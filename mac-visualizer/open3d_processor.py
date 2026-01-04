#!/usr/bin/env python3
"""
Open3D 3D Mesh Processor for CEMANI Robot
==========================================
Loads confirmed wall points from hybrid_3d_mapper.py and creates
a Poisson surface reconstruction mesh for visualization.

Usage:
    python3.11 open3d_processor.py          # One-time processing
    python3.11 open3d_processor.py --live   # Live updating mode
    python3.11 open3d_processor.py --pcd    # View point cloud only (faster)

Requirements:
    pip install open3d  (requires Python 3.11 or earlier)
"""

import open3d as o3d
import numpy as np
import json
import os
import sys
import time
import argparse

# Configuration
POINTS_FILE = "confirmed_walls.json"
OUTPUT_MESH = "confirmed_walls.ply"
OUTPUT_PCD = "confirmed_walls_pcd.ply"

# Reconstruction parameters
POISSON_DEPTH = 9  # Higher = more detail but slower (8-11 typical)
OUTLIER_NB_NEIGHBORS = 20  # For statistical outlier removal
OUTLIER_STD_RATIO = 2.0  # Points > 2 std dev from mean are removed
NORMAL_RADIUS = 0.1  # Search radius for normal estimation
NORMAL_MAX_NN = 30  # Max neighbors for normal estimation


def load_points(filepath=POINTS_FILE, retries=5, retry_delay=1.0):
    """
    Load points from confirmed_walls.json with retry logic.

    The file may be corrupted mid-read if hybrid_3d_mapper.py is writing to it.
    We retry a few times with delay to handle race conditions.
    """
    if not os.path.exists(filepath):
        raise FileNotFoundError(f"Points file not found: {filepath}")

    last_error = None
    for attempt in range(retries):
        try:
            # Get file size to detect partial writes
            file_size = os.path.getsize(filepath)

            with open(filepath, 'r') as f:
                content = f.read()

            # Check if file ends properly (valid JSON should end with }] or similar)
            if not content.strip().endswith('}'):
                raise json.JSONDecodeError("File appears truncated", content, len(content))

            data = json.loads(content)
            points = data.get('points', [])

            if attempt > 0:
                print(f"[LOAD] Loaded {len(points):,} points (after {attempt + 1} attempts)")
            else:
                print(f"[LOAD] Loaded {len(points):,} points")

            return points

        except (json.JSONDecodeError, ValueError) as e:
            last_error = e
            if attempt < retries - 1:
                # Wait for writer to finish
                time.sleep(retry_delay)
            continue

    # All retries failed
    print(f"[LOAD] WARNING: Could not parse JSON after {retries} attempts: {last_error}")
    return []  # Return empty list instead of crashing


def points_to_pointcloud(points):
    """Convert JSON points to Open3D PointCloud"""
    print("[PCD] Converting to Open3D PointCloud...")

    # Extract coordinates and colors
    xyz = np.array([[p['x'], p['y'], p['z']] for p in points], dtype=np.float64)
    rgb = np.array([[p['r'], p['g'], p['b']] for p in points], dtype=np.float64) / 255.0

    # Create PointCloud
    pcd = o3d.geometry.PointCloud()
    pcd.points = o3d.utility.Vector3dVector(xyz)
    pcd.colors = o3d.utility.Vector3dVector(rgb)

    print(f"[PCD] Created PointCloud with {len(pcd.points):,} points")
    print(f"[PCD] Bounds: min={np.min(xyz, axis=0)}, max={np.max(xyz, axis=0)}")

    return pcd


def clean_pointcloud(pcd):
    """Remove outliers and noise from pointcloud"""
    print("[CLEAN] Removing statistical outliers...")

    original_count = len(pcd.points)
    pcd_clean, ind = pcd.remove_statistical_outlier(
        nb_neighbors=OUTLIER_NB_NEIGHBORS,
        std_ratio=OUTLIER_STD_RATIO
    )

    removed = original_count - len(pcd_clean.points)
    print(f"[CLEAN] Removed {removed:,} outliers ({100*removed/original_count:.1f}%)")
    print(f"[CLEAN] Remaining: {len(pcd_clean.points):,} points")

    return pcd_clean


