#!/usr/bin/env python3
"""
Indoor SLAM Mapping System
Two-layer occupancy grid with static/dynamic classification
Uses LIDAR for mapping and localization without GPS
"""

import math
import time
import numpy as np
from dataclasses import dataclass, field
from typing import List, Tuple, Optional, Dict
import json
import os

# Map configuration
DEFAULT_RESOLUTION = 5.0      # cm per cell
DEFAULT_SIZE = 2000           # cells (2000 * 5cm = 100 meters)
STATIC_HIT_THRESHOLD = 50     # hits to consider static
STATIC_AGE_THRESHOLD = 30.0   # seconds before can be static
STATIC_CONFIDENCE = 0.8       # confidence threshold for static
DYNAMIC_DECAY_TIME = 60.0     # seconds before dynamic obstacles fade
FREE_THRESHOLD = 0.3          # below this confidence = free space


@dataclass
class MapCell:
    """Single cell in the occupancy grid"""
    hit_count: int = 0
    miss_count: int = 0
    first_seen: float = 0.0
    last_seen: float = 0.0
    is_static: bool = False

    @property
    def confidence(self) -> float:
        """Occupancy confidence (0-1)"""
        total = self.hit_count + self.miss_count
        if total == 0:
            return 0.5  # Unknown
        return self.hit_count / total

    @property
    def is_occupied(self) -> bool:
        """Is this cell currently occupied?"""
        return self.confidence > 0.6

    @property
    def is_free(self) -> bool:
        """Is this cell definitely free?"""
        return self.confidence < FREE_THRESHOLD

    def hit(self, timestamp: float):
        """LIDAR ray hit this cell"""
        if self.first_seen == 0:
            self.first_seen = timestamp
        self.last_seen = timestamp
        self.hit_count += 1

        # Check if should become static
        age = timestamp - self.first_seen
        if (self.hit_count >= STATIC_HIT_THRESHOLD and
            age >= STATIC_AGE_THRESHOLD and
            self.confidence >= STATIC_CONFIDENCE):
            self.is_static = True

    def miss(self, timestamp: float):
        """LIDAR ray passed through this cell"""
        self.last_seen = timestamp
        self.miss_count += 1

        # If consistently free, can't be static
        if self.confidence < 0.4:
            self.is_static = False


