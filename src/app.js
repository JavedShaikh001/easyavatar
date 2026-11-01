// EasyAvatar renderer: UI, 3D view, scan, VTube and export.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { DEFAULTS, SLIDERS, CHOICES, normalizeParams } from './avatar/params.js';
import { exportAvatar } from './avatar/exporter.js';
import { exportUnrealPackage } from './avatar/unrealExport.js';
import { getLandmarker, startCamera, stopCamera, attach, cameraOn, listCameras, currentCameraId, setPreferredCamera, isBlack, frameState } from './vision.js';
import { scanFace } from './scan.js';
import { Tracker } from './vtube.js';
import { rgbToHex, hslToRgb } from './avatar/color.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const STORE = 'easyavatar.params.v1';

// ---------------- state ----------------
let params = (() => {
  try { return normalizeParams(JSON.parse(localStorage.getItem(STORE))); } catch { return normalizeParams(DEFAULTS); }
})();
const history = [];
let lastCommitted = JSON.stringify(params);
function commit() {
  const now = JSON.stringify(params);
  if (now === lastCommitted) return;
  history.push(lastCommitted);
  if (history.length > 60) history.shift();
  lastCommitted = now;
  try { localStorage.setItem(STORE, now); } catch {}
}
function undo() {
  const prev = history.pop();
  if (!prev) return;
  params = normalizeParams(JSON.parse(prev));
  lastCommitted = prev;
  try { localStorage.setItem(STORE, prev); } catch {}
  syncUI(); scheduleRebuild(0);
}

// ---------------- 3D view ----------------
const stage = $('#stage');
const canvas = $('#view');
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
} catch (e) {
  document.body.innerHTML = '<div style="padding:40px;font:16px system-ui;max-width:560px">'
    + '<h2>EasyAvatar needs 3D graphics (WebGL)</h2><p>Your graphics driver did not allow 3D drawing. '
    + 'Updating your graphics driver usually fixes this. Details: ' + String(e.message).replace(/</g, '&lt;') + '</p></div>';
  throw e;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(28, 1, 0.05, 50);
camera.position.set(0, 1.25, 2.2);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.minDistance = 0.35;
controls.maxDistance = 6;
controls.target.set(0, 1.15, 0);
const sun = new THREE.DirectionalLight(0xffffff, Math.PI * 0.95);
sun.position.set(0.6, 1.4, 1.6);
scene.add(sun);
scene.add(new THREE.AmbientLight(0xffffff, 0.55));

const shadow = (() => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 128;
  const g = cv.getContext('2d'); const gr = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  gr.addColorStop(0, 'rgba(30,35,70,0.28)'); gr.addColorStop(1, 'rgba(30,35,70,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.9), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; m.position.y = 0.002;
  scene.add(m);
  return m;
})();

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);
resize();

// camera framing
let camAnim = null;
let currentView = 'upper';
function viewFor(name) {
  const s = desc ? desc.scale : 1;
  const headY = desc ? desc.headCenter[1] * s : 1.32;
  const top = desc ? desc.headTop * s + 0.06 : 1.5;
  if (name === 'face') return { target: [0, headY - 0.03, 0], pos: [0, headY - 0.01, 0.95] };
  if (name === 'full') return { target: [0, top / 2, 0], pos: [0, top / 2 + 0.15, 3.7] };
  return { target: [0, headY - 0.24, 0], pos: [0, headY - 0.15, 1.75] };
}
function setView(name, instant = false) {
  currentView = name;
  $$('.view-btns button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  const v = viewFor(name);
  const to = { t: new THREE.Vector3(...v.target), p: new THREE.Vector3(...v.pos) };
  if (instant) { controls.target.copy(to.t); camera.position.copy(to.p); camAnim = null; controls.update(); return; }
  camAnim = { from: { t: controls.target.clone(), p: camera.position.clone() }, to, t: 0 };
}
$$('.view-btns button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

// ---------------- avatar build / load ----------------
const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));
let vrm = null, desc = null, buildToken = 0, rebuildTimer = 0, firstBuild = true;

function busy(on) { $('#busy').hidden = !on; }

async function rebuild() {
  const token = ++buildToken;
  busy(true);
  try {
    const snapshot = { ...params };
    const res = await exportAvatar(snapshot, 'vrm');
    if (token !== buildToken) return;
    const gltf = await loader.parseAsync(res.buffer, '');
    const v = gltf.userData.vrm;
    if (token !== buildToken) { VRMUtils.deepDispose(v.scene); return; }
    VRMUtils.rotateVRM0(v);
    v.scene.traverse((o) => { o.frustumCulled = false; });
    if (vrm) { scene.remove(vrm.scene); VRMUtils.deepDispose(vrm.scene); }
    vrm = v; desc = res.desc;
    scene.add(vrm.scene);
    poseIdle(0, true);
    vrm.update(0);
    vrm.springBoneManager?.reset();
    if (firstBuild) { firstBuild = false; setView(currentView, true); }
  } catch (e) {
    console.error(e);
    toast('Something went wrong building the character: ' + e.message);
  } finally {
    if (token === buildToken) busy(false);
  }
}
function scheduleRebuild(delay = 90) {
  clearTimeout(rebuildTimer);
  return new Promise((resolve) => { rebuildTimer = setTimeout(() => rebuild().then(resolve), delay); });
}

