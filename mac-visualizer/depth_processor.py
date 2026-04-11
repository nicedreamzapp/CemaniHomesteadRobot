#!/usr/bin/env python3
"""
Mac Mini M4 Pro - Depth Estimation + Hybrid 3D Room Mapping
Uses Depth Anything V2 to create depth maps and builds textured 3D point clouds
"""

import asyncio
import websockets
import json
import base64
import io
import time
import numpy as np
from PIL import Image
import torch
from transformers import pipeline
import math

# VPS WebSocket
VPS_WS = "ws://YOUR_VPS_IP:3001"

# Depth estimation pipeline (will be initialized)
depth_pipe = None

# State
robot_pose = {"x": 0, "y": 0, "heading": 0}
last_depth_time = {1: 0, 2: 0}
DEPTH_INTERVAL = 0.5  # Process depth every 500ms per camera

# ============ HYBRID 3D MAPPING ============
# Accumulated 3D point cloud with colors
accumulated_points = []  # List of {x, y, z, r, g, b, count}
point_grid = {}  # Grid-based deduplication
GRID_SIZE = 0.05  # 5cm grid cells
MAX_POINTS = 100000
last_map_send = 0
MAP_SEND_INTERVAL = 2.0  # Send accumulated map every 2 seconds

# Camera intrinsics (approximate for 640x480)
CAM_FX = 500  # Focal length X
CAM_FY = 500  # Focal length Y
CAM_CX = 320  # Principal point X
CAM_CY = 240  # Principal point Y
DEPTH_SCALE = 5.0  # Scale factor for relative depth -> meters

# Colormap for depth visualization (viridis-like)
def depth_to_colormap(depth_array):
    """Convert depth array to colorized RGB image"""
    # Normalize to 0-1
    depth_norm = (depth_array - depth_array.min()) / (depth_array.max() - depth_array.min() + 1e-8)

    # Apply viridis-like colormap
    # Deep = purple/blue, Mid = green/yellow, Close = orange/red
    r = np.clip(255 * (1.5 - np.abs(depth_norm - 0.75) * 4), 0, 255)
    g = np.clip(255 * (1.5 - np.abs(depth_norm - 0.5) * 4), 0, 255)
    b = np.clip(255 * (1.5 - np.abs(depth_norm - 0.25) * 4), 0, 255)

    # Create RGB image
    rgb = np.stack([r, g, b], axis=-1).astype(np.uint8)
    return rgb


