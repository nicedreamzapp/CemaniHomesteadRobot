#!/usr/bin/env python3
"""
YOLOv8 OIV7 Object Detection - Jetson
Uses ffmpeg subprocess for reliable RTSP capture
With indoor/outdoor filtering and master controls
"""

import os
import cv2
import json
import time
import threading
import subprocess
import numpy as np
import websocket

from ultralytics import YOLO

# Cameras (RTSP)
CAMERAS = [
    {"id": 1, "name": "Front", "url": "rtsp://admin:kookster1@192.168.1.191:554/onvif1"},
    {"id": 2, "name": "Rear", "url": "rtsp://admin:kookster1@192.168.1.27:554/onvif1"}
]

# VPS WebSocket
VPS_WS = "ws://72.60.124.34:3001"

# Frame size (720p)
WIDTH, HEIGHT = 1280, 720

# ========== MASTER CONTROLS (updated via WebSocket) ==========
filter_mode = "all"  # "all", "indoor", "outdoor"
confidence_threshold = 0.05  # 0.01 to 1.0
settings_lock = threading.Lock()

# Living creatures get circle overlay
living_classes = {"person", "bird", "cat", "dog", "horse", "sheep", "cow",
                  "elephant", "bear", "zebra", "giraffe", "rabbit", "duck",
                  "chicken", "deer", "turkey", "goose", "boy", "girl", "man",
                  "woman", "owl", "parrot", "eagle", "falcon", "penguin",
                  "tiger", "lion", "leopard", "fox", "wolf", "monkey", "panda",
                  "kangaroo", "koala", "squirrel", "mouse", "rat", "pig",
                  "goat", "donkey", "camel", "llama", "alpaca"}

# Small objects need lower threshold
small_objects = {"pen", "pencil", "eraser", "marker", "key", "coin", "button",
                 "needle", "pin", "clip", "scissors", "nail", "screw", "ring",
                 "watch", "glasses", "spoon", "fork", "knife", "earrings",
                 "necklace", "lipstick", "toothbrush"}