def estimate_normals(pcd):
    """Estimate surface normals for Poisson reconstruction"""
    print("[NORMALS] Estimating surface normals...")

    pcd.estimate_normals(
        search_param=o3d.geometry.KDTreeSearchParamHybrid(
            radius=NORMAL_RADIUS,
            max_nn=NORMAL_MAX_NN
        )
    )

    # Orient normals consistently (important for Poisson)
    print("[NORMALS] Orienting normals consistently...")
    pcd.orient_normals_consistent_tangent_plane(k=15)

    print("[NORMALS] Done")
    return pcd


def create_mesh(pcd):
    """Create Poisson surface reconstruction mesh"""
    print(f"[MESH] Running Poisson reconstruction (depth={POISSON_DEPTH})...")
    print("[MESH] This may take a minute for large point clouds...")

    start_time = time.time()

    mesh, densities = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(
        pcd,
        depth=POISSON_DEPTH,
        width=0,
        scale=1.1,
        linear_fit=False
    )

    elapsed = time.time() - start_time
    print(f"[MESH] Reconstruction completed in {elapsed:.1f}s")
    print(f"[MESH] Mesh has {len(mesh.vertices):,} vertices, {len(mesh.triangles):,} faces")

    # Remove low-density vertices (often artifacts at boundaries)
    print("[MESH] Removing low-density artifacts...")
    densities = np.asarray(densities)
    density_threshold = np.quantile(densities, 0.01)  # Remove bottom 1%
    vertices_to_remove = densities < density_threshold
    mesh.remove_vertices_by_mask(vertices_to_remove)

    print(f"[MESH] After cleanup: {len(mesh.vertices):,} vertices, {len(mesh.triangles):,} faces")

    # Compute vertex normals for smooth shading
    mesh.compute_vertex_normals()

    return mesh


def save_outputs(mesh, pcd):
    """Save mesh and pointcloud to PLY files"""
    print(f"[SAVE] Writing mesh to {OUTPUT_MESH}...")
    o3d.io.write_triangle_mesh(OUTPUT_MESH, mesh)

    print(f"[SAVE] Writing pointcloud to {OUTPUT_PCD}...")
    o3d.io.write_point_cloud(OUTPUT_PCD, pcd)

    # Get file sizes
    mesh_size = os.path.getsize(OUTPUT_MESH) / (1024 * 1024)
    pcd_size = os.path.getsize(OUTPUT_PCD) / (1024 * 1024)
    print(f"[SAVE] Mesh: {mesh_size:.1f} MB, PointCloud: {pcd_size:.1f} MB")


def visualize(geometries, window_name="CEMANI 3D Map"):
    """Display in Open3D viewer"""
    print(f"[VIS] Opening visualization window...")
    print("[VIS] Controls: Mouse drag = rotate, Scroll = zoom, Shift+drag = pan")
    print("[VIS] Press Q or close window to exit")

    # Set up visualization
    vis = o3d.visualization.Visualizer()
    vis.create_window(window_name=window_name, width=1600, height=900)

    for geom in geometries:
        vis.add_geometry(geom)

    # Set render options
    opt = vis.get_render_option()
    opt.background_color = np.array([0.1, 0.1, 0.15])  # Dark background
    opt.point_size = 2.0
    opt.show_coordinate_frame = True

    # Set initial view
    ctr = vis.get_view_control()
    ctr.set_zoom(0.5)

    vis.run()
    vis.destroy_window()


