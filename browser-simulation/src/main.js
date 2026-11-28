// Einstiegspunkt der Web-Oberfläche: Modell laden, Simulation laufen lassen, Gelenke/Aktuatoren steuern,
// Hand per Webcam erkennen, in Aktuator-Stellungen umrechnen und daraus mit dem Gesten-Modell die Geste erkennen.
import { Renderer } from './renderer.js';
import {
  getMujoco,
  compileModel,
  listServedModels,
  fetchServedModel,
  readLocalFiles,
  findEntryCandidates,
} from './mujoco.js';
import { HandTracker, drawHand } from './handTracking.js';
import { Camera, FRAME_SIZES, PIXEL_FORMATS, getFrameSize, frameBufferSize } from './camera.js';
import {
  GestureModel,
  GESTURE_INPUTS,
  BUNDLED_GESTURE_MODEL,
  BUNDLED_GESTURE_LABELS,
  BUNDLED_GESTURE_IS_PLACEHOLDER,
  parseLabels,
} from './gestureModel.js';
import { landmarksToActuators, Smoother } from './handMapping.js';

const $ = (id) => document.getElementById(id);
const ui = {
  modelSelect: $('model-select'),
  entryRow: $('entry-row'),
  entrySelect: $('entry-select'),
  folderInput: $('folder-input'),
  filesInput: $('files-input'),
  modelInfo: $('model-info'),
  play: $('play'),
  reset: $('reset'),
  simInfo: $('sim-info'),
  controlsTitle: $('controls-title'),
  controls: $('controls'),
  groups: $('groups'),
  viewport: $('viewport'),
  status: $('status'),
  dropOverlay: $('drop-overlay'),
  cameraToggle: $('camera-toggle'),
  cameraInfo: $('camera-info'),
  cameraFollow: $('camera-follow'),
  cameraActuators: $('camera-actuators'),
  cameraFrameSize: $('camera-framesize'),
  cameraPixelFormat: $('camera-pixformat'),
  cameraQualityRow: $('camera-quality-row'),
  cameraQuality: $('camera-quality'),
  cameraQualityValue: $('camera-quality-value'),
  cameraFrameInfo: $('camera-frame-info'),
  cameraPreview: $('camera-preview'),
  cameraVideo: $('camera-video'),
  cameraFrame: $('camera-frame'),
  cameraOverlay: $('camera-overlay'),
  gestureModelSelect: $('gesture-model-select'),
  gestureSource: $('gesture-source'),
  gestureToggle: $('gesture-toggle'),
  gestureOpen: $('gesture-open'),
  gestureFileInput: $('gesture-file-input'),
  gestureInfo: $('gesture-info'),
  gestureResult: $('gesture-result'),
  gestureDetected: $('gesture-detected'),
  gestureOutputs: $('gesture-outputs'),
  gestureStatus: $('gesture-status'),
  gestureWin: $('gesture-win'),
};

const JOINT = { FREE: 0, BALL: 1, SLIDE: 2, HINGE: 3 };
const MAX_STEPS_PER_FRAME = 200;

const renderer = new Renderer(ui.viewport);
const state = {
  mujoco: null,
  model: null,
  data: null,
  files: null, // aktuell geladene Dateien (für Szenenwechsel)
  paused: false,
  mode: 'physics', // 'physics' | 'kinematic'
  simStartWall: 0,
  simStartTime: 0,
  sliders: [], // { input, output, apply(value), read() }
  hand: null, // letztes Ergebnis des Hand-Trackings (siehe handTracking.js)
  handActuators: null, // daraus berechnete 8 Aktuator-Stellungen in rad (siehe handMapping.js) oder null
};

// ---------------------------------------------------------------------------
// Modell laden
// ---------------------------------------------------------------------------

async function loadFiles(files, label, entry) {
  const candidates = findEntryCandidates(files);
  if (!candidates.length) throw new Error('Keine MJCF-XML-Datei gefunden.');
  entry ??= candidates[0];

  ui.entrySelect.replaceChildren(...candidates.map((p) => new Option(p, p, false, p === entry)));
  ui.entryRow.hidden = candidates.length < 2;

  setStatus(`Kompiliere ${entry}…`);
  const { model, data } = compileModel(state.mujoco, files, entry);

  state.data?.delete();
  state.model?.delete();
  state.model = model;
  state.data = data;
  state.files = files;

  renderer.setModel(model);
  renderer.update(data);
  buildControls();
  buildGroupToggles();
  restartClock();

  ui.modelInfo.classList.remove('error');
  ui.modelInfo.textContent =
    `${label}: ${model.nbody - 1} Körper, ${model.njnt} Gelenke, ` +
    `${model.nu} Aktuatoren, ${model.ngeom} Geoms, ${model.nmesh} Meshes`;
  setStatus('');
}

