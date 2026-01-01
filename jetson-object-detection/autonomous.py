#!/usr/bin/env python3
"""
Autonomous Mapping Navigation - Jetson
FULL SENSOR FUSION: LIDAR + Cameras + GPS + Compass + Ultrasonics
Uses all available data to navigate safely and build maps
"""

import json
import time
import math
import threading
from collections import deque
import websocket

# VPS WebSocket
VPS_WS = "ws://72.60.124.34:3001"

# Navigation parameters - 16 inches = 40cm stop distance
SAFE_DISTANCE_CM = 60      # Start slowing down (~24 inches)
STOP_DISTANCE_CM = 40      # Hard stop (~16 inches)
CRITICAL_DISTANCE_CM = 30  # Emergency backup (~12 inches)
TURN_THRESHOLD_CM = 80     # Need this much space to go forward
SCAN_SECTORS = 12          # Divide 360° into sectors
SPEED_SLOW = 3             # Slow speed
SPEED_NORMAL = 5           # Normal mapping speed

# ========== SENSOR STATE ==========
class SensorState:
    def __init__(self):
        self.lidar_sectors = {}
        self.lidar_updated = 0
        self.us_fl = 999
        self.us_fr = 999
        self.us_rl = 999
        self.us_rr = 999
        self.us_updated = 0
        self.heading = 0
        self.heading_updated = 0
        self.gps_lat = 0
        self.gps_lon = 0
        self.gps_valid = False
        self.gps_updated = 0
        self.cam1_detections = []
        self.cam2_detections = []
        self.detection_updated = 0
        self.torque_left = 0
        self.torque_right = 0
        self.collision_detected = False
        self.last_direction = "STOP"
        self.stuck_count = 0
        self.position_history = deque(maxlen=20)

sensors = SensorState()

