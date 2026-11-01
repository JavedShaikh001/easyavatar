// Procedural anime-style humanoid: skeleton, skinned body/hair/clothes, and a
// face mesh with expression morph targets. Built in design space (metres,
// Y up, facing +Z); `realize()` turns it into THREE objects for any facing.
import * as THREE from 'three';
import { MeshBuilder, loft, sphereGrid, FrontZMap, lerp, clamp, smooth, V, rectUV } from './geom.js';
import { atlasRects } from './atlas.js';
import { CANON_POS, CANON_UV } from './canonicalFace.js';
import { FACE_TRIS, faceMorphs, EYES } from './realFace.js';

const EYE_HOLE = new Set([...EYES.L.ring, ...EYES.R.ring]);

export const MORPHS = [
  'blinkL', 'blinkR', 'mouthA', 'mouthI', 'mouthU', 'mouthE', 'mouthO', 'smile', 'frown',
  'browUp', 'browAngry', 'browSad', 'lookLeft', 'lookRight', 'lookUp', 'lookDown',
];

// VRM humanoid bone -> our bone name
export const HUMAN_BONES = {
  hips: 'Hips', spine: 'Spine', chest: 'Chest', upperChest: 'UpperChest', neck: 'Neck', head: 'Head',
  leftShoulder: 'LeftShoulder', leftUpperArm: 'LeftUpperArm', leftLowerArm: 'LeftLowerArm', leftHand: 'LeftHand',
  rightShoulder: 'RightShoulder', rightUpperArm: 'RightUpperArm', rightLowerArm: 'RightLowerArm', rightHand: 'RightHand',
  leftUpperLeg: 'LeftUpperLeg', leftLowerLeg: 'LeftLowerLeg', leftFoot: 'LeftFoot', leftToes: 'LeftToes',
  rightUpperLeg: 'RightUpperLeg', rightLowerLeg: 'RightLowerLeg', rightFoot: 'RightFoot', rightToes: 'RightToes',
  leftEye: 'LeftEye', rightEye: 'RightEye',
};
export const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'];
export const PHALANGES = ['Proximal', 'Intermediate', 'Distal'];
for (const side of ['Left', 'Right']) for (const f of FINGERS) for (const ph of PHALANGES) {
  HUMAN_BONES[`${side.toLowerCase()}${f}${ph}`] = `${side}${f}${ph}`;
}

const DEG = Math.PI / 180;

