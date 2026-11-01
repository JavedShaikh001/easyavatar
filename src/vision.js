// Webcam + MediaPipe Face Landmarker (runs fully on this computer).
import { FilesetResolver, FaceLandmarker } from '@mediapipe/tasks-vision';

let landmarkerPromise = null;
let stream = null;

export function getLandmarker(onStatus = () => {}) {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      onStatus('Loading face tracker…');
      window.api.onModelStatus(onStatus);
      const fileset = await FilesetResolver.forVisionTasks(new URL('wasm', location.href).href.replace(/\/$/, ''));
      let model;
      try { model = await window.api.getModel(); } catch (e) {
        throw new Error('Could not download the face tracker (needed once, about 4 MB). Check your internet connection or firewall and try again. ' + String(e.message || '').replace(/^Error invoking remote method 'get-model': (Error: )?/, ''));
      }
      const opts = (delegate) => ({
        baseOptions: { modelAssetBuffer: model, delegate },
        runningMode: 'VIDEO', numFaces: 1,
        outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
      });
      try {
        return await FaceLandmarker.createFromOptions(fileset, opts('GPU'));
      } catch (e) {
        console.warn('GPU face tracking unavailable, using CPU', e);
        return FaceLandmarker.createFromOptions(fileset, opts('CPU'));
      }
    })().catch((e) => { landmarkerPromise = null; throw e; });
  }
  return landmarkerPromise;
}

const CAM_KEY = 'easyavatar.camera';
export function preferredCamera() { try { return localStorage.getItem(CAM_KEY) || ''; } catch { return ''; } }
export function setPreferredCamera(id) { try { localStorage.setItem(CAM_KEY, id || ''); } catch {} }

export async function listCameras() {
  const devs = await navigator.mediaDevices.enumerateDevices();
  return devs.filter((d) => d.kind === 'videoinput').map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }));
}

function explain(e) {
  const win = window.api.platform === 'win32', mac = window.api.platform === 'darwin';
  if (e.name === 'NotAllowedError' || e.name === 'SecurityError') {
    if (win) return 'Windows is blocking the camera. Open Settings → Privacy & security → Camera, turn on "Camera access" and "Let desktop apps access your camera", then try again.';
    if (mac) return 'macOS is blocking the camera. Open System Settings → Privacy & Security → Camera and turn on EasyAvatar, then restart the app.';
    return 'Camera permission was denied.';
  }
  if (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError') return 'No camera was found. Plug in a webcam (or turn it on) and try again.';
  if (e.name === 'NotReadableError' || e.name === 'TrackStartError' || e.name === 'AbortError') return 'The camera is busy or turned off. Close other apps that use it (Zoom, Teams, OBS, the Camera app…), check any privacy shutter or camera key on your laptop, then try again.';
  return 'Could not open the camera: ' + (e.message || e.name);
}

export async function startCamera(deviceId = preferredCamera()) {
  if (stream) return stream;
  const ok = await window.api.askCamera();
  if (!ok) throw new Error(explain({ name: 'NotAllowedError' }));
  const base = { width: { ideal: 1280 }, height: { ideal: 720 } };
  const tries = [];
  if (deviceId) tries.push({ ...base, deviceId: { exact: deviceId } });
  tries.push({ ...base, facingMode: 'user' }, true);
  let last;
  for (const video of tries) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      const id = stream.getVideoTracks()[0]?.getSettings().deviceId;
      if (id) setPreferredCamera(id);
      return stream;
    } catch (e) {
      last = e;
      console.warn('camera attempt failed', video, e.name, e.message);
      if (e.name === 'NotAllowedError' || e.name === 'SecurityError') break; // retrying won't help
    }
  }
  throw new Error(explain(last));
}

export function currentCameraId() { return stream?.getVideoTracks()[0]?.getSettings().deviceId || ''; }

/** Inspect a frame: 'black', 'blank' (one flat colour, e.g. the green frames of a broken capture path) or 'ok'. */
export function frameState(video) {
  if (!video.videoWidth) return 'none';
  const c = document.createElement('canvas'); c.width = 32; c.height = 18;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(video, 0, 0, 32, 18);
  const d = g.getImageData(0, 0, 32, 18).data;
  const n = d.length / 4;
  let sum = 0, sq = 0;
  for (let i = 0; i < d.length; i += 4) { const l = (d[i] + d[i + 1] + d[i + 2]) / 3; sum += l; sq += l * l; }
  const mean = sum / n, sd = Math.sqrt(Math.max(0, sq / n - mean * mean));
  if (mean < 6) return 'black';
  if (sd < 3.5) return 'blank';
  return 'ok';
}
export const isBlack = (video) => frameState(video) !== 'ok';

export function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
}

export function cameraOn() { return !!stream; }

export async function attach(video, s) {
  if (video.srcObject !== s) video.srcObject = s;
  await video.play().catch(() => {});
  if (video.readyState < 2) await new Promise((r) => video.addEventListener('loadeddata', r, { once: true }));
}

// monotonically increasing timestamps are required by detectForVideo
let lastTs = 0;
export function detect(landmarker, video) {
  let ts = performance.now();
  if (ts <= lastTs) ts = lastTs + 1;
  lastTs = ts;
  return landmarker.detectForVideo(video, ts);
}

export function blendshapeMap(res) {
  const out = {};
  const cats = res?.faceBlendshapes?.[0]?.categories || [];
  for (const c of cats) out[c.categoryName] = c.score;
  return out;
}