// ---------------- idle animation & expressions ----------------
const tracker = new Tracker();
let tracking = false;
let manualExpr = null;
let blinkT = 2, blinkPhase = 0;

function poseIdle(t, armsOnly = false) {
  if (!vrm) return;
  const h = vrm.humanoid;
  const n = (b) => h.getNormalizedBoneNode(b);
  const sway = Math.sin(t * 0.9) * 0.025;
  n('leftUpperArm')?.rotation.set(0, 0, 1.2 - sway);
  n('rightUpperArm')?.rotation.set(0, 0, -1.2 + sway);
  n('leftLowerArm')?.rotation.set(0, -0.25, 0);
  n('rightLowerArm')?.rotation.set(0, 0.25, 0);
  n('leftHand')?.rotation.set(0, 0, 0.1);
  n('rightHand')?.rotation.set(0, 0, -0.1);
  n('chest')?.rotation.set(Math.sin(t * 1.7) * 0.012, 0, 0);
  // relaxed, slightly curled fingers
  for (const [side, sg] of [['left', 1], ['right', -1]]) {
    for (const f of ['Index', 'Middle', 'Ring', 'Little']) for (const ph of ['Proximal', 'Intermediate', 'Distal']) {
      n(`${side}${f}${ph}`)?.rotation.set(0, 0, sg * (ph === 'Proximal' ? 0.25 : 0.4));
    }
  }
  if (armsOnly || tracking) return;
  n('head')?.rotation.set(Math.sin(t * 0.7) * 0.02, Math.sin(t * 0.45) * 0.06, Math.sin(t * 0.6) * 0.02);
  n('neck')?.rotation.set(0, 0, 0);
  n('spine')?.rotation.set(0, Math.sin(t * 0.45) * 0.02, 0);
}

const EXPRS = ['happy', 'angry', 'sad', 'Surprised', 'relaxed'];
function idleExpressions(dt) {
  const em = vrm?.expressionManager;
  if (!em) return;
  for (const e of EXPRS) em.setValue(e, manualExpr === e ? 1 : 0);
  for (const e of ['aa', 'ih', 'ou', 'ee', 'oh', 'blinkLeft', 'blinkRight']) em.setValue(e, 0);
  // natural blinking
  blinkT -= dt;
  if (blinkT <= 0 && blinkPhase === 0) blinkPhase = 0.0001;
  if (blinkPhase > 0) {
    blinkPhase += dt / 0.16;
    if (blinkPhase >= 1) { blinkPhase = 0; blinkT = 2 + Math.random() * 4; }
  }
  const room = manualExpr === 'happy' ? 0.45 : 1;
  em.setValue('blink', Math.min(room, blinkPhase > 0 ? Math.sin(blinkPhase * Math.PI) : 0));
  if (vrm.lookAt) { vrm.lookAt.target = camera; vrm.lookAt.autoUpdate = true; }
}

const clock = new THREE.Clock();
let elapsed = 0;
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.1);
  elapsed += dt;
  if (camAnim) {
    camAnim.t = Math.min(1, camAnim.t + dt / 0.45);
    const k = 1 - Math.pow(1 - camAnim.t, 3);
    controls.target.lerpVectors(camAnim.from.t, camAnim.to.t, k);
    camera.position.lerpVectors(camAnim.from.p, camAnim.to.p, k);
    if (camAnim.t >= 1) camAnim = null;
  }
  controls.update();
  if (vrm) {
    poseIdle(elapsed);
    if (tracking) tracker.apply(vrm, dt, manualExpr);
    else idleExpressions(dt);
    vrm.update(dt);
  }
  renderer.render(scene, camera);
}
requestAnimationFrame(frame);

// ---------------- UI wiring ----------------
function buildControls() {
  for (const [group, el] of [['face', $('#faceSliders')], ['body', $('#bodySliders')]]) {
    el.innerHTML = '';
    for (const [key, label] of SLIDERS[group]) {
      const row = document.createElement('label');
      row.className = 'slider';
      row.innerHTML = `<span>${label}</span><input type="range" min="0" max="1" step="0.01" data-param="${key}">`;
      el.appendChild(row);
    }
  }
  for (const box of $$('[data-choice]')) {
    const key = box.dataset.choice;
    box.innerHTML = '';
    for (const [val, label] of CHOICES[key]) {
      const b = document.createElement('button');
      b.textContent = label; b.dataset.value = val;
      b.addEventListener('click', () => { params[key] = val; commit(); syncUI(); scheduleRebuild(0); });
      box.appendChild(b);
    }
  }
  for (const inp of $$('[data-param]')) {
    inp.addEventListener('input', () => { params[inp.dataset.param] = +inp.value; scheduleRebuild(); });
    inp.addEventListener('change', commit);
    inp.addEventListener('dblclick', () => { params[inp.dataset.param] = DEFAULTS[inp.dataset.param]; commit(); syncUI(); scheduleRebuild(0); });
  }
  for (const inp of $$('[data-color]')) {
    inp.addEventListener('input', () => { params[inp.dataset.color] = inp.value; scheduleRebuild(150); });
    inp.addEventListener('change', commit);
  }
  for (const inp of $$('[data-bool]')) inp.addEventListener('change', () => { params[inp.dataset.bool] = inp.checked; commit(); scheduleRebuild(0); });
  $('#avatarName').addEventListener('input', (e) => { params.name = e.target.value || 'My Avatar'; });
  $('#avatarName').addEventListener('change', commit);
}
function syncUI() {
  for (const inp of $$('[data-param]')) inp.value = params[inp.dataset.param];
  for (const inp of $$('[data-color]')) inp.value = params[inp.dataset.color];
  for (const inp of $$('[data-bool]')) inp.checked = !!params[inp.dataset.bool];
  for (const box of $$('[data-choice]')) for (const b of box.children) b.classList.toggle('active', params[box.dataset.choice] === b.dataset.value);
  $('#avatarName').value = params.name;
  const real = params.style === 'real';
  $('#realNote').hidden = !real || !params.faceScan;
  $('#realNoScan').hidden = !real || !!params.faceScan;
  renderClothList();
}

