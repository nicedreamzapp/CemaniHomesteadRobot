# Cemani Homestead Robot

```
     ___________
    /           \      ___________
   |  CEMANI    |     / CAMERA 1 \
   |   ROBOT    |====[___PTZ____]=====
   |  ________  |     \_________/
   | |LIDAR  | |
   | |_______|_|      ___________
   |    ||||    |    / CAMERA 2 \
   |====    ====|====[___PTZ____]=====
   |  [WHEEL]   |     \_________/
    \___________/
         ||
    [ULTRASONIC]
```

> **An autonomous mapping robot with photorealistic 3D reconstruction using AI-powered depth estimation, LIDAR fusion, and real-time visualization.**

---

## System Architecture

```
+------------------+     WiFi      +------------------+     WebSocket    +------------------+
|                  |-------------->|                  |----------------->|                  |
|   TEENSY 4.1     |   Serial      |   JETSON NANO    |    Camera Feed   |   VPS SERVER     |
|   Motor Control  |<--------------|   AI Processing  |<-----------------|   Web Dashboard  |
|   Encoders       |               |   Object Detect  |                  |   3D Visualizer  |
|   Telemetry      |               |   LIDAR Relay    |                  |   Robot Control  |
+------------------+               +------------------+                  +------------------+
        |                                   |                                     |
        v                                   v                                     v
+------------------+               +------------------+                  +------------------+
|   ESP32          |               |   YDLidar X2     |                  |   Mac M4         |
|   WiFi Bridge    |               |   360° Scanner   |                  |   Depth AI       |
|   WebSocket      |               |   12m Range      |                  |   3D Mapping     |
+------------------+               +------------------+                  +------------------+
```

---

## Hardware Components

| Component | Model | Purpose | Connection |
|-----------|-------|---------|------------|
| Main MCU | **Teensy 4.1** | Motor control, encoders, telemetry | USB Serial |
| WiFi Bridge | **ESP32** | WebSocket communication | Serial to Teensy |
| AI Computer | **Jetson Nano** | Object detection, camera relay | Ethernet |
| LIDAR | **YDLidar X2** | 360° room scanning | USB to Jetson |
| Cameras | **2x PTZ** | Stereo vision, scanning | RTSP to Jetson |
| Depth AI | **Mac M4** | Depth Anything V2 processing | WebSocket |
| Ultrasonics | **4x HC-SR04** | Obstacle avoidance (FL, FR, RL, RR) | Teensy GPIO |

---

## Software Stack

| Layer | Technology | Description |
|-------|------------|-------------|
| Frontend | **Three.js** | Real-time 3D LIDAR visualization |
| Backend | **Node.js** | WebSocket server, robot control API |
| AI Depth | **Depth Anything V2** | State-of-the-art monocular depth estimation |
| Detection | **YOLO** | Real-time object detection on Jetson |
| Mapping | **Python + PyTorch** | Hybrid 3D mapper with LIDAR fusion |
| Firmware | **C++ / Arduino** | Teensy motor control, ESP32 WiFi |

---

## Quick Start

### 1. Start the VPS Server
```bash
ssh root@your-vps-ip
cd /opt/robot-server && pm2 start server.js --name robot
```

### 2. Start Jetson Services
```bash
ssh jetson@192.168.1.31  # password: jetson
python3 ~/lidar_relay.py &
python3 ~/local_streamer.py &
```

### 3. Start Mac Depth Processor
```bash
cd mac-visualizer
python3 hybrid_3d_mapper.py 2>&1 | tee /tmp/mapper.log
```

### 4. Open Web Dashboard
Navigate to `https://robot.yourdomain.com` and press **MAP 1** to start mapping!

---

## Mapping Pipeline

```
                              MAP 1 BUTTON
                                   |
                                   v
+-----------------------------------------------------------------------------+
|                           MAPPING SEQUENCE                                  |
+-----------------------------------------------------------------------------+
|                                                                             |
|  1. PTZ SCAN         2. DEPTH AI           3. LIDAR FUSION                  |
|  +-----------+       +-----------+         +-----------+                    |
|  | Camera 1  |------>| Depth     |-------->| Point     |                    |
|  | Camera 2  |       | Anything  |         | Cloud     |                    |
|  | 360° Scan |       | V2 Large  |         | Coloring  |                    |
|  +-----------+       +-----------+         +-----------+                    |
|       |                    |                     |                          |
|       v                    v                     v                          |
|  +-----------+       +-----------+         +-----------+                    |
|  | JPEG      |       | Mono      |         | Colored   |                    |
|  | Frames    |       | Depth Map |         | 3D Points |                    |
|  +-----------+       +-----------+         +-----------+                    |
|                            |                     |                          |
|                            v                     v                          |
|                      +---------------------------------+                    |
|                      |    CONFIRMED WALLS JSON         |                    |
|                      |    Photorealistic 3D Map        |                    |
|                      +---------------------------------+                    |
|                                                                             |
+-----------------------------------------------------------------------------+
```

---

## Network Configuration

| Device | IP Address | Port | Protocol |
|--------|------------|------|----------|
| Jetson Nano | `192.168.1.31` | 8765 | WebSocket |
| ESP32 | `192.168.1.228` | - | WiFi to VPS |
| VPS Server | `robot.yourdomain.com` | 443 | WSS/HTTPS |
| PTZ Camera 1 | `192.168.1.109` | 554 | RTSP |
| PTZ Camera 2 | `192.168.1.110` | 554 | RTSP |

---

## Features

### Real-Time 3D Visualization
- **LIDAR panels** - Live wall detection in 3D
- **Ultrasonic cones** - 4-corner obstacle visualization
- **Robot model** - Centered view with world moving around it
- **Encoder odometry** - Position tracking from wheel encoders

### AI-Powered Depth
- **Depth Anything V2 Large** - 518M parameter model
- **MPS acceleration** - Apple Silicon GPU support
- **LIDAR validation** - Cross-reference mono depth with LIDAR

### Autonomous Mapping
- **PTZ continuous scan** - Cameras sweep during mapping
- **Multi-source fusion** - Cameras + LIDAR + Depth AI
- **Persistent storage** - Maps saved to `confirmed_walls.json`

---

## Project Structure

```
CemaniHomesteadRobot/
|-- esp32-robot-controller/    # ESP32 WiFi bridge firmware
|-- jetson-camera-relay/       # Camera streaming to VPS
|-- jetson-lidar/              # LIDAR relay scripts
|-- jetson-object-detection/   # YOLO detection + local streamer
|-- mac-visualizer/            # Depth AI + 3D mapping
|   |-- hybrid_3d_mapper.py    # Main mapping processor
|   |-- confirmed_walls.json   # Persistent 3D map data
|-- teensy-robot/              # Motor control firmware
|-- vps-server/                # Web dashboard + WebSocket server
    |-- public/                # Frontend (Three.js, UI)
    |-- server.js              # Main server
```

---

## Controls

| Button | Action |
|--------|--------|
| **MAP 1** | Start full mapping sequence |
| **STOP** | Emergency stop all motors |
| **SPIN** | 360° rotation for LIDAR scan |
| **HOME** | Return to starting position |
| **PTZ** | Manual camera control |

---

## Safety

> **IMPORTANT:** Robot movement can only be initiated by pressing buttons in the web UI. This ensures the operator can verify the robot is in a safe position before any motion occurs.

---

## License

MIT License - Built for the Cemani Homestead

---

*Made with determination by the Cemani Homestead team*
