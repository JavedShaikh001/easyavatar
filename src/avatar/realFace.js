// Realistic face: the person's own MediaPipe face mesh, textured with their webcam photo.
import { CANON_POS, CANON_UV, CANON_TRIS } from './canonicalFace.js';

export const N_LM = 468;

// Landmark groups (subject's R = -X side, L = +X side, matching the avatar's own left at +X)
export const EYES = {
  R: { upper: [246, 161, 160, 159, 158, 157, 173], lower: [7, 163, 144, 145, 153, 154, 155], crease: [247, 30, 29, 27, 28, 56, 190], ring: [33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7] },
  L: { upper: [466, 388, 387, 386, 385, 384, 398], lower: [249, 390, 373, 374, 380, 381, 382], crease: [467, 260, 259, 257, 258, 286, 414], ring: [263, 466, 388, 387, 386, 385, 384, 398, 362, 382, 381, 380, 374, 373, 390, 249] },
};
export const BROWS = {
  R: { upper: [70, 63, 105, 66, 107], lower: [46, 53, 52, 65, 55], inner: [107, 55, 66, 65] },
  L: { upper: [300, 293, 334, 296, 336], lower: [276, 283, 282, 295, 285], inner: [336, 285, 296, 295] },
};
export const LIPS_INNER = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95];
export const LIPS_OUTER = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146];
export const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];

// Triangles with the inner-lip ring removed so the mouth can open.
const innerSet = new Set(LIPS_INNER);
export const FACE_TRIS = (() => {
  const out = [];
  for (let i = 0; i < CANON_TRIS.length; i += 3) {
    const t = [CANON_TRIS[i], CANON_TRIS[i + 1], CANON_TRIS[i + 2]];
    if (t.every((v) => innerSet.has(v))) continue;
    out.push(...t);
  }
  return out;
})();

export const canonical = () => ({ pos: CANON_POS, uv: CANON_UV });

// ---------- similarity alignment (Horn's quaternion method) ----------
function jacobiEigen4(A) {
  const a = A.map((r) => r.slice());
  const v = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += a[p][q] ** 2;
    if (off < 1e-18) break;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) {
      if (Math.abs(a[p][q]) < 1e-20) continue;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 4; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 4; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 4; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  let best = 0;
  for (let i = 1; i < 4; i++) if (a[i][i] > a[best][best]) best = i;
  return [v[0][best], v[1][best], v[2][best], v[3][best]];
}

/** Find s, R, t minimising |s R src + t - dst|. Points are flat [x,y,z,...] arrays. */
export function alignSimilarity(src, dst) {
  const n = src.length / 3;
  const cs = [0, 0, 0], cd = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) { cs[k] += src[i * 3 + k] / n; cd[k] += dst[i * 3 + k] / n; }
  const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  let ss = 0, sd = 0;
  for (let i = 0; i < n; i++) {
    const a = [0, 1, 2].map((k) => src[i * 3 + k] - cs[k]), b = [0, 1, 2].map((k) => dst[i * 3 + k] - cd[k]);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r][c] += a[r] * b[c];
    ss += a[0] ** 2 + a[1] ** 2 + a[2] ** 2; sd += b[0] ** 2 + b[1] ** 2 + b[2] ** 2;
  }
  const [[Sxx, Sxy, Sxz], [Syx, Syy, Syz], [Szx, Szy, Szz]] = S;
  const Nm = [
    [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
    [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
    [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
    [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz],
  ];
  const [w, x, y, z] = jacobiEigen4(Nm);
  const R = [
    [w * w + x * x - y * y - z * z, 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), w * w - x * x + y * y - z * z, 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), w * w - x * x - y * y + z * z],
  ];
  const s = Math.sqrt(sd / ss);
  const apply = (p) => {
    const q = [p[0] - cs[0], p[1] - cs[1], p[2] - cs[2]];
    return [0, 1, 2].map((r) => s * (R[r][0] * q[0] + R[r][1] * q[1] + R[r][2] * q[2]) + cd[r]);
  };
  return { s, R, apply };
}

/**
 * Webcam landmarks (normalised MediaPipe output) -> personal face shape in the canonical frame (cm).
 * Pose and distance to the camera are removed; only the shape of the face is kept.
 */
export function landmarksToShape(lm, W, H) {
  const src = [];
  for (let i = 0; i < N_LM; i++) src.push(lm[i].x * W, -lm[i].y * H, -lm[i].z * W);
  const { apply } = alignSimilarity(src, CANON_POS);
  const out = [];
  for (let i = 0; i < N_LM; i++) out.push(...apply([src[i * 3], src[i * 3 + 1], src[i * 3 + 2]]).map((v) => Math.round(v * 100) / 100));
  return out;
}

