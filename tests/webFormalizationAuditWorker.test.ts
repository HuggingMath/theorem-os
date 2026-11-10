import type { WorkerFormalizationAuditInput } from '../apps/web/formalizationAuditTypes';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { readWebConfig } from '../apps/web/config';
import { DockerWebRunner, parseFormalizationMessage } from '../apps/web/runner';
import { assertWebFormalizationAuditInput, formalizationAuditWorkerInputSchema, webFormalizationSessionOptions } from '../apps/web/formalizationWorker';
import { resolveMathematicsRuntimeEnvironment } from '../src/math/mathRuntimeEnvironment';
import { SUB2API_PROVIDER } from '../src/runtime/sub2api';
import type { MathAgentOptions } from '../src/runtime/codexSession';
import { webFormalizationLimits, type WorkerFormalizationInput, type WorkerFormalizationAuditInput,
  type WorkerFormalizationAuditMessage } from '../apps/web/formalizationTypes';
import { formalizationAuditFixture } from './helpers/formalizationAuditFixture';
import { webDirectFormalizationEvidence, webFormalizationStatement, webReviewedFormalizationEvidence } from './helpers/webFormalizationFixture';

// Synthetic evidence and a fake Docker executable exercise the boundary; no model, Lean or Docker daemon runs.
function input(): WorkerFormalizationAuditInput {
  const generation: WorkerFormalizationInput = { id: crypto.randomUUID(), original: webFormalizationStatement,
    environment: 'standard', model: 'gpt-6.1-sol', effort: 'max', apiKey: 'sk-private-audit-fixture',
    provider: { id: 'huanling', name: 'Synthetic HTTPS provider', baseUrl: 'https://models.example.test/v1' },
    maxRunSeconds: 0, maxTotalTokens: 0, maxRounds: 0, maxPlanningRounds: 0,
    reviewers: webFormalizationLimits.reviewers, reviewMode: 'direct' };
  return { operation: 'audit', id: generation.id, original: generation.original, environment: generation.environment,
    model: generation.model, effort: generation.effort, apiKey: generation.apiKey, provider: generation.provider,
    maxRunSeconds: 0, maxTotalTokens: 0, evidence: webDirectFormalizationEvidence(generation) };
}

