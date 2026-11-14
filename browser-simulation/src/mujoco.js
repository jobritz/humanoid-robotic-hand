// Laden der MuJoCo-WASM-Engine und Kompilieren von MJCF-Modellen über das virtuelle Dateisystem (VFS).
import loadMujoco from '@mujoco/mujoco';
import wasmUrl from '@mujoco/mujoco/mujoco.wasm?url';

let mujocoPromise;

/** Lädt die MuJoCo-Engine genau einmal. */
export function getMujoco() {
  mujocoPromise ??= loadMujoco({ locateFile: (file) => (file.endsWith('.wasm') ? wasmUrl : file) });
  return mujocoPromise;
}

/**
 * Kompiliert ein Modell.
 * @param {object} mujoco   geladene Engine
 * @param {Map<string, Uint8Array>} files  alle Dateien (Pfad -> Inhalt), z. B. XML, STL, OBJ, PNG
 * @param {string} entry    Pfad der Haupt-XML innerhalb von `files`
 * @returns {{model: object, data: object}}
 */
export function compileModel(mujoco, files, entry) {
  const vfs = new mujoco.MjVFS();
  try {
    for (const [path, bytes] of files) vfs.addBuffer(path, bytes);
    const model = mujoco.MjModel.from_xml_path(entry, vfs);
    const data = new mujoco.MjData(model);
    mujoco.mj_forward(model, data);
    return { model, data };
  } finally {
    vfs.delete();
  }
}

/**
 * Alle Modellordner in public/models (laut /models/manifest.json, siehe vite.config.js).
 * @returns {Promise<{folder: string, files: string[]}[]>}
 */
export async function listServedModels() {
  const res = await fetch(`${import.meta.env.BASE_URL}models/manifest.json`);
  if (!res.ok) throw new Error('Modell-Manifest nicht gefunden');
  const { files } = await res.json();
  const byFolder = new Map();
  for (const f of files) {
    const folder = f.split('/')[0];
    if (!byFolder.has(folder)) byFolder.set(folder, []);
    byFolder.get(folder).push(f);
  }
  return [...byFolder]
    .filter(([, list]) => list.some((f) => f.toLowerCase().endsWith('.xml')))
    .map(([folder, list]) => ({ folder, files: list }));
}

/** Lädt alle Dateien eines Modellordners aus public/models. */
export async function fetchServedModel({ files }) {
  const entries = await Promise.all(
    files.map(async (path) => {
      const r = await fetch(`${import.meta.env.BASE_URL}models/${path}`);
      if (!r.ok) throw new Error(`Datei konnte nicht geladen werden: ${path}`);
      return [path, new Uint8Array(await r.arrayBuffer())];
    }),
  );
  return new Map(entries);
}

/** Liest vom Nutzer gewählte Dateien (Datei-Dialog oder Drag & Drop) in eine Map. */
export async function readLocalFiles(fileList) {
  const entries = await Promise.all(
    fileList.map(async ({ path, file }) => [path, new Uint8Array(await file.arrayBuffer())]),
  );
  return new Map(entries);
}

/**
 * Sucht unter den XML-Dateien die Haupt-Szenen: Dateien mit <worldbody>, die von keiner anderen
 * Datei per <include> eingebunden werden. "scene.xml" wird bevorzugt.
 */
export function findEntryCandidates(files) {
  const decoder = new TextDecoder();
  const xmls = [...files.keys()].filter((p) => p.toLowerCase().endsWith('.xml'));
  const included = new Set();
  const texts = new Map(xmls.map((p) => [p, decoder.decode(files.get(p))]));
  for (const text of texts.values()) {
    for (const m of text.matchAll(/<include\s+file\s*=\s*"([^"]+)"/g)) {
      included.add(m[1].split('/').pop());
    }
  }
  const candidates = xmls.filter(
    (p) => texts.get(p).includes('<mujoco') && !included.has(p.split('/').pop()),
  );
  const list = candidates.length ? candidates : xmls;
  return list.sort((a, b) => score(b) - score(a) || a.localeCompare(b));

  function score(p) {
    const name = p.split('/').pop().toLowerCase();
    return (name === 'scene.xml' ? 2 : 0) + (texts.get(p).includes('<worldbody') ? 1 : 0);
  }
}
