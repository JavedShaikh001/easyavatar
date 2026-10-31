const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  askCamera: () => ipcRenderer.invoke('ask-camera'),
  getModel: () => ipcRenderer.invoke('get-model'),
  onModelStatus: (fn) => ipcRenderer.on('model-status', (_e, msg) => fn(msg)),
  saveFile: (opts) => ipcRenderer.invoke('save-file', opts),
  openFile: (opts) => ipcRenderer.invoke('open-file', opts),
  showInFolder: (p) => ipcRenderer.invoke('show-in-folder', p),
  selftestInfo: () => ipcRenderer.invoke('selftest-info'),
  selftestWrite: (name, data) => ipcRenderer.invoke('selftest-write', name, data),
  selftestDone: (code) => ipcRenderer.invoke('selftest-done', code),
});
