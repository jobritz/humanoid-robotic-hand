# Raspberry Pi Hand Tracking

Python utilities for running MediaPipe Hand Landmarker on a Raspberry Pi
camera. The package uses a local model and provides both an interactive camera
view and reusable landmark data for a later processing stage.

## Contents

| File | Purpose |
| --- | --- |
| `hand_tracker.py` | Loads the MediaPipe model, processes camera frames, and creates the combined camera/landmark view. |
| `run_hand_tracking.py` | Starts the camera and optional on-screen interface. |
| `requirements.txt` | Pins a MediaPipe range compatible with the supported Raspberry Pi Python versions and NumPy. |
| `models/hand_landmarker.task` | Local MediaPipe Hand Landmarker model used without a network connection at runtime. |

## Features

- Detects one hand and draws the 21-point MediaPipe skeleton.
- Keeps the original browser-compatible normalized image landmarks.
- Provides MediaPipe world landmarks in meters.
- Provides wrist-relative world landmarks by subtracting landmark 0.
- Shows camera and landmark information in one combined OpenCV window.
- Supports a headless mode for later model integration.
- Does not download the Hand Landmarker model at startup.

## Prerequisites

- 64-bit Raspberry Pi OS
- Raspberry Pi camera or USB camera
- Python 3.11 or 3.12
- Internet access only during initial setup

Raspberry Pi OS Trixie may ship Python 3.13, while MediaPipe 0.10.x only
provides compatible wheels through Python 3.12.

## Setup

Run the following commands inside the repository:

```bash
cd ~/Git/humanoid-robotic-hand/pi
python3 --version
python3 -m venv .venv312
source .venv312/bin/activate
```

If Python 3.13 is the system version, install Python 3.12 with `pyenv` first.
The Raspberry Pi build dependencies and pyenv setup are:

```bash
sudo apt update
sudo apt install -y build-essential curl git libssl-dev zlib1g-dev \
  libbz2-dev libreadline-dev libsqlite3-dev libncursesw5-dev xz-utils \
  tk-dev libxml2-dev libxmlsec1-dev libffi-dev liblzma-dev

curl https://pyenv.run | bash
```

Add the following lines to `~/.bashrc`:

```bash
export PYENV_ROOT="$HOME/.pyenv"
export PATH="$PYENV_ROOT/bin:$PATH"
eval "$(pyenv init -)"
```

Then reload the shell, install Python 3.12, and create the environment:

```bash
source ~/.bashrc
pyenv install 3.12
~/.pyenv/versions/3.12.*/bin/python -m venv .venv312
source .venv312/bin/activate
```

Install and verify the Python dependencies:

```bash
python -m pip install --upgrade pip
python -m pip install -r requirements.txt

python --version
python -c "import mediapipe as mp; print(mp.__version__)"
```

The MediaPipe version should be a 0.10.x release.

## Run the Interface

With the virtual environment activated:

```bash
python run_hand_tracking.py
```

Use another OpenCV camera index when more than one camera is available:

```bash
python run_hand_tracking.py --camera 1
```

The combined window contains:

- The camera image and hand skeleton.
- The handedness and confidence score.
- A table of all 21 MediaPipe landmarks.
- A coordinate mode button.

Click **Show world** or **Show relative** in the landmark panel to switch
coordinates. **w** has the same function. **q** or **Esc** closes the window.

## Headless Mode

Disable the graphical interface for server or pipeline use:

```bash
python run_hand_tracking.py --no-display
```

Tracking continues in this mode until it is interrupted with **Ctrl+C**. Camera
frames are still processed and `HandTracker.detect()` still produces landmark
data.

## Python API

Import `HandTracker` in another Python script:

```python
import cv2

from hand_tracker import HandTracker

camera = cv2.VideoCapture(0)

try:
    with HandTracker() as tracker:
        while True:
            ok, frame = camera.read()
            if not ok:
                break

            hand_data = tracker.detect(frame)

            if hand_data is not None:
                # Pass hand_data to another model or processing stage here.
                pass
finally:
    camera.release()
```

`detect(frame)` accepts a BGR OpenCV frame and returns `None` when no hand is
detected. Otherwise it returns:

| Field | Type | Description |
| --- | --- | --- |
| `landmarks` | 21 points | Browser-compatible normalized image landmarks `{x, y, z}`. |
| `worldLandmarks` | 21 points | Original MediaPipe world landmarks in meters. |
| `relativeLandmarks` | 21 points | World landmarks with landmark 0 subtracted from every point. |
| `handedness` | string | `Left` or `Right`. |
| `score` | float | Handedness confidence from `0` to `1`. |

MediaPipe landmark order is:

- 0: wrist
- 1-4: thumb CMC, MCP, IP, and tip
- 5-8: index MCP, PIP, DIP, and tip
- 9-12: middle MCP, PIP, DIP, and tip
- 13-16: ring MCP, PIP, DIP, and tip
- 17-20: pinky MCP, PIP, DIP, and tip

## Troubleshooting

### Wayland Qt warning

The bundled OpenCV Qt plugins may not support Wayland. The launcher sets
`QT_QPA_PLATFORM=xcb` when both Wayland and XWayland are available. It can also
be selected explicitly:

```bash
QT_QPA_PLATFORM=xcb python run_hand_tracking.py
```

XWayland or another desktop session with a supported Qt plugin is required.

### CPU feature messages

`prctl(PR_SVE_GET_VL) failed` is a CPU feature probe and does not prevent
tracking on a processor without SVE support.

`Created TensorFlow Lite XNNPACK delegate for CPU` confirms that CPU inference
is active.

MediaPipe feedback-manager and `NORM_RECT` log messages are runtime warnings.
They do not indicate an application failure when hand detection continues.
