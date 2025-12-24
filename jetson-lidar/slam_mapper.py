#!/usr/bin/env python3
"""
2D SLAM Mapper
Drive around with bluetooth controller, builds a map in real-time
No GPS needed - uses scan matching to track position
"""

import numpy as np
import cv2
from rplidar import RPLidar
import threading
import time
import math
from scipy.spatial import KDTree
from collections import deque

# Configuration
LIDAR_PORT = '/dev/ttyUSB0'

# Exclusion zones - auto-detected at startup
# Will be populated by calibration scan
EXCLUSION_ZONES = []

# Calibration settings
CALIBRATION_SCANS = 5  # Number of scans to average for detection
MOUNT_DETECTION_THRESHOLD = 500  # Objects closer than 500mm are "mounted"

# Manual exclusion zones (backup if auto-detect fails)
# 7 o'clock = ~210 degrees, camera is ~10 inches (~254mm)
MANUAL_EXCLUSIONS = [
    (205, 220, 400),  # Camera at 7 o'clock
]

# Map settings
MAP_SIZE_METERS = 30  # 30m x 30m map
MAP_RESOLUTION = 0.05  # 5cm per pixel
MAP_SIZE_PIXELS = int(MAP_SIZE_METERS / MAP_RESOLUTION)  # 600x600

# Display
DISPLAY_SIZE = 800
SCALE = DISPLAY_SIZE / MAP_SIZE_PIXELS

# Colors
BLACK = (0, 0, 0)
WHITE = (255, 255, 255)
GRAY = (128, 128, 128)
GREEN = (0, 255, 0)
RED = (0, 0, 255)
CYAN = (255, 255, 0)
YELLOW = (0, 255, 255)
BLUE = (255, 100, 0)


