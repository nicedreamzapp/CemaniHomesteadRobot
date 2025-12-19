# Claude Code on Jetson - Sync Instructions

**This file helps Claude Code on the Jetson stay in sync with Mac and GitHub.**

## Network Info

| Device | IP Address | User | Role |
|--------|------------|------|------|
| Mac Mini | 192.168.1.X | matthewmacosko | Development machine |
| Jetson Orin Nano | 192.168.1.31 | jetson | Robot's AI brain |
| VPS Server | 72.60.124.34 | root | Remote command center |

## Quick Sync Commands

### Pull latest from GitHub (most common)
```bash
cd ~/jetson-camera-relay && git pull origin main
```

### Push Jetson changes to GitHub
```bash
cd ~/jetson-camera-relay
git add -A
git commit -m "Update from Jetson"
git push origin main
```

### Restart the camera relay after updates
```bash
pkill -f "node relay.js"
cd ~/jetson-camera-relay && nohup node relay.js > /tmp/relay.log 2>&1 &
```

### Check relay status
```bash
pgrep -a node | grep relay
tail -20 /tmp/relay.log
```

## Talking to Mac

The Mac can SSH to Jetson:
```bash
# From Mac:
ssh jetson@192.168.1.31
```

The Jetson can SSH to Mac (if needed):
```bash
# From Jetson (may need Mac's IP):
ssh matthewmacosko@192.168.1.X
```

## File Locations

| Purpose | Jetson Path | Mac Path |
|---------|-------------|----------|
| Camera Relay | ~/jetson-camera-relay/ | ~/Desktop/CemaniHomesteadRobot/jetson-camera-relay/ |
| Music Files | ~/music/ | ~/Desktop/CemaniHomesteadRobot/ |
| Relay Logs | /tmp/relay.log | N/A |

## Git Workflow

```
┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐
│   Mac Mini      │ ◄─────► │     GitHub      │ ◄─────► │  Jetson Nano    │
│  (Development)  │  push   │   (Central)     │  pull   │   (On Robot)    │
│                 │  pull   │                 │  push   │                 │
└─────────────────┘         └─────────────────┘         └─────────────────┘
```

**Always sync through GitHub:**
1. Mac pushes changes → GitHub
2. Jetson pulls from GitHub
3. Or: Jetson pushes → GitHub → Mac pulls

## V380 Camera Commands

Test the V380 speaker:
```bash
cd ~/jetson-camera-relay
node v380-talk.js beep 20      # Quick beep at 20% volume
node v380-talk.js alert 30     # Two-tone alert
node v380-play.js ~/music/Chrome_Sparks_-_Send_the_Pain_On.mp3 15  # Play song at 15%
```

## Common Issues

**Relay not starting?**
```bash
# Check if port is in use
lsof -i :8800
# Kill old processes
pkill -9 -f "node relay"
```

**Camera not streaming?**
```bash
# Check ffmpeg processes
pgrep -a ffmpeg
# Check camera IPs in config
cat ~/jetson-camera-relay/config.json
```

**Git push rejected?**
```bash
git pull --rebase origin main
git push origin main
```
