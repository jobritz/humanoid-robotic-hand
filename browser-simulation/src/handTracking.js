// Hand-Erkennung mit dem MediaPipe Hand Landmarker auf den Bildern der (nachgebildeten) ESP32-Kamera.
// Läuft komplett im Browser (WASM + WebGL), das Kamerabild verlässt den Rechner nicht.
import { HandLandmarker } from '@mediapipe/tasks-vision';
// WASM-Laufzeit direkt aus dem npm-Paket: Vite liefert die Dateien aus bzw. kopiert sie beim Build (wie bei MuJoCo).
import wasmLoaderPath from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import wasmBinaryPath from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';

/** Offizielles Modell „hand_landmarker“ (float16, Version 1), lokal abgelegt, damit es auch offline funktioniert. */
const MODEL_URL = `${import.meta.env.BASE_URL}mediapipe/hand_landmarker.task`;

let landmarkerPromise;

/** Lädt WASM-Laufzeit und Modell genau einmal – bevorzugt GPU-beschleunigt, sonst auf der CPU. */
function getLandmarker() {
  landmarkerPromise ??= createLandmarker().catch((err) => {
    landmarkerPromise = undefined; // beim nächsten Start erneut versuchen
    throw new Error(`Handmodell konnte nicht geladen werden: ${err?.message ?? err}`, { cause: err });
  });
  return landmarkerPromise;
}

async function createLandmarker() {
  const create = (delegate) =>
    HandLandmarker.createFromOptions(
      { wasmLoaderPath, wasmBinaryPath },
      { baseOptions: { modelAssetPath: MODEL_URL, delegate }, runningMode: 'VIDEO', numHands: 1 },
    );
  try {
    return { landmarker: await create('GPU'), delegate: 'GPU' };
  } catch (err) {
    console.warn('Hand-Tracking: GPU-Beschleunigung nicht verfügbar, verwende die CPU.', err);
    return { landmarker: await create('CPU'), delegate: 'CPU' };
  }
}

/**
 * Erkennt eine Hand in aufeinanderfolgenden Kamerabildern (MediaPipe im Video-Modus).
 *
 * `detect(image, timestamp)` liefert `null`, wenn keine Hand im Bild ist, sonst:
 *   landmarks       21 × {x, y, z}: x, y normiert auf das (ungespiegelte) Kamerabild (0…1),
 *                   z = Tiefe relativ zum Handgelenk (kleiner = näher an der Kamera, etwa im Maßstab von x)
 *   worldLandmarks  21 × {x, y, z}: metrische 3D-Koordinaten in m, Ursprung etwa in der Handmitte
 *   handedness      'Left' | 'Right': linke bzw. rechte Hand der Person
 *   score           Sicherheit der Links/Rechts-Zuordnung (0…1)
 */
export class HandTracker {
  constructor() {
    this.landmarker = null;
    this.delegate = null; // 'GPU' | 'CPU'
    this.lastTimestamp = 0;
  }

  get ready() {
    return this.landmarker !== null;
  }

  /** Lädt WASM-Laufzeit und Modell (nur beim ersten Mal, danach sofort fertig). */
  async load() {
    ({ landmarker: this.landmarker, delegate: this.delegate } = await getLandmarker());
  }

  /** @param {TexImageSource} image z. B. die Canvas mit dem Kamerabild */
  detect(image, timestamp) {
    this.lastTimestamp = Math.max(timestamp, this.lastTimestamp + 1); // MediaPipe verlangt streng steigende Zeitstempel
    try {
      return toHand(this.landmarker.detectForVideo(image, this.lastTimestamp));
    } catch (err) {
      throw new Error(`Hand-Erkennung fehlgeschlagen: ${err?.message ?? err}`, { cause: err });
    }
  }
}

function toHand(result) {
  if (!result.landmarks.length) return null;
  const [{ categoryName, score }] = result.handedness[0];
  return {
    landmarks: result.landmarks[0],
    worldLandmarks: result.worldLandmarks[0],
    handedness: categoryName,
    score,
  };
}

// ---------------------------------------------------------------------------
// Darstellung über der Videovorschau
// ---------------------------------------------------------------------------

/** MediaPipe-Landmarken je Finger (0 = Handgelenk; je Finger 4 Punkte von der Wurzel zur Spitze). */
const FINGERS = [
  { chain: [0, 1, 2, 3, 4], color: '#ff9f43' }, // Daumen
  { chain: [5, 6, 7, 8], color: '#54a0ff' }, // Zeigefinger
  { chain: [9, 10, 11, 12], color: '#1dd1a1' }, // Mittelfinger
  { chain: [13, 14, 15, 16], color: '#feca57' }, // Ringfinger
  { chain: [17, 18, 19, 20], color: '#c56cf0' }, // kleiner Finger
];
const PALM = [0, 5, 9, 13, 17, 0];

/**
 * Zeichnet Hand-Skelett und Landmarken auf eine Canvas, die deckungsgleich über dem Kamerabild liegt
 * (Spiegelung übernimmt CSS für beide gemeinsam). `hand = null` leert die Canvas.
 */
export function drawHand(canvas, hand) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) Object.assign(canvas, { width: w, height: h });
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  if (!hand) return;

  const pts = hand.landmarks.map((p) => [p.x * w, p.y * h]);
  const polyline = (ids, color) => {
    ctx.beginPath();
    ids.forEach((i, k) => (k ? ctx.lineTo(...pts[i]) : ctx.moveTo(...pts[i])));
    ctx.strokeStyle = color;
    ctx.stroke();
  };
  const dot = (i, color) => {
    ctx.beginPath();
    ctx.arc(...pts[i], 3 * dpr, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
  };

  ctx.lineWidth = 2 * dpr;
  ctx.lineCap = ctx.lineJoin = 'round';
  polyline(PALM, 'rgb(255 255 255 / 0.75)');
  for (const { chain, color } of FINGERS) polyline(chain, color);
  for (const { chain, color } of FINGERS) chain.filter((i) => i > 0).forEach((i) => dot(i, color));
  dot(0, '#fff');
}