async function guarded(task) {
  try {
    await task();
  } catch (err) {
    console.error(err);
    ui.modelInfo.classList.add('error');
    ui.modelInfo.textContent = String(err?.message ?? err);
    setStatus('');
  }
}

async function loadServed(folder) {
  const model = state.served.find((m) => m.folder === folder);
  setStatus(`Lade ${folder}…`);
  const files = await fetchServedModel(model);
  await loadFiles(files, folder);
}

/** Pfade relativ zum gemeinsamen Oberordner machen (z. B. "amazing_hand/meshes/a.stl" -> "meshes/a.stl"). */
function stripCommonRoot(list) {
  const first = list[0]?.path.split('/');
  if (!first || first.length < 2) return list;
  const root = `${first[0]}/`;
  if (!list.every((f) => f.path.startsWith(root))) return list;
  return list.map((f) => ({ ...f, path: f.path.slice(root.length) }));
}

async function loadLocal(list, label) {
  if (!list.length) return;
  const files = await readLocalFiles(stripCommonRoot(list));
  ui.modelSelect.value = '';
  await loadFiles(files, label);
}

// Drag & Drop von Ordnern: Verzeichniseinträge rekursiv auslesen.
async function collectDropped(items) {
  const out = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ path: prefix + entry.name, file });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      } while (batch.length);
    }
  };
  const entries = [...items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  for (const e of entries) await walk(e, '');
  return out;
}

// ---------------------------------------------------------------------------
// Steuerelemente
// ---------------------------------------------------------------------------

function name(type, id, fallback) {
  return state.mujoco.mj_id2name(state.model, type, id) || fallback;
}

function buildControls() {
  const { mujoco, model } = state;
  const sliders = [];

  if (state.mode === 'physics') {
    ui.controlsTitle.textContent = `Aktuatoren (${model.nu})`;
    const range = model.actuator_ctrlrange;
    const limited = model.actuator_ctrllimited;
    for (let i = 0; i < model.nu; i++) {
      const [lo, hi] = limited[i] ? [range[2 * i], range[2 * i + 1]] : [-1, 1];
      sliders.push({
        label: name(mujoco.mjtObj.mjOBJ_ACTUATOR.value, i, `Aktuator ${i}`),
        min: lo,
        max: hi,
        format: (v) => v.toFixed(3),
        read: () => state.data.ctrl[i],
        apply: (v) => { state.data.ctrl[i] = v; },
      });
    }
  } else {
    const types = model.jnt_type;
    const adr = model.jnt_qposadr;
    const range = model.jnt_range;
    const limited = model.jnt_limited;
    for (let j = 0; j < model.njnt; j++) {
      const type = types[j];
      if (type !== JOINT.HINGE && type !== JOINT.SLIDE) continue; // freie/Kugelgelenke nicht als Slider
      const hinge = type === JOINT.HINGE;
      const [lo, hi] = limited[j] ? [range[2 * j], range[2 * j + 1]] : hinge ? [-Math.PI, Math.PI] : [-1, 1];
      const q = adr[j];
      sliders.push({
        label: name(mujoco.mjtObj.mjOBJ_JOINT.value, j, `Gelenk ${j}`),
        min: lo,
        max: hi,
        format: (v) => (hinge ? `${((v * 180) / Math.PI).toFixed(1)}°` : `${(v * 1000).toFixed(1)} mm`),
        read: () => state.data.qpos[q],
        apply: (v) => { state.data.qpos[q] = v; },
      });
    }
    ui.controlsTitle.textContent = `Gelenke (${sliders.length})`;
  }

  state.sliders = sliders.map((s) => {
    const wrap = document.createElement('div');
    wrap.className = 'control';
    wrap.innerHTML = `<div class="control-head"><span></span><output></output></div><input type="range" />`;
    const [labelEl, output] = wrap.querySelectorAll('span, output');
    const input = wrap.querySelector('input');
    labelEl.textContent = s.label;
    Object.assign(input, { min: s.min, max: s.max, step: (s.max - s.min) / 1000 });
    input.addEventListener('input', () => {
      const v = Number(input.value);
      output.textContent = s.format(v);
      s.apply(v);
      if (state.mode === 'kinematic') forward();
    });
    // Slider aus dem Simulationszustand aktualisieren (z. B. nach window.sim.setJoints).
    const refresh = () => {
      input.value = s.read();
      output.textContent = s.format(s.read());
    };
    refresh();
    return { ...s, wrap, refresh };
  });

  ui.controls.replaceChildren(...state.sliders.map((s) => s.wrap));
  if (!state.sliders.length) {
    ui.controls.innerHTML = `<p class="hint">${state.mode === 'physics' ? 'Das Modell hat keine Aktuatoren – Kinematik-Modus verwenden.' : 'Keine Dreh- oder Schubgelenke vorhanden.'}</p>`;
  }
}