# ========== INDOOR/OUTDOOR CLASS FILTERING (from Swift app) ==========
indoor_classes = {
    "Accordion", "Adhesive tape", "Alarm clock", "Armadillo", "Backpack", "Bagel",
    "Baked goods", "Balance beam", "Band-aid", "Banjo", "Barrel", "Bathroom accessory",
    "Bathroom cabinet", "Bathtub", "Beaker", "Bed", "Beer", "Belt", "Bench",
    "Bicycle helmet", "Bidet", "Billiard table", "Blender", "Book", "Bookcase",
    "Boot", "Bottle", "Bottle opener", "Bowl", "Bowling equipment", "Box", "Boy",
    "Brassiere", "Bread", "Briefcase", "Broccoli", "Bust", "Cabinetry", "Cake",
    "Cake stand", "Calculator", "Camera", "Can opener", "Candle", "Candy",
    "Cat furniture", "Ceiling fan", "Cello", "Chair", "Cheese", "Chest of drawers",
    "Chicken", "Chime", "Chisel", "Chopsticks", "Christmas tree", "Clock", "Closet",
    "Clothing", "Coat", "Cocktail", "Cocktail shaker", "Coconut", "Coffee",
    "Coffee cup", "Coffee table", "Coffeemaker", "Coin", "Computer keyboard",
    "Computer monitor", "Computer mouse", "Container", "Convenience store", "Cookie",
    "Cooking spray", "Corded phone", "Cosmetics", "Couch", "Countertop", "Cream",
    "Cricket ball", "Crutch", "Cupboard", "Curtain", "Cutting board", "Dagger",
    "Dairy Product", "Desk", "Dessert", "Diaper", "Dice", "Digital clock",
    "Dishwasher", "Dog bed", "Doll", "Door", "Door handle", "Doughnut", "Drawer",
    "Dress", "Drill (Tool)", "Drink", "Drinking straw", "Drum", "Dumbbell",
    "Earrings", "Egg (Food)", "Envelope", "Eraser", "Face powder",
    "Facial tissue holder", "Fashion accessory", "Fast food", "Fax", "Fedora",
    "Filing cabinet", "Fireplace", "Flag", "Flashlight", "Flowerpot", "Flute",
    "Food", "Food processor", "Football helmet", "Frying pan", "Furniture",
    "Gas stove", "Girl", "Glasses", "Glove", "Goggles", "Grinder", "Guacamole",
    "Guitar", "Hair dryer", "Hair spray", "Hamburger", "Hammer", "Hand dryer",
    "Handbag", "Harmonica", "Harp", "Hat", "Headphones", "Heater", "Home appliance",
    "Honeycomb", "Horizontal bar", "Hot dog", "Houseplant", "Human arm",
    "Human beard", "Human body", "Human ear", "Human eye", "Human face",
    "Human foot", "Human hair", "Human hand", "Human head", "Human leg",
    "Human mouth", "Human nose", "Humidifier", "Ice cream", "Indoor rower",
    "Infant bed", "Ipod", "Jacket", "Jacuzzi", "Jeans", "Jug", "Juice", "Kettle",
    "Kitchen & dining room table", "Kitchen appliance", "Kitchen knife",
    "Kitchen utensil", "Kitchenware", "Knife", "Ladder", "Ladle", "Lamp",
    "Lantern", "Laptop", "Lavender (Plant)", "Light bulb", "Light switch", "Lily",
    "Lipstick", "Loveseat", "Luggage and bags", "Man", "Maracas", "Measuring cup",
    "Mechanical fan", "Medical equipment", "Microphone", "Microwave oven", "Milk",
    "Miniskirt", "Mirror", "Mixer", "Mixing bowl", "Mobile phone", "Mouse",
    "Muffin", "Mug", "Musical instrument", "Musical keyboard", "Nail (Construction)",
    "Necklace", "Nightstand", "Oboe", "Organ (Musical Instrument)", "Oven",
    "Paper cutter", "Paper towel", "Pastry", "Pen", "Pencil case", "Pencil sharpener",
    "Perfume", "Personal care", "Piano", "Picnic basket", "Picture frame", "Pillow",
    "Pizza cutter", "Plastic bag", "Plate", "Platter", "Plumbing fixture", "Popcorn",
    "Porch", "Poster", "Power plugs and sockets", "Pressure cooker", "Pretzel",
    "Printer", "Punching bag", "Racket", "Refrigerator", "Remote control",
    "Ring binder", "Rose", "Ruler", "Salad", "Salt and pepper shakers", "Sandal",
    "Sandwich", "Saucer", "Saxophone", "Scale", "Scarf", "Scissors", "Screwdriver",
    "Sculpture", "Serving tray", "Sewing machine", "Shelf", "Shirt", "Shorts",
    "Shower", "Sink", "Skirt", "Slow cooker", "Soap dispenser", "Sock", "Sofa bed",
    "Sombrero", "Spatula", "Spice rack", "Spoon", "Stairs", "Stapler",
    "Stationary bicycle", "Stethoscope", "Stool", "Studio couch", "Suit", "Suitcase",
    "Sun hat", "Sunglasses", "Swim cap", "Swimwear", "Table", "Table tennis racket",
    "Tablet computer", "Tableware", "Tap", "Tea", "Teapot", "Teddy bear",
    "Telephone", "Television", "Tennis racket", "Tiara", "Tie", "Tin can", "Toaster",
    "Toilet", "Toilet paper", "Tool", "Toothbrush", "Torch", "Towel", "Toy",
    "Training bench", "Treadmill", "Tripod", "Trombone", "Trousers", "Trumpet",
    "Umbrella", "Vase", "Watch", "Whisk", "Whiteboard", "Willow", "Window",
    "Window blind", "Wine", "Wine glass", "Wine rack", "Wok", "Woman",
    "Wood-burning stove", "Wrench", "Apple", "Artichoke", "Banana", "Bell pepper",
    "Cabbage", "Cantaloupe", "Carrot", "Common fig", "Cucumber", "Garden Asparagus",
    "Grape", "Grapefruit", "Lemon", "Mango", "Orange", "Peach", "Pear", "Pineapple",
    "Pomegranate", "Potato", "Pumpkin", "Radish", "Strawberry", "Tomato", "Vegetable",
    "Watermelon", "Winter melon", "Zucchini"
}

