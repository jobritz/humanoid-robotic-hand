// Gesten-Modell mit Aktuator-Stellungen als Eingabe (SCRUM-37, erzeugt mit model/gesture/train_gesture_model.py):
// 8 Werte in rad rein, je Geste eine Wahrscheinlichkeit raus. Läuft wie das Bildmodell mit LiteRT.js.
import { loadAndCompile, Tensor } from '@litertjs/core';
import { readTfliteInfo, withStaticShapes } from './tfliteInfo.js';
import { getLiteRt, readBytes } from './esp32Model.js';

/** Reihenfolge der Eingabe – wie ACTUATORS in model/gesture/gesture_common.py und die Aktuatoren in MuJoCo.xml. */
export const GESTURE_INPUTS = [
  'index_flex', 'index_abd',
  'middle_flex', 'middle_abd',
  'ring_flex', 'ring_abd',
  'thumb_flex', 'thumb_abd',
];

// Mitgeliefertes Modell, sobald es trainiert und eingecheckt ist (sonst leer → nur „Datei öffnen…“).
const bundled = import.meta.glob('../../model/gesture/output/gesture.tflite', { query: '?url', import: 'default', eager: true });
const bundledLabels = import.meta.glob('../../model/gesture/output/labels.txt', { query: '?raw', import: 'default', eager: true });

/** URL des mitgelieferten Modells oder null. */
export const BUNDLED_GESTURE_MODEL = Object.values(bundled)[0] ?? null;

/** Beschriftung des mitgelieferten Modells aus labels.txt ("Output[i] = name"). */
export const BUNDLED_GESTURE_LABELS = parseLabels(Object.values(bundledLabels)[0] ?? '');

export function parseLabels(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.includes('='))
    .map((line) => line.replace(/^Output\[\d+\]\s*=\s*/, '').trim());
}

export class GestureModel {
  /** @param {string | URL | Blob | Uint8Array} source URL, Datei oder Inhalt der .tflite-Datei */
  static async load(source, { name = String(source) } = {}) {
    const bytes = await readBytes(source);
    const info = readTfliteInfo(bytes);
    const input = checkInput(info);
    await getLiteRt();
    const compiled = await loadAndCompile(withStaticShapes(bytes), { accelerator: 'wasm' });
    return new GestureModel(compiled, { ...info, input, name, size: bytes.length });
  }

  constructor(compiled, { input, outputs, operators, name, size }) {
    Object.assign(this, { compiled, input, outputs, operators, name, size });
  }

  /**
   * @param {number[]} values Stellungen in rad, Reihenfolge wie GESTURE_INPUTS
   * @returns {Promise<{values: number[], inferenceMs: number}>} Wahrscheinlichkeit je Geste
   */
  async run(values) {
    const data = this.input.dtype === 'float32' ? Float32Array.from(values) : quantize(values, this.input);
    const tensor = new Tensor(data, [1, GESTURE_INPUTS.length]);
    const start = performance.now();
    let results;
    try {
      results = await this.compiled.run(tensor);
    } finally {
      tensor.delete();
    }
    const out = results.flatMap((t, i) => {
      const raw = Array.from(t.toTypedArray());
      t.delete();
      const { scale: s, zeroPoint: z } = this.outputs[i];
      return s ? raw.map((q) => (q - z) * s) : raw;
    });
    return { values: out, inferenceMs: performance.now() - start };
  }

  delete() {
    this.compiled.delete();
  }
}

/** Erwartet genau eine Eingabe [1, 8] (float32 oder quantisiert int8/uint8). */
function checkInput({ inputs }) {
  if (inputs.length !== 1) throw new Error(`Das Modell hat ${inputs.length} Eingaben, erwartet wird genau eine.`);
  const [{ shape, dtype, scale, zeroPoint }] = inputs;
  if (shape.length !== 2 || shape[0] !== 1 || shape[1] !== GESTURE_INPUTS.length) {
    throw new Error(
      `Eingabe [${shape}] passt nicht – erwartet wird [1, ${GESTURE_INPUTS.length}] (Aktuator-Stellungen). ` +
        'Bildmodelle gehören in den Bereich „ESP32-KI-Modell“.',
    );
  }
  if (!['float32', 'int8', 'uint8'].includes(dtype)) throw new Error(`Eingabetyp ${dtype} nicht unterstützt.`);
  return { dtype, scale, zeroPoint };
}

function quantize(values, { dtype, scale, zeroPoint }) {
  const [min, max, Arr] = dtype === 'int8' ? [-128, 127, Int8Array] : [0, 255, Uint8Array];
  return Arr.from(values, (v) => Math.min(max, Math.max(min, Math.round(v / (scale || 1)) + zeroPoint)));
}