function buildGroupToggles() {
  const used = new Set(state.model.geom_group);
  ui.groups.replaceChildren(
    ...[...used].sort().map((g) => {
      const label = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = renderer.visibleGroups.has(g);
      box.addEventListener('change', () => renderer.setGroupVisible(g, box.checked));
      label.append(box, ` ${g}`);
      return label;
    }),
  );
}

// ---------------------------------------------------------------------------
// Simulationsschleife
// ---------------------------------------------------------------------------

function restartClock() {
  state.simStartWall = performance.now();
  state.simStartTime = state.data.time;
}

function forward() {
  state.data.qvel.fill(0);
  state.mujoco.mj_forward(state.model, state.data);
}

let fps = 0;
let lastFrame = performance.now();

function frame(now) {
  requestAnimationFrame(frame);
  const { mujoco, model, data } = state;
  fps = 0.9 * fps + 0.1 * (1000 / Math.max(1, now - lastFrame));
  lastFrame = now;
  if (!model) return renderer.render();

  if (state.mode === 'physics' && !state.paused) {
    const target = state.simStartTime + (now - state.simStartWall) / 1000;
    let steps = 0;
    while (data.time < target && steps++ < MAX_STEPS_PER_FRAME) mujoco.mj_step(model, data);
    if (steps >= MAX_STEPS_PER_FRAME) restartClock(); // Simulation zu langsam: nicht endlos aufholen
  }

  renderer.update(data);
  renderer.render();
  ui.simInfo.textContent = `t = ${data.time.toFixed(2)} s · ${fps.toFixed(0)} FPS`;
  runGestureModel();
}

function setPaused(paused) {
  state.paused = paused;
  ui.play.textContent = paused ? 'Start' : 'Pause';
  if (!paused) restartClock();
}

function setMode(mode) {
  state.mode = mode;
  ui.play.disabled = mode === 'kinematic';
  if (state.model) {
    if (mode === 'kinematic') forward();
    else restartClock();
    buildControls();
  }
}

function setStatus(text) {
  ui.status.textContent = text;
}

// ---------------------------------------------------------------------------
// Kamera & Hand-Tracking
// ---------------------------------------------------------------------------

const CAMERA_IDLE_TEXT = ui.cameraInfo.textContent;
const HANDEDNESS = { Left: 'Linke', Right: 'Rechte' };
const BYTES = new Intl.NumberFormat('de-DE');

const tracker = new HandTracker();
const camera = new Camera(ui.cameraVideo, ui.cameraFrame, {
  onFrame(frame) {
    updateFrameInfo();
    // Kleine Auflösungen pixelgenau vergrößern (siehe style.css).
    ui.cameraFrame.classList.toggle('pixelated', ui.cameraFrame.clientWidth * devicePixelRatio >= 2 * frame.width);
    if (tracker.ready) trackHand(frame); // sonst wird das Handmodell noch geladen
  },
  onError(err) {
    console.error(err);
    setCameraActive(false);
    setCameraInfo(err.message, true);
  },
});

/** Glättet die Ansteuerung der simulierten Hand (nicht die Eingabe des Gesten-Modells, die bleibt ungeglättet). */
const followSmoother = new Smoother(0.5);

function trackHand(frame) {
  // Erkannt wird auf dem angezeigten Kamerabild, also mit der eingestellten Auflösung und Farbcodierung.
  const hand = tracker.detect(ui.cameraFrame, frame.timestamp);
  state.hand = hand;
  // Landmarken → 8 Aktuator-Stellungen, gleiche Rechnung wie auf dem Raspberry Pi (hand_mapping.py).
  state.handActuators = hand ? landmarksToActuators(hand.worldLandmarks) : null;
  showHandActuators();
  // Im Gewinnmodus steuert das Gesten-Modell die Hand (Gegenpose), dann folgt sie nicht der Kamera.
  if (!hand) followSmoother.reset();
  else if (ui.cameraFollow.checked && state.model && !gestureState.winEnabled) {
    const values = followSmoother.next(state.handActuators);
    setControls(Object.fromEntries(GESTURE_INPUTS.map((name, i) => [name, values[i]])));
  }
  drawHand(ui.cameraOverlay, hand);
  const rate = `${camera.fps.toFixed(0)} FPS (${tracker.delegate})`;
  setCameraInfo(
    hand
      ? `${HANDEDNESS[hand.handedness] ?? hand.handedness} Hand erkannt (${Math.round(hand.score * 100)} %) · ${rate}`
      : `Keine Hand im Bild · ${rate}`,
  );
}

