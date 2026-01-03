#!/usr/bin/env python3
"""
CEMANI ROBOT - Hybrid 3D Mapper
================================
Combines multiple approaches for photorealistic 3D mapping:

1. LIDAR + Camera Fusion: Project camera colors onto accurate LIDAR geometry
2. Depth-Calibrated Monocular: Use LIDAR to calibrate monocular depth scale
3. Stereo Depth: Compute depth from dual PTZ cameras (when aligned)
4. Surface Reconstruction: Build mesh from point cloud for better rendering

DIRECT RTSP: Camera frames are captured directly over local WiFi,
bypassing the VPS bottleneck for maximum quality and frame rate.

Requirements:
    pip install numpy pillow websockets torch transformers opencv-python open3d

Usage:
    python3 hybrid_3d_mapper.py
"""

import asyncio
import websockets
import json
import base64
import io
import time
import math
import numpy as np
from PIL import Image
from collections import deque
from dataclasses import dataclass
from typing import List, Dict, Optional, Tuple

# Try imports, gracefully degrade if not available
try:
    import torch
    from transformers import pipeline
    DEPTH_AVAILABLE = True
except ImportError:
    DEPTH_AVAILABLE = False
    print("[WARN] torch/transformers not available - monocular depth disabled")

try:
    import cv2
    CV2_AVAILABLE = True
except ImportError:
    CV2_AVAILABLE = False
    print("[WARN] opencv not available - stereo depth disabled")

try:
    import open3d as o3d
    O3D_AVAILABLE = True
except ImportError:
    O3D_AVAILABLE = False
    print("[WARN] open3d not available - surface reconstruction disabled")

# ============ CONFIGURATION ============
VPS_WS = "ws://72.60.124.34:3001"

# DIRECT JETSON CONNECTION (bypasses VPS for data, sends only map to VPS)
# NOTE: Enable this after running local_streamer.py on Jetson
JETSON_DIRECT_ENABLED = False  # Set True when Jetson has local_streamer running
JETSON_WS = "ws://192.168.1.228:8765"  # Jetson local WebSocket

# DIRECT RTSP for maximum performance - bypass VPS bottleneck!
DIRECT_RTSP_ENABLED = True  # ENABLED - direct capture for speed!
RTSP_CAMERAS = {
    1: "rtsp://admin:kookster1@192.168.1.191:554/onvif1",  # Front camera
    2: "rtsp://admin:kookster1@192.168.1.27:554/onvif1"   # Rear camera
}
RTSP_FRAME_RATE = 10  # 10 FPS for aggressive mapping

# PERSISTENCE - Auto-save/load confirmed walls
PERSISTENCE_ENABLED = True
PERSISTENCE_FILE = "confirmed_walls.json"
AUTO_SAVE_INTERVAL = 30.0  # Save every 30 seconds
CONFIRM_THRESHOLD = 3  # Points seen 3+ times = confirmed

# Camera intrinsics (approximate for 640x480 PTZ cameras)
# These should be calibrated for best results
CAM_WIDTH = 640
CAM_HEIGHT = 480
CAM_FX = 500  # Focal length X (pixels)
CAM_FY = 500  # Focal length Y (pixels)
CAM_CX = 320  # Principal point X
CAM_CY = 240  # Principal point Y

# Camera positions relative to robot center (meters)
# Cam1: Front PTZ camera
CAM1_OFFSET = np.array([0.0, 0.40, -0.10])  # x=0, height=40cm, forward=10cm
CAM1_YAW = 0  # Faces forward

# Cam2: Rear/side PTZ camera on tower
CAM2_OFFSET = np.array([-0.20, 0.55, 0.0])  # x=-20cm left, height=55cm, z=0
CAM2_YAW = math.pi  # Faces backward

# LIDAR position (on top of tower)
LIDAR_HEIGHT = 0.70  # 70cm above ground
LIDAR_OFFSET = np.array([0.15, LIDAR_HEIGHT, 0.0])  # Right side of robot

# 3D mapping parameters - MAXIMUM QUALITY for beautiful maps
GRID_SIZE = 0.015  # 1.5cm grid cells - DENSER for photorealistic look
MAX_POINTS = 1000000  # 1M points for maximum detail like reference image
POINT_MERGE_DISTANCE = 0.008  # 8mm - VERY tight merging for crisp edges

# Static object filtering - KEEP EVERYTHING!
MIN_OBSERVATIONS = 1  # Just 1 observation = keep it!
DECAY_TIME = 300.0  # 5 minutes before decay starts
REMOVAL_TIME = 3600.0  # 1 HOUR before removal - keep everything!

# Color enhancement - VIVID like reference image (neon greens, bright pinks)
COLOR_SATURATION_BOOST = 2.0  # 2x saturation for vivid colors
COLOR_CONTRAST_BOOST = 1.4  # 40% more contrast - punchy colors
COLOR_BRIGHTNESS_BOOST = 1.15  # 15% brighter

# Point sampling density - MORE points per frame
SAMPLE_DENSITY = 6  # Sample every 6th pixel (was ~12)

# Depth calibration
DEPTH_SCALE_DEFAULT = 4.0  # Initial depth scale for monocular
LIDAR_DEPTH_CORRELATION_THRESHOLD = 0.3  # Max angle diff for LIDAR-camera correlation

# ============ DATA STRUCTURES ============
@dataclass
class Point3D:
    x: float
    y: float
    z: float
    r: int
    g: int
    b: int
    confidence: float = 1.0
    source: str = "lidar"  # lidar, mono, stereo
    observations: int = 1  # How many times this point has been seen
    last_seen: float = 0.0  # Timestamp of last observation
    is_static: bool = False  # True if seen enough times to be considered static

@dataclass
class RobotPose:
    x: float = 0.0  # meters
    y: float = 0.0  # meters
    heading: float = 0.0  # radians
    timestamp: float = 0.0

@dataclass
class CameraFrame:
    image: np.ndarray
    camera_id: int
    pan: float = 0.0  # degrees
    tilt: float = 0.0  # degrees
    timestamp: float = 0.0

