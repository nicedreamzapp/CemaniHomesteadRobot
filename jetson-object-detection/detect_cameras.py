#!/usr/bin/env python3
"""
YOLOv8 OIV7 Object Detection for Cemani Robot
Runs on Jetson Orin - processes RTSP camera streams and sends detections to VPS
Uses 601 object classes from Open Images V7 dataset
"""

import cv2
import json
import time
import asyncio
import websockets
import threading
import numpy as np
from collections import deque
from ultralytics import YOLO

# === CONFIGURATION ===
CONFIG_FILE = "config.json"
DEFAULT_CONFIG = {
    "cameras": [
        {
            "id": 1,
            "name": "Front",
            "rtsp_url": "rtsp://admin:kookster1@192.168.1.191:554/onvif1"
        },
        {
            "id": 2,
            "name": "Rear",
            "rtsp_url": "rtsp://admin:kookster1@192.168.1.27:554/onvif1"
        }
    ],
    "vps_ws_url": "ws://72.60.124.34:3001",
    "model_path": "yolov8n-oiv7.pt",
    "inference_size": 640,
    "confidence_threshold": 0.05,
    "small_object_threshold": 0.03,
    "iou_threshold": 0.4,
    "inference_interval_ms": 200,
    "max_detections_per_frame": 20
}

# Living creatures get special treatment (circle overlay for head tracking)
LIVING_CLASSES = [
    "person", "bird", "cat", "dog", "horse", "sheep", "cow",
    "elephant", "bear", "zebra", "giraffe", "rabbit", "duck",
    "chicken", "turkey", "goose", "deer", "squirrel", "mouse",
    "rat", "pig", "goat", "donkey", "fox", "wolf", "coyote"
]

# Small objects need lower confidence threshold
SMALL_OBJECTS = [
    "pen", "pencil", "eraser", "marker", "key", "coin", "button",
    "needle", "pin", "clip", "paperclip", "stapler", "tape",
    "scissors", "nail", "screw", "bolt", "nut", "ring", "earring",
    "watch", "glasses", "toothbrush", "razor", "comb", "spoon",
    "fork", "knife", "egg", "insect", "bug", "spider", "ant", "bee"
]

# Priority objects for robot safety/awareness
PRIORITY_OBJECTS = [
    "person", "dog", "cat", "car", "truck", "bicycle", "motorcycle",
    "bird", "chicken", "duck", "deer", "horse", "cow", "pig",
    "fire hydrant", "stop sign", "traffic light"
]

class CameraProcessor:
    def __init__(self, cam_config, model, config):
        self.cam_id = cam_config["id"]
        self.cam_name = cam_config["name"]
        self.rtsp_url = cam_config["rtsp_url"]
        self.model = model
        self.config = config
        self.running = False
        self.last_frame = None
        self.last_detections = []
        self.fps = 0
        self.cap = None
        self.lock = threading.Lock()

    def start(self):
        self.running = True
        self.thread = threading.Thread(target=self._capture_loop, daemon=True)
        self.thread.start()
        print(f"[CAM{self.cam_id}] Started {self.cam_name} camera processor")

    def stop(self):
        self.running = False
        if self.cap:
            self.cap.release()

    def _capture_loop(self):
        retry_count = 0
        max_retries = 5

        while self.running:
            try:
                # Open RTSP stream with optimized settings for Jetson
                self.cap = cv2.VideoCapture(self.rtsp_url, cv2.CAP_FFMPEG)
                self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)  # Minimize latency

                if not self.cap.isOpened():
                    print(f"[CAM{self.cam_id}] Failed to open {self.cam_name} stream, retrying...")
                    retry_count += 1
                    if retry_count > max_retries:
                        print(f"[CAM{self.cam_id}] Max retries reached, waiting 10s...")
                        time.sleep(10)
                        retry_count = 0
                    else:
                        time.sleep(2)
                    continue

                print(f"[CAM{self.cam_id}] Connected to {self.cam_name}")
                retry_count = 0
                frame_time = time.time()

                while self.running and self.cap.isOpened():
                    ret, frame = self.cap.read()
                    if not ret:
                        print(f"[CAM{self.cam_id}] Lost frame from {self.cam_name}")
                        break

                    # Calculate FPS
                    now = time.time()
                    self.fps = 1.0 / (now - frame_time + 1e-8)
                    frame_time = now

                    with self.lock:
                        self.last_frame = frame

            except Exception as e:
                print(f"[CAM{self.cam_id}] Error: {e}")
                time.sleep(2)

        if self.cap:
            self.cap.release()

    def get_frame(self):
        with self.lock:
            return self.last_frame.copy() if self.last_frame is not None else None


