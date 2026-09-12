// Regression tests for the pure response parsers.
//
// These cover the table in 审查报告《第三部分》P1-A — the tier logic that used to
// silently return 100 (or 300) for a `used/total` payload. Rule adopted after
// that finding: every function that is new or semantically changed this round
// gets at least 3 assertions here, so the regression list grows with the code.
//
// Run: npm test

const assert = require('assert');
const {
  detectLimitPct,
  normalizeBalance,
  FIVE_HOUR_SPEC,
  WEEKLY_SPEC,
  numOf,
  parseLimit,
  asPct,
  getPath,
  parseWindowedUsage,
  parseOpenCodeUsage,
  parseOpenRouterCredits,
  parseDeepSeekBalance,
  parseMiniMaxRemains,
  parseZhipuQuota,
  parseCopilotQuota,
  parseCherryInUserBalance,
} = require('../src/lib/limits');

let pass = 0;
const failures = [];
function t(label, fn) {
  try {
    fn();
    pass++;
    console.log('  ok   ' + label);
  } catch (err) {
    failures.push(label + ' :: ' + err.message);
    console.log('  FAIL ' + label + ' :: ' + err.message);
  }
}
const near = (actual, expected) =>
  assert.ok(
    actual != null && Math.abs(actual - expected) < 1e-9,
    'expected ~' + expected + ', got ' + JSON.stringify(actual),
  );

console.log('--- detectLimitPct: 审查报告表格 6 例 ---');
t('{five_hour:{used_percentage:30}} -> 30', () => near(detectLimitPct({ five_hour: { used_percentage: 30 } }, FIVE_HOUR_SPEC), 30));
t('{five_hour:{used:300,total:1000}} -> 30 (曾错返 100)', () => near(detectLimitPct({ five_hour: { used: 300, total: 1000 } }, FIVE_HOUR_SPEC), 30));
t('{five_hour:{used:3,total:1000}} -> 0.3 (曾错返 3)', () => near(detectLimitPct({ five_hour: { used: 3, total: 1000 } }, FIVE_HOUR_SPEC), 0.3));
t('{quota_5h_used:300,quota_5h_total:1000} -> 30 (曾错返 100)', () => near(detectLimitPct({ quota_5h_used: 300, quota_5h_total: 1000 }, FIVE_HOUR_SPEC), 30));
t('{five_hour_limit:1000} -> null (分母单独出现, 曾错返 100)', () => assert.strictEqual(detectLimitPct({ five_hour_limit: 1000 }, FIVE_HOUR_SPEC), null));
t("{'5h_used':'42%'} -> 42", () => near(detectLimitPct({ '5h_used': '42%' }, FIVE_HOUR_SPEC), 42));

console.log('--- detectLimitPct: 弃权与边界 ---');
t('used 无 total -> null (分母不明不猜)', () => assert.strictEqual(detectLimitPct({ five_hour: { used: 300 } }, FIVE_HOUR_SPEC), null));
t('裸标量 300 -> null', () => assert.strictEqual(detectLimitPct({ '5h_used': 300 }, FIVE_HOUR_SPEC), null));
t('裸标量 0.42 -> 42 (明确比例)', () => near(detectLimitPct({ '5h_used': 0.42 }, FIVE_HOUR_SPEC), 42));
t('used_percentage 0.3 -> 30 (比例)', () => near(detectLimitPct({ five_hour: { used_percentage: 0.3 } }, FIVE_HOUR_SPEC), 30));
t('total=0 -> null (不除零)', () => assert.strictEqual(detectLimitPct({ five_hour: { used: 500, total: 0 } }, FIVE_HOUR_SPEC), null));
t('used>total -> 夹到 100', () => near(detectLimitPct({ five_hour: { used: 2, total: 1 } }, FIVE_HOUR_SPEC), 100));
t('five_hour.used + five_hour.limit -> 25', () => near(detectLimitPct({ five_hour: { used: 1, limit: 4 } }, FIVE_HOUR_SPEC), 25));
t('pairs 优先于 ambiguous', () => near(detectLimitPct({ five_hour: { used: 300, total: 1000 }, '5h_used': 0.9 }, FIVE_HOUR_SPEC), 30));
t('{} -> null', () => assert.strictEqual(detectLimitPct({}, FIVE_HOUR_SPEC), null));
t('null -> null', () => assert.strictEqual(detectLimitPct(null, FIVE_HOUR_SPEC), null));
t("'abc' -> null", () => assert.strictEqual(detectLimitPct({ '5h_used': 'abc' }, FIVE_HOUR_SPEC), null));

