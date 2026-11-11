# Browser-Simulation (MuJoCo + Node.js)

Weboberfläche, die MuJoCo-Modelle (MJCF/XML inkl. Meshes) im Browser lädt, simuliert und darstellt.
Die Physik läuft direkt im Browser über die offiziellen MuJoCo-WASM-Bindings von Google DeepMind
([`@mujoco/mujoco`](https://www.npmjs.com/package/@mujoco/mujoco)), die 3D-Darstellung erfolgt mit [three.js](https://threejs.org).
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
| Maus | Linke Taste drehen, rechte Taste verschieben, Mausrad zoomen |

## Schnittstelle für die Ansteuerung

Für die spätere Anbindung (z. B. Finger-Posenschätzung) gibt es im Browser das Objekt `window.sim`:

```js
window.sim.setControls({ index_flex: 0.8, thumb_abd: 0.3 }); // Aktuator-Sollwerte in rad (Physik-Modus)
window.sim.setJoints({ index_mcp: 0.8, index_pip: 0.8 });    // Gelenkwinkel in rad (Kinematik-Modus)
window.sim.model / window.sim.data / window.sim.mujoco    // direkter Zugriff auf MuJoCo
```

## Aufbau

```
browser-simulation/
├─ index.html          Oberfläche
├─ vite.config.js      Dev-Server/Build + Manifest aller Dateien unter public/models
├─ public/models/      Mitgelieferte MuJoCo-Modelle (ein Ordner pro Modell)
└─ src/
   ├─ main.js          UI, Simulationsschleife, window.sim
   ├─ mujoco.js        Laden der WASM-Engine, Kompilieren über das virtuelle Dateisystem
   ├─ renderer.js      three.js-Darstellung der Geoms (Primitive + Meshes)
   └─ style.css
```

## Einschränkungen

- Texturen werden noch nicht dargestellt (es wird die Materialfarbe verwendet), Höhenfelder (`hfield`) ebenfalls nicht.
- Laut DeepMind ist die Windows-Unterstützung der WASM-Bindings noch experimentell; getestet wurde mit Edge/Chromium unter Windows 11.
