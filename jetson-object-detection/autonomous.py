#!/usr/bin/env python3
"""
Autonomous Mapping Navigation - Jetson
FULL SENSOR FUSION: LIDAR + Cameras + GPS + Compass + Ultrasonics
Uses all available data to navigate safely and build maps
Now with indoor SLAM mapping!
"""

import json
import time
import math
import threading
import os
from collections import deque
import websocket

# Import indoor mapping system
from mapping import OccupancyGrid, IndoorLocalizer
# Import visual mapping system
try:
    from visual_mapping import VisualMapper
    VISUAL_MAPPING_AVAILABLE = True
except ImportError as e:
    print(f"[VISUAL] Visual mapping not available: {e}")
    VISUAL_MAPPING_AVAILABLE = False

# Import semantic mapping system
try:
    from semantic_map import SemanticMap
    SEMANTIC_MAPPING_AVAILABLE = True
except ImportError as e:
    print(f"[SEMANTIC] Semantic mapping not available: {e}")
    SEMANTIC_MAPPING_AVAILABLE = False

# VPS WebSocket
VPS_WS = "ws://72.60.124.34:3001"

# Navigation parameters - 16 inches = 40cm stop distance
SAFE_DISTANCE_CM = 50      # Start slowing down (~20 inches)
STOP_DISTANCE_CM = 40      # Hard stop (~16 inches) - ultrasonics trigger this
CRITICAL_DISTANCE_CM = 30  # Emergency backup (~12 inches)
TURN_THRESHOLD_CM = 120    # Need 1.2m clear to keep going forward
OPEN_PATH_CM = 200         # Consider path "open" if >2m clear
SCAN_SECTORS = 12          # Divide 360° into sectors
SPEED_SLOW = 10            # Slow speed
SPEED_NORMAL = 20          # Normal mapping speed
SPEED_FAST = 30            # Fast when path is wide open
MIN_FORWARD_TIME = 1.5     # Commit to forward for 1.5 seconds
MIN_TURN_TIME = 0.5        # Quick turns to find openings faster

# Camera-based collision avoidance
CAM_PATH_WIDTH = 0.4       # Center 40% of frame is "in path"
CAM_CLOSE_THRESHOLD = 0.5  # Object filling >50% of frame height = very close
CAM_MEDIUM_THRESHOLD = 0.3 # Object filling >30% = medium distance

# Priority objects to stop for (living things and vehicles)
PRIORITY_OBJECTS = {
    # People
    "person", "boy", "girl", "man", "woman", "human body", "human face",
    # Animals
    "dog", "cat", "bird", "chicken", "duck", "goose", "turkey", "rabbit",
    "deer", "horse", "cow", "sheep", "goat", "pig", "fox", "coyote",
    "bear", "elephant", "lion", "tiger", "wolf", "squirrel", "raccoon",
    # Vehicles (in case they're moving)
    "car", "truck", "van", "bus", "motorcycle", "bicycle", "cart",
    # Other hazards
    "wheelchair", "stroller", "baby carriage"
}

# Map file location
MAP_FILE = os.path.expanduser("~/robot_map.json")

