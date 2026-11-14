import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

const MODELS_DIR = path.resolve(import.meta.dirname, 'public/models');

/** Liest alle Dateien unter public/models rekursiv ein (Pfade relativ, mit "/"). */
function listModelFiles(dir = MODELS_DIR, prefix = '') {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return listModelFiles(path.join(dir, entry.name), rel);
    return entry.name === 'manifest.json' ? [] : [rel];
  });
}

/**
 * Stellt /models/manifest.json bereit: Liste aller Dateien unter public/models.
 * Im Dev-Server wird sie bei jeder Anfrage neu erzeugt, beim Build in dist/ geschrieben.
 * So reicht es, einen Modellordner nach public/models zu kopieren.
 */
function modelsManifest() {
  const manifest = () => JSON.stringify({ files: listModelFiles() }, null, 2);
  return {
    name: 'models-manifest',
    configureServer(server) {
      server.middlewares.use('/models/manifest.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(manifest());
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'models/manifest.json', source: manifest() });
    },
  };
}

export default defineConfig({
  plugins: [modelsManifest()],
  optimizeDeps: { exclude: ['@mujoco/mujoco'] },
  // MuJoCo-Glue-Code + three.js ergeben ein großes Bundle; die WASM-Datei liegt separat.
  build: { target: 'esnext', chunkSizeWarningLimit: 1500 },
  server: { port: 5173, open: true },
});
