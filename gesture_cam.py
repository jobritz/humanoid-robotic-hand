#!/usr/bin/env python3
"""
Erkennt Schere / Stein / Papier per Kamera (MediaPipe Hand Landmarker).

Kameraquellen (--source):
    0, 1, ...                       Webcam-Index
    http://192.168.4.1:81/stream    ESP32-CAM, MJPEG-Stream (CameraWebServer-Beispiel)
    http://192.168.4.1/capture      ESP32-CAM, Einzelbilder (wird abgefragt, robuster bei WLAN-Problemen)
    video.mp4 / bild.jpg            Datei (zum Testen)

Allein testen:
    python gesture_cam.py --source 0                 # Live-Fenster mit erkannter Geste
    python gesture_cam.py --image foto.jpg           # ein Bild klassifizieren

Das Modell (hand_landmarker.task, ~7 MB) wird beim ersten Start automatisch geladen.
"""
import argparse
import collections
import os
import threading
import time
import urllib.request

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks.python import BaseOptions, vision

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.path.join(HERE, "hand_landmarker.task")
MODEL_URL = ("https://storage.googleapis.com/mediapipe-models/hand_landmarker/"
             "hand_landmarker/float16/latest/hand_landmarker.task")

# MediaPipe-Landmarken: 0 Handgelenk, Finger je (MCP, PIP, DIP, TIP)
FINGER_IDX = {"index": (5, 6, 7, 8), "middle": (9, 10, 11, 12),
              "ring": (13, 14, 15, 16), "pinky": (17, 18, 19, 20)}
CONNECTIONS = [(0, 1), (1, 2), (2, 3), (3, 4), (0, 5), (5, 6), (6, 7), (7, 8), (5, 9), (9, 10),
               (10, 11), (11, 12), (9, 13), (13, 14), (14, 15), (15, 16), (13, 17), (0, 17),
               (17, 18), (18, 19), (19, 20)]


def ensure_model(path=MODEL_PATH):
    if not os.path.exists(path):
        print("Lade MediaPipe-Handmodell ...", flush=True)
        urllib.request.urlretrieve(MODEL_URL, path)
    return path


def finger_extension(world):
    """Pro Finger ein Wert 0..1 (0 = eingerollt, 1 = gestreckt), aus 3D-Weltkoordinaten (m).

    Unabhängig von Bildgröße, Abstand und Drehung der Hand: gemessen wird, wie gerade der
    Finger ist (Winkel MCP-PIP-TIP) und ob die Spitze weiter vom Handgelenk weg ist als das PIP.
    """
    w = world[0]
    out = {}
    for f, (mcp, pip, dip, tip) in FINGER_IDX.items():
        v1 = world[pip] - world[mcp]
        v2 = world[tip] - world[pip]
        cos = float(np.dot(v1, v2) / (np.linalg.norm(v1) * np.linalg.norm(v2) + 1e-9))
        reach = np.linalg.norm(world[tip] - w) / (np.linalg.norm(world[pip] - w) + 1e-9)
        straight = np.clip((cos + 0.2) / 1.0, 0, 1)        # cos 0.8 (≈37°) -> 1
        far = np.clip((reach - 0.95) / 0.35, 0, 1)         # Spitze 30 % weiter als PIP -> 1
        out[f] = float(min(straight, far))
    return out


def classify(world, thresh=0.5):
    """Gibt 'stein' | 'papier' | 'schere' | None zurück, plus die Fingerwerte."""
    ext = finger_extension(world)
    up = {f: v > thresh for f, v in ext.items()}
    n = sum(up.values())
    if n == 0:
        g = "stein"
    elif ext["index"] > 0.45 and ext["middle"] > 0.45 and not up["ring"]:
        g = "schere"         # kleiner Finger egal, solange der Ringfinger eingerollt ist
    elif n >= 3 and up["middle"] and up["ring"]:
        g = "papier"
    elif n == 1 and not (up["index"] or up["middle"]):
        g = "stein"          # z. B. nur kleiner Finger leicht offen
    else:
        g = None
    return g, ext


