#!/usr/bin/env python3
"""
CEMANI ROBOT - Semantic 3D Mapper
==================================
Adds semantic understanding to the 3D point cloud:

1. Plane Detection: Identifies walls, floor, ceiling using RANSAC
2. Object Projection: Projects Jetson 2D detections into 3D space
3. Room Layout: Estimates room boundaries, doorways, furniture zones

Requirements:
    pip install numpy scipy scikit-learn websockets

This runs alongside hybrid_3d_mapper.py and enhances the point cloud with labels.
"""

import asyncio
import websockets
import json
import time
import math
import numpy as np
from collections import defaultdict
from dataclasses import dataclass, field
from typing import List, Dict, Optional, Tuple, Set
from scipy import stats

try:
    from sklearn.cluster import DBSCAN
    SKLEARN_AVAILABLE = True
except ImportError:
    SKLEARN_AVAILABLE = False
    print("[WARN] scikit-learn not available - clustering disabled")

# ============ CONFIGURATION ============
VPS_WS = "ws://YOUR_VPS_IP:3001"

# Plane detection parameters
RANSAC_ITERATIONS = 100
RANSAC_THRESHOLD = 0.05  # 5cm tolerance for plane fitting
MIN_PLANE_POINTS = 50
WALL_MIN_HEIGHT = 0.5  # Walls must be at least 50cm tall
FLOOR_HEIGHT_TOLERANCE = 0.15  # Floor is within 15cm of lowest point

# Object tracking
OBJECT_MERGE_DISTANCE = 0.5  # Objects within 50cm are same object
OBJECT_PERSISTENCE_TIME = 30.0  # Keep objects for 30s without re-detection
MIN_DETECTION_CONFIDENCE = 0.25

# Room layout
DOORWAY_MIN_WIDTH = 0.6  # Doorways are at least 60cm wide
DOORWAY_MAX_WIDTH = 1.5  # And at most 150cm wide
WALL_GAP_THRESHOLD = 0.3  # Gap in wall detection = potential doorway

# ============ DATA STRUCTURES ============
@dataclass
class Plane:
    """Detected plane (wall, floor, ceiling)"""
    normal: np.ndarray  # Unit normal vector
    d: float  # Distance from origin
    points: np.ndarray  # Points belonging to this plane
    plane_type: str = "unknown"  # wall, floor, ceiling
    bounds: Dict = field(default_factory=dict)  # min/max x,y,z
    confidence: float = 0.0

    def point_distance(self, point: np.ndarray) -> float:
        """Distance from point to plane"""
        return abs(np.dot(self.normal, point) + self.d)

    def to_dict(self) -> Dict:
        center = np.mean(self.points, axis=0) if len(self.points) > 0 else [0, 0, 0]
        return {
            "type": self.plane_type,
            "normal": self.normal.tolist(),
            "center": center.tolist(),
            "bounds": self.bounds,
            "point_count": len(self.points),
            "confidence": round(self.confidence, 2)
        }

@dataclass
class SemanticObject:
    """Detected object in 3D space"""
    class_name: str
    position: np.ndarray  # 3D center position
    size: np.ndarray  # Estimated size (width, height, depth)
    confidence: float
    detections: int = 1  # Number of times detected
    last_seen: float = 0.0
    id: str = ""

    def to_dict(self) -> Dict:
        return {
            "id": self.id,
            "class": self.class_name,
            "position": self.position.tolist(),
            "size": self.size.tolist(),
            "confidence": round(self.confidence, 2),
            "detections": self.detections
        }

@dataclass
class Doorway:
    """Detected doorway/opening"""
    position: np.ndarray  # Center of doorway
    width: float
    wall_normal: np.ndarray  # Normal of the wall containing doorway
    confidence: float = 0.0

    def to_dict(self) -> Dict:
        return {
            "position": self.position.tolist(),
            "width": round(self.width, 2),
            "normal": self.wall_normal.tolist(),
            "confidence": round(self.confidence, 2)
        }

