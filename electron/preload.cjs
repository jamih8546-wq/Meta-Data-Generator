const electron = require('electron');
const { contextBridge, ipcRenderer, webUtils } = electron;
const fs = require('fs');
const path = require('path');

const electronApi = {
  isElectron: true,
  getPathForFile: (file) => {
    try {
      if (webUtils && typeof webUtils.getPathForFile === 'function') {
        const p = webUtils.getPathForFile(file);
        if (p) return p;
      }
    } catch (e) {}
    return file ? (file.path || '') : '';
  },
  selectFilesOrFolder: (mode, isFolder) =>
    ipcRenderer.invoke('select-files-dialog', { mode, isFolder }),
  writeLocalFile: (filePath, data, oldPath) => {
    try {
      let buffer;
      if (Buffer.isBuffer(data)) {
        buffer = data;
      } else if (data instanceof Uint8Array) {
        buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      } else if (data instanceof ArrayBuffer) {
        buffer = Buffer.from(data);
      } else if (typeof data === 'string') {
        buffer = Buffer.from(data, 'base64');
      } else {
        buffer = Buffer.from(data);
      }
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, buffer);
      if (oldPath && oldPath !== filePath && fs.existsSync(oldPath)) {
        try { fs.unlinkSync(oldPath); } catch (e) {}
      }
      return Promise.resolve({ success: true, filePath });
    } catch (err) {
      return ipcRenderer.invoke('write-local-file', { filePath, base64Data: data, oldPath });
    }
  },
  renameLocalFile: (oldPath, newPath) => {
    try {
      if (fs.existsSync(oldPath)) {
        if (oldPath === newPath) return Promise.resolve({ success: true, newPath });
        if (fs.existsSync(newPath)) {
          try { fs.unlinkSync(newPath); } catch (e) {}
        }
        fs.renameSync(oldPath, newPath);
        return Promise.resolve({ success: true, newPath });
      }
    } catch (e) {}
    return ipcRenderer.invoke('rename-local-file', { oldPath, newPath });
  },
  deleteLocalFile: (filePath) => {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        return Promise.resolve({ success: true });
      }
    } catch (e) {}
    return ipcRenderer.invoke('delete-local-file', { filePath });
  },
  readLocalFile: (filePath) => {
    try {
      if (fs.existsSync(filePath)) {
        const data = fs.readFileSync(filePath);
        return Promise.resolve({
          success: true,
          buffer: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
          base64: data.toString('base64')
        });
      }
    } catch (e) {}
    return ipcRenderer.invoke('read-local-file', { filePath });
  },
  runIllustratorAutomation: (items) =>
    ipcRenderer.invoke('run-illustrator-automation', { items }),
  onIllustratorProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('illustrator-progress', handler);
    return () => ipcRenderer.removeListener('illustrator-progress', handler);
  },
  runPhotoshopAutomation: (items) =>
    ipcRenderer.invoke('run-photoshop-automation', { items }),
  onPhotoshopProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('photoshop-progress', handler);
    return () => ipcRenderer.removeListener('photoshop-progress', handler);
  }
};

// Expose directly to window
if (typeof window !== 'undefined') {
  window.electronApi = electronApi;
}

// Also expose via contextBridge if available
try {
  if (contextBridge && typeof contextBridge.exposeInMainWorld === 'function') {
    contextBridge.exposeInMainWorld('electronApi', electronApi);
  }
} catch (e) {}

module.exports = electronApi;
