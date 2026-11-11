// Einstiegspunkt der Web-Oberfläche: Modell laden, Simulation laufen lassen, Gelenke/Aktuatoren steuern.
import { Renderer } from './renderer.js';
import {
  getMujoco,
  compileModel,
  listServedModels,
  fetchServedModel,
  readLocalFiles,
  findEntryCandidates,
} from './mujoco.js';

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

// Schnittstelle für spätere Anbindung (z. B. Posenschätzung): window.sim.setJoints({ index_mcp: 0.5 })
window.sim = {
  get model() { return state.model; },
  get data() { return state.data; },
  get mujoco() { return state.mujoco; },
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
  setControls(values) {
    const { mujoco, model, data } = state;
    for (const [actName, v] of Object.entries(values)) {
      const id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_ACTUATOR.value, actName);
      if (id >= 0) data.ctrl[id] = v;
    }
    if (state.mode === 'physics') state.sliders.forEach((s) => s.refresh());
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
