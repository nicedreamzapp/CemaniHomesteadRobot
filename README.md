<div align="center">

# 🤖 Cemani Homestead Robot

### Autonomous Dual-Armed Tank Platform for Homestead Automation

![Made with](https://img.shields.io/badge/Made_with-Blood_Sweat_Tears-red?style=for-the-badge)
![Status](https://img.shields.io/badge/Status-Mobile_Platform_Complete-green?style=for-the-badge)
![Power](https://img.shields.io/badge/Power-24V_LiFePO4-orange?style=for-the-badge)

**Built to protect chickens, automate chores, and give kids rides around the homestead**

[📹 Demo Video](#demo) • [🔧 Hardware](#hardware) • [🤖 The Vision](#the-vision) • [💻 Code](#code)

</div>

---

## 🎥 Demo

### Robot Pulling Firewood Cart

https://github.com/user-attachments/assets/robot-pulling-firewood.mp4

*Successfully pulling a loaded metal cart - first real-world test after 6 months of building and learning.*

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
**Status:** Mobile platform complete ✅ | Adding autonomy next 🚧

### Phase Completion
- ✅ **Phase 1:** Tank chassis with 4WD hub motors
- ✅ **Phase 2:** Xbox controller → ESP32 → Teensy → Motors  
- ✅ **Phase 3:** RS-485 Modbus communication working
- ✅ **Phase 4:** Successfully pulled loaded cart
- 🚧 **Phase 5:** Wire management (goal: gaming PC aesthetic)
- 🚧 **Phase 6:** Fine-tune acceleration curves
- 🔜 **Phase 7:** Add computer vision (RealTime AI Cam integration)
- 🔜 **Phase 8:** Mount dual OpenArm 0.1 manipulators
- 🔜 **Phase 9:** Autonomous navigation and task planning

---

## 🔧 Hardware

### Mobile Platform (Complete)

| Component | Specs | Purpose |
|-----------|-------|---------|
| **4x Hub Motors** | ZLLG80ASM250, 9 lbs each | Tank drive (2 per side, encoded) |
| **2x Motor Drivers** | ZLAC8015D Dual-Channel | Each controls one side via Modbus |
| **Teensy 4.1** | 600MHz ARM Cortex-M7 | Main controller & Modbus master |
| **ESP32** | Bluetooth 5.0 | Xbox controller receiver (Bluepad32) |
| **RS-485 Module** | MAX3485 | Modbus RTU communication |
| **2x 12V LiFePO4** | Series = 24V | Motor power (low CoG mounting) |
| **Buck Converter** | DROK 24V→5V | Logic power with filtering |
| **Xbox Controller** | Bluetooth 5.0 | Wireless control |
| **2020 Extrusion** | Aluminum | Chassis frame |
| **Aluminum Plates** | Various | Mounting & structure |
| **4x Shocks** | Electric scooter | Suspension for terrain |
| **Fuses & Breakers** | 10A input, 2A output | Protection |
| **Capacitors** | 100µF input/output | Power filtering |

### Planned Additions

| Component | Specs | Purpose |
|-----------|-------|---------|
| **2x OpenArm 0.1** | 3-5kg lift each | Bilateral manipulation |
| **Camera Array** | 360° coverage | Computer vision & navigation |
| **iPhone/iPad** | Running RealTime AI Cam | 601-class object detection |
| **GPS Module** | Outdoor navigation | Property coverage |
| **LiDAR** | Optional 3D mapping | Obstacle avoidance |
| **Train Body** | Cardboard/3D printed | Kid transport mode |

---

## 🤖 The Vision: Dual-Armed Autonomy

### Why Two Arms?
OpenArm 0.1 provides **bilateral manipulation** - the ability to coordinate two arms like a human:
- One arm stabilizes a container while the other scoops
- Both arms work together to pack boxes efficiently  
- Coordinate lifting and placing objects
- Handle larger items that need two-point grip

### Planned Tasks

**Daily Chicken Care:**
1. Robot navigates to feed storage at scheduled time
2. Uses object detection to locate chicken feed container
3. One arm opens/stabilizes lid, other arm scoops feed
4. Distributes feed to multiple feeding stations
5. Chickens learn to gather when they see/hear the robot

**Package Handling:**
1. Vision system identifies box on shelf
2. Retrieves box with coordinated arm movement
3. Places in packing area
4. Fills with items from stockroom
5. Closes and labels for shipping

**Laundry Assistance:**
1. Detects dryer completion signal
2. Opens dryer door with one arm
3. Retrieves clothing with other arm
4. Places in basket for transport
5. Delivers to folding area

**Predator Patrol:**
- Autonomous perimeter patrol on schedule
- Computer vision detects animals (raccoons, foxes, coyotes)
- Approaches with lights/sounds to scare them away
- Arms can wave/gesture to appear larger
- Logs encounters for analysis

---

## 💻 Software Architecture

### Current Stack (Platform Control)
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

### Planned Stack (Full Autonomy)
```
High-Level Planning (Python/ROS)
    ├─ Task Scheduler
    ├─ Path Planning
    └─ Object Detection (RealTime AI Cam)
         ↓
    Teensy 4.1 (Motion Control)
         ├─ Motor Control (Modbus)
         ├─ Arm Control (OpenArm)
         └─ Sensor Fusion
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

---

## 🚧 Technical Challenges & Solutions

### Challenge 1: Motor Direction Asymmetry ✅
**Problem:** Left/right sides spinning opposite when given same command  
**Root Cause:** Driver CCW/CW parameters differed between units  
**Solution:** Driver-specific inversion in code, works reliably now

### Challenge 2: Power Stability ✅
**Problem:** Brown-outs during motor acceleration  
**Solution:** 100µF capacitors on buck converter input/output + proper fusing

### Challenge 3: Tip-Over Risk 🚧
**Problem:** Adding arms on top raises center of gravity  
**Solution:** 
- Batteries mounted at lowest point, evenly distributed
- Each 9 lb wheel provides low CoG
- Total 65 lbs well-balanced
- Can add 80+ lbs more if needed with reinforcement

### Challenge 4: Encoder Integration 🔜
**Status:** Each hub motor has encoders but not yet utilized  
**Plan:** Implement closed-loop PID speed control using encoder feedback

---

## 🎓 What I Learned (6 Months from Zero)

### Month 1-2: Basic Electronics
- Power distribution and voltage regulation
- Fuse/breaker selection for protection
- Why capacitors matter for motor loads

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

### Month 6: Real-World Testing
- Weight distribution matters
- Cable management is critical
- Testing reveals what theory misses
- Iterative improvement beats perfection

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
- [Teensy Code](hardware/teensy/) - Motor control firmware
- [ESP32 Code](hardware/esp32/) - Bluepad32 controller interface
- [ZLAC Documentation](hardware/motor-controllers/) - Driver manuals
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

### Short Term (Next 3 Months)
- [ ] Clean wire management with gaming PC aesthetic
- [ ] Fine-tune acceleration curves and control feel
- [ ] Integrate RealTime AI Cam for object detection
- [ ] Basic autonomous navigation (GPS waypoints)
- [ ] Mount and test single OpenArm first

### Medium Term (3-6 Months)
- [ ] Add second OpenArm for bilateral manipulation
- [ ] Implement task scheduler for automated feeding
- [ ] Computer vision-based predator detection
- [ ] Path planning with obstacle avoidance
- [ ] Build train engine body for kids

### Long Term (6-12 Months)
- [ ] Full autonomous homestead task execution
- [ ] Package packing automation
- [ ] Laundry retrieval system
- [ ] Multi-modal swappable bodies
- [ ] Fish-controlled mode (because why not)

---

## 💡 For Other Builders

**This project is useful for:**
- ZLAC8015D motor driver integration examples
- Teensy + ESP32 communication patterns
- Modbus RTU over RS-485 implementation
- Tank drive control algorithms
- Xbox controller input via Bluepad32
- Power system design for mobile robots

**Lessons learned:**
- Start with platform stability before adding complexity
- Test hardware thoroughly before writing complex software
- Weight distribution matters more than total weight
- Real-world testing reveals issues no simulation can predict
- Cable management isn't optional - plan it from the start

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
