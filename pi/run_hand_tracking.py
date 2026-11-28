"""Start the live camera preview with MediaPipe hand tracking."""

import argparse
import os

# The bundled OpenCV Qt plugin may not include Wayland support. Use XWayland
# when available, while allowing an explicit QT_QPA_PLATFORM override.
if os.environ.get("WAYLAND_DISPLAY") and os.environ.get("DISPLAY"):
    os.environ.setdefault("QT_QPA_PLATFORM", "xcb")

import cv2

from hand_tracker import HandTracker, draw_combined_surface


def main():
    parser = argparse.ArgumentParser(description="Live MediaPipe hand tracking")
    parser.add_argument("--camera", type=int, default=0, help="OpenCV camera index (default: 0)")
    parser.add_argument(
        "--no-display",
        action="store_true",
        help="Run tracking without opening a preview window",
    )
    args = parser.parse_args()
    coordinate_mode = {"value": "relative"}

    camera = cv2.VideoCapture(args.camera)
    if not camera.isOpened():
        camera.release()
        raise RuntimeError(
            f"Could not open camera {args.camera}. Check the camera connection and permissions."
        )

    try:
        with HandTracker() as tracker:
            window_name = "MediaPipe Hand Tracking"
            if not args.no_display:
                cv2.namedWindow(window_name, cv2.WINDOW_AUTOSIZE)

                def toggle_coordinates(event, x, y, _flags, _userdata):
                    if event == cv2.EVENT_LBUTTONDOWN and 868 <= x <= 1068 and 8 <= y <= 38:
                        coordinate_mode["value"] = (
                            "world"
                            if coordinate_mode["value"] == "relative"
                            else "relative"
                        )

                cv2.setMouseCallback(window_name, toggle_coordinates)

            while True:
                ok, frame = camera.read()
                if not ok:
                    raise RuntimeError("Could not read a frame from the camera.")

                hand_data = tracker.detect(frame)
                if not args.no_display:
                    surface = draw_combined_surface(
                        frame,
                        hand_data,
                        coordinate_mode["value"],
                    )
                    cv2.imshow(window_name, surface)
                    key = cv2.waitKey(1) & 0xFF
                    if key == ord("q") or key == 27:
                        break
                    if key == ord("w"):
                        coordinate_mode["value"] = (
                            "world"
                            if coordinate_mode["value"] == "relative"
                            else "relative"
                        )
    finally:
        camera.release()
        if not args.no_display:
            cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
