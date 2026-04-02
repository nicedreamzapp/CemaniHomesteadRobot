#!/usr/bin/env python3
"""
Gaussian Splatting Training Script for Cemani Robot

This script takes images captured during Map 1 and trains a Gaussian Splatting
model for photorealistic 3D visualization.

Pipeline:
1. Run COLMAP to estimate camera poses from images
2. Convert to nerfstudio format
3. Train Gaussian Splatting model (splatfacto)
4. Export for web viewing

Usage:
    source gaussian_env/bin/activate
    python3 train_gaussian.py gs_captures/20240101_120000

Requirements:
    - COLMAP installed (brew install colmap)
    - nerfstudio installed in gaussian_env venv
"""

import os
import sys
import json
import subprocess
import shutil
from pathlib import Path

def run_command(cmd, cwd=None, env=None):
    """Run a command and print output"""
    print(f"\n{'='*60}")
    print(f"Running: {' '.join(cmd)}")
    print('='*60)

    try:
        result = subprocess.run(
            cmd,
            cwd=cwd,
            env=env,
            capture_output=True,
            text=True
        )
        if result.stdout:
            print(result.stdout)
        if result.stderr:
            print(result.stderr, file=sys.stderr)
        if result.returncode != 0:
            print(f"Command failed with exit code {result.returncode}")
            return False
        return True
    except Exception as e:
        print(f"Error running command: {e}")
        return False

def run_colmap(capture_dir: Path):
    """Run COLMAP Structure from Motion on captured images"""
    images_dir = capture_dir / "images"
    database_path = capture_dir / "colmap" / "database.db"
    sparse_dir = capture_dir / "colmap" / "sparse"

    # Create directories
    (capture_dir / "colmap").mkdir(exist_ok=True)
    sparse_dir.mkdir(exist_ok=True)

    print("\n[COLMAP] Step 1: Feature extraction...")
    if not run_command([
        "colmap", "feature_extractor",
        "--database_path", str(database_path),
        "--image_path", str(images_dir),
        "--ImageReader.single_camera", "1",
        "--SiftExtraction.use_gpu", "0"  # CPU for Apple Silicon compatibility
    ]):
        return False

    print("\n[COLMAP] Step 2: Feature matching...")
    if not run_command([
        "colmap", "exhaustive_matcher",
        "--database_path", str(database_path),
        "--SiftMatching.use_gpu", "0"
    ]):
        return False

    print("\n[COLMAP] Step 3: Sparse reconstruction...")
    if not run_command([
        "colmap", "mapper",
        "--database_path", str(database_path),
        "--image_path", str(images_dir),
        "--output_path", str(sparse_dir)
    ]):
        return False

    print("\n[COLMAP] Done! Sparse reconstruction saved to:", sparse_dir)
    return True

def convert_to_nerfstudio(capture_dir: Path):
    """Convert COLMAP output to nerfstudio format using ns-process-data"""
    images_dir = capture_dir / "images"
    output_dir = capture_dir / "nerfstudio_data"

    print("\n[NERFSTUDIO] Converting COLMAP output to nerfstudio format...")

    # Use ns-process-data to convert
    if not run_command([
        "ns-process-data", "images",
        "--data", str(images_dir),
        "--output-dir", str(output_dir),
        "--skip-colmap"  # We already ran COLMAP
    ]):
        # Alternative: use the colmap output directly
        print("[NERFSTUDIO] Direct conversion failed, using COLMAP output...")
        output_dir = capture_dir / "colmap"

    return output_dir

def train_gaussian_splatting(data_dir: Path, output_dir: Path):
    """Train Gaussian Splatting model with splatfacto"""
    print("\n[TRAINING] Starting Gaussian Splatting training...")
    print("[TRAINING] This may take 5-30 minutes depending on image count...")

    # Train with splatfacto (Gaussian Splatting in nerfstudio)
    cmd = [
        "ns-train", "splatfacto",
        "--data", str(data_dir),
        "--output-dir", str(output_dir),
        "--vis", "tensorboard",  # Use tensorboard instead of viewer for headless
        "--max-num-iterations", "7000",  # Faster training
        "--pipeline.model.cull-alpha-thresh", "0.005",
        "--pipeline.model.continue-cull-post-densification", "False",
        "colmap"  # Use COLMAP dataparser
    ]

    if not run_command(cmd):
        print("[TRAINING] Failed! Check error messages above.")
        return None

    print("\n[TRAINING] Training complete!")
    return output_dir

