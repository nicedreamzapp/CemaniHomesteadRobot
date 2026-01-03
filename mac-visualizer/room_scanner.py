#!/usr/bin/env python3
"""
CEMANI ROBOT - 3D ROOM SCANNER
Systematically captures images from PTZ cameras for photorealistic 3D reconstruction

Features:
- Automatic PTZ sweep to capture entire room
- Saves high-res images with pose metadata
- Outputs COLMAP-compatible format for 3D reconstruction
- Supports both front and rear cameras
"""

import asyncio
import websockets
import json
import time
import os
import base64
from datetime import datetime
from pathlib import Path

VPS_WS = "ws://72.60.124.34:3001"

# Output directories
BASE_DIR = Path(__file__).parent
SCANS_DIR = BASE_DIR / "room_scans"
CURRENT_SCAN_DIR = None

# PTZ scan grid - comprehensive coverage
# (pan, tilt) - pan is horizontal (-170 to 170), tilt is vertical (-30 to 60)
def generate_scan_grid(pan_range=(-120, 120), tilt_range=(-20, 40), pan_step=30, tilt_step=20):
    """Generate a grid of scan positions"""
    positions = []
    for tilt in range(tilt_range[1], tilt_range[0] - 1, -tilt_step):  # Top to bottom
        for pan in range(pan_range[0], pan_range[1] + 1, pan_step):   # Left to right
            positions.append((pan, tilt))
    return positions

SCAN_POSITIONS = generate_scan_grid()
print(f"Scan grid: {len(SCAN_POSITIONS)} positions")

# State
class ScanState:
    active = False
    camera = 1
    position_idx = 0
    frames_captured = 0
    robot_pose = {"x": 0, "y": 0, "heading": 0}
    scan_id = None

state = ScanState()

def create_scan_directory():
    """Create directory for this scan session"""
    global CURRENT_SCAN_DIR
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    CURRENT_SCAN_DIR = SCANS_DIR / f"scan_{timestamp}"
    CURRENT_SCAN_DIR.mkdir(parents=True, exist_ok=True)
    (CURRENT_SCAN_DIR / "images").mkdir(exist_ok=True)
    (CURRENT_SCAN_DIR / "cam1").mkdir(exist_ok=True)
    (CURRENT_SCAN_DIR / "cam2").mkdir(exist_ok=True)

    # Create metadata file
    metadata = {
        "scan_id": timestamp,
        "start_time": datetime.now().isoformat(),
        "positions": SCAN_POSITIONS,
        "cameras": [1, 2],
        "images": []
    }
    with open(CURRENT_SCAN_DIR / "metadata.json", "w") as f:
        json.dump(metadata, f, indent=2)

    print(f"[SCAN] Created scan directory: {CURRENT_SCAN_DIR}")
    return timestamp

def save_frame(frame_data, camera, pan, tilt, robot_pose, frame_idx):
    """Save captured frame to disk with metadata"""
    if not CURRENT_SCAN_DIR:
        return None

    # Decode base64 image
    try:
        image_bytes = base64.b64decode(frame_data)
    except:
        print(f"[SCAN] Failed to decode frame")
        return None

    # Generate filename
    filename = f"cam{camera}_{frame_idx:04d}_p{pan:+04d}_t{tilt:+03d}.jpg"
    filepath = CURRENT_SCAN_DIR / f"cam{camera}" / filename

    # Save image
    with open(filepath, "wb") as f:
        f.write(image_bytes)

    # Save pose metadata
    pose_file = filepath.with_suffix(".json")
    pose_data = {
        "camera": camera,
        "pan": pan,
        "tilt": tilt,
        "robot_x": robot_pose.get("x", 0),
        "robot_y": robot_pose.get("y", 0),
        "robot_heading": robot_pose.get("heading", 0),
        "timestamp": time.time(),
        "frame_index": frame_idx
    }
    with open(pose_file, "w") as f:
        json.dump(pose_data, f, indent=2)

    print(f"[SCAN] Saved: {filename}")
    return str(filepath)

async def handle_messages(ws):
    """Handle incoming WebSocket messages"""
    try:
        message = await asyncio.wait_for(ws.recv(), timeout=0.05)

        # Handle binary frames (camera video)
        if isinstance(message, bytes) and len(message) > 100:
            packet_type = message[0]
            if packet_type in [0, 2]:  # Video frames
                camera_id = 1 if packet_type == 0 else 2
                if state.active and camera_id == state.camera:
                    # Convert to base64 for saving
                    frame_b64 = base64.b64encode(message[1:]).decode()
                    return ("frame", camera_id, frame_b64)
            return None

        # Handle JSON messages
        data = json.loads(message)

        if data.get("type") == "dead_reckoning":
            state.robot_pose = {
                "x": data.get("odomX", 0),
                "y": data.get("odomY", 0),
                "heading": data.get("odomHeadingDeg", 0)
            }

        if data.get("type") == "scan_frame_captured":
            return ("captured", data)

        if data.get("type") == "stop_room_scan":
            state.active = False
            print("[SCAN] Scan stopped by user")

        return None
    except asyncio.TimeoutError:
        return None
    except:
        return None

