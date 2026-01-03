#!/bin/bash
#
# CEMANI ROBOT - 3D Mapper Setup Script
# For Mac Mini M4 Pro with GPU acceleration
#

echo "=========================================="
echo "  CEMANI ROBOT - 3D Mapper Setup"
echo "  Mac Mini M4 Pro (Apple Silicon)"
echo "=========================================="
echo

# Check Python
echo "[1/5] Checking Python..."
if command -v python3 &> /dev/null; then
    PYTHON_VERSION=$(python3 --version)
    echo "  Found: $PYTHON_VERSION"
else
    echo "  ERROR: Python 3 not found!"
    echo "  Install with: brew install python@3.12"
    exit 1
fi

# Check pip
echo
echo "[2/5] Checking pip..."
if python3 -m pip --version &> /dev/null; then
    echo "  Found pip"
else
    echo "  Installing pip..."
    python3 -m ensurepip --upgrade
fi

# Install core dependencies
echo
echo "[3/5] Installing core dependencies..."
python3 -m pip install --upgrade pip
python3 -m pip install numpy pillow websockets

# Install ML dependencies for depth estimation
echo
echo "[4/5] Installing ML dependencies (for monocular depth)..."
echo "  This may take a few minutes on first install..."
python3 -m pip install torch torchvision
python3 -m pip install transformers accelerate

# Check MPS (Apple Silicon GPU) support
echo
echo "[5/5] Checking GPU support..."
python3 -c "
import torch
print(f'  PyTorch version: {torch.__version__}')
if torch.backends.mps.is_available():
    print('  Apple Silicon GPU (MPS): AVAILABLE')
    print('  GPU will be used for depth estimation!')
else:
    print('  Apple Silicon GPU: Not available, using CPU')
"

# Install optional dependencies
echo
echo "=========================================="
echo "  Optional Dependencies"
echo "=========================================="
echo

echo "Installing OpenCV for stereo depth..."
python3 -m pip install opencv-python

echo
echo "Installing Open3D for surface reconstruction..."
python3 -m pip install open3d || echo "  (Open3D install failed - surface reconstruction disabled)"

# COLMAP (optional, for full reconstruction)
echo
echo "For FULL photorealistic reconstruction (Gaussian Splatting):"
echo "  brew install colmap"
echo "  pip install nerfstudio"
echo "  (This is optional - the hybrid mapper works without it)"

# Create launchd service for auto-start
echo
echo "=========================================="
echo "  Setup Complete!"
echo "=========================================="
echo
echo "To run the 3D mapper manually:"
echo "  cd $(dirname $0)"
echo "  python3 hybrid_3d_mapper.py"
echo
echo "To run in background:"
echo "  nohup python3 hybrid_3d_mapper.py > mapper.log 2>&1 &"
echo

# Test the installation
echo "Testing installation..."
python3 -c "
import sys
print()
print('Dependency Check:')
try:
    import numpy; print('  numpy: OK')
except: print('  numpy: MISSING')

try:
    import PIL; print('  pillow: OK')
except: print('  pillow: MISSING')

try:
    import websockets; print('  websockets: OK')
except: print('  websockets: MISSING')

try:
    import torch
    import transformers
    print('  torch+transformers: OK (depth estimation enabled)')
except: print('  torch/transformers: MISSING (depth estimation disabled)')

try:
    import cv2; print('  opencv: OK (stereo depth enabled)')
except: print('  opencv: MISSING (stereo depth disabled)')

try:
    import open3d; print('  open3d: OK (surface reconstruction enabled)')
except: print('  open3d: MISSING (surface reconstruction disabled)')
print()
"

echo "Ready to run: python3 hybrid_3d_mapper.py"
