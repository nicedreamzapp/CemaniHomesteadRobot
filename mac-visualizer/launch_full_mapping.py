#!/usr/bin/env python3
"""
╔══════════════════════════════════════════════════════════════════════════════╗
║                    CEMANI HOMESTEAD ROBOT                                     ║
║                    Full 4D Mapping System                                     ║
║                                                                               ║
║  Hardware: Mac Mini Pro M4 (64GB) + Jetson Orin + Custom Robot Platform      ║
║  Sensors: 2x PTZ Cameras, 360° LIDAR, 4x Ultrasonic, Compass, Encoders       ║
║  Processing: Depth Anything V2 Large, Semantic Segmentation, SLAM            ║
╚══════════════════════════════════════════════════════════════════════════════╝

This launcher orchestrates all mapping subsystems:

  1. DEPTH ENGINE - Monocular depth estimation using Depth Anything V2 Large
                    Running on Apple Silicon GPU (MPS) with 64GB unified memory
                    Processes both PTZ camera feeds at 2 FPS for dense point clouds

  2. SEMANTIC MAPPER - RANSAC plane detection for walls/floor/ceiling
                       Projects Jetson 2D detections into 3D world coordinates
                       Builds room layout with furniture zones and doorways

  3. 3D RECONSTRUCTION - Open3D point cloud fusion with voxel grid downsampling
                         ICP alignment for multi-view registration
                         Textured mesh generation with vertex colors

  4. PTZ COORDINATOR - Automated camera sweep patterns for full room coverage
                       3x120° robot rotation with synchronized camera pans
                       Optimal viewpoint selection for maximum map coverage

  5. LIDAR FUSION - 360° 2D LIDAR integrated with depth-based 3D points
                    Fingerprint-based relocalization for loop closure
                    Dead reckoning with encoder odometry correction

Output: Real-time 4D visualization (3D + time) in browser at robot.marijuanaunion.com
        Persistent map storage with semantic labels and object tracking

Usage:
    python3 launch_full_mapping.py

Press MAP 1 in the UI to start the full room scan sequence.
"""

import asyncio
import subprocess
import sys
import os
import signal
import time
import platform
from pathlib import Path
from datetime import datetime

# ANSI colors for terminal output
class Colors:
    HEADER = '\033[95m'
    BLUE = '\033[94m'
    CYAN = '\033[96m'
    GREEN = '\033[92m'
    YELLOW = '\033[93m'
    RED = '\033[91m'
    BOLD = '\033[1m'
    DIM = '\033[2m'
    RESET = '\033[0m'

SCRIPT_DIR = Path(__file__).parent.absolute()

# All subsystems to launch
SUBSYSTEMS = [
    {
        "name": "Hybrid 3D Mapper",
        "script": "hybrid_3d_mapper.py",
        "description": "Depth Anything V2 Large + 3D Point Cloud Builder",
        "gpu": True,
        "priority": 1
    },
    {
        "name": "Semantic Mapper",
        "script": "semantic_mapper.py",
        "description": "Plane Detection + Object Labeling + Room Layout",
        "gpu": False,
        "priority": 2
    }
]

processes = []
start_time = None

def print_banner():
    """Print impressive startup banner"""
    print(f"""{Colors.CYAN}{Colors.BOLD}
╔══════════════════════════════════════════════════════════════════════════════╗
║                                                                              ║
║   ██████╗███████╗███╗   ███╗ █████╗ ███╗   ██╗██╗                            ║
║  ██╔════╝██╔════╝████╗ ████║██╔══██╗████╗  ██║██║                            ║
║  ██║     █████╗  ██╔████╔██║███████║██╔██╗ ██║██║                            ║
║  ██║     ██╔══╝  ██║╚██╔╝██║██╔══██║██║╚██╗██║██║                            ║
║  ╚██████╗███████╗██║ ╚═╝ ██║██║  ██║██║ ╚████║██║                            ║
║   ╚═════╝╚══════╝╚═╝     ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚═╝                            ║
║                                                                              ║
║                    HOMESTEAD ROBOT - 4D MAPPING SYSTEM                       ║
║                                                                              ║
╚══════════════════════════════════════════════════════════════════════════════╝
{Colors.RESET}""")

def print_system_info():
    """Display system hardware information"""
    print(f"\n{Colors.BOLD}═══ SYSTEM HARDWARE ═══{Colors.RESET}\n")

    # Platform info
    print(f"  {Colors.CYAN}Platform:{Colors.RESET}    {platform.system()} {platform.machine()}")
    print(f"  {Colors.CYAN}Processor:{Colors.RESET}   {platform.processor() or 'Apple Silicon'}")

    # Check GPU
    gpu_status = "CPU (fallback)"
    gpu_color = Colors.YELLOW
    try:
        import torch
        if torch.backends.mps.is_available():
            gpu_status = "Apple Silicon GPU (MPS) - ACTIVE"
            gpu_color = Colors.GREEN
            # Get GPU memory
            try:
                import subprocess
                result = subprocess.run(['sysctl', '-n', 'hw.memsize'], capture_output=True, text=True)
                mem_bytes = int(result.stdout.strip())
                mem_gb = mem_bytes / (1024**3)
                gpu_status += f" [{mem_gb:.0f}GB Unified Memory]"
            except:
                pass
        elif torch.cuda.is_available():
            gpu_status = f"NVIDIA CUDA ({torch.cuda.get_device_name(0)})"
            gpu_color = Colors.GREEN
    except ImportError:
        gpu_status = "PyTorch not installed!"
        gpu_color = Colors.RED

    print(f"  {Colors.CYAN}GPU:{Colors.RESET}         {gpu_color}{gpu_status}{Colors.RESET}")

    # Check key dependencies
    print(f"\n{Colors.BOLD}═══ AI MODELS ═══{Colors.RESET}\n")

    deps = [
        ("Depth Anything V2 Large", "transformers", "Monocular depth estimation"),
        ("Open3D", "open3d", "3D point cloud processing"),
        ("NumPy", "numpy", "Numerical computing"),
        ("OpenCV", "cv2", "Image processing"),
        ("scikit-learn", "sklearn", "RANSAC plane detection"),
    ]

    for name, module, desc in deps:
        try:
            __import__(module)
            status = f"{Colors.GREEN}✓ READY{Colors.RESET}"
        except ImportError:
            status = f"{Colors.RED}✗ MISSING{Colors.RESET}"
        print(f"  {status}  {name:25} - {Colors.DIM}{desc}{Colors.RESET}")

    print()