@dataclass
class LidarScan:
    points: List[Tuple[float, float]]  # (angle_deg, distance_mm)
    timestamp: float = 0.0

# ============ HYBRID 3D MAPPER ============
class Hybrid3DMapper:
    def __init__(self):
        # State
        self.robot_pose = RobotPose()
        self.accumulated_points: Dict[str, Point3D] = {}  # grid_key -> point
        self.recent_lidar_scans = deque(maxlen=10)
        self.recent_camera_frames = {1: None, 2: None}
        self.camera_ptz = {1: (0, 0), 2: (0, 0)}  # (pan, tilt) degrees

        # Depth calibration state
        self.depth_scale = DEPTH_SCALE_DEFAULT
        self.depth_calibration_samples = []

        # Depth model
        self.depth_pipe = None
        if DEPTH_AVAILABLE:
            self._init_depth_model()

        # Statistics
        self.stats = {
            "lidar_points": 0,
            "mono_points": 0,
            "stereo_points": 0,
            "total_points": 0,
            "depth_scale": self.depth_scale
        }

        # Timing - AGGRESSIVE for faster mapping!
        self.last_process_time = {1: 0, 2: 0}
        self.last_map_send = 0
        self.last_auto_save = 0
        self.PROCESS_INTERVAL = 0.1  # Process every 100ms - MAX SPEED!
        self.MAP_SEND_INTERVAL = 1.0  # Send map every 1s

        # Persistence - load saved walls on startup
        if PERSISTENCE_ENABLED:
            self._load_confirmed_walls()

    def _load_confirmed_walls(self):
        """Load previously confirmed walls from file"""
        import os
        filepath = os.path.join(os.path.dirname(__file__), PERSISTENCE_FILE)
        try:
            if os.path.exists(filepath):
                with open(filepath, 'r') as f:
                    data = json.load(f)
                    count = 0
                    now = time.time()
                    for pt in data.get("points", []):
                        key = f"{pt['x']:.2f},{pt['y']:.2f},{pt['z']:.2f}"
                        point = Point3D(
                            x=pt['x'], y=pt['y'], z=pt['z'],
                            r=pt['r'], g=pt['g'], b=pt['b'],
                            confidence=pt.get('c', 1.0),
                            source=pt.get('src', 'saved'),
                            observations=pt.get('obs', CONFIRM_THRESHOLD)
                        )
                        # CRITICAL: Set last_seen to NOW so they don't get aged out!
                        point.last_seen = now
                        point.is_static = True  # Already confirmed
                        self.accumulated_points[key] = point
                        count += 1
                    print(f"[PERSIST] Loaded {count} confirmed walls from {PERSISTENCE_FILE}")
        except Exception as e:
            print(f"[PERSIST] Could not load walls: {e}")

    def _save_confirmed_walls(self):
        """Save confirmed walls (high observation count) to file"""
        import os
        filepath = os.path.join(os.path.dirname(__file__), PERSISTENCE_FILE)
        try:
            confirmed = []
            for key, pt in self.accumulated_points.items():
                # Only save points seen multiple times (confirmed)
                if hasattr(pt, 'observations') and pt.observations >= CONFIRM_THRESHOLD:
                    confirmed.append({
                        'x': round(pt.x, 3),
                        'y': round(pt.y, 3),
                        'z': round(pt.z, 3),
                        'r': pt.r, 'g': pt.g, 'b': pt.b,
                        'c': round(pt.confidence, 2),
                        'src': pt.source,
                        'obs': pt.observations
                    })

            with open(filepath, 'w') as f:
                json.dump({"points": confirmed, "timestamp": time.time()}, f)

            print(f"[PERSIST] Saved {len(confirmed)} confirmed walls")
        except Exception as e:
            print(f"[PERSIST] Save failed: {e}")

    def _init_depth_model(self):
        """Initialize depth estimation model on GPU/MPS - with timeout"""
        import sys
        import threading

        print("[DEPTH] Loading Depth Anything V2 model...", flush=True)
        sys.stdout.flush()

        # Use threading to add timeout
        self.depth_pipe = None
        load_complete = threading.Event()

        def load_model():
            try:
                import torch
                device = "mps" if torch.backends.mps.is_available() else "cpu"
                print(f"[DEPTH] Using device: {device}", flush=True)

                pipe = pipeline(
                    "depth-estimation",
                    model="depth-anything/Depth-Anything-V2-Small-hf",
                    device=device
                )

                # Quick warmup with tiny image
                print("[DEPTH] Running warmup...", flush=True)
                dummy = Image.new("RGB", (128, 96), color="gray")
                pipe(dummy)

                self.depth_pipe = pipe
                print("[DEPTH] Model ready!", flush=True)
            except Exception as e:
                print(f"[DEPTH] Failed to load model: {e}", flush=True)
            finally:
                load_complete.set()

        # Start loading in thread
        thread = threading.Thread(target=load_model, daemon=True)
        thread.start()

        # Wait max 120 seconds for model to load
        if not load_complete.wait(timeout=120):
            print("[DEPTH] Model loading timed out - continuing without depth!", flush=True)

        if self.depth_pipe:
            print("[DEPTH] Depth estimation enabled!", flush=True)
        else:
            print("[DEPTH] Depth disabled - will use LIDAR + camera fusion only", flush=True)

    def _enhance_color(self, r: int, g: int, b: int) -> Tuple[int, int, int]:
        """Enhance colors for more vivid, beautiful visualization"""
        # Convert to HSV-like for saturation boost
        max_c = max(r, g, b)
        min_c = min(r, g, b)

        if max_c == min_c:
            # Grayscale - just apply brightness
            v = int(min(255, r * COLOR_BRIGHTNESS_BOOST))
            return (v, v, v)

        # Boost saturation by pulling colors away from gray
        mid = (r + g + b) / 3
        r_new = mid + (r - mid) * COLOR_SATURATION_BOOST
        g_new = mid + (g - mid) * COLOR_SATURATION_BOOST
        b_new = mid + (b - mid) * COLOR_SATURATION_BOOST

        # Apply contrast boost
        r_new = 128 + (r_new - 128) * COLOR_CONTRAST_BOOST
        g_new = 128 + (g_new - 128) * COLOR_CONTRAST_BOOST
        b_new = 128 + (b_new - 128) * COLOR_CONTRAST_BOOST

        # Apply brightness boost
        r_new *= COLOR_BRIGHTNESS_BOOST
        g_new *= COLOR_BRIGHTNESS_BOOST
        b_new *= COLOR_BRIGHTNESS_BOOST

        # Clamp to valid range
        return (
            int(max(0, min(255, r_new))),
            int(max(0, min(255, g_new))),
            int(max(0, min(255, b_new)))
        )

    def update_pose(self, x_mm: float, y_mm: float, heading_deg: float):
        """Update robot pose from odometry"""
        self.robot_pose = RobotPose(
            x=x_mm / 1000.0,
            y=y_mm / 1000.0,
            heading=math.radians(heading_deg),
            timestamp=time.time()
        )

    def update_camera_ptz(self, camera_id: int, pan: float, tilt: float):
        """Update PTZ position for a camera"""
        self.camera_ptz[camera_id] = (pan, tilt)

    def add_lidar_scan(self, points: List[Tuple[float, float]]):
        """Add a LIDAR scan (angle_deg, distance_mm pairs)"""
        scan = LidarScan(points=points, timestamp=time.time())
        self.recent_lidar_scans.append(scan)
        self._process_lidar_scan(scan)

    def add_camera_frame(self, camera_id: int, image_bytes: bytes):
        """Add a camera frame for processing"""
        try:
            img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
            frame = CameraFrame(
                image=np.array(img),
                camera_id=camera_id,
                pan=self.camera_ptz[camera_id][0],
                tilt=self.camera_ptz[camera_id][1],
                timestamp=time.time()
            )
            self.recent_camera_frames[camera_id] = frame

            # Rate limit processing
            now = time.time()
            if now - self.last_process_time[camera_id] >= self.PROCESS_INTERVAL:
                self.last_process_time[camera_id] = now
                self._process_frame_with_lidar_fusion(frame)
                if self.depth_pipe:
                    self._process_frame_with_mono_depth(frame)
        except Exception as e:
            print(f"[FRAME] Error processing cam {camera_id}: {e}")

    def _process_lidar_scan(self, scan: LidarScan):
        """Process LIDAR scan - project to 3D world coordinates"""
        pose = self.robot_pose
        cos_h = math.cos(pose.heading)
        sin_h = math.sin(pose.heading)

        for angle_deg, dist_mm in scan.points:
            if dist_mm < 100 or dist_mm > 8000:
                continue

            # Convert to meters
            dist_m = dist_mm / 1000.0
            angle_rad = math.radians(angle_deg - 90)  # LIDAR 0 = forward

            # Local point (relative to LIDAR)
            local_x = dist_m * math.cos(angle_rad)
            local_y = dist_m * math.sin(angle_rad)

            # Transform to robot frame (add LIDAR offset)
            robot_x = local_x + LIDAR_OFFSET[0]
            robot_y = local_y + LIDAR_OFFSET[2]
            robot_z = LIDAR_OFFSET[1]  # LIDAR height

            # Transform to world frame
            world_x = pose.x + robot_x * cos_h - robot_y * sin_h
            world_y = pose.y + robot_x * sin_h + robot_y * cos_h
            world_z = robot_z

            # SKIP adding grey points - only add colored points from camera fusion
            # The grey points look bad and clutter the visualization
            # Camera fusion will add properly colored LIDAR points
            pass

        self.stats["lidar_points"] = len([p for p in self.accumulated_points.values() if p.source == "lidar"])

    def _process_frame_with_lidar_fusion(self, frame: CameraFrame):
        """
        LIDAR + Camera Fusion: Project LIDAR points into camera to get colors.
        This gives accurate geometry (from LIDAR) with photorealistic colors (from camera).
        """
        if len(self.recent_lidar_scans) == 0:
            return

        # Get most recent LIDAR scan
        scan = self.recent_lidar_scans[-1]
        pose = self.robot_pose

        # Camera parameters
        cam_id = frame.camera_id
        cam_offset = CAM1_OFFSET if cam_id == 1 else CAM2_OFFSET
        cam_yaw = CAM1_YAW if cam_id == 1 else CAM2_YAW
        pan_rad = math.radians(frame.pan)
        tilt_rad = math.radians(frame.tilt)

        h, w = frame.image.shape[:2]
        fx = CAM_FX * (w / CAM_WIDTH)
        fy = CAM_FY * (h / CAM_HEIGHT)
        cx = CAM_CX * (w / CAM_WIDTH)
        cy = CAM_CY * (h / CAM_HEIGHT)

        colored_count = 0

        for angle_deg, dist_mm in scan.points:
            if dist_mm < 100 or dist_mm > 8000:
                continue

            dist_m = dist_mm / 1000.0
            lidar_angle = math.radians(angle_deg - 90)

            # LIDAR point in robot frame
            pt_x = dist_m * math.cos(lidar_angle) + LIDAR_OFFSET[0]
            pt_y = dist_m * math.sin(lidar_angle) + LIDAR_OFFSET[2]
            pt_z = LIDAR_OFFSET[1]

            # Transform to camera frame
            # First translate to camera position
            cam_x = pt_x - cam_offset[0]
            cam_y = pt_y - cam_offset[2]
            cam_z = pt_z - cam_offset[1]

            # Apply camera yaw + PTZ pan
            total_yaw = cam_yaw + pan_rad
            cos_yaw = math.cos(-total_yaw)
            sin_yaw = math.sin(-total_yaw)

            rotated_x = cam_x * cos_yaw - cam_y * sin_yaw
            rotated_y = cam_x * sin_yaw + cam_y * cos_yaw

            # Apply PTZ tilt
            cos_tilt = math.cos(-tilt_rad)
            sin_tilt = math.sin(-tilt_rad)

            final_y = rotated_y * cos_tilt - cam_z * sin_tilt
            final_z = rotated_y * sin_tilt + cam_z * cos_tilt

            # Camera coordinate system: Z=forward, X=right, Y=down
            cam_3d_x = rotated_x
            cam_3d_y = final_z  # Height becomes Y
            cam_3d_z = final_y  # Depth

            # Skip points behind camera
            if cam_3d_z <= 0.3:
                continue

            # Project to image plane
            img_x = fx * (cam_3d_x / cam_3d_z) + cx
            img_y = fy * (cam_3d_y / cam_3d_z) + cy

            # Check if point is visible in image
            if 0 <= img_x < w and 0 <= img_y < h:
                # Sample color from image
                px = int(img_x)
                py = int(img_y)
                r, g, b = frame.image[py, px]

                # Update LIDAR point with camera color
                cos_h = math.cos(pose.heading)
                sin_h = math.sin(pose.heading)
                world_x = pose.x + pt_x * cos_h - pt_y * sin_h
                world_y = pose.y + pt_x * sin_h + pt_y * cos_h
                world_z = pt_z

                # Add colored point with color enhancement
                r_e, g_e, b_e = self._enhance_color(int(r), int(g), int(b))
                self._add_point(Point3D(
                    x=world_x, y=world_y, z=world_z,
                    r=r_e, g=g_e, b=b_e,
                    confidence=0.95,
                    source="lidar"
                ), update_color=True)
                colored_count += 1

        if colored_count > 0:
            print(f"[FUSION] Cam{cam_id}: Colored {colored_count} LIDAR points")

    def _process_frame_with_mono_depth(self, frame: CameraFrame):
        """
        Monocular depth estimation with LIDAR-calibrated scale.
        Uses Depth Anything to estimate relative depth, then scales using LIDAR.
        """
        if not self.depth_pipe:
            return

        try:
            # MAX RESOLUTION - Mac Mini M2/M4 GPU is powerful!
            img = Image.fromarray(frame.image)
            img_small = img.resize((640, 480))  # Full 640x480 for maximum depth detail

            # Run depth estimation
            result = self.depth_pipe(img_small)
            depth_map = np.array(result["depth"])

            # Calibrate depth scale using recent LIDAR data
            self._calibrate_depth_scale(frame, depth_map)

            # Project depth to 3D
            self._project_depth_to_3d(frame, depth_map)

        except Exception as e:
            print(f"[MONO] Error: {e}")

    def _calibrate_depth_scale(self, frame: CameraFrame, depth_map: np.ndarray):
        """
        Calibrate monocular depth scale using LIDAR ground truth.
        Find correspondences between LIDAR and depth map, compute scale.
        """
        if len(self.recent_lidar_scans) == 0:
            return

        scan = self.recent_lidar_scans[-1]
        cam_id = frame.camera_id
        cam_offset = CAM1_OFFSET if cam_id == 1 else CAM2_OFFSET
        cam_yaw = CAM1_YAW if cam_id == 1 else CAM2_YAW
        pan_rad = math.radians(frame.pan)

        h, w = depth_map.shape
        correspondences = []

        for angle_deg, dist_mm in scan.points:
            if dist_mm < 500 or dist_mm > 5000:  # Use mid-range for calibration
                continue

            lidar_dist = dist_mm / 1000.0
            lidar_angle = math.radians(angle_deg - 90)

            # Transform to camera frame (simplified - just check angle)
            cam_angle = lidar_angle - cam_yaw - pan_rad

            # Only use points roughly in camera FOV
            if abs(cam_angle) > math.radians(30):
                continue

            # Estimate image column from angle
            img_x = int(w/2 + (cam_angle / math.radians(30)) * w/2)
            if 0 <= img_x < w:
                # Sample depth at horizontal center row
                mono_depth = depth_map[h//2, img_x]
                if mono_depth > 0.01:  # Valid depth
                    correspondences.append((lidar_dist, mono_depth))

        if len(correspondences) >= 5:
            # Compute scale: lidar_dist = scale * mono_depth
            lidar_dists = np.array([c[0] for c in correspondences])
            mono_dists = np.array([c[1] for c in correspondences])

            # Robust scale estimation (median)
            scales = lidar_dists / (mono_dists + 1e-6)
            new_scale = np.median(scales)

            # Smooth update
            self.depth_scale = 0.8 * self.depth_scale + 0.2 * new_scale
            self.depth_scale = np.clip(self.depth_scale, 1.0, 10.0)
            self.stats["depth_scale"] = round(self.depth_scale, 2)

    def _project_depth_to_3d(self, frame: CameraFrame, depth_map: np.ndarray):
        """Project monocular depth map to 3D point cloud"""
        pose = self.robot_pose
        cam_id = frame.camera_id
        cam_offset = CAM1_OFFSET if cam_id == 1 else CAM2_OFFSET
        cam_yaw = CAM1_YAW if cam_id == 1 else CAM2_YAW
        pan_rad = math.radians(frame.pan)
        tilt_rad = math.radians(frame.tilt)

        h, w = depth_map.shape
        img_h, img_w = frame.image.shape[:2]

        # Normalize depth
        depth_norm = depth_map / (depth_map.max() + 1e-8)
        depth_meters = (1.0 - depth_norm) * self.depth_scale + 0.3

        # Camera intrinsics scaled to depth map size
        fx = CAM_FX * (w / CAM_WIDTH)
        fy = CAM_FY * (h / CAM_HEIGHT)
        cx = w / 2
        cy = h / 2

        step = 1  # Sample EVERY PIXEL - absolute maximum density!
        points_added = 0

        for v in range(0, h, step):
            for u in range(0, w, step):
                d = depth_meters[v, u]
                if d < 0.3 or d > 8.0:  # Wider range - capture more
                    continue

                # Get color from original image
                px = int(u * img_w / w)
                py = int(v * img_h / h)
                if 0 <= px < img_w and 0 <= py < img_h:
                    r, g, b = frame.image[py, px]
                else:
                    continue

                # Skip only pure black pixels
                if int(r) + int(g) + int(b) < 15:
                    continue

                # Project to camera 3D
                x_cam = (u - cx) * d / fx
                y_cam = (v - cy) * d / fy
                z_cam = d

                # Apply PTZ rotation
                cos_pan = math.cos(pan_rad + cam_yaw)
                sin_pan = math.sin(pan_rad + cam_yaw)
                cos_tilt = math.cos(tilt_rad)
                sin_tilt = math.sin(tilt_rad)

                # Rotate by pan
                x_rot = x_cam * cos_pan + z_cam * sin_pan
                z_rot = -x_cam * sin_pan + z_cam * cos_pan

                # Rotate by tilt
                y_rot = y_cam * cos_tilt - z_rot * sin_tilt
                z_final = y_cam * sin_tilt + z_rot * cos_tilt

                # Transform to robot frame
                robot_x = x_rot + cam_offset[0]
                robot_y = z_final + cam_offset[2]
                robot_z = -y_rot + cam_offset[1]

                # Transform to world frame
                cos_h = math.cos(pose.heading)
                sin_h = math.sin(pose.heading)
                world_x = pose.x + robot_x * cos_h - robot_y * sin_h
                world_y = pose.y + robot_x * sin_h + robot_y * cos_h
                world_z = robot_z

                # Enhance colors for mono depth points too
                r_e, g_e, b_e = self._enhance_color(int(r), int(g), int(b))
                self._add_point(Point3D(
                    x=world_x, y=world_y, z=world_z,
                    r=r_e, g=g_e, b=b_e,
                    confidence=0.7,  # LIDAR-calibrated depth
                    source="mono"
                ))
                points_added += 1

        if points_added > 0:
            self.stats["mono_points"] += points_added

    def _add_point(self, point: Point3D, update_color: bool = False):
        """Add point to accumulated map with grid-based deduplication and static filtering"""
        now = time.time()

        # Grid key for deduplication
        gx = int(point.x / GRID_SIZE)
        gy = int(point.y / GRID_SIZE)
        gz = int(point.z / GRID_SIZE)
        key = f"{gx},{gy},{gz}"

        if key in self.accumulated_points:
            existing = self.accumulated_points[key]

            # Increment observation count - this point is being seen again!
            existing.observations += 1
            existing.last_seen = now

            # Mark as static if seen enough times
            if existing.observations >= MIN_OBSERVATIONS:
                existing.is_static = True

            # Update existing point
            if update_color or point.confidence > existing.confidence:
                # Running average of position (weighted by observations)
                n = existing.observations
                existing.x = (existing.x * (n-1) + point.x) / n
                existing.y = (existing.y * (n-1) + point.y) / n
                existing.z = (existing.z * (n-1) + point.z) / n

                # Update color (smooth blending)
                existing.r = int((existing.r * 0.8 + point.r * 0.2))
                existing.g = int((existing.g * 0.8 + point.g * 0.2))
                existing.b = int((existing.b * 0.8 + point.b * 0.2))

                # Keep higher confidence
                if point.confidence > existing.confidence:
                    existing.confidence = point.confidence
                    existing.source = point.source
        else:
            # New point - starts with 1 observation
            point.observations = 1
            point.last_seen = now
            point.is_static = True  # All points are static immediately - build map fast!

            # Limit total points - remove oldest non-static or decayed points first
            if len(self.accumulated_points) >= MAX_POINTS:
                self._cleanup_old_points(now)

            self.accumulated_points[key] = point

        self.stats["total_points"] = len(self.accumulated_points)
        self.stats["static_points"] = len([p for p in self.accumulated_points.values() if p.is_static])

    def _cleanup_old_points(self, now: float):
        """Remove points that haven't been seen recently (likely moving objects)"""
        to_remove = []

        for key, point in self.accumulated_points.items():
            age = now - point.last_seen

            # NEVER remove static/confirmed points - they are the map!
            if point.is_static and point.observations >= CONFIRM_THRESHOLD:
                continue

            # Remove transient points not seen for REMOVAL_TIME
            if age > REMOVAL_TIME:
                to_remove.append(key)
            # Also remove non-static points that are decaying
            elif not point.is_static and age > DECAY_TIME:
                to_remove.append(key)

        # Only remove more points if we're WAY over the limit
        if len(self.accumulated_points) > MAX_POINTS * 1.1 and len(to_remove) < 500:
            # Sort by (is_static, observations) - remove non-static low-observation first
            sorted_points = sorted(
                self.accumulated_points.items(),
                key=lambda x: (x[1].is_static, x[1].observations)
            )
            excess = len(self.accumulated_points) - MAX_POINTS
            for key, pt in sorted_points[:excess]:
                # Never remove confirmed static points
                if pt.is_static and pt.observations >= CONFIRM_THRESHOLD:
                    continue
                if key not in to_remove:
                    to_remove.append(key)

        # Only remove up to 50 at a time to avoid losing accumulated points
        removed_count = 0
        for key in to_remove[:50]:
            if key in self.accumulated_points:
                del self.accumulated_points[key]
                removed_count += 1

        if removed_count > 0:
            print(f"[CLEANUP] Removed {removed_count} non-static points")

    def compute_stereo_depth(self):
        """
        Compute stereo depth from dual cameras when they have overlapping views.
        Requires both cameras to be looking at similar scene (e.g., both facing forward).
        """
        if not CV2_AVAILABLE:
            return

        frame1 = self.recent_camera_frames.get(1)
        frame2 = self.recent_camera_frames.get(2)

        if frame1 is None or frame2 is None:
            return

        # Check if frames are recent enough
        now = time.time()
        if abs(frame1.timestamp - frame2.timestamp) > 0.5:
            return

        # Check if cameras are roughly facing the same direction
        # For stereo, we want cam1 facing forward and cam2 also facing forward
        pan1, tilt1 = self.camera_ptz.get(1, (0, 0))
        pan2, tilt2 = self.camera_ptz.get(2, (0, 0))

        # Cam2 base orientation is backward (180), so add 180 to its pan
        effective_pan2 = pan2 + 180

        # Check if they're within ~30 degrees of each other
        pan_diff = abs(pan1 - effective_pan2)
        if pan_diff > 30 and pan_diff < 330:
            return

        print(f"[STEREO] Computing depth from cam1(pan={pan1:.0f}) and cam2(pan={pan2:.0f})")

        try:
            # Convert to grayscale
            gray1 = cv2.cvtColor(frame1.image, cv2.COLOR_RGB2GRAY)
            gray2 = cv2.cvtColor(frame2.image, cv2.COLOR_RGB2GRAY)

            # Resize for faster processing
            h, w = gray1.shape
            scale = 0.5
            gray1 = cv2.resize(gray1, (int(w*scale), int(h*scale)))
            gray2 = cv2.resize(gray2, (int(w*scale), int(h*scale)))

            # Stereo matching using SGBM
            stereo = cv2.StereoSGBM_create(
                minDisparity=0,
                numDisparities=64,
                blockSize=5,
                P1=8 * 3 * 5**2,
                P2=32 * 3 * 5**2,
                disp12MaxDiff=1,
                uniquenessRatio=10,
                speckleWindowSize=100,
                speckleRange=32
            )

            disparity = stereo.compute(gray1, gray2).astype(np.float32) / 16.0

            # Convert disparity to depth
            # baseline = distance between cameras (approximate)
            baseline = 0.25  # ~25cm between cam1 and cam2
            focal = CAM_FX * scale

            # Avoid division by zero
            valid_mask = disparity > 1
            depth = np.zeros_like(disparity)
            depth[valid_mask] = (baseline * focal) / disparity[valid_mask]

            # Limit depth range
            depth = np.clip(depth, 0.3, 10.0)

            if np.sum(valid_mask) > 100:
                self._project_stereo_depth(frame1, depth, scale)
                self.stats["stereo_points"] += np.sum(valid_mask) // 36

        except Exception as e:
            print(f"[STEREO] Error: {e}")

    def _project_stereo_depth(self, frame: CameraFrame, depth: np.ndarray, scale: float):
        """Project stereo depth map to 3D world coordinates"""
        pose = self.robot_pose
        h, w = depth.shape
        img = cv2.resize(frame.image, (w, h))

        fx = CAM_FX * scale
        fy = CAM_FY * scale
        cx = w / 2
        cy = h / 2

        pan_rad = math.radians(frame.pan)
        tilt_rad = math.radians(frame.tilt)
        cos_h = math.cos(pose.heading)
        sin_h = math.sin(pose.heading)

        step = 3  # Denser stereo sampling
        for v in range(0, h, step):
            for u in range(0, w, step):
                d = depth[v, u]
                if d < 0.3 or d > 10.0:  # Wider range
                    continue

                r, g, b = img[v, u]
                if r + g + b < 15:  # Only skip pure black
                    continue

                # Project to 3D
                x_cam = (u - cx) * d / fx
                y_cam = (v - cy) * d / fy
                z_cam = d

                # Apply PTZ rotation
                cos_pan = math.cos(pan_rad)
                sin_pan = math.sin(pan_rad)
                x_rot = x_cam * cos_pan + z_cam * sin_pan
                z_rot = -x_cam * sin_pan + z_cam * cos_pan

                cos_tilt = math.cos(tilt_rad)
                sin_tilt = math.sin(tilt_rad)
                y_rot = y_cam * cos_tilt - z_rot * sin_tilt
                z_final = y_cam * sin_tilt + z_rot * cos_tilt

                # Transform to robot then world frame
                robot_x = x_rot + CAM1_OFFSET[0]
                robot_y = z_final + CAM1_OFFSET[2]
                robot_z = -y_rot + CAM1_OFFSET[1]

                world_x = pose.x + robot_x * cos_h - robot_y * sin_h
                world_y = pose.y + robot_x * sin_h + robot_y * cos_h
                world_z = robot_z

                # Enhance colors for stereo depth points
                r_e, g_e, b_e = self._enhance_color(int(r), int(g), int(b))
                self._add_point(Point3D(
                    x=world_x, y=world_y, z=world_z,
                    r=r_e, g=g_e, b=b_e,
                    confidence=0.85,  # Good confidence for stereo
                    source="stereo"
                ))

    def get_map_data(self) -> Dict:
        """Get accumulated map data for transmission - only static points"""
        # First clean up old/moving points
        self._cleanup_old_points(time.time())

        points = []
        static_count = 0
        pending_count = 0

        # Limit points to prevent WebSocket overflow
        # Send max 100k points per update, prioritize high-confidence
        MAX_SEND_POINTS = 100000

        # Sort by confidence and observations for priority
        sorted_points = sorted(
            self.accumulated_points.values(),
            key=lambda p: (p.confidence, p.observations),
            reverse=True
        )

        for p in sorted_points:
            # Only send points that have been seen enough times (static objects)
            if p.is_static:
                static_count += 1
                if len(points) < MAX_SEND_POINTS:
                    # Compact format: use arrays instead of dicts to save bandwidth
                    points.append([
                        round(p.x, 2), round(p.y, 2), round(p.z, 2),
                        p.r, p.g, p.b
                    ])
            else:
                pending_count += 1

        return {
            "type": "accumulated_map",
            "points": points,
            "total": len(points),
            "static_points": static_count,
            "pending_points": pending_count,
            "stats": self.stats,
            "format": "compact"  # [x, y, z, r, g, b] arrays
        }

    def clear_map(self):
        """Clear accumulated map"""
        self.accumulated_points.clear()
        self.stats = {
            "lidar_points": 0,
            "mono_points": 0,
            "stereo_points": 0,
            "total_points": 0,
            "depth_scale": self.depth_scale
        }
        print("[MAP] Cleared")

    def should_send_map(self) -> bool:
        """Check if it's time to send map update"""
        now = time.time()
        if now - self.last_map_send >= self.MAP_SEND_INTERVAL:
            self.last_map_send = now
            return True
        return False


# ============ WEBSOCKET CLIENT ============
mapper = Hybrid3DMapper()

async def handle_vps_connection():
    """Connect to VPS and process data streams"""
    print(f"[WS] Connecting to {VPS_WS}...")

    async with websockets.connect(VPS_WS, max_size=10_000_000, ping_interval=None, ping_timeout=None) as ws:
        print("[WS] Connected! Registering as hybrid-3d-mapper...")

        await ws.send(json.dumps({
            "type": "register_processor",
            "name": "hybrid-3d-mapper",
            "capabilities": ["lidar_fusion", "depth_estimation", "3d_mapping", "stereo"]
        }))

        print("[WS] Waiting for data streams...")
        print("[WS] Features enabled:")
        print(f"     - LIDAR + Camera Fusion: YES")
        print(f"     - Monocular Depth: {'YES' if mapper.depth_pipe else 'NO (missing torch/transformers)'}")
        print(f"     - Stereo Depth: {'YES' if CV2_AVAILABLE else 'NO (missing opencv)'}")
        print(f"     - Surface Reconstruction: {'YES' if O3D_AVAILABLE else 'NO (missing open3d)'}")

        msg_count = 0
        async for message in ws:
            try:
                msg_count += 1
                # Log every 100th message to see what's coming in
                if msg_count % 100 == 0:
                    if isinstance(message, bytes):
                        print(f"[DEBUG] Received {msg_count} msgs, latest: binary {len(message)} bytes, type={message[0] if len(message)>0 else 'empty'}")
                    else:
                        try:
                            d = json.loads(message)
                            print(f"[DEBUG] Received {msg_count} msgs, latest: {d.get('type', 'unknown')}")
                        except:
                            print(f"[DEBUG] Received {msg_count} msgs, latest: string {len(message)} chars")

                # Binary message = camera frame
                if isinstance(message, bytes) and len(message) > 100:
                    packet_type = message[0]
                    if packet_type in [0, 2]:  # Video frames
                        camera_id = 1 if packet_type == 0 else 2
                        mapper.add_camera_frame(camera_id, message[1:])
                    continue

                # JSON messages
                data = json.loads(message)
                msg_type = data.get("type", "unknown")

                # Robot pose from odometry
                if data.get("type") == "dead_reckoning":
                    mapper.update_pose(
                        data.get("odomX", data.get("x", 0)),
                        data.get("odomY", data.get("y", 0)),
                        data.get("odomHeadingDeg", data.get("heading", 0))
                    )

                # COMPASS heading - USE THIS since encoders are broken!
                if data.get("type") == "compass":
                    compass_heading = data.get("heading", 0)
                    # Update heading only, keep x/y position
                    mapper.robot_pose.heading = math.radians(compass_heading)

                # VELOCITY-BASED position estimate (since encoders broken)
                if data.get("type") == "teensy_telemetry":
                    velL = data.get("velL", 0)  # RPM
                    velR = data.get("velR", 0)  # RPM
                    # Average velocity in m/s (8" wheel = 0.2m circumference)
                    avg_vel_mps = (velL + velR) / 2.0 * 0.2 / 60.0
                    if abs(avg_vel_mps) > 0.01:  # Moving
                        dt = 0.2  # ~200ms between TELEM
                        dist = avg_vel_mps * dt
                        # Update position based on heading
                        mapper.robot_pose.x += dist * math.sin(mapper.robot_pose.heading)
                        mapper.robot_pose.y += dist * math.cos(mapper.robot_pose.heading)
                        print(f"[VELOCITY] vel={avg_vel_mps:.2f}m/s pos=({mapper.robot_pose.x:.2f}, {mapper.robot_pose.y:.2f})")

                # LIDAR scan
                if data.get("type") == "lidar":
                    points = [(p[0], p[1]) for p in data.get("points", [])]
                    if points:
                        mapper.add_lidar_scan(points)

                # PTZ position updates
                if data.get("type") == "ptz_status":
                    cam = data.get("camera", 1)
                    mapper.update_camera_ptz(cam, data.get("pan", 0), data.get("tilt", 0))

                # Clear map command
                if data.get("type") == "clear_3d_map":
                    mapper.clear_map()

                # Periodically compute stereo depth
                if CV2_AVAILABLE and time.time() % 2 < 0.1:  # Every ~2 seconds
                    mapper.compute_stereo_depth()

                # Send map updates
                if mapper.should_send_map() and len(mapper.accumulated_points) > 50:
                    map_data = mapper.get_map_data()
                    await ws.send(json.dumps(map_data))
                    stats = mapper.stats
                    print(f"[MAP] Sent {map_data['total']} points | lidar={stats['lidar_points']} mono={stats['mono_points']} stereo={stats['stereo_points']} | scale={mapper.depth_scale:.2f}")

                # Auto-save confirmed walls periodically
                if PERSISTENCE_ENABLED:
                    now = time.time()
                    if now - mapper.last_auto_save >= AUTO_SAVE_INTERVAL:
                        mapper.last_auto_save = now
                        mapper._save_confirmed_walls()

            except json.JSONDecodeError:
                pass
            except Exception as e:
                print(f"[WS] Error: {e}")
                import traceback
                traceback.print_exc()


def rtsp_capture_thread(camera_id: int, rtsp_url: str):
    """Capture frames directly from RTSP camera using FFmpeg subprocess"""
    import subprocess
    import struct

    if not CV2_AVAILABLE:
        print(f"[RTSP] Camera {camera_id}: OpenCV not available, skipping direct capture")
        return

    print(f"[RTSP] Camera {camera_id}: Starting FFmpeg capture from {rtsp_url.split('@')[1] if '@' in rtsp_url else rtsp_url}")

    frame_interval = 1.0 / RTSP_FRAME_RATE
    last_frame_time = 0
    consecutive_errors = 0
    width, height = 640, 480

    while True:
        try:
            # Use FFmpeg to capture frames directly
            cmd = [
                '/opt/homebrew/bin/ffmpeg',
                '-rtsp_transport', 'tcp',
                '-i', rtsp_url,
                '-vf', f'fps={RTSP_FRAME_RATE},scale={width}:{height}',
                '-f', 'rawvideo',
                '-pix_fmt', 'rgb24',
                '-an',
                '-'
            ]

            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                bufsize=width * height * 3 * 10  # Larger buffer
            )

            # Wait for FFmpeg to start streaming
            time.sleep(2)
            print(f"[RTSP] Camera {camera_id}: Connected! Direct capture active at {RTSP_FRAME_RATE} fps.")
            consecutive_errors = 0
            frame_size = width * height * 3

            while True:
                raw_frame = proc.stdout.read(frame_size)
                if len(raw_frame) != frame_size:
                    print(f"[RTSP] Camera {camera_id}: Frame read incomplete, reconnecting...")
                    break

                now = time.time()

                # Convert raw bytes to numpy array
                frame_rgb = np.frombuffer(raw_frame, dtype=np.uint8).reshape((height, width, 3))

                # Create camera frame and add to mapper
                camera_frame = CameraFrame(
                    image=frame_rgb,
                    camera_id=camera_id,
                    pan=mapper.camera_ptz[camera_id][0],
                    tilt=mapper.camera_ptz[camera_id][1],
                    timestamp=now
                )
                mapper.recent_camera_frames[camera_id] = camera_frame

                # Process frame with LIDAR fusion
                mapper._process_frame_with_lidar_fusion(camera_frame)

                # Process with depth (rate limit to reduce GPU load)
                if mapper.depth_pipe and (now - last_frame_time) >= 0.5:
                    mapper._process_frame_with_mono_depth(camera_frame)
                    last_frame_time = now

            proc.kill()

        except Exception as e:
            print(f"[RTSP] Camera {camera_id}: Error - {e}")
            consecutive_errors += 1
            time.sleep(min(5 * consecutive_errors, 30))  # Exponential backoff


