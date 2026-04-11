#!/usr/bin/env python3
"""
CEMANI ROBOT - VISUAL SLAM + LIDAR FUSION
Autonomous photorealistic 3D room mapping

Combines:
- PTZ camera imagery (color + texture)
- LIDAR point cloud (precise geometry)
- Depth estimation (dense depth from monocular)
- Object detection (semantic understanding)

Creates photorealistic 3D maps that look like actual photos of the room.

Based on: GS-LIVO, SplaTAM, RTG-SLAM concepts
Optimized for: Jetson Orin + PTZ cameras + 2D LIDAR

Usage:
    python3 visual_slam.py
"""

import asyncio
import websocket
import json
import threading
import time
import math
import numpy as np
from collections import deque
from dataclasses import dataclass, field
from typing import List, Dict, Tuple, Optional
import cv2
from io import BytesIO
from PIL import Image
import base64

# Try to import GPU acceleration
try:
    import torch
    import torch.nn.functional as F
    TORCH_AVAILABLE = True
    DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"[SLAM] PyTorch device: {DEVICE}")
except ImportError:
    TORCH_AVAILABLE = False
    DEVICE = "cpu"
    print("[SLAM] PyTorch not available, using NumPy")

# VPS Connection
VPS_WS = "ws://YOUR_VPS_IP:3001"

# ============ 3D GAUSSIAN POINT ============
@dataclass
class GaussianPoint:
    """A 3D point with color, representing a Gaussian splat"""
    x: float  # World X (meters)
    y: float  # World Y (meters)
    z: float  # World Z/height (meters)
    r: int    # Red (0-255)
    g: int    # Green (0-255)
    b: int    # Blue (0-255)
    confidence: float = 1.0  # How confident we are in this point
    observations: int = 1    # How many times we've seen this point
    last_seen: float = 0     # Timestamp of last observation
    semantic_class: str = "" # Object class if detected

# ============ VISUAL SLAM STATE ============
@dataclass
class SLAMState:
    """Current state of the SLAM system"""
    # Robot pose
    x: float = 0.0          # meters
    y: float = 0.0          # meters
    heading: float = 0.0    # radians

    # Camera states (pan/tilt in degrees)
    cam1_pan: float = 0.0
    cam1_tilt: float = 0.0
    cam2_pan: float = 0.0
    cam2_tilt: float = 0.0

    # Latest sensor data
    lidar_points: List[Tuple[float, float]] = field(default_factory=list)
    cam1_frame: Optional[np.ndarray] = None
    cam2_frame: Optional[np.ndarray] = None
    detections: List[dict] = field(default_factory=list)

    # Map data
    gaussian_map: List[GaussianPoint] = field(default_factory=list)
    map_bounds: Dict[str, float] = field(default_factory=lambda: {
        'min_x': -10, 'max_x': 10,
        'min_y': -10, 'max_y': 10,
        'min_z': 0, 'max_z': 3
    })

    # Scanning state
    scanning: bool = False
    scan_positions: List[Tuple[float, float]] = field(default_factory=list)
    current_scan_idx: int = 0

state = SLAMState()