class OccupancyGrid:
    """
    Two-layer occupancy grid for indoor mapping
    - Static layer: walls, furniture that doesn't move
    - Dynamic layer: chairs, people, pets
    """

    def __init__(self, resolution: float = DEFAULT_RESOLUTION,
                 size: int = DEFAULT_SIZE):
        """
        Initialize the occupancy grid

        Args:
            resolution: cm per cell
            size: number of cells in each dimension
        """
        self.resolution = resolution
        self.size = size

        # Robot starts at center of grid
        self.origin_x = size // 2
        self.origin_y = size // 2

        # Current robot pose (x, y in cm, theta in radians)
        self.robot_x = 0.0
        self.robot_y = 0.0
        self.robot_theta = 0.0

        # The grid - using dict for sparse storage (most cells are unknown)
        self.cells: Dict[Tuple[int, int], MapCell] = {}

        # Previous scan for scan matching
        self.prev_scan: List[Tuple[float, float]] = []
        self.prev_scan_time: float = 0.0

        # Statistics
        self.total_scans = 0
        self.static_cells = 0
        self.dynamic_cells = 0

        print(f"[MAP] Initialized {size}x{size} grid at {resolution}cm resolution")
        print(f"[MAP] Coverage: {size * resolution / 100:.1f}m x {size * resolution / 100:.1f}m")

    def world_to_grid(self, x: float, y: float) -> Tuple[int, int]:
        """Convert world coordinates (cm) to grid cell indices"""
        gx = int(x / self.resolution) + self.origin_x
        gy = int(y / self.resolution) + self.origin_y
        return gx, gy

    def grid_to_world(self, gx: int, gy: int) -> Tuple[float, float]:
        """Convert grid cell indices to world coordinates (cm)"""
        x = (gx - self.origin_x) * self.resolution
        y = (gy - self.origin_y) * self.resolution
        return x, y

    def get_cell(self, gx: int, gy: int) -> Optional[MapCell]:
        """Get cell at grid coordinates, or None if not observed"""
        return self.cells.get((gx, gy))

    def get_or_create_cell(self, gx: int, gy: int) -> MapCell:
        """Get cell at grid coordinates, creating if needed"""
        if (gx, gy) not in self.cells:
            self.cells[(gx, gy)] = MapCell()
        return self.cells[(gx, gy)]

    def is_valid_grid(self, gx: int, gy: int) -> bool:
        """Check if grid coordinates are within bounds"""
        return 0 <= gx < self.size and 0 <= gy < self.size

    def bresenham_line(self, x0: int, y0: int, x1: int, y1: int) -> List[Tuple[int, int]]:
        """
        Bresenham's line algorithm - get all cells along a line
        Used for ray tracing from robot to LIDAR hit point
        """
        cells = []
        dx = abs(x1 - x0)
        dy = abs(y1 - y0)
        sx = 1 if x0 < x1 else -1
        sy = 1 if y0 < y1 else -1
        err = dx - dy

        while True:
            cells.append((x0, y0))
            if x0 == x1 and y0 == y1:
                break
            e2 = 2 * err
            if e2 > -dy:
                err -= dy
                x0 += sx
            if e2 < dx:
                err += dx
                y0 += sy

        return cells

    def update_from_scan(self, scan_points: List[Tuple[float, float]],
                         robot_x: float, robot_y: float, robot_theta: float):
        """
        Update the map from a LIDAR scan

        Args:
            scan_points: List of (angle_deg, distance_mm) tuples
            robot_x, robot_y: Robot position in cm
            robot_theta: Robot heading in radians
        """
        now = time.time()
        self.robot_x = robot_x
        self.robot_y = robot_y
        self.robot_theta = robot_theta

        # Get robot grid position
        robot_gx, robot_gy = self.world_to_grid(robot_x, robot_y)

        if not self.is_valid_grid(robot_gx, robot_gy):
            print(f"[MAP] Warning: Robot outside grid bounds")
            return

        # Convert scan to world coordinates for scan matching
        world_points = []

        for angle_deg, distance_mm in scan_points:
            if distance_mm < 50 or distance_mm > 12000:  # Filter invalid readings
                continue

            distance_cm = distance_mm / 10.0

            # Convert to world coordinates
            angle_rad = math.radians(angle_deg) + robot_theta
            hit_x = robot_x + distance_cm * math.cos(angle_rad)
            hit_y = robot_y + distance_cm * math.sin(angle_rad)

            world_points.append((hit_x, hit_y))

            # Get grid coordinates for hit point
            hit_gx, hit_gy = self.world_to_grid(hit_x, hit_y)

            if not self.is_valid_grid(hit_gx, hit_gy):
                continue

            # Ray trace from robot to hit point
            ray_cells = self.bresenham_line(robot_gx, robot_gy, hit_gx, hit_gy)

            # All cells except last are free (ray passed through)
            for gx, gy in ray_cells[:-1]:
                if self.is_valid_grid(gx, gy):
                    cell = self.get_or_create_cell(gx, gy)
                    cell.miss(now)

            # Last cell is occupied (ray hit something)
            hit_cell = self.get_or_create_cell(hit_gx, hit_gy)
            hit_cell.hit(now)

        # Store for scan matching
        self.prev_scan = world_points
        self.prev_scan_time = now
        self.total_scans += 1

        # Update statistics periodically
        if self.total_scans % 50 == 0:
            self._update_stats()

    def _update_stats(self):
        """Update map statistics"""
        self.static_cells = sum(1 for c in self.cells.values() if c.is_static)
        self.dynamic_cells = sum(1 for c in self.cells.values()
                                  if c.is_occupied and not c.is_static)
        print(f"[MAP] Stats: {len(self.cells)} cells, "
              f"{self.static_cells} static, {self.dynamic_cells} dynamic")

    def decay_dynamic(self):
        """Decay old dynamic obstacles (call periodically)"""
        now = time.time()
        cells_to_check = list(self.cells.items())

        for (gx, gy), cell in cells_to_check:
            # Skip static cells
            if cell.is_static:
                continue

            # If not seen recently and was dynamic, decay it
            age = now - cell.last_seen
            if age > DYNAMIC_DECAY_TIME and cell.is_occupied:
                # Reduce hit count to let it fade
                cell.hit_count = max(0, cell.hit_count - 1)

                # Remove cell if completely faded
                if cell.hit_count == 0 and cell.miss_count == 0:
                    del self.cells[(gx, gy)]

    def get_scan_for_matching(self) -> List[Tuple[float, float]]:
        """Get static obstacles as points for scan matching"""
        points = []
        for (gx, gy), cell in self.cells.items():
            if cell.is_static:
                x, y = self.grid_to_world(gx, gy)
                points.append((x, y))
        return points

    def is_path_clear(self, x1: float, y1: float, x2: float, y2: float) -> bool:
        """Check if path between two points is clear of obstacles"""
        gx1, gy1 = self.world_to_grid(x1, y1)
        gx2, gy2 = self.world_to_grid(x2, y2)

        ray_cells = self.bresenham_line(gx1, gy1, gx2, gy2)

        for gx, gy in ray_cells:
            cell = self.get_cell(gx, gy)
            if cell and cell.is_occupied:
                return False

        return True

    def get_clearance(self, x: float, y: float, direction: float,
                      max_range: float = 300.0) -> float:
        """
        Get clearance in a direction from a point

        Args:
            x, y: Starting point in cm
            direction: Direction in radians
            max_range: Maximum range to check in cm

        Returns:
            Distance to nearest obstacle in cm, or max_range if clear
        """
        step = self.resolution
        distance = 0.0

        while distance < max_range:
            check_x = x + distance * math.cos(direction)
            check_y = y + distance * math.sin(direction)

            gx, gy = self.world_to_grid(check_x, check_y)

            if not self.is_valid_grid(gx, gy):
                return distance

            cell = self.get_cell(gx, gy)
            if cell and cell.is_occupied:
                return distance

            distance += step

        return max_range

    def save_map(self, filepath: str):
        """Save the static layer to a file"""
        # Only save static cells
        static_data = {
            'resolution': self.resolution,
            'size': self.size,
            'origin_x': self.origin_x,
            'origin_y': self.origin_y,
            'robot_x': self.robot_x,
            'robot_y': self.robot_y,
            'robot_theta': self.robot_theta,
            'cells': []
        }

        for (gx, gy), cell in self.cells.items():
            if cell.is_static:
                static_data['cells'].append({
                    'gx': gx,
                    'gy': gy,
                    'hit_count': cell.hit_count,
                    'confidence': cell.confidence
                })

        with open(filepath, 'w') as f:
            json.dump(static_data, f)

        print(f"[MAP] Saved {len(static_data['cells'])} static cells to {filepath}")

    def load_map(self, filepath: str) -> bool:
        """Load static layer from a file"""
        if not os.path.exists(filepath):
            print(f"[MAP] No saved map at {filepath}")
            return False

        try:
            with open(filepath, 'r') as f:
                data = json.load(f)

            self.resolution = data['resolution']
            self.size = data['size']
            self.origin_x = data['origin_x']
            self.origin_y = data['origin_y']
            self.robot_x = data.get('robot_x', 0.0)
            self.robot_y = data.get('robot_y', 0.0)
            self.robot_theta = data.get('robot_theta', 0.0)

            # Load static cells
            for cell_data in data['cells']:
                gx = cell_data['gx']
                gy = cell_data['gy']
                cell = MapCell(
                    hit_count=cell_data['hit_count'],
                    is_static=True,
                    first_seen=time.time() - 100,  # Mark as old
                    last_seen=time.time()
                )
                self.cells[(gx, gy)] = cell

            print(f"[MAP] Loaded {len(data['cells'])} static cells from {filepath}")
            return True

        except Exception as e:
            print(f"[MAP] Error loading map: {e}")
            return False

    def to_image_data(self, center_on_robot: bool = True,
                      view_size: int = 200) -> np.ndarray:
        """
        Generate image data for visualization

        Args:
            center_on_robot: If True, center view on robot
            view_size: Size of view in cells

        Returns:
            numpy array (view_size x view_size x 3) RGB image
        """
        img = np.full((view_size, view_size, 3), 128, dtype=np.uint8)  # Gray = unknown

        if center_on_robot:
            center_gx, center_gy = self.world_to_grid(self.robot_x, self.robot_y)
        else:
            center_gx = self.origin_x
            center_gy = self.origin_y

        half = view_size // 2

        for (gx, gy), cell in self.cells.items():
            # Convert to image coordinates
            img_x = gx - center_gx + half
            img_y = gy - center_gy + half

            if 0 <= img_x < view_size and 0 <= img_y < view_size:
                if cell.is_static:
                    # Static obstacles = black
                    img[img_y, img_x] = [0, 0, 0]
                elif cell.is_occupied:
                    # Dynamic obstacles = red
                    img[img_y, img_x] = [255, 0, 0]
                elif cell.is_free:
                    # Free space = white
                    img[img_y, img_x] = [255, 255, 255]

        # Draw robot position (green dot)
        robot_img_x = half
        robot_img_y = half
        if 0 <= robot_img_x < view_size and 0 <= robot_img_y < view_size:
            # Draw robot as small green square
            for dx in range(-2, 3):
                for dy in range(-2, 3):
                    px, py = robot_img_x + dx, robot_img_y + dy
                    if 0 <= px < view_size and 0 <= py < view_size:
                        img[py, px] = [0, 255, 0]

            # Draw heading indicator
            head_dx = int(5 * math.cos(self.robot_theta))
            head_dy = int(5 * math.sin(self.robot_theta))
            head_x = robot_img_x + head_dx
            head_y = robot_img_y + head_dy
            if 0 <= head_x < view_size and 0 <= head_y < view_size:
                img[head_y, head_x] = [0, 200, 0]

        return img


