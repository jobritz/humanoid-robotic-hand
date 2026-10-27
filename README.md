# Humanoid Robotic Hand

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![JavaScript](https://img.shields.io/badge/Language-JavaScript-F7DF1E.svg)](browser-simulation/package.json)
[![Vite](https://img.shields.io/badge/Tool-Vite-646CFF.svg)](browser-simulation/package.json)

A browser-based simulation of a humanoid robotic hand that tracks a real hand from a webcam and maps the detected motion onto a virtual hand model in real time.

The project combines MediaPipe hand tracking, MuJoCo-based physics, and a Three.js visualization to create an interactive control loop that is easy to run locally for demos, prototyping, and experimentation.

## Table of contents

- [What the project does](#what-the-project-does)
- [Why the project is useful](#why-the-project-is-useful)
- [How users can get started](#how-users-can-get-started)
- [Project structure](#project-structure)
- [How it works](#how-it-works)
- [Where users can get help](#where-users-can-get-help)
- [Who maintains and contributes](#who-maintains-and-contributes)

## What the project does

This repository contains a small interactive robotics demo in which a webcam feed is processed to estimate 3D hand landmarks. Those landmarks are converted into finger flexion and abduction values, and the result is applied to a simulated robotic hand model.

The visual layer is rendered in the browser using [browser-simulation/index.html](browser-simulation/index.html) and [browser-simulation/src](browser-simulation/src), while the physical model itself is defined in [browser-simulation/public/hand.xml](browser-simulation/public/hand.xml) and generated from [browser-simulation/make_hand.py](browser-simulation/make_hand.py).

### Core workflow

1. A user opens the app in the browser.
2. The webcam is accessed through the browser and analyzed with MediaPipe.
3. Finger features are extracted from hand landmarks.
4. A mapping layer converts those features into actuator commands.
5. MuJoCo advances the simulated hand, and Three.js renders the result in real time.

## Why the project is useful

- Real-time hand motion demo for visualization and prototyping
- No hardware robot required to test gesture-to-actuator mapping
- Easy to run locally in a standard browser
- Useful baseline for future robotics or human-machine interface work
- Modular design separates tracking, calibration, mapping, and simulation

### Key features

- Webcam-based hand tracking with MediaPipe Hand Landmarker
- Real-time mapping from hand landmarks to finger bend and spread values
- Calibration for both open-hand and fist states
- MuJoCo physics simulation for the hand model
- Three.js visualization with orbit camera controls
- Vite-based local development workflow for rapid iteration

## How users can get started

### Prerequisites

- Node.js 18+ recommended
- A modern desktop browser with webcam access
- A local development environment capable of serving a Vite app

### Installation

From the repository root:

```bash
cd browser-simulation
npm install
```

### Run the app locally

Start the dev server:

```bash
npm run dev
```

Then open the local URL shown by Vite in your browser, usually something like:

```text
http://localhost:5173
```

### Use the simulation

1. Allow camera access when prompted.
2. Click the button to start camera tracking.
3. Position your hand in view of the webcam.
4. Calibrate the open-hand state using the "Kalibrieren: Hand flach" button.
5. Calibrate the fist state using the "Kalibrieren: Faust" button.
6. Move your hand to control the simulated hand in real time.


### Regenerate the hand model

If you want to adjust the MuJoCo finger geometry or joint ranges, update [browser-simulation/make_hand.py](browser-simulation/make_hand.py) and generate the XML model again:

```bash
cd browser-simulation
python make_hand.py
```

This writes the model file used by the browser app at [browser-simulation/public/hand.xml](browser-simulation/public/hand.xml).

## Project structure

```text
.
├── LICENSE
├── README.md
├── browser-simulation/
│   ├── index.html
│   ├── make_hand.py
│   ├── package.json
│   ├── vite.config.js
│   ├── public/
│   │   └── hand.xml
│   └── src/
│       ├── main.js
│       ├── mapping.js
│       ├── overlay.js
│       ├── sim.js
│       └── tracking.js
└── .github/
    └── prompts/
```

### Main source files

- [browser-simulation/src/main.js](browser-simulation/src/main.js): app entry point, camera lifecycle, simulation loop
- [browser-simulation/src/tracking.js](browser-simulation/src/tracking.js): MediaPipe hand tracking integration
- [browser-simulation/src/mapping.js](browser-simulation/src/mapping.js): landmark-to-joint mapping and calibration logic
- [browser-simulation/src/sim.js](browser-simulation/src/sim.js): MuJoCo + Three.js hand simulation rendering
- [browser-simulation/src/overlay.js](browser-simulation/src/overlay.js): visual overlay drawn on top of the camera feed
- [browser-simulation/public/hand.xml](browser-simulation/public/hand.xml): MuJoCo model of the robotic hand

## How it works

The simulation is designed to be a compact proof-of-concept for gesture-controlled robotic motion.

- MediaPipe detects hand landmarks in 3D space from the webcam feed.
- Landmarks are reduced to a small feature set, such as finger spread and bending angles.
- The mapping logic computes target control values for each finger.
- The simulation applies these values to a MuJoCo model whose joints represent finger flexion and abduction.
- The rendered scene updates each animation frame so the robot hand follows the user's motion.

This makes it straightforward to test new mappings or adjust the simulated model without needing a physical device.

## Where users can get help

- Review the project code in [browser-simulation/src](browser-simulation/src)
- Open an issue in the GitHub repository for bugs, feature requests, or setup problems
- Check the project license in [LICENSE](LICENSE)
- Use the local code comments and model generator in [browser-simulation/make_hand.py](browser-simulation/make_hand.py) as the main implementation reference

If you are debugging browser permissions, camera access, or model loading issues, start by checking the browser console and confirming that the app is running under a local web server rather than as a plain file URL.

## Who maintains and contributes

This project is a small open-source prototype and is maintained through the repository itself. Contributions are welcome in the form of pull requests, bug fixes, feature experiments, and documentation improvements.

### Contribution guidelines

- Keep changes focused and relevant to the simulation, tracking, or model logic.
- Prefer small, well-scoped pull requests.
- Update documentation when behavior or setup changes.
- Open an issue before starting larger feature work if the intent is not obvious.
- Ensure the project still runs with the standard Vite workflow before submitting changes.

For a quick contribution workflow:

```bash
git checkout -b my-feature
# make your changes
npm run build
```

This repository is licensed under the GNU General Public License v3. See [LICENSE](LICENSE) for the full text.