def watch_and_update_live(filepath=POINTS_FILE, interval=30, pcd_only=False):
    """
    Live mode: Watch file for changes and update visualization in real-time.

    Args:
        filepath: Path to confirmed_walls.json
        interval: Seconds between file change checks
        pcd_only: If True, only show point cloud (faster updates)
    """
    print("=" * 60)
    print("  CEMANI Robot - LIVE 3D Visualization")
    print("=" * 60)
    print(f"[LIVE] Watching: {filepath}")
    print(f"[LIVE] Update interval: {interval}s")
    print(f"[LIVE] Mode: {'Point Cloud' if pcd_only else 'Mesh (Poisson)'}")
    print()
    print("[VIS] Controls: Mouse=rotate, Scroll=zoom, Shift+drag=pan")
    print("[VIS] Close window to exit")
    print()

    # Initialize visualizer
    vis = o3d.visualization.Visualizer()
    vis.create_window(
        window_name="CEMANI 3D Map - LIVE" + (" (PCD)" if pcd_only else ""),
        width=1600,
        height=900
    )

    # Set render options
    opt = vis.get_render_option()
    opt.background_color = np.array([0.1, 0.1, 0.15])
    opt.point_size = 2.0
    opt.show_coordinate_frame = True
    opt.mesh_show_back_face = True

    last_mtime = 0
    last_point_count = 0
    geometry = None
    first_load = True

    try:
        while True:
            # Check if file changed
            try:
                current_mtime = os.path.getmtime(filepath)
            except FileNotFoundError:
                print(f"[LIVE] Waiting for {filepath}...")
                time.sleep(5)
                vis.poll_events()
                vis.update_renderer()
                continue

            if current_mtime > last_mtime:
                print(f"\n[UPDATE] File changed, loading points...")

                try:
                    points = load_points(filepath)
                    point_count = len(points)

                    # Skip if we got empty results (file was being written)
                    if point_count == 0:
                        print(f"[UPDATE] Got 0 points (file being written?), will retry...")
                        time.sleep(2)
                        continue

                    if point_count == last_point_count and not first_load:
                        print(f"[UPDATE] No new points ({point_count:,} total)")
                        last_mtime = current_mtime
                        continue

                    diff = point_count - last_point_count
                    print(f"[UPDATE] Points: {last_point_count:,} -> {point_count:,} ({'+' if diff >= 0 else ''}{diff:,})")

                    # Create point cloud
                    pcd = points_to_pointcloud(points)
                    pcd_clean = clean_pointcloud(pcd)

                    if pcd_only:
                        # Point cloud mode - fast updates
                        new_geometry = pcd_clean
                    else:
                        # Mesh mode - slower but prettier
                        pcd_clean = estimate_normals(pcd_clean)
                        new_geometry, _ = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(
                            pcd_clean, depth=POISSON_DEPTH
                        )
                        new_geometry.compute_vertex_normals()

                        # Remove low-density artifacts
                        # Note: densities not returned in simple call, skip cleanup for live mode

                    # Update visualization
                    if geometry is None:
                        geometry = new_geometry
                        vis.add_geometry(geometry)

                        # Set initial camera view on first load
                        if first_load:
                            ctr = vis.get_view_control()
                            ctr.set_zoom(0.4)
                            first_load = False
                    else:
                        # Update existing geometry in-place
                        if pcd_only:
                            geometry.points = new_geometry.points
                            geometry.colors = new_geometry.colors
                            if new_geometry.has_normals():
                                geometry.normals = new_geometry.normals
                        else:
                            geometry.vertices = new_geometry.vertices
                            geometry.triangles = new_geometry.triangles
                            geometry.vertex_colors = new_geometry.vertex_colors
                            geometry.vertex_normals = new_geometry.vertex_normals

                        vis.update_geometry(geometry)

                    last_mtime = current_mtime
                    last_point_count = point_count

                    if pcd_only:
                        print(f"[UPDATE] PointCloud updated: {len(pcd_clean.points):,} points")
                    else:
                        print(f"[UPDATE] Mesh updated: {len(new_geometry.vertices):,} vertices, {len(new_geometry.triangles):,} faces")

                except Exception as e:
                    print(f"[ERROR] Failed to update: {e}")
                    import traceback
                    traceback.print_exc()

            # Process window events (keeps window responsive)
            if not vis.poll_events():
                print("[LIVE] Window closed, exiting...")
                break

            vis.update_renderer()

            # Small sleep to prevent CPU spinning
            time.sleep(0.05)

    except KeyboardInterrupt:
        print("\n[LIVE] Interrupted by user")
    finally:
        vis.destroy_window()
        print("[LIVE] Visualization closed")