console.log('--- detectLimitPct: WEEKLY_SPEC ---');
t('{seven_day:{used:6,total:10}} -> 60', () => near(detectLimitPct({ seven_day: { used: 6, total: 10 } }, WEEKLY_SPEC), 60));
t('{weekly_used:0.75} -> 75', () => near(detectLimitPct({ weekly_used: 0.75 }, WEEKLY_SPEC), 75));
t('{week_used:"88%"} -> 88', () => near(detectLimitPct({ week_used: '88%' }, WEEKLY_SPEC), 88));
t('{quota_weekly_used,quota_weekly_total} -> 30', () => near(detectLimitPct({ quota_weekly_used: 300, quota_weekly_total: 1000 }, WEEKLY_SPEC), 30));
t('{seven_day:{used:7}} -> null', () => assert.strictEqual(detectLimitPct({ seven_day: { used: 7 } }, WEEKLY_SPEC), null));

console.log('--- helpers ---');
t('numOf("42%") -> 42', () => assert.strictEqual(numOf('42%'), 42));
t('numOf("") -> null', () => assert.strictEqual(numOf(''), null));
t('numOf(null) -> null', () => assert.strictEqual(numOf(null), null));
t('parseLimit("42%").explicit -> true', () => assert.strictEqual(parseLimit('42%').explicit, true));
t('parseLimit(42).explicit -> false', () => assert.strictEqual(parseLimit(42).explicit, false));
t('asPct({value:0.5,explicit:false}) -> 50', () => near(asPct({ value: 0.5, explicit: false }), 50));
t('asPct({value:50,explicit:true}) -> 50', () => near(asPct({ value: 50, explicit: true }), 50));
t('getPath 缺字段 -> undefined 不抛', () => assert.strictEqual(getPath({}, 'a.b.c'), undefined));
t('getPath 穿透嵌套', () => assert.strictEqual(getPath({ a: { b: { c: 7 } } }, 'a.b.c'), 7));

console.log('--- normalizeBalance ---');
t('{data:{balance:12.5}} -> 12.5', () => assert.strictEqual(normalizeBalance({ data: { balance: 12.5 } }).amount, 12.5));
t('{data:{quota:500000}} -> 原样 500000（不猜单位、不贴币种）', () => {
  const r = normalizeBalance({ data: { quota: 500000 } });
  assert.strictEqual(r.amount, 500000);
  assert.strictEqual(r.currency, '');
  assert.strictEqual(r.field, 'quota');
});
t('相邻余额不出现 100 倍跳变（1000 vs 1001）', () => {
  const a = normalizeBalance({ data: { quota: 1000 } });
  const b = normalizeBalance({ data: { quota: 1001 } });
  assert.deepStrictEqual([a.amount, b.amount], [1000, 1001]);
  assert.strictEqual(a.currency, b.currency);
});
t('{data:{balance:""}} -> null (空值不当 0)', () => assert.strictEqual(normalizeBalance({ data: { balance: '' } }), null));
t('{data:{balance:null}} -> null', () => assert.strictEqual(normalizeBalance({ data: { balance: null } }), null));
t('{data:{remain:0}} -> 0 (真的 0 要保留)', () => assert.strictEqual(normalizeBalance({ data: { remain: 0 } }).amount, 0));