// tabs
let activeTab = 'scan';
function showTab(name) {
  activeTab = name;
  $$('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('section[data-panel]').forEach((s) => s.classList.toggle('active', s.dataset.panel === name));
  if (name === 'face' || name === 'scan') setView('face');
  else if (name === 'body') setView('full');
  else setView('upper');
}
$$('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

let toastTimer = 0;
function toast(msg, ms = 4200, action = null) {
  const t = $('#toast');
  t.innerHTML = '';
  t.append(document.createTextNode(msg));
  if (action) {
    const b = document.createElement('button');
    b.className = 'btn small'; b.style.marginLeft = '10px'; b.textContent = action.label;
    b.addEventListener('click', action.run);
    t.append(b);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// save / open / export
const safeName = () => (params.name || 'avatar').replace(/[^\w\- ]+/g, '').trim() || 'avatar';
$('#btnSave').addEventListener('click', async () => {
  const p = await window.api.saveFile({
    defaultPath: safeName() + '.easyavatar',
    filters: [{ name: 'EasyAvatar character', extensions: ['easyavatar'] }],
    data: JSON.stringify({ app: 'EasyAvatar', version: 1, params }, null, 2),
  });
  if (p) toast('Saved your character.');
});
$('#btnOpen').addEventListener('click', async () => {
  const txt = await window.api.openFile({ filters: [{ name: 'EasyAvatar character', extensions: ['easyavatar', 'json'] }] });
  if (!txt) return;
  try {
    const obj = JSON.parse(txt);
    params = normalizeParams(obj.params || obj);
    commit(); syncUI(); scheduleRebuild(0);
  } catch { toast("That file isn't an EasyAvatar character."); }
});
const exportMenu = $('#exportMenu');
$('#btnExport').addEventListener('click', (e) => { e.stopPropagation(); exportMenu.hidden = !exportMenu.hidden; });
document.addEventListener('click', () => { exportMenu.hidden = true; });
$$('[data-export]').forEach((b) => b.addEventListener('click', async () => {
  exportMenu.hidden = true;
  const kind = b.dataset.export;
  busy(true);
  try {
    if (kind === 'unreal') {
      const zip = await exportUnrealPackage(params);
      const p = await window.api.saveFile({ defaultPath: `${safeName()}-Unreal.zip`, filters: [{ name: 'Zip folder', extensions: ['zip'] }], data: zip });
      if (p) toast(params.faceScan ? 'Exported for Unreal. Unzip it and follow README-Unreal.txt.' : 'Exported for Unreal. Tip: scan your face first so the MetaHuman looks like you.', 8000, { label: 'Show file', run: () => window.api.showInFolder(p) });
      return;
    }
    const { buffer } = await exportAvatar(params, kind);
    const p = await window.api.saveFile({
      defaultPath: `${safeName()}.${kind}`,
      filters: [{ name: kind === 'vrm' ? 'VRM avatar' : 'glTF binary', extensions: [kind] }],
      data: new Uint8Array(buffer),
    });
    if (p) toast(`Exported ${kind.toUpperCase()}.`, 6000, { label: 'Show file', run: () => window.api.showInFolder(p) });
  } catch (e) {
    console.error(e); toast('Export failed: ' + e.message);
  } finally { busy(false); }
}));

// random avatar
const pick = (a) => a[Math.floor(Math.random() * a.length)];
$('#btnRandom').addEventListener('click', () => {
  const r = () => 0.2 + Math.random() * 0.6;
  for (const g of Object.values(SLIDERS)) for (const [k] of g) params[k] = r();
  params.blush = Math.random() * 0.8;
  const skinL = 0.35 + Math.random() * 0.5;
  params.skinColor = rgbToHex(hslToRgb([0.04 + Math.random() * 0.05, 0.35 + Math.random() * 0.2, skinL]));
  params.hairColor = pick(['#2a1f1c', '#4a3226', '#7b4a2a', '#c99a5a', '#e7d3a1', '#9a2f2f', '#3b4a8f', '#c56fa3', '#e9e9f0', '#2f6d5a', '#151318']);
  params.eyeColor = pick(['#7a4f2e', '#3f6fb0', '#3f8a5a', '#8a4fb0', '#b04f5a', '#c99a3a', '#4f8fa0']);
  params.hairStyle = pick(CHOICES.hairStyle)[0];
  params.bangs = pick(CHOICES.bangs)[0];
  params.hairLength = Math.random();
  params.top = pick(CHOICES.top)[0];
  params.bottom = pick(CHOICES.bottom)[0];
  params.topColor = rgbToHex(hslToRgb([Math.random(), 0.55, 0.55]));
  params.bottomColor = rgbToHex(hslToRgb([Math.random(), 0.3, 0.3]));
  params.ahoge = Math.random() < 0.3;
  commit(); syncUI(); scheduleRebuild(0);
});

// ---------------- scan tab ----------------
const camVideo = $('#cam');
const scanMsg = (m) => { $('#scanMsg').textContent = m; };
let preScan = null;

async function fillCameraList() {
  const cams = await listCameras().catch(() => []);
  const sel = $('#camSelect');
  sel.innerHTML = '';
  for (const c of cams) { const o = document.createElement('option'); o.value = c.id; o.textContent = c.label; sel.appendChild(o); }
  sel.value = currentCameraId();
  $('#camPickWrap').hidden = cams.length < 1;
}
let camSettings = {};
window.api.getSettings().then((st) => {
  camSettings = st || {};
  if (camSettings.platform === 'win32') { $('#compatWrap').hidden = false; $('#optCompat').checked = !!camSettings.cameraCompat; }
});
$('#optCompat').addEventListener('change', (e) => window.api.setCameraCompat(e.target.checked));
$('#btnCompat').addEventListener('click', () => window.api.setCameraCompat(!camSettings.cameraCompat));
function checkPicture() {
  if (!cameraOn()) return;
  const st = frameState(camVideo);
  const help = $('#camHelp');
  if (st === 'ok' || st === 'none') { help.hidden = true; return; }
  const many = $('#camSelect').options.length > 1;
  const win = camSettings.platform === 'win32';
  const what = st === 'black' ? 'black' : 'one flat colour (often green)';
  let txt = `Your camera is on, but its picture is ${what} instead of video.`;
  if (many) txt += ' First try another camera from the list above — laptops often have an infrared "Windows Hello" camera, and OBS/Teams add virtual cameras.';
  if (win) txt += camSettings.cameraCompat
    ? ' Compatibility mode is already on. Check the camera works in the Windows Camera app, and update your webcam and graphics drivers.'
    : ' If that doesn\'t help, switch on compatibility mode: the app restarts and uses the older Windows camera system, which fixes this for most webcams.';
  else txt += ' Check for a privacy shutter or another app using the camera.';
  $('#camHelpText').textContent = txt;
  $('#btnCompat').hidden = !win;
  $('#btnCompat').textContent = camSettings.cameraCompat ? 'Turn compatibility mode off' : 'Use camera compatibility mode';
  help.hidden = false;
  scanMsg("The camera picture is blank — see the tip below");
}
async function turnCameraOn() {
  $('#photoPreview').hidden = true;
  scanMsg('Starting camera…');
  await attach(camVideo, await startCamera());
  $('#btnCam').textContent = 'Turn off camera';
  $('#btnScan').disabled = false;
  scanMsg('Fit your face inside the oval');
  fillCameraList();
  setTimeout(checkPicture, 2500);
  setTimeout(checkPicture, 6000);
  getLandmarker((m) => scanMsg(m)).then(() => { if (!isBlack(camVideo)) scanMsg('Fit your face inside the oval, then press Scan'); }).catch((e) => scanMsg(e.message));
}
$('#btnCam').addEventListener('click', async () => {
  if (cameraOn() && !tracking) {
    stopCamera(); camVideo.srcObject = null;
    $('#btnCam').textContent = 'Turn on camera'; $('#btnScan').disabled = true; scanMsg('Camera is off');
    return;
  }
  try { await turnCameraOn(); } catch (e) { scanMsg(e.message); }
});
$('#camSelect').addEventListener('change', async (e) => {
  setPreferredCamera(e.target.value);
  const wasTracking = tracking;
  if (wasTracking) stopTracking();
  stopCamera(); camVideo.srcObject = null;
  try { await turnCameraOn(); if (wasTracking) startTracking(); } catch (err) { scanMsg(err.message); }
});

$('#btnScan').addEventListener('click', async () => {
  const btn = $('#btnScan');
  btn.disabled = true;
  try {
    const lm = await getLandmarker((m) => scanMsg(m));
    if (frameState(camVideo) !== 'ok') { checkPicture(); return; }
    for (const n of [3, 2, 1]) { $('#scanCount').textContent = n; await new Promise((r) => setTimeout(r, 650)); }
    $('#scanCount').textContent = '';
    const patch = await scanFace(camVideo, lm, { onProgress: (p, m) => scanMsg(`${m} ${Math.round(p * 100)}%`) });
    preScan = { ...params };
    Object.assign(params, patch);
    commit(); syncUI();
    await scheduleRebuild(0);
    for (const [id, k] of [['#swSkin', 'skinColor'], ['#swHair', 'hairColor'], ['#swEye', 'eyeColor']]) $(id).style.background = params[k];
    $('#scanResult').hidden = false;
    scanMsg('Done! Fine-tune anything in the Face and Hair tabs.');
    setView('face');
  } catch (e) {
    $('#scanCount').textContent = '';
    scanMsg(e.message);
  } finally { btn.disabled = false; }
});
$('#btnUndoScan').addEventListener('click', () => {
  if (!preScan) return;
  params = normalizeParams(preScan); preScan = null;
  commit(); syncUI(); scheduleRebuild(0);
  $('#scanResult').hidden = true;
});

// ---------------- avatar from a photo ----------------
function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { resolve(img); setTimeout(() => URL.revokeObjectURL(url), 1000); };
    img.onerror = () => reject(new Error("That file doesn't look like a picture."));
    img.src = url;
  });
}
$('#btnPhoto').addEventListener('click', () => $('#photoFile').click());
$('#photoFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const img = await fileToImage(file);
    // scale big photos down; the scanner treats the canvas like a single still video frame
    const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const cv = document.createElement('canvas');
    cv.width = Math.round(img.naturalWidth * k); cv.height = Math.round(img.naturalHeight * k);
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    cv.videoWidth = cv.width; cv.videoHeight = cv.height;
    const prev = $('#photoPreview');
    prev.src = cv.toDataURL('image/jpeg', 0.85); prev.hidden = false;
    $('#camHelp').hidden = true;
    scanMsg('Reading the photo…');
    const lm = await getLandmarker((m) => scanMsg(m));
    const patch = await scanFace(cv, lm, { frames: 3, onProgress: () => scanMsg('Reading the photo…') });
    preScan = { ...params };
    Object.assign(params, patch);
    commit(); syncUI();
    await scheduleRebuild(0);
    for (const [id, k2] of [['#swSkin', 'skinColor'], ['#swHair', 'hairColor'], ['#swEye', 'eyeColor']]) $(id).style.background = params[k2];
    $('#scanResult').hidden = false;
    scanMsg('Done! Made from your photo. Fine-tune anything in the Face and Hair tabs.');
    setView('face');
  } catch (err) {
    scanMsg(err.message.replace('Please face the camera', 'Use a photo where the face looks') .replace('Move into better light and fill the oval', 'Use a clear, front-facing photo of one face'));
  }
});

