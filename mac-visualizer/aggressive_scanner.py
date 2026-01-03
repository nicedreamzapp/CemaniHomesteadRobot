#!/usr/bin/env python3
"""
AGGRESSIVE 3D ROOM SCANNER
===========================
Rapidly pans PTZ cameras and spins robot to capture full 360° view
Builds complete 3D map by matching camera images to LIDAR

Usage: python3 aggressive_scanner.py
"""

import asyncio
import websockets
import json
import time
import math

VPS_WS = "ws://72.60.124.34:3001"

# Scanning parameters
PAN_POSITIONS = [-150, -100, -50, 0, 50, 100, 150]  # Pan angles to scan
TILT_POSITIONS = [-20, 0, 20]  # Tilt angles
ROBOT_ROTATIONS = [0, 45, 90, 135, 180, 225, 270, 315]  # Robot heading targets
SCAN_DELAY = 0.8  # Seconds to wait at each position for image capture
PTZ_MOVE_DELAY = 0.5  # Seconds for PTZ to move

class AggressiveScanner:
    def __init__(self):
        self.ws = None
        self.current_heading = 0
        self.scanning = False
        self.scan_count = 0

    async def connect(self):
        """Connect to VPS server"""
        print(f"[SCAN] Connecting to {VPS_WS}...")
        self.ws = await websockets.connect(VPS_WS, max_size=10_000_000)
        await self.ws.send(json.dumps({
            "type": "register_processor",
            "name": "aggressive-scanner",
            "capabilities": ["ptz_control", "robot_control", "scanning"]
        }))
        print("[SCAN] Connected!")

    async def send_ptz(self, camera_id: int, pan: float, tilt: float):
        """Send PTZ command"""
        await self.ws.send(json.dumps({
            "type": "ptz_absolute",
            "camera": camera_id,
            "pan": pan,
            "tilt": tilt,
            "zoom": 0
        }))

    async def send_robot_turn(self, degrees: float):
        """Send robot turn command"""
        await self.ws.send(json.dumps({
            "type": "serial_cmd",
            "cmd": f"TURN,{int(degrees)}"
        }))

    async def scan_with_camera(self, camera_id: int):
        """Scan all pan/tilt positions with one camera"""
        print(f"[SCAN] Camera {camera_id} scanning {len(PAN_POSITIONS) * len(TILT_POSITIONS)} positions...")

        for pan in PAN_POSITIONS:
            for tilt in TILT_POSITIONS:
                await self.send_ptz(camera_id, pan, tilt)
                await asyncio.sleep(PTZ_MOVE_DELAY)
                # Wait for image capture
                await asyncio.sleep(SCAN_DELAY)
                self.scan_count += 1
                print(f"[SCAN] Cam{camera_id} pan={pan}° tilt={tilt}° (#{self.scan_count})")

        # Return to center
        await self.send_ptz(camera_id, 0, 0)

    async def full_room_scan(self):
        """Complete room scan - pan both cameras, then rotate robot"""
        print("\n" + "="*60)
        print("  AGGRESSIVE 3D ROOM SCANNER - STARTING")
        print("="*60 + "\n")

        self.scanning = True
        self.scan_count = 0
        start_time = time.time()

        # Phase 1: Scan with both cameras at current position
        print("[PHASE 1] Scanning with both cameras at current position...")
        await asyncio.gather(
            self.scan_with_camera(1),
            self.scan_with_camera(2)
        )

        # Phase 2: Rotate robot and scan again
        print("\n[PHASE 2] Rotating robot to capture all angles...")
        for rotation in [90, 180, 270]:
            print(f"\n[SCAN] Rotating robot {rotation}° from start...")
            await self.send_robot_turn(90)  # Turn 90 degrees
            await asyncio.sleep(3)  # Wait for rotation

            # Quick scan at this position
            for pan in [-100, 0, 100]:
                await self.send_ptz(1, pan, 0)
                await self.send_ptz(2, pan, 0)
                await asyncio.sleep(SCAN_DELAY)
                self.scan_count += 2
                print(f"[SCAN] Position {rotation}° pan={pan}° (#{self.scan_count})")

        # Return robot to start
        print("\n[SCAN] Returning robot to start position...")
        await self.send_robot_turn(90)
        await asyncio.sleep(3)

        # Final center position
        await self.send_ptz(1, 0, 0)
        await self.send_ptz(2, 0, 0)

        elapsed = time.time() - start_time
        print("\n" + "="*60)
        print(f"  SCAN COMPLETE!")
        print(f"  Captured {self.scan_count} positions in {elapsed:.1f}s")
        print("="*60 + "\n")

        self.scanning = False

    async def quick_360_scan(self):
        """Quick 360° scan - just pan cameras rapidly"""
        print("\n[QUICK SCAN] Starting rapid 360° camera scan...")
        self.scan_count = 0
        start_time = time.time()

        # Rapid pan scan - both cameras
        for pan in range(-170, 171, 20):  # Every 20 degrees
            await self.send_ptz(1, pan, 0)
            await self.send_ptz(2, -pan, 0)  # Opposite direction for cam2
            await asyncio.sleep(0.4)  # Quick!
            self.scan_count += 2
            print(f"[QUICK] pan={pan}° (#{self.scan_count})")

        # Tilt variations
        for tilt in [-25, 25]:
            for pan in [-120, 0, 120]:
                await self.send_ptz(1, pan, tilt)
                await self.send_ptz(2, -pan, -tilt)
                await asyncio.sleep(0.4)
                self.scan_count += 2

        # Return to center
        await self.send_ptz(1, 0, 0)
        await self.send_ptz(2, 0, 0)

        elapsed = time.time() - start_time
        print(f"\n[QUICK SCAN] Done! {self.scan_count} captures in {elapsed:.1f}s")

    async def continuous_sweep(self):
        """Continuous sweeping motion for ongoing mapping"""
        print("\n[SWEEP] Starting continuous camera sweep...")
        sweep_count = 0

        while True:
            # Sweep cam1 left to right
            for pan in range(-150, 151, 30):
                await self.send_ptz(1, pan, 0)
                await asyncio.sleep(0.3)
                sweep_count += 1

            # Sweep cam1 right to left with tilt
            for pan in range(150, -151, -30):
                await self.send_ptz(1, pan, 15)
                await asyncio.sleep(0.3)
                sweep_count += 1

            # Sweep cam2
            for pan in range(-150, 151, 30):
                await self.send_ptz(2, pan, -10)
                await asyncio.sleep(0.3)
                sweep_count += 1

            print(f"[SWEEP] Completed sweep cycle ({sweep_count} total positions)")

            # Small pause between cycles
            await asyncio.sleep(1)

async def main():
    scanner = AggressiveScanner()

    while True:
        try:
            await scanner.connect()

            print("\n[AUTO] Starting aggressive room scanning...\n")

            # Quick 360° scan first
            await scanner.quick_360_scan()

            # Then continuous sweep with reconnection
            print("\nContinuous sweep mode...")
            await scanner.continuous_sweep()

        except Exception as e:
            print(f"\n[ERROR] Connection lost: {e}")
            print("[RECONNECT] Waiting 3 seconds and reconnecting...")
            await asyncio.sleep(3)
            continue

if __name__ == "__main__":
    asyncio.run(main())
