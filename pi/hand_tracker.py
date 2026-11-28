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

        return {
            "landmarks": [{"x": point.x, "y": point.y, "z": point.z} for point in landmarks],
            "worldLandmarks": [
                {"x": point.x, "y": point.y, "z": point.z} for point in world_landmarks
            ],
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


def draw_landmark_table(hand_data):
    """Render browser-compatible image and world landmarks in a separate panel."""
    panel = np.full((520, 600, 3), 24, dtype=np.uint8)
    cv2.putText(
        panel,
        "MediaPipe landmarks",
        (12, 24),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.65,
        (255, 255, 255),
        1,
    )
    if hand_data is None:
        cv2.putText(
            panel,
            "No hand detected",
            (12, 56),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            (255, 255, 255),
            1,
        )
        return panel

    cv2.putText(
        panel,
        "Image x/y (0..1), z rel. wrist  |  World x/y/z (m)",
        (12, 48),
        cv2.FONT_HERSHEY_SIMPLEX,
        0.42,
        (180, 220, 180),
        1,
    )
    for index, (name, image_point, world_point) in enumerate(
        zip(LANDMARK_NAMES, hand_data["landmarks"], hand_data["worldLandmarks"])
    ):
        text = (
            f"{index:02} {name:<11} "
            f"{image_point['x']:+.3f} {image_point['y']:+.3f} {image_point['z']:+.3f}  "
            f"{world_point['x']:+.3f} {world_point['y']:+.3f} {world_point['z']:+.3f}"
        )
        cv2.putText(
            panel,
            text,
            (12, 70 + index * 20),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.38,
            (245, 245, 245),
            1,
        )
    return panel
