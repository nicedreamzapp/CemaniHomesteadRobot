#!/usr/bin/env python3
"""
YDLidar X2/X2L Relay Service
Reads YDLidar data via serial and sends to VPS server via WebSocket
"""

import json
import time
import math
import threading
import serial
import websocket
import ssl
import struct

# Configuration
LIDAR_PORT = '/dev/ttyUSB0'
LIDAR_BAUD = 115200
VPS_WS_URL = 'wss://robot.marijuanaunion.com'

# YDLidar X2 protocol constants
SYNC_BYTE = 0xAA
HEADER_SIZE = 10

class YDLidarRelay:
    def __init__(self):
        self.serial = None
        self.ws = None
        self.running = True
        self.connected = False
        self.last_send = 0
        self.current_scan = []
        self.lock = threading.Lock()

    def connect_lidar(self):
        """Connect to YDLidar via serial"""
        try:
            print(f"Connecting to YDLidar on {LIDAR_PORT}...")
            self.serial = serial.Serial(
                LIDAR_PORT,
                LIDAR_BAUD,
                timeout=1,
                bytesize=serial.EIGHTBITS,
                parity=serial.PARITY_NONE,
                stopbits=serial.STOPBITS_ONE
            )
            # Start motor (DTR low)
            self.serial.setDTR(False)
            time.sleep(0.5)
            print("YDLidar connected - motor started")
            return True
        except Exception as e:
            print(f"YDLidar error: {e}")
            return False

    def connect_ws(self):
        """Connect to VPS WebSocket"""
        try:
            print(f"Connecting to VPS at {VPS_WS_URL}...")
            self.ws = websocket.create_connection(
                VPS_WS_URL,
                sslopt={"cert_reqs": ssl.CERT_NONE}
            )
            # Identify as lidar relay
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

    def parse_packet(self, data):
        """Parse YDLidar X2 packet format"""
        points = []
        try:
            if len(data) < HEADER_SIZE:
                return points

            # X2 packet: [0xAA, 0x55, type, sample_count, start_angle_L, start_angle_H, end_angle_L, end_angle_H, check_L, check_H, data...]
            if data[0] != 0xAA or data[1] != 0x55:
                return points

            sample_count = data[3]
            if sample_count == 0:
                return points

            start_angle = (data[5] << 8 | data[4]) / 64.0
            end_angle = (data[7] << 8 | data[6]) / 64.0

            if end_angle < start_angle:
                end_angle += 360

            angle_step = (end_angle - start_angle) / max(sample_count - 1, 1)

            # Data starts at offset 10, each sample is 2 bytes (distance)
            for i in range(sample_count):
                idx = 10 + i * 2
                if idx + 1 < len(data):
                    distance = data[idx] | (data[idx + 1] << 8)
                    if 10 < distance < 8000:  # Valid range 10mm to 8m
                        angle = (start_angle + i * angle_step) % 360
                        points.append((angle, distance))
        except Exception as e:
            pass
        return points

    def read_scan(self):
        """Read a complete 360° scan from the LIDAR"""
        scan_points = []
        start_time = time.time()
        buffer = bytearray()

        while time.time() - start_time < 1.0:  # Max 1 second per scan
            if self.serial.in_waiting > 0:
                buffer.extend(self.serial.read(self.serial.in_waiting))

                # Find sync bytes
                while len(buffer) >= 2:
                    if buffer[0] == 0xAA and buffer[1] == 0x55:
                        if len(buffer) >= 10:
                            sample_count = buffer[3]
                            packet_len = 10 + sample_count * 2
                            if len(buffer) >= packet_len:
                                packet = buffer[:packet_len]
                                buffer = buffer[packet_len:]
                                points = self.parse_packet(packet)
                                scan_points.extend(points)
                            else:
                                break
                        else:
                            break
                    else:
                        buffer.pop(0)

            # Check if we have a full scan (points covering most of 360°)
            if len(scan_points) > 200:
                angles = [p[0] for p in scan_points]
                if max(angles) - min(angles) > 300:
                    break

            time.sleep(0.01)

        return scan_points

    def run(self):
        """Main loop"""
        if not self.connect_lidar():
            return

        print("Starting LIDAR relay loop...")
        reconnect_delay = 1

        while self.running:
            if not self.connected:
                if self.connect_ws():
                    reconnect_delay = 1
                else:
                    time.sleep(reconnect_delay)
                    reconnect_delay = min(reconnect_delay * 2, 30)
                    continue

            try:
                scan = self.read_scan()
                if scan and len(scan) > 50:
                    # Send to VPS
                    msg = {
                        "type": "lidar",
                        "points": scan,
                        "count": len(scan),
                        "timestamp": time.time()
                    }
                    self.ws.send(json.dumps(msg))
                    print(f"[LIDAR] Sent {len(scan)} points")
            except websocket.WebSocketConnectionClosedException:
                print("WebSocket disconnected")
                self.connected = False
            except Exception as e:
                print(f"Error: {e}")
                time.sleep(0.1)

    def stop(self):
        """Clean shutdown"""
        self.running = False
        if self.serial:
            self.serial.setDTR(True)  # Stop motor
            self.serial.close()
        if self.ws:
            self.ws.close()


if __name__ == "__main__":
    relay = YDLidarRelay()
    try:
        relay.run()
    except KeyboardInterrupt:
        print("\nShutting down...")
    finally:
        relay.stop()