@dataclass
class RoomLayout:
    """Overall room structure"""
    floor_height: float = 0.0
    ceiling_height: float = 2.5
    walls: List[Plane] = field(default_factory=list)
    doorways: List[Doorway] = field(default_factory=list)
    objects: List[SemanticObject] = field(default_factory=list)
    room_bounds: Dict = field(default_factory=dict)

    def to_dict(self) -> Dict:
        return {
            "floor_height": round(self.floor_height, 2),
            "ceiling_height": round(self.ceiling_height, 2),
            "walls": [w.to_dict() for w in self.walls],
            "doorways": [d.to_dict() for d in self.doorways],
            "objects": [o.to_dict() for o in self.objects],
            "room_bounds": self.room_bounds
        }

# ============ SEMANTIC MAPPER ============
class SemanticMapper:
    def __init__(self):
        self.points = np.empty((0, 3))  # Accumulated 3D points
        self.colors = np.empty((0, 3))  # RGB colors
        self.labels = np.empty(0, dtype=int)  # Semantic labels per point

        self.planes: List[Plane] = []
        self.objects: Dict[str, SemanticObject] = {}  # id -> object
        self.layout = RoomLayout()

        # Robot state
        self.robot_pose = {"x": 0, "y": 0, "heading": 0}
        self.camera_poses = {1: {"pan": 0, "tilt": 0}, 2: {"pan": 0, "tilt": 0}}

        # Camera intrinsics (for projecting detections)
        self.cam_fx = 500
        self.cam_fy = 500
        self.cam_cx = 320
        self.cam_cy = 240

        # Timing
        self.last_analysis = 0
        self.ANALYSIS_INTERVAL = 2.0  # Analyze every 2 seconds
        self.last_layout_send = 0
        self.LAYOUT_SEND_INTERVAL = 3.0

        # Stats
        self.stats = {
            "points": 0,
            "planes": 0,
            "objects": 0,
            "doorways": 0
        }

        self.next_object_id = 0

    def update_points(self, points_data: List[Dict]):
        """Update point cloud from hybrid mapper"""
        if not points_data:
            return

        new_points = []
        new_colors = []

        for p in points_data:
            new_points.append([p["x"], p["y"], p["z"]])
            new_colors.append([p.get("r", 128)/255, p.get("g", 128)/255, p.get("b", 128)/255])

        self.points = np.array(new_points)
        self.colors = np.array(new_colors)
        self.labels = np.zeros(len(self.points), dtype=int)
        self.stats["points"] = len(self.points)

    def update_robot_pose(self, x: float, y: float, heading: float):
        """Update robot position"""
        self.robot_pose = {"x": x/1000, "y": y/1000, "heading": math.radians(heading)}

    def update_camera_pose(self, camera: int, pan: float, tilt: float):
        """Update camera PTZ position"""
        self.camera_poses[camera] = {"pan": pan, "tilt": tilt}

    def add_detection(self, camera: int, detection: Dict):
        """Add a 2D detection and project to 3D"""
        class_name = detection.get("class", "unknown")
        confidence = detection.get("confidence", 0)
        bbox = detection.get("bbox", {})

        if confidence < MIN_DETECTION_CONFIDENCE:
            return

        # Get bounding box center in image coordinates
        img_x = bbox.get("x", 0.5) * 640  # Assuming 640x480 image
        img_y = bbox.get("y", 0.5) * 480
        img_w = bbox.get("w", 0.1) * 640
        img_h = bbox.get("h", 0.1) * 480

        # Estimate depth based on object size (rough heuristic)
        # Larger bbox = closer object
        estimated_depth = self._estimate_depth_from_bbox(class_name, img_w, img_h)

        # Project to 3D
        position_3d = self._project_to_3d(camera, img_x, img_y, estimated_depth)
        if position_3d is None:
            return

        # Estimate object size in 3D
        size_3d = self._estimate_size_from_bbox(class_name, img_w, img_h, estimated_depth)

        # Check if this matches an existing object
        matched = self._match_or_create_object(class_name, position_3d, size_3d, confidence)

        if matched:
            print(f"[SEMANTIC] Updated {class_name} at ({position_3d[0]:.1f}, {position_3d[1]:.1f}, {position_3d[2]:.1f})")

    def _estimate_depth_from_bbox(self, class_name: str, bbox_w: float, bbox_h: float) -> float:
        """Estimate depth based on object class and bbox size"""
        # Typical object sizes (width in meters)
        typical_sizes = {
            "person": 0.5,
            "chair": 0.5,
            "table": 1.0,
            "couch": 2.0,
            "tv": 1.0,
            "door": 0.9,
            "window": 1.0,
            "plant": 0.4,
            "lamp": 0.3,
            "curtain": 1.5,
            "tree": 2.0,
        }

        typical_width = typical_sizes.get(class_name.lower(), 0.5)

        # depth = (focal_length * real_width) / pixel_width
        if bbox_w > 10:
            depth = (self.cam_fx * typical_width) / bbox_w
        else:
            depth = 3.0  # Default 3 meters

        return np.clip(depth, 0.5, 10.0)

    def _estimate_size_from_bbox(self, class_name: str, bbox_w: float, bbox_h: float, depth: float) -> np.ndarray:
        """Estimate 3D size from 2D bbox and depth"""
        # Convert pixel dimensions to meters at given depth
        width_3d = (bbox_w * depth) / self.cam_fx
        height_3d = (bbox_h * depth) / self.cam_fy
        depth_3d = min(width_3d, height_3d) * 0.5  # Rough depth estimate

        return np.array([width_3d, height_3d, depth_3d])

    def _project_to_3d(self, camera: int, img_x: float, img_y: float, depth: float) -> Optional[np.ndarray]:
        """Project image point to 3D world coordinates"""
        # Camera to robot transform
        if camera == 1:
            cam_offset = np.array([0, 0.4, -0.1])  # Front camera
            cam_yaw_base = 0
        else:
            cam_offset = np.array([-0.2, 0.55, 0])  # Rear camera
            cam_yaw_base = math.pi

        cam_pose = self.camera_poses.get(camera, {"pan": 0, "tilt": 0})
        pan = math.radians(cam_pose["pan"])
        tilt = math.radians(cam_pose["tilt"])

        # Image to camera 3D
        x_cam = (img_x - self.cam_cx) * depth / self.cam_fx
        y_cam = (img_y - self.cam_cy) * depth / self.cam_fy
        z_cam = depth

        # Apply PTZ rotation
        total_yaw = cam_yaw_base + pan
        cos_yaw = math.cos(total_yaw)
        sin_yaw = math.sin(total_yaw)
        cos_tilt = math.cos(tilt)
        sin_tilt = math.sin(tilt)

        # Rotate by yaw
        x_rot = x_cam * cos_yaw + z_cam * sin_yaw
        z_rot = -x_cam * sin_yaw + z_cam * cos_yaw

        # Rotate by tilt
        y_rot = y_cam * cos_tilt - z_rot * sin_tilt
        z_final = y_cam * sin_tilt + z_rot * cos_tilt

        # Camera to robot frame
        robot_x = x_rot + cam_offset[0]
        robot_y = z_final + cam_offset[2]
        robot_z = -y_rot + cam_offset[1]

        # Robot to world frame
        heading = self.robot_pose["heading"]
        cos_h = math.cos(heading)
        sin_h = math.sin(heading)

        world_x = self.robot_pose["x"] + robot_x * cos_h - robot_y * sin_h
        world_y = self.robot_pose["y"] + robot_x * sin_h + robot_y * cos_h
        world_z = robot_z

        return np.array([world_x, world_y, world_z])

    def _match_or_create_object(self, class_name: str, position: np.ndarray,
                                 size: np.ndarray, confidence: float) -> bool:
        """Match detection to existing object or create new one"""
        now = time.time()

        # Find closest object of same class
        best_match = None
        best_dist = OBJECT_MERGE_DISTANCE

        for obj_id, obj in self.objects.items():
            if obj.class_name.lower() == class_name.lower():
                dist = np.linalg.norm(obj.position - position)
                if dist < best_dist:
                    best_dist = dist
                    best_match = obj_id

        if best_match:
            # Update existing object
            obj = self.objects[best_match]
            alpha = 0.3  # Smoothing factor
            obj.position = obj.position * (1-alpha) + position * alpha
            obj.size = obj.size * (1-alpha) + size * alpha
            obj.confidence = max(obj.confidence, confidence)
            obj.detections += 1
            obj.last_seen = now
            return True
        else:
            # Create new object
            obj_id = f"{class_name}_{self.next_object_id}"
            self.next_object_id += 1

            self.objects[obj_id] = SemanticObject(
                class_name=class_name,
                position=position,
                size=size,
                confidence=confidence,
                last_seen=now,
                id=obj_id
            )
            self.stats["objects"] = len(self.objects)
            return True

    def analyze_planes(self):
        """Detect planes (walls, floor, ceiling) using RANSAC"""
        if len(self.points) < MIN_PLANE_POINTS * 3:
            return

        self.planes = []
        remaining_points = self.points.copy()
        remaining_indices = np.arange(len(self.points))

        # Detect up to 10 planes
        for _ in range(10):
            if len(remaining_points) < MIN_PLANE_POINTS:
                break

            plane = self._ransac_plane(remaining_points)
            if plane is None:
                break

            # Classify plane type based on normal
            plane = self._classify_plane(plane)

            if plane.plane_type != "unknown":
                self.planes.append(plane)

                # Remove inlier points
                distances = np.abs(np.dot(remaining_points, plane.normal) + plane.d)
                outlier_mask = distances > RANSAC_THRESHOLD
                remaining_points = remaining_points[outlier_mask]
                remaining_indices = remaining_indices[outlier_mask]

        self.stats["planes"] = len(self.planes)

        # Update layout
        self._update_layout_from_planes()

    def _ransac_plane(self, points: np.ndarray) -> Optional[Plane]:
        """RANSAC plane fitting"""
        if len(points) < 3:
            return None

        best_plane = None
        best_inliers = 0

        for _ in range(RANSAC_ITERATIONS):
            # Random 3 points
            idx = np.random.choice(len(points), 3, replace=False)
            p1, p2, p3 = points[idx]

            # Compute plane normal
            v1 = p2 - p1
            v2 = p3 - p1
            normal = np.cross(v1, v2)
            norm = np.linalg.norm(normal)
            if norm < 1e-6:
                continue
            normal = normal / norm

            # Plane equation: normal . (p - p1) = 0
            # => normal . p = normal . p1
            d = -np.dot(normal, p1)

            # Count inliers
            distances = np.abs(np.dot(points, normal) + d)
            inliers = np.sum(distances < RANSAC_THRESHOLD)

            if inliers > best_inliers:
                best_inliers = inliers
                inlier_mask = distances < RANSAC_THRESHOLD
                best_plane = Plane(
                    normal=normal,
                    d=d,
                    points=points[inlier_mask],
                    confidence=inliers / len(points)
                )

        if best_inliers < MIN_PLANE_POINTS:
            return None

        return best_plane

    def _classify_plane(self, plane: Plane) -> Plane:
        """Classify plane as wall, floor, or ceiling"""
        normal = plane.normal

        # In our coordinate system:
        # X = left/right, Y = forward/back, Z = height
        # Wall normals point horizontally (mostly X or Y, low Z)
        # Floor/ceiling normals point up/down (mostly Z)
        vertical_component = abs(normal[2])
        horizontal_component = np.sqrt(normal[0]**2 + normal[1]**2)

        # Debug output
        avg_height = np.mean(plane.points[:, 2])
        height_range = np.max(plane.points[:, 2]) - np.min(plane.points[:, 2])

        if vertical_component > 0.7:
            # Horizontal plane (normal pointing up/down)
            if avg_height < FLOOR_HEIGHT_TOLERANCE:
                plane.plane_type = "floor"
            elif avg_height > 2.0:
                plane.plane_type = "ceiling"
            else:
                plane.plane_type = "horizontal_surface"  # Table, shelf, etc.
            print(f"  Plane: {plane.plane_type} at height {avg_height:.2f}m, {len(plane.points)} pts")
        elif horizontal_component > 0.7 and height_range > WALL_MIN_HEIGHT:
            # Vertical plane = wall (normal pointing horizontally, spans height)
            plane.plane_type = "wall"

            # Compute wall bounds
            plane.bounds = {
                "min_x": float(np.min(plane.points[:, 0])),
                "max_x": float(np.max(plane.points[:, 0])),
                "min_y": float(np.min(plane.points[:, 1])),
                "max_y": float(np.max(plane.points[:, 1])),
                "min_z": float(np.min(plane.points[:, 2])),
                "max_z": float(np.max(plane.points[:, 2]))
            }
            print(f"  Plane: WALL, height range {height_range:.2f}m, {len(plane.points)} pts, normal={normal}")
        else:
            # Unknown orientation or too short to be wall
            plane.plane_type = "unknown"
            print(f"  Plane: unknown (vert={vertical_component:.2f}, horiz={horizontal_component:.2f}, hRange={height_range:.2f})")

        return plane

    def _update_layout_from_planes(self):
        """Update room layout from detected planes"""
        walls = [p for p in self.planes if p.plane_type == "wall"]
        floors = [p for p in self.planes if p.plane_type == "floor"]
        ceilings = [p for p in self.planes if p.plane_type == "ceiling"]

        self.layout.walls = walls

        if floors:
            self.layout.floor_height = np.mean([np.mean(f.points[:, 2]) for f in floors])

        if ceilings:
            self.layout.ceiling_height = np.mean([np.mean(c.points[:, 2]) for c in ceilings])

        # Detect doorways as gaps in walls
        self._detect_doorways()

        # Compute room bounds
        if len(self.points) > 0:
            self.layout.room_bounds = {
                "min_x": float(np.min(self.points[:, 0])),
                "max_x": float(np.max(self.points[:, 0])),
                "min_y": float(np.min(self.points[:, 1])),
                "max_y": float(np.max(self.points[:, 1])),
                "min_z": float(np.min(self.points[:, 2])),
                "max_z": float(np.max(self.points[:, 2]))
            }

    def _detect_doorways(self):
        """Detect doorways as gaps in wall planes"""
        self.layout.doorways = []

        for wall in self.layout.walls:
            # Project wall points onto the wall plane
            # Look for gaps in the coverage

            if len(wall.points) < 20:
                continue

            # Get the main direction of the wall (along its length)
            wall_2d = wall.points[:, :2]  # X, Y only

            # Find principal direction
            centered = wall_2d - np.mean(wall_2d, axis=0)
            cov = np.cov(centered.T)
            eigenvalues, eigenvectors = np.linalg.eigh(cov)
            main_dir = eigenvectors[:, np.argmax(eigenvalues)]

            # Project points onto main direction
            projections = np.dot(wall_2d, main_dir)

            # Sort and look for gaps
            sorted_proj = np.sort(projections)
            gaps = np.diff(sorted_proj)

            # Large gaps might be doorways
            for i, gap in enumerate(gaps):
                if DOORWAY_MIN_WIDTH < gap < DOORWAY_MAX_WIDTH:
                    # Found potential doorway
                    gap_center_proj = (sorted_proj[i] + sorted_proj[i+1]) / 2
                    gap_center_2d = np.mean(wall_2d, axis=0) + main_dir * gap_center_proj
                    gap_center_3d = np.array([gap_center_2d[0], gap_center_2d[1], 1.0])  # Assume 1m height

                    doorway = Doorway(
                        position=gap_center_3d,
                        width=gap,
                        wall_normal=wall.normal[:2] if len(wall.normal) >= 2 else np.array([0, 1]),
                        confidence=min(wall.confidence, 0.8)
                    )
                    self.layout.doorways.append(doorway)

        self.stats["doorways"] = len(self.layout.doorways)

    def prune_old_objects(self):
        """Remove objects that haven't been seen recently"""
        now = time.time()
        to_remove = []

        for obj_id, obj in self.objects.items():
            if now - obj.last_seen > OBJECT_PERSISTENCE_TIME:
                to_remove.append(obj_id)

        for obj_id in to_remove:
            del self.objects[obj_id]

        self.stats["objects"] = len(self.objects)

    def should_analyze(self) -> bool:
        """Check if it's time to run analysis"""
        now = time.time()
        if now - self.last_analysis >= self.ANALYSIS_INTERVAL:
            self.last_analysis = now
            return True
        return False

    def should_send_layout(self) -> bool:
        """Check if it's time to send layout update"""
        now = time.time()
        if now - self.last_layout_send >= self.LAYOUT_SEND_INTERVAL:
            self.last_layout_send = now
            return True
        return False

    def get_layout_data(self) -> Dict:
        """Get semantic layout for transmission"""
        # Update objects in layout
        self.layout.objects = list(self.objects.values())

        return {
            "type": "semantic_layout",
            "layout": self.layout.to_dict(),
            "stats": self.stats
        }


