#!/usr/bin/env python3
"""
CEMANI ROBOT - 3D RECONSTRUCTION
Creates photorealistic 3D room models from captured images

Uses Gaussian Splatting (via gsplat) for high-quality reconstruction
that can be viewed in real-time in the web interface.

Requirements:
    pip install nerfstudio gsplat open3d trimesh

Usage:
    python3 reconstruct_3d.py [scan_directory]
"""

import os
import sys
import json
import subprocess
from pathlib import Path
from datetime import datetime

BASE_DIR = Path(__file__).parent
SCANS_DIR = BASE_DIR / "room_scans"
MODELS_DIR = BASE_DIR / "3d_models"

def find_latest_scan():
    """Find the most recent scan directory"""
    if not SCANS_DIR.exists():
        return None
    scans = sorted(SCANS_DIR.glob("scan_*"), reverse=True)
    return scans[0] if scans else None

def check_dependencies():
    """Check if required tools are installed"""
    deps = {
        "colmap": "COLMAP (Structure from Motion)",
        "ns-train": "Nerfstudio (Neural Rendering)"
    }

    missing = []
    for cmd, name in deps.items():
        try:
            subprocess.run([cmd, "--help"], capture_output=True, check=False)
        except FileNotFoundError:
            missing.append(name)

    return missing

def prepare_colmap_data(scan_dir):
    """Prepare images in COLMAP format for reconstruction"""
    print("[PREP] Preparing data for COLMAP...")

    colmap_dir = scan_dir / "colmap"
    colmap_dir.mkdir(exist_ok=True)
    images_dir = colmap_dir / "images"
    images_dir.mkdir(exist_ok=True)

    # Collect all images from both cameras
    all_images = []
    for cam_dir in [scan_dir / "cam1", scan_dir / "cam2"]:
        if cam_dir.exists():
            for img in cam_dir.glob("*.jpg"):
                all_images.append(img)

    # Copy/link images to colmap directory
    for idx, img in enumerate(all_images):
        dest = images_dir / f"frame_{idx:05d}.jpg"
        if not dest.exists():
            os.symlink(img, dest)

    print(f"[PREP] Prepared {len(all_images)} images")
    return colmap_dir, len(all_images)

def run_colmap(colmap_dir):
    """Run COLMAP Structure from Motion"""
    print("[COLMAP] Running feature extraction...")

    db_path = colmap_dir / "database.db"
    images_dir = colmap_dir / "images"
    sparse_dir = colmap_dir / "sparse"
    sparse_dir.mkdir(exist_ok=True)

    # Feature extraction
    subprocess.run([
        "colmap", "feature_extractor",
        "--database_path", str(db_path),
        "--image_path", str(images_dir),
        "--ImageReader.single_camera", "1",
        "--SiftExtraction.use_gpu", "0"  # CPU for Mac compatibility
    ], check=True)

    print("[COLMAP] Running feature matching...")
    subprocess.run([
        "colmap", "exhaustive_matcher",
        "--database_path", str(db_path),
        "--SiftMatching.use_gpu", "0"
    ], check=True)

    print("[COLMAP] Running sparse reconstruction...")
    subprocess.run([
        "colmap", "mapper",
        "--database_path", str(db_path),
        "--image_path", str(images_dir),
        "--output_path", str(sparse_dir)
    ], check=True)

    print("[COLMAP] Sparse reconstruction complete!")
    return sparse_dir

def run_gaussian_splatting(colmap_dir, output_dir):
    """Run Gaussian Splatting reconstruction using nerfstudio"""
    print("[3DGS] Starting Gaussian Splatting reconstruction...")

    # Use nerfstudio's splatfacto method (Gaussian Splatting)
    subprocess.run([
        "ns-train", "splatfacto",
        "--data", str(colmap_dir),
        "--output-dir", str(output_dir),
        "--max-num-iterations", "10000",  # Faster training
        "--pipeline.model.num-points", "100000"
    ], check=True)

    print("[3DGS] Gaussian Splatting complete!")
    return output_dir

def export_point_cloud(model_dir, output_file):
    """Export the reconstruction as a point cloud for web viewing"""
    print("[EXPORT] Exporting point cloud...")

    # Use ns-export to get point cloud
    subprocess.run([
        "ns-export", "gaussian-splat",
        "--load-config", str(model_dir / "config.yml"),
        "--output-dir", str(model_dir / "exports")
    ], check=True)

    return model_dir / "exports"

