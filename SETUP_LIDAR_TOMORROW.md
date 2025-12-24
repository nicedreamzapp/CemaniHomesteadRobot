# Lidar Hybrid Sensor Setup - Tomorrow's Tasks

## Summary
The Jetson lidar relay is working and connects to VPS. The VPS server files need to be updated to display lidar data in the web UI.

## Current Status
- Jetson lidar relay: WORKING (tested, connects to VPS)
- VPS server files: NEED TO BE SYNCED (modified locally, not on VPS)
- Web UI: Will show hybrid lidar/ultrasonic once VPS files are updated

---

## TASKS TO COMPLETE

### 1. Sync Files to VPS

The following files were modified and need to be copied to VPS at `/root/vps-server/`:

From Mac (with SSH access), run:
```bash
cd ~/Desktop/CemaniHomesteadRobot
git pull origin main

# Then copy to VPS
scp vps-server/server.js root@72.60.124.34:/root/vps-server/
scp vps-server/public/index.html root@72.60.124.34:/root/vps-server/public/
scp vps-server/public/css/styles.css root@72.60.124.34:/root/vps-server/public/css/
scp vps-server/public/js/websocket.js root@72.60.124.34:/root/vps-server/public/js/
```

OR if on VPS directly:
```bash
cd /root/vps-server
git pull origin main
```

### 2. Install VPS Dependencies (if not done)

On VPS:
```bash
cd /root/vps-server
npm install
```

### 3. Restart VPS Server

On VPS:
```bash
pm2 restart robot
# or if not running:
pm2 start server.js --name robot
pm2 logs robot --lines 20
```

### 4. Start Lidar Relay on Jetson

On Jetson:
```bash
cd ~/Desktop/CemaniHomesteadRobot/jetson-lidar
python3 lidar_relay.py
```

Should show:
```
LIDAR RELAY SERVICE
LIDAR: /dev/ttyUSB0
VPS:   wss://robot.marijuanaunion.com
Connecting to LIDAR...
LIDAR connected - Model 24
WebSocket connected to VPS
```

### 5. Verify in Web UI

Open https://robot.marijuanaunion.com and look for:
- "HYBRID SENSORS" section (was "ULTRASONIC PROXIMITY")
- Green lidar dots showing room layout
- Ultrasonic waves should be more subtle
- When lidar and ultrasonic agree on object location, highlight appears

---

## File Changes Made

### jetson-lidar/lidar_relay.py (NEW)
- Reads RPLIDAR A1M8 data from /dev/ttyUSB0
- Excludes camera at 7 o'clock position (205-220 degrees, <400mm)
- Sends to VPS via WebSocket every 150ms
- Auto-reconnects on disconnect

### vps-server/server.js (MODIFIED)
- Added `identify` handler for `jetson-lidar` device
- Added `lidar` message type to broadcast to browsers
- Lines 537-546

### vps-server/public/index.html (MODIFIED)
- Changed "ULTRASONIC PROXIMITY" to "HYBRID SENSORS"
- Added `<canvas id="lidarCanvas">` for lidar overlay
- Removed LiDAR from "COMING SOON"

### vps-server/public/css/styles.css (MODIFIED)
- Added `.lidar-canvas` styles (z-index 1, pointer-events none)
- Reduced sonar wave opacity from 1.0 to 0.4/0.7
- Sonar now more subtle, lidar more prominent

### vps-server/public/js/websocket.js (MODIFIED)
- Added `lidar` message handler
- Added `drawLidarPoints()` function - draws green dots on canvas
- Added `checkSensorAgreement()` - highlights when lidar+sonar agree

---

## Troubleshooting

### Lidar "Incorrect descriptor starting bytes" error
Run this to reset:
```bash
python3 -c "
from rplidar import RPLidar
lidar = RPLidar('/dev/ttyUSB0')
lidar.stop()
lidar.stop_motor()
lidar.disconnect()
print('Reset complete')
"
```

### Permission denied on /dev/ttyUSB0
```bash
sudo chmod 666 /dev/ttyUSB0
```

### VPS server won't start
Check for errors:
```bash
cd /root/vps-server
node server.js
```
If "Cannot find module", run `npm install`

---

## Quick Start Command (after VPS is synced)

On Jetson, run this single command:
```bash
cd ~/Desktop/CemaniHomesteadRobot/jetson-lidar && sudo chmod 666 /dev/ttyUSB0 && python3 lidar_relay.py
```

Then refresh the web UI.
