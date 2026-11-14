// Kamera-Anbindung und Hand-Erkennung mit dem MediaPipe Hand Landmarker.
// Läuft komplett im Browser (WASM + WebGL), das Kamerabild verlässt den Rechner nicht.
import { HandLandmarker } from '@mediapipe/tasks-vision';
// WASM-Laufzeit direkt aus dem npm-Paket: Vite liefert die Dateien aus bzw. kopiert sie beim Build (wie bei MuJoCo).
import wasmLoaderPath from '@mediapipe/tasks-vision/vision_wasm_internal.js?url';
import wasmBinaryPath from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url';

/** Offizielles Modell „hand_landmarker“ (float16, Version 1), lokal abgelegt, damit es auch offline funktioniert. */
const MODEL_URL = `${import.meta.env.BASE_URL}mediapipe/hand_landmarker.task`;

/** Frontkamera mit 640×480: reicht für das Modell (rechnet intern mit 224×224) und hält die Latenz gering. */
const CAMERA_CONSTRAINTS = {
  audio: false,
  video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
};

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
 * Startet/stoppt die Kamera und wertet jedes neue Kamerabild aus.
 *
 * `onResult(hand)` wird pro Kamerabild aufgerufen – mit `null`, wenn keine Hand im Bild ist, sonst mit:
 *   landmarks       21 × {x, y, z}: x, y normiert auf das (ungespiegelte) Kamerabild (0…1),
 *                   z = Tiefe relativ zum Handgelenk (kleiner = näher an der Kamera, etwa im Maßstab von x)
 *   worldLandmarks  21 × {x, y, z}: metrische 3D-Koordinaten in m, Ursprung etwa in der Handmitte
 *   handedness      'Left' | 'Right': linke bzw. rechte Hand der Person
 *   score           Sicherheit der Links/Rechts-Zuordnung (0…1)
 *
 * `onError(err)` meldet einen unerwarteten Abbruch (z. B. Kamera getrennt); das Tracking ist dann bereits gestoppt.
 */
export class HandTracker {
  constructor(video, { onResult, onError } = {}) {
    this.video = video;
    this.onResult = onResult;
    this.onError = onError;
    this.stream = null;
    this.landmarker = null;
    this.delegate = null; // 'GPU' | 'CPU'
    this.fps = 0; // ausgewertete Kamerabilder pro Sekunde
    this.frameRequest = 0;
    this.lastVideoTime = -1;
    this.lastTimestamp = 0;
    this.lastFrameAt = 0;
    // requestVideoFrameCallback meldet sich genau einmal pro neuem Kamerabild. video.currentTime taugt dafür
    // nicht: Es steigt bei Kamera-Streams kontinuierlich, sodass dasselbe Bild mehrfach ausgewertet würde.
    this.perVideoFrame = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  }

  get running() {
    return this.stream !== null;
  }

  async start() {
    if (this.running) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Kein Kamerazugriff möglich – die Seite muss über http://localhost oder HTTPS geöffnet werden.');
    }
    const stream = await navigator.mediaDevices.getUserMedia(CAMERA_CONSTRAINTS).catch((err) => {
      throw new Error(cameraErrorMessage(err), { cause: err });
    });
    try {
      this.video.srcObject = stream;
      await this.video.play();
      ({ landmarker: this.landmarker, delegate: this.delegate } = await getLandmarker());
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      this.video.srcObject = null;
      throw err;
    }
    this.stream = stream;
    // Wird z. B. ausgelöst, wenn die Kamera abgesteckt oder vom System entzogen wird (nicht bei stop()).
    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (this.stream === stream) this.fail(new Error('Die Verbindung zur Kamera wurde getrennt.'));
    });
    this.fps = 0;
    this.lastVideoTime = -1;
    this.lastFrameAt = performance.now();
    this.scheduleFrame();
  }

  stop() {
    if (this.perVideoFrame) this.video.cancelVideoFrameCallback(this.frameRequest);
    else cancelAnimationFrame(this.frameRequest);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  fail(err) {
    this.stop();
    this.onError?.(err);
  }

  scheduleFrame() {
    this.frameRequest = this.perVideoFrame
      ? this.video.requestVideoFrameCallback(this.tick)
      : requestAnimationFrame(this.tick);
  }

  tick = () => {
    if (!this.running) return;
    this.scheduleFrame();
    const { video } = this;
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    // Fallback ohne requestVideoFrameCallback: unveränderte Bilder zumindest grob überspringen.
    if (!this.perVideoFrame) {
      if (video.currentTime === this.lastVideoTime) return;
      this.lastVideoTime = video.currentTime;
    }

    const now = performance.now();
    this.lastTimestamp = Math.max(now, this.lastTimestamp + 1); // MediaPipe verlangt streng steigende Zeitstempel
    let result;
    try {
      result = this.landmarker.detectForVideo(video, this.lastTimestamp);
    } catch (err) {
      this.fail(new Error(`Hand-Erkennung fehlgeschlagen: ${err?.message ?? err}`, { cause: err }));
      return;
    }
    this.fps = 0.9 * this.fps + 0.1 * (1000 / Math.max(1, now - this.lastFrameAt));
    this.lastFrameAt = now;
    this.onResult?.(toHand(result));
  };
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

function cameraErrorMessage(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Kamerazugriff verweigert – in den Website-Einstellungen des Browsers erlauben und erneut versuchen.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'Keine Kamera gefunden.';
    case 'NotReadableError':
    case 'AbortError':
      return 'Kamera ist belegt oder nicht verfügbar (z. B. durch eine andere Anwendung wie Teams oder Zoom).';
    default:
      return `Kamera konnte nicht gestartet werden: ${err?.message ?? err}`;
  }
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
 * Zeichnet Hand-Skelett und Landmarken auf eine Canvas, die deckungsgleich über dem Video liegt
 * (Spiegelung übernimmt CSS für Video und Canvas gemeinsam). `hand = null` leert die Canvas.
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
