#!/usr/bin/env python3
"""
Camera Calibration Tool
=======================
Captures images from PTZ cameras and performs checkerboard calibration.

Usage:
    1. Print a checkerboard pattern (9x6 internal corners recommended)
    2. Run this script: python3 calibrate_cameras.py
    3. Hold the checkerboard in front of camera 1 at various angles
    4. Press 'c' to capture, 'n' to switch cameras, 'q' to calibrate & quit

The script will output calibration values you can paste into camera_calibration.py
"""

import cv2
import numpy as np
import asyncio
import websockets
import json
import base64
from io import BytesIO
from PIL import Image
import time
import os

# Configuration
VPS_WS = "wss://robot.marijuanaunion.com"
PATTERN_SIZE = (9, 6)  # Internal corners (cols, rows)
SQUARE_SIZE = 0.025    # 2.5cm squares - adjust to your checkerboard
MIN_IMAGES = 5         # Minimum images needed for calibration

class CalibrationTool:
    def __init__(self):
        self.current_camera = 1
        self.frames = {1: None, 2: None}
        self.captures = {1: [], 2: []}  # Captured images per camera
        self.corners_found = {1: [], 2: []}  # Detected corners
        self.running = True

    async def connect_vps(self):
        """Connect to VPS and receive camera frames"""
        print(f"[VPS] Connecting to {VPS_WS}...")

        async with websockets.connect(VPS_WS) as ws:
            # Register as processor
            await ws.send(json.dumps({
                "type": "register",
                "role": "processor"
            }))
            print("[VPS] Connected and registered as processor")

            while self.running:
                try:
                    msg = await asyncio.wait_for(ws.recv(), timeout=1.0)
                    data = json.loads(msg)

                    if data.get("type") == "camera_frame":
                        cam_id = data.get("camera", 1)
                        frame_b64 = data.get("frame", "")

                        if frame_b64:
                            # Decode frame
                            img_data = base64.b64decode(frame_b64)
                            img = Image.open(BytesIO(img_data))
                            frame = cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)
                            self.frames[cam_id] = frame

                except asyncio.TimeoutError:
                    continue
                except Exception as e:
                    print(f"[ERROR] {e}")

    def process_frame(self, frame, cam_id):
        """Process frame and detect checkerboard"""
        if frame is None:
            return None, False

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

        # Find checkerboard corners
        flags = cv2.CALIB_CB_ADAPTIVE_THRESH + cv2.CALIB_CB_NORMALIZE_IMAGE
        ret, corners = cv2.findChessboardCorners(gray, PATTERN_SIZE, flags)

        display = frame.copy()

        if ret:
            # Refine corners
            criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.001)
            corners = cv2.cornerSubPix(gray, corners, (11, 11), (-1, -1), criteria)

            # Draw corners
            cv2.drawChessboardCorners(display, PATTERN_SIZE, corners, ret)

            # Add status text
            cv2.putText(display, "CHECKERBOARD FOUND - Press 'c' to capture",
                       (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)
        else:
            cv2.putText(display, "Looking for checkerboard...",
                       (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 0, 255), 2)

        # Show capture count
        count = len(self.captures[cam_id])
        cv2.putText(display, f"Camera {cam_id} | Captures: {count}/{MIN_IMAGES}",
                   (10, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)

        # Instructions
        cv2.putText(display, "c=capture  n=next camera  q=calibrate & quit",
                   (10, display.shape[0] - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (200, 200, 200), 1)

        return display, ret

    def capture_image(self, cam_id):
        """Capture current frame for calibration"""
        frame = self.frames.get(cam_id)
        if frame is None:
            print(f"[CAM{cam_id}] No frame available")
            return False

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        ret, corners = cv2.findChessboardCorners(gray, PATTERN_SIZE)

        if ret:
            criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.001)
            corners = cv2.cornerSubPix(gray, corners, (11, 11), (-1, -1), criteria)

            self.captures[cam_id].append(gray)
            self.corners_found[cam_id].append(corners)

            count = len(self.captures[cam_id])
            print(f"[CAM{cam_id}] Captured image {count}")

            # Save capture for debugging
            os.makedirs("calibration_images", exist_ok=True)
            cv2.imwrite(f"calibration_images/cam{cam_id}_{count:02d}.jpg", frame)
            return True
        else:
            print(f"[CAM{cam_id}] No checkerboard detected!")
            return False

    def calibrate(self, cam_id):
        """Run calibration for a camera"""
        if len(self.captures[cam_id]) < 3:
            print(f"[CAM{cam_id}] Need at least 3 images (have {len(self.captures[cam_id])})")
            return None, None, None

        print(f"\n[CAM{cam_id}] Running calibration with {len(self.captures[cam_id])} images...")

        # Prepare object points
        objp = np.zeros((PATTERN_SIZE[0] * PATTERN_SIZE[1], 3), np.float32)
        objp[:, :2] = np.mgrid[0:PATTERN_SIZE[0], 0:PATTERN_SIZE[1]].T.reshape(-1, 2)
        objp *= SQUARE_SIZE

        obj_points = [objp] * len(self.captures[cam_id])
        img_points = self.corners_found[cam_id]

        # Get image size
        h, w = self.captures[cam_id][0].shape

        # Calibrate
        ret, K, dist, rvecs, tvecs = cv2.calibrateCamera(
            obj_points, img_points, (w, h), None, None
        )

        # Calculate FOV from focal length
        fx = K[0, 0]
        fy = K[1, 1]
        hfov = 2 * np.degrees(np.arctan(w / (2 * fx)))
        vfov = 2 * np.degrees(np.arctan(h / (2 * fy)))

        print(f"\n{'='*60}")
        print(f"  CAMERA {cam_id} CALIBRATION RESULTS")
        print(f"{'='*60}")
        print(f"  Reprojection Error: {ret:.4f} pixels (< 0.5 is good)")
        print(f"")
        print(f"  FOV: {hfov:.1f}° x {vfov:.1f}°")
        print(f"  fx = {fx:.2f}, fy = {fy:.2f}")
        print(f"  cx = {K[0,2]:.2f}, cy = {K[1,2]:.2f}")
        print(f"")
        print(f"  Distortion coefficients:")
        print(f"    k1 = {dist[0,0]:.6f}")
        print(f"    k2 = {dist[0,1]:.6f}")
        print(f"    p1 = {dist[0,2]:.6f}")
        print(f"    p2 = {dist[0,3]:.6f}")
        print(f"    k3 = {dist[0,4]:.6f}")
        print(f"")
        print(f"  Paste this into camera_calibration.py:")
        print(f"")
        print(f"# Camera {cam_id} - Calibrated")
        print(f"CAM{cam_id}_HFOV_DEG = {hfov:.1f}")
        print(f"CAM{cam_id}_VFOV_DEG = {vfov:.1f}")
        print(f"CAM{cam_id}_FX = {fx:.2f}")
        print(f"CAM{cam_id}_FY = {fy:.2f}")
        print(f"CAM{cam_id}_CX = {K[0,2]:.2f}")
        print(f"CAM{cam_id}_CY = {K[1,2]:.2f}")
        print(f"CAM{cam_id}_DIST = np.array([{dist[0,0]:.6f}, {dist[0,1]:.6f}, {dist[0,2]:.6f}, {dist[0,3]:.6f}, {dist[0,4]:.6f}])")
        print(f"{'='*60}")

        return K, dist, ret

    async def run(self):
        """Main loop"""
        print("\n" + "="*60)
        print("  CAMERA CALIBRATION TOOL")
        print("="*60)
        print(f"  Checkerboard pattern: {PATTERN_SIZE[0]}x{PATTERN_SIZE[1]} internal corners")
        print(f"  Square size: {SQUARE_SIZE*100:.1f}cm")
        print("")
        print("  Instructions:")
        print("  1. Print a checkerboard pattern")
        print("  2. Hold it in front of camera at various angles")
        print("  3. Press 'c' when green overlay appears to capture")
        print("  4. Capture at least 5 images per camera")
        print("  5. Press 'n' to switch cameras")
        print("  6. Press 'q' to calibrate and quit")
        print("="*60 + "\n")

        # Start VPS connection in background
        vps_task = asyncio.create_task(self.connect_vps())

        # Wait for first frame
        print("[WAIT] Waiting for camera frames from VPS...")
        for _ in range(30):  # 30 second timeout
            if self.frames[1] is not None or self.frames[2] is not None:
                break
            await asyncio.sleep(1)

        if self.frames[1] is None and self.frames[2] is None:
            print("[ERROR] No camera frames received. Is the robot online?")
            self.running = False
            return

        print("[OK] Receiving camera frames")

        cv2.namedWindow("Calibration", cv2.WINDOW_NORMAL)
        cv2.resizeWindow("Calibration", 800, 600)

        try:
            while self.running:
                frame = self.frames.get(self.current_camera)

                if frame is not None:
                    display, found = self.process_frame(frame, self.current_camera)
                    if display is not None:
                        cv2.imshow("Calibration", display)

                key = cv2.waitKey(50) & 0xFF

                if key == ord('q'):
                    print("\n[DONE] Running calibration...")
                    self.running = False

                elif key == ord('c'):
                    self.capture_image(self.current_camera)

                elif key == ord('n'):
                    self.current_camera = 2 if self.current_camera == 1 else 1
                    print(f"[SWITCH] Now viewing camera {self.current_camera}")

                await asyncio.sleep(0.01)

        finally:
            cv2.destroyAllWindows()

        # Run calibration for cameras with captures
        results = {}
        for cam_id in [1, 2]:
            if len(self.captures[cam_id]) >= 3:
                K, dist, error = self.calibrate(cam_id)
                if K is not None:
                    results[cam_id] = {"K": K, "dist": dist, "error": error}

        if not results:
            print("\n[WARN] No calibration performed - need at least 3 captures per camera")
        else:
            print(f"\n[SUCCESS] Calibrated {len(results)} camera(s)")
            print("Copy the values above into camera_calibration.py to use them")

        vps_task.cancel()


async def main():
    tool = CalibrationTool()
    await tool.run()


if __name__ == "__main__":
    asyncio.run(main())
