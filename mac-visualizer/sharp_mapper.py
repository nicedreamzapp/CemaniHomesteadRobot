#!/usr/bin/env python3
"""
Apple SHARP Mapper - Real-Time Photorealistic 3D
Converts camera frames to 3D Gaussian Splats using Apple's SHARP model via CLI.
"""

import asyncio
import json
import math
import os
import time
import subprocess
import tempfile
import numpy as np
from pathlib import Path
from typing import Dict, Optional
import io

from PIL import Image
from plyfile import PlyData

try:
    import websockets
except ImportError:
    subprocess.check_call(["pip3", "install", "--break-system-packages", "websockets"])
    import websockets

# ============ CONFIGURATION ============
VPS_WS = "wss://robot.marijuanaunion.com"
DATA_DIR = Path(__file__).parent / "sharp_data"
DATA_DIR.mkdir(exist_ok=True)

PROCESS_INTERVAL = 2.0  # Process every 2 seconds
MAX_SPLAT_SETS = 20  # Keep last 20 processed frames

print("=" * 60)
print("  APPLE SHARP MAPPER")
print("  Photorealistic 3D from camera images")
print("=" * 60)


class SharpMapper:
    def __init__(self):
        self.robot_x = 0.0
        self.robot_y = 0.0
        self.robot_heading = 0.0
        self.last_process_time = 0.0
        self.frame_count = 0
        self.all_splats = []  # List of (means, colors, scales, opacities)
        self.processing = False

        # Test if sharp CLI works
        try:
            result = subprocess.run(["sharp", "--help"], capture_output=True, timeout=5)
            print("[SHARP] CLI available!")
            self.sharp_available = True
        except Exception as e:
            print(f"[SHARP] CLI not available: {e}")
            self.sharp_available = False

    def update_robot_pose(self, x: float, y: float, heading: float):
        self.robot_x = x
        self.robot_y = y
        self.robot_heading = heading

    def should_process(self) -> bool:
        if self.processing:
            return False
        now = time.time()
        return now - self.last_process_time >= PROCESS_INTERVAL

    async def process_frame(self, camera_id: int, image_bytes: bytes) -> Optional[Dict]:
        """Process frame through SHARP CLI"""
        if not self.should_process() or not self.sharp_available:
            return None

        self.processing = True
        self.last_process_time = time.time()

        try:
            # Save input image
            img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
            self.frame_count += 1

            input_path = DATA_DIR / f"input_{self.frame_count:04d}.jpg"
            output_dir = DATA_DIR / f"output_{self.frame_count:04d}"
            output_dir.mkdir(exist_ok=True)

            img.save(input_path, quality=95)
            print(f"[SHARP] Processing frame {self.frame_count}...")

            # Run SHARP predict with checkpoint path
            start = time.time()
            checkpoint = Path.home() / ".cache/torch/hub/checkpoints/sharp_2572gikvuh.pt"
            cmd = ["sharp", "predict", "-i", str(input_path), "-o", str(output_dir)]
            if checkpoint.exists():
                cmd.extend(["-c", str(checkpoint)])

            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=120  # 2 minutes for inference
            )

            elapsed = time.time() - start
            print(f"[SHARP] Inference took {elapsed:.2f}s")

            if result.returncode != 0:
                print(f"[SHARP] Error: {result.stderr}")
                return None

            # Find output PLY file
            ply_files = list(output_dir.glob("*.ply"))
            if not ply_files:
                print("[SHARP] No PLY output found")
                return None

            # Parse PLY file to get Gaussians
            ply_path = ply_files[0]
            splat_data = self.parse_ply(ply_path)

            if splat_data:
                # Transform to world coordinates
                splat_data = self.transform_to_world(splat_data)

                # Add to accumulated splats
                self.all_splats.append(splat_data)
                if len(self.all_splats) > MAX_SPLAT_SETS:
                    self.all_splats.pop(0)

                print(f"[SHARP] Got {len(splat_data['means'])} Gaussians")
                return self.get_combined_splats()

        except subprocess.TimeoutExpired:
            print("[SHARP] Timeout during inference")
        except Exception as e:
            print(f"[SHARP] Error: {e}")
            import traceback
            traceback.print_exc()
        finally:
            self.processing = False

        return None

    def parse_ply(self, ply_path: Path) -> Optional[Dict]:
        """Parse SHARP output PLY to extract Gaussian parameters"""
        try:
            plydata = PlyData.read(str(ply_path))
            vertex = plydata['vertex']

            # Extract positions
            x = np.array(vertex['x'])
            y = np.array(vertex['y'])
            z = np.array(vertex['z'])
            means = np.stack([x, y, z], axis=1)

            # Extract colors (f_dc_0, f_dc_1, f_dc_2 are spherical harmonics DC)
            if 'f_dc_0' in vertex.data.dtype.names:
                r = np.array(vertex['f_dc_0'])
                g = np.array(vertex['f_dc_1'])
                b = np.array(vertex['f_dc_2'])
                # Convert SH to RGB (simplified)
                colors = np.stack([r, g, b], axis=1)
                colors = (colors + 0.5).clip(0, 1)  # SH DC to RGB
            elif 'red' in vertex.data.dtype.names:
                r = np.array(vertex['red']) / 255.0
                g = np.array(vertex['green']) / 255.0
                b = np.array(vertex['blue']) / 255.0
                colors = np.stack([r, g, b], axis=1)
            else:
                colors = np.ones((len(x), 3)) * 0.5

            # Extract scales
            if 'scale_0' in vertex.data.dtype.names:
                s0 = np.exp(np.array(vertex['scale_0']))
                s1 = np.exp(np.array(vertex['scale_1']))
                s2 = np.exp(np.array(vertex['scale_2']))
                scales = np.stack([s0, s1, s2], axis=1)
            else:
                scales = np.ones((len(x), 3)) * 0.01

            # Extract opacities
            if 'opacity' in vertex.data.dtype.names:
                opacities = 1 / (1 + np.exp(-np.array(vertex['opacity'])))  # Sigmoid
            else:
                opacities = np.ones(len(x)) * 0.8

            return {
                'means': means,
                'colors': colors,
                'scales': scales,
                'opacities': opacities
            }

        except Exception as e:
            print(f"[SHARP] PLY parse error: {e}")
            return None

    def transform_to_world(self, splat_data: Dict) -> Dict:
        """Transform splat positions to world coordinates based on robot pose"""
        means = splat_data['means'].copy()

        # SHARP outputs in camera coordinates, transform to world
        cos_h = math.cos(self.robot_heading)
        sin_h = math.sin(self.robot_heading)

        # Scale down (SHARP uses metric scale but may need adjustment)
        scale = 0.5

        # Rotate and translate
        new_means = np.zeros_like(means)
        new_means[:, 0] = (means[:, 0] * cos_h - means[:, 2] * sin_h) * scale + self.robot_x
        new_means[:, 1] = means[:, 1] * scale + 0.7  # Camera height
        new_means[:, 2] = (means[:, 0] * sin_h + means[:, 2] * cos_h) * scale + self.robot_y

        splat_data['means'] = new_means
        splat_data['scales'] = splat_data['scales'] * scale

        return splat_data

    def get_combined_splats(self, max_splats: int = 10000) -> Dict:
        """Combine all splat sets for browser, downsampled for websocket limits"""
        if not self.all_splats:
            return None

        # Combine all splats
        all_means = np.concatenate([s['means'] for s in self.all_splats])
        all_colors = np.concatenate([s['colors'] for s in self.all_splats])
        all_scales = np.concatenate([s['scales'] for s in self.all_splats])
        all_opacities = np.concatenate([s['opacities'] for s in self.all_splats])

        total = len(all_means)

        # Downsample if too many - prioritize high opacity splats
        if total > max_splats:
            # Sort by opacity (descending) and take top splats
            indices = np.argsort(all_opacities)[::-1][:max_splats]
            all_means = all_means[indices]
            all_colors = all_colors[indices]
            all_scales = all_scales[indices]
            all_opacities = all_opacities[indices]
            print(f"[SHARP] Downsampled from {total} to {max_splats} splats")

        return {
            "type": "sharp_splats",
            "num_splats": len(all_means),
            "means": all_means.tolist(),
            "colors": all_colors.tolist(),
            "scales": all_scales.tolist(),
            "opacities": all_opacities.tolist(),
            "num_frames": len(self.all_splats)
        }

    def get_status(self) -> Dict:
        total = sum(len(s['means']) for s in self.all_splats) if self.all_splats else 0
        return {
            "type": "sharp_status",
            "num_frames": len(self.all_splats),
            "total_gaussians": total,
            "processing": self.processing,
            "sharp_available": self.sharp_available
        }


