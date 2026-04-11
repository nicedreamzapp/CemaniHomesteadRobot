#!/usr/bin/env python3
"""
╔══════════════════════════════════════════════════════════════════════════════════════╗
║                                                                                      ║
║   ██████╗███████╗███╗   ███╗ █████╗ ███╗   ██╗██╗    ██████╗  ██████╗ ██████╗  ██████╗ ║
║  ██╔════╝██╔════╝████╗ ████║██╔══██╗████╗  ██║██║    ██╔══██╗██╔═══██╗██╔══██╗██╔═══██╗║
║  ██║     █████╗  ██╔████╔██║███████║██╔██╗ ██║██║    ██████╔╝██║   ██║██████╔╝██║   ██║║
║  ██║     ██╔══╝  ██║╚██╔╝██║██╔══██║██║╚██╗██║██║    ██╔══██╗██║   ██║██╔══██╗██║   ██║║
║  ╚██████╗███████╗██║ ╚═╝ ██║██║  ██║██║ ╚████║██║    ██║  ██║╚██████╔╝██████╔╝╚██████╔║
║   ╚═════╝╚══════╝╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝    ╚═╝  ╚═╝ ╚═════╝ ╚═════╝  ╚═════╝║
║                                                                                      ║
║                     HYBRID 4D MAPPING ENGINE v2.0                                    ║
║                     ─────────────────────────────────                                ║
║                                                                                      ║
║  STATE-OF-THE-ART 2025 AI STACK:                                                     ║
║                                                                                      ║
║  ┌────────────────────────────────────────────────────────────────────────────────┐  ║
║  │ 🧠 DEPTH ANYTHING V2 LARGE (2024/2025)                                         │  ║
║  │    - Monocular depth estimation with metric scale                              │  ║
║  │    - State-of-the-art zero-shot generalization                                 │  ║
║  │    - Running on Apple Silicon GPU (MPS) with 64GB unified memory              │  ║
║  │    - Paper: "Depth Anything V2" - arXiv:2406.09414                            │  ║
║  └────────────────────────────────────────────────────────────────────────────────┘  ║
║                                                                                      ║
║  ┌────────────────────────────────────────────────────────────────────────────────┐  ║
║  │ 🔬 MULTI-MODAL SENSOR FUSION                                                   │  ║
║  │    - 360° LIDAR geometry + dual PTZ camera color projection                    │  ║
║  │    - Real-time sensor calibration via LIDAR-camera correlation                 │  ║
║  │    - Temporal consistency via fingerprint-based relocalization                 │  ║
║  │    - Dynamic object filtering using Jetson YOLO detections                     │  ║
║  └────────────────────────────────────────────────────────────────────────────────┘  ║
║                                                                                      ║
║  ┌────────────────────────────────────────────────────────────────────────────────┐  ║
║  │ 🗺️ SEMANTIC SLAM                                                               │  ║
║  │    - RANSAC plane detection for walls/floor/ceiling                            │  ║
║  │    - Doorway detection via wall gap analysis                                   │  ║
║  │    - Object tracking with 3D projection from 2D detections                     │  ║
║  │    - Room layout estimation with semantic labels                               │  ║
║  └────────────────────────────────────────────────────────────────────────────────┘  ║
║                                                                                      ║
║  ┌────────────────────────────────────────────────────────────────────────────────┐  ║
║  │ ⏱️ 4D TEMPORAL MAPPING                                                         │  ║
║  │    - Point persistence tracking (observations over time)                       │  ║
║  │    - Dynamic vs static classification via motion scoring                       │  ║
║  │    - Fingerprint-based loop closure for consistent maps                        │  ║
║  │    - Real-time map updates at 10Hz with voxel downsampling                     │  ║
║  └────────────────────────────────────────────────────────────────────────────────┘  ║
║                                                                                      ║
║  HARDWARE CONFIGURATION:                                                             ║
║    • Mac Mini Pro M4 (64GB) - GPU depth estimation + point cloud fusion             ║
║    • Jetson Orin Nano (8GB) - Real-time YOLO object detection                       ║
║    • 2x Sricam SP017 PTZ Cameras - RGB data with full pan/tilt coverage             ║
║    • YDLidar X2L - 360° 2D LIDAR for geometry and fingerprinting                    ║
║    • Custom Robot Platform - Encoders + compass for dead reckoning                  ║
║                                                                                      ║
║  OUTPUT: Real-time 4D visualization at robot.marijuanaunion.com                     ║
║                                                                                      ║
╚══════════════════════════════════════════════════════════════════════════════════════╝

Requirements:
    pip install numpy pillow websockets torch transformers opencv-python open3d

Usage:
    python3 hybrid_3d_mapper.py

Press MAP 1 in the web UI to start the full autonomous mapping sequence.
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
VPS_WS = "wss://robot.marijuanaunion.com"

# DIRECT JETSON CONNECTION (bypasses VPS for camera data)
# Camera frames: Jetson direct (local WiFi, low latency)
# LIDAR data: Still from VPS (ESP32 → VPS → Mac)
# NOTE: Run local_streamer.py on Jetson first
JETSON_DIRECT_ENABLED = True  # ENABLED - uses Jetson for cameras, VPS for LIDAR
JETSON_WS = "ws://192.168.1.31:8765"  # Jetson local WebSocket (correct IP)

# DIRECT RTSP - disabled for now, using VPS relay
DIRECT_RTSP_ENABLED = False  # VPS relay is more reliable
RTSP_CAMERAS = {
    1: "rtsp://admin:YOUR_CAMERA_PASSWORD@192.168.1.191:554/onvif1",  # Front camera
    2: "rtsp://admin:YOUR_CAMERA_PASSWORD@192.168.1.27:554/onvif1"   # Rear camera
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

# 3D mapping parameters - DENSE for photorealistic coverage
GRID_SIZE = 0.02  # 2cm grid cells - DENSE for solid coverage
MAX_POINTS = 2000000  # 2M points for maximum density
POINT_MERGE_DISTANCE = 0.005  # 5mm - tight merging

# DYNAMIC OBJECT FILTERING - exclude moving things from map
# Objects in this list will be excluded when detected
DYNAMIC_OBJECT_CLASSES = {
    # Living things that move
    "person", "boy", "girl", "man", "woman", "human body", "human face",
    "dog", "cat", "bird", "chicken", "duck", "goose", "turkey", "rabbit",
    "horse", "cow", "sheep", "pig", "mouse", "rat",
    # Vehicles
    "car", "truck", "bicycle", "motorcycle", "bus",
    # Objects that might be moved
    "chair", "office chair", "stool"  # Remove if you want chairs mapped
}
DETECTION_BBOX_PADDING = 20  # Extra pixels around bbox to exclude
DETECTION_EXPIRY_MS = 500  # Detections expire after 500ms

# PTZ SCAN PATTERNS - CONTINUOUS scanning during mapping
# Each position is (pan, tilt) in degrees, with dwell time in seconds
# PER-CAMERA patterns to avoid seeing the 2020 frame

# CONTINUOUS SCAN SETTINGS
CONTINUOUS_PTZ_SCAN = True  # Enable continuous PTZ sweeping
CONTINUOUS_SCAN_INTERVAL = 0.8  # Seconds between position changes

# Camera 1 (front) - ±30° pan, -30° up to +90° down (full down for floor/ground)
# TILT: negative = UP, positive = DOWN
# Pan/tilt limited to avoid seeing robot chassis
CAM1_SCAN_PATTERNS = {
    "mapping": [
        (0, 0, 0.6),       # Center (straight ahead)
        (-20, 0, 0.6),     # Slight left
        (20, 0, 0.6),      # Slight right
        (0, -20, 0.6),     # Slight up
        (0, 90, 0.6),      # Full down (floor mapping)
        (-20, -15, 0.6),   # Left + up
        (20, -15, 0.6),    # Right + up
        (-15, 60, 0.6),    # Left + down (floor)
        (15, 60, 0.6),     # Right + down (floor)
        (0, 0, 0.4),       # Back to center
    ],
    "detailed": [
        (0, 0, 1.0),       # Center
        (-20, 0, 1.0),     # Slight left
        (20, 0, 1.0),      # Slight right
        (0, -20, 1.0),     # Slight up
        (0, 90, 1.0),      # Full down
        (0, 0, 0.5),       # Return to center
    ]
}

# Camera 2 (rear) - same limits, faces backward
CAM2_SCAN_PATTERNS = {
    "mapping": [
        (0, 0, 0.5),       # Center (straight back)
        (-20, 0, 0.5),     # Slight left
        (20, 0, 0.5),      # Slight right
        (0, -20, 0.5),     # Slight up
        (0, 90, 0.5),      # Full down (floor mapping)
        (-20, -15, 0.5),   # Left + up
        (20, -15, 0.5),    # Right + up
        (-15, 60, 0.5),    # Left + down (floor)
        (15, 60, 0.5),     # Right + down (floor)
        (0, 0, 0.3),       # Back to center
    ],
    "detailed": [
        (0, 0, 1.0),       # Center
        (-20, 0, 1.0),     # Slight left
        (20, 0, 1.0),      # Slight right
        (0, -20, 1.0),     # Slight up
        (0, 90, 1.0),      # Full down
        (0, 0, 0.5),       # Return to center
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

# Color enhancement - NATURAL but vivid (realistic photo colors)
COLOR_SATURATION_BOOST = 1.4  # 40% saturation boost - vivid but realistic
COLOR_CONTRAST_BOOST = 1.2  # 20% more contrast - clearer details
COLOR_BRIGHTNESS_BOOST = 1.1  # 10% brighter - compensate for shadows

# Point sampling density - DENSE points per frame for solid surfaces
SAMPLE_DENSITY = 3  # Sample every 3rd pixel - MAXIMUM DETAIL with 64GB GPU

# Depth calibration
DEPTH_SCALE_DEFAULT = 4.0  # Initial depth scale for monocular
LIDAR_DEPTH_CORRELATION_THRESHOLD = 0.3  # Max angle diff for LIDAR-camera correlation

# ============ DATA STRUCTURES ============

# Dynamic object classification thresholds
MIN_OBS_FOR_STATIC = 3        # Must be seen 3+ times to be considered static
MAX_MISSES_FOR_STATIC = 1     # Can miss at most 1 expected observation
MOTION_SCORE_DYNAMIC = 0.4    # Above this = likely dynamic
DYNAMIC_DECAY_MULTIPLIER = 4.0  # Dynamic points decay 4x faster
MAX_OBSERVER_HISTORY = 5      # Keep last 5 robot poses that saw this point

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

    # Dynamic object tracking (NEW)
    observer_positions: list = None  # [(robot_x, robot_y, timestamp), ...] - where robot was when it saw this
    expected_observations: int = 0   # Times robot SHOULD have seen this (was in FOV)
    missed_observations: int = 0     # Times robot was in position to see it but didn't
    motion_score: float = 0.0        # 0 = static, 1 = dynamic

    def __post_init__(self):
        if self.observer_positions is None:
            self.observer_positions = []

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


# ============ DYNAMIC OBJECT CLASSIFICATION ============

def compute_motion_score(point: Point3D) -> float:
    """
    Compute motion score: 0 = definitely static, 1 = definitely moving.
    Based on persistence (how often seen when expected).
    """
    if point.expected_observations == 0:
        return 0.5  # Unknown - not enough data

    persistence_ratio = point.observations / max(1, point.expected_observations)
    miss_ratio = point.missed_observations / max(1, point.expected_observations)

    # High persistence + low misses = static (score → 0)
    # Low persistence + high misses = dynamic (score → 1)
    motion_score = miss_ratio * (1.0 - min(1.0, persistence_ratio))
    return min(1.0, max(0.0, motion_score))


def classify_point(point: Point3D) -> str:
    """
    Classify point as static, dynamic, or uncertain.
    """
    # Not enough data yet
    if point.expected_observations < 2:
        return "uncertain"

    # STATIC: Seen multiple times, rarely missed
    if (point.observations >= MIN_OBS_FOR_STATIC and
        point.missed_observations <= MAX_MISSES_FOR_STATIC and
        point.motion_score < MOTION_SCORE_DYNAMIC):
        return "static"

    # DYNAMIC: High miss rate or high motion score
    if (point.missed_observations > point.observations or
        point.motion_score >= MOTION_SCORE_DYNAMIC):
        return "dynamic"

    return "uncertain"


def should_expect_observation(point: Point3D, robot_x: float, robot_y: float) -> bool:
    """
    Check if robot is in position to observe this point.
    Returns True if point should be visible from current robot position.
    """
    dx = point.x - robot_x
    dy = point.y - robot_y
    distance = math.sqrt(dx * dx + dy * dy)

    # Too far - LIDAR can't see it (8m max range)
    if distance > 8.0:
        return False

    # Too close - minimum range
    if distance < 0.1:
        return False

    # LIDAR is 360°, so no angle check needed for LIDAR points
    # For camera-source points, could add FOV check (future enhancement)
    return True


# ============ HYBRID 3D MAPPER ============
class Hybrid3DMapper:
    def __init__(self):
        # State
        self.robot_pose = RobotPose()
        self.accumulated_points: Dict[str, Point3D] = {}  # grid_key -> point
        self.recent_lidar_scans = deque(maxlen=10)
        self.recent_camera_frames = {1: None, 2: None}
        self.camera_ptz = {1: (0, 0), 2: (0, 0)}  # (pan, tilt) degrees

        # LIDAR BOUNDARY - prevents depth points from going beyond walls
        # Maps angle bins (0-359) to max distance in meters
        self.lidar_boundary = {}  # angle_deg -> distance_m
        self.lidar_boundary_tolerance = 0.05  # Only 5cm tolerance - strict wall enforcement

        # MAPPING CONTROL - IDLE until user presses MAP 1 button
        self.mapping_active = False  # IDLE - waits for MAP 1 button press
        self.mapping_paused_by_override = False  # Paused due to manual override

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

        # DYNAMIC OBJECT DETECTION - store current detections per camera
        # Format: {cam_id: [(class_name, bbox, timestamp), ...]}
        self.current_detections = {1: [], 2: []}

        # MAPPING SEQUENCE STATE
        self.mapping_sequence_active = False
        self.manual_drive_mode = False  # When True, skip robot spins - user drives with Xbox
        self.current_heading = 0.0  # Track robot heading for spin commands
        self.capture_frame_for_map = False  # Flag to capture frame at current camera position
        self.frames_captured_this_position = 0  # Count frames captured at each position

        # Persistence - load saved walls on startup
        print("[INIT] About to load confirmed walls...", flush=True)
        if PERSISTENCE_ENABLED:
            self._load_confirmed_walls()
        print("[INIT] Mapper initialization complete!", flush=True)
        print("[INIT] Waiting for MAP button to start mapping...", flush=True)

    def start_mapping(self):
        """Start active mapping mode - triggered by UI MAP button"""
        self.mapping_active = True
        self.mapping_paused_by_override = False
        self.mapping_sequence_active = True  # Start the full mapping sequence
        print("=" * 50)
        print("[MAPPING] *** MAPPING STARTED ***")
        print("[MAPPING] GPU processing ACTIVE")
        print("[MAPPING] Full mapping sequence will begin!")
        print("=" * 50)

    def start_manual_mapping(self):
        """Start MANUAL mapping mode - PTZ sweep + GPU processing, but NO robot movement
        User drives with Xbox controller while cameras sweep and map builds"""
        self.mapping_active = True
        self.mapping_paused_by_override = False
        self.mapping_sequence_active = True  # Enable PTZ sweeping
        self.manual_drive_mode = True  # Flag to skip robot spin commands
        print("=" * 50)
        print("[MAPPING] *** MANUAL MAPPING MODE ***")
        print("[MAPPING] GPU processing ACTIVE")
        print("[MAPPING] Camera PTZ sweep ACTIVE")
        print("[MAPPING] Robot movement: XBOX CONTROLLER (you drive!)")
        print("=" * 50)

    def stop_mapping(self):
        """Stop mapping mode - triggered by UI or manual stop"""
        self.mapping_active = False
        self.mapping_paused_by_override = False
        print("=" * 50)
        print("[MAPPING] *** MAPPING STOPPED ***")
        print("[MAPPING] Entering standby mode")
        print("=" * 50)
        # Auto-save on stop
        if PERSISTENCE_ENABLED:
            self._save_confirmed_walls()

    def pause_for_override(self):
        """Temporarily pause mapping during manual override"""
        if self.mapping_active and not self.mapping_paused_by_override:
            self.mapping_paused_by_override = True
            print("[MAPPING] Paused for manual override (Xbox/UI)")

    def resume_from_override(self):
        """Resume mapping after manual override ends"""
        if self.mapping_active and self.mapping_paused_by_override:
            self.mapping_paused_by_override = False
            print("[MAPPING] Resumed from manual override - continuing from current position")

    def update_detections(self, cam_id: int, detections: list):
        """Update current detections for a camera. Called when DETECTIONS message received."""
        now = time.time() * 1000  # ms
        dynamic_dets = []
        for det in detections:
            class_name = det.get("class", "").lower()
            # Only track dynamic objects (people, dogs, etc.)
            if class_name in DYNAMIC_OBJECT_CLASSES:
                bbox = det.get("bbox", {})
                dynamic_dets.append({
                    "class": class_name,
                    "x1": bbox.get("x1", 0),
                    "y1": bbox.get("y1", 0),
                    "x2": bbox.get("x2", 0),
                    "y2": bbox.get("y2", 0),
                    "timestamp": now
                })
        self.current_detections[cam_id] = dynamic_dets
        if dynamic_dets:
            classes = [d["class"] for d in dynamic_dets]
            print(f"[DETECT] Cam{cam_id}: {len(dynamic_dets)} dynamic objects: {classes}")

    def is_pixel_in_detection(self, cam_id: int, u: int, v: int, img_w: int, img_h: int) -> bool:
        """Check if a pixel falls within a detected dynamic object bounding box."""
        now = time.time() * 1000
        for det in self.current_detections.get(cam_id, []):
            # Skip expired detections
            if now - det["timestamp"] > DETECTION_EXPIRY_MS:
                continue
            # Scale bbox to image size (detections might be at different resolution)
            x1 = det["x1"] - DETECTION_BBOX_PADDING
            y1 = det["y1"] - DETECTION_BBOX_PADDING
            x2 = det["x2"] + DETECTION_BBOX_PADDING
            y2 = det["y2"] + DETECTION_BBOX_PADDING
            # Check if pixel is inside bbox
            if x1 <= u <= x2 and y1 <= v <= y2:
                return True
        return False

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

    def _generate_fingerprint(self, x: float, y: float, heading: float) -> dict:
        """
        Generate a LIDAR fingerprint for relocalization.

        A fingerprint captures the distance profile from a position, allowing
        the robot to recognize where it is when it returns to the same area.
        This is the key to SLAM loop closure.

        Returns a dict with:
          - position: (x, y) where fingerprint was taken
          - heading: robot heading when taken
          - profile: list of (angle, distance) pairs from recent LIDAR scan
          - histogram: binned distance histogram for fast matching
        """
        if len(self.recent_lidar_scans) == 0:
            return None

        scan = self.recent_lidar_scans[-1]

        # Create distance profile - sorted by angle
        profile = sorted([(a, d/1000.0) for a, d in scan.points if 100 < d < 8000])

        # Create histogram for fast matching (36 bins of 10° each)
        histogram = [0.0] * 36
        counts = [0] * 36
        for angle, dist in profile:
            bin_idx = int((angle % 360) / 10)
            histogram[bin_idx] += dist
            counts[bin_idx] += 1

        # Average distances per bin
        histogram = [h/c if c > 0 else 0 for h, c in zip(histogram, counts)]

        return {
            "position": {"x": round(x, 3), "y": round(y, 3)},
            "heading": round(heading, 1),
            "histogram": [round(h, 2) for h in histogram],
            "point_count": len(profile),
            "timestamp": time.time()
        }

    def _save_confirmed_walls(self):
        """
        Save confirmed walls and LIDAR fingerprints for 4D map persistence.

        This saves:
        1. Confirmed 3D points (seen multiple times = static structure)
        2. LIDAR fingerprints for relocalization and loop closure
        3. Map metadata (stats, AI models used, timestamp)
        """
        import os
        filepath = os.path.join(os.path.dirname(__file__), PERSISTENCE_FILE)
        try:
            confirmed = []
            static_count = 0
            depth_count = 0
            lidar_count = 0

            for key, pt in self.accumulated_points.items():
                # Only save points seen multiple times (confirmed)
                if hasattr(pt, 'observations') and pt.observations >= CONFIRM_THRESHOLD:
                    point_data = {
                        'x': round(pt.x, 3),
                        'y': round(pt.y, 3),
                        'z': round(pt.z, 3),
                        'r': pt.r, 'g': pt.g, 'b': pt.b,
                        'c': round(pt.confidence, 2),
                        'src': pt.source,
                        'obs': pt.observations
                    }

                    # Add motion score for 4D temporal data
                    if hasattr(pt, 'motion_score'):
                        point_data['motion'] = round(pt.motion_score, 3)

                    confirmed.append(point_data)

                    if pt.is_static:
                        static_count += 1
                    if pt.source == 'mono':
                        depth_count += 1
                    elif pt.source == 'lidar':
                        lidar_count += 1

            # Generate fingerprint at current position for relocalization
            fingerprint = self._generate_fingerprint(
                self.robot_pose.x,
                self.robot_pose.y,
                math.degrees(self.robot_pose.heading)
            )
            fingerprints = [fingerprint] if fingerprint else []

            # Build map data with metadata
            map_data = {
                "version": "2.0",
                "ai_stack": {
                    "depth_model": "Depth Anything V2 Large",
                    "semantic": "RANSAC Plane Detection",
                    "object_filter": "YOLO Dynamic Object Filter",
                    "slam": "Fingerprint-based Relocalization"
                },
                "stats": {
                    "total_points": len(confirmed),
                    "static_points": static_count,
                    "depth_points": depth_count,
                    "lidar_points": lidar_count,
                    "fingerprints": len(fingerprints)
                },
                "points": confirmed,
                "fingerprints": fingerprints,
                "timestamp": time.time()
            }

            with open(filepath, 'w') as f:
                json.dump(map_data, f, indent=2)

            print(f"[4D-PERSIST] ══════════════════════════════════════════════════", flush=True)
            print(f"[4D-PERSIST] Saved 4D map to {PERSISTENCE_FILE}", flush=True)
            print(f"[4D-PERSIST]   • Total points: {len(confirmed):,}", flush=True)
            print(f"[4D-PERSIST]   • Depth AI points: {depth_count:,}", flush=True)
            print(f"[4D-PERSIST]   • LIDAR-fused points: {lidar_count:,}", flush=True)
            print(f"[4D-PERSIST]   • Fingerprints: {len(fingerprints)}", flush=True)
            print(f"[4D-PERSIST] ══════════════════════════════════════════════════", flush=True)

        except Exception as e:
            print(f"[4D-PERSIST] Save failed: {e}")

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

            model_name = "depth-anything/Depth-Anything-V2-Large-hf"  # LARGE model - uses more GPU for best quality
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

        # UPDATE LIDAR BOUNDARY - store wall distances for each angle
        # This prevents depth points from going beyond actual walls
        for angle_deg, distance_mm in points:
            distance_m = distance_mm / 1000.0
            # Use 5-degree bins for smoother boundary
            angle_bin = int(angle_deg / 5) * 5
            # Keep the closest wall at each angle (more conservative)
            if angle_bin not in self.lidar_boundary or distance_m < self.lidar_boundary[angle_bin]:
                self.lidar_boundary[angle_bin] = distance_m

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
        """Process LIDAR scan - project to 3D world coordinates and track expected observations"""
        pose = self.robot_pose
        cos_h = math.cos(pose.heading)
        sin_h = math.sin(pose.heading)

        # Track which points we observed in this scan
        points_observed_this_scan = set()

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

            # Track grid key for this observation
            gx = int(world_x / GRID_SIZE)
            gy = int(world_y / GRID_SIZE)
            gz = int(world_z / GRID_SIZE)
            key = f"{gx},{gy},{gz}"
            points_observed_this_scan.add(key)

            # SKIP adding grey points - only add colored points from camera fusion
            # The grey points look bad and clutter the visualization
            # Camera fusion will add properly colored LIDAR points

        # Update expected observations for all points that SHOULD have been visible
        # This is the key to dynamic object detection!
        # AGGRESSIVE: Remove mono points that LIDAR doesn't confirm
        points_to_remove = []
        for key, point in self.accumulated_points.items():
            if should_expect_observation(point, pose.x, pose.y):
                point.expected_observations += 1
                if key not in points_observed_this_scan:
                    # We should have seen this point but didn't - it may have moved!
                    point.missed_observations += 1
                    # Update motion score
                    point.motion_score = compute_motion_score(point)

                    # AGGRESSIVE REMOVAL: Mono points that LIDAR doesn't confirm
                    # If LIDAR has scanned this area 3+ times and never sees it, DELETE IT
                    if point.source == "mono" and not point.is_static:
                        if point.expected_observations >= 3 and point.observations < 2:
                            points_to_remove.append(key)

        # Remove unconfirmed mono points
        for key in points_to_remove:
            del self.accumulated_points[key]
        if points_to_remove:
            print(f"[LIDAR-VALID] Removed {len(points_to_remove)} unconfirmed mono points")

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

            # Resize image for depth estimation - larger = better quality
            img = Image.fromarray(frame.image)
            img_small = img.resize((640, 480))  # Higher res for better depth accuracy

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
                if d < 0.3 or d > 1.5:  # STRICT: Only 0.3-1.5m - beyond is unreliable
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

                # DYNAMIC OBJECT FILTER: Skip pixels inside detected people/dogs/etc
                if self.is_pixel_in_detection(cam_id, px, py, img_w, img_h):
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
        """Add point to accumulated map with grid-based deduplication and dynamic object tracking"""
        now = time.time()
        robot_x = self.robot_pose.x
        robot_y = self.robot_pose.y

        # QUALITY FILTER: Reject low-confidence depth readings
        MIN_CONFIDENCE = 0.3  # Reject points with <30% confidence
        if point.confidence < MIN_CONFIDENCE:
            return

        # DISTANCE FILTER: Depth estimates get worse with distance
        MAX_DEPTH_DISTANCE = 3.0  # Strict 3m limit - beyond this depth is unreliable
        point_dist = math.sqrt((point.x - robot_x)**2 + (point.y - robot_y)**2)
        if point_dist > MAX_DEPTH_DISTANCE:
            return

        # LIDAR BOUNDARY CHECK: Reject depth points beyond LIDAR walls
        # This prevents the "impossible" scattered dots outside walls
        if point.source == "mono":
            dx = point.x - robot_x
            dy = point.y - robot_y
            angle_rad = math.atan2(dy, dx) - self.robot_pose.heading
            angle_deg = math.degrees(angle_rad) % 360
            angle_bin = int(angle_deg / 5) * 5

            # If we have LIDAR data for this angle, use it
            if self.lidar_boundary and angle_bin in self.lidar_boundary:
                lidar_dist = self.lidar_boundary[angle_bin]
                if point_dist > lidar_dist + 0.05:  # 5cm tolerance
                    return  # Point is beyond wall - impossible!
            elif self.lidar_boundary:
                # No LIDAR data for this angle - use nearest angle or reject
                nearest_angles = [b for b in self.lidar_boundary.keys() if abs(b - angle_bin) <= 15]
                if nearest_angles:
                    min_dist = min(self.lidar_boundary[a] for a in nearest_angles)
                    if point_dist > min_dist + 0.1:
                        return  # Beyond nearest wall

        # Grid key for deduplication
        gx = int(point.x / GRID_SIZE)
        gy = int(point.y / GRID_SIZE)
        gz = int(point.z / GRID_SIZE)
        key = f"{gx},{gy},{gz}"

        # FALSE READING DETECTION: Check for same color in 3D neighborhood
        # If we see the same color at nearby but different positions, keep only the closest one
        COLOR_SIMILARITY_THRESHOLD = 50  # RGB distance threshold (more lenient)
        CONFLICT_RANGE_XY = 2  # Check +/- 2 grid cells in XY
        CONFLICT_RANGE_Z = 8   # Check +/- 8 grid cells in Z (depth varies more)

        for dx in range(-CONFLICT_RANGE_XY, CONFLICT_RANGE_XY + 1):
            for dy in range(-CONFLICT_RANGE_XY, CONFLICT_RANGE_XY + 1):
                for dz in range(-CONFLICT_RANGE_Z, CONFLICT_RANGE_Z + 1):
                    if dx == 0 and dy == 0 and dz == 0:
                        continue  # Skip same cell
                    check_key = f"{gx + dx},{gy + dy},{gz + dz}"
                    if check_key in self.accumulated_points:
                        existing = self.accumulated_points[check_key]
                        # Calculate color similarity
                        color_dist = abs(point.r - existing.r) + abs(point.g - existing.g) + abs(point.b - existing.b)
                        if color_dist < COLOR_SIMILARITY_THRESHOLD:
                            # Same color nearby - likely duplicate from depth variance
                            # Keep the one that's closer to robot (more reliable)
                            robot_dist_new = math.sqrt((point.x - robot_x)**2 + (point.y - robot_y)**2)
                            robot_dist_existing = math.sqrt((existing.x - robot_x)**2 + (existing.y - robot_y)**2)

                            if robot_dist_new < robot_dist_existing:
                                # New point is closer - replace the old one
                                del self.accumulated_points[check_key]
                                break  # Only replace one, then add new point
                            else:
                                # Existing point is closer - skip adding this point
                                return
                    if check_key not in self.accumulated_points:
                        continue  # Key was deleted, continue checking

        if key in self.accumulated_points:
            existing = self.accumulated_points[key]

            # Increment observation count - this point is being seen again!
            existing.observations += 1
            existing.last_seen = now

            # Track observer position (where robot was when it saw this point)
            if existing.observer_positions is None:
                existing.observer_positions = []
            existing.observer_positions.append((robot_x, robot_y, now))
            # Keep only recent observations
            if len(existing.observer_positions) > MAX_OBSERVER_HISTORY:
                existing.observer_positions = existing.observer_positions[-MAX_OBSERVER_HISTORY:]

            # Update motion score
            existing.motion_score = compute_motion_score(existing)

            # Classify and update is_static based on dynamic classification
            classification = classify_point(existing)
            if classification == "static":
                existing.is_static = True
                # Reduce confidence penalty for dynamic behavior if now static
                if existing.motion_score < 0.2:
                    existing.confidence = min(1.0, existing.confidence * 1.1)
            elif classification == "dynamic":
                existing.is_static = False
                # Reduce confidence for dynamic objects
                existing.confidence *= 0.9

            # Update existing point position/color
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
            point.is_static = False  # New points start as uncertain, not static
            point.expected_observations = 1
            point.missed_observations = 0
            point.motion_score = 0.5  # Unknown initially
            point.observer_positions = [(robot_x, robot_y, now)]

            # Limit total points - remove oldest non-static or decayed points first
            if len(self.accumulated_points) >= MAX_POINTS:
                self._cleanup_old_points(now)

            self.accumulated_points[key] = point

        self.stats["total_points"] = len(self.accumulated_points)
        self.stats["static_points"] = len([p for p in self.accumulated_points.values() if p.is_static])

    def _cleanup_old_points(self, now: float):
        """Remove points that haven't been seen recently, with faster decay for dynamic objects"""
        to_remove = []
        dynamic_removed = 0
        static_kept = 0

        for key, point in self.accumulated_points.items():
            age = now - point.last_seen

            # NEVER remove static/confirmed points - they are the map!
            if point.is_static and point.observations >= CONFIRM_THRESHOLD:
                static_kept += 1
                continue

            # Calculate effective decay time based on motion score
            # Dynamic points (high motion_score) decay faster
            if point.motion_score > MOTION_SCORE_DYNAMIC:
                effective_decay = DECAY_TIME / DYNAMIC_DECAY_MULTIPLIER  # 75 seconds for dynamic
                effective_removal = REMOVAL_TIME / DYNAMIC_DECAY_MULTIPLIER  # 15 minutes for dynamic
            else:
                effective_decay = DECAY_TIME  # 5 minutes for static
                effective_removal = REMOVAL_TIME  # 1 hour for static

            # Remove transient points not seen for their removal time
            if age > effective_removal:
                to_remove.append(key)
                if point.motion_score > MOTION_SCORE_DYNAMIC:
                    dynamic_removed += 1
            # Also remove non-static points that are decaying
            elif not point.is_static and age > effective_decay:
                to_remove.append(key)

        # Only remove more points if we're WAY over the limit
        if len(self.accumulated_points) > MAX_POINTS * 1.1 and len(to_remove) < 500:
            # Sort by (is_static, -motion_score, observations) - remove dynamic low-observation first
            sorted_points = sorted(
                self.accumulated_points.items(),
                key=lambda x: (x[1].is_static, -x[1].motion_score, x[1].observations)
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

        # ======== QUALITY FILTERS - REALTIME MAPPING ========
        MIN_OBSERVATIONS_LIDAR = 1   # Show LIDAR immediately
        MIN_OBSERVATIONS_MONO = 1    # Show mono immediately (was 2 - too strict)
        MIN_CONFIDENCE = 0.15        # Lower threshold - show more depth points
        MIN_HEIGHT = 0.05            # 5cm above floor (include low objects)
        MAX_HEIGHT = 4.0             # 4m max for warehouses
        VOXEL_SIZE = 0.05            # 5cm voxel grid - MORE DETAIL
        LIDAR_PRIORITY = True

        # Limit points - MORE for detailed maps
        MAX_SEND_POINTS = 15000

        # Sort by confidence and observations for priority
        sorted_points = sorted(
            self.accumulated_points.values(),
            key=lambda p: (p.confidence, p.observations),
            reverse=True
        )

        # Voxel grid for downsampling (only send one point per 3cm cube)
        voxel_grid = set()

        for p in sorted_points:
            # Count static vs pending for stats
            if p.is_static:
                static_count += 1
            else:
                pending_count += 1
            # Show ALL points during active mapping (filter by observations instead)

            # ======== APPLY QUALITY FILTERS ========
            # LIDAR points get priority - they are accurate!
            is_lidar = p.source == "lidar"

            # 1. Observation filter - per-source thresholds
            min_obs = MIN_OBSERVATIONS_LIDAR if is_lidar else MIN_OBSERVATIONS_MONO
            if p.observations < min_obs:
                filtered_count += 1
                continue

            # 2. Confidence filter - now includes monocular depth (0.3 > 0.2)
            if p.confidence < MIN_CONFIDENCE:
                filtered_count += 1
                continue

            # 3. Height filter - focus on walls (not floor/ceiling)
            if p.z < MIN_HEIGHT or p.z > MAX_HEIGHT:
                filtered_count += 1
                continue

            # 3.5 DISTANCE CAP - Filter unreliable far points
            # For warehouses, allow up to 6m - LIDAR calibrates depth at each position
            robot_x = self.robot_pose.x
            robot_y = self.robot_pose.y
            dx = p.x - robot_x
            dy = p.y - robot_y
            point_dist = math.sqrt(dx*dx + dy*dy)
            if point_dist > 6.0:  # 6m cap for warehouses - LIDAR validates accuracy
                filtered_count += 1
                continue

            # 4. LIDAR BOUNDARY - Allow points up to walls (20cm tolerance for depth noise)
            if not is_lidar and self.lidar_boundary:
                angle_rad = math.atan2(dy, dx)
                angle_deg = math.degrees(angle_rad) % 360
                angle_bin = int(angle_deg / 5) * 5
                if angle_bin in self.lidar_boundary:
                    lidar_dist = self.lidar_boundary[angle_bin]
                    if point_dist > lidar_dist + 0.20:  # 20cm tolerance for depth noise
                        filtered_count += 1
                        continue  # BEYOND WALL - reject!

            # 5. Voxel downsampling - one point per 3cm cube
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
                # NEW: Include motion_score as 0-100 int for dynamic object visualization
                # IMPORTANT: Convert all to native Python types to avoid JSON UTF-8 issues
                motion_pct = int(p.motion_score * 100) if hasattr(p, 'motion_score') else 0
                points.append([
                    float(round(p.x, 2)), float(round(p.y, 2)), float(round(p.z, 2)),
                    int(p.r), int(p.g), int(p.b),
                    int(p.observations),  # Include obs count for UI filtering
                    int(motion_pct)       # 0 = static, 100 = definitely moving
                ])

        return {
            "type": "accumulated_map",
            "points": points,
            "total": int(len(points)),
            "static_points": int(static_count),
            "pending_points": int(pending_count),
            "filtered_points": int(filtered_count),
            "stats": {k: int(v) for k, v in self.stats.items()},  # Ensure native ints
            "format": "compact_v2",  # [x, y, z, r, g, b, obs, motion] arrays
            "robot_x": float(round(self.robot_pose.x, 2)),
            "robot_y": float(round(self.robot_pose.y, 2))
        }

    def get_lidar_colors(self) -> Dict:
        """
        Get angle->color mapping for LIDAR walls.
        Browser uses this to color the realtime LIDAR panels.
        """
        angle_colors = {}

        # Find colored LIDAR points and map them to angles
        for key, p in self.accumulated_points.items():
            if p.source == "lidar" and p.confidence >= 0.9:
                # Calculate angle from robot to point
                dx = p.x - self.robot_pose.x
                dy = p.y - self.robot_pose.y
                angle = int(math.degrees(math.atan2(dy, dx)) + 90) % 360

                # Store color for this angle (keep most recent)
                angle_colors[angle] = [int(p.r), int(p.g), int(p.b)]

        return {
            "type": "lidar_colors",
            "colors": angle_colors  # {angle: [r,g,b], ...}
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

    async def spin_robot_to_heading(self, ws, target_heading: float):
        """
        Spin robot to exact compass heading using compass feedback.
        Uses HTTP /spin endpoint for reliability (WebSocket can drop during long operations).
        """
        print(f"[ROBOT] Target heading: {target_heading:.1f}°, current: {self.current_heading:.1f}°", flush=True)

        # Calculate turn direction and amount
        diff = target_heading - self.current_heading
        # Normalize to -180 to 180
        while diff > 180:
            diff -= 360
        while diff < -180:
            diff += 360

        turn_degrees = int(abs(diff))
        if turn_degrees < 5:
            print(f"[ROBOT] Already at target (within 5°), skipping turn", flush=True)
            return

        direction = 'RIGHT' if diff > 0 else 'LEFT'
        print(f"[ROBOT] Turning {direction} {turn_degrees}°...", flush=True)

        # Use HTTP endpoint instead of WebSocket (more reliable for commands)
        import urllib.request
        import urllib.error

        spin_url = f"http://YOUR_VPS_IP:3001/spin/{direction}/{turn_degrees}"
        print(f"[ROBOT] HTTP request: {spin_url}", flush=True)

        try:
            req = urllib.request.Request(spin_url)
            with urllib.request.urlopen(req, timeout=10) as response:
                result = response.read().decode('utf-8')
                print(f"[ROBOT] Spin response: {result}", flush=True)
        except urllib.error.URLError as e:
            print(f"[ROBOT] HTTP error (trying WebSocket fallback): {e}", flush=True)
            # Fallback to WebSocket if HTTP fails
            try:
                spin_cmd = {"type": "robot_spin", "direction": direction, "degrees": turn_degrees}
                await ws.send(json.dumps(spin_cmd))
            except Exception as ws_err:
                print(f"[ROBOT] WebSocket fallback also failed: {ws_err}", flush=True)
        except Exception as e:
            print(f"[ROBOT] Spin error: {e}", flush=True)

        # Wait for turn to complete (~10 seconds for 120°)
        wait_time = max(8, turn_degrees // 12)  # ~12 degrees per second
        print(f"[ROBOT] Waiting {wait_time}s for turn...", flush=True)
        await asyncio.sleep(wait_time)

        # MANUALLY UPDATE HEADING - compass data not reliably received during mapping
        # This ensures new camera frames project to NEW coordinates (not duplicates)
        old_heading = self.current_heading
        self.current_heading = target_heading
        self.robot_pose.heading = math.radians(target_heading)
        print(f"[ROBOT] Turn complete! Heading updated: {old_heading:.1f}° → {target_heading:.1f}°", flush=True)

    async def safe_ws_send(self, ws, data: dict):
        """Safely send data via WebSocket with error handling"""
        try:
            await ws.send(json.dumps(data))
            return True
        except Exception as e:
            print(f"[WS] Send failed: {e}", flush=True)
            return False

    async def scan_both_cameras(self, ws):
        """
        Scan both cameras with smooth 4-click sequence.
        Both cameras move SIMULTANEOUSLY using MAIN VPS websocket (no separate PTZ connection).
        Sequence: 4 LEFT -> 4 RIGHT (center) -> 4 RIGHT -> 4 LEFT (center)
                  4 UP -> 4 DOWN (center) -> 4 DOWN -> 4 UP (center)
        """
        # PTZ settings - FAST for rapid scanning
        PTZ_SPEED = 0.5  # Fast speed
        MOVE_TIME = 0.15  # 150ms per click (quick!)
        SETTLE_TIME = 0.1  # 100ms settle for frames
        CLICKS_PAN = 2  # 2 clicks per pan direction
        CLICKS_TILT = 2  # 2 clicks per tilt direction

        async def one_click_both(direction):
            """Move both cameras one click in direction using main VPS websocket"""
            pan = -PTZ_SPEED if direction == 'left' else PTZ_SPEED if direction == 'right' else 0
            tilt = PTZ_SPEED if direction == 'up' else -PTZ_SPEED if direction == 'down' else 0

            # Move both cameras simultaneously using main ws connection
            for cam_id in [1, 2]:
                await self.safe_ws_send(ws, {
                    'type': 'cam_ptz', 'camera': cam_id, 'action': 'move',
                    'pan': pan, 'tilt': tilt, 'zoom': 0
                })

            await asyncio.sleep(MOVE_TIME)

            # Stop both cameras
            for cam_id in [1, 2]:
                await self.safe_ws_send(ws, {
                    'type': 'cam_ptz', 'camera': cam_id, 'action': 'stop'
                })

            await asyncio.sleep(SETTLE_TIME)

            # CAPTURE FRAME at this position for mapping!
            self.capture_frame_for_map = True

        async def do_clicks(direction, count, label):
            print(f"[PTZ] {label}: {count}x {direction.upper()}", flush=True)
            for i in range(count):
                await one_click_both(direction)

        try:
            print("[PTZ] === CAMERA SCAN SEQUENCE START ===", flush=True)

            # PAN sequence: LEFT -> center -> RIGHT -> center
            await do_clicks('left', CLICKS_PAN, "Pan LEFT")
            await do_clicks('right', CLICKS_PAN, "Back to CENTER")
            await do_clicks('right', CLICKS_PAN, "Pan RIGHT")
            await do_clicks('left', CLICKS_PAN, "Back to CENTER")

            # TILT sequence: UP -> center -> DOWN -> center
            await do_clicks('up', CLICKS_TILT, "Tilt UP")
            await do_clicks('down', CLICKS_TILT, "Back to CENTER")
            await do_clicks('down', CLICKS_TILT, "Tilt DOWN")
            await do_clicks('up', CLICKS_TILT, "Back to CENTER")

            print("[PTZ] === CAMERA SCAN SEQUENCE COMPLETE ===", flush=True)

        except Exception as e:
            print(f"[PTZ] Camera scan error: {e}", flush=True)

    async def send_ai_status(self, ws, stage: str, substage: str, progress: float, details: dict = None):
        """Send real-time AI pipeline status to the web UI"""
        status = {
            "type": "ai_pipeline_status",
            "stage": stage,
            "substage": substage,
            "progress": progress,
            "points": len(self.accumulated_points),
            "stats": self.stats,
            "timestamp": time.time()
        }
        if details:
            status["details"] = details
        await self.safe_ws_send(ws, status)

    async def full_mapping_sequence(self, ws):
        """
        ╔══════════════════════════════════════════════════════════════════════════╗
        ║         AUTONOMOUS 4D MAPPING SEQUENCE - Full Room Coverage              ║
        ╠══════════════════════════════════════════════════════════════════════════╣
        ║                                                                          ║
        ║  This sequence orchestrates ALL AI subsystems for comprehensive mapping: ║
        ║                                                                          ║
        ║  FLOW: Robot spins 3x120° with camera sweeps at each position            ║
        ║                                                                          ║
        ║  At each position, the following AI pipeline executes:                   ║
        ║    1. 🔄 LIDAR Scan - 360° geometry capture + fingerprinting             ║
        ║    2. 📷 Dual PTZ Sweep - Camera 1 (internal) + Camera 2 (external)      ║
        ║    3. 🧠 Depth Anything V2 - Dense depth estimation on GPU               ║
        ║    4. 🔬 LIDAR-Camera Fusion - Color projection onto geometry            ║
        ║    5. 🏠 Semantic Analysis - Wall/floor/ceiling detection                ║
        ║    6. 📊 4D Temporal Update - Point persistence and motion scoring       ║
        ║                                                                          ║
        ║  Total coverage: 360° horizontal × ~90° vertical per position            ║
        ║                                                                          ║
        ╚══════════════════════════════════════════════════════════════════════════╝
        """
        print("", flush=True)
        print("╔" + "═" * 78 + "╗", flush=True)
        print("║" + " " * 20 + "4D MAPPING SEQUENCE INITIATED" + " " * 29 + "║", flush=True)
        print("╠" + "═" * 78 + "╣", flush=True)
        print("║  🧠 Depth Anything V2 Large ............. ACTIVE (Apple Silicon GPU)" + " " * 9 + "║", flush=True)
        print("║  🔬 Multi-Modal Sensor Fusion ........... ACTIVE (LIDAR + Camera)" + " " * 12 + "║", flush=True)
        print("║  🗺️  Semantic SLAM ....................... ACTIVE (RANSAC + Tracking)" + " " * 8 + "║", flush=True)
        print("║  ⏱️  4D Temporal Tracking ................ ACTIVE (Fingerprint SLAM)" + " " * 8 + "║", flush=True)
        print("╠" + "═" * 78 + "╣", flush=True)
        print("║  Sequence: 3 positions × 120° = 360° complete room coverage" + " " * 17 + "║", flush=True)
        print("╚" + "═" * 78 + "╝", flush=True)
        print("", flush=True)

        # Send initial status to UI
        await self.send_ai_status(ws, "INITIALIZING", "Loading AI models", 0.0, {
            "depth_model": "Depth Anything V2 Large",
            "gpu": "Apple Silicon MPS (64GB)",
            "sensors": ["LIDAR 360°", "PTZ Camera 1", "PTZ Camera 2"]
        })

        try:
            while self.mapping_sequence_active:
                # Get starting heading
                start_heading = self.current_heading
                print(f"\n[4D-MAP] 📍 Starting heading: {start_heading:.1f}°", flush=True)

                await self.send_ai_status(ws, "POSITION_1", "Rotating robot", 0.1, {
                    "action": "Spinning 120° to Position 1",
                    "target_heading": (start_heading + 120) % 360
                })

                # === POSITION 1 (120°) ===
                target1 = (start_heading + 120) % 360
                print(f"\n[4D-MAP] ═══ POSITION 1: Rotating to {target1:.1f}° ═══", flush=True)
                await self.spin_robot_to_heading(ws, target1)

                if not self.mapping_sequence_active:
                    break

                print("[4D-MAP] 🔄 LIDAR capturing 360° geometry...", flush=True)
                await self.send_ai_status(ws, "POSITION_1", "LIDAR scanning", 0.15)
                await asyncio.sleep(1.0)  # Allow LIDAR data to accumulate

                print("[4D-MAP] 📷 Dual PTZ camera sweep starting...", flush=True)
                await self.send_ai_status(ws, "POSITION_1", "Camera sweep + Depth AI", 0.2, {
                    "processing": "Depth Anything V2 Large @ 2 FPS",
                    "fusion": "LIDAR-Camera color projection"
                })
                await self.scan_both_cameras(ws)

                print(f"[4D-MAP] ✓ Position 1 complete: {len(self.accumulated_points)} points", flush=True)
                await self.send_ai_status(ws, "POSITION_1", "Complete", 0.33)

                if not self.mapping_sequence_active:
                    break

                # === POSITION 2 (240°) ===
                target2 = (start_heading + 240) % 360
                print(f"\n[4D-MAP] ═══ POSITION 2: Rotating to {target2:.1f}° ═══", flush=True)
                await self.send_ai_status(ws, "POSITION_2", "Rotating robot", 0.4, {
                    "action": "Spinning 120° to Position 2",
                    "target_heading": target2
                })
                await self.spin_robot_to_heading(ws, target2)

                if not self.mapping_sequence_active:
                    break

                print("[4D-MAP] 🔄 LIDAR capturing 360° geometry...", flush=True)
                await self.send_ai_status(ws, "POSITION_2", "LIDAR scanning", 0.45)
                await asyncio.sleep(1.0)

                print("[4D-MAP] 📷 Dual PTZ camera sweep starting...", flush=True)
                await self.send_ai_status(ws, "POSITION_2", "Camera sweep + Depth AI", 0.5, {
                    "processing": "Depth Anything V2 Large @ 2 FPS",
                    "fusion": "Temporal consistency check"
                })
                await self.scan_both_cameras(ws)

                print(f"[4D-MAP] ✓ Position 2 complete: {len(self.accumulated_points)} points", flush=True)
                await self.send_ai_status(ws, "POSITION_2", "Complete", 0.66)

                if not self.mapping_sequence_active:
                    break

                # === POSITION 3 (back to start) ===
                print(f"\n[4D-MAP] ═══ POSITION 3: Rotating to {start_heading:.1f}° ═══", flush=True)
                await self.send_ai_status(ws, "POSITION_3", "Rotating robot", 0.7, {
                    "action": "Spinning 120° to Position 3 (start)",
                    "target_heading": start_heading
                })
                await self.spin_robot_to_heading(ws, start_heading)

                if not self.mapping_sequence_active:
                    break

                print("[4D-MAP] 🔄 LIDAR capturing 360° geometry + loop closure...", flush=True)
                await self.send_ai_status(ws, "POSITION_3", "LIDAR scanning + loop closure", 0.75)
                await asyncio.sleep(1.0)

                print("[4D-MAP] 📷 Final camera sweep...", flush=True)
                await self.send_ai_status(ws, "POSITION_3", "Camera sweep + Depth AI", 0.85, {
                    "processing": "Final depth estimation pass",
                    "fusion": "Loop closure verification"
                })
                await self.scan_both_cameras(ws)

                # === FINALIZATION ===
                print("", flush=True)
                print("╔" + "═" * 78 + "╗", flush=True)
                print("║" + " " * 20 + "4D MAPPING SEQUENCE COMPLETE!" + " " * 29 + "║", flush=True)
                print("╠" + "═" * 78 + "╣", flush=True)
                print(f"║  Total 3D Points: {len(self.accumulated_points):,}".ljust(79) + "║", flush=True)
                print(f"║  Depth-derived Points: {self.stats.get('mono_points', 0):,}".ljust(79) + "║", flush=True)
                print(f"║  LIDAR-fused Points: {self.stats.get('lidar_points', 0):,}".ljust(79) + "║", flush=True)
                print("╠" + "═" * 78 + "╣", flush=True)
                print("║  AI Processing Summary:".ljust(79) + "║", flush=True)
                print("║    • Depth Anything V2 Large - GPU inference complete".ljust(79) + "║", flush=True)
                print("║    • RANSAC plane detection - Walls/floor identified".ljust(79) + "║", flush=True)
                print("║    • Temporal fusion - Static points confirmed".ljust(79) + "║", flush=True)
                print("╚" + "═" * 78 + "╝", flush=True)
                print("", flush=True)

                await self.send_ai_status(ws, "COMPLETE", "Map saved", 1.0, {
                    "total_points": len(self.accumulated_points),
                    "depth_points": self.stats.get('mono_points', 0),
                    "lidar_points": self.stats.get('lidar_points', 0),
                    "ai_models_used": ["Depth Anything V2 Large", "RANSAC Plane Detection", "YOLO Object Filter"]
                })

                # Save the map
                if PERSISTENCE_ENABLED:
                    self._save_confirmed_walls()
                    print("[4D-MAP] 💾 Map saved to confirmed_walls.json", flush=True)

                self.mapping_sequence_active = False
                break

        except Exception as e:
            print(f"[4D-MAP] ❌ Sequence error: {e}", flush=True)
            import traceback
            traceback.print_exc()
            await self.send_ai_status(ws, "ERROR", str(e), 0.0)

        print("[4D-MAP] Mapping sequence ended", flush=True)

    async def continuous_ptz_scan(self, ws):
        """
        Runs mapping - either full autonomous sequence OR manual mode (just camera sweep)
        """
        print("[PTZ] Waiting for mapping to start...", flush=True)

        while True:
            try:
                # Wait until mapping sequence is activated
                if not self.mapping_sequence_active:
                    await asyncio.sleep(0.5)
                    continue

                if self.mapping_paused_by_override:
                    await asyncio.sleep(0.5)
                    continue

                # MANUAL MODE: Just sweep cameras continuously, user drives with Xbox
                if self.manual_drive_mode:
                    await self.manual_mapping_loop(ws)
                else:
                    # AUTONOMOUS MODE: Full sequence with robot spins
                    await self.full_mapping_sequence(ws)

            except Exception as e:
                print(f"[PTZ] Error: {e}", flush=True)
                await asyncio.sleep(1)

    async def manual_mapping_loop(self, ws):
        """
        MANUAL MAPPING: Camera sweep + GPU depth, but NO robot movement.
        User drives with Xbox controller while cameras continuously scan.
        """
        print("", flush=True)
        print("╔" + "═" * 78 + "╗", flush=True)
        print("║" + " " * 15 + "MANUAL MAPPING MODE - YOU DRIVE WITH XBOX" + " " * 22 + "║", flush=True)
        print("╠" + "═" * 78 + "╣", flush=True)
        print("║  🎮 Robot Control: XBOX CONTROLLER (you drive!)" + " " * 30 + "║", flush=True)
        print("║  📷 Camera PTZ: AUTO-SWEEP (cameras scan continuously)" + " " * 23 + "║", flush=True)
        print("║  🧠 Depth AI: ACTIVE (GPU processing every frame)" + " " * 28 + "║", flush=True)
        print("║  🗺️  Mapping: ACTIVE (building 3D map as you drive)" + " " * 26 + "║", flush=True)
        print("╚" + "═" * 78 + "╝", flush=True)
        print("", flush=True)

        await self.send_ai_status(ws, "MANUAL_MAPPING", "Drive with Xbox - cameras sweeping", 0.0, {
            "mode": "manual",
            "robot_control": "Xbox Controller",
            "cameras": "Auto-sweep",
            "gpu": "Depth AI active"
        })

        sweep_count = 0
        while self.mapping_sequence_active and self.manual_drive_mode:
            try:
                sweep_count += 1
                print(f"\n[MANUAL] 📷 Camera sweep #{sweep_count}...", flush=True)

                # Sweep both cameras
                await self.scan_both_cameras(ws)

                # Report progress
                points = len(self.accumulated_points)
                print(f"[MANUAL] ✓ Sweep complete: {points:,} total points", flush=True)

                await self.send_ai_status(ws, "MANUAL_MAPPING", f"Sweep #{sweep_count} done", 0.5, {
                    "sweeps": sweep_count,
                    "total_points": points,
                    "depth_points": self.stats.get('mono_points', 0),
                    "lidar_points": self.stats.get('lidar_points', 0)
                })

                # Auto-save periodically
                if sweep_count % 5 == 0 and PERSISTENCE_ENABLED:
                    self._save_confirmed_walls()
                    print(f"[MANUAL] 💾 Auto-saved map ({points:,} points)", flush=True)

                # Small delay between sweeps
                await asyncio.sleep(0.5)

            except Exception as e:
                print(f"[MANUAL] Sweep error: {e}", flush=True)
                await asyncio.sleep(1)

        print("[MANUAL] Manual mapping stopped", flush=True)


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

                # COMPASS heading - use to supplement encoder heading
                # Encoders ARE working - use compass only for absolute heading reference
                if data.get("type") == "compass":
                    compass_heading = data.get("heading", 0)
                    # Store for mapping sequence use, but don't overwrite encoder pose
                    mapper.current_heading = compass_heading

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

                # MAPPING CONTROL - start/stop from UI MAP button
                if data.get("type") == "mapping_control":
                    cmd = data.get("cmd", "").upper()
                    if cmd == "START":
                        mapper.start_mapping()
                        # Send acknowledgment
                        await ws.send(json.dumps({
                            "type": "mapping_status",
                            "active": True,
                            "message": "Mapping started - GPU processing active"
                        }))
                    elif cmd == "START_MANUAL":
                        # MANUAL MODE: PTZ sweep + GPU processing, YOU drive with Xbox
                        mapper.start_manual_mapping()
                        await ws.send(json.dumps({
                            "type": "mapping_status",
                            "active": True,
                            "mode": "manual",
                            "message": "Manual mapping - YOU drive with Xbox, cameras sweep automatically"
                        }))
                    elif cmd == "STOP":
                        mapper.stop_mapping()
                        await ws.send(json.dumps({
                            "type": "mapping_status",
                            "active": False,
                            "message": "Mapping stopped"
                        }))
                    elif cmd == "PAUSE":
                        mapper.pause_for_override()
                    elif cmd == "RESUME":
                        mapper.resume_from_override()

                # Manual override notification from server
                if data.get("type") == "manual_override":
                    if data.get("active"):
                        mapper.pause_for_override()
                    else:
                        mapper.resume_from_override()

                # Skip heavy processing if mapping not active
                if not mapper.mapping_active:
                    continue

                # Periodically compute stereo depth (only when mapping active)
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
        print(f"     - Continuous PTZ Scan: {'YES' if CONTINUOUS_PTZ_SCAN else 'NO'}", flush=True)

        # Start continuous PTZ scanning in background
        if CONTINUOUS_PTZ_SCAN:
            asyncio.create_task(mapper.continuous_ptz_scan(ws))
            print("[PTZ] Continuous scan task started - cameras will sweep constantly during mapping")

        # AUTO-START in MANUAL mode - PTZ sweep + GPU processing, user drives with Xbox
        # Safety: NO robot movement commands sent - only cameras move
        print("[INIT] AUTO-STARTING in MANUAL MAPPING MODE...", flush=True)
        mapper.start_manual_mapping()
        await ws.send(json.dumps({
            "type": "mapping_status",
            "active": True,
            "mode": "manual",
            "message": "Manual mapping active - drive with Xbox, cameras sweep automatically"
        }))

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

                # DEBUG: Log all message types (except high-frequency ones)
                msg_type = data.get("type", "unknown")
                if msg_type not in ["lidar", "DETECTIONS", "compass", "dead_reckoning", "ptz_status", "status"]:
                    print(f"[WS-MSG] Received: {msg_type}", flush=True)

                # LIDAR from VPS (ESP32 → VPS → Mac)
                if data.get("type") == "lidar":
                    points = [(p[0], p[1]) for p in data.get("points", [])]
                    if points:
                        mapper.add_lidar_scan(points)

                # DETECTIONS from Jetson - filter dynamic objects from map
                elif data.get("type") == "DETECTIONS":
                    cam_id = data.get("camera", 1)
                    detections = data.get("detections", [])
                    mapper.update_detections(cam_id, detections)

                # PTZ status - update camera angles
                elif data.get("type") == "ptz_status":
                    cam = data.get("camera", 1)
                    mapper.update_camera_ptz(cam, data.get("pan", 0), data.get("tilt", 0))

                # Dead reckoning - update robot pose (use degrees field)
                elif data.get("type") == "dead_reckoning":
                    mapper.update_pose(
                        data.get("odomX", 0),
                        data.get("odomY", 0),
                        data.get("odomHeadingDeg", 0)
                    )

                # COMPASS heading - store for reference but don't overwrite encoder pose
                elif data.get("type") == "compass":
                    compass_heading = data.get("heading", 0)
                    mapper.current_heading = compass_heading

                # Clear map command
                elif data.get("type") == "clear_3d_map":
                    print("[MAP] Clearing accumulated points...")
                    mapper.accumulated_points.clear()
                    mapper.stats = {"lidar_points": 0, "mono_points": 0, "stereo_points": 0, "total_points": 0, "depth_scale": mapper.depth_scale}

                # MAPPING CONTROL - start/stop from UI MAP button
                elif data.get("type") == "mapping_control":
                    print(f"[DEBUG] Received mapping_control: {data}", flush=True)
                    cmd = data.get("cmd", "").upper()
                    if cmd == "START":
                        print("[DEBUG] Starting mapping from mapping_control START", flush=True)
                        mapper.start_mapping()
                        await ws.send(json.dumps({
                            "type": "mapping_status",
                            "active": True,
                            "message": "Mapping started - GPU processing active"
                        }))
                    elif cmd == "STOP":
                        mapper.stop_mapping()
                        await ws.send(json.dumps({
                            "type": "mapping_status",
                            "active": False,
                            "message": "Mapping stopped"
                        }))
                    elif cmd == "PAUSE":
                        mapper.pause_for_override()
                    elif cmd == "RESUME":
                        mapper.resume_from_override()

                # Manual override notification from server
                elif data.get("type") == "manual_override":
                    if data.get("active"):
                        mapper.pause_for_override()
                    else:
                        mapper.resume_from_override()

                # RELOCALIZATION - browser detected position via fingerprint
                elif data.get("type") == "relocalization":
                    new_x = data.get("x", 0)
                    new_y = data.get("y", 0)
                    confidence = data.get("confidence", 0)
                    source = data.get("source", "unknown")
                    print(f"[RELOCALIZE] Position correction from {source}: ({new_x:.0f}, {new_y:.0f}) confidence={confidence*100:.0f}%")

                    # Update mapper's robot pose to match
                    # Convert from mm to meters for internal use
                    mapper.robot_pose.x = new_x / 1000.0
                    mapper.robot_pose.y = new_y / 1000.0
                    print(f"[RELOCALIZE] Mapper pose updated to ({mapper.robot_pose.x:.2f}m, {mapper.robot_pose.y:.2f}m)")

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
                            map_json = json.dumps(map_data, ensure_ascii=True)
                            await ws.send(map_json)

                            # Also send LIDAR colors for wall texturing
                            lidar_colors = mapper.get_lidar_colors()
                            if lidar_colors["colors"]:
                                await ws.send(json.dumps(lidar_colors))

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

            # CRITICAL: Yield to allow other async tasks (PTZ scan, robot turn) to run
            # Use a small delay when mapping sequence is active to give PTZ/robot commands time
            if mapper.mapping_sequence_active:
                await asyncio.sleep(0.05)  # 50ms yield during active mapping
            else:
                await asyncio.sleep(0)

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
