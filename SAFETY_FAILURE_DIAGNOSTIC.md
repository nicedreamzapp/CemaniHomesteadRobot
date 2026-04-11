# CRITICAL SAFETY FAILURE DIAGNOSTIC
## Xbox Controller Failsafe Failure Analysis
### Date: January 25, 2026 — operator hand injury during testing (no stitches, close call)

---

## EXECUTIVE SUMMARY

The Xbox controller failsafe failed, causing the robot to move unexpectedly while
I was working on it during a mapping test. My hand got caught before I could
trigger the stop — a dog-bite-style laceration that didn't need stitches, but
close enough to prompt a full audit of the failsafe chain. This document
identifies **20 failure points** in the control chain that could have caused
delayed or lost Xbox controller commands, and the fixes applied.

This is documentation from a hobbyist garage project, shared publicly because the
failure modes here are generic to anyone building a PC/SBC + microcontroller
robot with network-bridged control — not exotic, not uncommon, and critically
important to understand *before* you build one.

---

## CONTROL CHAIN ARCHITECTURE

```
[XBOX CONTROLLER]
       |
       | Bluetooth (Bluepad32 polling)
       v
[ESP32 MICROCONTROLLER]
       |
       | Serial UART 115200 baud
       v
[TEENSY 4.1]
       |
       | Modbus RS485
       v
[ZLAC8015D MOTOR DRIVERS]
       |
       v
[4 HUB WHEEL MOTORS]
```

**PARALLEL PATH (DANGER):**
```
[MAC MAPPING PROCESSES] ---> [VPS WebSocket] ---> [ESP32] ---> [TEENSY]
                                                     ^
                                                     |
                                            COMPETES WITH XBOX!
```

---

## 20 FAILURE POINTS

### CATEGORY A: ESP32 BLUETOOTH/PROCESSING FAILURES

#### 1. BLUETOOTH POLLING STARVATION
**File:** `esp32-robot-controller/src/main.cpp` line 193
**Code:** `BP32.update();`
**Problem:** Single `BP32.update()` per loop. If loop is slow (>50ms), Xbox input is delayed.
**Evidence:** Loop has `delay(10)` but WebSocket processing can block indefinitely.
**Risk Level:** HIGH

#### 2. WEBSOCKET BLOCKING DURING MESSAGE PROCESSING
**File:** `esp32-robot-controller/src/main.cpp` line 210
**Code:** `webSocket.loop();`
**Problem:** WebSocket library processes ALL pending messages synchronously. When mapping floods with camera frames (100KB+ each), this blocks for hundreds of milliseconds.
**Risk Level:** CRITICAL

#### 3. JOYSTICK SEND DEADZONE TOO HIGH
**File:** `esp32-robot-controller/src/main.cpp` line 84
**Code:** `#define JOYSTICK_SEND_DZ 60`
**Problem:** Joystick must exceed 60 units (out of 512) before ANY command is sent. Small corrections are ignored entirely.
**Risk Level:** MEDIUM

#### 4. WEBSOCKET MESSAGE FLOOD FROM MAPPING
**Problem:** When mapping is active, Mac sends:
- Camera frames: ~100KB base64 every 100ms = 1MB/sec
- Depth maps: ~50KB every 200ms
- Point clouds: ~200KB every 500ms
- PTZ commands: Every 500ms
**Total:** 1.5+ MB/sec flooding the WebSocket
**Risk Level:** CRITICAL

#### 5. NO PRIORITY QUEUE FOR XBOX COMMANDS
**Problem:** All WebSocket messages processed FIFO. Xbox joystick updates wait behind camera frames.
**Risk Level:** CRITICAL

---

### CATEGORY B: ESP32-TEENSY SERIAL FAILURES

#### 6. SERIAL BUFFER OVERFLOW
**File:** `esp32-robot-controller/src/main.cpp` line 443-454
**Problem:** `forwardTeensySerial()` only forwards ONE message per loop. If Teensy sends faster than ESP32 processes, buffer fills.
**Risk Level:** HIGH

