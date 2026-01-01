#!/usr/bin/env python3
"""
Autonomous Mapping Navigation - Jetson
FULL SENSOR FUSION: LIDAR + Cameras + GPS + Compass + Ultrasonics
Uses all available data to navigate safely and build maps
LIDAR data received via VPS (lidar_relay.py handles hardware)
"""

import json
import time
import math
import threading
import websocket
from collections import deque

# VPS WebSocket
VPS_WS = "ws://72.60.124.34:3001"

# Navigation parameters - TIGHT to avoid hitting tables/furniture
# 16 inches = 40cm, 12 inches = 30cm
SAFE_DISTANCE_CM = 60      # Start slowing down (~24 inches)
STOP_DISTANCE_CM = 40      # Hard stop (~16 inches)
CRITICAL_DISTANCE_CM = 30  # Emergency backup (~12 inches)
TURN_THRESHOLD_CM = 80     # Need this much space to go forward
SCAN_SECTORS = 12          # Divide 360° into sectors
SPEED_SLOW = 3             # Slow speed (RPM-ish value)
SPEED_NORMAL = 5           # Normal mapping speed

# State
running = False
paused = True  # Start paused
ws = None
ws_lock = threading.Lock()

# ========== SENSOR FUSION DATA ==========
class SensorState:
    def __init__(self):
        # LIDAR - sectors with min distance
        self.lidar_sectors = {}
        self.lidar_updated = 0

        # Ultrasonics - 4 corners (cm)
        self.us_fl = 999  # Front-left
        self.us_fr = 999  # Front-right
        self.us_rl = 999  # Rear-left
        self.us_rr = 999  # Rear-right
        self.us_updated = 0

        # Compass - heading in degrees
        self.heading = 0
        self.heading_updated = 0

        # GPS
        self.gps_lat = 0
        self.gps_lon = 0
        self.gps_valid = False
        self.gps_sats = 0
        self.gps_updated = 0

        # Object detection from cameras
        self.cam1_detections = []  # Front camera
        self.cam2_detections = []  # Rear camera
        self.detection_updated = 0

        # Path history (for backtracking)
        self.path_history = deque(maxlen=100)

        # Stuck detection
        self.position_history = deque(maxlen=20)
        self.stuck_count = 0

        # Torque monitoring for collision detection
        self.torque_left = 0
        self.torque_right = 0
        self.torque_history = deque(maxlen=10)
        self.torque_updated = 0
        self.collision_detected = False
        self.last_direction = "STOP"  # Track: FORWARD, REVERSE, LEFT, RIGHT, STOP

    def update_lidar(self, sectors):
        self.lidar_sectors = sectors
        self.lidar_updated = time.time()

    def update_ultrasonics(self, fl, fr, rl, rr):
        self.us_fl = fl
        self.us_fr = fr
        self.us_rl = rl
        self.us_rr = rr
        self.us_updated = time.time()

    def update_compass(self, heading):
        self.heading = heading
        self.heading_updated = time.time()

    def update_gps(self, lat, lon, valid, sats):
        self.gps_lat = lat
        self.gps_lon = lon
        self.gps_valid = valid
        self.gps_sats = sats
        self.gps_updated = time.time()

    def update_detections(self, cam_id, detections):
        if cam_id == 1:
            self.cam1_detections = detections
        else:
            self.cam2_detections = detections
        self.detection_updated = time.time()

    def record_position(self):
        """Record current heading for stuck detection"""
        self.position_history.append(self.heading)

    def is_stuck(self):
        """Detect if robot is stuck (heading not changing)"""
        if len(self.position_history) < 10:
            return False
        # Check if heading variance is very low (not moving)
        headings = list(self.position_history)
        avg = sum(headings) / len(headings)
        variance = sum((h - avg) ** 2 for h in headings) / len(headings)
        return variance < 2  # Very little heading change

    def update_torque(self, torque_l, torque_r):
        """Update torque readings and check for collision"""
        self.torque_left = torque_l
        self.torque_right = torque_r
        self.torque_updated = time.time()

        # Track torque history for spike detection
        max_torque = max(abs(torque_l), abs(torque_r))
        self.torque_history.append(max_torque)

        # Collision detection: torque spike above threshold
        # Normal driving torque is low (1-5), collision causes spike (15+)
        TORQUE_COLLISION_THRESHOLD = 12.0
        if max_torque > TORQUE_COLLISION_THRESHOLD:
            self.collision_detected = True
            print(f"[COLLISION] Torque spike detected! L:{torque_l:.1f} R:{torque_r:.1f}")
            return True
        return False

    def clear_collision(self):
        """Clear collision flag after handling"""
        self.collision_detected = False

sensors = SensorState()

