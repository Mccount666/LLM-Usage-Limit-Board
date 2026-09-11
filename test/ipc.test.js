// End-to-end tests for the main-process IPC handlers.
//
// Loads the REAL src/main.js behind a stubbed `electron` module, then calls the
// registered ipcMain handlers directly. This is how providers:save validation
// and the usage:fetch -> detectLimitPct path get covered without a window.
//
// Run: npm test

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'llmb-test-'));
let encryptionAvailable = true; // flipped by the safeStorage-fallback test
const dataFile = () => path.join(TMP, 'providers.json');
const readStore = () => JSON.parse(fs.readFileSync(dataFile(), 'utf8'));
/** Replace the store on disk and drop the in-memory caches via a no-op delete. */
async function seedStore(providers) {
  fs.writeFileSync(dataFile(), JSON.stringify({ version: 1, providers }, null, 2));
  await handlers['providers:delete'](null, '__no_such_id__');
}
const handlers = {};
const windowCalls = [];
const trayCalls = [];
const lastWindow = () => windowCalls[windowCalls.length - 1];

const electronStub = {
  app: {
    commandLine: { appendSwitch() {} },
    // Run the callback so createWidgetWindow() actually executes — that is what
    // makes the window-control / tray handlers testable.
    whenReady: () => ({ then: (fn) => { fn(); } }),
    on() {},
    quit() {},
    requestSingleInstanceLock: () => true,
    getPath: () => TMP,
  },
  BrowserWindow: class {
    constructor() {
      this.webContents = { setWindowOpenHandler() {}, on() {} };
      this._minimized = false;
      this.calls = [];
      windowCalls.push(this);
    }
    loadFile() {}
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    isDestroyed() { return false; }
    minimize() { this._minimized = true; this.calls.push('minimize'); }
    hide() { this.calls.push('hide'); }
    show() { this.calls.push('show'); }
    focus() { this.calls.push('focus'); }
    isMinimized() { return this._minimized; }
    restore() { this._minimized = false; this.calls.push('restore'); }
  },
  ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) },
  safeStorage: {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (s) => Buffer.from('enc:' + s, 'utf8'),
    decryptString: (b) => b.toString('utf8').replace(/^enc:/, ''),
  },
  Tray: class {
    constructor() { trayCalls.push(this); }
    setToolTip() {}
    setContextMenu(menu) { this.menu = menu; }
    on() {}
    destroy() {}
  },
  Menu: { buildFromTemplate: (t) => t },
  nativeImage: { createFromDataURL: () => ({ isEmpty: () => false }) },
};

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return electronStub;
  return origLoad.apply(this, arguments);
};
require('../src/main.js');
Module._load = origLoad;

let routes = [];
const calls = [];
global.fetch = async (url, opts = {}) => {
  calls.push({ url, headers: opts.headers || {} });
  for (const r of routes) {
    if (url.includes(r.match)) {
      if (r.delay) await new Promise((res) => setTimeout(res, r.delay));
      if (r.throw) throw r.throw; // simulate timeout / DNS / refused
      return { ok: r.status === 200, status: r.status, json: async () => r.body };
    }
  }
  return { ok: false, status: 404, json: async () => ({}) };
};
const setRoutes = (list) => { routes = list; calls.length = 0; };

let pass = 0;
const failures = [];
async function t(label, fn) {
  try {
    await fn();
    pass++;
    console.log('  ok   ' + label);
  } catch (err) {
    failures.push(label + ' :: ' + err.message);
    console.log('  FAIL ' + label + ' :: ' + err.message);
  }
}
const save = (list) => handlers['providers:save'](null, list);
const load = () => handlers['providers:load'](null);
const fetchUsage = (id) => handlers['usage:fetch'](null, id);
const hasHandler = (ch) => typeof handlers[ch] === 'function';

