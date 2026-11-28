"""Gemeinsame Festlegungen fuer das Gesten-Modell (Training, Test, spaetere Ausfuehrung z. B. auf dem Raspberry Pi).

Schnittstelle des Modells
-------------------------
Input:  float32, Form [1, 8] - die Stellungen der 8 Aktuatoren der Amazing Hand in rad, in genau dieser Reihenfolge
        (Namen wie in browser-simulation/public/models/amazing_hand/MuJoCo.xml):
Output: float32, Form [1, Anzahl Gesten] - Wahrscheinlichkeiten (Softmax, Summe 1), Reihenfolge wie labels.txt
"""

import csv
import math
from pathlib import Path

import numpy as np

ACTUATORS = [
    "index_flex", "index_abd",
    "middle_flex", "middle_abd",
    "ring_flex", "ring_abd",
    "thumb_flex", "thumb_abd",
]

# Stellbereiche der Aktuatoren in rad (ctrlrange in MuJoCo.xml): Beugung 0..90 Grad, Spreizung -35..35 Grad.
FLEX_RANGE = (0.0, math.pi / 2)
ABD_RANGE = (-math.radians(35), math.radians(35))
RANGES = [FLEX_RANGE if name.endswith("_flex") else ABD_RANGE for name in ACTUATORS]

# Gleiche Gesten-Namen wie das bisherige Bildmodell (model/output/labels.txt). Deutsche Namen werden umgesetzt.
LABEL_ALIASES = {
    "stein": "rock", "faust": "rock",
    "papier": "paper", "offen": "paper",
    "schere": "scissors",
    "nichts": "nothing", "keine": "nothing", "none": "nothing",
}


def normalize_label(raw: str) -> str:
    label = raw.strip().lower()
    return LABEL_ALIASES.get(label, label)


def load_csv(paths):
    """Liest CSV-Dateien aus der Browser-Aufnahme. Benoetigt werden die Spalten 'label' und die 8 Aktuatoren,
    alle anderen Spalten (Zeitstempel, Landmarken ...) werden ignoriert. Zeilen ohne Label werden uebersprungen.
    Gibt (x [N, 8] float32, labels [N] str, Anzahl uebersprungener Zeilen) zurueck."""
    rows, labels, skipped = [], [], 0
    for path in paths:
        with open(Path(path), newline="", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            missing = [c for c in ["label", *ACTUATORS] if c not in (reader.fieldnames or [])]
            if missing:
                raise ValueError(f"{path}: Spalten fehlen: {', '.join(missing)}")
            for row in reader:
                label = normalize_label(row["label"] or "")
                try:
                    values = [float(row[c]) for c in ACTUATORS]
                except (TypeError, ValueError):
                    skipped += 1
                    continue
                if not label or not all(math.isfinite(v) for v in values):
                    skipped += 1
                    continue
                rows.append(values)
                labels.append(label)
    x = np.array(rows, dtype=np.float32).reshape(-1, len(ACTUATORS))
    return x, labels, skipped


def read_labels(path) -> list[str]:
    """labels.txt im Format 'Output[i] = name' (wie beim Bildmodell) einlesen."""
    lines = Path(path).read_text(encoding="utf-8").splitlines()
    return [line.split("=", 1)[1].strip() for line in lines if "=" in line]
