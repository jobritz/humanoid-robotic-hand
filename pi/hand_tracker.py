"""Reusable MediaPipe hand tracking for Raspberry Pi camera frames."""

from math import acos, degrees
from pathlib import Path
from time import monotonic

import cv2
import mediapipe as mp


MODEL_PATH = Path(__file__).parent / "models" / "hand_landmarker.task"

FINGER_JOINTS = {
    "thumb": {"MCP": (1, 2, 3), "IP": (2, 3, 4)},
    "index": {"MCP": (0, 5, 6), "PIP": (5, 6, 7), "DIP": (6, 7, 8)},
    "middle": {"MCP": (0, 9, 10), "PIP": (9, 10, 11), "DIP": (10, 11, 12)},
    "ring": {"MCP": (0, 13, 14), "PIP": (13, 14, 15), "DIP": (14, 15, 16)},
    "pinky": {"MCP": (0, 17, 18), "PIP": (17, 18, 19), "DIP": (18, 19, 20)},
}

HAND_CONNECTIONS = tuple(mp.solutions.hands.HAND_CONNECTIONS)


def _joint_angle(points, indices):
    """Return joint flexion in degrees; 0 means the three points are straight."""
    first, joint, last = (points[index] for index in indices)
    a = [first[axis] - joint[axis] for axis in range(3)]
    b = [last[axis] - joint[axis] for axis in range(3)]
    length_a = sum(value * value for value in a) ** 0.5
    length_b = sum(value * value for value in b) ** 0.5
    if length_a == 0 or length_b == 0:
        return 0.0
    cosine = sum(a[i] * b[i] for i in range(3)) / (length_a * length_b)
    cosine = max(-1.0, min(1.0, cosine))
    return round(180.0 - degrees(acos(cosine)), 1)


class HandTracker:
    """Detect one hand in BGR camera frames and return landmarks and joint angles."""

    def __init__(self, model_path=MODEL_PATH):
        model_path = Path(model_path)
        if not model_path.is_file():
            raise FileNotFoundError(f"MediaPipe model not found: {model_path}")

        options = mp.tasks.vision.HandLandmarkerOptions(
            base_options=mp.tasks.BaseOptions(model_asset_path=str(model_path)),
            running_mode=mp.tasks.vision.RunningMode.VIDEO,
            num_hands=1,
        )
        self._landmarker = mp.tasks.vision.HandLandmarker.create_from_options(options)
        self._last_timestamp_ms = 0

    def detect(self, frame):
        """Return hand data for a BGR image, or None when no hand is detected."""
        rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_frame)
        timestamp_ms = max(int(monotonic() * 1000), self._last_timestamp_ms + 1)
        self._last_timestamp_ms = timestamp_ms
        result = self._landmarker.detect_for_video(image, timestamp_ms)

        if not result.hand_landmarks:
            return None

        landmarks = result.hand_landmarks[0]
        world_landmarks = result.hand_world_landmarks[0]
        world_points = [(point.x, point.y, point.z) for point in world_landmarks]
        joint_angles = {
            finger: {
                joint: _joint_angle(world_points, indices)
                for joint, indices in joints.items()
            }
            for finger, joints in FINGER_JOINTS.items()
        }
        category = result.handedness[0][0]

        return {
            "landmarks": [{"x": point.x, "y": point.y, "z": point.z} for point in landmarks],
            "world_landmarks": [
                {"x": point.x, "y": point.y, "z": point.z} for point in world_landmarks
            ],
            "handedness": category.category_name,
            "confidence": category.score,
            "joint_angles": joint_angles,
        }

    def close(self):
        self._landmarker.close()

    def __enter__(self):
        return self

    def __exit__(self, _exception_type, _exception, _traceback):
        self.close()


def draw_hand(frame, hand_data):
    """Draw the detected skeleton and joint angles onto a camera frame."""
    if hand_data is None:
        cv2.putText(
            frame,
            "No hand detected",
            (12, 28),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.65,
            (255, 255, 255),
            2,
        )
        return frame

    height, width = frame.shape[:2]
    points = [
        (int(point["x"] * width), int(point["y"] * height))
        for point in hand_data["landmarks"]
    ]
    for start, end in HAND_CONNECTIONS:
        cv2.line(frame, points[start], points[end], (80, 220, 100), 2)
    for point in points:
        cv2.circle(frame, point, 4, (40, 100, 255), -1)

    cv2.putText(
        frame,
        f'{hand_data["handedness"]} hand ({hand_data["confidence"]:.0%})',
        (12, 28),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.6,
        (255, 255, 255),
        2,
    )
    for row, (finger, joints) in enumerate(hand_data["joint_angles"].items(), start=1):
        values = "  ".join(f"{joint}: {angle:.0f}°" for joint, angle in joints.items())
        cv2.putText(
            frame,
            f"{finger}: {values}",
            (12, 28 + row * 24),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            (255, 255, 255),
            1,
        )
    return frame