def project_to_3d(rgb_image, depth_map, pose, camera_id):
    """
    Project camera pixels into 3D world coordinates using depth and robot pose.
    Creates textured point cloud for hybrid mapping.

    Args:
        rgb_image: Original color image (PIL Image)
        depth_map: Depth estimation array (relative depth values)
        pose: Robot pose {x, y, heading} in mm and degrees
        camera_id: 1 for front cam, 2 for rear cam
    """
    global accumulated_points, point_grid

    # Convert to numpy
    rgb = np.array(rgb_image)
    h, w = depth_map.shape

    # Downsample for performance (process every 8th pixel)
    step = 8

    # Robot pose in meters
    robot_x = pose.get("x", 0) / 1000.0  # mm to m
    robot_y = pose.get("y", 0) / 1000.0
    robot_heading = math.radians(pose.get("heading", 0))  # degrees to radians

    # Camera offset from robot center (approximate)
    # Cam1 (front) looks forward, Cam2 (rear) looks backward
    if camera_id == 1:
        cam_offset_x = 0.0  # Center
        cam_offset_z = -0.15  # 15cm forward
        cam_yaw = 0  # Faces forward
    else:
        cam_offset_x = -0.20  # 20cm to the left (on tower)
        cam_offset_z = 0.0  # Center
        cam_yaw = math.pi  # Faces backward

    # Normalize depth (Depth Anything gives relative depth, higher = closer)
    depth_normalized = depth_map / (depth_map.max() + 1e-8)
    # Invert so lower value = closer (more intuitive)
    depth_meters = (1.0 - depth_normalized) * DEPTH_SCALE + 0.5  # 0.5m to 5.5m range

    points_added = 0

    for v in range(0, h, step):
        for u in range(0, w, step):
            d = depth_meters[v, u]

            # Skip very close or very far points
            if d < 0.3 or d > 6.0:
                continue

            # Get pixel color from original image (resized to match)
            px = int(u * rgb.shape[1] / w)
            py = int(v * rgb.shape[0] / h)
            if py < rgb.shape[0] and px < rgb.shape[1]:
                r, g, b = rgb[py, px]
            else:
                continue

            # Skip very dark pixels (likely noise)
            if r + g + b < 30:
                continue

            # Project to camera 3D (pinhole model)
            x_cam = (u - CAM_CX / (w / 640)) * d / (CAM_FX / (w / 640))
            y_cam = (v - CAM_CY / (h / 480)) * d / (CAM_FY / (h / 480))
            z_cam = d

            # Transform to robot frame (camera mounted looking forward/backward)
            # Camera Z = forward, X = right, Y = down
            # Robot: X = right, Y = forward, Z = up
            x_robot = x_cam
            y_robot = z_cam  # Camera forward = robot forward
            z_robot = -y_cam + 0.4  # Camera down = robot up, offset for camera height

            # Apply camera yaw offset
            cos_cam = math.cos(cam_yaw)
            sin_cam = math.sin(cam_yaw)
            x_rot = x_robot * cos_cam - y_robot * sin_cam
            y_rot = x_robot * sin_cam + y_robot * cos_cam

            # Add camera position offset
            x_final = x_rot + cam_offset_x
            y_final = y_rot + cam_offset_z

            # Transform to world frame using robot pose
            cos_h = math.cos(robot_heading)
            sin_h = math.sin(robot_heading)
            world_x = robot_x + x_final * cos_h - y_final * sin_h
            world_y = robot_y + x_final * sin_h + y_final * cos_h
            world_z = z_robot  # Keep height in robot frame

            # Grid-based deduplication
            grid_x = int(world_x / GRID_SIZE)
            grid_y = int(world_y / GRID_SIZE)
            grid_z = int(world_z / GRID_SIZE)
            grid_key = f"{grid_x},{grid_y},{grid_z}"

            if grid_key in point_grid:
                # Update existing point (running average of color)
                idx = point_grid[grid_key]
                pt = accumulated_points[idx]
                n = pt["count"]
                pt["r"] = (pt["r"] * n + r) / (n + 1)
                pt["g"] = (pt["g"] * n + g) / (n + 1)
                pt["b"] = (pt["b"] * n + b) / (n + 1)
                pt["count"] = n + 1
            else:
                # Add new point
                new_point = {
                    "x": world_x,
                    "y": world_y,
                    "z": world_z,
                    "r": float(r),
                    "g": float(g),
                    "b": float(b),
                    "count": 1
                }

                # Limit total points
                if len(accumulated_points) >= MAX_POINTS:
                    # Remove oldest point
                    old_key = list(point_grid.keys())[0]
                    old_idx = point_grid.pop(old_key)
                    accumulated_points.pop(old_idx)
                    # Reindex
                    point_grid = {k: (v if v < old_idx else v - 1) for k, v in point_grid.items()}

                point_grid[grid_key] = len(accumulated_points)
                accumulated_points.append(new_point)
                points_added += 1

    return points_added


def get_accumulated_map_data():
    """Get the accumulated point cloud for sending to VPS"""
    if len(accumulated_points) == 0:
        return None

    # Format for transmission (simplified for bandwidth)
    points = []
    for pt in accumulated_points:
        points.append({
            "x": round(pt["x"], 3),
            "y": round(pt["y"], 3),
            "z": round(pt["z"], 3),
            "r": int(pt["r"]),
            "g": int(pt["g"]),
            "b": int(pt["b"]),
            "count": pt["count"]
        })

    return {
        "type": "accumulated_map",
        "points": points,
        "total": len(points)
    }

def process_depth(image_bytes, camera_id, pose):
    """Process a camera frame through depth estimation and 3D projection"""
    global depth_pipe

    try:
        # Decode image
        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")

        # Resize for faster processing (depth works fine at lower res)
        img_small = img.resize((384, 288))

        # Run depth estimation
        result = depth_pipe(img_small)
        depth_map = np.array(result["depth"])

        # Project to 3D for hybrid mapping (uses original colors)
        points_added = project_to_3d(img, depth_map, pose, camera_id)
        if points_added > 0:
            print(f"[3D MAP] Cam {camera_id}: +{points_added} pts, total: {len(accumulated_points)}")

        # Colorize the depth map for visualization
        colored = depth_to_colormap(depth_map)

        # Resize back to original size
        colored_img = Image.fromarray(colored)
        colored_img = colored_img.resize(img.size, Image.BILINEAR)

        # Encode as JPEG
        buffer = io.BytesIO()
        colored_img.save(buffer, format="JPEG", quality=80)
        return buffer.getvalue()

    except Exception as e:
        print(f"[DEPTH] Error processing cam {camera_id}: {e}")
        import traceback
        traceback.print_exc()
        return None

