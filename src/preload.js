// Preload: expose a narrow IPC surface. Renderer never gets Node APIs.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadProviders: () => ipcRenderer.invoke('providers:load'),
  saveProviders: (providers) => ipcRenderer.invoke('providers:save', providers),
  deleteProvider: (id) => ipcRenderer.invoke('providers:delete', id),
  fetchUsage: (providerId) => ipcRenderer.invoke('usage:fetch', providerId),
  getSecurityStatus: () => ipcRenderer.invoke('security:status'),
  hideWindow: () => ipcRenderer.invoke('window:hide'),
  // 双态窗口：mini（透明 + 鼠标穿透的状态条，宽度由渲染层量好后上报）/
  // config（可交互面板）；ui:mode 是托盘强制切换时的反向通知。
  setDisplayMode: (mode, width) => ipcRenderer.invoke('window:set-display-mode', mode, width),
  onUiMode: (cb) => {
    ipcRenderer.on('ui:mode', (_evt, mode) => cb(mode));
  },
});
