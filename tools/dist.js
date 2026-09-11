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
const res = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit', env: process.env });
process.exit(res.status === null ? 1 : res.status);
