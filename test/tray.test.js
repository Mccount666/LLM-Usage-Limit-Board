// Real-Electron tray / window-control test.
//
// The stub-based test in ipc.test.js proves the handler logic; this one runs
// inside a real Electron process with a REAL Tray (real nativeImage decode, real
// notification-area object) so the "click the tray to get the window back" path
// is exercised end to end. It is still not a physical mouse click on the
// notification area, but every layer below that is real.
//
// It does not touch the user's real profile: userData is redirected to a temp
// dir before main.js is loaded, so providers.json is never read or written.
//
// Run: npm run test:tray

const { app, BrowserWindow, Tray, Menu } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const { sweepStale, scheduleCleanup } = require('./tmp-profiles');
const swept = sweepStale(['llmb-tray-']);
if (swept) console.log('swept ' + swept + ' stale tray profile(s)');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmb-tray-'));
app.setPath('userData', dataDir);

// Must run BEFORE app.exit(): exit() emits no 'quit', and process.on('exit')
// is the backstop for the error path (第六/七轮复核 七-P5).
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  scheduleCleanup(dataDir);
}
process.on('exit', cleanup);

// ---- capture real objects while letting main.js use the real modules -------
const created = { trays: [], menus: [], handlers: {} };

class CapturingTray extends Tray {
  constructor(image) {
    super(image);
    created.trays.push(this);
    this.__image = image;
  }
}
const realIpcMain = require('electron').ipcMain;
const ipcProxy = new Proxy(realIpcMain, {
  get(target, prop) {
    if (prop === 'handle') {
      return (channel, fn) => {
        created.handlers[channel] = fn;
        return target.handle(channel, fn); // register for real
      };
    }
    return target[prop];
  },
});
const menuProxy = new Proxy(Menu, {
  get(target, prop) {
    if (prop === 'buildFromTemplate') {
      return (template) => {
        created.menus.push(template);
        return target.buildFromTemplate(template);
      };
    }
    return target[prop];
  },
});

const realElectron = require('electron');
const electronProxy = new Proxy(realElectron, {
  get(target, prop) {
    if (prop === 'Tray') return CapturingTray;
    if (prop === 'ipcMain') return ipcProxy;
    if (prop === 'Menu') return menuProxy;
    return target[prop];
  },
});

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return electronProxy;
  return origLoad.apply(this, arguments);
};
require(path.join(__dirname, '..', 'src', 'main.js')); // the real app
Module._load = origLoad;

// ---- tiny harness ---------------------------------------------------------
let pass = 0;
const failures = [];
function ck(label, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + label + (detail ? '  [' + detail + ']' : '')); }
  else { failures.push(label + (detail ? ' :: ' + detail : '')); console.log('  FAIL ' + label + (detail ? '  [' + detail + ']' : '')); }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const widgetWindow = () => BrowserWindow.getAllWindows()[0];

(async () => {
  await app.whenReady();
  for (let i = 0; i < 40 && !widgetWindow(); i++) await wait(100);
  await wait(1200); // let the renderer load
  const win = widgetWindow();

  console.log('--- 真实 Electron 托盘链路 ---');
  ck('窗口已创建', Boolean(win));
  ck('初始可见', win.isVisible() === true);

  // hide via the registered IPC handler (this is what the × button triggers)
  await created.handlers['window:hide'](null);
  await wait(300);
  ck('window:hide 后窗口不可见', win.isVisible() === false);
  ck('创建了真实 Tray 实例', created.trays.length === 1, 'count=' + created.trays.length);
  const tray = created.trays[0];
  ck('托盘图标是有效的非空图像', tray.__image && tray.__image.isEmpty() === false, 'empty=' + (tray.__image ? tray.__image.isEmpty() : 'n/a'));
  const labels = (created.menus[0] || []).map((m) => m.label).filter(Boolean);
  ck('托盘菜单含「显示看板」「退出」', labels.includes('显示看板') && labels.includes('退出'), JSON.stringify(labels));

  // the real tray 'click' event is what fires when the user clicks the icon
  tray.emit('click');
  await wait(400);
  ck('点击托盘后窗口恢复可见', win.isVisible() === true);

  // and the menu item path
  const showItem = (created.menus[0] || []).find((m) => m.label === '显示看板');
  await created.handlers['window:hide'](null);
  await wait(250);
  ck('再次隐藏（托盘不重复创建）', win.isVisible() === false && created.trays.length === 1, 'trays=' + created.trays.length);
  showItem.click();
  await wait(400);
  ck('菜单「显示看板」也能恢复窗口', win.isVisible() === true);

  // minimize → tray click must un-minimize, not just show
  await created.handlers['window:minimize'](null);
  await wait(300);
  ck('window:minimize 后窗口最小化', win.isMinimized() === true);
  tray.emit('click');
  await wait(400);
  ck('托盘点击后解除最小化并可见', win.isMinimized() === false && win.isVisible() === true);

  console.log('\ntray.test: ' + pass + ' passed, ' + failures.length + ' failed');
  if (failures.length) console.log('Failed:\n- ' + failures.join('\n- '));
  cleanup();
  app.exit(failures.length ? 1 : 0);
})().catch((err) => {
  console.error('harness error', err);
  cleanup(); // 七-P5: the error path used to leave its profile behind
  app.exit(1);
});
