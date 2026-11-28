"""Reusable MediaPipe hand tracking for Raspberry Pi camera frames."""

from pathlib import Path
from time import monotonic

import cv2
import mediapipe as mp
import numpy as np


MODEL_PATH = Path(__file__).parent / "models" / "hand_landmarker.task"

HAND_CONNECTIONS = tuple(mp.solutions.hands.HAND_CONNECTIONS)
LANDMARK_NAMES = (
    "Wrist",
    "Thumb CMC", "Thumb MCP", "Thumb IP", "Thumb tip",
    "Index MCP", "Index PIP", "Index DIP", "Index tip",
    "Middle MCP", "Middle PIP", "Middle DIP", "Middle tip",
    "Ring MCP", "Ring PIP", "Ring DIP", "Ring tip",
    "Pinky MCP", "Pinky PIP", "Pinky DIP", "Pinky tip",
)


class HandTracker:
    """Detect one hand in BGR frames and return browser-compatible landmarks."""

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
        category = result.handedness[0][0]

        world_points = [
            {"x": point.x, "y": point.y, "z": point.z}
            for point in world_landmarks
        ]
        wrist = world_points[0]
        relative_landmarks = [
            {
                "x": point["x"] - wrist["x"],
                "y": point["y"] - wrist["y"],
                "z": point["z"] - wrist["z"],
            }
            for point in world_points
        ]

        return {
            "landmarks": [{"x": point.x, "y": point.y, "z": point.z} for point in landmarks],
            "worldLandmarks": world_points,
            "relativeLandmarks": relative_landmarks,
            "handedness": category.category_name,
            "score": category.score,
        }

    def close(self):
        self._landmarker.close()

    def __enter__(self):
        return self

    def __exit__(self, _exception_type, _exception, _traceback):
        self.close()


def draw_hand(frame, hand_data):
    """Draw the detected skeleton and handedness onto a camera frame."""
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
        f'{hand_data["handedness"]} hand ({hand_data["score"]:.0%})',
        (12, 28),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.6,
        (255, 255, 255),
        2,
    )
    return frame


def draw_landmark_table(hand_data, coordinate_mode="relative"):
    """Render the 21 joint coordinates beside the camera image."""
    panel = np.full((480, 600, 3), 24, dtype=np.uint8)
    mode_label = "Relative to wrist" if coordinate_mode == "relative" else "World coordinates"
    cv2.rectangle(panel, (388, 8), (588, 38), (70, 130, 180), -1)
    cv2.rectangle(panel, (388, 8), (588, 38), (220, 220, 220), 1)
    cv2.putText(
        panel,
        "Show world" if coordinate_mode == "relative" else "Show relative",
        (398, 29),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.48,
        (255, 255, 255),
        1,
    )
    cv2.putText(
        panel,
        "MediaPipe landmarks",
        (12, 24),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.65,
        (255, 255, 255),
        1,
    )
    cv2.putText(
        panel,
        mode_label,
        (12, 56),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.42,
        (180, 220, 180),
        1,
    )
    if hand_data is None:
        cv2.putText(
            panel,
            "No hand detected",
            (12, 82),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            (255, 255, 255),
            1,
        )
        return panel

    coordinate_key = "relativeLandmarks" if coordinate_mode == "relative" else "worldLandmarks"
    points = hand_data[coordinate_key]
    for index, (name, point) in enumerate(zip(LANDMARK_NAMES, points)):
        text = (
            f"{index:02} {name:<11} "
            f"x {point['x']:+.3f}  y {point['y']:+.3f}  z {point['z']:+.3f}"
        )
        cv2.putText(
            panel,
            text,
            (12, 82 + index * 18),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.40,
            (245, 245, 245),
            1,
        )
    return panel


def draw_combined_surface(camera_frame, hand_data, coordinate_mode="relative"):
    """Combine camera tracking and landmark coordinates in one image."""
    camera = draw_hand(camera_frame, hand_data)
    camera = cv2.resize(camera, (480, 480), interpolation=cv2.INTER_AREA)
    landmarks = draw_landmark_table(hand_data, coordinate_mode)
    return np.hstack((camera, landmarks))