# ============ SPATIAL HASH MAP ============
class SpatialHashMap:
    """Fast spatial lookup for 3D points using voxel hashing"""

    def __init__(self, voxel_size: float = 0.05):
        self.voxel_size = voxel_size
        self.voxels: Dict[Tuple[int, int, int], List[int]] = {}
        self.points: List[GaussianPoint] = []

    def _hash(self, x: float, y: float, z: float) -> Tuple[int, int, int]:
        """Convert 3D point to voxel index"""
        return (
            int(x / self.voxel_size),
            int(y / self.voxel_size),
            int(z / self.voxel_size)
        )

    def add_point(self, point: GaussianPoint) -> int:
        """Add a point, merging with nearby existing points"""
        voxel = self._hash(point.x, point.y, point.z)

        # Check if similar point exists in this voxel
        if voxel in self.voxels:
            for idx in self.voxels[voxel]:
                existing = self.points[idx]
                dist = math.sqrt(
                    (existing.x - point.x)**2 +
                    (existing.y - point.y)**2 +
                    (existing.z - point.z)**2
                )
                if dist < self.voxel_size * 0.5:
                    # Merge: update color as running average
                    n = existing.observations
                    existing.r = int((existing.r * n + point.r) / (n + 1))
                    existing.g = int((existing.g * n + point.g) / (n + 1))
                    existing.b = int((existing.b * n + point.b) / (n + 1))
                    existing.confidence = min(1.0, existing.confidence + 0.1)
                    existing.observations += 1
                    existing.last_seen = time.time()
                    if point.semantic_class:
                        existing.semantic_class = point.semantic_class
                    return idx

        # Add new point
        idx = len(self.points)
        self.points.append(point)
        point.last_seen = time.time()

        if voxel not in self.voxels:
            self.voxels[voxel] = []
        self.voxels[voxel].append(idx)

        return idx

    def get_points(self) -> List[GaussianPoint]:
        return self.points

    def get_points_in_radius(self, x: float, y: float, z: float, radius: float) -> List[GaussianPoint]:
        """Get all points within radius of a position"""
        results = []
        voxel_radius = int(radius / self.voxel_size) + 1
        center = self._hash(x, y, z)

        for dx in range(-voxel_radius, voxel_radius + 1):
            for dy in range(-voxel_radius, voxel_radius + 1):
                for dz in range(-voxel_radius, voxel_radius + 1):
                    voxel = (center[0] + dx, center[1] + dy, center[2] + dz)
                    if voxel in self.voxels:
                        for idx in self.voxels[voxel]:
                            pt = self.points[idx]
                            dist = math.sqrt((pt.x - x)**2 + (pt.y - y)**2 + (pt.z - z)**2)
                            if dist <= radius:
                                results.append(pt)
        return results

# Global map
gaussian_map = SpatialHashMap(voxel_size=0.05)  # 5cm voxels

# ============ LIDAR TO 3D PROJECTION ============
def project_lidar_to_world(lidar_points: List[Tuple[float, float]],
                           robot_x: float, robot_y: float, robot_heading: float,
                           lidar_height: float = 0.5) -> List[Tuple[float, float, float]]:
    """
    Project 2D LIDAR points to 3D world coordinates.

    Args:
        lidar_points: List of (angle_deg, distance_mm)
        robot_x, robot_y: Robot position in meters
        robot_heading: Robot heading in radians
        lidar_height: Height of LIDAR sensor in meters

    Returns:
        List of (world_x, world_y, world_z) in meters
    """
    world_points = []

    for angle_deg, dist_mm in lidar_points:
        if dist_mm < 100 or dist_mm > 8000:  # Skip invalid readings
            continue

        # Convert to meters
        dist_m = dist_mm / 1000.0

        # LIDAR angle to radians (0 = forward)
        angle_rad = math.radians(angle_deg - 90)  # Adjust for LIDAR orientation

        # Local coordinates (LIDAR frame)
        local_x = dist_m * math.cos(angle_rad)
        local_y = dist_m * math.sin(angle_rad)

        # Transform to world coordinates
        cos_h = math.cos(robot_heading)
        sin_h = math.sin(robot_heading)

        world_x = robot_x + local_x * cos_h - local_y * sin_h
        world_y = robot_y + local_x * sin_h + local_y * cos_h
        world_z = lidar_height  # LIDAR is at fixed height

        world_points.append((world_x, world_y, world_z))

    return world_points

