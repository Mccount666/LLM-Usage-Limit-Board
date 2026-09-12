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

// Hard block any attempt to open a second instance with a different path.
// Acquired BEFORE anything async so a second launch cannot race the first one
// into creating a window (P3-4).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // Launching the app again while it is minimized/hidden should reveal the
  // existing widget instead of silently doing nothing.
  app.on('second-instance', () => showWidget());
}

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
    icon: path.join(__dirname, 'assets', 'icon.ico'),
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



// --- Window controls + tray --------------------------------------------------
//
// The window is frameless and `skipTaskbar: true`, so once it is minimized or
// hidden there is no OS affordance left to bring it back. A tray icon is created
// lazily on the first minimize/hide; without it the widget would be unreachable
// until the app is restarted.

// 16x16 tray icon — the same three-bar mark as the widget and the installer
// icon (generated by tools/make-icon.js; byte-identical to build/tray.png),
// inlined so packaging needs no external icon asset.
const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAkUlEQVR42mNgYGBg8ApKCPAKSrjvFZTwn0gMUhvAANNs6+z/X9/EjiQM0gM2BGQaSEBETIYkDNID0gsy4D8xBih5mIKxtL4msgH/iTbA614DGOtX+dHRANs16WBNMJo+Bkh6mfyXjrYB02QZIF/n819pQQyYHqIGIIeBRqITWAOMBmFQYkI3gOKkTFlmojQ7AwD6ubG/RvQCXQAAAABJRU5ErkJggg==';

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
    if (!raw || raw.version !== 1) {
      // Never silently discard data: a future v2 file must not look like "no
      // subscriptions". We keep the file untouched and say so (P3-7).
      if (raw) console.warn(`[data] providers.json version ${raw.version} is not supported (expected 1); ignoring its contents`);
      else console.warn('[data] providers.json is not a JSON object; ignoring its contents');
      return { version: 1, providers: [] };
    }
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
    const rawId = incoming?.id;
    if (typeof rawId !== 'string' || rawId.length === 0) {
      return { ok: false, error: '订阅 id 不合法（必须是非空字符串）' };
    }
    // Truncate ONCE and use the truncated value everywhere: dedupe and the
    // stored record must agree, otherwise two ids differing only past char 100
    // pass the uniqueness check and then land on disk as the same entry (P3-3).
    const id = rawId.slice(0, 100);
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
      id,
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

/** Hostname of a URL, or '' when it does not parse. */
function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

// --- Plan mode (Coding Plan / subscription) --------------------------------
// 5h + weekly limits. OpenAI and Anthropic don't expose these for API keys,
// so we surface that honestly. Generic OpenAI-compatible gateways (OneAPI /
// NewAPI / packycode) often do — we try their user-info endpoints.
async function fetchPlanUsage(provider) {
  const base = provider.baseUrl.replace(/\/+$/, '');

  // Match the HOSTNAME, not a substring: `includes('api.openai.com')` also
  // matched "api.openai.com.example.com" and wrongly refused to poll it (P3-8).
  const host = hostOf(base);
  if (host === 'openai.com' || host.endsWith('.openai.com')) {
    return { ok: false, error: 'OpenAI 未提供 5h/周限额接口（订阅与 API 配额分开）' };
  }
  if (host === 'anthropic.com' || host.endsWith('.anthropic.com')) {
    return { ok: false, error: 'Anthropic 未提供 5h/周限额接口' };
  }

  // Strict accept: a 200 with `{success:false,...}` or a user object without any
  // limit field must NOT be accepted, or it would be cached and the endpoint
  // that does carry 5h/weekly data would never be tried again.
  const diag = newProbeDiag();
  const data = await fetchOneAPIUserInfo(provider, (res) => hasPlanLimits(res.data?.data ?? res.data), diag);
  if (!data) return { ok: false, error: explainProbeFailure(diag, provider, 'plan') };

  // Accepted means hasPlanLimits() was true for this exact root, so at least one
  // of the two is non-null. The other side is left as null ON PURPOSE: coercing
  // it to 0 renders a green 0% bar, and "0%" on this board reads as "plenty of
  // quota left" — the most dangerous direction to be wrong in. The renderer
  // shows an unknown state (grey "--") instead. See 第六轮复核 P1-A.
  const fiveHourPct = detectLimitPct(data, FIVE_HOUR_SPEC);
  const weeklyPct = detectLimitPct(data, WEEKLY_SPEC);
  return {
    ok: true,
    usage: {
      mode: 'plan',
      fiveHourPct: fiveHourPct == null ? null : clampPct(fiveHourPct),
      weeklyPct: weeklyPct == null ? null : clampPct(weeklyPct),
    },
  };
}

