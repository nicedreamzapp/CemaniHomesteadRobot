<div align="center">

# 🤖 Cemani Homestead Robot

### Autonomous 4WD Tank Platform for Homestead Automation

![Made with](https://img.shields.io/badge/Made_with-Blood_Sweat_Tears-red?style=for-the-badge)
![Status](https://img.shields.io/badge/Status-Pulling_Firewood-green?style=for-the-badge)
![Power](https://img.shields.io/badge/Power-24V_LiFePO4-orange?style=for-the-badge)

**Built to protect chickens, haul firewood, and automate homestead tasks**

[📹 Demo Video](#demo) • [🔧 Hardware](#hardware) • [💻 Code](#code) • [🚧 Current Status](#current-status)

</div>

---

## 🎥 Demo

### Robot Pulling Firewood Cart

https://github.com/user-attachments/assets/robot-pulling-firewood.mp4

*The robot successfully pulling a metal cart loaded with firewood - proof of concept for autonomous hauling tasks.*

---

## 🎯 The Mission

**The Problem:** Predators attacking my chickens at night. Manual labor for homestead tasks.

**The Solution:** Build an autonomous robot that can:
- 🐔 Patrol the property and detect predators using computer vision
- 🪵 Haul firewood and materials autonomously
- 📦 Transport feed, water, and supplies
- 🚜 Perform repetitive homestead chores

---

## 🔧 Hardware

### Complete Bill of Materials

| Component | Specs | Purpose |
|-----------|-------|---------|
| **4x Hub Motors** | ZLLG80ASM250 Brushless | Tank drive (2 per side) |
| **2x Motor Drivers** | ZLAC8015D Dual-Channel | Each controls one side |
| **Teensy 4.1** | 600MHz ARM Cortex-M7 | Main controller & Modbus master |
| **ESP32** | Bluetooth 5.0 | Xbox controller receiver (Bluepad32) |
| **RS-485 Module** | MAX3485 | Modbus RTU communication |
| **2x 12V LiFePO4** | In series for 24V | Motor power |
| **Buck Converter** | DROK 24V→5V | Logic power with filtering |
| **Xbox Controller** | Bluetooth 5.0 | Wireless control |
| **2020 Extrusion** | Aluminum rails | Chassis frame |
| **Aluminum Plates** | Various sizes | Mounting & structure |
| **4x Shocks** | From electric scooter | Suspension |
| **Fuses & Breakers** | 10A input, 2A output | Overcurrent protection |
| **Capacitors** | 100µF input/output | Power filtering |
| **Terminal Blocks** | Various | Power distribution |
| **DuPont Cables** | Various gauges | Signal connections |

### System Architecture
```
Xbox Controller (BT 5.0)
    ↓
ESP32 (Bluepad32)
    ↓ Serial (115200 baud)
Teensy 4.1
    ↓ RS-485 (Modbus RTU)
MAX3485 Module
    ↓ Twisted Pair A/B
┌──────────────────┬──────────────────┐
ZLAC8015D (ID=1)   ZLAC8015D (ID=2)
├─ Motor 1 (FL)    ├─ Motor 1 (FR)
└─ Motor 2 (RL)    └─ Motor 2 (RR)
```

---

## 💻 Software Stack

### ESP32 (Bluepad32)
- **Framework:** Arduino + Bluepad32 library
- **Purpose:** Xbox controller input via Bluetooth
- **Output:** Serial event stream to Teensy
- **Baud Rate:** 115200

### Teensy 4.1
- **Framework:** Arduino
- **Libraries:** ModbusMaster (for ZLAC drivers)
- **Purpose:** 
  - Parse controller events from ESP32
  - Convert joystick input to tank drive speeds
  - Send Modbus RTU commands to motors
- **Communication:**
  - Serial1 (RX/TX): ESP32 input
  - Serial2 (via MAX3485): RS-485 to drivers

### ZLAC8015D Drivers
- **Protocol:** Modbus RTU over RS-485
- **Baud Rate:** 115200
- **Registers:**
  - `0x2088`: Left motor velocity
  - `0x2089`: Right motor velocity
  - `0x2000`: Control word
- **Speed Range:** -3000 to +3000 RPM

---

## 🚀 Features

### ✅ Currently Working
- Xbox controller wireless connection
- ESP32 → Teensy serial communication
- Modbus RTU communication with both drivers
- Tank-style steering (left joystick)
- Emergency stop (B button)
- Smooth acceleration ramping
- Speed limiting for stability
- Deadzone handling for joystick drift
- Power system with proper filtering

### 🚧 In Progress
- Computer vision for predator detection
- Autonomous waypoint navigation
- Encoder feedback integration
- Path planning and obstacle avoidance
- Dual-arm manipulation (OpenArm integration planned)

### 🔮 Planned
- GPS navigation for property coverage
- LiDAR for 3D mapping
- Camera array for 360° vision
- Automatic chicken feeding
- Box packing automation
- Laundry retrieval
- Dishware handling

---

## 📊 Current Status

### Recent Milestones
- ✅ Successfully pulled loaded cart with firewood
- ✅ Fixed motor direction inversion issues
- ✅ Implemented smooth acceleration curves
- ✅ Stable 24V→5V power delivery
- ✅ Clean event-based controller input (no spam)
- ✅ Reliable Modbus communication

### Active Challenges
1. **Motor Direction Asymmetry**
   - Issue: Left and right sides sometimes spin opposite when given same command
   - Current workaround: Driver-specific inversion in code
   - Root cause: Investigating CCW/CW parameter differences between drivers

2. **Encoder Integration**
   - Each hub motor has built-in encoders
   - Not yet utilized for closed-loop speed control
   - Planned: PID speed control using encoder feedback

3. **Weight Distribution**
   - Cart pulling works but needs suspension tuning
   - Adding adjustable shock preload

---

## 🔨 Build Log

### Phase 1: Power System ✅
- Wired 2x 12V LiFePO4 in series for 24V
- Added DROK buck converter (24V→5V)
- Implemented input/output capacitors (100µF each)
- Added fuse protection (10A input, 2A output)
- **Result:** Stable power, both Teensy and ESP32 running

### Phase 2: Communication ✅  
- ESP32 running Bluepad32 for Xbox controller
- Teensy receiving clean event stream (no spam)
- RS-485 wiring with twisted pair A/B lines
- MAX3485 module properly configured
- **Result:** Full communication chain working

### Phase 3: Motor Control ✅
- Modbus RTU commands reaching both drivers
- Tank drive algorithm implemented
- Acceleration ramping added for smoothness
- Emergency stop functionality
- **Result:** Robot moves and responds to controller

### Phase 4: Real-World Testing 🚧
- Successfully pulled cart loaded with firewood
- Identified motor direction issues
- Testing suspension under load
- Tuning speed curves for different terrains

---

## 📝 Code Examples

### Tank Drive Calculation
```cpp
void calculateTankSpeeds(int16_t lx, int16_t ly, int16_t& left_out, int16_t& right_out) {
  // Apply deadzone
  if (abs(lx) < 20) lx = 0;
  if (abs(ly) < 20) ly = 0;
  
  // Scale to motor range (-3000 to +3000 RPM)
  float forward = (float)ly / 511.0 * MAX_SPEED;
  float turn = (float)lx / 511.0 * MAX_SPEED;
  
  // Tank drive mixing
  float left_f = forward + turn;
  float right_f = forward - turn;
  
  // Constrain and convert
  left_out = constrain((int16_t)left_f, -MAX_SPEED, MAX_SPEED);
  right_out = constrain((int16_t)right_f, -MAX_SPEED, MAX_SPEED);
}
```

### Modbus Command
```cpp
void setDriverSpeed(uint8_t driver_id, int16_t rpm) {
  uint8_t frame[8];
  frame[0] = driver_id;
  frame[1] = 0x06;  // Write Single Register
  frame[2] = 0x20;  // Register 0x2088/0x2089
  frame[3] = (driver_id == 1) ? 0x88 : 0x89;
  frame[4] = (rpm >> 8);
  frame[5] = (rpm & 0xFF);
  
  uint16_t crc = crc16(frame, 6);
  frame[6] = (crc & 0xFF);
  frame[7] = (crc >> 8);
  
  Serial2.write(frame, 8);
}
```

---

## 🐛 Troubleshooting

### Motor Direction Issues
**Problem:** Left and right sides spin opposite when given same command  
**Solutions Tried:**
- Changed CCW/CW settings in ZLAC software
- Inverted speed values in code for specific drivers
- Verified wiring polarity

**Current Status:** Working workaround in code, investigating root cause

### Power Issues (Solved)
**Problem:** Teensy/ESP32 brown-outs during motor acceleration  
**Solution:** Added 100µF capacitors on buck converter input/output

### RS-485 Communication (Solved)
**Problem:** Intermittent Modbus failures  
**Solution:** Proper twisted pair wiring + 120Ω termination resistor

---

## 🤝 Contributing

This is a personal homestead project, but I'm sharing it to help others building similar robots! 

**Useful for:**
- ZLAC8015D motor driver integration
- Teensy + ESP32 communication
- Modbus RTU over RS-485
- Tank drive algorithms
- Xbox controller input via Bluepad32

Found this helpful? ⭐ Star the repo!

---

## 📚 Resources

### Documentation
- [ZLAC8015D Manual](hardware/motor-controllers/ZLAC8015D_manual.pdf)
- [Modbus RTU Specification](docs/modbus-rtu-spec.pdf)
- [Bluepad32 Library](https://github.com/ricardoquesada/bluepad32)

### Related Projects
- [My Parkinson's ML Predictor](https://github.com/nicedreamzapp/parkinsons-vulnerability-predictor)
- [RealTime AI Camera](https://github.com/nicedreamzapp/RealTimeAICam)
- [CogVideoX on Mac Guide](https://github.com/nicedreamzapp/CogVideoX-Mac-Setup)

### Community Discussion
- [Reddit Post: OpenArm Integration Plans](https://www.reddit.com/r/robotics/comments/1ov3k5v/)

---

## 🙏 Acknowledgments

Built with help from:
- **Claude (Anthropic)** - For debugging Modbus issues and motor control algorithms
- **Bluepad32 Community** - Xbox controller integration
- **r/robotics** - Hardware advice and OpenArm recommendations

---

## 📜 License

MIT License - Use this for your own homestead automation projects!

---

<div align="center">

**Built with ❤️ on a homestead in Humboldt County, California**

*"If it takes more than 10 minutes, automate it. If it needs AI, build it from scratch."*

</div>
