// Live face tracking -> VRM (head pose, blinks, mouth, gaze).
import * as THREE from 'three';
import { detect, blendshapeMap } from './vision.js';

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const remap = (x, a, b) => clamp01((x - a) / (b - a));

export class Tracker {
  constructor() {
    this.running = false;
    this.mirror = true;
    this.state = { rx: 0, ry: 0, rz: 0, blinkL: 0, blinkR: 0, aa: 0, ih: 0, ou: 0, ee: 0, oh: 0, happy: 0, angry: 0, surprised: 0, gx: 0, gy: 0 };
    this.target = { ...this.state };
    this.neutral = new THREE.Quaternion();
    this.lastSeen = 0;
    this._m = new THREE.Matrix4();
    this._e = new THREE.Euler();
    this._q = new THREE.Quaternion();
    this.fps = 0;
  }

  start(video, landmarker) {
    this.video = video; this.landmarker = landmarker; this.running = true;
    let frames = 0, t0 = performance.now(), lastTime = -1;
    const loop = () => {
      if (!this.running) return;
      if (video.readyState >= 2 && video.currentTime !== lastTime) {
        lastTime = video.currentTime;
        try { this.onResult(detect(landmarker, video)); } catch (e) { console.warn(e); }
        frames++;
        const now = performance.now();
        if (now - t0 > 1000) { this.fps = Math.round((frames * 1000) / (now - t0)); frames = 0; t0 = now; }
      }
      requestAnimationFrame(loop);
    };
    loop();
  }

  stop() { this.running = false; }

  recenter() { this.neutral.copy(this._lastRaw || new THREE.Quaternion()).invert(); }

  onResult(res) {
    const data = res.facialTransformationMatrixes?.[0]?.data;
    if (!data) return;
    this.lastSeen = performance.now();
    this._m.fromArray(data);
    this._q.setFromRotationMatrix(this._m);
    this._lastRaw = this._q.clone();
    this._e.setFromQuaternion(this._q.clone().premultiply(this.neutral), 'YXZ');
    const sgn = this.mirror ? 1 : -1;
    const T = this.target;
    T.rx = this._e.x; T.ry = this._e.y * sgn; T.rz = this._e.z * sgn;

    const b = blendshapeMap(res);
    // in mirror mode MediaPipe's "Left" side maps onto the avatar's left eye (screen right)
    const L = this.mirror ? 'Left' : 'Right', R = this.mirror ? 'Right' : 'Left';
    const blink = (side) => remap((b['eyeBlink' + side] || 0) + 0.3 * (b['eyeSquint' + side] || 0), 0.3, 0.62);
    T.blinkL = blink(L); T.blinkR = blink(R);
    if (Math.abs(T.blinkL - T.blinkR) < 0.25) T.blinkL = T.blinkR = Math.max(T.blinkL, T.blinkR); // keep blinks in sync unless it's a clear wink
    const smile = ((b.mouthSmileLeft || 0) + (b.mouthSmileRight || 0)) / 2;
    T.aa = remap(b.jawOpen || 0, 0.05, 0.55);
    T.oh = remap(b.mouthFunnel || 0, 0.1, 0.5);
    T.ou = remap(b.mouthPucker || 0, 0.25, 0.8) * (1 - T.aa * 0.6);
    T.ee = remap(((b.mouthStretchLeft || 0) + (b.mouthStretchRight || 0)) / 2, 0.1, 0.5);
    T.ih = remap(smile, 0.25, 0.7) * (1 - T.aa) * 0.6;
    T.happy = remap(smile, 0.35, 0.8);
    T.angry = remap(((b.browDownLeft || 0) + (b.browDownRight || 0)) / 2, 0.25, 0.65);
    T.surprised = remap((b.browInnerUp || 0) * 0.7 + ((b.browOuterUpLeft || 0) + (b.browOuterUpRight || 0)) * 0.25, 0.3, 0.75);
    const gx = ((b['eyeLookOut' + L] || 0) + (b['eyeLookIn' + R] || 0) - (b['eyeLookIn' + L] || 0) - (b['eyeLookOut' + R] || 0)) / 2;
    const gy = ((b.eyeLookUpLeft || 0) + (b.eyeLookUpRight || 0) - (b.eyeLookDownLeft || 0) - (b.eyeLookDownRight || 0)) / 2;
    T.gx = gx; T.gy = gy;
  }

  /** Apply to a loaded VRM. Call each frame before vrm.update(). Returns false if the face is lost. */
  apply(vrm, dt, manual = null) {
    const lost = performance.now() - this.lastSeen > 600;
    const S = this.state, T = this.target;
    const k = 1 - Math.exp(-dt * 14), kSlow = 1 - Math.exp(-dt * 4);
    for (const key of Object.keys(S)) {
      const tgt = lost ? (key.startsWith('r') ? 0 : 0) : T[key];
      const fast = key.startsWith('blink') || key === 'aa';
      S[key] += (tgt - S[key]) * (lost ? kSlow : fast ? Math.min(1, k * 1.6) : k);
    }
    const h = vrm.humanoid;
    const set = (bone, x, y, z, f) => { const n = h.getNormalizedBoneNode(bone); if (n) n.rotation.set(x * f, y * f, z * f); };
    set('head', S.rx, S.ry, S.rz, 0.65);
    set('neck', S.rx, S.ry, S.rz, 0.35);
    set('spine', 0, S.ry, S.rz, 0.12);

    const em = vrm.expressionManager;
    if (em) {
      const happy = Math.max(S.happy, manual === 'happy' ? 1 : 0);
      const others = { angry: S.angry, sad: 0, relaxed: 0, Surprised: S.surprised };
      if (manual && manual !== 'happy') others[manual] = 1;
      // expressions that already close the eyes partially leave less room for blinks
      const room = 1 - 0.55 * happy - 0.2 * others.angry - 0.15 * others.sad;
      em.setValue('blinkLeft', Math.min(S.blinkL, room));
      em.setValue('blinkRight', Math.min(S.blinkR, room));
      em.setValue('blink', 0);
      em.setValue('aa', S.aa); em.setValue('oh', S.oh * (1 - S.aa * 0.5)); em.setValue('ou', S.ou);
      em.setValue('ee', S.ee * 0.7); em.setValue('ih', S.ih);
      em.setValue('happy', happy);
      for (const [n, v] of Object.entries(others)) em.setValue(n, v);
    }
    if (vrm.lookAt) {
      vrm.lookAt.autoUpdate = false;
      vrm.lookAt.target = null;
      vrm.lookAt.yaw = THREE.MathUtils.clamp(S.gx * 40, -20, 20);
      vrm.lookAt.pitch = THREE.MathUtils.clamp(S.gy * 30, -15, 15);
    }
    return !lost;
  }
}
