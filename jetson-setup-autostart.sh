#!/bin/bash
# ============================================
# CEMANI ROBOT - JETSON AUTO-START SETUP
# Run this ONCE on the Jetson to enable all services on boot
# ============================================

set -e

echo "============================================"
echo "  Cemani Robot - Jetson Auto-Start Setup"
echo "============================================"
echo ""

# Get the current user (for service files)
JETSON_USER=$(whoami)
echo "Setting up services for user: $JETSON_USER"

# Detect home directory
if [ -d "/home/nvidia" ]; then
    HOME_DIR="/home/nvidia"
elif [ -d "/home/jetson" ]; then
    HOME_DIR="/home/jetson"
else
    HOME_DIR="$HOME"
fi
echo "Home directory: $HOME_DIR"
echo ""

# 1. Enable SSH for remote access
echo "[1/5] Enabling SSH for remote access..."
sudo systemctl enable ssh 2>/dev/null || true
sudo systemctl start ssh 2>/dev/null || true
echo "  SSH enabled"

# 2. Create LIDAR relay service
echo "[2/5] Creating LIDAR relay service..."
sudo tee /etc/systemd/system/robot-lidar.service > /dev/null << EOF
[Unit]
Description=Cemani Robot LIDAR Relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$JETSON_USER
WorkingDirectory=$HOME_DIR/jetson-lidar
ExecStart=/usr/bin/python3 $HOME_DIR/jetson-lidar/lidar_relay.py
Restart=always
RestartSec=5
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
EOF
echo "  robot-lidar.service created"

# 3. Create object detection service
echo "[3/5] Creating object detection service..."
sudo tee /etc/systemd/system/robot-detection.service > /dev/null << EOF
[Unit]
Description=Cemani Robot Object Detection (YOLOv8)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$JETSON_USER
WorkingDirectory=$HOME_DIR/jetson-object-detection
ExecStart=/usr/bin/python3 $HOME_DIR/jetson-object-detection/detect.py
Restart=always
RestartSec=5
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
EOF
echo "  robot-detection.service created"

# 4. Create camera relay service
echo "[4/5] Creating camera relay service..."
sudo tee /etc/systemd/system/robot-camera.service > /dev/null << EOF
[Unit]
Description=Cemani Robot Camera Relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$JETSON_USER
WorkingDirectory=$HOME_DIR/jetson-camera-relay
ExecStart=/usr/bin/node $HOME_DIR/jetson-camera-relay/relay.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
echo "  robot-camera.service created"

# 5. Enable and start all services
echo "[5/5] Enabling and starting all services..."
sudo systemctl daemon-reload

# Enable on boot
sudo systemctl enable robot-lidar robot-detection robot-camera
echo "  Services enabled for boot"

# Start now
sudo systemctl start robot-lidar || echo "  Warning: robot-lidar failed to start (check if lidar_relay.py exists)"
sudo systemctl start robot-detection || echo "  Warning: robot-detection failed to start (check if detect.py exists)"
sudo systemctl start robot-camera || echo "  Warning: robot-camera failed to start (check if relay.js exists)"

echo ""
echo "============================================"
echo "  Setup Complete!"
echo "============================================"
echo ""
echo "Services will now auto-start on boot!"
echo ""
echo "Check status:"
echo "  sudo systemctl status robot-lidar"
echo "  sudo systemctl status robot-detection"
echo "  sudo systemctl status robot-camera"
echo ""
echo "View logs:"
echo "  journalctl -u robot-lidar -f"
echo "  journalctl -u robot-detection -f"
echo "  journalctl -u robot-camera -f"
echo ""
echo "SSH is now enabled - you can manage remotely!"
echo ""
