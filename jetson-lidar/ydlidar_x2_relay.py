#!/usr/bin/env python3
"""
YDLidar X2/X2L Relay Service - Correct protocol
Data format: 5-byte packets with 0x3E separator
"""

import json
import time
import serial
import websocket
import ssl

LIDAR_PORT = '/dev/ttyUSB0'
LIDAR_BAUD = 115200
VPS_WS_URL = 'wss://robot.marijuanaunion.com'
SEND_INTERVAL = 0.1  # 10 Hz

class YDLidarX2Relay:
    def __init__(self):
        self.serial = None
        self.ws = None
        self.running = True
        self.connected = False

    def connect_lidar(self):
        try:
            print(f"Connecting to YDLidar X2 on {LIDAR_PORT}...")
            self.serial = serial.Serial(LIDAR_PORT, LIDAR_BAUD, timeout=0.5)
            self.serial.setDTR(False)  # Start motor
            time.sleep(1)
            # Clear buffer
            self.serial.reset_input_buffer()
            print("YDLidar X2 connected - motor started")
            return True
        except Exception as e:
            print(f"YDLidar error: {e}")
            return False

    def connect_ws(self):
        try:
            print(f"Connecting to VPS...")
            self.ws = websocket.create_connection(
                VPS_WS_URL,
                sslopt={"cert_reqs": ssl.CERT_NONE}
            )
            self.ws.send(json.dumps({
                "type": "identify",
                "device": "jetson-lidar"
            }))
            print("Connected to VPS WebSocket")
            self.connected = True
            return True
        except Exception as e:
            print(f"WebSocket error: {e}")
            self.connected = False
            return False

    def parse_data(self, data):
        """
        Parse YDLidar X2 data format:
        Each point is ~5 bytes, with 0x3E as separator
        Format appears to be: [angle_low, angle_high, distance_low, distance_high, 0x3E]
        """
        points = []
        i = 0
        while i < len(data) - 4:
            # Find 0x3E separator
            if data[i + 4] == 0x3E:
                # Parse 4 bytes before separator
                angle_raw = data[i] | (data[i + 1] << 8)
                dist_raw = data[i + 2] | (data[i + 3] << 8)

                # Convert to angle (degrees) and distance (mm)
                # YDLidar X2 angle is in 0.01 degrees
                angle = (angle_raw / 100.0) % 360.0
                distance = dist_raw

                if 10 < distance < 8000:  # Valid range
                    points.append((angle, distance))
                i += 5
            else:
                i += 1
        return points

    def read_scan(self):
        """Read ~1 second of LIDAR data for a full scan"""
        all_data = bytearray()
        start = time.time()

        while time.time() - start < 0.5:
            if self.serial.in_waiting > 0:
                all_data.extend(self.serial.read(self.serial.in_waiting))
            time.sleep(0.01)

        if len(all_data) < 100:
            return []

        return self.parse_data(all_data)

    def run(self):
        if not self.connect_lidar():
            return

        print("Starting LIDAR relay loop...")
        last_send = 0

        while self.running:
            if not self.connected:
                if not self.connect_ws():
                    time.sleep(2)
                    continue

            try:
                now = time.time()
                if now - last_send >= SEND_INTERVAL:
                    points = self.read_scan()
                    if points and len(points) > 20:
                        msg = {
                            "type": "lidar",
                            "points": points,
                            "count": len(points)
                        }
                        self.ws.send(json.dumps(msg))
                        print(f"[LIDAR] Sent {len(points)} points")
                        last_send = now
            except websocket.WebSocketConnectionClosedException:
                print("WebSocket disconnected")
                self.connected = False
            except Exception as e:
                print(f"Error: {e}")
                time.sleep(0.1)

    def stop(self):
        self.running = False
        if self.serial:
            self.serial.setDTR(True)
            self.serial.close()
        if self.ws:
            self.ws.close()

if __name__ == "__main__":
    relay = YDLidarX2Relay()
    try:
        relay.run()
    except KeyboardInterrupt:
        print("\nShutting down...")
    finally:
        relay.stop()
