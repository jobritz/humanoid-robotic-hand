# Browser-Simulation (MuJoCo + Node.js)

Weboberfläche, die MuJoCo-Modelle (MJCF/XML inkl. Meshes) im Browser lädt, simuliert und darstellt.
Die Physik läuft direkt im Browser über die offiziellen MuJoCo-WASM-Bindings von Google DeepMind
([`@mujoco/mujoco`](https://www.npmjs.com/package/@mujoco/mujoco)), die 3D-Darstellung erfolgt mit [three.js](https://threejs.org).
Über die Laptop-Kamera wird außerdem die eigene Hand live erkannt
([MediaPipe Hand Landmarker](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker), siehe
[Kamera & Hand-Tracking](#kamera--hand-tracking)). Das Kamerabild lässt sich dabei wie die Kamera der ESP32-CAM
einstellen (nur deren Auflösungen und Farbcodierungen), damit KI-Modelle für den ESP32 im Browser mit denselben
Eingabedaten getestet werden können (siehe [ESP32-Kamera nachbilden](#esp32-kamera-nachbilden)). Das KI-Modell der
Firmware läuft direkt auf diesen Kamerabildern mit (siehe [ESP32-KI-Modell testen](#esp32-ki-modell-testen)).
Node.js wird als Entwicklungs-/Build-Umgebung genutzt (Vite).

## Starten

Voraussetzung: Node.js ≥ 20

```sh
cd browser-simulation
npm install
npm run dev        # Dev-Server auf http://localhost:5173
```

Unter Windows blockiert PowerShell `npm` eventuell („npm.ps1 ist nicht digital signiert“). Dann `npm.cmd install` bzw.
`npm.cmd run dev` verwenden.

Statischer Build (z. B. zum Hosten): `npm run build` → Ordner `dist/`, lokal testen mit `npm run preview`.

## Modelle laden

- **Mitgelieferte Modelle:** Jeder Ordner unter `public/models/` erscheint automatisch in der Auswahl.
  Einfach den kompletten Modellordner (XML + `meshes/`/`assets/`) dorthin kopieren.
  Mit `?model=<ordner>` in der URL wird ein bestimmtes Modell beim Start geladen (Standard: `amazing_hand`).
- **Lokale Dateien:** „Ordner öffnen…“ oder einen Ordner per Drag & Drop auf die 3D-Ansicht ziehen.
- Enthält ein Ordner mehrere Szenen, kann die Haupt-XML über „Szene“ gewählt werden (`scene.xml` wird bevorzugt).

Mitgelieferte Modelle:

| Ordner | Inhalt |
| --- | --- |
| `amazing_hand/` | Modell der Amazing Hand (rechte Hand, `hand.xml` + STL-Meshes), wird standardmäßig geladen. Übernommen aus dem Branch `test-jonasb` (erzeugt mit `make_hand.py`). |
| `demo_hand/` | Einfaches Testmodell aus Grundformen, ohne Meshes. |

### Amazing Hand (`amazing_hand/hand.xml`)

- 4 Finger (Zeige-, Mittel-, Ringfinger, Daumen) mit je 3 Gelenken: Spreizung (`*_abd`, ±35°), Grundgelenk (`*_mcp`, 0–90°)
  und Mittelgelenk (`*_pip`, 0–90°). Das Mittelgelenk ist per `<equality>` an das Grundgelenk gekoppelt.
- 8 Positions-Aktuatoren: `*_flex` (Beugung) und `*_abd` (Spreizung) pro Finger.
- Hinweis: Die `ctrlrange` der Aktuatoren steht in Grad (`0 90` bzw. `-35 35`), MuJoCo rechnet sie aber nicht in Radiant
  um. Sinnvolle Sollwerte liegen daher bei 0–1,57 rad (Beugung) bzw. ±0,61 rad (Spreizung). Die Slider sind nur im
  vorderen Bereich wirksam.

## Bedienung

| Element | Funktion |
| --- | --- |
| Physik (Aktuatoren) | Simulation läuft in Echtzeit, Slider setzen die Aktuator-Sollwerte (`data.ctrl`) |
| Kinematik (Gelenke) | Keine Dynamik, Slider setzen Gelenkwinkel direkt (`data.qpos`) – geeignet für Teleoperation |
| Geom-Gruppen | Ein-/Ausblenden von Geom-Gruppen (Standard: 0–2 sichtbar, Kollisions-Geoms oft in Gruppe 3) |
| Kamera aktivieren / beenden | Startet bzw. stoppt Kamera und Hand-Tracking, Vorschau unten rechts (siehe nächster Abschnitt) |
| Auflösung, Farbcodierung, JPEG-Qualität | Kamera wie beim ESP32 einstellen (`frame_size`, `pixel_format`, `jpeg_quality`), wirkt sofort |
| ESP32-KI-Modell | Modell wählen oder `.tflite` öffnen, starten/stoppen, Ausgaben ansehen und die Hand passend zur erkannten Schere-Stein-Papier-Pose bewegen (siehe [ESP32-KI-Modell testen](#esp32-ki-modell-testen)) |
| Maus | Linke Taste drehen, rechte Taste verschieben, Mausrad zoomen |

## Kamera & Hand-Tracking

Die eigene Hand wird live über die Laptop-Kamera erkannt – der erste Schritt der optischen Teleoperation.
Die Erkennung läuft komplett im Browser, das Kamerabild verlässt den Rechner nicht. Ausgewertet wird das Bild so, wie
es die ESP32-CAM liefern würde (siehe [ESP32-Kamera nachbilden](#esp32-kamera-nachbilden)).

1. Im Panel unter „Kamera & Hand-Tracking“ Auflösung und Farbcodierung wählen. Standard ist die Einstellung der
   Firmware in [`esp/esp32cam`](../esp/esp32cam): QVGA, JPEG, Qualität 12. Änderungen wirken auch bei laufender Kamera.
2. Auf **Kamera aktivieren** klicken und den Kamerazugriff im Browser erlauben.
3. Unten rechts in der 3D-Ansicht erscheint das Kamerabild (gespiegelt wie ein Spiegel) mit den 21 erkannten
   Landmarken: Daumen orange, Zeigefinger blau, Mittelfinger grün, Ringfinger gelb, kleiner Finger lila. Angezeigt wird
   genau der Inhalt des Bildpuffers, also z. B. Graustufen bei `GRAYSCALE` oder Blockartefakte bei starker
   JPEG-Kompression. Kleine Auflösungen werden pixelgenau vergrößert.
4. Die Statuszeile zeigt die erkannte Hand (links/rechts mit Sicherheit), die ausgewerteten Kamerabilder pro Sekunde
   und ob die Erkennung auf der GPU oder CPU läuft, z. B. `Rechte Hand erkannt (98 %) · 30 FPS (GPU)`. Unter den
   Einstellungen stehen Größe des letzten Bildes und Auflösung der Webcam, z. B.
   `320×240 JPEG: 4.682 Byte pro Bild · Webcam 640×480`.
5. **Kamera beenden** schaltet Kamera und Tracking wieder aus.

**Technik:** [`@mediapipe/tasks-vision`](https://www.npmjs.com/package/@mediapipe/tasks-vision) (Hand Landmarker im
Video-Modus, eine Hand). Jedes neue Webcam-Bild wird genau einmal in ein ESP32-Kamerabild umgerechnet und ausgewertet
(`requestVideoFrameCallback`).
Gerechnet wird bevorzugt per WebGL auf der GPU; schlägt das fehl, wird automatisch die CPU verwendet.
Gemessen auf einem Laptop mit Intel Iris Xe: ca. 18 ms pro Bild auf der GPU, ca. 60 ms auf der CPU (dann sinkt auch die
Bildrate der Simulation deutlich). Die WASM-Laufzeit stammt direkt aus dem npm-Paket (Vite liefert sie aus), das Modell
liegt unter `public/mediapipe/hand_landmarker.task`, damit alles auch offline funktioniert (offizielles Modell
[`float16/1`](https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task),
Apache-2.0, ca. 7,8 MB).

**Ergebnis pro Kamerabild** (`window.sim.hand`, `null` ohne Kamera bzw. ohne erkannte Hand):

| Feld | Inhalt |
| --- | --- |
| `landmarks` | 21 Punkte `{x, y, z}`: x, y normiert auf das ungespiegelte (ESP32-)Kamerabild (0…1), z = Tiefe relativ zum Handgelenk (kleiner = näher an der Kamera, etwa im Maßstab von x) |
| `worldLandmarks` | 21 Punkte `{x, y, z}` als metrische 3D-Koordinaten in Metern, Ursprung etwa in der Handmitte – Grundlage für Gelenkwinkel |
| `handedness` | `'Left'` oder `'Right'`: tatsächliche Hand der Person |
| `score` | Sicherheit der Links/Rechts-Zuordnung (0…1) |

Landmarken-Indizes: 0 Handgelenk · 1–4 Daumen (CMC, MCP, IP, Spitze) · 5–8 Zeigefinger (MCP, PIP, DIP, Spitze) ·
9–12 Mittelfinger · 13–16 Ringfinger · 17–20 kleiner Finger.

**Hinweise und Fehlerbehebung**

- Kamerazugriff gibt es nur in einem sicheren Kontext: `http://localhost` (Dev-Server) oder HTTPS. Wird die Seite von
  einem anderen Gerät über die IP-Adresse geöffnet (`npm run dev -- --host`), blockiert der Browser die Kamera.
- „Kamerazugriff verweigert“: in den Website-Einstellungen des Browsers (Symbol links in der Adressleiste) erlauben.
- „Kamera ist belegt“: andere Programme mit Kamerazugriff schließen (Teams, Zoom, Kamera-App).
- Der allererste Start auf der GPU kann einige Sekunden dauern und die Oberfläche kurz anhalten, weil die Shader
  kompiliert werden. Der Browser speichert sie zwischen; danach dauert der Start unter einer Sekunde.
- Händigkeit: Ältere MediaPipe-Dokumentation geht von gespiegelten Selfie-Bildern aus. Mit der verwendeten Version
  liefert MediaPipe für das ungespiegelte Kamerabild direkt die tatsächliche Hand (mit den offiziellen Testbildern
  `right_hands.jpg`/`left_hands.jpg` geprüft). Gespiegelt wird nur die Anzeige per CSS.

## ESP32-Kamera nachbilden

Damit KI-Modelle für den ESP32 im Browser sinnvoll getestet werden können, liefert die Webcam Bilder wie die ESP32-CAM
(AI-Thinker, Sensor OV2640). Einstellbar sind genau die Werte, die der Treiber
[`espressif/esp32-camera`](https://github.com/espressif/esp32-camera) (Version 2.1.8) in `camera_config_t` annimmt:

```c
camera_config_t camera_config = {
    // ...
    .pixel_format = PIXFORMAT_JPEG, // Farbcodierung
    .frame_size = FRAMESIZE_QVGA,   // Auflösung
    .jpeg_quality = 12,             // nur bei JPEG: 0–63, kleiner = bessere Qualität
};
```

**Auflösungen** (`frame_size`): alle 16 Auflösungen der OV2640. Wie der Sensor schneidet die Nachbildung das 4:3-Bild
mittig auf das Seitenverhältnis des Sensorfensters zu (`ratio_table` im Treiber) und skaliert es auf die Zielgröße.
Bei QCIF, HQVGA und CIF passt das Fenster nicht genau zur Zielgröße, das Bild wird dort wie auf dem ESP32 um bis zu
2,3 % verzerrt.

| Sensorfenster | Auflösungen (`FRAMESIZE_…`) |
| --- | --- |
| 4:3 (ganzes Bild) | `QQVGA` 160×120, `HQVGA` 240×176, `QVGA` 320×240, `CIF` 400×296, `VGA` 640×480, `SVGA` 800×600, `XGA` 1024×768, `UXGA` 1600×1200 |
| 1:1 | `96X96`, `128X128`, `240X240`, `320X320` |
| 5:4 | `QCIF` 176×144, `SXGA` 1280×1024 |
| 3:2 | `HVGA` 480×320 |
| 16:9 | `HD` 1280×720 |

**Farbcodierungen** (`pixel_format`): die vier Formate, die der Treiber auf dem ESP32 annimmt (andere wie `RGB888` oder
`YUV420` lehnt er dort ab). Der Bildpuffer ist byteweise so aufgebaut wie `fb->buf` nach `esp_camera_fb_get()`, Pixel
zeilenweise von links oben:

| Format | Größe des Puffers (Byte) | Aufbau |
| --- | --- | --- |
| `RGB565` | 2 × Breite × Höhe | je Pixel 2 Byte, höherwertiges zuerst: `RRRRRGGG GGGBBBBB` |
| `YUV422` | 2 × Breite × Höhe | `Y0 U Y1 V` (YUYV): zwei nebeneinanderliegende Pixel teilen sich U und V |
| `GRAYSCALE` | Breite × Höhe | je Pixel 1 Byte Helligkeit Y |
| `JPEG` | je nach Bildinhalt | JPEG-Datei, Kompression über `jpeg_quality` |

YUV und Graustufen werden nach BT.601 im vollen Wertebereich 0…255 berechnet (Y = 0,299 R + 0,587 G + 0,114 B).

**Ablauf pro Bild:** Webcam-Bild → Sensorfenster ausschneiden → auf die Auflösung skalieren → in die Farbcodierung
umrechnen (Bildpuffer) → für Vorschau und Hand-Tracking zurück in RGB wandeln. Die Webcam wird mit mindestens 640×480
(4:3) angefordert, bei großen Auflösungen entsprechend höher. Liefert sie weniger, steht in der Infozeile
„hochskaliert“.

**Zugriff für eigene Modelle:** Das letzte Bild steht in `window.sim.camera.frame` bereit, aufgebaut wie `camera_fb_t`.
Vorverarbeitung aus der Firmware lässt sich damit direkt in JavaScript übertragen:

```js
window.sim.camera.setConfig({ frameSize: 'QVGA', pixelFormat: 'GRAYSCALE' }); // FRAMESIZE_QVGA, PIXFORMAT_GRAYSCALE
const fb = window.sim.camera.frame; // { buf, len, width, height, format, timestamp } oder null ohne Kamera
fb.buf[y * fb.width + x];           // Helligkeit des Pixels (x, y), wie fb->buf in C

// JPEG-Bilder dekodiert der Browser:
const image = await createImageBitmap(new Blob([fb.buf], { type: 'image/jpeg' }));
```

Die Namen können wie im Treiber mit Präfix angegeben werden (`'FRAMESIZE_QVGA'`, `'PIXFORMAT_GRAYSCALE'`). Ungültige
Werte lösen einen Fehler aus, der die erlaubten Werte nennt; `jpegQuality` wird wie im Treiber auf 0…63 begrenzt.

**Was nicht nachgebildet wird:** der Sensor selbst (Rauschen, Belichtung, Weißabgleich, Objektiv und Bildwinkel), die
Bildrate und die Grenzen des ESP32:

- Laut [esp32-camera](https://github.com/espressif/esp32-camera#important-to-remember) belasten `RGB565` und `YUV422`
  den ESP32 stark, sodass Bilddaten fehlen können, besonders bei aktivem WLAN. Große Rohformate passen zudem kaum in
  den Speicher: UXGA in `RGB565` braucht 3,84 MB je Bildpuffer, die AI-Thinker-Platine hat 4 MB PSRAM.
  Im Browser funktioniert jede Kombination.
- JPEG erzeugt der Browser, nicht die OV2640. Die Umrechnung von `jpeg_quality` ist eine nicht kalibrierte Näherung
  (10 entspricht libjpeg-Qualität 50, größere Werte quantisieren proportional gröber). Bildgrößen (`fb->len`) und
  Artefakte weichen daher vom echten ESP32 ab.
- Ob die OV2640 YUV-Werte im vollen Bereich 0…255 oder im eingeschränkten Bereich (Y 16…235) ausgibt, ist nicht
  dokumentiert; die Umrechnung `yuv2rgb()` im Treiber geht vom eingeschränkten Bereich aus. Kommt es auf exakte
  Helligkeitswerte an, mit Aufnahmen des echten ESP32 vergleichen.

## ESP32-KI-Modell testen

Das KI-Modell, das auf dem ESP32 laufen soll ([`esp/esp32ai`](../esp/esp32ai)), wird im Browser auf den Bildern der
nachgebildeten ESP32-Kamera ausgeführt, so wie in der Firmware. Damit lässt sich ein Modell testen, bevor es geflasht
wird. Standardmäßig wird direkt die Datei der Firmware geladen (`esp/esp32ai/hand.tflite`, dieselbe Datei, die
`create_model.py` erzeugt und die in `main/model.cc` eingebettet ist). Es gibt also keine Kopie, die veralten kann.

1. Kamera aktivieren (siehe oben). Für das Firmware-Modell `GRAYSCALE` wählen, wie in der Firmware. Andere Formate
   funktionieren auch, dann wird wie unten beschrieben umgerechnet.
2. Unter „ESP32-KI-Modell“ auf **Modell starten** klicken. Beim ersten Mal wird die Laufzeit LiteRT.js geladen (ca. 11 MB).
3. Angezeigt werden:
   - die Eckdaten des Modells: Eingabe (Größe × Kanäle, Datentyp, Quantisierung), Anzahl der Ausgaben und die
     verwendeten Operatoren,
   - links das Bild, wie es das Modell bekommt (nach Zuschnitt und Verkleinerung),
   - rechts ein Balken je Ausgabe (`Output[0]`, `Output[1]`, …, wie im seriellen Monitor des ESP32),
   - die Rechenzeit pro Bild im Browser (sagt nichts über die Rechenzeit auf dem ESP32 aus).
4. **Datei öffnen…** lädt ein anderes `.tflite`-Modell, z. B. ein frisch trainiertes. Alle geöffneten Modelle bleiben
   bis zum Neuladen der Seite in der Auswahl.
5. **Ausgaben steuern die Hand (Platzhalter):** Die Ausgaben bewegen die simulierte Hand (nur im Physik-Modus). Solange
   die genauen Abläufe noch nicht feststehen, beugt Ausgabe *i* (0…1) einfach Finger *i* (Zeige-, Mittel-, Ringfinger,
   Daumen) von 0 bis 90°. Die Abbildung steht in `placeholderHandMapping()` in [`src/main.js`](src/main.js) und lässt sich
   per `window.sim.esp32Model.setHandMapping()` ersetzen (siehe unten).
6. **Schere, Stein, Papier gewinnen:** Die erkannte Pose wird als gegnerische Geste behandelt. Die Hand zeigt die
   gewinnende Gegenpose: Papier gegen Stein, Schere gegen Papier und Stein gegen Schere. Dafür braucht das Modell
   Ausgaben mit den Labels `rock`, `paper` und `scissors` (oder `Stein`, `Papier` und `Schere`). Die Klasse `nothing`
   bzw. `nichts` lässt die Hand unverändert. Die Bewegung wirkt im Physik-Modus.

**Was genau wie in der Firmware passiert** (`preprocess_frame()` und `run_model()` in
[`esp32ai.cc`](../esp/esp32ai/main/esp32ai.cc)):

| Schritt | Firmware | Browser |
| --- | --- | --- |
| Zuschnitt | mittig auf das Seitenverhältnis der Modelleingabe | gleich, auch mit derselben Ganzzahl-Rundung |
| Verkleinerung | Mittelwert der Quellpixel je Zielpixel, ganzzahlig abgerundet | gleich (pixelgenau geprüft) |
| Zu kleines Bild | wird verworfen | wird verworfen, Hinweis im Panel |
| Eingabe | `Pixel - 128` (fest für dieses Modell) | `round(Pixel / scale) + zero_point` aus dem Modell, für `hand.tflite` (scale 1, zero_point −128) identisch |
| Ausgabe | `(q - zero_point) * scale` | gleich |

**Flexibel für neue Modelle:** Eingabegröße, Kanäle, Datentyp und Quantisierung werden aus der `.tflite`-Datei gelesen
([`src/tfliteInfo.js`](src/tfliteInfo.js)). Unterstützt werden Modelle mit genau einer Bild-Eingabe
`[1, Höhe, Breite, 1 oder 3]` (NHWC) vom Typ `int8`, `uint8` oder `float32`, beliebig viele Ausgaben derselben Typen.
Graustufen-Modelle (1 Kanal) bekommen die Helligkeit Y (BT.601), Farbmodelle (3 Kanäle) R, G, B. Bei `GRAYSCALE` mit
einem Graustufen-Modell wird der Bildpuffer wie in der Firmware direkt verwendet, andere Formate werden vorher
umgerechnet: bei `RGB565` und `YUV422` wie für die Anzeige, JPEG dekodiert der Browser.

**Was nicht im Modell steht:** Der Wertebereich der Pixel beim Training. Standard ist 0…255 wie in `create_model.py`
(Pixel unverändert). Wurde ein Modell mit 0…1 oder −1…1 trainiert, beim Laden `inputRange` angeben:
`Esp32Model.load(url, { inputRange: [0, 1] })` in [`src/esp32Model.js`](src/esp32Model.js).

**Technik:** [LiteRT.js](https://www.npmjs.com/package/@litertjs/core) (`@litertjs/core`, Nachfolger von TensorFlow Lite
für das Web, Apache-2.0) auf der CPU (WebAssembly mit XNNPACK). Die WASM-Laufzeit stammt aus dem npm-Paket. Vite stellt
sie unter `/litert/` bereit bzw. kopiert sie beim Build nach `dist/litert/` (siehe `vite.config.js`), damit alles auch
offline funktioniert. Zwei Anpassungen, damit Modelle für den ESP32 laufen:

- LiteRT.js liefert `scale` und `zero_point` nicht. Sie werden deshalb direkt aus der Datei gelesen.
- Keras speichert die Batch-Größe als dynamisch (`shape_signature` `[-1, 60, 80, 1]`), was LiteRT.js ablehnt. TFLM auf
  dem ESP32 ignoriert dieses Feld. Im Browser wird es deshalb vor dem Laden in einer Kopie auf die feste Form gesetzt.

In der Browser-Konsole erscheinen beim Laden einige `INFO`- und `WARNING`-Meldungen von LiteRT.js (als Fehler markiert,
weil sie über `stderr` kommen). Sie sind normal.

**Unterschiede zum ESP32:** Gerechnet wird mit LiteRT.js (XNNPACK) statt mit TensorFlow Lite Micro (ESP-NN). Die
Ergebnisse können in der letzten Stelle abweichen. Nicht geprüft werden die Grenzen des ESP32: Größe der Tensor-Arena
(`kArena`, 32 KB) und ob alle Operatoren im `MicroMutableOpResolver` registriert sind. Die angezeigten Operatoren also mit
den `Add…()`-Aufrufen in `esp32ai.cc` vergleichen. Wer sicher gehen will, vergleicht die Ausgaben für dasselbe Bild mit
denen des ESP32.

**Hinweis zum aktuellen Modell:** `hand.tflite` hat zufällige Gewichte (nur zum Testen der Inferenz). Die Aktivierungen
werden im Netz so klein, dass die Ausgabe bei jedem Bild `0.500` ist. Das ist kein Fehler der Simulation, der ESP32
liefert dasselbe. Sinnvolle Werte gibt es erst mit einem trainierten Modell.

## Gesten-Modell (Aktuatoren)

Erkennt die Geste (Stein, Schere, Papier, keine Geste) aus den **8 Aktuator-Stellungen** der Hand statt aus einem
Kamerabild. Trainiert wird es mit [`model/gesture`](../model/gesture/README.md) (SCRUM-37).

1. Bereich „Gesten-Modell (Aktuatoren)“ → „Datei öffnen…“ → `gesture.tflite` und `labels.txt` zusammen auswählen.
   Liegt ein trainiertes Modell eingecheckt unter `model/gesture/output/`, steht es direkt in der Auswahl.
2. Das Modell wertet bei jedem Bild der Simulation die aktuelle Handstellung aus (`data.actuator_length`, also die
   tatsächliche Gelenkstellung an den Aktuatoren). Mit den Aktuator-Slidern eine Geste einstellen, oben steht z. B.
   `Erkannt: Schere (99 %)`, darunter die Wahrscheinlichkeit jeder Geste.

Eingabe: `float32 [1, 8]` in rad, Reihenfolge `index_flex, index_abd, middle_flex, middle_abd, ring_flex, ring_abd,
thumb_flex, thumb_abd`. Modelle mit einer anderen Eingabe (z. B. Bildmodelle) werden mit einer Fehlermeldung abgelehnt.

## Schnittstelle für die Ansteuerung

Für die Anbindung der Posenschätzung (Landmarken → Gelenkwinkel) gibt es im Browser das Objekt `window.sim`:

```js
window.sim.setControls({ index_flex: 0.8, thumb_abd: 0.3 }); // Aktuator-Sollwerte in rad (Physik-Modus)
window.sim.setJoints({ index_mcp: 0.8, index_pip: 0.8 });    // Gelenkwinkel in rad (Kinematik-Modus)
window.sim.hand                                            // zuletzt erkannte Hand der Kamera (siehe oben) oder null
window.sim.camera.setConfig({ frameSize: 'QQVGA' });       // Kamera wie beim ESP32 einstellen, auch im Betrieb
window.sim.camera.config                                   // { frameSize, pixelFormat, jpegQuality }
window.sim.camera.frame                                    // letztes Kamerabild wie camera_fb_t oder null
window.sim.model / window.sim.data / window.sim.mujoco    // direkter Zugriff auf MuJoCo

// ESP32-KI-Modell
window.sim.esp32Model.info                 // geladenes Modell { name, size, input, outputs, operators, inputRange } oder null
window.sim.esp32Model.result               // letztes Ergebnis { values, timestamp, preprocessMs, inferenceMs } oder null
await window.sim.esp32Model.load(url)      // anderes Modell laden (URL, File oder Uint8Array) und starten
await window.sim.esp32Model.run(frame)     // eigenes Bild auswerten, aufgebaut wie camera_fb_t – auch ohne Kamera
window.sim.esp32Model.setLabels(['offen', 'Faust', 'Zeigen']); // Ausgaben beschriften ([] = Output[i])
window.sim.esp32Model.setHandMapping((values) => ({ thumb_flex: values[0] * 1.57 })); // eigene Ansteuerung, null = Platzhalter
window.sim.esp32Model.driveHand = true;    // Ansteuerung der Hand ein/aus (wie die Checkbox)

// Gesten-Modell (Aktuatoren)
window.sim.gestureModel.inputs             // Reihenfolge der 8 Eingaben
window.sim.gestureModel.info               // geladenes Modell { name, size, labels, operators } oder null
window.sim.gestureModel.result             // letztes Ergebnis { inputs, values, label, score, inferenceMs } oder null
await window.sim.gestureModel.load(url, labelsText) // Modell (URL, File, Uint8Array) + labels.txt-Text oder Array laden
await window.sim.gestureModel.run([1.57, 0, 1.57, 0, 1.57, 0, 1.57, 0]) // eigene Werte → { values, label, score }
await window.sim.gestureModel.run()        // aktuelle Handstellung auswerten

// Beispiel: Abstand zwischen Daumen- und Zeigefingerspitze in cm
const p = window.sim.hand.worldLandmarks;
Math.hypot(p[4].x - p[8].x, p[4].y - p[8].y, p[4].z - p[8].z) * 100;

// Beispiel: Testbild ohne Kamera auswerten (Graustufen-Verlauf 320×240)
const buf = new Uint8Array(320 * 240).map((_, i) => (i % 320) * 255 / 319);
await window.sim.esp32Model.run({ buf, width: 320, height: 240, format: 'GRAYSCALE' }); // { values, pixels, … }
```

Die Funktion für `setHandMapping` bekommt die Modellausgaben (`values`, Zahlen wie in der Firmware umgerechnet) und gibt
Aktuator-Sollwerte in rad zurück, wie `setControls`. Sie wird bei jedem ausgewerteten Kamerabild aufgerufen, wenn die
Ansteuerung eingeschaltet ist.

## Aufbau

```
browser-simulation/
├─ index.html          Oberfläche
├─ vite.config.js      Dev-Server/Build + Manifest aller Dateien unter public/models
├─ public/
│  ├─ models/          Mitgelieferte MuJoCo-Modelle (ein Ordner pro Modell)
│  └─ mediapipe/       Hand-Landmarker-Modell (hand_landmarker.task)
└─ src/
   ├─ main.js          UI, Simulationsschleife, Kamera-Steuerung, KI-Modell-Panel, window.sim
   ├─ mujoco.js        Laden der WASM-Engine, Kompilieren über das virtuelle Dateisystem
   ├─ renderer.js      three.js-Darstellung der Geoms (Primitive + Meshes)
   ├─ esp32Camera.js   Webcam als ESP32-Kamera: Auflösungen, Farbcodierungen, Bildpuffer wie camera_fb_t
   ├─ esp32Model.js    KI-Modell für den ESP32 mit LiteRT.js: Vorverarbeitung und (De-)Quantisierung wie die Firmware
   ├─ gestureModel.js  Gesten-Modell mit den 8 Aktuator-Stellungen als Eingabe (LiteRT.js)
   ├─ tfliteInfo.js    Liest Ein-/Ausgaben, Quantisierung und Operatoren aus .tflite-Dateien
   ├─ handTracking.js  MediaPipe Hand Landmarker, Landmarken-Overlay der Vorschau
   └─ style.css
```

Das KI-Modell selbst liegt nicht hier, sondern wird aus [`../esp/esp32ai/hand.tflite`](../esp/esp32ai/hand.tflite)
geladen (dafür erlaubt `vite.config.js` dem Dev-Server den Zugriff auf diesen Ordner).

## Einschränkungen

- Texturen werden noch nicht dargestellt (es wird die Materialfarbe verwendet), Höhenfelder (`hfield`) ebenfalls nicht.
- Laut DeepMind ist die Windows-Unterstützung der WASM-Bindings noch experimentell; getestet wurde mit Edge/Chromium unter Windows 11.
- Hand-Tracking: Die erkannten Landmarken werden noch nicht auf die Gelenke der simulierten Hand übertragen
  (nächster Schritt: `window.sim.hand` → Gelenkwinkel → `window.sim.setJoints`). Es wird eine Hand verfolgt; die
  Tiefenwerte sind relativ zur Hand, der absolute Abstand zur Kamera wird nicht geschätzt.
- Die Hand-Erkennung läuft im Haupt-Thread des Browsers. Ohne GPU-Beschleunigung bremst sie die Simulation spürbar.
- ESP32-KI-Modell: Die allgemeine Ansteuerung der Hand aus den Modellausgaben ist ein Platzhalter; der
  Schere-Stein-Papier-Gewinnmodus setzt die Labels `rock`, `paper`, `scissors` und `nothing` voraus. Größe der Tensor-Arena
  und registrierte Operatoren des ESP32 werden nicht geprüft (siehe
  [ESP32-KI-Modell testen](#esp32-ki-modell-testen)). Bei Modellen mit mehreren Ausgabetensoren wird angenommen, dass
  LiteRT.js sie in der Reihenfolge des Modells liefert.
- Die ESP32-Nachbildung läuft ebenfalls im Haupt-Thread. Bis VGA kostet sie kaum Zeit (gemessen mit Intel Iris Xe:
  rund 30 Kamerabilder pro Sekunde wie ohne Nachbildung), bei UXGA sinkt die Rate auf etwa 12–20 Bilder pro Sekunde.