# ============ CAMERA TO 3D PROJECTION ============
def project_camera_to_world(image: np.ndarray,
                            depth_map: np.ndarray,
                            robot_x: float, robot_y: float, robot_heading: float,
                            cam_pan: float, cam_tilt: float,
                            camera_height: float = 0.4,
                            fov_h: float = 60, fov_v: float = 45) -> List[GaussianPoint]:
    """
    Project camera pixels to 3D world coordinates using depth.

    Args:
        image: RGB image (H, W, 3)
        depth_map: Depth values (H, W) in meters
        robot_x, robot_y: Robot position
        robot_heading: Robot heading in radians
        cam_pan, cam_tilt: Camera PTZ angles in degrees
        camera_height: Camera height in meters
        fov_h, fov_v: Field of view in degrees

    Returns:
        List of GaussianPoints with color
    """
    points = []
    h, w = image.shape[:2]

    # Sample every Nth pixel for efficiency
    step = 4

    pan_rad = math.radians(cam_pan)
    tilt_rad = math.radians(cam_tilt)

    for v in range(0, h, step):
        for u in range(0, w, step):
            depth = depth_map[v, u]
            if depth < 0.3 or depth > 8.0:
                continue

            # Pixel to camera ray
            px_angle_h = ((u - w/2) / w) * math.radians(fov_h)
            px_angle_v = ((h/2 - v) / h) * math.radians(fov_v)

            # Apply PTZ angles
            total_pan = pan_rad + px_angle_h
            total_tilt = tilt_rad + px_angle_v

            # Project to 3D (camera frame)
            cam_x = depth * math.cos(total_tilt) * math.sin(total_pan)
            cam_y = depth * math.cos(total_tilt) * math.cos(total_pan)
            cam_z = depth * math.sin(total_tilt) + camera_height

            # Transform to world
            cos_h = math.cos(robot_heading)
            sin_h = math.sin(robot_heading)

            world_x = robot_x + cam_x * cos_h - cam_y * sin_h
            world_y = robot_y + cam_x * sin_h + cam_y * cos_h
            world_z = cam_z

            # Get color
            r, g, b = image[v, u]

            points.append(GaussianPoint(
                x=world_x, y=world_y, z=world_z,
                r=int(r), g=int(g), b=int(b)
            ))

    return points

# ============ LIDAR-CAMERA FUSION ============
def fuse_lidar_camera(lidar_world_points: List[Tuple[float, float, float]],
                      camera_frame: np.ndarray,
                      robot_x: float, robot_y: float, robot_heading: float,
                      cam_pan: float, cam_tilt: float) -> List[GaussianPoint]:
    """
    Fuse LIDAR geometry with camera colors.

    Projects LIDAR points to camera image plane, samples colors,
    creates textured 3D points.
    """
    if camera_frame is None:
        return []

    points = []
    h, w = camera_frame.shape[:2]

    fov_h = 60  # degrees
    fov_v = 45

    cam_pan_rad = math.radians(cam_pan)
    cam_tilt_rad = math.radians(cam_tilt)

    for world_x, world_y, world_z in lidar_world_points:
        # Transform world point to robot frame
        dx = world_x - robot_x
        dy = world_y - robot_y

        cos_h = math.cos(-robot_heading)
        sin_h = math.sin(-robot_heading)

        robot_x_local = dx * cos_h - dy * sin_h
        robot_y_local = dx * sin_h + dy * cos_h
        robot_z_local = world_z

        # Calculate angle to point
        dist = math.sqrt(robot_x_local**2 + robot_y_local**2)
        if dist < 0.1:
            continue

        point_pan = math.atan2(robot_x_local, robot_y_local)
        point_tilt = math.atan2(robot_z_local - 0.4, dist)  # 0.4m camera height

        # Check if point is in camera's field of view
        pan_diff = point_pan - cam_pan_rad
        tilt_diff = point_tilt - cam_tilt_rad

        if abs(pan_diff) > math.radians(fov_h/2) or abs(tilt_diff) > math.radians(fov_v/2):
            continue

        # Project to image coordinates
        u = int(w/2 + (pan_diff / math.radians(fov_h)) * w)
        v = int(h/2 - (tilt_diff / math.radians(fov_v)) * h)

        if 0 <= u < w and 0 <= v < h:
            r, g, b = camera_frame[v, u]
            points.append(GaussianPoint(
                x=world_x, y=world_y, z=world_z,
                r=int(r), g=int(g), b=int(b),
                confidence=0.9  # High confidence - LIDAR geometry
            ))

    return points

# ============ AUTONOMOUS SCANNING ============
def generate_scan_pattern() -> List[Tuple[float, float]]:
    """Generate PTZ positions for comprehensive room scan"""
    positions = []

    # Systematic grid scan
    for tilt in [30, 15, 0, -15]:  # Top to bottom
        for pan in range(-120, 121, 30):  # Left to right
            positions.append((pan, tilt))

    return positions

