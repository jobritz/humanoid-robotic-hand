// Nachbildung der ESP32-CAM (AI-Thinker, Sensor OV2640) mit der Webcam des Rechners.
// Einstellbar ist dasselbe wie in camera_config_t der Firmware: nur die Auflösungen (frame_size) und Farbcodierungen
// (pixel_format) des Treibers espressif/esp32-camera sowie die JPEG-Qualität. Jedes Webcam-Bild wird wie vom Sensor
// zugeschnitten, skaliert und codiert, sodass `frame.buf` genauso aufgebaut ist wie `fb->buf` nach esp_camera_fb_get().

/**
 * Auflösungen der OV2640 in der Reihenfolge von framesize_t (esp32-camera 2.1.8, bis zum Sensormaximum UXGA).
 * `aspect` ist das Seitenverhältnis des Sensorfensters (resolution[] und ratio_table im Treiber): Der Sensor schneidet
 * sein 4:3-Bild mittig auf dieses Verhältnis zu und skaliert es dann auf width × height. Bei QCIF, HQVGA und CIF passt
 * das nicht ganz, das Bild wird dort – wie auf dem ESP32 – um bis zu 2,3 % verzerrt.
 */
export const FRAME_SIZES = [
  { name: '96X96', width: 96, height: 96, aspect: 1 },
  { name: 'QQVGA', width: 160, height: 120, aspect: 4 / 3 },
  { name: '128X128', width: 128, height: 128, aspect: 1 },
  { name: 'QCIF', width: 176, height: 144, aspect: 5 / 4 },
  { name: 'HQVGA', width: 240, height: 176, aspect: 4 / 3 },
  { name: '240X240', width: 240, height: 240, aspect: 1 },
  { name: 'QVGA', width: 320, height: 240, aspect: 4 / 3 },
  { name: '320X320', width: 320, height: 320, aspect: 1 },
  { name: 'CIF', width: 400, height: 296, aspect: 4 / 3 },
  { name: 'HVGA', width: 480, height: 320, aspect: 3 / 2 },
  { name: 'VGA', width: 640, height: 480, aspect: 4 / 3 },
  { name: 'SVGA', width: 800, height: 600, aspect: 4 / 3 },
  { name: 'XGA', width: 1024, height: 768, aspect: 4 / 3 },
  { name: 'HD', width: 1280, height: 720, aspect: 16 / 9 },
  { name: 'SXGA', width: 1280, height: 1024, aspect: 5 / 4 },
  { name: 'UXGA', width: 1600, height: 1200, aspect: 4 / 3 },
];

/**
 * Farbcodierungen, die der Treiber auf dem ESP32 mit der OV2640 annimmt (andere wie RGB888 oder YUV420 lehnt er dort
 * ab). `bytesPerPixel` ist die Größe von fb->buf je Pixel, 0 bei JPEG (abhängig vom Bildinhalt).
 */
export const PIXEL_FORMATS = [
  { name: 'RGB565', bytesPerPixel: 2, description: 'Farbe, 16 Bit' },
  { name: 'YUV422', bytesPerPixel: 2, description: 'Farbe (YUYV), 16 Bit' },
  { name: 'GRAYSCALE', bytesPerPixel: 1, description: 'Graustufen, 8 Bit' },
  { name: 'JPEG', bytesPerPixel: 0, description: 'komprimiert' },
];

/** Standard wie die Firmware in esp/esp32cam (main.c): QVGA, JPEG, Qualität 12. */
export const DEFAULT_CAMERA_CONFIG = Object.freeze({ frameSize: 'QVGA', pixelFormat: 'JPEG', jpegQuality: 12 });

const FRAME_SIZE = new Map(FRAME_SIZES.map((s) => [s.name, s]));
const PIXEL_FORMAT = new Map(PIXEL_FORMATS.map((f) => [f.name, f]));

/** Auflösung nach Name, z. B. getFrameSize('QVGA') → { name, width, height, aspect }. */
export function getFrameSize(name) {
  return FRAME_SIZE.get(name);
}

/**
 * Prüft eine (Teil-)Einstellung und ergänzt fehlende Werte aus `base`. Namen wie im Treiber, mit oder ohne Präfix:
 * 'QVGA' oder 'FRAMESIZE_QVGA', 'JPEG' oder 'PIXFORMAT_JPEG'. jpegQuality wird wie im Treiber auf 0…63 begrenzt.
 * @returns {{frameSize: string, pixelFormat: string, jpegQuality: number}}
 */