console.log('--- N-19: 空白串不得被 Number() 收编成 0（第九轮探针输出转正） ---');
t('numOf(" ") -> null（曾收编为 0）', () => assert.strictEqual(numOf(' '), null));
t('numOf("\\t\\n") -> null', () => assert.strictEqual(numOf('\t\n'), null));
t('parseLimit(" ") -> null（曾得 {value:0}）', () => assert.strictEqual(parseLimit(' '), null));
t('detectLimitPct({five_hour:{used:" ",total:100}}) -> null（曾渲染成 0%）', () => {
  assert.strictEqual(detectLimitPct({ five_hour: { used: ' ', total: 100 } }, FIVE_HOUR_SPEC), null);
});
t('normalizeBalance({quota:"   "}) -> null（曾得 amount 0）', () => {
  assert.strictEqual(normalizeBalance({ data: { quota: '   ' } }), null);
});
t('真 0 仍然保留：numOf(0) -> 0 / {remain:0} -> 0', () => {
  assert.strictEqual(numOf(0), 0);
  assert.strictEqual(normalizeBalance({ data: { remain: 0 } }).amount, 0);
});
t('吸收行为不因 trim 收紧：周边空白仍可解析', () => {
  assert.strictEqual(numOf('  42  '), 42);
  assert.deepStrictEqual(parseLimit('  42% '), { value: 42, explicit: true });
  const r = normalizeBalance({ data: { balance: ' 7.5 ' } });
  assert.strictEqual(r.amount, 7.5);
});

console.log('--- N-25: 非 number/string 不得被 Number() 收编成 0（第十轮探针输出转正） ---');
t('numOf([]) -> null（曾收编为 0）', () => assert.strictEqual(numOf([]), null));
t('numOf(false) -> null（曾收编为 0）', () => assert.strictEqual(numOf(false), null));
t('numOf(true)/numOf({}) -> null（同一收编面）', () => {
  assert.strictEqual(numOf(true), null);
  assert.strictEqual(numOf({}), null);
});
t('parseLimit([]) -> null（曾得 {value:0}）', () => assert.strictEqual(parseLimit([]), null));
t('红线①：used:[] 不得渲染成 0%', () => {
  assert.strictEqual(detectLimitPct({ five_hour: { used: [], total: 100 } }, FIVE_HOUR_SPEC), null);
});
t('红线②：balance:[] / quota:false 不得伪造余额 0', () => {
  assert.strictEqual(normalizeBalance({ data: { balance: [] } }), null);
  assert.strictEqual(normalizeBalance({ data: { quota: false } }), null);
});
t('真 number 仍然保留：numOf(0)/numOf(42)/{remain:0}', () => {
  assert.strictEqual(numOf(0), 0);
  assert.strictEqual(numOf(42), 42);
  assert.strictEqual(normalizeBalance({ data: { remain: 0 } }).amount, 0);
  assert.strictEqual(detectLimitPct({ five_hour: { used: 30, total: 100 } }, FIVE_HOUR_SPEC), 30);
});
t('数字字符串与百分号路径不受影响（既有行为钉住）', () => {
  assert.strictEqual(numOf('42'), 42);
  assert.strictEqual(numOf('42%'), 42);
  assert.deepStrictEqual(parseLimit(42), { value: 42, explicit: false });
  assert.strictEqual(normalizeBalance({ data: { balance: '12.5' } }).amount, 12.5);
});

// --- parseWindowedUsage（Kimi Code /usages）/ parseOpenCodeUsage（Go /usage）---

