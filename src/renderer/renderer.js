// Renderer: state + UI for the LLM usage widget.
// All persistent storage goes through window.api (preload -> main -> JSON file).

const POLL_INTERVAL_MS = 60_000;
const THRESHOLDS_LS_KEY = 'llm-board.balanceThresholds';
const PRIVACY_ACK_KEY = 'llm-board.privacyAck';

const DEFAULT_THRESHOLDS = { warn: 50, danger: 10 };

const state = {
  // provider shape: { id, name, baseUrl, mode: 'plan' | 'balance', hasKey }
  providers: [],
  // last known usage/error per provider id, used for re-rendering on
  // threshold changes without re-hitting the network.
  lastUsage: new Map(), // id -> { usage } | { error }
  thresholds: loadThresholds(),
  polling: false,
};

function loadThresholds() {
  try {
    const raw = localStorage.getItem(THRESHOLDS_LS_KEY);
    if (!raw) return { ...DEFAULT_THRESHOLDS };
    const parsed = JSON.parse(raw);
    const warn = Number(parsed.warn);
    const danger = Number(parsed.danger);
    if (!isFinite(warn) || !isFinite(danger) || warn <= danger) return { ...DEFAULT_THRESHOLDS };
    return { warn, danger };
  } catch {
    return { ...DEFAULT_THRESHOLDS };
  }
}

function saveThresholds(t) {
  localStorage.setItem(THRESHOLDS_LS_KEY, JSON.stringify(t));
}

const els = {
  list: document.getElementById('usageList'),
  empty: document.getElementById('emptyState'),
  settingsPanel: document.getElementById('settingsPanel'),
  providerForm: document.getElementById('providerForm'),
  providerList: document.getElementById('providerList'),
  toggleSettings: document.getElementById('toggleSettings'),
  refreshBtn: document.getElementById('refreshBtn'),
  minimizeBtn: document.getElementById('minimizeBtn'),
  hideBtn: document.getElementById('hideBtn'),
  lastUpdated: document.getElementById('lastUpdated'),
  // form fields
  fId: document.getElementById('providerId'),
  fName: document.getElementById('providerName'),
  fBaseUrl: document.getElementById('providerBaseUrl'),
  fApiKey: document.getElementById('providerApiKey'),
  fMode: document.getElementById('providerMode'),
  cancelEdit: document.getElementById('cancelEdit'),
  // feedback areas
  saveError: document.getElementById('saveError'),
  loadError: document.getElementById('loadError'),
  httpWarning: document.getElementById('httpWarning'),
  // first-run notice
  privacyNotice: document.getElementById('privacyNotice'),
  privacyAck: document.getElementById('privacyAck'),
  // thresholds
  thresholdWarn: document.getElementById('thresholdWarn'),
  thresholdDanger: document.getElementById('thresholdDanger'),
};

// --- Boot -------------------------------------------------------------------
(async function init() {
  // P2-B: `loadProviders()` had no catch while the very next line did. A single
  // rejected IPC call aborted init() before bindUi()/renderAll(), leaving a
  // blank widget with no explanation — the same failure mode as N-5, new trigger.
  let loadError = null;
  state.providers = await window.api.loadProviders().catch((err) => {
    loadError = err?.message || String(err);
    return [];
  });
  state.security = await window.api.getSecurityStatus().catch(() => ({ encryptionAvailable: true }));
  bindUi();
  renderSecurityBanner();
  renderHttpWarning();
  renderLoadError(loadError);
  renderPrivacyNotice();
  renderAll();
  // Register the interval BEFORE the first fetch: pollOne()/applyUsageRow() can
  // reject in ways we have not anticipated, and a rejected pollAll() used to
  // skip this line entirely — leaving the board frozen on stale numbers with
  // only an unhandled-promise error in the console.
  setInterval(pollAll, POLL_INTERVAL_MS);
  await pollAll();
})();

function renderLoadError(msg) {
  if (!msg) return;
  els.loadError.textContent = `⚠️ 读取本地订阅失败：${msg}。看板可能不完整，可在设置里重新添加订阅。`;
  els.loadError.classList.remove('hidden');
}

