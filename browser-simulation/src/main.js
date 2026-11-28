// Einstiegspunkt der Web-Oberfläche: Modell laden, Simulation laufen lassen, Gelenke/Aktuatoren steuern,
// Hand per (wie beim ESP32 eingestellter) Kamera erkennen, KI-Modelle für den ESP32 auf den Kamerabildern testen.
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
import { Esp32Camera, FRAME_SIZES, PIXEL_FORMATS, getFrameSize, frameBufferSize } from './esp32Camera.js';
import { Esp32Model, FIRMWARE_MODEL_URL } from './esp32Model.js';
import firmwareLabelsText from '../../model/output/labels.txt?raw';
import {
  GestureModel,
  GESTURE_INPUTS,
  BUNDLED_GESTURE_MODEL,
  BUNDLED_GESTURE_LABELS,
  parseLabels,
} from './gestureModel.js';

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
  aiModelSelect: $('ai-model-select'),
  aiToggle: $('ai-toggle'),
  aiOpen: $('ai-open'),
  aiFileInput: $('ai-file-input'),
  aiInfo: $('ai-info'),
  aiResult: $('ai-result'),
  aiInput: $('ai-input'),
  aiOutputs: $('ai-outputs'),
  aiDriveHand: $('ai-drive-hand'),
  aiWin: $('ai-win'),
  aiStatus: $('ai-status'),
  gestureModelSelect: $('gesture-model-select'),
  gestureToggle: $('gesture-toggle'),
  gestureOpen: $('gesture-open'),
  gestureFileInput: $('gesture-file-input'),
  gestureInfo: $('gesture-info'),
  gestureResult: $('gesture-result'),
  gestureDetected: $('gesture-detected'),
  gestureOutputs: $('gesture-outputs'),
  gestureStatus: $('gesture-status'),
};

const firmwareLabels = firmwareLabelsText
  .split(/\r?\n/)
  .filter(Boolean)
  .map((line) => line.replace(/^Output\[\d+\]\s*=\s*/, ''));

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
const camera = new Esp32Camera(ui.cameraVideo, ui.cameraFrame, {
  onFrame(frame) {
    updateFrameInfo();
    // Kleine Auflösungen pixelgenau vergrößern (siehe style.css).
    ui.cameraFrame.classList.toggle('pixelated', ui.cameraFrame.clientWidth * devicePixelRatio >= 2 * frame.width);
    if (tracker.ready) trackHand(frame); // sonst wird das Handmodell noch geladen
    // Erst nach dem Hand-Tracking, damit dessen Rechenzeit nicht in die gemessene Zeit des KI-Modells fällt.
    runEsp32Model(frame);
  },
  onError(err) {
    console.error(err);
    setCameraActive(false);
    setCameraInfo(err.message, true);
  },
});

