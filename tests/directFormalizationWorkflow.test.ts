import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formalizationCandidateSchema, prepareFormalization, readFormalizationArtifact } from '../src/math/formalization';
import { readMathText } from '../src/math/mathRuntimeIo';
import type { MathAgentOptions, MathAgentSession } from '../src/runtime/codexSession';
import type { ModelRequestReceipt } from '../src/runtime/modelRequest';
import { readFormalizationState, runFormalization } from '../src/solver/formalization';
import { buildFixture, candidateFixture, fixtureStatement, syntheticElaboration } from './helpers/formalizationFixture';

const temporary: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
function fixture(candidates: ReturnType<typeof candidateFixture>[] = [], requestOverrides: Record<string, unknown> = {}) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'direct-formalization-workflow-')));
  temporary.push(parent);
  const { root, manifest } = buildFixture(parent), directory = path.join(parent, 'run');
  const request = prepareFormalization(directory, { problemId: 'direct_identity', statement: fixtureStatement,
    environment: 'standard', execution: 'replay', model: 'preset-direct', effort: 'none',
    profile: '/no-provider', executable: '/no-model', reviewMode: 'direct', buildManifestRef: manifest,
    maxRounds: 0, maxRunSeconds: 0, maxTurnSeconds: 0, maxCompileSeconds: 0, maxTotalTokens: 0, ...requestOverrides });
  const seen: { input: any; message: string; instructions: string }[] = [];
  const openSession = async (options: MathAgentOptions): Promise<MathAgentSession> => ({
    threadId: 'direct-generator-' + (seen.length + 1), close: async () => {}, interrupt: async () => {},
    run: async (message, _id, workspace, started) => {
      expect(path.basename(workspace)).toBe('generate');
      if (request.maxRunSeconds === 0) expect(options.turnTimeoutMs).toBeUndefined();
      else { expect(options.turnTimeoutMs).toBeGreaterThan(0); expect(options.turnTimeoutMs).toBeLessThanOrEqual(request.maxRunSeconds * 1000); }
      const input = JSON.parse(readMathText(path.join(workspace, 'INPUT.json')));
      seen.push({ input, message, instructions: options.instructions });
      started('direct-turn-' + seen.length); options.onUsage({ totalTokens: 1 });
      fs.writeFileSync(path.join(workspace, 'OUTPUT.json'), JSON.stringify(candidates[input.round - 1] ?? candidateFixture(input.statement)));
      return 'completed';
    },
  });
  return { root, directory, seen, openSession };
}

const completeRequest: ModelRequestReceipt = { complete: true, outcome: 'completed',
  usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 } };

/** Exercise provider admission/settlement and submission without a transport or model. */
function withProviderRequests(agent: ReturnType<typeof fixture>, options: {
  receipts?: readonly ModelRequestReceipt[]; batchSize?: number; requireReminder?: boolean;
  outputBeforeSettlement?: boolean; beforeSettlement?: () => void;
} = {}) {
  const receipts = options.receipts ?? Array.from({ length: 3 }, () => completeRequest), batchSize = options.batchSize ?? 1;
  const notices: { round: number; message: string; reported: number; pending: number; waitForRequest: boolean | undefined }[] = [];
  const checkpoints: { round: number; settled: number; notices: number }[] = [];
  const interrupted: number[] = [], denied: string[] = [];
  const openSession = async (config: MathAgentOptions): Promise<MathAgentSession> => {
    const base = await agent.openSession(config), input = JSON.parse(readMathText(path.join(config.workspace, 'INPUT.json')));
    let reported = 0, pending = 0, noticeCount = 0;
    return { ...base, usageSource: 'upstream-requests',
      notify: async (message, notifyOptions) => {
        noticeCount++; notices.push({ round: input.round, message, reported, pending, waitForRequest: notifyOptions?.waitForRequest });
      },
      interrupt: async () => { interrupted.push(input.round); await base.interrupt(); },
      run: (message, id, workspace, started) => base.run(message, id, workspace, turnId => {
        started(turnId);
        for (let start = 0; start < receipts.length; start += batchSize) {
          const admissions = receipts.slice(start, start + batchSize).map((receipt, index) => {
            const admission = config.requestGate!({ requestId: input.round + '-' + (start + index), source: 'responses-relay' });
            if (!admission.allowed) { denied.push(admission.reason); throw new Error(admission.reason); }
            pending++; return { receipt, admission };
          });
          if (options.outputBeforeSettlement)
            fs.writeFileSync(path.join(workspace, 'OUTPUT.json'), JSON.stringify(candidateFixture(input.statement)));
          options.beforeSettlement?.();
          for (const [index, { receipt, admission }] of admissions.entries()) {
            pending--; if (receipt.complete) reported++;
            admission.settle(receipt);
            checkpoints.push({ round: input.round, settled: start + index + 1, notices: noticeCount });
          }
        }
        // This simulated generator submits only after receiving the host's reminder.
        if (options.requireReminder) expect(noticeCount).toBe(1);
      }),
    };
  };
  return { openSession, notices, checkpoints, interrupted, denied };
}

