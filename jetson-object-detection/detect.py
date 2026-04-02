#!/usr/bin/env python3
"""
YOLOv8 Object Detection v2.0 - SHARED STREAM via TCP
Receives JPEG frames from relay.js = ONE FFmpeg per camera!

v2.0 improvements ported from iOS Project 601:
- Object tracking with smoothing (no jitter)
- Context-aware confidence thresholds
- Aspect-preserving letterbox preprocessing
- Per-class instance limiting
- Conflict resolution
"""

import os
import cv2
import json
import time
import socket
import struct
import threading
import numpy as np
import websocket

from ultralytics import YOLO
from object_tracker import ObjectTracker

# =============================================================================
# CONFIGURATION
# =============================================================================

VPS_WS = "ws://72.60.124.34:3001"
LOCAL_PORT = 9998  # TCP port for relay frames

# =============================================================================
# SETTINGS
# =============================================================================

class Settings:
    def __init__(self):
        self.lock = threading.Lock()
        self.active_camera = 1
        self.filter_mode = "indoor"
        self.confidence = 0.05  # Lower default - context system handles thresholds

    def get(self):
        with self.lock:
            return {
                "active_camera": self.active_camera,
                "filter_mode": self.filter_mode,
                "confidence": self.confidence
            }

    def update(self, **kwargs):
        with self.lock:
            for k, v in kwargs.items():
                if hasattr(self, k):
                    old = getattr(self, k)
                    setattr(self, k, v)
                    if old != v:
                        print(f"[SETTINGS] {k}: {old} → {v}")

settings = Settings()

# =============================================================================
# CLASS FILTERS
# =============================================================================

indoor_classes = {
    "Accordion", "Adhesive tape", "Alarm clock", "Backpack", "Bagel",
    "Baked goods", "Bathroom cabinet", "Bathtub", "Bed", "Beer", "Belt",
    "Blender", "Book", "Bookcase", "Boot", "Bottle", "Bowl", "Box", "Boy",
    "Bread", "Briefcase", "Broccoli", "Cabinetry", "Cake", "Calculator",
    "Camera", "Can opener", "Candle", "Candy", "Ceiling fan", "Chair",
    "Cheese", "Chest of drawers", "Chopsticks", "Clock", "Closet", "Clothing",
    "Coat", "Coffee", "Coffee cup", "Coffee table", "Coffeemaker", "Coin",
    "Computer keyboard", "Computer monitor", "Computer mouse", "Container",
    "Cookie", "Couch", "Countertop", "Cup", "Cupboard", "Curtain",
    "Cutting board", "Desk", "Dishwasher", "Dog bed", "Doll", "Door",
    "Doughnut", "Drawer", "Dress", "Drill (Tool)", "Dumbbell", "Earrings",
    "Envelope", "Fan", "Fireplace", "Flashlight", "Flowerpot", "Food",
    "Fork", "Frying pan", "Furniture", "Gas stove", "Girl", "Glasses",
    "Glove", "Hair dryer", "Hamburger", "Hammer", "Handbag", "Hat",
    "Headphones", "Heater", "Home appliance", "Hot dog", "Houseplant",
    "Human face", "Jacket", "Jeans", "Jug", "Juice", "Kettle", "Kitchen knife",
    "Knife", "Ladder", "Lamp", "Laptop", "Light bulb", "Lipstick", "Loveseat",
    "Man", "Measuring cup", "Microphone", "Microwave oven", "Milk", "Mirror",
    "Mixer", "Mobile phone", "Muffin", "Mug", "Musical keyboard", "Necklace",
    "Nightstand", "Oven", "Pen", "Pencil case", "Perfume", "Piano",
    "Picture frame", "Pillow", "Pizza", "Plate", "Platter", "Poster",
    "Printer", "Refrigerator", "Remote control", "Ruler", "Salad", "Sandal",
    "Sandwich", "Saucer", "Scissors", "Screwdriver", "Shelf", "Shirt",
    "Shorts", "Shower", "Sink", "Skirt", "Slow cooker", "Soap dispenser",
    "Sock", "Sofa bed", "Spatula", "Spoon", "Stairs", "Stapler", "Stool",
    "Suit", "Suitcase", "Sunglasses", "Table", "Tablet computer", "Tap",
    "Tea", "Teapot", "Teddy bear", "Telephone", "Television", "Tie",
    "Tin can", "Toaster", "Toilet", "Toilet paper", "Tool", "Toothbrush",
    "Towel", "Toy", "Tripod", "Trousers", "Umbrella", "Vase", "Watch",
    "Whisk", "Window", "Wine", "Wine glass", "Wok", "Woman", "Wrench",
    "Apple", "Banana", "Carrot", "Cucumber", "Grape", "Lemon", "Mango",
    "Orange", "Peach", "Pear", "Pineapple", "Strawberry", "Tomato", "Vegetable",
    "Person"
}

