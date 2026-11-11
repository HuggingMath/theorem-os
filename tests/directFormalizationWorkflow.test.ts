import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
      fs.writeFileSync(path.join(workspace, 'OUTPUT.json'), JSON.stringify(candidates[seen.length - 1] ?? candidateFixture(input.statement)));
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
    expect(f.seen[0].instructions).toContain('Prepare source and its coverage/definition notes together');
    expect(f.seen[0].instructions).toContain('reuse its exact file bytes in source');
    expect(f.seen[0].instructions).toContain('Lean remains available for a specific unresolved type or syntax question');
    expect(f.seen[0].instructions).toContain('wait on that same session with write_stdin and empty chars');
    expect(f.seen[0].instructions).not.toContain('Use lean directly to inspect declarations when necessary');
    const evidence = readFormalizationArtifact(path.join(f.directory, 'artifact'));
    expect(evidence).toMatchObject({ authority: 'compiler', semanticReview: 'not-performed', proofVerified: false });
    expect(evidence.sessions.map(session => session.role)).toEqual(['generate']);
    expect(evidence).not.toHaveProperty('translation'); expect(evidence).not.toHaveProperty('review');
    expect(readMathText(path.join(f.directory, 'task.md'))).toContain('Original problem (verbatim):\n\n' + fixtureStatement);
    expect(await runFormalization(f.directory, f.root, options)).toMatchObject({ status: 'approved' });
    expect(f.seen).toHaveLength(1); expect(compilations).toBe(1);
  });

  it('packages the chosen draft source and exact notes with the supplied Python recipe before host validation', async () => {
    const f = fixture(), candidate = candidateFixture();
    candidate.source = '/- Keep apostrophes \' backticks ` $() and Unicode 原题 literal. -/\r\n' + candidate.source.replace(/\n/gu, '\r\n');
    candidate.definitionsExplanation = 'Exact notes: \' " ` $() \\ 原题\nsecond line.';
    const { source, ...metadata } = candidate;
    let compilations = 0;
    const result = await runFormalization(f.directory, f.root, {
      openSession: async options => ({
        threadId: 'packaged-direct-source', close: async () => {}, interrupt: async () => {},
        run: async (_message, _id, workspace, started) => {
          started('packaged-direct-turn'); options.onUsage({ totalTokens: 1 });
          const script = options.instructions.match(/<<'THEOREMOS_PACKAGE'\n([\s\S]*?)\nTHEOREMOS_PACKAGE\n/u)?.[1];
          expect(script).toBeDefined();
          fs.writeFileSync(path.join(workspace, 'Candidate.lean'), source);
          fs.writeFileSync(path.join(workspace, 'Candidate.metadata.json'), JSON.stringify(metadata));
          expect(fs.existsSync(path.join(workspace, 'OUTPUT.json'))).toBe(false);
          execFileSync('/usr/bin/python3', ['-I', '-c', script!], { cwd: workspace });
          const output = JSON.parse(readMathText(path.join(workspace, 'OUTPUT.json')));
          expect(output).toEqual(candidate);
          expect(fs.existsSync(path.join(workspace, 'OUTPUT.json.tmp'))).toBe(false);
          expect(fs.readFileSync(path.join(workspace, 'Candidate.lean'), 'utf8')).toBe(source);
          options.completedOutput!.validate(output);
          return 'submitted';
        },
      }),
      elaborate: async (_directory, compiledSource, environment, limits) => {
        compilations++;
        expect(compiledSource).toContain('theorem addition');
        return syntheticElaboration(compiledSource, environment, limits);
      },
    });
    expect(result).toMatchObject({ status: 'approved', rounds: 1, candidatesTried: 1 });
    expect(compilations).toBe(1);
    expect(readFormalizationArtifact(path.join(f.directory, 'artifact'))).toMatchObject({
      authority: 'compiler', semanticReview: 'not-performed', proofVerified: false,
      candidate: { coverage: candidate.coverage, definitionsExplanation: candidate.definitionsExplanation },
    });
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

  it('repairs an unsupported structure in the same generator thread before invoking the host compiler', async () => {
    const unsupported = formalizationCandidateSchema.parse({ ...candidateFixture(),
      source: 'structure RadicalTower where\n  level : Nat\n\n' + candidateFixture().source });
    const f = fixture([unsupported]); let compilations = 0;
    const result = await runFormalization(f.directory, f.root, { openSession: f.openSession,
      elaborate: async (_directory, source, environment, limits) => {
        compilations++; expect(source).toBe(candidateFixture().source); expect(limits.timeoutMs).toBe(0);
        return syntheticElaboration(source, environment, limits);
      } });
    expect(result).toMatchObject({ status: 'approved', rounds: 1, candidatesTried: 1, roleTurns: { generate: 2 } });
    expect(compilations).toBe(1); expect(f.seen).toHaveLength(2);
    expect(f.seen[1].input).toEqual(f.seen[0].input);
    expect(f.seen[1].message).toContain('formalization_unsupported_declaration');
    expect(f.seen[1].message).toContain('ordinary named def/abbrev/instance/theorem/lemma');
    expect(readFormalizationState(f.directory).sessions.map(session => session.role)).toEqual(['generate']);
    const round = fs.readdirSync(f.directory).find(file => file.startsWith('round-'))!;
    const rejected = fs.readdirSync(path.join(f.directory, round)).find(file => file.startsWith('generate-rejected-output-'))!;
    expect(JSON.parse(readMathText(path.join(f.directory, round, rejected)))).toEqual({
      error: 'formalization_unsupported_declaration', outputText: JSON.stringify(unsupported),
    });
    const evidence = readFormalizationArtifact(path.join(f.directory, 'artifact'));
    expect(evidence.round).toBe(1); expect(evidence.candidate.source).toBe(candidateFixture().source);
    expect(evidence.sessions).toHaveLength(1);
  });

  it.each([
    ['ordinary source', ''],
    ['source containing reserved stop markers',
      ' formalization_build_changed formalization_plan_task_kind_unsupported formalization_role_incomplete:failed:unauthorized'],
  ])('repairs an inexact coverage quote in the same generator thread before compiling unchanged Lean source (%s)', async (_caseName, suffix) => {
    const statement = 'For every natural number n ({n} ⊆ ℕ), prove n + 0 = n.' + suffix;
    const repaired = candidateFixture(statement), invalid = { ...repaired,
      coverage: [{ ...repaired.coverage[0], originalText: statement.replace('⊆', '⊔') }] };
    const f = fixture([invalid, repaired], { statement, maxRounds: 2 }); let compilations = 0;
    const result = await runFormalization(f.directory, f.root, { openSession: f.openSession,
      elaborate: async (_directory, source, environment, limits) => {
        compilations++; expect(f.seen).toHaveLength(2); expect(source).toBe(repaired.source);
        return syntheticElaboration(source, environment, limits);
      } });
    expect(result).toMatchObject({ status: 'approved', rounds: 1, candidatesTried: 1, roleTurns: { generate: 2 } });
    expect(compilations).toBe(1); expect(f.seen).toHaveLength(2);
    const repairInput = f.seen[1].input;
    expect(repairInput.statement).toBe(statement);
    expect(repairInput).toEqual(f.seen[0].input);
    expect(f.seen[1].message).toContain('formalization_coverage_invalid');
    expect(f.seen[1].message).toContain('coverage[0].originalText');
    expect(f.seen[1].message).toContain('{n} ⊆ ℕ');
    expect(f.seen[1].message).toContain('{n} ⊔ ℕ');
    const evidence = readFormalizationArtifact(path.join(f.directory, 'artifact'));
    expect(evidence.round).toBe(1); expect(evidence.candidate).toEqual(repaired);
  });

  it.each(['active', 'completed'] as const)('repairs an inferable definition underscore during an %s turn without a new round', async mode => {
    const f = fixture([], { maxRounds: 1 }), valid = candidateFixture();
    const invalid = { ...valid, source: 'def identity (n : Nat) : Nat := @id _ n\n' + valid.source };
    const originalProtocol: string[] = [], feedback: string[] = [];
    let opened = 0, turns = 0, compilations = 0;
    const result = await runFormalization(f.directory, f.root, {
      openSession: async config => {
        opened++;
        expect(config.turnTimeoutMs).toBeUndefined();
        expect(config.instructions).toContain('including inferable instance arguments');
        return { threadId: 'underscore-generator', close: async () => {}, interrupt: async () => {},
          usageSource: 'upstream-requests',
          run: async (message, _id, workspace, started) => {
            turns++; started('underscore-turn-' + turns);
            const protocol = ['INPUT.json', 'ROLE.md', 'OUTPUT.schema.json'].map(file => readMathText(path.join(workspace, file)));
            if (!originalProtocol.length) originalProtocol.push(...protocol);
            else expect(protocol).toEqual(originalProtocol);
            const paid = config.requestGate!({ requestId: 'underscore-request-' + turns, source: 'responses-relay' });
            expect(paid.allowed).toBe(true);
            if (!paid.allowed) throw new Error(paid.reason);
            paid.settle(completeRequest);
            const outputFile = path.join(workspace, 'OUTPUT.json');
            if (turns === 1) {
              fs.writeFileSync(outputFile, JSON.stringify(invalid));
              let error: unknown;
              try { config.completedOutput!.validate(invalid); } catch (cause) { error = cause; }
              expect(String(error)).toContain('formalization_placeholder_outside_proof');
              expect(String(error)).toContain('line 1, column 37');
              if (mode === 'completed') return 'completed';
              feedback.push(config.completedOutput!.validationFeedback!(error, { text: JSON.stringify(invalid), turnId: 'underscore-turn-1' }));
            } else feedback.push(message);
            fs.writeFileSync(outputFile, JSON.stringify(valid));
            config.completedOutput!.validate(valid);
            return 'submitted';
          },
        };
      },
      elaborate: async (_directory, source, environment, limits) => {
        compilations++; expect(source).toBe(valid.source); expect(limits.timeoutMs).toBe(0);
        return syntheticElaboration(source, environment, limits);
      },
    });
    expect(result).toMatchObject({ status: 'approved', rounds: 1, candidatesTried: 1 });
    expect(opened).toBe(1); expect(compilations).toBe(1); expect(turns).toBe(mode === 'active' ? 1 : 2);
    expect(feedback).toHaveLength(1); expect(feedback[0]).toContain('even when Lean could infer an underscore');
    const state = readFormalizationState(f.directory)!;
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0].requestUsageAccounting).toMatchObject({
      startedRequests: turns, reportedRequests: turns, pendingRequests: 0, incomplete: false,
    });
    const evidence = readFormalizationArtifact(path.join(f.directory, 'artifact'));
    expect(evidence).toMatchObject({ round: 1, generation: { output: valid },
      authority: 'compiler', semanticReview: 'not-performed', proofVerified: false });
    expect(evidence.sessions).toHaveLength(1);
    const round = fs.readdirSync(f.directory).find(file => file.startsWith('round-'))!;
    const rejected = fs.readdirSync(path.join(f.directory, round)).filter(file => file.startsWith('generate-rejected-output-'));
    expect(rejected).toHaveLength(1);
    expect(JSON.parse(readMathText(path.join(f.directory, round, rejected[0]))).outputText).toBe(JSON.stringify(invalid));
    expect(await runFormalization(f.directory, f.root, { openSession: f.openSession })).toMatchObject({ status: 'approved' });
    expect(f.seen).toEqual([]);
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
    expect(reminder).toContain('Let any running library query finish; this reminder does not cancel tools');
    expect(reminder).toContain('reuse that file instead of rewriting it');
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
