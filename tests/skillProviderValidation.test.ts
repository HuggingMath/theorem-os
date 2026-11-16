import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCodexMathSession, type MathAgentOptions } from '../src/runtime/codexSession';
import type { ModelRequestAdmission, ModelRequestGate } from '../src/runtime/modelRequest';
import { validateSkillProvider } from '../scripts/mathematics/validateSkillProvider';

vi.mock('../src/runtime/codexSession', () => ({ createCodexMathSession: vi.fn() }));

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.mocked(createCodexMathSession).mockReset();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function reported(admission: ModelRequestAdmission, tokens: number) {
  expect(admission.allowed).toBe(true);
  if (!admission.allowed) throw new Error('Fixture request admission rejected.');
  admission.settle({ complete: true, outcome: 'completed',
    usage: { inputTokens: tokens - 1, outputTokens: 1, totalTokens: tokens } });
}

async function exercise(run: (gate: ModelRequestGate) => void, flags: string[] = []) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skill-provider-budget-'))); roots.push(root);
  fs.mkdirSync(path.join(root, 'profile'));
  vi.mocked(createCodexMathSession).mockImplementation(async (options: MathAgentOptions) => ({
    threadId: 'budget-test-no-provider',
    run: async () => { run(options.requestGate!); return 'failed'; },
    interrupt: async () => {}, close: async () => {},
  }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await validateSkillProvider(['--directory', path.join(root, 'evidence'), '--profile', path.join(root, 'profile'),
    '--loading', 'native', ...flags])).toBe(1);
  return JSON.parse(fs.readFileSync(path.join(root, 'evidence/report.json'), 'utf8'));
}

describe('bounded provider capability validation without a provider', () => {
  it('executes both generated readback commands against frozen files and keeps each resumed thread', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skill-provider-commands-'))); roots.push(root);
    fs.mkdirSync(path.join(root, 'profile'));
    const compact = vi.fn(async () => {}), stop = vi.fn(async () => ({ status: 'stopped' as const }));
    vi.mocked(createCodexMathSession).mockImplementation(async (options: MathAgentOptions) => ({
      threadId: options.threadId ?? 'command-fixture-' + path.basename(path.dirname(options.workspace)),
      compact, stopForFreeze: stop, interrupt: async () => {}, close: async () => {},
      run: async (message, turnId) => {
        reported(options.requestGate!({ requestId: turnId }), 1000);
        const command = message.slice(message.indexOf("/usr/bin/python3 - <<'PY'\n"));
        expect(command.startsWith("/usr/bin/python3 - <<'PY'\n")).toBe(true);
        const execution = spawnSync('/bin/bash', ['-c', command], { cwd: options.workspace, encoding: 'utf8' });
        expect(execution.status, execution.stderr).toBe(0);
        options.onItem!('completed', { type: 'commandExecution', command,
          exitCode: execution.status, aggregatedOutput: execution.stdout }, { turnId });
        return 'completed';
      },
    }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const exit = await validateSkillProvider(['--directory', path.join(root, 'evidence'), '--profile', path.join(root, 'profile'),
      '--loading', 'both', '--compact']);
    const report = JSON.parse(fs.readFileSync(path.join(root, 'evidence/report.json'), 'utf8'));
    expect(exit, JSON.stringify(report.results)).toBe(0);
    expect(report.passed).toBe(true); expect(report.accounting.requests).toBe(4);
    expect(report.actualToolEvidence).toHaveLength(4);
    expect(report.results.map(item => item.threadId)).toEqual(['command-fixture-native', 'command-fixture-file']);
    expect(report.results.every(item => item.initial.tag === item.resumed.previousTag)).toBe(true);
    expect(compact).toHaveBeenCalledTimes(2); expect(stop).toHaveBeenCalledTimes(4);
  });

  it('stops the observed 61,490-token trajectory before its last in-flight request', async () => {
    let rejected: ModelRequestAdmission | undefined;
    const report = await exercise(gate => {
      for (const [index, tokens] of [5956, 7240, 7357, 7751, 8124, 8222, 8497, 8343].entries()) {
        const admission = gate({ requestId: 'observed-' + (index + 1) });
        if (!admission.allowed) { rejected = admission; break; }
        reported(admission, tokens);
      }
    });
    expect(rejected).toEqual({ allowed: false, reason: 'math_total_token_limit' });
    expect(report.accounting).toMatchObject({ requests: 7, knownTokens: 53147, reservedTokens: 0,
      overrunTokens: 0, largestObservedRequestTokens: 8497, usageIncomplete: false });
    expect(report.accounting.usage[0]).toMatchObject({ requestId: 'observed-1', loading: 'native', phase: 'initial' });
    expect(report.limits.inFlightTokensHardCapped).toBe(false);
  });

  it('rejects future admission immediately when an upstream receipt has unknown usage', async () => {
    const report = await exercise(gate => {
      const admission = gate({ requestId: 'missing-usage' });
      expect(admission.allowed).toBe(true);
      if (!admission.allowed) return;
      admission.settle({ complete: false, missingReason: 'provider-usage-missing', outcome: 'completed' });
      expect(gate()).toEqual({ allowed: false, reason: 'math_model_usage_unavailable' });
    });
    expect(report.accounting).toMatchObject({ requests: 1, knownTokens: 0, reservedTokens: 0, usageIncomplete: true });
    expect(report.passed).toBe(false);
  });

  it('reserves outstanding requests and settles each receipt once', async () => {
    const report = await exercise(gate => {
      const first = gate(), second = gate();
      expect(gate()).toEqual({ allowed: false, reason: 'math_total_token_limit' });
      reported(first, 6000); reported(first, 6000);
      expect(gate()).toEqual({ allowed: false, reason: 'math_total_token_limit' });
      reported(second, 6000);
      reported(gate(), 6000);
    }, ['--max-total-tokens', '25000']);
    expect(report.accounting).toMatchObject({ requests: 3, knownTokens: 18000, reservedTokens: 0, overrunTokens: 0 });
    expect(report.accounting.usage).toHaveLength(3);
  });
});
