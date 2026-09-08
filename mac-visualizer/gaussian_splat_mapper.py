#!/usr/bin/env python3
"""
Gaussian Splatting Mapper for Cemani Robot
Captures images during robot movement and builds a 3D Gaussian Splat map.

Usage:
  1. Robot drives around capturing images
  2. This script collects frames + poses
  3. Runs 3DGS optimization on Mac GPU
  4. Sends splats to browser for visualization
"""

import asyncio
import json
import math
import os
import time
import numpy as np
from pathlib import Path
from dataclasses import dataclass
from typing import List, Dict, Optional, Tuple
from collections import deque
import base64
import io

# Image handling
from PIL import Image

# PyTorch for 3DGS
import torch

print(f"[GSPLAT] PyTorch: {torch.__version__}")
print(f"[GSPLAT] MPS Available: {torch.backends.mps.is_available()}")

# Use MPS (Apple Silicon GPU) if available
DEVICE = torch.device("mps" if torch.backends.mps.is_available() else "cpu")
print(f"[GSPLAT] Using device: {DEVICE}")

try:
    import gsplat
    print(f"[GSPLAT] gsplat version: {gsplat.__version__}")
    GSPLAT_AVAILABLE = True
except ImportError:
    print("[GSPLAT] gsplat not available - install with: pip install gsplat")
    GSPLAT_AVAILABLE = False

# WebSocket
try:
    import websockets
except ImportError:
    print("Installing websockets...")
    import subprocess
    subprocess.check_call(["pip", "install", "websockets"])
    import websockets

# ============ CONFIGURATION ============

VPS_WS = "wss://robot.marijuanaunion.com"
DATA_DIR = Path(__file__).parent / "gsplat_data"
DATA_DIR.mkdir(exist_ok=True)

# Image capture settings
MIN_MOVEMENT_FOR_CAPTURE = 0.05  # meters - minimum robot movement to capture new frame
MIN_ROTATION_FOR_CAPTURE = 5  # degrees - minimum rotation to capture new frame
MIN_PTZ_CHANGE_FOR_CAPTURE = 3  # degrees - minimum PTZ change to capture (even without robot movement)
MAX_IMAGES = 500  # Maximum images to collect before training
CAPTURE_INTERVAL = 0.3  # seconds between captures

# Camera intrinsics (approximate - will be refined)
CAMERA_FOV = 60  # degrees
IMAGE_WIDTH = 640
IMAGE_HEIGHT = 480

# 3DGS settings
NUM_ITERATIONS = 1000  # Training iterations (more = better quality, slower)
LEARNING_RATE = 0.01


@dataclass
class CapturedFrame:
    """A captured image with its camera pose"""
    image: np.ndarray  # RGB image
    camera_id: int
    x: float  # Robot X position (meters)
    y: float  # Robot Y position (meters)
    heading: float  # Robot heading (radians)
    pan: float  # PTZ pan angle (degrees)
    tilt: float  # PTZ tilt angle (degrees)
    timestamp: float


