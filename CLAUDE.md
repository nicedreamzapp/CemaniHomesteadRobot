# Cemani Robot - Claude Code Instructions

## CRITICAL SAFETY RULE - ROBOT MOVEMENT

**Claude Code is NEVER allowed to:**
1. Start MAP 1 or any mapping sequence
2. Send movement commands to the robot
3. Trigger any robot motion whatsoever

**Before any robot movement or mapping is needed, Claude MUST:**
1. STOP and ASK the user: "Are you ready for robot movement? Please ensure the robot is in a safe position."
2. WAIT for explicit user confirmation
3. INSTRUCT the user to press the MAP 1 button in the UI themselves

**Only the user can initiate robot movement by clicking buttons in the web UI.**

This rule exists because the robot is a physical machine that can cause damage or injury if moved unexpectedly. The user must always have the opportunity to ensure the robot is in a safe position before any movement occurs.

---

# Robot LIDAR Grid Movement - ENCODER-BASED

## Current Status (Dec 29, 2024)
Encoder-based odometry is now **ENABLED**. The 3D LIDAR grid will move when the robot's wheels actually turn (based on encoder readings from the Teensy), not when commands are sent.

## How It Works
1. Teensy sends TELEM messages with encoder positions (posL, posR) every ~200ms
2. Server calculates delta movement from previous encoder readings
3. Server broadcasts `dead_reckoning` message with updated position
4. UI updates grid position in animation loop from `window.odomState`

## Key Files
- `vps-server/server.js` - Encoder processing (lines 395-475)
- `vps-server/public/js/websocket.js` - 3D LIDAR visualization
- `teensy-robot/src/telemetry.cpp` - Teensy TELEM format (line 196)

## Debug Logs
When robot moves, you should see:
```
[ENC] posL=10985 posR=11140 prevL=10980 prevR=11135 dL=5 dR=5
[ODOM] Movement detected: x=15mm, y=20mm, heading=0.5°
```

## If Grid Doesn't Move
1. Check encoder values are changing: `pm2 logs robot | grep ENC`
2. Verify TELEM messages: `pm2 logs robot | grep TELEM`
3. The grid only moves when encoder deltas are non-zero

## Deployment Note
Server runs from `/opt/robot-server/` (not /opt/robot/)
Deploy with: `scp server.js root@72.60.124.34:/opt/robot-server/server.js && ssh root@72.60.124.34 "pm2 restart robot"`

---

# LIDAR Setup - RPLidar A1M8

## Hardware
- **Sensor**: RPLidar A1M8 2D 360° LIDAR
- **Range**: 12 meters scanning radius
- **Connection**: USB to Jetson at `/dev/ttyUSB0`

## Jetson Connection
- **IP Address**: `192.168.1.31` (hostname: tegra-ubuntu)
- **Username**: `jetson`
- **Password**: `jetson`
- **SSH**: `ssh jetson@192.168.1.31`

## Starting LIDAR Relay
The LIDAR relay must be running on the Jetson for LIDAR panels to appear in the UI:

```bash
# SSH to Jetson
ssh jetson@192.168.1.31

# Start LIDAR relay
cd ~/jetson-lidar
python3 lidar_relay.py

# Or run in background
nohup python3 lidar_relay.py > /tmp/lidar.log 2>&1 &
```

## Verify LIDAR is Working
1. Check VPS logs: `ssh root@72.60.124.34 "pm2 logs robot | grep LIDAR"`
2. UI should show "LIDAR: XXX pts" in the top bar
3. Colorful wall panels should surround the robot

## Key Files
- `jetson-lidar/lidar_relay.py` - Main relay script (RPLidar)
- `vps-server/public/js/lidar3d.js` - 3D visualization
- `vps-server/server.js` - LIDAR data routing (lines 951-1000)

## Troubleshooting
- **No LIDAR in UI**: Check if relay is running on Jetson
- **Device not found**: Verify `/dev/ttyUSB0` exists on Jetson
- **Walls off to side**: Ensure lidar3d.js adds walls to `lidar3dScene` not `lidar3dWorldContainer`