describe('background formalization audit worker contract', () => {
  it.each(['huanling', SUB2API_PROVIDER.id])('injects %s credentials after environment projection for generation and audit', providerId => {
    const credential = 'sk-synthetic-host-only-key';
    const environment = resolveMathematicsRuntimeEnvironment({ PATH: '/usr/bin:/bin',
      THEOREMOS_PROVIDER_API_KEY: credential, [SUB2API_PROVIDER.apiKeyEnvironment]: credential }, '');
    expect(JSON.stringify(environment)).not.toContain(credential);
    const options: MathAgentOptions = { executable: 'codex', profile: '/synthetic/profile', workspace: '/synthetic/workspace',
      model: 'gpt-6.1-sol', effort: 'max', instructions: 'Frozen independent audit.', environment,
      readIsolation: { environment: 'mathlib' }, onUsage() {} };
    const configured = webFormalizationSessionOptions(options, providerId, credential);
    expect(configured.environment![providerId === SUB2API_PROVIDER.id ? SUB2API_PROVIDER.apiKeyEnvironment : 'THEOREMOS_PROVIDER_API_KEY']).toBe(credential);
    expect(configured.readIsolation).toEqual(options.readIsolation);
    expect(configured.instructions).toBe(options.instructions);
    expect(options.environment).toBe(environment); expect(JSON.stringify(environment)).not.toContain(credential);
  });

  it('accepts unlimited defaults and a positive shared remainder below the generation minimum', () => {
    const request = input();
    expect(formalizationAuditWorkerInputSchema.parse(request)).toEqual(request);
    expect(() => assertWebFormalizationAuditInput(request)).not.toThrow();
    for (const maxTotalTokens of [1, 9_999]) {
      const remaining = formalizationAuditWorkerInputSchema.parse({ ...request, maxTotalTokens });
      expect(remaining.maxTotalTokens).toBe(maxTotalTokens);
      expect(() => assertWebFormalizationAuditInput(remaining as WorkerFormalizationAuditInput)).not.toThrow();
    }
    expect(request.maxRunSeconds).toBe(0); expect(request.maxTotalTokens).toBe(0);
  });

  it('rejects generation controls, malformed evidence and private configuration fields', () => {
    const request = input();
    const reviewed = webReviewedFormalizationEvidence({ ...request, maxRounds: 0, maxPlanningRounds: 0,
      reviewers: webFormalizationLimits.reviewers });
    for (const override of [{ operation: 'formalize' }, { maxTotalTokens: -1 }, { maxTotalTokens: .5 },
      { maxTotalTokens: webFormalizationLimits.maxTotalTokens + 1 }, { maxRunSeconds: -1 },
      { maxRounds: 0 }, { reviewers: 2 }, { profile: '/private/profile' }, { apiKey: 'secret\nkey' },
      { evidence: {} }, { evidence: reviewed }])
      expect(formalizationAuditWorkerInputSchema.safeParse({ ...request, ...override }).success).toBe(false);
  });

  it.each([
    ['id', crypto.randomUUID()], ['original', 'An unrelated statement.'], ['environment', 'mathlib'],
    ['model', 'different-model'], ['effort', 'high'],
  ] as const)('binds worker %s to the compiled evidence identity', (field, value) => {
    const mismatched = formalizationAuditWorkerInputSchema.parse({ ...input(), [field]: value }) as WorkerFormalizationAuditInput;
    expect(() => assertWebFormalizationAuditInput(mismatched)).toThrow('formalization_audit_binding_mismatch');
  });

  it('revalidates evidence rather than trusting a schema-valid source mutation', () => {
    const request = input(); request.evidence.candidate.source += '\n';
    const shapeValid = formalizationAuditWorkerInputSchema.parse(request) as WorkerFormalizationAuditInput;
    expect(() => assertWebFormalizationAuditInput(shapeValid)).toThrow();
  });

  it('parses audit progress, a typed opinion and a safe error code', () => {
    const request = input(), result = formalizationAuditFixture(request.evidence);
    for (const message of [{ type: 'audit-progress', tokens: 0 }, { type: 'audit-progress', tokens: 7 },
      { type: 'audit-result', result }, { type: 'audit-error', reason: 'formalization_audit_session_incomplete' }])
      expect(parseFormalizationMessage(JSON.stringify(message))).toEqual(message);
  });

  it('rejects private diagnostic payloads and malformed audit messages', () => {
    const result = formalizationAuditFixture(input().evidence);
    for (const message of [null, { type: 'audit-progress', tokens: -1 }, { type: 'audit-progress', tokens: .5 },
      { type: 'audit-progress', tokens: 7, apiKey: 'private' }, { type: 'audit-progress', tokens: 7, message: 'provider said private' },
      { type: 'audit-result', result: {} }, { type: 'audit-result', result: [] },
      { type: 'audit-result', result, stderr: 'provider said private' },
      { type: 'audit-result', result: { ...result, profile: '/private/profile' } },
      { type: 'audit-result', result: { ...result, session: { ...result.session, apiKey: 'private' } } },
      { type: 'audit-result', result: { ...result, review: { ...result.review, diagnostic: 'private' } } },
      { type: 'audit-error', reason: 'provider said private' },
      { type: 'audit-error', reason: 'formalization_audit_failed: private provider text' },
      { type: 'audit-error', reason: 'formalization_audit_failed', message: 'private provider text' }])
      expect(parseFormalizationMessage(JSON.stringify(message))).toBeUndefined();
    expect(parseFormalizationMessage('private non-JSON provider text')).toBeUndefined();
  });
});

