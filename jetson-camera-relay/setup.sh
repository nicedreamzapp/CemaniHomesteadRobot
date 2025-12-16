#!/bin/bash
# Jetson Camera Relay Setup Script
# Run this on the Jetson Orin Nano Super

echo "=================================="
echo "  Jetson Camera Relay Setup"
echo "=================================="

# Check if running on Jetson
if [ ! -f /etc/nv_tegra_release ]; then
    echo "WARNING: This doesn't appear to be a Jetson device"
    echo "Continuing anyway..."
fi

# Install dependencies
echo ""
echo "[1/4] Installing system dependencies..."
sudo apt update
sudo apt install -y ffmpeg nodejs npm

# Check ffmpeg
echo ""
echo "[2/4] Checking FFmpeg..."
ffmpeg -version | head -1

# Check node
echo ""
echo "[3/4] Checking Node.js..."
node --version
npm --version

# Install npm dependencies
echo ""
echo "[4/4] Installing npm packages..."
npm install

echo ""
echo "=================================="
echo "  Setup Complete!"
echo "=================================="
echo ""
echo "Next steps:"
echo "1. Make sure config.json has the right camera IPs"
echo "2. Run: node relay.js"
echo "3. Or set up as a systemd service (see README)"
echo ""
