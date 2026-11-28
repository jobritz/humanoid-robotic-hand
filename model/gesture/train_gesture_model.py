"""
SCRUM-37: Gesten-Modell mit Aktuator-Stellungen als Input
=========================================================

Umbau des bisherigen Bildmodells (model/train_model.py): Statt eines Kamerabildes bekommt das Modell die Stellungen
der 8 Aktuatoren der Amazing Hand (in rad) und erkennt daraus die Geste. Ein- und Ausgabe siehe gesture_common.py.

Modell: kleines vollverbundenes Netz (MLP). Die Normalisierung der Eingabe auf -1..1 ist als erste Schicht im
Modell enthalten, wer das Modell ausfuehrt, uebergibt also direkt die Werte in rad.
Export als float32-TFLite: laeuft unveraendert in der Browser-Simulation (LiteRT.js), auf dem PC und auf dem
Raspberry Pi (LiteRT/TensorFlow Lite).

Trainingsdaten: eine oder mehrere CSV-Dateien aus der Browser-Simulation ("Trainingsdaten aufnehmen") mit den
Spalten 'label' und index_flex, index_abd, middle_flex, middle_abd, ring_flex, ring_abd, thumb_flex, thumb_abd.
Weitere Spalten werden ignoriert, Zeilen ohne Label uebersprungen.

Ergebnis (im Ordner --out, Standard ./output):
  gesture.tflite  -> das Modell
  labels.txt      -> welche Output-Nummer welche Geste ist
  report.txt      -> Datenmenge, Genauigkeit, Verwechslungsmatrix

Beispiel:
  python train_gesture_model.py --data aufnahme1.csv aufnahme2.csv
"""

import argparse
import os
import sys
from collections import Counter
from pathlib import Path

import numpy as np

from gesture_common import ACTUATORS, RANGES, load_csv

MIN_PER_CLASS = 5  # darunter ist weder Training noch Test sinnvoll


def build_model(n_classes: int, hidden: list[int]):
    import tensorflow as tf
    from tensorflow.keras import layers as L

    lo = np.array([r[0] for r in RANGES], dtype=np.float32)
    hi = np.array([r[1] for r in RANGES], dtype=np.float32)
    # Feste Normalisierung auf -1..1 anhand der Stellbereiche (nicht aus den Daten gelernt, damit sie bei wenigen
    # oder einseitigen Aufnahmen nicht verrutscht).
    norm = L.Normalization(mean=(lo + hi) / 2, variance=((hi - lo) / 2) ** 2, name="normalize")

    inp = L.Input((len(ACTUATORS),), name="actuators")
    x = norm(inp)
    for units in hidden:
        x = L.Dense(units, activation="relu")(x)
        x = L.Dropout(0.1)(x)  # nur im Training aktiv
    out = L.Dense(n_classes, activation="softmax", name="gesture")(x)
    return tf.keras.Model(inp, out)


def stratified_split(y: np.ndarray, val_split: float, rng):
    """Pro Geste den gleichen Anteil zufaellig zum Testen zuruecklegen."""
    train_idx, val_idx = [], []
    for c in np.unique(y):
        idx = rng.permutation(np.where(y == c)[0])
        k = max(1, int(round(len(idx) * val_split)))
        val_idx += list(idx[:k])
        train_idx += list(idx[k:])
    return np.array(train_idx), np.array(val_idx)


def convert_tflite(model) -> bytes:
    import tensorflow as tf
    # Ohne Optimierungen: float32 rein, float32 raus, nur Standard-Operatoren.
    return tf.lite.TFLiteConverter.from_keras_model(model).convert()


def run_tflite(tflite: bytes, x: np.ndarray):
    import warnings
    import tensorflow as tf
    warnings.filterwarnings("ignore", message=".*tf.lite.Interpreter is deprecated.*")
    # Ohne XNNPACK-Delegate, damit die echten Operatoren sichtbar sind (sonst steht dort nur DELEGATE).
    interp = tf.lite.Interpreter(
        model_content=tflite,
        experimental_op_resolver_type=tf.lite.experimental.OpResolverType.BUILTIN_WITHOUT_DEFAULT_DELEGATES)
    interp.allocate_tensors()
    inp, out = interp.get_input_details()[0], interp.get_output_details()[0]
    ops = sorted({op["op_name"] for op in interp._get_ops_details()})
    scores = []
    for row in x:
        interp.set_tensor(inp["index"], row[None].astype(np.float32))
        interp.invoke()
        scores.append(interp.get_tensor(out["index"])[0].copy())
    return np.array(scores), inp, out, ops


def confusion_text(y_true, y_pred, classes) -> list[str]:
    width = max(8, *(len(c) for c in classes))
    lines = ["Verwechslungsmatrix (Zeile = tatsaechlich, Spalte = erkannt):",
             " " * width + "".join(f"{c:>{width + 1}}" for c in classes)]
    for i, c in enumerate(classes):
        counts = [int(np.sum((y_true == i) & (y_pred == j))) for j in range(len(classes))]
        lines.append(f"{c:<{width}}" + "".join(f"{n:>{width + 1}}" for n in counts))
    return lines


