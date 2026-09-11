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
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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
  const n = Number(v);
  return Number.isFinite(n) ? { value: n, explicit: false } : null;
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
    // N-19: `v === ''` missed whitespace-only strings, and Number(' ') === 0
    // turned "no balance data" into a confident 0. Trim, then judge.
    if (v == null || (typeof v === 'string' && v.trim() === '')) continue;
    const n = Number(v);
    if (Number.isFinite(n)) return { amount: n, currency: '', field: key };
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
};