function renderSecurityBanner() {
  const existing = document.getElementById('securityBanner');
  if (existing) existing.remove();
  if (state.security?.encryptionAvailable) return; // nothing to warn about

  const banner = document.createElement('div');
  banner.id = 'securityBanner';
  banner.className = 'security-banner';
  banner.textContent = '⚠️ 本机系统级加密不可用，API Key 将以明文(base64)存储。建议在 Windows 上使用以获得 DPAPI 保护。';
  // Insert at the top of the settings panel.
  els.settingsPanel.insertBefore(banner, els.settingsPanel.firstChild);
}

/**
 * First-run privacy notice. The promise ("keys stay on this machine") is the
 * product's core claim, so it is shown once on first launch instead of being
 * buried in the settings panel. Dismissal is remembered locally.
 */
function renderPrivacyNotice() {
  let acked = false;
  try {
    acked = localStorage.getItem(PRIVACY_ACK_KEY) === '1';
  } catch {
    acked = false; // storage unavailable -> show it; nothing to remember anyway
  }
  if (!acked) els.privacyNotice.classList.remove('hidden');
}

function dismissPrivacyNotice() {
  els.privacyNotice.classList.add('hidden');
  try {
    localStorage.setItem(PRIVACY_ACK_KEY, '1');
  } catch {
    // Not fatal: the notice reappears next launch, which is the safe direction.
  }
}

function renderHttpWarning() {
  // P2-A: compare the PARSED protocol. `startsWith('http://')` is
  // case-sensitive, so "HTTP://x.com" — which the main process accepts and
  // then fetches in cleartext — slipped past the warning silently.
  const hasHttp = state.providers.some((p) => {
    try {
      return new URL(String(p.baseUrl || '')).protocol === 'http:';
    } catch {
      return false;
    }
  });
  els.httpWarning.classList.toggle('hidden', !hasHttp);
}

// --- UI events -------------------------------------------------------------
function bindUi() {
  els.toggleSettings.addEventListener('click', () => {
    els.settingsPanel.classList.toggle('hidden');
  });

  // Window controls: a failed IPC here is not actionable for the user, but it
  // must not become an unhandled rejection (第五轮复核 P1-C).
  els.minimizeBtn.addEventListener('click', () => {
    window.api.minimizeWindow().catch(() => {});
  });
  els.hideBtn.addEventListener('click', () => {
    window.api.hideWindow().catch(() => {});
  });

  els.refreshBtn.addEventListener('click', async () => {
    const started = await pollAll();
    // A poll round can take up to ~10s; without this the button just did nothing.
    if (!started) els.lastUpdated.textContent = '正在刷新，请稍候…';
  });

  els.providerForm.addEventListener('submit', onSaveProvider);
  els.cancelEdit.addEventListener('click', resetForm);
  els.privacyAck.addEventListener('click', dismissPrivacyNotice);

  // Threshold inputs — init from state, persist on change.
  els.thresholdWarn.value = state.thresholds.warn;
  els.thresholdDanger.value = state.thresholds.danger;
  els.thresholdWarn.addEventListener('change', onThresholdChange);
  els.thresholdDanger.addEventListener('change', onThresholdChange);
}

function onThresholdChange() {
  const warn = Number(els.thresholdWarn.value);
  const danger = Number(els.thresholdDanger.value);
  if (!isFinite(warn) || !isFinite(danger) || warn <= danger) {
    // Reject invalid (warn must be > danger). Snap back to current state.
    els.thresholdWarn.value = state.thresholds.warn;
    els.thresholdDanger.value = state.thresholds.danger;
    return;
  }
  state.thresholds = { warn, danger };
  saveThresholds(state.thresholds);
  // Re-render from cache — no network round-trip.
  // N-2: only re-render providers that have a successful cached usage;
  // skip error-state ones (re-writing the same error message is pointless
  // and the user already sees it).
  for (const p of state.providers) {
    const last = state.lastUsage.get(p.id);
    if (!last || !last.usage) continue;
    applyUsageRow(p.id, last.usage, null);
  }
}

