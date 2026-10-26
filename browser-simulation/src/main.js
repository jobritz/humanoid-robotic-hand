import { createSim } from './sim.js';
import { createTracker } from './tracking.js';
import { drawOverlay } from './overlay.js';
import { rawFeatures, Mapper } from './mapping.js';

const $ = (id) => document.getElementById(id);

async function main() {
  const sim = await createSim($('sim'));
  const mapper = new Mapper();
  let tracker = null;
  let raw = null;
  let frame = 0;

  $('start').onclick = async () => {
    $('start').disabled = true;
    $('status').textContent = 'Lade Modell ...';
    try {
      tracker = await createTracker($('cam'));
      $('status').textContent = 'Tracking läuft';
    } catch (e) {
      $('status').textContent = 'Fehler: ' + e.message;
      $('start').disabled = false;
    }
  };
  $('calOpen').onclick = () => { if (raw) mapper.calibrateOpen(raw); };
  $('calFist').onclick = () => { if (raw) mapper.calibrateFist(raw); };

  sim.start((t) => {
    let ctrl;
    if (tracker) {
      const res = tracker.poll();
      if (res) {
        drawOverlay($('overlay'), res.image);
        if (res.world) raw = rawFeatures(res.world);
      }
      ctrl = raw ? mapper.map(raw) : null;
    } else {
      ctrl = [];
      for (let f = 0; f < 4; f++) ctrl.push(0.8 * (1 + Math.sin(2 * t + f)), 0.3 * Math.sin(1.3 * t));
    }
    if (!ctrl) return;
    sim.setCtrl(ctrl);
    if (tracker && raw && ++frame % 10 === 0) {
      const pick = (a) => [0, 2, 4, 6].map((i) => a[i].toFixed(2)).join('  ');
      $('status').textContent = 'Beugung Z M R D\n roh: ' + pick(raw) + '\n ctrl: ' + pick(ctrl);
    }
  });
}
main();