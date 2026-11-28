// KI-Modelle für den ESP32 im Browser testen: Lädt ein .tflite-Modell mit LiteRT.js und wertet Kamerabilder (aufgebaut
// wie camera_fb_t, siehe esp32Camera.js) so aus wie die Firmware in esp/esp32ai (main/esp32ai.cc): gleiche
// Vorverarbeitung, gleiche Quantisierung der Eingabe, gleiche Umrechnung der Ausgabe. Eingabegröße, Kanäle, Datentyp
// und Quantisierung werden aus dem Modell gelesen, sodass auch neue Modelle ohne Codeänderung laufen.
import { loadLiteRt, loadAndCompile, Tensor } from '@litertjs/core';
import { readTfliteInfo, withStaticShapes } from './tfliteInfo.js';
import { decodeFrame, luma } from './esp32Camera.js';
import firmwareModelUrl from '../../model/output/hand.tflite?url';

/** Modell der Firmware – dieselbe Datei, die create_model.py erzeugt und die in main/model.cc eingebettet ist. */
export const FIRMWARE_MODEL_URL = firmwareModelUrl;

/** Unterstützte Datentypen der Eingabe und ihr Wertebereich. */
const INPUT_TYPES = {
  int8: { array: Int8Array, min: -128, max: 127 },
  uint8: { array: Uint8Array, min: 0, max: 255 },
  float32: { array: Float32Array },
};

let liteRtPromise;

/** Lädt die WASM-Laufzeit von LiteRT.js genau einmal (bereitgestellt unter /litert/, siehe vite.config.js). */
function getLiteRt() {
  liteRtPromise ??= loadLiteRt(`${import.meta.env.BASE_URL}litert/`).catch((err) => {
    liteRtPromise = undefined; // beim nächsten Versuch erneut laden
    throw new Error(`LiteRT.js konnte nicht geladen werden: ${err?.message ?? err}`, { cause: err });
  });
  return liteRtPromise;
}