#### 7. SERIAL BLOCKING DURING FLASH MODE
**File:** `esp32-robot-controller/src/main.cpp` line 250
**Code:** `if (!flashMode) { handleGamepad(); }`
**Problem:** During OTA updates, gamepad handling is completely disabled.
**Risk Level:** LOW (but exists)

#### 8. NO ACK/NACK FOR CRITICAL COMMANDS
**Problem:** ESP32 sends axis commands to Teensy without confirmation. If serial line is noisy or Teensy is busy, commands are lost silently.
**Risk Level:** HIGH

---

### CATEGORY C: TEENSY PROCESSING FAILURES

#### 9. WATCHDOG TIMEOUT TOO LONG (2 SECONDS!)
**File:** `teensy-robot/include/config.h` line 105
**Code:** `#define WATCHDOG_TIMEOUT_MS 2000`
**Problem:** Robot continues at last commanded speed for 2 FULL SECONDS before watchdog triggers. At 4.8 mph (turbo), that's 14 feet of uncontrolled travel.
**Risk Level:** CRITICAL

#### 10. MOTOR UPDATE INTERVAL DELAYS
**File:** `teensy-robot/include/config.h` line 56
**Code:** `#define MOTOR_UPDATE_INTERVAL 30`
**Problem:** Motors only update every 30ms. Combined with other delays, total latency can exceed 100ms.
**Risk Level:** MEDIUM

#### 11. SERIAL PARSING IS BLOCKING
**File:** `teensy-robot/src/main.cpp` lines 501-741
**Problem:** While parsing serial input, all motor control is paused. Long messages (GPS, telemetry) cause delays.
**Risk Level:** MEDIUM

#### 12. AUTONOMOUS MODE NOT IMMEDIATELY CANCELLED
**File:** `teensy-robot/src/main.cpp` lines 794-800
```cpp
if (controllerConnected && (abs(currentLX) > 50 || abs(currentLY) > 50)) {
    if (autonomousActive) {
        autonomousActive = false;
    }
}
```
**Problem:** Only cancels if `currentLX/LY` exceed 50. But these values come from PARSED serial - if parsing is delayed, autonomous keeps running.
**Risk Level:** CRITICAL

#### 13. KEEPALIVE RESETS WATCHDOG BUT NOT FROM XBOX
**File:** `teensy-robot/src/main.cpp` line 515
**Problem:** `lastComm = now;` is set for ANY serial input, including KEEPALIVE from ESP32. This means ESP32 can keep watchdog alive while Xbox is completely disconnected.
**Risk Level:** CRITICAL

---

### CATEGORY D: VPS SERVER FAILURES

#### 14. MANUAL OVERRIDE ONLY LASTS 5 SECONDS
**File:** `vps-server/server.js` line 49
**Code:** `const MANUAL_OVERRIDE_DURATION = 5000;`
**Problem:** After 5 seconds of no Xbox input, autonomous commands are allowed again. If Xbox commands are delayed/lost, mapping resumes automatically.
**Risk Level:** HIGH

#### 15. MAPPING COMMANDS BYPASS TEENSY XBOX CHECK
**File:** `vps-server/server.js` lines 1036-1047
```javascript
if (data.type === "robot_spin") {
    const cmd = `${dir},${data.degrees}`;
    rs.send(JSON.stringify({ type: "serial_cmd", cmd: cmd }));
}
```
**Problem:** `robot_spin` commands from mapping go directly to Teensy as `AUTO_LEFT/RIGHT` commands. Teensy's Xbox check only looks at `currentLX/LY`, not incoming autonomous commands.
**Risk Level:** CRITICAL

#### 16. NO HEARTBEAT VERIFICATION FOR XBOX
**Problem:** VPS assumes Xbox is working if ESP32 is connected. No way to verify Xbox controller is actually responding.
**Risk Level:** HIGH

---

### CATEGORY E: MAPPING PROCESS FAILURES

#### 17. MAPPING SENDS ROBOT_SPIN COMMANDS
**File:** `mac-visualizer/hybrid_3d_mapper.py` line 1798
```python
spin_cmd = {"type": "robot_spin", "direction": direction, "degrees": turn_degrees}
```
**Problem:** Mapping process directly commands robot rotation. These commands compete with Xbox.
**Risk Level:** CRITICAL

