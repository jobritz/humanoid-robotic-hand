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

const LITERT_DIR = path.resolve(import.meta.dirname, 'node_modules/@litertjs/core/wasm');
/** Benötigte LiteRT.js-Laufzeiten: Standard (mit Relaxed SIMD) und „compat“ für ältere Browser, je .js + .wasm. */
const LITERT_FILES = ['litert_wasm_internal', 'litert_wasm_compat_internal'].flatMap((n) => [`${n}.js`, `${n}.wasm`]);

/**
 * Stellt die WASM-Laufzeit von LiteRT.js unter /litert/ bereit (Dev-Server) bzw. kopiert sie nach dist/litert/.
 * LiteRT.js lädt sie zur Laufzeit selbst aus einem Ordner und wählt die zum Browser passende Variante.
 */
function liteRtWasm() {
  return {
    name: 'litert-wasm',
    configureServer(server) {
      server.middlewares.use('/litert', (req, res, next) => {
        const file = req.url.split('?')[0].slice(1);
        if (!LITERT_FILES.includes(file)) return next();
        res.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        fs.createReadStream(path.join(LITERT_DIR, file)).pipe(res);
      });
    },
    generateBundle() {
      for (const file of LITERT_FILES) {
        this.emitFile({ type: 'asset', fileName: `litert/${file}`, source: fs.readFileSync(path.join(LITERT_DIR, file)) });
      }
    },
  };
}

export default defineConfig({
  plugins: [modelsManifest(), liteRtWasm()],
  optimizeDeps: { exclude: ['@mujoco/mujoco'] },
  // MuJoCo-Glue-Code + three.js ergeben ein großes Bundle; die WASM-Datei liegt separat.
  build: { target: 'esnext', chunkSizeWarningLimit: 1500 },
  server: {
    port: 5173,
    open: true,
    // Das KI-Modell wird direkt aus der Firmware (esp/esp32ai/hand.tflite) geladen, nicht kopiert.
    fs: { allow: ['.', '../esp/esp32ai'] },
  },
});
