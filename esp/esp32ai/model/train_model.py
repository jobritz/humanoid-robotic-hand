"""
SCRUM-23: Trainierbares KI-Modell fuer den ESP32 (esp/esp32ai)
==============================================================

Trainiert ein kleines Bild-Klassifikationsmodell auf Graustufen-Fotos und
exportiert es genau in dem Format, das esp/esp32ai/main/esp32ai.cc erwartet:

  * Input:  int8, Form [1, HOEHE, BREITE, 1]  (Standard 60 x 80)
            Der ESP32 schreibt (Graustufe - 128) als int8 in den Input.
            Das Modell rechnet intern mit (Graustufe - 128) / 128, also -1..1.
            Das passt genau, wenn die Input-Quantisierung Skala 1/128 und
            Zero-Point 0 hat - das erzwingt und prueft dieses Skript.
  * Output: int8, eine Zahl pro Klasse (Sigmoid, 0..1)
  * Nur Operatoren, die der ESP32-Resolver kennt:
            Conv2D, DepthwiseConv2D, Mean, FullyConnected, Logistic, Reshape

Ergebnis (im Ordner --out, Standard ./output):
  hand.tflite   -> ersetzt esp/esp32ai/hand.tflite
  model.cc      -> ersetzt esp/esp32ai/main/model.cc
  labels.txt    -> welche Output-Nummer welche Geste ist
  report.txt    -> Genauigkeit, Modellgroesse, Speicher-Schaetzung

Trainingsdaten: ein Ordner pro Klasse, Name = Klasse, darin Bilder (png/jpg/bmp).
  data/
    papier/  *.png
    schere/  *.png
    stein/   *.png
Anzahl Klassen = Anzahl Unterordner (= Anzahl Outputs).

Beispiele:
  python train_model.py --data data
  python train_model.py --data data --width 96 --height 72
"""

import argparse
import os
import sys
from pathlib import Path

import numpy as np

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".bmp"}

# Operatoren, die esp32ai.cc in seinem MicroMutableOpResolver registriert.
ESP32_SUPPORTED_OPS = {
    "CONV_2D", "DEPTHWISE_CONV_2D", "MEAN", "FULLY_CONNECTED", "LOGISTIC", "RESHAPE",
}
ESP32_ARENA_BYTES = 32 * 1024  # kArena in esp32ai.cc


def normalize(pixels):
    """0..255 -> -1..1, passend zu 'Graustufe - 128' auf dem ESP32."""
    return (pixels - 128.0) / 128.0


# --------------------------------------------------------------------------
# Vorverarbeitung - identisch zu preprocess_frame() in esp32ai.cc
# --------------------------------------------------------------------------
def preprocess_like_esp32(gray: np.ndarray, width: int, height: int) -> np.ndarray:
    """Center-Crop auf das Seitenverhaeltnis des Modells, dann Mittelwert-
    Verkleinerung auf width x height. Gibt uint8 [height, width] zurueck.
    Gleiche Ganzzahl-Rechnung wie auf dem ESP32."""
    fh, fw = gray.shape
    crop_w, crop_h = fw, fh
    if crop_w * height > crop_h * width:
        crop_w = crop_h * width // height
    else:
        crop_h = crop_w * height // width
    if crop_w < width or crop_h < height:
        raise ValueError(f"Bild {fw}x{fh} ist kleiner als Modell-Input {width}x{height}")
    cx = (fw - crop_w) // 2
    cy = (fh - crop_h) // 2

    out = np.empty((height, width), dtype=np.uint8)
    src = gray.astype(np.uint32)
    for y in range(height):
        y0 = cy + y * crop_h // height
        y1 = cy + (y + 1) * crop_h // height
        for x in range(width):
            x0 = cx + x * crop_w // width
            x1 = cx + (x + 1) * crop_w // width
            block = src[y0:y1, x0:x1]
            out[y, x] = block.sum() // block.size
    return out


def load_gray(path: Path) -> np.ndarray:
    from PIL import Image
    with Image.open(path) as img:
        return np.asarray(img.convert("L"))


