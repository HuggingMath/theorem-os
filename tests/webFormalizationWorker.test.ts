import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { DockerWebRunner, parseFormalizationMessage } from '../apps/web/runner';
import { formalizationStopReason, formalizationWorkerInputSchema, webFormalizationPreparation } from '../apps/web/formalizationWorker';
import { webFormalizationLimits, type WorkerFormalizationInput, type WorkerFormalizationMessage } from '../apps/web/formalizationTypes';
import { readWebConfig } from '../apps/web/config';

const input = (): WorkerFormalizationInput => ({ id: crypto.randomUUID(), original: '对每个自然数 n，证明 n + 0 = n。',
  environment: 'standard', model: 'deepseek-flash', effort: 'max', apiKey: 'sk-private-formalize-fixture',
  provider: readWebConfig({}).providers[0]!, maxRunSeconds: webFormalizationLimits.maxRunSeconds,
  maxTotalTokens: webFormalizationLimits.maxTotalTokens, maxRounds: webFormalizationLimits.maxRounds,
  maxPlanningRounds: webFormalizationLimits.maxPlanningRounds, reviewers: webFormalizationLimits.reviewers });

describe('formalization worker input and protocol', () => {
  it('preserves the original and requires bounded production budgets and supported credentials', () => {
    const request = input();
    expect(formalizationWorkerInputSchema.parse(request)).toEqual(request);
    for (const override of [{ original: ' ' }, { original: '原'.repeat(11_000) }, { apiKey: 'bad\nkey' },
      { model: 'other' }, { reviewers: 1 }, { maxRounds: 0 }, { maxPlanningRounds: 0 }, { maxTotalTokens: 200_000 },
      { maxRunSeconds: webFormalizationLimits.maxRunSeconds + 1 }, { profile: '/private/profile' }])
      expect(formalizationWorkerInputSchema.safeParse({ ...request, ...override }).success).toBe(false);
  });

  it('keeps independent roles, planned fidelity review and exact provenance', () => {
    const request = input(), prepared = webFormalizationPreparation(request, '/private/profile', '/private/manifest.json');
    expect(prepared).toMatchObject({ problemId: request.id, statement: request.original, execution: 'model',
      fidelityPolicy: 'task-preserving-v2', maxTotalTokens: request.maxTotalTokens,
      maxRunSeconds: request.maxRunSeconds, maxRounds: request.maxRounds,
      workflow: { reviewPolicy: 'all-approve', candidateSelection: 'first-unanimously-approved',
        reviewScheduling: 'parallel', maxPlanningRounds: request.maxPlanningRounds } });
    expect(prepared.workflow!.reviewers.map(role => role.id)).toEqual(['reviewer-1', 'reviewer-2']);
    expect(prepared.workflow!.planner).not.toBe(prepared.workflow!.backtranslator);
    expect(JSON.stringify(prepared)).not.toContain(request.apiKey);
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
  it.each(['complete', 'cancel', 'missing-result'] as const)('uses private stdin and removes the container (%s)', async mode => {
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
  if (${JSON.stringify(mode)} === 'complete') process.stdout.write(JSON.stringify({ type: 'result', status: 'exhausted', reason: 'formalization_rounds_exhausted' }) + '\\n');
}
main().catch(() => process.exit(1));
`, { mode: 0o700 });
    vi.stubEnv('PATH', directory);
    try {
      const request = input(), messages: WorkerFormalizationMessage[] = [], controller = new AbortController();
      const operation = new DockerWebRunner(readWebConfig({})).formalize(request, message => {
        messages.push(message);
        if (mode === 'cancel') controller.abort();
      }, controller.signal);
      if (mode === 'complete') await operation;
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