async function toggleCamera() {
  if (camera.running) {
    camera.stop();
    setCameraActive(false);
    setCameraInfo(CAMERA_IDLE_TEXT);
    return;
  }
  ui.cameraToggle.disabled = true;
  ui.cameraPreview.hidden = false;
  setCameraInfo('Kamera und Handmodell werden geladen…');
  try {
    await camera.start();
    await tracker.load();
    if (camera.running) setCameraActive(true); // nicht, falls die Kamera inzwischen ausgefallen ist
  } catch (err) {
    console.error(err);
    camera.stop();
    setCameraActive(false);
    setCameraInfo(err.message, true);
  } finally {
    ui.cameraToggle.disabled = false;
  }
}

/** Zeigt Beugung und Spreizung der erkannten Hand in Grad (Zeige-, Mittel-, Ringfinger, Daumen). */
function showHandActuators() {
  const v = state.handActuators;
  const deg = (r) => Math.round((r * 180) / Math.PI);
  ui.cameraActuators.textContent = v
    ? `Beugung ${[0, 2, 4, 6].map((i) => `${deg(v[i])}°`).join(' / ')} · Spreizung ${[1, 3, 5, 7].map((i) => `${deg(v[i])}°`).join(' / ')}` +
      ' (Zeige / Mittel / Ring / Daumen)'
    : '';
}

function setCameraActive(active) {
  ui.cameraToggle.textContent = active ? 'Kamera beenden' : 'Kamera aktivieren';
  ui.cameraPreview.hidden = !active;
  if (!active) {
    state.hand = null;
    state.handActuators = null;
    showHandActuators();
    drawHand(ui.cameraOverlay, null);
    updateFrameInfo();
  }
}

function setCameraInfo(text, isError = false) {
  ui.cameraInfo.textContent = text;
  ui.cameraInfo.classList.toggle('error', isError);
}

/** Übernimmt eine (Teil-)Einstellung der Kamera, auch während sie läuft; wirft bei ungültigen Werten. */
function setCameraConfig(changes) {
  camera.setConfig(changes);
  showCameraConfig();
}

function showCameraConfig() {
  const { frameSize, pixelFormat, jpegQuality } = camera.config;
  ui.cameraFrameSize.value = frameSize;
  ui.cameraPixelFormat.value = pixelFormat;
  ui.cameraQuality.value = jpegQuality;
  ui.cameraQualityValue.textContent = jpegQuality;
  ui.cameraQualityRow.hidden = pixelFormat !== 'JPEG';
  updateFrameInfo();
}

/** Größe des Kamerabildes; bei laufender Kamera die des letzten Bildes und die Webcam-Auflösung. */
function updateFrameInfo() {
  const { frame, webcam, config } = camera;
  if (frame) {
    const source = `Webcam ${webcam.width}×${webcam.height}${webcam.upscaled ? ' (hochskaliert)' : ''}`;
    ui.cameraFrameInfo.textContent =
      `${frame.width}×${frame.height} ${frame.format}: ${BYTES.format(frame.len)} Byte pro Bild · ${source}`;
    return;
  }
  const { width, height } = getFrameSize(config.frameSize);
  const bytes = frameBufferSize(config);
  ui.cameraFrameInfo.textContent =
    `${width}×${height} ${config.pixelFormat}: ${bytes ? `${BYTES.format(bytes)} Byte pro Bild` : 'Größe je nach Bildinhalt'}`;
}

ui.cameraFrameSize.replaceChildren(
  ...FRAME_SIZES.map((s) => new Option(`${s.name} – ${s.width}×${s.height}`, s.name)),
);
ui.cameraPixelFormat.replaceChildren(
  ...PIXEL_FORMATS.map((f) => new Option(`${f.name} – ${f.description}`, f.name)),
);
showCameraConfig();

// ---------------------------------------------------------------------------
// Schere, Stein, Papier: Posen der simulierten Hand und Gegenpose zum Gewinnen
// ---------------------------------------------------------------------------