async function onSaveProvider(evt) {
  evt.preventDefault();
  const name = els.fName.value.trim();
  const baseUrl = els.fBaseUrl.value.trim();
  const apiKey = els.fApiKey.value.trim();
  const mode = els.fMode.value === 'balance' ? 'balance' : 'plan';
  if (!name || !baseUrl) return;

  const id = els.fId.value || `p_${Date.now()}`;
  const existing = state.providers.find((p) => p.id === id);
  const isNew = !existing;

  // New providers require a key; editing without typing a key keeps the old one.
  if (isNew && !apiKey) return;

  // Build the PROSPECTIVE list without touching `state.providers`. The previous
  // version mutated state first and only returned on failure, which left a ghost
  // entry behind: the next renderAll() (e.g. after deleting some other provider)
  // would display a subscription that was never written to disk, and it would be
  // polled every 60s until restart. Commit only after disk accepted it.
  const nextProvider = {
    id,
    name,
    baseUrl,
    mode,
    hasKey: isNew ? true : apiKey ? true : existing.hasKey,
  };
  const nextProviders = isNew
    ? [...state.providers, nextProvider]
    : state.providers.map((p) => (p.id === id ? nextProvider : p));

  // `changed` carries ONLY the (id, apiKey) pair that needs to hit disk.
  // `undefined` means "keep existing"; empty string would mean "delete".
  const ok = await persistAll(nextProviders, { id, apiKey: apiKey || undefined });
  if (!ok.ok) {
    // Nothing was mutated, so the UI is already consistent with disk — just
    // report why and keep the form filled in (P2-3 + 第六轮复核 P1-B).
    showSaveError(ok.error || '保存失败，请检查 Base URL 格式');
    return;
  }
  state.providers = nextProviders; // committed to memory only now
  clearSaveError();
  resetForm();
  renderAll();
  renderHttpWarning();
  pollOne(id);
}

function showSaveError(msg) {
  els.saveError.textContent = msg;
  els.saveError.classList.remove('hidden');
}

function clearSaveError() {
  els.saveError.classList.add('hidden');
}

/**
 * Persist an explicitly supplied provider list.
 * @param providers the FULL list to write — not read from `state`, so the caller
 *   can persist a prospective list and only commit it to state on success.
 * @param changed `{ id, apiKey }`: which provider's key is being set. `undefined`
 *   apiKey means "keep the stored one", '' means "delete it".
 */
async function persistAll(providers, changed) {
  const payload = providers.map((p) => ({
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    mode: p.mode,
    apiKey: p.id === changed.id ? changed.apiKey : undefined,
  }));
  try {
    const res = await window.api.saveProviders(payload);
    if (res?.ok === false) return { ok: false, error: res.error || '保存失败' };
    return { ok: true };
  } catch (err) {
    // The main-process handler is synchronous: a throw inside it (writeAll /
    // encryptKey) becomes an IPC rejection. Without this catch the submit
    // handler rejected silently — the form appeared to do nothing while
    // state.providers had already been mutated (第五轮复核 P1-C).
    return { ok: false, error: `保存失败：${err?.message || String(err)}` };
  }
}

function resetForm() {
  els.fId.value = '';
  els.fName.value = '';
  els.fBaseUrl.value = '';
  els.fApiKey.value = '';
  els.fMode.value = 'plan';
}

function startEdit(id) {
  const p = state.providers.find((x) => x.id === id);
  if (!p) return;
  els.fId.value = p.id;
  els.fName.value = p.name;
  els.fBaseUrl.value = p.baseUrl;
  els.fApiKey.value = ''; // never pre-fill; user re-enters to replace
  els.fMode.value = p.mode || 'plan';
}

