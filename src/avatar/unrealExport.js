// "Unreal Engine / MetaHuman" export: a zip with
//   Avatar.glb                 – the full rigged character (Unreal imports glTF as a Skeletal Mesh)
//   Head_for_MetaHuman.obj/.mtl + textures – a static, realistic head for MetaHuman "From Mesh"
//   Face_front.jpg             – the face photo, for reference while matching skin/eyes
//   README-Unreal.txt          – step-by-step instructions
import { zipSync, strToU8 } from 'fflate';
import { describeAvatar } from './builder.js';
import { drawAtlas, atlasRects } from './atlas.js';
import { paintDefaultFace, loadImageCanvas } from './realFace.js';
import { exportAvatar } from './exporter.js';

const HEAD_BONES = ['Head', 'LeftEye', 'RightEye'];

function canvasBytes(cv, type = 'image/png', q) {
  return new Promise((resolve, reject) => cv.toBlob(async (b) => {
    if (!b) return reject(new Error('Could not encode an image'));
    resolve(new Uint8Array(await b.arrayBuffer()));
  }, type, q));
}

/** Head-only OBJ (centimetres, Y up, facing +Z) with two materials sharing one UV set. */
export function headOBJ(desc) {
  const R = atlasRects();
  const hair = R.hair;
  const headIdx = new Set(HEAD_BONES.map((n) => desc.bi[n]).filter((i) => i !== undefined));
  const s = desc.scale * 100;
  const c = desc.headCenter;
  const lines = ['# EasyAvatar head for MetaHuman "From Mesh"', 'mtllib Head_for_MetaHuman.mtl'];
  const vt = [], vn = [];
  let vBase = 0;
  const emit = (mb, keepTri) => {
    const n = mb.count;
    const map = new Int32Array(n).fill(-1);
    const faces = [];
    for (let i = 0; i < mb.idx.length; i += 3) {
      const t = [mb.idx[i], mb.idx[i + 1], mb.idx[i + 2]];
      if (!keepTri(t)) continue;
      faces.push(t);
    }
    const used = [];
    for (const t of faces) for (const v of t) if (map[v] < 0) { map[v] = vBase + used.length; used.push(v); }
    // smooth vertex normals from the kept triangles
    const nrm = new Float64Array(n * 3);
    const P = (v) => [mb.pos[v * 3], mb.pos[v * 3 + 1], mb.pos[v * 3 + 2]];
    for (const [a, b, d] of faces) {
      const A = P(a), B = P(b), C = P(d);
      const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
      const fn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      for (const v of [a, b, d]) for (let k = 0; k < 3; k++) nrm[v * 3 + k] += fn[k];
    }
    for (const v of used) {
      const x = (mb.pos[v * 3] - c[0]) * s, y = (mb.pos[v * 3 + 1] - c[1]) * s, z = (mb.pos[v * 3 + 2] - c[2]) * s;
      lines.push(`v ${x.toFixed(4)} ${y.toFixed(4)} ${z.toFixed(4)}`);
      vt.push(`vt ${mb.uv[v * 2].toFixed(5)} ${(1 - mb.uv[v * 2 + 1]).toFixed(5)}`);
      const l = Math.hypot(nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]) || 1;
      vn.push(`vn ${(nrm[v * 3] / l).toFixed(4)} ${(nrm[v * 3 + 1] / l).toFixed(4)} ${(nrm[v * 3 + 2] / l).toFixed(4)}`);
    }
    const faceLines = faces.map((t) => `f ${t.map((v) => `${map[v] + 1}/${map[v] + 1}/${map[v] + 1}`).join(' ')}`);
    vBase += used.length;
    return faceLines;
  };
  const isHeadVert = (mb, v) => {
    const sk = mb.skin[v];
    return headIdx.has(sk.idx[0]) && sk.w[0] > 0.999;
  };
  const inHair = (mb, v) => {
    const u = mb.uv[v * 2], w = mb.uv[v * 2 + 1];
    return u >= hair.u0 - 1e-4 && u <= hair.u1 + 1e-4 && w >= hair.v0 - 1e-4 && w <= hair.v1 + 1e-4;
  };
  // skull, ears, eyeballs, teeth, mouth (no hair, neck or clothes)
  const bodyFaces = emit(desc.body, (t) => t.every((v) => isHeadVert(desc.body, v) && !inHair(desc.body, v)));
  const faceFaces = emit(desc.face, () => true);
  // OBJ wants every v before faces only by convention; keep it simple and conventional
  const vLines = lines.filter((l) => l.startsWith('v '));
  const out = [lines[0], lines[1], ...vLines, ...vt, ...vn, 'usemtl Skin_Eyes', ...bodyFaces, 'usemtl Face', ...faceFaces];
  return out.join('\n') + '\n';
}