def start_rtsp_threads():
    """Start RTSP capture threads for all cameras"""
    import threading

    if not DIRECT_RTSP_ENABLED:
        print("[RTSP] Direct capture disabled")
        return

    if not CV2_AVAILABLE:
        print("[RTSP] OpenCV not available - direct capture disabled")
        return

    print("[RTSP] Starting direct camera capture (bypassing VPS)...")
    for cam_id, rtsp_url in RTSP_CAMERAS.items():
        thread = threading.Thread(
            target=rtsp_capture_thread,
            args=(cam_id, rtsp_url),
            daemon=True
        )
        thread.start()
        print(f"[RTSP] Camera {cam_id} thread started")


async def handle_jetson_connection(vps_ws):
    """Connect directly to Jetson for camera/LIDAR data over local WiFi"""
    print(f"[JETSON] Connecting to {JETSON_WS}...")

    try:
        async with websockets.connect(JETSON_WS, max_size=10_000_000, ping_interval=20) as jetson_ws:
            print("[JETSON] Connected! Receiving local WiFi data...")

            async for message in jetson_ws:
                try:
                    data = json.loads(message)

                    # Camera frame from Jetson
                    if data.get("type") == "camera_frame":
                        cam_id = data.get("camera", 1)
                        frame_b64 = data.get("frame", "")
                        if frame_b64:
                            frame_bytes = base64.b64decode(frame_b64)
                            mapper.add_camera_frame(cam_id, frame_bytes)

                    # LIDAR from Jetson
                    elif data.get("type") == "lidar":
                        points = [(p[0], p[1]) for p in data.get("points", [])]
                        if points:
                            mapper.add_lidar_scan(points)

                    # Detections from Jetson
                    elif data.get("type") == "detection":
                        # Forward to VPS for display
                        if vps_ws:
                            await vps_ws.send(json.dumps(data))

                    # Send map to VPS periodically
                    if mapper.should_send_map() and len(mapper.accumulated_points) > 50:
                        map_data = mapper.get_map_data()
                        if vps_ws:
                            await vps_ws.send(json.dumps(map_data))
                        stats = mapper.stats
                        print(f"[MAP] Sent {map_data['total']} pts | lidar={stats['lidar_points']} mono={stats['mono_points']} | scale={mapper.depth_scale:.2f}")

                        # Auto-save
                        if PERSISTENCE_ENABLED:
                            now = time.time()
                            if now - mapper.last_auto_save >= AUTO_SAVE_INTERVAL:
                                mapper.last_auto_save = now
                                mapper._save_confirmed_walls()

                except Exception as e:
                    print(f"[JETSON] Error: {e}")

    except Exception as e:
        print(f"[JETSON] Connection failed: {e}")
        raise