def load_dataset(data_dir: Path, width: int, height: int):
    classes = sorted(p.name for p in data_dir.iterdir() if p.is_dir() and not p.name.startswith("."))
    if len(classes) < 2:
        sys.exit(f"Fehler: In {data_dir} braucht es mindestens 2 Unterordner (einen pro Klasse).")

    images, labels = [], []
    for idx, name in enumerate(classes):
        files = sorted(f for f in (data_dir / name).rglob("*") if f.suffix.lower() in IMAGE_EXT)
        if not files:
            sys.exit(f"Fehler: Ordner '{name}' enthaelt keine Bilder.")
        for f in files:
            try:
                images.append(preprocess_like_esp32(load_gray(f), width, height))
                labels.append(idx)
            except Exception as e:  # kaputte/zu kleine Bilder ueberspringen
                print(f"  uebersprungen: {f} ({e})")
        print(f"  Klasse {idx}: {name:<12} {labels.count(idx)} Bilder")

    x = np.stack(images)[..., None].astype(np.float32)  # Werte 0..255
    y = np.array(labels, dtype=np.int64)
    return x, y, classes


# --------------------------------------------------------------------------
# Modell - gleiche Architektur wie create_model.py im Repo, aber einstellbar
# --------------------------------------------------------------------------
def build_model(width, height, n_classes, stem_filters, blocks, dense_units):
    import tensorflow as tf
    from tensorflow.keras import layers as L

    def block(x, f, s):
        x = L.DepthwiseConv2D(3, strides=s, padding="same", use_bias=False)(x)
        x = L.BatchNormalization(momentum=0.9)(x); x = L.ReLU(6.)(x)
        x = L.Conv2D(f, 1, use_bias=False)(x)
        x = L.BatchNormalization(momentum=0.9)(x); return L.ReLU(6.)(x)

    inp = L.Input((height, width, 1))  # erwartet normalize()-te Werte (-1..1)
    x = L.Conv2D(stem_filters, 3, strides=2, padding="same", use_bias=False)(inp)
    x = L.BatchNormalization(momentum=0.9)(x); x = L.ReLU(6.)(x)
    for f, s in blocks:
        x = block(x, f, s)
    x = L.GlobalAveragePooling2D()(x)
    x = L.Dense(dense_units, activation="relu")(x)
    x = L.Dropout(0.3)(x)  # nur im Training aktiv, verschwindet im Export
    out = L.Dense(n_classes, activation="sigmoid")(x)
    return tf.keras.Model(inp, out)


_GEO = None


MOBILENET_URL = ("https://github.com/fchollet/deep-learning-models/releases/download/"
                 "v0.6/mobilenet_2_5_128_tf_no_top.h5")
# (Filter, Stride) der MobileNetV1-Bloecke bei alpha=0.25
MOBILENET_BLOCKS = [(16, 1), (32, 2), (32, 1), (64, 2), (64, 1), (128, 2),
                    (128, 1), (128, 1), (128, 1), (128, 1), (128, 1), (256, 2), (256, 1)]