// --- Failure diagnostics ---------------------------------------------------
//
// Probing several endpoints means a failure can come from very different
// causes: a bad key (401/403), a gateway that answers 200 with
// `{success:false,message:"…"}` because the key lacks permission, or an
// endpoint that simply does not carry the fields we need. "找不到字段" for all
// three sends the user down the wrong path — a wrong API Key is by far the most
// common and it looked identical to "unsupported provider".

function newProbeDiag() {
  // `statuses` only ever holds real HTTP codes; a request that never got a
  // response (timeout / DNS / refused) goes into `errors` instead. Mixing a 0
  // into `statuses` used to break the "all 404" test, so every network failure
  // fell through to "field names do not match" — the exact misdiagnosis this
  // mechanism exists to remove (七-P3).
  // responded: how many candidates answered successfully but were not
  // accepted. Needed because tryFetchJson carries no status on success, so
  // "every status seen was 404" is NOT the same as "nothing answered" — a
  // 200-with-unusable-fields alongside 404s must not be blamed on the URL.
  // unusable (N-20): how many candidates answered HTTP 200 but sent a body
  // that is not JSON (e.g. an SPA fallback page). That is a content problem,
  // distinct from both HTTP errors and "no response at all"; folding it into
  // either bucket made the failure text lie about what happened.
  return { statuses: [], messages: [], errors: [], responded: 0, unusable: 0 };
}

/** Strip anything that could echo the key back into the UI, then truncate. */
function safeMessage(msg, apiKey) {
  if (typeof msg !== 'string' || msg.trim() === '') return '';
  let s = msg.trim();
  if (apiKey) s = s.split(apiKey).join('***');
  s = s.replace(/\b(sk|xai|gsk)-[A-Za-z0-9_\-]{6,}/g, '***');
  return s.slice(0, 120);
}

/** Pull the gateway's own words (message/error/msg) out of a JSON body. */
function gatewayMessage(body) {
  if (!body || typeof body !== 'object') return '';
  // N-30: "absent" is defined by the consumer — a non-empty string. `??` only
  // skips null/undefined, so an early key that exists but is unusable ('' /
  // whitespace / number / object) used to absorb the chain and bury the real
  // words sitting in a later key. Walk the keys in order and take the first
  // value that actually satisfies the contract.
  const m = [body.message, body.error, body.msg].find((v) => typeof v === 'string' && v.trim());
  return m ?? '';
}

