#!/usr/bin/env python3
"""
Schere, Stein, Papier gegen die Amazing Hand (Simulation).

    python rps.py --cam 0                          # Webcam erkennt deine Geste
    python rps.py --cam http://192.168.4.1:81/stream   # ESP32-CAM
    python rps.py                                  # ohne Kamera: Eingabe im Terminal (1/2/3)
    python rps.py --auto                           # Hand spielt alleine (Demo)
    python rps.py --headless [--cam bild.jpg]      # ohne Fenster, 5 Runden (Test)

macOS: mit `mjpython rps.py --cam 0` starten (statt python). Das Kamerafenster entfällt dort
automatisch – vorher die Erkennung mit `python3 gesture_cam.py --source 0` prüfen.

Mit Kamera: Enter im Terminal oder Leertaste im Kamerafenster startet eine Runde.
Zeige deine Geste beim Wort "Papier!" – ausgewertet werden die Kamerabilder 0,15–0,8 s danach.
Die Hand wählt zufällig (random.choice) und schaut dabei NICHT auf die Kamera.
"""
import argparse
import os
import sys
import queue
import random
import threading
import time

import mujoco
import numpy as np

from gestures import GESTURES, SHOW_POSE, apply_arm, apply_gesture

HERE = os.path.dirname(os.path.abspath(__file__))
CHOICES = {"1": "schere", "2": "stein", "3": "papier",
           "schere": "schere", "stein": "stein", "papier": "papier"}
BEATS = {"schere": "papier", "stein": "schere", "papier": "stein"}  # X schlägt BEATS[X]
PUMP = 0.8                 # s pro "Schütteln"
VOTE_FROM, VOTE_TO = 0.15, 0.8   # Auswertefenster nach "Papier!" (s, Wanduhr) – vorher zeigt jeder die Countdown-Faust
WORDS = ("Schere ...", "Stein ...", "Papier!")


def winner(player, robot):
    if player == robot:
        return 0
    return 1 if BEATS[player] == robot else -1


class Game:
    """Zeitgesteuerte Runde: 3x Faust schütteln, dann Geste zeigen und auswerten."""

    def __init__(self, m, d, cam=None):
        self.m, self.d, self.cam = m, d, cam
        self.t0 = None
        self.player = self.robot = None
        self.said = 0
        self.shoot_wall = None
        self.score = [0, 0, 0]  # Spieler, Hand, Unentschieden
        self.wf = m.actuator("wrist_flex").id

    @property
    def busy(self):
        return self.t0 is not None

    def start(self, player=None):
        """player=None -> Geste kommt von der Kamera."""
        self.player, self.robot = player, random.choice(list(GESTURES))
        self.t0, self.said, self.shoot_wall = self.d.time, 0, None
        apply_gesture(self.m, self.d, "stein")

    def update(self):
        """Pro Simulationsschritt aufrufen. Gibt None zurück, solange die Runde läuft."""
        if not self.busy:
            return None
        t = self.d.time - self.t0
        n = int(t / PUMP)
        if n < 3:
            self.d.ctrl[self.wf] = SHOW_POSE["wrist_flex"] - 0.35 * np.sin(np.pi * (t % PUMP) / PUMP)
            if self.said <= n:
                print(WORDS[n], flush=True)
                self.said = n + 1
            return None
        if self.shoot_wall is None:                      # Moment "Papier!"
            self.shoot_wall = time.time()
            self.d.ctrl[self.wf] = SHOW_POSE["wrist_flex"]
            apply_gesture(self.m, self.d, self.robot)
        if t < 3 * PUMP + 0.8 or time.time() < self.shoot_wall + VOTE_TO:
            return None
        self.t0 = None
        if self.cam is not None:
            self.player, nframes = self.cam.vote(self.shoot_wall + VOTE_FROM,
                                                 self.shoot_wall + VOTE_TO)
            if self.player is None:
                print(f"  Hand: {self.robot.upper()}  –  deine Geste wurde nicht eindeutig erkannt "
                      f"({nframes} Bilder mit Geste). Runde zählt nicht.", flush=True)
                return "ungueltig"
        w = winner(self.player, self.robot)
        self.score[{1: 0, -1: 1, 0: 2}[w]] += 1
        msg = {1: "Du gewinnst!", -1: "Die Hand gewinnt!", 0: "Unentschieden."}[w]
        print(f"  Du: {self.player.upper()}  –  Hand: {self.robot.upper()}  ->  {msg}   "
              f"(Stand {self.score[0]}:{self.score[1]}, {self.score[2]}x unentschieden)", flush=True)
        return w