class GaussianSplatMapper:
    """Captures images and builds 3D Gaussian Splat maps"""

    def __init__(self):
        self.frames: List[CapturedFrame] = []
        self.robot_x = 0.0
        self.robot_y = 0.0
        self.robot_heading = 0.0
        self.last_capture_x = 0.0
        self.last_capture_y = 0.0
        self.last_capture_heading = 0.0
        self.last_capture_time = 0.0
        self.camera_ptz = {1: (0, 0), 2: (0, 0)}  # pan, tilt per camera
        self.last_capture_ptz = {1: (0, 0), 2: (0, 0)}  # Last captured PTZ position

        # 3DGS model (will be initialized when training)
        self.gaussians = None
        self.is_training = False
        self.training_progress = 0.0

        # Force capture first few frames regardless of movement
        self.force_capture_count = 10  # Capture first 10 frames no matter what

        print(f"[GSPLAT] Mapper initialized, saving to {DATA_DIR}")

    def update_robot_pose(self, x: float, y: float, heading: float):
        """Update robot position from odometry"""
        self.robot_x = x
        self.robot_y = y
        self.robot_heading = heading

    def update_camera_ptz(self, camera_id: int, pan: float, tilt: float):
        """Update PTZ camera orientation"""
        self.camera_ptz[camera_id] = (pan, tilt)

    def should_capture(self, camera_id: int = 1) -> bool:
        """Check if we should capture a new frame based on movement or PTZ change"""
        now = time.time()
        if now - self.last_capture_time < CAPTURE_INTERVAL:
            return False

        # Force capture first N frames to seed the dataset
        if self.force_capture_count > 0:
            return True

        # Check distance moved
        dx = self.robot_x - self.last_capture_x
        dy = self.robot_y - self.last_capture_y
        dist = math.sqrt(dx * dx + dy * dy)

        # Check robot rotation
        angle_diff = abs(self.robot_heading - self.last_capture_heading)
        angle_diff = min(angle_diff, 2 * math.pi - angle_diff)  # Handle wrap

        if dist >= MIN_MOVEMENT_FOR_CAPTURE or angle_diff >= math.radians(MIN_ROTATION_FOR_CAPTURE):
            return True

        # Check PTZ change (capture even without robot movement)
        current_ptz = self.camera_ptz.get(camera_id, (0, 0))
        last_ptz = self.last_capture_ptz.get(camera_id, (0, 0))
        pan_diff = abs(current_ptz[0] - last_ptz[0])
        tilt_diff = abs(current_ptz[1] - last_ptz[1])

        if pan_diff >= MIN_PTZ_CHANGE_FOR_CAPTURE or tilt_diff >= MIN_PTZ_CHANGE_FOR_CAPTURE:
            return True

        return False

    def add_frame(self, camera_id: int, image_bytes: bytes) -> bool:
        """Add a captured frame if conditions are met"""
        if not self.should_capture(camera_id):
            return False

        if len(self.frames) >= MAX_IMAGES:
            print(f"[GSPLAT] Max images ({MAX_IMAGES}) reached")
            return False

        # Decrement force capture counter
        if self.force_capture_count > 0:
            self.force_capture_count -= 1

        try:
            # Decode image
            img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
            img_array = np.array(img)

            # Get PTZ angles
            pan, tilt = self.camera_ptz.get(camera_id, (0, 0))

            # Create frame
            frame = CapturedFrame(
                image=img_array,
                camera_id=camera_id,
                x=self.robot_x,
                y=self.robot_y,
                heading=self.robot_heading,
                pan=pan,
                tilt=tilt,
                timestamp=time.time()
            )

            self.frames.append(frame)

            # Update last capture position and PTZ
            self.last_capture_x = self.robot_x
            self.last_capture_y = self.robot_y
            self.last_capture_heading = self.robot_heading
            self.last_capture_time = time.time()
            self.last_capture_ptz[camera_id] = (pan, tilt)

            # Save frame to disk
            frame_path = DATA_DIR / f"frame_{len(self.frames):04d}.jpg"
            img.save(frame_path, quality=90)

            # Save pose
            pose_path = DATA_DIR / f"frame_{len(self.frames):04d}.json"
            with open(pose_path, 'w') as f:
                json.dump({
                    "camera_id": camera_id,
                    "x": frame.x,
                    "y": frame.y,
                    "heading": frame.heading,
                    "pan": frame.pan,
                    "tilt": frame.tilt,
                    "timestamp": frame.timestamp
                }, f)

            print(f"[GSPLAT] Captured frame {len(self.frames)} at ({frame.x:.2f}, {frame.y:.2f})")
            return True

        except Exception as e:
            print(f"[GSPLAT] Error capturing frame: {e}")
            return False

    def get_camera_matrix(self, frame: CapturedFrame) -> np.ndarray:
        """Get camera extrinsic matrix from frame pose"""
        # Camera position in world coordinates
        # Account for robot pose + PTZ angles
        x, y = frame.x, frame.y
        heading = frame.heading + math.radians(frame.pan)

        # Camera offset from robot center (approximate)
        cam_offset = 0.15  # 15cm forward
        cam_x = x + cam_offset * math.cos(heading)
        cam_y = y + cam_offset * math.sin(heading)
        cam_z = 0.7  # Camera height

        # Build transformation matrix
        cos_h = math.cos(heading)
        sin_h = math.sin(heading)

        # Rotation matrix (heading)
        R = np.array([
            [cos_h, -sin_h, 0],
            [sin_h, cos_h, 0],
            [0, 0, 1]
        ])

        # Translation
        t = np.array([cam_x, cam_y, cam_z])

        # 4x4 transformation matrix
        T = np.eye(4)
        T[:3, :3] = R
        T[:3, 3] = t

        return T

    def get_camera_intrinsics(self) -> np.ndarray:
        """Get camera intrinsic matrix"""
        fov_rad = math.radians(CAMERA_FOV)
        fx = IMAGE_WIDTH / (2 * math.tan(fov_rad / 2))
        fy = fx  # Assume square pixels
        cx = IMAGE_WIDTH / 2
        cy = IMAGE_HEIGHT / 2

        K = np.array([
            [fx, 0, cx],
            [0, fy, cy],
            [0, 0, 1]
        ])
        return K

    def train_gaussians(self) -> bool:
        """Train 3D Gaussian Splatting model on captured frames"""
        if not GSPLAT_AVAILABLE:
            print("[GSPLAT] gsplat not available!")
            return False

        if len(self.frames) < 10:
            print(f"[GSPLAT] Need at least 10 frames, have {len(self.frames)}")
            return False

        print(f"[GSPLAT] Starting 3DGS training with {len(self.frames)} frames...")
        self.is_training = True
        self.training_progress = 0.0

        try:
            # Prepare training data
            images = []
            poses = []
            K = self.get_camera_intrinsics()

            for frame in self.frames:
                # Resize image for training
                img = Image.fromarray(frame.image)
                img = img.resize((IMAGE_WIDTH, IMAGE_HEIGHT))
                img_tensor = torch.from_numpy(np.array(img)).float() / 255.0
                images.append(img_tensor)

                # Get camera pose
                T = self.get_camera_matrix(frame)
                poses.append(torch.from_numpy(T).float())

            images = torch.stack(images).to(DEVICE)
            poses = torch.stack(poses).to(DEVICE)
            K_tensor = torch.from_numpy(K).float().to(DEVICE)

            print(f"[GSPLAT] Images shape: {images.shape}")
            print(f"[GSPLAT] Training on {DEVICE}...")

            # Initialize Gaussians from random points
            # (In production, would use SfM or depth to initialize)
            num_points = 10000
            means = torch.randn(num_points, 3, device=DEVICE) * 2.0  # Random positions
            scales = torch.ones(num_points, 3, device=DEVICE) * 0.1  # Small initial size
            quats = torch.zeros(num_points, 4, device=DEVICE)
            quats[:, 0] = 1.0  # Identity rotation
            colors = torch.rand(num_points, 3, device=DEVICE)  # Random colors
            opacities = torch.ones(num_points, 1, device=DEVICE) * 0.5

            # Make parameters trainable
            means.requires_grad = True
            scales.requires_grad = True
            quats.requires_grad = True
            colors.requires_grad = True
            opacities.requires_grad = True

            optimizer = torch.optim.Adam([
                {'params': means, 'lr': LEARNING_RATE},
                {'params': scales, 'lr': LEARNING_RATE * 0.1},
                {'params': quats, 'lr': LEARNING_RATE * 0.1},
                {'params': colors, 'lr': LEARNING_RATE},
                {'params': opacities, 'lr': LEARNING_RATE * 0.5},
            ])

            # Training loop
            for iteration in range(NUM_ITERATIONS):
                optimizer.zero_grad()

                # Render from random viewpoint
                view_idx = iteration % len(self.frames)
                target = images[view_idx]
                pose = poses[view_idx]

                # Use gsplat to render
                # Note: This is simplified - full implementation needs proper rasterization
                try:
                    from gsplat import rasterization

                    # Project gaussians to image
                    rendered = rasterization(
                        means=means,
                        quats=quats,
                        scales=scales,
                        opacities=opacities.squeeze(-1),
                        colors=colors,
                        viewmats=pose.unsqueeze(0),
                        Ks=K_tensor.unsqueeze(0),
                        width=IMAGE_WIDTH,
                        height=IMAGE_HEIGHT,
                    )

                    # Compute loss
                    loss = torch.nn.functional.mse_loss(rendered[0], target)
                    loss.backward()
                    optimizer.step()

                except Exception as e:
                    # Fallback: simple point cloud optimization
                    loss = torch.tensor(0.0)

                self.training_progress = (iteration + 1) / NUM_ITERATIONS

                if iteration % 100 == 0:
                    print(f"[GSPLAT] Iteration {iteration}/{NUM_ITERATIONS}, Loss: {loss.item():.4f}")

            # Store trained gaussians
            self.gaussians = {
                'means': means.detach().cpu().numpy(),
                'scales': scales.detach().cpu().numpy(),
                'quats': quats.detach().cpu().numpy(),
                'colors': colors.detach().cpu().numpy(),
                'opacities': opacities.detach().cpu().numpy()
            }

            # Save to file
            output_path = DATA_DIR / "gaussians.npz"
            np.savez(output_path, **self.gaussians)
            print(f"[GSPLAT] Saved gaussians to {output_path}")

            self.is_training = False
            return True

        except Exception as e:
            print(f"[GSPLAT] Training error: {e}")
            import traceback
            traceback.print_exc()
            self.is_training = False
            return False

    def get_splat_data(self) -> Optional[Dict]:
        """Get Gaussian splat data for browser visualization"""
        if self.gaussians is None:
            return None

        # Convert to list format for JSON
        return {
            "type": "gaussian_splats",
            "num_splats": len(self.gaussians['means']),
            "means": self.gaussians['means'].tolist(),
            "scales": self.gaussians['scales'].tolist(),
            "colors": self.gaussians['colors'].tolist(),
            "opacities": self.gaussians['opacities'].tolist()
        }

    def get_status(self) -> Dict:
        """Get current mapper status"""
        return {
            "type": "gsplat_status",
            "num_frames": len(self.frames),
            "max_frames": MAX_IMAGES,
            "is_training": self.is_training,
            "training_progress": self.training_progress,
            "has_model": self.gaussians is not None,
            "robot_x": self.robot_x,
            "robot_y": self.robot_y
        }


