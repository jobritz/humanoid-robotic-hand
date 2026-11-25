# KI-Modell trainieren (SCRUM-23)

Mit diesen Skripten trainiert man ein KI-Modell, das **Stein, Schere, Papier** (und **nichts**) auf einem Kamerabild erkennt.
Das fertige Modell läuft danach auf dem ESP32 (Projekt `esp/esp32ai`).

## Die Dateien

| Datei | Was sie macht |
|---|---|
| `capture_images.py` | Fotos für das Training aufnehmen |
| `train_model.py` | Aus den Fotos ein Modell für den ESP32 machen |
| `test_live.py` | Das Modell live mit der Kamera ausprobieren |
| `requirements.txt` | Liste der nötigen Python-Pakete |

## Einmal einrichten

Python 3.10 bis 3.12 installieren, dann im Terminal:

```sh
cd esp/esp32ai/training
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt
```

## 1. Fotos aufnehmen

```sh
python capture_images.py --source 0
```

Eine Geste zeigen und die Taste gedrückt halten:

- **1** = Stein
- **2** = Schere
- **3** = Papier
- **4** = nichts (keine Hand)
- **q** = Ende

Tipps: Hand groß ins Bild, an mehreren Orten aufnehmen, verschiedene Personen. Etwa 300 Fotos pro Geste.
Die Fotos landen im Ordner `data/`. **Diesen Ordner bitte nicht hochladen** (private Fotos).

## 2. Trainieren

```sh
python train_model.py --data data
```

Danach liegen im Ordner `output/`:

- `hand.tflite` → kommt nach `esp/esp32ai/hand.tflite`
- `model.cc` → kommt nach `esp/esp32ai/main/model.cc`
- `labels.txt` → welche Zahl welche Geste ist (0 = nichts, 1 = papier, 2 = schere, 3 = stein)

## 3. Testen

```sh
python test_live.py --source 0
```

Oben im Bild steht, was das Modell erkennt. Mit den Tasten **1–4** sagt man, was man wirklich zeigt.
So sieht man, wie oft es richtig liegt. Falsch erkannte Bilder werden gespeichert und beim nächsten Training mitgenommen.

## Gut zu wissen

- Das Modell passt zum ESP32-Code, am ESP32-Code muss nichts geändert werden.
- Noch nicht auf dem echten ESP32 getestet. Falls beim Start „Tensor allocation failed“ kommt: in `esp32ai.cc` den Wert `kArena` größer machen (z. B. 64 KB).
