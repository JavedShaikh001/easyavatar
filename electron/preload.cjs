const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  askCamera: () => ipcRenderer.invoke('ask-camera'),
  getModel: () => ipcRenderer.invoke('get-model'),
  onModelStatus: (fn) => ipcRenderer.on('model-status', (_e, msg) => fn(msg)),
  saveFile: (opts) => ipcRenderer.invoke('save-file', opts),
  openFile: (opts) => ipcRenderer.invoke('open-file', opts),
  showInFolder: (p) => ipcRenderer.invoke('show-in-folder', p),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setCameraCompat: (on) => ipcRenderer.invoke('set-camera-compat', on),
  selftestInfo: () => ipcRenderer.invoke('selftest-info'),
  selftestWrite: (name, data) => ipcRenderer.invoke('selftest-write', name, data),
  selftestRead: (p) => ipcRenderer.invoke('selftest-read', p),
  selftestDone: (code) => ipcRenderer.invoke('selftest-done', code),
});
