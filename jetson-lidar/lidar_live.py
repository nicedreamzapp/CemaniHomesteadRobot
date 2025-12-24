#!/usr/bin/env python3
"""
Simple Live Lidar View - Fast and reliable
"""

import numpy as np
import cv2
from rplidar import RPLidar
import math
import time

LIDAR_PORT = '/dev/ttyUSB0'
SIZE = 800
CENTER = SIZE // 2
MAX_DIST = 6000

# Exclusion zone for mounted camera at 7 o'clock
EXCLUDE_MIN = 205
EXCLUDE_MAX = 220
EXCLUDE_DIST = 400

def main():
    print("Connecting lidar...")
    lidar = RPLidar(LIDAR_PORT)
    info = lidar.get_info()
    print(f"LIDAR OK - Model {info['model']}")

    lidar.start_motor()
    time.sleep(1)

    scale = (SIZE // 2 - 50) / MAX_DIST

    cv2.namedWindow('LIDAR LIVE', cv2.WINDOW_NORMAL)
    cv2.resizeWindow('LIDAR LIVE', SIZE, SIZE)

    print("\nLIDAR LIVE VIEW")
    print("===============")
    print("Q = Quit")
    print("S = Save screenshot")
    print("+/- = Zoom in/out")
    print()

    try:
        for scan in lidar.iter_scans(max_buf_meas=2000, min_len=50):
            # Create fresh image each frame
            img = np.zeros((SIZE, SIZE, 3), dtype=np.uint8)

            # Draw grid rings
            for r in range(1000, 7000, 1000):
                radius = int(r * scale)
                cv2.circle(img, (CENTER, CENTER), radius, (40, 40, 40), 1)
                cv2.putText(img, f"{r//1000}m", (CENTER + 5, CENTER - radius + 15),
                           cv2.FONT_HERSHEY_SIMPLEX, 0.4, (60, 60, 60), 1)

            # Draw crosshairs
            cv2.line(img, (CENTER, 10), (CENTER, SIZE-10), (40, 40, 40), 1)
            cv2.line(img, (10, CENTER), (SIZE-10, CENTER), (40, 40, 40), 1)

            # Process and draw points
            points = []
            for quality, angle, dist in scan:
                if quality > 0 and 100 < dist < MAX_DIST:
                    # Skip excluded zone (mounted camera)
                    if EXCLUDE_MIN <= angle <= EXCLUDE_MAX and dist < EXCLUDE_DIST:
                        continue

                    # Convert to XY
                    rad = math.radians(angle - 90)  # 0 = front
                    x = int(CENTER + dist * scale * math.cos(rad))
                    y = int(CENTER + dist * scale * math.sin(rad))

                    # Color by distance
                    if dist < 1000:
                        color = (0, 0, 255)  # Red - close!
                    elif dist < 2000:
                        color = (0, 140, 255)  # Orange
                    elif dist < 3000:
                        color = (0, 255, 255)  # Yellow
                    else:
                        color = (0, 255, 0)  # Green

                    cv2.circle(img, (x, y), 3, color, -1)
                    points.append((x, y, dist))

            # Connect nearby points to show walls
            points.sort(key=lambda p: math.atan2(p[1] - CENTER, p[0] - CENTER))
            for i in range(1, len(points)):
                x1, y1, d1 = points[i-1]
                x2, y2, d2 = points[i]
                # Only connect if close together
                if abs(x1-x2) < 25 and abs(y1-y2) < 25 and abs(d1-d2) < 500:
                    color = (0, 200, 0)
                    cv2.line(img, (x1, y1), (x2, y2), color, 2)

            # Robot marker
            cv2.circle(img, (CENTER, CENTER), 10, (255, 255, 0), -1)
            # Heading indicator
            cv2.line(img, (CENTER, CENTER), (CENTER, CENTER - 30), (255, 255, 0), 3)

            # Info overlay
            cv2.rectangle(img, (5, 5), (200, 90), (20, 20, 20), -1)
            cv2.putText(img, "LIDAR LIVE", (10, 30),
                       cv2.FONT_HERSHEY_DUPLEX, 0.8, (255, 255, 0), 2)
            cv2.putText(img, f"Points: {len(points)}", (10, 55),
                       cv2.FONT_HERSHEY_SIMPLEX, 0.5, (200, 200, 200), 1)

            # Find closest point
            if points:
                closest = min(points, key=lambda p: p[2])
                cv2.putText(img, f"Closest: {closest[2]/1000:.1f}m", (10, 80),
                           cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 200, 200), 1)
                # Highlight closest
                cv2.circle(img, (closest[0], closest[1]), 10, (0, 0, 255), 2)

            # Direction labels
            cv2.putText(img, "FRONT", (CENTER - 30, 25), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (100, 100, 100), 1)
            cv2.putText(img, "REAR", (CENTER - 25, SIZE - 10), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (100, 100, 100), 1)
            cv2.putText(img, "L", (10, CENTER), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (100, 100, 100), 1)
            cv2.putText(img, "R", (SIZE - 25, CENTER), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (100, 100, 100), 1)

            cv2.imshow('LIDAR LIVE', img)

            key = cv2.waitKey(1) & 0xFF
            if key == ord('q') or key == 27:
                break
            elif key == ord('s'):
                fn = f"lidar_{int(time.time())}.png"
                cv2.imwrite(fn, img)
                print(f"Saved: {fn}")
            elif key == ord('+') or key == ord('='):
                scale *= 1.2
            elif key == ord('-'):
                scale /= 1.2

    except KeyboardInterrupt:
        pass
    finally:
        print("Stopping...")
        lidar.stop()
        lidar.stop_motor()
        lidar.disconnect()
        cv2.destroyAllWindows()
        print("Done")


if __name__ == '__main__':
    main()