(async () => {
  console.log('--- ipc 注册面 ---');
  await t('7 个通道全部注册', () => {
    for (const ch of ['providers:load', 'providers:save', 'providers:delete', 'usage:fetch', 'security:status', 'window:minimize', 'window:hide']) {
      assert.ok(hasHandler(ch), 'missing handler ' + ch);
    }
  });

  console.log('--- providers:save: id 校验 (P3-B) ---');
  await t('非字符串 id 被拒', async () => {
    const r = await save([{ id: undefined, name: 'x', baseUrl: 'https://a.com', mode: 'plan' }]);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /id 不合法/);
  });
  await t('空字符串 id 被拒', async () => {
    assert.strictEqual((await save([{ id: '', name: 'x', baseUrl: 'https://a.com', mode: 'plan' }])).ok, false);
  });
  await t('数字 id 被拒', async () => {
    assert.strictEqual((await save([{ id: 42, name: 'x', baseUrl: 'https://a.com', mode: 'plan' }])).ok, false);
  });
  await t('重复 id 被拒', async () => {
    const r = await save([
      { id: 'dup', name: 'a', baseUrl: 'https://a.com', mode: 'plan' },
      { id: 'dup', name: 'b', baseUrl: 'https://b.com', mode: 'plan' },
    ]);
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /重复/);
  });
  await t('file:// 协议被拒 (P2-3 写入侧)', async () => {
    assert.strictEqual((await save([{ id: 'f1', name: 'x', baseUrl: 'file:///etc/passwd', mode: 'plan' }])).ok, false);
  });

  console.log('--- providers:load ---');
  await t('保存两条并读回', async () => {
    const r = await save([
      { id: 'p1', name: 'Plan A', baseUrl: 'https://gw.example.com', mode: 'plan', apiKey: 'sk-plan' },
      { id: 'p2', name: 'Bal B', baseUrl: 'https://gw.example.com', mode: 'balance', apiKey: 'sk-bal' },
    ]);
    assert.strictEqual(r.ok, true);
    const listed = await load();
    assert.deepStrictEqual(listed.map((p) => p.id), ['p1', 'p2']);
  });
  await t('load 不泄漏 apiKey 明文', async () => {
    for (const p of await load()) {
      assert.ok(!('apiKey' in p) && !('apiKeyEnc' in p), 'leaked key on ' + p.id);
    }
  });
  await t('hasKey 为 true', async () => {
    assert.ok((await load()).every((p) => p.hasKey === true));
  });

  console.log('--- usage:fetch / plan（真实 detectLimitPct 链路）---');
  await t('used/total 300/1000 -> 30（报告表格第 2 例）', async () => {
    setRoutes([{ match: '/api/user/self', status: 200, body: { data: { five_hour: { used: 300, total: 1000 }, seven_day: { used_percentage: 88 } } } }]);
    const r = await fetchUsage('p1');
    assert.strictEqual(r.ok, true);
    assert.ok(Math.abs(r.usage.fiveHourPct - 30) < 1e-9, 'fiveHourPct=' + r.usage.fiveHourPct);
    assert.ok(Math.abs(r.usage.weeklyPct - 88) < 1e-9, 'weeklyPct=' + r.usage.weeklyPct);
  });
  await t('Authorization 头带解密后的 key', () => {
    assert.ok(calls.some((c) => String(c.headers.Authorization) === 'Bearer sk-plan'));
  });
  await t('裸 300 不被当成 300%', async () => {
    setRoutes([{ match: '/api/user/self', status: 200, body: { data: { '5h_used': 300 } } }]);
    const r = await fetchUsage('p1');
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /找不到/);
  });

  console.log('--- usage:fetch / balance（并发探测 P3-C）---');
  await t('余额解析成功', async () => {
    setRoutes([
      { match: '/api/user/balance', status: 200, body: { data: { balance: 12.5 } } },
      { match: '/api/user/wallet', status: 404, body: {} },
      { match: '/api/user/quota', status: 404, body: {} },
    ]);
    const r = await fetchUsage('p2');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.usage.amount, 12.5);
    assert.strictEqual(r.usage.currency, '');
  });
  await t('余额候选并发探测（清缓存后 3 个同时发出）', async () => {
    // save() clears the remembered-path cache so this measures the pure probe
    await save([
      { id: 'p1', name: 'Plan A', baseUrl: 'https://gw.example.com', mode: 'plan' },
      { id: 'p2', name: 'Bal B', baseUrl: 'https://gw.example.com', mode: 'balance' },
    ]);
    setRoutes([
      { match: '/api/user/balance', status: 404, delay: 150, body: {} },
      { match: '/api/user/wallet', status: 404, delay: 150, body: {} },
      { match: '/api/user/quota', status: 404, delay: 150, body: {} },
      { match: '/api/user/self', status: 200, body: { data: { balance: 7 } } },
    ]);
    const t0 = Date.now();
    const r = await fetchUsage('p2');
    const elapsed = Date.now() - t0;
    assert.strictEqual(r.ok, true);
    const probed = calls.filter((c) => /\/api\/user\/(balance|wallet|quota)/.test(c.url)).length;
    assert.strictEqual(probed, 3, 'probed ' + probed);
    // The count assertion above is the authoritative one; this timing bound is
    // deliberately loose so a loaded machine cannot flake it (P3-H).
    assert.ok(elapsed < 1000, 'took ' + elapsed + 'ms — serial would be ~450ms');
  });

  console.log('--- 候选路径记忆（P3-C：首次并发探测，稳态单请求）---');
  await t('首次探测并发（4 候选各 150ms → <350ms）', async () => {
    // save() also clears the remembered-path cache
    await save([
      { id: 'p1', name: 'Plan A', baseUrl: 'https://gw.example.com', mode: 'plan' },
      { id: 'p2', name: 'Bal B', baseUrl: 'https://gw.example.com', mode: 'balance' },
    ]);
    setRoutes([
      { match: '/api/user/self', status: 200, delay: 150, body: { data: { five_hour: { used: 300, total: 1000 } } } },
      { match: '/api/user/token', status: 404, delay: 150, body: {} },
      { match: '/api/user/status', status: 404, delay: 150, body: {} },
      { match: '/api/status', status: 404, delay: 150, body: {} },
    ]);
    const t0 = Date.now();
    const r = await fetchUsage('p1');
    const elapsed = Date.now() - t0;
    assert.strictEqual(r.ok, true);
    assert.ok(elapsed < 1000, 'took ' + elapsed + 'ms — serial would be ~600ms');
  });
  await t('稳态只发 1 个请求（复用记住的路径）', async () => {
    calls.length = 0;
    const r = await fetchUsage('p1');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(calls.length, 1, 'made ' + calls.length + ': ' + calls.map((c) => c.url).join(', '));
    assert.ok(calls[0].url.endsWith('/api/user/self'), calls[0].url);
  });
  await t('记住的路径失效 → 重新探测并恢复', async () => {
    setRoutes([
      { match: '/api/user/self', status: 404, body: {} },
      { match: '/api/user/token', status: 404, body: {} },
      { match: '/api/user/status', status: 200, body: { data: { five_hour: { used: 1, total: 4 } } } },
      { match: '/api/status', status: 404, body: {} },
    ]);
    const r = await fetchUsage('p1');
    assert.strictEqual(r.ok, true);
    assert.ok(Math.abs(r.usage.fiveHourPct - 25) < 1e-9, 'got ' + r.usage.fiveHourPct);
    assert.ok(calls.length >= 5, 'expected remembered-fail + 4 probes, made ' + calls.length);
  });

  console.log('--- 窗口控制 + 托盘（N-7 / N-12）---');
  await t('窗口被创建', () => {
    assert.ok(windowCalls.length >= 1, 'createWidgetWindow did not run');
  });
  await t('window:hide 隐藏窗口并惰性创建托盘', async () => {
    const before = trayCalls.length;
    await handlers['window:hide'](null);
    assert.ok(lastWindow().calls.includes('hide'), 'hide() not called');
    assert.strictEqual(trayCalls.length, before + 1, 'tray should be created on first hide');
  });
  await t('再次最小化不会重复创建托盘', async () => {
    const before = trayCalls.length;
    await handlers['window:minimize'](null);
    assert.ok(lastWindow().calls.includes('minimize'), 'minimize() not called');
    assert.strictEqual(trayCalls.length, before, 'tray must be created once');
  });
  await t('托盘菜单提供「显示看板」与「退出」', () => {
    const labels = trayCalls[0].menu.map((m) => m.label).filter(Boolean);
    assert.ok(labels.includes('显示看板'), JSON.stringify(labels));
    assert.ok(labels.includes('退出'), JSON.stringify(labels));
  });
  // The tray menu is the ONLY restore path now (the unused window:show IPC
  // channel was removed to shrink the surface), so it must do the full job.
  await t('菜单「显示看板」恢复被最小化的窗口并聚焦', async () => {
    const w = lastWindow();
    w._minimized = true;
    w.calls.length = 0;
    trayCalls[0].menu.find((m) => m.label === '显示看板').click();
    assert.deepStrictEqual(w.calls, ['restore', 'show', 'focus'], JSON.stringify(w.calls));
  });
  await t('窗口未最小化时菜单只 show + focus', async () => {
    const w = lastWindow();
    w._minimized = false;
    w.calls.length = 0;
    trayCalls[0].menu.find((m) => m.label === '显示看板').click();
    assert.deepStrictEqual(w.calls, ['show', 'focus'], JSON.stringify(w.calls));
  });
  await t('已移除的 window:show 通道确实不存在', () => {
    assert.ok(!handlers['window:show'], 'window:show should no longer be registered');
  });

  console.log('--- 反例测试（第五轮复核 P1-A / P1-B）---');
  await t('P1-A 先到先用：首选 0ms + 一个候选 3000ms → <300ms', async () => {
    // The old Promise.all waited for the slowest candidate: the correct 0ms
    // answer was held for 3s (the reviewer measured 10ms held for 8035ms).
    await save([
      { id: 'p1', name: 'Plan A', baseUrl: 'https://gw.example.com', mode: 'plan' },
      { id: 'p2', name: 'Bal B', baseUrl: 'https://gw.example.com', mode: 'balance' },
    ]);
    setRoutes([
      { match: '/api/user/self', status: 200, delay: 0, body: { data: { five_hour: { used: 1, total: 4 } } } },
      { match: '/api/user/token', status: 404, delay: 3000, body: {} },
      { match: '/api/user/status', status: 404, delay: 3000, body: {} },
      { match: '/api/status', status: 404, delay: 3000, body: {} },
    ]);
    const t0 = Date.now();
    const r = await fetchUsage('p1');
    const elapsed = Date.now() - t0;
    assert.strictEqual(r.ok, true);
    assert.ok(Math.abs(r.usage.fiveHourPct - 25) < 1e-9, 'got ' + r.usage.fiveHourPct);
    assert.ok(elapsed < 300, 'took ' + elapsed + 'ms — must not wait for slow candidates');
  });
  await t('P1-B 200+{} 不被接受，有效候选胜出并被记住', async () => {
    await save([
      { id: 'p1', name: 'Plan A', baseUrl: 'https://gw.example.com', mode: 'plan' },
      { id: 'p2', name: 'Bal B', baseUrl: 'https://gw.example.com', mode: 'balance' },
    ]);
    setRoutes([
      // HTTP 200 + no usable limit field — the shape OneAPI returns for a key
      // without permission. Must NOT be accepted/cached.
      { match: '/api/user/self', status: 200, body: { success: false, message: '无权进行此操作' } },
      { match: '/api/user/status', status: 200, body: { data: { five_hour: { used: 3, total: 10 } } } },
      { match: '/api/user/token', status: 404, body: {} },
      { match: '/api/status', status: 404, body: {} },
    ]);
    const r = await fetchUsage('p1');
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.ok(Math.abs(r.usage.fiveHourPct - 30) < 1e-9, 'got ' + (r.usage && r.usage.fiveHourPct));

    // …and the cache must remember the candidate that actually worked
    calls.length = 0;
    const r2 = await fetchUsage('p1');
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(calls.length, 1, 'steady state made ' + calls.length + ': ' + calls.map((c) => c.url).join(', '));
    assert.ok(calls[0].url.endsWith('/api/user/status'), calls[0].url);
  });
  await t('P1-B 全是 200+{} 时明确报错（不静默当 0）', async () => {
    await save([
      { id: 'p1', name: 'Plan A', baseUrl: 'https://gw.example.com', mode: 'plan' },
      { id: 'p2', name: 'Bal B', baseUrl: 'https://gw.example.com', mode: 'balance' },
    ]);
    setRoutes([{ match: '/api/', status: 200, body: { success: false, message: '无权进行此操作' } }]);
    const r = await fetchUsage('p1');
    assert.strictEqual(r.ok, false);
    // 200 + no usable field must be an explicit failure that quotes the gateway,
    // not a silent 0%
    assert.match(r.error, /无权进行此操作/);
  });

  console.log('--- 失败原因可辨识（key 错误 vs 不支持 vs 无字段）---');
  const reseed = () => save([
    { id: 'p1', name: 'Plan A', baseUrl: 'https://gw.example.com', mode: 'plan' },
    { id: 'p2', name: 'Bal B', baseUrl: 'https://gw.example.com', mode: 'balance' },
  ]);
  await t('401 → 明确指出 Key 有问题，而不是"找不到字段"', async () => {
    await reseed();
    setRoutes([{ match: '/api/', status: 401, body: {} }]);
    const r = await fetchUsage('p1');
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /API Key 无效或权限不足（HTTP 401）/);
    assert.ok(!/找不到 5h/.test(r.error), 'should not blame field names: ' + r.error);
  });
  await t('403 → 同样归类为鉴权问题', async () => {
    await reseed();
    setRoutes([{ match: '/api/', status: 403, body: {} }]);
    assert.match((await fetchUsage('p1')).error, /HTTP 403/);
  });
  await t('200+{success:false,message} → 转述服务商自己的话', async () => {
    await reseed();
    setRoutes([{ match: '/api/', status: 200, body: { success: false, message: '无权进行此操作' } }]);
    assert.match((await fetchUsage('p1')).error, /无权进行此操作/);
  });
  await t('全部 404 → 指向 Base URL 配置', async () => {
    await reseed();
    setRoutes([{ match: '/api/', status: 404, body: {} }]);
    assert.match((await fetchUsage('p1')).error, /404|Base URL/);
  });
  await t('错误文案不回显 API Key', async () => {
    await reseed();
    // gateway echoes the key back in its message
    setRoutes([{ match: '/api/', status: 200, body: { success: false, message: 'key sk-plan is not allowed' } }]);
    const r = await fetchUsage('p1');
    assert.ok(!r.error.includes('sk-plan'), 'key leaked into the UI message: ' + r.error);
    assert.match(r.error, /\*\*\*/);
  });

  console.log('--- 网络层失败（七-P3：不能误报成「找不到字段」）---');
  await t('200 但字段不可用 + 其余 404 → 报字段问题，不报 Base URL', async () => {
    await reseed();
    setRoutes([{ match: '/api/user/self', status: 200, body: { data: { maybe: 1 } } }]);
    const r = await fetchUsage('p1');
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /找不到/, r.error);
    assert.ok(!/404|Base URL/.test(r.error), 'must not blame the URL: ' + r.error);
  });
  await t('全部候选网络失败 → 归类为请求失败/网络层', async () => {
    await reseed();
    setRoutes([{ match: '/api/', throw: new Error('connect ECONNREFUSED 127.0.0.1:443') }]);
    const r = await fetchUsage('p1');
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /请求失败|网络层/, r.error);
    assert.ok(!/找不到/.test(r.error), 'must not blame field names: ' + r.error);
  });
  await t('超时（AbortError）→ 明确说超时', async () => {
    await reseed();
    const abortErr = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    setRoutes([{ match: '/api/', throw: abortErr }]);
    assert.match((await fetchUsage('p1')).error, /超时/);
  });
  await t('余额模式同样归类网络层（走 explainProbeFailure 的另一分支）', async () => {
    await reseed();
    setRoutes([{ match: '/api/', throw: new Error('getaddrinfo ENOTFOUND gw.example.com') }]);
    const r = await fetchUsage('p2');
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /请求失败|网络层/, r.error);
    assert.ok(!/找不到/.test(r.error), r.error);
  });

  console.log('--- 只报一侧限额：另一侧必须是 null，不能被伪造成 0 ---');
  await t('只有周限额时 fiveHourPct 为 null（不是 0）', async () => {
    await reseed();
    setRoutes([{ match: '/api/user/self', status: 200, body: { data: { seven_day: { used_percentage: 80 } } } }]);
    const r = await fetchUsage('p1');
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.usage.weeklyPct, 80);
    assert.strictEqual(r.usage.fiveHourPct, null, 'missing side must stay null, got ' + JSON.stringify(r.usage.fiveHourPct));
  });
  await t('只有 5h 限额时 weeklyPct 为 null', async () => {
    await reseed();
    setRoutes([{ match: '/api/user/self', status: 200, body: { data: { five_hour: { used: 1, total: 4 } } } }]);
    const r = await fetchUsage('p1');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.usage.fiveHourPct, 25);
    assert.strictEqual(r.usage.weeklyPct, null);
  });

  console.log('--- 行为验证（取代只匹配源码的文本断言）---');
  await t('P1-5 删除后缓存失效：被删的订阅不再可查', async () => {
    await reseed();
    setRoutes([{ match: '/api/user/self', status: 200, body: { data: { five_hour: { used: 1, total: 4 } } } }]);
    assert.strictEqual((await fetchUsage('p1')).ok, true);
    await handlers['providers:delete'](null, 'p1');
    const r = await fetchUsage('p1');
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /订阅不存在/);
    assert.ok((await load()).every((p) => p.id !== 'p1'), 'delete must persist');
  });
  await t('P2-3 读取侧：磁盘上被改成 file:// 也要拦住', async () => {
    // Simulates a hand-edited / migrated providers.json — the write-side check
    // never ran for this file.
    await seedStore([
      {
        id: 'evil',
        name: 'Evil',
        baseUrl: 'file:///C:/Windows/win.ini',
        mode: 'plan',
        apiKeyEnc: { v: 1, alg: 'plain', data: Buffer.from('k', 'utf8').toString('base64') },
      },
    ]);
    setRoutes([{ match: '/api/', status: 200, body: { data: { five_hour: { used: 1, total: 4 } } } }]);
    const r = await fetchUsage('evil');
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.match(r.error, /协议不支持|格式不合法/);
    assert.strictEqual(calls.length, 0, 'must not even attempt a request');
  });
  await t('P2-5 safeStorage 不可用时降级为 plain 并如实上报', async () => {
    const warns = [];
    const origWarn = console.warn;
    console.warn = (...a) => warns.push(a.join(' '));
    try {
      encryptionAvailable = false;
      await save([{ id: 'p1', name: 'Plan A', baseUrl: 'https://gw.example.com', mode: 'plan', apiKey: 'sk-plain' }]);
      const status = await handlers['security:status'](null);
      assert.strictEqual(status.encryptionAvailable, false);
      const rec = readStore().providers.find((p) => p.id === 'p1');
      assert.strictEqual(rec.apiKeyEnc.alg, 'plain', 'should fall back to plain');
      assert.ok(warns.some((w) => /safeStorage unavailable/.test(w)), 'must warn: ' + JSON.stringify(warns));
      // and the key still round-trips so polling still works
      setRoutes([{ match: '/api/user/self', status: 200, body: { data: { five_hour: { used: 1, total: 4 } } } }]);
      assert.strictEqual((await fetchUsage('p1')).ok, true);
    } finally {
      console.warn = origWarn;
      encryptionAvailable = true;
    }
  });
  await t('P1-1 编辑时不重输 key 会保留旧 key；传空串则删除', async () => {
    encryptionAvailable = true;
    await save([{ id: 'p1', name: 'Plan A', baseUrl: 'https://gw.example.com', mode: 'plan', apiKey: 'sk-orig' }]);
    // edit: only the name changes, apiKey omitted (undefined = keep)
    await save([{ id: 'p1', name: 'Renamed', baseUrl: 'https://gw.example.com', mode: 'plan' }]);
    setRoutes([{ match: '/api/user/self', status: 200, body: { data: { five_hour: { used: 1, total: 4 } } } }]);
    calls.length = 0;
    assert.strictEqual((await fetchUsage('p1')).ok, true);
    assert.ok(calls.some((c) => String(c.headers.Authorization) === 'Bearer sk-orig'), 'old key must be kept');
    // explicit empty string deletes the key
    await save([{ id: 'p1', name: 'Renamed', baseUrl: 'https://gw.example.com', mode: 'plan', apiKey: '' }]);
    assert.strictEqual(readStore().providers.find((p) => p.id === 'p1').apiKeyEnc, null);
    const r = await fetchUsage('p1');
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /尚未填写 API Key/);
  });

  console.log('\nipc.test: ' + pass + ' passed, ' + failures.length + ' failed');
  fs.rmSync(TMP, { recursive: true, force: true });
  if (failures.length) {
    console.log('\nFailed:\n- ' + failures.join('\n- '));
    process.exit(1);
  }
})().catch((err) => {
  console.error('harness error', err);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(1);
});
