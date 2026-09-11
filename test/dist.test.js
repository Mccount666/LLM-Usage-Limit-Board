// Subprocess-level regression for tools/dist.js (N-24 + N-27, 审查报告 第十/十一轮).
//
// The artefact gate's whole point lives at the PROCESS boundary: "electron-
// builder exited 0 but no Setup.exe landed" must make dist.js exit non-zero.
// No in-process assertion can cover that, and the round-9 static guard
// (notMatches on the old one-line exit) only pins literals — the gate was
// rewritten into a multi-line form and slipped past it (方法论补记（第十轮）#1).
// So this suite spawns the REAL tools/dist.js against a STUB electron-builder
// CLI inside a %TEMP% sandbox, and asserts on exit codes, stdout/stderr and
// the surviving dist/ contents.
//
// The three N-24 cases are the reviewer's sandbox probe, converted to
// regression; Cases 4–6 are the N-27 probe (round 11), same treatment:
//   Case 1  builder always exits 0, lands nothing  → dist.js must exit 1
//           (this is exactly the hole N-24 closed: it used to exit 0)
//   Case 2  attempt 1 exits 1, attempt 2 lands the artefact → "artefact:" line
//           on stdout and exit 0
//   Case 3  three straight failures → exit 1, and the final attempt must NOT
//           clear dist/ (attempt 2's scene survives for diagnosis; attempt 1's
//           was cleared before attempt 2, as designed)
//   Case 4  a STALE Setup.exe preset in dist/ + builder exit 0 landing
//           nothing → non-zero exit and NO "artefact:" line (N-27: a leftover
//           from a previous run must not satisfy the gate; sandbox S1)
//   Case 4b builder always exits 2 → final EXIT=2 (a real builder exit code
//           is preserved through the || 1; sandbox S3)
//   Case 5  attempt 2 lands a half artefact then exits 1, the kept-for-
//           diagnosis dist/ carries it into the final attempt which lands
//           nothing → non-zero exit, no "artefact:" line (N-27 sandbox S2)
//   Case 6  same setup but the final attempt genuinely rewrites the artefact
//           (same name, fresh mtime) → accepted: the snapshot gate must not
//           over-reject a real rebuild
//   Case 7  builder exit 0 landing a ZERO-BYTE Setup.exe → non-zero exit, no
//           "artefact:" line (N-29 round-12 probe A2: empty is not an artefact)
//   Case 8  a stale Setup.exe sorting FIRST + the builder landing a fresh one
//           on attempt 1 → accepted on the FIRST attempt, builder invoked
//           exactly once (N-29 probe A1: the old first-hit-early-return gate
//           misread "first is stale" as "none is fresh", burned a retry and
//           let clearDist() wipe the fresh artefact)
//
// Run: npm test (last in the chain — spawns the most processes)

const assert = require('assert');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sweepStale } = require('./tmp-profiles');

const ROOT = path.join(__dirname, '..');
// pid-named like the dom/tray profiles so sweepStale() reaps it if we die
const SANDBOX = path.join(os.tmpdir(), 'llmb-dist-' + process.pid);
const CLI_DIR = path.join(SANDBOX, 'node_modules', 'electron-builder', 'out', 'cli');
const DIST = () => path.join(SANDBOX, 'dist');
const STATE = () => path.join(SANDBOX, 'scene-state.json');

sweepStale(); // reap leftovers from a killed previous run first

