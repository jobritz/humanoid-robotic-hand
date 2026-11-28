# Browser-Simulation (MuJoCo + Node.js)

Weboberfläche, die MuJoCo-Modelle (MJCF/XML inkl. Meshes) im Browser lädt, simuliert und darstellt.
Die Physik läuft direkt im Browser über die offiziellen MuJoCo-WASM-Bindings von Google DeepMind
([`@mujoco/mujoco`](https://www.npmjs.com/package/@mujoco/mujoco)), die 3D-Darstellung erfolgt mit [three.js](https://threejs.org).
Über die Webcam wird die eigene Hand live erkannt
([MediaPipe Hand Landmarker](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker)), in die
Stellungen der Aktuatoren umgerechnet und vom Gesten-Modell ausgewertet (siehe
[Kamera & Hand-Tracking](#kamera--hand-tracking) und [Gesten-Modell](#gesten-modell-aktuatoren)).
Node.js wird als Entwicklungs-/Build-Umgebung genutzt (Vite).

## Starten

Voraussetzung: Node.js ≥ 20

```sh
cd browser-simulation
npm install
npm run dev        # Dev-Server auf http://localhost:5173
npm test           # prüft, dass handMapping.js wie model/gesture/hand_mapping.py rechnet
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
| `amazing_hand/` | Modell der Amazing Hand (rechte Hand, `MuJoCo.xml` + STL-Meshes), wird standardmäßig geladen. |
| `demo_hand/` | Einfaches Testmodell aus Grundformen, ohne Meshes. |

### Amazing Hand (`amazing_hand/MuJoCo.xml`)

- 4 Finger (Zeige-, Mittel-, Ringfinger, Daumen) mit je 3 Gelenken: Spreizung (`*_abd`, ±35°), Grundgelenk (`*_mcp`, 0–90°)
  und Mittelgelenk (`*_pip`, 0–90°). Das Mittelgelenk ist per `<equality>` an das Grundgelenk gekoppelt.
- 8 Positions-Aktuatoren: `*_flex` (Beugung, 0 … 1,5708 rad) und `*_abd` (Spreizung, ±0,6109 rad) pro Finger.

## Bedienung

| Element | Funktion |
| --- | --- |
| Physik (Aktuatoren) | Simulation läuft in Echtzeit, Slider setzen die Aktuator-Sollwerte (`data.ctrl`) |
| Kinematik (Gelenke) | Keine Dynamik, Slider setzen Gelenkwinkel direkt (`data.qpos`) |
| Kamera aktivieren / beenden | Startet bzw. stoppt Webcam und Hand-Tracking, Vorschau unten rechts |
| Auflösung, Farbcodierung, JPEG-Qualität | Kamerabild einstellen, wirkt sofort, auch bei laufender Kamera |
| Simulierte Hand folgt der echten Hand | Die erkannte Hand steuert die simulierte Hand (Physik-Modus) |
| Gesten-Modell | Modell starten, Eingabe wählen (Kamera oder Slider), erkannte Geste ansehen |
| Schere, Stein, Papier gewinnen | Die simulierte Hand zeigt die Gegenpose zur erkannten Geste |
| Geom-Gruppen | Ein-/Ausblenden von Geom-Gruppen (Standard: 0–2 sichtbar, Kollisions-Geoms oft in Gruppe 3) |
| Maus | Linke Taste drehen, rechte Taste verschieben, Mausrad zoomen |

## Kamera & Hand-Tracking

Die eigene Hand wird live über die Webcam erkannt, der erste Schritt der optischen Teleoperation. Die Erkennung läuft
komplett im Browser, das Kamerabild verlässt den Rechner nicht.

1. Auflösung und Farbcodierung wählen (Standard: VGA 640×480, RGB565 in Farbe). Änderungen wirken auch bei laufender
   Kamera.
2. Auf **Kamera aktivieren** klicken und den Kamerazugriff im Browser erlauben.
3. Unten rechts in der 3D-Ansicht erscheint das Kamerabild (gespiegelt wie ein Spiegel) mit den 21 erkannten
   Landmarken: Daumen orange, Zeigefinger blau, Mittelfinger grün, Ringfinger gelb, kleiner Finger lila. Angezeigt und
   ausgewertet wird genau das eingestellte Bild, also z. B. Graustufen bei `GRAYSCALE` oder Blockartefakte bei starker
   JPEG-Kompression. Kleine Auflösungen werden pixelgenau vergrößert.
   Die Statuszeile zeigt die erkannte Hand (links/rechts mit Sicherheit), die ausgewerteten Bilder pro Sekunde und
   ob die Erkennung auf der GPU oder CPU läuft, z. B. `Rechte Hand erkannt (98 %) · 30 FPS (GPU)`. Unter den
   Einstellungen stehen Größe des letzten Bildes und Auflösung der Webcam, z. B.
   `640×480 RGB565: 614.400 Byte pro Bild · Webcam 640×480`.
4. Darunter stehen Beugung und Spreizung je Finger in Grad, umgerechnet aus den Landmarken
   ([`src/handMapping.js`](src/handMapping.js), gleiche Rechnung wie `model/gesture/hand_mapping.py` auf dem Raspberry Pi).
   Mit **Simulierte Hand folgt der echten Hand** macht die simulierte Hand die Bewegung nach (leicht geglättet).
5. **Kamera beenden** schaltet Kamera und Tracking wieder aus.

**Einstellungen** ([`src/camera.js`](src/camera.js)): Die Auflösungen und Farbcodierungen entsprechen denen des
Kamerasensors OV2640, mit dem das Projekt begonnen hat.

| Einstellung | Werte |
| --- | --- |
| Auflösung | `96X96` bis `UXGA` 1600×1200, u. a. `QVGA` 320×240, `VGA` 640×480, `HD` 1280×720. Das Webcam-Bild wird mittig auf das Seitenverhältnis zugeschnitten und skaliert. |
| Farbcodierung | `RGB565` (Farbe, 16 Bit), `YUV422` (Farbe), `GRAYSCALE` (Graustufen, 8 Bit), `JPEG` (komprimiert) |
| JPEG-Qualität | nur bei `JPEG`: 0–63, kleiner = bessere Qualität |

Für das Hand-Tracking eignet sich ein Farbbild ab VGA am besten. In kleinen Graustufenbildern (z. B. QVGA, `GRAYSCALE`)
wird vor allem die flache Hand oft nicht gefunden.

**Technik:** [`@mediapipe/tasks-vision`](https://www.npmjs.com/package/@mediapipe/tasks-vision) (Hand Landmarker im
Video-Modus, eine Hand) auf dem eingestellten Kamerabild. Jedes neue Webcam-Bild wird genau einmal umgerechnet und
ausgewertet (`requestVideoFrameCallback`). Gerechnet wird bevorzugt per WebGL auf der GPU; schlägt das
fehl, wird automatisch die CPU verwendet. Gemessen auf einem Laptop mit Intel Iris Xe: ca. 18 ms pro Bild auf der GPU,
ca. 60 ms auf der CPU (dann sinkt auch die Bildrate der Simulation deutlich). Die WASM-Laufzeit stammt direkt aus dem
npm-Paket, das Modell liegt unter `public/mediapipe/hand_landmarker.task`, damit alles auch offline funktioniert
(offizielles Modell
[`float16/1`](https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task),
Apache-2.0, ca. 7,8 MB).

**Ergebnis pro Kamerabild** (`window.sim.hand`, `null` ohne Kamera bzw. ohne erkannte Hand):

| Feld | Inhalt |
| --- | --- |
| `landmarks` | 21 Punkte `{x, y, z}`: x, y normiert auf das ungespiegelte Kamerabild (0…1), z = Tiefe relativ zum Handgelenk (kleiner = näher an der Kamera, etwa im Maßstab von x) |
| `worldLandmarks` | 21 Punkte `{x, y, z}` als metrische 3D-Koordinaten in Metern, Ursprung etwa in der Handmitte, Grundlage für die Aktuator-Stellungen |
| `handedness` | `'Left'` oder `'Right'`: tatsächliche Hand der Person |
| `score` | Sicherheit der Links/Rechts-Zuordnung (0…1) |

Landmarken-Indizes: 0 Handgelenk · 1–4 Daumen (CMC, MCP, IP, Spitze) · 5–8 Zeigefinger (MCP, PIP, DIP, Spitze) ·
9–12 Mittelfinger · 13–16 Ringfinger · 17–20 kleiner Finger.

**Hinweise und Fehlerbehebung**

- Kamerazugriff gibt es nur in einem sicheren Kontext: `http://localhost` (Dev-Server) oder HTTPS. Wird die Seite von
  einem anderen Gerät über die IP-Adresse geöffnet (`npm run dev -- --host`), blockiert der Browser die Kamera.
- „Kamerazugriff verweigert“: in den Website-Einstellungen des Browsers (Symbol links in der Adressleiste) erlauben.
- „Kamera ist belegt“: andere Programme mit Kamerazugriff schließen (Teams, Zoom, Kamera-App).
- „Keine Kamera gefunden“: Kamera eingeschaltet? Manche Laptops haben eine Abdeckung oder eine Taste dafür.
- Der allererste Start auf der GPU kann einige Sekunden dauern und die Oberfläche kurz anhalten, weil die Shader
  kompiliert werden. Der Browser speichert sie zwischen; danach dauert der Start unter einer Sekunde.
- Händigkeit: Ältere MediaPipe-Dokumentation geht von gespiegelten Selfie-Bildern aus. Mit der verwendeten Version
  liefert MediaPipe für das ungespiegelte Kamerabild direkt die tatsächliche Hand (mit den offiziellen Testbildern
  `right_hands.jpg`/`left_hands.jpg` geprüft). Gespiegelt wird nur die Anzeige per CSS.

## Gesten-Modell (Aktuatoren)

Erkennt die Geste (Stein, Schere, Papier, keine Geste) aus den **8 Aktuator-Stellungen** der Hand. Trainiert wird es
mit [`model/gesture`](../model/gesture/README.md) (SCRUM-37).

1. Das Modell aus `model/gesture/output/` steht direkt in der Auswahl (zurzeit ein Platzhalter, trainiert mit
   künstlichen Daten). Andere Modelle: „Datei öffnen…“ → `gesture.tflite` und `labels.txt` zusammen auswählen.
2. **Modell starten.**
3. **Eingabe „Echte Hand (Kamera)“** (Standard): Kamera aktivieren und eine Geste zeigen. Das Modell bekommt die aus den
   Landmarken berechneten Aktuator-Stellungen direkt, so wie später auf dem Raspberry Pi.
4. **Eingabe „Simulierte Hand (Slider)“**: Das Modell wertet die Stellung der simulierten Hand aus
   (`data.actuator_length`, die tatsächliche Gelenkstellung an den Aktuatoren). Geste mit den Aktuator-Slidern einstellen.
5. Oben steht z. B. `Erkannt: Schere (97 %)`, darunter die Wahrscheinlichkeit jeder Geste.
6. **Schere, Stein, Papier gewinnen:** Die simulierte Hand zeigt die Geste, die gegen die erkannte gewinnt: Papier gegen
   Stein, Schere gegen Papier, Stein gegen Schere. Bei „keine Geste“ bleibt sie stehen. Funktioniert nur mit der Kamera
   als Eingabe (mit der simulierten Hand als Eingabe würde die Gegenpose sofort wieder erkannt) und im Physik-Modus.
   Solange der Gewinnmodus läuft, folgt die simulierte Hand nicht der echten Hand.

Getestet mit den offiziellen MediaPipe-Testbildern als Webcam: Faust → Stein (97 %), Victory-Zeichen → Schere (95 %),
flache Hand → Papier (75 %).

Eingabe: `float32 [1, 8]` in rad, Reihenfolge `index_flex, index_abd, middle_flex, middle_abd, ring_flex, ring_abd,
thumb_flex, thumb_abd`. Modelle mit einer anderen Eingabe (z. B. Bildmodelle) werden mit einer Fehlermeldung abgelehnt.

**Technik:** [LiteRT.js](https://www.npmjs.com/package/@litertjs/core) (`@litertjs/core`, Nachfolger von TensorFlow Lite
für das Web) auf der CPU (WebAssembly mit XNNPACK). Vite stellt die WASM-Laufzeit unter `/litert/` bereit bzw. kopiert
sie beim Build nach `dist/litert/` (siehe `vite.config.js`). Keras speichert die Batch-Größe als dynamisch, was LiteRT.js
ablehnt; [`src/tfliteInfo.js`](src/tfliteInfo.js) setzt sie vor dem Laden in einer Kopie auf die feste Form. In der
Browser-Konsole erscheinen beim Laden einige `INFO`- und `WARNING`-Meldungen von LiteRT.js; sie sind normal.

## Schnittstelle für die Ansteuerung

Im Browser gibt es das Objekt `window.sim`:

```js
window.sim.setControls({ index_flex: 0.8, thumb_abd: 0.3 }); // Aktuator-Sollwerte in rad (Physik-Modus)
window.sim.setJoints({ index_mcp: 0.8, index_pip: 0.8 });    // Gelenkwinkel in rad (Kinematik-Modus)
window.sim.hand                                            // zuletzt erkannte Hand der Kamera (siehe oben) oder null
window.sim.handActuators                                   // daraus berechnete 8 Aktuator-Stellungen in rad oder null
window.sim.camera.setConfig({ frameSize: 'HD', pixelFormat: 'JPEG' }); // Kamera einstellen, auch im Betrieb
window.sim.camera.config                                   // { frameSize, pixelFormat, jpegQuality }
window.sim.camera.frame                                    // letztes Kamerabild { buf, len, width, height, format, timestamp } oder null
window.sim.model / window.sim.data / window.sim.mujoco    // direkter Zugriff auf MuJoCo

// Gesten-Modell (Aktuatoren)
window.sim.gestureModel.inputs             // Reihenfolge der 8 Eingaben
window.sim.gestureModel.info               // geladenes Modell { name, size, labels, operators } oder null
window.sim.gestureModel.result             // letztes Ergebnis { inputs, values, label, score, inferenceMs } oder null
await window.sim.gestureModel.load(url, labelsText) // Modell (URL, File, Uint8Array) + labels.txt-Text oder Array laden
await window.sim.gestureModel.run([1.57, 0, 1.57, 0, 1.57, 0, 1.57, 0]) // eigene Werte → { values, label, score }
await window.sim.gestureModel.run()        // aktuelle Stellung der simulierten Hand auswerten

// Beispiel: Abstand zwischen Daumen- und Zeigefingerspitze in cm
const p = window.sim.hand.worldLandmarks;
Math.hypot(p[4].x - p[8].x, p[4].y - p[8].y, p[4].z - p[8].z) * 100;
```

## Aufbau

```
browser-simulation/
├─ index.html          Oberfläche
├─ vite.config.js      Dev-Server/Build, Manifest aller Dateien unter public/models, LiteRT-Laufzeit
├─ public/
│  ├─ models/          Mitgelieferte MuJoCo-Modelle (ein Ordner pro Modell)
│  └─ mediapipe/       Hand-Landmarker-Modell (hand_landmarker.task)
├─ test/               npm test: handMapping.js rechnet wie model/gesture/hand_mapping.py
└─ src/
   ├─ main.js          UI, Simulationsschleife, Kamera, Gesten-Modell, window.sim
   ├─ mujoco.js        Laden der WASM-Engine, Kompilieren über das virtuelle Dateisystem
   ├─ renderer.js      three.js-Darstellung der Geoms (Primitive + Meshes)
   ├─ camera.js        Webcam mit einstellbarer Auflösung, Farbcodierung und JPEG-Qualität
   ├─ handTracking.js  MediaPipe Hand Landmarker, Landmarken-Overlay der Vorschau
   ├─ handMapping.js   MediaPipe-Landmarken → 8 Aktuator-Stellungen (wie model/gesture/hand_mapping.py)
   ├─ gestureModel.js  Gesten-Modell mit den 8 Aktuator-Stellungen als Eingabe (LiteRT.js)
   ├─ tfliteInfo.js    Liest Ein-/Ausgaben, Quantisierung und Operatoren aus .tflite-Dateien
   └─ style.css
```

Das Gesten-Modell liegt nicht hier, sondern wird aus `../model/gesture/output/` geladen (dafür erlaubt
`vite.config.js` dem Dev-Server den Zugriff auf den Ordner `model/`).

## Einschränkungen

- Texturen werden noch nicht dargestellt (es wird die Materialfarbe verwendet), Höhenfelder (`hfield`) ebenfalls nicht.
- Laut DeepMind ist die Windows-Unterstützung der WASM-Bindings noch experimentell; getestet wurde mit Edge/Chromium unter Windows 11.
- Hand-Tracking: Es wird eine Hand verfolgt; die Tiefenwerte sind relativ zur Hand, der absolute Abstand zur Kamera
  wird nicht geschätzt. Die Spreizung der Finger wird deutlich ungenauer erkannt als die Beugung (siehe
  `model/gesture/hand_mapping.py`).
- Die Hand-Erkennung läuft im Haupt-Thread des Browsers. Ohne GPU-Beschleunigung bremst sie die Simulation spürbar.