console.log('--- 窗口用量解析（Kimi Code / OpenCode Go）---');
t('Kimi 形状1：300 MINUTE 窗口 + model_name:"all" 周行', () => {
  const r = parseWindowedUsage({ data: [
    { model_name: 'kimi-k2', window: { duration: 300, timeUnit: 'MINUTE' }, limit: 100, used: 25 },
    { model_name: 'all', limit: 7000, used: 700 },
  ] });
  assert.strictEqual(r.fiveHourPct, 25);
  assert.strictEqual(r.weeklyPct, 10);
});
t('Kimi 形状1：5 HOUR + 7 DAY 窗口同样识别', () => {
  const r = parseWindowedUsage({ data: [
    { window: { duration: 5, timeUnit: 'HOUR' }, limit_amount: 200, used_amount: 50 },
    { window: { duration: 7, timeUnit: 'DAY' }, limit_amount: 1000, used_amount: 250 },
  ] });
  assert.strictEqual(r.fiveHourPct, 25);
  assert.strictEqual(r.weeklyPct, 25);
});
t('Kimi：remaining 反推 used = limit - remaining', () => {
  const r = parseWindowedUsage({ data: [
    { window: { duration: 300, timeUnit: 'MINUTE' }, limit: 100, remaining: 90 },
    { model_name: 'all', limit: 100, remaining: 80 },
  ] });
  assert.strictEqual(r.fiveHourPct, 10);
  assert.strictEqual(r.weeklyPct, 20);
});
t('Kimi 形状2：数字嵌在 detail、window 在条目上', () => {
  const r = parseWindowedUsage({ usage: {}, limits: [
    { window: { duration: 300, timeUnit: 'MINUTE' }, detail: { limit: 100, used: 50 } },
    { window: { duration: 168, timeUnit: 'HOUR' }, detail: { limit: 1000, used: 250 } },
  ] });
  assert.strictEqual(r.fiveHourPct, 50);
  assert.strictEqual(r.weeklyPct, 25);
});
t('Kimi：limit 缺失的一侧留 null，不猜分母；另一侧照常', () => {
  const r = parseWindowedUsage({ data: [
    { window: { duration: 300, timeUnit: 'MINUTE' }, used: 30 },
    { model_name: 'all', limit: 100, used: 10 },
  ] });
  assert.strictEqual(r.fiveHourPct, null);
  assert.strictEqual(r.weeklyPct, 10);
});
t('Kimi：无窗口且无 "all" 行 -> 双 null（探测会被拒绝，不缓存）', () => {
  const r = parseWindowedUsage({ data: [{ limit: 10, used: 5 }] });
  assert.deepStrictEqual(r, { fiveHourPct: null, weeklyPct: null });
});
t('Kimi：坏形状不抛错 -> 双 null', () => {
  assert.deepStrictEqual(parseWindowedUsage({}), { fiveHourPct: null, weeklyPct: null });
  assert.deepStrictEqual(parseWindowedUsage({ data: [] }), { fiveHourPct: null, weeklyPct: null });
  assert.deepStrictEqual(parseWindowedUsage(null), { fiveHourPct: null, weeklyPct: null });
});
t('Kimi 真实形状：TIME_UNIT_MINUTE + 顶层 usage 周汇总（XiaoZ-0218/kimi-usage 同款响应）', () => {
  const r = parseWindowedUsage({
    usage: { limit: '7000', remaining: '6300', resetTime: '2026-09-15T00:00:00Z' },
    limits: [
      { window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '100', remaining: '75', resetTime: '2026-09-12T18:00:00Z' } },
    ],
    totalQuota: { limit: '10000', remaining: '9000' },
  });
  assert.strictEqual(r.fiveHourPct, 25);
  assert.strictEqual(r.weeklyPct, 10);
});
t('OpenCode Go：rolling/weekly percent 直读（0-100 不再乘 100）', () => {
  const r = parseOpenCodeUsage({ usage: {
    rolling: { status: 'ok', percent: 19.5, resetsAt: '2026-09-12T00:00:00Z' },
    weekly: { status: 'ok', percent: 7, resetsAt: '2026-09-15T00:00:00Z' },
    monthly: { status: 'ok', percent: 3, resetsAt: '2026-10-01T00:00:00Z' },
  } });
  assert.strictEqual(r.fiveHourPct, 19.5);
  assert.strictEqual(r.weeklyPct, 7);
});
t('OpenCode Go：rate-limited 状态不影响 percent 读取；字符串数字可用', () => {
  const r = parseOpenCodeUsage({ usage: {
    rolling: { status: 'rate-limited', percent: '100' },
  } });
  assert.strictEqual(r.fiveHourPct, 100);
  assert.strictEqual(r.weeklyPct, null);
});
t('OpenCode Go：坏形状 -> 双 null', () => {
  assert.deepStrictEqual(parseOpenCodeUsage({}), { fiveHourPct: null, weeklyPct: null });
  assert.deepStrictEqual(parseOpenCodeUsage({ usage: { rolling: { percent: [] } } }), { fiveHourPct: null, weeklyPct: null });
});

