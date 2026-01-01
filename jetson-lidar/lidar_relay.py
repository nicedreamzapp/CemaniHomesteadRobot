#!/usr/bin/env python3
"""
Lidar Relay Service
Reads RPLIDAR data and sends to VPS server via WebSocket
Runs as a background service on Jetson
"""

import json
import time
import math
import threading
from rplidar import RPLidar
import websocket
import ssl

# Configuration
LIDAR_PORT = '/dev/ttyUSB0'
VPS_WS_URL = 'wss://robot.marijuanaunion.com'

# Exclusion zone for mounted camera at 7 o'clock
EXCLUDE_MIN = 205
EXCLUDE_MAX = 220
EXCLUDE_DIST = 400

# Send rate limiting - REAL-TIME response
SEND_INTERVAL = 0.033  # Send data every 33ms (~30 fps)


class LidarRelay:
    def __init__(self):
        self.lidar = None
        self.ws = None
        self.running = True
        self.connected = False
        self.last_send = 0
        self.current_scan = []
        self.lock = threading.Lock()

    def connect_lidar(self):
        """Connect to RPLIDAR"""
        try:
            print("Connecting to LIDAR...")
            self.lidar = RPLidar(LIDAR_PORT)
            info = self.lidar.get_info()
            print(f"LIDAR connected - Model {info['model']}")
            return True
        except Exception as e:
            print(f"LIDAR error: {e}")
            return False

    def lidar_thread(self):
        """Thread to continuously read lidar"""
        consecutive_errors = 0
        while self.running:
            try:
                if not self.connect_lidar():
                    time.sleep(5)
                    continue

                self.lidar.start_motor()
                time.sleep(1)
                print("LIDAR motor started, scanning...")
                consecutive_errors = 0  # Reset on successful start

                for scan in self.lidar.iter_scans(max_buf_meas=2000, min_len=50):
                    if not self.running:
                        break

                    # Process scan - filter and convert
                    points = []
                    for quality, angle, dist in scan:
                        if quality > 0 and 100 < dist < 6000:
                            # Skip excluded zone (mounted camera)
                            if EXCLUDE_MIN <= angle <= EXCLUDE_MAX and dist < EXCLUDE_DIST:
                                continue
                            # Store as [angle, distance_mm]
                            points.append([round(angle, 1), int(dist)])

                    with self.lock:
                        self.current_scan = points

            except Exception as e:
                consecutive_errors += 1
                print(f"LIDAR error ({consecutive_errors}): {e}")
                # Only do full restart after multiple consecutive errors
                if consecutive_errors >= 3:
                    print("Multiple errors - restarting LIDAR...")
                    try:
                        if self.lidar:
                            self.lidar.stop()
                            self.lidar.stop_motor()
                            self.lidar.disconnect()
                            self.lidar = None
                    except:
                        pass
                    consecutive_errors = 0
                    time.sleep(3)
                else:
                    time.sleep(0.5)  # Brief pause before retry
                continue  # Try again without full restart

            # Only reach here if iter_scans exits normally (shouldn't happen)
            try:
                if self.lidar:
                    self.lidar.stop()
                    self.lidar.stop_motor()
                    self.lidar.disconnect()
                    self.lidar = None
            except:
                pass

            if self.running:
                time.sleep(2)

    def on_ws_open(self, ws):
        print("WebSocket connected to VPS")
        self.connected = True
        # Identify as Jetson lidar source
        ws.send(json.dumps({
            'type': 'identify',
            'device': 'jetson-lidar'
        }))

    def on_ws_close(self, ws, code, msg):
        print(f"WebSocket closed: {code}")
        self.connected = False

    def on_ws_error(self, ws, error):
        print(f"WebSocket error: {error}")
        self.connected = False

    def on_ws_message(self, ws, message):
        # We mainly send, but could receive commands
        pass

    def websocket_thread(self):
        """Thread to maintain WebSocket connection and send data"""
        while self.running:
            try:
                print(f"Connecting to VPS: {VPS_WS_URL}")
                self.ws = websocket.WebSocketApp(
                    VPS_WS_URL,
                    on_open=self.on_ws_open,
                    on_close=self.on_ws_close,
                    on_error=self.on_ws_error,
                    on_message=self.on_ws_message
                )

                # Run in background with ping
                ws_thread = threading.Thread(
                    target=self.ws.run_forever,
                    kwargs={'ping_interval': 30, 'ping_timeout': 10}
                )
                ws_thread.daemon = True
                ws_thread.start()

                # Send data loop
                while self.running and ws_thread.is_alive():
                    if self.connected:
                        now = time.time()
                        if now - self.last_send >= SEND_INTERVAL:
                            self.send_lidar_data()
                            self.last_send = now
                    time.sleep(0.02)  # Faster loop for lower latency

            except Exception as e:
                print(f"WebSocket error: {e}")
                self.connected = False

            if self.running:
                time.sleep(3)

    def send_lidar_data(self):
        """Send current lidar scan to VPS"""
        if not self.connected or not self.ws:
            return

        with self.lock:
            points = self.current_scan.copy()

        if not points:
            return

        # Downsample if too many points (keep every Nth point)
        # RPLIDAR A1M8 does ~1450 pts/scan - keep up to 1200 for best detail
        if len(points) > 1200:
            step = len(points) // 1200
            points = points[::step]

        try:
            self.ws.send(json.dumps({
                'type': 'lidar',
                'points': points,  # [[angle, dist], ...]
                'count': len(points),
                'ts': int(time.time() * 1000)
            }))
        except Exception as e:
            print(f"Send error: {e}")
            self.connected = False

    def run(self):
        """Start the relay service"""
        print("="*50)
        print("  LIDAR RELAY SERVICE")
        print("="*50)
        print(f"  LIDAR: {LIDAR_PORT}")
        print(f"  VPS:   {VPS_WS_URL}")
        print("="*50)

        # Start threads
        lidar_t = threading.Thread(target=self.lidar_thread, daemon=True)
        lidar_t.start()

        ws_t = threading.Thread(target=self.websocket_thread, daemon=True)
        ws_t.start()

        print("\nRelay running. Press Ctrl+C to stop.\n")

        try:
            while self.running:
                time.sleep(1)
        except KeyboardInterrupt:
            print("\nStopping...")
            self.running = False

        print("Done")


def main():
    relay = LidarRelay()
    relay.run()


if __name__ == '__main__':
    main()
