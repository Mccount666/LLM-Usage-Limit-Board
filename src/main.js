// Electron main process.
//
// Privacy contract (this file is the ONLY place network egress can happen):
//   1. The only outbound HTTP requests are `fetchUsage()` calls, each going
//      directly to the user-supplied `baseUrl`.
//   2. No analytics, no telemetry, no auto-update check, no remote config,
//      no crash report. Electron's auto-updater is intentionally NOT wired up.
//   3. Providers (incl. API keys) are persisted encrypted via Windows DPAPI
//      (safe-store, bound to this OS user account) at:
//        %APPDATA%/llm-usage-limit-board/providers.json
//   4. No remote server. No account. No sync. Reinstall = lose data = expected.

const { app, BrowserWindow, ipcMain, screen, safeStorage, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const {
  detectLimitPct,
  normalizeBalance,
  clampPct,
  FIVE_HOUR_SPEC,
  WEEKLY_SPEC,
} = require('./lib/limits');

// --- In-memory provider cache (P1-5 + N-4) --------------------------------
// Declared at the top so no IPC handler can ever hit TDZ.
// `usage:fetch` is called every 60s × N providers. Re-reading the encrypted
// file from disk and re-running DPAPI on every poll is wasteful and blocks
// the main process event loop. We hydrate once and invalidate on writes.
let providerCache = null;
function getCachedProviders() {
  if (providerCache) return providerCache;
  providerCache = readAll().providers;
  return providerCache;
}

// Which candidate path last produced a usable payload, keyed `${id}:${kind}`.
// Endpoint probing (P3-C) would otherwise re-request every candidate on every
// 60s poll; remembering the winner keeps the steady state at ONE request while
// the first poll still discovers it quickly (probes run concurrently).
const candidatePathCache = new Map();

function invalidateProviderCache() {
  providerCache = null;
  candidatePathCache.clear();
}

// Disable Electron's hardware acceleration crash report upload before app
// is ready. We never want anything leaving this machine.
app.commandLine.appendSwitch('disable-crash-reporter');

let widgetWindow = null;

// --- Window ----------------------------------------------------------------
function createWidgetWindow() {
  const display = screen.getPrimaryDisplay();
  const { width: screenW, height: screenH } = display.workAreaSize;

  const widgetWidth = 420;
  const widgetHeight = 520;

  widgetWindow = new BrowserWindow({
    width: widgetWidth,
    height: widgetHeight,
    x: screenW - widgetWidth - 20,
    y: screenH - widgetHeight - 20,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    title: 'LLM Usage Limit Board',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Block any accidental navigation away from local files.
      webSecurity: true,
    },
  });

  // P3-5: `floating` is honoured on macOS and Windows; Linux WMs generally
  // ignore the level argument but still apply the "always on top" hint.
  widgetWindow.setAlwaysOnTop(true, 'floating');
  // P3-5: "visible on all workspaces" is a macOS/Linux concept. On Windows the
  // window is already global, so the call is a no-op there and is skipped to
  // avoid platform-specific quirks.
  if (process.platform !== 'win32') {
    widgetWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  // Refuse to open external URLs inside the widget — privacy guard.
  widgetWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  widgetWindow.webContents.on('will-navigate', (e) => e.preventDefault());

  widgetWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWidgetWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWidgetWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Hard block any attempt to open a second instance with a different path.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // Launching the app again while it is minimized/hidden should reveal the
  // existing widget instead of silently doing nothing.
  app.on('second-instance', () => showWidget());
}

// --- Window controls + tray --------------------------------------------------
//
// The window is frameless and `skipTaskbar: true`, so once it is minimized or
// hidden there is no OS affordance left to bring it back. A tray icon is created
// lazily on the first minimize/hide; without it the widget would be unreachable
// until the app is restarted.

// 16x16 green dot, inlined so packaging needs no external icon asset.
const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAbUlEQVR42mPwutfAQAnGJcHpda8hxOteQzUUh0DFiDIApOGL172G/2j4C1QOrwGLsGhEx4twGVBNhGYYrkY3gBOHs3HhL7AwgRkQQoJmGA5BNqCaDAOqqWoAxV6gOBApjkaqJCSqJGWqZCaSMAAgTixvBdKGYAAAAABJRU5ErkJggg==';

let tray = null;

function showWidget() {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  if (widgetWindow.isMinimized()) widgetWindow.restore();
  widgetWindow.show();
  widgetWindow.focus();
}

function ensureTray() {
  if (tray) return;
  try {
    tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON_DATA_URL));
    tray.setToolTip('LLM 用量看板');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示看板', click: showWidget },
        { type: 'separator' },
        { label: '退出', click: () => app.quit() },
      ]),
    );
    tray.on('click', showWidget);
  } catch (err) {
    // A tray failure must never take the app down.
    console.error('tray creation failed', err);
    tray = null;
  }
}