// ---------- textures ----------
const uvPt = (uv, i, S) => [uv[i * 2] * S, uv[i * 2 + 1] * S];
function poly(ctx, uv, idx, S) {
  ctx.beginPath();
  idx.forEach((i, k) => { const [x, y] = uvPt(uv, i, S); if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
  ctx.closePath();
}

/** Painted, mannequin-like face for the realistic style before anyone has scanned. */
export function paintDefaultFace(P, S = 512) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  const uv = CANON_UV;
  ctx.fillStyle = P.skinColor; ctx.fillRect(0, 0, S, S);
  // soft cheek warmth
  for (const i of [205, 425]) {
    const [x, y] = uvPt(uv, i, S);
    const g = ctx.createRadialGradient(x, y, 0, x, y, S * 0.09);
    g.addColorStop(0, 'rgba(220,110,110,0.18)'); g.addColorStop(1, 'rgba(220,110,110,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
  }
  for (const side of ['R', 'L']) {
    const e = EYES[side];
    ctx.save();
    poly(ctx, uv, e.ring, S); ctx.fillStyle = '#f4f1ee'; ctx.fill(); ctx.clip();
    const [cx0, cy0] = uvPt(uv, e.upper[3], S), [cx1, cy1] = uvPt(uv, e.lower[3], S);
    const cx = (cx0 + cx1) / 2, cy = (cy0 + cy1) / 2, r = Math.abs(cy1 - cy0) * 0.62 + S * 0.006;
    ctx.fillStyle = P.eyeColor; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#121014'; ctx.beginPath(); ctx.arc(cx, cy, r * 0.42, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.beginPath(); ctx.arc(cx - r * 0.3, cy - r * 0.3, r * 0.18, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
    poly(ctx, uv, e.upper.concat([...e.crease].reverse()), S); ctx.fillStyle = 'rgba(80,50,45,0.25)'; ctx.fill();
    ctx.strokeStyle = '#3a2826'; ctx.lineWidth = S * 0.006; ctx.beginPath();
    e.upper.forEach((i, k) => { const [x, y] = uvPt(uv, i, S); if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.stroke();
    const b = BROWS[side];
    poly(ctx, uv, b.upper.concat([...b.lower].reverse()), S); ctx.fillStyle = P.hairColor; ctx.globalAlpha = 0.85; ctx.fill(); ctx.globalAlpha = 1;
  }
  poly(ctx, uv, LIPS_OUTER, S); ctx.fillStyle = '#c47a78'; ctx.fill();
  ctx.strokeStyle = '#7a3e40'; ctx.lineWidth = S * 0.004; ctx.beginPath();
  [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308].forEach((i, k) => { const [x, y] = uvPt(uv, i, S); if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y); }); ctx.stroke();
  // nostrils
  ctx.fillStyle = 'rgba(90,50,45,0.45)';
  for (const i of [79, 309]) { const [x, y] = uvPt(uv, i, S); ctx.beginPath(); ctx.ellipse(x, y, S * 0.008, S * 0.005, 0, 0, Math.PI * 2); ctx.fill(); }
  return cv;
}

/** Build the photo texture from a webcam frame: face cut out along the face outline and feathered into the skin colour. */
export function photoFaceTexture(video, lm, skin, S = 512) {
  const W = video.videoWidth || video.width, H = video.videoHeight || video.height;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < N_LM; i++) { const x = lm[i].x * W, y = lm[i].y * H; x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const size = Math.max(x1 - x0, y1 - y0) * 1.12;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const sx = cx - size / 2, sy = cy - size / 2;
  const uv = [];
  for (let i = 0; i < N_LM; i++) uv.push(+(((lm[i].x * W - sx) / size).toFixed(4)), +(((lm[i].y * H - sy) / size).toFixed(4)));

  const photo = document.createElement('canvas'); photo.width = photo.height = S;
  photo.getContext('2d').drawImage(video, sx, sy, size, size, 0, 0, S, S);
  // feathered mask along the face outline, pulled slightly inward
  const mask = document.createElement('canvas'); mask.width = mask.height = S;
  const m = mask.getContext('2d');
  let mx = 0, my = 0;
  FACE_OVAL.forEach((i) => { mx += uv[i * 2] / FACE_OVAL.length; my += uv[i * 2 + 1] / FACE_OVAL.length; });
  m.filter = `blur(${Math.round(S * 0.02)}px)`;
  m.beginPath();
  FACE_OVAL.forEach((i, k) => {
    const x = (mx + (uv[i * 2] - mx) * 0.93) * S, y = (my + (uv[i * 2 + 1] - my) * 0.93) * S;
    if (k) m.lineTo(x, y); else m.moveTo(x, y);
  });
  m.closePath(); m.fillStyle = '#fff'; m.fill();
  const pctx = photo.getContext('2d');
  pctx.globalCompositeOperation = 'destination-in';
  pctx.drawImage(mask, 0, 0);
  const out = document.createElement('canvas'); out.width = out.height = S;
  const o = out.getContext('2d');
  o.fillStyle = skin; o.fillRect(0, 0, S, S);
  o.drawImage(photo, 0, 0);
  return { uv, tex: out.toDataURL('image/jpeg', 0.88) };
}

export function loadImageCanvas(dataUrl, S = 512) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = S || img.naturalWidth; cv.height = S || img.naturalHeight; // S = 0 keeps the picture's own size
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      resolve(cv);
    };
    img.onerror = () => reject(new Error('Could not read the face photo'));
    img.src = dataUrl;
  });
}

