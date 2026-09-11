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

console.log('\nlimits.test: ' + pass + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  console.log('\nFailed:\n- ' + failures.join('\n- '));
  process.exit(1);
}
