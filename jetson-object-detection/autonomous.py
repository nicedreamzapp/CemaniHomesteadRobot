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
SAFE_DISTANCE_CM = 50      # Start slowing down (~20 inches)
STOP_DISTANCE_CM = 40      # Hard stop (~16 inches) - ultrasonics trigger this
CRITICAL_DISTANCE_CM = 30  # Emergency backup (~12 inches)
TURN_THRESHOLD_CM = 120    # Need 1.2m clear to keep going forward
OPEN_PATH_CM = 200         # Consider path "open" if >2m clear
SCAN_SECTORS = 12          # Divide 360° into sectors
SPEED_SLOW = 5             # Slow speed
SPEED_NORMAL = 10          # Normal mapping speed
SPEED_FAST = 15            # Fast when path is wide open
MIN_FORWARD_TIME = 2.0     # Commit to forward for 2 seconds minimum
MIN_TURN_TIME = 0.8        # Commit to turn for 0.8 seconds

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
        self.committed_action = None      # Current committed action
        self.commit_until = 0             # Time when commitment expires
        self.last_open_direction = None   # Remember which way was open

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
        """Find the most open direction to move - prefer long clear paths"""
        front = self.get_front_distance()
        rear = self.get_rear_distance()
        left = self.get_left_distance()
        right = self.get_right_distance()

        # Strong preference for forward if path is reasonably clear
        # Only turn if forward is really blocked
        if front > TURN_THRESHOLD_CM:
            return "FORWARD", front, front, left, right, rear

        # Forward is somewhat blocked - find the most open direction
        # Heavily prefer forward over turning
        scores = {
            "FORWARD": front * 2.0,    # Strong forward preference
            "LEFT": left * 1.0,
            "RIGHT": right * 1.0,
            "REVERSE": rear * 0.3,     # Really penalize reverse
        }

        best = max(scores, key=scores.get)
        best_dist = {"FORWARD": front, "LEFT": left, "RIGHT": right, "REVERSE": rear}[best]

        return best, best_dist, front, left, right, rear

    def find_open_path(self):
        """Look for the most open direction using all LIDAR sectors"""
        # Find sector with maximum distance
        max_dist = 0
        best_sector = 0

        for sector, dist in sensors.lidar_sectors.items():
            if dist > max_dist:
                max_dist = dist
                best_sector = sector

        # Convert sector to direction (0=front, 3=left, 6=rear, 9=right)
        if best_sector in [0, 1, 11]:
            return "FORWARD", max_dist
        elif best_sector in [2, 3, 4]:
            return "LEFT", max_dist
        elif best_sector in [5, 6, 7]:
            return "REVERSE", max_dist
        else:  # 8, 9, 10
            return "RIGHT", max_dist

    def navigate_step(self):
        """One step of autonomous navigation - commit to directions, find open paths"""
        if self.paused:
            self.stop_robot()
            return "PAUSED"

        now = time.time()

        # Collision recovery
        if sensors.collision_detected:
            print(f"[NAV] Collision recovery - was going {sensors.last_direction}")
            self.stop_robot()
            sensors.committed_action = None
            time.sleep(0.3)
            self.reverse(SPEED_SLOW)
            time.sleep(0.8)
            self.stop_robot()
            sensors.collision_detected = False
            return "COLLISION_RECOVERY"

        # Get distances - use LIDAR primarily, ultrasonics as backup
        front = self.get_front_distance()
        rear = self.get_rear_distance()
        left = self.get_left_distance()
        right = self.get_right_distance()

        # Find the most open path using all LIDAR data
        open_dir, open_dist = self.find_open_path()

        # Get LIDAR front distance for navigation
        lidar_front = 999
        for sector in [0, 11, 1]:
            if sector in sensors.lidar_sectors:
                lidar_front = min(lidar_front, sensors.lidar_sectors[sector])

        # CRITICAL: Use BOTH LIDAR and ultrasonics for emergency stops
        # Ultrasonics are great for catching things LIDAR might miss
        us_front = min(sensors.us_fl if sensors.us_fl > 0 else 999,
                       sensors.us_fr if sensors.us_fr > 0 else 999)
        min_front = min(lidar_front, us_front)  # Use closest reading from either sensor

        # Emergency stop if EITHER lidar or ultrasonic detects obstacle too close
        if min_front < CRITICAL_DISTANCE_CM:
            self.stop_robot()
            sensors.committed_action = None
            print(f"[NAV] EMERGENCY STOP! lidar={lidar_front:.0f}cm, ultrasonic={us_front:.0f}cm")
            # Find best escape direction
            if open_dist > SAFE_DISTANCE_CM:
                sensors.last_open_direction = open_dir
                if open_dir == "LEFT":
                    self.turn_left(SPEED_SLOW)
                elif open_dir == "RIGHT":
                    self.turn_right(SPEED_SLOW)
                else:
                    self.reverse(SPEED_SLOW)
                sensors.commit_until = now + 0.8
                return f"ESCAPE {open_dir} (front={min_front:.0f}cm, open={open_dist:.0f}cm)"
            return f"BLOCKED (front={min_front:.0f}cm)"

        # If we're committed to an action and it's still safe, continue
        if sensors.committed_action and now < sensors.commit_until:
            # But check if we're about to hit something (use both sensors)
            if sensors.committed_action == "FORWARD" and min_front < STOP_DISTANCE_CM:
                sensors.committed_action = None  # Abort forward - obstacle detected
                print(f"[NAV] Abort forward - obstacle at {min_front:.0f}cm")
            else:
                return f"COMMITTED {sensors.committed_action}"

        # Decide new action - prefer the most open direction
        if lidar_front > OPEN_PATH_CM:
            # Wide open ahead - go fast!
            self.move_forward(SPEED_FAST)
            sensors.committed_action = "FORWARD"
            sensors.commit_until = now + MIN_FORWARD_TIME * 2  # Commit longer when open
            return f"FORWARD_FAST (clear: {lidar_front:.0f}cm)"

        elif lidar_front > TURN_THRESHOLD_CM:
            # Good path ahead
            self.move_forward(SPEED_NORMAL)
            sensors.committed_action = "FORWARD"
            sensors.commit_until = now + MIN_FORWARD_TIME
            return f"FORWARD (clear: {lidar_front:.0f}cm)"

        elif lidar_front > SAFE_DISTANCE_CM:
            # Slowing down, path narrowing
            self.move_forward(SPEED_SLOW)
            sensors.committed_action = "FORWARD"
            sensors.commit_until = now + MIN_FORWARD_TIME * 0.5
            return f"FORWARD_SLOW ({lidar_front:.0f}cm)"

        else:
            # Need to turn - find best direction
            # Use the open path finder
            if open_dist > TURN_THRESHOLD_CM:
                if open_dir == "LEFT":
                    self.turn_left(SPEED_NORMAL)
                    sensors.committed_action = "LEFT"
                elif open_dir == "RIGHT":
                    self.turn_right(SPEED_NORMAL)
                    sensors.committed_action = "RIGHT"
                else:
                    self.reverse(SPEED_SLOW)
                    sensors.committed_action = "REVERSE"
                sensors.commit_until = now + MIN_TURN_TIME
                return f"TURN_{open_dir} (open path: {open_dist:.0f}cm)"
            else:
                # No good path - turn toward more space
                if right > left:
                    self.turn_right(SPEED_SLOW)
                    sensors.committed_action = "RIGHT"
                else:
                    self.turn_left(SPEED_SLOW)
                    sensors.committed_action = "LEFT"
                sensors.commit_until = now + MIN_TURN_TIME
                return f"SEARCHING (best: {max(left,right):.0f}cm)"

    def navigation_loop(self):
        """Main navigation loop"""
        nav_interval = 0.1  # 100ms between nav checks (but commits last longer)
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
                    # Only log when action changes (not COMMITTED messages)
                    if "COMMITTED" not in status:
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