# ========== DETECTION ANALYSIS ==========
def analyze_detections():
    """Analyze camera detections for navigation hints"""
    # Priority objects that indicate "go this way" or "avoid"
    avoid_objects = {"person", "dog", "cat", "car", "bicycle", "motorcycle",
                     "chair", "table", "door"}  # Don't drive into

    path_objects = {"floor", "ground", "road", "sidewalk", "grass"}  # Safe to traverse

    front_blocked = False
    rear_blocked = False

    # Check front camera
    for det in sensors.cam1_detections:
        cls = det.get("class", "").lower()
        conf = det.get("confidence", 0)
        bbox = det.get("bbox", {})

        # If high-confidence avoid object in center of frame
        if cls in avoid_objects and conf > 0.3:
            x = bbox.get("x", 0.5)
            if 0.3 < x < 0.7:  # Center of frame
                front_blocked = True
                print(f"[DETECT] Front blocked by {cls} ({conf:.0%})")

    # Check rear camera
    for det in sensors.cam2_detections:
        cls = det.get("class", "").lower()
        conf = det.get("confidence", 0)
        bbox = det.get("bbox", {})

        if cls in avoid_objects and conf > 0.3:
            x = bbox.get("x", 0.5)
            if 0.3 < x < 0.7:
                rear_blocked = True
                print(f"[DETECT] Rear blocked by {cls} ({conf:.0%})")

    return front_blocked, rear_blocked

# ========== SENSOR FUSION ==========
def get_fused_front_distance():
    """Combine LIDAR and ultrasonics for front distance"""
    distances = []

    # LIDAR front sectors (0, 11, 1)
    for sector in [0, 11, 1]:
        if sector in sensors.lidar_sectors:
            distances.append(sensors.lidar_sectors[sector])

    # Ultrasonics (converted to cm if needed)
    if sensors.us_fl < 500:
        distances.append(sensors.us_fl)
    if sensors.us_fr < 500:
        distances.append(sensors.us_fr)

    # Return minimum of all sensors
    return min(distances) if distances else 999

def get_fused_rear_distance():
    """Combine LIDAR and ultrasonics for rear distance"""
    distances = []

    # LIDAR rear sectors (5, 6, 7)
    for sector in [5, 6, 7]:
        if sector in sensors.lidar_sectors:
            distances.append(sensors.lidar_sectors[sector])

    # Rear ultrasonics
    if sensors.us_rl < 500:
        distances.append(sensors.us_rl)
    if sensors.us_rr < 500:
        distances.append(sensors.us_rr)

    return min(distances) if distances else 999

def get_fused_left_distance():
    """LIDAR left sectors"""
    distances = []
    for sector in [2, 3]:
        if sector in sensors.lidar_sectors:
            distances.append(sensors.lidar_sectors[sector])
    return min(distances) if distances else 999

def get_fused_right_distance():
    """LIDAR right sectors"""
    distances = []
    for sector in [9, 10]:
        if sector in sensors.lidar_sectors:
            distances.append(sensors.lidar_sectors[sector])
    return min(distances) if distances else 999

# ========== NAVIGATION LOGIC ==========
def find_best_direction():
    """Find safest direction to move using all sensors"""
    front = get_fused_front_distance()
    rear = get_fused_rear_distance()
    left = get_fused_left_distance()
    right = get_fused_right_distance()

    # Check camera detections
    front_blocked_by_object, rear_blocked_by_object = analyze_detections()

    # Apply camera detection penalties
    if front_blocked_by_object:
        front = min(front, SAFE_DISTANCE_CM - 10)  # Treat as closer
    if rear_blocked_by_object:
        rear = min(rear, SAFE_DISTANCE_CM - 10)

    print(f"[FUSION] F:{front:.0f} L:{left:.0f} R:{right:.0f} B:{rear:.0f} cm")

    # Score each direction (higher = better)
    scores = {
        "FORWARD": front * 1.5,    # Prefer forward
        "LEFT": left * 1.0,
        "RIGHT": right * 1.0,
        "REVERSE": rear * 0.5,     # Penalize reverse
    }

    # Find best direction
    best = max(scores, key=scores.get)
    best_dist = {"FORWARD": front, "LEFT": left, "RIGHT": right, "REVERSE": rear}[best]

    return best, best_dist

# ========== COMMAND SENDING ==========
def connect_ws():
    global ws
    while True:
        try:
            ws = websocket.create_connection(VPS_WS, timeout=5)
            ws.send(json.dumps({
                "type": "JETSON_REGISTER",
                "device": "autonomous",
                "capabilities": ["navigation", "mapping", "sensor_fusion"]
            }))
            print(f"[WS] Connected to {VPS_WS}")
            return
        except Exception as e:
            print(f"[WS] Connection failed: {e}, retrying...")
            time.sleep(2)

