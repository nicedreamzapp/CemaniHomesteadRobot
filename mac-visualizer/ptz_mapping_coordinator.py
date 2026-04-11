#!/usr/bin/env python3
"""
PTZ MAPPING COORDINATOR
=======================
Unified controller for systematic 3D room mapping.

Coordinates:
1. PTZ camera sweeps (systematic pan/tilt patterns)
2. Robot position tracking (from VPS odometry)
3. 3D point cloud accumulation (via hybrid_3d_mapper)
4. Scan session management

Usage:
    python3.11 ptz_mapping_coordinator.py              # Start coordinator
    python3.11 ptz_mapping_coordinator.py --scan       # Start immediate scan
    python3.11 ptz_mapping_coordinator.py --quick      # Quick 360 scan only

Integrates with:
    - hybrid_3d_mapper.py (3D point cloud builder)
    - VPS server.js (PTZ control relay)
    - open3d_processor.py (mesh visualization)
"""

import asyncio
import websockets
import json
import time
import math
import os
from datetime import datetime
from pathlib import Path
from dataclasses import dataclass, field
from typing import List, Tuple, Optional, Dict

VPS_WS = "ws://YOUR_VPS_IP:3001"

# ============ SCAN PATTERNS ============

# Comprehensive room scan - captures entire FOV of both cameras
FULL_SCAN_PATTERN = {
    "name": "full_room",
    "description": "Complete room capture with overlapping coverage",
    "positions": [
        # Camera 1 (Front) - systematic grid
        # Top row
        {"cam": 1, "pan": -120, "tilt": 30},
        {"cam": 1, "pan": -80, "tilt": 30},
        {"cam": 1, "pan": -40, "tilt": 30},
        {"cam": 1, "pan": 0, "tilt": 30},
        {"cam": 1, "pan": 40, "tilt": 30},
        {"cam": 1, "pan": 80, "tilt": 30},
        {"cam": 1, "pan": 120, "tilt": 30},
        # Middle row
        {"cam": 1, "pan": -120, "tilt": 0},
        {"cam": 1, "pan": -80, "tilt": 0},
        {"cam": 1, "pan": -40, "tilt": 0},
        {"cam": 1, "pan": 0, "tilt": 0},
        {"cam": 1, "pan": 40, "tilt": 0},
        {"cam": 1, "pan": 80, "tilt": 0},
        {"cam": 1, "pan": 120, "tilt": 0},
        # Bottom row (floor/furniture)
        {"cam": 1, "pan": -120, "tilt": -25},
        {"cam": 1, "pan": -60, "tilt": -25},
        {"cam": 1, "pan": 0, "tilt": -25},
        {"cam": 1, "pan": 60, "tilt": -25},
        {"cam": 1, "pan": 120, "tilt": -25},

        # Camera 2 (Rear) - same pattern
        {"cam": 2, "pan": -120, "tilt": 30},
        {"cam": 2, "pan": -60, "tilt": 30},
        {"cam": 2, "pan": 0, "tilt": 30},
        {"cam": 2, "pan": 60, "tilt": 30},
        {"cam": 2, "pan": 120, "tilt": 30},
        {"cam": 2, "pan": -120, "tilt": 0},
        {"cam": 2, "pan": -60, "tilt": 0},
        {"cam": 2, "pan": 0, "tilt": 0},
        {"cam": 2, "pan": 60, "tilt": 0},
        {"cam": 2, "pan": 120, "tilt": 0},
        {"cam": 2, "pan": -120, "tilt": -25},
        {"cam": 2, "pan": -60, "tilt": -25},
        {"cam": 2, "pan": 0, "tilt": -25},
        {"cam": 2, "pan": 60, "tilt": -25},
        {"cam": 2, "pan": 120, "tilt": -25},
    ],
    "dwell_time": 1.5,  # Seconds at each position for depth processing
    "move_time": 0.8,   # Seconds for PTZ to settle
}

