// Downloads Google's MediaPipe face landmarker model so it ships inside the installer.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'app', 'models', 'face_landmarker.task');
if (existsSync(out)) { console.log('model already present'); process.exit(0); }
mkdirSync(path.dirname(out), { recursive: true });
const res = await fetch(URL);
if (!res.ok) { console.error('download failed', res.status); process.exit(1); }
writeFileSync(out, Buffer.from(await res.arrayBuffer()));
console.log('saved', out);
