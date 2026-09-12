// Pure response-parsing helpers.
//
// These were previously defined inline in `main.js`, which made them
// unreachable from a test runner — the reason the regression list never grew
// when `detectLimitPct` replaced `pickPct` (审查报告《第三部分》P1-A 指出).
// They are pure functions (no Electron, no I/O), so they live here and are
// covered directly by `test/limits.test.js`.

// Limit-field specs. Three tiers with DIFFERENT semantics, so they must not be
// flattened into one hint list:
//   ① pairs     — `used` is an absolute amount; only meaningful WITH a
//                 denominator, so both sides must resolve before we divide.
//   ② pctPaths  — the field name itself says "percentage", safe to use directly.
//   ③ ambiguous — a bare `used`/`usage` scalar. <= 1 is an unambiguous ratio;
//                 > 1 is an absolute amount whose denominator we do NOT know, so
//                 we abstain instead of guessing. A wrong alert colour is worse
//                 than an honest "no data".
const FIVE_HOUR_SPEC = {
  pairs: [
    { used: 'five_hour.used', total: 'five_hour.total' },
    { used: 'five_hour.used', total: 'five_hour.limit' },
    { used: 'five_hour.used', total: 'five_hour.quota' },
    { used: 'five_hour_used', total: 'five_hour_total' },
    { used: 'five_hour_used', total: 'five_hour_limit' },
    { used: 'quota_5h_used', total: 'quota_5h_total' },
    { used: '5h.used', total: '5h.total' },
    { used: '5h.used', total: '5h.limit' },
    { used: '5h_used', total: '5h_total' },
  ],
  pctPaths: [
    'five_hour.used_percentage', 'five_hour_usage_percentage',
    'five_hour.percentage', 'five_hour.percent',
    '5h.used_percentage', '5h.percentage', 'quota_5h_used_percentage',
  ],
  ambiguous: ['five_hour.used', 'five_hour_usage', '5h_used', '5h_usage', 'quota_5h_used'],
};

const WEEKLY_SPEC = {
  pairs: [
    { used: 'seven_day.used', total: 'seven_day.total' },
    { used: 'seven_day.used', total: 'seven_day.limit' },
    { used: 'seven_day.used', total: 'seven_day.quota' },
    { used: 'seven_day_used', total: 'seven_day_total' },
    { used: 'seven_day_used', total: 'seven_day_limit' },
    { used: 'quota_weekly_used', total: 'quota_weekly_total' },
    { used: 'weekly.used', total: 'weekly.total' },
    { used: 'weekly_used', total: 'weekly_total' },
    { used: 'week.used', total: 'week.total' },
    { used: 'week_used', total: 'week_total' },
  ],
  pctPaths: [
    'seven_day.used_percentage', 'seven_day_usage_percentage',
    'seven_day.percentage', 'seven_day.percent',
    'weekly.used_percentage', 'weekly.percentage',
    'week.used_percentage', 'week.percentage',
    'quota_weekly_used_percentage',
  ],
  ambiguous: [
    'seven_day.used', 'seven_day_usage',
    'weekly_used', 'weekly_usage',
    'week_used', 'week_usage',
    'quota_weekly_used',
  ],
};