export function shadeCanvas(src) {
  const cv = document.createElement('canvas'); cv.width = src.width; cv.height = src.height;
  const c = cv.getContext('2d');
  c.drawImage(src, 0, 0);
  c.globalCompositeOperation = 'multiply';
  c.fillStyle = '#c9a8a0'; c.fillRect(0, 0, cv.width, cv.height);
  return cv;
}

// ---------- expression morphs (in canonical cm units) ----------
export function faceMorphs(pos) {
  const n = pos.length / 3;
  const P = (i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
  const morphs = {};
  const add = (name, i, d) => {
    const m = (morphs[name] ||= new Map());
    const cur = m.get(i) || [0, 0, 0];
    m.set(i, [cur[0] + d[0], cur[1] + d[1], cur[2] + d[2]]);
  };
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const falloff = (name, center, d, r, filter = () => true) => {
    for (let i = 0; i < n; i++) {
      const p = P(i);
      if (!filter(p, i)) continue;
      const w = Math.exp(-((dist(p, center) / r) ** 2));
      if (w > 0.01) add(name, i, [d[0] * w, d[1] * w, d[2] * w]);
    }
  };
  // blinks: upper lid onto lower lid, crease follows halfway
  for (const [side, name] of [['L', 'blinkL'], ['R', 'blinkR']]) {
    const e = EYES[side];
    e.upper.forEach((u, j) => {
      const a = P(u), b = P(e.lower[j]);
      add(name, u, [(b[0] - a[0]) * 0.9, (b[1] - a[1]) * 0.9 + 0.02, (b[2] - a[2]) * 0.9 + 0.05]);
      const c = e.crease[j], cp = P(c);
      add(name, c, [(b[0] - cp[0]) * 0.35, (b[1] - cp[1]) * 0.35, 0]);
    });
  }
  const top = P(13), bot = P(14), mouthY = (top[1] + bot[1]) / 2;
  const cR = P(61), cL = P(291), halfW = Math.abs(cL[0] - cR[0]) / 2;
  const chin = P(152);
  // jaw drop: everything below the lip line, fading out sideways past the mouth corners
  const jaw = (name, amount) => {
    for (let i = 0; i < n; i++) {
      const p = P(i);
      if (p[1] >= mouthY) continue;
      const down = Math.min(1, (mouthY - p[1]) / 0.5);
      const side = Math.exp(-((Math.max(0, Math.abs(p[0]) - halfW * 0.8) / 3.2) ** 2));
      const belowChinFade = p[1] < chin[1] - 0.5 ? 0.6 : 1;
      const w = down * side * belowChinFade;
      if (w > 0.01) add(name, i, [0, -amount * w, -amount * 0.25 * w]);
    }
  };
  const corners = (name, dx, dy, r = 1.4) => {
    falloff(name, cL, [dx, dy, 0], r);
    falloff(name, cR, [-dx, dy, 0], r);
  };
  jaw('mouthA', 1.5); corners('mouthA', -0.15, -0.1);
  jaw('mouthO', 0.9); corners('mouthO', -0.55, 0);
  jaw('mouthU', 0.35); corners('mouthU', -0.75, 0.05);
  jaw('mouthI', 0.25); corners('mouthI', 0.3, 0.05);
  jaw('mouthE', 0.6); corners('mouthE', 0.2, 0);
  corners('smile', 0.3, 0.45, 1.6);
  corners('frown', 0.05, -0.35, 1.4);
  for (const side of ['L', 'R']) {
    const b = BROWS[side];
    const eyeTop = P(EYES[side].upper[3])[1];
    const aboveEye = (p) => p[1] > eyeTop + 0.15;
    for (const i of b.upper.concat(b.lower)) falloff('browUp', P(i), [0, 0.45, 0], 1.1, aboveEye);
    for (const i of b.inner) falloff('browAngry', P(i), [side === 'L' ? -0.12 : 0.12, -0.35, 0.05], 0.9, aboveEye);
    for (const i of b.inner) falloff('browSad', P(i), [0, 0.38, 0], 0.9, aboveEye);
  }
  // normalise accumulated weights from overlapping falloffs
  for (const name of ['browUp', 'browAngry', 'browSad']) {
    const m = morphs[name]; if (!m) continue;
    const cap = name === 'browUp' ? 0.5 : 0.4;
    for (const [i, d] of m) { const l = Math.hypot(...d); if (l > cap) m.set(i, d.map((v) => (v * cap) / l)); }
  }
  return morphs;
}