# Quick 360 scan - fast horizontal sweep only
QUICK_SCAN_PATTERN = {
    "name": "quick_360",
    "description": "Fast horizontal sweep for rapid mapping",
    "positions": [
        {"cam": 1, "pan": -150, "tilt": 0},
        {"cam": 1, "pan": -100, "tilt": 0},
        {"cam": 1, "pan": -50, "tilt": 0},
        {"cam": 1, "pan": 0, "tilt": 0},
        {"cam": 1, "pan": 50, "tilt": 0},
        {"cam": 1, "pan": 100, "tilt": 0},
        {"cam": 1, "pan": 150, "tilt": 0},
        {"cam": 2, "pan": -150, "tilt": 0},
        {"cam": 2, "pan": -100, "tilt": 0},
        {"cam": 2, "pan": -50, "tilt": 0},
        {"cam": 2, "pan": 0, "tilt": 0},
        {"cam": 2, "pan": 50, "tilt": 0},
        {"cam": 2, "pan": 100, "tilt": 0},
        {"cam": 2, "pan": 150, "tilt": 0},
    ],
    "dwell_time": 0.8,
    "move_time": 0.5,
}

# Focus scan - detailed capture of front area
FOCUS_SCAN_PATTERN = {
    "name": "focus_front",
    "description": "Detailed front area for close objects",
    "positions": [
        {"cam": 1, "pan": -30, "tilt": 20},
        {"cam": 1, "pan": 0, "tilt": 20},
        {"cam": 1, "pan": 30, "tilt": 20},
        {"cam": 1, "pan": -30, "tilt": 0},
        {"cam": 1, "pan": 0, "tilt": 0},
        {"cam": 1, "pan": 30, "tilt": 0},
        {"cam": 1, "pan": -30, "tilt": -20},
        {"cam": 1, "pan": 0, "tilt": -20},
        {"cam": 1, "pan": 30, "tilt": -20},
    ],
    "dwell_time": 2.0,
    "move_time": 0.6,
}


@dataclass
class ScanSession:
    """Tracks a scanning session"""
    session_id: str
    pattern_name: str
    start_time: float
    positions_total: int
    positions_completed: int = 0
    points_captured: int = 0
    robot_x: float = 0
    robot_y: float = 0
    robot_heading: float = 0
    status: str = "starting"

    def to_dict(self) -> dict:
        return {
            "session_id": self.session_id,
            "pattern": self.pattern_name,
            "progress": f"{self.positions_completed}/{self.positions_total}",
            "percent": int(100 * self.positions_completed / max(1, self.positions_total)),
            "points": self.points_captured,
            "elapsed": f"{time.time() - self.start_time:.1f}s",
            "status": self.status,
            "robot_pose": {"x": self.robot_x, "y": self.robot_y, "heading": self.robot_heading}
        }