// ---------------- clothes from a picture ----------------
let cropState = null;
const cropCv = $('#cropCanvas');
function drawCrop() {
  const { img, rect } = cropState;
  const g = cropCv.getContext('2d');
  g.clearRect(0, 0, cropCv.width, cropCv.height);
  g.drawImage(img, 0, 0, cropCv.width, cropCv.height);
  if (rect) {
    g.fillStyle = 'rgba(20,22,40,0.45)';
    g.beginPath(); g.rect(0, 0, cropCv.width, cropCv.height);
    g.rect(rect.x, rect.y, rect.w, rect.h); g.fill('evenodd');
    g.strokeStyle = '#5b6cff'; g.lineWidth = 2; g.strokeRect(rect.x, rect.y, rect.w, rect.h);
  }
}
function setCropMode(m) { cropState.mode = m; $$('#cropMode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === m)); }
$$('#cropMode button').forEach((b) => b.addEventListener('click', () => setCropMode(b.dataset.mode)));
let clothPart = 'top';
$$('[data-cloth]').forEach((b) => b.addEventListener('click', () => { clothPart = b.dataset.cloth; $('#clothFile').click(); }));
$('#clothFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const img = await fileToImage(file);
    const k = Math.min(560 / img.naturalWidth, 380 / img.naturalHeight, 1);
    cropCv.width = Math.round(img.naturalWidth * k); cropCv.height = Math.round(img.naturalHeight * k);
    cropState = { img, rect: null, scale: k, mode: params[clothPart + 'ImageMode'] || (clothPart === 'top' ? 'print' : 'pattern') };
    $('#cropTitle').textContent = clothPart === 'top' ? 'Picture for the top' : 'Picture for the bottom';
    setCropMode(cropState.mode);
    drawCrop();
    $('#cropModal').hidden = false;
  } catch (err) { toast(err.message); }
});
{
  let start = null;
  const pos = (ev) => { const r = cropCv.getBoundingClientRect(); return { x: ((ev.clientX - r.left) * cropCv.width) / r.width, y: ((ev.clientY - r.top) * cropCv.height) / r.height }; };
  cropCv.addEventListener('pointerdown', (ev) => { start = pos(ev); cropCv.setPointerCapture(ev.pointerId); });
  cropCv.addEventListener('pointermove', (ev) => {
    if (!start) return;
    const p = pos(ev);
    cropState.rect = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
    drawCrop();
  });
  cropCv.addEventListener('pointerup', () => { start = null; if (cropState.rect && (cropState.rect.w < 8 || cropState.rect.h < 8)) { cropState.rect = null; drawCrop(); } });
}
$('#cropCancel').addEventListener('click', () => { $('#cropModal').hidden = true; cropState = null; });
function averageColor(cv, borderOnly) {
  const g = cv.getContext('2d', { willReadFrequently: true });
  const d = g.getImageData(0, 0, cv.width, cv.height).data;
  const px = [];
  for (let y = 0; y < cv.height; y += 2) for (let x = 0; x < cv.width; x += 2) {
    if (borderOnly && x > cv.width * 0.12 && x < cv.width * 0.88 && y > cv.height * 0.12 && y < cv.height * 0.88) continue;
    const i = (y * cv.width + x) * 4;
    if (d[i + 3] < 128) continue;
    px.push([d[i], d[i + 1], d[i + 2]]);
  }
  if (!px.length) return null;
  const med = (c) => px.map((p) => p[c]).sort((a, b) => a - b)[px.length >> 1];
  return rgbToHex([med(0), med(1), med(2)]);
}
$('#cropUse').addEventListener('click', () => {
  const { img, rect, scale, mode } = cropState;
  const sx = rect ? rect.x / scale : 0, sy = rect ? rect.y / scale : 0;
  const sw = rect ? rect.w / scale : img.naturalWidth, sh = rect ? rect.h / scale : img.naturalHeight;
  const k = Math.min(1, 512 / Math.max(sw, sh));
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(sw * k)); out.height = Math.max(1, Math.round(sh * k));
  out.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, out.width, out.height);
  params[clothPart + 'Image'] = out.toDataURL('image/jpeg', 0.88);
  params[clothPart + 'ImageMode'] = mode;
  // garment colour: the picture's background for prints, its overall colour for fabrics
  const col = averageColor(out, mode === 'print');
  if (col) params[clothPart + 'Color'] = col;
  $('#cropModal').hidden = true; cropState = null;
  commit(); syncUI(); scheduleRebuild(0);
  setView(clothPart === 'top' ? 'upper' : 'full');
});
function renderClothList() {
  const box = $('#clothList');
  box.innerHTML = '';
  for (const part of ['top', 'bottom']) {
    const src = params[part + 'Image'];
    if (!src) continue;
    const item = document.createElement('div');
    item.className = 'cloth-item';
    const mode = params[part + 'ImageMode'];
    item.innerHTML = `<img alt=""><div class="grow"><b>${part === 'top' ? 'Top' : 'Bottom'} picture</b><div class="chips">
      <button data-m="print" class="${mode === 'print' ? 'active' : ''}">Print</button><button data-m="pattern" class="${mode === 'pattern' ? 'active' : ''}">Pattern</button></div></div>
      <button class="btn small ghost">Remove</button>`;
    item.querySelector('img').src = src;
    item.querySelectorAll('[data-m]').forEach((b) => b.addEventListener('click', () => { params[part + 'ImageMode'] = b.dataset.m; commit(); syncUI(); scheduleRebuild(0); }));
    item.querySelector('.ghost').addEventListener('click', () => { params[part + 'Image'] = null; commit(); syncUI(); scheduleRebuild(0); });
    box.appendChild(item);
  }
}