// Isolated scheduling and evidence tests use synthetic compiler receipts; no model or Lean process runs here.
describe('direct formalization workflow', () => {
  it('uses one generation and compilation, preserves the original, and restores without adding reviews', async () => {
    const f = fixture(); let compilations = 0;
    const options = { openSession: f.openSession, elaborate: async (_directory, source, environment, limits) => {
      compilations++; expect(limits.timeoutMs).toBe(0);
      return syntheticElaboration(source, environment, limits);
    } } satisfies NonNullable<Parameters<typeof runFormalization>[2]>;
    const result = await runFormalization(f.directory, f.root, options);
    expect(result).toMatchObject({ status: 'approved', rounds: 1, candidatesTried: 1, roleTurns: { generate: 1 } });
    expect(f.seen).toHaveLength(1); expect(compilations).toBe(1);
    expect(f.seen[0].input.statement).toBe(fixtureStatement);
    expect(f.seen[0].message).toContain('BEGIN INPUT.json');
    expect(f.seen[0].instructions).toContain('No separate planning document, backtranslation or reviewer report is needed.');
    expect(f.seen[0].instructions).toContain('Structure and inductive declarations, custom notation and metaprogramming are unsupported');
    expect(f.seen[0].instructions).toContain('necessity and sufficiency belong to one iff target');
    expect(f.seen[0].instructions).toContain('they do not require additional formalization targets');
    expect(f.seen[0].instructions).toContain('/usr/bin/python3 /opt/formalization/library-api.py');
    const evidence = readFormalizationArtifact(path.join(f.directory, 'artifact'));
    expect(evidence).toMatchObject({ authority: 'compiler', semanticReview: 'not-performed', proofVerified: false });
    expect(evidence.sessions.map(session => session.role)).toEqual(['generate']);
    expect(evidence).not.toHaveProperty('translation'); expect(evidence).not.toHaveProperty('review');
    expect(readMathText(path.join(f.directory, 'task.md'))).toContain('Original problem (verbatim):\n\n' + fixtureStatement);
    expect(await runFormalization(f.directory, f.root, options)).toMatchObject({ status: 'approved' });
    expect(f.seen).toHaveLength(1); expect(compilations).toBe(1);
  });

  it('repairs compiler feedback using generation only and retains the failed attempt', async () => {
    const f = fixture(); let compilations = 0;
    const result = await runFormalization(f.directory, f.root, { openSession: f.openSession,
      elaborate: async (_directory, source, environment, limits) => {
        if (++compilations === 1) throw new Error('formalization_elaboration_failed: unknown constant in statement');
        return syntheticElaboration(source, environment, limits);
      } });
    expect(result).toMatchObject({ status: 'approved', rounds: 2, candidatesTried: 2, roleTurns: { generate: 2 } });
    expect(f.seen[1].input.feedback).toContain('unknown constant in statement');
    expect(f.seen[1].input.previousCandidate.source).toBe(candidateFixture().source);
    expect(readFormalizationState(f.directory).sessions.map(session => session.role)).toEqual(['generate', 'generate']);
    const evidence = readFormalizationArtifact(path.join(f.directory, 'artifact'));
    expect(evidence.round).toBe(2); expect(evidence.sessions).toHaveLength(1);
  });

  it('repairs an unsupported structure from its original candidate before invoking the host compiler', async () => {
    const unsupported = formalizationCandidateSchema.parse({ ...candidateFixture(),
      source: 'structure RadicalTower where\n  level : Nat\n\n' + candidateFixture().source });
    const f = fixture([unsupported]); let compilations = 0;
    const result = await runFormalization(f.directory, f.root, { openSession: f.openSession,
      elaborate: async (_directory, source, environment, limits) => {
        compilations++; expect(source).toBe(candidateFixture().source); expect(limits.timeoutMs).toBe(0);
        return syntheticElaboration(source, environment, limits);
      } });
    expect(result).toMatchObject({ status: 'approved', rounds: 2, candidatesTried: 2, roleTurns: { generate: 2 } });
    expect(compilations).toBe(1); expect(f.seen).toHaveLength(2);
    expect(f.seen[1].input.previousCandidate).toEqual(unsupported);
    expect(f.seen[1].input.feedback).toContain('formalization_unsupported_declaration');
    expect(f.seen[1].input.feedback).toContain('ordinary named def/abbrev/instance/theorem/lemma');
    expect(f.seen[1].input.feedback).toContain('Replace structure or inductive declarations with ordinary predicates or existential quantifiers');
    expect(readFormalizationState(f.directory).sessions.map(session => session.role)).toEqual(['generate', 'generate']);
    const evidence = readFormalizationArtifact(path.join(f.directory, 'artifact'));
    expect(evidence.round).toBe(2); expect(evidence.candidate.source).toBe(candidateFixture().source);
    expect(evidence.sessions).toHaveLength(1);
  });

  it.each([
    ['ordinary source', ''],
    ['source containing reserved stop markers',
      ' formalization_build_changed formalization_plan_task_kind_unsupported formalization_role_incomplete:failed:unauthorized'],
  ])('repairs an inexact coverage quote before compiling unchanged Lean source (%s)', async (_caseName, suffix) => {
    const statement = 'For every natural number n ({n} ⊆ ℕ), prove n + 0 = n.' + suffix;
    const repaired = candidateFixture(statement), invalid = { ...repaired,
      coverage: [{ ...repaired.coverage[0], originalText: statement.replace('⊆', '⊔') }] };
    const f = fixture([invalid, repaired], { statement, maxRounds: 2 }); let compilations = 0;
    const result = await runFormalization(f.directory, f.root, { openSession: f.openSession,
      elaborate: async (_directory, source, environment, limits) => {
        compilations++; expect(f.seen).toHaveLength(2); expect(source).toBe(repaired.source);
        return syntheticElaboration(source, environment, limits);
      } });
    expect(result).toMatchObject({ status: 'approved', rounds: 2, candidatesTried: 2, roleTurns: { generate: 2 } });
    expect(compilations).toBe(1); expect(f.seen).toHaveLength(2);
    const repairInput = f.seen[1].input;
    expect(repairInput.statement).toBe(statement);
    expect(repairInput.feedback).toContain('formalization_coverage_invalid');
    expect(repairInput.feedback).toContain('coverage[0].originalText');
    expect(repairInput.feedback).toContain('{n} ⊆ ℕ');
    expect(repairInput.feedback).toContain('{n} ⊔ ℕ');
    expect(repairInput.previousCandidate).toEqual(invalid);
    const evidence = readFormalizationArtifact(path.join(f.directory, 'artifact'));
    expect(evidence.round).toBe(2); expect(evidence.candidate).toEqual(repaired);
  });

  it.each([0, 60])('reminds direct generation once and submits for compilation with maxRunSeconds=%s', async maxRunSeconds => {
    const f = fixture([], { maxRunSeconds }), provider = withProviderRequests(f, { requireReminder: true });
    let compilations = 0;
    const result = await runFormalization(f.directory, f.root, { openSession: provider.openSession,
      elaborate: async (_directory, source, environment, limits) => {
        compilations++; expect(source).toBe(candidateFixture().source);
        return syntheticElaboration(source, environment, limits);
      } });
    expect(result).toMatchObject({ status: 'approved', rounds: 1, candidatesTried: 1, roleTurns: { generate: 1 } });
    expect(compilations).toBe(1); expect(provider.notices).toHaveLength(1);
    expect(provider.notices[0]).toMatchObject({ round: 1, reported: 1, pending: 0, waitForRequest: true });
    expect(provider.checkpoints.map(item => item.notices)).toEqual([1, 1, 1]);
    const reminder = provider.notices[0].message;
    expect(reminder).toContain('Preserve every required domain, quantifier, hypothesis, conclusion and definition');
    expect(reminder).toContain('The host compiles your submission and returns diagnostics for repair');
    expect(reminder).toContain('Do not guess missing semantics, truncate the statement or weaken it');
    for (const message of [f.seen[0].message, reminder]) {
      if (maxRunSeconds) {
        const countdown = message.match(/has (\d+) seconds remaining/u);
        expect(countdown).not.toBeNull(); expect(Number(countdown![1])).toBeGreaterThan(0);
        expect(Number(countdown![1])).toBeLessThanOrEqual(maxRunSeconds);
        expect(message).toContain('generation, host Lean compilation and any required repairs');
        expect(message).not.toContain('backtranslation and independent review');
      } else expect(message).not.toMatch(/seconds remaining|Infinity|NaN/u);
    }
    expect(provider.denied).toEqual([]); expect(provider.interrupted).toEqual([]);
    expect(readFormalizationState(f.directory).sessions[0].requestUsageAccounting).toMatchObject({
      startedRequests: 3, reportedRequests: 3, pendingRequests: 0, incomplete: false,
    });
    expect(readFormalizationArtifact(path.join(f.directory, 'artifact'))).toMatchObject({
      authority: 'compiler', semanticReview: 'not-performed', proofVerified: false,
    });
  });

  it('still requires compiler repair after a reminded candidate is rejected', async () => {
    const f = fixture(), provider = withProviderRequests(f, { requireReminder: true });
    let compilations = 0;
    const result = await runFormalization(f.directory, f.root, { openSession: provider.openSession,
      elaborate: async (_directory, source, environment, limits) => {
        if (++compilations === 1) throw new Error('formalization_elaboration_failed: unknown constant in statement');
        return syntheticElaboration(source, environment, limits);
      } });
    expect(result).toMatchObject({ status: 'approved', rounds: 2, candidatesTried: 2, roleTurns: { generate: 2 } });
    expect(compilations).toBe(2); expect(provider.notices.map(item => item.round)).toEqual([1, 2]);
    expect(f.seen[1].input.feedback).toContain('unknown constant in statement');
    expect(f.seen[1].input.previousCandidate.source).toBe(candidateFixture().source);
    expect(readFormalizationArtifact(path.join(f.directory, 'artifact')).round).toBe(2);
  });

  it('waits for every pending provider request before reminding direct generation', async () => {
    const f = fixture(), provider = withProviderRequests(f, { batchSize: 3, requireReminder: true });
    const result = await runFormalization(f.directory, f.root, { openSession: provider.openSession,
      elaborate: async (_directory, source, environment, limits) => syntheticElaboration(source, environment, limits) });
    expect(result.status).toBe('approved');
    expect(provider.checkpoints.map(item => item.notices)).toEqual([0, 0, 1]);
    expect(provider.notices[0]).toMatchObject({ reported: 3, pending: 0, waitForRequest: true });
  });

  it('does not remind a direct generator that has already written its candidate', async () => {
    const f = fixture(), provider = withProviderRequests(f, { outputBeforeSettlement: true });
    const result = await runFormalization(f.directory, f.root, { openSession: provider.openSession,
      elaborate: async (_directory, source, environment, limits) => syntheticElaboration(source, environment, limits) });
    expect(result.status).toBe('approved'); expect(provider.notices).toEqual([]);
    expect(provider.checkpoints.map(item => item.notices)).toEqual([0, 0, 0]);
  });

  it.each(['missing usage', 'spent token budget'] as const)('withholds a direct reminder after %s', async reason => {
    const missingUsage = reason === 'missing usage';
    const f = fixture([], { maxTotalTokens: missingUsage ? 100 : 1 }), provider = withProviderRequests(f, {
      ...(missingUsage ? { batchSize: 2, receipts: [completeRequest,
        { complete: false, outcome: 'completed', missingReason: 'provider-usage-missing' } as ModelRequestReceipt, completeRequest] } : {}),
    });
    let compilations = 0;
    const result = await runFormalization(f.directory, f.root, { openSession: provider.openSession,
      elaborate: async (_directory, source, environment, limits) => {
        compilations++; return syntheticElaboration(source, environment, limits);
      } });
    expect(result).toMatchObject({ status: 'stopped', error: missingUsage ? 'math_model_usage_unavailable' : 'math_total_token_limit' });
    expect(provider.notices).toEqual([]); expect(compilations).toBe(0);
    expect(provider.denied).toEqual([missingUsage ? 'math_model_usage_unavailable' : 'math_model_request_stopped']);
    expect(readFormalizationState(f.directory).sessions[0].requestUsageAccounting).toMatchObject({
      startedRequests: missingUsage ? 2 : 1, reportedRequests: 1, pendingRequests: 0, incomplete: missingUsage,
    });
    expect(fs.existsSync(path.join(f.directory, 'artifact'))).toBe(false);
  });

  it.each(['cancelled', 'time expired'] as const)('withholds a settled direct reminder when %s', async reason => {
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    const controller = new AbortController(), f = fixture([], { maxRunSeconds: 60 });
    const provider = withProviderRequests(f, { beforeSettlement: () => {
      if (reason === 'cancelled') controller.abort(); else now += 60_001;
    } });
    let compilations = 0;
    const result = await runFormalization(f.directory, f.root, { openSession: provider.openSession, signal: controller.signal,
      elaborate: async (_directory, source, environment, limits) => {
        compilations++; return syntheticElaboration(source, environment, limits);
      } });
    expect(result.status).not.toBe('approved'); expect(provider.notices).toEqual([]); expect(compilations).toBe(0);
    expect(provider.denied).toEqual(['math_model_request_stopped']);
    expect(fs.existsSync(path.join(f.directory, 'artifact'))).toBe(false);
  });
});