class ScanMatcher:
    """
    ICP-based scan matching for localization
    Compares current LIDAR scan to known map to correct position drift
    """

    def __init__(self, max_iterations: int = 20,
                 convergence_threshold: float = 0.5):
        self.max_iterations = max_iterations
        self.convergence_threshold = convergence_threshold

    def match(self, current_scan: List[Tuple[float, float]],
              reference_points: List[Tuple[float, float]],
              initial_x: float, initial_y: float,
              initial_theta: float) -> Tuple[float, float, float, float]:
        """
        Match current scan to reference points using ICP

        Args:
            current_scan: List of (x, y) points from current scan
            reference_points: List of (x, y) points from map (static obstacles)
            initial_x, initial_y, initial_theta: Initial pose estimate

        Returns:
            (corrected_x, corrected_y, corrected_theta, error)
        """
        if len(current_scan) < 10 or len(reference_points) < 10:
            return initial_x, initial_y, initial_theta, float('inf')

        # Convert to numpy arrays
        scan = np.array(current_scan)
        reference = np.array(reference_points)

        # Current transform
        x, y, theta = initial_x, initial_y, initial_theta

        for iteration in range(self.max_iterations):
            # Transform scan points by current estimate
            cos_t, sin_t = math.cos(theta), math.sin(theta)
            transformed = np.zeros_like(scan)
            transformed[:, 0] = scan[:, 0] * cos_t - scan[:, 1] * sin_t + x
            transformed[:, 1] = scan[:, 0] * sin_t + scan[:, 1] * cos_t + y

            # Find nearest neighbors in reference
            correspondences = []
            total_error = 0.0

            for i, point in enumerate(transformed):
                # Find closest reference point
                dists = np.sum((reference - point) ** 2, axis=1)
                min_idx = np.argmin(dists)
                min_dist = np.sqrt(dists[min_idx])

                # Only use close correspondences
                if min_dist < 50:  # 50cm threshold
                    correspondences.append((i, min_idx, min_dist))
                    total_error += min_dist

            if len(correspondences) < 5:
                break

            avg_error = total_error / len(correspondences)

            # Check convergence
            if avg_error < self.convergence_threshold:
                return x, y, theta, avg_error

            # Compute correction using least squares
            # Simplified: just compute centroid shift
            scan_centroid = np.mean(transformed[[c[0] for c in correspondences]], axis=0)
            ref_centroid = np.mean(reference[[c[1] for c in correspondences]], axis=0)

            # Update position
            dx = (ref_centroid[0] - scan_centroid[0]) * 0.5
            dy = (ref_centroid[1] - scan_centroid[1]) * 0.5

            x += dx
            y += dy

            # Simple rotation estimate (could be improved)
            # For now, trust encoder-based heading

        return x, y, theta, avg_error if 'avg_error' in dir() else float('inf')