// ---------------- VTube tab ----------------
const pip = $('#pip');
let statusTimer = 0;
async function startTracking() {
  const btn = $('#btnTrack');
  btn.disabled = true;
  try {
    $('#trackStatus').textContent = 'Starting camera…';
    const s = await startCamera();
    await attach(pip, s);
    pip.hidden = !$('#optPreview').checked;
    const lm = await getLandmarker((m) => { $('#trackStatus').textContent = m; });
    tracker.mirror = $('#optMirror').checked;
    tracker.start(pip, lm);
    tracking = true;
    btn.textContent = 'Stop tracking';
    $('#btnRecenter').disabled = false;
    statusTimer = setInterval(() => {
      const lost = performance.now() - tracker.lastSeen > 600;
      $('#trackStatus').textContent = lost ? "Can't see your face — move into the camera's view" : `Tracking · ${tracker.fps} fps`;
    }, 500);
    if (activeTab === 'vtube') setView('upper');
  } catch (e) {
    $('#trackStatus').textContent = e.message;
  } finally { btn.disabled = false; }
}
function stopTracking() {
  tracker.stop(); tracking = false;
  clearInterval(statusTimer);
  pip.hidden = true;
  $('#btnTrack').textContent = 'Start tracking';
  $('#btnRecenter').disabled = true;
  $('#trackStatus').textContent = '';
  if (!camVideo.srcObject) stopCamera();
  if (vrm?.humanoid) for (const b of ['head', 'neck', 'spine']) vrm.humanoid.getNormalizedBoneNode(b)?.rotation.set(0, 0, 0);
}
$('#btnTrack').addEventListener('click', () => (tracking ? stopTracking() : startTracking()));
$('#btnRecenter').addEventListener('click', () => tracker.recenter());
$('#optMirror').addEventListener('change', (e) => { tracker.mirror = e.target.checked; });
$('#optPreview').addEventListener('change', (e) => { if (tracking) pip.hidden = !e.target.checked; });
$$('#bgChips button').forEach((b) => b.addEventListener('click', () => {
  $$('#bgChips button').forEach((x) => x.classList.toggle('active', x === b));
  stage.dataset.bg = b.dataset.bg;
  shadow.visible = b.dataset.bg === 'studio' || b.dataset.bg === 'dark';
}));
function setManual(e) {
  manualExpr = manualExpr === e ? null : e;
  $$('#exprChips button').forEach((b) => b.classList.toggle('active', b.dataset.expr === manualExpr));
}
$$('#exprChips button').forEach((b) => b.addEventListener('click', () => setManual(b.dataset.expr)));
$('#btnStream').addEventListener('click', () => { document.body.classList.add('streaming'); setTimeout(resize, 50); });
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input[type=text], input:not([type])')) return;
  if (e.key === 'Escape' && document.body.classList.contains('streaming')) { document.body.classList.remove('streaming'); setTimeout(resize, 50); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
  const n = '12345'.indexOf(e.key);
  if (n >= 0 && !e.ctrlKey && !e.metaKey) setManual(EXPRS[n]);
  if (e.key === '0') setManual(manualExpr);
});

