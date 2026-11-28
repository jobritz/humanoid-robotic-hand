// Trainingsdaten für das Gesten-Modell aufnehmen (Training: model/gesture/train_gesture_model.py).
//
// Ein Datensatz = ein Kamerabild mit erkannter Hand: die gezeigte Geste (label), die 21 Landmarken von MediaPipe
// (Bild- und Weltkoordinaten) und die daraus mit handMapping.js berechneten 8 Aktuator-Stellungen in rad. Das sind
// genau die Werte, die das Gesten-Modell im Betrieb bekommt (Browser und Raspberry Pi). Das Trainingsskript liest nur
// `label` und die 8 Aktuator-Spalten. Die Landmarken bleiben erhalten, damit sich die Werte neu berechnen lassen,
// falls sich die Umrechnung ändert.
//
// Spalten wie in „Testdaten Roboterhand.csv“: timestamp, label, handedness, score, x0…z20, wx0…wz20, 8 Aktuatoren.
// Dort stehen in den Aktuator-Spalten allerdings die vorgegebenen Zielposen, hier die aus der Kamera berechneten Werte.

const coordinateColumns = (prefix) =>
  Array.from({ length: 21 }, (_, i) => ['x', 'y', 'z'].map((axis) => `${prefix}${axis}${i}`)).flat();

/** Bild-Landmarken (x, y normiert auf das Kamerabild 0…1, z relativ zum Handgelenk). */
export const LANDMARK_COLUMNS = coordinateColumns('');
/** Welt-Landmarken in m (Grundlage der Aktuator-Stellungen). */
export const WORLD_COLUMNS = coordinateColumns('w');

const number = (value, digits) => (Number.isFinite(value) ? value.toFixed(digits) : '');
const text = (value) => (/[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
const point = ({ x, y, z }) => [x, y, z];

export class TrainingData {
  /** @param {string[]} actuators Namen der Aktuator-Spalten in der Reihenfolge der Werte (GESTURE_INPUTS) */
  constructor(actuators) {
    this.actuators = actuators;
    this.samples = [];
    this.changed = false; // seit dem letzten Herunterladen verändert?
  }

  get length() {
    return this.samples.length;
  }

  /**
   * Speichert einen Datensatz.
   * @param {string} label Geste, z. B. 'rock'
   * @param {{landmarks: object[], worldLandmarks: object[], handedness: string, score: number}} hand erkannte Hand
   * @param {number[]} actuators daraus berechnete Aktuator-Stellungen in rad (landmarksToActuators)
   * @param {Date} [time] Aufnahmezeitpunkt
   */
  add(label, hand, actuators, time = new Date()) {
    if (!label) throw new Error('Keine Geste gewählt.');
    if (actuators?.length !== this.actuators.length) {
      throw new Error(`Erwartet werden ${this.actuators.length} Aktuator-Stellungen, erhalten: ${actuators?.length}`);
    }
    const sample = {
      time,
      label,
      handedness: hand.handedness,
      score: hand.score,
      landmarks: hand.landmarks.map(point),
      world: hand.worldLandmarks.map(point),
      actuators: [...actuators],
    };
    this.samples.push(sample);
    this.changed = true;
    return sample;
  }

  /** Entfernt den zuletzt gespeicherten Datensatz und gibt ihn zurück (oder null). */
  undo() {
    const sample = this.samples.pop() ?? null;
    if (sample) this.changed = true;
    return sample;
  }

  clear() {
    this.samples = [];
    this.changed = false;
  }

  /** Anzahl Datensätze je Geste. */
  counts() {
    const counts = new Map();
    for (const { label } of this.samples) counts.set(label, (counts.get(label) ?? 0) + 1);
    return counts;
  }

  /** Alle Datensätze als CSV-Text (Kopfzeile + eine Zeile je Datensatz). */
  toCsv() {
    const header = ['timestamp', 'label', 'handedness', 'score', ...LANDMARK_COLUMNS, ...WORLD_COLUMNS, ...this.actuators];
    const rows = this.samples.map((s) =>
      [
        s.time.toISOString(),
        text(s.label),
        text(s.handedness),
        number(s.score, 4),
        ...s.landmarks.flat().map((v) => number(v, 6)),
        ...s.world.flat().map((v) => number(v, 6)),
        ...s.actuators.map((v) => number(v, 6)),
      ].join(','),
    );
    return `${[header.join(','), ...rows].join('\n')}\n`;
  }

  /** Nach dem Herunterladen aufrufen: bis zur nächsten Änderung warnt die Seite nicht mehr vor Datenverlust. */
  markDownloaded() {
    this.changed = false;
  }
}