const MTL = `newmtl Skin_Eyes
Kd 1 1 1
map_Kd Head_Skin_Eyes.png

newmtl Face
Kd 1 1 1
map_Kd Head_Face.png
`;

function readme(P, hasScan) {
  return `EasyAvatar → Unreal Engine / MetaHuman
=======================================

What's in this folder
---------------------
  Avatar.glb                 Your full EasyAvatar character, rigged (bones, expressions, clothes).
  Head_for_MetaHuman.obj     A realistic static head built from your ${hasScan ? 'face scan' : 'default face (no scan yet)'}.
  Head_for_MetaHuman.mtl     Materials for the head (+ the two .png textures).
  Face_front.jpg             ${hasScan ? 'Your face photo, to compare against while you fine-tune.' : '(not included – scan your face in EasyAvatar first)'}
  Your colours               Skin ${P.skinColor}   Hair ${P.hairColor}   Eyes ${P.eyeColor}
${hasScan ? '' : `
NOTE: Without a face scan this head is a generic face. For a MetaHuman that looks like you,
open EasyAvatar, scan your face (camera or photo), then export again.
`}
A) Make a lifelike MetaHuman of yourself  (Unreal Engine 5.6 or newer, MetaHuman plugin enabled)
--------------------------------------------------------------------------------------------------
 1. Import: drag Head_for_MetaHuman.obj into the Content Browser.
    In the import options turn ON "Combine Meshes". If the head imports lying down or facing
    away, rotate it in the Static Mesh editor so it stands upright and faces forward.
 2. Open the imported mesh and check both materials show their textures
    (Head_Face and Head_Skin_Eyes). If not, connect each texture's RGB to Base Color and save.
 3. Content Browser → right-click → MetaHuman → MetaHuman Identity. Name it (that's the
    MetaHuman's name) and open it.
 4. Toolbar: Create Components → From Mesh → pick Head_for_MetaHuman.
 5. Select "Neutral Pose". Set the viewport camera Field of View to 20° or less, frame the head
    straight from the front, then click Promote Frame.
 6. Click Track Markers (Active Frame). Lock the camera and drag any markers that are off.
 7. Click MetaHuman Identity Solve (runs in Epic's cloud – you need to be signed in).
 8. Click Auto-Rig MetaHuman Identity. This creates an SK_ skeletal mesh with MetaHuman DNA.
 9. Create a MetaHuman Character asset, open it in MetaHuman Creator and use
    "Conform → From Identity" with the Identity you just made. Then pick hair, skin and eye
    colours (values above), clothes and body type in MetaHuman Creator.

 Live face tracking for the MetaHuman: use Live Link (Live Link Face app on iPhone, or
 MetaHuman Animator with a webcam / mono camera on UE 5.6+).

 Official guide: https://dev.epicgames.com/documentation/en-us/metahuman/from-mesh

B) Use your EasyAvatar character as it is
-----------------------------------------
 - Drag Avatar.glb into the Content Browser. Unreal imports it as a Skeletal Mesh with its
   skeleton, materials and morph targets (expressions).
 - Prefer VRM? Install the free VRM4U plugin and import the .vrm from EasyAvatar instead –
   it keeps the toon shading, spring-bone hair and VRM expressions.
`;
}

/** Build the zip. Returns Uint8Array. */
export async function exportUnrealPackage(params) {
  // the MetaHuman head is always the realistic version, whatever style is showing
  const fs = params.faceScan;
  const hasScan = !!(fs && fs.lm && fs.lm.length === 1404 && fs.tex);
  const realP = { ...params, style: 'real', ...(hasScan && fs.skin ? { skinColor: fs.skin } : {}) };
  const desc = describeAvatar(hasScan ? realP : { ...realP, faceScan: null });

  const files = {};
  const { buffer } = await exportAvatar(params, 'glb');
  files['Avatar.glb'] = new Uint8Array(buffer);
  files['Head_for_MetaHuman.obj'] = strToU8(headOBJ(desc));
  files['Head_for_MetaHuman.mtl'] = strToU8(MTL);
  files['Head_Skin_Eyes.png'] = await canvasBytes(drawAtlas(realP));
  const faceCv = hasScan ? await loadImageCanvas(fs.tex, 1024) : paintDefaultFace(realP, 1024);
  files['Head_Face.png'] = await canvasBytes(faceCv);
  if (hasScan) files['Face_front.jpg'] = await canvasBytes(await loadImageCanvas(fs.tex, 0), 'image/jpeg', 0.92);
  files['README-Unreal.txt'] = strToU8(readme(params, hasScan).replace(/\n/g, '\r\n'));

  const folder = (params.name || 'Avatar').replace(/[^\w\- ]+/g, '').trim() || 'Avatar';
  const nested = {};
  for (const [k, v] of Object.entries(files)) nested[`${folder}-Unreal/${k}`] = v;
  return zipSync(nested, { level: 6 });
}