// ---------------- start ----------------
buildControls();
syncUI();
rebuild();

// ---------------- self-test (developer only) ----------------
function testPicture(kind) {
  const cv = document.createElement('canvas'); cv.width = 200; cv.height = 160;
  const g = cv.getContext('2d');
  if (kind === 'plaid') {
    g.fillStyle = '#7a1f2b'; g.fillRect(0, 0, 200, 160);
    g.fillStyle = 'rgba(20,30,60,0.6)'; for (let i = 0; i < 200; i += 40) { g.fillRect(i, 0, 14, 160); g.fillRect(0, i, 200, 14); }
    g.fillStyle = 'rgba(255,220,120,0.5)'; for (let i = 20; i < 200; i += 40) { g.fillRect(i, 0, 3, 160); g.fillRect(0, i, 200, 3); }
  } else {
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 200, 160);
    g.fillStyle = '#ff5a3c'; g.beginPath(); g.arc(100, 70, 46, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#1f2335'; g.font = 'bold 30px sans-serif'; g.textAlign = 'center'; g.fillText('EASY', 100, 150);
  }
  return cv.toDataURL('image/jpeg', 0.9);
}
// A stand-in for a webcam scan: the canonical face, slightly reshaped, "photographed" by painting it.
async function fakeScan() {
  const { CANON_POS, CANON_UV } = await import('./avatar/canonicalFace.js');
  const { paintDefaultFace } = await import('./avatar/realFace.js');
  const lm = CANON_POS.map((v, i) => (i % 3 === 0 ? v * 0.94 : i % 3 === 1 ? v * 1.06 : v));
  const cv = paintDefaultFace({ ...DEFAULTS, skinColor: '#c99272', eyeColor: '#3f6fb0', hairColor: '#2a1f1c' });
  return { lm, uv: [...CANON_UV], tex: cv.toDataURL('image/jpeg', 0.9), skin: '#c99272' };
}
window.api.selftestInfo().then(async (info) => {
  if (!info) return;
  const log = (...a) => console.log('[selftest]', ...a);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (name) => {
    await wait(150);
    // hidden test windows don't get animation frames, so step the scene by hand
    for (let i = 0; i < 30; i++) { controls.update(); if (vrm) { poseIdle(i / 30); vrm.update(1 / 30); } }
    renderer.render(scene, camera);
    await window.api.selftestWrite(name, canvas.toDataURL('image/png'));
  };
  if (info.photo) {
    // developer mode: photo file -> realistic avatar -> Unreal/MetaHuman package
    try {
      const bytes = await window.api.selftestRead(info.photo);
      const blob = new Blob([bytes]);
      const img = await createImageBitmap(blob);
      const k = Math.min(1, 1600 / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      cv.videoWidth = cv.width; cv.videoHeight = cv.height;
      const lm = await getLandmarker((m) => log(m));
      const patch = await scanFace(cv, lm, { frames: 3 });
      params = normalizeParams({ ...DEFAULTS, ...patch, style: 'real', name: 'MyMetaHuman' });
      syncUI(); await rebuild();
      setView('face', true); await shot('photo-face.png');
      await window.api.selftestWrite('photo-unreal.zip', await exportUnrealPackage(params));
      await window.api.selftestWrite('photo-params.json', JSON.stringify(params));
      log('photo ok');
      window.api.selftestDone(0);
    } catch (e) { log('PHOTO FAILED', e.stack || e.message); window.api.selftestDone(1); }
    return;
  }
  try {
    await wait(500);
    const variants = [
      ['default', {}],
      ['long-skirt', { hairStyle: 'long', bangs: 'parted', bottom: 'skirt', top: 'long', topColor: '#f3f3f7', bottomColor: '#3b4a8f', hairColor: '#2a1f1c', eyeColor: '#3f6fb0', hairLength: 0.7, ahoge: true }],
      ['ponytail-shorts', { hairStyle: 'ponytail', bangs: 'side', bottom: 'shorts', top: 'tank', build: 0.9, hairColor: '#c99a5a', skinColor: '#a8714f', eyeColor: '#3f8a5a' }],
      ['real-default', { style: 'real', hairStyle: 'short', bangs: 'side', hairColor: '#3a2a22', eyeColor: '#5a3b26', skinColor: '#d9a98a' }],
      ['real-scan', { style: 'real', hairStyle: 'long', bangs: 'parted', hairLength: 0.5, hairColor: '#2a1f1c', bottom: 'skirt', faceScan: await fakeScan() }],
      ['clothes', { top: 'tshirt', topColor: '#ffffff', topImage: testPicture('print'), topImageMode: 'print', bottom: 'skirt', bottomImage: testPicture('plaid'), bottomImageMode: 'pattern' }],
      ['short-masc', { hairStyle: 'short', bangs: 'side', build: 1, headSize: 0.3, jaw: 0.8, eyeSize: 0.3, eyeOpen: 0.3, hairColor: '#151318', skinColor: '#6b4630', topColor: '#2f6d5a' }],
    ];
    for (const [name, patch] of variants) {
      if (name.startsWith('real')) {
        params = normalizeParams({ ...DEFAULTS, ...patch }); syncUI(); await rebuild();
        setView('face', true); await shot(`${name}-face.png`);
        setView('upper', true); await shot(`${name}-upper.png`);
        setView('full', true); await shot(`${name}-full.png`);
        tracking = true; tracker.apply = () => true;
        for (const ex of ['blink', 'aa', 'happy', 'Surprised']) {
          for (const e of ['blink', 'aa', 'happy', 'Surprised', 'angry', 'sad']) vrm.expressionManager.setValue(e, e === ex ? 1 : 0);
          vrm.humanoid.getNormalizedBoneNode('head').rotation.set(0, 0, 0);
          setView('face', true); vrm.update(0.016); renderer.render(scene, camera);
          await window.api.selftestWrite(`${name}-expr-${ex}.png`, canvas.toDataURL('image/png'));
        }
        for (const e of ['blink', 'aa', 'happy', 'Surprised', 'angry', 'sad']) vrm.expressionManager.setValue(e, 0);
        vrm.lookAt.autoUpdate = false; vrm.lookAt.target = null; vrm.lookAt.yaw = 25; vrm.lookAt.pitch = 0; vrm.update(0.016);
        renderer.render(scene, camera); await window.api.selftestWrite(`${name}-look-left.png`, canvas.toDataURL('image/png'));
        const hand = vrm.humanoid.getNormalizedBoneNode('leftHand'); const hp = new THREE.Vector3(); hand.getWorldPosition(hp);
        controls.target.copy(hp); camera.position.set(hp.x + 0.25, hp.y + 0.05, hp.z + 0.3); controls.update(); poseIdle(1); vrm.update(0.016);
        renderer.render(scene, camera); await window.api.selftestWrite(`${name}-hand.png`, canvas.toDataURL('image/png'));
        tracking = false; delete tracker.apply;
        const { buffer } = await exportAvatar(params, 'vrm');
        await window.api.selftestWrite(`${name}.vrm`, new Uint8Array(buffer));
        if (name === 'real-scan') await window.api.selftestWrite('unreal.zip', await exportUnrealPackage(params));
        log('real ok', name, buffer.byteLength);
        continue;
      }
      params = normalizeParams({ ...DEFAULTS, ...patch });
      syncUI();
      await rebuild();
      log('built', name, 'expressions:', Object.keys(vrm.expressionManager.expressionMap).join(','));
      setView('upper', true); await shot(`${name}-upper.png`);
      setView('full', true); await shot(`${name}-full.png`);
      setView('face', true); await shot(`${name}-face.png`);
      if (name === 'default') {
        const em = vrm.expressionManager;
        tracking = true; tracker.lastSeen = 0;
        tracker.apply = () => true; // freeze live updates while we pose expressions by hand
        const all = [...EXPRS, 'aa', 'ih', 'ou', 'ee', 'oh', 'blink', 'blinkLeft', 'blinkRight', 'lookLeft', 'lookRight', 'lookUp', 'lookDown'];
        for (const ex of ['happy', 'angry', 'sad', 'Surprised', 'aa', 'oh', 'blink', 'blinkLeft', 'lookLeft']) {
          for (const e of all) em.setValue(e, e === ex ? 1 : 0);
          vrm.lookAt.autoUpdate = false; vrm.lookAt.target = null; vrm.lookAt.yaw = 0; vrm.lookAt.pitch = 0;
          vrm.humanoid.getNormalizedBoneNode('head').rotation.set(0, 0, 0);
          vrm.update(0.016);
          renderer.render(scene, camera);
          await window.api.selftestWrite(`expr-${ex}.png`, canvas.toDataURL('image/png'));
        }
        tracking = false;
        delete tracker.apply;
        // side view
        controls.target.set(0, desc.headCenter[1] * desc.scale - 0.2, 0); camera.position.set(1.6, desc.headCenter[1] * desc.scale, 0.6);
        await shot('default-side.png');
        camera.position.set(-0.4, desc.headCenter[1] * desc.scale + 0.2, -1.6);
        await shot('default-back.png');
        for (const kind of ['vrm', 'glb']) {
          const { buffer } = await exportAvatar(params, kind);
          await window.api.selftestWrite(`default.${kind}`, new Uint8Array(buffer));
          log('exported', kind, buffer.byteLength, 'bytes');
        }
      }
    }
    // the face tracker's WebAssembly must load under our CSP
    try {
      const { FilesetResolver, FaceLandmarker } = await import('@mediapipe/tasks-vision');
      const fs = await FilesetResolver.forVisionTasks(new URL('wasm', location.href).href);
      log('wasm fileset ok', JSON.stringify(fs).slice(0, 120));
      try {
        await FaceLandmarker.createFromOptions(fs, { baseOptions: { modelAssetBuffer: new Uint8Array(16), delegate: 'CPU' }, runningMode: 'VIDEO' });
      } catch (e) { log('expected model error (fake model):', String(e.message || e).slice(0, 160)); }
    } catch (e) { log('WASM LOAD FAILED', e.message); }
    window.api.selftestDone(0);
  } catch (e) {
    log('FAILED', e.stack || e.message);
    window.api.selftestDone(1);
  }
});