ipcMain.handle('window:minimize', () => {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  widgetWindow.minimize();
  ensureTray();
});
ipcMain.handle('window:hide', () => {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  widgetWindow.hide();
  ensureTray();
});
ipcMain.handle('window:show', () => showWidget());

app.on('before-quit', () => {
  if (tray) {
    tray.destroy();
    tray = null;
  }
});

// --- Encrypted persistence --------------------------------------------------
//
// File shape on disk:
//   { version: 1, providers: [{ id, name, baseUrl, apiKeyEnc }] }
// `apiKeyEnc` is base64 of safeStorage-encrypted plaintext, only decryptable
// by the same OS user on the same machine.
function dataFile() {
  return path.join(app.getPath('userData'), 'providers.json');
}

function readAll() {
  const file = dataFile();
  try {
    if (!fs.existsSync(file)) return { version: 1, providers: [] };
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!raw || raw.version !== 1) return { version: 1, providers: [] };
    return raw;
  } catch (err) {
    console.error('readAll failed; starting empty', err);
    return { version: 1, providers: [] };
  }
}

function writeAll(state) {
  const file = dataFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf-8');
}

function encryptKey(plain) {
  if (!safeStorage.isEncryptionAvailable()) {
    // Fallback: store as plain UTF-8 string wrapped in a marker. This only
    // happens on Linux without a keyring; on Windows DPAPI is always available.
    console.warn('[security] safeStorage unavailable; API key will be stored as base64 (NOT encrypted)');
    return { v: 1, alg: 'plain', data: Buffer.from(plain, 'utf-8').toString('base64') };
  }
  const buf = safeStorage.encryptString(plain);
  return { v: 1, alg: 'dpapi', data: buf.toString('base64') };
}

function decryptKey(rec) {
  if (!rec) return '';
  if (rec.alg === 'plain') return Buffer.from(rec.data, 'base64').toString('utf-8');
  if (rec.alg === 'dpapi') {
    if (!safeStorage.isEncryptionAvailable()) return '';
    return safeStorage.decryptString(Buffer.from(rec.data, 'base64'));
  }
  return '';
}

// --- IPC: providers --------------------------------------------------------
const VALID_MODES = new Set(['plan', 'balance']);

// P2-5: surface whether OS-level encryption is available so the UI can warn
// the user instead of silently writing a base64 (unencrypted) key.
ipcMain.handle('security:status', () => {
  return {
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    platform: process.platform,
  };
});

ipcMain.handle('providers:load', () => {
  const state = readAll();
  // Never send the decrypted key to the renderer unless explicitly asked.
  // We strip it here; renderer holds the key only in memory after edit.
  return state.providers.map((p) => ({
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    mode: VALID_MODES.has(p.mode) ? p.mode : 'plan',
    hasKey: Boolean(p.apiKeyEnc?.data),
  }));
});

ipcMain.handle('providers:save', (_evt, providers) => {
  // `providers` from renderer: [{ id, name, baseUrl, mode, apiKey? }]
  // `apiKey === undefined` means "keep existing"; `apiKey === ''` means "delete";
  // any non-empty string means "replace".
  const state = readAll();
  const byId = new Map(state.providers.map((p) => [p.id, p]));

  const next = [];
  const seenIds = new Set();
  for (const incoming of providers) {
    // P3-B: an `undefined`/non-string id is silently dropped by
    // JSON.stringify, which would leave an unaddressable record on disk
    // (every lookup by data-id then misses). Reject it and duplicates up front.
    const id = incoming?.id;
    if (typeof id !== 'string' || id.length === 0) {
      return { ok: false, error: '订阅 id 不合法（必须是非空字符串）' };
    }
    if (seenIds.has(id)) {
      return { ok: false, error: `订阅 id 重复: ${id}` };
    }
    seenIds.add(id);

    const prev = byId.get(id);

    // baseUrl protocol check (P2-3). `file:` / `javascript:` etc. must not
    // make it to disk — Electron fetch can read local files via `file://`.
    const rawBaseUrl = String(incoming.baseUrl || '');
    let protocol = '';
    try {
      protocol = new URL(rawBaseUrl).protocol;
    } catch {
      return { ok: false, error: `Base URL 格式不合法: ${rawBaseUrl}` };
    }
    if (protocol !== 'http:' && protocol !== 'https:') {
      return { ok: false, error: `Base URL 协议不支持: ${protocol || '(unknown)'}` };
    }

    let apiKeyEnc = prev?.apiKeyEnc;
    if (incoming.apiKey === '') apiKeyEnc = null;
    else if (typeof incoming.apiKey === 'string' && incoming.apiKey.length > 0) {
      apiKeyEnc = encryptKey(incoming.apiKey);
    }
    next.push({
      id: id.slice(0, 100),
      name: String(incoming.name || '').slice(0, 100),
      baseUrl: rawBaseUrl.slice(0, 500),
      mode: VALID_MODES.has(incoming.mode) ? incoming.mode : 'plan',
      apiKeyEnc,
    });
  }

  writeAll({ version: 1, providers: next });
  // P1-5: invalidate the in-memory cache so the next usage:fetch re-reads.
  invalidateProviderCache();
  return { ok: true };
});

