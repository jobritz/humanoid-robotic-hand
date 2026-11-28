"""Start the live camera preview with MediaPipe hand tracking."""

import argparse

import cv2

from hand_tracker import HandTracker, draw_hand


def main():
    parser = argparse.ArgumentParser(description="Live MediaPipe hand tracking")
    parser.add_argument("--camera", type=int, default=0, help="OpenCV camera index (default: 0)")
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
                cv2.imshow("MediaPipe Hand Tracking (press q to quit)", draw_hand(frame, hand_data))
                if cv2.waitKey(1) & 0xFF == ord("q"):
                    break
    finally:
        camera.release()
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