outdoor_classes = {
    "Aircraft", "Airplane", "Alpaca", "Ambulance", "Animal", "Ant", "Antelope",
    "Auto part", "Axe", "Ball", "Balloon", "Barge", "Baseball bat", "Baseball glove",
    "Bat (Animal)", "Bear", "Bee", "Beehive", "Beetle", "Bicycle", "Bicycle wheel",
    "Billboard", "Binoculars", "Bird", "Blue jay", "Boat", "Bomb", "Bow and arrow",
    "Brown bear", "Building", "Bull", "Bus", "Butterfly", "Camel", "Cannon", "Canoe",
    "Car", "Carnivore", "Cart", "Castle", "Caterpillar", "Cattle", "Centipede",
    "Cheetah", "Crab", "Crocodile", "Crow", "Crown", "Deer", "Dinosaur", "Dog",
    "Dolphin", "Dragonfly", "Duck", "Eagle", "Falcon", "Fish", "Flower", "Flying disc",
    "Football", "Fountain", "Fox", "Frog", "Giraffe", "Goat", "Goldfish", "Golf ball",
    "Golf cart", "Gondola", "Goose", "Hedgehog", "Helicopter", "Hippopotamus",
    "Horse", "Jaguar (Animal)", "Jellyfish", "Jet ski", "Kangaroo", "Kite", "Koala",
    "Ladybug", "Land vehicle", "Leopard", "Lighthouse", "Limousine", "Lion", "Lizard",
    "Lobster", "Lynx", "Mammal", "Marine invertebrates", "Marine mammal", "Missile",
    "Monkey", "Moths and butterflies", "Motorcycle", "Mule", "Mushroom", "Ostrich",
    "Otter", "Owl", "Oyster", "Paddle", "Palm tree", "Panda", "Parachute",
    "Parking meter", "Parrot", "Penguin", "Person", "Pig", "Porcupine", "Rabbit",
    "Raccoon", "Raven", "Rays and skates", "Red panda", "Reptile", "Rhinoceros",
    "Rocket", "Roller skates", "Rugby ball", "Scorpion", "Sea lion", "Sea turtle",
    "Seafood", "Seahorse", "Segway", "Shark", "Sheep", "Shellfish", "Shotgun",
    "Shrimp", "Skateboard", "Ski", "Skull", "Skunk", "Snail", "Snake", "Snowboard",
    "Snowman", "Snowmobile", "Snowplow", "Sparrow", "Spider", "Sports equipment",
    "Sports uniform", "Squash (Plant)", "Squid", "Squirrel", "Starfish", "Stop sign",
    "Street light", "Stretcher", "Submarine", "Submarine sandwich", "Surfboard",
    "Sushi", "Swan", "Swimming pool", "Sword", "Syringe", "Tank", "Taco", "Taxi",
    "Tennis ball", "Tent", "Tick", "Tiger", "Tire", "Tortoise", "Tower",
    "Traffic light", "Traffic sign", "Train", "Tree", "Tree house", "Truck", "Turkey",
    "Turtle", "Unicycle", "Van", "Vehicle", "Vehicle registration plate", "Violin",
    "Volleyball (Ball)", "Waffle", "Waffle iron", "Wall clock", "Wardrobe",
    "Washing machine", "Waste container", "Watercraft", "Weapon", "Whale", "Wheel",
    "Wheelchair", "Worm", "Woodpecker", "Zebra"
}