# ========== AUTONOMOUS NAVIGATOR ==========
class AutonomousNavigator:
    def __init__(self):
        self.ws = None
        self.ws_app = None
        self.running = True
        self.connected = False
        self.paused = True  # Start paused until START command
        self.ws_lock = threading.Lock()
        self.nav_thread = None

    def on_open(self, ws):
        """Called when WebSocket connects"""
        print("[WS] Connected to VPS")
        self.connected = True

        # Send registration - THIS IS THE KEY FIX
        reg_msg = {
            "type": "JETSON_REGISTER",
            "device": "autonomous",
            "capabilities": ["navigation", "mapping", "sensor_fusion"]
        }
        ws.send(json.dumps(reg_msg))
        print("[WS] Sent JETSON_REGISTER")
        print("[NAV] Waiting for START command from UI...")

    def on_close(self, ws, close_code, close_msg):
        print(f"[WS] Disconnected: {close_code}")
        self.connected = False

    def on_error(self, ws, error):
        print(f"[WS] Error: {error}")
        self.connected = False

    def on_message(self, ws, message):
        """Handle incoming messages from VPS"""
        try:
            if isinstance(message, bytes):
                message = message.decode('utf-8')

            data = json.loads(message)
            msg_type = data.get("type", "")

            # Control commands from UI
            if msg_type == "AUTONOMOUS_CONTROL":
                cmd = data.get("cmd", "")
                if cmd == "START":
                    self.paused = False
                    print("[NAV] *** AUTONOMOUS MAPPING STARTED ***")
                elif cmd == "PAUSE":
                    self.paused = True
                    self.send_command("STOP")
                    print("[NAV] Paused")
                elif cmd == "STOP":
                    self.running = False
                    self.paused = True
                    self.send_command("STOP")
                    print("[NAV] Stopped")

            # LIDAR data
            elif msg_type == "lidar":
                points = data.get("points", [])
                if points:
                    self.process_lidar(points)

            # Ultrasonic data
            elif msg_type == "ultrasonic":
                sensors.us_fl = data.get("fl", 999)
                sensors.us_fr = data.get("fr", 999)
                sensors.us_rl = data.get("rl", 999)
                sensors.us_rr = data.get("rr", 999)
                sensors.us_updated = time.time()

            # Compass data
            elif msg_type == "compass":
                sensors.heading = data.get("heading", 0)
                sensors.heading_updated = time.time()

            # GPS data
            elif msg_type == "gps":
                sensors.gps_lat = data.get("lat", 0)
                sensors.gps_lon = data.get("lon", 0)
                sensors.gps_valid = data.get("valid", False)
                sensors.gps_updated = time.time()

            # Telemetry (torque for collision detection)
            elif msg_type == "teensy_telemetry":
                torque_l = abs(data.get("torqueL", 0))
                torque_r = abs(data.get("torqueR", 0))
                if max(torque_l, torque_r) > 12.0:
                    sensors.collision_detected = True
                    print(f"[COLLISION] Torque spike: L={torque_l:.1f} R={torque_r:.1f}")

            # Camera detections
            elif msg_type == "detections":
                cam = data.get("camera", 1)
                dets = data.get("detections", [])
                if cam == 1:
                    sensors.cam1_detections = dets
                else:
                    sensors.cam2_detections = dets
                sensors.detection_updated = time.time()

        except Exception as e:
            pass  # Ignore parse errors

    def process_lidar(self, points):
        """Convert LIDAR points to sector distances"""
        sectors = {}
        sector_size = 360 / SCAN_SECTORS

        for p in points:
            angle = p[0] if isinstance(p, list) else p.get("angle", 0)
            dist = p[1] if isinstance(p, list) else p.get("distance", 0)

            if dist < 10:  # Invalid
                continue

            sector = int(angle / sector_size) % SCAN_SECTORS
            dist_cm = dist / 10  # mm to cm

            if sector not in sectors or dist_cm < sectors[sector]:
                sectors[sector] = dist_cm

        sensors.lidar_sectors = sectors
        sensors.lidar_updated = time.time()

    def get_front_distance(self):
        """Get minimum front distance from LIDAR + ultrasonics"""
        distances = []

        # LIDAR front sectors (0, 11, 1)
        for sector in [0, 11, 1]:
            if sector in sensors.lidar_sectors:
                distances.append(sensors.lidar_sectors[sector])

        # Ultrasonics
        if sensors.us_fl > 0 and sensors.us_fl < 500:
            distances.append(sensors.us_fl)
        if sensors.us_fr > 0 and sensors.us_fr < 500:
            distances.append(sensors.us_fr)

        return min(distances) if distances else 999

    def get_rear_distance(self):
        """Get minimum rear distance"""
        distances = []
        for sector in [5, 6, 7]:
            if sector in sensors.lidar_sectors:
                distances.append(sensors.lidar_sectors[sector])
        if sensors.us_rl > 0 and sensors.us_rl < 500:
            distances.append(sensors.us_rl)
        if sensors.us_rr > 0 and sensors.us_rr < 500:
            distances.append(sensors.us_rr)
        return min(distances) if distances else 999

    def get_left_distance(self):
        distances = []
        for sector in [2, 3]:
            if sector in sensors.lidar_sectors:
                distances.append(sensors.lidar_sectors[sector])
        return min(distances) if distances else 999

    def get_right_distance(self):
        distances = []
        for sector in [9, 10]:
            if sector in sensors.lidar_sectors:
                distances.append(sensors.lidar_sectors[sector])
        return min(distances) if distances else 999

    def send_command(self, cmd, value=0):
        """Send command to robot via VPS"""
        if not self.connected or not self.ws_app:
            return
        try:
            msg = {"type": "autonomous_cmd", "cmd": cmd, "value": value}
            self.ws_app.send(json.dumps(msg))
        except:
            pass

    def stop_robot(self):
        self.send_command("STOP")
        sensors.last_direction = "STOP"

    def move_forward(self, speed=SPEED_NORMAL):
        self.send_command("FORWARD", speed)
        sensors.last_direction = "FORWARD"

    def turn_left(self, speed=SPEED_SLOW):
        self.send_command("TURN_LEFT", speed)
        sensors.last_direction = "LEFT"

    def turn_right(self, speed=SPEED_SLOW):
        self.send_command("TURN_RIGHT", speed)
        sensors.last_direction = "RIGHT"

    def reverse(self, speed=SPEED_SLOW):
        self.send_command("REVERSE", speed)
        sensors.last_direction = "REVERSE"

    def find_best_direction(self):
        """Find the safest direction to move"""
        front = self.get_front_distance()
        rear = self.get_rear_distance()
        left = self.get_left_distance()
        right = self.get_right_distance()

        # Score each direction (higher = better)
        scores = {
            "FORWARD": front * 1.5,    # Prefer forward
            "LEFT": left * 1.0,
            "RIGHT": right * 1.0,
            "REVERSE": rear * 0.5,     # Penalize reverse
        }

        best = max(scores, key=scores.get)
        best_dist = {"FORWARD": front, "LEFT": left, "RIGHT": right, "REVERSE": rear}[best]

        return best, best_dist, front, left, right, rear

    def navigate_step(self):
        """One step of autonomous navigation"""
        if self.paused:
            self.stop_robot()
            return "PAUSED"

        # Collision recovery
        if sensors.collision_detected:
            print(f"[NAV] Collision recovery - was going {sensors.last_direction}")
            self.stop_robot()
            time.sleep(0.2)

            if sensors.last_direction == "REVERSE":
                self.move_forward(SPEED_SLOW)
            else:
                self.reverse(SPEED_SLOW)
            time.sleep(0.5)
            self.stop_robot()
            sensors.collision_detected = False
            return "COLLISION_RECOVERY"

        # Get distances
        best_dir, best_dist, front, left, right, rear = self.find_best_direction()

        # Log distances periodically
        print(f"[NAV] F:{front:.0f} L:{left:.0f} R:{right:.0f} B:{rear:.0f} cm")

        # CRITICAL: Emergency stop if too close
        if front < CRITICAL_DISTANCE_CM:
            self.stop_robot()
            time.sleep(0.2)

            if rear > SAFE_DISTANCE_CM:
                self.reverse()
                time.sleep(0.4)
                return f"EMERGENCY REVERSE (front={front:.0f}cm)"
            else:
                # Trapped - spin to find exit
                if right > left:
                    self.turn_right()
                else:
                    self.turn_left()
                time.sleep(0.4)
                return "EMERGENCY SPIN"

        # Normal navigation
        if best_dir == "FORWARD":
            if front > TURN_THRESHOLD_CM:
                self.move_forward(SPEED_NORMAL)
                return f"FORWARD (clear: {front:.0f}cm)"
            elif front > SAFE_DISTANCE_CM:
                self.move_forward(SPEED_SLOW)
                return f"FORWARD_SLOW ({front:.0f}cm)"
            else:
                # Need to turn
                if right > left:
                    self.turn_right()
                    time.sleep(0.3)
                    return f"TURN_RIGHT (front blocked: {front:.0f}cm)"
                else:
                    self.turn_left()
                    time.sleep(0.3)
                    return f"TURN_LEFT (front blocked: {front:.0f}cm)"

        elif best_dir == "LEFT":
            self.turn_left()
            time.sleep(0.3)
            return f"TURN_LEFT (best: {left:.0f}cm)"

        elif best_dir == "RIGHT":
            self.turn_right()
            time.sleep(0.3)
            return f"TURN_RIGHT (best: {right:.0f}cm)"

        elif best_dir == "REVERSE":
            self.reverse()
            time.sleep(0.4)
            return f"REVERSE (only option: {rear:.0f}cm)"

        return "IDLE"

    def navigation_loop(self):
        """Main navigation loop"""
        nav_interval = 0.15  # 150ms between nav decisions
        last_nav = 0

        while self.running:
            time.sleep(0.05)

            if not self.connected:
                continue

            now = time.time()
            if not self.paused and (now - last_nav) > nav_interval:
                # Check if we have recent LIDAR data
                if sensors.lidar_updated > 0 and (now - sensors.lidar_updated) < 2.0:
                    status = self.navigate_step()
                    if "FORWARD" in status or "TURN" in status or "REVERSE" in status or "EMERGENCY" in status:
                        print(f"[NAV] {status}")
                    last_nav = now
                elif sensors.lidar_updated == 0:
                    pass  # Waiting for first LIDAR data
                else:
                    print("[NAV] Warning: LIDAR data stale")

    def run(self):
        """Start the navigator"""
        print("=" * 60)
        print("  AUTONOMOUS MAPPING - FULL SENSOR FUSION")
        print("  LIDAR + Cameras + GPS + Compass + Ultrasonics")
        print("  Stop distance: 40cm (16 inches)")
        print("=" * 60)

        # Start navigation thread
        self.nav_thread = threading.Thread(target=self.navigation_loop, daemon=True)
        self.nav_thread.start()

        # WebSocket connection loop
        while self.running:
            try:
                print(f"[WS] Connecting to {VPS_WS}...")
                self.ws_app = websocket.WebSocketApp(
                    VPS_WS,
                    on_open=self.on_open,
                    on_close=self.on_close,
                    on_error=self.on_error,
                    on_message=self.on_message
                )

                # Run WebSocket (blocks until disconnected)
                self.ws_app.run_forever(ping_interval=30, ping_timeout=10)

            except Exception as e:
                print(f"[WS] Connection error: {e}")
                self.connected = False

            if self.running:
                print("[WS] Reconnecting in 3 seconds...")
                time.sleep(3)

        self.stop_robot()
        print("[NAV] Shutdown complete")


def main():
    nav = AutonomousNavigator()
    try:
        nav.run()
    except KeyboardInterrupt:
        print("\n[NAV] Interrupted")
        nav.running = False
        nav.stop_robot()


if __name__ == "__main__":
    main()