const WINNING_POSES = {
  rock: {
    name: 'Stein',
    controls: {
      index_flex: 1.571, index_abd: 0,
      middle_flex: 1.571, middle_abd: 0,
      ring_flex: 1.571, ring_abd: 0,
      thumb_flex: 1.571, thumb_abd: 0,
    },
  },
  paper: {
    name: 'Papier',
    controls: {
      index_flex: 0, index_abd: 0,
      middle_flex: 0, middle_abd: 0,
      ring_flex: 0, ring_abd: 0,
      thumb_flex: 0, thumb_abd: 0,
    },
  },
  scissors: {
    name: 'Schere',
    controls: {
      index_flex: 0, index_abd: 0.157,
      middle_flex: 0, middle_abd: -0.157,
      ring_flex: 1.571, ring_abd: 0,
      thumb_flex: 1.571, thumb_abd: 0,
    },
  },
};

const COUNTER_POSES = {
  rock: { gesture: 'paper', name: 'Papier' },
  paper: { gesture: 'scissors', name: 'Schere' },
  scissors: { gesture: 'rock', name: 'Stein' },
};

// ---------------------------------------------------------------------------
// Gesten-Modell mit Aktuator-Stellungen als Eingabe (siehe gestureModel.js)
// ---------------------------------------------------------------------------

const GESTURE_NAMES = { rock: 'Stein', paper: 'Papier', scissors: 'Schere', nothing: 'Keine Geste' };

const gestureState = {
  /** Auswahl im Panel: mitgeliefertes Modell (falls trainiert und eingecheckt) und geöffnete Dateien. */
  sources: BUNDLED_GESTURE_MODEL
    ? [{
        label: `model/gesture/output/gesture.tflite${BUNDLED_GESTURE_IS_PLACEHOLDER ? ' – Platzhalter (künstliche Daten)' : ''}`,
        source: BUNDLED_GESTURE_MODEL,
        name: BUNDLED_GESTURE_IS_PLACEHOLDER ? 'gesture.tflite (Platzhalter)' : 'gesture.tflite',
        labels: BUNDLED_GESTURE_LABELS,
      }]
    : [],
  model: null, // geladenes GestureModel
  labels: [],
  enabled: false,
  running: null, // laufende Auswertung (Promise); solange wird kein neuer Durchlauf gestartet
  result: null, // { inputs, values, label, score, inferenceMs }
  bars: [],
  winEnabled: false, // Gewinnmodus: simulierte Hand zeigt die Gegenpose zur erkannten Geste
};

/**
 * Aktuelle Stellung der 8 Aktuatoren in rad, Reihenfolge wie GESTURE_INPUTS. Gelesen wird actuator_length, also die
 * tatsächliche Gelenkstellung am Aktuator – im Physik-Modus (Slider setzen Sollwerte) wie im Kinematik-Modus.
 */
function readGestureInputs() {
  const { mujoco, model, data } = state;
  const lengths = data.actuator_length;
  return GESTURE_INPUTS.map((name) => {
    const id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_ACTUATOR.value, name);
    if (id < 0) throw new Error(`Das geladene Handmodell hat keinen Aktuator „${name}“.`);
    return lengths[id];
  });
}

async function loadGestureModel({ source, name, labels = [] }) {
  setGestureInfo(`Lade ${name}…`);
  ui.gestureToggle.disabled = true;
  try {
    const model = await GestureModel.load(source, { name });
    const old = gestureState.model;
    gestureState.model = null;
    await gestureState.running;
    old?.delete();
    gestureState.model = model;
    gestureState.labels = labels;
    gestureState.result = null;
    showGestureModel();
  } finally {
    ui.gestureToggle.disabled = false;
  }
}

function loadSelectedGestureModel() {
  const selected = gestureState.sources[ui.gestureModelSelect.value];
  if (!selected) throw new Error('Kein Gesten-Modell vorhanden – mit „Datei öffnen…“ gesture.tflite und labels.txt wählen.');
  return loadGestureModel(selected);
}

async function toggleGestureModel() {
  if (gestureState.enabled) return setGestureEnabled(false);
  if (!gestureState.model) await loadSelectedGestureModel();
  setGestureEnabled(true);
}

function setGestureEnabled(enabled) {
  gestureState.enabled = enabled;
  ui.gestureToggle.textContent = enabled ? 'Modell stoppen' : 'Modell starten';
  ui.gestureResult.hidden = !enabled;
  if (!enabled) {
    ui.gestureStatus.textContent = '';
    setGestureWinEnabled(false);
  }
}

function setGestureInfo(text, isError = false) {
  ui.gestureInfo.textContent = text;
  ui.gestureInfo.classList.toggle('error', isError);
}