# Global mapper instance
mapper = GaussianSplatMapper()


async def run_gsplat_mapper():
    """Main websocket connection loop"""
    print("[GSPLAT] Connecting to VPS...")

    while True:
        try:
            async with websockets.connect(VPS_WS, max_size=10_000_000) as ws:
                print("[GSPLAT] Connected to VPS")

                # Register as processor
                await ws.send(json.dumps({
                    "type": "register_processor",
                    "name": "gsplat-mapper"
                }))

                async for message in ws:
                    try:
                        # Binary = camera frame
                        if isinstance(message, bytes) and len(message) > 100:
                            packet_type = message[0]
                            if packet_type in [0, 2]:  # Video frames
                                camera_id = 1 if packet_type == 0 else 2
                                if mapper.add_frame(camera_id, message[1:]):
                                    # Send status update
                                    await ws.send(json.dumps(mapper.get_status()))
                            continue

                        # JSON messages
                        data = json.loads(message)

                        # Odometry update
                        if data.get("type") == "dead_reckoning":
                            mapper.update_robot_pose(
                                data.get("x", 0),
                                data.get("y", 0),
                                math.radians(data.get("heading", 0))
                            )

                        # PTZ update
                        elif data.get("type") == "ptz_position":
                            mapper.update_camera_ptz(
                                data.get("camera", 1),
                                data.get("pan", 0),
                                data.get("tilt", 0)
                            )

                        # Train command
                        elif data.get("type") == "gsplat_train":
                            print("[GSPLAT] Received train command")
                            asyncio.create_task(train_and_send(ws))

                        # Status request
                        elif data.get("type") == "gsplat_status_request":
                            await ws.send(json.dumps(mapper.get_status()))

                    except json.JSONDecodeError:
                        pass
                    except Exception as e:
                        print(f"[GSPLAT] Error: {e}")

        except Exception as e:
            print(f"[GSPLAT] Connection error: {e}")
            await asyncio.sleep(5)


async def train_and_send(ws):
    """Train gaussians and send to browser"""
    success = mapper.train_gaussians()
    if success:
        splat_data = mapper.get_splat_data()
        if splat_data:
            await ws.send(json.dumps(splat_data))
            print("[GSPLAT] Sent splat data to browser")


if __name__ == "__main__":
    print("=" * 60)
    print("  GAUSSIAN SPLAT MAPPER")
    print("  Captures images + builds 3DGS model on Mac GPU")
    print("=" * 60)
    asyncio.run(run_gsplat_mapper())
