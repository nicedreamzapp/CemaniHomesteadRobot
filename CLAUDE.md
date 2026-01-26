# Cemani Robot - Claude Code Instructions

## ╔═══════════════════════════════════════════════════════════════════════════════╗
## ║                    !!! CRITICAL SAFETY - READ FIRST !!!                       ║
## ║═══════════════════════════════════════════════════════════════════════════════║
## ║  INCIDENT: January 25, 2026 - Robot crashed into crowd, people were INJURED  ║
## ║  ROOT CAUSE: Mapping processes flooded WebSocket, blocking Xbox controller    ║
## ║  THE XBOX CONTROLLER IS THE PRIMARY SAFETY MECHANISM - IT MUST NEVER FAIL    ║
## ╚═══════════════════════════════════════════════════════════════════════════════╝

## ABSOLUTE SAFETY RULES - XBOX CONTROLLER IS SACRED

**THE XBOX CONTROLLER MUST ALWAYS WORK. NOTHING CAN OVERRIDE IT.**

### What went wrong (Jan 25, 2026):
1. 8+ mapping processes flooded WebSocket with 1.5MB/sec of data
2. ESP32 got blocked processing camera frames, couldn't poll Xbox
3. Teensy watchdog was kept alive by KEEPALIVE (not Xbox-specific)
4. Manual override expired after only 5 seconds
5. Mapping sent robot_spin command that moved robot into crowd
6. People were injured

### What was fixed:
1. Xbox is now polled FIRST in ESP32 loop, BEFORE WebSocket
2. XBOX_ACTIVE heartbeat is separate from KEEPALIVE
3. Teensy has Xbox-specific watchdog (300ms timeout)
4. Xbox disconnect sends IMMEDIATE stop to motors
5. Manual override increased to 30 seconds
6. robot_spin is BLOCKED when Xbox was recently used
7. /spin endpoint requires authentication again
8. Watchdog reduced from 2000ms to 500ms

## CRITICAL SAFETY RULE - ROBOT MOVEMENT

**Claude Code is NEVER allowed to:**
1. Start MAP 1 or any mapping sequence
2. Send movement commands to the robot
3. Trigger any robot motion whatsoever
4. Modify Xbox controller handling code without explicit user approval
5. Reduce watchdog timeouts or safety margins
6. Remove authentication from any movement endpoint

**Before any robot movement or mapping is needed, Claude MUST:**
1. STOP and ASK the user: "Are you ready for robot movement? Please ensure the robot is in a safe position."
2. WAIT for explicit user confirmation
3. INSTRUCT the user to press the MAP 1 button in the UI themselves

**Only the user can initiate robot movement by clicking buttons in the web UI.**

This rule exists because the robot is a physical machine that can cause damage or injury if moved unexpectedly. The user must always have the opportunity to ensure the robot is in a safe position before any movement occurs.

**NEVER FORGET: PEOPLE WERE INJURED WHEN THESE RULES WERE NOT FOLLOWED.**

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

---

# NiceDreamz - Robot's Own WiFi Hotspot

## Purpose
The robot runs its own WiFi network called "NiceDreamz" using a long-range Alfa adapter. IP cameras connect to this network so they work anywhere the robot goes, regardless of what external WiFi the robot uses for internet.

## Architecture
```
[External WiFi] ←→ [Jetson built-in WiFi wlP1p1s0] (internet)
                         ↓
                    [Jetson]
                         ↓
              [Alfa adapter wlx00c0caab495d]
                         ↓
                   [NiceDreamz hotspot]
                         ↓
                 [IP Cameras: 10.0.0.x]
```

## Network Details
- **SSID**: NiceDreamz
- **IP Range**: 10.0.0.10 - 10.0.0.50 (DHCP)
- **Gateway**: 10.0.0.1
- **Channel**: 6 (2.4GHz)
- **Internet**: Shared from Jetson's main WiFi via NAT

## Services (auto-start on boot)
- `camera-relay.service` - Streams cameras to VPS
- `lidar-relay.service` - Streams LIDAR to VPS
- `hostapd.service` - NiceDreamz hotspot
- `dnsmasq.service` - DHCP for cameras

## Key Files on Jetson
- `/etc/hostapd/hostapd.conf` - Hotspot config
- `/etc/dnsmasq.d/hotspot.conf` - DHCP config
- `/etc/NetworkManager/conf.d/unmanaged-alfa.conf` - Prevents NM from managing Alfa
- `~/jetson-camera-relay/config.json` - Camera IPs/credentials

## Adding a New Camera to NiceDreamz
1. Connect camera to NiceDreamz WiFi (password in hostapd.conf)
2. Camera gets IP via DHCP (10.0.0.x)
3. Update `~/jetson-camera-relay/config.json` with camera IP
4. Restart relay: `sudo systemctl restart camera-relay`

## Troubleshooting
- **Hotspot not broadcasting**: `sudo systemctl restart hostapd`
- **Camera can't connect**: Check `nmcli device set wlx00c0caab495d managed no`
- **No internet for cameras**: Verify NAT: `sudo iptables -t nat -L POSTROUTING`
- **Camera relay not starting**: Check logs: `journalctl -u camera-relay -f`