function showGestureError(err) {
  console.error(err);
  setGestureEnabled(false);
  setGestureInfo(err.message, true);
}

function showGestureModel() {
  const { name, size, outputs, operators } = gestureState.model;
  const count = outputs.reduce((n, o) => n + o.shape.reduce((a, b) => a * b, 1), 0);
  const missing = gestureState.labels.length ? '' : ' · ohne labels.txt';
  setGestureInfo(`${name}, ${BYTES.format(size)} Byte · Eingabe 8 Aktuatoren · ${count} Gesten · Operatoren: ${operators.join(', ')}${missing}`);
  gestureState.bars = Array.from({ length: count }, (_, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'control';
    wrap.innerHTML = `<div class="control-head"><span></span><output>–</output></div><div class="prob-bar"><span></span></div>`;
    const label = gestureState.labels[i];
    wrap.querySelector('span').textContent = label ? (GESTURE_NAMES[label] ?? label) : `Output[${i}]`;
    return { wrap, output: wrap.querySelector('output'), bar: wrap.querySelector('.prob-bar span') };
  });
  ui.gestureOutputs.replaceChildren(...gestureState.bars.map((b) => b.wrap));
}

/** Wertet die aktuelle Handstellung aus, sofern das Modell läuft und gerade frei ist (aufgerufen je Bild). */
function runGestureModel() {
  const { model } = gestureState;
  if (!gestureState.enabled || !model || gestureState.running || !state.model) return;
  let inputs;
  if (ui.gestureSource.value === 'camera') {
    // Direkt aus der Kamera, ohne Umweg über die (verzögert nachfahrende) simulierte Hand – wie später auf dem Pi.
    inputs = state.handActuators;
    if (!inputs) {
      ui.gestureDetected.textContent = '';
      ui.gestureStatus.textContent = camera.running
        ? 'Keine Hand im Bild.'
        : 'Wartet auf die Kamera – oben bei „Kamera & Hand-Tracking“ aktivieren.';
      return;
    }
  } else {
    try {
      inputs = readGestureInputs();
    } catch (err) {
      showGestureError(err);
      return;
    }
  }
  gestureState.running = model
    .run(inputs)
    .then(({ values, inferenceMs }) => {
      if (gestureState.model === model && gestureState.enabled) showGestureResult(inputs, values, inferenceMs);
    })
    .catch((err) => showGestureError(new Error(`Auswertung fehlgeschlagen: ${err?.message ?? err}`, { cause: err })))
    .finally(() => {
      gestureState.running = null;
    });
}

function showGestureResult(inputs, values, inferenceMs) {
  const best = values.reduce((b, v, i) => (v > values[b] ? i : b), 0);
  const label = gestureState.labels[best] ?? `Output[${best}]`;
  gestureState.result = { inputs, values, label, score: values[best], inferenceMs };
  values.forEach((v, i) => {
    if (!gestureState.bars[i]) return;
    gestureState.bars[i].output.textContent = v.toFixed(3);
    gestureState.bars[i].bar.style.width = `${Math.min(1, Math.max(0, v)) * 100}%`;
  });
  ui.gestureDetected.textContent = `Erkannt: ${GESTURE_NAMES[label] ?? label} (${(values[best] * 100).toFixed(0)} %)`;
  const source = ui.gestureSource.value === 'camera' ? 'echte Hand (Kamera)' : 'simulierte Hand';
  let status = `Eingabe: ${source} · ${inferenceMs.toFixed(2)} ms pro Auswertung im Browser`;
  if (gestureState.winEnabled && state.model) {
    const counter = COUNTER_POSES[label];
    if (counter) {
      setControls(WINNING_POSES[counter.gesture].controls);
      status += ` · Hand zeigt ${counter.name} und gewinnt`;
    } else {
      status += ' · Warte auf Stein, Schere oder Papier';
    }
  }
  ui.gestureStatus.textContent = status;
}

/** Gewinnmodus: Die simulierte Hand zeigt die Geste, die gegen die erkannte Geste der echten Hand gewinnt. */
function setGestureWinEnabled(enabled) {
  gestureState.winEnabled = enabled;
  ui.gestureWin.textContent = enabled ? 'Gewinnmodus beenden' : 'Schere, Stein, Papier gewinnen';
  if (enabled) ui.gestureSource.value = 'camera';
}

function fillGestureModelSelect(selected = 0) {
  ui.gestureModelSelect.replaceChildren(
    ...(gestureState.sources.length
      ? gestureState.sources.map((s, i) => new Option(s.label, i, false, i === selected))
      : [new Option('– noch kein Modell trainiert –', '')]),
  );
}