# ============ WEBSOCKET CLIENT ============
mapper = SemanticMapper()

async def handle_vps_connection():
    """Connect to VPS and process semantic data"""
    print(f"[SEMANTIC] Connecting to {VPS_WS}...")

    async with websockets.connect(VPS_WS, max_size=10_000_000) as ws:
        print("[SEMANTIC] Connected! Registering...")

        await ws.send(json.dumps({
            "type": "register_processor",
            "name": "semantic-mapper",
            "capabilities": ["plane_detection", "object_tracking", "room_layout"]
        }))

        print("[SEMANTIC] Waiting for data...")
        print("[SEMANTIC] Will detect: walls, floor, ceiling, doorways, objects")

        async for message in ws:
            try:
                if isinstance(message, bytes):
                    continue  # Skip binary frames

                data = json.loads(message)

                # Get accumulated map points
                if data.get("type") == "accumulated_map":
                    points = data.get("points", [])
                    if points:
                        mapper.update_points(points)

                # Get robot pose
                if data.get("type") == "dead_reckoning":
                    mapper.update_robot_pose(
                        data.get("odomX", data.get("x", 0)),
                        data.get("odomY", data.get("y", 0)),
                        data.get("odomHeadingDeg", data.get("heading", 0))
                    )

                # Get camera poses
                if data.get("type") == "ptz_status":
                    mapper.update_camera_pose(
                        data.get("camera", 1),
                        data.get("pan", 0),
                        data.get("tilt", 0)
                    )

                # Get Jetson detections
                if data.get("type") == "DETECTIONS":
                    camera = data.get("camera", 1)
                    for det in data.get("detections", []):
                        mapper.add_detection(camera, det)

                # Periodic analysis
                if mapper.should_analyze() and len(mapper.points) > 100:
                    print(f"[SEMANTIC] Analyzing {len(mapper.points)} points...")
                    mapper.analyze_planes()
                    mapper.prune_old_objects()

                    walls = len([p for p in mapper.planes if p.plane_type == "wall"])
                    print(f"[SEMANTIC] Found: {walls} walls, {mapper.stats['doorways']} doorways, {mapper.stats['objects']} objects")

                # Send layout updates
                if mapper.should_send_layout() and len(mapper.planes) > 0:
                    layout_data = mapper.get_layout_data()
                    await ws.send(json.dumps(layout_data))
                    print(f"[SEMANTIC] Sent layout: {mapper.stats}")

            except json.JSONDecodeError:
                pass
            except Exception as e:
                print(f"[SEMANTIC] Error: {e}")
                import traceback
                traceback.print_exc()


async def main():
    """Main entry point"""
    print("=" * 60)
    print("  CEMANI ROBOT - Semantic Mapper")
    print("  Walls | Doorways | Objects | Room Layout")
    print("=" * 60)
    print()

    while True:
        try:
            await handle_vps_connection()
        except Exception as e:
            print(f"[SEMANTIC] Connection error: {e}")
            print("[SEMANTIC] Reconnecting in 3 seconds...")
            await asyncio.sleep(3)


if __name__ == "__main__":
    asyncio.run(main())