def build_mobilenet(width, height, n_classes, n_blocks, dense_units):
    """Vortrainiertes MobileNetV1 (alpha 0.25, ImageNet) fuer 1 Graustufen-Kanal.

    Nachgebaut mit padding="same" (ohne ZeroPadding/PAD-Operator, den der
    ESP32-Resolver nicht kennt) und auf n_blocks Bloecke gekuerzt, damit
    Modell und Tensor-Arena klein bleiben. Die ImageNet-Gewichte werden
    uebernommen; die erste Schicht wird von RGB auf Graustufen umgerechnet
    (Summe ueber die Farbkanaele)."""
    import tensorflow as tf
    from tensorflow.keras import layers as L

    ref = tf.keras.applications.MobileNet(
        input_shape=(128, 128, 3), alpha=0.25, include_top=False,
        weights=tf.keras.utils.get_file("mobilenet_2_5_128_tf_no_top.h5", MOBILENET_URL))

    inp = L.Input((height, width, 1))
    x = L.Conv2D(8, 3, strides=2, padding="same", use_bias=False, name="conv1")(inp)
    x = L.BatchNormalization(name="conv1_bn")(x); x = L.ReLU(6., name="conv1_relu")(x)
    for i, (f, st) in enumerate(MOBILENET_BLOCKS[:n_blocks], start=1):
        x = L.DepthwiseConv2D(3, strides=st, padding="same", use_bias=False, name=f"conv_dw_{i}")(x)
        x = L.BatchNormalization(name=f"conv_dw_{i}_bn")(x); x = L.ReLU(6.)(x)
        x = L.Conv2D(f, 1, use_bias=False, name=f"conv_pw_{i}")(x)
        x = L.BatchNormalization(name=f"conv_pw_{i}_bn")(x); x = L.ReLU(6.)(x)
    backbone = tf.keras.Model(inp, x, name="backbone")

    for layer in backbone.layers:
        if not layer.weights:
            continue
        w = ref.get_layer(layer.name).get_weights()
        if layer.name == "conv1":
            w = [w[0].sum(axis=2, keepdims=True)]  # RGB -> Graustufe
        layer.set_weights(w)

    y = L.GlobalAveragePooling2D()(backbone.output)
    y = L.Dense(dense_units, activation="relu")(y)
    y = L.Dropout(0.3)(y)
    out = L.Dense(n_classes, activation="sigmoid")(y)
    return tf.keras.Model(inp, out), backbone


def augment(img, label):
    """Zufaellige Veraenderungen, damit das Modell robuster wird und nicht am
    Hintergrund/Bildausschnitt haengen bleibt: Spiegeln, Drehen, Zoomen,
    Verschieben, Helligkeit, Kontrast, Rauschen. Nur beim Training."""
    import tensorflow as tf
    global _GEO
    if _GEO is None:
        L = tf.keras.layers
        _GEO = tf.keras.Sequential([
            L.RandomRotation(0.06, fill_mode="reflect"),            # ca. +-20 Grad
            L.RandomZoom((-0.35, 0.15), fill_mode="reflect"),       # bis 35 % reinzoomen
            L.RandomTranslation(0.15, 0.15, fill_mode="reflect"),
        ])
    img = tf.image.random_flip_left_right(img)
    img = _GEO(img[None], training=True)[0]
    img = (img - 128.0) * tf.random.uniform([], 0.7, 1.3) + 128.0     # Kontrast
    img = img + tf.random.uniform([], -30.0, 30.0)                     # Helligkeit
    img = img + tf.random.normal(tf.shape(img), stddev=4.0)            # Rauschen
    return normalize(tf.clip_by_value(img, 0.0, 255.0)), label


# --------------------------------------------------------------------------
# Export
# --------------------------------------------------------------------------
def convert_int8(model, x_train):
    import tensorflow as tf

    def representative():
        # Ein schwarzes (Pixel 0) und ein weisses (Pixel 255) Bild fixieren den
        # Input-Bereich. Dann ist Skala = 1/128 und Zero-Point = 0, und
        # 'Graustufe - 128' aus esp32ai.cc ist genau der richtige int8-Wert.
        shape = (1,) + x_train.shape[1:]
        yield [normalize(np.zeros(shape, np.float32))]
        yield [normalize(np.full(shape, 255.0, np.float32))]
        idx = np.random.default_rng(0).permutation(len(x_train))[:200]
        for i in idx:
            yield [normalize(x_train[i:i + 1])]

    conv = tf.lite.TFLiteConverter.from_keras_model(model)
    conv.optimizations = [tf.lite.Optimize.DEFAULT]
    conv.representative_dataset = representative
    conv.target_spec.supported_ops = [tf.lite.OpsSet.TFLITE_BUILTINS_INT8]
    conv.inference_input_type = tf.int8
    conv.inference_output_type = tf.int8
    return conv.convert()


