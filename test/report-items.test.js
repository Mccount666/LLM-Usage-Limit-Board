// "No regression on any report item" check.
//
// Every requirement from 审查报告.md is encoded as a machine-checkable
// assertion against the current source. This is the list that must GROW when
// code changes — the lesson from 审查报告《方法论教训》#3 (a rewritten function
// whose tests never followed it). When you add or semantically change a
// function, add its assertions here and in limits.test.js.
//
// Run: npm test

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const MAIN = read('src/main.js');
const LIMITS = read('src/lib/limits.js');
const REND = read('src/renderer/renderer.js');
const PRE = read('src/preload.js');
const HTML = read('src/renderer/index.html');
const CSS = read('src/renderer/styles.css');
const README = read('README.md');
const PKG = JSON.parse(read('package.json'));

/** Strip comments so assertions about code don't trip on explanatory prose. */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

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
const matches = (src, re, msg) => assert.match(src, re, msg);
const notMatches = (src, re, msg) => assert.doesNotMatch(src, re, msg);

console.log('--- 首轮 P0 ---');
t('P0-1 无 module.exports / normalizeOneAPI', () => {
  notMatches(MAIN, /module\.exports/);
  notMatches(MAIN, /normalizeOneAPI/);
});
t('P0-2 escapeHtml 为真实体映射', () => {
  for (const re of [/AMP = '\\u0026amp;'/, /LT {2}= '\\u0026lt;'/, /GT {2}= '\\u0026gt;'/, /QT {2}= '\\u0026quot;'/, /AP {2}= '&#39;'/]) {
    matches(REND, re);
  }
});
t('P0-2b escapeHtml 自测存在', () => matches(REND, /escapeHtml self-test FAILED/));
t('P0-3 无 shell:openExternal；shell 未 require', () => {
  notMatches(PRE, /openExternal/);
  notMatches(MAIN, /openExternal/);
  notMatches(MAIN, /require\('electron'\)[^\n]*\bshell\b/);
});
t('P0-3b preload 每个通道都有 main handler', () => {
  const chans = [...PRE.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1]);
  const handlers = [...MAIN.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((m) => m[1]);
  assert.strictEqual(chans.length, 7, 'IPC surface changed — update this inventory');
  for (const h of handlers) assert.ok(chans.includes(h), 'handler with no caller: ' + h);
  for (const c of chans) assert.ok(handlers.includes(c), 'no handler for ' + c);
});