function buildSandbox() {
  fs.mkdirSync(path.join(SANDBOX, 'tools'), { recursive: true });
  fs.mkdirSync(CLI_DIR, { recursive: true });
  // The thing under test, copied verbatim — no edits, no re-implementation.
  fs.copyFileSync(path.join(ROOT, 'tools', 'dist.js'), path.join(SANDBOX, 'tools', 'dist.js'));
  // Stub electron-builder CLI. dist.js spawns it with `env: process.env`, so
  // the scenario flows through LLMB_DIST_SCENE. Each attempt appends a marker
  // file to dist/ so the clear-vs-keep behavior is observable per attempt.
  const cli = [
    "const fs = require('fs');",
    "const path = require('path');",
    "const root = path.resolve(__dirname, '..', '..', '..', '..');",
    "const n = (fs.existsSync(" + JSON.stringify(STATE()) + ") ? JSON.parse(fs.readFileSync(" + JSON.stringify(STATE()) + ", 'utf8')).n : 0) + 1;",
    "fs.writeFileSync(" + JSON.stringify(STATE()) + ", JSON.stringify({ n }));",
    "fs.mkdirSync(" + JSON.stringify(DIST()) + ", { recursive: true });",
    "fs.writeFileSync(path.join(" + JSON.stringify(DIST()) + ", 'scene-' + n + '.txt'), 'attempt ' + n);",
    "const scene = process.env.LLMB_DIST_SCENE;",
    "if (scene === 'exit0-no-artefact') process.exit(0);",
    "if (scene === 'fail-then-succeed' && n >= 2) {",
    "  fs.writeFileSync(path.join(" + JSON.stringify(DIST()) + ", 'LLM Usage Limit Board-0.1.0-Setup.exe'), 'x');",
    "  process.exit(0);",
    "}",
    "if (scene === 'half-then-nothing' && n === 2) {",
    "  fs.writeFileSync(path.join(" + JSON.stringify(DIST()) + ", 'LLM Usage Limit Board-0.1.0-Setup.exe'), 'partial-from-attempt-2');",
    "  process.exit(1);",
    "}",
    "if (scene === 'half-then-real') {",
    "  if (n === 2) {",
    "    fs.writeFileSync(path.join(" + JSON.stringify(DIST()) + ", 'LLM Usage Limit Board-0.1.0-Setup.exe'), 'partial-from-attempt-2');",
    "    process.exit(1);",
    "  }",
    "  if (n === 3) {",
    "    fs.writeFileSync(path.join(" + JSON.stringify(DIST()) + ", 'LLM Usage Limit Board-0.1.0-Setup.exe'), 'real-from-attempt-3');",
    "    process.exit(0);",
    "  }",
    "}",
    "if (scene === 'always-exit2') process.exit(2);",
    // N-29 (round 12) scenes: every attempt exits 0; one lands a 0-byte
    // Setup.exe (reviewer probe A2), the other lands a real one (probe A1's
    // fresh artefact behind a stale first hit).
    "if (scene === 'zero-byte') {",
    "  fs.writeFileSync(path.join(" + JSON.stringify(DIST()) + ", 'LLM Usage Limit Board-0.1.0-Setup.exe'), '');",
    "  process.exit(0);",
    "}",
    "if (scene === 'fresh-every-time') {",
    "  fs.writeFileSync(path.join(" + JSON.stringify(DIST()) + ", 'LLM Usage Limit Board-0.1.0-Setup.exe'), 'fresh-build-' + n);",
    "  process.exit(0);",
    "}",
    'process.exit(1);',
  ].join('\n');
  fs.writeFileSync(path.join(CLI_DIR, 'cli.js'), cli);
}

function freshCase() {
  fs.rmSync(STATE(), { force: true });
  fs.rmSync(DIST(), { recursive: true, force: true });
}

function run(scene) {
  return spawnSync(process.execPath, [path.join(SANDBOX, 'tools', 'dist.js')], {
    encoding: 'utf8',
    env: { ...process.env, LLMB_DIST_SCENE: scene },
  });
}

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

buildSandbox();

t('N-24 Case 1  builder 恒 exit 0 且不落产物 → dist.js 必须以非零码退出', () => {
  freshCase();
  const res = run('exit0-no-artefact');
  assert.strictEqual(res.status, 1, 'terminal failure must exit 1 (the N-24 bug exited 0), got ' + res.status);
  assert.match(res.stderr, /no Setup\.exe landed/, res.stderr);
  assert.match(res.stderr, /build failed after 3 attempts/, res.stderr);
});

t('N-24 Case 2  第 1 次 exit 1、第 2 次落产物 → artefact 行 + exit 0', () => {
  freshCase();
  const res = run('fail-then-succeed');
  assert.strictEqual(res.status, 0, 'stderr: ' + res.stderr);
  assert.match(res.stdout, /\[dist\] artefact: .*Setup\.exe/, res.stdout);
  assert.ok(fs.existsSync(path.join(DIST(), 'LLM Usage Limit Board-0.1.0-Setup.exe')), 'artefact must exist');
});

