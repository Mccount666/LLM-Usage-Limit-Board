// Stub preload whose saveProviders() REJECTS (main-process handler threw).
// Covers 第五轮复核 P1-C: a rejected IPC save used to do nothing visible while
// state.providers had already been mutated.
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadProviders: async () => [],
  getSecurityStatus: async () => ({ encryptionAvailable: true, platform: 'win32' }),
  saveProviders: async () => {
    throw new Error('EACCES: providers.json is read-only');
  },
  deleteProvider: async () => ({ ok: true }),
  fetchUsage: async () => ({ ok: false, error: 'n/a' }),
  getFetchCount: async () => 0,
  minimizeWindow: async () => {},
  hideWindow: async () => {},
  showWindow: async () => {},
});