console.log('--- 首轮 P1 ---');
t('P1-1 persistAll 只传显式载荷', () => {
  matches(REND, /async function persistAll\(providers, changed\)/);
  matches(REND, /persistAll\(nextProviders, \{ id, apiKey: apiKey \|\| undefined \}\)/);
  matches(REND, /apiKey: p\.id === changed\.id \? changed\.apiKey : undefined/);
});
t('第六轮 P1-B 保存失败不得留下幽灵条目', () => {
  // N-23 added one legitimate push: deleteProvider's rollback fallback
  // (`push(removed)` restores a failed delete). Any OTHER push would be the
  // save-before-write mutation this assertion exists to catch.
  assert.ok(!/state\.providers\.push\((?!removed\))/.test(REND), 'must not mutate state before the write succeeds');
  matches(REND, /const nextProviders = isNew/);
  matches(REND, /state\.providers = nextProviders/); // commit only after success
  assert.ok(REND.indexOf('state.providers = nextProviders') > REND.indexOf('const ok = await persistAll'), 'commit must come after the write');
});
t('P1-2 无 clamp( 死代码，clampPct 仍在用', () => {
  notMatches(strip(REND), /clamp\(/);
  notMatches(strip(LIMITS), /[^P]clamp\(/);
  matches(LIMITS, /function clampPct\(/);
  matches(MAIN, /clampPct\(/);
});
t('P1-3 轮询有重入保护', () => {
  matches(REND, /if \(state\.polling\) return/);
  matches(REND, /state\.polling = false/);
});
t('P1-4 阈值变更不发网络请求', () => {
  const body = REND.slice(REND.indexOf('function onThresholdChange'), REND.indexOf('function onSaveProvider'));
  assert.ok(body.includes('applyUsageRow'), 'should re-render from cache');
  assert.ok(!body.includes('pollAll') && !body.includes('pollOne'), 'must not poll');
});
t('P1-5 provider 内存缓存 + 写操作失效', () => {
  matches(MAIN, /let providerCache = null/);
  matches(MAIN, /invalidateProviderCache\(\)/);
  matches(MAIN, /getCachedProviders\(\)/);
});
t('P1-6 apiKey 不 required；仅新增强制', () => {
  notMatches(HTML, /id="providerApiKey"[^>]*required/);
  matches(REND, /if \(isNew && !apiKey\) return/);
});

console.log('--- 首轮 P2 ---');
t('P2-1 finally 清理超时 timer', () => matches(MAIN, /finally \{\s*\r?\n\s*clearTimeout\(timer\);/));
t("P2-2 fetch redirect:'error'", () => matches(MAIN, /redirect: 'error'/));
t('P2-3 协议校验：写入侧 + 读取侧', () => {
  matches(MAIN, /baseUrl protocol check \(P2-3\)/);
  matches(MAIN, /P2-3 read-side/);
});
t('P2-3b 保存失败反馈到 UI', () => {
  matches(REND, /showSaveError\(ok\.error/);
  matches(REND, /function showSaveError\(msg\)/);
  matches(HTML, /id="saveError"/);
});
t('第五轮 P1-C 全部 7 个 IPC 调用点都有兜底', () => {
  matches(REND, /loadProviders\(\)\.catch\(/);
  matches(REND, /getSecurityStatus\(\)\.catch\(/);
  matches(REND, /minimizeWindow\(\)\.catch\(\(\) => \{\}\)/);
  matches(REND, /hideWindow\(\)\.catch\(\(\) => \{\}\)/);
  matches(REND, /try \{\s*\r?\n\s*const res = await window\.api\.saveProviders\(/);
  matches(REND, /try \{\s*\r?\n\s*const res = await window\.api\.deleteProvider\(/);
  matches(REND, /const res = await window\.api\.fetchUsage\(p\.id\)/);
  const sites = [...REND.matchAll(/window\.api\.(\w+)\(/g)].map((m) => m[1]);
  assert.deepStrictEqual(
    [...new Set(sites)].sort(),
    ['deleteProvider', 'fetchUsage', 'getSecurityStatus', 'hideWindow', 'loadProviders', 'minimizeWindow', 'saveProviders'],
    'IPC surface changed — re-check the fallback inventory',
  );
});
t('P2-3c http 明文告警存在', () => {
  matches(HTML, /id="httpWarning"/);
  matches(REND, /renderHttpWarning/);
});
t('P2-4 normalizeBalance 按键名遍历并跳空值', () => {
  matches(LIMITS, /const FIELDS = \['balance', 'remain', 'remaining', 'quota', 'credit'\]/);
  // N-19: whitespace-only strings must be skipped too — Number(' ') === 0.
  matches(LIMITS, /if \(v == null \|\| \(typeof v === 'string' && v\.trim\(\) === ''\)\) continue/);
  assert.ok(!/amount \/ 100/.test(LIMITS), 'must not convert units by guessing');
  matches(LIMITS, /return \{ amount: n, currency: '', field: key \}/);
});
t('P2-5 safeStorage 降级告警全链路', () => {
  matches(MAIN, /safeStorage unavailable/);
  matches(MAIN, /'security:status'/);
  matches(REND, /renderSecurityBanner/);
  matches(CSS, /\.security-banner/);
});

console.log('--- 首轮 P3 ---');
t('P3-1 pollOne 有 try/catch', () => {
  const body = REND.slice(REND.indexOf('async function pollOne'), REND.indexOf('// --- Util'));
  assert.ok(body.includes('catch'), 'pollOne must catch');
});
t('P3-2 balanceVisualPct 无冗余防御、有不变量注释', () => {
  notMatches(strip(REND), /Math\.max\(0, danger\)/);
  notMatches(strip(REND), /0\.0001/);
  matches(REND, /Invariant: danger < warn/);
});
t('P3-3 无内联 width 初值，改由 CSS 提供', () => {
  notMatches(REND, /style="width:0%"/);
  matches(CSS, /width: 0%; \/\* P3-3/);
});
t('P3-4 crash reporter 开关合法', () => {
  matches(MAIN, /appendSwitch\('disable-crash-reporter'\)/);
  notMatches(MAIN, /disable-features', 'CrashReporter'/);
});
t('P3-5 平台差异显式分支', () => {
  matches(MAIN, /P3-5/);
  matches(MAIN, /process\.platform !== 'win32'/);
  matches(MAIN, /setVisibleOnAllWorkspaces/);
});
t('P3-6 无生效的 backdrop-filter', () => {
  notMatches(CSS, /^\s*-?backdrop-filter\s*:/m);
  matches(CSS, /P3-6/);
});
t('P3-7 setBar 兜底 + 未知态不落成 0%', () => {
  matches(REND, /if \(!fillEl \|\| !pctEl\) return/);
  matches(REND, /function setPctBar\(/);
  matches(REND, /const known = Number\.isFinite\(pct\)/);
  matches(REND, /'unknown'/);
  matches(REND, /Number\.isFinite\(usage\.amount\)/);
});
t('第六轮 P1-A 单侧限额不得被伪造成 0', () => {
  assert.ok(!/clampPct\(fiveHourPct \?\? 0\)/.test(MAIN), 'five-hour side must not be coerced to 0');
  assert.ok(!/clampPct\(weeklyPct\s*\?\? 0\)/.test(MAIN), 'weekly side must not be coerced to 0');
  matches(MAIN, /fiveHourPct: fiveHourPct == null \? null : clampPct\(fiveHourPct\)/);
  matches(MAIN, /weeklyPct: weeklyPct == null \? null : clampPct\(weeklyPct\)/);
  matches(CSS, /\.bar-fill\.unknown/);
  matches(CSS, /\.bar-pct\.unknown/);
});

console.log('--- 复审 N-1..N-4 ---');
t('N-1 hasKey 兜底死循环已删', () => notMatches(strip(REND), /hasKey === undefined/));
t('N-2 阈值重绘只处理成功缓存', () => matches(REND, /if \(!last \|\| !last\.usage\) continue/));
t('N-3 无裸 toFixed 调用点', () => {
  notMatches(REND, /usage\.fiveHourPct\.toFixed/);
  notMatches(REND, /usage\.weeklyPct\.toFixed/);
});
t('N-4 providerCache 声明早于 usage:fetch', () => {
  assert.ok(MAIN.indexOf('let providerCache = null') < MAIN.indexOf("'usage:fetch'"));
});

console.log('--- 第三/四轮 N-5..N-12 ---');
t('N-5 els.minimizeBtn 已定义', () => matches(REND, /minimizeBtn: document\.getElementById\('minimizeBtn'\)/));
t('N-6 pickPct 已删', () => {
  notMatches(MAIN, /function pickPct/);
  notMatches(LIMITS, /function pickPct/);
});
t('N-7 托盘恢复链路完整', () => {
  matches(MAIN, /new Tray\(/);
  matches(MAIN, /ensureTray/);
  // window:show was an unused surface — the tray menu is the single restore path
  assert.ok(!/'window:show'/.test(MAIN), 'window:show handler should be gone');
  assert.ok(!/window:show/.test(PRE), 'window:show should not be exposed');
  matches(MAIN, /function ensureTray/);
});
t('N-8 CSP 锁定 script/connect', () => {
  matches(HTML, /script-src 'self'/);
  matches(HTML, /connect-src 'none'/);
});
t('N-9 README 无 normalizeOneAPI，说明 redirect', () => {
  notMatches(README, /normalizeOneAPI/);
  matches(README, /不跟随重定向/);
});
t('N-10 formatBalance 归一化', () => matches(REND, /const n = Number\.isFinite\(amount\) \? amount : 0/));
t('N-11 重绘回填缓存 + 删缓存项', () => {
  matches(REND, /A full rebuild starts every row at/);
  matches(REND, /state\.lastUsage\.delete\(id\)/);
});
t('N-12 second-instance 唤回窗口', () => matches(MAIN, /'second-instance'/));

console.log('--- 报告第三部分 P1-A / P1-B / P2 / P3 ---');
t('P1-A1 三档结构齐备（pairs / pctPaths / ambiguous）', () => {
  for (const re of [/pairs: \[/, /pctPaths: \[/, /ambiguous: \[/]) matches(LIMITS, re);
});
t('P1-A2 pairs 在 pctPaths 之前求值', () => {
  assert.ok(LIMITS.indexOf('of spec.pairs') < LIMITS.indexOf('of spec.pctPaths'));
  assert.ok(LIMITS.indexOf('of spec.pctPaths') < LIMITS.indexOf('of spec.ambiguous'));
});
t('P1-A3 分母不明的绝对值弃权', () => matches(LIMITS, /if \(!parsed\.explicit && parsed\.value > 1\) continue;/));
t('P1-A4 "%" 显式百分比被采信', () => matches(LIMITS, /parsed\.explicit \? parsed\.value : parsed\.value \* 100/));
t('P1-A5 无 pctOf 死代码', () => {
  notMatches(MAIN, /pctOf/);
  notMatches(LIMITS, /pctOf/);
});
t('P1-A6 纯函数已抽成可测模块并被 main.js 引用', () => {
  matches(MAIN, /require\('\.\/lib\/limits'\)/);
  matches(LIMITS, /module\.exports = \{/);
});
t('P1-B1 renderProviderList 不拼 innerHTML 模板', () => {
  const body = strip(REND.slice(REND.indexOf('function renderProviderList'), REND.indexOf('function rowMode')));
  notMatches(body, /innerHTML\s*=\s*`/);
  assert.ok(body.includes('createElement'), 'should build nodes');
});
t('P1-B2 无 ${p.id} 属性插值', () => notMatches(strip(REND), /\$\{p\.id\}/));
t('P1-B3 applyUsageRow 按 dataset 遍历匹配', () => {
  matches(REND, /\.find\(\(el\) => el\.dataset\.id === id\)/);
  notMatches(strip(REND), /querySelector\(`\[data-id/);
});
t('P1-B4 全项目无插值选择器', () => notMatches(strip(REND), /querySelector\([^)]*\$\{/));
t('P2-A http 告警用 URL.protocol', () => matches(REND, /new URL\(String\(p\.baseUrl \|\| ''\)\)\.protocol === 'http:'/));
t('P2-B loadProviders 有 catch + 可见横幅', () => {
  matches(REND, /window\.api\.loadProviders\(\)\.catch\(/);
  matches(REND, /renderLoadError/);
  matches(HTML, /id="loadError"/);
});
t('P2-C pollOne 单一受保护 DOM 调用点', () => {
  const body = REND.slice(REND.indexOf('async function pollOne'), REND.indexOf('// --- Util'));
  matches(body, /catch \(renderErr\)/);
  assert.strictEqual((body.match(/applyUsageRow\(/g) || []).length, 2, 'one guarded call site, error/success');
});
t('问题4 setInterval 在 await pollAll 之前', () => {
  assert.ok(REND.indexOf('setInterval(pollAll, POLL_INTERVAL_MS)') < REND.indexOf('await pollAll()'));
});
t('P3-A 行形状由 usage.mode 决定', () => {
  matches(REND, /function rowMode\(p\)/);
  matches(REND, /if \(row\.dataset\.mode !== mode\)/);
  matches(REND, /row\.innerHTML = buildRowHtml\(p, mode\)/);
});
t('P3-B providers:save 校验 id 字符串且唯一', () => {
  matches(MAIN, /typeof rawId !== 'string' \|\| rawId\.length === 0/);
  matches(MAIN, /seenIds\.has\(id\)/);
  matches(MAIN, /seenIds\.add\(id\)/);
});
t('第六轮 P3 批次：截断/锁顺序/版本告警/主机名匹配', () => {
  // P3-3: dedupe and storage must use the SAME (truncated) id
  matches(MAIN, /const id = rawId\.slice\(0, 100\)/);
  assert.ok(!/id: id\.slice\(0, 100\)/.test(MAIN), 'storage must reuse the already-truncated id');
  // P3-4: single-instance lock is acquired before anything async
  assert.ok(MAIN.indexOf('requestSingleInstanceLock') < MAIN.indexOf('app.whenReady()'), 'lock must be acquired before whenReady');
  // P3-7: a version we do not understand must not look like "no data"
  matches(MAIN, /version \$\{raw\.version\} is not supported/);
  // P3-8: match the hostname, not a substring of the URL
  matches(MAIN, /function hostOf\(url\)/);
  matches(MAIN, /host\.endsWith\('\.openai\.com'\)/);
  assert.ok(!/includes\('api\.openai\.com'\)/.test(strip(MAIN)), 'substring match would reject api.openai.com.example.com');
});
t('第六轮 P3-2/P3-1/P3-6：资产与死代码', () => {
  // P3-2: the generated tray PNG must not sit inside the packaged tree
  assert.ok(!fs.existsSync(path.join(ROOT, 'src', 'assets', 'tray.png')), 'unused asset would ship in the asar');
  matches(read('tools/make-icon.js'), /path\.join\(root, 'build', 'tray\.png'\)/);
  // P3-1: no dead branch left in the icon generator
  assert.ok(!/&& false/.test(read('tools/make-icon.js')), 'dead branch');
  // P3-6: pollAll reports whether a round actually started
  matches(REND, /if \(state\.polling\) return false/);
  matches(REND, /正在刷新，请稍候/);
});
t('P3-C 候选先到先用 + 记住可用路径', () => {
  matches(MAIN, /function probeCandidates\(/);
  matches(MAIN, /function probeAll\(list\)/); // N-22: takes the to-probe list
  matches(MAIN, /candidatePathCache\.set\(/);
  matches(MAIN, /candidatePathCache\.delete\(/);
  matches(MAIN, /candidatePathCache\.clear\(\)/);
  // 第五轮 P1-A: Promise.all waits for the SLOWEST candidate, which held a
  // 10ms answer hostage for 8s. Must be first-to-arrive instead.
  assert.ok(!/await Promise\.all\(/.test(MAIN), 'Promise.all would wait for the slowest candidate');
  assert.strictEqual((MAIN.match(/probeCandidates\(provider, '/g) || []).length, 2);
});
t('第五轮 P1-B accept 严格且按调用方区分', () => {
  matches(MAIN, /function hasPlanLimits\(/);
  matches(MAIN, /fetchOneAPIUserInfo\(provider, \(res\) => hasPlanLimits\(/);
  matches(MAIN, /viaUserInfo = normalizeBalance\(res\.data\)/);
  // the loose "is an object" test must be gone
  assert.ok(!/typeof root === 'object'\s*;?\s*\}\);/.test(MAIN), 'loose accept still present');
  // 七-P7: the branch after the strict accept could never be reached
  assert.ok(
    !MAIN.includes("if (!normalized) return { ok: false, error: '服务商返回中找不到余额字段' }"),
    'unreachable balance branch is back',
  );
});
t('第七轮 P3：诊断覆盖网络层（超时/断网不误报为字段问题）', () => {
  matches(MAIN, /return \{ statuses: \[\], messages: \[\], errors: \[\], responded: 0, unusable: 0 \}/);
  matches(MAIN, /if \(res\.ok\) diag\.responded\+\+/);
  matches(MAIN, /diag\.responded === 0 && diag\.statuses\.length > 0/);
  matches(MAIN, /else if \(res\.error\) diag\.errors\.push\(res\.error\)/);
  // N-20: the all-silent branch must not fire when a candidate DID answer.
  matches(MAIN, /diag\.statuses\.length === 0 && diag\.errors\.length > 0 &&\s*\n\s*diag\.unusable === 0 && diag\.responded === 0/);
  matches(MAIN, /请求超时（10 秒）/);
  matches(MAIN, /请求失败（网络层）/);
});
t('第七轮 P6/P5：图标生成器与测试清理', () => {
  assert.ok(!/&& false/.test(read('tools/make-icon.js')), 'dead && false branch');
  // the three-way ternary collapsed to one value
  assert.ok(!/b === 2 \? BAR : b === 1 \? BAR : BAR/.test(read('tools/make-icon.js')), 'same-value ternary');
  // failure paths must also clean their temp profile
  matches(read('test/tray.test.js'), /cleanup\(\); \/\/ 七-P5/);
  matches(read('test/ipc.test.js'), /fs\.rmSync\(TMP, \{ recursive: true, force: true \}\); \} catch/);
  matches(read('test/tmp-profiles.js'), /function sweepStale\(/);
});
t('失败原因可辨识且不回显 Key', () => {
  matches(MAIN, /function explainProbeFailure\(/);
  matches(MAIN, /function safeMessage\(/);
  matches(MAIN, /diag\.statuses\.find\(\(s\) => s === 401 \|\| s === 403\)/);
  matches(MAIN, /s\.split\(apiKey\)\.join\('\*\*\*'\)/); // real key value masked
  matches(MAIN, /replace\(\/\\b\(sk\|xai\|gsk\)-/); // and key-shaped strings
  matches(MAIN, /return s\.slice\(0, 120\)/);
});

console.log('--- 打包与文档 ---');
t('asar 开启且 files 覆盖 src（含 lib）', () => {
  assert.strictEqual(PKG.build.asar, true);
  assert.ok(PKG.build.files.includes('src/**/*'));
});
t('package.json 暴露 test 脚本', () => {
  assert.ok(PKG.scripts.test, 'npm test missing');
  assert.ok(PKG.scripts['test:dom'], 'npm run test:dom missing');
});
t('README 不重复测试条数（否则必然与实测漂移）', () => {
  notMatches(README, /报告条目回归 \d+/);
  notMatches(README, /IPC 端到端 \d+/);
  notMatches(README, /渲染断言 \d+/);
});
t('全项目真实 fetch( 调用仅 1 处', () => {
  let n = 0;
  for (const f of ['src/main.js', 'src/preload.js', 'src/renderer/renderer.js', 'src/lib/limits.js']) {
    for (const line of read(f).split(/\r?\n/)) {
      if (/\bfetch\(/.test(line) && !/^\s*(\/\/|\*)/.test(line)) n++;
    }
  }
  assert.strictEqual(n, 1, 'found ' + n + ' fetch calls');
});
t('README 不再写死 HTTPS-only 描述', () => notMatches(README, /发起一次 HTTPS 请求/));

console.log('--- 第九轮（N-19..N-23 + 杂项）---');
t('N-21 main.js 不得再出现「green dot」图标描述（实际是三柱图形）', () => {
  notMatches(MAIN, /green dot/i);
});
t('N-20 解析失败必须携带 status 与 parseError（不得并入网络失败）', () => {
  matches(MAIN, /parseError: err\?\.message \|\| String\(err\)/);
  matches(MAIN, /else if \(res\.parseError\) diag\.unusable\+\+/);
});
t('N-22 重探必须排除刚失败过的记忆路径', () => {
  matches(MAIN, /probeAll\(paths\.filter\(\(p\) => p !== remembered\)\)/);
});
t('N-23 删除回滚按 nextId 重算插入位（不得复用 await 前的 idx）', () => {
  notMatches(strip(REND), /splice\(idx, 0, removed\)/);
  matches(REND, /p\.id === nextId/);
});
t('杂项 saveThresholds 的 setItem 有 try 守卫（对齐 dismissPrivacyNotice）', () => {
  matches(strip(REND), /function saveThresholds\(t\) \{\s*try \{/);
});
t('杂项 dist.js 成功路径必须校验 Setup.exe 落地且非零字节', () => {
  const DIST = read('tools/dist.js');
  matches(DIST, /findSetupArtifact/);
  notMatches(DIST, /if \(res\.status === 0\) process\.exit\(0\)/);
});

console.log('\nreport-items.test: ' + pass + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  console.log('\nFailed:\n- ' + failures.join('\n- '));
  process.exit(1);
}