export function normalizeCameraConfig(changes = {}, base = DEFAULT_CAMERA_CONFIG) {
  const { frameSize = base.frameSize, pixelFormat = base.pixelFormat, jpegQuality = base.jpegQuality } = changes;
  const size = String(frameSize).toUpperCase().replace(/^FRAMESIZE_/, '');
  if (!FRAME_SIZE.has(size)) {
    throw new Error(`Unbekannte Auflösung "${frameSize}" – möglich: ${[...FRAME_SIZE.keys()].join(', ')}`);
  }
  const format = String(pixelFormat).toUpperCase().replace(/^PIXFORMAT_/, '');
  if (!PIXEL_FORMAT.has(format)) {
    throw new Error(`Unbekannte Farbcodierung "${pixelFormat}" – möglich: ${[...PIXEL_FORMAT.keys()].join(', ')}`);
  }
  const quality = Number(jpegQuality);
  if (jpegQuality === null || jpegQuality === '' || !Number.isFinite(quality)) {
    throw new Error(`Ungültige JPEG-Qualität "${jpegQuality}" – erwartet wird eine Zahl von 0 bis 63`);
  }
  return { frameSize: size, pixelFormat: format, jpegQuality: Math.min(63, Math.max(0, Math.round(quality))) };
}

/** Größe von fb->buf in Byte bei Rohformaten, `null` bei JPEG (abhängig vom Bildinhalt). */
export function frameBufferSize({ frameSize, pixelFormat }) {
  const { width, height } = FRAME_SIZE.get(frameSize);
  const bytesPerPixel = PIXEL_FORMAT.get(pixelFormat).bytesPerPixel;
  return bytesPerPixel ? width * height * bytesPerPixel : null;
}

// ---------------------------------------------------------------------------
// Bildausschnitt wie beim Sensor
// ---------------------------------------------------------------------------

/** Größtes mittiges Rechteck mit dem Seitenverhältnis `aspect` (Breite/Höhe) in einem Rechteck. */
function centerCrop({ x, y, width, height }, aspect) {
  const w = Math.min(width, height * aspect);
  const h = w / aspect;
  return { x: x + (width - w) / 2, y: y + (height - h) / 2, width: w, height: h };
}

/**
 * Ausschnitt des Webcam-Bildes (in Pixeln), den der ESP32 bei dieser Auflösung zeigen würde: Das Webcam-Bild steht
 * für den 4:3-Sensor der OV2640, daraus wird mittig das Sensorfenster der Auflösung ausgeschnitten. So haben z. B. QVGA
 * und HD denselben horizontalen Bildwinkel, HD zeigt aber oben und unten weniger.
 */
export function sensorWindow(videoWidth, videoHeight, frameSize) {
  const sensor = centerCrop({ x: 0, y: 0, width: videoWidth, height: videoHeight }, 4 / 3);
  return centerCrop(sensor, frameSize.aspect);
}

/** Anzufordernde Webcam-Auflösung (4:3): mindestens 640×480, sonst so groß, dass das Sensorfenster nicht hochskaliert wird. */
export function webcamResolution(frameSize) {
  const crop = sensorWindow(1, 0.75, frameSize); // Sensorfenster in Einheiten der Sensorbreite
  const width = Math.max(640, Math.ceil(Math.max(frameSize.width / crop.width, frameSize.height / crop.height)));
  return { width, height: Math.round((width * 3) / 4) };
}

// ---------------------------------------------------------------------------
// Farbcodierungen
// ---------------------------------------------------------------------------

// YUV nach BT.601 im vollen Wertebereich 0…255 (wie JPEG/JFIF und die Graustufen-Umrechnung gängiger ML-Bibliotheken).
export const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const chromaU = (r, g, b) => 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
const chromaV = (r, g, b) => 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;

/**
 * Codiert RGBA-Pixel (z. B. ImageData.data) so, wie sie auf dem ESP32 in fb->buf stehen:
 *   RGB565     2 Byte/Pixel, höherwertiges Byte zuerst: RRRRRGGG GGGBBBBB
 *   YUV422     2 Byte/Pixel als Y0 U Y1 V (YUYV): je zwei nebeneinanderliegende Pixel teilen sich U und V
 *   GRAYSCALE  1 Byte/Pixel: Helligkeit Y
 * Die Breite muss gerade sein (bei allen Auflösungen der OV2640 der Fall).
 * @returns {Uint8Array}
 */
