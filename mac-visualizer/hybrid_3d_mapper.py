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

# Import camera calibration (intrinsics, distortion, projection helpers)
from camera_calibration import (
    get_camera_intrinsics, get_camera_extrinsics,
    project_to_3d, undistort_points,
    PROC_WIDTH, PROC_HEIGHT
)

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

# DIRECT JETSON CONNECTION (bypasses VPS for camera data)
# Camera frames: Jetson direct (local WiFi, low latency)
# LIDAR data: Still from VPS (ESP32 → VPS → Mac)
# NOTE: Run local_streamer.py on Jetson first
JETSON_DIRECT_ENABLED = True  # ENABLED - uses Jetson for cameras, VPS for LIDAR
JETSON_WS = "ws://192.168.1.228:8765"  # Jetson local WebSocket

# DIRECT RTSP - disabled for now, using VPS relay
DIRECT_RTSP_ENABLED = False  # VPS relay is more reliable
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

# Camera intrinsics - now loaded from camera_calibration.py
# Uses FOV-based focal length calculation with distortion correction
CAM_WIDTH = PROC_WIDTH   # 640
CAM_HEIGHT = PROC_HEIGHT  # 480

# Camera positions loaded from calibration module
# get_camera_extrinsics(cam_id) returns (position, base_yaw)

# LIDAR position (on top of tower)
LIDAR_HEIGHT = 0.70  # 70cm above ground
LIDAR_OFFSET = np.array([0.15, LIDAR_HEIGHT, 0.0])  # Right side of robot

# 3D mapping parameters - MAXIMUM QUALITY for beautiful maps
GRID_SIZE = 0.015  # 1.5cm grid cells - DENSER for photorealistic look
MAX_POINTS = 1000000  # 1M points for maximum detail like reference image
POINT_MERGE_DISTANCE = 0.008  # 8mm - VERY tight merging for crisp edges

# PTZ SCAN PATTERNS - triggered when robot stops during mapping
# Each position is (pan, tilt) in degrees, with dwell time in seconds
# PER-CAMERA patterns to avoid seeing the 2020 frame

# Camera 1 (front) is INSIDE the LIDAR tower - LIMITED field of view
# Pan: -45 to +45 only (frame posts block further)
# Tilt: can go all the way DOWN, only -75 UP max (negative=up, positive=down)
CAM1_SCAN_PATTERNS = {
    "mapping": [
        # Camera embedded in chassis - VERY limited range!
        # Pan: max 15° left/right before hitting frame
        # Tilt: NO down tilt (sees chassis), slight up only
        (0, 0, 0.8),      # Center (forward)
        (-15, 0, 0.8),    # Slight left
        (15, 0, 0.8),     # Slight right
        (0, 0, 0.5),      # Return to center
    ],
    "detailed": [
        (0, 0, 1.0),      # Center (forward)
        (-15, 0, 1.0),    # Slight left
        (15, 0, 1.0),     # Slight right
        (0, -5, 1.0),     # Slight UP (negative = up)
        (0, 0, 0.5),      # Return to center
    ]
}

# Camera 2 (rear) is on external arm - FULL field of view
CAM2_SCAN_PATTERNS = {
    "mapping": [
        # Full sweep - no obstructions
        (0, 0, 0.8),      # Center
        (-60, 0, 0.8),    # Left
        (60, 0, 0.8),     # Right
        (0, -25, 0.8),    # Up (can look higher)
        (0, 20, 0.8),     # Down
        (0, 0, 0.5),      # Return to center
    ],
    "detailed": [
        (0, 0, 1.0),
        (-80, 0, 1.0),
        (-40, 0, 1.0),
        (40, 0, 1.0),
        (80, 0, 1.0),
        (0, -35, 1.0),    # High up
        (0, 25, 1.0),     # Down
        (-50, -20, 1.0),
        (50, -20, 1.0),
        (0, 0, 0.5),
    ]
}

def get_ptz_pattern(camera_id: int, pattern_name: str = "mapping"):
    """Get PTZ scan pattern for specific camera"""
    if camera_id == 1:
        return CAM1_SCAN_PATTERNS.get(pattern_name, CAM1_SCAN_PATTERNS["mapping"])
    else:
        return CAM2_SCAN_PATTERNS.get(pattern_name, CAM2_SCAN_PATTERNS["mapping"])

