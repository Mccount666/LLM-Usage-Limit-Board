// Stub preload for the DOM regression test (npm run test:dom).
const { contextBridge } = require('electron');

// p1: malicious id — used to inject DOM and kill the auto-refresh chain (P1-B).
// p2: configured as `plan` but the backend answers in balance mode (P3-A).
// p3: backend returns an error (exercises the error path).
// p4: uppercase scheme — the old `startsWith('http://')` missed the warning (P2-A).
const providers = [
  { id: 'inj"><img src=x onerror="window.__xssId=1', name: 'Injected', baseUrl: 'https://a.example.com', mode: 'plan', hasKey: true },
  { id: 'p2', name: 'Mode Mismatch', baseUrl: 'https://b.example.com', mode: 'plan', hasKey: true },
  { id: 'p3', name: 'Broken', baseUrl: 'https://c.example.com', mode: 'plan', hasKey: true },
  { id: 'p4', name: 'Cleartext', baseUrl: 'HTTP://plain.example.com', mode: 'plan', hasKey: true },
];

const usage = {
  [providers[0].id]: { ok: true, usage: { mode: 'plan', fiveHourPct: 42.5, weeklyPct: 88 } },
  p2: { ok: true, usage: { mode: 'balance', amount: 30, currency: 'CNY' } },
  p3: { ok: false, error: 'boom' },
  p4: { ok: true, usage: { mode: 'plan', fiveHourPct: 10, weeklyPct: 20 } },
};

let fetchCount = 0;

contextBridge.exposeInMainWorld('api', {
  loadProviders: async () => providers,
  getSecurityStatus: async () => ({ encryptionAvailable: true, platform: 'win32' }),
  saveProviders: async () => ({ ok: true }),
  deleteProvider: async () => ({ ok: true }),
  fetchUsage: async (id) => {
    fetchCount++;
    return usage[id] || { ok: false, error: 'n/a' };
  },
  // Lets the DOM test assert call COUNTS (behaviour) instead of reading source.
  getFetchCount: async () => fetchCount,
  minimizeWindow: async () => {},
  hideWindow: async () => {},
});