export function encodeFrame(rgba, width, height, pixelFormat) {
  const n = width * height;
  // Über die Clamped-Ansicht wird gerundet und auf 0…255 begrenzt.
  const out = new Uint8ClampedArray(n * PIXEL_FORMAT.get(pixelFormat).bytesPerPixel);
  switch (pixelFormat) {
    case 'RGB565':
      for (let i = 0, p = 0; i < n; i++, p += 4) {
        const r = rgba[p] >> 3;
        const g = rgba[p + 1] >> 2;
        const b = rgba[p + 2] >> 3;
        out[2 * i] = (r << 3) | (g >> 3);
        out[2 * i + 1] = ((g & 7) << 5) | b;
      }
      break;
    case 'YUV422':
      for (let i = 0, p = 0; i < n; i += 2, p += 8) {
        // U und V aus dem Mittelwert beider Pixel
        const r = (rgba[p] + rgba[p + 4]) / 2;
        const g = (rgba[p + 1] + rgba[p + 5]) / 2;
        const b = (rgba[p + 2] + rgba[p + 6]) / 2;
        out[2 * i] = luma(rgba[p], rgba[p + 1], rgba[p + 2]);
        out[2 * i + 1] = chromaU(r, g, b);
        out[2 * i + 2] = luma(rgba[p + 4], rgba[p + 5], rgba[p + 6]);
        out[2 * i + 3] = chromaV(r, g, b);
      }
      break;
    case 'GRAYSCALE':
      for (let i = 0, p = 0; i < n; i++, p += 4) out[i] = luma(rgba[p], rgba[p + 1], rgba[p + 2]);
      break;
    default:
      throw new Error(`${pixelFormat} ist kein Rohformat`);
  }
  return new Uint8Array(out.buffer);
}

/**
 * Wandelt fb->buf eines Rohformats zurück in RGBA-Pixel, z. B. zur Anzeige.
 * @param {Uint8ClampedArray} [rgba] Ziel (4 Byte je Pixel), z. B. ImageData.data
 */
export function decodeFrame(buf, width, height, pixelFormat, rgba = new Uint8ClampedArray(4 * width * height)) {
  const n = width * height;
  switch (pixelFormat) {
    case 'RGB565':
      for (let i = 0, p = 0; i < n; i++, p += 4) {
        const hi = buf[2 * i];
        const lo = buf[2 * i + 1];
        const r = hi >> 3;
        const g = ((hi & 7) << 3) | (lo >> 5);
        const b = lo & 31;
        rgba[p] = (r << 3) | (r >> 2);
        rgba[p + 1] = (g << 2) | (g >> 4);
        rgba[p + 2] = (b << 3) | (b >> 2);
        rgba[p + 3] = 255;
      }
      break;
    case 'YUV422':
      for (let i = 0, p = 0; i < n; i += 2, p += 8) {
        const u = buf[2 * i + 1] - 128;
        const v = buf[2 * i + 3] - 128;
        const dr = 1.402 * v;
        const dg = -0.344136 * u - 0.714136 * v;
        const db = 1.772 * u;
        const y0 = buf[2 * i];
        const y1 = buf[2 * i + 2];
        rgba[p] = y0 + dr;
        rgba[p + 1] = y0 + dg;
        rgba[p + 2] = y0 + db;
        rgba[p + 3] = 255;
        rgba[p + 4] = y1 + dr;
        rgba[p + 5] = y1 + dg;
        rgba[p + 6] = y1 + db;
        rgba[p + 7] = 255;
      }
      break;
    case 'GRAYSCALE':
      for (let i = 0, p = 0; i < n; i++, p += 4) {
        rgba[p] = rgba[p + 1] = rgba[p + 2] = buf[i];
        rgba[p + 3] = 255;
      }
      break;
    default:
      throw new Error(`${pixelFormat} ist kein Rohformat`);
  }
  return rgba;
}

/**
 * Übersetzt jpeg_quality (0…63, kleiner = besser) in die JPEG-Qualität des Browsers (0…1).
 * Bei der OV2640 landet jpeg_quality im Register QS, das die Quantisierungstabellen skaliert. Näherung, nicht am Sensor
 * kalibriert: Die Skalierung wächst linear mit QS, und QS = 10 entspricht etwa der libjpeg-Qualität 50 (12 ≈ 42, 63 ≈ 8).
 */