PTZ_SCAN_ENABLED = True  # Enable automatic PTZ sweeps during mapping

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

        import sys
        print("[INIT] Depth model setup done, continuing...", file=sys.stderr, flush=True)
        sys.stderr.flush()
        sys.stdout.flush()

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

        # PTZ scan coordination
        self.ptz_scan_in_progress = False
        self.ptz_scan_queue = []  # Queue of (camera_id, pan, tilt, dwell) tuples
        self.last_ptz_scan_time = 0
        self.ptz_scan_ws = None  # WebSocket to send PTZ commands through

        # Persistence - load saved walls on startup
        print("[INIT] About to load confirmed walls...", flush=True)
        if PERSISTENCE_ENABLED:
            self._load_confirmed_walls()
        print("[INIT] Mapper initialization complete!", flush=True)

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
                    print(f"[PERSIST] Loaded {count} confirmed walls from {PERSISTENCE_FILE}", flush=True)
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
        """Initialize depth estimation model on Apple Silicon GPU (MPS)"""
        import sys
        print("[DEPTH] Loading Depth Anything V2 model...", flush=True)

        try:
            import torch

            # Device selection: Apple GPU > NVIDIA > CPU
            if torch.backends.mps.is_available():
                self.depth_device = torch.device("mps")
                # MPS works best with float32 (float16 can cause issues)
                self.depth_dtype = torch.float32
            elif torch.cuda.is_available():
                self.depth_device = torch.device("cuda")
                self.depth_dtype = torch.float16  # CUDA supports float16 well
            else:
                self.depth_device = torch.device("cpu")
                self.depth_dtype = torch.float32

            print(f"[DEPTH] Using device: {self.depth_device} (dtype={self.depth_dtype})", flush=True)

            # Load model with explicit device and dtype
            from transformers import AutoImageProcessor, AutoModelForDepthEstimation

            model_name = "depth-anything/Depth-Anything-V2-Small-hf"
            print(f"[DEPTH] Loading {model_name}...", flush=True)

            self.depth_processor = AutoImageProcessor.from_pretrained(model_name)
            self.depth_model = AutoModelForDepthEstimation.from_pretrained(
                model_name,
                torch_dtype=self.depth_dtype
            ).to(self.depth_device)

            # Set to eval mode for inference (disables dropout, etc.)
            self.depth_model.eval()

            # Warmup run to compile any JIT operations
            print("[DEPTH] Running warmup on GPU...", flush=True)
            dummy = Image.new("RGB", (256, 192), color="gray")
            with torch.no_grad():
                inputs = self.depth_processor(images=dummy, return_tensors="pt")
                inputs = {k: v.to(self.depth_device, dtype=self.depth_dtype if v.dtype == torch.float32 else v.dtype) for k, v in inputs.items()}
                _ = self.depth_model(**inputs)

            # Clear MPS cache after warmup
            if self.depth_device.type == "mps":
                torch.mps.empty_cache()

            print(f"[DEPTH] Model ready on {self.depth_device}!", flush=True)

            # Set flag instead of using pipeline
            self.depth_pipe = True  # Flag to indicate model is ready

        except Exception as e:
            print(f"[DEPTH] Failed to load model: {e}", flush=True)
            import traceback
            traceback.print_exc()
            self.depth_pipe = None
            self.depth_model = None
            self.depth_processor = None

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

        # Camera parameters from calibration
        cam_id = frame.camera_id
        cam_offset, cam_yaw = get_camera_extrinsics(cam_id)
        pan_rad = math.radians(frame.pan)
        tilt_rad = math.radians(frame.tilt)

        h, w = frame.image.shape[:2]
        fx, fy, cx, cy, _, _ = get_camera_intrinsics(cam_id, w, h)

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
            print(f"[FUSION] Cam{cam_id}: Colored {colored_count} LIDAR points", flush=True)

    def _process_frame_with_mono_depth(self, frame: CameraFrame):
        """
        Monocular depth estimation with LIDAR-calibrated scale.
        Uses Depth Anything V2 on Apple Silicon GPU for fast inference.
        """
        if not self.depth_pipe or not hasattr(self, 'depth_model') or self.depth_model is None:
            return

        try:
            import torch

            # Resize image for depth estimation (smaller = faster)
            img = Image.fromarray(frame.image)
            img_small = img.resize((518, 392))  # Optimal size for Depth Anything V2

            # Preprocess on CPU, then move to GPU
            with torch.no_grad():
                inputs = self.depth_processor(images=img_small, return_tensors="pt")

                # Move tensors to GPU with correct dtype
                inputs = {
                    k: v.to(self.depth_device, dtype=self.depth_dtype if v.dtype == torch.float32 else v.dtype)
                    for k, v in inputs.items()
                }

                # Run inference on GPU
                outputs = self.depth_model(**inputs)
                predicted_depth = outputs.predicted_depth

                # Interpolate to original size and convert to numpy
                depth_map = torch.nn.functional.interpolate(
                    predicted_depth.unsqueeze(1),
                    size=(frame.image.shape[0], frame.image.shape[1]),
                    mode="bicubic",
                    align_corners=False
                ).squeeze().cpu().numpy()

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
        cam_offset, cam_yaw = get_camera_extrinsics(cam_id)
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
        cam_offset, cam_yaw = get_camera_extrinsics(cam_id)
        pan_rad = math.radians(frame.pan)
        tilt_rad = math.radians(frame.tilt)

        h, w = depth_map.shape
        img_h, img_w = frame.image.shape[:2]

        # Normalize depth
        depth_norm = depth_map / (depth_map.max() + 1e-8)
        depth_meters = (1.0 - depth_norm) * self.depth_scale + 0.3

        # Camera intrinsics from calibration, scaled to depth map size
        fx, fy, cx, cy, _, _ = get_camera_intrinsics(cam_id, w, h)

        step = SAMPLE_DENSITY  # Sample every Nth pixel (6=reasonable, 1=too slow)
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
                    confidence=0.3,  # Low confidence - monocular depth is noisy
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
            # Get calibrated focal length for cam1 at scaled resolution
            sh, sw = gray1.shape
            fx, _, _, _, _, _ = get_camera_intrinsics(1, sw, sh)
            focal = fx

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
        cam_id = frame.camera_id
        cam_offset, _ = get_camera_extrinsics(cam_id)

        h, w = depth.shape
        img = cv2.resize(frame.image, (w, h))

        # Get calibrated intrinsics scaled to depth map size
        fx, fy, cx, cy, _, _ = get_camera_intrinsics(cam_id, w, h)

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

                # Transform to robot then world frame (using calibrated offsets)
                robot_x = x_rot + cam_offset[0]
                robot_y = z_final + cam_offset[2]
                robot_z = -y_rot + cam_offset[1]

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
        """Get accumulated map data for transmission - FILTERED for quality"""
        # First clean up old/moving points
        self._cleanup_old_points(time.time())

        points = []
        static_count = 0
        pending_count = 0
        filtered_count = 0

        # ======== AGGRESSIVE QUALITY FILTERS ========
        # LIDAR is accurate, monocular depth is noisy - filter heavily!
        MIN_OBSERVATIONS = 5       # Must be seen 5+ times (removes single-frame noise)
        MIN_CONFIDENCE = 0.6       # Filters out monocular (0.3) but keeps LIDAR (0.9)
        MIN_HEIGHT = 0.10          # 10cm above floor (removes floor noise)
        MAX_HEIGHT = 2.2           # 2.2m max (removes ceiling, keep walls only)
        VOXEL_SIZE = 0.05          # 5cm voxel grid - coarser = cleaner
        LIDAR_PRIORITY = True      # Always include LIDAR points even with fewer observations

        # Limit points to prevent WebSocket overflow
        MAX_SEND_POINTS = 30000    # Reduced for cleaner UI

        # Sort by confidence and observations for priority
        sorted_points = sorted(
            self.accumulated_points.values(),
            key=lambda p: (p.confidence, p.observations),
            reverse=True
        )

        # Voxel grid for downsampling (only send one point per 3cm cube)
        voxel_grid = set()

        for p in sorted_points:
            # Only send points that have been seen enough times (static objects)
            if not p.is_static:
                pending_count += 1
                continue

            static_count += 1

            # ======== APPLY QUALITY FILTERS ========
            # LIDAR points get priority - they are accurate!
            is_lidar = p.source == "lidar"

            # 1. Observation filter - relax for LIDAR (accurate), strict for mono (noisy)
            min_obs = 2 if is_lidar else MIN_OBSERVATIONS  # LIDAR needs only 2 obs
            if p.observations < min_obs:
                filtered_count += 1
                continue

            # 2. Confidence filter - LIDAR always passes (0.9 > 0.6)
            if p.confidence < MIN_CONFIDENCE:
                filtered_count += 1
                continue

            # 3. Height filter - focus on walls (not floor/ceiling)
            if p.z < MIN_HEIGHT or p.z > MAX_HEIGHT:
                filtered_count += 1
                continue

            # 4. Voxel downsampling - one point per 3cm cube
            vx = int(p.x / VOXEL_SIZE)
            vy = int(p.y / VOXEL_SIZE)
            vz = int(p.z / VOXEL_SIZE)
            voxel_key = (vx, vy, vz)
            if voxel_key in voxel_grid:
                filtered_count += 1
                continue
            voxel_grid.add(voxel_key)

            # Passed all filters - add to output
            if len(points) < MAX_SEND_POINTS:
                # Compact format: use arrays instead of dicts to save bandwidth
                points.append([
                    round(p.x, 2), round(p.y, 2), round(p.z, 2),
                    p.r, p.g, p.b,
                    p.observations  # Include obs count for UI filtering
                ])

        return {
            "type": "accumulated_map",
            "points": points,
            "total": len(points),
            "static_points": static_count,
            "pending_points": pending_count,
            "filtered_points": filtered_count,
            "stats": self.stats,
            "format": "compact"  # [x, y, z, r, g, b, obs] arrays
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

    async def execute_ptz_scan(self, ws, pattern_name: str = "mapping"):
        """
        Execute a PTZ scan pattern on both cameras with PER-CAMERA limits.
        Called when robot stops during mapping (ready_for_scan message).

        Camera 1 (front) is inside the LIDAR tower frame - LIMITED view.
        Camera 2 (rear) is on external arm - FULL view.

        Args:
            ws: WebSocket connection to send PTZ commands through
            pattern_name: Name of pattern ("mapping" or "detailed")
        """
        if not PTZ_SCAN_ENABLED:
            print("[PTZ] Scan disabled")
            return

        if self.ptz_scan_in_progress:
            print("[PTZ] Scan already in progress, skipping")
            return

        cam1_pattern = get_ptz_pattern(1, pattern_name)
        cam2_pattern = get_ptz_pattern(2, pattern_name)

        print(f"[PTZ] Starting '{pattern_name}' scan (cam1: {len(cam1_pattern)} pos, cam2: {len(cam2_pattern)} pos)")
        self.ptz_scan_in_progress = True
        self.last_ptz_scan_time = time.time()

        try:
            # Scan each camera with its own pattern
            for camera_id in [1, 2]:
                pattern = get_ptz_pattern(camera_id, pattern_name)
                for pan, tilt, dwell in pattern:
                    # Send PTZ command
                    ptz_cmd = {
                        "type": "ptz",
                        "camera": camera_id,
                        "action": "absolute",
                        "pan": pan,
                        "tilt": tilt
                    }
                    await ws.send(json.dumps(ptz_cmd))

                    # Update local tracking
                    self.camera_ptz[camera_id] = (pan, tilt)

                    # Wait for camera to move and capture frames
                    await asyncio.sleep(dwell)

                    # Log progress
                    print(f"[PTZ] Cam{camera_id} at ({pan}, {tilt})")

            # Return cameras to center
            for camera_id in [1, 2]:
                await ws.send(json.dumps({
                    "type": "ptz",
                    "camera": camera_id,
                    "action": "absolute",
                    "pan": 0,
                    "tilt": 0
                }))
                self.camera_ptz[camera_id] = (0, 0)

            scan_duration = time.time() - self.last_ptz_scan_time
            print(f"[PTZ] Scan complete in {scan_duration:.1f}s")

        except Exception as e:
            print(f"[PTZ] Scan error: {e}")

        finally:
            self.ptz_scan_in_progress = False


# ============ WEBSOCKET CLIENT ============
mapper = Hybrid3DMapper()

async def handle_vps_connection():
    """Connect to VPS and process data streams"""
    import sys
    print(f"[WS] Connecting to {VPS_WS}...", flush=True)
    sys.stdout.flush()

    async with websockets.connect(VPS_WS, max_size=10_000_000, ping_interval=None, ping_timeout=None) as ws:
        print("[WS] Connected! Registering as hybrid-3d-mapper...", flush=True)

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
                    print(f"[MAP] Sent {map_data['total']} points | lidar={stats['lidar_points']} mono={stats['mono_points']} stereo={stats['stereo_points']} | scale={mapper.depth_scale:.2f}", flush=True)

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
    import sys

    if not DIRECT_RTSP_ENABLED:
        print("[RTSP] Direct capture disabled", flush=True)
        sys.stdout.flush()
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


async def handle_jetson_cameras(jetson_connected_event):
    """Receive camera frames directly from Jetson over local WiFi"""
    print(f"[JETSON] Connecting to {JETSON_WS} for cameras...")
    jetson_logged_offline = False  # Only log offline once to reduce spam

    while True:
        try:
            async with websockets.connect(JETSON_WS, max_size=10_000_000, ping_interval=20, open_timeout=5) as jetson_ws:
                print("[JETSON] Connected! Receiving camera frames via local WiFi...", flush=True)
                jetson_connected_event.set()
                jetson_logged_offline = False  # Reset so we log next disconnect

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

                        # Detections from Jetson (if it's doing detection too)
                        elif data.get("type") == "detections":
                            pass  # Let VPS handle detection display

                    except Exception as e:
                        print(f"[JETSON] Frame error: {e}")

        except Exception as e:
            jetson_connected_event.clear()
            if not jetson_logged_offline:
                print(f"[JETSON] Offline (will retry every 60s): {e}")
                jetson_logged_offline = True
            await asyncio.sleep(60)  # Retry every 60s instead of 3s


async def handle_hybrid_connection():
    """
    Hybrid mode: Cameras from Jetson (direct), LIDAR from VPS
    This gives best of both worlds:
    - Low latency camera frames via local WiFi
    - LIDAR data still flows through VPS (from ESP32)
    """
    jetson_connected = asyncio.Event()

    # Start Jetson camera receiver in background
    jetson_task = asyncio.create_task(handle_jetson_cameras(jetson_connected))

    print(f"[VPS] Connecting to {VPS_WS} for LIDAR + map output...")

    # Disable ping/pong - GPU depth estimation can block the event loop, causing ping timeouts
    async with websockets.connect(VPS_WS, max_size=10_000_000, ping_interval=None, ping_timeout=None) as ws:
        print("[VPS] Connected!", flush=True)

        # Small delay to let server fully establish connection
        await asyncio.sleep(0.5)

        # Register as processor - MUST be first message!
        reg_msg = json.dumps({
            "type": "register_processor",
            "name": "hybrid-3d-mapper",
            "capabilities": ["lidar_fusion", "depth_estimation", "3d_mapping", "jetson_direct"]
        })
        print(f"[VPS] Sending register_processor ({len(reg_msg)} bytes): {reg_msg[:80]}...", flush=True)
        try:
            await ws.send(reg_msg)
            print("[VPS] register_processor SENT SUCCESSFULLY!", flush=True)
        except Exception as e:
            print(f"[VPS] FAILED to send register_processor: {e}", flush=True)

        # Give server time to process before sending data
        await asyncio.sleep(0.2)

        print("[WS] Waiting for data streams...", flush=True)
        print("[WS] Features enabled:", flush=True)
        print(f"     - Camera Source: {'JETSON DIRECT' if JETSON_DIRECT_ENABLED else 'VPS relay'}", flush=True)
        print(f"     - LIDAR Source: VPS (ESP32)", flush=True)
        print(f"     - Monocular Depth: {'YES' if DEPTH_AVAILABLE else 'NO'}", flush=True)
        print(f"     - Stereo Depth: {'YES' if CV2_AVAILABLE else 'NO'}", flush=True)
        print(f"     - Surface Reconstruction: {'YES' if O3D_AVAILABLE else 'NO (missing open3d)'}", flush=True)

        async for message in ws:
            try:
                # Skip binary messages (camera frames from VPS - we get cameras from Jetson now)
                if isinstance(message, bytes):
                    # Only process VPS camera frames if Jetson not connected
                    if not jetson_connected.is_set() and len(message) > 100:
                        first_byte = message[0]
                        if first_byte in [0, 2]:  # video packets
                            cam_id = (first_byte // 2) + 1
                            frame_data = message[1:]
                            mapper.add_camera_frame(cam_id, bytes(frame_data))
                    continue

                data = json.loads(message)

                # LIDAR from VPS (ESP32 → VPS → Mac)
                if data.get("type") == "lidar":
                    points = [(p[0], p[1]) for p in data.get("points", [])]
                    if points:
                        mapper.add_lidar_scan(points)

                # PTZ status - update camera angles
                elif data.get("type") == "ptz_status":
                    cam = data.get("camera", 1)
                    mapper.update_camera_ptz(cam, data.get("pan", 0), data.get("tilt", 0))

                # Dead reckoning - update robot pose
                elif data.get("type") == "dead_reckoning":
                    mapper.update_pose(
                        data.get("odomX", 0),
                        data.get("odomY", 0),
                        data.get("odomHeading", 0)
                    )

                # Clear map command
                elif data.get("type") == "clear_3d_map":
                    print("[MAP] Clearing accumulated points...")
                    mapper.accumulated_points.clear()
                    mapper.stats = {"lidar_points": 0, "mono_points": 0, "stereo_points": 0, "total_points": 0, "depth_scale": mapper.depth_scale}

                # ========== PTZ SCAN TRIGGER ==========
                # Robot stopped during mapping - time to sweep the cameras!
                elif data.get("type") == "ready_for_scan":
                    robot_x = data.get("robot_x", 0)
                    robot_y = data.get("robot_y", 0)
                    robot_heading = data.get("robot_heading", 0)
                    print(f"[PTZ] Ready for scan at ({robot_x:.0f}, {robot_y:.0f}) heading={robot_heading:.0f}°")

                    # Update robot pose from the scan message
                    mapper.update_pose(robot_x, robot_y, robot_heading)

                    # Execute PTZ scan pattern (non-blocking via asyncio)
                    asyncio.create_task(mapper.execute_ptz_scan(ws, "mapping"))

                # Periodically send map to VPS
                now = time.time()
                if now - mapper.last_map_send >= mapper.MAP_SEND_INTERVAL:
                    mapper.last_map_send = now
                    if len(mapper.accumulated_points) > 50:
                        map_data = mapper.get_map_data()
                        try:
                            map_json = json.dumps(map_data)
                            await ws.send(map_json)
                            print(f"[DEBUG] Sent {len(map_json)} bytes to VPS", flush=True)
                        except Exception as e:
                            print(f"[ERROR] Failed to send map: {e}", flush=True)
                            raise  # Re-raise to trigger reconnect
                        stats = mapper.stats
                        jetson_status = "DIRECT" if jetson_connected.is_set() else "vps"
                        print(f"[MAP] Sent {map_data['total']} points | lidar={stats['lidar_points']} mono={stats['mono_points']} | cam={jetson_status} | scale={mapper.depth_scale:.2f}", flush=True)

                        # Auto-save
                        if PERSISTENCE_ENABLED and now - mapper.last_auto_save >= AUTO_SAVE_INTERVAL:
                            mapper.last_auto_save = now
                            mapper._save_confirmed_walls()

            except json.JSONDecodeError:
                pass
            except Exception as e:
                print(f"[WS] Error: {e}", flush=True)

    # Cancel Jetson task on disconnect
    jetson_task.cancel()


async def main():
    """Main entry point"""
    import sys
    print("=" * 60, flush=True)
    print("  CEMANI ROBOT - Hybrid 3D Mapper", flush=True)
    print("  LIDAR + Camera Fusion | Calibrated Depth | Stereo", flush=True)
    print("=" * 60, flush=True)
    print(flush=True)
    sys.stdout.flush()

    # Start direct RTSP capture threads (only used if not in Jetson direct mode)
    if not JETSON_DIRECT_ENABLED:
        start_rtsp_threads()

    while True:
        try:
            if JETSON_DIRECT_ENABLED:
                # Hybrid mode: cameras from Jetson, LIDAR from VPS
                print("[MODE] Hybrid: Cameras=Jetson direct, LIDAR=VPS", flush=True)
                await handle_hybrid_connection()
            else:
                # Original VPS-only mode
                print("[MODE] VPS-only: All data from VPS", flush=True)
                await handle_vps_connection()

        except Exception as e:
            print(f"[WS] Connection error: {e}")
            print("[WS] Reconnecting in 3 seconds...")
            await asyncio.sleep(3)


if __name__ == "__main__":
    asyncio.run(main())