class GestureCamera:
    """Liest Bilder in einem Hintergrund-Thread und klassifiziert jedes Bild."""

    def __init__(self, source="0", model_path=None, history_s=5.0):
        self.source = source
        landmarker_opts = vision.HandLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=ensure_model(model_path or MODEL_PATH)),
            num_hands=1, min_hand_detection_confidence=0.5, min_tracking_confidence=0.5)
        self.landmarker = vision.HandLandmarker.create_from_options(landmarker_opts)
        self.snapshot = isinstance(source, str) and (source.rstrip("/").endswith("capture")
                                                     or source.lower().endswith((".jpg", ".jpeg", ".png")))
        if not self.snapshot:
            src = int(source) if str(source).isdigit() else source
            self.cap = cv2.VideoCapture(src)
            if not self.cap.isOpened():
                raise RuntimeError(f"Kamera/Stream '{source}' lässt sich nicht öffnen")
        self.lock = threading.Lock()
        self.frame = None          # letztes Bild (BGR) mit Overlay
        self.label = None
        self.ext = {}
        self.fps = 0.0
        self.history = collections.deque()   # (zeit, label)
        self.history_s = history_s
        self.running = True
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    # ---------------------------------------------------------------- Bilder holen
    def _read(self):
        if self.snapshot:
            if os.path.exists(self.source):
                img = cv2.imread(self.source)
                time.sleep(0.05)
                return img
            data = urllib.request.urlopen(self.source, timeout=2).read()
            return cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        ok, img = self.cap.read()
        return img if ok else None

    def _loop(self):
        t_last = time.time()
        while self.running:
            try:
                img = self._read()
            except Exception as e:  # WLAN-Aussetzer beim ESP32 etc.
                print("Kamera-Fehler:", e)
                time.sleep(0.5)
                continue
            if img is None:
                time.sleep(0.02)
                continue
            label, ext, pts = self.process(img)
            now = time.time()
            self._draw(img, label, ext, pts)
            with self.lock:
                self.frame, self.label, self.ext = img, label, ext
                self.fps = 0.9 * self.fps + 0.1 / max(now - t_last, 1e-3)
                self.history.append((now, label))
                while self.history and now - self.history[0][0] > self.history_s:
                    self.history.popleft()
            t_last = now

    # ---------------------------------------------------------------- Erkennung
    def process(self, img_bgr):
        rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
        res = self.landmarker.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
        if not res.hand_world_landmarks:
            return None, {}, None
        world = np.array([[p.x, p.y, p.z] for p in res.hand_world_landmarks[0]])
        pts = np.array([[p.x, p.y] for p in res.hand_landmarks[0]])
        label, ext = classify(world)
        return label, ext, pts

    def _draw(self, img, label, ext, pts):
        h, w = img.shape[:2]
        if pts is not None:
            p = (pts * [w, h]).astype(int)
            for a, b in CONNECTIONS:
                cv2.line(img, tuple(p[a]), tuple(p[b]), (0, 255, 0), 2)
            for q in p:
                cv2.circle(img, tuple(q), 3, (0, 0, 255), -1)
        text = (label or ("?" if pts is not None else "keine Hand")).upper()
        cv2.putText(img, text, (10, 35), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (255, 255, 255), 3)
        cv2.putText(img, text, (10, 35), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (0, 120, 255), 2)
        y = h - 10
        for f, v in ext.items():
            cv2.putText(img, f"{f}: {v:.2f}", (10, y), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (255, 255, 0), 1)
            y -= 16

    # ---------------------------------------------------------------- Abfragen
    def latest(self):
        with self.lock:
            return self.label, (None if self.frame is None else self.frame.copy())

    def vote(self, t_from, t_to, min_frames=2):
        """Häufigste Geste im Zeitfenster [t_from, t_to] (Wanduhr-Zeit). None, wenn unklar."""
        with self.lock:
            labels = [l for t, l in self.history if t_from <= t <= t_to and l]
        if len(labels) < min_frames:
            return None, len(labels)
        g, n = collections.Counter(labels).most_common(1)[0]
        return (g if n / len(labels) >= 0.5 else None), len(labels)

    def close(self):
        self.running = False
        self.thread.join(timeout=2)
        if not self.snapshot:
            self.cap.release()
        self.landmarker.close()


def show(cam, title="Gestenerkennung"):
    """Kamerabild anzeigen (im Hauptthread aufrufen). Gibt die gedrückte Taste zurück."""
    _, frame = cam.latest()
    if frame is not None:
        cv2.imshow(title, frame)
    return cv2.waitKey(1) & 0xFF


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default="0")
    ap.add_argument("--image", help="nur ein Bild klassifizieren")
    a = ap.parse_args()
    if a.image:
        opts = vision.HandLandmarkerOptions(base_options=BaseOptions(model_asset_path=ensure_model()),
                                            num_hands=1)
        lm = vision.HandLandmarker.create_from_options(opts)
        img = cv2.cvtColor(cv2.imread(a.image), cv2.COLOR_BGR2RGB)
        res = lm.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=img))
        if not res.hand_world_landmarks:
            print("keine Hand gefunden")
        else:
            w = np.array([[p.x, p.y, p.z] for p in res.hand_world_landmarks[0]])
            g, ext = classify(w)
            print(g, {k: round(v, 2) for k, v in ext.items()})
        lm.close()
        return
    cam = GestureCamera(a.source)
    print("Fenster aktiv – q oder ESC beendet.")
    try:
        while True:
            k = show(cam)
            if k in (ord("q"), 27):
                break
    finally:
        cam.close()
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
