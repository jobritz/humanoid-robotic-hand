const sub = (a, b) => [a.x - b.x, a.y - b.y, a.z - b.z];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a) => { const n = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };
const angle = (a, b) => Math.acos(Math.min(1, Math.max(-1, dot(unit(a), unit(b)))));

const FINGER_IDS = { index: [5, 6, 7, 8], middle: [9, 10, 11, 12], ring: [13, 14, 15, 16] };

// lm = 21 Welt-Landmarken -> [idxFlex, idxAbd, midFlex, midAbd, ringFlex, ringAbd, thumbFlex, thumbAbd] in rad
export function rawFeatures(lm) {
  const wrist = lm[0];
  const fwd = unit(sub(lm[9], wrist));          // Handrichtung
  const s = sub(lm[5], lm[17]);                 // quer über die Hand
  const k = dot(s, fwd);
  const side = unit([s[0] - k * fwd[0], s[1] - k * fwd[1], s[2] - k * fwd[2]]);

  const out = [];
  for (const name of ['index', 'middle', 'ring']) {
    const [m, p, d, t] = FINGER_IDS[name].map((i) => lm[i]);
    const bendMcp = angle(sub(m, wrist), sub(p, m));
    const bendPip = angle(sub(p, m), sub(d, p));
    const bendDip = angle(sub(d, p), sub(t, d));
    const v = sub(p, m);
    out.push(bendMcp + bendPip + bendDip, Math.atan2(dot(v, side), dot(v, fwd)));
  }
  // Daumen: Landmarken 1..4
  const [c, m, i, t] = [lm[1], lm[2], lm[3], lm[4]];
  const v = sub(m, c);
  out.push(angle(sub(m, c), sub(i, m)) + angle(sub(i, m), sub(t, i)),
           Math.atan2(dot(v, side), dot(v, fwd)));
  return out;
}

const FLEX_MAX = 45.0;                    // wie in make_hand.py
const ABD_MAX = 35.0;                     // wie in make_hand.py
const ABD_GAIN = 0.8;                     // empirisch, um die Spreizbewegung zu verstärken
const ABD_SIGN = [1, 1, 1, 1];            // pro Finger auf -1 setzen, falls Spreizen verkehrt herum läuft
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class Mapper {
  constructor() {
    this.open = null;                     // Kalibrierung: flache Hand
    this.fist = null;                     // Kalibrierung: Faust
    this.lo = [null, null, null, null];   // automatisch gelernter Bereich je Finger
    this.hi = [null, null, null, null];
    this.out = new Array(8).fill(0);
  }
  calibrateOpen(raw) { this.open = [...raw]; }
  calibrateFist(raw) { this.fist = [...raw]; }

  map(raw, alpha = 0.35) {
    const target = new Array(8);
    for (let f = 0; f < 4; f++) {
      const fi = 2 * f;
      const ai = 2 * f + 1;
      if (this.lo[f] === null) { this.lo[f] = raw[fi]; this.hi[f] = raw[fi] + 1.0; }
      this.lo[f] = Math.min(this.lo[f], raw[fi]);
      this.hi[f] = Math.max(this.hi[f], raw[fi]);
      const o = this.open ? this.open[fi] : this.lo[f];
      const c = this.fist ? this.fist[fi] : this.hi[f];
      const t = clamp((raw[fi] - o) / Math.max(c - o, 0.3), 0, 1);
      const a0 = this.open ? this.open[ai] : 0;
      target[fi] = t * FLEX_MAX;
      target[ai] = clamp(ABD_SIGN[f] * ABD_GAIN * (raw[ai] - a0), -ABD_MAX, ABD_MAX);
    }
    for (let i = 0; i < 8; i++) this.out[i] += alpha * (target[i] - this.out[i]);
    return this.out;
  }
}