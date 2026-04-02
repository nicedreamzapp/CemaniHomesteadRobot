#!/usr/bin/env python3
"""
YOLOv8 OIV7 Object Detection for Cemani Robot - v2.0
Runs on Jetson Orin - processes RTSP camera streams and sends detections to VPS

Improvements ported from iOS Project 601:
- Object tracking with exponential smoothing (no more jitter)
- Context-aware confidence thresholds (food detected near plates, etc.)
- Aspect-preserving letterbox preprocessing (no more distortion)
- Per-class instance limiting (max 3 people, 2 of others)
- Conflict resolution for mutually exclusive classes
- Temporal detection history for stability
"""

import os
os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = "rtsp_transport;tcp"

import cv2
import json
import time
import asyncio
import websockets
import threading
import numpy as np
from collections import deque
from ultralytics import YOLO
from object_tracker import ObjectTracker

# === CONFIGURATION ===
CONFIG_FILE = "config.json"
DEFAULT_CONFIG = {
    "cameras": [
        {
            "id": 1,
            "name": "Front",
            "rtsp_url": "rtsp://admin:kookster1@192.168.1.79:554/onvif1"
        },
        {
            "id": 2,
            "name": "Rear",
            "rtsp_url": "rtsp://admin:kookster1@192.168.1.34:554/onvif1"
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
LIVING_CLASSES = {
    "person", "bird", "cat", "dog", "horse", "sheep", "cow",
    "elephant", "bear", "zebra", "giraffe", "rabbit", "duck",
    "chicken", "turkey", "goose", "deer", "squirrel", "mouse",
    "rat", "pig", "goat", "donkey", "fox", "wolf", "coyote",
    "man", "woman", "boy", "girl"
}

# Small objects need lower confidence threshold
SMALL_OBJECTS = {
    "pen", "pencil", "eraser", "marker", "key", "coin", "button",
    "needle", "pin", "clip", "paperclip", "stapler", "tape",
    "scissors", "nail", "screw", "bolt", "nut", "ring", "earring",
    "watch", "glasses", "toothbrush", "razor", "comb", "spoon",
    "fork", "knife", "egg", "insect", "bug", "spider", "ant", "bee"
}

# Priority objects for robot safety/awareness - lower threshold
PRIORITY_OBJECTS = {
    "person", "dog", "cat", "car", "truck", "bicycle", "motorcycle",
    "bird", "chicken", "duck", "deer", "horse", "cow", "pig",
    "fire hydrant", "stop sign", "traffic light",
    "man", "woman", "boy", "girl"
}

# Priority household items - slightly lower threshold (from iOS)
PRIORITY_HOUSEHOLD = {
    "mobile phone", "phone", "keys", "key", "remote control", "glasses",
    "sunglasses", "wallet", "watch", "cup", "mug", "plate", "bowl",
    "fork", "knife", "spoon", "book", "laptop", "computer keyboard",
    "computer mouse", "tablet computer", "pen", "pencil", "scissors",
    "bottle", "medicine", "pill", "backpack", "handbag"
}

# Context pairs - when a context object is seen, lower threshold for paired items
# Ported directly from iOS YOLOv8Processor.swift
CONTEXT_PAIRS = {
    "plate": {"fork", "knife", "spoon", "food", "cup", "mug", "bowl", "napkin"},
    "laptop": {"computer mouse", "computer keyboard", "mobile phone", "coffee cup", "mug", "pen"},
    "desk": {"computer keyboard", "computer mouse", "laptop", "monitor", "pen", "pencil", "book"},
    "bed": {"pillow", "blanket", "mobile phone", "lamp", "book", "clock"},
    "sink": {"toothbrush", "soap", "towel", "faucet", "cup"},
    "couch": {"pillow", "remote control", "blanket", "book", "mobile phone"},
    "television": {"remote control", "couch", "coffee table"},
    "refrigerator": {"food", "bottle", "milk", "juice"},
    "stove": {"pot", "pan", "kettle", "spatula"},
    "table": {"chair", "plate", "cup", "fork", "knife", "spoon"},
    "coffee table": {"remote control", "cup", "book", "magazine"},
    "kitchen counter": {"knife", "cutting board", "mixer", "toaster", "coffee maker"},
}

# Conflicting classes - can't both be true, keep the higher confidence one
CONFLICTING_CLASSES = [
    ("toilet", "waste container"),
    ("toilet", "bucket"),
    ("cup", "mug"),
    ("mobile phone", "tablet computer"),
    ("television", "computer monitor"),
    ("couch", "bed"),
    ("person", "mannequin"),
]

# Per-class instance limits (from iOS)
CLASS_INSTANCE_LIMITS = {
    "person": 5, "man": 5, "woman": 5, "boy": 3, "girl": 3,
    "chair": 4, "window": 4,
    "door": 3,
}
DEFAULT_INSTANCE_LIMIT = 2


def letterbox_frame(frame, target_size):
    """
    Aspect-preserving resize with padding (letterbox).
    Returns resized frame and letterbox info for coordinate mapping.
    Ported from iOS MetalImageResizer.swift.
    """
    h, w = frame.shape[:2]
    scale = min(target_size / w, target_size / h)
    new_w = int(w * scale)
    new_h = int(h * scale)

    # Resize maintaining aspect ratio
    resized = cv2.resize(frame, (new_w, new_h), interpolation=cv2.INTER_LINEAR)

    # Create black canvas and paste centered
    canvas = np.zeros((target_size, target_size, 3), dtype=np.uint8)
    pad_x = (target_size - new_w) // 2
    pad_y = (target_size - new_h) // 2
    canvas[pad_y:pad_y + new_h, pad_x:pad_x + new_w] = resized

    return canvas, scale, pad_x, pad_y


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
                self.cap = cv2.VideoCapture(self.rtsp_url, cv2.CAP_FFMPEG)
                self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

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
        self.tracker = ObjectTracker()

    def _load_config(self):
        try:
            with open(CONFIG_FILE, 'r') as f:
                config = json.load(f)
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
        """Run YOLOv8 inference with letterbox preprocessing and context-aware post-processing"""
        if frame is None or self.model is None:
            return []

        try:
            h, w = frame.shape[:2]
            size = self.config['inference_size']

            # --- Letterbox preprocessing (from iOS MetalImageResizer) ---
            letterboxed, scale, pad_x, pad_y = letterbox_frame(frame, size)

            # Run inference on letterboxed frame
            results = self.model(
                letterboxed,
                stream=False,
                conf=self.config['small_object_threshold'],
                iou=self.config['iou_threshold'],
                imgsz=size,
                verbose=False
            )

            # --- First pass: find context objects (from iOS two-pass strategy) ---
            raw_detections = []
            context_objects = set()

            for r in results:
                boxes = r.boxes
                for box in boxes:
                    x1, y1, x2, y2 = box.xyxy[0].cpu().numpy()
                    conf = float(box.conf[0])
                    cls_id = int(box.cls[0])
                    class_name = self.model.names[cls_id]
                    class_lower = class_name.lower()

                    # Remove letterbox padding to get original coordinates
                    x1 = (x1 - pad_x) / scale
                    y1 = (y1 - pad_y) / scale
                    x2 = (x2 - pad_x) / scale
                    y2 = (y2 - pad_y) / scale

                    # Clamp to frame bounds
                    x1 = max(0, min(x1, w))
                    y1 = max(0, min(y1, h))
                    x2 = max(0, min(x2, w))
                    y2 = max(0, min(y2, h))

                    # Normalized coordinates
                    cx = (x1 + x2) / 2 / w
                    cy = (y1 + y2) / 2 / h
                    bw = (x2 - x1) / w
                    bh = (y2 - y1) / h

                    raw_detections.append({
                        'class': class_name,
                        'class_lower': class_lower,
                        'confidence': conf,
                        'bbox': {'x': cx, 'y': cy, 'w': bw, 'h': bh},
                        'area': bw * bh,
                    })

                    # Track context objects (high confidence)
                    if conf > 0.3 and class_lower in CONTEXT_PAIRS:
                        context_objects.add(class_lower)

            # --- Second pass: apply dynamic thresholds (from iOS) ---
            detections = []
            class_counts = {}

            for det in raw_detections:
                cl = det['class_lower']

                # Dynamic threshold calculation (ported from iOS)
                threshold = self.config['confidence_threshold']

                if cl in SMALL_OBJECTS:
                    threshold = self.config['small_object_threshold']
                elif cl in PRIORITY_OBJECTS:
                    threshold *= 0.7
                elif cl in PRIORITY_HOUSEHOLD:
                    threshold *= 0.8

                # Context-aware: lower threshold for items near context objects
                for ctx_obj in context_objects:
                    if cl in CONTEXT_PAIRS.get(ctx_obj, set()):
                        threshold *= 0.6
                        break

                if det['confidence'] < threshold:
                    continue

                # Size filtering (from iOS)
                area = det['area']
                if area < 0.001:  # Too small (0.1% of frame)
                    continue
                if area > 0.85:   # Too large (full-frame detection = noise)
                    continue
                # Human body full-frame filter
                if cl in ('human body', 'person', 'man', 'woman') and area > 0.5:
                    continue

                # Per-class instance limiting (from iOS)
                limit = CLASS_INSTANCE_LIMITS.get(cl, DEFAULT_INSTANCE_LIMIT)
                count = class_counts.get(cl, 0)
                if count >= limit:
                    continue
                class_counts[cl] = count + 1

                detections.append({
                    'camera': cam_id,
                    'class': det['class'],
                    'confidence': round(det['confidence'], 3),
                    'bbox': {
                        'x': round(det['bbox']['x'], 3),
                        'y': round(det['bbox']['y'], 3),
                        'w': round(det['bbox']['w'], 3),
                        'h': round(det['bbox']['h'], 3),
                    },
                    'is_living': cl in LIVING_CLASSES,
                    'is_priority': cl in PRIORITY_OBJECTS,
                    'timestamp': time.time()
                })

            # --- Conflict resolution (from iOS) ---
            detections = self._resolve_conflicts(detections)

            # --- Object tracking (from iOS ObjectTracker) ---
            tracked = self.tracker.update(detections, cam_id)

            # Cap total detections
            return tracked[:self.config['max_detections_per_frame']]

        except Exception as e:
            print(f"[DETECT] Inference error: {e}")
            import traceback
            traceback.print_exc()
            return []

    def _resolve_conflicts(self, detections):
        """Remove conflicting detections - keep higher confidence (from iOS)"""
        to_remove = set()
        for i, d1 in enumerate(detections):
            if i in to_remove:
                continue
            for j, d2 in enumerate(detections):
                if j <= i or j in to_remove:
                    continue
                c1 = d1['class'].lower()
                c2 = d2['class'].lower()
                for a, b in CONFLICTING_CLASSES:
                    if (c1 == a and c2 == b) or (c1 == b and c2 == a):
                        # Check if they overlap (IoU > 0.5)
                        iou = self.tracker._calc_iou(d1['bbox'], d2['bbox'])
                        if iou > 0.5:
                            # Remove the lower confidence one
                            if d1['confidence'] >= d2['confidence']:
                                to_remove.add(j)
                            else:
                                to_remove.add(i)
        return [d for i, d in enumerate(detections) if i not in to_remove]

    async def _send_detections(self, detections, cam_id):
        """Send detections to VPS via WebSocket"""
        try:
            if self.ws_connection is None or self.ws_connection.closed:
                self.ws_connection = await websockets.connect(
                    self.config['vps_ws_url'],
                    ping_interval=20,
                    ping_timeout=10
                )
                # Register as Jetson detector
                await self.ws_connection.send(json.dumps({
                    "type": "JETSON_REGISTER",
                    "capabilities": ["detection"]
                }))
                print(f"[WS] Connected to VPS")

            message = {
                "type": "DETECTIONS",
                "camera": cam_id,
                "detections": detections,
                "count": len(detections),
                "timestamp": int(time.time() * 1000)
            }
            await self.ws_connection.send(json.dumps(message))

        except Exception as e:
            print(f"[WS] Send error: {e}")
            self.ws_connection = None

    def _inference_loop(self):
        """Main inference loop"""
        interval = self.config['inference_interval_ms'] / 1000.0
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        print("[DETECT] Starting inference loop (v2.0 - with tracking + context)")
        inference_count = 0

        while self.running:
            start = time.time()

            for cam_id, cam in self.cameras.items():
                frame = cam.get_frame()
                if frame is not None:
                    detections = self._run_inference(frame, cam_id)
                    inference_count += 1

                    # Always send (even empty) so VPS knows we're alive
                    loop.run_until_complete(self._send_detections(detections, cam_id))

                    if detections and inference_count % 5 == 0:
                        classes = [d['class'] for d in detections]
                        tracked_ids = [d.get('track_id', '?') for d in detections]
                        print(f"[CAM{cam_id}] {len(detections)} tracked: {classes[:5]}{'...' if len(classes) > 5 else ''}")

            # Rate limit
            elapsed = time.time() - start
            if elapsed < interval:
                time.sleep(interval - elapsed)

        loop.close()

    def start(self):
        """Start object detection"""
        print("=" * 60)
        print("  CEMANI ROBOT - YOLOv8 Object Detection v2.0")
        print("  601 Classes | Tracking | Context-Aware | Letterbox")
        print("=" * 60)

        if not self._load_model():
            print("[ERROR] Failed to load model, exiting")
            return

        self._init_cameras()

        self.running = True
        self.inference_thread = threading.Thread(target=self._inference_loop, daemon=True)
        self.inference_thread.start()

        print("\n[READY] Object detection v2.0 running. Press Ctrl+C to stop.\n")

        try:
            while self.running:
                time.sleep(5)
                for cam_id, cam in self.cameras.items():
                    print(f"[STATS] CAM{cam_id} ({cam.cam_name}): {cam.fps:.1f} FPS capture")
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