t('N-24 Case 3  三连败 → exit 1 + 终局保留现场（attempt 2/3 场景还在，1 已被正常清理）', () => {
  freshCase();
  const res = run('always-fail');
  assert.strictEqual(res.status, 1, 'got ' + res.status);
  assert.match(res.stdout, /final attempt — keeping the previous dist\//, res.stdout);
  assert.deepStrictEqual(fs.readdirSync(DIST()).sort(), ['scene-2.txt', 'scene-3.txt'],
    'attempt-2 scene must survive into the final attempt');
});

t('N-27 Case 4  预置陈旧 Setup.exe + builder exit0 不落产物 → 非零退出，且不得输出 artefact 行', () => {
  freshCase();
  // dist/ left over from a "previous run": a complete, non-empty Setup.exe
  fs.mkdirSync(DIST(), { recursive: true });
  fs.writeFileSync(path.join(DIST(), 'LLM Usage Limit Board-0.1.0-Setup.exe'), 'STALE-FROM-PREVIOUS-RUN');
  const res = run('exit0-no-artefact');
  assert.strictEqual(res.status, 1, 'a stale artefact must not satisfy the gate, got ' + res.status);
  assert.ok(!/\[dist\] artefact:/.test(res.stdout), 'stale artefact must not be reported as ours: ' + res.stdout);
  assert.match(res.stderr, /no Setup\.exe landed/, res.stderr);
  assert.match(res.stderr, /predates this attempt/, 'the diagnosis hint should name the rejection: ' + res.stderr);
  assert.match(res.stderr, /build failed after 3 attempts/, res.stderr);
});

t('N-27 Case 4b  builder 恒 exit 2 → 终局 EXIT=2（真实退出码经 || 1 保留）', () => {
  freshCase();
  const res = run('always-exit2');
  assert.strictEqual(res.status, 2, 'got ' + res.status);
  assert.ok(!/\[dist\] artefact:/.test(res.stdout), 'no artefact line on failure: ' + res.stdout);
});

t('N-27 Case 5  第 2 次落半成品 + 终局 exit0 不落新产物 → 非零退出（保留现场不得当成本次产物）', () => {
  freshCase();
  const res = run('half-then-nothing');
  assert.strictEqual(res.status, 1, 'the attempt-2 half artefact must not ride out on attempt 3, got ' + res.status);
  assert.ok(!/\[dist\] artefact:/.test(res.stdout), 'must not claim the half artefact: ' + res.stdout);
  // the half artefact itself survives for diagnosis (final attempt keeps dist/)
  assert.strictEqual(
    fs.readFileSync(path.join(DIST(), 'LLM Usage Limit Board-0.1.0-Setup.exe'), 'utf8'),
    'partial-from-attempt-2',
    'the failing scene must still be on disk for diagnosis',
  );
});

t('N-27 Case 6  终局真的重写产物（同名、新 mtime）→ 正常放行 + artefact 行（快照不得错杀真重建）', () => {
  freshCase();
  const res = run('half-then-real');
  assert.strictEqual(res.status, 0, 'a genuine rebuild overwriting the same name must pass: ' + res.stderr);
  assert.match(res.stdout, /\[dist\] artefact: .*Setup\.exe/, res.stdout);
  assert.strictEqual(
    fs.readFileSync(path.join(DIST(), 'LLM Usage Limit Board-0.1.0-Setup.exe'), 'utf8'),
    'real-from-attempt-3',
    'the accepted artefact must be the one this build wrote',
  );
});

t('N-29 Case 7  builder exit 0 写出 0 字节 Setup.exe → 必须非零退出，不得输出 artefact 行（探针 A2 转正）', () => {
  freshCase();
  const res = run('zero-byte');
  assert.strictEqual(res.status, 1, 'a 0-byte artefact is not an artefact, got ' + res.status);
  assert.ok(!/\[dist\] artefact:/.test(res.stdout), 'an empty file must not be reported as ours: ' + res.stdout);
  assert.match(res.stderr, /no Setup\.exe landed/, res.stderr);
  assert.match(res.stderr, /build failed after 3 attempts/, res.stderr);
});

t('N-29 Case 8  预置陈旧产物（字典序在前）+ builder 首试即落新产物 → 首次尝试即放行、builder 调用 1 次（探针 A1 转正）', () => {
  freshCase();
  // dist/ left over from a previous VERSION: sorts before 0.1.0, so under the
  // old .find()-first-hit gate it masked the fresh artefact behind it
  fs.mkdirSync(DIST(), { recursive: true });
  fs.writeFileSync(path.join(DIST(), 'LLM Usage Limit Board-0.0.9-Setup.exe'), 'STALE-0.0.9-FROM-PREVIOUS-RUN');
  const res = run('fresh-every-time');
  assert.strictEqual(res.status, 0, 'the fresh artefact must be found behind the stale first hit: ' + res.stderr);
  // the stale first hit must not burn a retry: builder invoked exactly once
  assert.strictEqual(JSON.parse(fs.readFileSync(STATE(), 'utf8')).n, 1,
    'attempt 1 must already pass — no clearDist() retry wiping the fresh artefact');
  assert.match(res.stdout, /\[dist\] artefact: .*0\.1\.0-Setup\.exe/, 'the FRESH one must be logged, not the stale hit: ' + res.stdout);
  assert.strictEqual(
    fs.readFileSync(path.join(DIST(), 'LLM Usage Limit Board-0.1.0-Setup.exe'), 'utf8'),
    'fresh-build-1',
    'the accepted artefact must be this build\'s',
  );
  // attempt 1 never clears dist/, so the untouched leftover must survive
  assert.strictEqual(
    fs.readFileSync(path.join(DIST(), 'LLM Usage Limit Board-0.0.9-Setup.exe'), 'utf8'),
    'STALE-0.0.9-FROM-PREVIOUS-RUN',
    'the stale leftover must not be touched on the passing path',
  );
});

try {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
} catch { /* best effort — the pid-named dir is sweepable */ }

console.log('\ndist.test: ' + pass + ' passed, ' + failures.length + ' failed');
if (failures.length) {
  console.log('\nFailed:\n- ' + failures.join('\n- '));
  process.exit(1);
}