function trackHand(frame) {
  // Erkannt wird auf dem angezeigten Kamerabild, also auf dem, was der ESP32 liefern würde.
  const hand = tracker.detect(ui.cameraFrame, frame.timestamp);
  // Hier kann später die Abbildung der Landmarken auf die Gelenke ansetzen (z. B. window.sim.setJoints).
  state.hand = hand;
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

function setCameraActive(active) {
  ui.cameraToggle.textContent = active ? 'Kamera beenden' : 'Kamera aktivieren';
  ui.cameraPreview.hidden = !active;
  if (!active) {
    state.hand = null;
    drawHand(ui.cameraOverlay, null);
    updateFrameInfo();
    showAiWaiting();
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

/** Größe des Kamerabildes (wie fb->len); bei laufender Kamera die des letzten Bildes und die Webcam-Auflösung. */
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
// ESP32-KI-Modell (siehe esp32Model.js)
// ---------------------------------------------------------------------------

/** Fingerbeuger der Amazing Hand, der Reihe nach von den Modellausgaben angesteuert (Platzhalter). */
const FLEX_ACTUATORS = ['index_flex', 'middle_flex', 'ring_flex', 'thumb_flex'];

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

/**
 * Platzhalter für die Ansteuerung der Hand, bis die Abläufe feststehen: Ausgabe i (0…1) beugt Finger i (Zeige-,
 * Mittel-, Ringfinger, Daumen) von 0 bis 90°. Ersetzen mit window.sim.esp32Model.setHandMapping(fn).
 * @param {number[]} values Modellausgaben
 * @returns {Record<string, number>} Aktuator-Sollwerte in rad (wie window.sim.setControls)
 */
function placeholderHandMapping(values) {
  return Object.fromEntries(
    FLEX_ACTUATORS.slice(0, values.length).map((name, i) => [name, Math.min(1, Math.max(0, values[i])) * (Math.PI / 2)]),
  );
}

const ai = {
  /** Auswahl im Panel: Firmware-Modell und alle in dieser Sitzung geöffneten Dateien. */
  sources: [{ label: 'Firmware: hand.tflite', source: FIRMWARE_MODEL_URL, name: 'hand.tflite (Firmware)' }],
  model: null, // geladenes Esp32Model
  running: null, // laufende Auswertung (Promise) – solange verfallen neue Kamerabilder wie bei CAMERA_GRAB_LATEST
  enabled: false, // wertet Kamerabilder aus
  winEnabled: false, // zeigt die gewinnende Gegenpose zur erkannten Geste
  result: null, // letztes Ergebnis { values, timestamp, preprocessMs, inferenceMs }
  labels: [], // Beschriftung der Ausgaben, leer = Output[i] wie im seriellen Monitor des ESP32
  handMapping: placeholderHandMapping,
  bars: [], // Anzeige je Ausgabe { output, bar }
};

/** Lädt ein Modell und ersetzt das bisherige erst, wenn das neue fertig geladen ist. */
async function loadAiModel(source, name) {
  setAiInfo(`Lade ${name}…`);
  ui.aiToggle.disabled = true;
  try {
    const model = await Esp32Model.load(source, { name });
    const old = ai.model;
    ai.model = null;
    await ai.running; // laufende Auswertung des alten Modells abwarten, erst dann freigeben
    old?.delete();
    ai.model = model;
    ai.result = null;
    showAiModel();
  } finally {
    ui.aiToggle.disabled = false;
  }
}

function loadSelectedAiModel() {
  const { source, name } = ai.sources[ui.aiModelSelect.value];
  return loadAiModel(source, name);
}

async function toggleAiModel() {
  if (ai.enabled) return setAiEnabled(false);
  if (!ai.model) await loadSelectedAiModel();
  setAiEnabled(true);
}

function setAiEnabled(enabled) {
  ai.enabled = enabled;
  ui.aiToggle.textContent = enabled ? 'Modell stoppen' : 'Modell starten';
  ui.aiResult.hidden = !enabled;
  if (!enabled) setAiWinEnabled(false);
  showAiWaiting();
}

function setAiWinEnabled(enabled) {
  ai.winEnabled = enabled;
  ui.aiWin.textContent = enabled ? 'Gewinnmodus beenden' : 'Schere, Stein, Papier gewinnen';
  ui.aiDriveHand.disabled = enabled;
}

/** Hinweis, solange das Modell läuft, aber keine Kamerabilder kommen. */
function showAiWaiting() {
  ui.aiStatus.textContent = ai.enabled && !camera.running ? 'Wartet auf Kamerabilder – oben „Kamera aktivieren“.' : '';
}

function setAiInfo(text, isError = false) {
  ui.aiInfo.textContent = text;
  ui.aiInfo.classList.toggle('error', isError);
}

function showAiError(err) {
  console.error(err);
  setAiEnabled(false);
  setAiInfo(err.message, true);
}

/** Eckdaten des Modells: Eingabe (wie kInputWidth/kInputHeight in der Firmware), Ausgaben, Operatoren. */
function showAiModel() {
  const { name, size, input, outputs, operators } = ai.model;
  const quant = input.scale ? `, scale ${input.scale}, zero_point ${input.zeroPoint}` : '';
  const count = outputs.reduce((n, o) => n + o.shape.reduce((a, b) => a * b, 1), 0);
  setAiInfo(
    `${name}, ${BYTES.format(size)} Byte · Eingabe ${input.width}×${input.height}×${input.channels} ` +
      `${input.dtype}${quant} · ${count} Ausgaben · Operatoren: ${operators.join(', ')}`,
  );
  Object.assign(ui.aiInput, { width: input.width, height: input.height });
  buildAiOutputs(count);
}

function buildAiOutputs(count) {
  const labels = ai.labels.length ? ai.labels : firmwareLabels;
  ai.bars = Array.from({ length: count }, (_, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'control';
    wrap.innerHTML = `<div class="control-head"><span></span><output>–</output></div><div class="ai-bar"><span></span></div>`;
    wrap.querySelector('span').textContent = labels[i] ?? `Output[${i}]`;
    return { wrap, output: wrap.querySelector('output'), bar: wrap.querySelector('.ai-bar span') };
  });
  ui.aiOutputs.replaceChildren(...ai.bars.map((b) => b.wrap));
}

/** Wertet ein Kamerabild aus, sofern das Modell läuft und gerade frei ist. */
function runEsp32Model(frame) {
  const { model } = ai;
  if (!ai.enabled || !model || ai.running) return;
  ai.running = model
    .run(frame)
    .then((result) => {
      if (ai.model === model && ai.enabled) showAiResult(result, frame);
    })
    .catch((err) => showAiError(new Error(`Auswertung fehlgeschlagen: ${err?.message ?? err}`, { cause: err })))
    .finally(() => {
      ai.running = null;
    });
}

function showAiResult(result, frame) {
  const { input } = ai.model;
  if (!result) {
    ui.aiStatus.textContent =
      `Kamerabild ${frame.width}×${frame.height} ist kleiner als die Modelleingabe ${input.width}×${input.height} – ` +
      'größere Auflösung wählen (die Firmware würde das Bild ebenfalls ablehnen).';
    return;
  }
  const { values, pixels, preprocessMs, inferenceMs } = result;
  ai.result = { values, timestamp: frame.timestamp, preprocessMs, inferenceMs };
  values.forEach((v, i) => {
    if (!ai.bars[i]) return;
    ai.bars[i].output.textContent = v.toFixed(3);
    ai.bars[i].bar.style.width = `${Math.min(1, Math.max(0, v)) * 100}%`; // Balken für Werte 0…1
  });
  drawModelInput(pixels, input);
  let status =
    `${(preprocessMs + inferenceMs).toFixed(1)} ms pro Bild ` +
    `(Vorverarbeitung ${preprocessMs.toFixed(1)} ms, Modell ${inferenceMs.toFixed(1)} ms im Browser)`;
  if (ui.aiDriveHand.checked && state.model && !ai.winEnabled) setControls(ai.handMapping(values));
  if (ai.winEnabled && state.model) {
    const labels = ai.labels.length ? ai.labels : firmwareLabels;
    const index = values.reduce((best, value, i, all) => (value > all[best] ? i : best), 0);
    const label = labels[index]?.trim().toLowerCase();
    const gesture = ({ stein: 'rock', rock: 'rock', papier: 'paper', paper: 'paper', schere: 'scissors', scissors: 'scissors' })[label];
    if (gesture) {
      const counter = COUNTER_POSES[gesture];
      setControls(WINNING_POSES[counter.gesture].controls);
      status += ` · Erkannt: ${WINNING_POSES[gesture].name} → Hand: ${counter.name}`;
    } else if (label === 'nothing' || label === 'nichts') {
      status += ' · Keine Hand erkannt; warte auf eine Pose.';
    } else {
      status += ' · Pose nicht unterstützt; prüfe die Modell-Labels.';
    }
  }
  ui.aiStatus.textContent = status;
}

/** Zeigt das Bild, wie es das Modell bekommt (nach Zuschnitt und Verkleinerung). */
function drawModelInput(pixels, { width, height, channels }) {
  const image = new ImageData(width, height);
  for (let i = 0; i < width * height; i++) {
    const p = i * channels;
    image.data.set(channels === 1 ? [pixels[p], pixels[p], pixels[p], 255] : [...pixels.subarray(p, p + 3), 255], 4 * i);
  }
  ui.aiInput.getContext('2d').putImageData(image, 0, 0);
}

function fillAiModelSelect(selected = 0) {
  ui.aiModelSelect.replaceChildren(...ai.sources.map((s, i) => new Option(s.label, i, false, i === selected)));
}

fillAiModelSelect();

// ---------------------------------------------------------------------------
// Gesten-Modell mit Aktuator-Stellungen als Eingabe (siehe gestureModel.js)
// ---------------------------------------------------------------------------

const GESTURE_NAMES = { rock: 'Stein', paper: 'Papier', scissors: 'Schere', nothing: 'Keine Geste' };

const gestureState = {
  /** Auswahl im Panel: mitgeliefertes Modell (falls trainiert und eingecheckt) und geöffnete Dateien. */
  sources: BUNDLED_GESTURE_MODEL
    ? [{ label: 'model/gesture/output/gesture.tflite', source: BUNDLED_GESTURE_MODEL, name: 'gesture.tflite', labels: BUNDLED_GESTURE_LABELS }]
    : [],
  model: null, // geladenes GestureModel
  labels: [],
  enabled: false,
  running: null, // laufende Auswertung (Promise); solange wird kein neuer Durchlauf gestartet
  result: null, // { inputs, values, label, score, inferenceMs }
  bars: [],
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
  if (!enabled) ui.gestureStatus.textContent = '';
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
    wrap.innerHTML = `<div class="control-head"><span></span><output>–</output></div><div class="ai-bar"><span></span></div>`;
    const label = gestureState.labels[i];
    wrap.querySelector('span').textContent = label ? (GESTURE_NAMES[label] ?? label) : `Output[${i}]`;
    return { wrap, output: wrap.querySelector('output'), bar: wrap.querySelector('.ai-bar span') };
  });
  ui.gestureOutputs.replaceChildren(...gestureState.bars.map((b) => b.wrap));
}

/** Wertet die aktuelle Handstellung aus, sofern das Modell läuft und gerade frei ist (aufgerufen je Bild). */
function runGestureModel() {
  const { model } = gestureState;
  if (!gestureState.enabled || !model || gestureState.running || !state.model) return;
  let inputs;
  try {
    inputs = readGestureInputs();
  } catch (err) {
    showGestureError(err);
    return;
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
  ui.gestureStatus.textContent = `${inferenceMs.toFixed(2)} ms pro Auswertung im Browser`;
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

ui.aiToggle.addEventListener('click', () => toggleAiModel().catch(showAiError));
ui.aiWin.addEventListener('click', async () => {
  if (ai.winEnabled) {
    setAiWinEnabled(false);
    showAiWaiting();
    return;
  }
  setAiWinEnabled(true);
  try {
    if (!ai.model) await loadSelectedAiModel();
    setAiEnabled(true);
  } catch (err) {
    setAiWinEnabled(false);
    showAiError(err);
  }
});
ui.aiModelSelect.addEventListener('change', () =>
  loadSelectedAiModel().then(() => setAiEnabled(true)).catch(showAiError),
);
ui.aiOpen.addEventListener('click', () => ui.aiFileInput.click());
ui.aiFileInput.addEventListener('change', () => {
  const [file] = ui.aiFileInput.files;
  ui.aiFileInput.value = '';
  if (!file) return;
  ai.sources.push({ label: `Datei: ${file.name}`, source: file, name: file.name });
  fillAiModelSelect(ai.sources.length - 1);
  loadSelectedAiModel().then(() => setAiEnabled(true)).catch(showAiError);
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
  /** Kamera wie beim ESP32 (siehe esp32Camera.js). */
  camera: {
    /** Einstellung { frameSize, pixelFormat, jpegQuality } – entspricht .frame_size, .pixel_format, .jpeg_quality. */
    get config() { return { ...camera.config }; },
    /** Letztes Kamerabild wie camera_fb_t ({ buf, len, width, height, format, timestamp }) oder null. */
    get frame() { return camera.frame; },
    /** Ändert die Einstellung, auch bei laufender Kamera, z. B. setConfig({ pixelFormat: 'GRAYSCALE' }). */
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
  /** KI-Modell für den ESP32, ausgewertet auf den Kamerabildern (siehe esp32Model.js). */
  esp32Model: {
    /** Geladenes Modell { name, size, input, outputs, operators, inputRange } oder null. */
    get info() {
      const m = ai.model;
      return m && { name: m.name, size: m.size, input: { ...m.input }, outputs: m.outputs, operators: m.operators, inputRange: m.inputRange };
    },
    /** Letztes Ergebnis { values, timestamp, preprocessMs, inferenceMs } oder null. */
    get result() { return ai.result; },
    /** Lädt ein Modell (URL, File oder Uint8Array) und startet es. */
    async load(source, name = String(source)) {
      await loadAiModel(source, name);
      setAiEnabled(true);
      return this.info;
    },
    /** Wertet ein eigenes Bild aus, aufgebaut wie camera_fb_t ({ buf, width, height, format }) – auch ohne Kamera. */
    run(frame) {
      if (!ai.model) throw new Error('Kein Modell geladen.');
      return ai.model.run(frame);
    },
    /** Beschriftet die Ausgaben, z. B. setLabels(['offen', 'Faust', 'Zeigen']); [] = Output[i]. */
    setLabels(labels) {
      ai.labels = [...labels];
      if (ai.model) buildAiOutputs(ai.bars.length);
    },
    /** Ersetzt die Ansteuerung der Hand: fn(values) → { aktuator: Sollwert in rad }; null = Platzhalter. */
    setHandMapping(fn) { ai.handMapping = fn ?? placeholderHandMapping; },
    /** Ansteuerung der Hand ein/aus (wie die Checkbox im Panel). */
    get driveHand() { return ui.aiDriveHand.checked; },
    set driveHand(on) { ui.aiDriveHand.checked = Boolean(on); },
  },
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
