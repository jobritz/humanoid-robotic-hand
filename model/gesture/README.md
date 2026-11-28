# Gesten-Modell mit Aktuator-Stellungen als Input (SCRUM-37)

Umbau des bisherigen Bildmodells (`model/train_model.py`): Statt eines Kamerabildes bekommt das Modell die
**Stellungen der 8 Aktuatoren der Amazing Hand** und erkennt daraus die Geste (Stein, Schere, Papier, keine Geste).

## Schnittstelle

| | |
| --- | --- |
| **Input** | `float32 [1, 8]`, Werte in **rad**, genau diese Reihenfolge: `index_flex, index_abd, middle_flex, middle_abd, ring_flex, ring_abd, thumb_flex, thumb_abd` (Namen wie in `browser-simulation/public/models/amazing_hand/MuJoCo.xml`) |
| **Wertebereich** | `*_flex` 0 … 1,5708 (0–90°), `*_abd` −0,6109 … 0,6109 (±35°) |
| **Output** | `float32 [1, Anzahl Gesten]`, Wahrscheinlichkeiten (Softmax, Summe 1), Reihenfolge wie `labels.txt` |
| **Gesten** | so, wie sie in den Trainingsdaten heißen; deutsche Namen werden umgesetzt (stein → `rock`, papier → `paper`, schere → `scissors`, nichts → `nothing`) |

Die Normalisierung der Eingabe ist als erste Schicht im Modell enthalten. Wer das Modell ausführt, übergibt also direkt
die Werte in rad, ohne Vorverarbeitung.

## Unterschied zum Bildmodell

| | Bildmodell (`model/`) | Gesten-Modell (`model/gesture/`) |
| --- | --- | --- |
| Input | Graustufenbild 64×48 (int8) | 8 Aktuator-Stellungen (float32) |
| Netz | MobileNet (Faltungsschichten), ca. 180 KB | kleines MLP 8 → 32 → 16 → Gesten, wenige KB |
| Format | int8-TFLite für den ESP32 | float32-TFLite (Browser, PC, Raspberry Pi) |
| Training | Minuten | Sekunden |

## Einrichten

Python 3.10 bis 3.12, dann:

```sh
cd model/gesture
python -m venv venv
venv\Scripts\activate            # Linux/macOS: source venv/bin/activate
pip install -r requirements.txt
```

## Trainingsdaten

CSV-Dateien aus der Browser-Simulation („Trainingsdaten aufnehmen“). Benötigt werden die Spalte `label` und die
8 Aktuator-Spalten. Weitere Spalten (Zeitstempel, Landmarken …) werden ignoriert, Zeilen ohne Label übersprungen.

```csv
label,index_flex,index_abd,middle_flex,middle_abd,ring_flex,ring_abd,thumb_flex,thumb_abd
stein,1.5708,0,1.5708,0,1.5708,0,1.5708,0
schere,0,0.157,0,-0.157,1.5708,0,1.5708,0
```

Für ein brauchbares Modell sind pro Geste mindestens einige Dutzend, besser einige Hundert Datensätze nötig. Für die
Klasse „keine Geste“ (`nothing`) Stellungen aufnehmen, die keiner der Gesten entsprechen (Zwischenstellungen).

## Trainieren

```sh
python train_gesture_model.py --data aufnahme1.csv aufnahme2.csv
```

> **Aktueller Stand:** `output/` enthält ein **Platzhalter-Modell**, trainiert mit künstlichen Daten (siehe
> `output/PLATZHALTER.md`). Nach dem Training mit echten Aufnahmen `output/PLATZHALTER.md` löschen.

Ergebnis in `output/`:

- `gesture.tflite`: das Modell
- `labels.txt`: welche Output-Nummer welche Geste ist
- `report.txt`: Datenmenge, Testgenauigkeit, Verwechslungsmatrix

Wichtige Optionen: `--hidden 32 16` (Größe des Netzes), `--val-split 0.2` (Anteil Testdaten), `--epochs`, `--seed`.

## Testen

```sh
python predict_gesture.py 1.57 0 1.57 0 1.57 0 1.57 0     # Einzelwerte -> Wahrscheinlichkeit je Geste
python predict_gesture.py --csv aufnahme3.csv             # ganze Aufnahme -> Anteil richtig erkannt
```

In der Browser-Simulation: Bereich **„Gesten-Modell (Aktuatoren)“** → „Datei öffnen…“ → `gesture.tflite` und
`labels.txt` zusammen auswählen. Das Modell wertet dann laufend die aktuelle Handstellung aus, gesteuert über die Slider.
Liegt das Modell eingecheckt unter `model/gesture/output/`, wird es dort automatisch angeboten.

## Eigenen Code anbinden (z. B. Raspberry Pi)

`predict_gesture.py` läuft auch ohne TensorFlow mit dem kleinen Paket `ai-edge-litert`:

```python
from predict_gesture import GestureModel

model = GestureModel("output/gesture.tflite")
name, score = model.gesture([1.57, 0, 1.57, 0, 1.57, 0, 1.57, 0])   # -> ("rock", 0.98)
```
