#!/bin/bash
# MAP 1 Full System Launcher - ONE CLICK TO START EVERYTHING

set -e
cd /Users/matthewmacosko/Desktop/CemaniHomesteadRobot

echo "=========================================="
echo "  MAP 1 SYSTEM LAUNCHER"
echo "=========================================="

# Step 1: Deploy to VPS
echo ""
echo "[1/4] Deploying code to VPS server..."
scp -q vps-server/server.js vps-server/server-odometry.js root@72.60.124.34:/opt/robot-server/
scp -q vps-server/public/index.html root@72.60.124.34:/opt/robot-server/public/
scp -q vps-server/public/js/websocket.js vps-server/public/js/lidar3d.js root@72.60.124.34:/opt/robot-server/public/js/
echo "    Done!"

# Step 2: Restart VPS server
echo ""
echo "[2/4] Restarting VPS server..."
ssh root@72.60.124.34 "pm2 restart robot"
echo "    Done!"

# Step 3: Start LIDAR relay on Jetson
echo ""
echo "[3/4] Starting LIDAR relay on Jetson..."
sshpass -p 'jetson' ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 jetson@192.168.1.31 "pkill -f 'lidar_relay\|ydlidar' 2>/dev/null; sleep 1; cd ~/jetson-lidar && nohup python3 -u lidar_relay.py > /tmp/lidar.log 2>&1 &" 2>/dev/null || echo "    (Jetson not reachable - skip)"
echo "    Done!"

# Step 4: Start Mac processor
echo ""
echo "[4/4] Starting Mac GPU processor..."
pkill -f "hybrid_3d_mapper.py" 2>/dev/null || true
pkill -f "semantic_mapper.py" 2>/dev/null || true
sleep 1

cd mac-visualizer
python3 hybrid_3d_mapper.py &
MAC_PID=$!

echo ""
echo "=========================================="
echo "  READY! Click MAP 1 in your browser"
echo "=========================================="
echo ""
echo "Press Ctrl+C to stop"
echo ""

wait $MAC_PID
