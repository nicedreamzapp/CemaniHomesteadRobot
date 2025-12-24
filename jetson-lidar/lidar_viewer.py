#!/usr/bin/env python3
"""
RPLIDAR A1 Standalone Visualization
Displays 360-degree lidar scan in a radar-style window
"""

import sys
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.animation import FuncAnimation
from rplidar import RPLidar
import argparse

# Default settings
DEFAULT_PORT = '/dev/ttyUSB0'
MAX_DISTANCE = 6000  # 6 meters in mm (A1 max range)

class LidarViewer:
    def __init__(self, port=DEFAULT_PORT):
        self.port = port
        self.lidar = None
        self.scan_data = np.zeros((360, 2))  # angle, distance

        # Set up the plot
        plt.style.use('dark_background')
        self.fig = plt.figure(figsize=(10, 10))
        self.ax = self.fig.add_subplot(111, projection='polar')
        self.ax.set_title('RPLIDAR A1 - 360° Scan', color='cyan', fontsize=14, pad=20)

        # Configure polar plot
        self.ax.set_theta_zero_location('N')  # 0 degrees at top
        self.ax.set_theta_direction(-1)  # Clockwise
        self.ax.set_rlim(0, MAX_DISTANCE)
        self.ax.set_rticks([1000, 2000, 3000, 4000, 5000, 6000])
        self.ax.set_yticklabels(['1m', '2m', '3m', '4m', '5m', '6m'], fontsize=8)
        self.ax.grid(True, alpha=0.3, color='green')
        self.ax.set_facecolor('#001100')

        # Initialize the scatter plot
        self.scatter = self.ax.scatter([], [], c='lime', s=2, alpha=0.8)

        # Add range rings with labels
        for r in range(1000, 7000, 1000):
            circle = plt.Circle((0, 0), r, fill=False, color='green', alpha=0.2,
                               transform=self.ax.transData._b, linewidth=0.5)

        # Stats text
        self.stats_text = self.ax.text(0.02, 0.98, '', transform=self.fig.transFigure,
                                       fontsize=10, color='cyan',
                                       verticalalignment='top', family='monospace')

    def connect(self):
        """Connect to the RPLIDAR"""
        try:
            print(f"Connecting to RPLIDAR on {self.port}...")
            self.lidar = RPLidar(self.port)
            info = self.lidar.get_info()
            health = self.lidar.get_health()
            print(f"Model: {info['model']}")
            print(f"Firmware: {info['firmware'][0]}.{info['firmware'][1]}")
            print(f"Hardware: {info['hardware']}")
            print(f"Serial: {info['serialnumber']}")
            print(f"Health: {health[0]} (code: {health[1]})")
            return True
        except Exception as e:
            print(f"Error connecting to RPLIDAR: {e}")
            return False

    def update(self, frame):
        """Update function for animation"""
        try:
            # Get one scan
            for scan in self.lidar.iter_scans(max_buf_meas=500):
                angles = []
                distances = []

                for quality, angle, distance in scan:
                    if quality > 0 and distance > 0:
                        # Convert to radians
                        angles.append(np.radians(angle))
                        distances.append(distance)

                if angles:
                    self.scatter.set_offsets(np.column_stack([angles, distances]))

                    # Update stats
                    min_dist = min(distances) if distances else 0
                    max_dist = max(distances) if distances else 0
                    avg_dist = np.mean(distances) if distances else 0
                    points = len(distances)

                    stats = f"Points: {points:4d} | Min: {min_dist/1000:.2f}m | Max: {max_dist/1000:.2f}m | Avg: {avg_dist/1000:.2f}m"
                    self.stats_text.set_text(stats)

                break  # Only process one scan per frame

        except Exception as e:
            print(f"Scan error: {e}")

        return self.scatter, self.stats_text

    def run(self):
        """Start the visualization"""
        if not self.connect():
            return

        try:
            print("\nStarting visualization... Press Ctrl+C to exit")
            print("Close the window or press 'q' to quit\n")

            # Start motor
            self.lidar.start_motor()

            # Create animation
            ani = FuncAnimation(self.fig, self.update, interval=100,
                              blit=True, cache_frame_data=False)

            # Handle window close
            def on_close(event):
                self.cleanup()

            self.fig.canvas.mpl_connect('close_event', on_close)

            plt.tight_layout()
            plt.show()

        except KeyboardInterrupt:
            print("\nStopping...")
        finally:
            self.cleanup()

    def cleanup(self):
        """Clean up resources"""
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
    parser = argparse.ArgumentParser(description='RPLIDAR A1 Visualization')
    parser.add_argument('--port', '-p', default=DEFAULT_PORT,
                       help=f'Serial port (default: {DEFAULT_PORT})')
    parser.add_argument('--range', '-r', type=int, default=6000,
                       help='Max display range in mm (default: 6000)')
    args = parser.parse_args()

    global MAX_DISTANCE
    MAX_DISTANCE = args.range

    viewer = LidarViewer(port=args.port)
    viewer.run()


if __name__ == '__main__':
    main()
