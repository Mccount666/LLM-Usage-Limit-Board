// DOM regression test. Real Electron loads the real renderer with a stub
// preload, so the renderer's actual escaping / lookup / shape logic is exercised.
//
// Run: npm run test:dom
// Usage: electron test/dom/main.js [preloadFile] [case]

const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const preloadFile = process.argv[2] || 'stub-preload.js';
const testCase = process.argv[3] || 'injection';
const root = path.join(__dirname, '..', '..');

// Isolate persistent state (localStorage: balance thresholds) per run — the
// `behavior` case changes the thresholds, and sharing a profile made later
// cases assert against the mutated values.
const { sweepStale, scheduleCleanup } = require('../tmp-profiles');
const swept = sweepStale(['llmb-dom-']);
if (swept) console.log('swept ' + swept + ' stale profile(s) left by earlier runs');

const dataDir = path.join(os.tmpdir(), 'llmb-dom-' + process.pid);
app.setPath('userData', dataDir);

// NOTE: cleanup must run BEFORE app.exit(). Electron's app.exit() terminates
// immediately and does NOT emit 'quit'/'before-quit'/'will-quit', so an
// `app.on('quit', cleanup)` handler never fires — that mistake leaked one
// ~7.6MB Chromium profile per case (58 dirs / 403MB observed). process.on('exit')
// is a belt-and-braces catch for any path that skips cleanup().
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  scheduleCleanup(dataDir); // deletes now, or via a detached helper after exit
}
process.on('exit', cleanup);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const failures = [];
function ck(label, cond, detail) {
  if (cond) {
    pass++;
    console.log('  ok   ' + label + (detail ? '  [' + detail + ']' : ''));
  } else {
    failures.push(label + (detail ? ' :: ' + detail : ''));
    console.log('  FAIL ' + label + (detail ? '  [' + detail + ']' : ''));
  }
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 520,
    height: 620,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, preloadFile),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const errors = [];
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2) errors.push(msg);
  });

  await win.loadFile(path.join(root, 'src', 'renderer', 'index.html'));
  await new Promise((r) => setTimeout(r, 1600));

  if (testCase === 'injection') {
    const res = JSON.parse(
      await win.webContents.executeJavaScript(`(() => {
        const rows = [...document.querySelectorAll('.usage-item')];
        const rowOf = (id) => rows.find((r) => r.dataset.id === id);
        const pcts = (r) => [...r.querySelectorAll('.bar-pct')].map((e) => e.textContent);
        return JSON.stringify({
          imgInProviderList: document.querySelectorAll('#providerList img').length,
          imgInUsageList: document.querySelectorAll('#usageList img').length,
          xssIdFlag: window.__xssId === undefined ? 'undefined' : 'EXECUTED',
          lastUpdated: document.getElementById('lastUpdated').textContent,
          rowIds: rows.map((r) => r.dataset.id),
          injPcts: pcts(rows[0]),
          p2Pcts: pcts(rowOf('p2')),
          p3Errors: [...rowOf('p3').querySelectorAll('.usage-error')].map((e) => e.textContent),
          modeTags: document.querySelectorAll('#providerList .mode-tag').length,
          buttons: document.querySelectorAll('#providerList button').length,
          httpWarningHidden: document.getElementById('httpWarning').classList.contains('hidden'),
          // P1-A: provider that reports only the weekly window
          p5Pcts: pcts(rowOf('p5')),
          p5FillClasses: [...rowOf('p5').querySelectorAll('.bar-fill')].map((e) => e.className),
          p5PctTitles: [...rowOf('p5').querySelectorAll('.bar-pct')].map((e) => e.title),
          // P2-C: a long balance reading must not be clipped by its column
          p6Text: rowOf('p6').querySelector('.bar-pct').textContent,
          // A fixed-width column makes an unbreakable reading OVERFLOW rather
          // than wrap, so scrollWidth vs clientWidth is the metric that reacts.
          p6Overflow: (() => { const el = rowOf('p6').querySelector('.bar-pct'); return el.scrollWidth - el.clientWidth; })(),
          p6Title: rowOf('p6').querySelector('.bar-pct').title,
          // Bar fill must be proportional to the percentage (measured, not eyeballed)
          barsByRow: rows.map((r) =>
            [...r.querySelectorAll('.bar')].map((track) => {
              const fill = track.querySelector('.bar-fill');
              const tw = track.getBoundingClientRect().width;
              if (!fill || !tw) return null;
              return Math.round((fill.getBoundingClientRect().width / tw) * 1000) / 10;
            }),
          ),
        });
      })()`),
    );

    // P1-B: the id below used to inject an <img> AND throw a SyntaxError from
    // querySelector, which killed the refresh chain (lastUpdated stayed "—").
    ck('provider 列表无注入 <img>（修复前为 2）', res.imgInProviderList === 0, String(res.imgInProviderList));
    ck('看板列表无注入 <img>', res.imgInUsageList === 0, String(res.imgInUsageList));
    ck('注入脚本未执行', res.xssIdFlag === 'undefined', res.xssIdFlag);
    ck('恶意 id 原样保留在 dataset 中', res.rowIds[0] === 'inj"><img src=x onerror="window.__xssId=1', JSON.stringify(res.rowIds[0]));
    ck('自动刷新链路存活（修复前 lastUpdated 停在 "—"）', res.lastUpdated.startsWith('更新于'), JSON.stringify(res.lastUpdated));
    ck('恶意 id 那行读数正常', res.injPcts.length === 2 && res.injPcts[0] === '42.5%', JSON.stringify(res.injPcts));
    ck('P3-A 形状随数据（plan 收到 balance → 1 条 bar）', res.p2Pcts.length === 1 && res.p2Pcts[0] === '30.00', JSON.stringify(res.p2Pcts));
    ck('bar 宽度与百分比成正比（实测 5h 42.5 / 7d 88）', Math.abs(res.barsByRow[0][0] - 42.5) < 1 && Math.abs(res.barsByRow[0][1] - 88) < 1, JSON.stringify(res.barsByRow[0]));
    ck('余额中段阈值公式（30 介于 10/50 → 50%）', Math.abs(res.barsByRow[1][0] - 50) < 1, JSON.stringify(res.barsByRow[1]));
    ck('低用量行成正比（实测 10 / 20）', Math.abs(res.barsByRow[3][0] - 10) < 1 && Math.abs(res.barsByRow[3][1] - 20) < 1, JSON.stringify(res.barsByRow[3]));
    ck('错误态行两条 bar 归零', res.barsByRow[2].every((v) => v === 0), JSON.stringify(res.barsByRow[2]));
    ck('错误态写入行内', res.p3Errors.length === 1 && res.p3Errors[0] === 'boom', JSON.stringify(res.p3Errors));
    ck('provider 列表渲染名称与模式标签', res.modeTags === 6, String(res.modeTags));
    ck('编辑/删除按钮各 6 个（共 12）', res.buttons === 12, String(res.buttons));
    // 第六轮复核 P2-C
    ck('长余额读数完整显示', res.p6Text === '12345678.00', JSON.stringify(res.p6Text));
    ck('长余额读数未溢出列宽', res.p6Overflow <= 1, 'overflowPx=' + res.p6Overflow);
    ck('余额读数有单位说明 tooltip', /不.*换算|原样显示/.test(res.p6Title || ''), JSON.stringify(res.p6Title));
    // Prove that assertion is discriminating: restore the pre-fix layout and
    // confirm the same metric then reports overflow.
    const overflowUnderOldCss = await win.webContents.executeJavaScript(`(() => {
      const st = document.createElement('style');
      st.textContent = '.bar-row{grid-template-columns:36px 1fr 36px !important}';
      document.head.appendChild(st);
      const el = [...document.querySelectorAll('.usage-item')].find((r) => r.dataset.id === 'p6').querySelector('.bar-pct');
      const over = el.scrollWidth - el.clientWidth;
      st.remove();
      return over;
    })()`);
    ck('该断言能判别旧布局（旧 CSS 下确实溢出）', overflowUnderOldCss > 1, 'overflowPx=' + overflowUnderOldCss);
    ck('P2-A HTTP:// 大写协议也触发明文告警', res.httpWarningHidden === false, 'hidden=' + res.httpWarningHidden);
    // 第六轮复核 P1-A：只报一侧限额时，缺的那侧必须是未知态
    ck('缺的那侧显示 -- 而不是 0%', res.p5Pcts[0] === '--', JSON.stringify(res.p5Pcts));
    ck('缺的那侧 bar 是 unknown（不是绿色 ok）', /unknown/.test(res.p5FillClasses[0]) && !/ok|warn|danger/.test(res.p5FillClasses[0]), JSON.stringify(res.p5FillClasses[0]));
    ck('缺的那侧有解释性 tooltip', /未返回/.test(res.p5PctTitles[0] || ''), JSON.stringify(res.p5PctTitles[0]));
    ck('有数据的那侧照常显示', res.p5Pcts[1] === '80.0%' && /warn/.test(res.p5FillClasses[1]), JSON.stringify(res.p5Pcts));
    // 第八轮 杂项：unknown 行翻转到错误态时，斜纹类与 tooltip 必须一并清掉，
    // 否则"缺数据"的观感会残留进错误态（applyUsageRow error 分支的行为断言）
    const misc = await win.webContents.executeJavaScript(`(async () => {
      try {
        await window.api.setUsage('p5', { ok: false, error: 'probe failed' });
        await pollOne('p5');
        const row = [...document.querySelectorAll('.usage-item')].find((r) => r.dataset.id === 'p5');
        const fill = row.querySelector('.bar-fill');
        const pct = row.querySelector('.bar-pct');
        const err = row.querySelector('.usage-error');
        return JSON.stringify({ pageError: '', fillClasses: fill.className, pctTitle: pct.title, pctText: pct.textContent, errText: err ? err.textContent : '' });
      } catch (e) {
        return JSON.stringify({ pageError: String((e && e.stack) || e) });
      }
    })()`).then((s) => JSON.parse(s));
    ck('杂项探针自身无页面异常', misc.pageError === '', misc.pageError || 'clean');
    ck('杂项：unknown 行转错误态后不残留 unknown 类', misc.fillClasses.trim() === 'bar-fill ok', JSON.stringify(misc.fillClasses));
    ck('杂项：unknown 的 tooltip 一并清空', misc.pctTitle === '', JSON.stringify(misc.pctTitle));
    ck('杂项：错误态读数仍是 --（不是上一轮的 80.0%）', misc.pctText === '--', JSON.stringify(misc.pctText));
    ck('杂项：错误信息写入行内', /probe failed/.test(misc.errText), JSON.stringify(misc.errText));
    ck('渲染进程无 console 错误', errors.length === 0, JSON.stringify(errors.slice(0, 2)));
  } else if (testCase === 'behavior') {
    // Behavioural (not source-text) assertions for two items the reviewer asked
    // to upgrade: polling re-entrancy and "threshold change must not re-request".
    const res = JSON.parse(
      await win.webContents.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const pcts = () => [...document.querySelectorAll('.bar-pct')].map((e) => e.textContent);
        const out = { providerCount: document.querySelectorAll('.usage-item').length };

        // 1) two overlapping polls must not double the requests
        const before = await window.api.getFetchCount();
        pollAll(); pollAll();
        await wait(400);
        out.requestsForTwoPolls = (await window.api.getFetchCount()) - before;

        // 2) changing a threshold must redraw from cache without any request
        const before2 = await window.api.getFetchCount();
        const pctsBefore = pcts();
        const warn = document.getElementById('thresholdWarn');
        warn.value = '80';
        warn.dispatchEvent(new Event('change'));
        await wait(250);
        out.requestsAfterThresholdChange = (await window.api.getFetchCount()) - before2;
        out.pctsUnchanged = JSON.stringify(pctsBefore) === JSON.stringify(pcts());
        out.widthsAfter = [...document.querySelectorAll('.bar-fill')].map((e) => e.style.width);

        // 3) P3-6: a manual refresh while a round is in flight used to do
        //    nothing at all. Slow pollOne down so the window is deterministic.
        const origPollOne = pollOne;
        pollOne = () => new Promise((r) => setTimeout(r, 400));
        const firstStarted = pollAll();          // starts a round (in flight ~400ms)
        const secondStarted = await pollAll();   // must decline, not queue a second
        document.getElementById('refreshBtn').click();
        await wait(80);
        out.refreshHint = document.getElementById('lastUpdated').textContent;
        out.secondPollStarted = secondStarted;
        await firstStarted;
        pollOne = origPollOne;
        out.firstPollStarted = true;

        // 4) P1-6: a NEW provider with no key must be refused before any IPC
        const savesBefore = await window.api.getSaveCount();
        document.getElementById('providerName').value = 'No Key';
        document.getElementById('providerBaseUrl').value = 'https://nk.example.com';
        document.getElementById('providerApiKey').value = '';
        document.getElementById('providerId').value = '';
        document.getElementById('providerForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        await wait(150);
        out.savesForNoKey = (await window.api.getSaveCount()) - savesBefore;
        out.rowsForNoKey = document.querySelectorAll('#usageList .usage-item').length;
        return JSON.stringify(out);
      })()`),
    );
    console.log('DOM ' + JSON.stringify(res));
    ck('两次重叠轮询只发一轮请求（每个 provider 恰好 1 次）', res.requestsForTwoPolls === res.providerCount, JSON.stringify(res.requestsForTwoPolls) + ' vs ' + res.providerCount);
    ck('阈值变更不发任何请求', res.requestsAfterThresholdChange === 0, String(res.requestsAfterThresholdChange));
    ck('阈值变更后读数由缓存重绘（未清空）', res.pctsUnchanged === true, JSON.stringify(res.pctsUnchanged));
    // 第六轮复核 P3-6
    ck('轮询进行中再次触发会明确拒绝（不排队第二轮）', res.secondPollStarted === false, String(res.secondPollStarted));
    ck('刷新中点击 ↻ 有可见反馈', res.refreshHint === '正在刷新，请稍候…', JSON.stringify(res.refreshHint));
    // P1-6
    ck('新增订阅不填 Key 时不会发起保存', res.savesForNoKey === 0, String(res.savesForNoKey));
    ck('也不会多出一行', res.rowsForNoKey === res.providerCount, JSON.stringify(res.rowsForNoKey));
  } else if (testCase === 'savefail') {
    // P1-C: saveProviders() rejecting must surface a visible error and must NOT
    // render a row that only exists in memory.
    const res = JSON.parse(
      await win.webContents.executeJavaScript(`(async () => {
        document.getElementById('providerName').value = 'Unsaveable';
        document.getElementById('providerBaseUrl').value = 'https://x.example.com';
        document.getElementById('providerApiKey').value = 'sk-1';
        document.getElementById('providerForm').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
        await new Promise((r) => setTimeout(r, 300));
        const el = document.getElementById('saveError');
        const before = {
          hidden: el.classList.contains('hidden'),
          text: el.textContent,
          rowsShown: document.querySelectorAll('#usageList .usage-item').length,
          formStillFilled: document.getElementById('providerName').value,
        };
        // P1-B: the failure must not leave a GHOST entry in state. Triggering a
        // later full re-render is what used to expose it (e.g. after deleting
        // some other provider). Nothing may appear here.
        renderAll();
        renderProviderList();
        return JSON.stringify({
          ...before,
          rowsAfterRenderAll: document.querySelectorAll('#usageList .usage-item').length,
          listedAfterRenderAll: document.querySelectorAll('#providerList li').length,
        });
      })()`),
    );
    console.log('DOM ' + JSON.stringify(res));
    ck('保存失败横幅可见', res.hidden === false, 'hidden=' + res.hidden);
    ck('横幅含 IPC rejection 原因', /保存失败/.test(res.text) && /read-only/.test(res.text), JSON.stringify(res.text));
    ck('未渲染"假保存成功"的行', res.rowsShown === 0, String(res.rowsShown));
    ck('表单内容保留（用户不用重输）', res.formStillFilled === 'Unsaveable', res.formStillFilled);
    // 第六轮复核 P1-B：失败后任何一次重绘都不得冒出幽灵订阅
    ck('再次 renderAll() 后仍无幽灵行', res.rowsAfterRenderAll === 0, String(res.rowsAfterRenderAll));
    ck('设置面板列表也没有幽灵条目', res.listedAfterRenderAll === 0, String(res.listedAfterRenderAll));
    ck('渲染进程无 console 错误（无未处理 rejection）', errors.length === 0, JSON.stringify(errors.slice(0, 2)));
  } else if (testCase === 'ipcfail') {
    // P1-C for the other three call sites: a rejected deleteProvider must roll
    // back the row (not show a deletion that never happened), and rejected
    // window controls must not become unhandled rejections.
    const res = JSON.parse(
      await win.webContents.executeJavaScript(`(async () => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const pcts = () => [...document.querySelectorAll('.usage-item')].map((r) =>
          [...r.querySelectorAll('.bar-pct')].map((e) => e.textContent));
        const rowsBefore = [...document.querySelectorAll('.usage-item')].map((r) => r.dataset.id);
        const pctsBefore = pcts();
        // provider list: [edit, del] per row → index 1 is the first row's delete
        document.querySelectorAll('#providerList button')[1].click();
        await wait(300);
        const rowsAfter = [...document.querySelectorAll('.usage-item')].map((r) => r.dataset.id);
        const el = document.getElementById('saveError');
        document.getElementById('minimizeBtn').click();
        document.getElementById('hideBtn').click();
        await wait(200);
        return JSON.stringify({
          rowsBefore,
          rowsAfter,
          pctsBefore,
          pctsAfterRollback: pcts(),
          errorHidden: el.classList.contains('hidden'),
          errorText: el.textContent,
        });
      })()`),
    );
    console.log('DOM ' + JSON.stringify(res));
    ck('删除失败后行回滚（UI 不显示未落盘的删除）', JSON.stringify(res.rowsAfter) === JSON.stringify(res.rowsBefore), JSON.stringify(res.rowsAfter));
    ck('删除失败有可见提示', res.errorHidden === false && /删除失败/.test(res.errorText), JSON.stringify(res.errorText));
    // N-14: the rollback must restore the usage cache too — otherwise the
    // rolled-back row loses its readings ("--") until the next poll.
    ck('回滚后读数原样保留（缓存一并恢复，不退回 --）', JSON.stringify(res.pctsAfterRollback) === JSON.stringify(res.pctsBefore), JSON.stringify(res.pctsAfterRollback));
    ck('窗口按钮 reject 不产生未处理 rejection', errors.length === 0, JSON.stringify(errors.slice(0, 2)));
  } else if (testCase === 'firstrun') {
    // Privacy notice: shown on first launch, remembered after dismissal.
    const before = JSON.parse(
      await win.webContents.executeJavaScript(`(() => {
        const el = document.getElementById('privacyNotice');
        const r = el.getBoundingClientRect();
        return JSON.stringify({
          hidden: el.classList.contains('hidden'),
          displayed: getComputedStyle(el).display !== 'none',
          coversBoard: r.height > window.innerHeight * 0.5,
          text: el.textContent.replace(/\\s+/g, ' ').trim().slice(0, 200),
          ackVisible: Boolean(document.getElementById('privacyAck')),
          headerUsable: getComputedStyle(document.querySelector('.widget-header')).webkitAppRegion === 'drag',
        });
      })()`),
    );
    console.log('DOM ' + JSON.stringify(before));
    ck('首次启动显示隐私提示', before.hidden === false && before.displayed === true, 'hidden=' + before.hidden);
    ck('提示覆盖看板区域（不是藏在设置里）', before.coversBoard === true, 'coversBoard=' + before.coversBoard);
    ck('文案包含"只保存在这台电脑上"与"唯一的外发请求"', /只保存在这台电脑上/.test(before.text) && /唯一的外发请求/.test(before.text), JSON.stringify(before.text.slice(0, 80)));
    ck('有确认按钮', before.ackVisible === true);
    ck('标题栏仍可拖动（没被提示挡住）', before.headerUsable === true);

    // dismiss, then reload: it must stay dismissed
    await win.webContents.executeJavaScript(`document.getElementById('privacyAck').click()`);
    await wait(200);
    const afterClick = await win.webContents.executeJavaScript(
      `document.getElementById('privacyNotice').classList.contains('hidden')`,
    );
    ck('点「知道了」后立即隐藏', afterClick === true);

    await win.webContents.reload();
    await wait(1500);
    const afterReload = JSON.parse(
      await win.webContents.executeJavaScript(`(() => JSON.stringify({
        hidden: document.getElementById('privacyNotice').classList.contains('hidden'),
        stored: (() => { try { return localStorage.getItem('llm-board.privacyAck'); } catch { return null; } })(),
      }))()`),
    );
    ck('重载后不再出现（已记住）', afterReload.hidden === true, 'hidden=' + afterReload.hidden);
    ck('localStorage 里留下了确认标记', afterReload.stored === '1', String(afterReload.stored));
  } else if (testCase === 'visual') {
    // The tray icon is a hand-generated inline PNG — make sure Electron can
    // actually decode it (an empty image makes Tray silent/invisible).
    const mainSrc = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const b64 = (mainSrc.match(/'data:image\/png;base64,([A-Za-z0-9+/=]+)'/) || [])[1];
    ck('main.js 里能找到内联托盘图标 data URL', Boolean(b64), b64 ? b64.slice(0, 24) + '…' : 'not found');
    const icon = nativeImage.createFromDataURL('data:image/png;base64,' + b64);
    ck('托盘图标可被 nativeImage 解码（非空）', !icon.isEmpty(), 'empty=' + icon.isEmpty());
    const size = icon.getSize();
    ck('托盘图标尺寸 16x16', size.width === 16 && size.height === 16, size.width + 'x' + size.height);
    const png = icon.toPNG();
    ck('托盘图标 PNG 字节数合理', png.length > 80 && png.length < 2000, png.length + ' bytes');

    // Capture the rendered widget so a human can eyeball the panel/layout.
    const shot = path.join(os.tmpdir(), 'llmb-widget-shot.png');
    const image = await win.webContents.capturePage();
    fs.writeFileSync(shot, image.toPNG());
    ck('成功截取渲染结果', image.getSize().width > 0 && image.getSize().height > 0, JSON.stringify(image.getSize()));
    ck('截图非空白（PNG > 3KB）', image.toPNG().length > 3000, image.toPNG().length + ' bytes');
    console.log('screenshot (first run): ' + shot);

    // …and a second one with the first-run notice dismissed, so the normal
    // board layout also has a visual artifact to review.
    await win.webContents.executeJavaScript(`document.getElementById('privacyAck').click()`);
    await wait(400);
    const shot2 = path.join(os.tmpdir(), 'llmb-widget-shot-acked.png');
    const image2 = await win.webContents.capturePage();
    fs.writeFileSync(shot2, image2.toPNG());
    ck('关闭提示后的截图非空白', image2.toPNG().length > 3000, image2.toPNG().length + ' bytes');
    console.log('screenshot (board): ' + shot2);
  } else if (testCase === 'mini') {
    // 双态窗口：预置 displayMode=mini 后重载，渲染层应收缩成迷你状态条——
    // body.mini 挂类、迷你条可见、面板元素全部隐藏；窗口几何/穿透由主进程
    // 侧（window:set-display-mode）负责，不在渲染断言面内。
    await win.webContents.executeJavaScript(`localStorage.setItem('llm-board.displayMode', 'mini'); 'set'`);
    await win.webContents.reload();
    await wait(1500);
    const res = JSON.parse(
      await win.webContents.executeJavaScript(`(() => JSON.stringify({
        mini: document.body.classList.contains('mini'),
        barVisible: !document.getElementById('miniBar').classList.contains('hidden'),
        headerHidden: getComputedStyle(document.querySelector('.widget-header')).display === 'none',
        boardHidden: getComputedStyle(document.querySelector('.board')).display === 'none',
        items: document.querySelectorAll('.mini-bar .mi').length,
        persisted: (() => { try { return localStorage.getItem('llm-board.displayMode'); } catch { return null; } })(),
      }))()`),
    );
    ck('body.mini 生效', res.mini === true, JSON.stringify(res));
    ck('迷你状态条可见', res.barVisible === true, String(res.barVisible));
    ck('面板头部隐藏', res.headerHidden === true, String(res.headerHidden));
    ck('看板隐藏', res.boardHidden === true, String(res.boardHidden));
    ck('每个订阅一个迷你项', res.items === 6, String(res.items));
    ck('displayMode 偏好持久化', res.persisted === 'mini', String(res.persisted));
    ck('渲染进程无 console 错误', errors.length === 0, JSON.stringify(errors.slice(0, 2)));
  } else {
    // P2-B: loadProviders() rejecting must not blank the widget silently.
    const res = JSON.parse(
      await win.webContents.executeJavaScript(`(() => {
        const el = document.getElementById('loadError');
        return JSON.stringify({
          exists: !!el,
          hidden: el ? el.classList.contains('hidden') : null,
          text: el ? el.textContent : '',
          boardRendered: !document.getElementById('emptyState').classList.contains('hidden'),
        });
      })()`),
    );
    ck('loadError 横幅存在', res.exists === true);
    ck('loadError 可见（非 hidden）', res.hidden === false, String(res.hidden));
    ck('提示含失败原因', /读取本地订阅失败/.test(res.text) && /IPC channel closed/.test(res.text), JSON.stringify(res.text));
    ck('init 未中断，renderAll 仍执行', res.boardRendered === true);
    ck('渲染进程无 console 错误', errors.length === 0, JSON.stringify(errors.slice(0, 2)));
  }

  console.log('dom.test(' + testCase + '): ' + pass + ' passed, ' + failures.length + ' failed');
  if (failures.length) console.log('Failed:\n- ' + failures.join('\n- '));
  cleanup(); // before app.exit(): quit handlers never fire
  app.exit(failures.length ? 1 : 0);
});