async function deleteProvider(id) {
  const idx = state.providers.findIndex((p) => p.id === id);
  const removed = idx >= 0 ? state.providers[idx] : null;
  state.providers = state.providers.filter((p) => p.id !== id);
  state.lastUsage.delete(id); // drop the cache entry with the provider
  if (els.fId.value === id) resetForm();
  try {
    const res = await window.api.deleteProvider(id);
    if (res?.ok === false) throw new Error(res.error || '删除失败');
  } catch (err) {
    // Roll back to the original position so the UI never shows a deletion that
    // did not reach disk, and say why (第五轮复核 P1-C).
    if (removed) state.providers.splice(idx, 0, removed);
    renderAll();
    showSaveError(`删除失败：${err?.message || String(err)}`);
    return;
  }
  renderAll();
}

// --- Rendering -------------------------------------------------------------
function renderAll() {
  renderProviderList();
  renderUsage();
  els.empty.classList.toggle('hidden', state.providers.length > 0);
}

function renderProviderList() {
  els.providerList.innerHTML = '';
  for (const p of state.providers) {
    const li = document.createElement('li');

    // P1-B: build nodes instead of interpolating `p.id` / `p.name` into
    // innerHTML. `data-id="${p.id}"` was the untrusted side of the escapeHtml
    // fix — an id containing a quote both injected DOM and broke every
    // downstream lookup. Property assignment cannot be "escaped wrong".
    const label = document.createElement('span');
    label.appendChild(document.createTextNode(p.name));
    const tag = document.createElement('small');
    tag.className = 'mode-tag';
    tag.textContent = `· ${p.mode === 'balance' ? '余额' : 'Plan'}`;
    label.appendChild(tag);

    const actions = document.createElement('span');
    const editBtn = document.createElement('button');
    editBtn.textContent = '编辑';
    editBtn.addEventListener('click', () => startEdit(p.id));
    const delBtn = document.createElement('button');
    delBtn.textContent = '删除';
    delBtn.addEventListener('click', () => deleteProvider(p.id));
    actions.append(editBtn, delBtn);

    li.append(label, actions);
    els.providerList.appendChild(li);
  }
}

/** The mode a row should be drawn in: the DATA's mode wins over the configured one. */
function rowMode(p) {
  const last = state.lastUsage.get(p.id);
  if (last && last.usage && last.usage.mode) return last.usage.mode === 'balance' ? 'balance' : 'plan';
  return p.mode === 'balance' ? 'balance' : 'plan';
}

function renderUsage() {
  els.list.innerHTML = '';
  for (const p of state.providers) {
    const li = document.createElement('li');
    li.className = 'usage-item';
    li.dataset.id = p.id; // property assignment: never parsed as HTML
    li.dataset.mode = rowMode(p);
    li.innerHTML = buildRowHtml(p, rowMode(p));
    els.list.appendChild(li);
  }
  // A full rebuild starts every row at "--". Re-apply the cache so adding or
  // deleting one provider does not blank the readings of all the others.
  for (const p of state.providers) {
    const last = state.lastUsage.get(p.id);
    if (!last) continue;
    if (last.usage) applyUsageRow(p.id, last.usage, null);
    else if (last.error) applyUsageRow(p.id, null, last.error);
  }
}

function buildRowHtml(p, mode) {
  const name = escapeHtml(String(p?.name ?? ''));
  if (mode === 'balance') {
    return `
      <div class="usage-name" title="${name} · 余额模式">${name}</div>
      <div class="usage-bars">
        <div class="bar-row balance-row">
          <span>余额</span>
          <div class="bar"><div class="bar-fill ok"></div></div>
          <span class="bar-pct balance-amount">--</span>
        </div>
      </div>
    `;
  }
  return `
    <div class="usage-name" title="${name} · Coding Plan">${name}</div>
    <div class="usage-bars">
      <div class="bar-row">
        <span>5h</span>
        <div class="bar"><div class="bar-fill ok"></div></div>
        <span class="bar-pct">--</span>
      </div>
      <div class="bar-row">
        <span>7d</span>
        <div class="bar"><div class="bar-fill ok"></div></div>
        <span class="bar-pct">--</span>
      </div>
    </div>
  `;
}