def simple_reconstruction(scan_dir, output_dir):
    """
    Simple point cloud reconstruction without COLMAP/nerfstudio
    Uses depth estimation + camera poses for basic 3D reconstruction
    """
    import numpy as np
    from PIL import Image

    print("[SIMPLE] Running simple reconstruction (no COLMAP required)...")

    output_dir.mkdir(parents=True, exist_ok=True)

    # Load all images and their poses
    points = []
    colors = []

    for cam_dir in [scan_dir / "cam1", scan_dir / "cam2"]:
        if not cam_dir.exists():
            continue

        for img_path in sorted(cam_dir.glob("*.jpg")):
            pose_path = img_path.with_suffix(".json")
            if not pose_path.exists():
                continue

            # Load pose
            with open(pose_path) as f:
                pose = json.load(f)

            # Load image
            img = Image.open(img_path)
            img_array = np.array(img)

            # Simple projection: create points based on pan/tilt angle
            # This is a simplified reconstruction - just for visualization
            pan_rad = np.radians(pose["pan"])
            tilt_rad = np.radians(pose["tilt"])
            robot_x = pose.get("robot_x", 0) / 1000  # mm to m
            robot_y = pose.get("robot_y", 0) / 1000
            robot_heading = np.radians(pose.get("robot_heading", 0))

            # Sample points from the image
            h, w = img_array.shape[:2]
            sample_step = 20  # Sample every 20 pixels

            for y in range(0, h, sample_step):
                for x in range(0, w, sample_step):
                    # Estimated depth (arbitrary - would need depth estimation)
                    depth = 2.0 + np.random.random() * 2.0  # 2-4 meters

                    # Image coordinates to camera angles
                    px_pan = pan_rad + ((x - w/2) / w) * np.radians(60)  # ~60 degree FOV
                    px_tilt = tilt_rad + ((h/2 - y) / h) * np.radians(45)  # ~45 degree vertical FOV

                    # Project to 3D (relative to robot)
                    pt_x = depth * np.cos(px_tilt) * np.sin(px_pan)
                    pt_y = depth * np.sin(px_tilt)
                    pt_z = depth * np.cos(px_tilt) * np.cos(px_pan)

                    # Transform to world coordinates
                    world_x = robot_x + pt_x * np.cos(robot_heading) - pt_z * np.sin(robot_heading)
                    world_z = robot_y + pt_x * np.sin(robot_heading) + pt_z * np.cos(robot_heading)
                    world_y = pt_y + 0.5  # Camera height offset

                    points.append([world_x, world_y, world_z])
                    colors.append(img_array[y, x] / 255.0)

    points = np.array(points)
    colors = np.array(colors)

    # Save as PLY file
    ply_path = output_dir / "room_reconstruction.ply"
    save_ply(ply_path, points, colors)

    # Save as JSON for web viewer
    json_path = output_dir / "room_points.json"
    save_json_points(json_path, points, colors)

    print(f"[SIMPLE] Saved {len(points)} points to {ply_path}")
    return ply_path

def save_ply(path, points, colors):
    """Save point cloud as PLY file"""
    with open(path, 'w') as f:
        f.write("ply\n")
        f.write("format ascii 1.0\n")
        f.write(f"element vertex {len(points)}\n")
        f.write("property float x\n")
        f.write("property float y\n")
        f.write("property float z\n")
        f.write("property uchar red\n")
        f.write("property uchar green\n")
        f.write("property uchar blue\n")
        f.write("end_header\n")

        for pt, col in zip(points, colors):
            r, g, b = (col * 255).astype(int)[:3] if len(col) >= 3 else (128, 128, 128)
            f.write(f"{pt[0]:.4f} {pt[1]:.4f} {pt[2]:.4f} {r} {g} {b}\n")

def save_json_points(path, points, colors):
    """Save point cloud as JSON for web viewer"""
    data = {
        "type": "room_reconstruction",
        "point_count": len(points),
        "points": []
    }

    # Downsample for JSON (max 50k points)
    step = max(1, len(points) // 50000)

    for i in range(0, len(points), step):
        pt = points[i]
        col = colors[i] if i < len(colors) else [0.5, 0.5, 0.5]
        data["points"].append({
            "x": round(float(pt[0]), 3),
            "y": round(float(pt[1]), 3),
            "z": round(float(pt[2]), 3),
            "r": int(col[0] * 255) if len(col) >= 1 else 128,
            "g": int(col[1] * 255) if len(col) >= 2 else 128,
            "b": int(col[2] * 255) if len(col) >= 3 else 128
        })

    with open(path, 'w') as f:
        json.dump(data, f)

def main():
    print("=" * 60)
    print("  CEMANI ROBOT - 3D ROOM RECONSTRUCTION")
    print("  Creates photorealistic 3D models from room scans")
    print("=" * 60)
    print()

    # Find scan directory
    if len(sys.argv) > 1:
        scan_dir = Path(sys.argv[1])
    else:
        scan_dir = find_latest_scan()

    if not scan_dir or not scan_dir.exists():
        print("[ERROR] No scan directory found!")
        print("Run 'python3 room_scanner.py' first to capture images")
        sys.exit(1)

    print(f"[INFO] Using scan: {scan_dir}")

    # Create output directory
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output_dir = MODELS_DIR / f"model_{timestamp}"
    output_dir.mkdir(parents=True, exist_ok=True)

    # Check for advanced reconstruction tools
    missing = check_dependencies()

    if not missing:
        # Full reconstruction with COLMAP + Gaussian Splatting
        print("[INFO] Using COLMAP + Gaussian Splatting (best quality)")
        colmap_dir, num_images = prepare_colmap_data(scan_dir)
        sparse_dir = run_colmap(colmap_dir)
        model_dir = run_gaussian_splatting(colmap_dir, output_dir)
        export_point_cloud(model_dir, output_dir / "exports")
    else:
        # Simple reconstruction
        print(f"[INFO] Missing tools: {missing}")
        print("[INFO] Using simple reconstruction (faster, lower quality)")
        print("[INFO] For best results, install: brew install colmap && pip install nerfstudio")
        simple_reconstruction(scan_dir, output_dir)

    print()
    print("=" * 60)
    print(f"  RECONSTRUCTION COMPLETE!")
    print(f"  Output: {output_dir}")
    print("=" * 60)

    # Copy to web-accessible location
    web_output = BASE_DIR.parent / "vps-server" / "public" / "3d_models"
    web_output.mkdir(parents=True, exist_ok=True)

    json_file = output_dir / "room_points.json"
    if json_file.exists():
        import shutil
        shutil.copy(json_file, web_output / "latest_room.json")
        print(f"[INFO] Copied to web: {web_output / 'latest_room.json'}")

if __name__ == "__main__":
    main()