ipcMain.handle('providers:delete', (_evt, id) => {
  const state = readAll();
  state.providers = state.providers.filter((p) => p.id !== id);
  writeAll(state);
  invalidateProviderCache();
  return { ok: true };
});

// --- IPC: usage fetch ------------------------------------------------------
//
// This is the ONLY function in the codebase that opens an outbound socket.
// It targets exactly one URL: `${provider.baseUrl}${candidatePath}`.
// There is no fallback to any other host. If you want to verify, grep for
// `fetch(` — this file is the only place it appears.
ipcMain.handle('usage:fetch', async (_evt, providerId) => {
  const stored = getCachedProviders().find((p) => p.id === providerId);
  if (!stored) return { ok: false, error: '订阅不存在' };
  if (!stored.apiKeyEnc) return { ok: false, error: '尚未填写 API Key' };

  // P2-3 read-side: even if the file was hand-edited or migrated from an
  // older version, we must not pass a non-HTTP(S) URL to `fetch`.
  const rawBaseUrl = String(stored.baseUrl || '');
  try {
    const u = new URL(rawBaseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { ok: false, error: `Base URL 协议不支持: ${u.protocol}（仅允许 http/https）` };
    }
  } catch {
    return { ok: false, error: `Base URL 格式不合法: ${rawBaseUrl}` };
  }

  const apiKey = decryptKey(stored.apiKeyEnc);
  if (!apiKey) return { ok: false, error: 'API Key 解密失败' };

  const provider = {
    id: stored.id,
    name: stored.name,
    baseUrl: rawBaseUrl,
    apiKey,
    mode: VALID_MODES.has(stored.mode) ? stored.mode : 'plan',
  };

  return fetchUsage(provider);
});

async function fetchUsage(provider) {
  try {
    if (provider.mode === 'balance') return await fetchBalanceUsage(provider);
    return await fetchPlanUsage(provider);
  } catch (err) {
    return { ok: false, error: `请求失败: ${err?.message || String(err)}` };
  }
}

// --- Plan mode (Coding Plan / subscription) --------------------------------
// 5h + weekly limits. OpenAI and Anthropic don't expose these for API keys,
// so we surface that honestly. Generic OpenAI-compatible gateways (OneAPI /
// NewAPI / packycode) often do — we try their user-info endpoints.
async function fetchPlanUsage(provider) {
  const base = provider.baseUrl.replace(/\/+$/, '');
  const lower = base.toLowerCase();

  if (lower.includes('api.openai.com')) {
    return { ok: false, error: 'OpenAI 未提供 5h/周限额接口（订阅与 API 配额分开）' };
  }
  if (lower.includes('anthropic')) {
    return { ok: false, error: 'Anthropic 未提供 5h/周限额接口' };
  }

  // Strict accept: a 200 with `{success:false,...}` or a user object without any
  // limit field must NOT be accepted, or it would be cached and the endpoint
  // that does carry 5h/weekly data would never be tried again.
  const data = await fetchOneAPIUserInfo(provider, (res) => hasPlanLimits(res.data?.data ?? res.data));
  if (!data) {
    // Covers both "nothing usable came back" and "no endpoint carried limits".
    // Keep the actionable hint: field-name adaptation needs the raw JSON.
    return { ok: false, error: '服务商返回中找不到 5h/周 限额字段，请把接口 JSON 发给我适配' };
  }

  // Accepted means hasPlanLimits() was true for this exact root, so at least one
  // of the two is non-null — no further emptiness check needed.
  const fiveHourPct = detectLimitPct(data, FIVE_HOUR_SPEC);
  const weeklyPct = detectLimitPct(data, WEEKLY_SPEC);
  return {
    ok: true,
    usage: {
      mode: 'plan',
      fiveHourPct: clampPct(fiveHourPct ?? 0),
      weeklyPct: clampPct(weeklyPct ?? 0),
    },
  };
}


// --- Balance mode (gateway / pay-as-you-go) --------------------------------
// Shows remaining account balance. Many gateways return this as a numeric
// `quota` (usually in cents) or as explicit `balance`/`remain` fields.

