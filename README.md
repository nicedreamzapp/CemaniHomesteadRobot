<div align="center">

# Cemani Homestead Robot

### Autonomous Dual-Armed Tank Platform with AI Vision & 3D Mapping

![Made with](https://img.shields.io/badge/Made_with-Blood_Sweat_Tears-red?style=for-the-badge)
![Status](https://img.shields.io/badge/Status-3D_Mapping_Live-green?style=for-the-badge)
![Power](https://img.shields.io/badge/Power-24V_LiFePO4-orange?style=for-the-badge)
![AI](https://img.shields.io/badge/AI-YOLOv8_+_Depth_Anything-purple?style=for-the-badge)
![LIDAR](https://img.shields.io/badge/LIDAR-RPLidar_A1M8-blue?style=for-the-badge)

**Built to protect chickens, automate chores, and give kids rides around the homestead**

[Demo Videos](#demo) | [3D Mapping](#-3d-mapping--sensor-fusion) | [AI Detection](#-ai-object-detection) | [Web Interface](#-web-interface) | [Hardware](#-hardware)

</div>

---

## Demo

### Robot Pulling Firewood Cart

https://github.com/user-attachments/assets/6a05e239-ce66-46ee-b951-474730370bfe

*Successfully pulling a loaded metal cart - first real-world test after 6 months of building and learning.*

---

### Build Process & Testing

<table>
<tr>
<td width="50%">

**Chassis Assembly**

![Chassis](https://github.com/user-attachments/assets/32430365-4cf8-4abc-9d9f-82167b31484c)

*2020 aluminum extrusion frame with motor mounts*

</td>
<td width="50%">

**Electronics Bay**

![Electronics](https://github.com/user-attachments/assets/c5690957-92af-4711-9627-1c7eadb0bac4)

*Teensy 4.1, ESP32, ZLAC drivers, and power distribution*

</td>
</tr>
</table>

### More Testing Footage

<table>
<tr>
<td width="33%">

https://github.com/user-attachments/assets/9921ebb9-426a-4740-9e35-a875a7818416

*Initial mobility test*

</td>
<td width="33%">

https://github.com/user-attachments/assets/a52f8c41-8795-4027-825c-4a8bdb81a10c

*Maneuverability demo*

</td>
<td width="33%">

https://github.com/user-attachments/assets/fd26b6ea-948a-4a99-8cf5-652a429bc2db

*Speed testing*

</td>
</tr>
</table>

---

## 3D Mapping & Sensor Fusion

**Real-time photorealistic 3D environment mapping using hybrid sensor fusion**

### How It Works

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    HYBRID 3D MAPPING PIPELINE                           │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   PTZ Cameras (2x)              RPLidar A1M8                           │
│        │                              │                                 │
│        ▼                              ▼                                 │
│   ┌──────────────┐            ┌──────────────┐                         │
│   │ Depth        │            │ 360° Laser   │                         │
│   │ Anything V2  │            │ Point Cloud  │                         │
│   │ (Mac M1 GPU) │            │ (8000 pts/s) │                         │
│   └──────┬───────┘            └──────┬───────┘                         │
│          │                           │                                  │
│          ▼                           ▼                                  │
│   ┌─────────────────────────────────────────────┐                      │
│   │         POINT CLOUD FUSION                   │                      │
│   │  • Voxel grid downsampling (10cm)           │                      │
│   │  • Dynamic object classification            │                      │
│   │  • Observation persistence scoring          │                      │
│   │  • Wall confirmation (3+ observations)      │                      │
│   └──────────────────┬──────────────────────────┘                      │
│                      │                                                  │
│                      ▼                                                  │
│   ┌─────────────────────────────────────────────┐                      │
│   │         3D VISUALIZATION (Browser)          │                      │
│   │  • Three.js WebGL rendering                 │                      │
│   │  • Color-coded depth (near=warm, far=cool)  │                      │
│   │  • Live robot position tracking             │                      │
│   │  • Compass heading overlay                  │                      │
│   └─────────────────────────────────────────────┘                      │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### Features

| Feature | Description |
|---------|-------------|
| **Monocular Depth** | Depth Anything V2 estimates distance from single camera images |
| **LIDAR Fusion** | Calibrates depth scale using accurate laser measurements |
| **PTZ Scanning** | Cameras sweep patterns to map full environment |
| **Dynamic Classification** | Distinguishes static walls from moving objects |
| **Persistence** | Confirmed walls saved to disk, survive restarts |
| **Dead Reckoning** | Encoder-based odometry tracks robot position |

### Dynamic Object Detection

Points are classified as static or dynamic based on observation patterns:

```
Motion Score = 0.0 → Static (walls, furniture)     [Solid rendering]
Motion Score = 0.5 → Uncertain                     [Yellow tint]
Motion Score = 1.0 → Dynamic (people, pets)        [Orange/pulsing]
```

---

## AI Object Detection

**Real-time 601-class object detection running on Jetson Orin Nano**

### Detection Pipeline

```
┌────────────────────────────────────────────────────────────────────────┐
│                      SHARED STREAM DETECTION                           │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│   PTZ Cameras ──► relay.js ──► TCP Frame Share ──► detect.py          │
│       │              │                                  │              │
│       │         (captures       (shares frames     (YOLOv8 +          │
│       │          RTSP)          to detector)       TensorRT)          │
│       │                                                 │              │
│       │                                                 ▼              │
│       │                                        ┌──────────────┐       │
│       │                                        │  ~11ms/frame │       │
│       │                                        │  GPU Accel   │       │
│       │                                        └──────┬───────┘       │
│       │                                               │               │
│       ▼                                               ▼               │
│   Browser ◄──────────────── VPS ◄─────────────── Detections          │
│   (overlay                 (relay)               + bounding           │
│    boxes)                                         boxes               │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

### Classes Detected

| Category | Examples |
|----------|----------|
| **Living** | person, dog, cat, bird, bear, raccoon, chicken |
| **Vehicles** | car, truck, bicycle, motorcycle |
| **Indoor** | chair, couch, bed, toilet, tv, laptop |
| **Outdoor** | tree, fence, bench, fire hydrant |
| **Animals** | 80+ species including wildlife threats |

### Indoor/Outdoor Filtering

Toggle between detection modes:
- **All** - Show everything
- **Indoor** - Furniture, appliances, household items
- **Outdoor** - Vehicles, wildlife, landscape features

---

## Web Interface

**Control and monitor from ANYWHERE in the world**

### Command Center Features

| Feature | Description |
|---------|-------------|
| **Virtual Joystick** | Tank steering control (touch or mouse) |
| **Dual Camera Feeds** | Front/rear PTZ with live depth overlay |
| **3D LIDAR Map** | Real-time point cloud visualization |
| **Object Detection** | Bounding boxes with class labels |
| **Telemetry** | Battery, motor RPM, temperatures |
| **Compass/GPS** | Heading and position display |
| **Ultrasonic** | 4-corner proximity sensors |
| **Autonomous Mode** | One-click mapping patrol |

### Autonomous Mapping

Click **MAP** to start autonomous exploration:
1. Robot drives forward
2. PTZ cameras scan in patterns
3. Depth points accumulate in 3D map
4. Obstacles trigger avoidance maneuvers
5. Walls get confirmed after multiple observations
6. Xbox controller overrides for manual control

### Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                     SYSTEM ARCHITECTURE                               │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│   Browser (Anywhere)                                                  │
│       │                                                               │
│       │ HTTPS/WSS                                                     │
│       ▼                                                               │
│   ┌────────────────────────────────────────┐                         │
│   │   VPS Server (Node.js + Nginx)         │                         │
│   │   robot.yourdomain.com                 │                         │
│   │   • WebSocket hub                      │                         │
│   │   • Command routing                    │                         │
│   │   • Frame relay                        │                         │
│   └───────────────┬────────────────────────┘                         │
│                   │ WebSocket                                         │
│       ┌───────────┼───────────┬────────────────┐                     │
│       ▼           ▼           ▼                ▼                     │
│   ┌───────┐  ┌─────────┐  ┌────────┐    ┌──────────┐                │
│   │ ESP32 │  │ Jetson  │  │Mac Mini│    │ Cameras  │                │
│   │(WiFi) │  │ Orin    │  │(3D Map)│    │ (PTZ)    │                │
│   └───┬───┘  └────┬────┘  └────────┘    └──────────┘                │
│       │           │                                                   │
│       │Serial     │ RTSP + Detection                                 │
│       ▼           ▼                                                   │
│   ┌───────┐  ┌─────────┐                                             │
│   │Teensy │  │ YOLOv8  │                                             │
│   │ 4.1   │  │TensorRT │                                             │
│   └───┬───┘  └─────────┘                                             │
│       │                                                               │
│       │ Modbus RS-485                                                 │
│       ▼                                                               │
│   ┌─────────────────────────────────────┐                            │
│   │  ZLAC8015D Drivers → Hub Motors     │                            │
│   │  (4x ZLLG80ASM250, tank config)     │                            │
│   └─────────────────────────────────────┘                            │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
```

---

## Hardware

### Main Components

| Component | Specification |
|-----------|---------------|
| **Drive Motors** | 4x ZLLG80ASM250 hub motors, 250W each |
| **Motor Drivers** | 2x ZLAC8015D, Modbus RS-485 |
| **Main Controller** | Teensy 4.1 (motor control, sensors) |
| **WiFi/Bluetooth** | ESP32 (Bluepad32 for Xbox controller) |
| **AI Processor** | Jetson Orin Nano Super (YOLOv8) |
| **3D Processing** | Mac Mini M1 (Depth Anything V2) |
| **LIDAR** | RPLidar A1M8 (360°, 8000 samples/sec) |
| **Cameras** | 2x Sricam PTZ (1080p, ONVIF) |
| **Power** | 24V LiFePO4 8S, 720Wh |
| **Sensors** | 4x ultrasonic, GPS, compass (BNO085) |

### Weight & Dimensions

| Spec | Value |
|------|-------|
| Total Weight | ~80 lbs |
| Wheel Diameter | 10" pneumatic |
| Ground Clearance | 4" |
| Max Speed | ~8 mph |
| Payload | 100+ lbs tested |

---

## Code Structure

```
CemaniHomesteadRobot/
├── teensy-robot/              # Motor control, sensors, Modbus
├── esp32-robot-controller/    # WiFi/Bluetooth bridge, OTA
├── vps-server/                # Web UI, WebSocket relay
├── jetson-object-detection/   # YOLOv8, TensorRT, camera relay
├── jetson-lidar/              # RPLidar streaming
├── mac-visualizer/            # Hybrid 3D mapper, depth estimation
├── mac-camera-relay/          # PTZ control relay
└── docs/                      # Wiring diagrams, screenshots
```

---

## Lessons Learned

### The Hard Parts

| Challenge | Solution |
|-----------|----------|
| **Tank steering** | Driver-specific direction inversion, atomic Modbus writes |
| **Power stability** | Automotive-grade buck converters (destroyed 4 Teensys with hobby DROKs) |
| **Ground loops** | Star grounding from battery negative |
| **Depth calibration** | LIDAR-calibrated scale for monocular depth |
| **WebSocket reliability** | Reconnection logic, ping/pong disabled for GPU blocking |

### Component Damage Report

| Component | Destroyed | Cause | Cost |
|-----------|-----------|-------|------|
| Teensy 4.1 | 4 | DROK voltage spikes | ~$120 |
| ESP32 | 3+ | DROK voltage spikes | ~$30 |
| Buck converters | 4 | Hobby-grade failure | ~$40 |
| **Since automotive grade** | **0** | - | **$0** |

---

## Roadmap

### Completed
- [x] Remote web control from anywhere
- [x] Dual PTZ camera streaming
- [x] Xbox controller support
- [x] Real-time object detection (601 classes)
- [x] 3D LIDAR visualization
- [x] Monocular depth estimation
- [x] Hybrid sensor fusion mapping
- [x] Dynamic object classification
- [x] Autonomous mapping mode
- [x] Dead reckoning odometry

### In Progress
- [ ] SLAM loop closure
- [ ] Path planning with A*
- [ ] Predator detection alerts
- [ ] Multi-room fingerprinting

### Future
- [ ] OpenArm integration
- [ ] Voice commands
- [ ] Mobile app with notifications
- [ ] Train engine body for kids

---

## License

MIT - Use this for your own robot projects!

---

<div align="center">

**Built with love on a homestead in Humboldt County, California**

*Started with a chicken problem, ended up building an autonomous homestead assistant.*

### "If it takes more than 10 minutes, automate it."

[GitHub](https://github.com/nicedreamzapp) | [Reddit](https://www.reddit.com/r/robotics/comments/1ov3k5v/)

</div>
