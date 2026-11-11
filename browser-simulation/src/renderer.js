// Darstellung eines MuJoCo-Modells mit three.js.
// MuJoCo nutzt Z nach oben, three.js Y nach oben: Alle Geoms hängen an `world`, das um -90° um X gedreht ist.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const GEOM = { PLANE: 0, HFIELD: 1, SPHERE: 2, CAPSULE: 3, ELLIPSOID: 4, CYLINDER: 5, BOX: 6, MESH: 7 };

export class Renderer {
  constructor(container) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1d2026);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.001, 100);
    this.camera.position.set(0.4, 0.35, 0.4);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404050, 1.2));
    this.sun = new THREE.DirectionalLight(0xffffff, 2.2);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.scene.add(this.sun, this.sun.target);

    this.world = new THREE.Group();
    this.world.rotation.x = -Math.PI / 2;
    this.scene.add(this.world);

    /** @type {THREE.Mesh[]} Index = MuJoCo-Geom-ID (null bei nicht darstellbaren Geoms) */
    this.geoms = [];
    this.visibleGroups = new Set([0, 1, 2]);

    this.resizeObserver = new ResizeObserver(() => this.resize(container));
    this.resizeObserver.observe(container);
    this.resize(container);
  }

  resize(container) {
    const { clientWidth: w, clientHeight: h } = container;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Baut die three.js-Objekte für alle Geoms eines neu geladenen Modells. */
  setModel(model) {
    this.clear();
    const meshCache = new Map();
    const extent = model.stat.extent || 1;
    // Jeder Zugriff auf ein Modellfeld erzeugt eine neue Ansicht in den WASM-Speicher, daher einmal holen.
    const types = model.geom_type;
    const sizes = model.geom_size;
    const dataIds = model.geom_dataid;
    const groups = model.geom_group;

    for (let g = 0; g < model.ngeom; g++) {
      const type = types[g];
      const size = sizes.subarray(3 * g, 3 * g + 3);
      let geometry;
      switch (type) {
        case GEOM.PLANE: {
          const sx = size[0] > 0 ? 2 * size[0] : 20 * extent;
          const sy = size[1] > 0 ? 2 * size[1] : 20 * extent;
          geometry = new THREE.PlaneGeometry(sx, sy);
          break;
        }
        case GEOM.SPHERE:
          geometry = new THREE.SphereGeometry(size[0], 32, 16);
          break;
        case GEOM.ELLIPSOID:
          geometry = new THREE.SphereGeometry(1, 32, 16).scale(size[0], size[1], size[2]);
          break;
        case GEOM.CAPSULE:
          geometry = new THREE.CapsuleGeometry(size[0], 2 * size[1], 12, 24).rotateX(Math.PI / 2);
          break;
        case GEOM.CYLINDER:
          geometry = new THREE.CylinderGeometry(size[0], size[0], 2 * size[1], 32).rotateX(Math.PI / 2);
          break;
        case GEOM.BOX:
          geometry = new THREE.BoxGeometry(2 * size[0], 2 * size[1], 2 * size[2]);
          break;
        case GEOM.MESH: {
          const id = dataIds[g];
          if (!meshCache.has(id)) meshCache.set(id, buildMeshGeometry(model, id));
          geometry = meshCache.get(id);
          break;
        }
        default:
          // Höhenfelder und SDFs werden (noch) nicht dargestellt.
          this.geoms.push(null);
          continue;
      }

      const mesh = new THREE.Mesh(geometry, makeMaterial(model, g, type === GEOM.PLANE));
      mesh.matrixAutoUpdate = false;
      mesh.castShadow = type !== GEOM.PLANE;
      mesh.receiveShadow = true;
      mesh.userData.group = groups[g];
      mesh.visible = this.visibleGroups.has(mesh.userData.group) && mesh.material.opacity > 0;
      this.world.add(mesh);
      this.geoms.push(mesh);
    }

    this.frameModel(model);
  }

  /** Überträgt die aktuellen Geom-Posen aus MjData auf die three.js-Objekte. */
  update(data) {
    const pos = data.geom_xpos;
    const mat = data.geom_xmat;
    const m = new THREE.Matrix4();
    for (let g = 0; g < this.geoms.length; g++) {
      const mesh = this.geoms[g];
      if (!mesh) continue;
      const r = 9 * g;
      const p = 3 * g;
      // geom_xmat ist zeilenweise (row-major), Matrix4.set erwartet ebenfalls Zeilen.
      m.set(
        mat[r], mat[r + 1], mat[r + 2], pos[p],
        mat[r + 3], mat[r + 4], mat[r + 5], pos[p + 1],
        mat[r + 6], mat[r + 7], mat[r + 8], pos[p + 2],
        0, 0, 0, 1,
      );
      mesh.matrix.copy(m);
      mesh.matrixWorldNeedsUpdate = true;
    }
  }

  setGroupVisible(group, visible) {
    if (visible) this.visibleGroups.add(group);
    else this.visibleGroups.delete(group);
    for (const mesh of this.geoms) {
      if (mesh && mesh.userData.group === group) mesh.visible = visible && mesh.material.opacity > 0;
    }
  }

  /** Richtet Kamera und Schattenlicht anhand der Modellgröße aus. */
  frameModel(model) {
    const [cx, cy, cz] = model.stat.center;
    const extent = model.stat.extent || 1;
    const center = new THREE.Vector3(cx, cz, -cy); // MuJoCo (Z oben) -> three.js (Y oben)
    this.controls.target.copy(center);
    this.camera.position.copy(center).add(new THREE.Vector3(1, 0.8, 1).multiplyScalar(extent * 1.2));
    this.camera.near = extent / 200;
    this.camera.far = extent * 200;
    this.camera.updateProjectionMatrix();
    this.controls.update();

    this.sun.position.copy(center).add(new THREE.Vector3(1, 2, 1.5).multiplyScalar(extent * 2));
    this.sun.target.position.copy(center);
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -extent * 1.5;
    cam.right = cam.top = extent * 1.5;
    cam.near = extent / 10;
    cam.far = extent * 10;
    cam.updateProjectionMatrix();
  }

  render() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  clear() {
    const geometries = new Set();
    for (const mesh of this.geoms) {
      if (!mesh) continue;
      geometries.add(mesh.geometry);
      mesh.material.dispose();
      this.world.remove(mesh);
    }
    geometries.forEach((g) => g.dispose());
    this.geoms = [];
  }
}

