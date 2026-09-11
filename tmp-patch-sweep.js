// TEMP patch: reliable temp-profile handling in all three suites.
const fs = require('fs');

function patch(file, reps) {
  let s = fs.readFileSync(file, 'utf8');
  for (const [a, b] of reps) {
    if (!s.includes(a)) throw new Error(file + ': anchor not found -> ' + a.slice(0, 70));
    s = s.replace(a, b);
  }
  fs.writeFileSync(file, s);
  console.log('patched ' + file);
}

// ---- test/dom/main.js: sweep on the way in (delete on the way out already) --
patch('test/dom/main.js', [
  [
    `const dataDir = path.join(os.tmpdir(), 'llmb-dom-' + process.pid);
app.setPath('userData', dataDir);`,
    `const { sweepStale } = require('../tmp-profiles');
const swept = sweepStale(['llmb-dom-']);
if (swept) console.log('swept ' + swept + ' stale profile(s) left by earlier runs');

const dataDir = path.join(os.tmpdir(), 'llmb-dom-' + process.pid);
app.setPath('userData', dataDir);`,
  ],
]);

// ---- test/tray.test.js: sweep + clean up on BOTH exit paths ----------------
patch('test/tray.test.js', [
  [
    `const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmb-tray-'));
app.setPath('userData', dataDir);`,
    `const { sweepStale } = require('./tmp-profiles');
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
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* next run sweeps */ }
}
process.on('exit', cleanup);`,
  ],
  [
    `  console.log('\\ntray.test: ' + pass + ' passed, ' + failures.length + ' failed');
  if (failures.length) console.log('Failed:\\n- ' + failures.join('\\n- '));
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  app.exit(failures.length ? 1 : 0);
})().catch((err) => {
  console.error('harness error', err);
  app.exit(1);
});`,
    `  console.log('\\ntray.test: ' + pass + ' passed, ' + failures.length + ' failed');
  if (failures.length) console.log('Failed:\\n- ' + failures.join('\\n- '));
  cleanup();
  app.exit(failures.length ? 1 : 0);
})().catch((err) => {
  console.error('harness error', err);
  cleanup(); // 七-P5: the error path used to leave its profile behind
  app.exit(1);
});`,
  ],
]);

// ---- test/ipc.test.js: the failure path skipped cleanup --------------------
patch('test/ipc.test.js', [
  [
    `  console.log('\\nipc.test: ' + pass + ' passed, ' + failures.length + ' failed');
  fs.rmSync(TMP, { recursive: true, force: true });
  if (failures.length) {
    console.log('Failed:\\n- ' + failures.join('\\n- '));
    process.exit(1);
  }
})().catch((err) => { console.error('harness error', err); process.exit(1); });`,
    `  console.log('\\nipc.test: ' + pass + ' passed, ' + failures.length + ' failed');
  fs.rmSync(TMP, { recursive: true, force: true });
  if (failures.length) {
    console.log('Failed:\\n- ' + failures.join('\\n- '));
    process.exit(1);
  }
})().catch((err) => {
  console.error('harness error', err);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
  process.exit(1);
});`,
  ],
]);
