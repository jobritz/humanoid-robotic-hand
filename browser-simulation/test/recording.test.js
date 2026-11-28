// Prüft, dass die aufgenommenen Trainingsdaten zum Trainingsskript des Gesten-Modells passen
// (model/gesture/gesture_common.py) und die Werte enthalten, die das Modell im Betrieb bekommt. Ausführen: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TrainingData, LANDMARK_COLUMNS, WORLD_COLUMNS } from '../src/recording.js';
import { landmarksToActuators } from '../src/handMapping.js';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const listItems = (source, pattern) => [...source.match(pattern)[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]);

/** Spalten, die load_csv() in gesture_common.py verlangt (Quelle der Wahrheit für das Training). */
const ACTUATORS = listItems(read('../../model/gesture/gesture_common.py'), /ACTUATORS = \[([\s\S]*?)\]/);
/** Eingabe-Reihenfolge des Gesten-Modells im Browser; main.js benennt damit die Aktuator-Spalten. */
const GESTURE_INPUTS = listItems(read('../src/gestureModel.js'), /GESTURE_INPUTS = \[([\s\S]*?)\]/);
const { cases } = JSON.parse(read('../../model/gesture/hand_mapping_testdata.json'));

const toPoints = (rows) => rows.map(([x, y, z]) => ({ x, y, z }));
const handOf = (world) => ({
  handedness: 'Right',
  score: 0.9876,
  landmarks: toPoints(world.map(([x, y, z]) => [x + 0.5, y + 0.5, z])), // Bildkoordinaten, hier nur Platzhalter
  worldLandmarks: toPoints(world),
});
const parse = (csv) => {
  const [header, ...rows] = csv.trimEnd().split('\n').map((line) => line.split(','));
  return rows.map((row) => Object.fromEntries(header.map((name, i) => [name, row[i]])));
};

test('Aktuator-Spalten heißen wie im Trainingsskript und in derselben Reihenfolge', () => {
  assert.equal(ACTUATORS.length, 8);
  assert.deepEqual(GESTURE_INPUTS, ACTUATORS);
});

test('Kopfzeile wie bei der bisherigen Aufnahme (timestamp, label, handedness, score, x0…z20, wx0…wz20, Aktuatoren)', () => {
  const [header] = new TrainingData(GESTURE_INPUTS).toCsv().split('\n');
  const columns = header.split(',');
  assert.deepEqual(columns.slice(0, 4), ['timestamp', 'label', 'handedness', 'score']);
  assert.deepEqual(columns.slice(4, 67), LANDMARK_COLUMNS);
  assert.deepEqual(columns.slice(67, 130), WORLD_COLUMNS);
  assert.deepEqual(columns.slice(130), ACTUATORS);
  assert.equal(LANDMARK_COLUMNS[0] + LANDMARK_COLUMNS.at(-1) + WORLD_COLUMNS[0] + WORLD_COLUMNS.at(-1), 'x0z20wx0wz20');
});

test('gespeichert werden die aus der Kamera berechneten Werte (wie hand_mapping.py)', () => {
  const data = new TrainingData(GESTURE_INPUTS);
  for (const { landmarks } of cases) data.add('rock', handOf(landmarks), landmarksToActuators(landmarks));
  const rows = parse(data.toCsv());
  assert.equal(rows.length, cases.length);
  rows.forEach((row, i) => {
    assert.equal(row.label, 'rock');
    assert.equal(row.handedness, 'Right');
    assert.equal(row.score, '0.9876');
    assert.ok(!Number.isNaN(Date.parse(row.timestamp)));
    // Aktuator-Spalten = Erwartungswerte aus hand_mapping_testdata.json (berechnet mit hand_mapping.py)
    ACTUATORS.forEach((name, k) => {
      assert.ok(Math.abs(Number(row[name]) - cases[i].actuators[k]) <= 1e-6, `Datensatz ${i}, ${name}`);
    });
    // Welt-Landmarken bleiben erhalten, die Werte lassen sich daraus neu berechnen
    WORLD_COLUMNS.forEach((name, k) => {
      assert.ok(Math.abs(Number(row[name]) - cases[i].landmarks[Math.floor(k / 3)][k % 3]) <= 1e-6, `${name}`);
    });
  });
});

test('Anzahl je Geste, Rückgängig, Verwerfen und Hinweis auf nicht heruntergeladene Daten', () => {
  const data = new TrainingData(GESTURE_INPUTS);
  const [first] = cases;
  const values = landmarksToActuators(first.landmarks);
  assert.equal(data.changed, false);
  for (const label of ['rock', 'rock', 'paper', 'nothing']) data.add(label, handOf(first.landmarks), values);
  assert.deepEqual(Object.fromEntries(data.counts()), { rock: 2, paper: 1, nothing: 1 });
  assert.equal(data.changed, true);
  data.markDownloaded();
  assert.equal(data.changed, false);
  assert.equal(data.undo().label, 'nothing');
  assert.equal(data.changed, true);
  assert.equal(data.length, 3);
  data.clear();
  assert.equal(data.length, 0);
  assert.equal(data.undo(), null);
  assert.equal(data.toCsv().trimEnd().split('\n').length, 1); // nur die Kopfzeile
});

test('ungültige Datensätze werden abgelehnt, Sonderzeichen im Label korrekt maskiert', () => {
  const data = new TrainingData(GESTURE_INPUTS);
  const hand = handOf(cases[0].landmarks);
  const values = landmarksToActuators(cases[0].landmarks);
  assert.throws(() => data.add('', hand, values), /Keine Geste/);
  assert.throws(() => data.add('rock', hand, values.slice(0, 7)), /8 Aktuator-Stellungen/);
  data.add('daumen "hoch", links', hand, values);
  assert.match(data.toCsv(), /,"daumen ""hoch"", links",/);
});
