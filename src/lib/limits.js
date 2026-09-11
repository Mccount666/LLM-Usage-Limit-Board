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
  if (v == null || v === '') return null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s.endsWith('%')) {
      const p = parseFloat(s);
      return Number.isFinite(p) ? p : null;
    }
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a single limit field. `explicit` means the value declared itself a
 * percentage — by a "%" suffix — which is a stronger signal than magnitude.
 */
function parseLimit(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s.endsWith('%')) {
      const p = parseFloat(s);
      return Number.isFinite(p) ? { value: p, explicit: true } : null;
    }
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

/** Extract a remaining-balance amount from a gateway response. */
function normalizeBalance(root) {
  const r = root?.data ?? root;
  // Iterate by KEY (not value) so we can record which field we matched,
  // and skip null/empty values that `Number()` would coerce to 0.
  const FIELDS = ['balance', 'remain', 'remaining', 'quota', 'credit'];
  let amount = null;
  let field = null;
  for (const key of FIELDS) {
    const v = r?.[key];
    if (v == null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) {
      amount = n;
      field = key;
      break;
    }
  }
  if (amount == null) return null;

  // Some gateways store quota in cents (e.g. NewAPI uses 500000 = $5.00).
  // Only apply the cents heuristic when the value came from the `quota`
  // field AND looks like an integer > 1000.
  let currency = '';
  if (field === 'quota' && Number.isInteger(amount) && amount > 1000) {
    currency = 'CNY';
    amount = amount / 100;
  }
  return { amount, currency };
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