export function describeAvatar(P) {
  const R = atlasRects();
  const b = P.build;
  const real = P.style === 'real';
  const hs = lerp(0.9, 1.2, P.headSize);
  const L = real ? lerp(0.76, 0.88, P.legs) : lerp(0.7, 0.82, P.legs);
  const scale = real ? lerp(0.98, 1.16, P.height) : lerp(0.88, 1.12, P.height);

  // ---------- skeleton ----------
  const bones = [], bi = {};
  const bone = (name, parent, pos) => { bi[name] = bones.length; bones.push({ name, parent, pos }); };
  const Y = { hips: L + 0.05, spine: L + 0.13, chest: L + 0.24, upperChest: L + 0.33, neck: L + 0.445 };
  Y.head = Y.neck + 0.065;
  const shY = L + 0.405, shX = lerp(0.128, 0.162, b), upLen = 0.25, loLen = 0.235;
  const legX = lerp(0.08, 0.088, b), kneeY = L * 0.52, ankleY = 0.072;
  const wristX = shX + upLen + loLen;
  const armScale = lerp(0.9, 1.08, b);
  // finger layout for a palm-down T-pose hand: joints (proximal, intermediate, distal, tip) and radius
  const fingerDefs = (sx) => {
    const k = armScale, y = shY - 0.003, z0 = -0.008;
    const out = [];
    for (const [name, z, ls, r, kx] of [['Index', 0.025, 0.93, 0.0082, 0.06], ['Middle', 0.008, 1, 0.0085, 0.062], ['Ring', -0.009, 0.95, 0.008, 0.06], ['Little', -0.025, 0.76, 0.0068, 0.055]]) {
      const x0 = wristX + kx * k, L1 = 0.03 * ls * k, L2 = 0.022 * ls * k, L3 = 0.019 * ls * k;
      const zz = z0 + z * k;
      out.push({ name, r: r * k, joints: [[sx * x0, y, zz], [sx * (x0 + L1), y, zz], [sx * (x0 + L1 + L2), y, zz], [sx * (x0 + L1 + L2 + L3), y, zz]] });
    }
    const base = [sx * (wristX + 0.014 * k), shY - 0.009, z0 + 0.024 * k];
    const d = V.norm([sx * 0.78, -0.22, 0.58]);
    const tj = [0, 0.032, 0.058, 0.08].map((t) => V.add(base, V.mul(d, t * k)));
    out.unshift({ name: 'Thumb', r: 0.0105 * k, joints: tj });
    return out;
  };

  bone('Hips', null, [0, Y.hips, 0]);
  bone('Spine', 'Hips', [0, Y.spine, -0.005]);
  bone('Chest', 'Spine', [0, Y.chest, -0.005]);
  bone('UpperChest', 'Chest', [0, Y.upperChest, -0.01]);
  bone('Neck', 'UpperChest', [0, Y.neck, -0.01]);
  bone('Head', 'Neck', [0, Y.head, 0]);
  for (const [side, sx] of [['Left', 1], ['Right', -1]]) {
    bone(side + 'Shoulder', 'UpperChest', [sx * 0.03, shY + 0.005, -0.01]);
    bone(side + 'UpperArm', side + 'Shoulder', [sx * shX, shY, -0.01]);
    bone(side + 'LowerArm', side + 'UpperArm', [sx * (shX + upLen), shY, -0.01]);
    bone(side + 'Hand', side + 'LowerArm', [sx * wristX, shY, -0.01]);
    for (const fd of fingerDefs(sx)) fd.joints.slice(0, 3).forEach((p, j) => bone(side + fd.name + PHALANGES[j], j ? side + fd.name + PHALANGES[j - 1] : side + 'Hand', p));
    bone(side + 'UpperLeg', 'Hips', [sx * legX, L, 0]);
    bone(side + 'LowerLeg', side + 'UpperLeg', [sx * legX * 0.96, kneeY, 0.005]);
    bone(side + 'Foot', side + 'LowerLeg', [sx * legX * 0.92, ankleY, -0.005]);
    bone(side + 'Toes', side + 'Foot', [sx * legX * 0.92, 0.02, 0.095]);
  }

  const W = (name, w = 1) => [bi[name], w];
  const blend = (a, c, t) => [[bi[a], 1 - t], [bi[c], t]];
  const chainY = (y, chain) => {
    if (y <= chain[0][1]) return [W(chain[0][0])];
    for (let i = 0; i < chain.length - 1; i++) {
      const [n0, y0] = chain[i], [n1, y1] = chain[i + 1];
      if (y <= y1) return blend(n0, n1, smooth(y0, y1, y));
    }
    return [W(chain[chain.length - 1][0])];
  };
  const interp = (table, x) => {
    if (x <= table[0][0]) return table[0].slice(1);
    for (let i = 0; i < table.length - 1; i++) {
      const a = table[i], c = table[i + 1];
      if (x <= c[0]) {
        const t = (x - a[0]) / (c[0] - a[0]);
        return a.slice(1).map((v, k) => lerp(v, c[k + 1], t));
      }
    }
    return table[table.length - 1].slice(1);
  };
  // sections across clothing boundaries: duplicated rings give a crisp colour edge + small hem lip
  const banded = (ts, bounds, regionAt, mk) => {
    const all = [...new Set([...ts, ...bounds])].sort((x, y) => x - y);
    const out = [];
    for (const t of all) {
      if (bounds.includes(t)) {
        const r0 = regionAt(t - 1e-4), r1 = regionAt(t + 1e-4);
        out.push(mk(t, r0, r0 !== 'skin' && r1 === 'skin' ? 1.05 : 1));
        out.push(mk(t, r1, r1 !== 'skin' && r0 === 'skin' ? 1.05 : 1));
      } else out.push(mk(t, regionAt(t), 1));
    }
    return out;
  };
  const range = (a, c, step) => { const r = []; for (let x = a; x < c - 1e-6; x += step) r.push(+x.toFixed(5)); r.push(c); return r; };
  const clothScale = (region) => (region === 'skin' ? 1 : region === 'sock' ? 1.015 : 1.035);

  const body = new MeshBuilder('Body');
  const face = new MeshBuilder('Face');
  MORPHS.forEach((m) => face.declareMorph(m));

  // ---------- torso ----------
  const prof = [ // y, half-width, front depth, back depth, superellipse p
    [L - 0.045, 0.07, 0.055, 0.06, 2.2],
    [L + 0.02, lerp(0.152, 0.138, b), 0.085, 0.098, 2.4],
    [L + 0.10, lerp(0.145, 0.134, b), 0.08, 0.088, 2.4],
    [L + 0.18, lerp(0.112, 0.128, b), 0.072, 0.07, 2.4],
    [L + 0.27, lerp(0.128, 0.145, b), lerp(0.106, 0.088, b), 0.078, 2.4],
    [L + 0.34, lerp(0.132, 0.158, b), 0.084, 0.074, 2.6],
    [L + 0.395, lerp(0.128, 0.152, b), 0.062, 0.062, 3.0],
    [L + 0.435, 0.082, 0.05, 0.052, 2.4],
    [L + 0.462, 0.046, 0.04, 0.042, 2],
  ];
  const waistY = L + 0.15;
  const topEnd = P.top === 'tank' ? L + 0.385 : L + 0.44;
  const torsoChain = [['Hips', Y.hips], ['Spine', Y.spine], ['Chest', Y.chest], ['UpperChest', Y.upperChest], ['Neck', Y.neck]];
  const torsoW = (pt) => {
    const base = chainY(pt[1], torsoChain);
    const ws = smooth(0.07, 0.125, Math.abs(pt[0])) * smooth(L + 0.30, L + 0.37, pt[1]);
    if (ws <= 0) return base;
    return [...base.map(([i, w]) => [i, w * (1 - ws)]), W((pt[0] > 0 ? 'Left' : 'Right') + 'Shoulder', ws)];
  };
  const torsoRegion = (y) => (y < waistY ? 'bottom' : y < topEnd ? 'top' : 'skin');
  loft(body, banded(range(L - 0.045, L + 0.462, 0.02), [waistY, topEnd], torsoRegion, (y, region, lip) => {
    const [w, df, db, p] = interp(prof, y);
    const sc = lip * clothScale(region);
    return { c: [0, y, 0], n: [0, 0, 1], w: w * sc, df: df * sc, db: db * sc, p, wt: torsoW, rect: R[region] };
  }), { seg: 28, capStart: true });

  // ---------- neck ----------
  loft(body, [
    [Y.neck - 0.035, 0.043], [Y.neck + 0.02, 0.037], [Y.head + 0.04, 0.034],
  ].map(([y, r]) => ({
    c: [0, y, -0.008], n: [0, 0, 1], w: r, df: r * 0.95, db: r, rect: R.skin,
    wt: (pt) => chainY(pt[1], [['UpperChest', Y.neck - 0.04], ['Neck', Y.neck + 0.01], ['Head', Y.head + 0.02]]),
  })), { seg: 16 });

  // ---------- arms & hands ----------
  const armTable = [
    [0.085, 0.05], [shX - 0.01, 0.046], [shX + 0.06, 0.042], [shX + 0.13, 0.038], [shX + upLen - 0.005, 0.032],
    [shX + upLen + 0.05, 0.034], [shX + upLen + 0.14, 0.03], [wristX, 0.025],
  ];
  const sleeveEnd = P.top === 'tshirt' ? shX + 0.12 : P.top === 'long' ? wristX - 0.015 : -1;
  for (const [sd, sx] of [['Left', 1], ['Right', -1]]) {
    const armW = (pt) => {
      const x = Math.abs(pt[0]), ex = shX + upLen;
      if (x < shX - 0.03) return [W(sd + 'Shoulder')];
      if (x < shX + 0.03) return blend(sd + 'Shoulder', sd + 'UpperArm', smooth(shX - 0.03, shX + 0.03, x));
      if (x < ex - 0.03) return [W(sd + 'UpperArm')];
      if (x < ex + 0.03) return blend(sd + 'UpperArm', sd + 'LowerArm', smooth(ex - 0.03, ex + 0.03, x));
      if (x < wristX - 0.015) return [W(sd + 'LowerArm')];
      return blend(sd + 'LowerArm', sd + 'Hand', smooth(wristX - 0.015, wristX + 0.01, x));
    };
    const region = (x) => (x < sleeveEnd ? 'top' : 'skin');
    const ts = armTable.map((a) => a[0]);
    loft(body, banded(ts, sleeveEnd > 0 ? [sleeveEnd] : [], region, (x, rg, lip) => {
      const r = interp(armTable, x)[0] * armScale * lip * (rg === 'top' && x > shX - 0.02 ? 1.12 : 1);
      return { c: [sx * x, shY, -0.01], n: [0, 1, 0], w: r, df: r * 0.92, db: r * 0.92, wt: armW, rect: R[rg] };
    }), { seg: 14 });

    // palm (palm down) + five jointed fingers
    const handW = (pt) => (Math.abs(pt[0]) < wristX + 0.008 ? blend(sd + 'LowerArm', sd + 'Hand', 0.7) : [W(sd + 'Hand')]);
    loft(body, [
      [0, 0.026, 0.02, 0.019], [0.022, 0.036, 0.019, 0.017], [0.045, 0.04, 0.016, 0.014], [0.064, 0.037, 0.012, 0.011],
    ].map(([dx, w, up, dn]) => ({
      c: [sx * (wristX + dx * armScale), shY - 0.002, -0.008], n: [0, 1, 0], w: w * armScale, df: up * armScale, db: dn * armScale, wt: handW, rect: R.skin,
    })), { seg: 12, capEnd: true, capExt: 0.005 });
    for (const fd of fingerDefs(sx)) {
      const names = PHALANGES.map((ph) => sd + fd.name + ph);
      const J = fd.joints;
      const dir = V.norm(V.sub(J[3], J[0]));
      const along = (q) => V.dot(V.sub(q, J[0]), dir);
      const t1 = along(J[1]), t2 = along(J[2]), bw = 0.004;
      const segW = (p) => {
        const a = along(p);
        if (a < 0) return blend(sd + 'Hand', names[0], 0.5);
        if (a < t1 - bw) return [W(names[0])];
        if (a < t1 + bw) return blend(names[0], names[1], (a - (t1 - bw)) / (2 * bw));
        if (a < t2 - bw) return [W(names[1])];
        if (a < t2 + bw) return blend(names[1], names[2], (a - (t2 - bw)) / (2 * bw));
        return [W(names[2])];
      };
      const back = V.sub(J[0], V.mul(dir, fd.name === 'Thumb' ? 0.012 : 0.008));
      const mid = (a, c, t) => V.add(V.mul(a, 1 - t), V.mul(c, t));
      const pts = [[back, 1.05], [J[0], 1], [mid(J[0], J[1], 0.5), 0.95], [J[1], 0.92], [J[2], 0.86], [mid(J[2], J[3], 0.6), 0.8], [J[3], 0.7]];
      loft(body, pts.map(([c, k]) => ({ c, n: [0, 1, 0], w: fd.r * k, df: fd.r * k * 0.85, db: fd.r * k * 0.8, wt: segW, rect: R.skin })),
        { seg: 8, capEnd: true, capExt: fd.r * 0.6 });
    }
  }

  // ---------- legs ----------
  const legScale = lerp(1.04, 0.97, b);
  const legTable = [
    [L + 0.07, 0.078], [L - 0.01, 0.086], [L - 0.15, 0.073], [kneeY + 0.03, 0.054], [kneeY - 0.02, 0.052],
    [kneeY - 0.12, 0.057], [ankleY + 0.06, 0.037], [ankleY + 0.01, 0.033], [0.035, 0.033],
  ];
  // legs are lofted by "drop" = (L + 0.07) - y so the parameter increases along the leg
  const top = L + 0.07;
  let legBounds, legRegion;
  const hem = { pants: ankleY + 0.045, shorts: L - 0.16 };
  if (P.bottom === 'pants') {
    legRegion = (y) => (y > hem.pants ? 'bottom' : P.socks ? 'sock' : 'skin');
    legBounds = P.socks ? [] : [hem.pants];
  } else if (P.bottom === 'shorts') {
    const sockTop = ankleY + 0.06;
    legRegion = (y) => (y > hem.shorts ? 'bottom' : P.socks && y < sockTop ? 'sock' : 'skin');
    legBounds = [hem.shorts].concat(P.socks ? [sockTop] : []);
  } else {
    const sockTop = kneeY - 0.035;
    legRegion = (y) => (P.socks && y < sockTop ? 'sock' : 'skin');
    legBounds = P.socks ? [sockTop] : [];
  }
  for (const [sd, sx] of [['Left', 1], ['Right', -1]]) {
    const legW = (pt) => {
      const y = pt[1];
      if (y > L - 0.01) return blend('Hips', sd + 'UpperLeg', smooth(L + 0.07, L - 0.01, y));
      if (y > kneeY + 0.035) return [W(sd + 'UpperLeg')];
      if (y > kneeY - 0.035) return blend(sd + 'UpperLeg', sd + 'LowerLeg', smooth(kneeY + 0.035, kneeY - 0.035, y));
      if (y > ankleY + 0.04) return [W(sd + 'LowerLeg')];
      return blend(sd + 'LowerLeg', sd + 'Foot', smooth(ankleY + 0.04, ankleY, y));
    };
    const ts = legTable.map((a) => +(top - a[0]).toFixed(5));
    const bs = legBounds.map((y) => +(top - y).toFixed(5));
    loft(body, banded(ts, bs, (t) => {
      const rg = legRegion(top - t);
      // the extra 1e-4 in banded() flips sign because t = top - y
      return rg;
    }, (t, rg, lip) => {
      const y = top - t;
      const r = interp(legTable.map(([yy, rr]) => [top - yy, rr]), t)[0] * legScale * lip * clothScale(rg) * (rg === 'bottom' ? 1.02 : 1);
      const x = sx * lerp(legX, legX * 0.92, smooth(L, ankleY, y));
      return { c: [x, y, 0], n: [0, 0, 1], w: r, df: r, db: r, wt: legW, rect: R[rg] };
    }), { seg: 16 });

    // shoe
    const fx = sx * legX * 0.92;
    const shoeW = (pt) => blend(sd + 'Foot', sd + 'Toes', smooth(0.065, 0.11, pt[2]));
    loft(body, [
      [-0.05, 0.034, 0.028, 0.026, 0.04], [-0.01, 0.04, 0.05, 0.035, 0.05], [0.05, 0.044, 0.032, 0.03, 0.033],
      [0.11, 0.04, 0.022, 0.022, 0.025], [0.145, 0.024, 0.012, 0.014, 0.02],
    ].map(([z, w, up, dn, cy]) => ({ c: [fx, cy, z], n: [0, 1, 0], w, df: up, db: dn, p: 2.3, wt: shoeW, rect: R.shoe })),
    { seg: 16, capStart: true, capEnd: true, capExt: 0.008 });
  }

  // ---------- skirt ----------
  if (P.bottom === 'skirt') {
    const hemY = L - 0.17;
    const [w0, df0, db0] = interp(prof, L + 0.155);
    const skirtW = (pt) => {
      const f = smooth(L + 0.1, hemY, pt[1]);
      const sideL = smooth(-0.06, 0.06, pt[0]);
      return [[bi.Hips, 1 - 0.6 * f], [bi.LeftUpperLeg, 0.6 * f * sideL], [bi.RightUpperLeg, 0.6 * f * (1 - sideL)]];
    };
    loft(body, [
      [L + 0.155, w0 * 1.04 + 0.006, df0 * 1.04 + 0.006, db0 * 1.04 + 0.006, 0],
      [L + 0.09, 0.162, 0.103, 0.113, 0.015],
      [L - 0.02, 0.19, 0.13, 0.14, 0.03],
      [hemY, 0.215, 0.152, 0.162, 0.04],
    ].map(([y, w, df, db, rip]) => ({ c: [0, y, 0], n: [0, 0, 1], w, df, db, p: 2.2, ripple: rip, rippleK: 14, wt: skirtW, rect: R.bottom })),
    { seg: 42 });
  }

  // ---------- head ----------
  let hw, hh, hd, hc, shapeUnit, faceZ = null, realFace = null;
  if (real) {
    // the person's own face mesh (or the canonical one before a scan), placed on a simple skull
    const scanned = P.faceScan && P.faceScan.lm && P.faceScan.lm.length === 1404 && P.faceScan.uv && P.faceScan.uv.length === 936;
    const src = scanned ? P.faceScan.lm : CANON_POS;
    const uvs = scanned ? P.faceScan.uv : CANON_UV;
    const g = (i) => [src[i * 3], src[i * 3 + 1], src[i * 3 + 2]];
    const fw = Math.abs(g(454)[0] - g(234)[0]);
    const k = (0.142 * lerp(0.92, 1.1, P.headSize)) / fw;
    const sideZ = (g(234)[2] + g(454)[2]) / 2;
    const oy = Y.head - 0.03 - g(152)[1] * k, oz = 0.025 - sideZ * k;
    const toW = (p) => [p[0] * k, p[1] * k + oy, p[2] * k + oz];
    const yTop = toW(g(10))[1], yChin = toW(g(152))[1];
    hw = (fw * k) / 2 * 1.04;
    hh = ((yTop - yChin) / 2) * 1.2;
    hd = 0.098 * lerp(0.92, 1.1, P.headSize);
    hc = [0, (yTop + yChin) / 2 + 0.03, 0.025 - 0.02];
    shapeUnit = (d) => d;
    realFace = { src, uvs, k, toW };
    faceZ = new FrontZMap(-hw * 1.3, hw * 1.3, -hh * 1.6, hh * 1.4, 128);
    const tris = [];
    for (let i = 0; i < FACE_TRIS.length; i += 3) {
      tris.push([0, 1, 2].map((j) => { const w = toW(g(FACE_TRIS[i + j])); return [w[0] - hc[0], w[1] - hc[1], w[2] - hc[2]]; }));
    }
    faceZ.rasterize(tris);
  } else {
    hw = 0.09 * hs * lerp(0.93, 1.07, P.faceWidth);
    hh = 0.112 * hs * lerp(0.94, 1.08, P.faceLength);
    hd = 0.102 * hs;
    hc = [0, Y.head + 0.07 * hs, 0.012];
    shapeUnit = ([x, y, z]) => {
      if (y < 0) {
        const t = -y;
        const front = smooth(-0.3, 0.6, z);
        x *= 1 - lerp(0.42, 0.18, P.jaw) * Math.pow(t, 1.6) * (0.55 + 0.45 * front);
        y *= 1 + lerp(-0.04, 0.14, P.chin) * t * t * t * front;
        z *= 1 + 0.08 * t * t * front - 0.22 * t * t * (1 - front);
      } else if (z < 0) z *= 1 + 0.06 * y;
      if (z > 0) z *= 1 - 0.1 * (1 - Math.abs(x)) * smooth(-0.6, 0, y);
      const nb = Math.exp(-((x / 0.07) ** 2 + ((y + 0.3) / 0.09) ** 2));
      if (z > 0) z += 0.05 * nb * lerp(0.6, 1.3, P.noseLength);
      return [x, y, z];
    };
  }
  const headPt = (d, k = 1, dy = 0) => {
    const [x, y, z] = shapeUnit(d);
    const p = [hc[0] + x * hw * k, hc[1] + y * hh * k + dy, hc[2] + z * hd * k];
    if (faceZ && p[2] > hc[2]) {
      const lx = p[0] - hc[0], ly = p[1] - hc[1];
      if (faceZ.covers(lx, ly)) {
        const fz = hc[2] + faceZ.sample(lx, ly);
        if (k <= 1.001) p[2] = Math.min(p[2], fz - 0.006); // skull hides behind the face
        else p[2] = Math.max(p[2], fz + 0.004 + (k - 1) * 0.06); // hair sits on top of it
      }
    }
    return p;
  };
  const headNormal = (p) => V.norm([(p[0] - hc[0]) / (hw * hw), (p[1] - hc[1]) / (hh * hh), (p[2] - hc[2]) / (hd * hd)]);
  const skinUV = rectUV(R.skin, 0.5, 0.5);
  sphereGrid(body, 36, 48, (d) => ({ p: headPt(d), uv: skinUV, wt: [W('Head')] }));

  // ears
  for (const sx of [1, -1]) {
    const es = real ? 1.05 : hs;
    const ec = real ? [sx * hw * 0.97, hc[1] - 0.12 * hh, hc[2] - 0.02] : [sx * hw * 0.95, hc[1] - 0.1 * hh, hc[2] - 0.12 * hd];
    sphereGrid(body, 8, 10, (d) => ({ p: [ec[0] + d[0] * 0.01 * es, ec[1] + d[1] * 0.03 * es, ec[2] + d[2] * 0.02 * es], uv: skinUV, wt: [W('Head')] }));
  }

  // ---------- hair ----------
  const hairV = (y) => clamp((hc[1] + hh * 1.1 - y) / (hh * 2.8), 0, 1);
  const hairUV = (y) => rectUV(R.hair, 0.5, hairV(y));
  const dirFrom = (phi, y) => { const r = Math.sqrt(Math.max(0, 1 - y * y)); return [r * Math.sin(phi), y, r * Math.cos(phi)]; };
  const capMask = ([x, y, z]) => {
    const fr = smooth(0.15, 0.75, z), bk = smooth(0, 0.6, -z);
    return y > lerp(lerp(-0.12, 0.3 - 0.12 * Math.abs(x), fr), -0.62, bk);
  };
  sphereGrid(body, 36, 48, (d) => { const p = headPt(d, 1.055, 0.004); return { p, uv: hairUV(p[1]), wt: [W('Head')] }; }, capMask);

  // spring chains: each is a list of bone names, root first
  const springs = [];
  const chainBones = (prefix, pts, parent = 'Head') => {
    const names = [];
    pts.forEach((p, j) => { const nm = `${prefix}_${j}`; bone(nm, j === 0 ? parent : names[j - 1], p); names.push(nm); });
    return names;
  };
  const along = (curve, n) => Array.from({ length: n + 1 }, (_, j) => curve.getPointAt(j / n).toArray());
  const toV3 = (p) => new THREE.Vector3(p[0], p[1], p[2]);

  // a strand = loft through path points; widths taper to a point
  const strand = (pts, normals, wFn, thFn, wtFn, seg = 6) => {
    const n = pts.length;
    loft(body, pts.map((p, i) => {
      const t = i / (n - 1);
      return {
        c: p, n: normals[i], w: Math.max(0.0012, wFn(t)), df: Math.max(0.001, thFn(t)), db: Math.max(0.0008, thFn(t) * 0.35),
        rect: R.hair, v: hairV(p[1]), wt: wtFn(p, t, i),
      };
    }), { seg, capEnd: true, capExt: 0.002 });
  };
  const headOnly = () => [W('Head')];
  const tip = (t, p) => (real ? 1 - 0.72 * Math.pow(t, p) : 1 - Math.pow(t, p)); // realistic hair ends softly
  const hairW = real ? 0.68 : 1;

  // bangs
  const bangDefs = [];
  if (P.bangs === 'parted') {
    const nb = real ? 8 : 5;
    for (const sx of [1, -1]) for (let i = 0; i < nb; i++) {
      const f = i / (nb - 1), phi0 = sx * lerp(6, 64, f) * DEG;
      bangDefs.push({ phi0, phi1: phi0 + sx * 14 * DEG, y1: lerp(0.3, 0.0, f) + (i % 2 ? (real ? 0.02 : 0.05) : 0) });
    }
  } else if (P.bangs === 'side') {
    const nb = real ? 14 : 9;
    for (let i = 0; i < nb; i++) {
      const f = i / (nb - 1), phi0 = lerp(-64, 64, f) * DEG;
      bangDefs.push({ phi0, phi1: phi0 + 28 * DEG * (1 - Math.abs(phi0) / (90 * DEG)), y1: lerp(0.2, -0.02, f) + (i % 2 ? (real ? 0.02 : 0.05) : 0) });
    }
  } else {
    const nb = real ? 14 : 9;
    for (let i = 0; i < nb; i++) {
      const f = i / (nb - 1), phi0 = lerp(-64, 64, f) * DEG;
      bangDefs.push({ phi0, phi1: phi0 * 1.05, y1: lerp(0.1, -0.02, Math.abs(phi0) / (64 * DEG)) + (i % 2 ? (real ? 0.02 : 0.06) : 0) });
    }
  }
  for (const d of bangDefs) {
    const pts = [], nrm = [];
    for (let i = 0; i <= 10; i++) {
      const t = i / 10;
      const p = headPt(dirFrom(lerp(d.phi0, d.phi1, Math.pow(t, 1.5)), lerp(0.88, d.y1, t)), 1.072 + 0.028 * t);
      pts.push(p); nrm.push(headNormal(p));
    }
    strand(pts, nrm, (t) => 0.0165 * hs * hairW * tip(t, 2.2) * (t < 0.1 ? 0.7 + 3 * t : 1), (t) => 0.011 * hs * (1 - 0.7 * t), headOnly);
  }

  // side locks
  const style = P.hairStyle, len = P.hairLength;
  const sideEnd = style === 'short' ? null : style === 'long' ? hc[1] - hh - lerp(0.05, 0.2, len) : hc[1] - hh * lerp(0.85, 1.05, len);
  const sideChains = {};
  for (const sx of [1, -1]) {
    let chain = null;
    if (sideEnd !== null) {
      const p0 = headPt(dirFrom(sx * 89 * DEG, -0.12), 1.08);
      const curve = new THREE.CatmullRomCurve3([toV3(p0), toV3([p0[0], lerp(p0[1], sideEnd, 0.5), p0[2] + 0.008]), toV3([p0[0] * 0.98, sideEnd, p0[2] + 0.012])]);
      chain = { names: chainBones(`HairSide${sx > 0 ? 'L' : 'R'}`, along(curve, 2)), y0: p0[1], y1: sideEnd };
      springs.push({ comment: 'Side hair', root: chain.names[0], stiff: 1.2 });
    }
    sideChains[sx] = chain;
    for (const phiD of real ? [76, 84, 92, 100] : [80, 96]) {
      const phi = sx * phiD * DEG;
      const yEndHead = sideEnd === null ? -0.32 : -0.12;
      const pts = [], nrm = [];
      for (let i = 0; i <= 7; i++) {
        const p = headPt(dirFrom(phi, lerp(0.55, yEndHead, i / 7)), 1.08);
        pts.push(p); nrm.push(headNormal(p));
      }
      const headCount = pts.length;
      if (sideEnd !== null) {
        const pe = pts[pts.length - 1];
        for (let i = 1; i <= 5; i++) {
          const t = i / 5;
          pts.push([pe[0] * (1 - 0.03 * t), lerp(pe[1], sideEnd, t), pe[2] + 0.012 * Math.sin(t * Math.PI * 0.5)]);
          nrm.push(V.norm([pe[0] - hc[0], 0, pe[2] - hc[2] + 0.02]));
        }
      }
      const wt = (p, t, i) => {
        if (!chain || i < headCount - 1) return headOnly();
        const s = clamp((chain.y0 - p[1]) / (chain.y0 - chain.y1), 0, 1);
        const f = s * 2;
        const j = Math.min(1, Math.floor(f));
        const k = f - j;
        const ws = [[bi[chain.names[j]], 1 - k * 0.5], [bi[chain.names[Math.min(2, j + 1)]], k * 0.5]];
        return s < 0.1 ? [...ws, W('Head', 1 - s * 10)] : ws;
      };
      strand(pts, nrm, (t) => 0.0165 * hs * hairW * tip(t, 2.5), (t) => 0.012 * hs * (1 - 0.6 * t), wt);
    }
  }

  // back hair
  const longish = style === 'long' || style === 'bob';
  const yLeave = longish ? -0.2 : -0.58;
  const shoulderTop = L + 0.44;
  const endY = style === 'long' ? Y.chest + 0.05 - lerp(0, 0.34, len) : hc[1] - hh * lerp(0.95, 1.35, len);
  const backPath = (phi) => {
    const pts = [], nrm = [];
    for (let i = 0; i <= 9; i++) {
      const p = headPt(dirFrom(phi, lerp(0.93, yLeave, i / 9)), 1.075);
      pts.push(p); nrm.push(headNormal(p));
    }
    const headCount = pts.length;
    if (longish) {
      const pe = pts[pts.length - 1];
      const out = V.norm([pe[0], 0, pe[2] - hc[2]]);
      let ctrl;
      if (style === 'long') {
        const zb = Math.min(pe[2] - 0.02, -0.12);
        ctrl = [pe, [pe[0] * 1.02, pe[1] - 0.04, pe[2] - 0.01], [pe[0] * 1.15, shoulderTop + 0.03, zb], [pe[0] * 1.2, endY, zb - 0.02 + (pe[2] - hc[2]) * 0.2]];
      } else {
        ctrl = [pe, [pe[0] + out[0] * 0.018, lerp(pe[1], endY, 0.5), pe[2] + out[2] * 0.018], [pe[0] + out[0] * 0.006, endY, pe[2] + out[2] * 0.006]];
      }
      const curve = new THREE.CatmullRomCurve3(ctrl.map(toV3));
      const ext = along(curve, style === 'long' ? 10 : 5).slice(1);
      for (const p of ext) { pts.push(p); nrm.push(V.norm([p[0], 0, p[2] - hc[2] * 0.5])); }
      return { pts, nrm, headCount, curve };
    }
    return { pts, nrm, headCount, curve: null };
  };
  const chainPhis = [125, 155, 180, 205, 235].map((d) => d * DEG);
  const backChains = [];
  if (longish) {
    const nb = style === 'long' ? 4 : 2;
    chainPhis.forEach((phi, c) => {
      const { curve } = backPath(phi);
      const names = chainBones(`HairBack${c}`, along(curve, nb));
      backChains.push({ phi, names, nb });
      springs.push({ comment: 'Back hair', root: names[0], stiff: style === 'long' ? 0.7 : 1.1 });
    });
  }
  const nBack = real ? 21 : 13;
  for (let i = 0; i < nBack; i++) {
    const phi = lerp(100, 260, i / (nBack - 1)) * DEG;
    const { pts, nrm, headCount } = backPath(phi);
    const extLen = pts.length - headCount;
    const wt = (p, t, idx) => {
      if (!longish || idx < headCount - 1) return headOnly();
      const s = clamp((idx - (headCount - 1)) / extLen, 0, 1);
      // two nearest chains by angle
      const sorted = backChains.map((c) => [c, Math.abs(c.phi - phi)]).sort((a, c) => a[1] - c[1]);
      const [c0, d0] = sorted[0], [c1, d1] = sorted[1];
      const a = d0 + d1 > 0 ? d1 / (d0 + d1) : 1;
      const out = [];
      for (const [ch, cw] of [[c0, a], [c1, 1 - a]]) {
        const f = s * ch.nb, j = Math.min(ch.nb - 1, Math.floor(f)), k = f - j;
        out.push([bi[ch.names[j]], cw * (1 - k)], [bi[ch.names[j + 1]], cw * k]);
      }
      if (s < 0.12) return [...out.map(([bb, w]) => [bb, w * s / 0.12]), W('Head', 1 - s / 0.12)];
      return out;
    };
    const tipW = style === 'long' ? 0.022 : 0.019;
    strand(pts, nrm, (t) => tipW * hs * hairW * (longish ? tip(t, 3) : tip(t, 2)), (t) => 0.013 * hs * (1 - 0.5 * t), wt);
  }

  // ponytail
  if (style === 'ponytail') {
    const tie = headPt(dirFrom(Math.PI, 0.25), 1.09);
    const tailLen = lerp(0.15, 0.42, len);
    const curve = new THREE.CatmullRomCurve3([
      toV3(tie), toV3([tie[0], tie[1] + 0.01, tie[2] - 0.05]), toV3([tie[0], tie[1] - 0.08, tie[2] - 0.09]), toV3([tie[0], tie[1] - 0.08 - tailLen, tie[2] - 0.075]),
    ]);
    const names = chainBones('Ponytail', along(curve, 4));
    springs.push({ comment: 'Ponytail', root: names[0], stiff: 0.8 });
    sphereGrid(body, 8, 12, (d) => ({ p: [tie[0] + d[0] * 0.02 * hs, tie[1] + d[1] * 0.02 * hs, tie[2] + d[2] * 0.012 * hs], uv: rectUV(R.tie, 0.5, 0.5), wt: [W('Head')] }));
    const samples = 14;
    for (let k = 0; k < 7; k++) {
      const ang = (k / 7) * Math.PI * 2;
      const pts = [], nrm = [];
      for (let i = 0; i <= samples; i++) {
        const t = i / samples;
        const c = curve.getPointAt(t), tg = curve.getTangentAt(t);
        const side = new THREE.Vector3().crossVectors(tg, new THREE.Vector3(1, 0, 0)).normalize();
        const right = new THREE.Vector3(1, 0, 0);
        const rad = 0.012 + 0.02 * Math.sin(Math.PI * Math.min(1, t * 1.4)) * (1 - t * 0.5);
        const off = right.clone().multiplyScalar(Math.cos(ang) * rad).add(side.clone().multiplyScalar(Math.sin(ang) * rad));
        pts.push(c.clone().add(off).toArray());
        nrm.push(off.lengthSq() > 0 ? off.clone().normalize().toArray() : [0, 0, -1]);
      }
      const wt = (p, t) => {
        const f = t * 4, j = Math.min(3, Math.floor(f)), kk = f - j;
        const ws = [[bi[names[j]], 1 - kk], [bi[names[j + 1]], kk]];
        return t < 0.08 ? [...ws.map(([bb, w]) => [bb, w * t / 0.08]), W('Head', 1 - t / 0.08)] : ws;
      };
      strand(pts, nrm, (t) => 0.016 * hs * (1 - Math.pow(t, 2.4)), (t) => 0.012 * hs * (1 - 0.5 * t), wt);
    }
  }

  // ahoge
  if (P.ahoge) {
    const p0 = headPt(dirFrom(0, 0.97), 1.06);
    const pts = [p0, [p0[0], p0[1] + 0.03, p0[2] + 0.004], [p0[0], p0[1] + 0.055, p0[2] + 0.025], [p0[0], p0[1] + 0.05, p0[2] + 0.05]];
    strand(pts, pts.map(() => [0, 0.3, 1]), (t) => 0.008 * hs * (1 - t), () => 0.004 * hs, headOnly);
  }

  // ---------- face ----------
  let eyeWorldY = hc[1];
  if (real) {
    const { src, uvs, k, toW } = realFace;
    const n = src.length / 3;
    for (let i = 0; i < n; i++) face.v(toW([src[i * 3], src[i * 3 + 1], src[i * 3 + 2]]), [uvs[i * 2], uvs[i * 2 + 1]], [W('Head')]);
    for (let i = 0; i < FACE_TRIS.length; i += 3) {
      const t = [FACE_TRIS[i], FACE_TRIS[i + 1], FACE_TRIS[i + 2]];
      if (t.every((v) => EYE_HOLE.has(v))) continue; // the eyeballs show through here
      face.tri(...t);
    }
    for (const [name, m] of Object.entries(faceMorphs(src))) for (const [i, d] of m) face.morph(name, i, [d[0] * k, d[1] * k, d[2] * k]);
    // dark mouth cavity behind the lips, seen when the jaw opens
    const a = toW([src[13 * 3], src[13 * 3 + 1], src[13 * 3 + 2]]), b = toW([src[14 * 3], src[14 * 3 + 1], src[14 * 3 + 2]]);
    const cL = toW([src[291 * 3], src[291 * 3 + 1], src[291 * 3 + 2]]);
    const mc = [0, (a[1] + b[1]) / 2 - 0.006, Math.min(a[2], b[2]) - 0.014];
    const mr = [Math.abs(cL[0]) * 0.85, 0.016, 0.012];
    sphereGrid(body, 8, 12, (d) => ({ p: [mc[0] + d[0] * mr[0], mc[1] + d[1] * mr[1], mc[2] + d[2] * mr[2]], uv: rectUV(R.inner, 0.5, 0.5), wt: [W('Head')] }));
    // upper teeth just behind the upper lip
    const tc = [0, a[1] - 0.001, a[2] - 0.011];
    sphereGrid(body, 6, 12, (d) => ({ p: [tc[0] + d[0] * mr[0] * 0.78, tc[1] + d[1] * 0.0045, tc[2] + d[2] * 0.007], uv: rectUV(R.white, 0.5, 0.5), wt: [W('Head')] }));
    // eyeballs on eye bones (VRM bone look-at), centred behind each eye opening
    for (const [sd, ring] of [['Left', EYES.L.ring], ['Right', EYES.R.ring]]) {
      const pts = ring.map((i) => toW([src[i * 3], src[i * 3 + 1], src[i * 3 + 2]]));
      const c = pts.reduce((acc, q) => V.add(acc, V.mul(q, 1 / pts.length)), [0, 0, 0]);
      const front = Math.max(...pts.map((q) => q[2]));
      const width = Math.max(...pts.map((q) => q[0])) - Math.min(...pts.map((q) => q[0]));
      const er = Math.max(0.0105, width * 0.48);
      const ec = [c[0], c[1], front - er - 0.0004];
      bone(sd + 'Eye', 'Head', ec);
      sphereGrid(body, 16, 20, (d) => {
        const th = Math.acos(clamp(d[2], -1, 1)), rr = Math.hypot(d[0], d[1]) || 1;
        const k = (th / Math.PI) * 0.5;
        return { p: [ec[0] + d[0] * er, ec[1] + d[1] * er, ec[2] + d[2] * er], uv: rectUV(R.eyeball, 0.5 + (d[0] / rr) * k, 0.5 - (d[1] / rr) * k), wt: [W(sd + 'Eye')] };
      });
    }
    const eyeR = toW([src[159 * 3], src[159 * 3 + 1], src[159 * 3 + 2]]);
    eyeWorldY = eyeR[1];
  } else {
    const zmap = new FrontZMap(-hw * 1.25, hw * 1.25, -hh * 1.6, hh * 1.3, 160);
    {
      const tris = [], rows = 48, cols = 64, grid = [];
      for (let i = 0; i <= rows; i++) {
        const th = (Math.PI * i) / rows, row = [];
        for (let j = 0; j <= cols; j++) {
          const ph = -Math.PI / 2 + (Math.PI * j) / cols;
          const p = headPt([Math.sin(th) * Math.sin(ph), Math.cos(th), Math.sin(th) * Math.cos(ph)]);
          row.push([p[0] - hc[0], p[1] - hc[1], p[2] - hc[2]]);
        }
        grid.push(row);
      }
      for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
        tris.push([grid[i][j], grid[i + 1][j], grid[i][j + 1]], [grid[i][j + 1], grid[i + 1][j], grid[i + 1][j + 1]]);
      }
      zmap.rasterize(tris);
    }
    const surf = (x, y, layer) => [hc[0] + x, hc[1] + y, hc[2] + zmap.sample(x, y) + 0.0012 + layer * 0.0011];
    const decal = ({ cx, cy, w, h, rot = 0, rect, mirror = false, nx = 6, ny = 4, layer = 1, morphs = {} }) => {
      const c = Math.cos(rot), s = Math.sin(rot);
      const local = (lx, ly) => [cx + lx * c - ly * s, cy + lx * s + ly * c];
      const base = face.count;
      for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
        const u = i / nx, t = j / ny;
        const lx = (u - 0.5) * w, ly = (0.5 - t) * h;
        const [x, y] = local(lx, ly);
        const p = surf(x, y, layer);
        const id = face.v(p, rectUV(rect, mirror ? 1 - u : u, t), [W('Head')]);
        for (const [name, fn] of Object.entries(morphs)) {
          const [dx, dy] = fn(lx, ly);
          if (Math.abs(dx) + Math.abs(dy) < 1e-7) continue;
          const [x2, y2] = local(lx + dx, ly + dy);
          const p2 = surf(x2, y2, layer);
          face.morph(name, id, [p2[0] - p[0], p2[1] - p[1], p2[2] - p[2]]);
        }
      }
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const A = base + j * (nx + 1) + i, B = A + 1, C = A + nx + 1, D = C + 1;
        face.tri(A, C, B); face.tri(B, C, D);
      }
    };

    const eW = 0.4 * hw * lerp(0.8, 1.22, P.eyeSize);
    const eH = eW * lerp(0.78, 1.08, P.eyeOpen);
    const eyeCY = -0.21 * hh + lerp(-0.05, 0.05, P.eyeY) * hh;
    const eyeCX = 0.41 * hw * lerp(0.86, 1.12, P.eyeSpacing);
    const tilt = lerp(-0.16, 0.24, P.eyeTilt);
    const closedY = -0.16 * eH;
    const look = { lookLeft: [0.21 * eW, 0], lookRight: [-0.21 * eW, 0], lookUp: [0, 0.1 * eH], lookDown: [0, -0.12 * eH] };
    for (const sx of [1, -1]) {
      const cx = sx * eyeCX, rot = sx * tilt, mirror = sx < 0, blink = sx > 0 ? 'blinkL' : 'blinkR';
      decal({ cx, cy: eyeCY, w: eW, h: eH, rot, rect: R.eyeWhite, mirror, nx: 6, ny: 6, layer: 1, morphs: { [blink]: (lx, ly) => [0, closedY - ly] } });
      const iy = 0.02 * eH;
      const icx = cx - Math.sin(rot) * iy, icy = eyeCY + Math.cos(rot) * iy;
      const irisMorphs = { [blink]: (lx, ly) => [0, closedY - (ly + iy)] };
      for (const [k, [dx, dy]] of Object.entries(look)) irisMorphs[k] = () => [dx, dy];
      decal({ cx: icx, cy: icy, w: eW * 0.56, h: eH * 0.74, rot, rect: R.iris, mirror, nx: 4, ny: 4, layer: 2, morphs: irisMorphs });
      decal({ cx, cy: eyeCY, w: eW, h: eH, rot, rect: R.lash, mirror, nx: 8, ny: 4, layer: 3, morphs: { [blink]: (lx, ly) => [0, closedY + ly * 0.28 - 0.06 * eH - ly] } });

      const bW = eW * 1.05, bH = eW * 0.27 * lerp(0.7, 1.4, P.browThickness);
      const bcx = cx + sx * 0.04 * eW, bcy = eyeCY + eH * 0.62 + lerp(-0.12, 0.18, P.browHeight) * eH;
      const uOut = (lx) => (lx * sx) / bW + 0.5;
      decal({
        cx: bcx, cy: bcy, w: bW, h: bH, rot: sx * lerp(-0.18, 0.22, P.browAngle), rect: R.brow, mirror, nx: 6, ny: 2, layer: 1,
        morphs: {
          browUp: () => [0, 0.28 * eH],
          browAngry: (lx) => [0, -(1 - uOut(lx)) * 0.3 * eH + uOut(lx) * 0.06 * eH],
          browSad: (lx) => [0, (1 - uOut(lx)) * 0.28 * eH - uOut(lx) * 0.04 * eH],
        },
      });
      if (P.blush > 0.05) {
        const bw = 0.3 * hw * lerp(0.6, 1.2, P.blush);
        decal({ cx: sx * eyeCX * 1.15, cy: eyeCY - eH * 0.72, w: bw, h: bw * 0.5, rect: R.blush, mirror, nx: 3, ny: 2, layer: 1 });
      }
    }
    const nw = 0.075 * hw;
    decal({ cx: 0, cy: -0.42 * hh * lerp(0.9, 1.1, P.noseLength), w: nw, h: nw, rect: R.nose, nx: 2, ny: 2, layer: 1 });
    const mW = 0.3 * hw * lerp(0.7, 1.3, P.mouthWidth), restH = mW * 0.06;
    decal({
      cx: 0, cy: -0.63 * hh * lerp(0.93, 1.06, P.mouthY), w: mW, h: restH, rect: R.mouth, nx: 10, ny: 4, layer: 1,
      morphs: {
        mouthA: (lx, ly) => [lx * -0.15, ly * 9 - restH * 2.6],
        mouthI: (lx, ly) => [lx * 0.15, ly * 1.9],
        mouthU: (lx, ly) => [lx * -0.45, ly * 4.5 - restH * 1.1],
        mouthE: (lx, ly) => [lx * 0.08, ly * 3.4 - restH * 0.9],
        mouthO: (lx, ly) => [lx * -0.28, ly * 7.3 - restH * 2.0],
        smile: (lx) => { const q = (2 * lx) / mW; return [lx * 0.05, mW * (0.17 * q * q - 0.035)]; },
        frown: (lx) => { const q = (2 * lx) / mW; return [0, -mW * (0.12 * q * q - 0.02)]; },
      },
    });


    eyeWorldY = hc[1] + eyeCY;
  }

  // ---------- colliders (offsets in each bone's frame; bones have identity rotation) ----------
  const off = (name, p) => V.sub(p, bones[bi[name]].pos);
  const colliders = [
    { bone: 'Head', offset: off('Head', [hc[0], hc[1] - 0.01, hc[2] - 0.005]), radius: (hw + hd) * 0.5 * 1.04 },
    { bone: 'Neck', offset: [0, 0.02, 0], radius: 0.045 },
    { bone: 'UpperChest', offset: [0, 0.03, 0], radius: 0.1 },
    { bone: 'UpperChest', offset: [0.09, 0.06, 0.005], radius: 0.06 },
    { bone: 'UpperChest', offset: [-0.09, 0.06, 0.005], radius: 0.06 },
    { bone: 'Chest', offset: [0, 0, 0], radius: 0.1 },
    { bone: 'Spine', offset: [0, 0, 0], radius: 0.095 },
    { bone: 'Hips', offset: [0, 0, -0.01], radius: 0.12 },
  ];

  return {
    name: P.name || 'Avatar', scale, bones, bi, body, face, springs, colliders,
    headCenter: hc, headTop: hc[1] + hh * 1.1, eyeY: eyeWorldY, style: real ? 'real' : 'anime',
  };
}