def print_subsystems():
    """Display subsystems to be launched"""
    print(f"{Colors.BOLD}═══ MAPPING SUBSYSTEMS ═══{Colors.RESET}\n")

    for i, sys in enumerate(SUBSYSTEMS, 1):
        gpu_badge = f"{Colors.GREEN}[GPU]{Colors.RESET}" if sys['gpu'] else f"{Colors.BLUE}[CPU]{Colors.RESET}"
        print(f"  {Colors.CYAN}{i}.{Colors.RESET} {sys['name']:20} {gpu_badge}")
        print(f"     {Colors.DIM}{sys['description']}{Colors.RESET}")

    print()

def signal_handler(sig, frame):
    """Handle Ctrl+C gracefully"""
    elapsed = time.time() - start_time if start_time else 0
    print(f"\n\n{Colors.YELLOW}═══ SHUTTING DOWN ═══{Colors.RESET}")
    print(f"{Colors.DIM}Session duration: {elapsed:.1f} seconds{Colors.RESET}\n")

    for proc, name in processes:
        try:
            proc.terminate()
            print(f"  {Colors.RED}■{Colors.RESET} Stopped: {name}")
        except:
            pass

    print(f"\n{Colors.GREEN}All subsystems stopped cleanly.{Colors.RESET}")
    print(f"{Colors.CYAN}Map data saved to: mac-visualizer/confirmed_walls.json{Colors.RESET}\n")
    sys.exit(0)

async def launch_subsystem(subsystem):
    """Launch a mapping subsystem"""
    script_path = SCRIPT_DIR / subsystem["script"]

    if not script_path.exists():
        print(f"  {Colors.RED}✗{Colors.RESET} {subsystem['name']}: Script not found!")
        return None

    print(f"  {Colors.GREEN}▶{Colors.RESET} Launching: {Colors.BOLD}{subsystem['name']}{Colors.RESET}")

    proc = await asyncio.create_subprocess_exec(
        sys.executable, str(script_path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        cwd=str(SCRIPT_DIR)
    )

    processes.append((proc, subsystem['name']))
    return proc

async def stream_output(proc, name):
    """Stream and prefix output from subsystem"""
    # Create short prefix from name
    prefix = name.split()[0].upper()[:6]

    try:
        async for line in proc.stdout:
            text = line.decode().rstrip()
            if text:
                # Color code based on content
                if 'error' in text.lower() or 'exception' in text.lower():
                    color = Colors.RED
                elif 'warning' in text.lower() or 'warn' in text.lower():
                    color = Colors.YELLOW
                elif 'connected' in text.lower() or 'ready' in text.lower() or 'started' in text.lower():
                    color = Colors.GREEN
                elif 'gpu' in text.lower() or 'mps' in text.lower() or 'cuda' in text.lower():
                    color = Colors.CYAN
                else:
                    color = Colors.RESET

                print(f"{Colors.DIM}[{prefix}]{Colors.RESET} {color}{text}{Colors.RESET}")
    except Exception as e:
        pass

async def main():
    global start_time
    start_time = time.time()

    # Clear screen and print banner
    os.system('clear' if os.name != 'nt' else 'cls')
    print_banner()
    print_system_info()
    print_subsystems()

    # Setup signal handlers
    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    print(f"{Colors.BOLD}═══ LAUNCHING SUBSYSTEMS ═══{Colors.RESET}\n")

    # Sort by priority and launch
    sorted_systems = sorted(SUBSYSTEMS, key=lambda x: x['priority'])
    tasks = []

    for subsystem in sorted_systems:
        proc = await launch_subsystem(subsystem)
        if proc:
            tasks.append(stream_output(proc, subsystem['name']))
        await asyncio.sleep(2)  # Stagger launches for cleaner output

    print(f"\n{Colors.GREEN}{Colors.BOLD}═══ ALL SYSTEMS ONLINE ═══{Colors.RESET}")
    print(f"\n{Colors.CYAN}📡 Connected to: robot.marijuanaunion.com")
    print(f"🗺️  Map storage: mac-visualizer/confirmed_walls.json")
    print(f"🎮 Control: Press MAP 1 in web UI to start room scan{Colors.RESET}")
    print(f"\n{Colors.DIM}Press Ctrl+C to stop all subsystems{Colors.RESET}")
    print(f"\n{'─' * 70}\n")

    # Stream all outputs
    if tasks:
        await asyncio.gather(*tasks)

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