/** Clamp to 0..100; non-finite input collapses to 0. */
function clampPct(n) {
  if (!isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

/** Coerce a field to a number. Accepts numeric strings and "42%" (→ 42). */
function numOf(v) {
  if (v == null) return null;
  if (typeof v === 'string') {
    const s = v.trim();
    // N-19: `Number(' ') === 0`, so a whitespace-only field would be absorbed
    // into a confident 0 — a forged reading on the "0% = quota fine" axis.
    // Whitespace-only is MISSING data, same as null/''.
    if (s === '') return null;
    if (s.endsWith('%')) {
      const p = parseFloat(s);
      return Number.isFinite(p) ? p : null;
    }
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  // N-25: `Number([]) === 0` and `Number(false) === 0` — arrays and booleans
  // would be absorbed into a confident 0 exactly the way whitespace was
  // (N-19). Anything that is not a number and not a numeric string is
  // MISSING data, not a zero.
  if (typeof v !== 'number') return null;
  return Number.isFinite(v) ? v : null;
}

/**
 * Parse a single limit field. `explicit` means the value declared itself a
 * percentage — by a "%" suffix — which is a stronger signal than magnitude.
 */
function parseLimit(v) {
  if (v == null) return null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return null; // N-19: same absorption trap as numOf
    if (s.endsWith('%')) {
      const p = parseFloat(s);
      return Number.isFinite(p) ? { value: p, explicit: true } : null;
    }
    const n = Number(s);
    return Number.isFinite(n) ? { value: n, explicit: false } : null;
  }
  // N-25: same absorption trap as numOf — Number([])/Number(false) are 0.
  if (typeof v !== 'number') return null;
  return Number.isFinite(v) ? { value: v, explicit: false } : null;
}

/** A ratio (<= 1) becomes a percentage; anything larger is already one. */
function asPct(parsed) {
  return parsed.explicit || parsed.value > 1 ? parsed.value : parsed.value * 100;
}

/** Resolve a dot-path like `a.b.c` without throwing on missing/odd shapes. */
function getPath(root, path) {
  return path.split('.').reduce((node, key) => {
    if (node && typeof node === 'object' && key in node) return node[key];
    return undefined;
  }, root);
}

/**
 * Pick one limit percentage out of the response, honouring the three tiers.
 * Returns null when nothing trustworthy is found — callers surface "no data"
 * rather than a guessed value.
 */
function detectLimitPct(root, spec) {
  // ① paired used/total — divide, never treat the numerator as a percentage
  for (const { used, total } of spec.pairs) {
    const u = numOf(getPath(root, used));
    const t = numOf(getPath(root, total));
    if (u == null || t == null || t <= 0) continue;
    return clampPct((u / t) * 100);
  }
  // ② fields whose name states they are a percentage
  for (const path of spec.pctPaths) {
    const parsed = parseLimit(getPath(root, path));
    if (parsed == null) continue;
    return clampPct(asPct(parsed));
  }
  // ③ ambiguous scalars — only two readings are trustworthy: an explicit "42%"
  // string, or a value <= 1 (an unambiguous ratio). A bare 300 is an absolute
  // amount whose denominator we do NOT know, so abstain rather than guess.
  for (const path of spec.ambiguous) {
    const parsed = parseLimit(getPath(root, path));
    if (parsed == null) continue;
    if (!parsed.explicit && parsed.value > 1) continue;
    return clampPct(parsed.explicit ? parsed.value : parsed.value * 100);
  }
  return null;
}

/**
 * Extract a remaining-balance amount from a gateway response.
 *
 * The value is returned EXACTLY as the gateway sent it: no unit conversion and
 * no currency label. An earlier version divided `quota` by 100 and labelled it
 * `CNY` above a hard threshold of 1000. That was an unverifiable guess with two
 * bad consequences (第六轮复核 P2-B):
 *   - the comment claimed "$5.00" (dollars), the code labelled CNY, and the
 *     README claimed 分 — three claims, at most one of which could be right;
 *   - `{quota: 1000}` rendered "1000" while `{quota: 1001}` rendered "CNY 10.01",
 *     a 100x discontinuity between two adjacent balances.
 * Guessing wrong about money is worse than showing a raw number, so we show the
 * raw number and say so. Same principle as `detectLimitPct` abstaining on a bare
 * absolute amount.
 */
function normalizeBalance(root) {
  const r = root?.data ?? root;
  // Iterate by KEY (not value) so a matched field is unambiguous, and skip
  // null/empty values that `Number()` would coerce to 0.
  const FIELDS = ['balance', 'remain', 'remaining', 'quota', 'credit'];
  for (const key of FIELDS) {
    const v = r?.[key];
    // N-25: only numbers and numeric strings are balance data. `Number([])`
    // and `Number(false)` are both 0, so an array/boolean field would forge a
    // confident "balance 0" — the same absorption axis as N-19's whitespace.
    if (v == null || (typeof v !== 'number' && typeof v !== 'string')) continue;
    // N-19: `Number(' ') === 0` turned "no balance data" into a 0. Trim first.
    if (typeof v === 'string' && v.trim() === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return { amount: n, currency: '', field: key };
  }
  return null;
}

// --- Windowed plan-usage payloads (Kimi Code /usages, OpenCode Go /usage) ---
//
// Two provider dialects, one result shape: { fiveHourPct, weeklyPct } where
// null means "this window is not in the response" — never coerced to 0, for
// the same reason as 第六轮 P1-A (a green 0% bar reads as "quota fine", the
// worst direction to be wrong in). Pure functions: no fetch, no Electron.

const WINDOW_MINUTES = { MINUTE: 1, HOUR: 60, DAY: 1440, WEEK: 10080 };
const FIVE_HOUR_MINUTES = 300;
const WEEKLY_MINUTES = 10080;

/** Window length in minutes from `{ duration, timeUnit }`; null if unparsable. */
function windowMinutes(w) {
  if (!w || typeof w !== 'object') return null;
  const d = numOf(w.duration);
  // Live Kimi responses spell it "TIME_UNIT_MINUTE"; community dialects use
  // plain "MINUTE". Normalize by stripping the enum prefix.
  const u = typeof w.timeUnit === 'string'
    ? w.timeUnit.toUpperCase().replace(/^TIME_UNIT_/, '')
    : '';
  if (d == null || d <= 0 || !(u in WINDOW_MINUTES)) return null;
  return d * WINDOW_MINUTES[u];
}

/**
 * used/limit out of one windowed item, tolerant to the field spellings
 * observed in the wild (kimi-code-usage providers/kimi.py): limit|limit_amount,
 * used|used_amount, or remaining -> used = limit - remaining. Shape 2 of that
 * dialect nests the numbers under `detail` while `window` stays on the item.
 * A missing side is null — abstain instead of guessing a denominator.
 */
function windowItemPair(item) {
  if (!item || typeof item !== 'object') return null;
  const fields = item.detail && typeof item.detail === 'object' ? item.detail : item;
  const limit = numOf(fields.limit ?? fields.limit_amount);
  let used = numOf(fields.used ?? fields.used_amount);
  if (used == null && limit != null) {
    const remaining = numOf(fields.remaining);
    if (remaining != null) used = limit - remaining;
  }
  if (limit == null || limit <= 0 || used == null) return null;
  return { used, limit };
}

function pairPct(pair) {
  return (pair.used / pair.limit) * 100;
}

/**
 * Exact-window match first; then the caller's fallback predicate — Kimi's
 * weekly summary arrives as a `model_name:'all'` row with no window object.
 */
function pickWindowItem(items, wantMinutes, fallbackPred) {
  if (!Array.isArray(items)) return null;
  for (const it of items) {
    if (windowMinutes(it?.window) === wantMinutes) {
      const pair = windowItemPair(it);
      if (pair) return pair;
    }
  }
  if (fallbackPred) {
    for (const it of items) {
      if (fallbackPred(it)) {
        const pair = windowItemPair(it);
        if (pair) return pair;
      }
    }
  }
  return null;
}

/**
 * Kimi Code `/usages` payload. Shape 1: `{ data: [...] }`. Shape 2 (the LIVE
 * Kimi shape, cross-verified against XiaoZ-0218/kimi-usage):
 * `{ usage: {limit, remaining, …}, limits: [{ window: {duration,
 * timeUnit:'TIME_UNIT_MINUTE'}, detail: {limit, remaining, …} }], … }` —
 * the weekly quota lives in the top-level `usage` summary, values are
 * numeric strings, and consumption is remaining-based.
 */
function parseWindowedUsage(payload) {
  let items = Array.isArray(payload?.data) ? payload.data : null;
  if (!items && Array.isArray(payload?.limits)) items = payload.limits;
  const fiveHour = items ? pickWindowItem(items, FIVE_HOUR_MINUTES) : null;
  // Weekly, in order of trust: an explicit weekly-window row; the top-level
  // `usage` summary (live Kimi shape); the `model_name:'all'` row (community
  // dialect). Missing stays null — never a forged 0.
  const weekly = (items ? pickWindowItem(items, WEEKLY_MINUTES) : null)
    ?? windowItemPair(payload?.usage)
    ?? (items
      ? pickWindowItem(items, WEEKLY_MINUTES, (it) => it && typeof it === 'object' && it.model_name === 'all')
      : null);
  return {
    fiveHourPct: fiveHour ? pairPct(fiveHour) : null,
    weeklyPct: weekly ? pairPct(weekly) : null,
  };
}

/**
 * OpenCode Go `/usage` payload — shape taken from the opencode console source
 * (packages/console/app/src/routes/zen/go/v1/usage.ts):
 * `{ usage: { rolling: { status, percent, resetsAt }, weekly: {...}, monthly } }`.
 * `percent` is already a 0-100 usage share on the same axis as the board's
 * bars, so it passes through without ratio conversion; monthly has no board
 * column and is deliberately not surfaced.
 */
function parseOpenCodeUsage(payload) {
  const u = payload?.usage;
  return {
    fiveHourPct: numOf(u?.rolling?.percent),
    weeklyPct: numOf(u?.weekly?.percent),
  };
}

/**
 * OpenRouter `/credits` payload: `{ data: { total_credits, total_usage } }`
 * (USD strings; a bare root also tolerated). Remaining = credits - usage.
 * Negative results mean a malformed payload — abstain, never fabricate.
 */
function parseOpenRouterCredits(payload) {
  const d = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const total = numOf(d?.total_credits);
  const used = numOf(d?.total_usage);
  if (total == null || used == null) return null;
  const amount = total - used;
  if (amount < 0) return null;
  return { amount, currency: 'USD' };
}

/**
 * DeepSeek `/user/balance` payload. OFFICIAL key is `balance_infos` (per
 * api-docs.deepseek.com 查询余额): `{ is_available, balance_infos: [{
 * currency, total_balance, granted_balance, topped_up_balance }] }` — values
 * are numeric strings. `balance` is kept as a compat alias, and a bare
 * top-level `total_balance` as a last resort. Prefers the CNY row.
 */
function parseDeepSeekBalance(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const list = Array.isArray(payload.balance_infos) ? payload.balance_infos
    : Array.isArray(payload.balance) ? payload.balance
    : null;
  if (list) {
    const ordered = [...list.filter((b) => b && b.currency === 'CNY'), ...list];
    for (const b of ordered) {
      const amount = numOf(b?.total_balance);
      if (amount != null) return { amount, currency: b.currency || '' };
    }
  }
  const top = numOf(payload.total_balance);
  if (top != null) return { amount: top, currency: '' };
  return null;
}

/**
 * MiniMax `/coding_plan/remains` payload: `{ model_remains: [{…}], base_resp }`.
 * ⚠️ SEMANTIC TRAP (verified against coding-plan-monitor's minimax.ts):
 * `current_interval_usage_count` is the REMAINING count, not the used count —
 * used = total - remaining. Prefers the MiniMax-M2.5 row. The response covers
 * the 5h rolling window only; there is no weekly side (caller reports null).
 */
function parseMiniMaxRemains(payload) {
  const list = Array.isArray(payload?.model_remains) ? payload.model_remains : null;
  if (!list || list.length === 0) return null;
  const ordered = [...list.filter((m) => m && m.model_name === 'MiniMax-M2.5'), ...list];
  for (const m of ordered) {
    const total = numOf(m?.current_interval_total_count);
    const remaining = numOf(m?.current_interval_usage_count);
    // Negative remaining is a malformed row (it would inflate "used" past the
    // total) — skip it and try the next model instead of reporting nonsense.
    if (total == null || total <= 0 || remaining == null || remaining < 0) continue;
    const used = total - remaining;
    if (used < 0) continue;
    return (used / total) * 100;
  }
  return null;
}

module.exports = {
  FIVE_HOUR_SPEC,
  WEEKLY_SPEC,
  clampPct,
  numOf,
  parseLimit,
  asPct,
  getPath,
  detectLimitPct,
  normalizeBalance,
  parseWindowedUsage,
  parseOpenCodeUsage,
  parseOpenRouterCredits,
  parseDeepSeekBalance,
  parseMiniMaxRemains,
};