outdoor_classes = {
    "Aircraft", "Airplane", "Ambulance", "Animal", "Ant", "Backpack",
    "Ball", "Balloon", "Baseball bat", "Baseball glove", "Bear", "Bee",
    "Beetle", "Bicycle", "Bird", "Boat", "Bus", "Butterfly", "Camel",
    "Canoe", "Car", "Cat", "Caterpillar", "Cattle", "Chicken", "Cow",
    "Crab", "Crocodile", "Crow", "Deer", "Dog", "Dolphin", "Dragonfly",
    "Duck", "Eagle", "Elephant", "Falcon", "Fire hydrant", "Fish", "Flower",
    "Football", "Fountain", "Fox", "Frog", "Giraffe", "Goat", "Goldfish",
    "Golf ball", "Goose", "Helicopter", "Horse", "House", "Jaguar (Animal)",
    "Kangaroo", "Kite", "Koala", "Ladybug", "Leopard", "Lighthouse", "Lion",
    "Lizard", "Lobster", "Monkey", "Motorcycle", "Mushroom", "Ostrich",
    "Otter", "Owl", "Panda", "Parachute", "Parking meter", "Parrot",
    "Penguin", "Person", "Pig", "Polar bear", "Rabbit", "Raccoon", "Raven",
    "Rhinoceros", "Rocket", "Scorpion", "Shark", "Sheep", "Skateboard",
    "Ski", "Snail", "Snake", "Snowboard", "Sparrow", "Spider", "Squirrel",
    "Stop sign", "Street light", "Surfboard", "Swan", "Tank", "Taxi",
    "Tennis ball", "Tent", "Tiger", "Tire", "Tortoise", "Tower",
    "Traffic light", "Traffic sign", "Train", "Tree", "Truck", "Turkey",
    "Turtle", "Van", "Vehicle", "Whale", "Wheel", "Zebra",
}

living_classes = {
    "person", "bird", "cat", "dog", "horse", "sheep", "cow", "elephant",
    "bear", "zebra", "giraffe", "rabbit", "duck", "chicken", "deer",
    "turkey", "goose", "boy", "girl", "man", "woman", "owl", "parrot",
    "eagle", "falcon", "penguin", "tiger", "lion", "leopard", "fox",
    "wolf", "monkey", "panda", "kangaroo", "koala", "squirrel", "pig",
    "goat", "donkey", "camel", "human face"
}

# --- iOS-ported enhancements ---

PRIORITY_OBJECTS = {
    "person", "dog", "cat", "car", "truck", "bicycle", "motorcycle",
    "bird", "chicken", "duck", "deer", "horse", "cow", "pig",
    "fire hydrant", "stop sign", "traffic light", "man", "woman", "boy", "girl"
}

PRIORITY_HOUSEHOLD = {
    "mobile phone", "phone", "keys", "key", "remote control", "glasses",
    "sunglasses", "wallet", "watch", "cup", "mug", "plate", "bowl",
    "fork", "knife", "spoon", "book", "laptop", "computer keyboard",
    "computer mouse", "tablet computer", "pen", "pencil", "scissors",
    "bottle", "medicine", "backpack", "handbag"
}

CONTEXT_PAIRS = {
    "plate": {"fork", "knife", "spoon", "food", "cup", "mug", "bowl"},
    "laptop": {"computer mouse", "computer keyboard", "mobile phone", "mug", "pen"},
    "desk": {"computer keyboard", "computer mouse", "laptop", "pen", "pencil", "book"},
    "bed": {"pillow", "blanket", "mobile phone", "lamp", "book", "clock"},
    "sink": {"toothbrush", "soap", "towel", "cup"},
    "couch": {"pillow", "remote control", "blanket", "book", "mobile phone"},
    "television": {"remote control", "couch", "coffee table"},
    "refrigerator": {"food", "bottle", "milk", "juice"},
    "table": {"chair", "plate", "cup", "fork", "knife", "spoon"},
    "coffee table": {"remote control", "cup", "book"},
}

CONFLICTING_CLASSES = [
    ("toilet", "waste container"), ("toilet", "bucket"),
    ("cup", "mug"), ("mobile phone", "tablet computer"),
    ("television", "computer monitor"), ("couch", "bed"),
    ("person", "mannequin"),
]

