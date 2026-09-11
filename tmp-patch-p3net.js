// TEMP patch: 七-P3 — network-layer failures must not be reported as "field not found".
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

patch('src/main.js', [
  [
    `function newProbeDiag() {
  return { statuses: [], messages: [] };
}`,
    `function newProbeDiag() {
  // `statuses` only ever holds real HTTP codes; a request that never got a
  // response (timeout / DNS / refused) is recorded in `errors` instead. Mixing
  // a 0 into `statuses` used to break the "all 404" test and make every network
  // failure fall through to "field names don't match" — the exact misdiagnosis
  // this whole mechanism exists to remove (七-P3).
  return { statuses: [], messages: [], errors: [] };
}`,
  ],
  [
    `function explainProbeFailure(diag, provider, mode) {
  const auth = diag.statuses.find((s) => s === 401 || s === 403);
  if (auth) {
    return \`API Key 无效或权限不足（HTTP \${auth}），请检查该订阅的 Key 是否填错/已失效\`;
  }`,
    `function explainProbeFailure(diag, provider, mode) {
  const auth = diag.statuses.find((s) => s === 401 || s === 403);
  if (auth) {
    return \`API Key 无效或权限不足（HTTP \${auth}），请检查该订阅的 Key 是否填错/已失效\`;
  }
  // Nothing ever answered: report the transport problem, not a field mismatch.
  if (diag.statuses.length === 0 && diag.errors.length > 0) {
    const raw = diag.errors[0];
    if (/abort|timeout|timed out/i.test(raw)) {
      return '请求超时（10 秒）：服务商没有在超时时间内响应，请检查 Base URL 是否可达、或服务商是否正忙';
    }
    return \`请求失败（网络层）：\${safeMessage(raw, provider.apiKey)}。请确认 Base URL 可达、且本机网络/代理设置正常\`;
  }`,
  ],
  [
    `  const note = (res) => {
    if (!diag) return;
    diag.statuses.push(res.status || 0);
    const body = res.data;
    const msg = body && typeof body === 'object' ? body.message ?? body.error ?? body.msg : '';
    if (typeof msg === 'string' && msg.trim()) diag.messages.push(safeMessage(msg, provider.apiKey));
  };`,
    `  const note = (res) => {
    if (!diag) return;
    if (res.status) diag.statuses.push(res.status);
    else if (res.error) diag.errors.push(res.error); // no response at all
    const body = res.data;
    const msg = body && typeof body === 'object' ? body.message ?? body.error ?? body.msg : '';
    if (typeof msg === 'string' && msg.trim()) diag.messages.push(safeMessage(msg, provider.apiKey));
  };`,
  ],
  // 七-P7: the fallback branch was unreachable — carry the parsed value out of accept
  [
    `  // Fall back to the same user-info endpoints and look for a balance-like field.
  const data = await fetchOneAPIUserInfo(provider, (res) => Boolean(normalizeBalance(res.data)), diag);
  if (!data) return { ok: false, error: explainProbeFailure(diag, provider, 'balance') };

  const normalized = normalizeBalance(data);
  if (!normalized) return { ok: false, error: '服务商返回中找不到余额字段' };
  return { ok: true, usage: { mode: 'balance', ...normalized } };`,
    `  // Fall back to the same user-info endpoints and look for a balance-like field.
  // accept already guarantees normalizeBalance() succeeded for the winning
  // response, so carry that parsed value out instead of re-parsing (and instead
  // of keeping a "could not find a balance field" branch that can never be
  // reached — 七-P7).
  let viaUserInfo = null;
  const data = await fetchOneAPIUserInfo(provider, (res) => {
    viaUserInfo = normalizeBalance(res.data);
    return viaUserInfo != null;
  }, diag);
  if (!data || !viaUserInfo) return { ok: false, error: explainProbeFailure(diag, provider, 'balance') };
  return { ok: true, usage: { mode: 'balance', ...viaUserInfo } };`,
  ],
]);
