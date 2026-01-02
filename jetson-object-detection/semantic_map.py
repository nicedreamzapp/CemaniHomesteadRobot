#!/usr/bin/env python3
"""
Semantic Mapping System - Jetson
Learns and remembers named locations, zones, and objects
Enables spatial awareness: "look at dishwasher", "go to couch area"
"""

import sqlite3
import json
import math
import time
import os
import threading
import numpy as np
from datetime import datetime
from dataclasses import dataclass, field
from typing import List, Tuple, Optional, Dict, Callable
from collections import defaultdict

# Configuration
DB_PATH = os.path.expanduser("~/robot_semantic_map.db")
OBJECT_PERSISTENCE_THRESHOLD = 3  # Times seen in same spot to become "persistent" (was 5 - faster learning)
OBJECT_LOCATION_TOLERANCE = 50  # cm - how close detections must be to count as same object
ZONE_MIN_OBSERVATIONS = 5  # Observations needed to auto-create a zone (was 10 - faster learning)
ZONE_CLUSTER_RADIUS = 100  # cm - cluster radius for auto-zone detection
STALE_OBJECT_DAYS = 7  # Days before object is considered stale


@dataclass
class SemanticZone:
    """A named area in the environment"""
    zone_id: int
    name: str
    center_x: float  # cm
    center_y: float  # cm
    radius: float  # cm - circular zone
    floor_level: int = 0  # For multi-floor support
    zone_type: str = "area"  # area, furniture, appliance, storage
    description: str = ""
    created_at: float = field(default_factory=time.time)
    last_visited: float = field(default_factory=time.time)
    visit_count: int = 0
    confidence: float = 1.0  # 0-1, how sure we are this zone exists
    metadata: Dict = field(default_factory=dict)

    def contains_point(self, x: float, y: float) -> bool:
        """Check if a point is within this zone"""
        dist = math.sqrt((x - self.center_x)**2 + (y - self.center_y)**2)
        return dist <= self.radius

    def distance_to(self, x: float, y: float) -> float:
        """Distance from point to zone center"""
        return math.sqrt((x - self.center_x)**2 + (y - self.center_y)**2)

    def to_dict(self) -> Dict:
        return {
            "zone_id": self.zone_id,
            "name": self.name,
            "center_x": self.center_x,
            "center_y": self.center_y,
            "radius": self.radius,
            "floor_level": self.floor_level,
            "zone_type": self.zone_type,
            "description": self.description,
            "visit_count": self.visit_count,
            "confidence": self.confidence
        }


@dataclass
class PersistentObject:
    """An object seen multiple times in the same location"""
    object_id: int
    object_type: str  # person, dog, cat, chair, cup, etc.
    name: str  # User-assigned name or auto-generated
    x: float  # cm
    y: float  # cm
    z: float = 0  # cm - height off ground
    width: float = 0  # Estimated size
    height: float = 0
    times_seen: int = 1
    first_seen: float = field(default_factory=time.time)
    last_seen: float = field(default_factory=time.time)
    is_static: bool = False  # True for furniture, appliances
    zone_id: Optional[int] = None  # Which zone it belongs to
    confidence: float = 0.5
    visual_signature: Optional[bytes] = None  # Thumbnail for recognition
    metadata: Dict = field(default_factory=dict)

    def distance_to(self, x: float, y: float) -> float:
        return math.sqrt((x - self.x)**2 + (y - self.y)**2)

    def to_dict(self) -> Dict:
        return {
            "object_id": self.object_id,
            "object_type": self.object_type,
            "name": self.name,
            "x": self.x,
            "y": self.y,
            "z": self.z,
            "times_seen": self.times_seen,
            "is_static": self.is_static,
            "zone_id": self.zone_id,
            "confidence": self.confidence,
            "last_seen": self.last_seen
        }


@dataclass
class ObjectObservation:
    """A single observation of an object"""
    object_type: str
    x: float
    y: float
    z: float
    width: float
    height: float
    confidence: float
    timestamp: float
    camera_id: int
    robot_x: float
    robot_y: float
    robot_heading: float