def read_input(q):
    while True:
        try:
            s = input().strip().lower()
        except EOFError:
            q.put("q")
            return
        q.put(s)


def setup(cam=None):
    m = mujoco.MjModel.from_xml_path(os.path.join(HERE, "scene.xml"))
    d = mujoco.MjData(m)
    mujoco.mj_resetDataKeyframe(m, d, m.key("home").id)
    apply_arm(m, d, SHOW_POSE, set_qpos=True)
    apply_gesture(m, d, "papier")
    mujoco.mj_forward(m, d)
    return m, d, Game(m, d, cam)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cam", help="Kameraquelle: 0, 1, ... oder URL des ESP32-CAM")
    ap.add_argument("--auto", action="store_true")
    ap.add_argument("--headless", action="store_true")
    ap.add_argument("--no-window", action="store_true",
                    help="kein Kamerafenster (auf macOS automatisch: mjpython erlaubt nur das MuJoCo-Fenster)")
    a = ap.parse_args()
    cam_window = not (a.no_window or sys.platform == "darwin")

    cam = None
    if a.cam is not None:
        from gesture_cam import GestureCamera
        cam = GestureCamera(a.cam)
    m, d, game = setup(cam)

    if a.headless:
        for _ in range(5):
            game.start(None if cam else random.choice(list(GESTURES)))
            while game.update() is None:
                mujoco.mj_step(m, d)
                if cam:
                    time.sleep(0.0005)   # grob an Echtzeit annähern
        if cam:
            cam.close()
        return

    import mujoco.viewer as mjviewer
    if cam:
        import cv2
        from gesture_cam import show
        prompt_txt = ("\nEnter (oder Leertaste im Kamerafenster) = neue Runde, q = Ende > " if cam_window
                      else "\nEnter = neue Runde, q = Ende > ")
    else:
        prompt_txt = "\nDeine Wahl: 1 = Schere, 2 = Stein, 3 = Papier  (q = Ende) > "

    def prompt():
        print(prompt_txt, end="", flush=True)

    q = queue.Queue()
    if not a.auto:
        threading.Thread(target=read_input, args=(q,), daemon=True).start()
        prompt()
    pause_until, next_show = 0.0, 0.0
    with mjviewer.launch_passive(m, d) as v:
        v.cam.azimuth, v.cam.elevation, v.cam.distance = 180, -5, 0.45
        v.cam.lookat[:] = d.site_xpos[m.site("hand_palm_center").id] + [0, 0, 0.05]
        t_wall = time.time() - d.time
        while v.is_running():
            key = None
            if cam and cam_window and time.time() > next_show:   # Kamerafenster ~30 Hz
                key = show(cam)
                next_show = time.time() + 0.033
            if not game.busy:
                if a.auto and d.time > pause_until:
                    game.start(None if cam else random.choice(list(GESTURES)))
                elif key == ord(" "):
                    game.start(None)
                elif key in (ord("q"), 27):
                    break
                elif not q.empty():
                    s = q.get()
                    if s == "q":
                        break
                    if cam:
                        game.start(None)
                    elif s in CHOICES:
                        game.start(CHOICES[s])
                    else:
                        print("Bitte 1, 2, 3 oder q eingeben.")
                        prompt()
            if game.update() is not None:
                pause_until = d.time + 1.5
                if not a.auto:
                    prompt()
            mujoco.mj_step(m, d)
            v.sync()
            lag = d.time - (time.time() - t_wall)
            if lag > 0:
                time.sleep(lag)
    if cam:
        cam.close()
        if cam_window:
            cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
