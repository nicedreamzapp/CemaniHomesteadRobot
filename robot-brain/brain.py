#!/usr/bin/env python3
"""
Robot Brain - Autonomous Movement with Text Message Control
Connects to VPS server, receives all sensor data, executes movement commands.
Control via HTTP API (localhost:5000) or text messages from phone.
"""

import json
import time
import math
import threading
import subprocess
import os
import urllib.request
from http.server import HTTPServer, BaseHTTPRequestHandler
import websocket

# ===== CONFIG =====
VPS_WS = "ws://72.60.124.34:3001"
API_PORT = 5000

# Physical constants (must match config.h)
WHEEL_CIRCUMFERENCE_MM = 638.4
WHEEL_BASE_MM = 550.0
ENCODER_COUNTS_PER_REV = 4096
MM_PER_COUNT = WHEEL_CIRCUMFERENCE_MM / ENCODER_COUNTS_PER_REV  # ~0.156mm

# Unit conversions
FT_TO_MM = 304.8
MM_TO_FT = 1.0 / FT_TO_MM

# Obstacle avoidance (cm)
STOP_DISTANCE = 40       # Hard stop
SLOW_DISTANCE = 80       # Start slowing
CLEAR_DISTANCE = 120     # Consider path clear

# Speed limits (RPM) - Teensy caps AUTO_ at 10 RPM anyway
SPEED_SLOW = 8
SPEED_NORMAL = 15
SPEED_FAST = 25
SPEED_TURN = 10

# LIDAR sectors (12 x 30 degrees)
FRONT_SECTORS = [0, 11, 1]
REAR_SECTORS = [5, 6, 7]
LEFT_SECTORS = [2, 3, 4]
RIGHT_SECTORS = [8, 9, 10]

# Text message script
SEND_SMS = os.path.expanduser("~/send-imessage.sh")

# Claude API for natural language understanding
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
CLAUDE_MODEL = "claude-haiku-4-5-20251001"  # Fast + cheap for command parsing


# ===== SENSOR STATE =====
class SensorState:
    """Holds all real-time sensor data from the robot."""

    def __init__(self):
        # Ultrasonic (cm)
        self.us_fl = 999
        self.us_fr = 999
        self.us_rl = 999
        self.us_rr = 999
        self.us_updated = 0

        # LIDAR sectors: {sector_id: min_distance_cm}
        self.lidar_sectors = {}
        self.lidar_updated = 0

        # Compass heading (degrees, 0=N, 90=E)
        self.compass = 0
        self.compass_updated = 0

        # Odometry from server (mm, radians)
        self.odom_x = 0
        self.odom_y = 0
        self.odom_heading = 0       # radians
        self.odom_heading_deg = 0   # degrees
        self.odom_distance = 0      # total distance traveled (mm)
        self.odom_updated = 0

        # Encoders (raw counts)
        self.enc_left = 0
        self.enc_right = 0

        # Motor state
        self.vel_left = 0   # RPM
        self.vel_right = 0
        self.battery_v = 0

        # GPS
        self.gps_lat = 0
        self.gps_lon = 0
        self.gps_valid = False

        # Object detections
        self.detections_cam1 = []
        self.detections_cam2 = []
        self.detect_updated = 0

        # Home position (saved on startup or command)
        self.home_x = 0
        self.home_y = 0
        self.home_heading = 0

    def front_clear(self, min_cm=STOP_DISTANCE):
        """Check if front is clear using LIDAR + ultrasonic."""
        distances = []
        for s in FRONT_SECTORS:
            if s in self.lidar_sectors:
                distances.append(self.lidar_sectors[s])
        for v in [self.us_fl, self.us_fr]:
            if 0 < v < 500:
                distances.append(v)
        return min(distances) > min_cm if distances else True

    def rear_clear(self, min_cm=STOP_DISTANCE):
        distances = []
        for s in REAR_SECTORS:
            if s in self.lidar_sectors:
                distances.append(self.lidar_sectors[s])
        for v in [self.us_rl, self.us_rr]:
            if 0 < v < 500:
                distances.append(v)
        return min(distances) > min_cm if distances else True

    def min_front(self):
        distances = []
        for s in FRONT_SECTORS:
            if s in self.lidar_sectors:
                distances.append(self.lidar_sectors[s])
        for v in [self.us_fl, self.us_fr]:
            if 0 < v < 500:
                distances.append(v)
        return min(distances) if distances else 999

    def min_rear(self):
        distances = []
        for s in REAR_SECTORS:
            if s in self.lidar_sectors:
                distances.append(self.lidar_sectors[s])
        for v in [self.us_rl, self.us_rr]:
            if 0 < v < 500:
                distances.append(v)
        return min(distances) if distances else 999

    def distance_to(self, x_mm, y_mm):
        dx = x_mm - self.odom_x
        dy = y_mm - self.odom_y
        return math.sqrt(dx * dx + dy * dy)

    def bearing_to(self, x_mm, y_mm):
        """Bearing in degrees from current position to target."""
        dx = x_mm - self.odom_x
        dy = y_mm - self.odom_y
        angle_rad = math.atan2(dy, dx)
        return math.degrees(angle_rad) % 360

    def find_most_open_direction(self):
        """Find the most open direction from LIDAR data."""
        max_dist = 0
        best_sector = 0
        for sector, dist in self.lidar_sectors.items():
            if dist > max_dist:
                max_dist = dist
                best_sector = sector
        if best_sector in FRONT_SECTORS:
            return "forward", max_dist
        elif best_sector in LEFT_SECTORS:
            return "left", max_dist
        elif best_sector in RIGHT_SECTORS:
            return "right", max_dist
        else:
            return "backward", max_dist


