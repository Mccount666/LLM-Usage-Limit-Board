// Temp-profile bookkeeping for the Electron-backed test suites.
//
// Two facts learned the hard way (审查报告 第六/七轮复核):
//   1. app.exit() does not emit 'quit'/'before-quit'/'will-quit', so a cleanup
//      handler registered on 'quit' never runs — cleanup must happen before it;
//   2. even then, deletion can fail while Chromium still holds handles, and a
//      run that is killed (or that hangs) cannot clean up at all. One session
//      accumulated 58 profiles / 403MB this way.
//
// So we do both: delete on the way out, and sweep leftovers from *dead* PIDs on
// the way in. The sweep only touches directories whose owning process is gone,
// which keeps concurrent runs safe.

const fs = require('fs');
const os = require('os');
const path = require('path');

// `llmb-dist-` is the dist.test.js subprocess sandbox (also pid-named, same
// sweep rules) — added when that suite joined the npm test chain (N-24).
const PREFIXES = ['llmb-dom-', 'llmb-tray-', 'llmb-dist-'];

/** Is a pid still running? EPERM means "exists but not ours" → alive. */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

/**
 * Remove profile directories left behind by processes that no longer exist.
 * @returns how many were removed
 */
function sweepStale(prefixes = PREFIXES) {
  let removed = 0;
  let entries;
  try {
    entries = fs.readdirSync(os.tmpdir());
  } catch {
    return 0;
  }
  for (const name of entries) {
    const prefix = prefixes.find((p) => name.startsWith(p));
    if (!prefix) continue;
    const pid = Number(name.slice(prefix.length));
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    if (pidAlive(pid)) continue; // a live sibling run owns it
    try {
      fs.rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
      removed++;
    } catch {
      // Still locked (e.g. Windows releasing handles) — the next run retries.
    }
  }
  return removed;
}

/**
 * Delete a profile now, and if Windows still holds handles on it, hand the job
 * to a detached helper that runs after we exit. Chromium routinely keeps the
 * last case's profile locked at exit time, which is why a synchronous rmSync
 * alone left one directory per suite behind.
 */
function scheduleCleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // fall through to the helper
  }
  if (!fs.existsSync(dir)) return;

  // Retry: the last case's profile can stay locked for a few seconds after the
  // process is gone, so a single attempt is not enough.
  const script =
    'var fs=require("fs"),p=' +
    JSON.stringify(dir) +
    ',n=0,t=setInterval(function(){n++;try{fs.rmSync(p,{recursive:true,force:true})}catch(e){}' +
    'if(!fs.existsSync(p)||n>10)clearInterval(t)},1000)';
  try {
    const { spawn } = require('child_process');
    spawn(process.execPath, ['-e', script], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, // electron.exe as plain node
    }).unref();
  } catch {
    // The next run's sweepStale() is the last line of defence.
  }
}

module.exports = { sweepStale, scheduleCleanup, pidAlive, PREFIXES };
