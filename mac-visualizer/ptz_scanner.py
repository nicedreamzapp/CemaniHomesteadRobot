#!/usr/bin/env python3
"""
PTZ Auto-Scanner
Controls PTZ cameras to systematically scan the room
Captures frames at each position for room mapping
"""

import asyncio
import websockets
import json
import time

VPS_WS = "ws://72.60.124.34:3001"

# PTZ scan patterns - positions to visit
# Each position is (pan, tilt) where:
# - pan: horizontal angle (-180 to 180)
# - tilt: vertical angle (-90 to 90)

SCAN_PATTERN_FRONT = [
    # Top row
    (0, 30),     # Center top
    (-40, 30),   # Left top
    (40, 30),    # Right top
    # Middle row
    (-60, 0),    # Far left
    (-30, 0),    # Left
    (0, 0),      # Center
    (30, 0),     # Right
    (60, 0),     # Far right
    # Bottom row
    (-40, -20),  # Left bottom
    (0, -20),    # Center bottom
    (40, -20),   # Right bottom
]

SCAN_PATTERN_REAR = [
    # Similar pattern for rear camera
    (0, 20),
    (-50, 20),
    (50, 20),
    (-70, 0),
    (0, 0),
    (70, 0),
    (-50, -15),
    (0, -15),
    (50, -15),
]

# Scan state
scan_active = False
current_camera = 1
current_position_index = 0
last_move_time = 0
MOVE_INTERVAL = 3.0  # Seconds between moves
CAPTURE_DELAY = 1.0  # Wait after moving before capturing

async def send_ptz_command(ws, camera, pan, tilt):
    """Send PTZ move command"""
    await ws.send(json.dumps({
        "type": "ptz",
        "camera": camera,
        "action": "absolute",
        "pan": pan,
        "tilt": tilt
    }))
    print(f"[PTZ] Cam {camera} -> pan={pan}, tilt={tilt}", flush=True)

async def send_capture_command(ws, camera, position):
    """Request frame capture at current position"""
    await ws.send(json.dumps({
        "type": "capture_scan_frame",
        "camera": camera,
        "position": position,
        "timestamp": int(time.time() * 1000)
    }))

async def run_scanner():
    """Main scanner loop"""
    global scan_active, current_camera, current_position_index, last_move_time
    import sys

    print("[SCANNER] Connecting to VPS...", flush=True)
    sys.stdout.flush()

    # Configure WebSocket with proper limits and ping settings
    async with websockets.connect(
        VPS_WS,
        max_size=10_000_000,  # 10MB max message size
        ping_interval=30,     # Send ping every 30s
        ping_timeout=60       # Wait 60s for pong
    ) as ws:
        print("[SCANNER] Connected!", flush=True)

        # Register as scanner
        await ws.send(json.dumps({
            "type": "register_processor",
            "name": "ptz-scanner",
            "capabilities": ["ptz_control", "room_scan"]
        }))

        scan_active = True
        current_camera = 1
        current_position_index = 0
        last_move_time = 0

        while True:
            now = time.time()

            # Check for commands from VPS
            try:
                message = await asyncio.wait_for(ws.recv(), timeout=0.1)

                # Skip binary messages (camera frames)
                if isinstance(message, bytes):
                    continue

                data = json.loads(message)

                if data.get("type") == "start_scan":
                    scan_active = True
                    current_position_index = 0
                    print("[SCANNER] Scan started!")

                if data.get("type") == "stop_scan":
                    scan_active = False
                    print("[SCANNER] Scan stopped!")

            except asyncio.TimeoutError:
                pass
            except (json.JSONDecodeError, UnicodeDecodeError):
                # Skip any unparseable messages
                pass

            # Execute scan if active
            if scan_active and (now - last_move_time) >= MOVE_INTERVAL:
                pattern = SCAN_PATTERN_FRONT if current_camera == 1 else SCAN_PATTERN_REAR

                if current_position_index < len(pattern):
                    pan, tilt = pattern[current_position_index]

                    # Move camera
                    await send_ptz_command(ws, current_camera, pan, tilt)

                    # Wait for camera to settle, then capture
                    await asyncio.sleep(CAPTURE_DELAY)
                    await send_capture_command(ws, current_camera, {
                        "pan": pan,
                        "tilt": tilt,
                        "index": current_position_index
                    })

                    current_position_index += 1
                    last_move_time = now
                else:
                    # Switch to other camera or restart
                    if current_camera == 1:
                        current_camera = 2
                        current_position_index = 0
                        print("[SCANNER] Switching to rear camera")
                    else:
                        # Full scan complete, restart
                        current_camera = 1
                        current_position_index = 0
                        print("[SCANNER] Full scan complete, restarting...")
                        await asyncio.sleep(5)  # Pause between full scans

            await asyncio.sleep(0.1)

async def main():
    print("=" * 50)
    print("  PTZ AUTO-SCANNER")
    print("  Systematic Room Mapping")
    print("=" * 50)

    while True:
        try:
            await run_scanner()
        except Exception as e:
            print(f"[SCANNER] Error: {e}")
            print("[SCANNER] Reconnecting in 3 seconds...")
            await asyncio.sleep(3)

if __name__ == "__main__":
    asyncio.run(main())
