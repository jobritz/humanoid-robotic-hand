// Webcam des Rechners für das Hand-Tracking: startet/stoppt die Kamera und meldet jedes neue Bild genau einmal.
// Ausgewertet wird direkt das Video (volle Auflösung, Farbe), ohne Umrechnung – wie später mit der Pi-Kamera.

/** Gewünschte Auflösung. Größer bringt MediaPipe kaum Vorteile, kostet aber Rechenzeit. */
const PREFERRED = { width: 640, height: 480 };

/**
 * `onFrame(video, timestamp)` wird pro neuem Kamerabild aufgerufen (timestamp: performance.now() in ms).
 * Wirft `onFrame` einen Fehler oder bricht die Kamera ab (z. B. abgesteckt), wird gestoppt und `onError(err)` gerufen.
 */
export class Webcam {
  constructor(video, { onFrame, onError } = {}) {
    this.video = video;
    this.onFrame = onFrame;
    this.onError = onError;
    this.stream = null;
    this.fps = 0; // ausgewertete Bilder pro Sekunde
    this.frameRequest = 0;
    this.lastVideoTime = -1;
    this.lastFrameAt = 0;
    // requestVideoFrameCallback meldet sich genau einmal pro neuem Kamerabild. video.currentTime taugt dafür
    // nicht: Es steigt bei Kamera-Streams kontinuierlich, sodass dasselbe Bild mehrfach ausgewertet würde.
    this.perVideoFrame = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
  }

  get running() {
    return this.stream !== null;
  }

  /** Tatsächliche Auflösung der laufenden Kamera oder null. */
  get resolution() {
    return this.running && this.video.videoWidth ? { width: this.video.videoWidth, height: this.video.videoHeight } : null;
  }

  async start() {
    if (this.running) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Kein Kamerazugriff möglich – die Seite muss über http://localhost oder HTTPS geöffnet werden.');
    }
    const video = { facingMode: 'user', width: { ideal: PREFERRED.width }, height: { ideal: PREFERRED.height } };
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video }).catch((err) => {
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
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth) return;
    // Fallback ohne requestVideoFrameCallback: unveränderte Bilder zumindest grob überspringen.
    if (!this.perVideoFrame) {
      if (video.currentTime === this.lastVideoTime) return;
      this.lastVideoTime = video.currentTime;
    }
    const now = performance.now();
    this.fps = 0.9 * this.fps + 0.1 * (1000 / Math.max(1, now - this.lastFrameAt));
    this.lastFrameAt = now;
    try {
      this.onFrame?.(video, now);
    } catch (err) {
      this.fail(err);
    }
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