async def move_camera(ws, camera, pan, tilt):
    """Move PTZ camera to position"""
    await ws.send(json.dumps({
        "type": "ptz",
        "camera": camera,
        "action": "absolute",
        "pan": pan,
        "tilt": tilt
    }))
    print(f"[PTZ] Cam {camera} -> pan={pan}°, tilt={tilt}°")

async def request_snapshot(ws, camera):
    """Request high-res snapshot from camera"""
    await ws.send(json.dumps({
        "type": "cam_snapshot",
        "camera": camera,
        "quality": "high"
    }))

async def run_scan(ws):
    """Execute the room scan"""
    global state

    print("\n" + "=" * 50)
    print("  STARTING ROOM SCAN")
    print(f"  {len(SCAN_POSITIONS)} positions per camera")
    print("=" * 50 + "\n")

    state.scan_id = create_scan_directory()
    state.active = True
    state.position_idx = 0
    state.frames_captured = 0

    # Scan both cameras
    for camera in [1, 2]:
        state.camera = camera
        print(f"\n[SCAN] === Scanning Camera {camera} ===")

        for idx, (pan, tilt) in enumerate(SCAN_POSITIONS):
            if not state.active:
                print("[SCAN] Scan aborted")
                return

            state.position_idx = idx

            # Move camera
            await move_camera(ws, camera, pan, tilt)

            # Wait for camera to settle
            await asyncio.sleep(1.5)

            # Capture frame - wait for binary frame
            frame_captured = False
            capture_attempts = 0
            while not frame_captured and capture_attempts < 20:
                result = await handle_messages(ws)
                if result and result[0] == "frame" and result[1] == camera:
                    saved = save_frame(
                        result[2], camera, pan, tilt,
                        state.robot_pose, state.frames_captured
                    )
                    if saved:
                        frame_captured = True
                        state.frames_captured += 1
                capture_attempts += 1
                await asyncio.sleep(0.1)

            if not frame_captured:
                print(f"[SCAN] Warning: No frame captured at pan={pan}, tilt={tilt}")

            # Progress update
            total = len(SCAN_POSITIONS) * 2
            done = state.frames_captured
            pct = (done / total) * 100
            print(f"[SCAN] Progress: {done}/{total} ({pct:.1f}%)")

    print("\n" + "=" * 50)
    print(f"  SCAN COMPLETE!")
    print(f"  Captured {state.frames_captured} images")
    print(f"  Saved to: {CURRENT_SCAN_DIR}")
    print("=" * 50 + "\n")

    # Notify VPS
    await ws.send(json.dumps({
        "type": "room_scan_complete",
        "scan_id": state.scan_id,
        "frames": state.frames_captured,
        "path": str(CURRENT_SCAN_DIR)
    }))

    state.active = False
    return CURRENT_SCAN_DIR

async def main():
    """Main entry point"""
    print("=" * 60)
    print("  CEMANI ROBOT - 3D ROOM SCANNER")
    print("  Captures images for photorealistic 3D reconstruction")
    print("=" * 60)
    print()

    # Ensure directories exist
    SCANS_DIR.mkdir(parents=True, exist_ok=True)

    while True:
        try:
            print("[SCANNER] Connecting to VPS...")
            async with websockets.connect(VPS_WS, max_size=10_000_000) as ws:
                print("[SCANNER] Connected!")

                # Register
                await ws.send(json.dumps({
                    "type": "register_processor",
                    "name": "room-scanner",
                    "capabilities": ["room_scan", "ptz_control", "3d_reconstruction"]
                }))

                # Wait for scan command or auto-start
                print("[SCANNER] Ready. Waiting for scan command...")
                print("[SCANNER] Or press Enter to start scan now...")

                # Auto-start scan after 3 seconds
                await asyncio.sleep(3)

                # Run the scan
                scan_dir = await run_scan(ws)

                if scan_dir:
                    print(f"\n[SCANNER] Scan saved to: {scan_dir}")
                    print("[SCANNER] Run 'python3 reconstruct_3d.py' to create 3D model")

                # Keep connection alive
                while True:
                    await handle_messages(ws)
                    await asyncio.sleep(0.1)

        except Exception as e:
            print(f"[SCANNER] Error: {e}")
            import traceback
            traceback.print_exc()
            print("[SCANNER] Reconnecting in 5 seconds...")
            await asyncio.sleep(5)

if __name__ == "__main__":
    asyncio.run(main())
