#!/usr/bin/env python3 -u
"""
Mac Launcher Daemon
Stays connected to VPS and starts/stops GPU mapping on command from web UI.

Run this at Mac startup:
  python3 -u mac_launcher_daemon.py

Or install as a LaunchAgent for auto-start.
"""

import asyncio
import json
import subprocess
import os
import sys
import signal
import time
from pathlib import Path

# Force unbuffered output for logging
sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)

try:
    import websockets
except ImportError:
    print("Installing websockets...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "websockets"])
    import websockets

try:
    import psutil
except ImportError:
    print("Installing psutil...")
    subprocess.check_call([sys.executable, "-m", "pip", "install", "psutil"])
    import psutil

# Configuration
VPS_WS = "wss://robot.marijuanaunion.com"
SCRIPT_DIR = Path(__file__).parent.absolute()
GPU_REPORT_INTERVAL = 2  # seconds

# Mapping processes
mapping_processes = []
mapping_running = False


def get_gpu_usage():
    """Get Apple Silicon GPU usage percentage"""
    try:
        # Use powermetrics for accurate GPU usage (requires sudo for full data)
        # Fallback to estimating from process CPU usage
        gpu_percent = 0

        # Check if our mapping processes are running and estimate GPU from their activity
        for proc in mapping_processes:
            if proc and proc.poll() is None:  # Still running
                try:
                    p = psutil.Process(proc.pid)
                    cpu = p.cpu_percent(interval=0.1)
                    # MPS operations show as CPU usage in Activity Monitor
                    # Rough estimate: if process is active, GPU is being used
                    gpu_percent = max(gpu_percent, min(cpu, 100))
                except:
                    pass

        # If mapping is running, report at least some usage
        if mapping_running and gpu_percent < 5:
            gpu_percent = 15  # Minimum when active

        return int(gpu_percent)
    except Exception as e:
        print(f"[GPU] Error getting usage: {e}")
        return 0


def start_mapping():
    """Start the GPU mapping processes"""
    global mapping_processes, mapping_running

    if mapping_running:
        print("[LAUNCHER] Mapping already running")
        return True

    print("[LAUNCHER] Starting GPU mapping processes...")

    try:
        # Start hybrid_3d_mapper.py (GPU depth estimation)
        # NOTE: Don't capture stdout/stderr - let output go to daemon's log
        # (capturing with PIPE but not reading causes subprocess to block!)
        hybrid_script = SCRIPT_DIR / "hybrid_3d_mapper.py"
        if hybrid_script.exists():
            proc1 = subprocess.Popen(
                [sys.executable, "-u", str(hybrid_script)],
                cwd=str(SCRIPT_DIR)
            )
            mapping_processes.append(proc1)
            print(f"[LAUNCHER] Started hybrid_3d_mapper.py (PID {proc1.pid})")
        else:
            print(f"[LAUNCHER] WARNING: {hybrid_script} not found")

        # Start semantic_mapper.py (plane detection)
        semantic_script = SCRIPT_DIR / "semantic_mapper.py"
        if semantic_script.exists():
            proc2 = subprocess.Popen(
                [sys.executable, "-u", str(semantic_script)],
                cwd=str(SCRIPT_DIR)
            )
            mapping_processes.append(proc2)
            print(f"[LAUNCHER] Started semantic_mapper.py (PID {proc2.pid})")
        else:
            print(f"[LAUNCHER] WARNING: {semantic_script} not found")

        mapping_running = True
        print("[LAUNCHER] GPU mapping started!")
        return True

    except Exception as e:
        print(f"[LAUNCHER] Error starting mapping: {e}")
        return False


def stop_mapping():
    """Stop all mapping processes"""
    global mapping_processes, mapping_running

    print("[LAUNCHER] Stopping GPU mapping processes...")

    for proc in mapping_processes:
        try:
            if proc and proc.poll() is None:
                proc.terminate()
                proc.wait(timeout=5)
                print(f"[LAUNCHER] Stopped process {proc.pid}")
        except subprocess.TimeoutExpired:
            proc.kill()
            print(f"[LAUNCHER] Killed process {proc.pid}")
        except Exception as e:
            print(f"[LAUNCHER] Error stopping process: {e}")

    mapping_processes = []
    mapping_running = False
    print("[LAUNCHER] GPU mapping stopped")
    return True


def check_processes():
    """Check if mapping processes are still running"""
    global mapping_running

    if not mapping_processes:
        mapping_running = False
        return False

    # Check if any process is still alive
    alive = False
    for proc in mapping_processes:
        if proc and proc.poll() is None:
            alive = True
            break

    mapping_running = alive
    return alive


async def send_status(ws, status, gpu_percent=0, message=""):
    """Send status update to VPS"""
    try:
        msg = {
            "type": "mac_status",
            "status": status,  # "idle", "starting", "running", "stopping", "error"
            "gpu_percent": gpu_percent,
            "message": message
        }
        await ws.send(json.dumps(msg))
    except Exception as e:
        print(f"[WS] Error sending status: {e}")


async def gpu_reporter(ws):
    """Periodically report GPU usage"""
    while True:
        try:
            check_processes()
            gpu = get_gpu_usage()
            status = "running" if mapping_running else "idle"
            await send_status(ws, status, gpu)
        except Exception as e:
            print(f"[GPU] Reporter error: {e}")
        await asyncio.sleep(GPU_REPORT_INTERVAL)


async def handle_messages(ws):
    """Handle incoming commands from VPS"""
    async for message in ws:
        try:
            data = json.loads(message)
            msg_type = data.get("type", "")

            if msg_type == "mac_control":
                cmd = data.get("cmd", "")
                print(f"[LAUNCHER] Received command: {cmd}")

                if cmd == "start":
                    await send_status(ws, "starting", 0, "Initializing GPU mapping...")
                    success = start_mapping()
                    if success:
                        await asyncio.sleep(3)  # Give processes time to start
                        await send_status(ws, "running", 15, "GPU mapping active")
                    else:
                        await send_status(ws, "error", 0, "Failed to start mapping")

                elif cmd == "stop":
                    await send_status(ws, "stopping", 0, "Shutting down...")
                    stop_mapping()
                    await send_status(ws, "idle", 0, "GPU mapping stopped")

                elif cmd == "status":
                    check_processes()
                    gpu = get_gpu_usage()
                    status = "running" if mapping_running else "idle"
                    await send_status(ws, status, gpu)

            # Ignore other message types (lidar, telemetry, etc)

        except json.JSONDecodeError:
            pass
        except Exception as e:
            print(f"[WS] Error handling message: {e}")


async def connect_to_vps():
    """Connect to VPS and maintain connection"""
    while True:
        try:
            print(f"[WS] Connecting to {VPS_WS}...")

            async with websockets.connect(
                VPS_WS,
                max_size=10_000_000,
                ping_interval=30,
                ping_timeout=10
            ) as ws:

                # Register as Mac launcher
                await ws.send(json.dumps({
                    "type": "register_mac_launcher",
                    "name": "mac-gpu-mapper"
                }))
                print("[WS] Connected and registered as mac_launcher")

                # Send initial status
                check_processes()
                gpu = get_gpu_usage()
                status = "running" if mapping_running else "idle"
                await send_status(ws, status, gpu, "Mac launcher connected")

                # Run message handler and GPU reporter concurrently
                await asyncio.gather(
                    handle_messages(ws),
                    gpu_reporter(ws)
                )

        except websockets.exceptions.ConnectionClosed as e:
            print(f"[WS] Connection closed: {e}")
        except Exception as e:
            print(f"[WS] Connection error: {e}")

        print("[WS] Reconnecting in 5 seconds...")
        await asyncio.sleep(5)


def signal_handler(sig, frame):
    """Handle Ctrl+C"""
    print("\n[LAUNCHER] Shutting down...")
    stop_mapping()
    sys.exit(0)


def main():
    print("=" * 60)
    print("  MAC LAUNCHER DAEMON")
    print("  Controls GPU mapping from web UI")
    print("=" * 60)
    print(f"  VPS: {VPS_WS}")
    print(f"  Scripts: {SCRIPT_DIR}")
    print("=" * 60)
    print("\nPress Ctrl+C to stop\n")

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    asyncio.run(connect_to_vps())


if __name__ == "__main__":
    main()
