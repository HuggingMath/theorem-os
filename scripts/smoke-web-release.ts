import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { parse } from 'smol-toml';
import { webFormalizationDefaults } from '../apps/web/formalizationTypes';

/** Opt-in paid acceptance against a disposable loopback web instance; never part of the offline test suite. */
const { values } = parseArgs({ options: { 'base-url': { type: 'string' }, 'credential-profile': { type: 'string' },
  output: { type: 'string', default: 'out/web-release-model' }, 'allow-model': { type: 'boolean' } } });
assert.ok(values['allow-model'], 'Pass --allow-model to authorize the bounded real-model acceptance.');
const base = new URL(values['base-url'] ?? 'http://127.0.0.1:8797');
assert.ok(base.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(base.hostname), 'Use a disposable loopback instance.');
const output = path.resolve(values.output!); fs.mkdirSync(output, { recursive: true });
let key = process.env.SUB2API_WESTLAKE_API_KEY ?? '';
if (!key && values['credential-profile']) {
  const profile = parse(fs.readFileSync(path.join(values['credential-profile'], 'config.toml'), 'utf8')) as any;
  assert.equal(profile.model_provider, 'sub2api');
  const provider = profile.model_providers.sub2api;
  if (provider.env_key) key = process.env[provider.env_key] ?? '';
  else {
    const auth = provider.auth;
    assert.ok(auth && path.isAbsolute(auth.command) && Array.isArray(auth.args));
    try { key = execFileSync(auth.command, auth.args, { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
    catch { throw new Error('Release acceptance credential is unavailable.'); }
  }
}
if (!/^[\x21-\x7e]{8,4096}$/u.test(key)) throw new Error('Supply a valid credential through its existing profile or environment.');
let cookie = '', csrf = '', formalizationId = '', runId = '';
const started = Date.now(), stages: Record<string, unknown>[] = [];
const write = (file: string, value: unknown) => fs.writeFileSync(path.join(output, file), JSON.stringify(value, null, 2) + '\n');
async function api(route: string, body?: unknown) {
  const response = await fetch(new URL(route, base), { method: body === undefined ? 'GET' : 'POST',
    headers: { Cookie: cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000), redirect: 'error' });
  const next = response.headers.get('set-cookie'); if (next) cookie = next.split(';')[0];
  if (!response.ok) throw new Error(`Acceptance HTTP ${response.status} at ${route.split('/').slice(0, 3).join('/')}`);
  return response;
}
const budget = webFormalizationDefaults;
try {
  const session = await (await api('/api/session')).json(); csrf = session.csrfToken;
  assert.equal(session.auth, 'none', 'Use disposable data with no production account.');
  assert.equal(session.runtime.ready, true);
  const health = await (await api('/healthz')).json();
  const connection = await (await api('/api/providers/sub2api/check', { apiKey: key, model: 'deepseek-flash' })).json();
  write('connection.json', connection);
  const response = await (await api('/api/formalizations', { original: '对任意自然数 n（包括 0），证明 n + 0 = n。',
    environment: 'standard', providerId: 'sub2api', model: 'deepseek-flash', effort: 'max', apiKey: key, solve: true, ...budget })).json();
  formalizationId = response.formalization.id;
  const deadline = started + (budget.maxRunSeconds + budget.research.maxRunSeconds + 180) * 1000;
  let last = '', formalization: any, run: any;
  while (Date.now() < deadline) {
    formalization = (await (await api(`/api/formalizations/${formalizationId}`)).json()).formalization;
    if (formalization.runId) {
      runId = formalization.runId;
      run = (await (await api(`/api/runs/${runId}`)).json()).run;
    }
    const state = { formalization: formalization.status, phase: formalization.progress?.phase, tokens: formalization.progress?.tokens,
      ...(run ? { proof: run.status, proofPhase: run.phase } : {}) };
    if (JSON.stringify(state) !== last) {
      last = JSON.stringify(state); const stage = { elapsedSeconds: Math.round((Date.now() - started) / 1000), ...state };
      stages.push(stage); console.log(JSON.stringify(stage));
    }
    if (['error', 'cancelled', 'exhausted'].includes(formalization.status) || formalization.researchError || run && ['completed', 'error', 'cancelled'].includes(run.status)) break;
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
  write('formalization.json', formalization); if (run) write('run.json', run);
  write('activity.json', await (await api(`/api/formalizations/${formalizationId}/activity`)).json());
  const accepted = run?.status === 'completed' && run.result?.status === 'evaluated_passed';
  let downloaded = false;
  if (accepted) {
    const kit = await api(`/api/runs/${runId}/verification-kit`), bytes = Buffer.from(await kit.arrayBuffer());
    assert.equal(bytes.subarray(0, 2).toString(), 'PK'); fs.writeFileSync(path.join(output, 'verification-kit.zip'), bytes);
    fs.writeFileSync(path.join(output, 'proof.lean'), run.result.proof); downloaded = true;
  }
  write('report.json', { passed: accepted && downloaded, modelInvoked: true, checkedAt: new Date().toISOString(), commit: health.commit,
    provider: 'sub2api', model: 'deepseek-flash', environment: 'standard', budgets: budget,
    elapsedSeconds: (Date.now() - started) / 1000, formalizationId, runId, stages, downloaded,
    note: 'One bounded first-use problem; not a benchmark or an OpenAI compatibility result.' });
  assert.ok(accepted && downloaded, 'The bounded natural-language acceptance did not reach independent Lean acceptance. See report.json.');
} finally {
  key = '';
  // This test owns these disposable records; cancel any work still active on failure or deadline.
  if (formalizationId) await api(`/api/formalizations/${formalizationId}/cancel`, {}).catch(() => {});
  if (runId) await api(`/api/runs/${runId}/cancel`, {}).catch(() => {});
}
