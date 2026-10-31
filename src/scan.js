// Turn a few webcam frames into avatar parameters: face proportions + colours.
import { detect, blendshapeMap } from './vision.js';
import { rgbToHsl, hslToRgb, rgbToHex } from './avatar/color.js';
import { landmarksToShape, photoFaceTexture } from './avatar/realFace.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const median = (arr) => { if (!arr.length) return NaN; const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

// map a measurement onto a 0..1 slider, exaggerated a little so likeness reads in a stylised face
const toSlider = (v, lo, hi, exag = 1.35) => clamp(0.5 + ((v - lo) / (hi - lo) - 0.5) * exag, 0.05, 0.95);

function measure(lm, W, H) {
  const P = (i) => [lm[i].x * W, lm[i].y * H, lm[i].z * W];
  const d = (a, b) => { const p = P(a), q = P(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
  // 2D face frame so head roll doesn't skew angles
  const o = P(10), r = P(454), l = P(234);
  let xa = [r[0] - l[0], r[1] - l[1]]; const xl = Math.hypot(...xa); xa = [xa[0] / xl, xa[1] / xl];
  const ya = [-xa[1], xa[0]];
  const F = (i) => { const p = P(i); const v = [p[0] - o[0], p[1] - o[1]]; return [v[0] * xa[0] + v[1] * xa[1], v[0] * ya[0] + v[1] * ya[1]]; };
  const ang = (inner, outer) => { const a = F(inner), b = F(outer); return Math.atan2(a[1] - b[1], Math.abs(a[0] - b[0])) * 180 / Math.PI; };

  const fw = d(234, 454), fl = d(10, 152);
  const eyeWR = d(33, 133), eyeWL = d(362, 263);
  const eyeC = (F(33)[1] + F(133)[1] + F(362)[1] + F(263)[1]) / 4;
  return {
    faceRatio: fl / fw,
    jaw: d(172, 397) / fw,
    chin: d(17, 152) / fl,
    eyeSize: (eyeWR + eyeWL) / 2 / fw,
    eyeOpen: (d(159, 145) / eyeWR + d(386, 374) / eyeWL) / 2,
    eyeSpacing: d(133, 362) / fw,
    eyeTilt: (ang(133, 33) + ang(362, 263)) / 2,
    eyeY: eyeC / fl,
    browHeight: (d(105, 159) + d(334, 386)) / 2 / fl,
    browThick: (d(105, 52) + d(334, 282)) / 2 / fl,
    browAngle: (ang(107, 70) + ang(336, 300)) / 2,
    nose: d(168, 2) / fl,
    mouthWidth: d(61, 291) / fw,
    mouthY: F(13)[1] / fl,
    fw, fl,
  };
}

function samplePixels(ctx, W, H, pts, radius) {
  const out = [];
  const r = Math.max(2, Math.round(radius));
  for (const [cx, cy] of pts) {
    const x0 = Math.round(cx - r), y0 = Math.round(cy - r);
    if (x0 < 0 || y0 < 0 || x0 + 2 * r >= W || y0 + 2 * r >= H) continue;
    const data = ctx.getImageData(x0, y0, 2 * r, 2 * r).data;
    for (let y = 0; y < 2 * r; y += 2) for (let x = 0; x < 2 * r; x += 2) {
      if ((x - r) ** 2 + (y - r) ** 2 > r * r) continue;
      const k = (y * 2 * r + x) * 4;
      out.push([data[k], data[k + 1], data[k + 2]]);
    }
  }
  return out;
}
const lum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
function robustColor(px, lo = 0.15, hi = 0.85) {
  if (!px.length) return null;
  const s = [...px].sort((a, b) => lum(a) - lum(b));
  const mid = s.slice(Math.floor(s.length * lo), Math.max(Math.floor(s.length * lo) + 1, Math.floor(s.length * hi)));
  return [0, 1, 2].map((c) => median(mid.map((p) => p[c])));
}
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// Webcam colours -> friendly anime palette. Keeps hue and relative darkness.
function animeSkin(rgb) {
  let [h, s, l] = rgbToHsl(rgb);
  if (h > 0.13 && h < 0.92) h = 0.06; // white-balance gone wrong: fall back to a warm hue
  return rgbToHex(hslToRgb([h, clamp(s * 0.85, 0.12, 0.6), clamp(0.2 + l * 0.85, 0.25, 0.93)]));
}
function animeHair(rgb) {
  let [h, s, l] = rgbToHsl(rgb);
  if (l < 0.13) { l = 0.14; s = Math.max(s, 0.15); }
  return rgbToHex(hslToRgb([h, clamp(s * 1.2, 0, 0.85), clamp(l * 1.05, 0.12, 0.85)]));
}
function animeEye(rgb) {
  const [h, s, l] = rgbToHsl(rgb);
  return rgbToHex(hslToRgb([h, clamp(Math.max(s * 1.4, 0.35), 0, 0.85), clamp(0.25 + l * 0.9, 0.3, 0.6)]));
}

export async function scanFace(video, landmarker, { frames = 20, onProgress = () => {} } = {}) {
  const W = video.videoWidth, H = video.videoHeight;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const samples = [], skinPx = [], hairPx = [], eyePx = [];
  let turned = 0, missing = 0;
  // best (most frontal, eyes open, mouth closed) frame for the realistic face
  const bestCv = document.createElement('canvas'); bestCv.width = W; bestCv.height = H;
  let best = null;

  for (let i = 0; i < frames + 30 && samples.length < frames; i++) {
    await new Promise((r) => requestAnimationFrame(r));
    const res = detect(landmarker, video);
    const lm = res.faceLandmarks?.[0];
    if (!lm) { missing++; onProgress(samples.length / frames, 'Looking for your face…'); continue; }
    const m = res.facialTransformationMatrixes?.[0]?.data;
    let yaw = 0, pitch = 0;
    if (m) {
      yaw = Math.asin(clamp(m[8], -1, 1)) * 180 / Math.PI; pitch = Math.asin(clamp(-m[9], -1, 1)) * 180 / Math.PI;
      if (Math.abs(yaw) > 14 || Math.abs(pitch) > 16) { turned++; onProgress(samples.length / frames, 'Please look straight at the camera'); continue; }
    }
    const bs = blendshapeMap(res);
    const mm = measure(lm, W, H);
    const blinking = (bs.eyeBlinkLeft || 0) > 0.35 || (bs.eyeBlinkRight || 0) > 0.35;
    const talking = (bs.jawOpen || 0) > 0.15;
    samples.push({ ...mm, blinking, talking });
    const score = Math.abs(yaw) + Math.abs(pitch) + (blinking ? 30 : 0) + (talking ? 20 : 0) + ((bs.mouthSmileLeft || 0) + (bs.mouthSmileRight || 0)) * 10;
    if (!best || score < best.score) {
      best = { score, lm: lm.map((p) => ({ x: p.x, y: p.y, z: p.z })) };
      bestCv.getContext('2d').drawImage(video, 0, 0, W, H);
    }
    onProgress(samples.length / frames, 'Hold still…');

    if (samples.length % 4 === 1) {
      ctx.drawImage(video, 0, 0, W, H);
      const px = (k) => [lm[k].x * W, lm[k].y * H];
      skinPx.push(...samplePixels(ctx, W, H, [50, 280, 151, 101, 330].map(px), mm.fw * 0.035));
      // hair: just above the hairline and at the temples
      const up = (k, f, side = 0) => {
        const p = px(k), c = px(152), t = px(10);
        const v = [t[0] - c[0], t[1] - c[1]], n = Math.hypot(...v);
        const s = [px(454)[0] - px(234)[0], px(454)[1] - px(234)[1]], sn = Math.hypot(...s);
        return [p[0] + (v[0] / n) * f * mm.fl + (s[0] / sn) * side * mm.fw, p[1] + (v[1] / n) * f * mm.fl + (s[1] / sn) * side * mm.fw];
      };
      hairPx.push(...samplePixels(ctx, W, H, [up(10, 0.07), up(10, 0.11), up(10, 0.08, -0.22), up(10, 0.08, 0.22), up(54, 0.05, -0.06), up(284, 0.05, 0.06)], mm.fw * 0.04));
      for (const [c, ring] of [[468, [469, 470, 471, 472]], [473, [474, 475, 476, 477]]]) {
        if (!lm[c]) continue;
        const cc = px(c);
        const rad = median(ring.map((k) => Math.hypot(px(k)[0] - cc[0], px(k)[1] - cc[1])));
        const ringPts = [];
        for (let a = 0; a < 8; a++) ringPts.push([cc[0] + Math.cos(a * Math.PI / 4) * rad * 0.62, cc[1] + Math.sin(a * Math.PI / 4) * rad * 0.62]);
        eyePx.push(...samplePixels(ctx, W, H, ringPts, Math.max(2, rad * 0.22)));
      }
    }
  }
  if (samples.length < Math.min(6, frames)) {
    if (turned > missing) throw new Error('Please face the camera straight on and try again.');
    throw new Error("We couldn't see your face clearly. Move into better light and fill the oval.");
  }

  const pick = (key, filter = () => true) => median(samples.filter(filter).map((s) => s[key]));
  const notBlink = (s) => !s.blinking, notTalk = (s) => !s.talking;
  const faceLength = toSlider(pick('faceRatio'), 1.05, 1.4);
  const patch = {
    faceLength,
    faceWidth: clamp(0.5 + (0.5 - faceLength) * 0.4, 0.1, 0.9),
    jaw: toSlider(pick('jaw'), 0.7, 0.92),
    chin: toSlider(pick('chin', notTalk), 0.17, 0.27),
    eyeSize: toSlider(pick('eyeSize'), 0.18, 0.25),
    eyeOpen: toSlider(pick('eyeOpen', notBlink) || pick('eyeOpen'), 0.2, 0.4),
    eyeSpacing: toSlider(pick('eyeSpacing'), 0.2, 0.3),
    eyeTilt: toSlider(pick('eyeTilt'), -6, 10, 1.2),
    eyeY: 1 - toSlider(pick('eyeY'), 0.33, 0.45),
    browHeight: toSlider(pick('browHeight'), 0.07, 0.14),
    browThickness: toSlider(pick('browThick'), 0.018, 0.04),
    browAngle: toSlider(pick('browAngle'), -8, 14, 1.2),
    noseLength: toSlider(pick('nose'), 0.3, 0.4),
    mouthWidth: toSlider(pick('mouthWidth', notTalk), 0.32, 0.48),
    mouthY: toSlider(pick('mouthY', notTalk), 0.66, 0.78),
  };
  for (const k of Object.keys(patch)) if (!Number.isFinite(patch[k])) delete patch[k];

  const skin = robustColor(skinPx);
  if (skin) patch.skinColor = animeSkin(skin);
  if (hairPx.length && skin) {
    const notSkin = hairPx.filter((p) => dist3(p, skin) > 38);
    const hair = robustColor(notSkin.length > hairPx.length * 0.3 ? notSkin : hairPx, 0.1, 0.7);
    if (hair) patch.hairColor = animeHair(hair);
  }
  const eye = robustColor(eyePx, 0.2, 0.8);
  if (eye) patch.eyeColor = animeEye(eye);
  // realistic style: the face's own 3D shape + photo texture (kept only on this computer / in your files)
  if (best) {
    const skinHex = skin ? rgbToHex(skin) : '#d9b39a';
    const { uv, tex } = photoFaceTexture(bestCv, best.lm, skinHex);
    patch.faceScan = { lm: landmarksToShape(best.lm, W, H), uv, tex, skin: skinHex };
  }
  return patch;
}
