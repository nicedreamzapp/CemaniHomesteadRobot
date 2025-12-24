#!/usr/bin/env python3
"""
Hybrid Sensor Fusion - Camera + Lidar + Ultrasonic
Clean, readable UI with camera overlay
"""

import sys
import numpy as np
import cv2
from rplidar import RPLidar
import threading
import time
import math
import json
import websocket
from collections import deque

# Configuration
LIDAR_PORT = '/dev/ttyUSB0'
VPS_WEBSOCKET = 'wss://robot.marijuanaunion.com'

# Cameras from config
CAMERAS = {
    'front': 'rtsp://192.168.1.191:554/onvif1',
    'rear': 'rtsp://192.168.1.27:554/onvif1',
    'v380': 'rtsp://192.168.1.200:554/live/ch00_0',
}
CAMERA_URL = CAMERAS['front']  # Default to front

# Calibration - auto-detect mounted objects
CALIBRATION_SCANS = 5
MOUNT_DETECTION_THRESHOLD = 500  # Objects < 500mm are "mounted"

# Manual exclusion zones (backup if auto-detect fails)
# 7 o'clock = ~210 degrees, camera is ~10 inches (~254mm)
MANUAL_EXCLUSIONS = [
    (205, 220, 400),  # Camera at 7 o'clock
]

# Display
WINDOW_WIDTH = 1280
WINDOW_HEIGHT = 720

# Colors (BGR)
BLACK = (0, 0, 0)
WHITE = (255, 255, 255)
CYAN = (255, 255, 0)
GREEN = (0, 255, 0)
YELLOW = (0, 255, 255)
ORANGE = (0, 140, 255)
RED = (0, 0, 255)
GRAY = (100, 100, 100)
DARK = (30, 30, 30)


