#!/usr/bin/env node
// Wrapper around electron-builder that defaults the download mirrors to
// npmmirror.
//
// Why this exists: electron-builder fetches NSIS / winCodeSign / the Electron
// dist from GitHub releases. From mainland China github.com is unreachable, and
// the failure mode is not an error — the build just hangs after creating an
// empty `dist/win-unpacked` with no output. That cost real time to diagnose
// once, so the mirrors are now the default here.
//
// Any mirror env var you set yourself wins over these defaults.
//
// Usage: node tools/dist.js [--win] [--x64] ...   (see `npm run dist:win`)

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_MIRRORS = {
  ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/',
};

for (const [key, value] of Object.entries(DEFAULT_MIRRORS)) {
  if (!process.env[key]) {
    process.env[key] = value;
    console.log('[dist] ' + key + '=' + value + '  (set it yourself to override)');
  }
}

const cli = path.join(__dirname, '..', 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
const args = process.argv.slice(2);

// Fallback for machines where unpacking the Electron zip loses electron.exe
// (observed here: the zip contains it, but extraction leaves everything except
// the 188MB binary, which Windows Defender's real-time protection is the likely
// cause of). Copying from the already-unpacked `node_modules/electron/dist`
// avoids the extraction entirely. Only applied when it cannot cause a version
// mismatch: an explicit `build.electronVersion` means the caller pins a version,
// so we respect that and let electron-builder fetch it.
if (!args.some((a) => a.includes('electronDist'))) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const pinned = pkg.build && pkg.build.electronVersion;
    const distDir = path.join(__dirname, '..', 'node_modules', 'electron', 'dist');
    const hasBinary = fs.existsSync(path.join(distDir, process.platform === 'win32' ? 'electron.exe' : 'electron'));
    if (hasBinary && !pinned) {
      args.push('--config.electronDist=' + path.relative(path.join(__dirname, '..'), distDir).split(path.sep).join('/'));
      console.log('[dist] using the already-unpacked electron in node_modules/electron/dist');
      console.log('[dist]   (avoids re-extracting the zip, which can drop electron.exe; set build.electronVersion to opt out)');
    } else if (pinned) {
      console.log('[dist] build.electronVersion is pinned — letting electron-builder fetch electron ' + pinned);
    }
  } catch (err) {
    console.log('[dist] electronDist fallback skipped: ' + err.message);
  }
}

const res = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit', env: process.env });
process.exit(res.status === null ? 1 : res.status);