class SemanticMap:
    """
    Main semantic mapping controller
    Manages zones, objects, and spatial queries
    """

    def __init__(self, ws_send_func: Callable = None, get_pose_func: Callable = None):
        self.send = ws_send_func or (lambda x: None)
        self.get_pose = get_pose_func or (lambda: (0, 0, 0))

        self.zones: Dict[int, SemanticZone] = {}
        self.objects: Dict[int, PersistentObject] = {}
        self.pending_observations: List[ObjectObservation] = []

        self.lock = threading.Lock()
        self._init_database()
        self._load_from_database()

        # Start background processing
        self.running = True
        self.process_thread = threading.Thread(target=self._process_loop, daemon=True)
        self.process_thread.start()

        print(f"[SEMANTIC] Loaded {len(self.zones)} zones, {len(self.objects)} objects")

    def _init_database(self):
        """Initialize SQLite database"""
        os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()

        # Zones table
        c.execute('''CREATE TABLE IF NOT EXISTS zones (
            zone_id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            center_x REAL NOT NULL,
            center_y REAL NOT NULL,
            radius REAL NOT NULL,
            floor_level INTEGER DEFAULT 0,
            zone_type TEXT DEFAULT 'area',
            description TEXT DEFAULT '',
            created_at REAL,
            last_visited REAL,
            visit_count INTEGER DEFAULT 0,
            confidence REAL DEFAULT 1.0,
            metadata TEXT DEFAULT '{}'
        )''')

        # Objects table
        c.execute('''CREATE TABLE IF NOT EXISTS objects (
            object_id INTEGER PRIMARY KEY AUTOINCREMENT,
            object_type TEXT NOT NULL,
            name TEXT,
            x REAL NOT NULL,
            y REAL NOT NULL,
            z REAL DEFAULT 0,
            width REAL DEFAULT 0,
            height REAL DEFAULT 0,
            times_seen INTEGER DEFAULT 1,
            first_seen REAL,
            last_seen REAL,
            is_static INTEGER DEFAULT 0,
            zone_id INTEGER,
            confidence REAL DEFAULT 0.5,
            visual_signature BLOB,
            metadata TEXT DEFAULT '{}',
            FOREIGN KEY (zone_id) REFERENCES zones(zone_id)
        )''')

        # Observations history (for learning patterns)
        c.execute('''CREATE TABLE IF NOT EXISTS observations (
            obs_id INTEGER PRIMARY KEY AUTOINCREMENT,
            object_type TEXT NOT NULL,
            x REAL NOT NULL,
            y REAL NOT NULL,
            z REAL DEFAULT 0,
            confidence REAL,
            timestamp REAL,
            robot_x REAL,
            robot_y REAL,
            robot_heading REAL
        )''')

        # Create indexes
        c.execute('CREATE INDEX IF NOT EXISTS idx_objects_type ON objects(object_type)')
        c.execute('CREATE INDEX IF NOT EXISTS idx_objects_zone ON objects(zone_id)')
        c.execute('CREATE INDEX IF NOT EXISTS idx_obs_type ON observations(object_type)')
        c.execute('CREATE INDEX IF NOT EXISTS idx_obs_time ON observations(timestamp)')

        conn.commit()
        conn.close()

    def _load_from_database(self):
        """Load zones and objects from database"""
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()

        # Load zones
        c.execute('SELECT * FROM zones')
        for row in c.fetchall():
            zone = SemanticZone(
                zone_id=row[0],
                name=row[1],
                center_x=row[2],
                center_y=row[3],
                radius=row[4],
                floor_level=row[5],
                zone_type=row[6],
                description=row[7],
                created_at=row[8] or time.time(),
                last_visited=row[9] or time.time(),
                visit_count=row[10],
                confidence=row[11],
                metadata=json.loads(row[12] or '{}')
            )
            self.zones[zone.zone_id] = zone

        # Load objects
        c.execute('SELECT * FROM objects')
        for row in c.fetchall():
            obj = PersistentObject(
                object_id=row[0],
                object_type=row[1],
                name=row[2] or row[1],
                x=row[3],
                y=row[4],
                z=row[5],
                width=row[6],
                height=row[7],
                times_seen=row[8],
                first_seen=row[9] or time.time(),
                last_seen=row[10] or time.time(),
                is_static=bool(row[11]),
                zone_id=row[12],
                confidence=row[13],
                visual_signature=row[14],
                metadata=json.loads(row[15] or '{}')
            )
            self.objects[obj.object_id] = obj

        conn.close()

    def _process_loop(self):
        """Background loop to process observations and update map"""
        while self.running:
            try:
                self._process_pending_observations()
                self._update_zone_visits()
                self._cleanup_stale_objects()
            except Exception as e:
                print(f"[SEMANTIC] Process error: {e}")
            time.sleep(1.0)

    def _process_pending_observations(self):
        """Process pending object observations"""
        with self.lock:
            if not self.pending_observations:
                return
            observations = self.pending_observations.copy()
            self.pending_observations.clear()

        for obs in observations:
            self._integrate_observation(obs)

    def _integrate_observation(self, obs: ObjectObservation):
        """Integrate a single observation into the map"""
        # Find nearby existing object of same type
        nearest_obj = None
        nearest_dist = float('inf')

        for obj in self.objects.values():
            if obj.object_type != obs.object_type:
                continue
            dist = obj.distance_to(obs.x, obs.y)
            if dist < OBJECT_LOCATION_TOLERANCE and dist < nearest_dist:
                nearest_obj = obj
                nearest_dist = dist

        if nearest_obj:
            # Update existing object
            self._update_object(nearest_obj, obs)
        else:
            # Create new object
            self._create_object(obs)

        # Store observation in database for pattern learning
        self._store_observation(obs)

    def _update_object(self, obj: PersistentObject, obs: ObjectObservation):
        """Update existing object with new observation"""
        # Running average of position
        alpha = 0.3  # How much to weight new observation
        obj.x = obj.x * (1 - alpha) + obs.x * alpha
        obj.y = obj.y * (1 - alpha) + obs.y * alpha
        obj.z = obj.z * (1 - alpha) + obs.z * alpha

        obj.times_seen += 1
        obj.last_seen = obs.timestamp
        obj.confidence = min(1.0, obj.confidence + 0.1)

        # Mark as static if seen many times in same spot
        if obj.times_seen >= OBJECT_PERSISTENCE_THRESHOLD and not obj.is_static:
            obj.is_static = True
            print(f"[SEMANTIC] Object '{obj.name}' is now persistent (seen {obj.times_seen}x)")

        # Assign to zone if not already
        if obj.zone_id is None:
            for zone in self.zones.values():
                if zone.contains_point(obj.x, obj.y):
                    obj.zone_id = zone.zone_id
                    break

        # Save to database
        self._save_object(obj)

    def _create_object(self, obs: ObjectObservation):
        """Create new object from observation"""
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()

        # Find zone
        zone_id = None
        for zone in self.zones.values():
            if zone.contains_point(obs.x, obs.y):
                zone_id = zone.zone_id
                break

        # Generate name
        name = f"{obs.object_type}_{int(obs.x)}_{int(obs.y)}"

        c.execute('''INSERT INTO objects
            (object_type, name, x, y, z, width, height, times_seen, first_seen, last_seen, zone_id, confidence)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)''',
            (obs.object_type, name, obs.x, obs.y, obs.z, obs.width, obs.height,
             obs.timestamp, obs.timestamp, zone_id, obs.confidence))

        object_id = c.lastrowid
        conn.commit()
        conn.close()

        obj = PersistentObject(
            object_id=object_id,
            object_type=obs.object_type,
            name=name,
            x=obs.x,
            y=obs.y,
            z=obs.z,
            width=obs.width,
            height=obs.height,
            times_seen=1,
            first_seen=obs.timestamp,
            last_seen=obs.timestamp,
            zone_id=zone_id,
            confidence=obs.confidence
        )

        with self.lock:
            self.objects[object_id] = obj

        print(f"[SEMANTIC] New object: {obs.object_type} at ({obs.x:.0f}, {obs.y:.0f})")

    def _save_object(self, obj: PersistentObject):
        """Save object to database"""
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute('''UPDATE objects SET
            x=?, y=?, z=?, times_seen=?, last_seen=?, is_static=?, zone_id=?, confidence=?, metadata=?
            WHERE object_id=?''',
            (obj.x, obj.y, obj.z, obj.times_seen, obj.last_seen, int(obj.is_static),
             obj.zone_id, obj.confidence, json.dumps(obj.metadata), obj.object_id))
        conn.commit()
        conn.close()

    def _store_observation(self, obs: ObjectObservation):
        """Store observation for pattern learning"""
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute('''INSERT INTO observations
            (object_type, x, y, z, confidence, timestamp, robot_x, robot_y, robot_heading)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)''',
            (obs.object_type, obs.x, obs.y, obs.z, obs.confidence, obs.timestamp,
             obs.robot_x, obs.robot_y, obs.robot_heading))
        conn.commit()
        conn.close()

    def _update_zone_visits(self):
        """Update zone visit counts based on robot position"""
        robot_x, robot_y, _ = self.get_pose()

        for zone in self.zones.values():
            if zone.contains_point(robot_x, robot_y):
                zone.last_visited = time.time()
                zone.visit_count += 1

    def _cleanup_stale_objects(self):
        """Remove objects not seen in a long time"""
        stale_threshold = time.time() - (STALE_OBJECT_DAYS * 24 * 3600)

        stale_ids = []
        for obj_id, obj in self.objects.items():
            if not obj.is_static and obj.last_seen < stale_threshold:
                stale_ids.append(obj_id)

        if stale_ids:
            conn = sqlite3.connect(DB_PATH)
            c = conn.cursor()
            for obj_id in stale_ids:
                c.execute('DELETE FROM objects WHERE object_id=?', (obj_id,))
                del self.objects[obj_id]
            conn.commit()
            conn.close()
            print(f"[SEMANTIC] Cleaned up {len(stale_ids)} stale objects")

    # ==================== PUBLIC API ====================

    def add_observation(self, object_type: str, x: float, y: float, z: float = 0,
                       width: float = 0, height: float = 0, confidence: float = 0.5,
                       camera_id: int = 1):
        """Add an object observation from AI detection"""
        robot_x, robot_y, robot_heading = self.get_pose()

        obs = ObjectObservation(
            object_type=object_type,
            x=x, y=y, z=z,
            width=width, height=height,
            confidence=confidence,
            timestamp=time.time(),
            camera_id=camera_id,
            robot_x=robot_x,
            robot_y=robot_y,
            robot_heading=robot_heading
        )

        with self.lock:
            self.pending_observations.append(obs)

    def create_zone(self, name: str, center_x: float, center_y: float, radius: float = 100,
                   zone_type: str = "area", description: str = "") -> Optional[SemanticZone]:
        """Create a new named zone"""
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()

        try:
            c.execute('''INSERT INTO zones
                (name, center_x, center_y, radius, zone_type, description, created_at, last_visited)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)''',
                (name, center_x, center_y, radius, zone_type, description, time.time(), time.time()))

            zone_id = c.lastrowid
            conn.commit()

            zone = SemanticZone(
                zone_id=zone_id,
                name=name,
                center_x=center_x,
                center_y=center_y,
                radius=radius,
                zone_type=zone_type,
                description=description
            )

            with self.lock:
                self.zones[zone_id] = zone

            print(f"[SEMANTIC] Created zone '{name}' at ({center_x:.0f}, {center_y:.0f})")

            # Assign nearby objects to this zone
            self._assign_objects_to_zone(zone)

            # Broadcast update
            self.send({"type": "semantic_zone_created", "zone": zone.to_dict()})

            return zone

        except sqlite3.IntegrityError:
            print(f"[SEMANTIC] Zone '{name}' already exists")
            return None
        finally:
            conn.close()

    def update_zone(self, zone_id: int, **kwargs) -> bool:
        """Update zone properties"""
        if zone_id not in self.zones:
            return False

        zone = self.zones[zone_id]

        for key, value in kwargs.items():
            if hasattr(zone, key):
                setattr(zone, key, value)

        # Save to database
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute('''UPDATE zones SET
            name=?, center_x=?, center_y=?, radius=?, zone_type=?, description=?, confidence=?
            WHERE zone_id=?''',
            (zone.name, zone.center_x, zone.center_y, zone.radius,
             zone.zone_type, zone.description, zone.confidence, zone_id))
        conn.commit()
        conn.close()

        return True

    def delete_zone(self, zone_id: int) -> bool:
        """Delete a zone"""
        if zone_id not in self.zones:
            return False

        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()

        # Unassign objects from this zone
        c.execute('UPDATE objects SET zone_id=NULL WHERE zone_id=?', (zone_id,))
        c.execute('DELETE FROM zones WHERE zone_id=?', (zone_id,))

        conn.commit()
        conn.close()

        with self.lock:
            del self.zones[zone_id]
            for obj in self.objects.values():
                if obj.zone_id == zone_id:
                    obj.zone_id = None

        self.send({"type": "semantic_zone_deleted", "zone_id": zone_id})
        return True

    def rename_object(self, object_id: int, new_name: str) -> bool:
        """Give an object a friendly name"""
        if object_id not in self.objects:
            return False

        obj = self.objects[object_id]
        obj.name = new_name

        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()
        c.execute('UPDATE objects SET name=? WHERE object_id=?', (new_name, object_id))
        conn.commit()
        conn.close()

        return True

    def mark_object_static(self, object_id: int, is_static: bool = True) -> bool:
        """Mark an object as static (furniture) or dynamic"""
        if object_id not in self.objects:
            return False

        obj = self.objects[object_id]
        obj.is_static = is_static
        self._save_object(obj)

        return True

    def _assign_objects_to_zone(self, zone: SemanticZone):
        """Assign objects within zone boundaries"""
        for obj in self.objects.values():
            if obj.zone_id is None and zone.contains_point(obj.x, obj.y):
                obj.zone_id = zone.zone_id
                self._save_object(obj)

    # ==================== SPATIAL QUERIES ====================

    def get_zone_by_name(self, name: str) -> Optional[SemanticZone]:
        """Find zone by name (case-insensitive, partial match)"""
        name_lower = name.lower()

        # Exact match first
        for zone in self.zones.values():
            if zone.name.lower() == name_lower:
                return zone

        # Partial match
        for zone in self.zones.values():
            if name_lower in zone.name.lower():
                return zone

        return None

    def get_object_by_name(self, name: str) -> Optional[PersistentObject]:
        """Find object by name (case-insensitive, partial match)"""
        name_lower = name.lower()

        for obj in self.objects.values():
            if obj.name.lower() == name_lower:
                return obj

        for obj in self.objects.values():
            if name_lower in obj.name.lower():
                return obj

        return None

    def get_objects_by_type(self, object_type: str) -> List[PersistentObject]:
        """Get all objects of a specific type"""
        return [obj for obj in self.objects.values() if obj.object_type == object_type]

    def get_objects_in_zone(self, zone_id: int) -> List[PersistentObject]:
        """Get all objects within a zone"""
        return [obj for obj in self.objects.values() if obj.zone_id == zone_id]

    def get_nearest_object(self, x: float, y: float, object_type: str = None) -> Optional[PersistentObject]:
        """Find nearest object to a point"""
        nearest = None
        nearest_dist = float('inf')

        for obj in self.objects.values():
            if object_type and obj.object_type != object_type:
                continue
            dist = obj.distance_to(x, y)
            if dist < nearest_dist:
                nearest = obj
                nearest_dist = dist

        return nearest

    def get_nearest_zone(self, x: float, y: float) -> Optional[SemanticZone]:
        """Find nearest zone to a point"""
        nearest = None
        nearest_dist = float('inf')

        for zone in self.zones.values():
            dist = zone.distance_to(x, y)
            if dist < nearest_dist:
                nearest = zone
                nearest_dist = dist

        return nearest

    def get_zone_at_point(self, x: float, y: float) -> Optional[SemanticZone]:
        """Get zone containing a point"""
        for zone in self.zones.values():
            if zone.contains_point(x, y):
                return zone
        return None

    def find_location(self, query: str) -> Optional[Tuple[float, float, str]]:
        """
        Find location by name - searches zones and objects
        Returns (x, y, description) or None
        """
        # Try zone first
        zone = self.get_zone_by_name(query)
        if zone:
            return (zone.center_x, zone.center_y, f"zone:{zone.name}")

        # Try object
        obj = self.get_object_by_name(query)
        if obj:
            return (obj.x, obj.y, f"object:{obj.name}")

        # Try object type
        objects = self.get_objects_by_type(query)
        if objects:
            # Return the most confident/seen object
            best = max(objects, key=lambda o: o.times_seen * o.confidence)
            return (best.x, best.y, f"object_type:{best.object_type}")

        return None

    # ==================== LOOK-AT SYSTEM ====================

    def calculate_look_at_angle(self, target_x: float, target_y: float) -> float:
        """
        Calculate pan angle to look at a world position
        Returns angle in degrees (0-360) relative to robot's current heading
        """
        robot_x, robot_y, robot_heading = self.get_pose()

        # Calculate absolute angle to target
        dx = target_x - robot_x
        dy = target_y - robot_y

        # atan2 returns angle in radians, convert to degrees
        # Note: atan2(y, x) gives angle from positive x-axis
        abs_angle = math.degrees(math.atan2(dy, dx))

        # Convert to 0-360 range
        abs_angle = abs_angle % 360

        # Calculate relative angle from robot's heading
        rel_angle = (abs_angle - robot_heading) % 360

        return rel_angle

    def look_at_location(self, query: str, camera_id: int = 1) -> Optional[Dict]:
        """
        Look at a named location
        Returns look-at info or None if not found
        """
        location = self.find_location(query)
        if not location:
            return None

        target_x, target_y, description = location
        pan_angle = self.calculate_look_at_angle(target_x, target_y)
        robot_x, robot_y, robot_heading = self.get_pose()
        distance = math.sqrt((target_x - robot_x)**2 + (target_y - robot_y)**2)

        result = {
            "type": "look_at_result",
            "query": query,
            "found": True,
            "target_x": target_x,
            "target_y": target_y,
            "description": description,
            "pan_angle": pan_angle,
            "distance": distance,
            "camera_id": camera_id
        }

        # Send PTZ command
        self.send({
            "type": "ptz_goto",
            "camera": camera_id,
            "pan": pan_angle,
            "tilt": 0  # Could calculate tilt based on distance/height
        })

        # Broadcast result
        self.send(result)

        print(f"[SEMANTIC] Looking at '{query}' - pan {pan_angle:.1f}° (dist: {distance:.0f}cm)")

        return result

    def look_at_coordinates(self, x: float, y: float, camera_id: int = 1) -> Dict:
        """Look at specific world coordinates"""
        pan_angle = self.calculate_look_at_angle(x, y)
        robot_x, robot_y, _ = self.get_pose()
        distance = math.sqrt((x - robot_x)**2 + (y - robot_y)**2)

        # Send PTZ command
        self.send({
            "type": "ptz_goto",
            "camera": camera_id,
            "pan": pan_angle,
            "tilt": 0
        })

        result = {
            "type": "look_at_result",
            "found": True,
            "target_x": x,
            "target_y": y,
            "pan_angle": pan_angle,
            "distance": distance,
            "camera_id": camera_id
        }

        self.send(result)
        return result

    # ==================== AUTO-LEARNING ====================

    def auto_detect_zones(self) -> List[SemanticZone]:
        """
        Analyze observation patterns to suggest new zones
        Uses clustering of frequent observation locations
        """
        conn = sqlite3.connect(DB_PATH)
        c = conn.cursor()

        # Get observation clusters
        c.execute('''SELECT object_type, AVG(x), AVG(y), COUNT(*) as cnt
            FROM observations
            WHERE timestamp > ?
            GROUP BY object_type,
                CAST(x / ? AS INT),
                CAST(y / ? AS INT)
            HAVING cnt >= ?''',
            (time.time() - 7*24*3600, ZONE_CLUSTER_RADIUS, ZONE_CLUSTER_RADIUS, ZONE_MIN_OBSERVATIONS))

        clusters = c.fetchall()
        conn.close()

        suggested_zones = []
        for obj_type, avg_x, avg_y, count in clusters:
            # Check if zone already exists here
            existing = self.get_zone_at_point(avg_x, avg_y)
            if existing:
                continue

            # Suggest zone based on common object type
            zone_name = f"{obj_type}_area_{int(avg_x)}_{int(avg_y)}"
            suggested_zones.append({
                "name": zone_name,
                "center_x": avg_x,
                "center_y": avg_y,
                "radius": ZONE_CLUSTER_RADIUS,
                "object_type": obj_type,
                "observation_count": count
            })

        return suggested_zones

    # ==================== DATA EXPORT ====================

    def get_full_map_data(self) -> Dict:
        """Get complete semantic map for UI display"""
        return {
            "type": "semantic_map_data",
            "zones": [z.to_dict() for z in self.zones.values()],
            "objects": [o.to_dict() for o in self.objects.values()],
            "stats": {
                "total_zones": len(self.zones),
                "total_objects": len(self.objects),
                "static_objects": sum(1 for o in self.objects.values() if o.is_static),
                "dynamic_objects": sum(1 for o in self.objects.values() if not o.is_static)
            }
        }

    def get_lookable_targets(self) -> Dict:
        """Get list of things the robot can look at"""
        targets = []

        # Add zones
        for zone in self.zones.values():
            targets.append({
                "name": zone.name,
                "type": "zone",
                "x": zone.center_x,
                "y": zone.center_y
            })

        # Add static objects
        for obj in self.objects.values():
            if obj.is_static or obj.times_seen >= 3:
                targets.append({
                    "name": obj.name,
                    "type": obj.object_type,
                    "x": obj.x,
                    "y": obj.y
                })

        return {
            "type": "lookable_targets",
            "targets": targets
        }

    def shutdown(self):
        """Clean shutdown"""
        self.running = False
        if self.process_thread.is_alive():
            self.process_thread.join(timeout=2.0)
        print("[SEMANTIC] Shutdown complete")