both_classes = {
    "Beer", "Bell pepper", "Blue jay", "Book", "Bottle", "Bowl", "Boy", "Bread",
    "Broccoli", "Butterfly", "Cabbage", "Cantaloupe", "Carrot", "Cat", "Christmas tree",
    "Clothing", "Coat", "Cocktail", "Coconut", "Coffee", "Coin", "Common fig",
    "Common sunflower", "Computer mouse", "Cookie", "Cream", "Crocodile", "Croissant",
    "Cucumber", "Cupboard", "Curtain", "Cutting board", "Deer", "Dessert",
    "Digital clock", "Dog", "Door", "Drink", "Drum", "Duck", "Earrings", "Egg (Food)",
    "Elephant", "Envelope", "Eraser", "Face powder", "Fashion accessory", "Fast food",
    "Flag", "Flashlight", "Flower", "Flute", "Food", "Football", "Footwear", "Fork",
    "French fries", "French horn", "Frog", "Fruit", "Frying pan", "Garden Asparagus",
    "Giraffe", "Girl", "Glasses", "Glove", "Goggles", "Goat", "Grape", "Grapefruit",
    "Guacamole", "Guitar", "Hair dryer", "Hair spray", "Hamburger", "Hammer",
    "Hamster", "Hand dryer", "Handbag", "Hat", "Headphones", "Heater", "Honeycomb",
    "Horse", "Hot dog", "Human arm", "Human beard", "Human body", "Human ear",
    "Human eye", "Human face", "Human foot", "Human hair", "Human hand", "Human head",
    "Human leg", "Human mouth", "Human nose", "Ice cream", "Insect", "Invertebrate",
    "Jacket", "Jeans", "Juice", "Kangaroo", "Kitchen utensil", "Kite", "Knife",
    "Koala", "Ladybug", "Lemon", "Leopard", "Lily", "Lion", "Lizard", "Lobster",
    "Lynx", "Magpie", "Mammal", "Man", "Maple", "Maracas", "Measuring cup",
    "Mechanical fan", "Microphone", "Milk", "Miniskirt", "Mirror", "Mixer",
    "Mixing bowl", "Mobile phone", "Monkey", "Moths and butterflies", "Mouse",
    "Muffin", "Mug", "Mule", "Mushroom", "Musical instrument", "Musical keyboard",
    "Nail (Construction)", "Necklace", "Nightstand", "Oboe", "Office supplies",
    "Orange", "Organ (Musical Instrument)", "Ostrich", "Otter", "Owl", "Oyster",
    "Paddle", "Palm tree", "Pancake", "Panda", "Paper cutter", "Paper towel",
    "Parrot", "Pasta", "Pastry", "Peach", "Pear", "Pen", "Pencil case",
    "Pencil sharpener", "Penguin", "Perfume", "Person", "Personal care",
    "Personal flotation device", "Piano", "Picnic basket", "Picture frame", "Pig",
    "Pillow", "Pineapple", "Pitcher (Container)", "Pizza", "Plant", "Plastic bag",
    "Plate", "Platter", "Plumbing fixture", "Polar bear", "Pomegranate", "Popcorn",
    "Porch", "Porcupine", "Poster", "Potato", "Power plugs and sockets",
    "Pressure cooker", "Pretzel", "Printer", "Pumpkin", "Punching bag", "Rabbit",
    "Raccoon", "Racket", "Radish", "Ratchet (Device)", "Raven", "Rays and skates",
    "Red panda", "Refrigerator", "Remote control", "Reptile", "Rhinoceros", "Rifle",
    "Ring binder", "Rocket", "Roller skates", "Rose", "Rugby ball", "Ruler", "Salad",
    "Salt and pepper shakers", "Sandal", "Sandwich", "Saucer", "Saxophone", "Scale",
    "Scarf", "Scissors", "Scoreboard", "Screwdriver", "Sculpture", "Serving tray",
    "Sewing machine", "Shark", "Sheep", "Shelf", "Shellfish", "Shirt", "Shorts",
    "Shower", "Shrimp", "Sink", "Skateboard", "Ski", "Skirt", "Skull", "Skunk",
    "Slow cooker", "Snack", "Snail", "Snake", "Snowboard", "Snowman", "Snowmobile",
    "Snowplow", "Sparrow", "Spatula", "Spice rack", "Spider", "Spoon",
    "Sports equipment", "Sports uniform", "Squash (Plant)", "Squid", "Squirrel",
    "Starfish", "Stationary bicycle", "Stethoscope", "Stool", "Stop sign",
    "Strawberry", "Street light", "Stretcher", "Studio couch", "Submarine",
    "Submarine sandwich", "Suit", "Suitcase", "Sun hat", "Sunglasses", "Surfboard",
    "Sushi", "Swan", "Swim cap", "Swimming pool", "Swimwear", "Sword", "Syringe",
    "Table", "Table tennis racket", "Tablet computer", "Tableware", "Taco", "Tank",
    "Tap", "Tart", "Taxi", "Tea", "Teapot", "Teddy bear", "Telephone", "Television",
    "Tennis ball", "Tennis racket", "Tent", "Tiara", "Tick", "Tie", "Tiger",
    "Tin can", "Tire", "Toaster", "Toilet", "Toilet paper", "Tomato", "Tool",
    "Toothbrush", "Torch", "Tortoise", "Towel", "Tower", "Toy", "Traffic light",
    "Traffic sign", "Train", "Training bench", "Treadmill", "Tree", "Tree house",
    "Tripod", "Trombone", "Trousers", "Truck", "Trumpet", "Turkey", "Turtle",
    "Umbrella", "Unicycle", "Van", "Vase", "Vegetable", "Vehicle",
    "Vehicle registration plate", "Violin", "Volleyball (Ball)", "Waffle",
    "Waffle iron", "Wall clock", "Wardrobe", "Washing machine", "Waste container",
    "Watch", "Watercraft", "Watermelon", "Weapon", "Whale", "Wheel", "Wheelchair",
    "Whisk", "Whiteboard", "Willow", "Window", "Window blind", "Wine", "Wine glass",
    "Wine rack", "Winter melon", "Wok", "Woman", "Wood-burning stove", "Woodpecker",
    "Worm", "Wrench", "Zebra", "Zucchini"
}

