#!/bin/bash
# Setup script for YOLOv8 Object Detection on Jetson Orin

echo "=========================================="
echo "  Cemani Robot - YOLOv8 Object Detection"
echo "  Setup for Jetson Orin"
echo "=========================================="

# Check if running on Jetson
if [ ! -f /etc/nv_tegra_release ]; then
    echo "Warning: This doesn't appear to be a Jetson device"
    echo "Continuing anyway..."
fi

# Update package list
echo "[1/5] Updating package list..."
sudo apt update

# Install system dependencies
echo "[2/5] Installing system dependencies..."
sudo apt install -y python3-pip python3-opencv libopencv-dev ffmpeg

# Install Python packages
echo "[3/5] Installing Python packages..."
pip3 install --upgrade pip
pip3 install ultralytics opencv-python-headless websockets numpy

# Download YOLOv8 OIV7 model if not present
echo "[4/5] Checking for YOLOv8 OIV7 model..."
if [ ! -f "yolov8n-oiv7.pt" ]; then
    echo "Downloading YOLOv8 OIV7 model (601 classes)..."
    # The ultralytics library will auto-download on first use
    python3 -c "from ultralytics import YOLO; YOLO('yolov8n-oiv7.pt')"
fi

# Create systemd service
echo "[5/5] Creating systemd service..."
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

sudo tee /etc/systemd/system/robot-detection.service > /dev/null << EOF
[Unit]
Description=Cemani Robot Object Detection
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$SCRIPT_DIR
ExecStart=/usr/bin/python3 $SCRIPT_DIR/detect_cameras.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

echo ""
echo "=========================================="
echo "  Setup complete!"
echo "=========================================="
echo ""
echo "To start object detection:"
echo "  python3 detect_cameras.py"
echo ""
echo "To run as a service:"
echo "  sudo systemctl enable robot-detection"
echo "  sudo systemctl start robot-detection"
echo ""
echo "To view service logs:"
echo "  journalctl -u robot-detection -f"
echo ""
