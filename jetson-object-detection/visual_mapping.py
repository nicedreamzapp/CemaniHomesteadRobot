#!/usr/bin/env python3
"""
Visual Mapping System - Jetson
Creates visual maps by capturing and stitching camera images
Correlates with LIDAR data for rich spatial understanding
"""

import cv2
import numpy as np
import json
import time
import os
import math
import threading
import sqlite3
from datetime import datetime
from dataclasses import dataclass
from typing import List, Tuple, Optional, Dict
import base64

# Configuration
SCAN_ANGLES = 12  # Capture every 30 degrees
ANGLE_STEP = 360 / SCAN_ANGLES
PTZ_SETTLE_TIME = 0.5  # Wait for camera to settle after pan
CAPTURE_INTERVAL = 0.3  # Time between captures
PANORAMA_DIR = os.path.expanduser("~/robot_panoramas")
DB_PATH = os.path.expanduser("~/robot_visual_map.db")

# Feature detection
ORB_FEATURES = 500  # Number of ORB features to detect
MATCH_THRESHOLD = 30  # Minimum good matches to consider overlap


@dataclass
class CapturedFrame:
    """A single captured frame with metadata"""
    image: np.ndarray
    camera_id: int
    pan_angle: float  # PTZ pan angle (degrees)
    tilt_angle: float  # PTZ tilt angle (degrees)
    robot_x: float  # Robot position in map (cm)
    robot_y: float
    robot_heading: float  # Robot heading (degrees)
    timestamp: float
    features: Optional[np.ndarray] = None  # ORB features
    descriptors: Optional[np.ndarray] = None  # Feature descriptors

    @property
    def world_angle(self) -> float:
        """Absolute world angle this frame is looking at"""
        return (self.robot_heading + self.pan_angle) % 360


@dataclass
class VisualLandmark:
    """A recognized visual landmark"""
    landmark_id: int
    name: str
    world_x: float
    world_y: float
    thumbnail: bytes  # JPEG thumbnail
    features: np.ndarray
    descriptors: np.ndarray
    last_seen: float
    times_seen: int = 1


class PTZController:
    """Controls PTZ cameras for scanning"""

    def __init__(self, ws_send_func):
        self.send = ws_send_func
        self.current_pan = {1: 0, 2: 0}
        self.current_tilt = {1: 0, 2: 0}
        self.moving = {1: False, 2: False}

    def pan_to(self, camera_id: int, angle: float, tilt: float = 0):
        """Pan camera to absolute angle (0-360)"""
        # Convert angle to pan speed/direction
        # Cameras typically use continuous movement, so we need to calculate
        # For now, we'll use relative movement and timing
        self.send({
            "type": "ptz_goto",
            "camera": camera_id,
            "pan": angle,
            "tilt": tilt
        })
        self.current_pan[camera_id] = angle
        self.current_tilt[camera_id] = tilt

    def move(self, camera_id: int, pan_speed: float, tilt_speed: float):
        """Move camera with speed (-1 to 1)"""
        self.send({
            "type": "cam_ptz",
            "camera": camera_id,
            "action": "move",
            "pan": pan_speed,
            "tilt": tilt_speed,
            "zoom": 0
        })
        self.moving[camera_id] = True

    def stop(self, camera_id: int):
        """Stop camera movement"""
        self.send({
            "type": "cam_ptz",
            "camera": camera_id,
            "action": "stop"
        })
        self.moving[camera_id] = False

    def home(self, camera_id: int):
        """Return camera to home position"""
        self.send({
            "type": "cam_ptz",
            "camera": camera_id,
            "action": "home"
        })
        self.current_pan[camera_id] = 0
        self.current_tilt[camera_id] = 0


class FrameCapture:
    """Captures frames from camera streams"""

    def __init__(self):
        self.latest_frame = {1: None, 2: None}
        self.frame_time = {1: 0, 2: 0}
        self.lock = threading.Lock()

    def update_frame(self, camera_id: int, frame_data: bytes):
        """Called when new frame arrives from camera"""
        try:
            # Decode JPEG frame
            nparr = np.frombuffer(frame_data, np.uint8)
            frame = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
            if frame is not None:
                with self.lock:
                    self.latest_frame[camera_id] = frame
                    self.frame_time[camera_id] = time.time()
        except Exception as e:
            print(f"[VISUAL] Frame decode error: {e}")

    def get_frame(self, camera_id: int) -> Optional[np.ndarray]:
        """Get latest frame for camera"""
        with self.lock:
            if time.time() - self.frame_time[camera_id] > 2.0:
                return None  # Frame too old
            return self.latest_frame[camera_id].copy() if self.latest_frame[camera_id] is not None else None