describe('background audit container boundary', () => {
  it.each(['complete', 'error', 'cancel', 'missing-result', 'foreign-terminal'] as const)(
    'uses private stdin, an independent container name and cleanup (%s)', async mode => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'formalization-audit-docker-test-'));
      const request = input(), result = formalizationAuditFixture(request.evidence);
      fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result));
      fs.writeFileSync(path.join(directory, 'docker'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), mode = ${JSON.stringify(mode)};
fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify(args) + '\\n');
async function main() {
  if (args[0] !== 'start') return;
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  const input = JSON.parse(text);
  fs.writeFileSync(path.join(__dirname, 'private-input.json'), text, { mode: 0o600 });
  fs.writeFileSync(path.join(__dirname, 'metadata.json'), JSON.stringify({
    apiKeyInEnvironment: Object.values(process.env).some(value => value.includes(input.apiKey))
  }));
  const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
  send({ type: 'progress', progress: { phase: 'planning', round: 1 } });
  send({ type: 'audit-progress', tokens: 7 });
  send({ type: 'audit-error', reason: 'formalization_audit_failed: private provider text' });
  if (mode === 'cancel') setInterval(() => {}, 1000);
  if (mode === 'complete') send({ type: 'audit-result', result: JSON.parse(fs.readFileSync(path.join(__dirname, 'result.json'), 'utf8')) });
  if (mode === 'error') send({ type: 'audit-error', reason: 'formalization_audit_session_incomplete' });
  if (mode === 'foreign-terminal') send({ type: 'result', status: 'approved', evidence: {} });
}
main().catch(() => process.exit(1));
`, { mode: 0o700 });
      vi.stubEnv('PATH', directory);
      try {
        const messages: WorkerFormalizationAuditMessage[] = [], controller = new AbortController();
        const operation = new DockerWebRunner(readWebConfig({})).auditFormalization(request, message => {
          messages.push(message); if (mode === 'cancel') controller.abort();
        }, controller.signal);
        if (mode === 'complete' || mode === 'error') await operation;
        else await expect(operation).rejects.toThrow(mode === 'cancel' ? 'formalization_cancelled' : 'formalization_worker_exited');
        const calls = fs.readFileSync(path.join(directory, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
        const name = `theoremos-formalize-audit-${request.id}`;
        expect(calls.map(args => args[0])).toEqual(['create', 'start', 'rm']);
        expect(calls[0][calls[0].indexOf('--name') + 1]).toBe(name);
        expect(name).not.toBe(`theoremos-formalize-${request.id}`);
        expect(calls[0].slice(-2)).toEqual(['standard', 'formalize']);
        for (const argument of ['--log-driver=none', '--read-only', '--cap-drop=ALL', '--interactive']) expect(calls[0]).toContain(argument);
        expect(calls[1]).toEqual(['start', '--attach', '--interactive', name]);
        expect(calls[2]).toEqual(['rm', '--force', '--volumes', name]);
        expect(JSON.parse(fs.readFileSync(path.join(directory, 'private-input.json'), 'utf8'))).toEqual(request);
        const metadata = JSON.parse(fs.readFileSync(path.join(directory, 'metadata.json'), 'utf8'));
        expect(metadata).toEqual({ apiKeyInEnvironment: false });
        expect(messages).toEqual([{ type: 'audit-progress', tokens: 7 },
          ...(mode === 'complete' ? [{ type: 'audit-result', result }]
            : mode === 'error' ? [{ type: 'audit-error', reason: 'formalization_audit_session_incomplete' }] : [])]);
        expect(JSON.stringify({ calls, metadata, messages })).not.toContain(request.apiKey);
        expect(JSON.stringify(messages)).not.toContain('private provider text');
      } finally {
        vi.unstubAllEnvs(); fs.rmSync(directory, { recursive: true, force: true });
      }
    });
});