# ===== ROBOT BRAIN =====
class RobotBrain:
    """Main brain: connects to server, processes sensors, executes commands."""

    def __init__(self):
        self.sensors = SensorState()
        self.ws = None
        self.connected = False
        self.running = True

        # Movement state
        self.current_task = None       # "forward", "turn", "explore", etc.
        self.task_cancel = threading.Event()
        self.movement_lock = threading.Lock()
        self.status_msg = "idle"

        # Command keep-alive (Teensy AUTO_ timeout is 500ms)
        self._keepalive_cmd = None
        self._keepalive_speed = 0
        self._keepalive_thread = None

    # ========== WebSocket ==========

    def on_open(self, ws):
        self.connected = True
        reg = {
            "type": "JETSON_REGISTER",
            "device": "autonomous",
            "capabilities": ["brain", "movement", "navigation"]
        }
        ws.send(json.dumps(reg))
        print("[BRAIN] Connected to VPS, registered as autonomous")

        # Save home position
        self.sensors.home_x = self.sensors.odom_x
        self.sensors.home_y = self.sensors.odom_y
        self.sensors.home_heading = self.sensors.odom_heading
        print(f"[BRAIN] Home set at ({self.sensors.home_x:.0f}, {self.sensors.home_y:.0f})")

    def on_close(self, ws, code, msg):
        print(f"[BRAIN] Disconnected: {code}")
        self.connected = False
        self._stop_keepalive()

    def on_error(self, ws, error):
        print(f"[BRAIN] WS error: {error}")

    def on_message(self, ws, message):
        try:
            if isinstance(message, bytes):
                message = message.decode('utf-8')
            data = json.loads(message)
            msg_type = data.get("type", "")
            self._route_message(msg_type, data)
        except Exception:
            pass

    def _route_message(self, msg_type, data):
        s = self.sensors

        if msg_type == "lidar":
            points = data.get("points", [])
            sectors = {}
            for p in points:
                angle = p[0] if isinstance(p, list) else p.get("angle", 0)
                dist = p[1] if isinstance(p, list) else p.get("distance", 0)
                if dist < 10:
                    continue
                sector = int(angle / 30) % 12
                dist_cm = dist / 10
                if sector not in sectors or dist_cm < sectors[sector]:
                    sectors[sector] = dist_cm
            s.lidar_sectors = sectors
            s.lidar_updated = time.time()

        elif msg_type == "ultrasonic":
            s.us_fl = data.get("fl", 999)
            s.us_fr = data.get("fr", 999)
            s.us_rl = data.get("rl", 999)
            s.us_rr = data.get("rr", 999)
            s.us_updated = time.time()

        elif msg_type == "compass":
            s.compass = data.get("heading", 0)
            s.compass_updated = time.time()

        elif msg_type == "dead_reckoning":
            s.odom_x = data.get("odomX", 0)
            s.odom_y = data.get("odomY", 0)
            s.odom_heading = data.get("odomHeading", 0)
            s.odom_heading_deg = data.get("odomHeadingDeg", 0)
            s.odom_distance = data.get("odomDistance", 0)
            s.odom_updated = time.time()

        elif msg_type == "teensy_telemetry":
            s.enc_left = data.get("posL", 0)
            s.enc_right = data.get("posR", 0)
            s.vel_left = data.get("velocityL", 0)
            s.vel_right = data.get("velocityR", 0)
            s.battery_v = data.get("voltage", 0) / 100.0  # 0.01V units

        elif msg_type == "gps":
            s.gps_lat = data.get("lat", 0)
            s.gps_lon = data.get("lon", 0)
            s.gps_valid = data.get("valid", False)

        elif msg_type == "detections":
            cam = data.get("camera", 1)
            dets = data.get("detections", [])
            if cam == 1:
                s.detections_cam1 = dets
            else:
                s.detections_cam2 = dets
            s.detect_updated = time.time()

        elif msg_type == "AUTONOMOUS_CONTROL":
            cmd = data.get("cmd", "")
            if cmd == "STOP":
                self.stop()

        # Brain commands from web UI (forwarded by server)
        elif msg_type == "brain_command":
            self._handle_brain_command(data)

    # ========== Brain command handler (from web UI) ==========

    def _handle_brain_command(self, data):
        """Handle commands from the web UI via server."""
        action = data.get("action", "")
        value = data.get("value")

        if action == "status":
            # Send status back through WebSocket
            status = self.get_status()
            status["type"] = "brain_status"
            self._send(status)
            return

        def run_and_respond():
            result = ""
            if action == "forward":
                result = self.go_forward(float(value or 3))
            elif action == "backward":
                result = self.go_backward(float(value or 2))
            elif action == "turn":
                result = self.turn(float(value or 90))
            elif action == "explore":
                result = self.explore()
            elif action == "go_home":
                result = self.go_home()
            elif action == "stop":
                result = self.stop()
            elif action == "set_home":
                result = self.set_home()
            elif action == "text":
                _, result = self.parse_text_command(str(value or ""))
            else:
                result = f"unknown action: {action}"

            # Send result back
            self._send({"type": "brain_result", "action": action, "result": result})
            # Also send updated status
            status = self.get_status()
            status["type"] = "brain_status"
            self._send(status)

        if action == "stop":
            self.stop()
            self._send({"type": "brain_result", "action": "stop", "result": "stopped"})
        else:
            threading.Thread(target=run_and_respond, daemon=True).start()
            # Immediate acknowledgment
            self._send({"type": "brain_result", "action": action, "result": f"started: {action}"})

    # ========== Low-level motor commands ==========

    def _send(self, data):
        if self.connected and self.ws:
            try:
                self.ws.send(json.dumps(data))
            except Exception:
                pass

    def _cmd(self, cmd, speed=0):
        """Send autonomous command (AUTO_ prefix applied by server)."""
        self._send({"type": "autonomous_cmd", "cmd": cmd, "value": speed})

    def _start_keepalive(self, cmd, speed):
        """Send command every 300ms to keep Teensy moving (500ms timeout)."""
        self._stop_keepalive()
        self._keepalive_cmd = cmd
        self._keepalive_speed = speed

        def loop():
            while self._keepalive_cmd == cmd and not self.task_cancel.is_set():
                self._cmd(cmd, speed)
                time.sleep(0.3)

        self._keepalive_thread = threading.Thread(target=loop, daemon=True)
        self._keepalive_thread.start()

    def _stop_keepalive(self):
        old_cmd = self._keepalive_cmd
        self._keepalive_cmd = None
        self._keepalive_speed = 0
        if self._keepalive_thread:
            self._keepalive_thread.join(timeout=1)
            self._keepalive_thread = None
        if old_cmd:
            self._cmd("STOP")

    # ========== High-level movement commands ==========

    def go_forward(self, distance_ft):
        """Move forward a specific distance in feet."""
        with self.movement_lock:
            self.task_cancel.clear()
            self.current_task = "forward"
            target_mm = distance_ft * FT_TO_MM
            start_dist = self.sensors.odom_distance
            self.status_msg = f"moving forward {distance_ft:.1f}ft"
            print(f"[MOVE] Forward {distance_ft:.1f}ft ({target_mm:.0f}mm)")

            self._start_keepalive("FORWARD", SPEED_NORMAL)

            while not self.task_cancel.is_set():
                traveled = self.sensors.odom_distance - start_dist
                if traveled >= target_mm:
                    break

                # Obstacle check
                if not self.sensors.front_clear(STOP_DISTANCE):
                    self._stop_keepalive()
                    front = self.sensors.min_front()
                    self.status_msg = f"obstacle at {front:.0f}cm, stopped"
                    print(f"[MOVE] Obstacle at {front:.0f}cm - stopping")
                    self.current_task = None
                    return f"stopped - obstacle at {front:.0f}cm after {traveled * MM_TO_FT:.1f}ft"

                # Slow down when approaching target
                remaining = target_mm - traveled
                if remaining < 200:  # Last 200mm
                    self._keepalive_speed = SPEED_SLOW
                    self._start_keepalive("FORWARD", SPEED_SLOW)

                time.sleep(0.1)

            self._stop_keepalive()
            actual = self.sensors.odom_distance - start_dist
            result = f"moved forward {actual * MM_TO_FT:.1f}ft"
            self.status_msg = result
            print(f"[MOVE] {result}")
            self.current_task = None
            return result

    def go_backward(self, distance_ft):
        """Move backward a specific distance in feet."""
        with self.movement_lock:
            self.task_cancel.clear()
            self.current_task = "backward"
            target_mm = distance_ft * FT_TO_MM
            start_dist = self.sensors.odom_distance
            self.status_msg = f"moving backward {distance_ft:.1f}ft"
            print(f"[MOVE] Backward {distance_ft:.1f}ft ({target_mm:.0f}mm)")

            self._start_keepalive("REVERSE", SPEED_NORMAL)

            while not self.task_cancel.is_set():
                traveled = self.sensors.odom_distance - start_dist
                if traveled >= target_mm:
                    break

                if not self.sensors.rear_clear(STOP_DISTANCE):
                    self._stop_keepalive()
                    rear = self.sensors.min_rear()
                    self.status_msg = f"obstacle behind at {rear:.0f}cm"
                    self.current_task = None
                    return f"stopped - obstacle behind at {rear:.0f}cm"

                time.sleep(0.1)

            self._stop_keepalive()
            actual = self.sensors.odom_distance - start_dist
            result = f"moved backward {actual * MM_TO_FT:.1f}ft"
            self.status_msg = result
            self.current_task = None
            return result

    def turn(self, degrees):
        """Turn in place. Positive = right, negative = left."""
        with self.movement_lock:
            self.task_cancel.clear()
            self.current_task = "turn"
            direction = "right" if degrees > 0 else "left"
            target_deg = abs(degrees)
            start_heading = self.sensors.odom_heading_deg
            self.status_msg = f"turning {direction} {target_deg}deg"
            print(f"[MOVE] Turn {direction} {target_deg}deg")

            cmd = "TURN_RIGHT" if degrees > 0 else "TURN_LEFT"
            self._start_keepalive(cmd, SPEED_TURN)

            while not self.task_cancel.is_set():
                current = self.sensors.odom_heading_deg
                turned = abs(current - start_heading)
                # Handle 360 wraparound
                if turned > 180:
                    turned = 360 - turned
                if turned >= target_deg:
                    break
                time.sleep(0.05)

            self._stop_keepalive()
            current = self.sensors.odom_heading_deg
            actual = abs(current - start_heading)
            if actual > 180:
                actual = 360 - actual
            result = f"turned {direction} {actual:.0f}deg"
            self.status_msg = result
            self.current_task = None
            return result

    def go_to_point(self, x_mm, y_mm):
        """Navigate to a point in odometry coordinates (mm)."""
        with self.movement_lock:
            self.task_cancel.clear()
            self.current_task = "goto"
            dist = self.sensors.distance_to(x_mm, y_mm)
            self.status_msg = f"navigating to ({x_mm:.0f}, {y_mm:.0f})"
            print(f"[NAV] Go to ({x_mm:.0f}, {y_mm:.0f}), distance={dist:.0f}mm")

        # Calculate bearing and turn
        bearing = self.sensors.bearing_to(x_mm, y_mm)
        current_heading = self.sensors.odom_heading_deg
        turn_angle = bearing - current_heading
        # Normalize to [-180, 180]
        while turn_angle > 180:
            turn_angle -= 360
        while turn_angle < -180:
            turn_angle += 360

        if abs(turn_angle) > 5:
            self.turn(turn_angle)

        # Drive forward
        dist_ft = self.sensors.distance_to(x_mm, y_mm) * MM_TO_FT
        if dist_ft > 0.3:  # More than ~4 inches
            result = self.go_forward(dist_ft)
        else:
            result = "already at target"

        self.status_msg = f"arrived at ({x_mm:.0f}, {y_mm:.0f})"
        return result

    def explore(self):
        """Wander around avoiding obstacles. Runs until cancelled."""
        self.task_cancel.clear()
        self.current_task = "explore"
        self.status_msg = "exploring"
        print("[EXPLORE] Starting exploration")

        while not self.task_cancel.is_set():
            s = self.sensors

            # Wait for sensor data
            if s.lidar_updated == 0:
                time.sleep(0.5)
                continue

            front = s.min_front()
            direction, open_dist = s.find_most_open_direction()

            if front > CLEAR_DISTANCE:
                # Path clear - go forward
                with self.movement_lock:
                    self._start_keepalive("FORWARD", SPEED_NORMAL)
                self.status_msg = f"exploring forward ({front:.0f}cm clear)"
                time.sleep(1.0)
                self._stop_keepalive()

            elif front > STOP_DISTANCE:
                # Getting close - slow forward
                with self.movement_lock:
                    self._start_keepalive("FORWARD", SPEED_SLOW)
                self.status_msg = f"exploring slow ({front:.0f}cm)"
                time.sleep(0.5)
                self._stop_keepalive()

            else:
                # Blocked - turn toward most open direction
                if direction == "left":
                    cmd = "TURN_LEFT"
                elif direction == "right":
                    cmd = "TURN_RIGHT"
                else:
                    cmd = "REVERSE"

                with self.movement_lock:
                    self._start_keepalive(cmd, SPEED_TURN)
                self.status_msg = f"turning {direction} ({open_dist:.0f}cm open)"
                time.sleep(0.8)
                self._stop_keepalive()

            time.sleep(0.1)

        self._stop_keepalive()
        self.status_msg = "exploration stopped"
        self.current_task = None
        return "exploration stopped"

    def go_home(self):
        """Return to the starting position."""
        s = self.sensors
        dist = s.distance_to(s.home_x, s.home_y)
        print(f"[NAV] Going home ({s.home_x:.0f}, {s.home_y:.0f}), distance={dist * MM_TO_FT:.1f}ft")
        return self.go_to_point(s.home_x, s.home_y)

    def stop(self):
        """Immediately stop all movement."""
        self.task_cancel.set()
        self._stop_keepalive()
        self.current_task = None
        self.status_msg = "stopped"
        print("[MOVE] STOP")
        return "stopped"

    def set_home(self):
        """Save current position as home."""
        s = self.sensors
        s.home_x = s.odom_x
        s.home_y = s.odom_y
        s.home_heading = s.odom_heading
        result = f"home set at ({s.home_x:.0f}mm, {s.home_y:.0f}mm)"
        print(f"[BRAIN] {result}")
        return result

    def get_status(self):
        """Return current state as dict."""
        s = self.sensors
        return {
            "task": self.current_task or "idle",
            "status": self.status_msg,
            "connected": self.connected,
            "position": {
                "x_mm": round(s.odom_x),
                "y_mm": round(s.odom_y),
                "heading_deg": round(s.odom_heading_deg, 1),
                "distance_ft": round(s.odom_distance * MM_TO_FT, 1)
            },
            "obstacles": {
                "front_cm": round(s.min_front()),
                "rear_cm": round(s.min_rear()),
                "us_fl": round(s.us_fl),
                "us_fr": round(s.us_fr),
                "us_rl": round(s.us_rl),
                "us_rr": round(s.us_rr)
            },
            "battery_v": round(s.battery_v, 1),
            "compass_deg": round(s.compass, 1),
            "sensors": {
                "lidar": "ok" if time.time() - s.lidar_updated < 2 else "stale",
                "ultrasonic": "ok" if time.time() - s.us_updated < 2 else "stale",
                "odometry": "ok" if time.time() - s.odom_updated < 2 else "stale",
                "compass": "ok" if time.time() - s.compass_updated < 5 else "stale"
            },
            "home": {
                "x_mm": round(s.home_x),
                "y_mm": round(s.home_y)
            }
        }

    # ========== Claude AI command parsing ==========

    def ask_claude(self, user_text):
        """Use Claude to parse natural language into robot commands."""
        if not ANTHROPIC_API_KEY:
            return None

        status = self.get_status()
        system_prompt = (
            "You are the brain of an autonomous robot. Parse the user's text message into a robot command.\n"
            "Available commands: forward <feet>, backward <feet>, turn left <degrees>, turn right <degrees>, "
            "explore, stop, go home, set home, status\n"
            f"Current status: position=({status['position']['x_mm']}mm, {status['position']['y_mm']}mm), "
            f"heading={status['position']['heading_deg']}deg, "
            f"front_obstacle={status['obstacles']['front_cm']}cm, "
            f"battery={status['battery_v']}V, task={status['task']}\n\n"
            "Respond with ONLY a JSON object: {\"command\": \"<command string>\", \"reply\": \"<friendly short reply to user>\"}\n"
            "Examples:\n"
            "User: 'go forward 6' -> {\"command\": \"forward 6\", \"reply\": \"Moving forward 6 feet\"}\n"
            "User: 'turn around' -> {\"command\": \"turn right 180\", \"reply\": \"Turning around\"}\n"
            "User: 'come back' -> {\"command\": \"go home\", \"reply\": \"Heading home\"}\n"
            "User: 'look around' -> {\"command\": \"explore\", \"reply\": \"Exploring the area\"}\n"
            "User: 'whats in front of you' -> {\"command\": \"status\", \"reply\": \"Front is clear at 120cm\"}\n"
        )

        try:
            body = json.dumps({
                "model": CLAUDE_MODEL,
                "max_tokens": 150,
                "system": system_prompt,
                "messages": [{"role": "user", "content": user_text}]
            }).encode()

            req = urllib.request.Request(
                "https://api.anthropic.com/v1/messages",
                data=body,
                headers={
                    "Content-Type": "application/json",
                    "x-api-key": ANTHROPIC_API_KEY,
                    "anthropic-version": "2023-06-01"
                }
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                result = json.loads(resp.read())
                text_response = result["content"][0]["text"]
                # Parse JSON from response
                parsed = json.loads(text_response)
                return parsed
        except Exception as e:
            print(f"[CLAUDE] Error: {e}")
            return None

    # ========== Text message command parsing ==========

    def parse_text_command(self, text):
        """Parse a natural language text command. Returns (action, result_str)."""
        text = text.strip().lower()

        # Stop
        if text in ["stop", "halt", "freeze", "e stop", "estop", "quit"]:
            return "stop", self.stop()

        # Status
        if text in ["status", "where are you", "whats up", "info", "state"]:
            st = self.get_status()
            return "status", (
                f"Task: {st['task']}\n"
                f"Pos: {st['position']['x_mm']}mm, {st['position']['y_mm']}mm\n"
                f"Heading: {st['position']['heading_deg']}deg\n"
                f"Front: {st['obstacles']['front_cm']}cm\n"
                f"Battery: {st['battery_v']}V\n"
                f"Traveled: {st['position']['distance_ft']}ft"
            )

        # Forward
        for prefix in ["go forward", "forward", "fwd", "go ahead", "move forward", "go"]:
            if text.startswith(prefix):
                rest = text[len(prefix):].strip()
                dist = self._parse_distance(rest, default=3.0)
                result = self.go_forward(dist)
                return "forward", result

        # Backward
        for prefix in ["go backward", "go back", "backward", "back", "reverse", "move back"]:
            if text.startswith(prefix):
                rest = text[len(prefix):].strip()
                dist = self._parse_distance(rest, default=3.0)
                result = self.go_backward(dist)
                return "backward", result

        # Turn
        for prefix in ["turn left", "left"]:
            if text.startswith(prefix):
                rest = text[len(prefix):].strip()
                deg = self._parse_number(rest, default=90)
                result = self.turn(-deg)
                return "turn", result

        for prefix in ["turn right", "right"]:
            if text.startswith(prefix):
                rest = text[len(prefix):].strip()
                deg = self._parse_number(rest, default=90)
                result = self.turn(deg)
                return "turn", result

        if text.startswith("turn"):
            rest = text[4:].strip()
            deg = self._parse_number(rest, default=90)
            result = self.turn(deg)
            return "turn", result

        # Explore
        if text in ["explore", "wander", "roam", "look around"]:
            threading.Thread(target=self.explore, daemon=True).start()
            return "explore", "started exploring"

        # Go home
        if text in ["go home", "home", "come back", "return"]:
            result = self.go_home()
            return "home", result

        # Set home
        if text in ["set home", "mark home", "home here"]:
            return "set_home", self.set_home()

        # Fall back to Claude AI for natural language
        claude_result = self.ask_claude(text)
        if claude_result:
            cmd = claude_result.get("command", "")
            reply = claude_result.get("reply", "")
            print(f"[CLAUDE] Parsed '{text}' -> '{cmd}' ({reply})")
            if cmd:
                # Re-parse the extracted command
                action, result = self.parse_text_command(cmd)
                return action, reply or result

        return "unknown", f"Unknown command: {text}. Try: forward 3, back 2, turn left 90, explore, status, stop, go home"

    def _parse_distance(self, text, default=3.0):
        """Parse distance from text like '3', '3 feet', '6ft', '2 meters'."""
        text = text.strip()
        if not text:
            return default
        # Remove units
        multiplier = 1.0
        if "meter" in text or text.endswith("m"):
            multiplier = 3.281  # meters to feet
        text = text.replace("feet", "").replace("foot", "").replace("ft", "")
        text = text.replace("meters", "").replace("meter", "").replace("m", "")
        text = text.strip()
        try:
            return float(text) * multiplier
        except ValueError:
            return default

    def _parse_number(self, text, default=90):
        """Parse a number from text."""
        text = text.replace("degrees", "").replace("deg", "").replace("°", "").strip()
        try:
            return float(text)
        except ValueError:
            return default

    # ========== SMS Bridge ==========

    def send_sms(self, message):
        """Send text message to phone."""
        try:
            subprocess.run([SEND_SMS, message], timeout=15, capture_output=True)
        except Exception as e:
            print(f"[SMS] Error: {e}")

    def sms_loop(self):
        """Check for incoming text messages and execute commands."""
        INBOX = os.path.expanduser("~/.claude/mobile-inbox.txt")
        print("[SMS] Watching for text messages...")
        while self.running:
            try:
                if os.path.exists(INBOX) and os.path.getsize(INBOX) > 0:
                    with open(INBOX, 'r') as f:
                        messages = f.read().strip().split('\n')
                    # Clear inbox
                    with open(INBOX, 'w') as f:
                        f.write("")

                    for msg in messages:
                        msg = msg.strip()
                        if not msg:
                            continue
                        print(f"[SMS] Received: {msg}")
                        action, result = self.parse_text_command(msg)
                        print(f"[SMS] Result: {result}")
                        # Send result back via text
                        self.send_sms(f"Robot: {result}")
            except Exception as e:
                print(f"[SMS] Error: {e}")

            time.sleep(3)

    # ========== Main run ==========

    def run(self):
        """Start the brain."""
        print("=" * 50)
        print("  ROBOT BRAIN - Autonomous Movement")
        print(f"  Server: {VPS_WS}")
        print(f"  API: http://localhost:{API_PORT}")
        print(f"  SMS: watching ~/.claude/mobile-inbox.txt")
        print("=" * 50)

        # Start SMS watcher
        sms_thread = threading.Thread(target=self.sms_loop, daemon=True)
        sms_thread.start()

        # Start HTTP API
        api_thread = threading.Thread(target=self._run_api, daemon=True)
        api_thread.start()

        # WebSocket connection loop
        while self.running:
            try:
                print(f"[WS] Connecting to {VPS_WS}...")
                ws_app = websocket.WebSocketApp(
                    VPS_WS,
                    on_open=self.on_open,
                    on_close=self.on_close,
                    on_error=self.on_error,
                    on_message=self.on_message
                )
                self.ws = ws_app
                ws_app.run_forever(ping_interval=30, ping_timeout=10)
            except Exception as e:
                print(f"[WS] Error: {e}")
                self.connected = False

            if self.running:
                print("[WS] Reconnecting in 3s...")
                time.sleep(3)

    def _run_api(self):
        """Run HTTP API server."""
        brain = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == "/status":
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps(brain.get_status()).encode())
                else:
                    self.send_response(404)
                    self.end_headers()

            def do_POST(self):
                if self.path == "/command":
                    length = int(self.headers.get("Content-Length", 0))
                    body = json.loads(self.rfile.read(length)) if length else {}

                    action = body.get("action", "")
                    value = body.get("value", None)

                    # Execute in background thread so API responds immediately
                    def run_cmd():
                        if action == "forward":
                            brain.go_forward(float(value or 3))
                        elif action == "backward":
                            brain.go_backward(float(value or 3))
                        elif action == "turn":
                            brain.turn(float(value or 90))
                        elif action == "explore":
                            brain.explore()
                        elif action == "go_home":
                            brain.go_home()
                        elif action == "stop":
                            brain.stop()
                        elif action == "set_home":
                            brain.set_home()
                        elif action == "text":
                            # Natural language command
                            _, result = brain.parse_text_command(str(value or ""))
                            brain.status_msg = result

                    if action == "stop":
                        brain.stop()
                    else:
                        threading.Thread(target=run_cmd, daemon=True).start()

                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({
                        "status": "ok",
                        "action": action,
                        "task": brain.current_task or "idle"
                    }).encode())

                elif self.path == "/text":
                    # Natural language text command
                    length = int(self.headers.get("Content-Length", 0))
                    body = json.loads(self.rfile.read(length)) if length else {}
                    text = body.get("text", "")

                    def run_text():
                        brain.parse_text_command(text)

                    threading.Thread(target=run_text, daemon=True).start()

                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({
                        "status": "ok",
                        "command": text
                    }).encode())
                else:
                    self.send_response(404)
                    self.end_headers()

            def log_message(self, format, *args):
                pass  # Suppress HTTP logs

        server = HTTPServer(("0.0.0.0", API_PORT), Handler)
        print(f"[API] Listening on port {API_PORT}")
        server.serve_forever()


def main():
    brain = RobotBrain()
    try:
        brain.run()
    except KeyboardInterrupt:
        print("\n[BRAIN] Shutting down...")
        brain.running = False
        brain.stop()


if __name__ == "__main__":
    main()