/**
 * Resolve the first candidate path that yields a payload accepted by `accept`.
 *
 * Why this shape (第五轮复核 P1-A + P1-B):
 *  - The candidates are alternative spellings of the SAME query on the same
 *    host, so probing them concurrently bounds worst-case latency (4 × 10s
 *    serially → ~10s).
 *  - But it must be FIRST-TO-ARRIVE, not `Promise.all`: waiting for the slowest
 *    candidate means a fast, correct endpoint can be held up by an unrelated
 *    slow/black-holing one (measured: 10ms answer delayed to 8s).
 *  - The remembered winner is tried alone first, so steady-state polling costs
 *    ONE request. If it stops working we fall through to a fresh probe.
 *  - `accept` MUST verify the payload actually parses into what the caller
 *    needs. A loose "is an object" test would cache a useless-but-200 response
 *    and permanently stop trying the candidate that does work.
 *
 * @returns the accepted `{ok:true,...}` result, or null
 */
function probeCandidates(provider, kind, paths, headers, accept) {
  const base = provider.baseUrl.replace(/\/+$/, '');
  const key = `${provider.id}:${kind}`;

  const remembered = candidatePathCache.get(key);
  if (remembered && paths.includes(remembered)) {
    return tryFetchJson(`${base}${remembered}`, provider, headers).then((res) => {
      if (res.ok && accept(res)) return res;
      candidatePathCache.delete(key); // stale — rediscover below
      return probeAll();
    });
  }
  return probeAll();

  // First-to-arrive: resolve as soon as ANY candidate is accepted; a slower
  // sibling resolving later is ignored. `done` also stops accept() from being
  // invoked again, which is what lets callers capture the winning parse.
  function probeAll() {
    if (paths.length === 0) return Promise.resolve(null);
    return new Promise((resolve) => {
      let remaining = paths.length;
      let done = false;
      for (const path of paths) {
        tryFetchJson(`${base}${path}`, provider, headers)
          .then((res) => {
            if (done) return;
            if (res.ok && accept(res)) {
              done = true;
              candidatePathCache.set(key, path);
              resolve(res);
              return;
            }
            if (--remaining === 0) resolve(null);
          })
          .catch(() => {
            if (!done && --remaining === 0) resolve(null);
          });
      }
    });
  }
}

async function fetchBalanceUsage(provider) {
  const balanceCandidates = ['/api/user/balance', '/api/user/wallet', '/api/user/quota'];
  // `matched` is set by accept() for the winning candidate only — probeCandidates
  // stops calling accept once a winner is found, so we parse once, not twice (P3-I).
  let matched = null;
  const direct = await probeCandidates(provider, 'balance', balanceCandidates, {}, (res) => {
    matched = normalizeBalance(res.data);
    return matched != null;
  });
  if (direct && matched) return { ok: true, usage: { mode: 'balance', ...matched } };

  // Fall back to the same user-info endpoints and look for a balance-like field.
  const data = await fetchOneAPIUserInfo(provider, (res) => Boolean(normalizeBalance(res.data)));
  if (!data) return { ok: false, error: '服务商未返回余额字段' };

  const normalized = normalizeBalance(data);
  if (!normalized) return { ok: false, error: '服务商返回中找不到余额字段' };
  return { ok: true, usage: { mode: 'balance', ...normalized } };
}

// --- Shared HTTP helper ----------------------------------------------------
/** True when this root yields at least one usable 5h/weekly limit. */
function hasPlanLimits(root) {
  if (!root || typeof root !== 'object') return false;
  return detectLimitPct(root, FIVE_HOUR_SPEC) != null || detectLimitPct(root, WEEKLY_SPEC) != null;
}

/**
 * @param accept decides whether a candidate response is good enough to use (and
 *   to remember). Callers pass a STRICT test — "it parsed into what I need" —
 *   never "it looks like JSON".
 */
async function fetchOneAPIUserInfo(provider, accept) {
  const headers = {
    Authorization: `Bearer ${provider.apiKey}`,
    'Content-Type': 'application/json',
    'User-Agent': 'llm-usage-limit-board/0.1',
  };
  const candidates = ['/api/user/self', '/api/user/token', '/api/user/status', '/api/status'];

  const res = await probeCandidates(provider, 'userinfo', candidates, headers, accept);
  if (!res) return null;
  return res.data?.data ?? res.data;
}

async function tryFetchJson(url, provider, extraHeaders = {}) {
  const headers = {
    'User-Agent': 'llm-usage-limit-board/0.1',
    ...extraHeaders,
  };
  if (extraHeaders.Authorization == null && provider.apiKey) {
    headers.Authorization = `Bearer ${provider.apiKey}`;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    // redirect:'error' enforces the privacy contract: an outbound request
    // must not silently follow a 30x to a different host.
    const res = await fetch(url, { headers, signal: ctrl.signal, redirect: 'error' });
    if (!res.ok) return { ok: false, status: res.status };
    const data = await res.json();
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