function explainProbeFailure(diag, provider, mode) {
  const auth = diag.statuses.find((s) => s === 401 || s === 403);
  if (auth) {
    return `API Key 无效或权限不足（HTTP ${auth}），请检查该订阅的 Key 是否填错/已失效`;
  }
  // Per-class tally (N-16 + N-20): a mixed outcome must report every class it
  // contains — 404s, candidates that never answered, and candidates that
  // answered but sent an unusable body — never collapse one into another.
  const tally = () => {
    const parts = [];
    if (diag.statuses.length) parts.push(`${diag.statuses.length} 个候选返回 ${[...new Set(diag.statuses)].join('/')}`);
    if (diag.errors.length) parts.push(`${diag.errors.length} 个无响应`);
    if (diag.unusable) parts.push(`${diag.unusable} 个有响应但内容不可用`);
    return parts.join('、');
  };
  // NOTHING answered AND nothing usable arrived: report the transport problem,
  // not a field mismatch. (N-20: `unusable`/`responded` must be zero here too,
  // or "网络层" would swallow cases where a candidate did answer.)
  if (
    diag.statuses.length === 0 && diag.errors.length > 0 &&
    diag.unusable === 0 && diag.responded === 0
  ) {
    const raw = diag.errors[0];
    if (/abort|timeout|timed out/i.test(raw)) {
      return '请求超时（10 秒）：服务商没有在超时时间内响应，请检查 Base URL 是否可达、或服务商是否正忙';
    }
    return `请求失败（网络层）：${safeMessage(raw, provider.apiKey)}。请确认 Base URL 可达、且本机网络/代理设置正常`;
  }
  const gateway = diag.messages.find(Boolean);
  if (gateway) {
    // N-26: the gateway branch was the only four-bucket exit that never showed
    // the tally — a probe of 1 gateway message + 3×404 hid the 404s entirely.
    // Deliberately NO "另有/其余" quantifier: the candidate that spoke may
    // itself be one of the counted statuses (a 404 body CAN carry a gateway
    // message — non-2xx bodies are message-parsed since N-28 (a)), so the
    // tally describes the whole probe set, not "the rest".
    const mix = tally();
    return `服务商拒绝了请求：${gateway}${mix ? `（${mix}）` : ''}。若 Key 无误，请把该接口的返回 JSON 发给我适配${mode === 'plan' ? ' 5h/周 限额' : '余额'}字段`;
  }
  const notFound =
    diag.responded === 0 && diag.statuses.length > 0 && diag.statuses.every((s) => s === 404);
  if (notFound) {
    // Mixed failure (N-16/N-20): 404-dominant, but some candidates never
    // answered or answered with an unusable body — "所有候选路径均返回 404"
    // would be false, so enumerate what actually happened per class.
    if (diag.errors.length > 0 || diag.unusable > 0) {
      return `服务商用量接口不可用：${tally()}。请确认 Base URL 是否指向中转站的根地址，且本机网络可达`;
    }
    return `服务商没有提供可用的用量接口（所有候选路径均返回 404）。请确认 Base URL 是否指向中转站的根地址`;
  }
  const fieldMsg = mode === 'plan'
    ? '服务商返回中找不到 5h/周 限额字段'
    : '服务商返回中找不到余额字段';
  const mix = tally();
  return mix
    ? `${fieldMsg}（${mix}）。请把接口 JSON 发给我适配`
    : `${fieldMsg}，请把接口 JSON 发给我适配`;
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
function probeCandidates(provider, kind, paths, headers, accept, diag) {
  const base = provider.baseUrl.replace(/\/+$/, '');
  const key = `${provider.id}:${kind}`;

  const note = (res) => {
    if (!diag) return;
    if (res.ok) diag.responded++;
    else if (res.parseError) diag.unusable++; // answered 200, body not JSON (N-20)
    else if (res.status) diag.statuses.push(res.status);
    else if (res.error) diag.errors.push(res.error); // no response at all
    // N-28 (a): a non-2xx candidate can carry a gateway message too
    // (bodyMessage, parsed in tryFetchJson). It is masked/truncated here
    // exactly like a 200-body message, and the response KEEPS being counted
    // in `statuses` — the speaking candidate stays inside the tally, which is
    // why the gateway branch deliberately carries no "另有" quantifier.
    const msg = gatewayMessage(res.data) || res.bodyMessage || '';
    if (typeof msg === 'string' && msg.trim()) diag.messages.push(safeMessage(msg, provider.apiKey));
  };

  const remembered = candidatePathCache.get(key);
  if (remembered && paths.includes(remembered)) {
    return tryFetchJson(`${base}${remembered}`, provider, headers).then((res) => {
      note(res);
      if (res.ok && accept(res)) return res;
      candidatePathCache.delete(key); // stale — rediscover below
      // N-22: the rediscovery must NOT re-probe `remembered` — it just failed
      // and was already noted above; probing it again would count one
      // candidate twice (the reviewer's probe turned 3×404 + 1×silent into
      // "4 个候选返回 404、1 个无响应") and waste one request.
      return probeAll(paths.filter((p) => p !== remembered));
    });
  }
  return probeAll();

  // First-to-arrive: resolve as soon as ANY candidate is accepted; a slower
  // sibling resolving later is ignored. `done` also stops accept() from being
  // invoked again, which is what lets callers capture the winning parse.
  function probeAll(list) {
    const candidates = list || paths;
    if (candidates.length === 0) return Promise.resolve(null);
    return new Promise((resolve) => {
      let remaining = candidates.length;
      let done = false;
      for (const path of candidates) {
        tryFetchJson(`${base}${path}`, provider, headers)
          .then((res) => {
            if (done) return;
            note(res);
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
  const diag = newProbeDiag();
  const direct = await probeCandidates(provider, 'balance', balanceCandidates, {}, (res) => {
    matched = normalizeBalance(res.data);
    return matched != null;
  }, diag);
  if (direct && matched) return { ok: true, usage: { mode: 'balance', ...matched } };

  // Fall back to the same user-info endpoints and look for a balance-like field.
  // accept already guarantees normalizeBalance() succeeded for the winning
  // response, so carry that parsed value out instead of re-parsing — and instead
  // of keeping a "no balance field" branch that can never be reached (七-P7).
  let viaUserInfo = null;
  const data = await fetchOneAPIUserInfo(provider, (res) => {
    viaUserInfo = normalizeBalance(res.data);
    return viaUserInfo != null;
  }, diag);
  if (!data || !viaUserInfo) return { ok: false, error: explainProbeFailure(diag, provider, 'balance') };
  return { ok: true, usage: { mode: 'balance', ...viaUserInfo } };
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
 * @param diag optional collector for HTTP statuses / gateway messages, so a
 *   failure can be explained instead of always blaming the field names.
 */
async function fetchOneAPIUserInfo(provider, accept, diag) {
  const headers = {
    Authorization: `Bearer ${provider.apiKey}`,
    'Content-Type': 'application/json',
    'User-Agent': 'llm-usage-limit-board/0.1',
  };
  const candidates = ['/api/user/self', '/api/user/token', '/api/user/status', '/api/status'];

  const res = await probeCandidates(provider, 'userinfo', candidates, headers, accept, diag);
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
    if (!res.ok) {
      // N-28 (a): a non-2xx body can still carry the actionable gateway
      // message (reviewer probe ⑤v5: a 404 with {"message":"gateway says no"}
      // used to be swallowed into "所有候选路径均返回 404"). The parse is
      // bounded in effect: a non-JSON body contributes NOTHING (no new
      // counting category — the response still lands in `statuses` via
      // note()), and whatever message is found goes through safeMessage
      // masking/truncation in note() before it can reach the UI.
      let bodyMessage = '';
      try {
        bodyMessage = gatewayMessage(await res.json());
      } catch { /* non-JSON body — counted by status only */ }
      return { ok: false, status: res.status, bodyMessage };
    }
    let data;
    try {
      data = await res.json();
    } catch (err) {
      // N-20: the endpoint DID answer (HTTP 200) but the body is not JSON —
      // often an SPA fallback page for a wrong Base URL path. The old code let
      // this reach the network-error catch below, so a content problem was
      // reported as "no response" and poisoned the failure tally.
      return { ok: false, status: res.status, parseError: err?.message || String(err) };
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

