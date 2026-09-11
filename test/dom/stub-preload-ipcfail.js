// Stub preload where delete/window IPC calls REJECT — covers the P1-C fallbacks
// for deleteProvider, minimizeWindow and hideWindow (not just saveProviders).
const { contextBridge } = require('electron');

const providers = [
  { id: 'a1', name: 'Keep Me', baseUrl: 'https://a.example.com', mode: 'plan', hasKey: true },
  { id: 'a2', name: 'Also Here', baseUrl: 'https://b.example.com', mode: 'plan', hasKey: true },
];

contextBridge.exposeInMainWorld('api', {
  loadProviders: async () => providers,
  getSecurityStatus: async () => ({ encryptionAvailable: true, platform: 'win32' }),
  saveProviders: async () => ({ ok: true }),
  deleteProvider: async () => {
    throw new Error('EACCES: providers.json is read-only');
  },
  fetchUsage: async () => ({ ok: true, usage: { mode: 'plan', fiveHourPct: 10, weeklyPct: 20 } }),
  getFetchCount: async () => 0,
  minimizeWindow: async () => {
    throw new Error('window:minimize failed');
  },
  hideWindow: async () => {
    throw new Error('window:hide failed');
  },
});
