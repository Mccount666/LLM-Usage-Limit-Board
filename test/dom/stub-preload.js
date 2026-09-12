// Stub preload for the DOM regression test (npm run test:dom).
const { contextBridge } = require('electron');

// p1: malicious id — used to inject DOM and kill the auto-refresh chain (P1-B).
// p2: configured as `plan` but the backend answers in balance mode (P3-A).
// p3: backend returns an error (exercises the error path).
// p4: uppercase scheme — the old `startsWith('http://')` missed the warning (P2-A).
// p5: reports ONLY the weekly window — the 5h side must render as unknown ("--"),
//     never as a green 0% bar (第六轮复核 P1-A).
const providers = [
  { id: 'inj"><img src=x onerror="window.__xssId=1', name: 'Injected', baseUrl: 'https://a.example.com', mode: 'plan', hasKey: true },
  { id: 'p2', name: 'Mode Mismatch', baseUrl: 'https://b.example.com', mode: 'plan', hasKey: true },
  { id: 'p3', name: 'Broken', baseUrl: 'https://c.example.com', mode: 'plan', hasKey: true },
  { id: 'p4', name: 'Cleartext', baseUrl: 'HTTP://plain.example.com', mode: 'plan', hasKey: true },
  { id: 'p5', name: 'Weekly Only', baseUrl: 'https://e.example.com', mode: 'plan', hasKey: true },
  { id: 'p6', name: 'Big Balance', baseUrl: 'https://f.example.com', mode: 'balance', hasKey: true },
];

const usage = {
  [providers[0].id]: { ok: true, usage: { mode: 'plan', fiveHourPct: 42.5, weeklyPct: 88 } },
  p2: { ok: true, usage: { mode: 'balance', amount: 30, currency: '' } },
  p3: { ok: false, error: 'boom' },
  p4: { ok: true, usage: { mode: 'plan', fiveHourPct: 10, weeklyPct: 20 } },
  p5: { ok: true, usage: { mode: 'plan', fiveHourPct: null, weeklyPct: 80 } },
  // deliberately long, no currency label (raw quota) — must not be clipped
  p6: { ok: true, usage: { mode: 'balance', amount: 12345678, currency: '' } },
};

let fetchCount = 0;
let saveCount = 0;

contextBridge.exposeInMainWorld('api', {
  loadProviders: async () => providers,
  getSecurityStatus: async () => ({ encryptionAvailable: true, platform: 'win32' }),
  saveProviders: async () => {
    saveCount++;
    return { ok: true };
  },
  deleteProvider: async () => ({ ok: true }),
  fetchUsage: async (id) => {
    fetchCount++;
    return usage[id] || { ok: false, error: 'n/a' };
  },
  // Lets the DOM test assert call COUNTS (behaviour) instead of reading source.
  getFetchCount: async () => fetchCount,
  getSaveCount: async () => saveCount,
  // Lets the DOM test flip a provider's canned answer mid-scenario (used to
  // walk a row from the unknown state into the error state and back).
  setUsage: async (id, value) => { usage[id] = value; },
  minimizeWindow: async () => {},
  hideWindow: async () => {},
  // 双态窗口（displayMode）：DOM 场景只断言渲染层形态；这里记录 setDisplayMode
  // 的调用供场景需要时断言，onUiMode 不推送（托盘路径由真实主进程覆盖）。
  setDisplayMode: async (mode, width) => { displayModeCalls.push([mode, width]); return { ok: true }; },
  onUiMode: (cb) => {},
});
let displayModeCalls = [];