class IndoorLocalizer:
    """
    Combines encoder odometry with scan matching for accurate indoor localization
    """

    def __init__(self, occupancy_grid: OccupancyGrid):
        self.grid = occupancy_grid
        self.matcher = ScanMatcher()

        # Position state
        self.x = 0.0  # cm
        self.y = 0.0  # cm
        self.theta = 0.0  # radians

        # Encoder tracking
        self.last_encoder_left = 0
        self.last_encoder_right = 0
        self.encoder_initialized = False

        # Robot parameters (adjust for your robot)
        self.wheel_diameter_cm = 20.0  # 20cm diameter wheels
        self.wheel_base_cm = 50.0      # 50cm between wheels
        self.ticks_per_revolution = 8192  # Encoder resolution

        # Correction interval
        self.scans_since_correction = 0
        self.correction_interval = 10  # Correct every 10 scans

    def cm_per_tick(self) -> float:
        """Calculate distance per encoder tick"""
        circumference = math.pi * self.wheel_diameter_cm
        return circumference / self.ticks_per_revolution

    def update_from_encoders(self, encoder_left: int, encoder_right: int):
        """
        Update position estimate from encoder readings

        Args:
            encoder_left: Left wheel encoder count
            encoder_right: Right wheel encoder count
        """
        if not self.encoder_initialized:
            self.last_encoder_left = encoder_left
            self.last_encoder_right = encoder_right
            self.encoder_initialized = True
            return

        # Calculate deltas
        delta_left = encoder_left - self.last_encoder_left
        delta_right = encoder_right - self.last_encoder_right

        self.last_encoder_left = encoder_left
        self.last_encoder_right = encoder_right

        # Convert to distances
        cm_per_tick = self.cm_per_tick()
        dist_left = delta_left * cm_per_tick
        dist_right = delta_right * cm_per_tick

        # Calculate movement
        dist_center = (dist_left + dist_right) / 2.0
        delta_theta = (dist_right - dist_left) / self.wheel_base_cm

        # Update pose
        self.theta += delta_theta
        self.x += dist_center * math.cos(self.theta)
        self.y += dist_center * math.sin(self.theta)

        # Normalize theta to [-pi, pi]
        while self.theta > math.pi:
            self.theta -= 2 * math.pi
        while self.theta < -math.pi:
            self.theta += 2 * math.pi

    def update_from_scan(self, scan_points: List[Tuple[float, float]]):
        """
        Update position from LIDAR scan with optional correction

        Args:
            scan_points: List of (angle_deg, distance_mm) tuples
        """
        # Update the map
        self.grid.update_from_scan(scan_points, self.x, self.y, self.theta)

        self.scans_since_correction += 1

        # Periodically correct position using scan matching
        if self.scans_since_correction >= self.correction_interval:
            self.scans_since_correction = 0
            self._correct_position()

    def _correct_position(self):
        """Use scan matching to correct accumulated drift"""
        if len(self.grid.prev_scan) < 20:
            return

        # Get static points from map
        static_points = self.grid.get_scan_for_matching()

        if len(static_points) < 20:
            return  # Not enough map data yet

        # Run scan matching
        corrected_x, corrected_y, corrected_theta, error = self.matcher.match(
            self.grid.prev_scan,
            static_points,
            self.x, self.y, self.theta
        )

        # Only apply correction if error is reasonable
        if error < 20:  # Less than 20cm average error
            # Blend correction (don't jump too suddenly)
            blend = 0.3
            self.x = self.x * (1 - blend) + corrected_x * blend
            self.y = self.y * (1 - blend) + corrected_y * blend
            # Keep encoder-based theta (usually more reliable)

            print(f"[LOC] Position corrected: ({self.x:.1f}, {self.y:.1f}) error={error:.1f}cm")

    def get_pose(self) -> Tuple[float, float, float]:
        """Get current pose estimate (x, y, theta)"""
        return self.x, self.y, self.theta

    def reset_pose(self, x: float = 0.0, y: float = 0.0, theta: float = 0.0):
        """Reset pose to specified values"""
        self.x = x
        self.y = y
        self.theta = theta
        self.grid.robot_x = x
        self.grid.robot_y = y
        self.grid.robot_theta = theta
        print(f"[LOC] Pose reset to ({x:.1f}, {y:.1f}, {math.degrees(theta):.1f}°)")


# Test code
if __name__ == "__main__":
    print("Testing mapping system...")

    # Create grid
    grid = OccupancyGrid(resolution=5.0, size=400)  # 20m x 20m

    # Simulate some LIDAR scans
    for i in range(100):
        # Fake scan data - walls at fixed distances
        scan = []
        for angle in range(0, 360, 1):
            # Simulate a 5m x 5m room
            if 45 <= angle <= 135:  # Front wall at 250cm
                dist = 2500
            elif 135 <= angle <= 225:  # Left wall at 200cm
                dist = 2000
            elif 225 <= angle <= 315:  # Back wall at 300cm
                dist = 3000
            else:  # Right wall at 200cm
                dist = 2000

            # Add some noise
            dist += np.random.randint(-50, 50)
            scan.append((angle, dist))

        # Update map
        grid.update_from_scan(scan, 0, 0, 0)

    # Check results
    print(f"Total cells: {len(grid.cells)}")
    static = sum(1 for c in grid.cells.values() if c.is_static)
    print(f"Static cells: {static}")

    # Save map
    grid.save_map("/tmp/test_map.json")

    # Load map
    grid2 = OccupancyGrid()
    grid2.load_map("/tmp/test_map.json")

    print("Mapping system test complete!")
