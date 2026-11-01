// Low-level geometry helpers for the procedural avatar.
// Everything is built in "design space": metres, Y up, character facing +Z.
import * as THREE from 'three';

export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const smooth = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const V = { add, sub, mul, dot, cross, len, norm };

function normWeights(weights) {
  const merged = new Map();
  for (const [i, w] of weights) if (w > 1e-4) merged.set(i, (merged.get(i) || 0) + w);
  let list = [...merged.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  if (!list.length) list = [[0, 1]];
  const total = list.reduce((s, x) => s + x[1], 0);
  const idx = [0, 0, 0, 0], w = [0, 0, 0, 0];
  list.forEach(([i, ww], k) => { idx[k] = i; w[k] = ww / total; });
  return { idx, w };
}

export class MeshBuilder {
  constructor(name) {
    this.name = name;
    this.pos = []; this.uv = []; this.skin = []; this.idx = [];
    this.morphs = new Map();
  }
  get count() { return this.pos.length / 3; }
  v(p, uv, weights) {
    this.pos.push(p[0], p[1], p[2]);
    this.uv.push(uv[0], uv[1]);
    this.skin.push(normWeights(weights));
    return this.count - 1;
  }
  tri(a, b, c) { this.idx.push(a, b, c); }
  declareMorph(name) { if (!this.morphs.has(name)) this.morphs.set(name, new Map()); }
  morph(name, i, d) { this.declareMorph(name); this.morphs.get(name).set(i, d); }

  // xf: { p(vec3)->vec3 for points, d(vec3)->vec3 for deltas }
  toGeometry(xf) {
    const n = this.count;
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const p = xf.p([this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]]);
      pos.set(p, i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
    this.skin.forEach((s, i) => { si.set(s.idx, i * 4); sw.set(s.w, i * 4); });
    g.setAttribute('skinIndex', new THREE.BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(sw, 4));
    g.setIndex(n > 65535 ? new THREE.BufferAttribute(new Uint32Array(this.idx), 1) : new THREE.BufferAttribute(new Uint16Array(this.idx), 1));
    g.computeVertexNormals();
    if (this.morphs.size) {
      g.morphTargetsRelative = true;
      g.morphAttributes.position = [];
      for (const [name, m] of this.morphs) {
        const arr = new Float32Array(n * 3);
        for (const [i, d] of m) arr.set(xf.d(d), i * 3);
        const attr = new THREE.BufferAttribute(arr, 3);
        attr.name = name;
        g.morphAttributes.position.push(attr);
      }
    }
    return g;
  }
}

// A UV rectangle in the atlas, inset to stay inside a swatch.
export function rectUV(rect, s, t) {
  return [rect.u0 + (rect.u1 - rect.u0) * s, rect.v0 + (rect.v1 - rect.v0) * t];
}

/**
 * Loft a tube through cross-sections.
 * section: { c:[x,y,z], n:[x,y,z] front/thickness direction, w half-width,
 *            df front depth, db back depth, p superellipse exponent (2 = ellipse),
 *            ripple, rippleK, wt: weights array or fn(point)->weights,
 *            rect: atlas rect, v: 0..1 along rect }
 * Winding gives outward-facing triangles (u = n x t, so (u, n, t) is right-handed).
 */
export function loft(mb, secs, { seg = 12, capStart = false, capEnd = false, capExt = 0, a0 = 0 } = {}) {
  const rings = [];
  let lastT = [0, 1, 0];
  const frames = secs.map((s, i) => {
    const a = secs[Math.max(0, i - 1)].c, b = secs[Math.min(secs.length - 1, i + 1)].c;
    let t = sub(b, a);
    if (len(t) < 1e-6) {
      // duplicated section: search further neighbours
      let j0 = i, j1 = i;
      while (j0 > 0 && len(sub(secs[j0].c, s.c)) < 1e-6) j0--;
      while (j1 < secs.length - 1 && len(sub(secs[j1].c, s.c)) < 1e-6) j1++;
      t = sub(secs[j1].c, secs[j0].c);
    }
    t = len(t) < 1e-6 ? lastT : norm(t);
    lastT = t;
    let n = s.n;
    let u = cross(n, t);
    if (len(u) < 1e-6) u = cross([0, 0, 1], t);
    u = norm(u);
    n = norm(cross(t, u));
    return { t, u, n };
  });

  secs.forEach((s, i) => {
    const { u, n } = frames[i];
    const ex = 2 / (s.p || 2);
    const ring = [];
    // seg + 1 vertices: the last repeats the first with u = 1 so textures don't smear across the seam
    for (let k = 0; k <= seg; k++) {
      const a = a0 + (2 * Math.PI * k) / seg;
      const cs = Math.cos(a), sn = Math.sin(a);
      const rip = 1 + (s.ripple || 0) * Math.cos((s.rippleK || 8) * a);
      const x = s.w * rip * Math.sign(cs) * Math.pow(Math.abs(cs), ex);
      const z = (sn >= 0 ? s.df : s.db) * rip * Math.sign(sn) * Math.pow(Math.abs(sn), ex);
      const P = add(s.c, add(mul(u, x), mul(n, z)));
      const w = typeof s.wt === 'function' ? s.wt(P, s) : s.wt;
      ring.push(mb.v(P, rectUV(s.rect, k / seg, s.v ?? 0.5), w));
    }
    rings.push(ring);
  });

  for (let i = 0; i < rings.length - 1; i++) {
    for (let k = 0; k < seg; k++) {
      const A = rings[i][k], B = rings[i][k + 1], C = rings[i + 1][k], D = rings[i + 1][k + 1];
      mb.tri(A, B, C); mb.tri(B, D, C);
    }
  }
  const cap = (i, start) => {
    const s = secs[i], { t } = frames[i];
    const c = add(s.c, mul(t, start ? -capExt : capExt));
    const w = typeof s.wt === 'function' ? s.wt(c, s) : s.wt;
    const C = mb.v(c, rectUV(s.rect, 0.5, s.v ?? 0.5), w);
    const r = rings[i];
    for (let k = 0; k < seg; k++) {
      if (start) mb.tri(C, r[k + 1], r[k]);
      else mb.tri(C, r[k], r[k + 1]);
    }
  };
  if (capStart) cap(0, true);
  if (capEnd) cap(rings.length - 1, false);
}

/**
 * Sphere-topology grid. f(dir, i, j) -> { p, uv, wt } ; keep(dir) optional mask:
 * a triangle is only emitted when all three vertices pass.
 */
export function sphereGrid(mb, rows, cols, f, keep = null) {
  const grid = [], ok = [];
  for (let i = 0; i <= rows; i++) {
    const th = (Math.PI * i) / rows;
    const row = [], okRow = [];
    for (let j = 0; j < cols; j++) {
      const ph = (2 * Math.PI * j) / cols;
      const d = [Math.sin(th) * Math.sin(ph), Math.cos(th), Math.sin(th) * Math.cos(ph)];
      const r = f(d, i, j);
      row.push(mb.v(r.p, r.uv, r.wt));
      okRow.push(keep ? keep(d) : true);
    }
    grid.push(row); ok.push(okRow);
  }
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const j1 = (j + 1) % cols;
      const A = grid[i][j], B = grid[i][j1], C = grid[i + 1][j], D = grid[i + 1][j1];
      const oa = ok[i][j], ob = ok[i][j1], oc = ok[i + 1][j], od = ok[i + 1][j1];
      if (oa && oc && ob) mb.tri(A, C, B);
      if (ob && oc && od) mb.tri(B, C, D);
    }
  }
  return grid;
}