def write_model_cc(tflite_bytes: bytes, path: Path):
    """Wie `xxd -i hand.tflite`, aber ohne xxd (laeuft auch unter Windows).
    Gleiche Namen (hand_tflite, hand_tflite_len), passend zu main/model.h."""
    lines = []
    for i in range(0, len(tflite_bytes), 12):
        chunk = tflite_bytes[i:i + 12]
        lines.append("  " + ", ".join(f"0x{b:02x}" for b in chunk))
    with open(path, "w", newline="\n") as f:
        f.write("// Generated by train_model.py (SCRUM-23). Do not edit by hand.\n")
        f.write('#include "model.h"\n\n')
        f.write("alignas(16) const unsigned char hand_tflite[] = {\n")
        f.write(",\n".join(lines))
        f.write("\n};\n")
        f.write(f"const unsigned int hand_tflite_len = {len(tflite_bytes)};\n")


def inspect_tflite(tflite_bytes: bytes):
    """Prueft Operatoren, Input-Quantisierung und schaetzt den Arena-Bedarf."""
    import tensorflow as tf
    # Ohne XNNPACK-Delegate, damit wir die echten Operatoren sehen.
    interp = tf.lite.Interpreter(
        model_content=tflite_bytes,
        experimental_op_resolver_type=tf.lite.experimental.OpResolverType.BUILTIN_WITHOUT_DEFAULT_DELEGATES)
    interp.allocate_tensors()
    inp = interp.get_input_details()[0]
    out = interp.get_output_details()[0]

    ops = {op["op_name"] for op in interp._get_ops_details()}
    tensors = {t["index"]: t for t in interp.get_tensor_details()}
    const_ids = set()
    for op in interp._get_ops_details():
        for i in op["inputs"]:
            if i >= 0 and tensors[i]["name"] and "const" in tensors[i]["name"].lower():
                const_ids.add(i)

    # Grobe Schaetzung: groesstes (Eingang + Ausgang) eines Operators, nur Aktivierungen.
    peak = 0
    for op in interp._get_ops_details():
        acts = [i for i in list(op["inputs"]) + list(op["outputs"])
                if i >= 0 and len(tensors[i]["shape"]) == 4 and i not in const_ids]
        size = sum(int(np.prod(tensors[i]["shape"])) * np.dtype(tensors[i]["dtype"]).itemsize for i in set(acts))
        peak = max(peak, size)
    return interp, inp, out, ops, peak


def evaluate_int8(interp, inp, out, x, y):
    """Laesst das int8-Modell genau so rechnen wie auf dem ESP32 (Pixel - 128)."""
    correct = 0
    for img, label in zip(x, y):
        q = (img.astype(np.int32) - 128).astype(np.int8)[None]
        interp.set_tensor(inp["index"], q)
        interp.invoke()
        scores = interp.get_tensor(out["index"])[0]
        correct += int(np.argmax(scores) == label)
    return correct / max(1, len(y))


