#!/usr/bin/env python3
"""
Uploads latest SHARP splat to VPS every few seconds
Downsamples to keep file size manageable for browser
"""
import subprocess
import time
import tempfile
from pathlib import Path
import numpy as np

SHARP_DATA = Path(__file__).parent / "sharp_data"
VPS = "root@72.60.124.34"
REMOTE_PATH = "/opt/robot-server/public/splats/latest.ply"
UPLOAD_INTERVAL = 10  # seconds
MAX_SPLATS = 10000  # Keep top 10k splats by opacity

print("="*50)
print("  SPLAT UPLOADER (with downsampling)")
print(f"  Max {MAX_SPLATS} splats, every {UPLOAD_INTERVAL}s")
print("="*50)


def parse_ply(ply_path):
    """Parse binary PLY file and return vertex data only"""
    with open(ply_path, 'rb') as f:
        # Read header line by line
        header_bytes = b''
        while True:
            line = f.readline()
            header_bytes += line
            if line.strip() == b'end_header':
                break

        header = header_bytes.decode('utf-8')
        lines = header.split('\n')

        # Parse vertex count and properties
        vertex_count = 0
        vertex_props = []
        in_vertex_element = False

        for line in lines:
            line = line.strip()
            if line.startswith('element vertex'):
                vertex_count = int(line.split()[-1])
                in_vertex_element = True
            elif line.startswith('element ') and in_vertex_element:
                # Hit next element, stop collecting vertex props
                break
            elif line.startswith('property') and in_vertex_element:
                parts = line.split()
                dtype = parts[1]
                name = parts[2]
                vertex_props.append((name, dtype))

        if vertex_count == 0:
            return None, []

        # All vertex properties are float (56 bytes per vertex = 14 floats)
        bytes_per_vertex = len(vertex_props) * 4
        data_size = vertex_count * bytes_per_vertex

        # Read vertex data using numpy for speed
        vertex_data = f.read(data_size)
        vertices = np.frombuffer(vertex_data, dtype=np.float32).reshape(vertex_count, len(vertex_props))

        return vertices, vertex_props


def write_ply(path, vertices, props):
    """Write binary PLY file (vertex data only)"""
    with open(path, 'wb') as f:
        # Write header
        header = "ply\n"
        header += "format binary_little_endian 1.0\n"
        header += f"element vertex {len(vertices)}\n"
        for name, dtype in props:
            header += f"property {dtype} {name}\n"
        header += "end_header\n"
        f.write(header.encode('utf-8'))

        # Write vertex data
        vertices.astype(np.float32).tofile(f)


def downsample_splat(ply_path, max_splats=MAX_SPLATS):
    """Downsample PLY file keeping highest opacity splats"""
    vertices, props = parse_ply(ply_path)

    if vertices is None:
        return None

    if len(vertices) <= max_splats:
        return ply_path  # Already small enough

    # Find opacity column
    opacity_idx = None
    for i, (name, _) in enumerate(props):
        if name == 'opacity':
            opacity_idx = i
            break

    if opacity_idx is None:
        # No opacity - random sample
        indices = np.random.choice(len(vertices), max_splats, replace=False)
    else:
        # Apply sigmoid to opacity and take top N
        opacities = 1.0 / (1.0 + np.exp(-vertices[:, opacity_idx]))
        indices = np.argsort(opacities)[::-1][:max_splats]

    downsampled = vertices[indices]

    # Write to temp file
    temp_path = Path(tempfile.gettempdir()) / "splat_downsampled.ply"
    write_ply(temp_path, downsampled, props)

    return temp_path


last_uploaded = None
last_mtime = None

while True:
    try:
        # Find latest PLY
        output_dirs = sorted(SHARP_DATA.glob("output_*"))
        if output_dirs:
            latest_dir = output_dirs[-1]
            ply_files = list(latest_dir.glob("*.ply"))
            if ply_files:
                latest_ply = ply_files[0]
                current_mtime = latest_ply.stat().st_mtime

                # Only upload if new or modified
                if str(latest_ply) != last_uploaded or current_mtime != last_mtime:
                    print(f"[UPLOAD] Processing {latest_ply.name}...")

                    # Downsample
                    downsampled_path = downsample_splat(latest_ply, MAX_SPLATS)
                    if downsampled_path:
                        size_mb = downsampled_path.stat().st_size / 1024 / 1024
                        print(f"[UPLOAD] Downsampled to {MAX_SPLATS} splats ({size_mb:.1f}MB)")

                        # Upload
                        result = subprocess.run(
                            ["scp", "-q", str(downsampled_path), f"{VPS}:{REMOTE_PATH}"],
                            capture_output=True, timeout=120
                        )
                        if result.returncode == 0:
                            print(f"[UPLOAD] Success! {latest_ply.parent.name}")
                            last_uploaded = str(latest_ply)
                            last_mtime = current_mtime
                        else:
                            print(f"[UPLOAD] Failed: {result.stderr.decode()}")
    except Exception as e:
        print(f"[UPLOAD] Error: {e}")
        import traceback
        traceback.print_exc()

    time.sleep(UPLOAD_INTERVAL)
