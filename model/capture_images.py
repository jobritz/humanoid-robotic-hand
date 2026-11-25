"""
SCRUM-23: Trainingsbilder aufnehmen
===================================

Zeigt das Kamerabild live an. Mit den Zahlentasten speicherst du Bilder
in den passenden Klassen-Ordner. Die Bilder werden wie beim ESP32 als
Graustufen in 320x240 (QVGA) gespeichert.

Quelle:
  --source 0                     Laptop-Webcam (0, 1, ... je nach Kamera)
  --source http://192.168.x.y/   ESP32-CAM-Stream aus esp/esp32cam (empfohlen:
                                 dann sehen die Trainingsbilder genau so aus
                                 wie spaeter auf dem ESP32)

Tasten:
  1, 2, 3, ...   ein Bild fuer Klasse 1, 2, 3 ... speichern (gedrueckt halten = viele)
  q / Esc        beenden

Beispiel:
  python capture_images.py --source 0 --classes stein schere papier nichts

Tipps: Hand gross ins Bild (30-50 cm vor der Kamera), Ort/Licht/Hand wechseln,
"nichts" = Bilder ohne Hand (leerer Hintergrund, nur Gesicht, ...).
"""

import argparse
import time
from pathlib import Path

import cv2
import numpy as np

QVGA = (64, 48) # 320x240 / 5


def to_qvga_gray(frame: np.ndarray) -> np.ndarray:
    """Center-Crop auf 4:3 und Verkleinern auf 320x240, dann Graustufen."""
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) if frame.ndim == 3 else frame
    h, w = gray.shape
    if w * 3 > h * 4:
        cw, ch = h * 4 // 3, h
    else:
        cw, ch = w, w * 3 // 4
    x0, y0 = (w - cw) // 2, (h - ch) // 2
    return cv2.resize(gray[y0:y0 + ch, x0:x0 + cw], QVGA, interpolation=cv2.INTER_AREA)


def main():
    p = argparse.ArgumentParser(description="Trainingsbilder fuer das Hand-Modell aufnehmen.")
    p.add_argument("--source", default="0", help="Webcam-Nummer oder URL der ESP32-CAM")
    p.add_argument("--classes", nargs="+", default=["rock", "scissors", "paper", "nothing"],
                   help="Namen der Klassen (Taste 1 = erste Klasse, ...)")
    p.add_argument("--data", type=Path, default=Path("data"), help="Zielordner")
    p.add_argument("--interval", type=float, default=0.15,
                   help="Mindestabstand zwischen zwei Bildern in Sekunden")
    args = p.parse_args()

    if len(args.classes) > 9:
        raise SystemExit("Maximal 9 Klassen (Tasten 1-9).")

    for c in args.classes:
        (args.data / c).mkdir(parents=True, exist_ok=True)
    counts = {c: len(list((args.data / c).glob("*.png"))) for c in args.classes}

    source = int(args.source) if args.source.isdigit() else args.source
    # macOS fragt beim ersten Mal nach der Kamera-Erlaubnis -> bis zu 30 s warten.
    cap = None
    for attempt in range(15):
        cap = cv2.VideoCapture(source)
        if cap.isOpened():
            break
        cap.release()
        if attempt == 0:
            print("Warte auf Kamera ... (falls der Mac fragt: Kamera-Zugriff fuer Terminal erlauben)")
        time.sleep(2)
    if cap is None or not cap.isOpened():
        raise SystemExit(
            f"Kamera '{args.source}' konnte nicht geoeffnet werden.\n"
            "Mac: Systemeinstellungen -> Datenschutz & Sicherheit -> Kamera -> 'Terminal' einschalten,\n"
            "dann diese Datei nochmal starten.")

    print("Tasten: " + ", ".join(f"{i+1}={c}" for i, c in enumerate(args.classes)) + ", q=Ende")
    last_save = 0.0
    flash = ""
    while True:
        ok, frame = cap.read()
        if not ok:
            print("Kein Bild von der Kamera - versuche erneut ...")
            time.sleep(0.5)
            continue

        img = to_qvga_gray(frame)

        view = cv2.cvtColor(cv2.resize(img, (640, 480), interpolation=cv2.INTER_NEAREST), cv2.COLOR_GRAY2BGR)
        y = 24
        for i, c in enumerate(args.classes):
            cv2.putText(view, f"{i+1}: {c} ({counts[c]})", (10, y),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)
            y += 24
        cv2.putText(view, "Hand gross ins Bild! Ort/Licht wechseln.", (10, 440),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 0), 1)
        if flash:
            cv2.putText(view, flash, (10, 465), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 200, 255), 2)
        cv2.imshow("Trainingsbilder aufnehmen (q = Ende)", view)

        key = cv2.waitKey(1) & 0xFF
        if key in (ord("q"), 27):
            break
        if ord("1") <= key < ord("1") + len(args.classes) and time.time() - last_save >= args.interval:
            c = args.classes[key - ord("1")]
            name = f"{c}_{time.strftime('%Y%m%d_%H%M%S')}_{counts[c]:04d}.png"
            cv2.imwrite(str(args.data / c / name), img)
            counts[c] += 1
            last_save = time.time()
            flash = f"gespeichert: {c} #{counts[c]}"

    cap.release()
    cv2.destroyAllWindows()
    print("Bilder pro Klasse: " + ", ".join(f"{c}={n}" for c, n in counts.items()))


if __name__ == "__main__":
    main()