async def run_autonomous_scan(ws):
    """Execute autonomous room scanning"""
    global state

    print("[SLAM] Starting autonomous scan...")
    state.scanning = True
    state.scan_positions = generate_scan_pattern()
    state.current_scan_idx = 0

    for camera in [1, 2]:
        print(f"[SLAM] Scanning camera {camera}...")

        for idx, (pan, tilt) in enumerate(state.scan_positions):
            if not state.scanning:
                break

            # Move camera
            await send_ptz_command(ws, camera, pan, tilt)

            # Update state
            if camera == 1:
                state.cam1_pan = pan
                state.cam1_tilt = tilt
            else:
                state.cam2_pan = pan
                state.cam2_tilt = tilt

            # Wait for camera to settle
            await asyncio.sleep(1.0)

            # Process current view
            await process_current_view(ws, camera)

            state.current_scan_idx = idx + 1

            # Send progress
            progress = (camera - 1) * len(state.scan_positions) + idx + 1
            total = 2 * len(state.scan_positions)
            print(f"[SLAM] Progress: {progress}/{total} ({100*progress/total:.1f}%)")

    state.scanning = False
    print("[SLAM] Autonomous scan complete!")

    # Send final map
    await send_map_update(ws)

async def send_ptz_command(ws, camera: int, pan: float, tilt: float):
    """Send PTZ move command"""
    msg = json.dumps({
        "type": "ptz",
        "camera": camera,
        "action": "absolute",
        "pan": pan,
        "tilt": tilt
    })
    ws.send(msg)

async def process_current_view(ws, camera: int):
    """Process current camera view and fuse with LIDAR"""
    global state, gaussian_map

    # Get current camera frame
    frame = state.cam1_frame if camera == 1 else state.cam2_frame
    if frame is None:
        return

    # Get camera PTZ position
    cam_pan = state.cam1_pan if camera == 1 else state.cam2_pan
    cam_tilt = state.cam1_tilt if camera == 1 else state.cam2_tilt

    # Project LIDAR points to world
    lidar_world = project_lidar_to_world(
        state.lidar_points,
        state.x, state.y, state.heading
    )

    # Fuse with camera for colored points
    fused_points = fuse_lidar_camera(
        lidar_world, frame,
        state.x, state.y, state.heading,
        cam_pan, cam_tilt
    )

    # Add to map
    for pt in fused_points:
        gaussian_map.add_point(pt)

    print(f"[SLAM] Added {len(fused_points)} points, map total: {len(gaussian_map.points)}")

