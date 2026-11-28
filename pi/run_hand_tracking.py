"""Start the live camera preview with MediaPipe hand tracking."""

import argparse
import os

# The bundled OpenCV Qt plugin may not include Wayland support. Use XWayland
# when available, while allowing an explicit QT_QPA_PLATFORM override.
if os.environ.get("WAYLAND_DISPLAY") and os.environ.get("DISPLAY"):
    os.environ.setdefault("QT_QPA_PLATFORM", "xcb")

import cv2

from hand_tracker import HandTracker, draw_hand, draw_landmark_table


def main():
    parser = argparse.ArgumentParser(description="Live MediaPipe hand tracking")
    parser.add_argument("--camera", type=int, default=0, help="OpenCV camera index (default: 0)")
    parser.add_argument(
        "--no-display",
        action="store_true",
        help="Run tracking without opening a preview window",
    )
    args = parser.parse_args()

    camera = cv2.VideoCapture(args.camera)
    if not camera.isOpened():
        camera.release()
        raise RuntimeError(
            f"Could not open camera {args.camera}. Check the camera connection and permissions."
        )

    try:
        with HandTracker() as tracker:
            while True:
                ok, frame = camera.read()
                if not ok:
                    raise RuntimeError("Could not read a frame from the camera.")

                hand_data = tracker.detect(frame)
                if not args.no_display:
                    cv2.imshow(
                        "MediaPipe Hand Tracking (press q to quit)",
                        draw_hand(frame, hand_data),
                    )
                    cv2.imshow("Hand Landmarks", draw_landmark_table(hand_data))
                    if cv2.waitKey(1) & 0xFF == ord("q"):
                        break
    finally:
        camera.release()
        if not args.no_display:
            cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
