# Gesture Recognizer on the Raspberry Pi: Environment Setup

This guide explains how to set up the Python virtual environment for the
gesture recognizer on a Raspberry Pi.

## Why not just `pip install mediapipe`?

Two things make the setup on the Pi special:

1. **Python version:** Raspberry Pi OS Trixie ships with Python 3.13. The
   MediaPipe 0.10.x versions that run on the Pi only provide wheels for
   Python up to 3.12.
2. **MediaPipe version:** Newer versions (e.g. 1.2.3) crash on the Pi with
   `Illegal instruction`, because the wheel uses CPU instructions (AES) that
   the Pi's processor does not support. Older 0.10.x versions are used
   instead.

## Prerequisites

- Raspberry Pi with Raspberry Pi OS (64-bit)
- Internet connection

## 1. Provide a suitable Python version

First check which version you have:

```bash
python3 --version
```

- **Python 3.11 or 3.12:** Skip ahead to step 2.
- **Python 3.13 (Trixie):** Additionally install Python 3.12 with `pyenv`.
  The system Python stays untouched.

### Install Python 3.12 with pyenv

Install the build dependencies:

```bash
sudo apt update
sudo apt install -y build-essential curl git libssl-dev zlib1g-dev \
  libbz2-dev libreadline-dev libsqlite3-dev libncursesw5-dev xz-utils \
  tk-dev libxml2-dev libxmlsec1-dev libffi-dev liblzma-dev
```

Install pyenv:

```bash
curl https://pyenv.run | bash
```

Then append these lines to the end of `~/.bashrc`:

```bash
export PYENV_ROOT="$HOME/.pyenv"
export PATH="$PYENV_ROOT/bin:$PATH"
eval "$(pyenv init -)"
```

Reload the shell and build Python 3.12. Depending on the Pi model, this takes
roughly 10 to 40 minutes:

```bash
source ~/.bashrc
pyenv install 3.12
```

Verify:

```bash
pyenv versions
```

## 2. Create the virtual environment

In the project folder:

```bash
cd ~/Git/humanoid-robotic-hand/pi
```

With the pyenv Python 3.12:

```bash
~/.pyenv/versions/3.12.*/bin/python -m venv .venv312
```

If your system Python is already 3.11 or 3.12, this is enough instead:

```bash
python3 -m venv .venv312
```

Activate the environment (required in every new terminal):

```bash
source .venv312/bin/activate
```

The prompt now starts with `(.venv312)`. Use `deactivate` to leave the
environment.

## 3. Install the dependencies

```bash
pip install --upgrade pip
pip install -r requirements.txt
```

Verify the installation:

```bash
python --version
python -c "import mediapipe as mp; print(mp.__version__)"
```

The first command should print Python 3.12 (or 3.11), and the second a 0.10.x
version.

## Start Live Hand Tracking

The MediaPipe Hand Landmarker model is included locally at
[`models/hand_landmarker.task`](models/hand_landmarker.task). It is not
downloaded at startup, so hand tracking works offline once the Python
dependencies have been installed.

1. Connect a camera to the Raspberry Pi and make sure OpenCV can access it.
2. Activate the virtual environment and start the application:

   ```bash
   python run_hand_tracking.py
   ```

   To select a different camera when multiple cameras are connected, specify
   its OpenCV index, for example `python run_hand_tracking.py --camera 1`.
3. The window displays the camera feed, detected hand skeleton, and estimated
   joint angles in degrees. Press **q** to quit.

To run tracking without opening a preview window (for example, in a headless
session), use:

```bash
python run_hand_tracking.py --no-display
```

In this mode, tracking continues until interrupted with **Ctrl+C**. The
`hand_data` result is still produced for every camera frame and can be passed
to another model in the script.

`hand_tracker.py` can also be used independently of the viewer. Other Python
scripts can import `HandTracker` and call `tracker.detect(frame)` for each
OpenCV BGR frame. The method returns `None` when no hand is detected;
otherwise, it returns a dictionary containing `landmarks`,
`world_landmarks`, `handedness`, `confidence`, and `joint_angles`. Angles are
estimated in degrees as flexion relative to a straight position. The thumb
reports MCP/IP angles, and the other fingers report MCP/PIP/DIP angles.

```python
import cv2
from hand_tracker import HandTracker

camera = cv2.VideoCapture(0)
try:
    with HandTracker() as tracker:
        ok, frame = camera.read()
        if not ok:
            raise RuntimeError("Could not read a camera frame")
        hand_data = tracker.detect(frame)  # Pass this output to another model
finally:
    camera.release()
```

## Troubleshooting

- `Error in cpuinfo: prctl(PR_SVE_GET_VL) failed` is a CPU-feature probe.
  It can appear on Raspberry Pi processors that do not support SVE and does
  not prevent tracking.
- `Created TensorFlow Lite XNNPACK delegate for CPU` is an informational
  message confirming that the CPU delegate is enabled.
- MediaPipe's `Feedback manager requires a model with a single signature` and
  `Using NORM_RECT without IMAGE_DIMENSIONS` messages are runtime warnings.
  They do not prevent hand detection when the viewer is working.
- If Qt reports that the `wayland` platform plugin is missing, the viewer now
  selects the bundled `xcb` plugin when an XWayland display is available.
  You can also set it explicitly when starting the program:

  ```bash
  QT_QPA_PLATFORM=xcb python run_hand_tracking.py
  ```

  This requires an XWayland display. If the viewer still cannot open, use a
  desktop session supported by the installed OpenCV Qt plugins.
