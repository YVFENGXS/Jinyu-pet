const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('petBridge', {
  postMessage(message) {
    ipcRenderer.send('pet:message', message);
  },
  addEventListener(type, callback) {
    if (type !== 'message' || typeof callback !== 'function') return;
    ipcRenderer.on('pet:host', (_event, data) => callback({ data }));
  },
  removeEventListener() { /* the page only adds one listener for the app's lifetime */ }
});

contextBridge.exposeInMainWorld('petFiles', {
  pathForFile(file) {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  }
});