console.log('--- 智谱 GLM quota（TIME_LIMIT / TOKENS_LIMIT）---');
t('GLM：TIME_LIMIT → 5h 列、TOKENS_LIMIT → 第二列（percentage 直读 0-100）', () => {
  const r = parseZhipuQuota({ success: true, data: { level: 'pro', limits: [
    { type: 'TIME_LIMIT', percentage: 12.5, unit: 1, number: 600, nextResetTime: 1760000000000 },
    { type: 'TOKENS_LIMIT', percentage: 34, unit: 1, number: 100000, nextResetTime: 1761000000000 },
  ] } });
  assert.ok(Math.abs(r.fiveHourPct - 12.5) < 1e-9);
  assert.ok(Math.abs(r.weeklyPct - 34) < 1e-9);
});
t('GLM：只缺一类窗口时另一类照常，全缺 → null', () => {
  const r = parseZhipuQuota({ success: true, data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 5 }] } });
  assert.strictEqual(r.fiveHourPct, null);
  assert.strictEqual(r.weeklyPct, 5);
  assert.strictEqual(parseZhipuQuota({ success: true, data: { limits: [] } }), null);
});
t('GLM：鉴权失败体（HTTP 200 + success:false）→ null，accept 必拒', () => {
  assert.strictEqual(parseZhipuQuota({ code: 401, msg: '令牌已过期或验证不正确', success: false }), null);
  assert.strictEqual(parseZhipuQuota({}), null);
});

console.log('--- GitHub Copilot premium 快照（percent_remaining 反推）---');
t('Copilot：premium_interactions 剩余 80 → 已用 20', () => {
  const r = parseCopilotQuota({ quota_snapshots: {
    chat: { percent_remaining: 100, unlimited: true },
    premium_interactions: { percent_remaining: 80, entitlement: 300 },
  } });
  assert.ok(Math.abs(r - 20) < 1e-9);
});
t('Copilot：unlimited / 缺快照 / 坏值 → null', () => {
  assert.strictEqual(parseCopilotQuota({ quota_snapshots: { premium_interactions: { percent_remaining: 100, unlimited: true } } }), null);
  assert.strictEqual(parseCopilotQuota({ quota_snapshots: {} }), null);
  assert.strictEqual(parseCopilotQuota({}), null);
  assert.strictEqual(parseCopilotQuota({ quota_snapshots: { premium_interactions: { percent_remaining: 180 } } }), null);
});

console.log('--- 按量余额 / Token Plan（OpenRouter / DeepSeek / MiniMax）---');
t('OpenRouter credits：data 信封 + 字符串值，可用 = 充值 - 已用', () => {
  const r = parseOpenRouterCredits({ data: { total_credits: '24.50', total_usage: '12.25' } });
  assert.ok(Math.abs(r.amount - 12.25) < 1e-9);
  assert.strictEqual(r.currency, 'USD');
});
t('CherryIN 用户族：success 信封 + quota 换算（500000 = 1 USD）', () => {
  const r = parseCherryInUserBalance({ success: true, data: { quota: 6900000, used_quota: 100000 } });
  assert.ok(Math.abs(r.amount - 13.8) < 1e-9);
  assert.strictEqual(r.currency, 'USD');
});
t('CherryIN：无限额度哨兵大数（≥ 1e6 USD）→ null，不谎报巨额余额', () => {
  assert.strictEqual(parseCherryInUserBalance({ data: { quota: 4999999999500000 } }), null);
  assert.strictEqual(parseCherryInUserBalance({ data: { quota: 5000000000000000 } }), null);
});
t('CherryIN：OAuth 余额端点形状（无 success 标志）→ 通过', () => {
  const r = parseCherryInUserBalance({ data: { quota: 3450000, used_quota: 550000 } });
  assert.ok(Math.abs(r.amount - 6.9) < 1e-9);
});
t('CherryIN 用户族：鉴权失败体（200 + success:false）→ null；负值 → null', () => {
  assert.strictEqual(parseCherryInUserBalance({ message: 'Unauthorized, invalid access token', success: false }), null);
  assert.strictEqual(parseCherryInUserBalance({ success: true, data: { quota: -1 } }), null);
  assert.strictEqual(parseCherryInUserBalance({}), null);
});

