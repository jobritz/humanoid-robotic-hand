"""
Gesten-Modell ausfuehren: 8 Aktuator-Stellungen (rad) rein, erkannte Geste raus.

Laeuft mit TensorFlow oder - z. B. auf dem Raspberry Pi - nur mit dem kleinen Paket ai-edge-litert.

Beispiele:
  python predict_gesture.py 1.57 0 1.57 0 1.57 0 1.57 0
  python predict_gesture.py --csv aufnahme.csv          # alle Zeilen auswerten, mit Label: Genauigkeit
"""

import argparse
from pathlib import Path

import numpy as np

from gesture_common import ACTUATORS, load_csv, read_labels

HERE = Path(__file__).resolve().parent


def load_interpreter(model_path: Path):
    try:
        from ai_edge_litert.interpreter import Interpreter
    except ImportError:
        import warnings
        import tensorflow as tf
        warnings.filterwarnings("ignore", message=".*tf.lite.Interpreter is deprecated.*")
        Interpreter = tf.lite.Interpreter
    interp = Interpreter(model_path=str(model_path))
    interp.allocate_tensors()
    return interp


class GestureModel:
    """Kleine Huelle um das TFLite-Modell, zum Einbinden in eigenen Code."""

    def __init__(self, model_path=HERE / "output" / "gesture.tflite", labels_path=None):
        model_path = Path(model_path)
        self.labels = read_labels(Path(labels_path) if labels_path else model_path.with_name("labels.txt"))
        self.interp = load_interpreter(model_path)
        self.inp = self.interp.get_input_details()[0]
        self.out = self.interp.get_output_details()[0]

    def predict(self, values) -> np.ndarray:
        """values: 8 Stellungen in rad (Reihenfolge wie ACTUATORS) -> Wahrscheinlichkeit je Geste."""
        x = np.asarray(values, dtype=np.float32).reshape(1, len(ACTUATORS))
        self.interp.set_tensor(self.inp["index"], x)
        self.interp.invoke()
        return self.interp.get_tensor(self.out["index"])[0].copy()

    def gesture(self, values) -> tuple[str, float]:
        scores = self.predict(values)
        best = int(scores.argmax())
        return self.labels[best], float(scores[best])


def main():
    p = argparse.ArgumentParser(description="Erkennt die Geste aus 8 Aktuator-Stellungen (rad).")
    p.add_argument("values", type=float, nargs="*", help=f"8 Werte in rad: {' '.join(ACTUATORS)}")
    p.add_argument("--csv", type=Path, help="CSV aus der Browser-Aufnahme statt Einzelwerten")
    p.add_argument("--model", type=Path, default=HERE / "output" / "gesture.tflite")
    args = p.parse_args()

    model = GestureModel(args.model)
    if args.csv:
        x, names, skipped = load_csv([args.csv])
        known = [n in model.labels for n in names]
        pred = [model.gesture(row)[0] for row in x]
        correct = sum(p == n for p, n, k in zip(pred, names, known) if k)
        print(f"{len(x)} Datensaetze mit Label ausgewertet ({skipped} uebersprungen)")
        if any(known):
            print(f"Richtig erkannt: {correct}/{sum(known)} ({correct / sum(known):.1%})")
        return
    if len(args.values) != len(ACTUATORS):
        p.error(f"Es werden genau {len(ACTUATORS)} Werte erwartet ({' '.join(ACTUATORS)}).")
    scores = model.predict(args.values)
    for label, s in sorted(zip(model.labels, scores), key=lambda t: -t[1]):
        print(f"{label:<10} {s:6.1%}")


if __name__ == "__main__":
    main()