function applyUsageRow(id, usage, error) {
  // P1-B: match by dataset instead of interpolating the id into a selector.
  // `querySelector('[data-id="' + id + '"]')` threw a SyntaxError for ids
  // containing a quote, which then propagated out of pollOne and killed the
  // whole auto-refresh chain.
  const row = [...els.list.querySelectorAll('.usage-item')].find((el) => el.dataset.id === id);
  if (!row) return;

  const existingError = row.querySelector('.usage-error');
  if (existingError) existingError.remove();

  if (error) {
    const e = document.createElement('div');
    e.className = 'usage-error';
    e.textContent = error;
    row.appendChild(e);
    row.querySelectorAll('.bar-fill').forEach((f) => (f.style.width = '0%'));
    row.querySelectorAll('.bar-pct').forEach((el) => (el.textContent = '--'));
    return;
  }

  // P3-A: single source of truth. The row's SHAPE follows the data's mode, so a
  // provider configured as plan but answering in balance mode cannot end up
  // with two bars that only ever update one of them.
  const mode = usage.mode === 'balance' ? 'balance' : 'plan';
  if (row.dataset.mode !== mode) {
    const p = state.providers.find((x) => x.id === id);
    row.dataset.mode = mode;
    row.innerHTML = buildRowHtml(p, mode);
  }

  const fills = row.querySelectorAll('.bar-fill');
  const pcts = row.querySelectorAll('.bar-pct');

  if (usage.mode === 'balance') {
    // Visual bar: filled portion represents "still above the warn threshold".
    // Beyond the warn threshold the bar is full but turns yellow; below the
    // danger threshold it turns red. The exact amount is always shown as text.
    const { warn, danger } = state.thresholds;
    // Same P3-7 discipline as the plan branch below: normalize before the value
    // reaches comparisons / toFixed, so a malformed amount cannot throw.
    const amount = Number.isFinite(usage.amount) ? usage.amount : 0;
    const level = balanceLevel(amount, warn, danger);
    const visualPct = balanceVisualPct(amount, warn, danger);
    setBar(fills[0], pcts[0], visualPct, formatBalance(amount, usage.currency), level);
    pcts[0].title = '数值与单位由服务商决定，本工具原样显示、不做换算';
    return;
  }

  // 第六轮复核 P1-A: a side the provider did not report must never become 0%.
  // "0%" on this board reads as "plenty of quota left", so fabricating it is the
  // most dangerous possible error. null/undefined -> explicit unknown state.
  setPctBar(fills[0], pcts[0], usage.fiveHourPct);
  setPctBar(fills[1], pcts[1], usage.weeklyPct);
}

/** Render one plan-side percentage, or the unknown state when it is absent. */
function setPctBar(fillEl, pctEl, pct) {
  if (!fillEl || !pctEl) return;
  if (!Number.isFinite(pct)) {
    setBar(fillEl, pctEl, null, '--');
    pctEl.title = '服务商未返回这一项的限额数据';
    return;
  }
  // Normalize before toFixed so a malformed value cannot throw (P3-7).
  setBar(fillEl, pctEl, pct, `${pct.toFixed(1)}%`);
  pctEl.title = '';
}

function setBar(fillEl, pctEl, pct, label, levelOverride) {
  if (!fillEl || !pctEl) return; // P3-7: tolerate unexpected DOM shape
  const known = Number.isFinite(pct);
  const safePct = known ? pct : 0;
  fillEl.style.width = `${safePct.toFixed(1)}%`;
  fillEl.classList.remove('ok', 'warn', 'danger', 'unknown');
  pctEl.classList.toggle('unknown', !known);
  // An unknown value gets its own level so it can never be styled as "ok".
  const level = !known
    ? 'unknown'
    : levelOverride || (safePct >= 85 ? 'danger' : safePct >= 60 ? 'warn' : 'ok');
  fillEl.classList.add(level);
  pctEl.textContent = label;
}

// --- Balance threshold helpers ---------------------------------------------
function balanceLevel(amount, warn, danger) {
  if (amount <= danger) return 'danger';
  if (amount <= warn) return 'warn';
  return 'ok';
}

