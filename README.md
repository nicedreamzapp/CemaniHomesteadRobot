# Cemani Homestead Robot

Tank-drive robot for homestead work. Control from anywhere via web browser.

## Features

- **Remote Control** - Drive from any browser, anywhere
- **Dual PTZ Cameras** - Front/rear with live AI object detection
- **3D LIDAR** - 360-degree laser scanning with real-time obstacle mapping
- **Autonomous Mode** - Self-navigation using sensor fusion
- **Xbox Controller** - Local Bluetooth gamepad support

## Hardware

| Component | Spec |
|-----------|------|
| Drive | 4x ZLLG80ASM250 hub motors, tank configuration |
| Controllers | Teensy 4.1 + ESP32 + Jetson Orin Nano |
| Sensors | RPLidar A1, 4x ultrasonic, GPS, compass |
| Power | 24V LiFePO4, 720Wh |

## Architecture

```
Browser <-> VPS <-> ESP32 <-> Teensy <-> Motors
              |
           Jetson (AI, cameras)
              |
           Mac Mini (3D processing)
```

## Components

```
teensy-robot/              # Motor control, sensors
esp32-robot-controller/    # WiFi/BT bridge
vps-server/                # Web UI, command relay
jetson-object-detection/   # YOLOv8 + TensorRT detection
jetson-camera-relay/       # RTSP to WebSocket streaming
mac-visualizer/            # Point cloud processing
```

## Detection Pipeline

Cameras stream via RTSP to relay.js, which shares frames with detect.py over TCP. TensorRT runs YOLOv8 inference at ~11ms/frame on the Jetson GPU. Detections overlay on the web UI in real-time.

## License

MIT
