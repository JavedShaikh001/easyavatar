// Draws the avatar's texture atlas (and its darker "shade" twin used by the toon shader).
import { adjust, mix, luminance } from './color.js';

export const ATLAS_SIZE = 1024;
const S = ATLAS_SIZE;

// pixel rects
const R = {
  skin: [0, 0, 64, 64], top: [64, 0, 64, 64], bottom: [128, 0, 64, 64], shoe: [192, 0, 64, 64],
  sock: [256, 0, 64, 64], tie: [320, 0, 64, 64], white: [384, 0, 64, 64], inner: [448, 0, 64, 64],
  hair: [512, 0, 64, 512],
  eyeWhite: [0, 512, 256, 256], iris: [256, 512, 256, 256], lash: [512, 512, 256, 256],
  brow: [768, 512, 256, 64], mouth: [768, 576, 256, 128], blush: [768, 704, 128, 64], nose: [896, 704, 64, 64],
};
const SWATCHES = ['skin', 'top', 'bottom', 'shoe', 'sock', 'tie', 'white', 'inner', 'hair'];

export function atlasRects() {
  const out = {};
  for (const [k, [x, y, w, h]] of Object.entries(R)) {
    const inset = SWATCHES.includes(k) ? (k === 'hair' ? [12, 4] : [16, 16]) : [1, 1];
    out[k] = { u0: (x + inset[0]) / S, v0: (y + inset[1]) / S, u1: (x + w - inset[0]) / S, v1: (y + h - inset[1]) / S };
  }
  return out;
}

export function colorsFor(P) {
  const hair = P.hairColor;
  const darkHair = luminance(hair) < 0.12;
  return {
    skin: P.skinColor, top: P.topColor, bottom: P.bottomColor, shoe: P.shoeColor,
    sock: P.sockColor || '#f4f4f4', tie: adjust(P.topColor, { dl: 0.6 }),
    white: '#ffffff', inner: '#3b1219', hair,
    hairHi: darkHair ? mix(hair, '#8aa0c8', 0.35) : adjust(hair, { dl: 1.25, addL: 0.08, ds: 0.9 }),
    brow: adjust(hair, { dl: 0.7 }),
    lash: mix(adjust(hair, { dl: 0.45 }), '#1b1012', 0.6),
    iris: P.eyeColor,
    blush: mix(P.skinColor, '#ff5a78', 0.55),
    nose: adjust(P.skinColor, { dl: 0.72, ds: 1.2 }),
  };
}

function shadeOf(key, c) {
  switch (key) {
    case 'skin': return adjust(c, { dh: -0.015, ds: 1.25, dl: 0.84 });
    case 'hair': case 'hairHi': return adjust(c, { dl: 0.62, ds: 1.1 });
    case 'white': return '#d9dcef';
    case 'brow': case 'lash': case 'nose': case 'inner': return c;
    default: return adjust(c, { dl: 0.72, ds: 1.05 });
  }
}

function almondPath(ctx, x, y, w, h) {
  const m = 0.12;
  const ix = x + w * m, iy = y + h * 0.56, ox = x + w * (1 - m), oy = y + h * 0.46;
  ctx.beginPath();
  ctx.moveTo(ix, iy);
  ctx.bezierCurveTo(x + w * 0.24, y + h * 0.12, x + w * 0.66, y + h * 0.06, ox, oy);
  ctx.bezierCurveTo(x + w * 0.80, y + h * 0.86, x + w * 0.32, y + h * 0.90, ix, iy);
  ctx.closePath();
}