class PTZMappingCoordinator:
    """
    Coordinates PTZ cameras with 3D mapping.

    Workflow:
    1. Connect to VPS WebSocket
    2. Listen for scan commands or start automatically
    3. Execute scan pattern (move PTZ, wait for capture)
    4. Track progress and broadcast status
    5. Return cameras to home when done
    """

    def __init__(self):
        self.ws = None
        self.connected = False
        self.running = True

        # Current state
        self.current_session: Optional[ScanSession] = None
        self.scanning = False
        self.paused = False

        # Robot pose tracking
        self.robot_x = 0
        self.robot_y = 0
        self.robot_heading = 0

        # PTZ state tracking
        self.ptz_state = {
            1: {"pan": 0, "tilt": 0, "moving": False},
            2: {"pan": 0, "tilt": 0, "moving": False}
        }

        # 3D map stats from hybrid_3d_mapper
        self.map_points = 0
        self.last_map_update = 0

    async def connect(self):
        """Connect to VPS WebSocket"""
        print(f"[COORD] Connecting to {VPS_WS}...")
        self.ws = await websockets.connect(
            VPS_WS,
            max_size=10_000_000,
            ping_interval=30,
            ping_timeout=60
        )

        # Register as processor
        await self.ws.send(json.dumps({
            "type": "register_processor",
            "name": "ptz-mapping-coordinator",
            "capabilities": ["ptz_control", "scan_coordination", "mapping"]
        }))

        self.connected = True
        print("[COORD] Connected!")

    async def send_ptz(self, camera: int, pan: float, tilt: float):
        """Send PTZ absolute position command"""
        if not self.connected:
            return

        await self.ws.send(json.dumps({
            "type": "ptz",
            "camera": camera,
            "action": "absolute",
            "pan": pan,
            "tilt": tilt
        }))

        self.ptz_state[camera]["pan"] = pan
        self.ptz_state[camera]["tilt"] = tilt
        self.ptz_state[camera]["moving"] = True

    async def send_ptz_home(self, camera: int):
        """Return PTZ to home position"""
        await self.send_ptz(camera, 0, 0)

    async def broadcast_status(self):
        """Broadcast scan status to all clients"""
        if not self.connected or not self.current_session:
            return

        await self.ws.send(json.dumps({
            "type": "scan_status",
            **self.current_session.to_dict()
        }))

    async def execute_scan(self, pattern: dict):
        """Execute a scan pattern"""
        pattern_name = pattern["name"]
        positions = pattern["positions"]
        dwell_time = pattern["dwell_time"]
        move_time = pattern["move_time"]

        # Create session
        session_id = datetime.now().strftime("%Y%m%d_%H%M%S")
        self.current_session = ScanSession(
            session_id=session_id,
            pattern_name=pattern_name,
            start_time=time.time(),
            positions_total=len(positions),
            robot_x=self.robot_x,
            robot_y=self.robot_y,
            robot_heading=self.robot_heading
        )

        self.scanning = True
        print(f"\n{'='*60}")
        print(f"  SCAN SESSION: {session_id}")
        print(f"  Pattern: {pattern_name} ({len(positions)} positions)")
        print(f"  Dwell: {dwell_time}s, Move: {move_time}s")
        print(f"  Estimated time: {len(positions) * (dwell_time + move_time):.0f}s")
        print(f"{'='*60}\n")

        self.current_session.status = "scanning"
        await self.broadcast_status()

        try:
            for i, pos in enumerate(positions):
                if not self.running or not self.scanning:
                    print("[COORD] Scan interrupted")
                    break

                # Wait if paused
                while self.paused and self.running:
                    await asyncio.sleep(0.1)

                cam = pos["cam"]
                pan = pos["pan"]
                tilt = pos["tilt"]

                # Move PTZ
                print(f"[SCAN] Position {i+1}/{len(positions)}: Cam{cam} pan={pan:+4d} tilt={tilt:+3d}")
                await self.send_ptz(cam, pan, tilt)

                # Wait for camera to settle
                await asyncio.sleep(move_time)

                # Dwell for depth processing
                # During this time, hybrid_3d_mapper.py will capture and process frames
                await asyncio.sleep(dwell_time)

                # Update session
                self.current_session.positions_completed = i + 1
                self.current_session.points_captured = self.map_points
                await self.broadcast_status()

            # Scan complete
            self.current_session.status = "complete"
            await self.broadcast_status()

            elapsed = time.time() - self.current_session.start_time
            print(f"\n{'='*60}")
            print(f"  SCAN COMPLETE!")
            print(f"  Positions: {self.current_session.positions_completed}/{len(positions)}")
            print(f"  Points captured: {self.map_points:,}")
            print(f"  Time: {elapsed:.1f}s")
            print(f"{'='*60}\n")

        except Exception as e:
            print(f"[COORD] Scan error: {e}")
            self.current_session.status = f"error: {e}"
            await self.broadcast_status()

        finally:
            self.scanning = False
            # Return cameras to home
            print("[COORD] Returning cameras to home position...")
            await self.send_ptz_home(1)
            await self.send_ptz_home(2)

    async def handle_message(self, message: str):
        """Handle incoming WebSocket messages"""
        try:
            data = json.loads(message)
            msg_type = data.get("type", "")

            # Track robot position
            if msg_type == "dead_reckoning":
                self.robot_x = data.get("odomX", 0)
                self.robot_y = data.get("odomY", 0)
                self.robot_heading = data.get("odomHeadingDeg", 0)
                if self.current_session:
                    self.current_session.robot_x = self.robot_x
                    self.current_session.robot_y = self.robot_y
                    self.current_session.robot_heading = self.robot_heading

            # Track 3D map updates from hybrid_3d_mapper
            if msg_type == "accumulated_map":
                points = data.get("points", [])
                self.map_points = len(points)
                self.last_map_update = time.time()

            # Scan control commands
            if msg_type == "start_scan":
                pattern_name = data.get("pattern", "quick_360")
                pattern = {
                    "full_room": FULL_SCAN_PATTERN,
                    "quick_360": QUICK_SCAN_PATTERN,
                    "focus_front": FOCUS_SCAN_PATTERN
                }.get(pattern_name, QUICK_SCAN_PATTERN)

                if not self.scanning:
                    asyncio.create_task(self.execute_scan(pattern))
                else:
                    print("[COORD] Scan already in progress")

            if msg_type == "stop_scan":
                if self.scanning:
                    self.scanning = False
                    print("[COORD] Stopping scan...")

            if msg_type == "pause_scan":
                self.paused = not self.paused
                print(f"[COORD] Scan {'paused' if self.paused else 'resumed'}")

            # PTZ status feedback
            if msg_type == "ptz_status":
                cam = data.get("camera", 1)
                self.ptz_state[cam]["pan"] = data.get("pan", 0)
                self.ptz_state[cam]["tilt"] = data.get("tilt", 0)
                self.ptz_state[cam]["moving"] = False

        except json.JSONDecodeError:
            pass
        except Exception as e:
            print(f"[COORD] Message error: {e}")

    async def message_loop(self):
        """Main message receiving loop"""
        try:
            async for message in self.ws:
                if isinstance(message, bytes):
                    continue  # Skip binary frames
                await self.handle_message(message)
        except websockets.ConnectionClosed:
            print("[COORD] Connection closed")
            self.connected = False

    async def run(self, auto_scan: bool = False, pattern: str = "quick_360"):
        """Main coordinator loop"""
        print("=" * 60)
        print("  PTZ MAPPING COORDINATOR")
        print("  Systematic Room Scanning + 3D Mapping")
        print("=" * 60)
        print()

        while self.running:
            try:
                await self.connect()

                # Start message handler
                message_task = asyncio.create_task(self.message_loop())

                # Start auto-scan if requested
                if auto_scan:
                    pattern_obj = {
                        "full_room": FULL_SCAN_PATTERN,
                        "quick_360": QUICK_SCAN_PATTERN,
                        "focus_front": FOCUS_SCAN_PATTERN
                    }.get(pattern, QUICK_SCAN_PATTERN)

                    await asyncio.sleep(2)  # Wait for connection to stabilize
                    await self.execute_scan(pattern_obj)
                    auto_scan = False  # Only auto-scan once

                # Wait for message loop to complete (disconnection)
                await message_task

            except Exception as e:
                print(f"[COORD] Error: {e}")
                self.connected = False

            if self.running:
                print("[COORD] Reconnecting in 3 seconds...")
                await asyncio.sleep(3)

        print("[COORD] Shutdown complete")


async def main():
    import argparse

    parser = argparse.ArgumentParser(description="PTZ Mapping Coordinator")
    parser.add_argument("--scan", "-s", action="store_true",
                        help="Start scanning immediately")
    parser.add_argument("--quick", "-q", action="store_true",
                        help="Quick 360 scan only")
    parser.add_argument("--full", "-f", action="store_true",
                        help="Full room scan")
    parser.add_argument("--focus", action="store_true",
                        help="Focus front scan")
    args = parser.parse_args()

    coordinator = PTZMappingCoordinator()

    pattern = "quick_360"
    if args.full:
        pattern = "full_room"
    elif args.focus:
        pattern = "focus_front"

    auto_scan = args.scan or args.quick or args.full or args.focus

    try:
        await coordinator.run(auto_scan=auto_scan, pattern=pattern)
    except KeyboardInterrupt:
        print("\n[COORD] Interrupted")
        coordinator.running = False


if __name__ == "__main__":
    asyncio.run(main())