mapper = SharpMapper()


async def run_mapper():
    print("[SHARP] Connecting to VPS...")

    while True:
        try:
            async with websockets.connect(VPS_WS, max_size=10_000_000) as ws:
                print("[SHARP] Connected!")

                await ws.send(json.dumps({
                    "type": "register_processor",
                    "name": "sharp-mapper"
                }))

                async for message in ws:
                    try:
                        # Binary = camera frame
                        if isinstance(message, bytes) and len(message) > 1000:
                            packet_type = message[0]
                            if packet_type in [0, 2]:  # Video
                                camera_id = 1 if packet_type == 0 else 2
                                result = await mapper.process_frame(camera_id, message[1:])
                                if result:
                                    json_data = json.dumps(result)
                                    print(f"[SHARP] Sending {len(json_data)/1024/1024:.1f}MB ({result['num_splats']} splats)")
                                    try:
                                        await ws.send(json_data)
                                        print(f"[SHARP] Sent successfully!")
                                    except Exception as send_err:
                                        print(f"[SHARP] SEND ERROR: {send_err}")
                            continue

                        data = json.loads(message)

                        if data.get("type") == "dead_reckoning":
                            mapper.update_robot_pose(
                                data.get("x", 0),
                                data.get("y", 0),
                                math.radians(data.get("heading", 0))
                            )

                        elif data.get("type") == "sharp_status_request":
                            await ws.send(json.dumps(mapper.get_status()))

                    except json.JSONDecodeError:
                        pass
                    except Exception as e:
                        print(f"[SHARP] Error: {e}")

        except Exception as e:
            print(f"[SHARP] Connection error: {e}")
            await asyncio.sleep(5)


if __name__ == "__main__":
    asyncio.run(run_mapper())