class SLAMMapper:
    def __init__(self):
        self.lidar = None
        self.running = True
        self.calibrated = False
        self.exclusion_zones = []  # Auto-detected mounted objects

        # Robot pose [x, y, theta] in meters and radians
        self.pose = np.array([MAP_SIZE_METERS / 2, MAP_SIZE_METERS / 2, 0.0])

        # Occupancy grid: 0=unknown, 1=free, 2=occupied
        self.map = np.zeros((MAP_SIZE_PIXELS, MAP_SIZE_PIXELS), dtype=np.uint8)

        # Previous scan for matching
        self.prev_scan = None
        self.prev_points = None

        # Path history
        self.path = deque(maxlen=10000)
        self.path.append(self.pose[:2].copy())

        # Lock for thread safety
        self.lock = threading.Lock()

        # Stats
        self.scan_count = 0
        self.last_update = time.time()

    def is_excluded(self, angle, distance):
        """Check if point is in an exclusion zone (robot-mounted objects)"""
        for min_ang, max_ang, max_dist in self.exclusion_zones:
            if min_ang <= angle <= max_ang and distance < max_dist:
                return True
        return False

    def calibrate(self):
        """
        Run calibration scans to detect robot-mounted objects.
        These will be excluded from mapping.
        """
        print("\n" + "="*50)
        print("  CALIBRATION - Detecting mounted objects...")
        print("  Keep robot stationary!")
        print("="*50)

        # Clear buffer first
        try:
            self.lidar.clean_input()
        except:
            pass

        # Collect multiple scans
        all_close_points = {}  # angle -> list of distances

        scan_count = 0
        for scan in self.lidar.iter_scans(max_buf_meas=1000, min_len=100):
            for quality, angle, distance in scan:
                if quality > 0 and distance < MOUNT_DETECTION_THRESHOLD:
                    # Round angle to nearest degree
                    ang_key = int(round(angle))
                    if ang_key not in all_close_points:
                        all_close_points[ang_key] = []
                    all_close_points[ang_key].append(distance)

            scan_count += 1
            print(f"  Calibration scan {scan_count}/{CALIBRATION_SCANS}...")
            if scan_count >= CALIBRATION_SCANS:
                break

        # Find consistent close objects (seen in multiple scans)
        mounted_angles = []
        for ang, distances in all_close_points.items():
            if len(distances) >= CALIBRATION_SCANS - 1:  # Seen in most scans
                avg_dist = sum(distances) / len(distances)
                mounted_angles.append((ang, avg_dist))
                print(f"  Found mounted object at {ang}° - {avg_dist:.0f}mm")

        # Group into exclusion zones
        if mounted_angles:
            mounted_angles.sort(key=lambda x: x[0])

            # Group adjacent angles
            zones = []
            zone_start = mounted_angles[0][0]
            zone_end = mounted_angles[0][0]
            max_dist = mounted_angles[0][1]

            for ang, dist in mounted_angles[1:]:
                if ang <= zone_end + 5:  # Within 5 degrees, same object
                    zone_end = ang
                    max_dist = max(max_dist, dist)
                else:
                    # Save previous zone
                    zones.append((zone_start - 3, zone_end + 3, max_dist + 100))
                    zone_start = ang
                    zone_end = ang
                    max_dist = dist

            # Don't forget last zone
            zones.append((zone_start - 3, zone_end + 3, max_dist + 100))

            self.exclusion_zones = zones
            print(f"\n  Created {len(zones)} exclusion zone(s):")
            for i, (min_a, max_a, max_d) in enumerate(zones):
                print(f"    Zone {i+1}: {min_a}° to {max_a}° (within {max_d:.0f}mm)")
        else:
            print("  No mounted objects auto-detected")
            print("  Using manual exclusion zones...")
            self.exclusion_zones = MANUAL_EXCLUSIONS.copy()
            for min_a, max_a, max_d in self.exclusion_zones:
                print(f"    Zone: {min_a}° to {max_a}° (within {max_d}mm)")

        print("="*50)
        print("  Calibration complete! Starting mapping...")
        print("="*50 + "\n")

        self.calibrated = True

    def lidar_to_points(self, scan):
        """Convert lidar scan to XY points in robot frame"""
        points = []
        for quality, angle, distance in scan:
            if quality > 0 and 100 < distance < 6000:
                # Skip excluded zones (robot-mounted cameras, etc.)
                if self.is_excluded(angle, distance):
                    continue
                # Convert to meters
                d = distance / 1000.0
                # Convert to radians (0 = front)
                a = math.radians(angle)
                x = d * math.cos(a)
                y = d * math.sin(a)
                points.append([x, y])
        return np.array(points) if points else None

    def transform_points(self, points, pose):
        """Transform points from robot frame to world frame"""
        if points is None or len(points) == 0:
            return None

        x, y, theta = pose
        cos_t = math.cos(theta)
        sin_t = math.sin(theta)

        # Rotation matrix
        R = np.array([[cos_t, -sin_t], [sin_t, cos_t]])

        # Transform
        world_points = (R @ points.T).T + np.array([x, y])
        return world_points

    def icp_match(self, source, target, max_iterations=20):
        """
        Simple ICP (Iterative Closest Point) to find transformation
        Returns: dx, dy, dtheta
        """
        if source is None or target is None:
            return 0, 0, 0
        if len(source) < 10 or len(target) < 10:
            return 0, 0, 0

        # Build KD-tree for target
        tree = KDTree(target)

        # Current transformation estimate
        dx, dy, dtheta = 0, 0, 0
        transformed = source.copy()

        for _ in range(max_iterations):
            # Find closest points
            distances, indices = tree.query(transformed)

            # Filter outliers
            mask = distances < 0.5  # 50cm threshold
            if np.sum(mask) < 10:
                break

            src_matched = transformed[mask]
            tgt_matched = target[indices[mask]]

            # Compute centroids
            src_centroid = np.mean(src_matched, axis=0)
            tgt_centroid = np.mean(tgt_matched, axis=0)

            # Center the points
            src_centered = src_matched - src_centroid
            tgt_centered = tgt_matched - tgt_centroid

            # Compute rotation using SVD
            H = src_centered.T @ tgt_centered
            U, _, Vt = np.linalg.svd(H)
            R = Vt.T @ U.T

            # Ensure proper rotation (det = 1)
            if np.linalg.det(R) < 0:
                Vt[-1, :] *= -1
                R = Vt.T @ U.T

            # Compute translation
            t = tgt_centroid - R @ src_centroid

            # Update transformation
            angle = math.atan2(R[1, 0], R[0, 0])
            dtheta += angle
            dx += t[0]
            dy += t[1]

            # Apply to source
            cos_a = math.cos(angle)
            sin_a = math.sin(angle)
            R_apply = np.array([[cos_a, -sin_a], [sin_a, cos_a]])
            transformed = (R_apply @ transformed.T).T + t

            # Check convergence
            if abs(angle) < 0.001 and np.linalg.norm(t) < 0.001:
                break

        return dx, dy, dtheta

    def update_map(self, points_world):
        """Update occupancy grid with new scan"""
        if points_world is None:
            return

        robot_x, robot_y = self.pose[:2]

        for px, py in points_world:
            # Convert to grid coordinates
            gx = int(px / MAP_RESOLUTION)
            gy = int(py / MAP_RESOLUTION)

            if 0 <= gx < MAP_SIZE_PIXELS and 0 <= gy < MAP_SIZE_PIXELS:
                # Mark as occupied
                self.map[gy, gx] = 2

            # Ray trace to mark free space
            robot_gx = int(robot_x / MAP_RESOLUTION)
            robot_gy = int(robot_y / MAP_RESOLUTION)

            # Bresenham's line algorithm (simplified)
            steps = max(abs(gx - robot_gx), abs(gy - robot_gy))
            if steps > 0:
                for i in range(0, steps, 2):  # Skip some for speed
                    t = i / steps
                    fx = int(robot_gx + t * (gx - robot_gx))
                    fy = int(robot_gy + t * (gy - robot_gy))
                    if 0 <= fx < MAP_SIZE_PIXELS and 0 <= fy < MAP_SIZE_PIXELS:
                        if self.map[fy, fx] == 0:  # Only if unknown
                            self.map[fy, fx] = 1  # Mark free

    def process_scan(self, scan):
        """Process a new lidar scan"""
        points = self.lidar_to_points(scan)
        if points is None or len(points) < 20:
            return

        self.scan_count += 1

        # First scan - just initialize
        if self.prev_points is None:
            self.prev_points = points
            world_points = self.transform_points(points, self.pose)
            self.update_map(world_points)
            return

        # Match current scan to previous
        dx, dy, dtheta = self.icp_match(self.prev_points, points)

        # Update pose (inverse transform - we matched prev to current)
        with self.lock:
            self.pose[2] -= dtheta
            cos_t = math.cos(self.pose[2])
            sin_t = math.sin(self.pose[2])
            self.pose[0] -= dx * cos_t - dy * sin_t
            self.pose[1] -= dx * sin_t + dy * cos_t

            # Add to path
            self.path.append(self.pose[:2].copy())

        # Transform to world and update map
        world_points = self.transform_points(points, self.pose)
        self.update_map(world_points)

        # Save for next iteration
        self.prev_points = points

    def lidar_thread(self):
        """Thread to read lidar and process scans"""
        while self.running:
            try:
                print("Connecting LIDAR...")
                self.lidar = RPLidar(LIDAR_PORT)
                info = self.lidar.get_info()
                print(f"LIDAR OK - Model {info['model']}")
                self.lidar.start_motor()

                # Run calibration first to detect mounted objects
                if not self.calibrated:
                    time.sleep(1)  # Let motor spin up
                    self.calibrate()

                for scan in self.lidar.iter_scans(max_buf_meas=1000, min_len=50):
                    if not self.running:
                        break
                    self.process_scan(scan)
                    self.last_update = time.time()

            except Exception as e:
                print(f"LIDAR error: {e}")
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

    def render(self):
        """Render the map for display"""
        # Create display image
        display = np.zeros((DISPLAY_SIZE, DISPLAY_SIZE, 3), dtype=np.uint8)

        # Draw map
        for y in range(MAP_SIZE_PIXELS):
            for x in range(MAP_SIZE_PIXELS):
                dx = int(x * SCALE)
                dy = int(y * SCALE)
                if dx < DISPLAY_SIZE and dy < DISPLAY_SIZE:
                    val = self.map[y, x]
                    if val == 1:  # Free
                        display[dy, dx] = (40, 40, 40)
                    elif val == 2:  # Occupied
                        display[dy, dx] = WHITE

        # Draw path
        with self.lock:
            path = list(self.path)
            pose = self.pose.copy()

        if len(path) > 1:
            for i in range(1, len(path)):
                p1 = path[i - 1]
                p2 = path[i]
                x1 = int(p1[0] / MAP_RESOLUTION * SCALE)
                y1 = int(p1[1] / MAP_RESOLUTION * SCALE)
                x2 = int(p2[0] / MAP_RESOLUTION * SCALE)
                y2 = int(p2[1] / MAP_RESOLUTION * SCALE)
                cv2.line(display, (x1, y1), (x2, y2), GREEN, 1)

        # Draw robot
        rx = int(pose[0] / MAP_RESOLUTION * SCALE)
        ry = int(pose[1] / MAP_RESOLUTION * SCALE)
        cv2.circle(display, (rx, ry), 8, CYAN, -1)

        # Draw heading
        hx = int(rx + 20 * math.cos(pose[2] - math.pi/2))
        hy = int(ry + 20 * math.sin(pose[2] - math.pi/2))
        cv2.line(display, (rx, ry), (hx, hy), CYAN, 2)

        # Info panel
        cv2.rectangle(display, (5, 5), (250, 130), (20, 20, 20), -1)
        cv2.rectangle(display, (5, 5), (250, 130), GRAY, 1)

        cv2.putText(display, "2D SLAM MAPPER", (15, 30),
                   cv2.FONT_HERSHEY_DUPLEX, 0.7, CYAN, 2)

        info = [
            f"Scans: {self.scan_count}",
            f"Pos: ({pose[0]:.1f}, {pose[1]:.1f})m",
            f"Heading: {math.degrees(pose[2]):.0f} deg",
            f"Map: {MAP_SIZE_METERS}m x {MAP_SIZE_METERS}m",
        ]

        y = 55
        for line in info:
            cv2.putText(display, line, (15, y),
                       cv2.FONT_HERSHEY_SIMPLEX, 0.5, WHITE, 1)
            y += 20

        # Legend
        cv2.rectangle(display, (5, DISPLAY_SIZE - 80), (200, DISPLAY_SIZE - 5), (20, 20, 20), -1)
        cv2.putText(display, "White = Walls/Objects", (10, DISPLAY_SIZE - 55),
                   cv2.FONT_HERSHEY_SIMPLEX, 0.45, WHITE, 1)
        cv2.putText(display, "Gray = Free space", (10, DISPLAY_SIZE - 35),
                   cv2.FONT_HERSHEY_SIMPLEX, 0.45, GRAY, 1)
        cv2.putText(display, "Green = Robot path", (10, DISPLAY_SIZE - 15),
                   cv2.FONT_HERSHEY_SIMPLEX, 0.45, GREEN, 1)

        # Controls
        cv2.putText(display, "Q=Quit S=Save R=Reset", (DISPLAY_SIZE - 230, DISPLAY_SIZE - 10),
                   cv2.FONT_HERSHEY_SIMPLEX, 0.5, GRAY, 1)

        return display

    def save_map(self, filename=None):
        """Save the map as an image"""
        if filename is None:
            filename = f"slam_map_{int(time.time())}.png"

        # Create high-res map image
        map_img = np.zeros((MAP_SIZE_PIXELS, MAP_SIZE_PIXELS, 3), dtype=np.uint8)
        for y in range(MAP_SIZE_PIXELS):
            for x in range(MAP_SIZE_PIXELS):
                val = self.map[y, x]
                if val == 0:
                    map_img[y, x] = (50, 50, 50)  # Unknown
                elif val == 1:
                    map_img[y, x] = (200, 200, 200)  # Free
                elif val == 2:
                    map_img[y, x] = (0, 0, 0)  # Occupied (walls black)

        cv2.imwrite(filename, map_img)
        print(f"Map saved: {filename}")

        # Also save raw numpy array
        np.save(filename.replace('.png', '.npy'), self.map)
        print(f"Raw map saved: {filename.replace('.png', '.npy')}")

    def reset(self):
        """Reset the map and pose"""
        with self.lock:
            self.pose = np.array([MAP_SIZE_METERS / 2, MAP_SIZE_METERS / 2, 0.0])
            self.map = np.zeros((MAP_SIZE_PIXELS, MAP_SIZE_PIXELS), dtype=np.uint8)
            self.path.clear()
            self.path.append(self.pose[:2].copy())
            self.prev_points = None
            self.scan_count = 0
        print("Map reset")

    def run(self):
        """Main loop"""
        # Start lidar thread
        threading.Thread(target=self.lidar_thread, daemon=True).start()

        print("\n" + "="*50)
        print("       2D SLAM MAPPER")
        print("="*50)
        print("\nDrive the robot around with bluetooth controller.")
        print("The map will build in real-time!")
        print("\nControls:")
        print("  Q = Quit")
        print("  S = Save map")
        print("  R = Reset map")
        print("="*50 + "\n")

        cv2.namedWindow('SLAM Mapper', cv2.WINDOW_NORMAL)
        cv2.resizeWindow('SLAM Mapper', DISPLAY_SIZE, DISPLAY_SIZE)

        while self.running:
            display = self.render()
            cv2.imshow('SLAM Mapper', display)

            key = cv2.waitKey(50) & 0xFF
            if key == ord('q') or key == 27:
                break
            elif key == ord('s'):
                self.save_map()
            elif key == ord('r'):
                self.reset()

        self.running = False
        cv2.destroyAllWindows()

        # Auto-save on exit
        self.save_map("slam_map_final.png")
        print("Done!")


def main():
    mapper = SLAMMapper()
    mapper.run()


if __name__ == '__main__':
    main()
