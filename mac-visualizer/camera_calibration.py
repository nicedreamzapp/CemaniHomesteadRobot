#!/usr/bin/env python3
"""
Camera Calibration for PTZ Cameras
==================================
Intrinsic matrices and distortion coefficients for the robot's PTZ cameras.

Camera 1: Front PTZ (192.168.1.191) - Sricam SP017
Camera 2: Rear PTZ (192.168.1.27) - Sricam SP017

These are estimated from camera specs. For better accuracy, run OpenCV
checkerboard calibration using calibrate_from_checkerboard().

Typical PTZ camera specs:
- Horizontal FOV: ~70 degrees at 1x zoom
- Sensor: 1/2.7" CMOS
- Resolution: 1920x1080 (downscaled to 640x480 for processing)
"""

import numpy as np
import math

# ============ RESOLUTION ============
# Processing resolution (images are resized to this)
PROC_WIDTH = 640
PROC_HEIGHT = 480

# Native resolution
NATIVE_WIDTH = 1920
NATIVE_HEIGHT = 1080

# ============ CAMERA 1: FRONT PTZ (192.168.1.191) ============
# Sricam SP017 or similar PTZ camera
# Estimated FOV: 70 degrees horizontal at 1x zoom

CAM1_HFOV_DEG = 70.0  # Horizontal field of view in degrees
CAM1_VFOV_DEG = 42.0  # Vertical FOV (4:3 aspect adjusted)

# Calculate focal length from FOV: fx = (width/2) / tan(hfov/2)
CAM1_FX = (PROC_WIDTH / 2) / math.tan(math.radians(CAM1_HFOV_DEG / 2))
CAM1_FY = (PROC_HEIGHT / 2) / math.tan(math.radians(CAM1_VFOV_DEG / 2))

# Principal point (optical center) - usually near image center
# Slight offset is common due to lens alignment
CAM1_CX = PROC_WIDTH / 2 + 2   # Small offset from center
CAM1_CY = PROC_HEIGHT / 2 - 5  # Slight vertical offset

# Distortion coefficients [k1, k2, p1, p2, k3]
# Typical values for PTZ cameras with slight barrel distortion
CAM1_DIST = np.array([-0.12, 0.08, 0.001, -0.001, 0.0])

# Intrinsic matrix K
CAM1_K = np.array([
    [CAM1_FX, 0,       CAM1_CX],
    [0,       CAM1_FY, CAM1_CY],
    [0,       0,       1      ]
], dtype=np.float64)

# Physical position relative to robot center (meters)
CAM1_POSITION = np.array([0.0, 0.40, -0.10])  # x=0, height=40cm, forward=-10cm
CAM1_BASE_YAW = 0.0  # Faces forward (radians)


# ============ CAMERA 2: REAR PTZ (192.168.1.27) ============
# Same model camera, may have slightly different characteristics
CAM2_HFOV_DEG = 70.0
CAM2_VFOV_DEG = 42.0

CAM2_FX = (PROC_WIDTH / 2) / math.tan(math.radians(CAM2_HFOV_DEG / 2))
CAM2_FY = (PROC_HEIGHT / 2) / math.tan(math.radians(CAM2_VFOV_DEG / 2))

CAM2_CX = PROC_WIDTH / 2 - 3   # Different offset
CAM2_CY = PROC_HEIGHT / 2 + 2

CAM2_DIST = np.array([-0.10, 0.06, -0.001, 0.002, 0.0])

CAM2_K = np.array([
    [CAM2_FX, 0,       CAM2_CX],
    [0,       CAM2_FY, CAM2_CY],
    [0,       0,       1      ]
], dtype=np.float64)

CAM2_POSITION = np.array([-0.20, 0.55, 0.0])  # x=-20cm left, height=55cm
CAM2_BASE_YAW = math.pi  # Faces backward


# ============ HELPER FUNCTIONS ============

def get_camera_intrinsics(cam_id: int, width: int = PROC_WIDTH, height: int = PROC_HEIGHT):
    """
    Get camera intrinsics scaled to the given resolution.

    Returns: (fx, fy, cx, cy, K, dist)
    """
    if cam_id == 1:
        base_K = CAM1_K.copy()
        dist = CAM1_DIST.copy()
    else:
        base_K = CAM2_K.copy()
        dist = CAM2_DIST.copy()

    # Scale intrinsics if resolution differs from PROC_WIDTH/HEIGHT
    scale_x = width / PROC_WIDTH
    scale_y = height / PROC_HEIGHT

    K = base_K.copy()
    K[0, 0] *= scale_x  # fx
    K[0, 2] *= scale_x  # cx
    K[1, 1] *= scale_y  # fy
    K[1, 2] *= scale_y  # cy

    fx = K[0, 0]
    fy = K[1, 1]
    cx = K[0, 2]
    cy = K[1, 2]

    return fx, fy, cx, cy, K, dist


def get_camera_extrinsics(cam_id: int):
    """
    Get camera position and base orientation.

    Returns: (position, base_yaw)
    """
    if cam_id == 1:
        return CAM1_POSITION.copy(), CAM1_BASE_YAW
    else:
        return CAM2_POSITION.copy(), CAM2_BASE_YAW


def undistort_points(points: np.ndarray, cam_id: int, width: int = PROC_WIDTH, height: int = PROC_HEIGHT):
    """
    Undistort 2D image points using camera distortion model.

    Args:
        points: Nx2 array of (x, y) pixel coordinates
        cam_id: Camera ID (1 or 2)
        width, height: Image dimensions

    Returns:
        Nx2 array of undistorted points
    """
    try:
        import cv2
        fx, fy, cx, cy, K, dist = get_camera_intrinsics(cam_id, width, height)

        # Reshape for OpenCV
        pts = points.reshape(-1, 1, 2).astype(np.float32)

        # Undistort
        undistorted = cv2.undistortPoints(pts, K, dist, P=K)

        return undistorted.reshape(-1, 2)
    except ImportError:
        # No OpenCV, return original points
        return points


