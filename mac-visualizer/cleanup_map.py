#!/usr/bin/env python3
"""
Cleanup 3D map points - remove noise and low-quality data
"""
import json
import numpy as np
from collections import defaultdict
import sys

def cleanup_map(input_file='confirmed_walls.json', output_file='confirmed_walls_clean.json',
                min_obs=5, min_confidence=0.7, min_z=0.0, max_z=2.5,
                remove_outliers=True, outlier_neighbors=10, outlier_std=2.0):
    """
    Clean up 3D map by removing low-quality points.
    
    Args:
        min_obs: Minimum observation count to keep a point
        min_confidence: Minimum confidence score
        min_z: Minimum Z height (floor level)
        max_z: Maximum Z height (ceiling)
        remove_outliers: Whether to remove statistical outliers
        outlier_neighbors: Number of neighbors for outlier detection
        outlier_std: Standard deviations for outlier threshold
    """
    print(f"Loading {input_file}...")
    with open(input_file, 'r') as f:
        data = json.load(f)
    
    points = data.get('points', [])
    print(f"Total points before cleanup: {len(points):,}")
    
    # Stage 1: Basic filtering
    filtered = []
    removed_z = 0
    removed_obs = 0
    removed_conf = 0
    
    for p in points:
        z = p.get('z', 0)
        obs = p.get('obs', 1)
        conf = p.get('c', 1.0)
        
        if z < min_z or z > max_z:
            removed_z += 1
            continue
        if obs < min_obs:
            removed_obs += 1
            continue
        if conf < min_confidence:
            removed_conf += 1
            continue
        
        filtered.append(p)
    
    print(f"\n=== Stage 1: Basic Filtering ===")
    print(f"Removed {removed_z:,} points outside Z range [{min_z}, {max_z}]")
    print(f"Removed {removed_obs:,} points with obs < {min_obs}")
    print(f"Removed {removed_conf:,} points with confidence < {min_confidence}")
    print(f"Remaining: {len(filtered):,} points")
    
    # Stage 2: Statistical outlier removal
    if remove_outliers and len(filtered) > outlier_neighbors * 2:
        print(f"\n=== Stage 2: Outlier Removal ===")
        
        # Build KD-tree for nearest neighbor search
        coords = np.array([[p['x'], p['y'], p['z']] for p in filtered])
        
        # Simple grid-based density check instead of full KD-tree
        # Points in low-density areas are outliers
        grid_size = 0.15  # 15cm grid
        grid_counts = defaultdict(int)
        point_grids = []
        
        for p in filtered:
            gx = int(p['x'] / grid_size)
            gy = int(p['y'] / grid_size)
            gz = int(p['z'] / grid_size)
            grid_key = (gx, gy, gz)
            grid_counts[grid_key] += 1
            point_grids.append(grid_key)
        
        # Remove points in sparse grid cells
        min_neighbors = 3
        final_points = []
        removed_sparse = 0
        
        for i, p in enumerate(filtered):
            if grid_counts[point_grids[i]] >= min_neighbors:
                final_points.append(p)
            else:
                removed_sparse += 1
        
        print(f"Removed {removed_sparse:,} sparse/isolated points")
        filtered = final_points
    
    print(f"\n=== Final Result ===")
    print(f"Points after cleanup: {len(filtered):,}")
    print(f"Reduction: {len(points) - len(filtered):,} points ({100*(len(points)-len(filtered))/len(points):.1f}%)")
    
    # Analyze what's left
    sources = defaultdict(int)
    for p in filtered:
        sources[p.get('src', 'unknown')] += 1
    print(f"\nRemaining by source:")
    for src, count in sources.items():
        print(f"  {src}: {count:,}")
    
    # Save cleaned data
    clean_data = {
        'points': filtered,
        'timestamp': data.get('timestamp'),
        'cleanup_params': {
            'min_obs': min_obs,
            'min_confidence': min_confidence,
            'min_z': min_z,
            'max_z': max_z,
            'original_count': len(points)
        }
    }
    
    with open(output_file, 'w') as f:
        json.dump(clean_data, f)
    
    print(f"\nSaved to {output_file}")
    return len(points), len(filtered)

if __name__ == '__main__':
    # Default aggressive cleanup
    cleanup_map(
        min_obs=5,        # Require 5+ observations
        min_confidence=0.7,
        min_z=0.0,        # Floor level
        max_z=2.5,        # 2.5m ceiling
        remove_outliers=True
    )
