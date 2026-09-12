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
  numOf,
  clampPct,
  parseWindowedUsage,
  parseOpenCodeUsage,
  parseOpenRouterCredits,
  parseDeepSeekBalance,
  parseMiniMaxRemains,
  parseZhipuQuota,
  parseCopilotQuota,
  parseCherryInUserBalance,
  FIVE_HOUR_SPEC,
  WEEKLY_SPEC,
} = require('./lib/limits');

// --- In-memory provider cache (P1-5 + N-4) --------------------------------
// Declared at the top so no IPC handler can ever hit TDZ.
// `usage:fetch` is called every 10s × N providers. Re-reading the encrypted
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
// 10s poll; remembering the winner keeps the steady state at ONE request while
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

// --- Display modes: config（交互面板）/ mini（透明穿透状态条）----------------
// mini 的窗口宽度由渲染层量好传上来；位置锚在工作区右下角。穿透 =
// setIgnoreMouseEvents(true)：点击/悬停全部落到它下面的窗口，状态条只可看，
// 因此回到配置面板的唯一入口是托盘。
function applyWindowDisplayMode(mode, width) {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  // 迷你条鼠标完全穿透，托盘是它唯一的回程——切态时惰性确保存在，
  // 否则「启动即 mini」的用户会被锁在穿透条里出不来。
  ensureTray();
  const wa = screen.getPrimaryDisplay().workArea;
  if (mode === 'mini') {
    const w = Math.max(200, Math.min(Number(width) || 560, wa.width - 24));
    const h = 44;
    widgetWindow.setBounds({
      x: wa.x + wa.width - w - 12,
      y: wa.y + wa.height - h - 8,
      width: w,
      height: h,
    });
    widgetWindow.setIgnoreMouseEvents(true);
  } else {
    widgetWindow.setBounds({
      x: wa.x + wa.width - 420 - 20,
      y: wa.y + wa.height - 520 - 20,
      width: 420,
      height: 520,
    });
    widgetWindow.setIgnoreMouseEvents(false);
    widgetWindow.show();
    widgetWindow.focus();
  }
}

/** 主进程侧切换形态，并通知渲染层（渲染层负责 localStorage 偏好与条内重绘）。 */
function setDisplayModeAndNotify(mode, width) {
  applyWindowDisplayMode(mode, width);
  if (widgetWindow && !widgetWindow.isDestroyed()) {
    widgetWindow.webContents.send('ui:mode', mode === 'mini' ? 'mini' : 'config');
  }
}

function showWidget() {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  if (widgetWindow.isMinimized()) widgetWindow.restore();
  widgetWindow.show();
  widgetWindow.focus();
  // 托盘是迷你条唯一可回的入口：显示看板 = 回到交互面板。
  setDisplayModeAndNotify('config');
}

function ensureTray() {
  if (tray) return;
  try {
    tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON_DATA_URL));
    tray.setToolTip('LLM 用量看板');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '配置面板', click: () => setDisplayModeAndNotify('config') },
        { label: '迷你状态条', click: () => setDisplayModeAndNotify('mini') },
        { type: 'separator' },
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

