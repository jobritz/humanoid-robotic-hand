"""
Gesten der Amazing Hand (rechte Hand) – Winkel in Grad pro Finger: (motor1, motor2).

Werte aus Pollens PythonExample/AmazingHand_Demo.py (Side = 1, rechte Hand):
  Stein  = CloseHand()
  Papier = OpenHand()
  Schere = Victory()
Für die echte Hand kommen noch die eigenen MiddlePos-Kalibrieroffsets dazu.
"""
import numpy as np

FINGERS = ("index", "middle", "ring", "thumb")

GESTURES = {
    "stein": {"index": (90, -90), "middle": (90, -90), "ring": (90, -90), "thumb": (90, -90)},
    "papier": {"index": (-35, 35), "middle": (-35, 35), "ring": (-35, 35), "thumb": (-35, 35)},
    "schere": {"index": (-15, 65), "middle": (-65, 15), "ring": (90, -90), "thumb": (90, -90)},
}

# Linke Hand (für die echte Hand, Side = 2): (a, b) -> (-b, -a)
# Beugen bleibt gleich, Abspreizen wird gespiegelt – deckt sich mit Pollens Victory() für Side 2
GESTURES_LEFT = {g: {f: (-b, -a) for f, (a, b) in v.items()} for g, v in GESTURES.items()}

# Armpose zum Zeigen: Finger nach oben, Handfläche nach vorn (+x), in rad
SHOW_POSE = {"shoulder_pan": 0.0, "shoulder_lift": np.radians(-40), "elbow_flex": np.radians(20),
             "wrist_flex": np.radians(-70), "wrist_roll": 0.0}


def apply_gesture(m, d, name):
    """Setzt die Sollwinkel der 8 Handmotoren für eine Geste (Simulation)."""
    for f, (a1, a2) in GESTURES[name].items():
        d.ctrl[m.actuator(f"hand_{f}_motor1").id] = np.deg2rad(a1)
        d.ctrl[m.actuator(f"hand_{f}_motor2").id] = np.deg2rad(a2)


def apply_arm(m, d, pose, set_qpos=False):
    for j, v in pose.items():
        d.ctrl[m.actuator(j).id] = v
        if set_qpos:
            d.qpos[m.jnt_qposadr[m.joint(j).id]] = v
