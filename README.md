# Cemani Homestead Robot

A remote-controlled robot built to help around the homestead. Controls from anywhere via web browser.

## What It Does

- **Remote Control**: Drive the robot from any web browser, anywhere in the world
- **Camera Feeds**: Two PTZ cameras with live video and AI object detection
- **LIDAR Mapping**: 360-degree laser scanning shows obstacles in 3D
- **Autonomous Mode**: Robot can explore on its own using sensors
- **Xbox Controller**: Local control via Bluetooth gamepad

## Hardware

| Part | Purpose |
|------|---------|
| 4x Hub Motors (ZLLG80ASM250) | Tank drive, 2 per side |
| 2x ZLAC8015D Drivers | Motor control via Modbus |
| Teensy 4.1 | Main controller |
| ESP32 | WiFi/Bluetooth bridge |
| Jetson Orin Nano | AI processing |
| RPLidar A1 | 360° laser scanning |
| 2x PTZ Cameras | Front and rear video |
| 4x Ultrasonic Sensors | Proximity detection |
| GPS + Compass | Position and heading |
| 24V LiFePO4 Battery | 720Wh total |

## Software Components

```
CemaniHomesteadRobot/
├── teensy-robot/              # Motor control firmware
├── esp32-robot-controller/    # Bluetooth/WiFi bridge
├── vps-server/                # Web server and command center
├── jetson-object-detection/   # AI detection and autonomous navigation
├── jetson-lidar/              # LIDAR relay
├── mac-visualizer/            # Mac Mini processor for 3D mapping
└── mac-camera-relay/          # Camera relay
```

## Web Interface

The command center at robot.marijuanaunion.com shows:

- Live camera feeds with AI detection overlays
- 3D LIDAR view with real-time obstacle display
- Tank drive controls (direction buttons, distance presets)
- Ultrasonic sensor readings at each corner
- Battery voltage, motor temps, GPS position
- Xbox controller status

## How Data Flows

```
Browser <---> VPS Server <---> ESP32 <---> Teensy <---> Motors
                  ^
                  |
         Jetson (cameras, LIDAR, AI)
                  ^
                  |
         Mac Mini (point cloud processing)
```

## Current Setup

The robot runs on a home network. The Jetson handles camera feeds and AI detection. LIDAR data goes through the VPS. The Mac Mini processes accumulated point cloud data for the 3D visualization.

## Controls

- **Xbox Controller**: Left stick drives, bumpers turn
- **Web UI**: Click direction, click distance, click GO
- **MAP Mode**: Robot explores autonomously using sensors

## Project Status

Working:
- Remote driving from browser
- Dual PTZ cameras with detection
- LIDAR 3D visualization
- Ultrasonic proximity sensing
- GPS and compass
- Autonomous exploration mode

Coming next:
- Waypoint navigation
- Patrol routes

## License

MIT