async function readBytes(source) {
  if (source instanceof Uint8Array) return source;
  if (source instanceof Blob) return new Uint8Array(await source.arrayBuffer());
  const res = await fetch(source);
  if (!res.ok) throw new Error(`Modell nicht gefunden: ${source} (HTTP ${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Ein geladenes Modell. Eigenschaften:
 *   name       Anzeigename
 *   size       Dateigröße in Byte
 *   input      { width, height, channels, dtype, scale, zeroPoint } der (einzigen) Eingabe, Layout NHWC [1, H, W, C]
 *   outputs    Ausgabetensoren { name, shape, dtype, scale, zeroPoint }
 *   operators  verwendete Operatoren, z. B. ['CONV_2D', …] – müssen in der Firmware im OpResolver registriert sein
 *   inputRange Wertebereich, auf den die Pixel 0…255 vor der Quantisierung abgebildet werden (siehe load)
 */
export class Esp32Model {
  /**
   * @param {string | URL | Blob | Uint8Array} source URL, Datei (z. B. aus <input type=file>) oder Inhalt der .tflite-Datei
   * @param {{name?: string, inputRange?: [number, number]}} [options]
   *   inputRange: Wertebereich der Eingabe beim Training. Standard [0, 255] wie create_model.py (Pixel unverändert);
   *   für Modelle, die mit 0…1 oder -1…1 trainiert wurden, entsprechend [0, 1] bzw. [-1, 1].
   */
  static async load(source, { name = String(source), inputRange = [-1, 1] } = {}) {
    const bytes = await readBytes(source);
    const info = readTfliteInfo(bytes);
    const input = checkInput(info);
    await getLiteRt();
    // 'wasm' = CPU (XNNPACK). Die Modelle sind für den ESP32 klein, die GPU brächte hier keinen Vorteil.
    const compiled = await loadAndCompile(withStaticShapes(bytes), { accelerator: 'wasm' });
    return new Esp32Model(compiled, { ...info, input, name, size: bytes.length, inputRange });
  }

  constructor(compiled, { input, outputs, operators, name, size, inputRange }) {
    Object.assign(this, { compiled, input, outputs, operators, name, size, inputRange });
  }

  /**
   * Wertet ein Kamerabild aus, aufgebaut wie camera_fb_t: { buf, width, height, format } (alle Formate der ESP32-CAM).
   * @returns {Promise<{values: number[], pixels: Uint8Array, preprocessMs: number, inferenceMs: number} | null>}
   *   values  alle Ausgaben, umgerechnet wie in der Firmware ((q - zero_point) * scale)
   *   pixels  das Bild, wie es das Modell bekommt (0…255, NHWC), z. B. zur Anzeige
   *   null, wenn das Kamerabild kleiner als die Modelleingabe ist (wie preprocess_frame() → false)
   */
  async run(frame) {
    // JPEG dekodiert der Browser asynchron; das zählt nicht zur gemessenen Vorverarbeitung.
    const rgba = frame.format === 'JPEG' ? await decodeJpeg(frame.buf, frame.width, frame.height) : undefined;
    const start = performance.now();
    const pixels = preprocessFrame(frame, this.input, rgba);
    if (!pixels) return null;
    const { width, height, channels } = this.input;
    const tensor = new Tensor(quantize(pixels, this.input, this.inputRange), [1, height, width, channels]);
    const prepared = performance.now();
    let results;
    try {
      results = await this.compiled.run(tensor);
    } finally {
      tensor.delete();
    }
    // Reihenfolge der Ausgaben wie im Modell (SubGraph.outputs); Tensoren müssen manuell freigegeben werden.
    const values = results.flatMap((t, i) => {
      const raw = Array.from(t.toTypedArray());
      t.delete();
      return dequantize(raw, this.outputs[i]);
    });
    return { values, pixels, preprocessMs: prepared - start, inferenceMs: performance.now() - prepared };
  }

  /** Gibt das Modell in LiteRT.js frei. */
  delete() {
    this.compiled.delete();
  }
}

/** Prüft, ob die Eingabe unterstützt wird: genau ein Bild [1, H, W, 1 oder 3] als int8, uint8 oder float32. */
function checkInput({ inputs, outputs }) {
  if (inputs.length !== 1) throw new Error(`Das Modell hat ${inputs.length} Eingaben, unterstützt wird genau eine.`);
  const [{ shape, dtype, scale, zeroPoint }] = inputs;
  const [batch, height, width, channels] = shape;
  if (shape.length !== 4 || batch !== 1 || ![1, 3].includes(channels)) {
    throw new Error(`Eingabe [${shape}] nicht unterstützt – erwartet wird ein Bild [1, Höhe, Breite, 1 oder 3] (NHWC).`);
  }
  if (!INPUT_TYPES[dtype]) throw new Error(`Eingabetyp ${dtype} nicht unterstützt – möglich: int8, uint8, float32.`);
  const badOutput = outputs.find((o) => !INPUT_TYPES[o.dtype]);
  if (badOutput) throw new Error(`Ausgabetyp ${badOutput.dtype} nicht unterstützt – möglich: int8, uint8, float32.`);
  return { width, height, channels, dtype, scale, zeroPoint };
}

// ---------------------------------------------------------------------------
// Vorverarbeitung wie in der Firmware
// ---------------------------------------------------------------------------

/**
 * Wie preprocess_frame() in esp32ai.cc, verallgemeinert auf die Eingabe des Modells: das Kamerabild mittig auf das
 * Seitenverhältnis der Eingabe zuschneiden und je Zielpixel den Mittelwert der Quellpixel bilden (ganzzahlig
 * abgerundet wie in C). Graustufen-Modelle bekommen die Helligkeit Y, Farbmodelle R, G, B.
 * @param {Uint8ClampedArray} [rgba] bei JPEG das dekodierte Bild (RGBA, siehe decodeJpeg)
 * @returns {Uint8Array | null} Pixel zeilenweise, je Pixel `channels` Werte 0…255; null, wenn zu klein
 */
export function preprocessFrame(frame, { width, height, channels }, rgba) {
  let cropWidth = frame.width;
  let cropHeight = frame.height;
  if (cropWidth * height > cropHeight * width) cropWidth = Math.floor((cropHeight * width) / height);
  else cropHeight = Math.floor((cropWidth * height) / width);
  if (cropWidth < width || cropHeight < height) return null; // die Firmware vergrößert nicht

  const src = framePixels(frame, channels, rgba);
  const cropX = Math.floor((frame.width - cropWidth) / 2);
  const cropY = Math.floor((frame.height - cropHeight) / 2);
  const out = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y++) {
    const y0 = cropY + Math.floor((y * cropHeight) / height);
    const y1 = cropY + Math.floor(((y + 1) * cropHeight) / height);
    for (let x = 0; x < width; x++) {
      const x0 = cropX + Math.floor((x * cropWidth) / width);
      const x1 = cropX + Math.floor(((x + 1) * cropWidth) / width);
      for (let c = 0; c < channels; c++) {
        let sum = 0;
        for (let sy = y0; sy < y1; sy++) {
          for (let sx = x0; sx < x1; sx++) sum += src[(sy * frame.width + sx) * channels + c];
        }
        out[(y * width + x) * channels + c] = Math.floor(sum / ((y1 - y0) * (x1 - x0)));
      }
    }
  }
  return out;
}

/** Bildpuffer (fb->buf) in Pixel mit 1 (Helligkeit Y) oder 3 Kanälen (R, G, B) umwandeln. */
function framePixels({ buf, width, height, format }, channels, rgba) {
  if (format === 'GRAYSCALE' && channels === 1) return buf; // wie die Firmware: fb->buf direkt
  if (format === 'JPEG' && !rgba) throw new Error('JPEG-Bilder zuerst mit decodeJpeg() dekodieren.');
  rgba ??= decodeFrame(buf, width, height, format);
  const n = width * height;
  const out = new Uint8ClampedArray(n * channels); // rundet und begrenzt auf 0…255
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    if (channels === 1) out[i] = luma(rgba[p], rgba[p + 1], rgba[p + 2]);
    else out.set(rgba.subarray(p, p + 3), 3 * i);
  }
  return out;
}

/** JPEG-Bild zu RGBA dekodieren (auf dem ESP32 übernähme das z. B. fmt2rgb888()). */
export async function decodeJpeg(buf, width, height) {
  const bitmap = await createImageBitmap(new Blob([buf], { type: 'image/jpeg' }));
  const ctx = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, width, height).data;
}

/**
 * Pixel 0…255 in den Eingabetensor: zuerst auf inputRange abbilden (Wert r), dann quantisieren wie TFLite:
 * q = round(r / scale) + zero_point. Beim Firmware-Modell (scale 1, zero_point -128) ergibt das wie in esp32ai.cc
 * genau „Pixel - 128“.
 */
function quantize(pixels, { dtype, scale, zeroPoint }, [lo, hi]) {
  const { array, min, max } = INPUT_TYPES[dtype];
  const data = new array(pixels.length);
  const step = (hi - lo) / 255;
  for (let i = 0; i < pixels.length; i++) {
    const r = lo + pixels[i] * step;
    data[i] = dtype === 'float32' ? r : Math.min(max, Math.max(min, Math.round(r / (scale || 1)) + zeroPoint));
  }
  return data;
}

/** Ausgabe wie in der Firmware umrechnen: (q - zero_point) * scale; nicht quantisierte Werte bleiben unverändert. */
function dequantize(raw, { scale, zeroPoint }) {
  return scale ? raw.map((q) => (q - zeroPoint) * scale) : raw;
}