class FeatureMatcher:
    """ORB feature detection and matching"""

    def __init__(self):
        self.orb = cv2.ORB_create(nfeatures=ORB_FEATURES)
        self.bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)

    def extract_features(self, image: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
        """Extract ORB features from image"""
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        keypoints, descriptors = self.orb.detectAndCompute(gray, None)
        if keypoints is None or len(keypoints) == 0:
            return np.array([]), None
        # Convert keypoints to array
        kp_array = np.array([[kp.pt[0], kp.pt[1], kp.size, kp.angle] for kp in keypoints])
        return kp_array, descriptors

    def match_features(self, desc1: np.ndarray, desc2: np.ndarray) -> List[cv2.DMatch]:
        """Match features between two images"""
        if desc1 is None or desc2 is None:
            return []
        if len(desc1) == 0 or len(desc2) == 0:
            return []
        matches = self.bf.match(desc1, desc2)
        # Sort by distance
        matches = sorted(matches, key=lambda x: x.distance)
        return matches

    def compute_overlap(self, desc1: np.ndarray, desc2: np.ndarray) -> float:
        """Compute overlap score between two images (0-1)"""
        matches = self.match_features(desc1, desc2)
        good_matches = [m for m in matches if m.distance < 50]
        if len(good_matches) < MATCH_THRESHOLD:
            return 0.0
        return min(1.0, len(good_matches) / 100.0)


class PanoramaStitcher:
    """Stitches multiple frames into panoramas"""

    def __init__(self):
        self.matcher = FeatureMatcher()

    def stitch_frames(self, frames: List[CapturedFrame]) -> Optional[np.ndarray]:
        """Stitch multiple frames into a panorama"""
        if len(frames) < 2:
            return frames[0].image if frames else None

        # Sort frames by world angle
        sorted_frames = sorted(frames, key=lambda f: f.world_angle)

        # Use OpenCV's stitcher for simplicity
        images = [f.image for f in sorted_frames]

        try:
            stitcher = cv2.Stitcher_create(cv2.Stitcher_PANORAMA)
            status, panorama = stitcher.stitch(images)
            if status == cv2.Stitcher_OK:
                return panorama
            else:
                print(f"[VISUAL] Stitching failed with status {status}")
                return None
        except Exception as e:
            print(f"[VISUAL] Stitching error: {e}")
            return None

    def create_strip_panorama(self, frames: List[CapturedFrame], strip_height: int = 100) -> np.ndarray:
        """Create a simple horizontal strip panorama (faster, always works)"""
        if not frames:
            return None

        # Sort by world angle
        sorted_frames = sorted(frames, key=lambda f: f.world_angle)

        # Resize each frame to strip height
        strips = []
        for frame in sorted_frames:
            h, w = frame.image.shape[:2]
            aspect = w / h
            new_w = int(strip_height * aspect)
            resized = cv2.resize(frame.image, (new_w, strip_height))
            strips.append(resized)

        # Concatenate horizontally
        panorama = np.hstack(strips)
        return panorama


class VisualMapDatabase:
    """SQLite database for storing visual map data"""

    def __init__(self, db_path: str = DB_PATH):
        self.db_path = db_path
        self.conn = None
        self._init_db()

    def _init_db(self):
        """Initialize database tables"""
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)
        self.conn = sqlite3.connect(self.db_path, check_same_thread=False)
        cursor = self.conn.cursor()

        # Panoramas table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS panoramas (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                robot_x REAL,
                robot_y REAL,
                robot_heading REAL,
                timestamp REAL,
                image_path TEXT,
                thumbnail BLOB
            )
        ''')

        # Landmarks table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS landmarks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT,
                world_x REAL,
                world_y REAL,
                thumbnail BLOB,
                features BLOB,
                descriptors BLOB,
                first_seen REAL,
                last_seen REAL,
                times_seen INTEGER DEFAULT 1
            )
        ''')

        # Scene recognition table
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS scenes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT,
                robot_x REAL,
                robot_y REAL,
                features BLOB,
                descriptors BLOB,
                thumbnail BLOB,
                created REAL
            )
        ''')

        self.conn.commit()
        print(f"[VISUAL] Database initialized at {self.db_path}")

    def save_panorama(self, robot_x: float, robot_y: float, robot_heading: float,
                      image: np.ndarray) -> int:
        """Save a panorama image"""
        timestamp = time.time()

        # Save full image to file
        os.makedirs(PANORAMA_DIR, exist_ok=True)
        filename = f"pano_{int(timestamp)}_{int(robot_x)}_{int(robot_y)}.jpg"
        filepath = os.path.join(PANORAMA_DIR, filename)
        cv2.imwrite(filepath, image, [cv2.IMWRITE_JPEG_QUALITY, 85])

        # Create thumbnail
        h, w = image.shape[:2]
        thumb_h = 60
        thumb_w = int(w * thumb_h / h)
        thumbnail = cv2.resize(image, (thumb_w, thumb_h))
        _, thumb_bytes = cv2.imencode('.jpg', thumbnail, [cv2.IMWRITE_JPEG_QUALITY, 70])

        cursor = self.conn.cursor()
        cursor.execute('''
            INSERT INTO panoramas (robot_x, robot_y, robot_heading, timestamp, image_path, thumbnail)
            VALUES (?, ?, ?, ?, ?, ?)
        ''', (robot_x, robot_y, robot_heading, timestamp, filepath, thumb_bytes.tobytes()))
        self.conn.commit()

        print(f"[VISUAL] Saved panorama at ({robot_x:.1f}, {robot_y:.1f})")
        return cursor.lastrowid

    def get_nearby_panoramas(self, robot_x: float, robot_y: float,
                              radius: float = 200) -> List[Dict]:
        """Get panoramas within radius (cm) of position"""
        cursor = self.conn.cursor()
        cursor.execute('''
            SELECT id, robot_x, robot_y, robot_heading, timestamp, image_path, thumbnail
            FROM panoramas
            WHERE (robot_x - ?) * (robot_x - ?) + (robot_y - ?) * (robot_y - ?) < ? * ?
            ORDER BY timestamp DESC
            LIMIT 10
        ''', (robot_x, robot_x, robot_y, robot_y, radius, radius))

        results = []
        for row in cursor.fetchall():
            results.append({
                'id': row[0],
                'robot_x': row[1],
                'robot_y': row[2],
                'robot_heading': row[3],
                'timestamp': row[4],
                'image_path': row[5],
                'thumbnail': row[6]
            })
        return results

    def close(self):
        if self.conn:
            self.conn.close()


class VisualMapper:
    """Main visual mapping controller"""

    def __init__(self, ws_send_func, get_pose_func):
        self.send = ws_send_func
        self.get_pose = get_pose_func  # Returns (x, y, heading)

        self.ptz = PTZController(ws_send_func)
        self.capture = FrameCapture()
        self.matcher = FeatureMatcher()
        self.stitcher = PanoramaStitcher()
        self.db = VisualMapDatabase()

        self.scanning = False
        self.scan_thread = None
        self.captured_frames: List[CapturedFrame] = []

        print("[VISUAL] Visual mapper initialized")

    def update_frame(self, camera_id: int, frame_data: bytes):
        """Update with new frame from camera"""
        self.capture.update_frame(camera_id, frame_data)

    def start_360_scan(self, camera_id: int = 1):
        """Start a 360-degree panoramic scan"""
        if self.scanning:
            print("[VISUAL] Scan already in progress")
            return

        self.scanning = True
        self.captured_frames = []
        self.scan_thread = threading.Thread(
            target=self._do_360_scan,
            args=(camera_id,),
            daemon=True
        )
        self.scan_thread.start()
        print(f"[VISUAL] Starting 360° scan with camera {camera_id}")

    def _do_360_scan(self, camera_id: int):
        """Perform the 360-degree scan"""
        try:
            robot_x, robot_y, robot_heading = self.get_pose()

            # Pan through all angles
            for i in range(SCAN_ANGLES):
                if not self.scanning:
                    break

                target_angle = i * ANGLE_STEP
                print(f"[VISUAL] Scanning angle {target_angle}°")

                # Calculate pan direction and duration
                # For continuous pan, we move for a calculated time
                pan_speed = 0.5 if target_angle > 0 else -0.5
                pan_duration = ANGLE_STEP / 90.0  # Approximate time to pan 30 degrees

                if i > 0:  # First frame at current position
                    self.ptz.move(camera_id, pan_speed, 0)
                    time.sleep(pan_duration)
                    self.ptz.stop(camera_id)
                    time.sleep(PTZ_SETTLE_TIME)

                # Capture frame
                frame = self.capture.get_frame(camera_id)
                if frame is not None:
                    # Extract features
                    features, descriptors = self.matcher.extract_features(frame)

                    captured = CapturedFrame(
                        image=frame,
                        camera_id=camera_id,
                        pan_angle=target_angle,
                        tilt_angle=0,
                        robot_x=robot_x,
                        robot_y=robot_y,
                        robot_heading=robot_heading,
                        timestamp=time.time(),
                        features=features,
                        descriptors=descriptors
                    )
                    self.captured_frames.append(captured)
                    print(f"[VISUAL] Captured frame at {target_angle}° ({len(features)} features)")

                    # Broadcast progress
                    self.send({
                        "type": "visual_scan_progress",
                        "angle": target_angle,
                        "total_angles": 360,
                        "frames_captured": len(self.captured_frames)
                    })

            # Return camera to home
            self.ptz.home(camera_id)

            # Create panorama
            if len(self.captured_frames) >= 3:
                print(f"[VISUAL] Creating panorama from {len(self.captured_frames)} frames")
                panorama = self.stitcher.create_strip_panorama(self.captured_frames)
                if panorama is not None:
                    # Save to database
                    pano_id = self.db.save_panorama(robot_x, robot_y, robot_heading, panorama)

                    # Broadcast completion
                    _, thumb_bytes = cv2.imencode('.jpg', panorama, [cv2.IMWRITE_JPEG_QUALITY, 60])
                    self.send({
                        "type": "visual_scan_complete",
                        "panorama_id": pano_id,
                        "frames_count": len(self.captured_frames),
                        "thumbnail": base64.b64encode(thumb_bytes).decode('utf-8')
                    })

        except Exception as e:
            print(f"[VISUAL] Scan error: {e}")
            import traceback
            traceback.print_exc()
        finally:
            self.scanning = False
            self.ptz.stop(camera_id)

    def stop_scan(self):
        """Stop current scan"""
        self.scanning = False
        self.ptz.stop(1)
        self.ptz.stop(2)

    def recognize_scene(self, camera_id: int = 1) -> Optional[Dict]:
        """Try to recognize current scene from database"""
        frame = self.capture.get_frame(camera_id)
        if frame is None:
            return None

        features, descriptors = self.matcher.extract_features(frame)
        if descriptors is None:
            return None

        # Get nearby panoramas
        robot_x, robot_y, _ = self.get_pose()
        nearby = self.db.get_nearby_panoramas(robot_x, robot_y, radius=500)

        best_match = None
        best_score = 0

        for pano in nearby:
            # Load panorama and match features
            if os.path.exists(pano['image_path']):
                saved_img = cv2.imread(pano['image_path'])
                if saved_img is not None:
                    _, saved_desc = self.matcher.extract_features(saved_img)
                    score = self.matcher.compute_overlap(descriptors, saved_desc)
                    if score > best_score:
                        best_score = score
                        best_match = pano

        if best_match and best_score > 0.3:
            return {
                'recognized': True,
                'panorama_id': best_match['id'],
                'confidence': best_score,
                'position': (best_match['robot_x'], best_match['robot_y'])
            }

        return {'recognized': False, 'confidence': 0}

    def get_visual_map_data(self) -> Dict:
        """Get visual map data for UI display"""
        robot_x, robot_y, _ = self.get_pose()
        panoramas = self.db.get_nearby_panoramas(robot_x, robot_y, radius=1000)

        return {
            "type": "visual_map_data",
            "robot_x": robot_x,
            "robot_y": robot_y,
            "panoramas": [
                {
                    "id": p["id"],
                    "x": p["robot_x"],
                    "y": p["robot_y"],
                    "heading": p["robot_heading"],
                    "thumbnail": base64.b64encode(p["thumbnail"]).decode('utf-8') if p["thumbnail"] else None
                }
                for p in panoramas
            ]
        }


# Test code
if __name__ == "__main__":
    print("Testing visual mapping system...")

    # Test feature matching
    matcher = FeatureMatcher()

    # Create test images
    img1 = np.random.randint(0, 255, (480, 640, 3), dtype=np.uint8)
    img2 = np.random.randint(0, 255, (480, 640, 3), dtype=np.uint8)

    features1, desc1 = matcher.extract_features(img1)
    features2, desc2 = matcher.extract_features(img2)

    print(f"Image 1: {len(features1)} features")
    print(f"Image 2: {len(features2)} features")

    # Test database
    db = VisualMapDatabase("/tmp/test_visual_map.db")
    db.close()

    print("Visual mapping system test complete!")
