import loadMujoco from '@mujoco/mujoco';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const DT = 0.002; // gleich wie <option timestep> in hand.xml

export async function createSim(canvas) {
  const mujoco = await loadMujoco();
  const xml = await (await fetch('/hand.xml')).text();
  const model = mujoco.MjModel.from_xml_string(xml);
  const data = new mujoco.MjData(model);
  mujoco.mj_forward(model, data);

  // three.js-Szene
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x15181d);
  const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 10);
  camera.up.set(0, 0, 1);
  camera.position.set(0.30, 0.05, 0.02); // Seitenansicht: die Krümmung nach unten ist gut zu sehen
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0.05, -0.02);
  controls.update();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.5);
  sun.position.set(0.2, -0.3, 0.5);
  scene.add(sun);
  const grid = new THREE.GridHelper(0.5, 25, 0x445566, 0x2a3340);
  grid.rotation.x = Math.PI / 2;
  grid.position.z = -0.09;
  scene.add(grid);

  // ein Mesh pro MuJoCo-Geom (Kugel, Kapsel, Box)
  const meshes = [];
  for (let i = 0; i < model.ngeom; i++) {
    const type = model.geom_type[i];
    const s = [model.geom_size[3 * i], model.geom_size[3 * i + 1], model.geom_size[3 * i + 2]];
    let geo = null;
    if (type === 2) geo = new THREE.SphereGeometry(s[0], 24, 16);
    else if (type === 3) {
      geo = new THREE.CapsuleGeometry(s[0], 2 * s[1], 8, 16);
      geo.rotateX(Math.PI / 2); // three: Achse y, MuJoCo: Achse z
    } else if (type === 6) geo = new THREE.BoxGeometry(2 * s[0], 2 * s[1], 2 * s[2]);
    if (!geo) { meshes.push(null); continue; }
    const color = new THREE.Color(model.geom_rgba[4 * i], model.geom_rgba[4 * i + 1], model.geom_rgba[4 * i + 2]);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color }));
    scene.add(mesh);
    meshes.push(mesh);
  }

  function resize() {
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
    camera.aspect = canvas.clientWidth / canvas.clientHeight;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  const rot = new THREE.Matrix4();
  function syncMeshes() {
    const p = data.geom_xpos;
    const R = data.geom_xmat; // 9 Werte pro Geom, zeilenweise
    for (let i = 0; i < meshes.length; i++) {
      const m = meshes[i];
      if (!m) continue;
      m.position.set(p[3 * i], p[3 * i + 1], p[3 * i + 2]);
      rot.set(
        R[9 * i], R[9 * i + 1], R[9 * i + 2], 0,
        R[9 * i + 3], R[9 * i + 4], R[9 * i + 5], 0,
        R[9 * i + 6], R[9 * i + 7], R[9 * i + 8], 0,
        0, 0, 0, 1);
      m.quaternion.setFromRotationMatrix(rot);
    }
  }

  function start(onTick) {
    let last = performance.now() / 1000;
    let acc = 0;
    const frame = (nowMs) => {
      const now = nowMs / 1000;
      acc += Math.min(now - last, 0.05);
      last = now;
      onTick(now);
      while (acc >= DT) { mujoco.mj_step(model, data); acc -= DT; }
      syncMeshes();
      controls.update();
      renderer.render(scene, camera);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  function setCtrl(values) {
    for (let i = 0; i < values.length; i++) data.ctrl[i] = values[i];
  }

  return { start, setCtrl, nu: model.nu };
}