# Load model
print("Loading YOLOv8 OIV7 model...")
model = YOLO("yolov8n-oiv7.pt")
print(f"Loaded {len(model.names)} classes")

# WebSocket connection
ws = None
ws_lock = threading.Lock()

def get_allowed_classes():
    """Get the set of allowed classes based on current filter mode"""
    with settings_lock:
        mode = filter_mode.lower()

    if mode == "indoor":
        return indoor_classes.union(both_classes)
    elif mode == "outdoor":
        return outdoor_classes.union(both_classes)
    else:  # "all"
        return None  # None means allow all

def is_class_allowed(class_name):
    """Check if a class is allowed by current filter"""
    allowed = get_allowed_classes()
    if allowed is None:
        return True
    return class_name in allowed

def connect_ws():
    global ws
    while True:
        try:
            with ws_lock:
                ws = websocket.create_connection(VPS_WS)
            print(f"[WS] Connected to {VPS_WS}")
            # Send registration message
            reg_msg = {"type": "JETSON_REGISTER", "capabilities": ["detection"]}
            with ws_lock:
                ws.send(json.dumps(reg_msg))
            return
        except Exception as e:
            print(f"[WS] Connection failed: {e}, retrying...")
            time.sleep(3)

def send_detections(cam_id, detections):
    global ws
    if not detections:
        return
    try:
        with ws_lock:
            if ws is None:
                return
            msg = {
                "type": "DETECTIONS",
                "camera": cam_id,
                "detections": detections,
                "count": len(detections)
            }
            ws.send(json.dumps(msg))
    except Exception as e:
        print(f"[WS] Send error: {e}")
        with ws_lock:
            ws = None

def ws_listener():
    """Listen for settings updates from VPS"""
    global ws, filter_mode, confidence_threshold

    while True:
        try:
            with ws_lock:
                if ws is None:
                    time.sleep(1)
                    continue

            # Set a timeout so we can check connection status
            try:
                with ws_lock:
                    ws.settimeout(1.0)
                    data = ws.recv()
            except websocket.WebSocketTimeoutException:
                continue
            except Exception as e:
                print(f"[WS] Receive error: {e}")
                with ws_lock:
                    ws = None
                connect_ws()
                continue

            if data:
                # Skip binary data (video frames)
                if isinstance(data, bytes):
                    # Only try to decode if it looks like JSON (starts with '{')
                    if len(data) < 2 or data[0] != ord('{'):
                        continue
                    try:
                        data = data.decode('utf-8')
                    except:
                        continue

                try:
                    msg = json.loads(data)
                    msg_type = msg.get("type", "")

                    # Handle settings updates
                    if msg_type == "DETECTION_SETTINGS":
                        with settings_lock:
                            if "filter_mode" in msg:
                                old_mode = filter_mode
                                filter_mode = msg["filter_mode"]
                                if old_mode != filter_mode:
                                    print(f"[SETTINGS] Filter mode: {filter_mode}")
                            if "confidence" in msg:
                                old_conf = confidence_threshold
                                confidence_threshold = max(0.01, min(1.0, float(msg["confidence"])))
                                if abs(old_conf - confidence_threshold) > 0.01:
                                    print(f"[SETTINGS] Confidence: {confidence_threshold:.2f}")

                except json.JSONDecodeError:
                    pass

        except Exception as e:
            print(f"[WS Listener] Error: {e}")
            time.sleep(1)

