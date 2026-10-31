// Export the procedural avatar as VRM 0.x (for VTubing apps / UniVRM) or plain glTF binary.
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { describeAvatar, realize, MORPHS, HUMAN_BONES } from './builder.js';
import { drawAtlas } from './atlas.js';
import { paintDefaultFace, loadImageCanvas, shadeCanvas } from './realFace.js';

function canvasTexture(cv) {
  const t = new THREE.CanvasTexture(cv);
  t.flipY = false; // UVs are authored with glTF's top-left origin
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

// VRM 0.x blend shape groups -> our morph weights (0..1)
const GROUPS = [
  ['Neutral', 'neutral', {}],
  ['A', 'a', { mouthA: 1 }], ['I', 'i', { mouthI: 1 }], ['U', 'u', { mouthU: 1 }], ['E', 'e', { mouthE: 1 }], ['O', 'o', { mouthO: 1 }],
  ['Blink', 'blink', { blinkL: 1, blinkR: 1 }], ['Blink_L', 'blink_l', { blinkL: 1 }], ['Blink_R', 'blink_r', { blinkR: 1 }],
  ['Joy', 'joy', { smile: 1, blinkL: 0.55, blinkR: 0.55, browUp: 0.2 }],
  ['Angry', 'angry', { browAngry: 1, frown: 0.4, blinkL: 0.2, blinkR: 0.2 }],
  ['Sorrow', 'sorrow', { browSad: 1, frown: 0.6, blinkL: 0.15, blinkR: 0.15 }],
  ['Fun', 'fun', { smile: 0.7, blinkL: 0.25, blinkR: 0.25 }],
  ['LookUp', 'lookup', { lookUp: 1 }], ['LookDown', 'lookdown', { lookDown: 1 }],
  ['LookLeft', 'lookleft', { lookLeft: 1 }], ['LookRight', 'lookright', { lookRight: 1 }],
  ['Surprised', 'unknown', { browUp: 1, mouthO: 0.6 }],
];

function mtoon(name, mainTex, shadeTex, { cutout, outline, real }) {
  return {
    name, shader: 'VRM/MToon', renderQueue: cutout ? 2450 : 2000,
    floatProperties: {
      _Cutoff: 0.5, _BumpScale: 1, _ReceiveShadowRate: 1, _ShadingGradeRate: 1, _ShadeShift: real ? -0.2 : -0.05, _ShadeToony: real ? 0.45 : 0.92,
      _LightColorAttenuation: 0, _IndirectLightIntensity: real ? 0.3 : 0.15, _RimLightingMix: 0, _RimFresnelPower: 1, _RimLift: 0,
      _OutlineWidth: outline ? 0.11 : 0, _OutlineScaledMaxDistance: 1, _OutlineLightingMix: 1,
      _UvAnimScrollX: 0, _UvAnimScrollY: 0, _UvAnimRotation: 0, _MToonVersion: 38, _DebugMode: 0,
      _BlendMode: cutout ? 1 : 0, _OutlineWidthMode: outline ? 1 : 0, _OutlineColorMode: 1, _CullMode: 2, _OutlineCullMode: 1,
      _SrcBlend: 1, _DstBlend: 0, _ZWrite: 1, _AlphaToMask: cutout ? 1 : 0,
    },
    vectorProperties: {
      _Color: [1, 1, 1, 1], _ShadeColor: [1, 1, 1, 1], _MainTex: [0, 0, 1, 1], _ShadeTexture: [0, 0, 1, 1],
      _OutlineColor: [0.22, 0.16, 0.17, 1], _EmissionColor: [0, 0, 0, 1], _RimColor: [0, 0, 0, 1],
    },
    textureProperties: { _MainTex: mainTex, _ShadeTexture: shadeTex },
    keywordMap: Object.assign({}, cutout ? { _ALPHATEST_ON: true } : {}, outline ? { MTOON_OUTLINE_WIDTH_WORLD: true, MTOON_OUTLINE_COLOR_MIXED: true } : {}),
    tagMap: { RenderType: cutout ? 'TransparentCutout' : 'Opaque' },
  };
}

class VRMWriterPlugin {
  constructor(writer, ctx) {
    this.writer = writer;
    this.ctx = ctx;
    this.name = 'VRM';
    this.shade = {};
  }
  async writeMaterialAsync(material) {
    const tex = this.ctx.shadeFor[material.name];
    if (tex && this.shade[material.name] === undefined) this.shade[material.name] = await this.writer.processTextureAsync(tex);
  }
  afterParse() {
    const { writer, ctx } = this;
    const json = writer.json, nodeMap = writer.nodeMap;
    const { real, desc, params } = ctx;
    const node = (obj) => nodeMap.get(obj);
    const meshOf = (obj) => json.nodes[node(obj)].mesh;
    const faceMesh = meshOf(real.face), bodyMesh = meshOf(real.body);
    const s = desc.scale;

    const materialProperties = json.materials.map((m) => {
      const main = m.pbrMetallicRoughness?.baseColorTexture?.index ?? 0;
      const cutout = m.alphaMode === 'MASK';
      const real = desc.style === 'real';
      return mtoon(m.name, main, this.shade[m.name] ?? main, { cutout, outline: !cutout && !real, real });
    });

    const curve = [0, 0, 0, 1, 1, 1, 1, 0];
    const morphIndex = (name) => MORPHS.indexOf(name);

    const colliderGroups = [];
    const byBone = new Map();
    for (const c of desc.colliders) {
      if (!byBone.has(c.bone)) { byBone.set(c.bone, colliderGroups.length); colliderGroups.push({ node: node(real.boneObjs[c.bone]), colliders: [] }); }
      const o = real.xp(c.offset); // rotated + scaled like the mesh
      colliderGroups[byBone.get(c.bone)].colliders.push({ offset: { x: o[0], y: o[1], z: -o[2] }, radius: c.radius * s });
    }
    const allGroups = colliderGroups.map((_, i) => i);

    json.extensions = json.extensions || {};
    json.extensions.VRM = {
      exporterVersion: 'EasyAvatar-1.0',
      specVersion: '0.0',
      meta: {
        title: params.name || 'EasyAvatar', version: '1.0', author: params.author || 'EasyAvatar user',
        contactInformation: '', reference: '',
        allowedUserName: 'OnlyAuthor', violentUssageName: 'Disallow', sexualUssageName: 'Disallow',
        commercialUssageName: 'Disallow', otherPermissionUrl: '', licenseName: 'Redistribution_Prohibited', otherLicenseUrl: '',
      },
      humanoid: {
        humanBones: Object.entries(HUMAN_BONES).map(([bone, name]) => ({ bone, node: node(real.boneObjs[name]), useDefaultValues: true })),
        armStretch: 0.05, legStretch: 0.05, upperArmTwist: 0.5, lowerArmTwist: 0.5, upperLegTwist: 0.5, lowerLegTwist: 0.5,
        feetSpacing: 0, hasTranslationDoF: false,
      },
      firstPerson: {
        firstPersonBone: node(real.boneObjs.Head),
        firstPersonBoneOffset: { x: 0, y: 0.06 * s, z: 0 },
        meshAnnotations: [{ mesh: bodyMesh, firstPersonFlag: 'Auto' }, { mesh: faceMesh, firstPersonFlag: 'Auto' }],
        lookAtTypeName: 'BlendShape',
        lookAtHorizontalInner: { curve, xRange: 20, yRange: 1 },
        lookAtHorizontalOuter: { curve, xRange: 20, yRange: 1 },
        lookAtVerticalDown: { curve, xRange: 15, yRange: 1 },
        lookAtVerticalUp: { curve, xRange: 15, yRange: 1 },
      },
      blendShapeMaster: {
        blendShapeGroups: GROUPS.map(([name, presetName, binds]) => ({
          name, presetName, isBinary: false, materialValues: [],
          binds: Object.entries(binds).map(([m, w]) => ({ mesh: faceMesh, index: morphIndex(m), weight: w * 100 })),
        })),
      },
      secondaryAnimation: {
        boneGroups: desc.springs.map((sp) => ({
          comment: sp.comment, stiffiness: sp.stiff, gravityPower: 0.15, gravityDir: { x: 0, y: -1, z: 0 },
          dragForce: 0.4, center: -1, hitRadius: 0.018 * s, bones: [node(real.boneObjs[sp.root])], colliderGroups: allGroups,
        })),
        colliderGroups,
      },
      materialProperties,
    };
    writer.extensionsUsed.VRM = true;
  }
}

/** Build + export. kind: 'vrm' | 'glb'. Returns { buffer, desc } */
export async function exportAvatar(params, kind = 'vrm') {
  const real = params.style === 'real';
  const fs = params.faceScan;
  const scanned = real && fs && fs.lm && fs.lm.length === 1404 && fs.uv && fs.uv.length === 936 && fs.tex;
  // the realistic style uses the true (photo) skin colour so the face blends into the body
  const P = scanned && fs.skin ? { ...params, skinColor: fs.skin } : params;
  const desc = describeAvatar(scanned ? P : { ...P, faceScan: null });
  const atlasTex = canvasTexture(drawAtlas(P));
  const shadeTex = canvasTexture(drawAtlas(P, { shade: true }));
  const body = new THREE.MeshBasicMaterial({ map: atlasTex });
  body.name = 'Body';
  let face, faceTex = null, faceShade = null;
  if (real) {
    const cv = scanned ? await loadImageCanvas(fs.tex) : paintDefaultFace(P);
    faceTex = canvasTexture(cv);
    faceShade = canvasTexture(shadeCanvas(cv));
    face = new THREE.MeshBasicMaterial({ map: faceTex });
    face.name = 'FaceSkin';
  } else {
    face = new THREE.MeshBasicMaterial({ map: atlasTex, alphaTest: 0.5 });
    face.name = 'Face';
  }
  const real3 = realize(desc, { body, face }, kind === 'vrm' ? -1 : 1);
  const exporter = new GLTFExporter();
  const shadeFor = { Body: shadeTex, Face: shadeTex, FaceSkin: faceShade };
  if (kind === 'vrm') exporter.register((writer) => new VRMWriterPlugin(writer, { real: real3, desc, params: P, shadeFor }));
  const buffer = await exporter.parseAsync(real3.root, { binary: true, onlyVisible: false });
  real3.body.geometry.dispose(); real3.face.geometry.dispose();
  for (const t of [atlasTex, shadeTex, faceTex, faceShade]) t?.dispose();
  return { buffer, desc };
}
