#!/bin/bash
# ============================================
# CEMANI ROBOT - 3D DEPTH PROCESSOR LAUNCHER
# Double-click to start the hybrid 3D mapping
# ============================================

cd "$(dirname "$0")"

echo "=========================================="
echo "  CEMANI ROBOT - 3D DEPTH PROCESSOR"
echo "  Mac Mini M4 Pro - Hybrid 3D Mapping"
echo "=========================================="
echo ""

# Check if already running
if pgrep -f "depth_processor.py" > /dev/null; then
    echo "[!] Depth processor is already running!"
    echo "    Use 'pkill -f depth_processor.py' to stop it first"
    echo ""
    read -p "Press Enter to exit..."
    exit 1
fi

# Check Python and dependencies
echo "[1/3] Checking Python environment..."
if ! command -v python3 &> /dev/null; then
    echo "[ERROR] Python3 not found! Please install Python 3.10+"
    read -p "Press Enter to exit..."
    exit 1
fi

echo "[2/3] Checking dependencies..."
python3 -c "import torch; import transformers; import websockets" 2>/dev/null
if [ $? -ne 0 ]; then
    echo "[!] Missing dependencies. Installing..."
    pip3 install torch transformers websockets pillow numpy
fi

echo "[3/3] Starting depth processor..."
echo ""
echo "Connecting to VPS at ws://72.60.124.34:3001"
echo "Press Ctrl+C to stop"
echo ""

# Run the processor
python3 depth_processor.py

echo ""
echo "Depth processor stopped."
read -p "Press Enter to close..."