t('OpenRouter：已用超过充值（负值）→ 拒绝；字段缺失 → null', () => {
  assert.strictEqual(parseOpenRouterCredits({ data: { total_credits: '1', total_usage: '2' } }), null);
  assert.strictEqual(parseOpenRouterCredits({ data: { total_credits: '1' } }), null);
  assert.strictEqual(parseOpenRouterCredits({}), null);
});
t('DeepSeek：优先 CNY 行，取 total_balance', () => {
  const r = parseDeepSeekBalance({ balance: [
    { currency: 'USD', total_balance: '0.10' },
    { currency: 'CNY', total_balance: '110.50' },
  ] });
  assert.ok(Math.abs(r.amount - 110.5) < 1e-9);
  assert.strictEqual(r.currency, 'CNY');
});
t('DeepSeek 官方形状：balance_infos 键（api-docs 实键名）优先识别', () => {
  const r = parseDeepSeekBalance({ is_available: true, balance_infos: [
    { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
  ] });
  assert.ok(Math.abs(r.amount - 110.0) < 1e-9);
  assert.strictEqual(r.currency, 'CNY');
});
t('DeepSeek：顶层 total_balance 兜底（部分文档版本）', () => {
  const r = parseDeepSeekBalance({ is_available: true, total_balance: '77.5' });
  assert.ok(Math.abs(r.amount - 77.5) < 1e-9);
  assert.strictEqual(r.currency, '');
});
t('DeepSeek：无 CNY 行回落首行；空数组/坏形状 → null', () => {
  assert.strictEqual(parseDeepSeekBalance({ balance: [{ currency: 'USD', total_balance: '3.2' }] }).amount, 3.2);
  assert.strictEqual(parseDeepSeekBalance({ balance: [] }), null);
  assert.strictEqual(parseDeepSeekBalance({}), null);
});
// 真实响应，2026-09-12 对该账号实发一次请求取得（涂掉 key 后原样固化）。
// 旧实现因 general 行 counts 全为 0 而跳过它、落到 video 行 3/3 → 恒返回 0%，
// 界面表现为绿色 0.0% 永不变化。这条 fixture 就是那个 bug 的反例。
const MINIMAX_REAL = {
  model_remains: [
    { start_time: 1789214400000, end_time: 1789228800000, remains_time: 599114,
      current_interval_total_count: 0, current_interval_usage_count: 0, model_name: 'general',
      current_weekly_total_count: 0, current_weekly_usage_count: 0,
      weekly_start_time: 1788710400000, weekly_end_time: 1789315200000, weekly_remains_time: 86999114,
      current_interval_status: 1, current_interval_remaining_percent: 59,
      current_weekly_status: 1, current_weekly_remaining_percent: 95 },
    { start_time: 1789142400000, end_time: 1789228800000, remains_time: 599114,
      current_interval_total_count: 3, current_interval_usage_count: 3, model_name: 'video',
      current_weekly_total_count: 21, current_weekly_usage_count: 21,
      weekly_start_time: 1788710400000, weekly_end_time: 1789315200000, weekly_remains_time: 86999114,
      current_interval_status: 1, current_interval_remaining_percent: 100,
      current_weekly_status: 1, current_weekly_remaining_percent: 100 },
  ],
  base_resp: { status_code: 0, status_msg: 'success' },
};

t('MiniMax 真实响应：选 general 行读 remaining_percent — 5h 41% / 周 5%', () => {
  const r = parseMiniMaxRemains(MINIMAX_REAL);
  assert.ok(r, 'real payload must parse');
  assert.ok(Math.abs(r.fiveHourPct - 41) < 1e-9, 'fiveHourPct=' + r.fiveHourPct);
  assert.ok(Math.abs(r.weeklyPct - 5) < 1e-9, 'weeklyPct=' + r.weeklyPct);
});
t('MiniMax 反例：general 行在场时绝不读 video 份额度（3/3 → 0% 是旧 bug）', () => {
  const r = parseMiniMaxRemains(MINIMAX_REAL);
  // 判别力锚点：旧实现返回裸数字 0，取 .fiveHourPct 得到 undefined，
  // 单看 notStrictEqual(…, 0) 会假绿——所以先钉住返回形状。
  assert.strictEqual(typeof r, 'object', '解析结果必须是双窗口对象，不是裸百分比数字');
  assert.ok(r !== null, 'real payload must parse');
  assert.notStrictEqual(r.fiveHourPct, 0, 'video 行 3/3 的 0% 被当成套餐用量');
  assert.notStrictEqual(r.weeklyPct, 0, 'video 行 21/21 的 0% 被当成周用量');
});
t('MiniMax：percent 字段优先于 counts；只有 counts 时才回落到计数换算', () => {
  // 故意让两者矛盾（counts 说已用 100%、percent 说已用 75%）以证明优先级。
  const viaPct = parseMiniMaxRemains({ model_remains: [
    { model_name: 'general', current_interval_total_count: 200, current_interval_usage_count: 0,
      current_interval_remaining_percent: 25 },
  ] });
  assert.ok(Math.abs(viaPct.fiveHourPct - 75) < 1e-9, 'fiveHourPct=' + viaPct.fiveHourPct);
  // 无 percent 字段的旧形状 → counts 兜底；usage_count 语义为剩余。
  const viaCounts = parseMiniMaxRemains({ model_remains: [
    { model_name: 'MiniMax-M2.5', current_interval_total_count: 1500, current_interval_usage_count: 1200 },
  ] });
  assert.ok(Math.abs(viaCounts.fiveHourPct - 20) < 1e-9, 'fiveHourPct=' + viaCounts.fiveHourPct);
  assert.strictEqual(viaCounts.weeklyPct, null);
});
t('MiniMax：缺一侧留 null 不伪造 0（周侧缺 → weeklyPct null）', () => {
  const r = parseMiniMaxRemains({ model_remains: [
    { model_name: 'general', current_interval_remaining_percent: 20 },
  ] });
  assert.ok(Math.abs(r.fiveHourPct - 80) < 1e-9);
  assert.strictEqual(r.weeklyPct, null);
});
t('MiniMax：plan 行存在但无数据 → null，不回落到 video 等其它额度行', () => {
  assert.strictEqual(parseMiniMaxRemains({ model_remains: [
    { model_name: 'general', current_interval_total_count: 0, current_interval_usage_count: 0 },
    { model_name: 'video', current_interval_total_count: 3, current_interval_usage_count: 3 },
  ] }), null);
});
t('MiniMax：无任何 plan 行时才扫描全部行（旧形状兼容）', () => {
  const r = parseMiniMaxRemains({ model_remains: [
    { model_name: 'whatever', current_interval_total_count: 100, current_interval_usage_count: 10 },
  ] });
  assert.ok(Math.abs(r.fiveHourPct - 90) < 1e-9, 'fiveHourPct=' + r.fiveHourPct);
});
t('MiniMax：负剩余 / 剩余超总额 / 越界 percent 均不产生读数；空/坏形状 → null', () => {
  assert.strictEqual(parseMiniMaxRemains({ model_remains: [{ model_name: 'x', current_interval_total_count: 100, current_interval_usage_count: -5 }] }), null);
  assert.strictEqual(parseMiniMaxRemains({ model_remains: [{ model_name: 'x', current_interval_total_count: 100, current_interval_usage_count: 150 }] }), null);
  assert.strictEqual(parseMiniMaxRemains({ model_remains: [{ model_name: 'x', current_interval_remaining_percent: 120 }] }), null);
  assert.strictEqual(parseMiniMaxRemains({ model_remains: [] }), null);
  assert.strictEqual(parseMiniMaxRemains({}), null);
});

console.log('\nlimits.test: ' + pass + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  console.log('\nFailed:\n- ' + failures.join('\n- '));
  process.exit(1);
}
