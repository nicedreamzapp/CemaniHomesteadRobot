<div align="center">

# 🤖 Cemani Homestead Robot

### Autonomous Dual-Armed Tank Platform for Homestead Automation

![Made with](https://img.shields.io/badge/Made_with-Blood_Sweat_Tears-red?style=for-the-badge)
![Status](https://img.shields.io/badge/Status-Remote_Control_Live-green?style=for-the-badge)
![Power](https://img.shields.io/badge/Power-24V_LiFePO4-orange?style=for-the-badge)
![Remote](https://img.shields.io/badge/Remote-Control_From_Anywhere-blue?style=for-the-badge)
![Camera](https://img.shields.io/badge/Camera-PTZ_+_Audio-purple?style=for-the-badge)

**Built to protect chickens, automate chores, and give kids rides around the homestead**

[📹 Demo Videos](#demo) • [🌐 Web Interface](#-web-interface) • [📷 Camera System](#-remote-camera-system) • [🔧 Hardware](#hardware) • [🤖 The Vision](#the-vision) • [💻 Code](#code)

</div>

---

## 🎥 Demo

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

### Component Details

![Component Layout](https://github.com/user-attachments/assets/62f8c85c-d889-40bc-884e-81aa16f5a4e2)

*Hub motors, shocks, and wheel assembly*

---

## 🌐 Web Interface

**Control and monitor your robot from ANYWHERE in the world!**

![Web Dashboard](docs/screenshots/web-dashboard.webp)

*Command Center with dual camera feeds, PTZ controls, robot movement queue, and real-time telemetry*

### Futuristic Command Center Dashboard
**Design:** Glassmorphism UI with cyberpunk aesthetic - liquid glass effects, 3D embossing, spaceship cockpit vibes

**Features:**
- 🎮 **Virtual Joystick** - Tank steering control (simulates Xbox controller)
- 📊 **Real-Time Telemetry** - Live motor RPM, WiFi signal, session stats
- 🔋 **Battery Monitor** - Live voltage + percentage (24V LiFePO4 8S)
- 🌡️ **Temperature Display** - Driver and motor temps in Fahrenheit
- ⚡ **Motor Stats** - Left/Right speed (RPM), torque (Amps), encoder position
- 🖥️ **Serial Monitor Popup** - Draggable floating window for Teensy debug output
- 💻 **Code Editor** - Edit Teensy/ESP32/Driver code with syntax highlighting
- ⚡ **Compile & Upload** - Wireless firmware updates via browser
- 📡 **Command Input** - Send custom commands to robot
- 🔄 **Reset Button** - Soft reset (simulates Xbox A button)
- 📷 **Camera Feeds** - Dual IP camera streams with PTZ control + round light cam
- 🔋 **System Status** - ESP32, Teensy, ZLAC drivers health
- 🛰️ **Future Sensors** - Jetson Orin, LiDAR, GPS, PIR, OpenArm placeholders
- 🗺️ **Position Tracker** - Real-time odometry map with trip distance and heading

**Tech:** Glassmorphism CSS (backdrop-filter, blur, transparency), WebSocket real-time updates, Monaco editor integration

### Architecture
```
┌──────────────────────────────────────────────────────────────────┐
│                     ANYWHERE IN THE WORLD                         │
│   ┌─────────────────┐                                            │
│   │ Your Phone/PC   │──────┐                                     │
│   │   Any Browser   │      │                                     │
│   └─────────────────┘      │ HTTPS/WebSocket                     │
│                             ▼                                     │
│              ┌──────────────────────────────┐                    │
│              │  your-robot-domain.com       │                    │
│              │  (VPS - Node.js + Nginx)     │                    │
│              └───────────────┬──────────────┘                    │
│                              │ WebSocket                          │
│                              ▼                                     │
│   ┌────────────────────────────────────────────────────────┐    │
│   │                    ROBOT HARDWARE                       │    │
│   │  ┌─────────┐   Serial   ┌─────────┐   Modbus          │    │
│   │  │  ESP32  │◄──────────►│ Teensy  │◄────────►Motors   │    │
│   │  │ (WiFi+  │            │  4.1    │                    │    │
│   │  │  OTA)   │            └─────────┘                    │    │
│   │  └────┬────┘                                            │    │
│   │       │ Bluetooth                                       │    │
│   │       ▼                                                 │    │
│   │  ┌─────────┐                                            │    │
│   │  │  Xbox   │                                            │    │
│   │  │Controller│                                           │    │
│   │  └─────────┘                                            │    │
│   └────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────┘
```

### How It Works
1. **ESP32 connects to WiFi** on robot startup (home, hotspot, or work)
2. **Opens WebSocket** to your VPS server
3. **Sends Teensy serial data** to VPS in real-time
4. **Your browser connects** to VPS and sees live serial output
5. **Xbox controller still works** locally via Bluetooth - web doesn't interfere!

### Tech Stack
- **VPS:** Ubuntu 24.04 (any hosting provider works)
- **Backend:** Node.js WebSocket server with PM2 process manager
- **Frontend:** Vanilla HTML/CSS/JS (no frameworks needed)
- **Reverse Proxy:** Nginx for subdomain routing
- **Security:** HTTP Basic Auth (password protected)
- **ESP32:** WiFiMulti + WebSocket client + Bluepad32

---

## 📷 Remote Camera System

**Live PTZ camera with audio streaming - control from anywhere!**

### Camera Architecture
```
┌─────────────────────────────────────────────────────────────────────────┐
│                         REMOTE CAMERA CONTROL                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   Xbox Controller                                                        │
│        │ Bluetooth                                                       │
│        ▼                                                                 │
│   ESP32 (Robot)                                                          │
│        │                                                                 │
│        │ WiFi/WebSocket ──────────────────────────┐                     │
│        ▼                                           │                     │
│   ┌─────────────────────────────────────┐         │                     │
│   │   VPS Server (Node.js)              │         │                     │
│   │   robot.yourdomain.com              │         │                     │
│   │   - Routes PTZ commands             │         │                     │
│   │   - Broadcasts video/audio frames   │         │                     │
│   │   - WebSocket hub for all clients   │         │                     │
│   └──────────────┬──────────────────────┘         │                     │
│                  │                                 │                     │
│   ┌──────────────┴─────────────┬───────────────────┴───────────┐        │
│   │                            │                                │        │
│   ▼                            ▼                                ▼        │
│  Browser                 Mac Mini Relay               Xbox D-pad        │
│  (Web UI)               (Home Network)             (Camera PTZ)         │
│   - View video              │                                           │
│   - PTZ buttons             │ WebSocket                                 │
│   - Audio playback          ▼                                           │
│   - Mute toggle       ┌─────────────────┐                              │
│                       │  Sricam Camera   │                              │
│                       │  192.168.1.xxx   │                              │
│                       │  - RTSP video    │                              │
│                       │  - ONVIF PTZ     │                              │
│                       │  - Audio (PCM)   │                              │
│                       └─────────────────┘                              │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### How It Works

1. **Video Streaming (MJPEG via WebSocket)**
   - Mac Mini runs FFmpeg to capture RTSP from camera
   - Transcodes to MJPEG frames (640x360 @ 10fps)
   - Sends frames via WebSocket to VPS
   - VPS broadcasts to all connected browsers

2. **Audio Streaming (MP3 via WebSocket)**
   - Separate FFmpeg process captures audio track
   - Converts PCM A-law to MP3 (32kbps, 16kHz mono)
   - Streams via WebSocket with type marker
   - Browser plays via Web Audio API

3. **PTZ Control (ONVIF via HTTP)**
   - Browser PTZ buttons OR Xbox D-pad
   - Commands flow: Browser/ESP32 → VPS → Mac Relay → Camera
   - Mac Relay sends ONVIF SOAP requests to camera
   - Supports: pan, tilt, zoom, presets

### Control Methods

| Input | Control |
|-------|---------|
| **Web UI PTZ buttons** | Click/tap arrow buttons on camera feed |
| **Xbox D-pad** | Press D-pad while playing - Up/Down/Left/Right |
| **Speaker button** | Toggle camera audio on/off (green=on, red=muted) |

### Files

| File | Purpose |
|------|---------|
| `mac-camera-relay/relay.js` | Main relay - video + audio + PTZ |
| `mac-camera-relay/config.json` | Camera credentials (gitignored) |
| `mac-camera-relay/config.example.json` | Template for config |
| `vps-server/server.js` | Routes video/audio/PTZ between clients |
| `vps-server/public/index.html` | Web UI with camera feed |

### Mac Mini Setup

The relay runs as a launchd service for auto-start:

```bash
# Install dependencies
cd mac-camera-relay
npm install

# Create config from template
cp config.example.json config.json
# Edit config.json with your camera IP and credentials

# Load as service (auto-starts on boot)
launchctl load ~/Library/LaunchAgents/com.robot.camera-relay.plist

# Check logs
tail -f /tmp/camera-relay.log
```

### Future Camera Features

- [ ] Multiple camera support (CAM 2 slot ready)
- [ ] Recording/snapshots
- [ ] Motion detection alerts
- [ ] Two-way audio (speak through camera)
- [ ] Night vision toggle

---

## ⚡ Wireless Programming System

**Write code in your browser, compile on the VPS, flash Teensy wirelessly - NO USB REQUIRED!**

### Complete Over-The-Air Development Pipeline

```
┌────────────────────────────────────────────────────────────────┐
│                   WIRELESS COMPILATION FLOW                     │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. 💻 Browser Code Editor                                     │
│      └─► Write/Edit Teensy code with syntax highlighting       │
│           │                                                     │
│           │ HTTP POST (code as JSON)                           │
│           ▼                                                     │
│  2. 🖥️  VPS Server (Node.js)                                   │
│      ├─► Receives code via WebSocket                           │
│      ├─► Writes to temp file: /opt/robot-server/temp-sketch/   │
│      ├─► Compiles with Arduino CLI:                            │
│      │    arduino-cli compile --fqbn teensy:avr:teensy41       │
│      ├─► Reads output: build/sketch.ino.hex                    │
│      └─► Chunks hex into 1KB pieces (50ms delay)               │
│           │                                                     │
│           │ WebSocket (flash_start, flash_chunk x N, complete) │
│           ▼                                                     │
│  3. 📡 ESP32 Robot Controller                                  │
│      ├─► Buffers all hex chunks in RAM                         │
│      ├─► Verifies complete reception                           │
│      └─► Forwards to Teensy in 128-byte chunks                 │
│           │                                                     │
│           │ Serial (GPIO16/17, 115200 baud)                    │
│           ▼                                                     │
│  4. 🎛️  Teensy 4.1 (FlasherX Bootloader)                       │
│      ├─► Receives hex via serial protocol                      │
│      ├─► Flashes own firmware in-place                         │
│      └─► Reboots with new code                                 │
│           │                                                     │
│           ▼                                                     │
│  5. ✅ New code running!                                        │
│                                                                 │
└────────────────────────────────────────────────────────────────┘
```

### Why This Is Awesome

- **No Physical Access Needed** - Update robot code from anywhere in the world
- **Fast Iteration** - Write, compile, test in under 30 seconds
- **Multi-Network** - ESP32 auto-connects to home/work/phone hotspot
- **Chunked Transmission** - Reliable delivery even on weak WiFi
- **Error Handling** - Compilation errors shown in browser immediately
- **Real-Time Feedback** - Watch serial output while code compiles

### Technical Implementation

**VPS Backend (`web-dashboard/server.js`):**
```javascript
function handleCompile(target, code, clientWs) {
  // Write code to temp file
  fs.writeFileSync('/opt/robot-server/temp-sketch/sketch.ino', code);

  // Compile with Arduino CLI
  exec('arduino-cli compile --fqbn teensy:avr:teensy41 ...', (err, stdout) => {
    // Read compiled .hex file
    const hexData = fs.readFileSync('build/sketch.ino.hex', 'utf8');

    // Send in 1KB chunks to ESP32
    const CHUNK_SIZE = 1024;
    robotSocket.send({ type: 'flash_start', totalChunks: N });
    // ... send flash_chunk messages with 50ms delay
    robotSocket.send({ type: 'flash_complete' });
  });
}
```

**ESP32 Controller (`esp32-robot-controller/src/main.cpp`):**
```cpp
void handleFlashMessage(uint8_t * payload, size_t length) {
  if (flash_start) {
    hexBuffer = "";
    teensySerial.println("FLASH_MODE");
  }

  if (flash_chunk) {
    hexBuffer += chunk;
  }

  if (flash_complete) {
    // Forward buffered hex to Teensy via FlasherX
    for (int i = 0; i < hexBuffer.length(); i += 128) {
      teensySerial.print(chunk);
      delay(10);
    }
    teensySerial.println("END_FLASH");
  }
}
```

### One-Time Setup Required

1. **Upload FlasherX bootloader to Teensy** (via USB, once)
   - Use Teensyduino IDE
   - Flash FlasherX example
   - Teensy can now receive firmware via serial

2. **Upload ESP32 controller code** (via USB, once)
   ```bash
   cd esp32-robot-controller
   platformio run --target upload
   ```

3. **Configure Arduino CLI on VPS** (already done)
   ```bash
   arduino-cli core install teensy:avr
   arduino-cli lib install FlasherX
   ```

### After Setup: 100% Wireless Forever

- Edit code in browser
- Click "Compile & Upload"
- Watch progress in serial monitor
- New code running in ~30 seconds
- **Never touch USB cable again!**

### Features

- ✅ **Chunked Transmission** - Reliable 1KB chunks with 50ms delay
- ✅ **WiFiMulti** - Auto-connects to 3 different networks
- ✅ **Error Reporting** - Compilation errors shown in browser
- ✅ **Serial Monitoring** - Watch Teensy boot with new code
- ✅ **Cleanup** - Temp files deleted after flash
- ✅ **Status Updates** - Real-time progress (compiling... sending... done!)

### Supported Targets

- ✅ **Teensy 4.1** - Full wireless flashing via FlasherX
- 🔜 **ESP32** - OTA updates (standard ESP32 OTA)
- 🔜 **Motor Drivers** - Parameter updates via Modbus

---

## 🎯 The Vision

**The Problem:** Backyard predators attacking my chickens. Manual homestead labor. Kids want robot rides.

**The Solution:** Build a dual-armed autonomous robot that can:

### Primary Mission: Chicken Protection
- 🐔 **Patrol property** using computer vision to detect predators
- 👁️ **601-class object detection** via [RealTime AI Cam](https://github.com/nicedreamzapp/RealTimeAICam)
- 🔊 **Scare off predators** through motion and sound
- ⏰ **Automated feeding** at scheduled times

### Dual-Arm Manipulation (OpenArm 0.1 Integration Planned)
Using two robotic arms for human-like bilateral manipulation:
- 🥣 **Feed chickens** by scooping from containers
- 📦 **Pack boxes** for shipping
- 🧺 **Carry laundry** from dryer to basket
- 🍽️ **Handle dishware** and containers
- 🏗️ **Grab parts** from stockroom shelves
- 🪵 **Load/unload** materials autonomously

### Family Fun
- 🚂 **Train engine body** (cardboard/3D printed) for kids to ride in cars behind it
- 🏴‍☠️ **Swappable bodies** - pirate ship, fire truck, space shuttle
- 🐠 **Fish-controlled mode** (aquarium on top, fish steers via camera tracking)

---

## 📊 Current Status

**Weight:** 65 lbs (can handle 80+ lbs more with reinforcement)
**Build Time:** 6 months from zero robotics knowledge
**Status:** Remote control from anywhere ✅ | Wireless programming ready ✅ | Adding autonomy next 🚧

### What's Working Now (Built From Scratch)

| Feature | Status | Description |
|---------|--------|-------------|
| **Tank Drive Platform** | ✅ Complete | 4WD hub motors, 65 lbs, pulls loaded carts |
| **Xbox Controller** | ✅ Complete | Bluetooth via ESP32, exponential curves, perfect feel |
| **Web Command Center** | ✅ Complete | Control from anywhere, glassmorphism UI |
| **Dual PTZ Cameras** | ✅ Complete | Robot-mounted, RTSP streaming, ONVIF pan/tilt |
| **D-pad Camera Control** | ✅ Complete | Xbox D-pad moves cameras while driving |
| **Audio Streaming** | ✅ Complete | Hear surroundings through browser |
| **Wireless Programming** | ✅ Complete | Flash Teensy from browser, no USB needed |
| **Multi-Network Support** | ✅ Complete | Auto-connects: home, work, phone hotspot |
| **Safety Auto-Stop** | ✅ Complete | Stops if communication lost mid-command |
| **Real-Time Telemetry** | ✅ Complete | Motor RPM, WiFi signal, debug output |
| **Driver Telemetry** | ✅ Complete | Live battery voltage, motor/driver temps (°F), RPM, torque |

### Network Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        MULTI-NETWORK OPERATION                           │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  AT HOME:                                                                │
│  [Robot] ──WiFi──▶ [Router] ──ethernet──▶ [Mac Mini] ──▶ [VPS]         │
│     │                  │                     │                          │
│     │              (192.168.x.x)        (camera relay)                  │
│     │                                        │                          │
│     └───── Cameras work ◀────────────────────┘                          │
│                                                                          │
│  AT WORK / PHONE HOTSPOT:                                               │
│  [Robot] ──WiFi──▶ [Any Network] ──internet──▶ [VPS] ──▶ [Browser]     │
│     │                                                                    │
│     └───── Motor control works, no camera (cameras at home)             │
│                                                                          │
│  FUTURE (with Jetson on robot):                                         │
│  [Robot+Jetson] ──WiFi──▶ [Any Network] ──▶ [VPS] ──▶ [Browser]        │
│     │                                                                    │
│     └───── EVERYTHING works from ANYWHERE                               │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### WiFi Range Considerations

| Setup | Range | Notes |
|-------|-------|-------|
| **Standard router** | ~100-200ft outdoor | Current setup |
| **+ Outdoor AP** | ~500-1000ft | Recommended for 1-acre coverage |
| **+ High-gain antenna on ESP32** | +50% range | $12 upgrade |
| **+ Mesh system** | Full property | Multiple access points |

**1 acre = 208ft × 208ft** - Outdoor AP recommended for full coverage.

### Phase Completion
- ✅ **Phase 1:** Tank chassis with 4WD hub motors
- ✅ **Phase 2:** Xbox controller → ESP32 → Teensy → Motors
- ✅ **Phase 3:** RS-485 Modbus communication working
- ✅ **Phase 4:** Successfully pulled loaded cart
- ✅ **Phase 5:** Synchronized motor control (atomic Modbus writes)
- ✅ **Phase 6:** Turn mode with reduced speed/acceleration for smooth steering
- ✅ **Phase 6.5:** Web Command Center - monitor and control from ANYWHERE
- ✅ **Phase 6.6:** Wireless programming infrastructure (VPS compilation ready)
- ✅ **Phase 6.7:** Remote PTZ camera with live video + audio streaming
- ✅ **Phase 6.8:** Xbox D-pad controls camera pan/tilt
- ✅ **Phase 6.9:** Dual control system - Xbox joystick + Command Center buttons work simultaneously
- ✅ **Phase 6.10:** Safety auto-stop on disconnect (V3.5 firmware)
- ✅ **Phase 6.11:** Driver telemetry - live battery V, motor/driver temps, RPM, torque via Modbus reads
- 🚧 **Phase 7:** Autonomous predator patrol (Jetson + Lidar + YOLO)
- 🔜 **Phase 8:** Deterrent system (siren, strobes, bear spray)
- 🔜 **Phase 9:** OpenArm integration (future)

---

## 🔧 Hardware

### Mobile Platform (Complete)

| Component | Specs | Purpose |
|-----------|-------|---------|
| **4x Hub Motors** | ZLLG80ASM250, 9 lbs each | Tank drive (2 per side, encoded) |
| **2x Motor Drivers** | ZLAC8015D Dual-Channel | Each controls one side via Modbus |
| **Teensy 4.1** | 600MHz ARM Cortex-M7 | Main controller & Modbus master |
| **ESP32** | Bluetooth 5.0 + WiFi | Xbox controller + web interface |
| **RS-485 Module** | MAX3485 | Modbus RTU communication |
| **2x 30Ah 12V LiFePO4** | Series = 24V, 720Wh total | Motor power (low CoG mounting) |
| **Buck Converter** | 25W Waterproof Vehicle 24V→5V 5A | Logic power (automotive grade) |
| **Xbox Controller** | Bluetooth 5.0 | Wireless control |
| **2x Sricam PTZ Cameras** | 1080p, RTSP, ONVIF | Robot-mounted dual view with pan/tilt |
| **2020 Extrusion** | Aluminum | Chassis frame |
| **Aluminum Plates** | Various | Mounting & structure |
| **4x Shocks** | Electric scooter | Suspension for terrain |
| **Breakers** | 2x 40A (drivers), 1x 50A (battery bar) | Overcurrent protection |
| **VPS Server** | Ubuntu 24.04 | Remote monitoring backend |
| **Mac Mini M4 Pro** | 64GB RAM | Camera relay + future YOLO processing |

### Battery Performance (Real-World Tested)

The 720Wh LiFePO4 pack provides exceptional runtime:

| Mode | Power Draw | Runtime |
|------|------------|---------|
| **Idle** (electronics only) | ~5W | ~6 days |
| **With cameras streaming** | ~15W | ~2-3 days |
| **Light patrol** (occasional movement) | ~20W avg | ~36 hours |
| **Active driving** | ~400W | ~2 hours continuous |

*Tested: Robot ran for 1 week with motor testing + 2 days continuous camera streaming with battery to spare.*

### Phase 7: Autonomous Predator Patrol (In Progress)

**All-Weather Sensor Redundancy:**
| Sensor | Good Weather | Rain/Fog | Purpose |
|--------|--------------|----------|---------|
| RPLidar A1 | ✅ Mapping | ❌ Docked | Precise SLAM navigation |
| GPS | ✅ Position | ✅ Position | Absolute location on property |
| Ultrasonics x4 | ✅ Obstacles | ✅ Obstacles | Backup obstacle avoidance |
| IR Camera | ✅ Detection | ✅ Detection | Predator identification |

**Hardware:**
| Component | Specs | Purpose |
|-----------|-------|---------|
| **Jetson Orin Nano Super** | 8GB, 67 TOPS | AI brain - runs YOLO + navigation offline |
| **NVMe SSD** | 256GB KingSpec | Fast storage for Jetson |
| **5V 5A Buck Converter** | Waterproof automotive | Jetson power from 24V battery |
| **RPLidar A1** | 360°, 12m range | Mapping & obstacle avoidance (fair weather) |
| **GPS Module** | u-blox NEO-M8N | Waypoint navigation (all weather) |
| **Ultrasonics x4** | JSN-SR04T, IP67 | Obstacle avoidance (all weather backup) |
| **IR Night Camera** | Arducam 1080p | Predator detection day/night |
| **Industrial PIR Sensor** | 100-200ft range, 12V | Wake system during patrol breaks |
| **Siren/Speaker** | 120dB marine horn | Scare deterrent |
| **Strobe Lights** | 12V LED bar | Visual deterrent |
| **Bear Spray Mount** | Servo-triggered | Last resort deterrent |

---

## 🧠 Jetson Orin Nano: The Robot's Brain

The **Jetson Orin Nano Super** (67 TOPS) is the cornerstone of future autonomy. Here's why it's essential:

### Why Jetson Over Alternatives

| Feature | Raspberry Pi 5 | Jetson Orin Nano | Mac Mini (Remote) |
|---------|----------------|------------------|-------------------|
| **Price** | ~$80 | ~$250 | Already have |
| **AI Performance** | ~5 FPS YOLO | ~30 FPS YOLO | ~15 FPS YOLO |
| **Latency to Motors** | ~10ms | ~10ms | ~300-500ms (via internet) |
| **ROS2 + MoveIt** | Struggles | Smooth | N/A |
| **Power Draw** | ~5W | ~15W | N/A (at home) |
| **Portable** | Yes | Yes | No |

**For real-time autonomous reactions, Jetson on the robot is required.** The Mac is perfect for development and remote monitoring, but can't match on-board processing for time-critical decisions.

### Jetson Capabilities

```
┌─────────────────────────────────────────────────────────────────┐
│                    JETSON ORIN NANO SUPER                        │
│                      (Robot's AI Brain)                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  INPUTS:                        PROCESSING:                      │
│  ├─ 2x Sricam PTZ (RTSP)       ├─ YOLOv8 Object Detection       │
│  ├─ RPLidar A1 (SLAM)          ├─ ROS2 Navigation Stack         │
│  ├─ GPS (positioning)          ├─ MoveIt2 (arm planning)        │
│  ├─ Ultrasonics x4             ├─ Behavior Trees                │
│  └─ PIR (wake trigger)         └─ Camera Relay to VPS           │
│                                                                  │
│  OUTPUTS:                                                        │
│  ├─ Serial → Teensy (motor commands)                            │
│  ├─ USB → OpenArm servos (arm control)                          │
│  ├─ GPIO → Siren/Strobe (deterrents)                            │
│  └─ WebSocket → VPS (telemetry + video)                         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Latency Comparison

| Detection Path | Total Latency | Use Case |
|----------------|---------------|----------|
| **Jetson on robot** | ~60ms | Autonomous reactions (predator deterrent) |
| **Mac via LAN** | ~100ms | Local development/testing |
| **Mac via VPS** | ~300-500ms | Remote monitoring (non-critical) |

### Jetson + Mac Hybrid Architecture

The optimal setup uses **both**:

```
DEVELOPMENT MODE (at home):
[Cameras] → [Mac Mini] → YOLO → Display detections
                ↓
           Tune models, test algorithms

DEPLOYMENT MODE (in field):
[Cameras] → [Jetson on robot] → YOLO → Instant reaction
                    ↓
              [VPS] → Remote monitoring
```

---

## 🦾 OpenArm 0.1: Dual-Arm Manipulation

### What is OpenArm?

[OpenArm 0.1](https://youtu.be/IlcA7l_imOk) is an open-source robotic arm designed for hobbyist robotics. Two arms on this platform enable **bilateral manipulation** - coordinated two-handed tasks like a human.

### Why Jetson is Required for OpenArm

| Task | Compute Need | Why |
|------|--------------|-----|
| **Inverse Kinematics** | Real-time math | Calculate joint angles from target position |
| **MoveIt2 Planning** | Path computation | Collision-free arm trajectories |
| **Visual Servoing** | Camera + AI | Adjust grip based on what camera sees |
| **Coordinated Motion** | Dual-arm sync | Both arms move together smoothly |

Raspberry Pi **cannot** run MoveIt2 smoothly. Jetson handles it with ease.

### Full Robot Architecture with Arms

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         COMPLETE ROBOT SYSTEM                             │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│                        ┌─────────────────────┐                           │
│                        │  JETSON ORIN NANO   │                           │
│                        │   (AI + Planning)   │                           │
│                        └──────────┬──────────┘                           │
│                                   │                                       │
│         ┌─────────────────────────┼─────────────────────────┐            │
│         │                         │                         │            │
│         ▼                         ▼                         ▼            │
│  ┌─────────────┐          ┌─────────────┐          ┌─────────────┐      │
│  │ LEFT ARM    │          │  TEENSY 4.1 │          │ RIGHT ARM   │      │
│  │ OpenArm 0.1 │          │   (Motors)  │          │ OpenArm 0.1 │      │
│  │ 6 servos    │          └──────┬──────┘          │ 6 servos    │      │
│  └─────────────┘                 │                 └─────────────┘      │
│                                  │                                       │
│                           ┌──────┴──────┐                                │
│                           │ ZLAC8015D   │                                │
│                           │  Drivers    │                                │
│                           └──────┬──────┘                                │
│                                  │                                       │
│                    ┌─────────────┼─────────────┐                        │
│                    ▼             ▼             ▼                        │
│               [Motor FL]   [Motor FR]   [Motor RL]   [Motor RR]         │
│                                                                           │
│  SENSORS:              DETERRENTS:           CAMERAS:                    │
│  ├─ RPLidar A1         ├─ 120dB Siren        ├─ Sricam PTZ #1           │
│  ├─ GPS NEO-M8N        ├─ Strobe Lights      └─ Sricam PTZ #2           │
│  ├─ Ultrasonics x4     └─ Bear Spray Mount                              │
│  └─ Industrial PIR                                                       │
│                                                                           │
└──────────────────────────────────────────────────────────────────────────┘
```

### OpenArm Task Examples

**Chicken Feeding (Bilateral):**
```
1. Navigate to feed container (Jetson + GPS/LiDAR)
2. Left arm: grip container lid, lift
3. Right arm: reach in with scoop, grab feed
4. Left arm: stabilize container
5. Right arm: transfer feed to dispenser
6. Both arms: return to rest position
7. Navigate to next station, repeat
```

**Predator Deterrent (Enhanced):**
```
1. YOLO detects: "coyote" (confidence 0.87)
2. Jetson triggers: siren ON, strobe ON
3. Motors: advance 0.5m toward threat
4. BOTH ARMS: raise up and wave (appear larger)
5. Continue until threat retreats
6. Log encounter, resume patrol
```

### OpenArm Hardware Requirements

| Component | Specs | Purpose |
|-----------|-------|---------|
| **2x OpenArm 0.1 kits** | 6-DOF each | Bilateral manipulation |
| **12x Servo motors** | High-torque (per OpenArm BOM) | Joint actuation |
| **2x USB-Serial adapters** | FTDI or similar | Jetson → Arm communication |
| **Mounting brackets** | Custom 3D printed | Attach arms to chassis |
| **Additional buck converter** | 5V 10A+ | Power servos from 24V battery |

---

## 🔮 Future Possibilities

### Near-Term (With Current Hardware + Jetson)

| Capability | Description | Dependencies |
|------------|-------------|--------------|
| **Predator Detection** | YOLOv8 identifies coyotes, foxes, raccoons | Jetson + cameras |
| **Autonomous Patrol** | Follow waypoints, return to charge station | Jetson + GPS + LiDAR |
| **Remote Video Anywhere** | Stream from robot on any network | Jetson as relay |
| **Deterrent Automation** | Auto-trigger siren/strobe on detection | Jetson GPIO |
| **Path Memory** | Learn common routes, avoid obstacles | ROS2 SLAM |

### Mid-Term (With OpenArm Added)

| Capability | Description | Dependencies |
|------------|-------------|--------------|
| **Chicken Feeding** | Scoop and distribute feed | Dual arms + vision |
| **Object Retrieval** | Pick up items, bring to location | MoveIt2 + YOLO |
| **Door/Gate Operation** | Open latches, push doors | Force feedback |
| **Simple Assembly** | Hold + fasten operations | Coordinated motion |
| **Gesture Deterrent** | Wave arms to scare predators | Arm kinematics |

### Long-Term (Full Autonomy)

| Capability | Description | Dependencies |
|------------|-------------|--------------|
| **Multi-Robot Coordination** | Fleet of robots share patrol duties | ROS2 networking |
| **Voice Commands** | "Robot, feed the chickens" | Speech recognition |
| **Learning from Demo** | Show task once, robot repeats | Imitation learning |
| **Tool Use** | Pick up and use tools (rake, hose) | Advanced manipulation |
| **Human Following** | Follow person, carry items | Person tracking |

### Fun/Experimental

| Idea | Description | Difficulty |
|------|-------------|------------|
| **Fish-Controlled Mode** | Aquarium on top, fish position = steering | Medium |
| **Train for Kids** | Pull wagon with passengers | Easy |
| **Pirate Ship Body** | Cardboard hull, working "cannons" (confetti) | Easy |
| **DJ Robot** | Speakers + lights for parties | Easy |
| **Security Guard** | Patrol + announce visitors | Medium |

---

## 💻 Software Architecture

### Current Stack (Platform Control + Web Interface)
```
┌─────────── LOCAL CONTROL ────────────┐  ┌──── REMOTE MONITORING ────┐
│                                       │  │                            │
│  Xbox Controller (BT 5.0)            │  │   Your Phone/Browser       │
│       ↓                               │  │           │                │
│  ESP32 (Bluepad32 + WiFi + OTA)      │  │           │                │
│       ↓ Serial (115200 baud)         │  │           ▼                │
│  Teensy 4.1                           │  │  VPS WebSocket Server      │
│       ↓ RS-485 (Modbus RTU)          │  │   (Node.js + Nginx)        │
│  MAX3485 Module                       │  │           │                │
│       ↓ Twisted Pair A/B             │  │           │                │
│  ┌──────────────────┬──────────────┐ │  │           │                │
│  ZLAC8015D (ID=1)   ZLAC8015D (ID=2) │  │           │                │
│  ├─ Motor 1 (FL)    ├─ Motor 1 (FR) │  │           │                │
│  └─ Motor 2 (RL)    └─ Motor 2 (RR) │  │           │                │
│                                       │  │           │                │
└───────────────────────────────────────┘  └───────────┴────────────────┘
                                                       │
                                           ┌───────────┴───────────┐
                                           │                        │
                                       WebSocket              WebSocket
                                        (Serial Data)         (Commands)
                                           │                        │
                                           └────────────┬───────────┘
                                                        │
                                                   ESP32 WiFi
```

### Autonomous Patrol Stack (Phase 7)
```
Industrial PIR Sensor (100-200ft)
    ↓ Wake Signal
Jetson Orin Nano (67 TOPS)
    ├─ RPLidar A1 (fair weather SLAM)
    ├─ GPS Module (all-weather position)
    ├─ Ultrasonics x4 (all-weather obstacles)  
    ├─ IR Camera (YOLOv8 predator detection)
    ├─ Navigation Planning (ROS2)
    ├─ Object Detection (YOLO)
    └─ Behavior Trees (task execution)
    ↓ Serial Commands
Teensy 4.1 (motion control)
    ↓ Modbus
Motor Drivers + Deterrent Systems
```

### Planned High-Level Stack
```
Python/ROS2 (Jetson)
    ├─ Task Scheduler
    ├─ Path Planning  
    ├─ Object Detection (RealTime AI Cam)
    └─ OpenArm Control
    ↓ Serial Commands
Teensy 4.1 (Real-time Control)
    ├─ Motor Control (Modbus)
    ├─ Sensor Fusion
    └─ Safety Override
```

---

## 🎨 Design Philosophy

### "Gaming Desktop" Aesthetic
**Current:** Functional prototype with exposed wiring  
**Goal:** Clean cable management with:
- Cable sleeves matching chassis color
- RGB LED accent lighting
- Transparent panels to show internals
- Custom 3D-printed cable guides
- Professional wire routing

### Modular Bodies
Swappable top structures for different modes:
- 🚂 **Train Engine** - For pulling kids in cars
- 🏴‍☠️ **Pirate Ship** - Cardboard sails and cannons
- 🐠 **Fish Tank** - Let fish control movement via tracking
- 🚜 **Utility Bed** - Open platform for cargo
- 🤖 **Humanoid Torso** - With dual arms exposed

---

## 📝 Code Examples

### Tank Drive with Acceleration Ramping
```cpp
void calculateTankSpeeds(int16_t lx, int16_t ly, int16_t& left_out, int16_t& right_out) {
  // Deadzone handling
  if (abs(lx) < 20) lx = 0;
  if (abs(ly) < 20) ly = 0;
  
  // Scale to motor range (-3000 to +3000 RPM)
  float forward = (float)ly / 511.0 * MAX_SPEED;
  float turn = (float)lx / 511.0 * MAX_SPEED;
  
  // Tank drive mixing
  float left_f = forward + turn;
  float right_f = forward - turn;
  
  // Smooth acceleration ramping
  left_f = rampSpeed(prevLeft, left_f, ACCEL_RATE);
  right_f = rampSpeed(prevRight, right_f, ACCEL_RATE);
  
  // Constrain and output
  left_out = constrain((int16_t)left_f, -MAX_SPEED, MAX_SPEED);
  right_out = constrain((int16_t)right_f, -MAX_SPEED, MAX_SPEED);
}
```

### Modbus Command Structure
```cpp
void setDriverSpeed(uint8_t driver_id, int16_t rpm) {
  uint8_t frame[8];
  frame[0] = driver_id;          // 1=left, 2=right
  frame[1] = 0x06;               // Write Single Register
  frame[2] = 0x20;               // Register hi byte
  frame[3] = (driver_id == 1) ? 0x88 : 0x89;
  frame[4] = (rpm >> 8);         // Speed hi byte
  frame[5] = (rpm & 0xFF);       // Speed lo byte
  
  uint16_t crc = crc16(frame, 6);
  frame[6] = (crc & 0xFF);       // CRC lo
  frame[7] = (crc >> 8);         // CRC hi
  
  Serial2.write(frame, 8);
}
```

### ESP32 WebSocket Connection
```cpp
// Connect to VPS WebSocket server
WebSocketsClient webSocket;
webSocket.begin("your-robot-domain.com", 80, "/");

// Forward Teensy serial data to web interface
void loop() {
  webSocket.loop();

  if (Serial.available()) {
    String data = Serial.readStringUntil('\n');
    webSocket.sendTXT(data);
  }
}
```

---

## 🚧 Technical Challenges & Solutions (Hard-Won Lessons)

### Challenge 1: Tank Steering & Motor Symmetry ✅
**The Hardest Part of the Entire Build**

**Problem:** Getting all 4 wheels to spin correctly in symmetry - same axis, same direction, coordinated movement.

**What Made It Hard:**
- Left/right sides spinning opposite when given same Modbus command
- Driver CCW/CW parameters differed between ZLAC8015D units
- Each driver controls 2 motors - had to get both sides synchronized
- Modbus timing issues caused jerky, uncoordinated movement

**Solution:**
- Driver-specific direction inversion in Teensy code
- Atomic Modbus writes to both drivers (no delay between commands)
- Careful wiring: all grounds tied together properly
- Extensive testing to map which motor = which wheel

**Lesson:** Tank steering looks simple but coordinating 4 motors via 2 Modbus drivers is genuinely difficult. Expect this to take time.

### Challenge 2: Power Stability - The $200+ Mistake ✅
**Problem:** Hobby-grade DROK buck converters destroyed components repeatedly

**The Damage:**
- 🔥 **4x Teensy 4.1 boards** - fried by voltage spikes ($120)
- 🔥 **Multiple ESP32 boards** - killed in other projects
- 🔥 **3-4 DROK buck converters** - failed under load
- Inconsistent voltage output, no protection, inadequate filtering

**Root Cause:** DROK and similar hobby-grade converters:
- Poor voltage regulation under load changes
- No transient suppression
- Inadequate current handling despite ratings
- Zero protection circuitry

**Solution - Go Automotive/Marine Grade:**
- Switched to **25W waterproof automotive-grade vehicle buck converter** (24V→5V 5A)
- Designed for harsh vehicle environments (vibration, temperature, load spikes)
- Built-in protection and filtering
- **Zero component failures since switching**

**Lesson:** Never use hobby electronics for power regulation on expensive microcontrollers. The $20 "savings" on a cheap buck converter cost $200+ in destroyed components. Automotive/marine grade converters are worth every penny.

### Challenge 3: Wiring & Ground Management ✅
**Problem:** Intermittent behavior, random resets, communication failures

**What Went Wrong:**
- Ground loops between components
- Floating grounds on RS-485 bus
- Poor connections causing voltage drops

**Solution:**
- **All grounds tied together** at a central point
- Star grounding topology from battery negative
- Quality crimped connections, no breadboard jumpers
- Twisted pair for RS-485 (A/B lines)

**Lesson:** Most "weird behavior" in robotics is a grounding or wiring problem. Invest time in proper wire management before debugging code.

### Challenge 4: Tip-Over Risk 🚧
**Problem:** Adding arms on top raises center of gravity
**Solution:**
- Batteries mounted at lowest point, evenly distributed
- Each 9 lb wheel provides low CoG
- Total 65 lbs well-balanced
- Can add 80+ lbs more if needed with reinforcement

### Challenge 5: Remote Monitoring ✅
**Problem:** No way to debug robot when not physically present
**Solution:**
- Built VPS WebSocket server for real-time serial monitoring
- ESP32 auto-connects to multiple WiFi networks
- OTA updates eliminate need for USB cable access
- Web interface accessible from anywhere with internet

### Challenge 6: Encoder Integration 🔜
**Status:** Each hub motor has encoders but not yet utilized
**Plan:** Implement closed-loop PID speed control using encoder feedback

### Damage Report (So You Don't Repeat My Mistakes)

| Component | Quantity Destroyed | Cause | Cost |
|-----------|-------------------|-------|------|
| Teensy 4.1 | 4 | DROK voltage spikes | ~$120 |
| ESP32 | 3+ | DROK voltage spikes | ~$30 |
| DROK Buck Converters | 3-4 | Failed under load | ~$40 |
| **Total** | - | Hobby-grade power electronics | **~$190** |

**Components destroyed since switching to automotive-grade: ZERO**

---

## 🎓 What I Learned (6 Months from Zero)

### Month 1-2: Basic Electronics
- Power distribution and voltage regulation
- Breaker selection for overcurrent protection
- Why automotive-grade components matter (learned after blowing 4 Teensys with hobby parts)

### Month 3-4: Communication Protocols
- Serial UART between microcontrollers
- RS-485 physical layer
- Modbus RTU protocol implementation
- CRC16 checksum calculations

### Month 5: Motor Control Theory
- Tank drive kinematics
- Acceleration ramping for smoothness
- Deadzone handling
- PID concepts (still learning!)

### Month 6: Real-World Testing & Web Integration
- Weight distribution matters
- Cable management is critical
- Testing reveals what theory misses
- Iterative improvement beats perfection
- **Remote debugging saves hours of frustration**
- **WebSocket architecture for IoT robotics**
- **PM2 process management for always-on servers**

---

## 🌟 Community Feedback

From r/robotics discussion:

> *"Very impressive! Epic vision for dual-arm homestead automation!"*

> *"With cardboard, anything is possible for swappable bodies. Do a pirate ship!"* 

> *"I'd like to see an aquarium in that box and let a fish control the bot 🐠"* - Challenge accepted!

**Community Concerns Addressed:**
- ✅ Top-heavy risk: Batteries at lowest point, 65 lbs well-balanced
- ✅ Center of gravity: Can handle 80+ lbs more with reinforcement
- ✅ Modbus requirement: ZLAC drivers don't support simpler protocols
- ✅ Tipping during acceleration: Suspension + weight distribution mitigates

---

## 📚 Resources

### This Project
- [Teensy Code](teensy-robot/) - Motor control firmware (PlatformIO)
- [ESP32 Code](esp32-robot-controller/arduino_full/) - Bluepad32 + WiFi + WebSocket (Arduino IDE)
- [VPS Server](vps-server/) - Node.js WebSocket server + Command Center UI
- [ZLAC Documentation](ZLAC8015D-V2.0/) - Driver manuals and wiring guides
- [Wiring Diagrams](docs/wiring/) - Coming soon

### Related Projects
- [RealTime AI Cam](https://github.com/nicedreamzapp/RealTimeAICam) - 601-class object detection
- [Parkinson's ML Predictor](https://github.com/nicedreamzapp/parkinsons-vulnerability-predictor) - Medical AI
- [CogVideoX Mac Guide](https://github.com/nicedreamzapp/CogVideoX-Mac-Setup) - Local AI video

### Reference Material
- [OpenArm 0.1](https://youtu.be/IlcA7l_imOk) - Open source robot arm
- [Bluepad32](https://github.com/ricardoquesada/bluepad32) - ESP32 gamepad library

---

## 🔮 Roadmap

### Immediate Priority: Autonomous Predator Patrol

**Shopping List (Amazon):**
- [x] Jetson Orin Nano Super Developer Kit ($249)
- [x] KingSpec 256GB NVMe SSD ($29.99)
- [x] 5V 5A Waterproof Buck Converter ($11.99)
- [x] Slamtec RPLidar A1M8 ($99)
- [x] Arducam 1080P IR Night Camera ($34.99)
- [x] VPS Server (~$4/mo any provider)
- [ ] u-blox NEO-M8N GPS Module (~$15-20)
- [ ] JSN-SR04T Waterproof Ultrasonics x4 (~$32)
- [ ] Industrial PIR Sensor (~$25-40)
- [ ] Siren + Strobe deterrents (~$30)

**Installation Tasks:**
- [x] Set up VPS with WebSocket server
- [x] Configure Nginx reverse proxy
- [x] Implement ESP32 WiFi connectivity
- [ ] Install Jetson Orin Nano + power regulation
- [ ] Mount RPLidar A1 with rain cover for obstacle avoidance
- [ ] Add IR night camera for detection
- [ ] Wire GPS module for all-weather positioning
- [ ] Mount ultrasonic sensors x4 for backup obstacle avoidance
- [ ] Wire industrial PIR sensor for wake triggers
- [ ] Install siren + strobe deterrents
- [ ] YOLOv8 predator detection (bear, raccoon, fox)
- [ ] Patrol logic: 15 min posts, weighted zones
- [ ] Sealed plexiglass enclosure with bottom venting

### After Patrol Works
- [ ] Clean wire management with gaming PC aesthetic
- [ ] Fine-tune patrol routes based on testing
- [ ] Add bear spray servo mount (last resort)
- [ ] Build train engine body for kids
- [ ] Add web interface controls (stop, speed adjust, emergency override)

### Long Term
- [ ] OpenArm integration for manipulation tasks
- [ ] Multi-modal swappable bodies
- [ ] Fish-controlled mode (because why not)
- [ ] Mobile app with push notifications for detections

---

## 💡 For Other Builders

**This project is useful for:**
- ZLAC8015D motor driver integration examples
- Teensy + ESP32 communication patterns
- Modbus RTU over RS-485 implementation
- Tank drive control algorithms
- Xbox controller input via Bluepad32
- Power system design for mobile robots
- **WebSocket-based remote robot monitoring**
- **Futuristic glassmorphism web UI design**
- **Virtual joystick for tank drive control**
- **ESP32 WiFi + Bluetooth simultaneous operation**
- **OTA update implementation for embedded systems**

**Lessons learned:**
- Start with platform stability before adding complexity
- Test hardware thoroughly before writing complex software
- Weight distribution matters more than total weight
- Real-world testing reveals issues no simulation can predict
- Cable management isn't optional - plan it from the start
- **Remote debugging capability is worth the VPS cost**
- **Build monitoring early - saves hours of physical debugging**

---

## 🤝 Contributing

This is a personal homestead automation project, but:

- ⭐ **Star** if this helped your build
- 🐛 **Issues** for questions about implementation
- 💬 **Discussions** for sharing your own robot stories
- 🔧 **PRs welcome** for code improvements

---

## 📜 License

MIT License - Use this for your own robot projects!

**Attribution appreciated but not required.**

---

<div align="center">

**Built with ❤️ on a homestead in Humboldt County, California**

*Started with a chicken problem, ended up building an autonomous homestead assistant.*

### 🚂 "If it takes more than 10 minutes, automate it. If kids want robot rides, build a train." 🐔

[Website](https://nicedreamzwholesale.com) • [GitHub](https://github.com/nicedreamzapp) • [Reddit Discussion](https://www.reddit.com/r/robotics/comments/1ov3k5v/)

</div>
