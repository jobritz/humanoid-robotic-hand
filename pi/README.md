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
cd ~/Git/mediapipe/raspberry_pi_gesture_recognizer
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

The first command should print Python 3.12 (or 3.11), the second a 0.10.x
version.