fillGestureModelSelect();

// ---------------------------------------------------------------------------
// Ereignisse
// ---------------------------------------------------------------------------

ui.play.addEventListener('click', () => setPaused(!state.paused));
ui.reset.addEventListener('click', () => {
  if (!state.model) return;
  state.mujoco.mj_resetData(state.model, state.data);
  state.mujoco.mj_forward(state.model, state.data);
  restartClock();
  buildControls();
});
document.querySelectorAll('input[name="mode"]').forEach((r) =>
  r.addEventListener('change', () => setMode(r.value)),
);
ui.cameraToggle.addEventListener('click', toggleCamera);
ui.cameraFrameSize.addEventListener('change', () => setCameraConfig({ frameSize: ui.cameraFrameSize.value }));
ui.cameraPixelFormat.addEventListener('change', () => setCameraConfig({ pixelFormat: ui.cameraPixelFormat.value }));
ui.cameraQuality.addEventListener('input', () => setCameraConfig({ jpegQuality: Number(ui.cameraQuality.value) }));

ui.gestureWin.addEventListener('click', async () => {
  if (gestureState.winEnabled) return setGestureWinEnabled(false);
  try {
    if (!gestureState.model) await loadSelectedGestureModel();
    setGestureEnabled(true);
    setGestureWinEnabled(true);
  } catch (err) {
    showGestureError(err);
  }
});
ui.gestureSource.addEventListener('change', () => {
  // Mit der simulierten Hand als Eingabe würde die Gegenpose sofort wieder als Geste erkannt.
  if (ui.gestureSource.value !== 'camera') setGestureWinEnabled(false);
});

ui.gestureToggle.addEventListener('click', () => toggleGestureModel().catch(showGestureError));
ui.gestureModelSelect.addEventListener('change', () =>
  loadSelectedGestureModel().then(() => setGestureEnabled(true)).catch(showGestureError),
);
ui.gestureOpen.addEventListener('click', () => ui.gestureFileInput.click());
ui.gestureFileInput.addEventListener('change', async () => {
  const files = [...ui.gestureFileInput.files];
  ui.gestureFileInput.value = '';
  const file = files.find((f) => f.name.toLowerCase().endsWith('.tflite'));
  const labelsFile = files.find((f) => f.name.toLowerCase().endsWith('.txt'));
  if (!file) return showGestureError(new Error('Bitte eine .tflite-Datei auswählen (dazu optional labels.txt).'));
  const labels = labelsFile ? parseLabels(await labelsFile.text()) : [];
  gestureState.sources.push({ label: `Datei: ${file.name}`, source: file, name: file.name, labels });
  fillGestureModelSelect(gestureState.sources.length - 1);
  loadSelectedGestureModel().then(() => setGestureEnabled(true)).catch(showGestureError);
});

ui.modelSelect.addEventListener('change', () => {
  if (ui.modelSelect.value) guarded(() => loadServed(ui.modelSelect.value));
});
ui.entrySelect.addEventListener('change', () =>
  guarded(() => loadFiles(state.files, ui.entrySelect.value, ui.entrySelect.value)),
);

$('open-folder').addEventListener('click', () => ui.folderInput.click());
$('open-files').addEventListener('click', () => ui.filesInput.click());
ui.folderInput.addEventListener('change', () => {
  const list = [...ui.folderInput.files].map((file) => ({ path: file.webkitRelativePath, file }));
  guarded(() => loadLocal(list, list[0]?.path.split('/')[0] ?? 'Ordner'));
  ui.folderInput.value = '';
});
ui.filesInput.addEventListener('change', () => {
  const list = [...ui.filesInput.files].map((file) => ({ path: file.name, file }));
  guarded(() => loadLocal(list, 'Lokale Dateien'));
  ui.filesInput.value = '';
});

let dragDepth = 0;
ui.viewport.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; ui.dropOverlay.hidden = false; });
ui.viewport.addEventListener('dragleave', () => { if (--dragDepth <= 0) ui.dropOverlay.hidden = true; });
ui.viewport.addEventListener('dragover', (e) => e.preventDefault());
ui.viewport.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  ui.dropOverlay.hidden = true;
  const items = e.dataTransfer.items;
  guarded(async () => {
    const list = await collectDropped(items);
    await loadLocal(list, list[0]?.path.split('/')[0] ?? 'Abgelegte Dateien');
  });
});

