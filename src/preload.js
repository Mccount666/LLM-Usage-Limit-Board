// Preload: expose a narrow IPC surface. Renderer never gets Node APIs.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadProviders: () => ipcRenderer.invoke('providers:load'),
  saveProviders: (providers) => ipcRenderer.invoke('providers:save', providers),
  deleteProvider: (id) => ipcRenderer.invoke('providers:delete', id),
  fetchUsage: (providerId) => ipcRenderer.invoke('usage:fetch', providerId),
  getSecurityStatus: () => ipcRenderer.invoke('security:status'),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
});
