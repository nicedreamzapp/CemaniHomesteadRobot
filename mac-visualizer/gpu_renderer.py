#!/usr/bin/env python3
"""
CEMANI ROBOT - GPU-Accelerated 3D Renderer
==========================================
Uses Mac's M4 Pro GPU (Metal) to render 3D point cloud,
streams video to browsers via WebRTC/MJPEG.

Your Mac's 64GB unified memory + GPU does ALL rendering.
Browsers just display a video stream - zero GPU work.

Requirements:
    pip install open3d numpy websockets aiohttp

Usage:
    python3 gpu_renderer.py
"""

import asyncio
import json
import numpy as np
import time
import io
import threading
from pathlib import Path
from collections import deque

# Try to import Open3D for GPU rendering
try:
    import open3d as o3d
    OPEN3D_AVAILABLE = True
    print("[GPU] Open3D available - using Metal GPU acceleration")
except ImportError:
    OPEN3D_AVAILABLE = False
    print("[GPU] Open3D not installed. Run: pip install open3d")

# For video streaming
try:
    from aiohttp import web
    AIOHTTP_AVAILABLE = True
except ImportError:
    AIOHTTP_AVAILABLE = False
    print("[GPU] aiohttp not installed. Run: pip install aiohttp")

try:
    from PIL import Image
    PIL_AVAILABLE = True
except ImportError:
    PIL_AVAILABLE = False

import websockets

# Configuration
VPS_WS = "ws://72.60.124.34:3001"
RENDER_WIDTH = 1280
RENDER_HEIGHT = 720
TARGET_FPS = 30
MJPEG_PORT = 8089  # Local MJPEG stream port

# Global state
class RendererState:
    points = None  # Nx6 array [x, y, z, r, g, b]
    point_cloud = None  # Open3D point cloud
    visualizer = None
    frame_buffer = deque(maxlen=3)  # Latest rendered frames
    camera_pos = [0, 5, 5]  # Camera position
    camera_target = [0, 0, 0]  # Look at
    running = True
    last_update = 0

state = RendererState()


def create_robot_mesh():
    """Create a simple robot mesh for the scene"""
    # Simple box for robot body
    robot = o3d.geometry.TriangleMesh.create_box(0.3, 0.25, 0.4)
    robot.translate([-0.15, 0, -0.2])
    robot.paint_uniform_color([0.7, 0.7, 0.7])
    return robot


def create_ground_plane():
    """Create ground plane"""
    ground = o3d.geometry.TriangleMesh.create_box(20, 0.01, 20)
    ground.translate([-10, -0.01, -10])
    ground.paint_uniform_color([0.1, 0.12, 0.15])
    return ground


def init_visualizer():
    """Initialize Open3D offscreen visualizer"""
    if not OPEN3D_AVAILABLE:
        return None

    print(f"[GPU] Initializing {RENDER_WIDTH}x{RENDER_HEIGHT} renderer...")

    # Create offscreen renderer
    vis = o3d.visualization.rendering.OffscreenRenderer(RENDER_WIDTH, RENDER_HEIGHT)

    # Setup scene
    vis.scene.set_background([0.04, 0.04, 0.07, 1.0])  # Dark background

    # Add lighting
    vis.scene.scene.set_sun_light(
        [0.5, -1, -0.5],  # Direction
        [1, 1, 1],  # Color
        75000  # Intensity
    )
    vis.scene.scene.enable_sun_light(True)

    # Add ground plane
    ground = create_ground_plane()
    mat_ground = o3d.visualization.rendering.MaterialRecord()
    mat_ground.shader = "defaultLit"
    mat_ground.base_color = [0.1, 0.12, 0.15, 1.0]
    vis.scene.add_geometry("ground", ground, mat_ground)

    # Add robot
    robot = create_robot_mesh()
    mat_robot = o3d.visualization.rendering.MaterialRecord()
    mat_robot.shader = "defaultLit"
    mat_robot.base_color = [0.75, 0.75, 0.75, 1.0]
    vis.scene.add_geometry("robot", robot, mat_robot)

    # Create empty point cloud
    pcd = o3d.geometry.PointCloud()
    pcd.points = o3d.utility.Vector3dVector(np.zeros((1, 3)))
    pcd.colors = o3d.utility.Vector3dVector(np.ones((1, 3)) * 0.5)

    mat_points = o3d.visualization.rendering.MaterialRecord()
    mat_points.shader = "defaultUnlit"
    mat_points.point_size = 4.0
    vis.scene.add_geometry("pointcloud", pcd, mat_points)

    state.point_cloud = pcd

    # Setup camera
    vis.setup_camera(60.0, [0, 0, 0], [0, 3, 4], [0, 1, 0])

    print("[GPU] Renderer initialized with Metal acceleration")
    return vis


def update_point_cloud(points_data):
    """Update point cloud from accumulated_map data"""
    if not OPEN3D_AVAILABLE or state.visualizer is None:
        return

    if not points_data or len(points_data) == 0:
        return

    # Parse compact format [x, y, z, r, g, b]
    positions = []
    colors = []

    for p in points_data:
        if len(p) >= 6:
            # Convert coordinates (swap Y/Z for Open3D)
            x, y, z, r, g, b = p[0], p[1], p[2], p[3], p[4], p[5]
            positions.append([x, z, -y])  # Swap Y/Z, negate Y
            colors.append([r/255.0, g/255.0, b/255.0])

    if len(positions) == 0:
        return

    # Update Open3D point cloud
    pcd = o3d.geometry.PointCloud()
    pcd.points = o3d.utility.Vector3dVector(np.array(positions))
    pcd.colors = o3d.utility.Vector3dVector(np.array(colors))

    # Update in scene
    mat_points = o3d.visualization.rendering.MaterialRecord()
    mat_points.shader = "defaultUnlit"
    mat_points.point_size = 3.0

    state.visualizer.scene.remove_geometry("pointcloud")
    state.visualizer.scene.add_geometry("pointcloud", pcd, mat_points)
    state.point_cloud = pcd
    state.last_update = time.time()

    print(f"[GPU] Updated {len(positions):,} points")


