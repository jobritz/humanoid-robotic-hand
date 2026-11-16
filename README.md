# Humanoid Robotic Hand

[![License: GPL](https://img.shields.io/badge/License-GPL-blue.svg)](LICENSE)

A prototype humanoid robotic hand project that combines a browser-based MuJoCo simulation, live camera hand tracking, and embedded AI inference on ESP32 hardware. The goal is to evaluate hand gestures with an AI model running on an ESP32 which controls an [Amazing Hand](https://github.com/pollen-robotics/AmazingHand).

## Table of contents

- [What the project does](#what-the-project-does)
- [Setup instructions](#setup-instructions)
- [Where users can get help](#where-users-can-get-help)
- [Who maintains and contributes](#who-maintains-and-contributes)
- [Repository layout](#repository-layout)
- [License](#license)

## What the project does

This repository is a practical research and prototyping workspace for a robotic hand that can be explored in multiple ways:

- The [browser-simulation](./browser-simulation) app loads MuJoCo models directly in the browser and renders them with three.js.
- It can run a simulated hand model, expose control interfaces, and show live camera input from a laptop webcam for hand landmark detection.
- The [esp/esp32ai](./esp/esp32ai) project captures camera frames with an ESP32-CAM and runs a TensorFlow Lite Micro model on-device to classify hand states from grayscale input.
- The [esp/esp32cam](./esp/esp32cam) project provides a camera/web-server setup for ESP32-CAM-based image capture and experimentation.
- The [CAD](./CAD) folder contains a mechanical design concept for the hand.

At a high level, the repository is aimed at bridging simulated control and embedded hardware so a hand can be tested from a browser, visualized in MuJoCo, and eventually deployed onto real hardware.

## Setup instructions

### Prerequisites

For the browser simulation:

- Node.js 20 or newer
- A modern browser with webcam access for hand tracking

For the ESP32 AI project:

- ESP-IDF v6.1 configured in your shell
- An AI-Thinker ESP32-CAM board with PSRAM and OV2640
- USB serial cable for flashing and logs

### 1. Run the browser simulation

```bash
cd browser-simulation
npm install
npm run dev
```

Then open the local Vite URL in your browser. For local development, the app is commonly served at `http://localhost:5173`.

The simulation exposes a browser-side `window.sim` API for controlling the model. Example:

```js
window.sim.setControls({ index_flex: 0.8, thumb_abd: 0.3 });
window.sim.setJoints({ index_mcp: 0.8, index_pip: 0.8 });
window.sim.hand; // latest detected hand landmarks from the webcam, if enabled
```

The browser project includes the MuJoCo model under [browser-simulation/public/models](./browser-simulation/public/models), and it is documented in more detail in [browser-simulation/README.md](./browser-simulation/README.md).

### 2. Build and flash the ESP32 AI classifier

```bash
cd esp/esp32ai
idf.py reconfigure
idf.py build
idf.py -p /dev/ttyUSB0 flash monitor
```

Replace `/dev/ttyUSB0` with the correct serial port for your machine. The project captures grayscale camera frames, preprocesses them to match the model input size, and runs a TensorFlow Lite Micro model continuously.

For full setup instructions, see [esp/esp32ai/README.md](./esp/esp32ai/README.md).

### 3. Build the ESP32-CAM web project

```bash
cd esp/esp32cam
idf.py reconfigure
idf.py build
idf.py -p /dev/ttyUSB0 flash monitor
```

This project is intended for ESP32-CAM image capture and web-server experimentation. See [esp/esp32cam/README.md](./esp/esp32cam/README.md) for details.

## Repository layout

```text
.
├── CAD/                          # Mechanical / CAD assets
├── LICENSE                       # Project license
├── README.md                     # Main project documentation
├── .github/
│   ├── skills/
│   └── workflows/                # ESP32 CI/build workflows
├── browser-simulation/           # MuJoCo + three.js + MediaPipe browser app
│   ├── README.md
│   ├── index.html
│   ├── package.json
│   ├── vite.config.js
│   ├── public/
│   └── src/
├── esp/
│   ├── esp32ai/                  # Embedded TensorFlow Lite Micro classifier
│   │   ├── README.md
│   │   ├── CMakeLists.txt
│   │   ├── create_model.py
│   │   ├── hand.tflite
│   │   └── main/
│   └── esp32cam/                 # ESP32-CAM project for camera/web work
│       ├── README.md
│       ├── CMakeLists.txt
│       └── main/
└── .gitignore
```

## License

This project is licensed under the [GPL License](LICENSE).