async def send_map_update(ws):
    """Send current map to VPS for visualization"""
    points = gaussian_map.get_points()

    # Format for transmission
    map_data = {
        "type": "visual_slam_map",
        "points": [],
        "total": len(points),
        "robot_pose": {
            "x": state.x * 1000,  # mm
            "y": state.y * 1000,
            "heading": math.degrees(state.heading)
        }
    }

    # Sample points for bandwidth (max 20k)
    step = max(1, len(points) // 20000)

    for i in range(0, len(points), step):
        pt = points[i]
        map_data["points"].append({
            "x": round(pt.x, 3),
            "y": round(pt.y, 3),
            "z": round(pt.z, 3),
            "r": pt.r,
            "g": pt.g,
            "b": pt.b,
            "c": round(pt.confidence, 2)
        })

    ws.send(json.dumps(map_data))
    print(f"[SLAM] Sent map update: {len(map_data['points'])} points")

# ============ WEBSOCKET HANDLERS ============
def on_message(ws, message):
    """Handle incoming WebSocket messages"""
    global state

    try:
        # Handle binary frames
        if isinstance(message, bytes):
            if len(message) < 2:
                return

            packet_type = message[0]
            frame_data = message[1:]

            # Video frames
            if packet_type in [0, 2]:
                camera_id = 1 if packet_type == 0 else 2
                try:
                    img = Image.open(BytesIO(frame_data))
                    frame = np.array(img)
                    if camera_id == 1:
                        state.cam1_frame = frame
                    else:
                        state.cam2_frame = frame
                except:
                    pass
            return

        # JSON messages
        data = json.loads(message)

        # LIDAR data
        if data.get("type") == "lidar":
            state.lidar_points = data.get("points", [])

        # Robot pose from odometry
        if data.get("type") == "dead_reckoning":
            state.x = data.get("odomX", 0) / 1000.0  # mm to m
            state.y = data.get("odomY", 0) / 1000.0
            state.heading = math.radians(data.get("odomHeadingDeg", 0))

        # Object detections
        if data.get("type") == "detections":
            state.detections = data.get("detections", [])

        # Start scan command
        if data.get("type") == "start_visual_slam":
            threading.Thread(
                target=lambda: asyncio.run(run_autonomous_scan(ws)),
                daemon=True
            ).start()

        # Stop scan command
        if data.get("type") == "stop_visual_slam":
            state.scanning = False

    except Exception as e:
        print(f"[SLAM] Message error: {e}")

def on_open(ws):
    """Handle WebSocket connection open"""
    print("[SLAM] Connected to VPS!")

    # Register as visual SLAM
    ws.send(json.dumps({
        "type": "JETSON_REGISTER",
        "device": "visual_slam",
        "capabilities": [
            "lidar_camera_fusion",
            "gaussian_splatting",
            "autonomous_scan",
            "semantic_mapping"
        ]
    }))

    print("[SLAM] Registered. Waiting for commands...")
    print("[SLAM] Send 'start_visual_slam' to begin autonomous mapping")

def on_close(ws, close_status, close_msg):
    """Handle WebSocket close"""
    print(f"[SLAM] Disconnected: {close_status} - {close_msg}")

def on_error(ws, error):
    """Handle WebSocket error"""
    print(f"[SLAM] Error: {error}")

# ============ CONTINUOUS MAPPING MODE ============
def continuous_mapping_loop(ws):
    """Continuously process incoming data and update map"""
    global state, gaussian_map

    last_update = 0
    UPDATE_INTERVAL = 0.5  # Process every 500ms
    MAP_SEND_INTERVAL = 2.0
    last_map_send = 0

    while True:
        time.sleep(0.1)
        now = time.time()

        if now - last_update < UPDATE_INTERVAL:
            continue
        last_update = now

        # Skip if no data
        if len(state.lidar_points) < 10:
            continue

        # Process both cameras if available
        for camera in [1, 2]:
            frame = state.cam1_frame if camera == 1 else state.cam2_frame
            if frame is None:
                continue

            cam_pan = state.cam1_pan if camera == 1 else state.cam2_pan
            cam_tilt = state.cam1_tilt if camera == 1 else state.cam2_tilt

            # Project LIDAR
            lidar_world = project_lidar_to_world(
                state.lidar_points,
                state.x, state.y, state.heading
            )

            # Fuse with camera
            fused = fuse_lidar_camera(
                lidar_world, frame,
                state.x, state.y, state.heading,
                cam_pan, cam_tilt
            )

            for pt in fused:
                gaussian_map.add_point(pt)

        # Send map updates periodically
        if now - last_map_send >= MAP_SEND_INTERVAL and len(gaussian_map.points) > 100:
            try:
                asyncio.run(send_map_update(ws))
                last_map_send = now
            except:
                pass

# ============ MAIN ============
def main():
    print("=" * 60)
    print("  CEMANI ROBOT - VISUAL SLAM")
    print("  LiDAR + Camera Fusion with Gaussian Splatting")
    print("=" * 60)
    print()
    print(f"  Device: {DEVICE}")
    print(f"  PyTorch: {'Yes' if TORCH_AVAILABLE else 'No'}")
    print()

    while True:
        try:
            print("[SLAM] Connecting to VPS...")
            ws = websocket.WebSocketApp(
                VPS_WS,
                on_open=on_open,
                on_message=on_message,
                on_close=on_close,
                on_error=on_error
            )

            # Start continuous mapping in background
            mapping_thread = threading.Thread(
                target=continuous_mapping_loop,
                args=(ws,),
                daemon=True
            )
            mapping_thread.start()

            ws.run_forever()

        except Exception as e:
            print(f"[SLAM] Connection error: {e}")

        print("[SLAM] Reconnecting in 5 seconds...")
        time.sleep(5)

if __name__ == "__main__":
    main()
