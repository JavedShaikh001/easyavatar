// Bundles the renderer and copies the MediaPipe WebAssembly files into app/.
import { build } from 'esbuild';
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
mkdirSync(path.join(root, 'app', 'wasm'), { recursive: true });
cpSync(path.join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm'), path.join(root, 'app', 'wasm'), { recursive: true });
await build({
  entryPoints: [path.join(root, 'src', 'app.js')],
  bundle: true, format: 'iife', target: 'chrome120', minify: !watch, sourcemap: watch ? 'inline' : false,
  outfile: path.join(root, 'app', 'renderer.js'), logLevel: 'info',
});
if (!existsSync(path.join(root, 'app', 'models', 'face_landmarker.task'))) {
  console.log('note: app/models/face_landmarker.task not found — run "npm run fetch-model" to bundle it (otherwise the app downloads it on first use).');
}