CLASS_INSTANCE_LIMITS = {
    "person": 5, "man": 5, "woman": 5, "boy": 3, "girl": 3,
    "chair": 4, "window": 4, "door": 3,
}
DEFAULT_INSTANCE_LIMIT = 2

# =============================================================================
# LETTERBOX PREPROCESSING (from iOS MetalImageResizer)
# =============================================================================

def letterbox_frame(frame, target_size):
    """Aspect-preserving resize with padding"""
    h, w = frame.shape[:2]
    scale = min(target_size / w, target_size / h)
    new_w = int(w * scale)
    new_h = int(h * scale)
    resized = cv2.resize(frame, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
    canvas = np.zeros((target_size, target_size, 3), dtype=np.uint8)
    pad_x = (target_size - new_w) // 2
    pad_y = (target_size - new_h) // 2
    canvas[pad_y:pad_y + new_h, pad_x:pad_x + new_w] = resized
    return canvas, scale, pad_x, pad_y

# =============================================================================
# MODEL
# =============================================================================

print("=" * 60)
print("  YOLOv8 v2.0 - Tracking + Context + Letterbox")
print("=" * 60)

script_dir = os.path.dirname(os.path.abspath(__file__))
engine_path = os.path.join(script_dir, "yolov8n-oiv7.engine")
model_path = os.path.join(script_dir, "yolov8n-oiv7.pt")

import torch
print(f"[GPU] CUDA: {torch.cuda.is_available()}")
if torch.cuda.is_available():
    print(f"[GPU] Device: {torch.cuda.get_device_name(0)}")

if os.path.exists(engine_path):
    print(f"[MODEL] TensorRT: {engine_path}")
    model = YOLO(engine_path, task='detect')
else:
    print(f"[MODEL] PyTorch: {model_path}")
    model = YOLO(model_path)
    if torch.cuda.is_available():
        model.to('cuda:0')

print(f"[MODEL] {len(model.names)} classes loaded")

# Initialize object tracker (from iOS ObjectTracker)
tracker = ObjectTracker()

# =============================================================================
# VPS CONNECTION
# =============================================================================

vps_ws = None
vps_lock = threading.Lock()

# =============================================================================
# OCR ENGINE (EasyOCR with GPU)
# =============================================================================

ocr_reader = None
ocr_lock = threading.Lock()
last_ocr_frame = None  # Store latest frame for on-demand OCR

def init_ocr():
    global ocr_reader
    try:
        import easyocr
        ocr_reader = easyocr.Reader(['en'], gpu=True)
        print("[OCR] EasyOCR initialized with GPU")
    except Exception as e:
        print(f"[OCR] Failed to init EasyOCR: {e}")

def run_ocr(cam_id):
    """Run OCR on the latest frame from the specified camera"""
    global last_ocr_frame
    with ocr_lock:
        if ocr_reader is None:
            return {"error": "OCR not initialized"}
        if last_ocr_frame is None:
            return {"error": "No frame available"}

        frame = last_ocr_frame.copy()

    try:
        h, w = frame.shape[:2]
        # Crop top/bottom 15% to remove camera OSD timestamps
        crop_top = int(h * 0.15)
        crop_bot = int(h * 0.15)
        cropped = frame[crop_top:h-crop_bot, :, :]

        results = ocr_reader.readtext(cropped)
        words = []
        for bbox, text, conf in results:
            text = text.strip()
            if conf >= 0.25 and len(text) >= 2:
                words.append({"text": text, "confidence": round(conf, 2)})

        print(f"[OCR] Cam{cam_id}: {[w['text'] for w in words]}")
        return {"words": words, "camera": cam_id}
    except Exception as e:
        print(f"[OCR] Error: {e}")
        return {"error": str(e)}

def connect_vps():
    global vps_ws
    while True:
        try:
            print(f"[VPS] Connecting to {VPS_WS}...")
            vps_ws = websocket.create_connection(VPS_WS, timeout=60)
            vps_ws.send(json.dumps({"type": "JETSON_REGISTER", "capabilities": ["detection", "ocr"]}))
            print("[VPS] Connected!")
            return
        except Exception as e:
            print(f"[VPS] Error: {e}, retrying...")
            time.sleep(3)

def send_detections(cam_id, detections):
    global vps_ws
    try:
        with vps_lock:
            if vps_ws:
                msg = {
                    "type": "DETECTIONS",
                    "camera": cam_id,
                    "detections": detections,
                    "count": len(detections),
                    "timestamp": int(time.time() * 1000)
                }
                vps_ws.send(json.dumps(msg))
    except Exception as e:
        print(f"[VPS] Send error: {e}")
        threading.Thread(target=connect_vps, daemon=True).start()

def send_ocr_result(result):
    global vps_ws
    try:
        with vps_lock:
            if vps_ws:
                msg = {"type": "OCR_RESULT", **result}
                vps_ws.send(json.dumps(msg))
    except Exception as e:
        print(f"[VPS] OCR send error: {e}")

def vps_keepalive():
    """Send periodic ping to keep WebSocket alive"""
    global vps_ws
    while True:
        time.sleep(30)
        try:
            with vps_lock:
                if vps_ws:
                    vps_ws.ping()
        except:
            pass

def vps_listener():
    global vps_ws
    while True:
        try:
            if vps_ws is None:
                time.sleep(1)
                continue
            msg = vps_ws.recv()
            data = json.loads(msg)
            if data.get("type") == "DETECTION_SETTINGS":
                settings.update(
                    active_camera=data.get("active_camera", settings.active_camera),
                    filter_mode=data.get("filter_mode", settings.filter_mode),
                    confidence=data.get("confidence", settings.confidence)
                )
            elif data.get("type") == "OCR_REQUEST":
                cam = data.get("camera", settings.get()["active_camera"])
                print(f"[OCR] Request received for cam {cam}")
                result = run_ocr(cam)
                send_ocr_result(result)
        except Exception as e:
            print(f"[VPS] Receive error: {e}")
            vps_ws = None
            time.sleep(1)
            connect_vps()

# =============================================================================
# FRAME PROCESSING v2.0
# =============================================================================

detect_times = []
last_print = 0
frame_count = 0

def process_frame(cam_id, jpeg_data):
    global last_print, detect_times, frame_count

    s = settings.get()
    if cam_id != s["active_camera"]:
        return

    try:
        arr = np.frombuffer(jpeg_data, dtype=np.uint8)
        frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if frame is None:
            return

        # Store latest frame for on-demand OCR
        global last_ocr_frame
        last_ocr_frame = frame

        h_orig, w_orig = frame.shape[:2]

        # LETTERBOX (from iOS) instead of distorting cv2.resize
        # Use 320 for TensorRT engine, 640 for PyTorch
        infer_size = 320 if os.path.exists(engine_path) else 640
        letterboxed, scale, pad_x, pad_y = letterbox_frame(frame, infer_size)

        t0 = time.time()
        results = model(letterboxed, conf=0.03, iou=0.45, imgsz=infer_size, verbose=False)
        detect_time = (time.time() - t0) * 1000
        detect_times.append(detect_time)
        if len(detect_times) > 30:
            detect_times.pop(0)
        frame_count += 1

        # --- Pass 1: collect raw detections + find context objects ---
        raw = []
        context_objects = set()

        for r in results:
            for box in r.boxes:
                x1, y1, x2, y2 = box.xyxy[0].cpu().numpy()
                conf = float(box.conf[0])
                cls_id = int(box.cls[0])
                class_name = model.names[cls_id]
                cl = class_name.lower()

                # Undo letterbox padding
                x1 = (x1 - pad_x) / scale
                y1 = (y1 - pad_y) / scale
                x2 = (x2 - pad_x) / scale
                y2 = (y2 - pad_y) / scale
                x1 = max(0, min(x1, w_orig))
                y1 = max(0, min(y1, h_orig))
                x2 = max(0, min(x2, w_orig))
                y2 = max(0, min(y2, h_orig))

                cx = (x1 + x2) / 2 / w_orig
                cy = (y1 + y2) / 2 / h_orig
                bw = (x2 - x1) / w_orig
                bh = (y2 - y1) / h_orig

                raw.append((class_name, cl, conf, cx, cy, bw, bh, bw * bh))

                if conf > 0.3 and cl in CONTEXT_PAIRS:
                    context_objects.add(cl)

        # --- Pass 2: dynamic thresholds + filtering ---
        mode = s["filter_mode"]
        base_conf = s["confidence"]
        detections = []
        class_counts = {}

        for class_name, cl, conf, cx, cy, bw, bh, area in raw:
            # Mode filter
            if mode == "indoor" and class_name not in indoor_classes:
                continue
            elif mode == "outdoor" and class_name not in outdoor_classes:
                continue

            # Dynamic threshold (from iOS)
            threshold = base_conf
            if cl in PRIORITY_OBJECTS:
                threshold *= 0.7
            elif cl in PRIORITY_HOUSEHOLD:
                threshold *= 0.8
            for ctx in context_objects:
                if cl in CONTEXT_PAIRS.get(ctx, set()):
                    threshold *= 0.6
                    break
            if conf < threshold:
                continue

            # Size filters (from iOS)
            if area < 0.001 or area > 0.85:
                continue
            if cl in ('human body', 'person', 'man', 'woman') and area > 0.5:
                continue

            # Per-class instance limits (from iOS)
            limit = CLASS_INSTANCE_LIMITS.get(cl, DEFAULT_INSTANCE_LIMIT)
            if class_counts.get(cl, 0) >= limit:
                continue
            class_counts[cl] = class_counts.get(cl, 0) + 1

            detections.append({
                "class": class_name,
                "confidence": round(conf, 3),
                "bbox": {"x": round(cx, 3), "y": round(cy, 3),
                         "w": round(bw, 3), "h": round(bh, 3)},
                "is_living": cl in living_classes,
                "is_priority": cl in PRIORITY_OBJECTS,
            })

        # --- Conflict resolution (from iOS) ---
        remove = set()
        for i, d1 in enumerate(detections):
            if i in remove: continue
            for j, d2 in enumerate(detections):
                if j <= i or j in remove: continue
                c1, c2 = d1['class'].lower(), d2['class'].lower()
                for a, b in CONFLICTING_CLASSES:
                    if (c1 == a and c2 == b) or (c1 == b and c2 == a):
                        if tracker._calc_iou(d1['bbox'], d2['bbox']) > 0.5:
                            remove.add(j if d1['confidence'] >= d2['confidence'] else i)
        detections = [d for i, d in enumerate(detections) if i not in remove]

        # --- Object tracking (from iOS ObjectTracker) ---
        tracked = tracker.update(detections, cam_id)[:20]

        send_detections(cam_id, tracked)

        # Stats
        now = time.time()
        if now - last_print > 2.0:
            avg = sum(detect_times) / len(detect_times) if detect_times else 0
            fps = frame_count / 2.0
            frame_count = 0
            cam_name = "Front" if cam_id == 1 else "Rear"
            det_list = ", ".join([d["class"] for d in tracked[:3]])
            ctx = f" ctx:{','.join(context_objects)}" if context_objects else ""
            trk = sum(1 for d in tracked if d.get('hits', 0) > 1)
            print(f"[{cam_name}] {fps:.1f}fps {len(tracked)} obj ({avg:.0f}ms) {det_list}{ctx} [{trk} tracked]")
            last_print = now

    except Exception as e:
        import traceback
        print(f"[DETECT] Error: {e}")
        traceback.print_exc()

# =============================================================================
# TCP SERVER - Receives frames from relay.js
# =============================================================================

def tcp_server():
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(('127.0.0.1', LOCAL_PORT))
    server.listen(1)
    print(f"[TCP] Listening on port {LOCAL_PORT}")

    while True:
        try:
            conn, addr = server.accept()
            print(f"[TCP] Relay connected: {addr}")
            handle_connection(conn)
        except Exception as e:
            print(f"[TCP] Accept error: {e}")
            time.sleep(1)

def handle_connection(conn):
    try:
        conn.settimeout(5.0)
        while True:
            header = b''
            while len(header) < 4:
                chunk = conn.recv(4 - len(header))
                if not chunk:
                    raise Exception("Connection closed")
                header += chunk

            length = struct.unpack('>I', header)[0]
            if length > 1000000:
                raise Exception(f"Frame too large: {length}")

            data = b''
            while len(data) < length:
                chunk = conn.recv(min(65536, length - len(data)))
                if not chunk:
                    raise Exception("Connection closed during frame")
                data += chunk

            if len(data) > 1:
                cam_marker = data[0]
                cam_id = 1 if cam_marker == 0 else 2
                jpeg_data = data[1:]
                process_frame(cam_id, jpeg_data)

    except Exception as e:
        print(f"[TCP] Connection error: {e}")
    finally:
        conn.close()
        print("[TCP] Connection closed")

# =============================================================================
# MAIN
# =============================================================================

if __name__ == "__main__":
    connect_vps()
    threading.Thread(target=vps_listener, daemon=True).start()
    threading.Thread(target=vps_keepalive, daemon=True).start()
    threading.Thread(target=init_ocr, daemon=True).start()
    print(f"[READY] v2.0 waiting for frames on TCP port {LOCAL_PORT}")
    tcp_server()