def send_command(cmd, value=0):
    """Send drive command to robot via VPS"""
    global ws
    try:
        with ws_lock:
            if ws is None:
                return
            msg = {
                "type": "autonomous_cmd",
                "cmd": cmd,
                "value": value
            }
            ws.send(json.dumps(msg))
    except Exception as e:
        print(f"[WS] Send error: {e}")

def stop_robot():
    send_command("STOP")
    sensors.last_direction = "STOP"

def move_forward(speed=SPEED_NORMAL):
    send_command("FORWARD", speed)
    sensors.last_direction = "FORWARD"

def turn_left(speed=SPEED_SLOW):
    send_command("TURN_LEFT", speed)
    sensors.last_direction = "LEFT"

def turn_right(speed=SPEED_SLOW):
    send_command("TURN_RIGHT", speed)
    sensors.last_direction = "RIGHT"

def reverse(speed=SPEED_SLOW):
    send_command("REVERSE", speed)
    sensors.last_direction = "REVERSE"

# ========== MAIN NAVIGATION STEP ==========
def navigate_step():
    """One step of intelligent navigation"""
    global paused

    if paused:
        stop_robot()
        return "PAUSED"

    # COLLISION RECOVERY: If we hit something, go the opposite direction
    if sensors.collision_detected:
        last_dir = sensors.last_direction
        print(f"[NAV] Collision recovery - was going {last_dir}")
        stop_robot()
        time.sleep(0.2)

        if last_dir == "REVERSE":
            # Was reversing, go forward
            move_forward(SPEED_SLOW)
            time.sleep(0.5)
            print("[NAV] Collision while reversing - moved forward")
        else:
            # Was going forward/turning, back up
            reverse(SPEED_SLOW)
            time.sleep(0.5)
            print("[NAV] Collision while moving forward - backed up")

        stop_robot()
        sensors.clear_collision()
        return f"COLLISION RECOVERY (was {last_dir})"

    # Record position for stuck detection
    sensors.record_position()

    # Get fused distances
    front = get_fused_front_distance()
    rear = get_fused_rear_distance()
    left = get_fused_left_distance()
    right = get_fused_right_distance()

    # Check if stuck
    if sensors.is_stuck():
        sensors.stuck_count += 1
        if sensors.stuck_count > 5:
            print("[NAV] STUCK DETECTED - trying recovery")
            # Try wiggle maneuver
            turn_right()
            time.sleep(0.3)
            turn_left()
            time.sleep(0.3)
            sensors.stuck_count = 0
            return "RECOVERY (stuck)"
    else:
        sensors.stuck_count = 0

    # CRITICAL: Emergency stop if too close
    if front < CRITICAL_DISTANCE_CM:
        stop_robot()
        time.sleep(0.2)

        # Emergency backup
        if rear > SAFE_DISTANCE_CM:
            reverse()
            time.sleep(0.4)
            return "EMERGENCY REVERSE"
        else:
            # Trapped! Try spinning
            if right > left:
                turn_right()
            else:
                turn_left()
            time.sleep(0.4)
            return "EMERGENCY SPIN"

    # Find best direction using all sensors
    best_dir, best_dist = find_best_direction()

    # Execute navigation
    if best_dir == "FORWARD":
        if front > TURN_THRESHOLD_CM:
            move_forward(SPEED_NORMAL)
            return f"FORWARD (clear: {front:.0f}cm)"
        elif front > SAFE_DISTANCE_CM:
            move_forward(SPEED_SLOW)
            return f"FORWARD_SLOW ({front:.0f}cm)"
        else:
            # Need to turn
            if right > left:
                turn_right()
                time.sleep(0.3)
                return f"TURN_RIGHT (front:{front:.0f})"
            else:
                turn_left()
                time.sleep(0.3)
                return f"TURN_LEFT (front:{front:.0f})"

    elif best_dir == "LEFT":
        turn_left()
        time.sleep(0.3)
        return f"TURN_LEFT (best direction, {left:.0f}cm)"

    elif best_dir == "RIGHT":
        turn_right()
        time.sleep(0.3)
        return f"TURN_RIGHT (best direction, {right:.0f}cm)"

    elif best_dir == "REVERSE":
        reverse()
        time.sleep(0.4)
        return f"REVERSE (only option, {rear:.0f}cm)"

    return "IDLE"

