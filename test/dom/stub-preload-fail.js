// Stub preload whose loadProviders() rejects — covers the P2-B error banner.
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadProviders: async () => {
    throw new Error('IPC channel closed');
  },
  getSecurityStatus: async () => ({ encryptionAvailable: true, platform: 'win32' }),
  saveProviders: async () => ({ ok: true }),
  deleteProvider: async () => ({ ok: true }),
  fetchUsage: async () => ({ ok: false, error: 'n/a' }),
  minimizeWindow: async () => {},
  hideWindow: async () => {},
});
