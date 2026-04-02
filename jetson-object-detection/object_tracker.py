"""
Object Tracker - Ported from iOS Project 601
Smooths bounding boxes and maintains stable object IDs across frames.
Eliminates jitter, provides persistence, and stabilizes detections.
"""

import time
import uuid
import threading


class TrackedObject:
    __slots__ = [
        'id', 'class_name', 'confidence',
        'current_bbox', 'target_bbox',
        'last_seen_frame', 'consecutive_hits',
        'is_visible', 'is_living', 'is_priority', 'camera'
    ]

    def __init__(self, detection, frame_count):
        self.id = str(uuid.uuid4())[:8]
        self.class_name = detection['class']
        self.confidence = detection['confidence']
        self.current_bbox = dict(detection['bbox'])  # Smoothed position
        self.target_bbox = dict(detection['bbox'])   # Latest raw detection
        self.last_seen_frame = frame_count
        self.consecutive_hits = 1
        self.is_visible = True
        self.is_living = detection.get('is_living', False)
        self.is_priority = detection.get('is_priority', False)
        self.camera = detection.get('camera', 1)


class ObjectTracker:
    """
    Multi-frame object tracker with exponential smoothing.
    Ported from iOS ObjectTracker.swift.
    """

    def __init__(self):
        # Smoothing: 0 = no smoothing, 1 = infinite smoothing
        # 0.5 = good balance of responsiveness and stability
        self.smoothing_factor = 0.5

        # Keep showing detection for N frames after it disappears
        self.persistence_frames = 6

        # IoU threshold to match detection to existing track
        self.matching_iou_threshold = 0.3

        # Minimum confidence to start tracking
        self.min_confidence = 0.10

        # Per-camera tracked objects
        self.tracked = {}  # camera_id -> {track_id: TrackedObject}
        self.frame_counts = {}  # camera_id -> int
        self.lock = threading.Lock()

    def update(self, detections, camera_id):
        """
        Process new detections and return smoothed, stable detections.
        Matches new detections to existing tracks, creates new tracks,
        ages out old tracks, and smooths positions.
        """
        with self.lock:
            if camera_id not in self.tracked:
                self.tracked[camera_id] = {}
                self.frame_counts[camera_id] = 0

            self.frame_counts[camera_id] += 1
            frame = self.frame_counts[camera_id]
            tracks = self.tracked[camera_id]

            # --- Pass 1: Match detections to existing tracks by IoU ---
            unmatched = list(detections)
            matched_ids = set()

            for det in detections:
                best_id = None
                best_iou = self.matching_iou_threshold

                for tid, track in tracks.items():
                    # Must be same class
                    if track.class_name != det['class']:
                        continue
                    iou = self._calc_iou(track.current_bbox, det['bbox'])
                    if iou > best_iou:
                        best_iou = iou
                        best_id = tid

                if best_id is not None:
                    track = tracks[best_id]
                    track.target_bbox = dict(det['bbox'])
                    # Weighted confidence: 70% old + 30% new, but never below new
                    track.confidence = max(
                        track.confidence * 0.7 + det['confidence'] * 0.3,
                        det['confidence']
                    )
                    track.last_seen_frame = frame
                    track.consecutive_hits += 1
                    track.is_visible = True
                    track.class_name = det['class']
                    track.is_living = det.get('is_living', track.is_living)
                    track.is_priority = det.get('is_priority', track.is_priority)
                    matched_ids.add(best_id)
                    # Remove from unmatched
                    unmatched = [d for d in unmatched
                                 if not (d['bbox'] == det['bbox'] and d['class'] == det['class'])]

            # --- Pass 2: Create new tracks for unmatched detections ---
            for det in unmatched:
                if det['confidence'] < self.min_confidence:
                    continue
                obj = TrackedObject(det, frame)
                tracks[obj.id] = obj

            # --- Pass 3: Age unmatched tracks (persistence) ---
            to_remove = []
            for tid, track in tracks.items():
                if tid not in matched_ids:
                    frames_gone = frame - track.last_seen_frame
                    if frames_gone > self.persistence_frames:
                        to_remove.append(tid)
                    else:
                        # Fade confidence while persisting
                        track.confidence *= 0.85
                        track.consecutive_hits = 0
                        track.is_visible = True

            for tid in to_remove:
                del tracks[tid]

            # --- Pass 4: Smooth positions ---
            f = self.smoothing_factor
            for track in tracks.values():
                t = track.target_bbox
                c = track.current_bbox
                track.current_bbox = {
                    'x': c['x'] * f + t['x'] * (1 - f),
                    'y': c['y'] * f + t['y'] * (1 - f),
                    'w': c['w'] * f + t['w'] * (1 - f),
                    'h': c['h'] * f + t['h'] * (1 - f),
                }

            # --- Build output ---
            result = []
            for track in tracks.values():
                if not track.is_visible or track.confidence < 0.05:
                    continue
                result.append({
                    'class': track.class_name,
                    'confidence': round(track.confidence, 3),
                    'bbox': {
                        'x': round(track.current_bbox['x'], 3),
                        'y': round(track.current_bbox['y'], 3),
                        'w': round(track.current_bbox['w'], 3),
                        'h': round(track.current_bbox['h'], 3),
                    },
                    'is_living': track.is_living,
                    'is_priority': track.is_priority,
                    'track_id': track.id,
                    'hits': track.consecutive_hits,
                })

            # Sort by confidence
            result.sort(key=lambda d: d['confidence'], reverse=True)
            return result

    def _calc_iou(self, bbox1, bbox2):
        """Calculate IoU between two center-format bboxes {x, y, w, h}"""
        # Convert center format to corner format
        ax1 = bbox1['x'] - bbox1['w'] / 2
        ay1 = bbox1['y'] - bbox1['h'] / 2
        ax2 = bbox1['x'] + bbox1['w'] / 2
        ay2 = bbox1['y'] + bbox1['h'] / 2

        bx1 = bbox2['x'] - bbox2['w'] / 2
        by1 = bbox2['y'] - bbox2['h'] / 2
        bx2 = bbox2['x'] + bbox2['w'] / 2
        by2 = bbox2['y'] + bbox2['h'] / 2

        # Intersection
        ix1 = max(ax1, bx1)
        iy1 = max(ay1, by1)
        ix2 = min(ax2, bx2)
        iy2 = min(ay2, by2)

        if ix2 <= ix1 or iy2 <= iy1:
            return 0.0

        inter = (ix2 - ix1) * (iy2 - iy1)
        area1 = (ax2 - ax1) * (ay2 - ay1)
        area2 = (bx2 - bx1) * (by2 - by1)
        union = area1 + area2 - inter

        return inter / union if union > 0 else 0.0

    def reset(self, camera_id=None):
        """Reset tracking state"""
        with self.lock:
            if camera_id is not None:
                self.tracked.pop(camera_id, None)
                self.frame_counts.pop(camera_id, None)
            else:
                self.tracked.clear()
                self.frame_counts.clear()
