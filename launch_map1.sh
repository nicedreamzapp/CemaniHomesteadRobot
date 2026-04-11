#!/bin/bash
# MAP 1 Full System Launcher - ONE CLICK TO START EVERYTHING
#
# Before running this, set the following env vars (or edit the defaults below):
#   VPS_HOST      — user@host for your VPS server running pm2 (e.g. root@1.2.3.4)
#   JETSON_HOST   — user@host for your Jetson Orin Nano     (e.g. jetson@192.168.1.31)
#
# Set up SSH key authentication for both hosts first so this script doesn't
# need a hardcoded password. (The original version of this file shipped with
# `sshpass -p 'jetson'`, which is NVIDIA's default Jetson password — never
# leave that pattern in a repo, and never leave the default Jetson password
# in production either.)

set -e
cd "$(cd "$(dirname "$0")" && pwd)"

VPS_HOST="${VPS_HOST:-root@YOUR_VPS_IP}"
JETSON_HOST="${JETSON_HOST:-jetson@YOUR_JETSON_IP}"

echo "=========================================="
echo "  MAP 1 SYSTEM LAUNCHER"
echo "=========================================="

# Step 1: Deploy to VPS
echo ""
echo "[1/4] Deploying code to VPS server..."
scp -q vps-server/server.js vps-server/server-odometry.js "$VPS_HOST:/opt/robot-server/"
scp -q vps-server/public/index.html "$VPS_HOST:/opt/robot-server/public/"
scp -q vps-server/public/js/websocket.js vps-server/public/js/lidar3d.js "$VPS_HOST:/opt/robot-server/public/js/"
echo "    Done!"

# Step 2: Restart VPS server
echo ""
echo "[2/4] Restarting VPS server..."
ssh "$VPS_HOST" "pm2 restart robot"
echo "    Done!"

# Step 3: Start LIDAR relay on Jetson
echo ""
echo "[3/4] Starting LIDAR relay on Jetson..."
ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 "$JETSON_HOST" "pkill -f 'lidar_relay\|ydlidar' 2>/dev/null; sleep 1; cd ~/jetson-lidar && nohup python3 -u lidar_relay.py > /tmp/lidar.log 2>&1 &" 2>/dev/null || echo "    (Jetson not reachable - skip)"
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
