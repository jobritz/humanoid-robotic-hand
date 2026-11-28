// Umrechnung MediaPipe-Hand → 8 Aktuator-Stellungen der Amazing Hand (Input des Gesten-Modells).
//
// Identisch implementiert in model/gesture/hand_mapping.py (für den Raspberry Pi). Beide müssen gleich rechnen, sonst
// bekommt das Gesten-Modell auf dem Pi andere Werte als bei der Aufnahme der Trainingsdaten im Browser.
// Prüfung: npm test (vergleicht mit model/gesture/hand_mapping_testdata.json, die auch der Python-Test nutzt).
// Vorgehen und Herkunft der Kalibrierung: siehe Kopf von hand_mapping.py.

const FLEX_MAX = Math.PI / 2; // 90° (ctrlrange der *_flex-Aktuatoren in MuJoCo.xml)
const ABD_MAX = (35 * Math.PI) / 180; // 35° (ctrlrange der *_abd-Aktuatoren)

/** Kalibrierung je Finger (Roh-Werte in rad), gleiche Werte wie CALIBRATION in hand_mapping.py. */
export const CALIBRATION = {
  index: { open: 0.892, fist: 2.54, abdNeutral: -0.11 },
  middle: { open: 0.707, fist: 3.459, abdNeutral: -0.169 },
  ring: { open: 0.599, fist: 2.942, abdNeutral: -0.32 },
  thumb: { open: 0.334, fist: 1.977, abdNeutral: 0.659 },
};

/** Finger in der Reihenfolge der Ausgabe und ihre MediaPipe-Landmarken (Wurzel → Spitze). */
const FINGERS = [
  ['index', [5, 6, 7, 8]],
  ['middle', [9, 10, 11, 12]],
  ['ring', [13, 14, 15, 16]],
  ['thumb', [1, 2, 3, 4]],
];

const xyz = (p) => (Array.isArray(p) ? p : [p.x, p.y, p.z]);
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a) => {
  const n = Math.sqrt(dot(a, a)) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};
const angle = (a, b) => Math.acos(Math.min(1, Math.max(-1, dot(unit(a), unit(b)))));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * 21 Landmarken → je Finger [Beugung, Spreizung] als Roh-Winkel in rad (Reihenfolge wie FINGERS).
 * @param {Array<{x: number, y: number, z: number} | number[]>} landmarks MediaPipe-worldLandmarks
 */
export function rawFeatures(landmarks) {
  if (landmarks.length !== 21) throw new Error(`Erwartet werden 21 Landmarken, erhalten: ${landmarks.length}`);
  const lm = landmarks.map(xyz);
  const wrist = lm[0];
  const fwd = unit(sub(lm[9], wrist)); // Handrichtung
  const s = sub(lm[5], lm[17]); // quer über die Hand, zur Daumenseite
  const k = dot(s, fwd);
  const side = unit([s[0] - k * fwd[0], s[1] - k * fwd[1], s[2] - k * fwd[2]]);

  return FINGERS.map(([name, [a, b, c, d]]) => {
    const [pa, pb, pc, pd] = [lm[a], lm[b], lm[c], lm[d]];
    const bend =
      name === 'thumb'
        ? angle(sub(pb, pa), sub(pc, pb)) + angle(sub(pc, pb), sub(pd, pc))
        : angle(sub(pa, wrist), sub(pb, pa)) + angle(sub(pb, pa), sub(pc, pb)) + angle(sub(pc, pb), sub(pd, pc));
    const v = sub(pb, pa);
    return [bend, Math.atan2(dot(v, side), dot(v, fwd))];
  });
}

/**
 * 21 MediaPipe-worldLandmarks → 8 Aktuator-Stellungen in rad, Reihenfolge wie GESTURE_INPUTS
 * (index_flex, index_abd, middle_flex, middle_abd, ring_flex, ring_abd, thumb_flex, thumb_abd).
 */
export function landmarksToActuators(landmarks, calibration = CALIBRATION) {
  return rawFeatures(landmarks).flatMap(([bend, spread], i) => {
    const cal = calibration[FINGERS[i][0]];
    const t = clamp((bend - cal.open) / (cal.fist - cal.open), 0, 1);
    return [t * FLEX_MAX, clamp((spread - cal.abdNeutral) * (1 - t), -ABD_MAX, ABD_MAX)];
  });
}

/** Optional: glättet aufeinanderfolgende Werte (exponentiell) gegen Zittern; alpha = Anteil des neuen Werts. */
export class Smoother {
  constructor(alpha = 0.5) {
    this.alpha = alpha;
    this.values = null;
  }

  next(values) {
    this.values = this.values ? this.values.map((v, i) => v + this.alpha * (values[i] - v)) : [...values];
    return this.values;
  }

  reset() {
    this.values = null;
  }
}
