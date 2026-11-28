"""
Prueft, dass hand_mapping.py die erwarteten Werte liefert (hand_mapping_testdata.json).
Dieselbe Datei prueft browser-simulation/test/handMapping.test.js (npm test) - so rechnen Browser und
Raspberry Pi nachweislich gleich.

  python test_hand_mapping.py                          # pruefen
  python test_hand_mapping.py --regenerate daten.csv   # Testdaten neu erzeugen (nur nach gewollter Aenderung!)
"""

import argparse
import csv
import json
import sys
from pathlib import Path

from hand_mapping import landmarks_to_actuators

HERE = Path(__file__).resolve().parent
TESTDATA = HERE / "hand_mapping_testdata.json"
TOLERANCE = 1e-9


def regenerate(csv_path: Path, count: int):
    with open(csv_path, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    step = max(1, len(rows) // count)
    cases = []
    for row in rows[::step][:count]:
        lm = [[float(row[f"w{a}{i}"]) for a in "xyz"] for i in range(21)]
        cases.append({"landmarks": lm, "actuators": landmarks_to_actuators(lm)})
    TESTDATA.write_text(json.dumps({"tolerance": TOLERANCE, "cases": cases}, indent=1) + "\n")
    print(f"{len(cases)} Testfaelle -> {TESTDATA.name}")


def check() -> bool:
    data = json.loads(TESTDATA.read_text())
    worst = 0.0
    for case in data["cases"]:
        got = landmarks_to_actuators(case["landmarks"])
        worst = max(worst, max(abs(g - e) for g, e in zip(got, case["actuators"])))
    ok = worst <= data["tolerance"]
    print(f"{len(data['cases'])} Testfaelle, groesste Abweichung {worst:.2e}: {'OK' if ok else 'FEHLER'}")
    return ok


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--regenerate", type=Path, metavar="CSV", help="CSV mit Spalten wx0..wz20")
    p.add_argument("--count", type=int, default=12)
    args = p.parse_args()
    if args.regenerate:
        regenerate(args.regenerate, args.count)
    sys.exit(0 if check() else 1)