class HybridSensorView:
    def __init__(self):
        # Lidar
        self.lidar = None
        self.lidar_ok = False
        self.lidar_points = []
        self.lidar_lock = threading.Lock()
        self.exclusion_zones = []  # Auto-detected mounted objects
        self.calibrated = False

        # Camera
        self.camera = None
        self.camera_frame = None
        self.camera_ok = False
        self.camera_lock = threading.Lock()

        # Ultrasonic
        self.sonar = {'FL': 0, 'FR': 0, 'RL': 0, 'RR': 0}
        self.sonar_lock = threading.Lock()
        self.sonar_time = 0
        self.ws_ok = False

        # Map settings
        self.map_size = 350
        self.max_range = 6000  # mm
        self.scale = (self.map_size // 2 - 20) / self.max_range

        self.running = True

    def is_excluded(self, angle, distance):
        """Check if point is in exclusion zone"""
        for min_ang, max_ang, max_dist in self.exclusion_zones:
            if min_ang <= angle <= max_ang and distance < max_dist:
                return True
        return False

    def calibrate(self):
        """Auto-detect mounted objects (cameras, etc.)"""
        print("\n" + "="*50)
        print("  CALIBRATION - Detecting mounted objects...")
        print("="*50)

        # Clear buffer first
        try:
            self.lidar.clean_input()
        except:
            pass

        all_close = {}
        scan_count = 0

        for scan in self.lidar.iter_scans(max_buf_meas=1000, min_len=100):
            for q, angle, dist in scan:
                if q > 0 and dist < MOUNT_DETECTION_THRESHOLD:
                    ang = int(round(angle))
                    if ang not in all_close:
                        all_close[ang] = []
                    all_close[ang].append(dist)

            scan_count += 1
            print(f"  Scan {scan_count}/{CALIBRATION_SCANS}")
            if scan_count >= CALIBRATION_SCANS:
                break

        # Find consistent objects
        mounted = []
        for ang, dists in all_close.items():
            if len(dists) >= CALIBRATION_SCANS - 1:
                avg = sum(dists) / len(dists)
                mounted.append((ang, avg))
                print(f"  Found object at {ang}° ({avg:.0f}mm)")

        # Group into zones
        if mounted:
            mounted.sort()
            zones = []
            start = mounted[0][0]
            end = mounted[0][0]
            max_d = mounted[0][1]

            for ang, d in mounted[1:]:
                if ang <= end + 5:
                    end = ang
                    max_d = max(max_d, d)
                else:
                    zones.append((start - 3, end + 3, max_d + 100))
                    start = end = ang
                    max_d = d
            zones.append((start - 3, end + 3, max_d + 100))

            self.exclusion_zones = zones
            print(f"\n  Excluding {len(zones)} zone(s)")
        else:
            print("  No mounted objects auto-detected")
            print("  Using manual exclusion zones...")
            self.exclusion_zones = MANUAL_EXCLUSIONS.copy()
            for min_a, max_a, max_d in self.exclusion_zones:
                print(f"    Zone: {min_a}° to {max_a}° (within {max_d}mm)")

        print("="*50 + "\n")
        self.calibrated = True

    # ─────────────────────────────────────────────────────────────
    # LIDAR
    # ─────────────────────────────────────────────────────────────
    def lidar_thread(self):
        while self.running:
            try:
                print("Connecting LIDAR...")
                self.lidar = RPLidar(LIDAR_PORT)
                info = self.lidar.get_info()
                print(f"LIDAR OK - Model {info['model']}")
                self.lidar_ok = True
                self.lidar.start_motor()

                # Run calibration to detect mounted cameras
                if not self.calibrated:
                    time.sleep(1)
                    self.calibrate()

                for scan in self.lidar.iter_scans(max_buf_meas=1000, min_len=50):
                    if not self.running:
                        break
                    # Filter out excluded zones (mounted cameras)
                    pts = [(a, d) for q, a, d in scan
                           if q > 0 and 100 < d < self.max_range
                           and not self.is_excluded(a, d)]
                    with self.lidar_lock:
                        self.lidar_points = pts

            except Exception as e:
                print(f"LIDAR error: {e}")
                self.lidar_ok = False
            finally:
                try:
                    if self.lidar:
                        self.lidar.stop()
                        self.lidar.stop_motor()
                        self.lidar.disconnect()
                except:
                    pass

            if self.running:
                time.sleep(2)

    # ─────────────────────────────────────────────────────────────
    # CAMERA
    # ─────────────────────────────────────────────────────────────
    def camera_thread(self):
        import os
        os.environ['OPENCV_FFMPEG_CAPTURE_OPTIONS'] = 'rtsp_transport;tcp'

        while self.running:
            try:
                print(f"Connecting camera: {CAMERA_URL}")
                # Force TCP transport for RTSP
                self.camera = cv2.VideoCapture(CAMERA_URL, cv2.CAP_FFMPEG)
                self.camera.set(cv2.CAP_PROP_BUFFERSIZE, 1)

                if self.camera.isOpened():
                    print("Camera OK")
                    self.camera_ok = True

                    while self.running and self.camera.isOpened():
                        ret, frame = self.camera.read()
                        if ret:
                            with self.camera_lock:
                                self.camera_frame = frame
                        else:
                            break
                else:
                    print("Camera failed to open")
                    self.camera_ok = False

            except Exception as e:
                print(f"Camera error: {e}")
                self.camera_ok = False
            finally:
                if self.camera:
                    self.camera.release()

            if self.running:
                time.sleep(2)

    # ─────────────────────────────────────────────────────────────
    # WEBSOCKET (Ultrasonic)
    # ─────────────────────────────────────────────────────────────
    def on_ws_message(self, ws, msg):
        try:
            data = json.loads(msg)
            if data.get('type') == 'serial':
                s = data.get('data', '')
                if s.startswith('SONAR,'):
                    p = s.split(',')
                    if len(p) >= 5:
                        with self.sonar_lock:
                            self.sonar['FL'] = float(p[1]) if p[1] else 0
                            self.sonar['FR'] = float(p[2]) if p[2] else 0
                            self.sonar['RL'] = float(p[3]) if p[3] else 0
                            self.sonar['RR'] = float(p[4]) if p[4] else 0
                            self.sonar_time = time.time()
        except:
            pass

    def on_ws_open(self, ws):
        print("WebSocket OK")
        self.ws_ok = True

    def on_ws_close(self, ws, a, b):
        self.ws_ok = False

    def on_ws_error(self, ws, e):
        self.ws_ok = False

    def websocket_thread(self):
        while self.running:
            try:
                print(f"Connecting WebSocket...")
                ws = websocket.WebSocketApp(
                    VPS_WEBSOCKET,
                    on_message=self.on_ws_message,
                    on_open=self.on_ws_open,
                    on_close=self.on_ws_close,
                    on_error=self.on_ws_error
                )
                ws.run_forever(ping_interval=30)
            except Exception as e:
                print(f"WebSocket error: {e}")
            if self.running:
                time.sleep(3)

    # ─────────────────────────────────────────────────────────────
    # DRAWING
    # ─────────────────────────────────────────────────────────────
    def polar_to_xy(self, angle, dist, cx, cy):
        """Convert lidar polar to screen XY"""
        rad = math.radians(angle - 90)
        x = int(cx + dist * self.scale * math.cos(rad))
        y = int(cy + dist * self.scale * math.sin(rad))
        return x, y

    def get_proximity_color(self, cm):
        """Color by distance"""
        if cm <= 0:
            return GRAY
        elif cm < 45:
            return RED
        elif cm < 75:
            return ORANGE
        elif cm < 120:
            return YELLOW
        else:
            return GREEN

    def draw_lidar_map(self, frame, x_offset, y_offset):
        """Draw lidar as top-down map"""
        cx = x_offset + self.map_size // 2
        cy = y_offset + self.map_size // 2

        # Background circle
        cv2.circle(frame, (cx, cy), self.map_size // 2, DARK, -1)
        cv2.circle(frame, (cx, cy), self.map_size // 2, GRAY, 1)

        # Range rings
        for r in [1000, 2000, 3000, 4000, 5000]:
            radius = int(r * self.scale)
            cv2.circle(frame, (cx, cy), radius, (50, 50, 50), 1)

        # Range labels - BIG TEXT
        for r in [2, 4, 6]:
            radius = int(r * 1000 * self.scale)
            cv2.putText(frame, f"{r}m", (cx + 5, cy - radius + 20),
                       cv2.FONT_HERSHEY_SIMPLEX, 0.6, GRAY, 1)

        # Crosshairs
        cv2.line(frame, (cx, y_offset + 10), (cx, y_offset + self.map_size - 10), (40, 40, 40), 1)
        cv2.line(frame, (x_offset + 10, cy), (x_offset + self.map_size - 10, cy), (40, 40, 40), 1)

        # Draw lidar points
        with self.lidar_lock:
            points = self.lidar_points.copy()

        if points:
            points.sort(key=lambda p: p[0])
            prev = None

            for angle, dist in points:
                x, y = self.polar_to_xy(angle, dist, cx, cy)

                # Color by distance
                if dist < 1000:
                    color = RED
                elif dist < 2000:
                    color = ORANGE
                elif dist < 3000:
                    color = YELLOW
                else:
                    color = GREEN

                cv2.circle(frame, (x, y), 3, color, -1)

                # Connect close points
                if prev:
                    px, py = prev
                    if abs(x - px) < 20 and abs(y - py) < 20:
                        cv2.line(frame, (px, py), (x, y), color, 2)
                prev = (x, y)

        # Robot triangle
        pts = np.array([
            [cx, cy - 15],
            [cx + 12, cy + 12],
            [cx - 12, cy + 12]
        ], np.int32)
        cv2.fillPoly(frame, [pts], (60, 60, 60))
        cv2.polylines(frame, [pts], True, CYAN, 2)

        # Title
        cv2.putText(frame, "LIDAR 360", (x_offset + 10, y_offset + 30),
                   cv2.FONT_HERSHEY_DUPLEX, 0.9, CYAN, 2)

    def draw_sonar_panel(self, frame, x, y, w, h):
        """Draw ultrasonic sensor panel"""
        # Background
        cv2.rectangle(frame, (x, y), (x + w, y + h), DARK, -1)
        cv2.rectangle(frame, (x, y), (x + w, y + h), GRAY, 1)

        # Title
        cv2.putText(frame, "ULTRASONIC", (x + 15, y + 35),
                   cv2.FONT_HERSHEY_DUPLEX, 0.9, CYAN, 2)

        with self.sonar_lock:
            sonar = self.sonar.copy()
            age = time.time() - self.sonar_time

        stale = age > 2.0

        # Sensor layout
        sensors = [
            ('FL', x + 20, y + 70),
            ('FR', x + w//2 + 10, y + 70),
            ('RL', x + 20, y + 160),
            ('RR', x + w//2 + 10, y + 160),
        ]

        for name, sx, sy in sensors:
            dist_cm = sonar[name]
            dist_ft = dist_cm / 30.48 if dist_cm > 0 else 0
            color = GRAY if stale else self.get_proximity_color(dist_cm)

            # Sensor name
            cv2.putText(frame, name, (sx, sy),
                       cv2.FONT_HERSHEY_DUPLEX, 0.8, WHITE, 2)

            # Distance - BIG
            if dist_cm > 0:
                txt = f"{dist_ft:.1f} ft"
            else:
                txt = "---"
            cv2.putText(frame, txt, (sx, sy + 40),
                       cv2.FONT_HERSHEY_DUPLEX, 1.0, color, 2)

            # Distance bar
            bar_w = w // 2 - 40
            bar_h = 12
            bar_x = sx
            bar_y = sy + 50
            cv2.rectangle(frame, (bar_x, bar_y), (bar_x + bar_w, bar_y + bar_h), (40, 40, 40), -1)
            if dist_cm > 0:
                fill = min(dist_cm / 300, 1.0)  # 3m = full
                cv2.rectangle(frame, (bar_x, bar_y),
                             (bar_x + int(bar_w * fill), bar_y + bar_h), color, -1)

    def draw_status_bar(self, frame, y):
        """Draw status bar at bottom"""
        cv2.rectangle(frame, (0, y), (WINDOW_WIDTH, WINDOW_HEIGHT), (20, 20, 20), -1)

        # Status indicators
        statuses = [
            ("LIDAR", self.lidar_ok),
            ("CAMERA", self.camera_ok),
            ("SONAR", self.ws_ok),
            ("GPS", False),  # Placeholder
        ]

        x = 20
        for name, ok in statuses:
            color = GREEN if ok else RED
            cv2.circle(frame, (x, y + 20), 8, color, -1)
            cv2.putText(frame, name, (x + 20, y + 26),
                       cv2.FONT_HERSHEY_DUPLEX, 0.7, WHITE, 1)
            x += 150

        # Controls hint
        cv2.putText(frame, "Q=Quit  S=Screenshot  +/-=Zoom",
                   (WINDOW_WIDTH - 380, y + 26),
                   cv2.FONT_HERSHEY_SIMPLEX, 0.6, GRAY, 1)

    def draw_camera_view(self, frame, x, y, w, h):
        """Draw camera feed with lidar overlay"""
        with self.camera_lock:
            cam_frame = self.camera_frame.copy() if self.camera_frame is not None else None

        if cam_frame is not None:
            # Resize to fit
            cam_resized = cv2.resize(cam_frame, (w, h))
            frame[y:y+h, x:x+w] = cam_resized

            # Overlay lidar on camera (front arc only)
            with self.lidar_lock:
                points = self.lidar_points.copy()

            # Project front lidar points onto camera view
            cam_cx = x + w // 2
            cam_cy = y + h  # Bottom of camera view

            for angle, dist in points:
                # Only front 120 degrees
                if -60 < (angle - 360 if angle > 180 else angle) < 60:
                    # Simple projection (approximate)
                    rel_angle = angle if angle < 180 else angle - 360
                    px = int(cam_cx + (rel_angle / 60) * (w // 2))
                    # Distance affects vertical position
                    py = int(cam_cy - min(dist / 30, h * 0.8))

                    if x < px < x + w and y < py < y + h:
                        color = RED if dist < 1000 else (ORANGE if dist < 2000 else GREEN)
                        cv2.circle(frame, (px, py), 4, color, -1)
        else:
            # No camera - show placeholder
            cv2.rectangle(frame, (x, y), (x + w, y + h), DARK, -1)
            cv2.putText(frame, "CAMERA", (x + w//2 - 60, y + h//2 - 20),
                       cv2.FONT_HERSHEY_DUPLEX, 1.2, GRAY, 2)
            cv2.putText(frame, "CONNECTING...", (x + w//2 - 100, y + h//2 + 20),
                       cv2.FONT_HERSHEY_SIMPLEX, 0.8, GRAY, 1)

        # Border
        cv2.rectangle(frame, (x, y), (x + w, y + h), CYAN, 2)

        # Label
        cv2.putText(frame, "FRONT CAMERA + LIDAR OVERLAY", (x + 10, y + 30),
                   cv2.FONT_HERSHEY_DUPLEX, 0.7, CYAN, 2)

    def run(self):
        """Main loop"""
        # Start threads
        threading.Thread(target=self.lidar_thread, daemon=True).start()
        threading.Thread(target=self.camera_thread, daemon=True).start()
        threading.Thread(target=self.websocket_thread, daemon=True).start()

        print("\n=== HYBRID SENSOR VIEW ===")
        print("Press Q to quit\n")

        cv2.namedWindow('Sensor Fusion', cv2.WINDOW_NORMAL)
        cv2.resizeWindow('Sensor Fusion', WINDOW_WIDTH, WINDOW_HEIGHT)

        while self.running:
            # Create frame
            frame = np.zeros((WINDOW_HEIGHT, WINDOW_WIDTH, 3), dtype=np.uint8)

            # Layout:
            # [  CAMERA + LIDAR OVERLAY  ] [ LIDAR MAP ]
            # [                          ] [ SONAR     ]
            # [========= STATUS BAR ===================]

            status_h = 45
            right_panel_w = 380
            cam_w = WINDOW_WIDTH - right_panel_w - 10
            cam_h = WINDOW_HEIGHT - status_h - 10

            # Camera view (left side)
            self.draw_camera_view(frame, 5, 5, cam_w, cam_h)

            # Lidar map (top right)
            lidar_x = WINDOW_WIDTH - right_panel_w
            self.draw_lidar_map(frame, lidar_x, 5)

            # Sonar panel (bottom right)
            sonar_y = self.map_size + 15
            sonar_h = WINDOW_HEIGHT - sonar_y - status_h - 10
            self.draw_sonar_panel(frame, lidar_x, sonar_y, right_panel_w - 10, sonar_h)

            # Status bar
            self.draw_status_bar(frame, WINDOW_HEIGHT - status_h)

            cv2.imshow('Sensor Fusion', frame)

            key = cv2.waitKey(30) & 0xFF
            if key == ord('q') or key == 27:
                break
            elif key == ord('s'):
                fn = f"fusion_{int(time.time())}.png"
                cv2.imwrite(fn, frame)
                print(f"Saved: {fn}")
            elif key == ord('+') or key == ord('='):
                self.scale *= 1.2
            elif key == ord('-'):
                self.scale /= 1.2

        self.running = False
        cv2.destroyAllWindows()
        print("Shutdown complete")


def main():
    view = HybridSensorView()
    view.run()


if __name__ == '__main__':
    main()
