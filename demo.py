#!/usr/bin/env python3
"""
Demo: SO-101 + Amazing Hand im MuJoCo-Viewer.

    python demo.py            # Hand öffnet/schließt, Arm schwenkt   (macOS: mjpython demo.py)
    python demo.py --grasp    # Greiftest: Flasche greifen und anheben

Die Funktion `set_finger()` nimmt Winkel in Grad wie Pollens Python-Beispiele
(AmazingHand_Demo.py: Move_Index(-35, 35) = offen, Move_Index(90, -90) = geschlossen).
"""
import argparse
import os
import time

import mujoco
import mujoco.viewer
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
FINGERS = ("index", "middle", "ring", "thumb")


def set_finger(m, d, finger, angle1_deg, angle2_deg):
    """Wie Move_Index/Move_Middle/... in Pollens Code, nur ohne MiddlePos-Kalibrieroffsets."""
    d.ctrl[m.actuator(f"hand_{finger}_motor1").id] = np.deg2rad(angle1_deg)
    d.ctrl[m.actuator(f"hand_{finger}_motor2").id] = np.deg2rad(angle2_deg)


def open_hand(m, d):
    for f in FINGERS:
        set_finger(m, d, f, -35, 35)


def close_hand(m, d, deg=80):
    for f in FINGERS:
        set_finger(m, d, f, deg, -deg)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--grasp", action="store_true")
    a = ap.parse_args()

    scene = "scene_grasp.xml" if a.grasp else "scene.xml"
    m = mujoco.MjModel.from_xml_path(os.path.join(HERE, scene))
    d = mujoco.MjData(m)
    mujoco.mj_resetDataKeyframe(m, d, m.key("grasp_ready" if a.grasp else "home").id)

    with mujoco.viewer.launch_passive(m, d) as v:
        t0 = time.time()
        while v.is_running():
            t = d.time
            if a.grasp:
                # 0-1 s warten, 1-2.5 s schließen, danach langsam anheben
                if 1.0 < t < 1.1:
                    close_hand(m, d, 80)
                if t > 2.5 and d.ctrl[m.actuator("shoulder_lift").id] > -0.25:
                    d.ctrl[m.actuator("shoulder_lift").id] -= 0.25 * m.opt.timestep / 3
                    d.ctrl[m.actuator("elbow_flex").id] -= 0.25 * m.opt.timestep / 3
            else:
                phase = int(t / 2.0) % 2
                (close_hand if phase else open_hand)(m, d)
                d.ctrl[m.actuator("shoulder_pan").id] = 0.6 * np.sin(0.5 * t)
                d.ctrl[m.actuator("wrist_roll").id] = 1.2 * np.sin(0.7 * t)

            mujoco.mj_step(m, d)
            v.sync()
            # Echtzeit
            lag = d.time - (time.time() - t0)
            if lag > 0:
                time.sleep(lag)


if __name__ == "__main__":
    main()
