#!/usr/bin/env python3
"""
Schere, Stein, Papier mit der ECHTEN Amazing Hand (SCS0009-Servos über rustypot).

Aufbau wie Pollens PythonExample/AmazingHand_Demo.py:
    pip install rustypot numpy
    python rps_real.py --port COM11                        # Eingabe im Terminal
    python rps_real.py --port COM11 --cam 0                # Webcam erkennt deine Geste
    python rps_real.py --port COM11 --cam http://192.168.4.1:81/stream   # ESP32-CAM

ACHTUNG: ungetestet (keine Hardware vorhanden). Vorher unbedingt
  - MiddlePos mit deinen Kalibrierwerten ersetzen (AmazingHand_Hand_FingerMiddlePos.py),
  - SIDE richtig setzen (1 = rechte, 2 = linke Hand),
  - zuerst mit `python rps_real.py --test` jede Geste einzeln anschauen.
"""
import argparse
import random
import time

import numpy as np
from rustypot import Scs0009PyController

from gestures import GESTURES, GESTURES_LEFT

SIDE = 1                                     # 1 = rechte Hand, 2 = linke Hand
MiddlePos = [3, 0, -5, -8, -2, 5, -12, 0]    # <- DEINE Kalibrierwerte eintragen
MaxSpeed = 7
SERVO_IDS = {"index": (1, 2), "middle": (3, 4), "ring": (5, 6), "thumb": (7, 8)}
BEATS = {"schere": "papier", "stein": "schere", "papier": "stein"}
CHOICES = {"1": "schere", "2": "stein", "3": "papier"}
VOTE_FROM, VOTE_TO = 0.15, 0.8   # Auswertefenster nach "Papier!" in s (vorher: Countdown-Faust)


def move_finger(c, finger, a1, a2, speed=MaxSpeed):
    i1, i2 = SERVO_IDS[finger]
    c.write_goal_speed(i1, speed)
    time.sleep(0.0002)
    c.write_goal_speed(i2, speed)
    time.sleep(0.0002)
    c.write_goal_position(i1, np.deg2rad(MiddlePos[i1 - 1] + a1))
    c.write_goal_position(i2, np.deg2rad(MiddlePos[i2 - 1] + a2))
    time.sleep(0.005)


def show(c, gesture):
    table = GESTURES if SIDE == 1 else GESTURES_LEFT
    for f, (a1, a2) in table[gesture].items():
        move_finger(c, f, a1, a2)


CAM = None


def wait(seconds):
    """Wie time.sleep, hält aber das Kamerafenster am Leben. Gibt die zuletzt gedrückte Taste zurück."""
    key, t_end = None, time.time() + seconds
    while True:
        if CAM is not None:
            from gesture_cam import show as cam_show
            k = cam_show(CAM)
            key = k if k != 255 else key
        if time.time() >= t_end:
            return key
        time.sleep(0.03 if CAM is not None else max(0.0, t_end - time.time()))


def countdown(c):
    # Faust "schütteln": leicht öffnen/schließen im Takt, wie beim echten Spiel
    for word in ("Schere ...", "Stein ...", "Papier!"):
        print(word, flush=True)
        show(c, "stein")
        wait(0.4)
        if word != "Papier!":
            for f in ("index", "middle", "ring"):
                move_finger(c, f, 60, -60)
            wait(0.3)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", default="COM11")
    ap.add_argument("--test", action="store_true", help="alle Gesten nacheinander zeigen")
    ap.add_argument("--cam", help="Kameraquelle: 0, 1, ... oder URL des ESP32-CAM")
    a = ap.parse_args()
    global CAM
    if a.cam is not None:
        from gesture_cam import GestureCamera
        CAM = GestureCamera(a.cam)

    c = Scs0009PyController(serial_port=a.port, baudrate=1000000, timeout=0.5)
    for i in range(1, 9):
        c.write_torque_enable(i, 1)  # 1 = On

    if a.test:
        for g in ("papier", "stein", "schere", "papier"):
            print("Geste:", g)
            show(c, g)
            time.sleep(2)
        return

    score = [0, 0, 0]
    show(c, "papier")
    while True:
        if CAM is None:
            s = input("\nDeine Wahl: 1 = Schere, 2 = Stein, 3 = Papier  (q = Ende) > ").strip().lower()
            if s == "q":
                break
            if s not in CHOICES:
                continue
            player = CHOICES[s]
        else:
            print("\nLeertaste im Kamerafenster = neue Runde, q = Ende")
            key = None
            while key not in (ord(" "), ord("q"), 27):
                key = wait(0.05)
            if key != ord(" "):
                break
        robot = random.choice(list(GESTURES))     # Hand wählt OHNE auf die Kamera zu schauen
        countdown(c)
        shoot = time.time()
        show(c, robot)
        wait(VOTE_TO)
        if CAM is not None:
            player, n = CAM.vote(shoot + VOTE_FROM, shoot + VOTE_TO)
            if player is None:
                print(f"  Hand: {robot.upper()}  –  deine Geste wurde nicht eindeutig erkannt "
                      f"({n} Bilder). Runde zählt nicht.")
                continue
        if player == robot:
            score[2] += 1
            msg = "Unentschieden."
        elif BEATS[player] == robot:
            score[0] += 1
            msg = "Du gewinnst!"
        else:
            score[1] += 1
            msg = "Die Hand gewinnt!"
        print(f"  Du: {player.upper()}  –  Hand: {robot.upper()}  ->  {msg}   "
              f"(Stand {score[0]}:{score[1]}, {score[2]}x unentschieden)")
    show(c, "papier")
    if CAM is not None:
        CAM.close()


if __name__ == "__main__":
    main()