export function browserJpegQuality(jpegQuality) {
  const scale = 10 * jpegQuality; // Skalierung der Tabellen in % (libjpeg: 100 % bei Qualität 50)
  const libjpegQuality = scale <= 100 ? (200 - scale) / 2 : 5000 / scale;
  return libjpegQuality / 100;
}

// ---------------------------------------------------------------------------
// Kamera
// ---------------------------------------------------------------------------

/**
 * Webcam als ESP32-Kamera: Startet/stoppt die Webcam und erzeugt aus jedem neuen Webcam-Bild ein Kamerabild mit der
 * eingestellten Auflösung und Farbcodierung. Das Bild wird auf `canvas` angezeigt – zurückgerechnet aus den Bytes, also
 * genau das, was im Puffer steht (Graustufen, Farbstufen von RGB565, JPEG-Artefakte …).
 *
 * `onFrame(frame)` wird pro Kamerabild aufgerufen, `frame` ist aufgebaut wie camera_fb_t:
 *   buf        Uint8Array mit den Bilddaten wie fb->buf (Aufbau siehe encodeFrame, bei JPEG die JPEG-Datei)
 *   len        Länge von buf in Byte
 *   width      Breite in Pixeln
 *   height     Höhe in Pixeln
 *   format     Farbcodierung ('RGB565' | 'YUV422' | 'GRAYSCALE' | 'JPEG')
 *   timestamp  Aufnahmezeitpunkt (performance.now(), ms)
 * Wirft `onFrame` einen Fehler, wird die Kamera gestoppt und `onError(err)` aufgerufen – ebenso bei einem unerwarteten
 * Abbruch (z. B. Kamera getrennt).
 */
export class Esp32Camera {
  constructor(video, canvas, { onFrame, onError } = {}) {
    this.video = video;
    this.canvas = canvas;
    this.context = canvas.getContext('2d');
    this.onFrame = onFrame;
    this.onError = onError;
    this.config = { ...DEFAULT_CAMERA_CONFIG };
    this.stream = null;
    this.frame = null; // letztes Kamerabild
    this.webcam = null; // { width, height, upscaled }: tatsächliche Webcam-Auflösung, upscaled = Bild wird vergrößert
    this.fps = 0; // erzeugte Kamerabilder pro Sekunde
    this.busy = false;
    this.frameRequest = 0;
    this.lastVideoTime = -1;
    this.lastFrameAt = 0;
    // Arbeitsfläche für Zuschnitt, Skalierung und Codierung (wird bei jedem Bild ausgelesen).
    this.scratch = new OffscreenCanvas(1, 1);
    this.scratchContext = this.scratch.getContext('2d', { willReadFrequently: true });
    // requestVideoFrameCallback meldet sich genau einmal pro neuem Kamerabild. video.currentTime taugt dafür
    // nicht: Es steigt bei Kamera-Streams kontinuierlich, sodass dasselbe Bild mehrfach ausgewertet würde.
    this.perVideoFrame = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  }

  get running() {
    return this.stream !== null;
  }

  /** Ändert die Einstellung (Teilangaben möglich, siehe normalizeCameraConfig); gilt ab dem nächsten Bild. */
  setConfig(changes) {
    const previous = this.config;
    this.config = normalizeCameraConfig(changes, previous);
    if (this.running && this.config.frameSize !== previous.frameSize) {
      // Passende Webcam-Auflösung anfordern; klappt das nicht, wird das vorhandene Bild skaliert.
      this.stream
        .getVideoTracks()[0]
        ?.applyConstraints(webcamConstraints(this.config))
        .catch((err) => console.warn('Webcam-Auflösung konnte nicht angepasst werden.', err));
    }
    return this.config;
  }

