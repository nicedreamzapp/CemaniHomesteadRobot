#!/usr/bin/env python3
"""
YOLOv8 Object Detection - SHARED STREAM via TCP
Receives JPEG frames from relay.js = ONE FFmpeg per camera!
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
        self.confidence = 0.25

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

# =============================================================================
# MODEL
# =============================================================================

print("=" * 50)
print("  YOLOv8 SHARED STREAM - TCP Mode")
print("=" * 50)

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

# =============================================================================
# VPS CONNECTION
# =============================================================================

vps_ws = None
vps_lock = threading.Lock()

def connect_vps():
    global vps_ws
    while True:
        try:
            print(f"[VPS] Connecting to {VPS_WS}...")
            vps_ws = websocket.create_connection(VPS_WS, timeout=10)
            vps_ws.send(json.dumps({"type": "JETSON_REGISTER", "capabilities": ["detection"]}))
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
        except Exception as e:
            print(f"[VPS] Receive error: {e}")
            vps_ws = None
            time.sleep(1)
            connect_vps()

# =============================================================================
# FRAME PROCESSING
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
        # Decode JPEG
        arr = np.frombuffer(jpeg_data, dtype=np.uint8)
        frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if frame is None:
            return

        # Resize for detection (smaller = faster)
        frame = cv2.resize(frame, (320, 320))

        # Run detection
        t0 = time.time()
        results = model(frame, conf=s["confidence"], iou=0.45, verbose=False)
        detect_time = (time.time() - t0) * 1000
        detect_times.append(detect_time)
        if len(detect_times) > 30:
            detect_times.pop(0)

        frame_count += 1

        # Process results
        detections = []
        h, w = frame.shape[:2]

        for r in results:
            for box in r.boxes:
                x1, y1, x2, y2 = box.xyxy[0].cpu().numpy()
                conf = float(box.conf[0])
                cls_id = int(box.cls[0])
                class_name = model.names[cls_id]

                # Filter by mode
                mode = s["filter_mode"]
                if mode == "indoor" and class_name not in indoor_classes:
                    continue
                elif mode == "outdoor" and class_name not in outdoor_classes:
                    continue

                bw = (x2 - x1) / w
                bh = (y2 - y1) / h
                if bw * bh > 0.85:
                    continue

                detections.append({
                    "class": class_name,
                    "confidence": round(conf, 2),
                    "bbox": {
                        "x": round((x1 + x2) / 2 / w, 3),
                        "y": round((y1 + y2) / 2 / h, 3),
                        "w": round(bw, 3),
                        "h": round(bh, 3)
                    },
                    "is_living": class_name.lower() in living_classes
                })

                if len(detections) >= 15:
                    break

        # Send to VPS
        send_detections(cam_id, detections)

        # Print stats
        now = time.time()
        if now - last_print > 2.0:
            avg = sum(detect_times) / len(detect_times) if detect_times else 0
            fps = frame_count / 2.0
            frame_count = 0
            cam_name = "Front" if cam_id == 1 else "Rear"
            det_list = ", ".join([d["class"] for d in detections[:3]])
            print(f"[{cam_name}] {fps:.1f}fps {len(detections)} obj ({avg:.0f}ms) {det_list}")
            last_print = now

    except Exception as e:
        print(f"[DETECT] Error: {e}")

# =============================================================================
# TCP SERVER - Receives frames from relay.js
# Protocol: [4-byte length][1-byte cam_id][jpeg_data]
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
            # Read 4-byte length header
            header = b''
            while len(header) < 4:
                chunk = conn.recv(4 - len(header))
                if not chunk:
                    raise Exception("Connection closed")
                header += chunk

            length = struct.unpack('>I', header)[0]
            if length > 1000000:  # Max 1MB
                raise Exception(f"Frame too large: {length}")

            # Read frame data
            data = b''
            while len(data) < length:
                chunk = conn.recv(min(65536, length - len(data)))
                if not chunk:
                    raise Exception("Connection closed during frame")
                data += chunk

            # First byte is camera ID marker
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
    # Connect to VPS
    connect_vps()

    # Start VPS listener
    threading.Thread(target=vps_listener, daemon=True).start()

    # Start TCP server
    print(f"[READY] Waiting for frames from relay.js on TCP port {LOCAL_PORT}")
    tcp_server()