def process_camera(cam):
    global confidence_threshold
    cam_id = cam["id"]
    cam_name = cam["name"]
    url = cam["url"]

    print(f"[CAM{cam_id}] Starting {cam_name}...")

    while True:
        try:
            # Use ffmpeg to capture RTSP and pipe raw frames
            cmd = [
                'ffmpeg',
                '-rtsp_transport', 'udp',
                '-i', url,
                '-f', 'rawvideo',
                '-pix_fmt', 'bgr24',
                '-s', f'{WIDTH}x{HEIGHT}',
                '-r', '5',  # 5 fps for detection
                '-'
            ]

            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                bufsize=WIDTH * HEIGHT * 3
            )

            print(f"[CAM{cam_id}] Connected to {cam_name}")
            frame_size = WIDTH * HEIGHT * 3
            last_detect = 0

            while True:
                raw = proc.stdout.read(frame_size)
                if len(raw) != frame_size:
                    print(f"[CAM{cam_id}] Lost stream")
                    break

                # Convert to numpy array
                frame = np.frombuffer(raw, dtype=np.uint8).reshape((HEIGHT, WIDTH, 3))

                # Run detection every 200ms
                now = time.time()
                if now - last_detect < 0.2:
                    continue
                last_detect = now

                # Get current confidence threshold
                with settings_lock:
                    conf_thresh = confidence_threshold

                # Run YOLOv8
                results = model(frame, conf=0.03, iou=0.4, verbose=False)

                detections = []
                for r in results:
                    for box in r.boxes:
                        x1, y1, x2, y2 = box.xyxy[0].cpu().numpy()
                        conf = float(box.conf[0])
                        cls_id = int(box.cls[0])
                        class_name = model.names[cls_id]
                        class_name_lower = class_name.lower()

                        # Apply indoor/outdoor filter
                        if not is_class_allowed(class_name):
                            continue

                        # Apply confidence threshold (dynamic for small objects)
                        base_thresh = conf_thresh
                        if class_name_lower in small_objects:
                            base_thresh = max(0.03, conf_thresh * 0.6)
                        if conf < base_thresh:
                            continue

                        # Normalized bbox
                        cx = (x1 + x2) / 2 / WIDTH
                        cy = (y1 + y2) / 2 / HEIGHT
                        bw = (x2 - x1) / WIDTH
                        bh = (y2 - y1) / HEIGHT

                        detections.append({
                            "class": class_name,
                            "confidence": round(conf, 2),
                            "bbox": {"x": round(cx, 3), "y": round(cy, 3),
                                    "w": round(bw, 3), "h": round(bh, 3)},
                            "is_living": class_name_lower in living_classes
                        })

                        if len(detections) >= 20:
                            break

                if detections:
                    classes = [d["class"] for d in detections]
                    print(f"[CAM{cam_id}] {len(detections)}: {', '.join(classes[:5])}")
                    send_detections(cam_id, detections)

            proc.kill()

        except Exception as e:
            print(f"[CAM{cam_id}] Error: {e}")

        time.sleep(2)

# Start
print("=" * 40)
print("  YOLOv8 OIV7 - 601 Classes")
print("  Indoor/Outdoor Filtering Enabled")
print("=" * 40)

connect_ws()

# Start WebSocket listener thread
ws_thread = threading.Thread(target=ws_listener, daemon=True)
ws_thread.start()
print("[WS] Settings listener started")

# Start camera threads
for cam in CAMERAS:
    t = threading.Thread(target=process_camera, args=(cam,), daemon=True)
    t.start()

# Keep running
try:
    while True:
        time.sleep(1)
except KeyboardInterrupt:
    print("\nStopping...")
