#!/bin/bash
# CEMANI HOMESTEAD ROBOT - 4D Mapping System Launcher
# Double-click to start all mapping subsystems

cd "$(dirname "$0")"

echo ""
echo "Starting Cemani 4D Mapping System..."
echo ""

# Run the full mapping launcher
python3 launch_full_mapping.py

# Keep terminal open on error
read -p "Press Enter to close..."