ipcMain.handle('window:hide', () => {
  if (!widgetWindow || widgetWindow.isDestroyed()) return;
  widgetWindow.hide();
  ensureTray();
});
// window:minimize 已移除（第二十八部分§28.九）：「-」键改为收缩迷你状态条，
// 最小化到任务栏的旧路径随之退场，缩小 IPC 面。
ipcMain.handle('window:set-display-mode', (_evt, mode, width) => {
  applyWindowDisplayMode(mode === 'mini' ? 'mini' : 'config', width);
  return { ok: true };
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

  // Kimi Code (Kimi For Coding): GET {base}/usages (fallback /usage) with the
  // Kimi Code console key (sk-kimi-...). Community-verified endpoint — the
  // CLI's own /usage command and kimi-code-usage both speak it. The CLI's
  // User-Agent is sent because the endpoint is undocumented and may gate on
  // client identity; it is the user's own quota being queried.
  if (host === 'kimi.com' || host.endsWith('.kimi.com')) {
    return fetchKimiPlanUsage(provider);
  }
  // OpenCode Go: GET {base}/usage with the Go API key. Response shape from the
  // opencode console source (packages/console/app/src/routes/zen/go/v1/usage.ts):
  // { usage: { rolling/weekly/monthly: { status, percent, resetsAt } } }.
  if (host === 'opencode.ai' || host.endsWith('.opencode.ai')) {
    return fetchOpenCodeGoPlanUsage(provider);
  }
  // MiniMax Token Plan：GET {base}/v1/api/openplatform/coding_plan/remains。
  // 只覆盖 5h 滚动窗口，响应无周侧 → weeklyPct 留 null（灰 "--"）。
  if (host === 'minimaxi.com' || host.endsWith('.minimaxi.com') ||
      host === 'minimax.io' || host.endsWith('.minimax.io')) {
    return fetchMiniMaxPlanUsage(provider);
  }
  // GitHub Copilot：两步换票——GET /copilot_internal/v2/token（OAuth token，
  // PAT 不受支持）→ {token} → GET /copilot_internal/user → quota_snapshots。
  // Premium 请求（月度重置）是付费计划的稀缺额度：percent_remaining 反推已用。
  if (host === 'github.com' || host.endsWith('.github.com')) {
    return fetchCopilotPlanUsage(provider);
  }
  // 火山方舟 Coding Plan：无公开 Key 直查接口（诚实拒答，零探测）。
  if (host === 'volces.com' || host.endsWith('.volces.com') ||
      host === 'volcengine.com' || host.endsWith('.volcengine.com')) {
    return guardVolcanoPlan();
  }
  // 智谱 GLM Coding Plan：GET {origin}/api/monitor/usage/quota/limit。
  // 智谱鉴权风格：裸 Key 直接放 Authorization（无 Bearer 前缀）；
  // 鉴权失败是 HTTP 200 + {success:false}（不在状态码里），accept 必须查标志。
  // 用户常填模型请求端点（/api/coding/paas/v4、/api/anthropic）——归一化到
  // origin 后统一落到查询端点（同 host）。
  if (host === 'bigmodel.cn' || host.endsWith('.bigmodel.cn') ||
      host === 'z.ai' || host.endsWith('.z.ai')) {
    return fetchZhipuPlanUsage(provider);
  }
  // Step Plan（阶跃星辰订阅制）与 MiniMax 同为 5h+周双窗口，但官方至今未开放
  // 查询接口（cc-switch #4454 在等）——按量余额请走「余额」模式。
  if (host === 'stepfun.com' || host.endsWith('.stepfun.com') ||
      host === 'stepfun.ai' || host.endsWith('.stepfun.ai')) {
    return { ok: false, error: 'Step Plan 暂无公开的 5h/周额度接口（官方未开放）。按量余额请改用「余额」模式，Base URL 填 https://api.stepfun.com' };
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

// Kimi Code 用量：候选路径同时兼容两种 Base URL 填法——完整形
// `https://api.kimi.com/coding/v1`（拼 /usages 即命中）与光主机
// `https://api.kimi.com`（社区工具 XiaoZ-0218/kimi-usage 的约定，需补
// /coding/v1 前缀）。并发探测先到先用并记忆，稳态轮询只发一枪。语义沿用
// plan 模式：解析不出的一侧留 null（灰 "--"），绝不伪造 0%。
const KIMI_USAGE_PATHS = ['/usages', '/usage', '/coding/v1/usages', '/coding/v1/usage'];
async function fetchKimiPlanUsage(provider) {
  const diag = newProbeDiag();
  const headers = {
    Authorization: `Bearer ${provider.apiKey}`,
    'User-Agent': 'KimiCLI/1.6',
  };
  const res = await probeCandidates(provider, 'kimi-usage', KIMI_USAGE_PATHS, headers, (r) => {
    const p = parseWindowedUsage(r.data);
    return p.fiveHourPct != null || p.weeklyPct != null;
  }, diag);
  if (!res) {
    const msg = explainProbeFailure(diag, provider, 'plan');
    // 404 主导的失败说明连路径都没对上——把两种正确填法直接给出来。
    const hint = /404|没有提供可用的用量接口/.test(msg)
      ? '。Kimi Code 的 Base URL 填 https://api.kimi.com/coding/v1 或 https://api.kimi.com 均可' : '';
    return { ok: false, error: msg + hint };
  }
  const p = parseWindowedUsage(res.data);
  return {
    ok: true,
    usage: {
      mode: 'plan',
      fiveHourPct: p.fiveHourPct == null ? null : clampPct(p.fiveHourPct),
      weeklyPct: p.weeklyPct == null ? null : clampPct(p.weeklyPct),
    },
  };
}

// OpenCode Go 用量：{base}/usage（base = https://opencode.ai/zen/go/v1）。
// 401 = Key 无效，403 = 无 Go 订阅（EntitlementError）——都落进认证分支，
// 服务商原话经 gatewayMessage 提取后随错误文案展示。
const OPENCODE_USAGE_PATHS = ['/usage'];
async function fetchOpenCodeGoPlanUsage(provider) {
  const diag = newProbeDiag();
  const headers = { Authorization: `Bearer ${provider.apiKey}` };
  const res = await probeCandidates(provider, 'opencode-usage', OPENCODE_USAGE_PATHS, headers, (r) => {
    const p = parseOpenCodeUsage(r.data);
    return p.fiveHourPct != null || p.weeklyPct != null;
  }, diag);
  if (!res) {
    const msg = explainProbeFailure(diag, provider, 'plan');
    const hint = /404|没有提供可用的用量接口/.test(msg)
      ? '。OpenCode Go 的 Base URL 应为 https://opencode.ai/zen/go/v1' : '';
    return { ok: false, error: msg + hint };
  }
  const p = parseOpenCodeUsage(res.data);
  return {
    ok: true,
    usage: {
      mode: 'plan',
      fiveHourPct: p.fiveHourPct == null ? null : clampPct(p.fiveHourPct),
      weeklyPct: p.weeklyPct == null ? null : clampPct(p.weeklyPct),
    },
  };
}

// Moonshot 开放平台余额：{base}/users/me/balance（base = https://api.moonshot.cn/v1
// 或 api.moonshot.ai/v1）。响应形如 { code: 0, data: { balance: "12.34", … } } ——
// normalizeBalance 的 `root.data ?? root` 对两种包一层都成立；FIELDS 里 balance
// 优先于 total_balance 之外的字段，取到的即「可用余额」。
const MOONSHOT_BALANCE_PATHS = ['/users/me/balance'];
async function fetchMoonshotBalance(provider) {
  const diag = newProbeDiag();
  const headers = { Authorization: `Bearer ${provider.apiKey}` };
  let matched = null;
  const res = await probeCandidates(provider, 'moonshot-balance', MOONSHOT_BALANCE_PATHS, headers, (r) => {
    matched = normalizeBalance(r.data);
    return matched != null;
  }, diag);
  if (!res) {
    const msg = explainProbeFailure(diag, provider, 'balance');
    const hint = /404|没有提供可用的用量接口/.test(msg)
      ? '。Moonshot 开放平台的 Base URL 应为 https://api.moonshot.cn/v1' : '';
    return { ok: false, error: msg + hint };
  }
  return { ok: true, usage: { mode: 'balance', ...matched } };
}

// OpenRouter 按量余额：{base}/credits（base = https://openrouter.ai/api/v1）→
// { data: { total_credits, total_usage } }（USD 字符串）。可用 = 充值 - 已用，
// 解析交给 parseOpenRouterCredits。
const OPENROUTER_CREDIT_PATHS = ['/credits'];
async function fetchOpenRouterBalance(provider) {
  const diag = newProbeDiag();
  const headers = { Authorization: `Bearer ${provider.apiKey}` };
  let parsed = null;
  const res = await probeCandidates(provider, 'openrouter-credits', OPENROUTER_CREDIT_PATHS, headers, (r) => {
    parsed = parseOpenRouterCredits(r.data);
    return parsed != null;
  }, diag);
  if (!res) {
    const msg = explainProbeFailure(diag, provider, 'balance');
    const hint = /404|没有提供可用的用量接口/.test(msg)
      ? '。OpenRouter 的 Base URL 填 https://openrouter.ai/api/v1' : '';
    return { ok: false, error: msg + hint };
  }
  return { ok: true, usage: { mode: 'balance', amount: parsed.amount, currency: parsed.currency, field: 'credits' } };
}

// DeepSeek 按量余额：{base}/user/balance（base = https://api.deepseek.com）。
// 官方文档同时教用户填 /v1（OpenAI 兼容形）——两个路径变体都实测存活
// （哑密钥均 401），并发探测先到先用，填哪种都能命中。
// 响应官方键为 balance_infos 数组（api-docs.deepseek.com 查询余额），解析见
// parseDeepSeekBalance（balance 别名与顶层 total_balance 兼容）。
// base 以 /v1 结尾的填法先归一化去掉（同 host，仅去文档惯用的 /v1 前缀），
// 两种填法都落到同一规范端点。
const DEEPSEEK_BALANCE_PATHS = ['/user/balance', '/v1/user/balance'];
async function fetchDeepSeekBalance(providerIn) {
  const diag = newProbeDiag();
  const headers = { Authorization: `Bearer ${providerIn.apiKey}` };
  const rawBase = providerIn.baseUrl.replace(/\/+$/, '');
  const normBase = rawBase.endsWith('/v1') ? rawBase.slice(0, -3) : rawBase;
  // 就地换名，保证九个 probeCandidates 调用点形参同形（P3-C 不变量）。
  const provider = normBase === rawBase ? providerIn : { ...providerIn, baseUrl: normBase };
  let parsed = null;
  const res = await probeCandidates(provider, 'deepseek-balance', DEEPSEEK_BALANCE_PATHS, headers, (r) => {
    parsed = parseDeepSeekBalance(r.data);
    return parsed != null;
  }, diag);
  if (!res) {
    const msg = explainProbeFailure(diag, provider, 'balance');
    const hint = /404|没有提供可用的用量接口/.test(msg)
      ? '。DeepSeek 的 Base URL 填 https://api.deepseek.com（或带 /v1）' : '';
    return { ok: false, error: msg + hint };
  }
  return { ok: true, usage: { mode: 'balance', amount: parsed.amount, currency: parsed.currency, field: 'balance' } };
}

// StepFun 按量余额：{base}/v1/accounts（base = https://api.stepfun.com）→
// { object: "account", balance: <float>, … }——balance 字段恰在 normalizeBalance
// 的字段表里，直接复用。注意 Step Plan 订阅额度与该余额相互独立且无查询接口。
const STEPFUN_BALANCE_PATHS = ['/v1/accounts'];
async function fetchStepFunBalance(provider) {
  const diag = newProbeDiag();
  const headers = { Authorization: `Bearer ${provider.apiKey}` };
  let matched = null;
  const res = await probeCandidates(provider, 'stepfun-balance', STEPFUN_BALANCE_PATHS, headers, (r) => {
    matched = normalizeBalance(r.data);
    return matched != null;
  }, diag);
  if (!res) {
    const msg = explainProbeFailure(diag, provider, 'balance');
    const hint = /404|没有提供可用的用量接口/.test(msg)
      ? '。StepFun 的 Base URL 填 https://api.stepfun.com' : '';
    return { ok: false, error: msg + hint };
  }
  return { ok: true, usage: { mode: 'balance', ...matched } };
}

// MiniMax Token Plan 用量：{base}/v1/api/openplatform/coding_plan/remains
// （base 填 https://www.minimaxi.com）。语义陷阱（已对 coding-plan-monitor 的
// minimax.ts 核实）：current_interval_usage_count 是「剩余」不是「已用」——
// used = total - 剩余。解析交给 parseMiniMaxRemains，这里只做编排与提示。
const MINIMAX_REMAINS_PATHS = ['/v1/api/openplatform/coding_plan/remains'];
async function fetchMiniMaxPlanUsage(provider) {
  const diag = newProbeDiag();
  const headers = {
    Authorization: `Bearer ${provider.apiKey}`,
    'Content-Type': 'application/json',
  };
  const res = await probeCandidates(provider, 'minimax-remains', MINIMAX_REMAINS_PATHS, headers, (r) => {
    return parseMiniMaxRemains(r.data) != null;
  }, diag);
  if (!res) {
    const msg = explainProbeFailure(diag, provider, 'plan');
    const hint = /404|没有提供可用的用量接口/.test(msg)
      ? '。MiniMax Token Plan 的 Base URL 填 https://www.minimaxi.com' : '';
    return { ok: false, error: msg + hint };
  }
  const pct = parseMiniMaxRemains(res.data);
  return {
    ok: true,
    usage: {
      mode: 'plan',
      fiveHourPct: pct == null ? null : clampPct(pct),
      weeklyPct: null, // 响应无周侧——留灰，不伪造
    },
  };
}

// 智谱 GLM Coding Plan 用量：{origin}/api/monitor/usage/quota/limit
// （端点与形状已对 cc-switch Discussion #1038 与 coding-plan-monitor 核实）。
// TIME_LIMIT → 5h 列；TOKENS_LIMIT → 第二列（其周期社区标注不一，README 有
// 如实说明）。鉴权失败 = HTTP 200 + success:false，由 accept 的 null 拒绝。
const ZHIPU_QUOTA_PATHS = ['/api/monitor/usage/quota/limit'];
async function fetchZhipuPlanUsage(providerIn) {
  const diag = newProbeDiag();
  const headers = {
    Authorization: String(providerIn.apiKey || ''),
    'Content-Type': 'application/json',
  };
  const rawBase = providerIn.baseUrl.replace(/\/+$/, '');
  let origin = rawBase;
  try {
    origin = new URL(rawBase).origin;
  } catch {
    origin = rawBase; // keep the raw base; the probe will fail honestly
  }
  // 就地换名，保证 probeCandidates 调用点形参同形（P3-C 不变量）。
  const provider = origin === rawBase ? providerIn : { ...providerIn, baseUrl: origin };
  let parsed = null;
  const res = await probeCandidates(provider, 'zhipu-quota', ZHIPU_QUOTA_PATHS, headers, (r) => {
    parsed = parseZhipuQuota(r.data);
    return parsed != null;
  }, diag);
  if (!res) {
    const msg = explainProbeFailure(diag, provider, 'plan');
    const hint = /404|没有提供可用的用量接口|找不到/.test(msg)
      ? '。GLM Coding Plan 的 Base URL 填 https://open.bigmodel.cn（Z.ai 填 https://api.z.ai），填模型端点会自动归一' : '';
    return { ok: false, error: msg + hint };
  }
  const p = parseZhipuQuota(res.data);
  return {
    ok: true,
    usage: {
      mode: 'plan',
      fiveHourPct: p.fiveHourPct == null ? null : clampPct(p.fiveHourPct),
      weeklyPct: p.weeklyPct == null ? null : clampPct(p.weeklyPct),
      secondLabel: 'Token', // TOKENS_LIMIT 的周期官方未明示——列标签如实标注
    },
  };
}

// CherryIN（Cherry Studio 官方聚合网关，New API 栈）按量余额：OpenAI 式账单
// 对——GET /v1/dashboard/billing/subscription（hard_limit_usd）与
// /v1/dashboard/billing/usage（total_usage，按 one-api 惯例为美分）。
// 可用 = hard_limit_usd - total_usage / 100。换算若与站点实测不符，错误横幅
// 会引导回传 JSON 适配。
const CHERRYIN_SUB_PATH = '/v1/dashboard/billing/subscription';
const CHERRYIN_USAGE_PATH = '/v1/dashboard/billing/usage';
async function fetchCherryInBalance(provider) {
  // 级联两段（同一把 Key，两种凭证体系）：
  // ① sk- 令牌 → OpenAI 式账单对（/v1/dashboard/billing/*）；
  // ② 失败则降级控制台「访问令牌」体系 → /api/user/* 族（New API 用户端点，
  //    官方对计费路由逐步加了用户校验，sk- 可能被 402/401 拒——访问令牌可达）。
  //    访问令牌两种拼法都试：`Bearer <token>` 与裸 token（one-api 兼容）。
  // Key 框可选双要素格式「令牌|用户ID」：提供用户 ID 时附带 New-Api-User 头
  // （新版 New API 的用户族/计费路由要求它，缺失即 401/402 "无效的令牌"）。
  // 不带「|」时行为与从前完全一致。
  const [credRaw, uidRaw] = String(provider.apiKey || '').split('|');
  const key = (credRaw || '').trim();
  const uid = (uidRaw || '').trim();
  const diag = newProbeDiag();
  const headers = { Authorization: `Bearer ${key}` };
  if (uid) headers['New-Api-User'] = uid;
  const sub = await probeCandidates(provider, 'cherryin-sub', [CHERRYIN_SUB_PATH], headers, (r) => {
    // 无限额度令牌的 hard_limit_usd 是 9999999999.99 级哨兵——不得当真。
    const limit = numOf(r.data?.hard_limit_usd ?? r.data?.system_hard_limit_usd);
    return limit != null && limit > 0 && limit < 1_000_000;
  }, diag);
  if (sub) {
    const limit = numOf(sub.data?.hard_limit_usd ?? sub.data?.system_hard_limit_usd);
    const usage = await probeCandidates(provider, 'cherryin-usage', [CHERRYIN_USAGE_PATH], headers, (r) => {
      return numOf(r.data?.total_usage) != null;
    }, diag);
    if (!usage) {
      // 上限拿到了但用量查询失败——按 0 已用会谎报余额（最危险方向），如实失败。
      return { ok: false, error: 'CherryIN 订阅上限已取到，但用量查询失败（HTTP 错误），请稍后重试；若持续失败请把 /v1/dashboard/billing/usage 的返回 JSON 发给我适配' };
    }
    const used = numOf(usage.data?.total_usage) ?? 0;
    const amount = limit - used / 100; // one-api 惯例：total_usage 为美分
    return {
      ok: true,
      usage: { mode: 'balance', amount: clampAmount(amount), currency: 'USD', field: 'billing' },
    };
  }

  // ② 用户族降级（parseCherryInUserBalance 的 accept 内置 success 检查，
  //    200+success:false 的鉴权失败体会被拒）。
  const userDiag = newProbeDiag();
  // 账户级 OAuth 余额端点优先（Cherry Studio 同款——订阅制账户的真实余额
  // 在这里；/api/user/self 的 quota 对「无限额度」账户是哨兵大数，靠
  // parseCherryInUserBalance 的常识阈值拒掉后自然落到下一候选）。
  const userPaths = ['/api/v1/oauth/balance', '/api/user/self', '/api/user/balance', '/api/user/quota'];
  const authVariants = [
    { Authorization: `Bearer ${key}` },
    { Authorization: key },
  ];
  let parsed = null;
  for (const hv of authVariants) {
    const res = await probeCandidates(provider, 'cherryin-user', userPaths, hv, (r) => {
      parsed = parseCherryInUserBalance(r.data);
      return parsed != null;
    }, userDiag);
    if (res) {
      return {
        ok: true,
        usage: { mode: 'balance', amount: clampAmount(parsed.amount), currency: 'USD', field: 'quota' },
      };
    }
  }

  // 两段都失败：优先转述第一段服务商的原话（用户看到的就是 CherryIN 的措辞），
  // 并给出「访问令牌」这条已验证存在的替代路径。
  const msg = explainProbeFailure(diag, provider, 'balance');
  const hint = '。CherryIN 的 sk- 模型令牌不被余额端点接受（401 Invalid token 实测即此因）：请改填控制台「设置 → 生成访问令牌」的令牌，并按「令牌|用户ID」格式填写（用户 ID 见控制台个人设置；新版站点校验 New-Api-User 头，两种令牌都会自动尝试，Cherry Studio 同款余额端点已并入候选）；仍失败请把 /v1/dashboard/billing/subscription 与 /api/user/self 的返回 JSON 发给我适配';
  return { ok: false, error: msg + hint };
}

function clampAmount(n) {
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

// GitHub Copilot 用量（两步换票，均在 api.github.com）：
// ① GET /copilot_internal/v2/token —— Authorization: Bearer <GitHub OAuth
//    token（gho_…）>；PAT（ghp_/github_pat_）被 GitHub 拒绝，提前给出诚实错误。
// ② GET /copilot_internal/user —— Bearer <上一步的 copilot token> →
//    quota_snapshots.premium_interactions.percent_remaining（剩余%）→ 反推已用。
// Premium 请求按月重置：secondLabel='月'（看板第二列如实标注，不再冒充周）。
const COPILOT_TOKEN_PATH = '/copilot_internal/v2/token';
const COPILOT_USER_PATH = '/copilot_internal/user';
async function fetchCopilotPlanUsage(provider) {
  const key = String(provider.apiKey || '');
  if (/^(ghp_|github_pat_)/.test(key)) {
    return { ok: false, error: 'GitHub Copilot 用量查询需要 GitHub OAuth token（gho_…，含 Copilot 授权，如 gh auth token 的输出）；PAT（ghp_/github_pat_）已被 GitHub 拒绝，请更换后重试' };
  }
  const base = provider.baseUrl.replace(/\/+$/, '');
  const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
  const tokenRes = await tryFetchJson(`${base}${COPILOT_TOKEN_PATH}`, provider, headers);
  if (!tokenRes.ok) {
    const msg = tokenRes.status === 401 || tokenRes.status === 403
      ? `GitHub OAuth token 无效或不含 Copilot 授权（HTTP ${tokenRes.status}）${safeMessage(tokenRes.bodyMessage, key)}`
      : explainProbeFailure(({ statuses: [tokenRes.status].filter(Boolean), messages: [tokenRes.bodyMessage].filter(Boolean), errors: [tokenRes.error].filter(Boolean), responded: 0, unusable: 0 }), provider, 'plan');
    return { ok: false, error: msg };
  }
  const copilotToken = tokenRes.data?.token;
  if (!copilotToken) return { ok: false, error: 'GitHub 响应中找不到 Copilot token，请把返回 JSON 发给我适配' };
  const userRes = await tryFetchJson(`${base}${COPILOT_USER_PATH}`, provider, { Authorization: `Bearer ${copilotToken}`, Accept: 'application/json' });
  if (!userRes.ok) {
    const msg = userRes.status === 401 || userRes.status === 403
      ? `Copilot token 交换成功但用量查询被拒（HTTP ${userRes.status}），请重试或更新 token`
      : `Copilot 用量查询失败（HTTP ${userRes.status ?? ''}）${safeMessage(userRes.bodyMessage, key)}`;
    return { ok: false, error: msg };
  }
  const used = parseCopilotQuota(userRes.data);
  if (used == null) {
    return { ok: true, usage: { mode: 'plan', fiveHourPct: null, weeklyPct: null, secondLabel: '月' } };
  }
  return {
    ok: true,
    usage: { mode: 'plan', fiveHourPct: null, weeklyPct: clampPct(used), secondLabel: '月' },
  };
}

// 火山方舟 Coding Plan：无公开的 Key 直查接口——通用「查询用量」API 走
// volcengine V4 签名（AK/SK，另一套凭证模型，未接入）。诚实拒答，不做探测。
function guardVolcanoPlan() {
  return { ok: false, error: '火山方舟 Coding Plan 暂无公开的 Key 直查用量接口（通用用量 API 需 AK/SK V4 签名，暂未接入）。套餐用量请到火山方舟控制台「用量统计」查看' };
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
  if (m) return m;
  // opencode-style nested error: { type: 'error', error: { type, message } }.
  // Only consulted when no flat string key matched, so existing contracts
  // (N-30's "first usable string" semantics) are untouched.
  const nested = body.error;
  if (nested && typeof nested === 'object' && typeof nested.message === 'string' && nested.message.trim()) {
    return nested.message.trim();
  }
  return '';
}

function explainProbeFailure(diag, provider, mode) {
  const auth = diag.statuses.find((s) => s === 401 || s === 403);
  if (auth) {
    // The gateway's own words (opencode 401 "Unauthorized" / 403 "OpenCode Go
    // subscription required.") disambiguate a bad key from a missing plan.
    const gw = diag.messages.find(Boolean);
    return `API Key 无效或权限不足（HTTP ${auth}）${gw ? `：${gw}` : ''}，请检查该订阅的 Key 是否填错/已失效`;
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
  // 按量计费平台的专用余额端点（one-api 方言不适用）——按 host 分派。
  const bh = hostOf(provider.baseUrl.replace(/\/+$/, ''));
  if (bh === 'moonshot.cn' || bh.endsWith('.moonshot.cn') || bh === 'moonshot.ai' || bh.endsWith('.moonshot.ai')) {
    return fetchMoonshotBalance(provider);
  }
  if (bh === 'openrouter.ai' || bh.endsWith('.openrouter.ai')) {
    return fetchOpenRouterBalance(provider);
  }
  if (bh === 'deepseek.com' || bh.endsWith('.deepseek.com')) {
    return fetchDeepSeekBalance(provider);
  }
  if (bh === 'stepfun.com' || bh.endsWith('.stepfun.com') || bh === 'stepfun.ai' || bh.endsWith('.stepfun.ai')) {
    return fetchStepFunBalance(provider);
  }
  if (bh === 'cherryin.ai' || bh.endsWith('.cherryin.ai')) {
    return fetchCherryInBalance(provider);
  }
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