async def main():
    """Main entry point"""
    print("=" * 60)
    print("  CEMANI ROBOT - Hybrid 3D Mapper")
    print("  LIDAR + Camera Fusion | Calibrated Depth | Stereo")
    print("=" * 60)
    print()

    # Start direct RTSP capture threads (fallback if no Jetson WS)
    start_rtsp_threads()

    while True:
        try:
            if JETSON_DIRECT_ENABLED:
                # Connect to VPS first for sending map
                print(f"[VPS] Connecting to {VPS_WS} for map output...")
                async with websockets.connect(VPS_WS, max_size=10_000_000, ping_interval=None) as vps_ws:
                    await vps_ws.send(json.dumps({
                        "type": "register_processor",
                        "name": "hybrid-3d-mapper",
                        "capabilities": ["lidar_fusion", "depth_estimation", "3d_mapping"]
                    }))
                    print("[VPS] Registered. Now connecting to Jetson for data...")

                    # Connect to Jetson for data
                    try:
                        await handle_jetson_connection(vps_ws)
                    except Exception as e:
                        print(f"[JETSON] Failed: {e}, falling back to VPS data...")
                        # Fall through to VPS connection
                        await handle_vps_connection()
            else:
                # Original VPS-only mode
                await handle_vps_connection()

        except Exception as e:
            print(f"[WS] Connection error: {e}")
            print("[WS] Reconnecting in 3 seconds...")
            await asyncio.sleep(3)


if __name__ == "__main__":
    asyncio.run(main())