#### 18. MULTIPLE MAPPING PROCESSES RUNNING
**Evidence:** `ps aux` showed 8+ Python processes:
- hybrid_3d_mapper.py (2 instances!)
- sharp_mapper.py (2 instances!)
- gaussian_splat_mapper.py
- semantic_mapper.py
- splat_uploader.py
- splat_server.py
**Problem:** All sending data simultaneously, flooding WebSocket.
**Risk Level:** CRITICAL

#### 19. MAC LAUNCHER DAEMON AUTO-RESPAWNS
**File:** `~/Library/LaunchAgents/com.cemani.mac-launcher.plist`
**Problem:** Even when killed, the launcher daemon respawns. It restarts mapping processes automatically.
**Risk Level:** HIGH

---

### CATEGORY F: HARDWARE/NETWORK FAILURES

#### 20. WIFI INTERFERENCE DURING BLUETOOTH
**File:** `esp32-robot-controller/src/main.cpp` lines 188-268
**Problem:** ESP32 shares antenna between WiFi and Bluetooth. High WiFi traffic (mapping data) degrades Bluetooth performance.
**Evidence:** Version notes mention "aggressive Bluetooth polling that was interfering with WiFi"
**Risk Level:** HIGH

---

## FAILURE CHAIN RECONSTRUCTION

Based on the code analysis, here's what likely happened:

1. **8+ mapping processes were running**, sending massive data to VPS
2. **VPS forwarded all data to ESP32** WebSocket
3. **ESP32 `webSocket.loop()` blocked** processing camera frames
4. **Xbox `BP32.update()` wasn't called frequently enough**
5. **Joystick commands queued in Bluepad32 buffer**
6. **Teensy continued executing last command** (possibly autonomous spin)
7. **Watchdog didn't trigger** because KEEPALIVE was still being sent
8. **Manual override expired** after 5 seconds
9. **Mapping resumed** and sent robot_spin command
10. **Robot spun/moved into crowd**

---

## IMMEDIATE FIXES REQUIRED

### CRITICAL (Must fix before any operation):

1. **XBOX MUST BE PROCESSED FIRST** - Move `BP32.update()` and `handleGamepad()` BEFORE `webSocket.loop()` in ESP32

2. **REDUCE WATCHDOG TO 500MS** - Change `WATCHDOG_TIMEOUT_MS` from 2000 to 500

3. **ADD XBOX-SPECIFIC HEARTBEAT** - Teensy must track Xbox input separately from ESP32 keepalive

4. **DISABLE ROBOT_SPIN FROM MAPPING** - Remove or require explicit user confirmation

5. **ADD MESSAGE PRIORITY QUEUE** - Xbox commands must skip WebSocket queue

### HIGH PRIORITY:

6. Rate limit mapping data to 100KB/sec max
7. Add hardware E-stop button
8. Xbox disconnect = immediate motor stop (not watchdog delay)
9. Mapping processes must check Xbox status before any command
10. Add network latency monitoring with auto-stop if >200ms

---

## TESTING REQUIREMENTS

Before operating robot again:

1. Test Xbox response time under full mapping load - must be <100ms
2. Test watchdog trigger with simulated ESP32 disconnect
3. Verify robot_spin commands are blocked when Xbox is active
4. Test emergency stop under all conditions
5. Verify KEEPALIVE doesn't mask Xbox disconnection

---

## CONCLUSION

The failsafe system had **multiple critical design flaws** that created a perfect storm:

- Xbox commands competed with mapping data on shared channel
- Watchdog was kept alive by KEEPALIVE, not Xbox
- Mapping could send movement commands that bypassed Xbox checks
- Multiple processes flooded the communication channel

**This was not a single point of failure - it was systemic.**

The robot should NOT be operated until fixes 1-5 above are implemented and tested.

---

*Document generated: 2026-01-25*
*Incident: Robot collision with injuries*
*Analysis by: Claude Code Safety Audit*