/**
 * Turn a description into THREE objects.
 * facing: +1 = character faces +Z (plain glTF), -1 = faces -Z (VRM 0.x convention).
 */
export function realize(desc, materials, facing = 1) {
  const s = desc.scale;
  const xp = (p) => (facing > 0 ? [p[0] * s, p[1] * s, p[2] * s] : [-p[0] * s, p[1] * s, -p[2] * s]);
  const xf = { p: xp, d: xp };
  const boneObjs = {};
  const list = desc.bones.map((bd) => {
    const bo = new THREE.Bone();
    bo.name = bd.name;
    boneObjs[bd.name] = bo;
    return bo;
  });
  desc.bones.forEach((bd, i) => {
    const w = xp(bd.pos);
    if (bd.parent) {
      const pw = xp(desc.bones[desc.bi[bd.parent]].pos);
      list[i].position.set(w[0] - pw[0], w[1] - pw[1], w[2] - pw[2]);
      boneObjs[bd.parent].add(list[i]);
    } else list[i].position.set(w[0], w[1], w[2]);
  });
  const root = new THREE.Group();
  root.name = desc.name;
  const armature = new THREE.Object3D();
  armature.name = 'Armature';
  armature.add(boneObjs.Hips);
  root.add(armature);
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(list);
  const mk = (mb, mat) => {
    const m = new THREE.SkinnedMesh(mb.toGeometry(xf), mat);
    m.name = mb.name;
    root.add(m);
    m.bind(skeleton, m.matrixWorld);
    return m;
  };
  const body = mk(desc.body, materials.body);
  const face = mk(desc.face, materials.face);
  root.updateMatrixWorld(true);
  return { root, skeleton, boneObjs, body, face, xp };
}
