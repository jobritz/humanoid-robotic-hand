// Prüft, dass handMapping.js genauso rechnet wie model/gesture/hand_mapping.py (Raspberry Pi):
// beide werden gegen dieselben Testdaten geprüft. Ausführen: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { landmarksToActuators } from '../src/handMapping.js';

const data = JSON.parse(readFileSync(new URL('../../model/gesture/hand_mapping_testdata.json', import.meta.url), 'utf8'));

test('handMapping.js liefert dieselben Werte wie hand_mapping.py', () => {
  assert.ok(data.cases.length > 0);
  for (const [i, { landmarks, actuators }] of data.cases.entries()) {
    const got = landmarksToActuators(landmarks);
    got.forEach((v, k) => {
      assert.ok(Math.abs(v - actuators[k]) <= data.tolerance, `Fall ${i}, Wert ${k}: ${v} statt ${actuators[k]}`);
    });
  }
});

test('Landmarken als {x, y, z}-Objekte (wie von MediaPipe) ergeben dasselbe wie Arrays', () => {
  const { landmarks } = data.cases[0];
  const objects = landmarks.map(([x, y, z]) => ({ x, y, z }));
  assert.deepEqual(landmarksToActuators(objects), landmarksToActuators(landmarks));
});

test('falsche Anzahl Landmarken wird abgelehnt', () => {
  assert.throws(() => landmarksToActuators(data.cases[0].landmarks.slice(0, 20)), /21 Landmarken/);
});
