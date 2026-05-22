<div align="center">

# Cemani Homestead Robot

<p align="center">
  <a href="https://youtu.be/NWnGvvdvRik">
    <img src="https://img.youtube.com/vi/NWnGvvdvRik/maxresdefault.jpg" width="640" alt="Backyard robot demo">
  </a>
  <br>
  <em>▶ Watch the demo on YouTube</em>
</p>


### Autonomous AI-Powered Tank Platform

![Status](https://img.shields.io/badge/Status-Robot_Brain_Live-green?style=for-the-badge)
![AI](https://img.shields.io/badge/AI-Claude_+_YOLOv8_+_Depth_AI-purple?style=for-the-badge)
![Power](https://img.shields.io/badge/Power-24V_LiFePO4_1kW-orange?style=for-the-badge)
![Control](https://img.shields.io/badge/Control-Text_From_Phone-blue?style=for-the-badge)

**Text it commands from your phone. It drives itself, avoids obstacles, detects 601 objects, builds 3D maps, and texts you back.**

[Demo](#demo) | [Robot Brain](#-robot-brain) | [3D Mapping](#-3d-mapping) | [AI Vision](#-ai-vision) | [Architecture](#-architecture) | [Hardware](#-hardware) | [Roadmap](#-roadmap)

---

![Robot Diagram](docs/robot-diagram.png)

---

### Command Center

![Command Center](docs/command-center.png)

*Real-time web interface: dual PTZ cameras with AI object detection, 3D LIDAR point cloud, autonomous brain control, and tank drive*

</div>

---

## Demo

### Robot Pulling Firewood Cart

https://github.com/user-attachments/assets/6a05e239-ce66-46ee-b951-474730370bfe

*1kW tank platform pulling a loaded metal cart around the homestead.*

---

<table>
<tr>
<td width="33%">

https://github.com/user-attachments/assets/9921ebb9-426a-4740-9e35-a875a7818416

*Mobility test*

</td>
<td width="33%">

https://github.com/user-attachments/assets/a52f8c41-8795-4027-825c-4a8bdb81a10c

*Maneuverability*

</td>
<td width="33%">

https://github.com/user-attachments/assets/fd26b6ea-948a-4a99-8cf5-652a429bc2db

*Speed test*

</td>
</tr>
</table>

---

## Robot Brain

**Text your robot from your phone. It understands natural language, moves autonomously, and reports back.**

### Phone Commands

| You Text | Robot Does |
|----------|-----------|
| `forward 6` | Drives forward 6 feet, avoids obstacles |
| `back 3` | Reverses 3 feet |
| `turn left 90` | Turns left 90 degrees |
| `explore` | Wanders autonomously, avoiding everything |
| `go home` | Returns to starting position |
| `status` | Texts back position, battery, obstacles |
| `go check the yard` | Claude AI parses intent, plans route |
| `stop` | Emergency stop |

### How It Works

```
Your Phone (iMessage)
    |
    v
Mac Mini (message relay)
    |
    v
Jetson Orin Nano (robot-brain/brain.py)
    ├── Claude API parses natural language
    ├── Plans movement from sensor data
    ├── LIDAR + ultrasonic obstacle avoidance
    └── Sends motor commands via WebSocket
            |
            v
      VPS Server (command routing)
            |
            v
      ESP32 -> Teensy 4.1 -> Motors
```

### Web Command Center

The brain is also controllable from the web UI with a **BRAIN** panel:
- Quick buttons: FWD, BACK, LEFT, RIGHT, EXPLORE, HOME, STOP
- Text input for natural language commands
- Live status: position, heading, obstacles, battery

### API

```bash
# Start the brain on Jetson
cd robot-brain && bash start.sh

# HTTP endpoints (port 5000)
curl -X POST localhost:5000/command -d '{"action":"forward","value":3}'
curl -X POST localhost:5000/text -d '{"text":"go forward 6 feet"}'
curl localhost:5000/status
```

---

## 3D Mapping

**Real-time photorealistic 3D environment mapping using sensor fusion**

```
PTZ Cameras (2x)         RPLidar A1M8 (360°)
      |                        |
      v                        v
Depth Anything V2        Laser Point Cloud
(Mac M1 GPU)             (8000 pts/sec)
      |                        |
      +--------+-------+------+
               |
        Point Cloud Fusion
        • Voxel grid (10cm cells)
        • Dynamic vs static classification
        • Wall confirmation (3+ observations)
        • 1M point photorealistic output
               |
               v
        Three.js 3D Visualization
        (live in browser)
```

| Feature | Detail |
|---------|--------|
| **Monocular Depth** | Depth Anything V2 from single camera |
| **LIDAR Fusion** | Laser calibrates monocular depth scale |
| **PTZ Scanning** | Automated camera sweep patterns |
| **Dead Reckoning** | Encoder-based odometry (4096 counts/rev) |
| **Persistence** | Confirmed walls save to disk |

---

## AI Vision

**601-class real-time object detection on Jetson Orin Nano**

- **YOLOv8n** with TensorRT GPU acceleration (~11ms per frame)
- **Indoor mode:** furniture, appliances, household items
- **Outdoor mode:** vehicles, wildlife, landscape
- **Living mode:** people, animals, threats (triggers safety stops)
- Detections overlay on live camera feeds in browser

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                                                                │
│   Phone ──► Mac ──► Jetson (Robot Brain)                      │
│                        ├── YOLOv8 Detection                   │
│                        ├── LIDAR Streaming                    │
│                        └── Autonomous Navigation              │
│                              |                                 │
│   Browser ◄──► VPS Server (WebSocket Hub) ◄──► ESP32          │
│                     ├── Command routing          |             │
│                     ├── Frame relay          Teensy 4.1        │
│                     └── Brain control         ├── Modbus       │
│                              |                ├── Sensors      │
│                         Mac Mini M1           └── Motors       │
│                         └── Depth Anything V2                  │
│                         └── 3D Mapping                         │
│                                                                │
└──────────────────────────────────────────────────────────────┘
```

### Compute Stack

| Device | Role |
|--------|------|
| **Teensy 4.1** | Motor control, Modbus, sensors, safety watchdog |
| **ESP32** | WiFi/Bluetooth bridge, Xbox controller (Bluepad32) |
| **Jetson Orin Nano Super** | Robot brain, YOLOv8, LIDAR relay |
| **Mac Mini M1** | Depth Anything V2, 3D mapping, iMessage relay |
| **VPS** | WebSocket hub, web UI hosting, API |

---

## Hardware

| Component | Specification |
|-----------|---------------|
| **Drive** | 4x ZLLG80ASM250 hub motors (250W each, 1kW total) |
| **Drivers** | 2x ZLAC8015D (Modbus RS-485) |
| **LIDAR** | RPLidar A1M8 (360°, 8000 samples/sec, 6m range) |
| **Cameras** | 2x Sricam PTZ (1080p, ONVIF, pan/tilt) |
| **Ultrasonics** | 4x JSN-SR04T (corners: FL, FR, RL, RR) |
| **Compass** | HMC5883L magnetometer |
| **GPS** | Serial @ 38400 baud |
| **Encoders** | 4096 counts/rev (built into ZLAC drivers) |
| **Power** | 24V LiFePO4 8S, 720Wh |
| **Wheels** | 10" pneumatic, direct hub motor drive |
| **Frame** | 2020 aluminum extrusion |
| **Weight** | ~80 lbs, 100+ lbs payload tested |
| **Speed** | ~8 mph max, ~0.4 mph autonomous |

---

## Code Structure

```
CemaniHomesteadRobot/
├── robot-brain/               # Autonomous movement + text control + Claude AI
├── teensy-robot/              # Motor control, Modbus, sensors, safety
├── esp32-robot-controller/    # WiFi/BT bridge, Xbox controller
├── vps-server/                # Web UI, WebSocket hub, command routing
├── jetson-object-detection/   # YOLOv8 TensorRT + autonomous navigation
├── jetson-lidar/              # RPLidar A1 streaming
├── mac-visualizer/            # Depth Anything V2, 3D mapping pipeline
├── mac-camera-relay/          # PTZ camera control relay
└── docs/                      # Diagrams, screenshots
```

---

## 🛠️ Setup — Configure These Before Running

This repo was scrubbed of secrets before being made public. If you clone it and try to run it as-is, you'll see placeholder values where real network addresses and credentials used to be. **You need to replace them with your own before anything actually connects to anything.**

### Placeholders in the repo

| Placeholder | What it is | Where to find |
|---|---|---|
| `YOUR_VPS_IP` | Public IP / hostname of the VPS running `vps-server/` (Node.js + pm2) | Every `.py` / `.js` / `.md` / `.sh` with a `ws://` or `http://` URL |
| `YOUR_JETSON_IP` | LAN IP of your Jetson Orin Nano running `jetson-lidar/` and `jetson-object-detection/` | `launch_map1.sh` and a couple of Python files |
| `YOUR_CAMERA_PASSWORD` | RTSP password for your ONVIF PTZ cameras | `mac-visualizer/hybrid_3d_mapper.py`, `jetson-object-detection/*.py`, `mac-camera-relay/README.md` |
| `config.example.json` files | Per-service config (camera IPs, VPS auth, etc.) | Copy each `config.example.json` to `config.json` and fill in. `config.json` is gitignored so your real values never get committed. |

### The launcher script

`launch_map1.sh` now reads `VPS_HOST` and `JETSON_HOST` from environment variables. Set them before running:

```bash
export VPS_HOST="root@1.2.3.4"
export JETSON_HOST="jetson@192.168.1.31"
bash launch_map1.sh
```

And set up SSH key authentication for both hosts — the original script shipped with `sshpass -p 'jetson'` (NVIDIA's default Jetson password), which is exactly the kind of pattern that should never be in a public repo. Generate SSH keys and `ssh-copy-id` them to both hosts before running anything.

### 🔒 What's *not* in this repo (on purpose)

The `.gitignore` already excludes real secret files — you'll see `*.example` stubs for each of these but never the real thing:

- `**/credentials.h` (ESP32 WiFi credentials)
- `mac-camera-relay/config.json`, `jetson-camera-relay/config.json`, `jetson-lidar/config.json`, `jetson-object-detection/config.json` (camera passwords)
- `vps-server/auth.json` (VPS login)
- `.env`, `.env.*`
- `*.pem`, `*.key`, `id_rsa*` (SSH keys)
- `private/`, `secrets/`

If you add new secrets while working on your fork, put them in a file that matches one of those patterns — or add a new line to `.gitignore` — so they stay out of git.

---

## Roadmap

### Working Now
- [x] Tank drive with Xbox controller + web joystick
- [x] Dual PTZ camera streaming with depth overlay
- [x] 601-class AI object detection (YOLOv8 + TensorRT)
- [x] 360° LIDAR with 3D point cloud visualization
- [x] Hybrid 3D mapping (LIDAR + monocular depth fusion)
- [x] Encoder-based dead reckoning odometry
- [x] Autonomous mapping with obstacle avoidance
- [x] Robot Brain with text message control from phone
- [x] Claude AI natural language command parsing
- [x] Distance-based movement (go forward X feet)
- [x] Web command center with brain control panel
- [x] Indoor SLAM occupancy grid mapping
- [x] Semantic map (named zones, object tracking)

### Building Next
- [ ] IMU upgrade (BNO085 - accelerometer + gyroscope)
- [ ] Intel RealSense D455 depth camera
- [ ] A* path planning with obstacle map
- [ ] SLAM loop closure
- [ ] Auto-docking charging station
- [ ] Predator detection alerts (text when bear/coyote seen)
- [ ] Patrol route scheduling (time-based rounds)

### Future Vision
- [ ] Robotic arm (scoop poop, pour chicken feed, grab objects)
- [ ] Dog walking with leash tension control
- [ ] Chicken coop automation (feeding, door open/close)
- [ ] Voice commands via phone
- [ ] Multi-robot coordination
- [ ] Train engine body shell for giving kids rides

---

## License

MIT

---

<div align="center">

**Built on a homestead in Humboldt County, California**

*Started with a chicken predator problem. Now it's an autonomous AI homestead assistant you can text from your phone.*

[GitHub](https://github.com/nicedreamzapp) | [Reddit](https://www.reddit.com/r/robotics/comments/1ov3k5v/)

</div>
