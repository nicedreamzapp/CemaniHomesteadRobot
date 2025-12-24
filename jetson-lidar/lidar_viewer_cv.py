#!/usr/bin/env python3
"""
RPLIDAR A1 Room Map Visualization
Shows walls and objects as connected lines with persistence
"""

import sys
import numpy as np
import cv2
from rplidar import RPLidar
import argparse
import time
from collections import deque
import math

# Default settings
DEFAULT_PORT = '/dev/ttyUSB0'
MAX_DISTANCE = 6000  # 6 meters in mm
WINDOW_SIZE = 800
CENTER = WINDOW_SIZE // 2

class LidarMapper:
    def __init__(self, port=DEFAULT_PORT, max_range=MAX_DISTANCE):
        self.port = port
        self.max_range = max_range
        self.lidar = None
        self.scale = (WINDOW_SIZE // 2 - 50) / max_range

        # Persistence map - accumulates scans
        self.persistence_map = np.zeros((WINDOW_SIZE, WINDOW_SIZE, 3), dtype=np.uint8)
        self.decay_rate = 0.97  # How fast old points fade

        # For clustering/segmentation
        self.min_cluster_gap = 100  # mm - gap to start new object

    def connect(self):
        """Connect to the RPLIDAR"""
        try:
            print(f"Connecting to RPLIDAR on {self.port}...")
            self.lidar = RPLidar(self.port)
            info = self.lidar.get_info()
            health = self.lidar.get_health()
            print(f"Model: {info['model']}")
            print(f"Firmware: {info['firmware'][0]}.{info['firmware'][1]}")
            print(f"Health: {health[0]}")
            return True
        except Exception as e:
            print(f"Error connecting to RPLIDAR: {e}")
            return False

    def angle_to_xy(self, angle_deg, distance):
        """Convert polar to screen coordinates"""
        angle_rad = math.radians(angle_deg - 90)
        x = int(CENTER + distance * self.scale * math.cos(angle_rad))
        y = int(CENTER + distance * self.scale * math.sin(angle_rad))
        return x, y

    def get_object_color(self, cluster_id):
        """Different colors for different detected objects"""
        colors = [
            (0, 255, 0),    # Green
            (255, 100, 0),  # Blue
            (0, 255, 255),  # Yellow
            (255, 0, 255),  # Magenta
            (255, 255, 0),  # Cyan
            (0, 165, 255),  # Orange
            (255, 0, 0),    # Blue
            (147, 20, 255), # Pink
        ]
        return colors[cluster_id % len(colors)]

    def segment_scan(self, scan_points):
        """Segment scan into clusters (different objects/walls)"""
        if len(scan_points) < 2:
            return [(scan_points, 0)]

        # Sort by angle
        scan_points.sort(key=lambda p: p[0])

        clusters = []
        current_cluster = [scan_points[0]]
        cluster_id = 0

        for i in range(1, len(scan_points)):
            prev_angle, prev_dist = scan_points[i-1][:2]
            curr_angle, curr_dist = scan_points[i][:2]

            # Calculate distance between consecutive points
            prev_x, prev_y = self.angle_to_xy(prev_angle, prev_dist)
            curr_x, curr_y = self.angle_to_xy(curr_angle, curr_dist)
            point_gap = math.sqrt((curr_x - prev_x)**2 + (curr_y - prev_y)**2)

            # Also check for big distance jumps (indicates different object)
            dist_diff = abs(curr_dist - prev_dist)

            # Start new cluster if big gap or big distance change
            if point_gap > 30 or dist_diff > self.min_cluster_gap:
                if len(current_cluster) >= 2:
                    clusters.append((current_cluster, cluster_id))
                    cluster_id += 1
                current_cluster = [scan_points[i]]
            else:
                current_cluster.append(scan_points[i])

        # Don't forget last cluster
        if len(current_cluster) >= 2:
            clusters.append((current_cluster, cluster_id))

        return clusters

    def draw_grid(self, frame):
        """Draw subtle background grid"""
        # Range rings
        for r in range(1000, self.max_range + 1000, 1000):
            radius = int(r * self.scale)
            cv2.circle(frame, (CENTER, CENTER), radius, (30, 30, 30), 1)
            label = f"{r//1000}m"
            cv2.putText(frame, label, (CENTER + 5, CENTER - radius + 15),
                       cv2.FONT_HERSHEY_SIMPLEX, 0.35, (60, 60, 60), 1)

        # Crosshairs
        cv2.line(frame, (CENTER, 20), (CENTER, WINDOW_SIZE-20), (30, 30, 30), 1)
        cv2.line(frame, (20, CENTER), (WINDOW_SIZE-20, CENTER), (30, 30, 30), 1)

        # Robot marker
        cv2.circle(frame, (CENTER, CENTER), 8, (0, 200, 200), -1)
        cv2.circle(frame, (CENTER, CENTER), 8, (0, 255, 255), 2)
        # Direction indicator (front)
        cv2.line(frame, (CENTER, CENTER), (CENTER, CENTER - 20), (0, 255, 255), 2)

    def run(self):
        """Start the visualization"""
        if not self.connect():
            return

        try:
            print("\nStarting room mapper...")
            print("Press 'q' to quit")
            print("Press 'c' to clear map")
            print("Press 'p' to toggle persistence")
            print("Press '+'/'-' to adjust range")
            print("Press 's' to save screenshot\n")

            self.lidar.start_motor()

            cv2.namedWindow('LIDAR Room Map', cv2.WINDOW_NORMAL)
            cv2.resizeWindow('LIDAR Room Map', WINDOW_SIZE, WINDOW_SIZE)

            persistence_enabled = True
            show_points = True

            for scan in self.lidar.iter_scans(max_buf_meas=500):
                # Fade persistence map
                if persistence_enabled:
                    self.persistence_map = (self.persistence_map * self.decay_rate).astype(np.uint8)
                else:
                    self.persistence_map = np.zeros((WINDOW_SIZE, WINDOW_SIZE, 3), dtype=np.uint8)

                # Collect valid points
                scan_points = []
                for quality, angle, distance in scan:
                    if quality > 0 and 150 < distance < self.max_range:
                        scan_points.append((angle, distance, quality))

                # Segment into objects
                clusters = self.segment_scan(scan_points)

                # Draw each cluster as connected lines
                for cluster_points, cluster_id in clusters:
                    color = self.get_object_color(cluster_id)

                    # Convert to screen coordinates
                    screen_points = []
                    for angle, distance, quality in cluster_points:
                        x, y = self.angle_to_xy(angle, distance)
                        screen_points.append((x, y))

                    # Draw connected lines (wall segments)
                    if len(screen_points) >= 2:
                        pts = np.array(screen_points, np.int32)
                        cv2.polylines(self.persistence_map, [pts], False, color, 2, cv2.LINE_AA)

                    # Draw points on top
                    if show_points:
                        for x, y in screen_points:
                            cv2.circle(self.persistence_map, (x, y), 3, color, -1)

                # Create display frame
                frame = self.persistence_map.copy()

                # Draw grid on top
                self.draw_grid(frame)

                # Stats
                stats = [
                    f"Points: {len(scan_points)}",
                    f"Objects: {len(clusters)}",
                    f"Range: {self.max_range/1000:.0f}m",
                    f"Persist: {'ON' if persistence_enabled else 'OFF'}",
                ]

                # Find closest point
                if scan_points:
                    closest = min(scan_points, key=lambda p: p[1])
                    stats.append(f"Closest: {closest[1]/1000:.2f}m")

                    # Highlight closest point
                    cx, cy = self.angle_to_xy(closest[0], closest[1])
                    cv2.circle(frame, (cx, cy), 10, (0, 0, 255), 2)
                    cv2.line(frame, (CENTER, CENTER), (cx, cy), (0, 0, 150), 1)

                # Draw stats
                cv2.rectangle(frame, (5, 5), (150, 25 + len(stats) * 20), (0, 0, 0), -1)
                cv2.rectangle(frame, (5, 5), (150, 25 + len(stats) * 20), (50, 50, 50), 1)
                for i, stat in enumerate(stats):
                    cv2.putText(frame, stat, (10, 25 + i * 20),
                               cv2.FONT_HERSHEY_SIMPLEX, 0.5, (200, 200, 200), 1)

                # Title
                cv2.putText(frame, "LIDAR ROOM MAP", (WINDOW_SIZE - 180, 25),
                           cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)

                cv2.imshow('LIDAR Room Map', frame)

                key = cv2.waitKey(1) & 0xFF
                if key == ord('q') or key == 27:
                    break
                elif key == ord('c'):
                    self.persistence_map = np.zeros((WINDOW_SIZE, WINDOW_SIZE, 3), dtype=np.uint8)
                    print("Map cleared")
                elif key == ord('p'):
                    persistence_enabled = not persistence_enabled
                    print(f"Persistence: {'ON' if persistence_enabled else 'OFF'}")
                elif key == ord('d'):
                    show_points = not show_points
                    print(f"Points: {'ON' if show_points else 'OFF'}")
                elif key == ord('s'):
                    filename = f"lidar_map_{int(time.time())}.png"
                    cv2.imwrite(filename, frame)
                    print(f"Saved: {filename}")
                elif key == ord('+') or key == ord('='):
                    self.max_range = min(self.max_range + 1000, 12000)
                    self.scale = (WINDOW_SIZE // 2 - 50) / self.max_range
                    print(f"Range: {self.max_range/1000:.0f}m")
                elif key == ord('-'):
                    self.max_range = max(self.max_range - 1000, 1000)
                    self.scale = (WINDOW_SIZE // 2 - 50) / self.max_range
                    print(f"Range: {self.max_range/1000:.0f}m")

        except KeyboardInterrupt:
            print("\nStopping...")
        finally:
            self.cleanup()

    def cleanup(self):
        """Clean up resources"""
        cv2.destroyAllWindows()
        if self.lidar:
            print("Stopping lidar...")
            try:
                self.lidar.stop()
                self.lidar.stop_motor()
                self.lidar.disconnect()
            except:
                pass
            print("Done.")


def main():
    parser = argparse.ArgumentParser(description='RPLIDAR Room Mapper')
    parser.add_argument('--port', '-p', default=DEFAULT_PORT,
                       help=f'Serial port (default: {DEFAULT_PORT})')
    parser.add_argument('--range', '-r', type=int, default=6000,
                       help='Max display range in mm (default: 6000)')
    args = parser.parse_args()

    mapper = LidarMapper(port=args.port, max_range=args.range)
    mapper.run()


if __name__ == '__main__':
    main()