# ========== SENSOR STATE ==========
class SensorState:
    def __init__(self):
        self.lidar_sectors = {}
        self.lidar_points = []            # Raw LIDAR points for mapping
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
        # Encoder tracking for mapping
        self.encoder_left = 0
        self.encoder_right = 0
        self.encoder_updated = 0

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
        self.map_thread = None

        # Initialize indoor mapping system
        print("[MAP] Initializing indoor SLAM mapping...")
        self.occupancy_grid = OccupancyGrid(resolution=5.0, size=800)  # 40m x 40m
        self.localizer = IndoorLocalizer(self.occupancy_grid)

        # Try to load existing map
        if os.path.exists(MAP_FILE):
            if self.occupancy_grid.load_map(MAP_FILE):
                print("[MAP] Loaded saved map!")
                # Restore robot position from map
                self.localizer.x = self.occupancy_grid.robot_x
                self.localizer.y = self.occupancy_grid.robot_y
                self.localizer.theta = self.occupancy_grid.robot_theta
            else:
                print("[MAP] Starting with fresh map")
        else:
            print("[MAP] No saved map found, starting fresh")

        # Map update tracking
        self.last_map_update = 0
        self.map_update_interval = 0.1  # Update map every 100ms (faster learning)
        self.last_map_save = 0
        self.map_save_interval = 60.0   # Auto-save every 60 seconds
        self.last_map_broadcast = 0
        self.map_broadcast_interval = 1.0  # Broadcast map to UI every 1 second (faster updates)

        # Visual mapping system
        self.visual_mapper = None
        self.last_visual_scan_pos = (0, 0)
        self.visual_scan_distance = 200  # Do visual scan every 2 meters
        if VISUAL_MAPPING_AVAILABLE:
            print("[VISUAL] Initializing visual mapper...")

        # Semantic mapping system (zones, objects, look-at)
        self.semantic_map = None
        if SEMANTIC_MAPPING_AVAILABLE:
            print("[SEMANTIC] Initializing semantic mapper...")

    def _init_visual_mapper(self):
        """Initialize visual mapper after WebSocket is connected"""
        if not VISUAL_MAPPING_AVAILABLE or self.visual_mapper is not None:
            return

        def ws_send(data):
            if self.connected and self.ws_app:
                try:
                    self.ws_app.send(json.dumps(data))
                except:
                    pass

        def get_pose():
            return self.localizer.get_pose()

        self.visual_mapper = VisualMapper(ws_send, get_pose)
        print("[VISUAL] Visual mapper ready")

    def _init_semantic_map(self):
        """Initialize semantic map after WebSocket is connected"""
        if not SEMANTIC_MAPPING_AVAILABLE or self.semantic_map is not None:
            return

        def ws_send(data):
            if self.connected and self.ws_app:
                try:
                    self.ws_app.send(json.dumps(data))
                except:
                    pass

        def get_pose():
            return self.localizer.get_pose()

        self.semantic_map = SemanticMap(ws_send, get_pose)
        print(f"[SEMANTIC] Semantic map ready - {len(self.semantic_map.zones)} zones, {len(self.semantic_map.objects)} objects")

    def _process_detections_for_semantic_map(self, camera_id: int, detections: list):
        """Convert camera detections to world coordinates and feed to semantic map"""
        if not self.semantic_map:
            return

        robot_x, robot_y, robot_theta = self.localizer.get_pose()

        # Camera field of view parameters (approximate)
        CAMERA_HFOV = 70  # Horizontal FOV in degrees
        CAMERA_DEPTH_ESTIMATE = 150  # Default depth estimate in cm when unknown

        for det in detections:
            obj_class = det.get("class", "unknown")
            confidence = det.get("confidence", 0.5)

            # Skip low confidence detections
            if confidence < 0.4:
                continue

            # Get bounding box (normalized 0-1)
            bbox = det.get("bbox", {})
            x1 = bbox.get("x1", 0)
            x2 = bbox.get("x2", 1)
            y1 = bbox.get("y1", 0)
            y2 = bbox.get("y2", 1)

            # Calculate object center in frame
            obj_center_x = (x1 + x2) / 2  # 0 = left, 1 = right
            obj_height = y2 - y1  # Bigger = closer

            # Estimate distance from bounding box size (rough approximation)
            # Objects filling more of the frame are closer
            if obj_height > 0.5:
                depth = 50  # Very close, ~50cm
            elif obj_height > 0.3:
                depth = 100  # Close, ~1m
            elif obj_height > 0.15:
                depth = 200  # Medium, ~2m
            else:
                depth = CAMERA_DEPTH_ESTIMATE  # Far, use default

            # Calculate angle from camera center
            # obj_center_x: 0 = left edge, 0.5 = center, 1 = right edge
            angle_offset = (obj_center_x - 0.5) * CAMERA_HFOV  # Degrees from center

            # Adjust for which camera (cam 1 = front, cam 2 = rear)
            if camera_id == 1:
                world_angle = math.degrees(robot_theta) + angle_offset
            else:  # rear camera
                world_angle = math.degrees(robot_theta) + 180 + angle_offset

            world_angle_rad = math.radians(world_angle)

            # Calculate world position
            obj_x = robot_x + depth * math.cos(world_angle_rad)
            obj_y = robot_y + depth * math.sin(world_angle_rad)

            # Estimate object size from bounding box
            width = (x2 - x1) * depth * 0.01 * CAMERA_HFOV  # Rough width estimate
            height = obj_height * depth  # Rough height estimate

            # Add observation to semantic map
            self.semantic_map.add_observation(
                object_type=obj_class,
                x=obj_x,
                y=obj_y,
                z=0,  # Ground level
                width=width,
                height=height,
                confidence=confidence,
                camera_id=camera_id
            )

    def on_open(self, ws):
        """Called when WebSocket connects"""
        print("[WS] Connected to VPS")
        self.connected = True

        # Initialize visual mapper now that WebSocket is connected
        self._init_visual_mapper()

        # Initialize semantic map
        self._init_semantic_map()

        # Send registration
        capabilities = ["navigation", "mapping", "sensor_fusion"]
        if self.visual_mapper:
            capabilities.append("visual_mapping")
        if self.semantic_map:
            capabilities.append("semantic_mapping")

        reg_msg = {
            "type": "JETSON_REGISTER",
            "device": "autonomous",
            "capabilities": capabilities
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

            # Telemetry (torque for collision detection + encoders for mapping)
            elif msg_type == "teensy_telemetry":
                torque_l = abs(data.get("torqueL", 0))
                torque_r = abs(data.get("torqueR", 0))
                if max(torque_l, torque_r) > 12.0:
                    sensors.collision_detected = True
                    print(f"[COLLISION] Torque spike: L={torque_l:.1f} R={torque_r:.1f}")

                # Capture encoder values for indoor localization
                if "posL" in data and "posR" in data:
                    sensors.encoder_left = data.get("posL", 0)
                    sensors.encoder_right = data.get("posR", 0)
                    sensors.encoder_updated = time.time()
                    # Update localizer with encoder data
                    self.localizer.update_from_encoders(
                        sensors.encoder_left,
                        sensors.encoder_right
                    )

            # Camera detections
            elif msg_type == "detections":
                cam = data.get("camera", 1)
                dets = data.get("detections", [])
                if cam == 1:
                    sensors.cam1_detections = dets
                else:
                    sensors.cam2_detections = dets
                sensors.detection_updated = time.time()

                # Feed detections to semantic map for object learning
                if self.semantic_map and dets:
                    self._process_detections_for_semantic_map(cam, dets)

            # Visual mapping commands from UI
            elif msg_type == "visual_scan_start":
                if self.visual_mapper and not self.visual_mapper.scanning:
                    camera_id = data.get("camera", 1)
                    print(f"[VISUAL] Starting 360° scan on camera {camera_id}")
                    self.visual_mapper.start_360_scan(camera_id)

            elif msg_type == "visual_scan_stop":
                if self.visual_mapper:
                    print("[VISUAL] Stopping scan")
                    self.visual_mapper.stop_scan()

            elif msg_type == "visual_map_request":
                if self.visual_mapper:
                    map_data = self.visual_mapper.get_visual_map_data()
                    if self.ws_app:
                        self.ws_app.send(json.dumps(map_data))

            elif msg_type == "recognize_scene":
                if self.visual_mapper:
                    result = self.visual_mapper.recognize_scene(data.get("camera", 1))
                    if result and self.ws_app:
                        self.ws_app.send(json.dumps({
                            "type": "scene_recognition_result",
                            **result
                        }))

            # Camera frame data for visual mapping
            elif msg_type == "camera_frame":
                if self.visual_mapper:
                    cam_id = data.get("camera", 1)
                    frame_data = data.get("frame")  # Base64 encoded
                    if frame_data:
                        import base64
                        frame_bytes = base64.b64decode(frame_data)
                        self.visual_mapper.update_frame(cam_id, frame_bytes)

            # ==================== SEMANTIC MAP COMMANDS ====================

            # Create a new zone
            elif msg_type == "create_zone":
                if self.semantic_map:
                    name = data.get("name", "")
                    x = data.get("x", 0)
                    y = data.get("y", 0)
                    radius = data.get("radius", 100)
                    zone_type = data.get("zone_type", "area")
                    description = data.get("description", "")
                    zone = self.semantic_map.create_zone(name, x, y, radius, zone_type, description)
                    if zone and self.ws_app:
                        self.ws_app.send(json.dumps({
                            "type": "zone_created",
                            "zone": zone.to_dict()
                        }))

            # Delete a zone
            elif msg_type == "delete_zone":
                if self.semantic_map:
                    zone_id = data.get("zone_id")
                    if zone_id:
                        self.semantic_map.delete_zone(zone_id)

            # Update a zone
            elif msg_type == "update_zone":
                if self.semantic_map:
                    zone_id = data.get("zone_id")
                    updates = {k: v for k, v in data.items() if k not in ["type", "zone_id"]}
                    self.semantic_map.update_zone(zone_id, **updates)

            # Rename an object
            elif msg_type == "rename_object":
                if self.semantic_map:
                    object_id = data.get("object_id")
                    new_name = data.get("name", "")
                    if object_id and new_name:
                        self.semantic_map.rename_object(object_id, new_name)

            # Mark object as static/furniture
            elif msg_type == "mark_object_static":
                if self.semantic_map:
                    object_id = data.get("object_id")
                    is_static = data.get("is_static", True)
                    if object_id:
                        self.semantic_map.mark_object_static(object_id, is_static)

            # Look at a named location
            elif msg_type == "look_at":
                if self.semantic_map:
                    query = data.get("query", "")
                    camera_id = data.get("camera", 1)
                    if query:
                        result = self.semantic_map.look_at_location(query, camera_id)
                        if not result and self.ws_app:
                            self.ws_app.send(json.dumps({
                                "type": "look_at_result",
                                "query": query,
                                "found": False
                            }))

            # Look at coordinates
            elif msg_type == "look_at_coords":
                if self.semantic_map:
                    x = data.get("x", 0)
                    y = data.get("y", 0)
                    camera_id = data.get("camera", 1)
                    self.semantic_map.look_at_coordinates(x, y, camera_id)

            # Get full semantic map data
            elif msg_type == "semantic_map_request":
                if self.semantic_map and self.ws_app:
                    map_data = self.semantic_map.get_full_map_data()
                    self.ws_app.send(json.dumps(map_data))

            # Get list of things robot can look at
            elif msg_type == "lookable_targets_request":
                if self.semantic_map and self.ws_app:
                    targets = self.semantic_map.get_lookable_targets()
                    self.ws_app.send(json.dumps(targets))

            # Find location by query
            elif msg_type == "find_location":
                if self.semantic_map and self.ws_app:
                    query = data.get("query", "")
                    result = self.semantic_map.find_location(query)
                    if result:
                        x, y, desc = result
                        self.ws_app.send(json.dumps({
                            "type": "location_found",
                            "query": query,
                            "x": x,
                            "y": y,
                            "description": desc
                        }))
                    else:
                        self.ws_app.send(json.dumps({
                            "type": "location_found",
                            "query": query,
                            "found": False
                        }))

            # Create zone at current robot position
            elif msg_type == "create_zone_here":
                if self.semantic_map:
                    x, y, _ = self.localizer.get_pose()
                    name = data.get("name", f"zone_{int(x)}_{int(y)}")
                    radius = data.get("radius", 100)
                    zone_type = data.get("zone_type", "area")
                    zone = self.semantic_map.create_zone(name, x, y, radius, zone_type)
                    if zone and self.ws_app:
                        self.ws_app.send(json.dumps({
                            "type": "zone_created",
                            "zone": zone.to_dict()
                        }))

        except Exception as e:
            pass  # Ignore parse errors

    def process_lidar(self, points):
        """Convert LIDAR points to sector distances and update map"""
        sectors = {}
        sector_size = 360 / SCAN_SECTORS
        raw_points = []  # For mapping

        for p in points:
            angle = p[0] if isinstance(p, list) else p.get("angle", 0)
            dist = p[1] if isinstance(p, list) else p.get("distance", 0)

            if dist < 10:  # Invalid
                continue

            sector = int(angle / sector_size) % SCAN_SECTORS
            dist_cm = dist / 10  # mm to cm

            if sector not in sectors or dist_cm < sectors[sector]:
                sectors[sector] = dist_cm

            # Store raw points for mapping (angle in degrees, distance in mm)
            raw_points.append((angle, dist))

        sensors.lidar_sectors = sectors
        sensors.lidar_points = raw_points
        sensors.lidar_updated = time.time()

        # Update indoor map (throttled)
        now = time.time()
        if now - self.last_map_update >= self.map_update_interval:
            self.last_map_update = now
            self.update_map()

        # Auto-save map periodically
        if now - self.last_map_save >= self.map_save_interval:
            self.last_map_save = now
            self.save_map()

    def update_map(self):
        """Update the occupancy grid with current LIDAR scan"""
        if not sensors.lidar_points:
            return

        # Get current pose from localizer
        x, y, theta = self.localizer.get_pose()

        # Update localizer/map with LIDAR scan
        self.localizer.update_from_scan(sensors.lidar_points)

    def save_map(self):
        """Save the current map to file"""
        try:
            self.occupancy_grid.save_map(MAP_FILE)
        except Exception as e:
            print(f"[MAP] Error saving map: {e}")

    def broadcast_map(self):
        """Send map data to UI for visualization"""
        if not self.connected or not self.ws_app:
            return

        try:
            # Get map statistics
            x, y, theta = self.localizer.get_pose()
            static_count = sum(1 for c in self.occupancy_grid.cells.values() if c.is_static)
            total_count = len(self.occupancy_grid.cells)

            msg = {
                "type": "map_status",
                "robot_x": x,
                "robot_y": y,
                "robot_heading": math.degrees(theta),
                "static_cells": static_count,
                "total_cells": total_count,
                "map_coverage": total_count * (self.occupancy_grid.resolution ** 2) / 10000  # sq meters
            }
            self.ws_app.send(json.dumps(msg))

            # Also send cell data for 3D visualization (every other broadcast)
            if self.total_scans % 2 == 0:
                self.broadcast_map_cells()

        except Exception as e:
            pass

    @property
    def total_scans(self):
        return self.occupancy_grid.total_scans

    def broadcast_map_cells(self):
        """Send map cell positions for 3D visualization"""
        if not self.connected or not self.ws_app:
            return

        try:
            resolution = self.occupancy_grid.resolution
            static_cells = []
            dynamic_cells = []
            free_cells = []

            # Get robot position for relative coordinates
            robot_x, robot_y, _ = self.localizer.get_pose()

            # Limit to cells within 5 meters of robot for performance
            max_dist = 500  # 5 meters in cm

            for (gx, gy), cell in self.occupancy_grid.cells.items():
                # Convert to world coordinates (cm)
                wx, wy = self.occupancy_grid.grid_to_world(gx, gy)

                # Only send cells near the robot
                dist = math.sqrt((wx - robot_x)**2 + (wy - robot_y)**2)
                if dist > max_dist:
                    continue

                # Convert to meters for Three.js (relative to robot)
                rel_x = (wx - robot_x) / 100.0
                rel_y = (wy - robot_y) / 100.0

                if cell.is_static:
                    static_cells.append([round(rel_x, 2), round(rel_y, 2)])
                elif cell.is_occupied:
                    dynamic_cells.append([round(rel_x, 2), round(rel_y, 2)])
                elif cell.is_free and cell.confidence < 0.2:
                    # Only send very confident free cells
                    free_cells.append([round(rel_x, 2), round(rel_y, 2)])

            # Limit cell counts to avoid huge messages
            max_cells = 500
            if len(static_cells) > max_cells:
                static_cells = static_cells[:max_cells]
            if len(dynamic_cells) > max_cells:
                dynamic_cells = dynamic_cells[:max_cells]
            if len(free_cells) > max_cells:
                free_cells = free_cells[:max_cells]

            msg = {
                "type": "map_cells",
                "resolution": resolution / 100.0,  # Convert to meters
                "static": static_cells,
                "dynamic": dynamic_cells,
                "free": free_cells
            }
            self.ws_app.send(json.dumps(msg))

        except Exception as e:
            print(f"[MAP] Error broadcasting cells: {e}")

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

    def check_camera_obstacle(self, direction="FORWARD"):
        """
        Check camera detections for obstacles in path.
        Returns: (should_stop, should_slow, object_name) or (False, False, None)
        """
        now = time.time()

        # Only use recent detections (within 2 seconds)
        if (now - sensors.detection_updated) > 2.0:
            return False, False, None

        # Choose camera based on direction
        if direction == "FORWARD":
            detections = sensors.cam1_detections  # Front camera
        elif direction == "REVERSE":
            detections = sensors.cam2_detections  # Rear camera
        else:
            return False, False, None

        if not detections:
            return False, False, None

        # Check each detection
        for det in detections:
            obj_class = det.get("class", "").lower()

            # Only care about priority objects
            if obj_class not in PRIORITY_OBJECTS:
                continue

            # Get bounding box (normalized 0-1)
            bbox = det.get("bbox", {})
            x1 = bbox.get("x1", 0)
            x2 = bbox.get("x2", 1)
            y1 = bbox.get("y1", 0)
            y2 = bbox.get("y2", 1)

            # Check if object is in the path (center portion of frame)
            obj_center_x = (x1 + x2) / 2
            path_left = (1 - CAM_PATH_WIDTH) / 2    # 0.3
            path_right = 1 - path_left               # 0.7

            if not (path_left < obj_center_x < path_right):
                continue  # Object is to the side, not in path

            # Estimate proximity from bounding box height
            obj_height = y2 - y1

            if obj_height > CAM_CLOSE_THRESHOLD:
                # Very close - stop!
                print(f"[CAM] STOP - {obj_class} in path, size={obj_height:.2f}")
                return True, False, obj_class
            elif obj_height > CAM_MEDIUM_THRESHOLD:
                # Medium distance - slow down
                print(f"[CAM] SLOW - {obj_class} approaching, size={obj_height:.2f}")
                return False, True, obj_class

        return False, False, None

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

        # Camera-based obstacle detection (priority objects like people/animals)
        cam_direction = "FORWARD" if sensors.last_direction != "REVERSE" else "REVERSE"
        cam_stop, cam_slow, cam_object = self.check_camera_obstacle(cam_direction)

        if cam_stop:
            # Priority object very close - immediate stop
            self.stop_robot()
            sensors.committed_action = None
            return f"CAM_STOP ({cam_object} in path)"

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

        # Get all ultrasonic readings
        us_front = min(sensors.us_fl if sensors.us_fl > 0 else 999,
                       sensors.us_fr if sensors.us_fr > 0 else 999)
        us_rear = min(sensors.us_rl if sensors.us_rl > 0 else 999,
                      sensors.us_rr if sensors.us_rr > 0 else 999)

        # If ultrasonics see obstacle in front, find clear direction
        if us_front < STOP_DISTANCE_CM and us_front > 0:
            print(f"[NAV] Ultrasonic obstacle front: {us_front:.0f}cm - finding clear path")
            # Check which way is clearer
            if us_rear > SAFE_DISTANCE_CM:
                # Back up to get room
                self.reverse(SPEED_SLOW)
                sensors.committed_action = "REVERSE"
                sensors.commit_until = now + 1.0
                return f"BACKUP (ultrasonic front={us_front:.0f}cm, rear clear={us_rear:.0f}cm)"
            elif open_dist > TURN_THRESHOLD_CM:
                # Turn toward open path
                if open_dir == "LEFT":
                    self.turn_left(SPEED_NORMAL)
                elif open_dir == "RIGHT":
                    self.turn_right(SPEED_NORMAL)
                sensors.committed_action = open_dir
                sensors.commit_until = now + MIN_TURN_TIME
                return f"TURN_{open_dir} (ultrasonic blocked, open={open_dist:.0f}cm)"

        # LIDAR says too close - back up or go around
        if lidar_front < STOP_DISTANCE_CM:
            print(f"[NAV] LIDAR obstacle: {lidar_front:.0f}cm - finding escape")
            sensors.committed_action = None

            # First choice: back up if rear is clear
            if us_rear > SAFE_DISTANCE_CM:
                self.reverse(SPEED_NORMAL)
                sensors.committed_action = "REVERSE"
                sensors.commit_until = now + 1.0
                return f"BACKUP (lidar front={lidar_front:.0f}cm, rear clear={us_rear:.0f}cm)"

            # Second choice: turn toward open path
            if open_dist > TURN_THRESHOLD_CM:
                if open_dir == "LEFT":
                    self.turn_left(SPEED_NORMAL)
                elif open_dir == "RIGHT":
                    self.turn_right(SPEED_NORMAL)
                else:
                    self.reverse(SPEED_SLOW)
                sensors.committed_action = open_dir
                sensors.commit_until = now + MIN_TURN_TIME
                return f"ESCAPE_{open_dir} (lidar blocked, open={open_dist:.0f}cm)"

            # Last resort: spin to find any opening
            if right > left:
                self.turn_right(SPEED_SLOW)
            else:
                self.turn_left(SPEED_SLOW)
            sensors.commit_until = now + 0.5
            return f"SEARCHING (trapped, looking for exit)"

        # If we're committed to an action and it's still safe, continue
        if sensors.committed_action and now < sensors.commit_until:
            # But check if we're about to hit something (use both sensors + camera)
            min_front = min(lidar_front, us_front)
            if sensors.committed_action == "FORWARD" and (min_front < STOP_DISTANCE_CM or cam_stop):
                sensors.committed_action = None  # Abort forward - obstacle detected
                if cam_stop:
                    print(f"[NAV] Abort forward - camera sees {cam_object}")
                else:
                    print(f"[NAV] Abort forward - obstacle at {min_front:.0f}cm")
            elif sensors.committed_action == "REVERSE" and cam_stop:
                sensors.committed_action = None  # Abort reverse - camera sees something behind
                print(f"[NAV] Abort reverse - camera sees {cam_object}")
            else:
                return f"COMMITTED {sensors.committed_action}"

        # Decide new action - prefer the most open direction
        # If camera sees priority object approaching, limit speed
        if lidar_front > OPEN_PATH_CM:
            # Wide open ahead - go fast (unless camera sees something)
            if cam_slow:
                self.move_forward(SPEED_SLOW)
                sensors.committed_action = "FORWARD"
                sensors.commit_until = now + MIN_FORWARD_TIME * 0.5
                return f"FORWARD_SLOW (cam: {cam_object} ahead)"
            else:
                self.move_forward(SPEED_FAST)
                sensors.committed_action = "FORWARD"
                sensors.commit_until = now + MIN_FORWARD_TIME * 2
                return f"FORWARD_FAST (clear: {lidar_front:.0f}cm)"

        elif lidar_front > TURN_THRESHOLD_CM:
            # Good path ahead
            if cam_slow:
                self.move_forward(SPEED_SLOW)
                sensors.committed_action = "FORWARD"
                sensors.commit_until = now + MIN_FORWARD_TIME * 0.5
                return f"FORWARD_SLOW (cam: {cam_object} ahead)"
            else:
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
        last_decay = 0
        decay_interval = 10.0  # Decay dynamic obstacles every 10 seconds

        while self.running:
            time.sleep(0.05)

            if not self.connected:
                continue

            now = time.time()

            # Decay old dynamic obstacles
            if now - last_decay > decay_interval:
                last_decay = now
                self.occupancy_grid.decay_dynamic()

            # Broadcast map status to UI
            if now - self.last_map_broadcast > self.map_broadcast_interval:
                self.last_map_broadcast = now
                self.broadcast_map()

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
        print("  AUTONOMOUS MAPPING - INDOOR SLAM")
        print("  LIDAR + Cameras + Encoders + Ultrasonics")
        print("  Stop distance: 40cm (16 inches)")
        print("  Map resolution: 5cm, Coverage: 40m x 40m")
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

        # Save map on shutdown
        print("[MAP] Saving map before shutdown...")
        self.save_map()
        static_count = sum(1 for c in self.occupancy_grid.cells.values() if c.is_static)
        print(f"[MAP] Saved {static_count} static cells to {MAP_FILE}")

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