/**
 * Height map of the front of a mesh region (in head-local x,y), used to lay
 * flat "decals" (eyes, mouth, brows) onto the curved face.
 */
export class FrontZMap {
  constructor(x0, x1, y0, y1, res = 128) {
    Object.assign(this, { x0, x1, y0, y1, res });
    this.z = new Float32Array(res * res).fill(-Infinity);
  }
  rasterize(tris) {
    const { x0, x1, y0, y1, res, z } = this;
    const gx = (x) => ((x - x0) / (x1 - x0)) * (res - 1);
    const gy = (y) => ((y - y0) / (y1 - y0)) * (res - 1);
    for (const [a, b, c] of tris) {
      const ax = gx(a[0]), ay = gy(a[1]), bx = gx(b[0]), by = gy(b[1]), cx = gx(c[0]), cy = gy(c[1]);
      const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(det) < 1e-9) continue;
      const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx))), maxX = Math.min(res - 1, Math.ceil(Math.max(ax, bx, cx)));
      const minY = Math.max(0, Math.floor(Math.min(ay, by, cy))), maxY = Math.min(res - 1, Math.ceil(Math.max(ay, by, cy)));
      for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
        const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det;
        const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det;
        const l3 = 1 - l1 - l2;
        if (l1 < -0.02 || l2 < -0.02 || l3 < -0.02) continue;
        const zz = l1 * a[2] + l2 * b[2] + l3 * c[2];
        const k = y * res + x;
        if (zz > z[k]) z[k] = zz;
      }
    }
  }
  covers(x, y) {
    const { x0, x1, y0, y1, res, z } = this;
    const ix = Math.round(((x - x0) / (x1 - x0)) * (res - 1)), iy = Math.round(((y - y0) / (y1 - y0)) * (res - 1));
    if (ix < 0 || iy < 0 || ix >= res || iy >= res) return false;
    return Number.isFinite(z[iy * res + ix]);
  }
  sample(x, y) {
    const { x0, x1, y0, y1, res, z } = this;
    const fx = clamp(((x - x0) / (x1 - x0)) * (res - 1), 0, res - 1.001);
    const fy = clamp(((y - y0) / (y1 - y0)) * (res - 1), 0, res - 1.001);
    const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
    const g = (i, j) => { const v = z[j * res + i]; return Number.isFinite(v) ? v : 0; };
    return lerp(lerp(g(ix, iy), g(ix + 1, iy), tx), lerp(g(ix, iy + 1), g(ix + 1, iy + 1), tx), ty);
  }
}
