import { describeAvatar, realize } from '../src/avatar/builder.js';
import { DEFAULTS } from '../src/avatar/params.js';
import * as THREE from 'three';
for (const style of ['short','bob','long','ponytail']) for (const bottom of ['pants','skirt','shorts']) {
  const P = {...DEFAULTS, hairStyle: style, bottom, ahoge: true, bangs: style==='long'?'parted':'full'};
  const t0 = performance.now();
  const d = describeAvatar(P);
  const r = realize(d, {body: new THREE.MeshBasicMaterial(), face: new THREE.MeshBasicMaterial()}, -1);
  const t1 = performance.now();
  for (const m of [r.body, r.face]) {
    const pos = m.geometry.attributes.position.array, idx = m.geometry.index.array;
    let nan = 0; for (const v of pos) if (!Number.isFinite(v)) nan++;
    let vol = 0;
    for (let i=0;i<idx.length;i+=3){ const a=idx[i]*3,b=idx[i+1]*3,c=idx[i+2]*3;
      const ax=pos[a],ay=pos[a+1],az=pos[a+2],bx=pos[b],by=pos[b+1],bz=pos[b+2],cx=pos[c],cy=pos[c+1],cz=pos[c+2];
      vol += (ax*(by*cz-bz*cy) - ay*(bx*cz-bz*cx) + az*(bx*cy-by*cx))/6; }
    const box = new THREE.Box3().setFromBufferAttribute(m.geometry.attributes.position);
    if (style==='bob'&&bottom==='pants'||nan) console.log(style,bottom,m.name,'verts',pos.length/3,'tris',idx.length/3,'nan',nan,'vol',vol.toFixed(4),'box',box.min.toArray().map(v=>v.toFixed(2)),box.max.toArray().map(v=>v.toFixed(2)), (t1-t0).toFixed(0)+'ms', 'morphs', m.geometry.morphAttributes.position?.length);
  }
  if (style==='long'&&bottom==='pants') console.log('bones', d.bones.length, d.springs.map(s=>s.root).join(','));
}

// realistic style: alignment recovers the face shape from a rotated, scaled "camera" view
import { landmarksToShape } from '../src/avatar/realFace.js';
import { CANON_POS } from '../src/avatar/canonicalFace.js';
{
  const W = 1280, H = 720, yaw = 0.25, s = 0.0045;
  const lm = [];
  for (let i = 0; i < 468; i++) {
    const [x, y, z] = [CANON_POS[i * 3], CANON_POS[i * 3 + 1], CANON_POS[i * 3 + 2]];
    const rx = x * Math.cos(yaw) + z * Math.sin(yaw), rz = -x * Math.sin(yaw) + z * Math.cos(yaw);
    lm.push({ x: 0.5 + rx * s * (H / W), y: 0.5 - y * s, z: -rz * s * (H / W) });
  }
  const shape = landmarksToShape(lm, W, H);
  let err = 0; for (let i = 0; i < shape.length; i++) err = Math.max(err, Math.abs(shape[i] - CANON_POS[i]));
  console.log('face alignment max error (cm):', err.toFixed(3));
  if (err > 0.05) { console.error('alignment FAILED'); process.exit(1); }
  const d = describeAvatar({ ...DEFAULTS, style: 'real', faceScan: { lm: shape, uv: new Array(936).fill(0.5) } });
  console.log('real face verts', d.face.count, 'morphs', [...d.face.morphs].filter(([, m]) => m.size).map(([n, m]) => n + ':' + m.size).join(' '));
}
