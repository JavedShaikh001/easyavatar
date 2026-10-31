// EasyAvatar — Electron main process.
const { app, BrowserWindow, protocol, ipcMain, dialog, session, systemPreferences, net, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_DIR = path.join(__dirname, '..', 'app');
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const SELFTEST_DIR = process.env.EASYAVATAR_SELFTEST || '';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.task': 'application/octet-stream', '.ico': 'image/x-icon',
};

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// Software WebGL fallback for PCs whose graphics driver is blocklisted (slower, but the app still works).
app.commandLine.appendSwitch('enable-unsafe-swiftshader');
if (SELFTEST_DIR) app.commandLine.appendSwitch('ignore-gpu-blocklist');

let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1320, height: 860, minWidth: 980, minHeight: 640,
    title: 'EasyAvatar', backgroundColor: '#eef1f8', show: !SELFTEST_DIR,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  win.loadURL('app://bundle/index.html');
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://')) e.preventDefault(); });
  if (SELFTEST_DIR) win.webContents.on('console-message', (_e, ...args) => {
    const msg = typeof args[0] === 'object' ? args[0].message : args[1];
    console.log('[renderer]', msg);
  });
}

app.whenReady().then(() => {
  protocol.handle('app', async (req) => {
    const url = new URL(req.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const file = path.normalize(path.join(APP_DIR, rel));
    if (!file.startsWith(APP_DIR)) return new Response('Forbidden', { status: 403 });
    try {
      const data = await fs.promises.readFile(file);
      return new Response(data, { headers: { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  // camera is the only permission we ever grant
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb, details) => {
    cb(permission === 'media' && (!details.mediaTypes || details.mediaTypes.every((t) => t === 'video')));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');

  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin' || SELFTEST_DIR) app.quit(); });

ipcMain.handle('ask-camera', async () => {
  if (process.platform !== 'darwin') return true;
  const status = systemPreferences.getMediaAccessStatus('camera');
  if (status === 'granted') return true;
  return systemPreferences.askForMediaAccess('camera');
});

ipcMain.handle('get-model', async (e) => {
  const bundled = path.join(APP_DIR, 'models', 'face_landmarker.task');
  if (fs.existsSync(bundled)) return new Uint8Array(await fs.promises.readFile(bundled));
  const cacheDir = path.join(app.getPath('userData'), 'models');
  const cached = path.join(cacheDir, 'face_landmarker.task');
  if (fs.existsSync(cached)) return new Uint8Array(await fs.promises.readFile(cached));
  e.sender.send('model-status', 'Downloading the face tracker (one time, about 4 MB)…');
  const res = await net.fetch(MODEL_URL);
  if (!res.ok) throw new Error(`Could not download the face tracker (HTTP ${res.status}). Check your internet connection.`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.promises.mkdir(cacheDir, { recursive: true });
  await fs.promises.writeFile(cached, buf);
  return new Uint8Array(buf);
});

ipcMain.handle('save-file', async (_e, { defaultPath, filters, data }) => {
  const r = await dialog.showSaveDialog(win, { defaultPath, filters });
  if (r.canceled || !r.filePath) return null;
  await fs.promises.writeFile(r.filePath, typeof data === 'string' ? data : Buffer.from(data));
  return r.filePath;
});

ipcMain.handle('open-file', async (_e, { filters }) => {
  const r = await dialog.showOpenDialog(win, { filters, properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return null;
  return fs.promises.readFile(r.filePaths[0], 'utf8');
});

ipcMain.handle('show-in-folder', (_e, p) => shell.showItemInFolder(p));

// --- self-test hooks (only active when EASYAVATAR_SELFTEST is set) ---
ipcMain.handle('selftest-info', () => (SELFTEST_DIR ? { dir: SELFTEST_DIR } : null));
ipcMain.handle('selftest-write', async (_e, name, data) => {
  if (!SELFTEST_DIR) return false;
  const out = path.join(SELFTEST_DIR, path.basename(name));
  await fs.promises.writeFile(out, typeof data === 'string' && data.startsWith('data:') ? Buffer.from(data.split(',')[1], 'base64') : Buffer.from(data));
  return true;
});
ipcMain.handle('selftest-done', (_e, code) => { setTimeout(() => app.exit(code || 0), 100); });
