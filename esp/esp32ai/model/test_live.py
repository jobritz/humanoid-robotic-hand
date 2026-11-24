"""
SCRUM-23: Modell live mit der Kamera testen
===========================================

Laedt output/hand.tflite (das int8-Modell fuer den ESP32) und zeigt live,
welche Geste es erkennt. Die Vorverarbeitung ist identisch zum ESP32:
Graustufen -> Center-Crop -> 80x60 -> Pixel - 128 -> int8.

  python test_live.py                      # Laptop-Webcam
  python test_live.py --source http://IP/  # ESP32-CAM-Stream

Bewerten (du sagst, was du WIRKLICH zeigst):
  1 = stein, 2 = schere, 3 = papier, 4 = nichts
  -> wird mit der Erkennung verglichen und mitgezaehlt.
  -> falsch erkannte Bilder landen in data/<geste>/ (Praefix "fehler_"),
     damit das Modell beim naechsten Training daraus lernt.
Taste q / Esc = beenden, Auswertung steht danach in test_ergebnis.txt
"""

import argparse
import os
import time
from pathlib import Path

os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")

import cv2
import numpy as np

from capture_images import to_qvga_gray
from train_model import preprocess_like_esp32


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--source", default="0", help="Webcam-Nummer oder URL der ESP32-CAM")
    p.add_argument("--model", type=Path, default=Path("output/hand.tflite"))
    p.add_argument("--labels", type=Path, default=Path("output/labels.txt"))
    p.add_argument("--keys", nargs="+", default=["stein", "schere", "papier", "nichts"],
                   help="Klassen fuer die Tasten 1, 2, 3 (wie bei capture_images.py)")
    p.add_argument("--data", type=Path, default=Path("data"), help="wohin falsch erkannte Bilder kommen")
    args = p.parse_args()

    import tensorflow as tf
    interp = tf.lite.Interpreter(model_path=str(args.model))
    interp.allocate_tensors()
    inp = interp.get_input_details()[0]
    out = interp.get_output_details()[0]
    _, h, w, _ = inp["shape"]
    o_scale, o_zp = out["quantization"]
    labels = [line.split("=", 1)[1].strip() for line in args.labels.read_text().splitlines() if "=" in line]

    source = int(args.source) if args.source.isdigit() else args.source
    cap = None
    for attempt in range(15):
        cap = cv2.VideoCapture(source)
        if cap.isOpened():
            break
        cap.release()
        time.sleep(2)
    if cap is None or not cap.isOpened():
        raise SystemExit(f"Kamera '{args.source}' konnte nicht geoeffnet werden.")

    args.keys = [k for k in args.keys if k in labels]  # nur Klassen, die das Modell kennt
    confusion = {t: {p_: 0 for p_ in labels} for t in args.keys}
    last_key, last_msg = 0.0, ""

    print("Laeuft. Kamerafenster anklicken. Taste " +
          ", ".join(f"{i+1}={k}" for i, k in enumerate(args.keys)) +
          " = was du wirklich zeigst. q = Ende.")
    while True:
        ok, frame = cap.read()
        if not ok:
            time.sleep(0.1)
            continue
        gray = to_qvga_gray(frame)
        small = preprocess_like_esp32(gray, w, h)
        q = (small.astype(np.int32) - 128).astype(np.int8)[None, ..., None]
        interp.set_tensor(inp["index"], q)
        interp.invoke()
        raw = interp.get_tensor(out["index"])[0].astype(np.float32)
        scores = (raw - o_zp) * o_scale
        best = int(np.argmax(scores))

        view = cv2.cvtColor(cv2.resize(gray, (640, 480)), cv2.COLOR_GRAY2BGR)
        # was das Modell wirklich sieht (80x60), oben rechts
        mini = cv2.cvtColor(cv2.resize(small, (w * 2, h * 2), interpolation=cv2.INTER_NEAREST), cv2.COLOR_GRAY2BGR)
        view[10:10 + mini.shape[0], 630 - mini.shape[1]:630] = mini

        color = (0, 220, 0) if scores[best] >= 0.6 else (0, 200, 255)
        cv2.putText(view, f"{labels[best].upper()}", (10, 50), cv2.FONT_HERSHEY_SIMPLEX, 1.5, color, 3)
        for i, (name, s) in enumerate(zip(labels, scores)):
            y = 90 + i * 30
            cv2.rectangle(view, (10, y), (10 + int(200 * float(np.clip(s, 0, 1))), y + 20), (0, 220, 0) if i == best else (160, 160, 160), -1)
            cv2.putText(view, f"{name} {s:.2f}", (220, y + 16), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
        # Zaehler unten links
        y = 470 - 26 * len(args.keys)
        for i, t in enumerate(args.keys):
            n = sum(confusion[t].values()); r = confusion[t][t]
            txt = f"{i+1}={t}: {r}/{n} richtig" if n else f"{i+1}={t}: -"
            cv2.putText(view, txt, (10, y + i * 26), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 0), 2)
        if last_msg and time.time() - last_key < 1.5:
            ok_ = last_msg.startswith("RICHTIG")
            cv2.putText(view, last_msg, (300, 470), cv2.FONT_HERSHEY_SIMPLEX, 0.7,
                        (0, 220, 0) if ok_ else (0, 0, 255), 2)
        cv2.imshow("Modell-Test (q = Ende)", view)

        key = cv2.waitKey(1) & 0xFF
        if key in (ord("q"), 27):
            break
        if ord("1") <= key < ord("1") + len(args.keys) and time.time() - last_key > 0.4:
            truth = args.keys[key - ord("1")]
            pred = labels[best]
            confusion[truth][pred] += 1
            last_key = time.time()
            if pred == truth:
                last_msg = f"RICHTIG: {truth}"
            else:
                last_msg = f"FALSCH: {truth} als {pred} erkannt"
                (args.data / truth).mkdir(parents=True, exist_ok=True)
                cv2.imwrite(str(args.data / truth / f"fehler_{time.strftime('%Y%m%d_%H%M%S')}_{int(time.time()*1000)%1000:03d}.png"), gray)

    cap.release()
    cv2.destroyAllWindows()

    lines = ["Live-Test des Modells " + str(args.model), time.strftime("%d.%m.%Y %H:%M"), ""]
    total = sum(sum(v.values()) for v in confusion.values())
    right = sum(confusion[t][t] for t in args.keys)
    for t in args.keys:
        n = sum(confusion[t].values())
        if n:
            wrong = ", ".join(f"{c}x als {p_}" for p_, c in confusion[t].items() if p_ != t and c)
            lines.append(f"{t:<8} {confusion[t][t]:>3}/{n:<3} richtig ({confusion[t][t]/n:.0%})" + (f"  - verwechselt: {wrong}" if wrong else ""))
    lines.append("")
    lines.append(f"GESAMT   {right}/{total} richtig ({right/total:.0%})" if total else "Keine Bewertungen abgegeben.")
    if total - right:
        lines.append(f"{total - right} falsch erkannte Bilder wurden in {args.data}/ gespeichert -> beim naechsten Training dabei.")
    report = "\n".join(lines)
    Path("test_ergebnis.txt").write_text(report + "\n")
    print("\n" + report)


if __name__ == "__main__":
    main()