# ==================== TESTING ====================

if __name__ == "__main__":
    # Test the semantic map
    def mock_send(data):
        print(f"[WS] {json.dumps(data, indent=2)}")

    def mock_pose():
        return (100, 100, 45)  # x, y, heading

    sem_map = SemanticMap(mock_send, mock_pose)

    # Create some test zones
    sem_map.create_zone("kitchen", 0, 300, radius=150, zone_type="room", description="Kitchen area")
    sem_map.create_zone("living_room", 400, 100, radius=200, zone_type="room")
    sem_map.create_zone("dishwasher", 50, 350, radius=50, zone_type="appliance")

    # Add some observations
    sem_map.add_observation("chair", 420, 120, confidence=0.8)
    sem_map.add_observation("chair", 415, 125, confidence=0.9)
    sem_map.add_observation("couch", 380, 80, width=150, height=80, confidence=0.95)

    time.sleep(2)  # Let background process run

    # Test queries
    print("\n--- Testing Queries ---")
    print(f"Find 'kitchen': {sem_map.find_location('kitchen')}")
    print(f"Find 'dishwasher': {sem_map.find_location('dishwasher')}")
    print(f"Find 'chair': {sem_map.find_location('chair')}")

    # Test look-at
    print("\n--- Testing Look-At ---")
    sem_map.look_at_location("dishwasher")
    sem_map.look_at_location("living_room")

    # Get map data
    print("\n--- Map Data ---")
    print(json.dumps(sem_map.get_full_map_data(), indent=2))

    sem_map.shutdown()