def export_for_web(model_dir: Path, output_path: Path):
    """Export trained model for web viewing"""
    print("\n[EXPORT] Exporting model for web viewing...")

    # Find the latest checkpoint
    checkpoints = list(model_dir.glob("**/step-*.ckpt"))
    if not checkpoints:
        print("[EXPORT] No checkpoints found!")
        return None

    latest_ckpt = max(checkpoints, key=lambda p: p.stat().st_mtime)
    print(f"[EXPORT] Using checkpoint: {latest_ckpt}")

    # Export to splat format
    if not run_command([
        "ns-export", "gaussian-splat",
        "--load-config", str(model_dir / "config.yml"),
        "--output-dir", str(output_path)
    ]):
        print("[EXPORT] Export failed!")
        return None

    print(f"\n[EXPORT] Model exported to: {output_path}")
    return output_path

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 train_gaussian.py <capture_directory>")
        print("\nExample:")
        print("  python3 train_gaussian.py gs_captures/20240101_120000")
        print("\nAvailable captures:")
        gs_dir = Path(__file__).parent / "gs_captures"
        if gs_dir.exists():
            for d in sorted(gs_dir.iterdir()):
                if d.is_dir():
                    images = list((d / "images").glob("*.jpg")) if (d / "images").exists() else []
                    print(f"  {d.name}  ({len(images)} images)")
        sys.exit(1)

    capture_dir = Path(sys.argv[1])
    if not capture_dir.is_absolute():
        capture_dir = Path(__file__).parent / capture_dir

    if not capture_dir.exists():
        print(f"Error: Capture directory not found: {capture_dir}")
        sys.exit(1)

    images_dir = capture_dir / "images"
    if not images_dir.exists() or not list(images_dir.glob("*.jpg")):
        print(f"Error: No images found in {images_dir}")
        sys.exit(1)

    image_count = len(list(images_dir.glob("*.jpg")))
    print(f"\n{'='*60}")
    print("GAUSSIAN SPLATTING TRAINING PIPELINE")
    print('='*60)
    print(f"Capture directory: {capture_dir}")
    print(f"Images found: {image_count}")

    if image_count < 20:
        print("\nWarning: Less than 20 images may produce poor results.")
        print("Consider running Map 1 again to capture more images.")

    # Step 1: COLMAP
    print("\n" + "="*60)
    print("STEP 1: COLMAP Structure from Motion")
    print("="*60)
    if not run_colmap(capture_dir):
        print("COLMAP failed! Cannot continue.")
        sys.exit(1)

    # Step 2: Train Gaussian Splatting
    print("\n" + "="*60)
    print("STEP 2: Training Gaussian Splatting")
    print("="*60)

    colmap_dir = capture_dir / "colmap"
    output_dir = capture_dir / "outputs"
    output_dir.mkdir(exist_ok=True)

    model_dir = train_gaussian_splatting(colmap_dir, output_dir)
    if not model_dir:
        print("Training failed!")
        sys.exit(1)

    # Step 3: Export for web
    print("\n" + "="*60)
    print("STEP 3: Export for Web Viewing")
    print("="*60)

    export_path = capture_dir / "splat_export"
    export_for_web(model_dir, export_path)

    print("\n" + "="*60)
    print("COMPLETE!")
    print("="*60)
    print(f"\nGaussian Splatting model trained successfully!")
    print(f"\nTo view the model:")
    print(f"  ns-viewer --load-config {output_dir}/*/config.yml")
    print(f"\nExported splat file:")
    print(f"  {export_path}")

if __name__ == "__main__":
    main()
