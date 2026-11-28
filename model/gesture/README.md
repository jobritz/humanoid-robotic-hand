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

In der Browser-Simulation: Kamera aktivieren, im Bereich **„Gesten-Modell (Aktuatoren)“** das Modell starten und eine
Geste in die Kamera zeigen. Das Modell aus `model/gesture/output/` wird automatisch angeboten, andere Modelle über
„Datei öffnen…“ (`gesture.tflite` und `labels.txt` zusammen auswählen).

## Echte Hand per Kamera: Landmarken → Aktuator-Stellungen

Damit das Modell Gesten einer echten Hand erkennt, werden die 21 Punkte von MediaPipe (Hand Landmarker,
„world landmarks“) in die 8 Aktuator-Stellungen umgerechnet:

```
Kamera → MediaPipe (21 Landmarken) → hand_mapping.py / handMapping.js → 8 Werte in rad → Gesten-Modell → Geste
```

- **Beugung** je Finger = Summe der Knickwinkel entlang des Fingers, linear abgebildet von „flache Hand“ (0°) bis
  „Faust“ (90°).
- **Spreizung** = Winkel des ersten Fingerglieds in der Handebene gegen die Ruhelage, umso schwächer, je stärker der
  Finger gebeugt ist (begrenzt auf ±35°).
- Funktioniert für linke und rechte Hand gleich. Ansatz aus `mapping.js` von Jonas Britz (Branch `test-jonasb`), auf rad
  umgestellt. Die Kalibrierung (`CALIBRATION`) stammt aus 316 Aufnahmen echter Hände (`Testdaten Roboterhand.csv`):
  mittlere Abweichung zur nachgestellten Zielpose 15–19° bei der Beugung, 16–18° bei der Spreizung.

**Die Umrechnung gibt es zweimal mit identischer Rechnung**: `hand_mapping.py` (Raspberry Pi) und
`browser-simulation/src/handMapping.js` (Browser, auch für die Aufnahme von Trainingsdaten). Beide werden gegen dieselben
Testdaten geprüft (`hand_mapping_testdata.json`). Wer eine davon ändert, muss die andere genauso ändern:

```sh
python test_hand_mapping.py          # Python
cd ../../browser-simulation && npm test   # JavaScript
```

Getestet in der Browser-Simulation mit den offiziellen MediaPipe-Testbildern: Faust → Stein (97 %),
Victory-Zeichen → Schere (97 %), flache Hand → Papier (59–79 %, rechte und linke Hand). Die geringere Sicherheit bei
Papier liegt am Platzhalter-Modell, das nur die ideale flache Hand kennt. Mit echten Trainingsdaten wird das besser.

## Eigenen Code anbinden (z. B. Raspberry Pi)

`predict_gesture.py` und `hand_mapping.py` laufen ohne TensorFlow, nur mit dem kleinen Paket `ai-edge-litert`
(`pip install ai-edge-litert numpy`). Auf den Pi kopieren: `predict_gesture.py`, `gesture_common.py`,
`hand_mapping.py`, `output/gesture.tflite`, `output/labels.txt`.

```python
from predict_gesture import GestureModel

model = GestureModel("output/gesture.tflite")

# aus den 8 Aktuator-Stellungen
name, score = model.gesture([1.57, 0, 1.57, 0, 1.57, 0, 1.57, 0])      # -> ("rock", 0.97)

# direkt aus MediaPipe (Python, Hand Landmarker), z. B. auf dem Raspberry Pi mit der Pi-Kamera
result = landmarker.detect_for_video(mp_image, timestamp_ms)
if result.hand_world_landmarks:
    name, score = model.gesture_from_landmarks(result.hand_world_landmarks[0])
```

Wie MediaPipe und die Kamera auf dem Pi laufen, klärt die Story „Ausführen eines KI-Modells auf dem Raspberry Pi“.
Wichtig ist nur, dass **world landmarks** übergeben werden (metrische 3D-Koordinaten), nicht die normierten
Bild-Landmarken.
