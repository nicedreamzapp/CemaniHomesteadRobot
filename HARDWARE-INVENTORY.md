# Cemani robot: every part on it now (current list, 2026-11-17)
Built from every README/CLAUDE.md version in git history, the firmware, and the Jetson WiFi notes.
Read this BEFORE proposing any part. Matt: "every part is accounted for." Matt corrects this file, not the other way round.

## 1. Power
| Part | Spec | Feeds |
|---|---|---|
| 2x LiFePO4 12V 30Ah (DC HOUSE 2-pack) | in series = 24V, 720Wh, mounted low | everything |
| Breakers | 2x 40A (one per ZLAC driver) + 1x 50A (battery bar) | drive power |
| 5V buck (Matt: x2; repo lists 1) | 25W 5A, waterproof AUTOMOTIVE | repo: Teensy, ESP32, logic. Matt 11/17: cameras run off 5V |
| 12V buck | KInuoxj 20A 240W DC-DC 24/36/48V to 12V, IP68, built-in fuse + over-current/short/heat protection (Amazon B0CS2KJSKS, Matt found it 11/18) | repo: "Cameras, accessories"; Matt 11/17: reserved for the 12V PIR motion sensors (old README: "Industrial PIR Sensor, 100-200ft, 12V, wake system"), never hooked up; now shared with the steering actuator, fuse each branch |
| 19V buck | waterproof AUTOMOTIVE | Jetson Orin Nano Super |
| Terminal blocks + "battery bar" (50A breaker) | only bar named in repo; Matt remembers other bars (12V etc.), not written down | power distribution |
| Wiring | star ground from battery negative, all grounds tied at one point; DuPont for signals | |
Lesson (git): hobby DROK bucks blew 4 Teensys + 3 ESP32s (~$190). Automotive grade since: zero failures. Never suggest hobby bucks.

## 2. Drive
| Part | Spec |
|---|---|
| 4x ZLLG80ASM250 hub motors | 250W each (1 kW), 9 lb each, 4096-count encoders, 8 in pneumatic tires |
| 2x ZLAC8015D dual-channel drivers | one per side, Modbus RTU |
| RS-485 module MAX3485 | Teensy Serial3 @ 115200 to both ZLACs |
| 4x e-scooter shocks on black plates | suspension |

## 3. Control
| Part | Connection |
|---|---|
| Teensy 4.1 | main controller, Modbus master, safety watchdogs, wireless flashing via ESP32 |
| ESP32 | Teensy Serial1; WiFiMulti (home / work / phone hotspot) + Bluepad32 |
| Xbox controller (also 8BitDo Ultimate 5.1) | Bluetooth to ESP32, processed first every loop |

## 4. Sensors
| Part | Connection |
|---|---|
| RPLidar A1M8 | USB to Jetson (/dev/ttyUSB0/1), lidar_relay.py |
| 4x JSN-SR04T-V3.0 ultrasonics (FL FR RL RR) | Teensy trig/echo pins |
| u-blox NEO-M8N GPS | Teensy Serial7 @ 38400 |
| Compass HMC5883L / QMC5883L / IST8310 (auto-detected) | Teensy I2C, scans Wire/Wire1/Wire2 |

## 5. Cameras + network
| Part | Detail |
|---|---|
| 2x Sricam PTZ 1080p (RTSP/ONVIF, audio) | front + rear on the robot hotspot; powered by 5V (Matt 11/17; old README wrongly said 12V buck) |
| Alfa WiFi adapter + antenna | robot hotspot; NEVER move hostapd off it |
| Jetson built-in WiFi | internet (home network), NAT to the hotspot |

## 6. Brain + servers
| Part | Detail |
|---|---|
| Jetson Orin Nano Super 8GB | 256GB KingSpec NVMe; YOLOv8n TensorRT, robot brain, camera + lidar relays |
| VPS (Hostinger, Ubuntu 24.04) | WebSocket hub, command center, ports 3001/3002 |
| Mac Mini | camera relay / 3D mapper (Depth Anything V2) |

## 7. Frame
- 2020 extrusion frame v3 (built 11/11), aluminum plates, spare 2020 pieces + 7 L brackets
- ~80 lb, 100+ lb payload tested

## 8. Front steering (the only NEW parts, carts 11/17, not bought yet)
- Pololu: Glideforce LACT4P-12V-10 actuator (pot feedback + limit switches) + bracket 2314
- eBay: 2x UCF204-12 bearings. Zoro: 2 Ruland collars, 2 clevis pins 3/4x2, M5 nylocks
- Amazon: 14 hardware items (screws, T-nuts, washers, sleeves, standoffs, heims, tie rod, spacers, bolts)
- Steering plates: ON HOLD until the cardboard test
- Wiring plan: actuator pot -> Teensy analog pin on 3.3V; motor power from the free 12V buck (20A, plenty) through a motor driver (Matt 11/18: NO actuator driver owned. Chosen: Pololu Dual G2 High-Power Motor Driver 18v18 Shield #2515, $74.95, 2 channels 18A each, 3.3V logic OK; Teensy PWM/DIR per channel + reads each actuator pot, so it runs 2 actuators separately. Actuator stall = 7A @12V per Pololu, fuse ~10A per actuator)

## Amazon order history confirmations (Matt pasted 11/18, orders delivered ~Dec 2025)
- RPLIDAR A1M8 (WayPonDEV) $99.00
- KInuoxj 20A 240W 24/36/48V to 12V buck $17.99 (the 12V buck above)
- 25W 12/24V to 5V 5A waterproof buck $11.99 (qty on that line not shown)
- KingSpec 256GB M.2 NVMe $34.99
- hiBCTR 2-pack outdoor PIR DC 12V motion sensor SWITCH (made for LED flood lights; it switches 12V on motion, so reading it on the Teensy needs a divider or optocoupler) $14.09
- Deegoo-FPV NEO-M8N GPS + compass module $26.99
- 2x JSN-SR04T-V3.0 ultrasonic (D-FLIFE 2-pack) $9.99; Matt confirmed 11/18 he has all 4 (other pair on another order)
- No actuator motor driver board seen in these orders yet.

## Planned / not on the robot (from old READMEs, don't treat as owned)
Bought but not hooked up (Matt 11/17): new long-range antenna, motion (PIR) detectors meant to wake everything.
IR night camera (Arducam, bought), siren, strobe, bear-spray servo, 2x OpenArm, ESP32 high-gain antenna, outdoor AP / mesh.

Power figures in the repo: only motors (24V, 6A rated / 18A peak, 250W each) and ZLAC (20-48V in) from the maker PDFs; load estimates idle ~5W, cameras streaming ~15W, driving ~400W. Everything else: not recorded.