/** Farbe aus dem MuJoCo-Material (falls vorhanden), sonst aus geom_rgba. */
function makeMaterial(model, g, isPlane) {
  const matId = model.geom_matid[g];
  const rgba = matId >= 0 ? model.mat_rgba.subarray(4 * matId, 4 * matId + 4) : model.geom_rgba.subarray(4 * g, 4 * g + 4);
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(rgba[0], rgba[1], rgba[2]),
    opacity: rgba[3],
    transparent: rgba[3] < 1,
    roughness: isPlane ? 0.95 : 0.6,
    metalness: 0.05,
    side: isPlane ? THREE.DoubleSide : THREE.FrontSide,
  });
}

/** Erzeugt die Geometrie eines MuJoCo-Meshes mit den Normalen pro Dreiecksecke (scharfe Kanten bleiben erhalten). */
function buildMeshGeometry(model, meshId) {
  const vertAdr = model.mesh_vertadr[meshId];
  const normalAdr = model.mesh_normaladr[meshId];
  const faceAdr = model.mesh_faceadr[meshId];
  const faceNum = model.mesh_facenum[meshId];
  const verts = model.mesh_vert;
  const normals = model.mesh_normal;
  const faces = model.mesh_face;
  const faceNormals = model.mesh_facenormal;

  const position = new Float32Array(faceNum * 9);
  const normal = new Float32Array(faceNum * 9);
  for (let f = 0; f < faceNum; f++) {
    for (let k = 0; k < 3; k++) {
      const i = 3 * (faceAdr + f) + k;
      const v = 3 * (vertAdr + faces[i]);
      const n = 3 * (normalAdr + faceNormals[i]);
      const o = 9 * f + 3 * k;
      position[o] = verts[v];
      position[o + 1] = verts[v + 1];
      position[o + 2] = verts[v + 2];
      normal[o] = normals[n];
      normal[o + 1] = normals[n + 1];
      normal[o + 2] = normals[n + 2];
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  return geometry;
}
