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
