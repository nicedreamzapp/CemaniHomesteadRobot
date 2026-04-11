# Sricam IP Camera Relay for Robot Command Center

This relay server runs on your Mac Mini M4 Pro to bridge your local Sricam IP camera to the remote VPS command center.

## Architecture

```
[Sricam Camera]  --RTSP-->  [Mac Mini Relay]  --HLS/WebSocket-->  [VPS Server]  --WebSocket-->  [Browser]
  192.168.1.192              Local Network                         YOUR_VPS_IP                   User
       |                          |                                     |
   ONVIF PTZ  <------------------+-------------------------------------+
```

## Prerequisites

### On Mac Mini

1. **Install FFmpeg** (for RTSP to HLS conversion):
   ```bash
   brew install ffmpeg
   ```

2. **Install Node.js** (if not already installed):
   ```bash
   brew install node
   ```

## Setup

### 1. Configure the Relay

Edit `relay.js` and update the configuration if needed:

```javascript
const CONFIG = {
  camera: {
    ip: '192.168.1.192',        // Your camera's local IP
    rtspPort: 554,
    rtspPath: '/onvif1',
    onvifPort: 5000,
    username: 'admin',
    password: 'YOUR_CAMERA_PASSWORD'
  },
  relay: {
    port: 8080,                  // Local relay server port
  },
  vps: {
    url: 'ws://YOUR_VPS_IP:3001'  // Your VPS WebSocket URL
  }
};
```

### 2. Install Dependencies

```bash
cd mac-camera-relay
npm install
```

### 3. Start the Relay

```bash
npm start
```

You should see:
```
========================================
  Mac Mini Camera Relay Server
========================================
Local server: http://localhost:8080
HLS stream:   http://localhost:8080/hls/stream.m3u8
Snapshot:     http://localhost:8080/camera/snapshot
Camera IP:    192.168.1.192
========================================
[FFMPEG] Starting RTSP to HLS conversion...
[VPS] Connecting to ws://YOUR_VPS_IP:3001
[VPS] Connected
```

### 4. Configure Browser Access to HLS Stream

For remote viewing, the browser needs to access the HLS stream from your Mac Mini. Options:

#### Option A: Port Forwarding (Recommended for home use)
1. Forward port 8080 on your router to your Mac Mini's local IP
2. Update the frontend with your public IP:
   ```javascript
   const CAM1_RELAY_URL = 'http://YOUR_PUBLIC_IP:8080';
   ```

#### Option B: Cloudflare Tunnel (More secure, no port forwarding)
```bash
brew install cloudflared
cloudflared tunnel login
cloudflared tunnel create robot-camera
cloudflared tunnel route dns robot-camera camera.yourdomain.com
cloudflared tunnel run --url http://localhost:8080 robot-camera
```

Then use: `const CAM1_RELAY_URL = 'https://camera.yourdomain.com';`

#### Option C: ngrok (Quick testing)
```bash
brew install ngrok
ngrok http 8080
```

Then use the ngrok URL in the frontend.

## Camera Controls

### PTZ (Pan-Tilt-Zoom)
- **Pan**: Left/Right movement
- **Tilt**: Up/Down movement
- **Zoom**: Digital zoom in/out
- Uses ONVIF continuous move commands

### Settings via CGI
- **Flip/Mirror**: Image orientation
- **Night Vision**: Auto/On/Off IR control
- **Motion Detection**: Enable with sensitivity 1-10
- **Snapshot**: Captures JPEG from camera

### Presets
- 4 preset positions (P1-P4)
- Save current position to preset
- One-click recall of saved positions

## API Endpoints

### Local HTTP API (for testing)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/hls/stream.m3u8` | GET | HLS video stream playlist |
| `/camera/snapshot` | GET | JPEG snapshot |
| `/stream/start` | POST | Start HLS streaming |
| `/stream/stop` | POST | Stop HLS streaming |
| `/stream/status` | GET | Check stream status |
| `/ptz/move` | POST | `{pan, tilt, zoom}` -1.0 to 1.0 |
| `/ptz/stop` | POST | Stop PTZ movement |
| `/ptz/preset/goto` | POST | `{preset: "1"}` |
| `/ptz/preset/set` | POST | `{name: "Preset1"}` |
| `/camera/flip` | POST | `{flip: true, mirror: false}` |
| `/camera/nightvision` | POST | `{mode: 0}` 0=auto, 1=on, 2=off |
| `/camera/motion` | POST | `{enabled: true, sensitivity: 5}` |
| `/health` | GET | Server health check |

### WebSocket Commands (via VPS)

The relay connects to the VPS and responds to these message types:

- `cam_ptz` - PTZ control commands
- `cam_setting` - Camera settings (flip, NV, motion)
- `cam_stream` - Start/stop streaming
- `cam_snapshot` - Capture and send snapshot

## Troubleshooting

### "RTSP connection failed"
- Verify camera IP is correct: `ping 192.168.1.192`
- Check RTSP URL in VLC: `rtsp://admin:YOUR_CAMERA_PASSWORD@192.168.1.192:554/onvif1`
- Ensure camera and Mac Mini are on same network

### "ONVIF commands not working"
- Verify ONVIF port (5000) is open on camera
- Check camera firmware supports ONVIF Profile S
- Test with ONVIF Device Manager tool

### "HLS stream not loading in browser"
- Check CORS headers are being set
- Verify FFmpeg is producing .ts segments in `hls/` directory
- Check browser console for errors

### "VPS connection keeps dropping"
- Check VPS server is running: `pm2 status`
- Verify firewall allows WebSocket on port 3001
- Check for network issues between Mac Mini and VPS

## Running as a Service

### Using launchd (macOS native)

Create `~/Library/LaunchAgents/com.robot.camera-relay.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.robot.camera-relay</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/Users/YOUR_USERNAME/Desktop/CemaniHomesteadRobot/mac-camera-relay/relay.js</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>WorkingDirectory</key>
    <string>/Users/YOUR_USERNAME/Desktop/CemaniHomesteadRobot/mac-camera-relay</string>
    <key>StandardOutPath</key>
    <string>/tmp/camera-relay.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/camera-relay.err</string>
</dict>
</plist>
```

Load it:
```bash
launchctl load ~/Library/LaunchAgents/com.robot.camera-relay.plist
```

### Using PM2

```bash
npm install -g pm2
pm2 start relay.js --name camera-relay
pm2 save
pm2 startup
```

## Security Notes

- Camera credentials are stored in plain text in relay.js
- Consider using environment variables for production:
  ```bash
  export CAM_USER=admin
  export CAM_PASS=YOUR_CAMERA_PASSWORD
  ```
- The HLS stream is not encrypted - use HTTPS tunnel for remote access
- VPS WebSocket connection should use WSS (WebSocket Secure) in production
