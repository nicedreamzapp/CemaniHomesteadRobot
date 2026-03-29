#!/usr/bin/env python3 -u
"""
YDLidar X2/X2L Relay Service - Sends LIDAR data to VPS
"""

import json
import time
import serial
import websocket
import ssl
import threading

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
        self.points_buffer = []
        self.lock = threading.Lock()

    def connect_lidar(self):
        try:
            print(f"Connecting to YDLidar X2 on {LIDAR_PORT}...")
            self.serial = serial.Serial(LIDAR_PORT, LIDAR_BAUD, timeout=0.5)
            self.serial.setDTR(False)  # Start motor
            time.sleep(1)
            self.serial.reset_input_buffer()
            print("YDLidar X2 connected - motor started")
            return True
        except Exception as e:
            print(f"YDLidar error: {e}")
            return False

    def connect_ws(self):
        try:
            print("Connecting to VPS...")
            self.ws = websocket.WebSocket()
            self.ws.connect(
                VPS_WS_URL,
                sslopt={"cert_reqs": ssl.CERT_NONE}
            )
            # Enable ping/pong so server doesn't disconnect us
            self.ws.ping_interval = 20
            self.ws.ping_timeout = 10

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
        """Parse YDLidar X2 5-byte packets: [angle_lo, angle_hi, dist_lo, dist_hi, 0x3E]"""
        points = []
        i = 0
        while i < len(data) - 4:
            if data[i + 4] == 0x3E:
                angle_raw = data[i] | (data[i + 1] << 8)
                dist_raw = data[i + 2] | (data[i + 3] << 8)
                angle = (angle_raw / 100.0) % 360.0
                distance = dist_raw
                if 10 < distance < 8000:
                    points.append((round(angle, 1), distance))
                i += 5
            else:
                i += 1
        return points

    def read_scan(self):
        """Read ~0.5s of LIDAR data"""
        all_data = bytearray()
        start = time.time()
        while time.time() - start < 0.5:
            if self.serial.in_waiting > 0:
                all_data.extend(self.serial.read(self.serial.in_waiting))
            time.sleep(0.01)
        if len(all_data) < 100:
            return []
        return self.parse_data(all_data)

    def ping_loop(self):
        """Send WebSocket pings to keep connection alive"""
        while self.running:
            try:
                if self.connected and self.ws:
                    self.ws.ping()
            except:
                self.connected = False
            time.sleep(15)

    def run(self):
        if not self.connect_lidar():
            return

        # Start ping thread
        ping_thread = threading.Thread(target=self.ping_loop, daemon=True)
        ping_thread.start()

        print("Starting LIDAR relay loop...")
        last_send = 0
        send_count = 0

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
                        msg = json.dumps({
                            "type": "lidar",
                            "points": points,
                            "count": len(points)
                        })
                        self.ws.send(msg)
                        send_count += 1
                        if send_count % 10 == 0:
                            print(f"[LIDAR] Sent {len(points)} pts (total: {send_count} scans)")
                        last_send = now
            except (websocket.WebSocketConnectionClosedException, BrokenPipeError, ConnectionResetError):
                print("WebSocket disconnected - reconnecting...")
                self.connected = False
                time.sleep(1)
            except Exception as e:
                print(f"Error: {e}")
                time.sleep(0.1)

    def stop(self):
        self.running = False
        if self.serial:
            self.serial.setDTR(True)
            self.serial.close()
        if self.ws:
            try:
                self.ws.close()
            except:
                pass

if __name__ == "__main__":
    relay = YDLidarX2Relay()
    try:
        relay.run()
    except KeyboardInterrupt:
        print("\nShutting down...")
    finally:
        relay.stop()