export function drawAtlas(P, { shade = false } = {}) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, S, S);
  const C0 = colorsFor(P);
  const C = {};
  for (const k of Object.keys(C0)) C[k] = shade ? shadeOf(k, C0[k]) : C0[k];

  // solid swatches
  for (const k of ['skin', 'top', 'bottom', 'shoe', 'sock', 'tie', 'white', 'inner']) {
    const [x, y, w, h] = R[k];
    ctx.fillStyle = C[k];
    ctx.fillRect(x, y, w, h);
  }
  // hair: root -> tip gradient with the classic anime highlight ring
  {
    const [x, y, w, h] = R.hair;
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    const base = C.hair;
    g.addColorStop(0, adjust(base, { dl: 0.95 }));
    g.addColorStop(0.16, base);
    if (!shade) {
      g.addColorStop(0.2, C.hairHi);
      g.addColorStop(0.235, C.hairHi);
      g.addColorStop(0.26, base);
    }
    g.addColorStop(0.7, base);
    g.addColorStop(1, adjust(base, { dl: 0.8 }));
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
  }
  // eye white
  {
    const [x, y, w, h] = R.eyeWhite;
    ctx.save();
    almondPath(ctx, x, y, w, h);
    ctx.fillStyle = C.white;
    ctx.fill();
    ctx.clip();
    const g = ctx.createLinearGradient(0, y + h * 0.1, 0, y + h * 0.45);
    g.addColorStop(0, shade ? '#b9bdd8' : '#c9cde6');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
    // lower lash hint near the outer corner
    ctx.strokeStyle = C.lash;
    ctx.lineWidth = w * 0.025;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x + w * 0.62, y + h * 0.79);
    ctx.quadraticCurveTo(x + w * 0.78, y + h * 0.72, x + w * 0.86, y + h * 0.52);
    ctx.stroke();
  }
  // iris
  {
    const [x, y, w, h] = R.iris;
    const cx = x + w / 2, cy = y + h / 2, rx = w * 0.47, ry = h * 0.47;
    ctx.save();
    ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.closePath();
    const g = ctx.createLinearGradient(0, cy - ry, 0, cy + ry);
    g.addColorStop(0, adjust(C.iris, { dl: 0.35 }));
    g.addColorStop(0.45, adjust(C.iris, { dl: 0.85 }));
    g.addColorStop(1, adjust(C.iris, { dl: 1.25, addL: 0.12, ds: 1.1 }));
    ctx.fillStyle = g; ctx.fill();
    ctx.lineWidth = w * 0.05; ctx.strokeStyle = adjust(C.iris, { dl: 0.3 }); ctx.stroke();
    ctx.clip();
    // pupil
    ctx.fillStyle = adjust(C.iris, { dl: 0.18 });
    ctx.beginPath(); ctx.ellipse(cx, cy - h * 0.02, rx * 0.4, ry * 0.5, 0, 0, Math.PI * 2); ctx.fill();
    // lower glow
    ctx.fillStyle = adjust(C.iris, { dl: 1.4, addL: 0.18 });
    ctx.beginPath(); ctx.ellipse(cx, cy + ry * 0.62, rx * 0.55, ry * 0.18, 0, 0, Math.PI * 2); ctx.fill();
    // highlights
    if (!shade) {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.ellipse(cx - rx * 0.32, cy - ry * 0.38, rx * 0.26, ry * 0.2, -0.4, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(cx + rx * 0.35, cy + ry * 0.3, rx * 0.1, ry * 0.08, 0, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }
  // upper lash line, drawn in the same frame as the eye white
  {
    const [x, y, w, h] = R.lash;
    ctx.fillStyle = C.lash;
    ctx.beginPath();
    ctx.moveTo(x + w * 0.10, y + h * 0.58);
    ctx.bezierCurveTo(x + w * 0.22, y + h * 0.08, x + w * 0.66, y + h * 0.0, x + w * 0.90, y + h * 0.40);
    ctx.lineTo(x + w * 0.985, y + h * 0.30); // wing
    ctx.lineTo(x + w * 0.93, y + h * 0.52);
    ctx.bezierCurveTo(x + w * 0.66, y + h * 0.16, x + w * 0.26, y + h * 0.22, x + w * 0.13, y + h * 0.62);
    ctx.closePath();
    ctx.fill();
  }
  // eyebrow: thick inner end (left) tapering to outer end (right)
  {
    const [x, y, w, h] = R.brow;
    ctx.fillStyle = C.brow;
    ctx.beginPath();
    ctx.moveTo(x + w * 0.05, y + h * 0.88);
    ctx.quadraticCurveTo(x + w * 0.45, y + h * 0.02, x + w * 0.96, y + h * 0.62);
    ctx.quadraticCurveTo(x + w * 0.5, y + h * 0.42, x + w * 0.07, y + h * 0.98);
    ctx.closePath();
    ctx.fill();
  }
  // mouth (fully open shape; squashed thin it reads as a closed line)
  {
    const [x, y, w, h] = R.mouth;
    const cx = x + w / 2, cy = y + h / 2;
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(cx, cy, w * 0.44, h * 0.42, 0, 0, Math.PI * 2);
    ctx.fillStyle = shade ? '#3d0f17' : '#5c1a26';
    ctx.fill();
    ctx.clip();
    ctx.fillStyle = shade ? '#a8505a' : '#d8707c';
    ctx.beginPath(); ctx.ellipse(cx, cy + h * 0.36, w * 0.26, h * 0.22, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = shade ? '#e2e2ee' : '#ffffff';
    ctx.fillRect(x, cy - h * 0.48, w, h * 0.16);
    ctx.restore();
  }
  // blush hatching (cut-out friendly)
  {
    const [x, y, w, h] = R.blush;
    ctx.strokeStyle = C.blush; ctx.lineWidth = w * 0.06; ctx.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const bx = x + w * (0.25 + i * 0.22);
      ctx.beginPath(); ctx.moveTo(bx, y + h * 0.75); ctx.lineTo(bx + w * 0.1, y + h * 0.25); ctx.stroke();
    }
  }
  // nose: small soft dash
  {
    const [x, y, w, h] = R.nose;
    ctx.fillStyle = C.nose;
    ctx.beginPath(); ctx.ellipse(x + w * 0.5, y + h * 0.55, w * 0.22, h * 0.11, -0.25, 0, Math.PI * 2); ctx.fill();
  }
  return cv;
}