  async start() {
    if (this.running) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Kein Kamerazugriff möglich – die Seite muss über http://localhost oder HTTPS geöffnet werden.');
    }
    const stream = await navigator.mediaDevices
      .getUserMedia({ audio: false, video: webcamConstraints(this.config) })
      .catch((err) => {
        throw new Error(cameraErrorMessage(err), { cause: err });
      });
    try {
      this.video.srcObject = stream;
      await this.video.play();
    } catch (err) {
      stream.getTracks().forEach((t) => t.stop());
      this.video.srcObject = null;
      throw new Error(`Kamera konnte nicht gestartet werden: ${err?.message ?? err}`, { cause: err });
    }
    this.stream = stream;
    // Wird z. B. ausgelöst, wenn die Kamera abgesteckt oder vom System entzogen wird (nicht bei stop()).
    stream.getVideoTracks()[0]?.addEventListener('ended', () => {
      if (this.stream === stream) this.fail(new Error('Die Verbindung zur Kamera wurde getrennt.'));
    });
    // Vorschau schon vor dem ersten Bild im richtigen Seitenverhältnis.
    const { width, height } = FRAME_SIZE.get(this.config.frameSize);
    Object.assign(this.canvas, { width, height });
    this.fps = 0;
    this.busy = false;
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
    this.frame = null;
    this.webcam = null;
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
    // Wie CAMERA_GRAB_LATEST: Solange ein Bild verarbeitet wird, verfallen neue Webcam-Bilder.
    if (this.busy || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) return;
    // Fallback ohne requestVideoFrameCallback: unveränderte Bilder zumindest grob überspringen.
    if (!this.perVideoFrame) {
      if (video.currentTime === this.lastVideoTime) return;
      this.lastVideoTime = video.currentTime;
    }
    this.busy = true;
    this.process().finally(() => {
      this.busy = false;
    });
  };

  async process() {
    const { stream } = this;
    let result;
    try {
      result = await this.capture();
    } catch (err) {
      if (this.stream === stream) this.fail(new Error(`Kamerabild konnte nicht erzeugt werden: ${err?.message ?? err}`, { cause: err }));
      return;
    }
    const { frame, image } = result;
    if (this.stream !== stream) {
      image.close?.(); // inzwischen gestoppt
      return;
    }
    if (this.canvas.width !== frame.width || this.canvas.height !== frame.height) {
      Object.assign(this.canvas, { width: frame.width, height: frame.height });
    }
    if (image instanceof ImageData) {
      this.context.putImageData(image, 0, 0);
    } else {
      this.context.drawImage(image, 0, 0);
      image.close();
    }
    const now = performance.now();
    this.fps = 0.9 * this.fps + 0.1 * (1000 / Math.max(1, now - this.lastFrameAt));
    this.lastFrameAt = now;
    this.frame = frame;
    try {
      this.onFrame?.(frame);
    } catch (err) {
      this.fail(err);
    }
  }

  /** Erzeugt aus dem aktuellen Webcam-Bild ein Kamerabild wie auf dem ESP32 und das Bild zur Anzeige. */
  async capture() {
    const { video, config } = this;
    const size = FRAME_SIZE.get(config.frameSize);
    const { width, height } = size;
    const crop = sensorWindow(video.videoWidth, video.videoHeight, size);
    this.webcam = {
      width: video.videoWidth,
      height: video.videoHeight,
      upscaled: crop.width < width || crop.height < height,
    };

    const { scratch } = this;
    if (scratch.width !== width || scratch.height !== height) Object.assign(scratch, { width, height });
    const ctx = this.scratchContext;
    ctx.imageSmoothingQuality = 'high'; // nach jeder Größenänderung zurückgesetzt
    ctx.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
    const timestamp = performance.now();
    const makeFrame = (buf) => ({ buf, len: buf.length, width, height, format: config.pixelFormat, timestamp });

    if (config.pixelFormat === 'JPEG') {
      const blob = await scratch.convertToBlob({ type: 'image/jpeg', quality: browserJpegQuality(config.jpegQuality) });
      const [bytes, image] = await Promise.all([blob.arrayBuffer(), createImageBitmap(blob)]);
      return { frame: makeFrame(new Uint8Array(bytes)), image };
    }
    const image = ctx.getImageData(0, 0, width, height);
    const buf = encodeFrame(image.data, width, height, config.pixelFormat);
    decodeFrame(buf, width, height, config.pixelFormat, image.data);
    return { frame: makeFrame(buf), image };
  }
}

/** Frontkamera mit der zur Auflösung passenden Webcam-Auflösung (nur Wunschwerte, damit jede Webcam funktioniert). */
function webcamConstraints({ frameSize }) {
  const { width, height } = webcamResolution(FRAME_SIZE.get(frameSize));
  return { facingMode: 'user', width: { ideal: width }, height: { ideal: height } };
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
