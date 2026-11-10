import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { DockerWebRunner, parseFormalizationMessage } from '../apps/web/runner';
import { formalizationStopReason, formalizationWorkerInputSchema, webFormalizationPreparation } from '../apps/web/formalizationWorker';
import { webFormalizationLimits, type WorkerFormalizationInput, type WorkerFormalizationMessage } from '../apps/web/formalizationTypes';
import { readWebConfig } from '../apps/web/config';
import { LEAN_STATEMENT_CONTEXT_PROTOCOL } from '../src/math/leanStatementSemantic';
import { parse as parseToml } from 'smol-toml';
import { prepareWebProviderProfile } from '../apps/web/worker';

const input = (): WorkerFormalizationInput => ({ id: crypto.randomUUID(), original: '对每个自然数 n，证明 n + 0 = n。',
  environment: 'standard', model: 'deepseek-flash', effort: 'max', apiKey: 'sk-private-formalize-fixture',
  provider: readWebConfig({}).providers[0]!, maxRunSeconds: webFormalizationLimits.maxRunSeconds,
  maxTotalTokens: webFormalizationLimits.maxTotalTokens, maxRounds: webFormalizationLimits.maxRounds,
  maxPlanningRounds: webFormalizationLimits.maxPlanningRounds, reviewers: webFormalizationLimits.reviewers });