async def handle_vps_connection():
    """Connect to VPS and process camera frames"""
    global depth_pipe, robot_pose, last_map_send

    print("[MAC] Connecting to VPS...")

    async with websockets.connect(VPS_WS, max_size=10_000_000) as ws:
        print("[MAC] Connected! Registering as depth processor...")

        # Register
        await ws.send(json.dumps({
            "type": "register_processor",
            "name": "mac-depth-processor",
            "capabilities": ["depth_estimation", "room_mapping", "hybrid_3d"]
        }))

        print("[MAC] Waiting for camera frames...")
        print("[MAC] Hybrid 3D mapping ENABLED - accumulating textured point cloud")

        async for message in ws:
            try:
                now = time.time()

                # Periodically send accumulated map
                if now - last_map_send >= MAP_SEND_INTERVAL and len(accumulated_points) > 100:
                    map_data = get_accumulated_map_data()
                    if map_data:
                        await ws.send(json.dumps(map_data))
                        print(f"[3D MAP] Sent {map_data['total']} points to VPS")
                        last_map_send = now

                # Check if binary (camera frame)
                if isinstance(message, bytes) and len(message) > 100:
                    first_byte = message[0]

                    # Camera packet: 0=cam1 video, 1=cam1 audio, 2=cam2 video, 3=cam2 audio
                    if first_byte in [0, 2]:  # Video frames only
                        camera_id = 1 if first_byte == 0 else 2
                        frame_data = message[1:]

                        # Rate limit depth processing
                        if now - last_depth_time[camera_id] >= DEPTH_INTERVAL:
                            last_depth_time[camera_id] = now

                            # Process depth with current pose for 3D projection
                            depth_result = process_depth(frame_data, camera_id, robot_pose.copy())

                            if depth_result:
                                # Send colorized depth back to VPS
                                await ws.send(json.dumps({
                                    "type": "depth_frame",
                                    "camera": camera_id,
                                    "frame": base64.b64encode(depth_result).decode(),
                                    "pose": robot_pose,
                                    "timestamp": int(now * 1000)
                                }))
                                print(f"[DEPTH] Cam {camera_id} - sent {len(depth_result)} bytes")

                    continue

                # JSON messages
                data = json.loads(message)

                # Update robot pose from odometry
                if data.get("type") == "dead_reckoning":
                    robot_pose["x"] = data.get("odomX", data.get("x", 0))
                    robot_pose["y"] = data.get("odomY", data.get("y", 0))
                    robot_pose["heading"] = data.get("odomHeadingDeg", data.get("heading", 0))

                # Handle clear map command
                if data.get("type") == "clear_3d_map":
                    accumulated_points.clear()
                    point_grid.clear()
                    print("[3D MAP] Cleared accumulated map")

            except json.JSONDecodeError:
                pass
            except Exception as e:
                print(f"[MAC] Error: {e}")
                import traceback
                traceback.print_exc()

def init_depth_model():
    """Initialize the depth estimation model"""
    global depth_pipe

    print("[MAC] Loading Depth Anything model...")
    print("[MAC] This may take a minute on first run...")

    # Use MPS (Metal) on Mac for GPU acceleration
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    print(f"[MAC] Using device: {device}")

    # Load Depth Anything V2 (smaller model for speed)
    depth_pipe = pipeline(
        "depth-estimation",
        model="depth-anything/Depth-Anything-V2-Small-hf",
        device=device
    )

    print("[MAC] Depth model loaded!")

    # Warm up with dummy image
    dummy = Image.new("RGB", (384, 288), color="gray")
    depth_pipe(dummy)
    print("[MAC] Model warmed up and ready!")

async def main():
    """Main entry point"""
    print("=" * 50)
    print("  MAC MINI DEPTH PROCESSOR")
    print("  Depth Anything V2 + Room Mapping")
    print("=" * 50)

    # Initialize model
    init_depth_model()

    # Connect and process
    while True:
        try:
            await handle_vps_connection()
        except Exception as e:
            print(f"[MAC] Connection error: {e}")
            print("[MAC] Reconnecting in 3 seconds...")
            await asyncio.sleep(3)

if __name__ == "__main__":
    asyncio.run(main())