def render_frame():
    """Render a frame and return as JPEG bytes"""
    if state.visualizer is None:
        return None

    try:
        # Render
        img = state.visualizer.render_to_image()

        # Convert to numpy then to JPEG
        img_np = np.asarray(img)

        if PIL_AVAILABLE:
            pil_img = Image.fromarray(img_np)
            buffer = io.BytesIO()
            pil_img.save(buffer, format='JPEG', quality=85)
            return buffer.getvalue()
        else:
            # Fallback - return raw
            return img_np.tobytes()
    except Exception as e:
        print(f"[GPU] Render error: {e}")
        return None


def render_loop():
    """Background thread for continuous rendering"""
    frame_time = 1.0 / TARGET_FPS

    while state.running:
        start = time.time()

        frame = render_frame()
        if frame:
            state.frame_buffer.append(frame)

        # Maintain target FPS
        elapsed = time.time() - start
        if elapsed < frame_time:
            time.sleep(frame_time - elapsed)


async def mjpeg_handler(request):
    """Handle MJPEG stream requests"""
    response = web.StreamResponse(
        status=200,
        reason='OK',
        headers={
            'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        }
    )
    await response.prepare(request)

    print(f"[MJPEG] Client connected from {request.remote}")

    try:
        while state.running:
            if state.frame_buffer:
                frame = state.frame_buffer[-1]  # Latest frame

                await response.write(
                    b'--frame\r\n'
                    b'Content-Type: image/jpeg\r\n\r\n' + frame + b'\r\n'
                )

            await asyncio.sleep(1.0 / TARGET_FPS)
    except Exception as e:
        print(f"[MJPEG] Client disconnected: {e}")

    return response


async def websocket_client():
    """Connect to VPS and receive point cloud updates"""
    while state.running:
        try:
            print(f"[WS] Connecting to {VPS_WS}...")
            async with websockets.connect(VPS_WS, max_size=50_000_000) as ws:
                print("[WS] Connected!")

                # Register as renderer
                await ws.send(json.dumps({
                    "type": "register_processor",
                    "name": "gpu-renderer",
                    "capabilities": ["gpu_render", "video_stream"]
                }))

                async for message in ws:
                    try:
                        data = json.loads(message)

                        if data.get("type") == "accumulated_map":
                            points = data.get("points", [])
                            if points:
                                update_point_cloud(points)

                    except json.JSONDecodeError:
                        pass
                    except Exception as e:
                        print(f"[WS] Error: {e}")

        except Exception as e:
            print(f"[WS] Connection error: {e}")
            await asyncio.sleep(3)


async def start_mjpeg_server():
    """Start MJPEG HTTP server"""
    if not AIOHTTP_AVAILABLE:
        print("[MJPEG] aiohttp not available, skipping MJPEG server")
        return

    app = web.Application()
    app.router.add_get('/stream', mjpeg_handler)
    app.router.add_get('/stream.mjpg', mjpeg_handler)

    # Simple status page
    async def index(request):
        html = f"""
        <html>
        <head><title>GPU Renderer</title></head>
        <body style="background:#111;color:#fff;font-family:monospace;">
            <h1>Cemani Robot - GPU Renderer</h1>
            <p>Mac M4 Pro GPU rendering @ {RENDER_WIDTH}x{RENDER_HEIGHT} {TARGET_FPS}fps</p>
            <p>Points: {len(state.point_cloud.points) if state.point_cloud else 0:,}</p>
            <img src="/stream.mjpg" style="max-width:100%;border:2px solid #333;">
        </body>
        </html>
        """
        return web.Response(text=html, content_type='text/html')

    app.router.add_get('/', index)

    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, '0.0.0.0', MJPEG_PORT)
    await site.start()
    print(f"[MJPEG] Server running at http://localhost:{MJPEG_PORT}/")
    print(f"[MJPEG] Stream URL: http://localhost:{MJPEG_PORT}/stream.mjpg")


async def main():
    """Main entry point"""
    print("=" * 60)
    print("  CEMANI ROBOT - GPU RENDERER")
    print("  Mac M4 Pro GPU acceleration")
    print("=" * 60)
    print()

    if not OPEN3D_AVAILABLE:
        print("ERROR: Open3D required. Install with:")
        print("  pip install open3d")
        return

    # Initialize renderer
    state.visualizer = init_visualizer()
    if state.visualizer is None:
        print("ERROR: Failed to initialize renderer")
        return

    # Start render thread
    render_thread = threading.Thread(target=render_loop, daemon=True)
    render_thread.start()
    print(f"[GPU] Render loop started @ {TARGET_FPS} FPS")

    # Load existing map if available
    map_file = Path("confirmed_walls.json")
    if map_file.exists():
        try:
            with open(map_file) as f:
                data = json.load(f)
            points = data.get("points", [])
            if points:
                # Convert from object format to compact
                compact = []
                for p in points:
                    if isinstance(p, dict):
                        compact.append([p['x'], p['y'], p['z'], p['r'], p['g'], p['b']])
                    else:
                        compact.append(p)
                update_point_cloud(compact)
                print(f"[GPU] Loaded {len(compact):,} points from {map_file}")
        except Exception as e:
            print(f"[GPU] Failed to load map: {e}")

    # Start servers
    await start_mjpeg_server()

    # Connect to VPS for live updates
    await websocket_client()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[GPU] Shutting down...")
        state.running = False