describe('formalization worker input and protocol', () => {
  it('preserves the original, accepts unlimited budgets and validates explicit limits and credentials', () => {
    const request = input();
    expect(formalizationWorkerInputSchema.parse(request)).toEqual(request);
    const unlimitedBudgets = { maxRunSeconds: 0, maxTotalTokens: 0, maxRounds: 0, maxPlanningRounds: 0 };
    expect(formalizationWorkerInputSchema.parse({ ...request, ...unlimitedBudgets })).toEqual({ ...request, ...unlimitedBudgets });
    const { maxRunSeconds: _seconds, maxTotalTokens: _tokens, maxRounds: _rounds, maxPlanningRounds: _planning, ...withoutBudgets } = request;
    expect(formalizationWorkerInputSchema.parse(withoutBudgets)).toEqual({ ...request, ...unlimitedBudgets });
    for (const override of [{ original: ' ' }, { original: '原'.repeat(11_000) }, { apiKey: 'bad\nkey' },
      { model: 'other' }, { reviewers: 1 }, { maxRounds: -1 }, { maxPlanningRounds: -1 }, { maxTotalTokens: 9_999 },
      { maxRunSeconds: -1 }, { maxTotalTokens: -1 }, { maxRounds: 1.5 }, { maxPlanningRounds: 1.5 },
      { maxRounds: webFormalizationLimits.maxRounds + 1 }, { maxPlanningRounds: webFormalizationLimits.maxPlanningRounds + 1 },
      { maxTotalTokens: webFormalizationLimits.maxTotalTokens + 1 },
      { maxRunSeconds: webFormalizationLimits.maxRunSeconds + 1 }, { profile: '/private/profile' }])
      expect(formalizationWorkerInputSchema.safeParse({ ...request, ...override }).success).toBe(false);
    const unlimited = { ...request, maxRounds: 0, maxPlanningRounds: 0, maxRunSeconds: 0, maxTotalTokens: 0 };
    expect(formalizationWorkerInputSchema.parse(unlimited)).toEqual(unlimited);
    expect(webFormalizationPreparation(unlimited, '/private/profile', '/private/manifest.json'))
      .toMatchObject({ maxRounds: 0, maxRunSeconds: 0, maxTurnSeconds: 0, maxCompileSeconds: 0, maxTotalTokens: 0,
        contextProtocol: LEAN_STATEMENT_CONTEXT_PROTOCOL, workflow: { maxPlanningRounds: 0 } });
    expect(formalizationWorkerInputSchema.parse({ ...unlimited, contextProtocol: LEAN_STATEMENT_CONTEXT_PROTOCOL }))
      .toMatchObject({ contextProtocol: LEAN_STATEMENT_CONTEXT_PROTOCOL });
    expect(formalizationWorkerInputSchema.safeParse({ ...unlimited, contextProtocol: 'kernel-v1' }).success).toBe(false);
  });

  it('preserves a configured HTTPS provider, model and reduced token budget through every independent role', () => {
    const request = { ...input(), model: 'custom-reasoner', effort: 'high' as const, maxTotalTokens: 200_000,
      provider: { id: 'compatible', name: 'Own provider', baseUrl: 'https://models.example.test/v1' } };
    expect(formalizationWorkerInputSchema.parse(request)).toEqual(request);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'formalization-provider-profile-')), profile = path.join(directory, 'profile');
    try {
      prepareWebProviderProfile(profile, { provider: request.provider, input: request });
      const config = parseToml(fs.readFileSync(path.join(profile, 'config.toml'), 'utf8'));
      expect(config).toMatchObject({ model: request.model, model_reasoning_effort: 'high', model_provider: 'web_provider',
        model_providers: { web_provider: { base_url: request.provider.baseUrl, wire_api: 'responses', env_key: 'THEOREMOS_PROVIDER_API_KEY' } } });
      expect(config.model_catalog_json).toBeUndefined(); expect(JSON.stringify(config)).not.toContain(request.apiKey);
      const prepared = webFormalizationPreparation(request, profile, '/private/manifest.json');
      expect(prepared).toMatchObject({ model: request.model, effort: 'high', maxTotalTokens: 200_000 });
      for (const role of [prepared.workflow!.planner, prepared.workflow!.backtranslator, ...prepared.workflow!.reviewers])
        expect(role).toMatchObject({ model: request.model, effort: 'high', profile });
      expect(JSON.stringify(prepared)).not.toContain(request.apiKey);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it.each(['http://models.example.test/v1', 'https://user:password@models.example.test/v1',
    'https://models.example.test/v1?key=private', 'https://models.example.test/v1#fragment', 'not-a-url'])
    ('rejects an invalid BYOK endpoint through schema validation: %s', baseUrl => {
      expect(formalizationWorkerInputSchema.safeParse({ ...input(), model: 'custom-reasoner',
        provider: { id: 'compatible', name: 'Fixture', baseUrl } }).success).toBe(false);
    });

  it('keeps the independent review workflow on legacy inputs without a direct mode', () => {
    const request = input(), prepared = webFormalizationPreparation(request, '/private/profile', '/private/manifest.json');
    expect(prepared).toMatchObject({ problemId: request.id, statement: request.original, execution: 'model',
      fidelityPolicy: 'task-preserving-v2', contextProtocol: LEAN_STATEMENT_CONTEXT_PROTOCOL, maxTotalTokens: request.maxTotalTokens,
      maxRunSeconds: request.maxRunSeconds, maxRounds: request.maxRounds,
      workflow: { reviewPolicy: 'all-approve', candidateSelection: 'first-unanimously-approved',
        reviewScheduling: 'parallel', maxPlanningRounds: request.maxPlanningRounds } });
    expect(prepared.workflow!.reviewers.map(role => role.id)).toEqual(['reviewer-1', 'reviewer-2']);
    expect(prepared.workflow!.planner).not.toBe(prepared.workflow!.backtranslator);
    expect(JSON.stringify(prepared)).not.toContain(request.apiKey);
  });

  it('prepares new direct inputs with generation and compilation only and unlimited budgets', () => {
    const request = { ...input(), reviewMode: 'direct' as const, maxRunSeconds: 0, maxTotalTokens: 0,
      maxRounds: 0, maxPlanningRounds: 0 };
    expect(formalizationWorkerInputSchema.parse(request)).toEqual(request);
    const prepared = webFormalizationPreparation(request, '/private/profile', '/private/manifest.json');
    expect(prepared).toMatchObject({ problemId: request.id, statement: request.original, model: request.model,
      effort: request.effort, reviewMode: 'direct', execution: 'model', contextProtocol: LEAN_STATEMENT_CONTEXT_PROTOCOL,
      maxRunSeconds: 0, maxTotalTokens: 0, maxTurnSeconds: 0, maxCompileSeconds: 0, maxRounds: 0 });
    expect(prepared).not.toHaveProperty('workflow'); expect(prepared).not.toHaveProperty('fidelityPolicy');
    expect(JSON.stringify(prepared)).not.toContain(request.apiKey);
    expect(formalizationWorkerInputSchema.safeParse({ ...request, reviewMode: 'unchecked' }).success).toBe(false);
  });

  it('passes unlimited execution, generation and planning budgets to the core formalizer', () => {
    const prepared = webFormalizationPreparation({ ...input(), maxRunSeconds: 0, maxTotalTokens: 0,
      maxRounds: 0, maxPlanningRounds: 0 }, '/private/profile', '/private/manifest.json');
    expect(prepared).toMatchObject({ maxRunSeconds: 0, maxTotalTokens: 0, maxRounds: 0,
      maxTurnSeconds: 0, maxCompileSeconds: 0, workflow: { maxPlanningRounds: 0 } });
  });

  it('accepts phase updates and evidence objects while excluding private diagnostics', () => {
    const message = { type: 'progress', progress: { phase: 'reviewing', round: 2, tokens: 123 } };
    expect(parseFormalizationMessage(JSON.stringify(message))).toEqual(message);
    expect(parseFormalizationMessage('{"type":"result","status":"approved","evidence":{}}'))
      .toEqual({ type: 'result', status: 'approved', evidence: {} });
    for (const message of [null, { type: 'progress', progress: { phase: 'reviewing', apiKey: 'secret' } },
      { type: 'progress', progress: { phase: 'finished' } }, { type: 'progress', progress: { phase: 'compiling', round: -1 } },
      { type: 'result', status: 'approved', evidence: [] }, { type: 'result', status: 'error', reason: 'provider said secret' },
      { type: 'result', status: 'confirmed', evidence: {} }])
      expect(parseFormalizationMessage(JSON.stringify(message))).toBeUndefined();
  });

  it('reports exhaustion and reason codes without diagnostic payloads', () => {
    expect(formalizationStopReason('exhausted', 'formalization_review_rejected: private text', false))
      .toEqual({ status: 'exhausted', reason: 'formalization_rounds_exhausted' });
    expect(formalizationStopReason('stopped', 'math_total_token_limit: private', false))
      .toEqual({ status: 'exhausted', reason: 'formalization_token_limit' });
    expect(formalizationStopReason('stopped', 'This operation was aborted', true))
      .toEqual({ status: 'exhausted', reason: 'formalization_time_limit' });
    expect(formalizationStopReason('stopped', 'formalization_sandbox_canary_failed: private', false))
      .toEqual({ status: 'error', reason: 'formalization_sandbox_canary_failed' });
    expect(formalizationStopReason('stopped', 'provider said secret', false))
      .toEqual({ status: 'error', reason: 'formalization_failed' });
  });
});

describe('formalization container boundary', () => {
  it.each([0, 1])('honors an unlimited or finite host watchdog and remains cancellable (seconds=%s)', async maxRunSeconds => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'formalization-watchdog-test-'));
    fs.writeFileSync(path.join(directory, 'docker'), `#!${process.execPath}
const args = process.argv.slice(2);
async function main() {
  if (args[0] !== 'start') return;
  for await (const _chunk of process.stdin) {}
  process.stdout.write(JSON.stringify({ type: 'progress', progress: { phase: 'generating' } }) + '\\n');
  setInterval(() => {}, 1000);
}
main().catch(() => process.exit(1));
`, { mode: 0o700 });
    vi.stubEnv('PATH', directory);
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const controller = new AbortController();
    let operation: Promise<void> | undefined;
    try {
      let generating!: () => void, ended = false;
      const ready = new Promise<void>(resolve => { generating = resolve; });
      operation = new DockerWebRunner(readWebConfig({})).formalize({ ...input(), maxRunSeconds }, message => {
        if (message.type === 'progress') generating();
      }, controller.signal);
      const result = operation.then(() => { ended = true; return ''; }, error => { ended = true; return error.message; });
      await Promise.race([ready, result.then(reason => { throw new Error(reason || 'fixture_stopped_before_generation'); })]);
      await vi.advanceTimersByTimeAsync(3_600_000);
      if (maxRunSeconds === 0) {
        expect(ended).toBe(false);
        controller.abort();
        expect(await result).toBe('formalization_cancelled');
      } else expect(await result).toBe('formalization_timeout');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      controller.abort(); await operation?.catch(() => {});
      vi.useRealTimers(); vi.unstubAllEnvs(); fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(['complete', 'https-complete', 'cancel', 'missing-result'] as const)('uses private stdin and removes the container (%s)', async mode => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'formalization-docker-test-'));
    fs.writeFileSync(path.join(directory, 'docker'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify(args) + '\\n');
async function main() {
  if (args[0] !== 'start') return;
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  const request = JSON.parse(text);
  fs.writeFileSync(path.join(__dirname, 'private-input.json'), text, { mode: 0o600 });
  fs.writeFileSync(path.join(__dirname, 'metadata.json'), JSON.stringify({ leaked: Object.values(process.env).some(value => value.includes(request.apiKey)) }));
  process.stdout.write(JSON.stringify({ type: 'progress', progress: { phase: 'planning', round: 1 } }) + '\\n');
  if (${JSON.stringify(mode)} === 'cancel') setInterval(() => {}, 1000);
  if (${JSON.stringify(mode)}.endsWith('complete')) process.stdout.write(JSON.stringify({ type: 'result', status: 'exhausted', reason: 'formalization_rounds_exhausted' }) + '\\n');
}
main().catch(() => process.exit(1));
`, { mode: 0o700 });
    vi.stubEnv('PATH', directory);
    try {
      const request = input(), messages: WorkerFormalizationMessage[] = [], controller = new AbortController();
      if (mode === 'https-complete') Object.assign(request, { model: 'custom-reasoner', maxTotalTokens: 200_000,
        provider: { id: 'compatible', name: 'Fixture', baseUrl: 'https://models.example.test/v1' } });
      const operation = new DockerWebRunner(readWebConfig({})).formalize(request, message => {
        messages.push(message);
        if (mode === 'cancel') controller.abort();
      }, controller.signal);
      if (mode.endsWith('complete')) await operation;
      else await expect(operation).rejects.toThrow(mode === 'cancel' ? 'formalization_cancelled' : 'formalization_worker_exited');
      const calls = fs.readFileSync(path.join(directory, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(calls.map(args => args[0])).toEqual(['create', 'start', 'rm']);
      expect(calls[0].slice(-2)).toEqual(['standard', 'formalize']);
      expect(calls[0]).toContain('--log-driver=none');
      expect(calls[0]).toContain('--read-only');
      expect(calls[0]).toContain('--cap-drop=ALL');
      expect(calls[2]).toEqual(['rm', '--force', '--volumes', `theoremos-formalize-${request.id}`]);
      expect(JSON.parse(fs.readFileSync(path.join(directory, 'private-input.json'), 'utf8'))).toEqual(request);
      expect(JSON.parse(fs.readFileSync(path.join(directory, 'metadata.json'), 'utf8'))).toEqual({ leaked: false });
      expect(JSON.stringify({ calls, messages })).not.toContain(request.apiKey);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
