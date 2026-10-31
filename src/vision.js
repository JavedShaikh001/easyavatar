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
      const model = await window.api.getModel();
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

export async function startCamera() {
  if (stream) return stream;
  const ok = await window.api.askCamera();
  if (!ok) throw new Error('Camera permission was denied. Allow EasyAvatar to use the camera in your system settings.');
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: false });
  } catch (e) {
    if (e.name === 'NotFoundError') throw new Error('No camera was found. Plug in a webcam and try again.');
    if (e.name === 'NotReadableError') throw new Error('The camera is busy. Close other apps that use it (Zoom, Teams, OBS…) and try again.');
    throw new Error('Could not open the camera: ' + e.message);
  }
  return stream;
}

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
