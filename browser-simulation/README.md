# Browser-Simulation (MuJoCo + Node.js)

Weboberfläche, die MuJoCo-Modelle (MJCF/XML inkl. Meshes) im Browser lädt, simuliert und darstellt.
Die Physik läuft direkt im Browser über die offiziellen MuJoCo-WASM-Bindings von Google DeepMind
([`@mujoco/mujoco`](https://www.npmjs.com/package/@mujoco/mujoco)), die 3D-Darstellung erfolgt mit [three.js](https://threejs.org).
Über die Laptop-Kamera wird außerdem die eigene Hand live erkannt
([MediaPipe Hand Landmarker](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker), siehe
[Kamera & Hand-Tracking](#kamera--hand-tracking)).
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
| Maus | Linke Taste drehen, rechte Taste verschieben, Mausrad zoomen |

## Kamera & Hand-Tracking

Die eigene Hand wird live über die Laptop-Kamera erkannt – der erste Schritt der optischen Teleoperation.
Die Erkennung läuft komplett im Browser, das Kamerabild verlässt den Rechner nicht.

1. Im Panel unter „Kamera & Hand-Tracking“ auf **Kamera aktivieren** klicken und den Kamerazugriff im Browser erlauben.
2. Unten rechts in der 3D-Ansicht erscheint eine kleine Videovorschau (gespiegelt wie ein Spiegel) mit den 21 erkannten
   Landmarken: Daumen orange, Zeigefinger blau, Mittelfinger grün, Ringfinger gelb, kleiner Finger lila.
3. Die Statuszeile zeigt die erkannte Hand (links/rechts mit Sicherheit), die ausgewerteten Kamerabilder pro Sekunde
   und ob die Erkennung auf der GPU oder CPU läuft, z. B. `Rechte Hand erkannt (98 %) · 30 FPS (GPU)`.
4. **Kamera beenden** schaltet Kamera und Tracking wieder aus.

**Technik:** [`@mediapipe/tasks-vision`](https://www.npmjs.com/package/@mediapipe/tasks-vision) (Hand Landmarker im
Video-Modus, eine Hand). Jedes neue Kamerabild (angefordert: 640×480) wird genau einmal ausgewertet
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
| `landmarks` | 21 Punkte `{x, y, z}`: x, y normiert auf das ungespiegelte Kamerabild (0…1), z = Tiefe relativ zum Handgelenk (kleiner = näher an der Kamera, etwa im Maßstab von x) |
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

## Schnittstelle für die Ansteuerung

Für die Anbindung der Posenschätzung (Landmarken → Gelenkwinkel) gibt es im Browser das Objekt `window.sim`:

```js
window.sim.setControls({ index_flex: 0.8, thumb_abd: 0.3 }); // Aktuator-Sollwerte in rad (Physik-Modus)
window.sim.setJoints({ index_mcp: 0.8, index_pip: 0.8 });    // Gelenkwinkel in rad (Kinematik-Modus)
window.sim.hand                                            // zuletzt erkannte Hand der Kamera (siehe oben) oder null
window.sim.model / window.sim.data / window.sim.mujoco    // direkter Zugriff auf MuJoCo

// Beispiel: Abstand zwischen Daumen- und Zeigefingerspitze in cm
const p = window.sim.hand.worldLandmarks;
Math.hypot(p[4].x - p[8].x, p[4].y - p[8].y, p[4].z - p[8].z) * 100;
```

## Aufbau

```
browser-simulation/
├─ index.html          Oberfläche
├─ vite.config.js      Dev-Server/Build + Manifest aller Dateien unter public/models
├─ public/
│  ├─ models/          Mitgelieferte MuJoCo-Modelle (ein Ordner pro Modell)
│  └─ mediapipe/       Hand-Landmarker-Modell (hand_landmarker.task)
└─ src/
   ├─ main.js          UI, Simulationsschleife, Kamera-Steuerung, window.sim
   ├─ mujoco.js        Laden der WASM-Engine, Kompilieren über das virtuelle Dateisystem
   ├─ renderer.js      three.js-Darstellung der Geoms (Primitive + Meshes)
   ├─ handTracking.js  Kamera + MediaPipe Hand Landmarker, Landmarken-Overlay der Vorschau
   └─ style.css
```

## Einschränkungen

- Texturen werden noch nicht dargestellt (es wird die Materialfarbe verwendet), Höhenfelder (`hfield`) ebenfalls nicht.
- Laut DeepMind ist die Windows-Unterstützung der WASM-Bindings noch experimentell; getestet wurde mit Edge/Chromium unter Windows 11.
- Hand-Tracking: Die erkannten Landmarken werden noch nicht auf die Gelenke der simulierten Hand übertragen
  (nächster Schritt: `window.sim.hand` → Gelenkwinkel → `window.sim.setJoints`). Es wird eine Hand verfolgt; die
  Tiefenwerte sind relativ zur Hand, der absolute Abstand zur Kamera wird nicht geschätzt.
- Die Hand-Erkennung läuft im Haupt-Thread des Browsers. Ohne GPU-Beschleunigung bremst sie die Simulation spürbar.