def parse_args():
    """Parse command line arguments"""
    parser = argparse.ArgumentParser(
        description="CEMANI Robot - Open3D 3D Mesh Processor",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python3.11 open3d_processor.py              # One-time processing with menu
  python3.11 open3d_processor.py --live       # Live updating mesh view
  python3.11 open3d_processor.py --live --pcd # Live updating point cloud (faster)
  python3.11 open3d_processor.py --view mesh  # Direct mesh view
  python3.11 open3d_processor.py --view pcd   # Direct point cloud view
        """
    )

    parser.add_argument(
        '--live', '-l',
        action='store_true',
        help='Enable live mode: watch file and update visualization automatically'
    )

    parser.add_argument(
        '--pcd', '-p',
        action='store_true',
        help='Use point cloud instead of mesh (faster updates in live mode)'
    )

    parser.add_argument(
        '--interval', '-i',
        type=int,
        default=30,
        help='Seconds between file checks in live mode (default: 30)'
    )

    parser.add_argument(
        '--view', '-v',
        choices=['mesh', 'pcd', 'both', 'none'],
        default=None,
        help='Visualization mode (skip menu): mesh, pcd, both, or none'
    )

    parser.add_argument(
        '--file', '-f',
        type=str,
        default=POINTS_FILE,
        help=f'Input file path (default: {POINTS_FILE})'
    )

    parser.add_argument(
        '--depth', '-d',
        type=int,
        default=POISSON_DEPTH,
        help=f'Poisson reconstruction depth (default: {POISSON_DEPTH})'
    )

    return parser.parse_args()


def main():
    """Main processing pipeline"""
    args = parse_args()

    # Live mode
    if args.live:
        watch_and_update_live(
            filepath=args.file,
            interval=args.interval,
            pcd_only=args.pcd
        )
        return

    # One-time processing mode
    print("=" * 60)
    print("  CEMANI Robot - Open3D 3D Mesh Processor")
    print("=" * 60)
    print()

    # Load points
    points = load_points(args.file)

    if len(points) == 0:
        print("[ERROR] No points found in file!")
        return

    # Convert to pointcloud
    pcd = points_to_pointcloud(points)

    # Clean pointcloud
    pcd_clean = clean_pointcloud(pcd)

    # Estimate normals
    pcd_clean = estimate_normals(pcd_clean)

    # Create mesh (with custom depth if specified)
    global POISSON_DEPTH
    POISSON_DEPTH = args.depth
    mesh = create_mesh(pcd_clean)

    # Save outputs
    save_outputs(mesh, pcd_clean)

    print()
    print("=" * 60)
    print("  Processing Complete!")
    print("=" * 60)
    print(f"  Points loaded: {len(points):,}")
    print(f"  Points after cleanup: {len(pcd_clean.points):,}")
    print(f"  Mesh vertices: {len(mesh.vertices):,}")
    print(f"  Mesh faces: {len(mesh.triangles):,}")
    print("=" * 60)
    print()

    # Determine view mode
    if args.view:
        choice = args.view
    else:
        # Interactive menu
        print("Choose visualization mode:")
        print("  1. View mesh only")
        print("  2. View pointcloud only")
        print("  3. View both (mesh + pointcloud)")
        print("  q. Quit without viewing")

        choice = input("\nEnter choice [1/2/3/q]: ").strip().lower()

        # Map numeric choices
        if choice == '1':
            choice = 'mesh'
        elif choice == '2':
            choice = 'pcd'
        elif choice == '3':
            choice = 'both'
        elif choice == 'q':
            choice = 'none'
        else:
            choice = 'mesh'  # default

    # Visualize
    if choice == 'mesh':
        visualize([mesh], "CEMANI 3D Map - Mesh")
    elif choice == 'pcd':
        visualize([pcd_clean], "CEMANI 3D Map - PointCloud")
    elif choice == 'both':
        visualize([mesh, pcd_clean], "CEMANI 3D Map - Mesh + PointCloud")
    elif choice == 'none':
        print("Exiting without visualization.")
    else:
        visualize([mesh], "CEMANI 3D Map - Mesh")


if __name__ == '__main__':
    main()