class ObjectDetector:
    def __init__(self):
        self.config = self._load_config()
        self.model = None
        self.cameras = {}
        self.ws_connection = None
        self.detection_queue = deque(maxlen=100)
        self.running = False

    def _load_config(self):
        try:
            with open(CONFIG_FILE, 'r') as f:
                config = json.load(f)
                # Merge with defaults
                for key, value in DEFAULT_CONFIG.items():
                    if key not in config:
                        config[key] = value
                return config
        except FileNotFoundError:
            print(f"[CONFIG] {CONFIG_FILE} not found, using defaults")
            return DEFAULT_CONFIG.copy()

    def _load_model(self):
        print(f"[MODEL] Loading YOLOv8 OIV7 model: {self.config['model_path']}")
        try:
            self.model = YOLO(self.config['model_path'])
            print(f"[MODEL] Loaded with {len(self.model.names)} classes")
            # Print some available classes
            sample_classes = list(self.model.names.values())[:20]
            print(f"[MODEL] Sample classes: {sample_classes}")
            return True
        except Exception as e:
            print(f"[MODEL] Failed to load model: {e}")
            return False

    def _init_cameras(self):
        for cam_config in self.config['cameras']:
            cam = CameraProcessor(cam_config, self.model, self.config)
            self.cameras[cam_config['id']] = cam
            cam.start()

    def _run_inference(self, frame, cam_id):
        """Run YOLOv8 inference on a frame"""
        if frame is None or self.model is None:
            return []

        try:
            # Resize for inference
            h, w = frame.shape[:2]
            size = self.config['inference_size']

            # Run inference
            results = self.model(
                frame,
                stream=False,
                conf=self.config['small_object_threshold'],
                iou=self.config['iou_threshold'],
                imgsz=size,
                verbose=False
            )

            detections = []
            for r in results:
                boxes = r.boxes
                for box in boxes:
                    x1, y1, x2, y2 = box.xyxy[0].cpu().numpy()
                    conf = float(box.conf[0])
                    cls_id = int(box.cls[0])
                    class_name = self.model.names[cls_id].lower()

                    # Apply appropriate confidence threshold
                    if class_name in SMALL_OBJECTS:
                        threshold = self.config['small_object_threshold']
                    else:
                        threshold = self.config['confidence_threshold']

                    if conf < threshold:
                        continue

                    # Calculate center and size
                    cx = (x1 + x2) / 2 / w  # Normalized 0-1
                    cy = (y1 + y2) / 2 / h
                    box_w = (x2 - x1) / w
                    box_h = (y2 - y1) / h

                    detection = {
                        "camera": cam_id,
                        "class": class_name,
                        "confidence": round(conf, 3),
                        "bbox": {
                            "x": round(cx, 3),
                            "y": round(cy, 3),
                            "w": round(box_w, 3),
                            "h": round(box_h, 3)
                        },
                        "is_living": class_name in LIVING_CLASSES,
                        "is_priority": class_name in PRIORITY_OBJECTS,
                        "timestamp": time.time()
                    }
                    detections.append(detection)

                    # Limit detections per frame
                    if len(detections) >= self.config['max_detections_per_frame']:
                        break

            return detections

        except Exception as e:
            print(f"[DETECT] Inference error: {e}")
            return []

    async def _send_detections(self, detections, cam_id):
        """Send detections to VPS via WebSocket"""
        if not detections:
            return

        try:
            if self.ws_connection is None or self.ws_connection.closed:
                self.ws_connection = await websockets.connect(
                    self.config['vps_ws_url'],
                    ping_interval=20,
                    ping_timeout=10
                )
                print(f"[WS] Connected to VPS")

            message = {
                "type": "DETECTIONS",
                "camera": cam_id,
                "detections": detections,
                "count": len(detections)
            }
            await self.ws_connection.send(json.dumps(message))

        except Exception as e:
            print(f"[WS] Send error: {e}")
            self.ws_connection = None

    def _inference_loop(self):
        """Main inference loop - runs on separate thread"""
        interval = self.config['inference_interval_ms'] / 1000.0
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        print("[DETECT] Starting inference loop")

        while self.running:
            start = time.time()

            for cam_id, cam in self.cameras.items():
                frame = cam.get_frame()
                if frame is not None:
                    detections = self._run_inference(frame, cam_id)

                    if detections:
                        # Print summary
                        classes = [d['class'] for d in detections]
                        priority = [d for d in detections if d['is_priority']]
                        print(f"[CAM{cam_id}] {len(detections)} objects: {classes[:5]}{'...' if len(classes) > 5 else ''}")

                        if priority:
                            print(f"[CAM{cam_id}] PRIORITY: {[p['class'] for p in priority]}")

                        # Send to VPS
                        loop.run_until_complete(self._send_detections(detections, cam_id))

            # Rate limit
            elapsed = time.time() - start
            if elapsed < interval:
                time.sleep(interval - elapsed)

        loop.close()

    def start(self):
        """Start object detection"""
        print("=" * 50)
        print("  CEMANI ROBOT - YOLOv8 Object Detection")
        print("  601 Classes (Open Images V7)")
        print("=" * 50)

        if not self._load_model():
            print("[ERROR] Failed to load model, exiting")
            return

        self._init_cameras()

        self.running = True
        self.inference_thread = threading.Thread(target=self._inference_loop, daemon=True)
        self.inference_thread.start()

        print("\n[READY] Object detection running. Press Ctrl+C to stop.\n")

        try:
            while self.running:
                # Print stats every 5 seconds
                time.sleep(5)
                for cam_id, cam in self.cameras.items():
                    print(f"[STATS] CAM{cam_id} ({cam.cam_name}): {cam.fps:.1f} FPS")

        except KeyboardInterrupt:
            print("\n[STOP] Shutting down...")

        self.stop()

    def stop(self):
        """Stop all processing"""
        self.running = False
        for cam in self.cameras.values():
            cam.stop()
        print("[STOP] Object detection stopped")


def main():
    detector = ObjectDetector()
    detector.start()


if __name__ == "__main__":
    main()