# --------------------------------------------------------------------------
def main():
    p = argparse.ArgumentParser(description="Trainiert das Hand-Gesten-Modell fuer den ESP32.")
    p.add_argument("--data", type=Path, required=True, help="Ordner mit einem Unterordner pro Klasse")
    p.add_argument("--width", type=int, default=64, help="Modell-Input Breite (= kInputWidth)")
    p.add_argument("--height", type=int, default=48, help="Modell-Input Hoehe (= kInputHeight)")
    p.add_argument("--epochs", type=int, default=300)
    p.add_argument("--batch", type=int, default=32)
    p.add_argument("--patience", type=int, default=80,
                   help="Abbruch, wenn sich die Testgenauigkeit so viele Runden nicht verbessert")
    p.add_argument("--val-split", type=float, default=0.2, help="Anteil Bilder nur zum Testen")
    p.add_argument("--arch", choices=["mobilenet", "small"], default="mobilenet",
                   help="mobilenet = vortrainiert (empfohlen), small = kleines Netz von null (wie im Repo)")
    p.add_argument("--blocks", type=int, default=11,
                   help="Anzahl MobileNet-Bloecke (weniger = kleiner/schneller, mehr = genauer)")
    p.add_argument("--freeze-epochs", type=int, default=15,
                   help="Runden, in denen nur der Kopf trainiert wird (MobileNet bleibt fest)")
    p.add_argument("--stem-filters", type=int, default=8,
                   help="Filter der ersten Schicht (Repo-Zufallsmodell: 3; 8 ist genauer, braucht ~28 KB Arena)")
    p.add_argument("--dense", type=int, default=32, help="Neuronen der vorletzten Schicht")
    p.add_argument("--no-augment", action="store_true", help="Augmentierung ausschalten")
    p.add_argument("--extra", type=Path, nargs="*", default=[],
                   help="zusaetzliche Ordner (z. B. data_extern) - nur zum Lernen, nie zum Testen")
    p.add_argument("--random-split", action="store_true",
                   help="Testbilder zufaellig statt zeitlich (zuletzt aufgenommene) waehlen")
    p.add_argument("--out", type=Path, default=Path("output"))
    p.add_argument("--seed", type=int, default=42)
    args = p.parse_args()

    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
    import tensorflow as tf
    tf.keras.utils.set_random_seed(args.seed)

    print(f"\n1) Lade Bilder aus {args.data} (Vorverarbeitung wie auf dem ESP32 -> {args.width}x{args.height})")
    x, y, classes = load_dataset(args.data, args.width, args.height)
    n = len(classes)

    # Zeitlich getrennter Test: pro Klasse die zuletzt aufgenommenen Bilder.
    # Wer beim Aufnehmen Ort/Licht wechselt, testet so mit einer Szene, die
    # das Modell beim Training nicht gesehen hat -> ehrlichere Zahl.
    # Mit --random-split wird stattdessen zufaellig aufgeteilt.
    rng = np.random.default_rng(args.seed)
    val_idx, train_idx = [], []
    for c in range(n):
        idx = np.where(y == c)[0]  # schon nach Dateiname (= Zeit) sortiert
        if args.random_split:
            idx = rng.permutation(idx)
        k = max(1, int(round(len(idx) * args.val_split)))
        val_idx += list(idx[-k:]); train_idx += list(idx[:-k])
    x_tr, y_tr = x[train_idx], y[train_idx]
    x_va, y_va = x[val_idx], y[val_idx]
    for extra in args.extra:
        print(f"   + Zusatzdaten aus {extra} (nur Training)")
        xe, ye_names, ce = load_dataset(extra, args.width, args.height)
        keep = [i for i, v in enumerate(ye_names) if ce[v] in classes]
        ye = np.array([classes.index(ce[ye_names[i]]) for i in keep], dtype=np.int64)
        x_tr = np.concatenate([x_tr, xe[keep]]); y_tr = np.concatenate([y_tr, ye])
    print(f"   {len(x_tr)} Bilder zum Trainieren, {len(x_va)} zum Testen")

    print("\n2) Baue Modell")
    backbone = None
    if args.arch == "mobilenet":
        model, backbone = build_mobilenet(args.width, args.height, n, args.blocks, args.dense)
    else:
        blocks = [(16, 1), (32, 2), (32, 1), (64, 2), (64, 1), (96, 2)]
        model = build_model(args.width, args.height, n, args.stem_filters, blocks, args.dense)
    print(f"   {args.arch}: {model.count_params():,} Parameter, {n} Outputs: {', '.join(classes)}")

    print("\n3) Trainiere")
    onehot = lambda v: tf.one_hot(v, n)
    ds_tr = tf.data.Dataset.from_tensor_slices((x_tr, onehot(y_tr))).shuffle(len(x_tr), seed=args.seed)
    if not args.no_augment:
        ds_tr = ds_tr.map(augment, num_parallel_calls=tf.data.AUTOTUNE)
    else:
        ds_tr = ds_tr.map(lambda a, b: (normalize(a), b))
    ds_tr = ds_tr.batch(args.batch).prefetch(tf.data.AUTOTUNE)
    ds_va = tf.data.Dataset.from_tensor_slices((normalize(x_va), onehot(y_va))).batch(args.batch)
    metrics = [tf.keras.metrics.CategoricalAccuracy(name="acc")]

    if backbone is not None and args.freeze_epochs > 0:
        print(f"   Phase 1: nur der Kopf ({args.freeze_epochs} Runden)")
        backbone.trainable = False
        model.compile(optimizer=tf.keras.optimizers.Adam(1e-3), loss="binary_crossentropy", metrics=metrics)
        model.fit(ds_tr, validation_data=ds_va, epochs=args.freeze_epochs, verbose=2)
        backbone.trainable = True
        print("   Phase 2: alles feinjustieren")
        lr = 2e-4
    else:
        lr = 1e-3
    model.compile(optimizer=tf.keras.optimizers.Adam(lr), loss="binary_crossentropy", metrics=metrics)
    model.fit(ds_tr, validation_data=ds_va, epochs=args.epochs, verbose=2,
              callbacks=[tf.keras.callbacks.EarlyStopping("val_acc", patience=args.patience, mode="max",
                                                          restore_best_weights=True)])
    float_acc = model.evaluate(ds_va, verbose=0)[1]

    print("\n4) Wandle in int8-TFLite um")
    tflite = convert_int8(model, x_tr)
    interp, inp, out, ops, peak = inspect_tflite(tflite)

    problems = []
    if inp["dtype"] != np.int8 or list(inp["shape"]) != [1, args.height, args.width, 1]:
        problems.append(f"Input ist {inp['dtype']} {list(inp['shape'])}, ESP32 erwartet int8 [1,{args.height},{args.width},1]")
    scale, zp = inp["quantization"]
    if abs(scale - 1 / 128) > 1e-6 or zp != 0:
        problems.append(f"Input-Quantisierung ist scale={scale}, zero_point={zp}; erwartet 1/128 und 0")
    unknown = ops - ESP32_SUPPORTED_OPS
    if unknown:
        problems.append(f"Operatoren fehlen im ESP32-Resolver: {sorted(unknown)}")

    int8_acc = evaluate_int8(interp, inp, out, x_va.astype(np.uint8)[..., 0][..., None], y_va)

    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / "hand.tflite").write_bytes(tflite)
    write_model_cc(tflite, args.out / "model.cc")
    (args.out / "labels.txt").write_text("".join(f"Output[{i}] = {c}\n" for i, c in enumerate(classes)))
    model.save(args.out / "hand.keras")

    report = [
        f"Klassen ({n}): " + ", ".join(f"Output[{i}]={c}" for i, c in enumerate(classes)),
        f"Input: {args.width}x{args.height} Graustufen",
        f"Testgenauigkeit float-Modell: {float_acc:.1%}",
        f"Testgenauigkeit int8-Modell (wie auf ESP32): {int8_acc:.1%}",
        f"Modellgroesse: {len(tflite):,} Bytes",
        f"Operatoren: {', '.join(sorted(ops))}",
        f"Arena-Schaetzung (grob): ~{peak/1024:.1f} KB von {ESP32_ARENA_BYTES/1024:.0f} KB (kArena)",
        "",
        "ESP32-Checks: " + ("alle OK" if not problems else "PROBLEME:\n  - " + "\n  - ".join(problems)),
    ]
    if args.width != 80 or args.height != 60:
        report.append(f"HINWEIS: In esp32ai.cc kInputWidth={args.width} und kInputHeight={args.height} setzen.")
    if peak > 0.8 * ESP32_ARENA_BYTES:
        report.append("HINWEIS: Arena koennte knapp werden - ggf. kArena in esp32ai.cc erhoehen.")
    (args.out / "report.txt").write_text("\n".join(report) + "\n")

    print("\n5) Ergebnis\n   " + "\n   ".join(report))
    print(f"\nDateien in {args.out.resolve()}:")
    print("   hand.tflite -> esp/esp32ai/hand.tflite")
    print("   model.cc    -> esp/esp32ai/main/model.cc")
    if problems:
        sys.exit(1)


if __name__ == "__main__":
    main()