function balanceVisualPct(amount, warn, danger) {
  // Map: 0 → 0%, danger → 25%, warn → 75%, 2×warn → 100% (clamped).
  // Invariant: danger < warn, guaranteed by loadThresholds() and
  // onThresholdChange(); neither value reaches here unvalidated, so the
  // divisions below cannot be by zero and need no epsilon padding (P3-2).
  const hi = Math.max(warn * 2, warn + 1); // keeps hi > warn even when warn <= 0
  if (amount <= danger) return 0;
  if (amount >= hi) return 100;
  if (amount <= warn) {
    // danger..warn → 25..75%
    return 25 + ((amount - danger) / (warn - danger)) * 50;
  }
  // warn..hi → 75..100%
  return 75 + ((amount - warn) / (hi - warn)) * 25;
}

function formatBalance(amount, currency) {
  // `amount` is already normalized by the caller, but keep this function total
  // so it can never throw on a bad cache entry.
  const n = Number.isFinite(amount) ? amount : 0;
  const cur = currency || '';
  const formatted = n >= 1 ? n.toFixed(2) : n.toFixed(4);
  return cur ? `${cur} ${formatted}` : formatted;
}

// --- Polling ---------------------------------------------------------------
/** @returns true if a round was started, false if one is already in flight. */
async function pollAll() {
  if (state.polling) return false;
  state.polling = true;
  try {
    await Promise.all(state.providers.map((p) => pollOne(p.id)));
    els.lastUpdated.textContent = `更新于 ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    // pollOne() is written not to reject; if that ever breaks, keep the
    // already-armed interval alive instead of surfacing an unhandled rejection.
    console.error('pollAll failed', err);
    return true;
  } finally {
    state.polling = false;
  }
  return true;
}

async function pollOne(id) {
  const p = state.providers.find((x) => x.id === id);
  if (!p) return;

  // Phase 1 — network. Only this part may reject, and we catch it here.
  let outcome;
  try {
    const res = await window.api.fetchUsage(p.id);
    outcome = res?.ok ? { usage: res.usage } : { error: res?.error || '获取失败' };
  } catch (err) {
    outcome = { error: `请求异常: ${err?.message || String(err)}` };
  }
  state.lastUsage.set(p.id, outcome);

  // Phase 2 — rendering. `applyUsageRow` used to be called from inside the
  // catch block, so a throw there escaped pollOne entirely (P2-C). One DOM
  // call site, always guarded: a render failure must not kill the refresh chain.
  try {
    if (outcome.usage) applyUsageRow(p.id, outcome.usage, null);
    else applyUsageRow(p.id, null, outcome.error);
  } catch (renderErr) {
    console.error('applyUsageRow failed; row left as-is', renderErr);
  }
}

// --- Util ------------------------------------------------------------------
function escapeHtml(s) {
  // Use \u escapes so no transport/tooling can accidentally decode entities.
  const AMP = '\u0026amp;';   // &
  const LT  = '\u0026lt;';    // <
  const GT  = '\u0026gt;';    // >
  const QT  = '\u0026quot;';  // "
  const AP  = '&#39;';        // '
  return String(s).replace(/[&<>"']/g, (c) => {
    if (c === '&') return AMP;
    if (c === '<') return LT;
    if (c === '>') return GT;
    if (c === '"') return QT;
    return AP;
  });
}

// Self-test (P0-2). Runs once at module load in EVERY build, deliberately:
// it costs microseconds and a silently broken escaper is worse than a log line.
// Assertions use concatenation so the expected strings cannot be
// accidentally decoded by any transport layer.
;(function () {
  try {
    const a = escapeHtml('&');
    const b = escapeHtml('<');
    const c = escapeHtml('"><img>');
    const expA = '&' + 'amp;';
    const expB = '&' + 'lt;';
    const expC = '&' + 'quot;' + '&' + 'gt;' + '&' + 'lt;' + 'img' + '&' + 'gt;';
    if (a !== expA || b !== expB || c !== expC) {
      console.error('[security] escapeHtml self-test FAILED. XSS mitigation is broken.', { a, b, c, expA, expB, expC });
    }
  } catch (err) {
    console.error('[security] escapeHtml self-test threw', err);
  }
})();
