<div align="center">

# Cemani Homestead Robot

### Autonomous Tank Platform for Homestead Automation

![Status](https://img.shields.io/badge/Status-Fully_Operational-green?style=for-the-badge)
![Control](https://img.shields.io/badge/Control-From_Anywhere-blue?style=for-the-badge)
![OTA](https://img.shields.io/badge/Updates-Wireless_OTA-purple?style=for-the-badge)

**Protecting chickens. Automating chores. Giving kids rides.**

</div>

---

## What It Does

A 65 lb tank-drive robot controlled via Xbox controller or web browser from anywhere in the world. Features dual PTZ cameras, real-time telemetry, and wireless firmware updates.

### Demo: Pulling a Firewood Cart

https://github.com/user-attachments/assets/6a05e239-ce66-46ee-b951-474730370bfe

---

## Quick Start

### Drive the Robot
1. Power on robot (main breaker)
2. Connect Xbox controller via Bluetooth
3. Left stick = drive, Right trigger = turbo mode
4. D-pad = control PTZ camera

### Control from Anywhere
Open your web dashboard - joystick, cameras, and telemetry all work remotely.

### Update Code Wirelessly
1. Edit code locally
2. Compile with PlatformIO
3. Upload hex to VPS
4. Click "Flash Pre-built" in web UI
5. Watch progress in serial monitor - done!

---

## System Architecture

```
                    ANYWHERE
                       |
                   [Browser]
                       |
                    [VPS] -------- [Mac Mini]
                       |           (camera relay)
                       |
    [Xbox] -----> [ESP32] -----> [Teensy 4.1] -----> [Motors]
                    WiFi           Modbus RS-485
```

**Components:**
- **Teensy 4.1** - Motor control, Modbus master, telemetry
- **ESP32** - Xbox Bluetooth + WiFi WebSocket bridge
- **ZLAC8015D x2** - Dual-channel motor drivers (4 hub motors total)
- **VPS** - Node.js WebSocket server, remote UI
- **Mac Mini** - Camera relay for PTZ streaming

---

## Features

| Feature | Status |
|---------|--------|
| Tank drive (4WD hub motors) | Complete |
| Xbox controller + turbo mode | Complete |
| Web control from anywhere | Complete |
| Dual PTZ cameras + audio | Complete |
| Wireless OTA updates | Complete |
| Real-time telemetry | Complete |
| Battery monitoring | Complete |
| Safety watchdog | Complete |

---

## Hardware

| Component | Purpose |
|-----------|---------|
| 4x ZLLG80ASM250 Hub Motors | 8" wheels, built-in encoders |
| 2x ZLAC8015D Drivers | Modbus RS-485 control |
| Teensy 4.1 | Main controller |
| ESP32 + Bluepad32 | Xbox + WiFi |
| 2x 12V 30Ah LiFePO4 | 24V 720Wh power |
| 2x Sricam PTZ Cameras | RTSP + ONVIF |

---

## Project Structure

```
teensy-robot/           # Teensy 4.1 firmware (PlatformIO)
  src/
    main.cpp            # Main loop, serial handling
    movement.cpp        # Tank drive, joystick control
    modbus.cpp          # Motor driver communication
    flasher.cpp         # Wireless OTA updates
    telemetry.cpp       # Battery, temps, encoder data
  include/
    config.h            # Speed limits, pins, constants

esp32-robot-controller/ # ESP32 firmware (Arduino)
  arduino_full/
    arduino_full.ino    # Xbox + WiFi + OTA relay

vps-server/             # Remote control server
  server.js             # WebSocket hub
  public/               # Web UI
    index.html
    js/
    css/

mac-camera-relay/       # Camera streaming
  relay.js              # RTSP -> WebSocket
  ptz-relay.js          # ONVIF PTZ control
```

---

## Configuration

### Speed Settings (config.h)
```cpp
#define MAX_SPEED_RPM 75         // Normal driving
#define TURBO_SPEED_RPM 240      // With right trigger (~5.8 mph)
#define MAX_TURN_RPM 30          // Turning speed
```

### Network Setup
ESP32 auto-connects to configured WiFi networks and opens WebSocket to VPS.

---

## Wireless OTA Updates

The killer feature - update Teensy firmware without touching USB:

1. **Edit code** on your Mac
2. **Compile:** `pio run -e teensy41`
3. **Upload hex:** `scp .pio/build/teensy41/firmware.hex your-vps:/path/prebuilt/`
4. **Flash:** Click "Flash Pre-built" in web UI
5. **Watch progress:** Serial monitor shows every 500 lines written
6. **Reboot:** New firmware running in ~90 seconds

---

## Controls

### Xbox Controller
| Input | Action |
|-------|--------|
| Left Stick | Drive (tank steering) |
| Right Trigger | Turbo mode (hold) |
| D-pad | PTZ camera control |
| A Button | Soft reset |
| B Button | Emergency stop |
| Y Button | Toggle active camera |

### Web Interface
- Virtual joystick for driving
- PTZ camera buttons
- Real-time telemetry display
- Serial monitor popup
- Flash firmware button

---

## Safety Features

- **Watchdog Timer** - Motors stop if no commands for 2 seconds
- **E-Stop** - Full shutdown if no data for 5 seconds
- **Speed Limits** - Hard-clamped in firmware
- **Turbo Lock** - Requires holding trigger (no accidental speed)

---

## Development

### Build Teensy Firmware
```bash
cd teensy-robot
pio run -e teensy41
```

### Build ESP32 Firmware
```bash
cd esp32-robot-controller/arduino_full
# Use Arduino IDE with Bluepad32 board package
```

### Run VPS Server
```bash
cd vps-server
npm install
pm2 start server.js --name robot
```

---

## Lessons Learned

**Power:** Don't use hobby buck converters. I fried 4 Teensys before switching to automotive-grade. Worth every penny.

**Wiring:** Most "weird behavior" is grounding. Tie all grounds at one point.

**Tank Steering:** Getting 4 motors synchronized via 2 Modbus drivers is harder than it sounds. Expect iteration.

**Remote Debugging:** Build monitoring early. The VPS cost pays for itself in saved debugging time.

---

## Future Plans

- [ ] Jetson Orin Nano for AI/autonomy
- [ ] YOLO predator detection
- [ ] Autonomous patrol routes
- [ ] OpenArm dual-arm manipulation
- [ ] Train body for kid rides

---

## License

MIT - Use this for your own robot projects!

---

<div align="center">

**Built on a homestead in Northern California**

*Started with a chicken problem. Now building an autonomous farmhand.*

</div>
