#!/usr/bin/env python3
"""
Local WebSocket Streamer for Jetson
Streams camera frames + detections directly to Mac over WiFi
Bypasses VPS for heavy data, VPS only gets the processed map
"""

import asyncio
import websockets
import json
import cv2
import base64
import time
import threading
from collections import deque

# Configuration
LOCAL_WS_PORT = 8765
RTSP_CAMERAS = {
    1: "rtsp://admin:kookster1@192.168.1.79:554/onvif1",  # Front
    2: "rtsp://admin:kookster1@192.168.1.34:554/onvif1"    # Rear
}
FRAME_RATE = 10  # Frames per second per camera
JPEG_QUALITY = 80  # JPEG compression quality

# Shared state
clients = set()
frame_queues = {1: deque(maxlen=3), 2: deque(maxlen=3)}
detection_queue = deque(maxlen=10)
lidar_queue = deque(maxlen=5)
running = True

def capture_camera(cam_id, rtsp_url):
    """Capture frames from RTSP camera"""
    global running
    print(f"[CAM{cam_id}] Starting capture: {rtsp_url}")

    while running:
        try:
            cap = cv2.VideoCapture(rtsp_url, cv2.CAP_FFMPEG)
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

            if not cap.isOpened():
                print(f"[CAM{cam_id}] Failed to open, retrying...")
                time.sleep(2)
                continue

            frame_interval = 1.0 / FRAME_RATE
            last_frame = 0

            while running and cap.isOpened():
                ret, frame = cap.read()
                if not ret:
                    print(f"[CAM{cam_id}] Lost frame, reconnecting...")
                    break

                now = time.time()
                if now - last_frame >= frame_interval:
                    last_frame = now

                    # Resize for efficiency
                    h, w = frame.shape[:2]
                    if w > 640:
                        scale = 640 / w
                        frame = cv2.resize(frame, (640, int(h * scale)))

                    # Encode to JPEG
                    _, jpeg = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
                    b64 = base64.b64encode(jpeg.tobytes()).decode('utf-8')

                    frame_queues[cam_id].append({
                        "type": "camera_frame",
                        "camera": cam_id,
                        "timestamp": now,
                        "frame": b64,
                        "width": frame.shape[1],
                        "height": frame.shape[0]
                    })

            cap.release()
        except Exception as e:
            print(f"[CAM{cam_id}] Error: {e}")
            time.sleep(2)

async def broadcast():
    """Broadcast frames to all connected clients"""
    global running
    while running:
        try:
            # Send camera frames
            for cam_id in [1, 2]:
                if frame_queues[cam_id]:
                    frame_data = frame_queues[cam_id].popleft()
                    if clients:
                        msg = json.dumps(frame_data)
                        await asyncio.gather(
                            *[client.send(msg) for client in clients.copy()],
                            return_exceptions=True
                        )

            # Send detections
            if detection_queue:
                det_data = detection_queue.popleft()
                if clients:
                    msg = json.dumps(det_data)
                    await asyncio.gather(
                        *[client.send(msg) for client in clients.copy()],
                        return_exceptions=True
                    )

            # Send LIDAR
            if lidar_queue:
                lidar_data = lidar_queue.popleft()
                if clients:
                    msg = json.dumps(lidar_data)
                    await asyncio.gather(
                        *[client.send(msg) for client in clients.copy()],
                        return_exceptions=True
                    )

            await asyncio.sleep(0.01)  # 100Hz check rate
        except Exception as e:
            print(f"[BROADCAST] Error: {e}")
            await asyncio.sleep(0.1)

async def handle_client(websocket, path):
    """Handle client connection"""
    clients.add(websocket)
    client_ip = websocket.remote_address[0]
    print(f"[WS] Client connected: {client_ip} (total: {len(clients)})")

    try:
        async for message in websocket:
            try:
                data = json.loads(message)
                # Handle incoming commands (PTZ, etc)
                if data.get("type") == "ptz":
                    # Forward to camera control
                    pass
            except:
                pass
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        clients.discard(websocket)
        print(f"[WS] Client disconnected: {client_ip} (total: {len(clients)})")

def add_detection(detection_data):
    """Add detection to broadcast queue (called from detect.py)"""
    detection_queue.append(detection_data)

def add_lidar(lidar_data):
    """Add LIDAR data to broadcast queue"""
    lidar_queue.append(lidar_data)

async def main():
    print(f"""
╔══════════════════════════════════════════════════════════════╗
║  JETSON LOCAL STREAMER                                       ║
║  Direct WiFi → Mac (bypasses VPS for heavy data)             ║
╠══════════════════════════════════════════════════════════════╣
║  WebSocket: ws://192.168.1.228:{LOCAL_WS_PORT}                        ║
║  Cameras: {len(RTSP_CAMERAS)} @ {FRAME_RATE} FPS                                      ║
╚══════════════════════════════════════════════════════════════╝
""")

    # Start camera capture threads
    for cam_id, url in RTSP_CAMERAS.items():
        t = threading.Thread(target=capture_camera, args=(cam_id, url), daemon=True)
        t.start()

    # Start broadcast task
    asyncio.create_task(broadcast())

    # Start WebSocket server
    server = await websockets.serve(
        handle_client,
        "0.0.0.0",
        LOCAL_WS_PORT,
        max_size=10 * 1024 * 1024,  # 10MB max message
        ping_interval=20,
        ping_timeout=60
    )

    print(f"[WS] Server listening on port {LOCAL_WS_PORT}")
    await server.wait_closed()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        running = False
        print("\n[EXIT] Shutting down...")