def project_to_3d(u: float, v: float, depth: float, cam_id: int,
                  width: int = PROC_WIDTH, height: int = PROC_HEIGHT):
    """
    Project a 2D pixel with depth to 3D camera coordinates.

    Args:
        u, v: Pixel coordinates
        depth: Depth in meters
        cam_id: Camera ID
        width, height: Image dimensions

    Returns:
        (x, y, z) in camera coordinate frame
    """
    fx, fy, cx, cy, _, _ = get_camera_intrinsics(cam_id, width, height)

    # Standard pinhole projection: X = (u - cx) * Z / fx
    x = (u - cx) * depth / fx
    y = (v - cy) * depth / fy
    z = depth

    return x, y, z


def project_to_image(x: float, y: float, z: float, cam_id: int,
                     width: int = PROC_WIDTH, height: int = PROC_HEIGHT):
    """
    Project a 3D point to 2D image coordinates.

    Args:
        x, y, z: 3D point in camera coordinates
        cam_id: Camera ID
        width, height: Image dimensions

    Returns:
        (u, v) pixel coordinates, or None if behind camera
    """
    if z <= 0:
        return None

    fx, fy, cx, cy, _, _ = get_camera_intrinsics(cam_id, width, height)

    u = fx * (x / z) + cx
    v = fy * (y / z) + cy

    return u, v


# ============ CALIBRATION FROM CHECKERBOARD ============

def calibrate_from_checkerboard(image_paths: list, pattern_size: tuple = (9, 6),
                                 square_size: float = 0.025):
    """
    Run OpenCV checkerboard calibration on a set of images.

    Args:
        image_paths: List of paths to calibration images
        pattern_size: (cols, rows) of internal corners
        square_size: Size of checkerboard square in meters

    Returns:
        K: 3x3 intrinsic matrix
        dist: Distortion coefficients
        error: Reprojection error
    """
    try:
        import cv2
    except ImportError:
        print("OpenCV required for checkerboard calibration")
        return None, None, None

    # Prepare object points (0,0,0), (1,0,0), (2,0,0), ...
    objp = np.zeros((pattern_size[0] * pattern_size[1], 3), np.float32)
    objp[:, :2] = np.mgrid[0:pattern_size[0], 0:pattern_size[1]].T.reshape(-1, 2)
    objp *= square_size

    obj_points = []  # 3D points in world
    img_points = []  # 2D points in image

    img_size = None

    for path in image_paths:
        img = cv2.imread(path)
        if img is None:
            print(f"Could not read: {path}")
            continue

        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        img_size = gray.shape[::-1]

        # Find corners
        ret, corners = cv2.findChessboardCorners(gray, pattern_size, None)

        if ret:
            # Refine corners
            criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.001)
            corners2 = cv2.cornerSubPix(gray, corners, (11, 11), (-1, -1), criteria)

            obj_points.append(objp)
            img_points.append(corners2)
            print(f"Found corners in: {path}")
        else:
            print(f"No corners found in: {path}")

    if len(obj_points) < 3:
        print("Need at least 3 images with detected corners")
        return None, None, None

    # Calibrate
    ret, K, dist, rvecs, tvecs = cv2.calibrateCamera(
        obj_points, img_points, img_size, None, None
    )

    print(f"\nCalibration Results:")
    print(f"  Reprojection Error: {ret:.4f} pixels")
    print(f"  fx = {K[0,0]:.2f}, fy = {K[1,1]:.2f}")
    print(f"  cx = {K[0,2]:.2f}, cy = {K[1,2]:.2f}")
    print(f"  Distortion: {dist.flatten()}")

    return K, dist.flatten(), ret


# ============ PRINT CURRENT CALIBRATION ============

if __name__ == "__main__":
    print("=" * 60)
    print("  CAMERA CALIBRATION VALUES")
    print("=" * 60)

    for cam_id in [1, 2]:
        fx, fy, cx, cy, K, dist = get_camera_intrinsics(cam_id)
        pos, yaw = get_camera_extrinsics(cam_id)

        print(f"\nCamera {cam_id}:")
        print(f"  FOV: {CAM1_HFOV_DEG if cam_id == 1 else CAM2_HFOV_DEG}° x {CAM1_VFOV_DEG if cam_id == 1 else CAM2_VFOV_DEG}°")
        print(f"  fx = {fx:.2f}, fy = {fy:.2f}")
        print(f"  cx = {cx:.2f}, cy = {cy:.2f}")
        print(f"  Distortion: k1={dist[0]:.3f}, k2={dist[1]:.3f}, p1={dist[2]:.4f}, p2={dist[3]:.4f}")
        print(f"  Position: x={pos[0]:.2f}m, y={pos[1]:.2f}m, z={pos[2]:.2f}m")
        print(f"  Base Yaw: {math.degrees(yaw):.1f}°")
        print(f"  Intrinsic Matrix K:")
        print(f"    [{K[0,0]:7.2f} {K[0,1]:7.2f} {K[0,2]:7.2f}]")
        print(f"    [{K[1,0]:7.2f} {K[1,1]:7.2f} {K[1,2]:7.2f}]")
        print(f"    [{K[2,0]:7.2f} {K[2,1]:7.2f} {K[2,2]:7.2f}]")