/** Setzt Aktuator-Sollwerte nach Name (wirksam im Physik-Modus). */
function setControls(values) {
  const { mujoco, model, data } = state;
  for (const [actName, v] of Object.entries(values)) {
    const id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_ACTUATOR.value, actName);
    if (id >= 0) data.ctrl[id] = v;
  }
  if (state.mode === 'physics') state.sliders.forEach((s) => s.refresh());
}

// Schnittstelle für spätere Anbindung (z. B. Posenschätzung): window.sim.setJoints({ index_mcp: 0.5 })
window.sim = {
  get model() { return state.model; },
  get data() { return state.data; },
  get mujoco() { return state.mujoco; },
  /** Zuletzt erkannte Hand der Kamera ({ landmarks, worldLandmarks, handedness, score }) oder null. */
  get hand() { return state.hand; },
  /** Daraus berechnete 8 Aktuator-Stellungen in rad (Reihenfolge wie gestureModel.inputs) oder null. */
  get handActuators() { return state.handActuators; },
  /** Kamera (siehe camera.js). */
  camera: {
    /** Läuft die Kamera? */
    get running() { return camera.running; },
    /** Einstellung { frameSize, pixelFormat, jpegQuality }. */
    get config() { return { ...camera.config }; },
    /** Letztes Kamerabild ({ buf, len, width, height, format, timestamp }) oder null. */
    get frame() { return camera.frame; },
    /** Ändert die Einstellung, auch bei laufender Kamera, z. B. setConfig({ frameSize: 'HD', pixelFormat: 'JPEG' }). */
    setConfig(changes) {
      setCameraConfig(changes);
      return { ...camera.config };
    },
  },
  /** Setzt Gelenkwinkel (rad bzw. m) nach Name und aktualisiert die Kinematik. */
  setJoints(values) {
    const { mujoco, model, data } = state;
    for (const [jointName, v] of Object.entries(values)) {
      const id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT.value, jointName);
      if (id >= 0) data.qpos[model.jnt_qposadr[id]] = v;
    }
    forward();
    if (state.mode === 'kinematic') state.sliders.forEach((s) => s.refresh());
  },
  /** Setzt Aktuator-Sollwerte nach Name (wirksam im Physik-Modus). */
  setControls,
  /** Gesten-Modell mit den 8 Aktuator-Stellungen als Eingabe (siehe gestureModel.js). */
  gestureModel: {
    /** Reihenfolge der Eingabe. */
    inputs: GESTURE_INPUTS,
    /** Geladenes Modell { name, size, labels, operators } oder null. */
    get info() {
      const m = gestureState.model;
      return m && { name: m.name, size: m.size, labels: [...gestureState.labels], operators: m.operators };
    },
    /** Letztes Ergebnis { inputs, values, label, score, inferenceMs } oder null. */
    get result() { return gestureState.result; },
    /** Lädt ein Modell (URL, File oder Uint8Array) mit Beschriftung (labels.txt-Text oder Array) und startet es. */
    async load(source, labels = [], name = String(source)) {
      await loadGestureModel({ source, name, labels: typeof labels === 'string' ? parseLabels(labels) : labels });
      setGestureEnabled(true);
      return this.info;
    },
    /** Wertet eigene Werte aus (8 Zahlen in rad), unabhängig von der Simulation; ohne Argument die aktuelle Hand. */
    async run(values = readGestureInputs()) {
      if (!gestureState.model) throw new Error('Kein Gesten-Modell geladen.');
      const { values: scores } = await gestureState.model.run(values);
      const best = scores.reduce((b, v, i) => (v > scores[b] ? i : b), 0);
      return { values: scores, label: gestureState.labels[best] ?? `Output[${best}]`, score: scores[best] };
    },
  },
};

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

requestAnimationFrame(frame);

guarded(async () => {
  state.mujoco = await getMujoco();
  state.served = await listServedModels();
  ui.modelSelect.replaceChildren(
    new Option('– auswählen –', ''),
    ...state.served.map((m) => new Option(m.folder, m.folder)),
  );
  // Startmodell: ?model=<ordner> in der URL, sonst die Amazing Hand, sonst demo_hand.
  const wanted = [new URLSearchParams(location.search).get('model'), 'amazing_hand', 'demo_hand'];
  const initial =
    wanted.map((f) => state.served.find((m) => m.folder === f)).find(Boolean) ?? state.served[0];
  if (initial) {
    ui.modelSelect.value = initial.folder;
    await loadServed(initial.folder);
  } else {
    setStatus('Kein Modell in public/models gefunden – Ordner öffnen oder hierher ziehen.');
  }
});