def main():
    p = argparse.ArgumentParser(description="Trainiert das Gesten-Modell mit Aktuator-Stellungen als Input.")
    p.add_argument("--data", type=Path, nargs="+", required=True, help="CSV-Datei(en) aus der Browser-Aufnahme")
    p.add_argument("--out", type=Path, default=Path("output"))
    p.add_argument("--hidden", type=int, nargs="+", default=[32, 16], help="Neuronen je verdeckter Schicht")
    p.add_argument("--epochs", type=int, default=500)
    p.add_argument("--batch", type=int, default=32)
    p.add_argument("--patience", type=int, default=60,
                   help="Abbruch, wenn sich die Testgenauigkeit so viele Runden nicht verbessert")
    p.add_argument("--val-split", type=float, default=0.2, help="Anteil der Datensaetze nur zum Testen")
    p.add_argument("--seed", type=int, default=42)
    args = p.parse_args()

    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")

    print(f"\n1) Lade Daten aus {', '.join(str(d) for d in args.data)}")
    x, names, skipped = load_csv(args.data)
    counts = Counter(names)
    print(f"   {len(x)} Datensaetze mit Label, {skipped} ohne Label/ungueltig uebersprungen")
    for name, n in sorted(counts.items()):
        print(f"   {name:<10} {n}")
    classes = sorted(counts)
    too_few = [c for c in classes if counts[c] < MIN_PER_CLASS]
    if len(classes) < 2:
        sys.exit("Fehler: Es braucht Datensaetze fuer mindestens 2 verschiedene Gesten.")
    if too_few:
        sys.exit(f"Fehler: Zu wenige Datensaetze (< {MIN_PER_CLASS}) fuer: {', '.join(too_few)}")
    y = np.array([classes.index(n) for n in names], dtype=np.int64)

    import tensorflow as tf
    tf.keras.utils.set_random_seed(args.seed)
    rng = np.random.default_rng(args.seed)
    train_idx, val_idx = stratified_split(y, args.val_split, rng)
    x_tr, y_tr, x_va, y_va = x[train_idx], y[train_idx], x[val_idx], y[val_idx]
    print(f"   {len(x_tr)} zum Trainieren, {len(x_va)} zum Testen")

    print("\n2) Baue Modell")
    model = build_model(len(classes), args.hidden)
    print(f"   8 -> {' -> '.join(map(str, args.hidden))} -> {len(classes)}, {model.count_params():,} Parameter")

    print("\n3) Trainiere")
    # Seltene Gesten staerker gewichten, damit das Modell nicht einfach die haeufigste raet.
    weights = {i: len(y_tr) / (len(classes) * max(1, np.sum(y_tr == i))) for i in range(len(classes))}
    model.compile(optimizer=tf.keras.optimizers.Adam(3e-3), loss="sparse_categorical_crossentropy",
                  metrics=[tf.keras.metrics.SparseCategoricalAccuracy(name="acc")])
    model.fit(x_tr, y_tr, validation_data=(x_va, y_va), epochs=args.epochs, batch_size=args.batch,
              class_weight=weights, verbose=0,
              callbacks=[tf.keras.callbacks.EarlyStopping("val_acc", patience=args.patience, mode="max",
                                                          restore_best_weights=True)])
    float_acc = model.evaluate(x_va, y_va, verbose=0)[1]

    print("\n4) Exportiere als TFLite und pruefe")
    tflite = convert_tflite(model)
    scores, inp, out, ops = run_tflite(tflite, x_va)
    pred = scores.argmax(axis=1)
    tflite_acc = float(np.mean(pred == y_va))
    reference = model.predict(x_va, verbose=0)
    max_diff = float(np.abs(reference - scores).max())

    problems = []
    if inp["dtype"] != np.float32 or list(inp["shape"]) != [1, len(ACTUATORS)]:
        problems.append(f"Input ist {inp['dtype'].__name__} {list(inp['shape'])}, erwartet float32 [1, 8]")
    if list(out["shape"]) != [1, len(classes)]:
        problems.append(f"Output hat Form {list(out['shape'])}, erwartet [1, {len(classes)}]")
    if max_diff > 1e-4:
        problems.append(f"TFLite weicht vom Keras-Modell ab (max. {max_diff:.2e})")

    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "gesture.tflite").write_bytes(tflite)
    (args.out / "labels.txt").write_text("".join(f"Output[{i}] = {c}\n" for i, c in enumerate(classes)))

    report = [
        f"Gesten ({len(classes)}): " + ", ".join(f"Output[{i}]={c}" for i, c in enumerate(classes)),
        "Input: float32 [1, 8] in rad: " + ", ".join(ACTUATORS),
        f"Daten: {len(x)} Datensaetze ({', '.join(f'{c} {counts[c]}' for c in classes)}), "
        f"{len(x_tr)} Training / {len(x_va)} Test",
        f"Testgenauigkeit Keras-Modell: {float_acc:.1%}",
        f"Testgenauigkeit TFLite-Modell: {tflite_acc:.1%}",
        f"Modellgroesse: {len(tflite):,} Bytes",
        f"Operatoren: {', '.join(ops)}",
        "",
        *confusion_text(y_va, pred, classes),
        "",
        "Checks: " + ("alle OK" if not problems else "PROBLEME:\n  - " + "\n  - ".join(problems)),
    ]
    (args.out / "report.txt").write_text("\n".join(report) + "\n")

    print("\n5) Ergebnis\n   " + "\n   ".join(report))
    print(f"\nDateien in {args.out.resolve()}: gesture.tflite, labels.txt, report.txt")
    if problems:
        sys.exit(1)


if __name__ == "__main__":
    main()