# ========== WEBSOCKET LISTENER ==========
def ws_listener():
    """Listen for sensor data and commands from VPS"""
    global running, paused, ws

    while running:
        try:
            with ws_lock:
                if ws is None:
                    time.sleep(0.5)
                    continue
                ws.settimeout(0.3)

            try:
                data = ws.recv()
            except websocket.WebSocketTimeoutException:
                continue
            except:
                continue

            if isinstance(data, bytes):
                if len(data) < 2 or data[0] != ord('{'):
                    continue
                try:
                    data = data.decode('utf-8')
                except:
                    continue

            try:
                msg = json.loads(data)
                msg_type = msg.get("type", "")

                # Control commands
                if msg_type == "AUTONOMOUS_CONTROL":
                    cmd = msg.get("cmd", "")
                    if cmd == "START":
                        paused = False
                        print("[NAV] *** AUTONOMOUS MAPPING STARTED ***")
                    elif cmd == "PAUSE":
                        paused = True
                        stop_robot()
                        print("[NAV] Paused")
                    elif cmd == "STOP":
                        running = False
                        paused = True
                        stop_robot()
                        print("[NAV] Stopped")

                # Compass data
                elif msg_type == "compass":
                    sensors.update_compass(msg.get("heading", 0))

                # GPS data
                elif msg_type == "gps":
                    sensors.update_gps(
                        msg.get("lat", 0),
                        msg.get("lon", 0),
                        msg.get("valid", False),
                        msg.get("sats", 0)
                    )

                # Teensy telemetry - extract torque for collision detection
                elif msg_type == "teensy_telemetry":
                    torque_l = msg.get("torqueL", 0)
                    torque_r = msg.get("torqueR", 0)
                    if sensors.update_torque(torque_l, torque_r):
                        # Collision detected! Emergency stop
                        stop_robot()
                        print("[COLLISION] Emergency stop triggered by torque spike!")

                # Ultrasonic data from server
                elif msg_type == "ultrasonic":
                    sensors.update_ultrasonics(
                        msg.get("fl", 999),
                        msg.get("fr", 999),
                        msg.get("rl", 999),
                        msg.get("rr", 999)
                    )

                # Object detection data
                elif msg_type == "detections":
                    cam_id = msg.get("camera", 1)
                    detections = msg.get("detections", [])
                    sensors.update_detections(cam_id, detections)

                # LIDAR data from lidar_relay.py via VPS
                elif msg_type == "lidar":
                    points = msg.get("points", [])
                    if points:
                        # Convert to (angle, distance) tuples - distance in mm
                        scan_data = [(p.get("angle", 0), p.get("distance", 0)) for p in points]
                        process_scan(scan_data)

            except:
                pass

        except Exception as e:
            if "timed out" not in str(e):
                print(f"[WS Listener] Error: {e}")
            time.sleep(0.1)

# ========== LIDAR PROCESSING ==========
def process_scan(scan):
    """Process LIDAR scan into sectors with min distances"""
    sectors = {}
    sector_size = 360 / SCAN_SECTORS

    for angle, distance in scan:
        if distance < 10:  # Invalid reading
            continue
        sector = int(angle / sector_size) % SCAN_SECTORS
        dist_cm = distance / 10  # mm to cm
        if sector not in sectors or dist_cm < sectors[sector]:
            sectors[sector] = dist_cm

    sensors.update_lidar(sectors)
    return sectors

# ========== MAIN LOOP ==========
def run_navigation():
    """Main navigation loop using all sensors"""
    global running, paused

    print("=" * 60)
    print("  AUTONOMOUS MAPPING - FULL SENSOR FUSION")
    print("  Sensors: LIDAR + Cameras + GPS + Compass + Ultrasonics")
    print("  LIDAR data via lidar_relay.py (no direct hardware access)")
    print("  Press 🛑 STOP on UI or physical kill switch to stop")
    print("=" * 60)

    # Connect to VPS
    connect_ws()

    # Start WebSocket listener for sensor data (including LIDAR)
    running = True
    paused = True
    ws_thread = threading.Thread(target=ws_listener, daemon=True)
    ws_thread.start()

    print("[NAV] Waiting for START command from UI...")
    print("[NAV] LIDAR data comes from lidar_relay.py via VPS")

    last_nav_time = 0
    nav_interval = 0.15  # Navigate every 150ms

    try:
        while running:
            time.sleep(0.05)

            # Run navigation at fixed interval when not paused
            now = time.time()
            if not paused and running and (now - last_nav_time) > nav_interval:
                # Check if we have recent LIDAR data
                if sensors.lidar_updated > 0 and (now - sensors.lidar_updated) < 2.0:
                    status = navigate_step()
                    if "FORWARD" in status or "TURN" in status or "REVERSE" in status:
                        print(f"[NAV] {status}")
                    last_nav_time = now
                elif sensors.lidar_updated == 0:
                    # No LIDAR data yet - wait
                    pass
                else:
                    print("[NAV] Warning: LIDAR data stale")

    except KeyboardInterrupt:
        print("\n[NAV] Interrupted by user")
    except Exception as e:
        print(f"[NAV] Error: {e}")
        import traceback
        traceback.print_exc()
    finally:
        running = False
        stop_robot()
        print("[NAV] Shutdown complete")

if __name__ == "__main__":
    run_navigation()
