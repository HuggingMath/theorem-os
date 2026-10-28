import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formalizationDigest, prepareFormalization, readFormalizationArtifact } from '../src/math/formalization';
import type { FormalizationPlan } from '../src/math/formalizationPlan';
import { defaultFormalizationWorkflow, type FormalizationWorkflow } from '../src/math/formalizationWorkflow';
import { mathDigest, readMathText } from '../src/math/mathRuntimeIo';
import type { FormalizationReferenceResult } from '../src/math/formalizationReference';
import type { StructuredReviewInput } from '../src/math/formalizationReviewV2';
import type { MathAgentFailureDiagnostic, MathAgentOptions, MathAgentSession } from '../src/runtime/codexSession';
import { readFormalizationState, runFormalization } from '../src/solver/formalization';
import { compareFormalizationReference } from '../src/solver/formalizationReference';
import { buildFixture, candidateFixture, fixtureStatement, semanticReviewFixture, syntheticElaboration } from './helpers/formalizationFixture';

// Disposable protocol/continuation fixtures; these are not model or Lean accuracy measurements.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const author = { model: 'preset-recovery', effort: 'none', profile: '/preset-recovery', executable: '/no-model' };
type Role = 'plan-1' | 'plan-2' | 'generate' | 'backtranslate' | 'compare-reviewer-1' | 'compare-reviewer-2';
type RunOptions = NonNullable<Parameters<typeof runFormalization>[2]>;
const roles: Role[] = ['plan-1', 'generate', 'backtranslate', 'compare-reviewer-1', 'compare-reviewer-2'];

function fixture(maxTotalTokens = 0, configure?: (workflow: FormalizationWorkflow) => void) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'formalization-recovery-'))); roots.push(parent);
  const { root, manifest } = buildFixture(parent), directory = path.join(parent, 'run');
  const workflow = defaultFormalizationWorkflow(author);
  workflow.maxPlanningRounds = 1; workflow.reviewScheduling = 'parallel';
  configure?.(workflow);
  prepareFormalization(directory, { problemId: 'synthetic_recovery', statement: fixtureStatement,
    environment: 'standard', execution: 'replay', ...author, workflow, buildManifestRef: manifest,
    maxRounds: 1, maxRunSeconds: 0, maxTurnSeconds: 0, maxCompileSeconds: 0, maxTotalTokens });
  const elaborate = vi.fn<NonNullable<RunOptions['elaborate']>>(async (_directory, source, environment, options) =>
    syntheticElaboration(source, environment, options));
  return { root, directory, elaborate };
}

function plan(statement: string): FormalizationPlan {
  return { schema: 'theorem-os.formalization-plan.v1', taskKind: 'prove',
    spans: [{ id: 'source', start: 0, end: statement.length, text: statement }],
    objects: [{ id: 'natural', spanIds: ['source'], description: 'Every natural number n.', leanType: 'Nat' }],
    assumptions: [], definitions: [], unresolved: [], conclusions: [{ id: 'identity', spanIds: ['source'],
      mathematics: 'For every natural n, n + 0 = n.', targetNames: ['addition'], assumptionIds: [] }] };
}

function recoveryAgent(failureRole: Role | undefined, failure: MathAgentFailureDiagnostic, behavior: {
  diagnostic?: (role: Role, attempt: number) => MathAgentFailureDiagnostic | undefined;
  beforeRun?: (role: Role) => Promise<void>;
  alterOutput?: (role: Role, attempt: number, output: unknown) => unknown;
} = {}) {
  let sequence = 0;
  const attempts = new Map<Role, number>();
  const seen: { role: Role; workspace: string; threadId: string; inputText: string; closed: boolean; failed: boolean }[] = [];
  const open = async (config: MathAgentOptions): Promise<MathAgentSession> => {
    const role = path.basename(config.workspace) as Role, threadId = 'recovery-thread-' + ++sequence;
    let diagnostic: MathAgentFailureDiagnostic | undefined;
    let record: typeof seen[number] | undefined;
    return { threadId, get lastFailureDiagnostic() { return diagnostic; },
      interrupt: async () => {}, close: async () => { if (record) record.closed = true; },
      run: async (_message, _id, workspace, onStarted) => {
        expect([...roles, 'plan-2']).toContain(role);
        onStarted('recovery-turn-' + threadId);
        config.onUsage({ inputTokens: 1, outputTokens: 0, totalTokens: 1 });
        const attempt = (attempts.get(role) ?? 0) + 1; attempts.set(role, attempt);
        const inputText = readMathText(path.join(workspace, 'INPUT.json')), input = JSON.parse(inputText);
        const currentDiagnostic = behavior.diagnostic ? behavior.diagnostic(role, attempt) :
          role === failureRole && attempt === 1 ? failure : undefined;
        const failed = currentDiagnostic !== undefined;
        record = { role, workspace, threadId, inputText, closed: false, failed }; seen.push(record);
        await behavior.beforeRun?.(role);
        if (failed) { diagnostic = currentDiagnostic; return 'failed'; }
        const output = role.startsWith('plan-') ? plan(input.statement) : role === 'generate' ? candidateFixture(input.statement) :
          role === 'backtranslate' ? { snapshotDigest: input.snapshotDigest, mathematics: 'The natural zero identity.',
            assumptions: [], definitions: [], targets: input.targets.map((target: { name: string }) =>
              ({ name: target.name, mathematics: 'For every natural n, n + 0 = n.' })) } :
            semanticReviewFixture(input as StructuredReviewInput);
        fs.writeFileSync(path.join(workspace, 'OUTPUT.json'), JSON.stringify(behavior.alterOutput?.(role, attempt, output) ?? output));
        return 'completed';
      } };
  };
  return { open, seen, attempts };
}

const upstream: MathAgentFailureDiagnostic = { code: 'other', reason: 'upstream_request_failed' };

async function cancelledReviewFixture() {
  const f = fixture(), agent = recoveryAgent('compare-reviewer-2', upstream), controller = new AbortController();
  const waitForRetry = vi.fn(async (_ms: number, signal: AbortSignal) => {
    controller.abort(); signal.throwIfAborted();
  });
  const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate: f.elaborate,
    signal: controller.signal, waitForRetry });
  expect(result).toMatchObject({ status: 'stopped', rounds: 1, candidatesTried: 1 });
  expect(waitForRetry).toHaveBeenCalledTimes(1);
  expect(f.elaborate).toHaveBeenCalledTimes(1);
  return { ...f, agent, state: readFormalizationState(f.directory)! };
}

describe('formalization stage recovery', () => {
  it.each([
    ['plan-1', 'upstream_request_failed'], ['generate', 'invalid_tool_call_arguments'],
    ['backtranslate', 'account_concurrency_limit'], ['compare-reviewer-2', 'upstream_request_failed'],
  ] as const)('retries only %s in fresh sessions without consuming another candidate round', async (role, reason) => {
    const f = fixture(), agent = recoveryAgent(role, { code: 'other', reason });
    const waitForRetry = vi.fn(async (_ms: number, signal: AbortSignal) => { signal.throwIfAborted(); });
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open,
      elaborate: f.elaborate, waitForRetry });
    expect(result).toMatchObject({ status: 'approved', rounds: 1, candidatesTried: 1, firstCandidateApproved: true });
    for (const expected of roles) expect(agent.attempts.get(expected)).toBe(expected === role ? 2 : 1);
    const retried = agent.seen.filter(item => item.role === role);
    expect(retried[0].inputText).toBe(retried[1].inputText);
    expect(new Set(agent.seen.map(item => item.threadId)).size).toBe(6);
    expect(new Set(agent.seen.map(item => item.workspace)).size).toBe(6);
    expect(agent.seen.every(item => item.closed)).toBe(true);
    expect(waitForRetry).toHaveBeenCalledTimes(1);
    expect(waitForRetry.mock.calls[0][0]).toBeGreaterThan(0);
    expect(f.elaborate).toHaveBeenCalledTimes(1);
    const state = readFormalizationState(f.directory)!;
    expect(state.sessions.find(item => item.status === 'failed')?.failureDiagnostic).toEqual({ code: 'other', reason });
    expect(state.sessions.every(item => item.round === 1 && !item.usageAccounting.incomplete)).toBe(true);
    expect(readFormalizationArtifact(path.join(f.directory, 'artifact')).sessions).toHaveLength(5);
  });

  it('keeps the completed parallel reviewer and upstream stages while another reviewer recovers', async () => {
    const f = fixture(), agent = recoveryAgent('compare-reviewer-2', upstream);
    const waitForRetry = vi.fn(async () => {
      const successful = readFormalizationState(f.directory)!.sessions.filter(item => item.status === 'completed');
      expect(successful.map(item => item.role)).toEqual(['plan', 'generate', 'backtranslate', 'compare']);
      expect(successful.at(-1)).toMatchObject({ reviewerId: 'reviewer-1' });
      expect(agent.seen.find(item => item.role === 'compare-reviewer-1')?.closed).toBe(true);
    });
    expect(await runFormalization(f.directory, f.root, { openSession: agent.open,
      elaborate: f.elaborate, waitForRetry })).toMatchObject({ status: 'approved', rounds: 1, candidatesTried: 1 });
    expect(agent.seen.map(item => item.role)).toEqual([...roles, 'compare-reviewer-2']);
    expect(f.elaborate).toHaveBeenCalledTimes(1);
  });

  it('stops when cancelled during retry backoff without starting another attempt', async () => {
    const f = fixture(), agent = recoveryAgent('plan-1', upstream), controller = new AbortController();
    let entered!: () => void;
    const backoffEntered = new Promise<void>(resolve => { entered = resolve; });
    const waitForRetry = vi.fn((_ms: number, signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }); entered();
    }));
    const running = runFormalization(f.directory, f.root, { openSession: agent.open,
      elaborate: f.elaborate, signal: controller.signal, waitForRetry });
    await backoffEntered; controller.abort();
    expect(await running).toMatchObject({ status: 'stopped', rounds: 1, candidatesTried: 0 });
    expect(agent.seen.map(item => item.role)).toEqual(['plan-1']);
    expect(waitForRetry).toHaveBeenCalledTimes(1); expect(f.elaborate).not.toHaveBeenCalled();
    expect(readFormalizationState(f.directory)!.activeSince).toBeUndefined();
  });

  it.each(['unauthorized', 'badRequest'] as const)('stops on native %s without retrying', async code => {
    const f = fixture(), agent = recoveryAgent('plan-1', { code }), waitForRetry = vi.fn(async () => {});
    expect(await runFormalization(f.directory, f.root, { openSession: agent.open,
      elaborate: f.elaborate, waitForRetry })).toMatchObject({ status: 'stopped', rounds: 1, candidatesTried: 0 });
    expect(agent.seen.map(item => item.role)).toEqual(['plan-1']);
    expect(waitForRetry).not.toHaveBeenCalled(); expect(f.elaborate).not.toHaveBeenCalled();
  });

  it.each([
    ['compare-reviewer-1', 'unauthorized'], ['compare-reviewer-2', 'unauthorized'],
    ['compare-reviewer-1', 'badRequest'], ['compare-reviewer-2', 'badRequest'],
  ] as const)('propagates %s %s while cancelling its retrying parallel sibling', async (failedReviewer, code) => {
    const f = fixture(), controller = new AbortController();
    let releaseReviewers!: () => void, startedReviewers = 0;
    const bothReviewersStarted = new Promise<void>(resolve => { releaseReviewers = resolve; });
    const agent = recoveryAgent(undefined, upstream, {
      diagnostic: role => role === failedReviewer ? { code } : role.startsWith('compare-') ? upstream : undefined,
      beforeRun: async role => {
        if (!role.startsWith('compare-')) return;
        if (++startedReviewers === 2) releaseReviewers();
        await bothReviewersStarted;
      },
    });
    const waitForRetry = vi.fn(async (_ms: number, signal: AbortSignal) => {
      signal.throwIfAborted();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    // An unfixed allSettled loop must fail this test and still release its lease.
    let watchdogFired = false;
    const watchdog = setTimeout(() => {
      watchdogFired = true; controller.abort(new Error('parallel_permanent_failure_was_not_propagated'));
    }, 1000);
    let result: Awaited<ReturnType<typeof runFormalization>>;
    try {
      result = await runFormalization(f.directory, f.root, { openSession: agent.open,
        elaborate: f.elaborate, waitForRetry, signal: controller.signal });
    } finally { clearTimeout(watchdog); controller.abort(); }
    expect(watchdogFired, 'Permanent reviewer failure must stop the panel without external cancellation.').toBe(false);
    expect(result).toMatchObject({ status: 'stopped', rounds: 1, candidatesTried: 1 });
    expect(result.error).toBe('formalization_role_incomplete:failed:' + code);
    expect(agent.seen.map(item => item.role)).toEqual(roles);
    expect(agent.seen.every(item => item.closed)).toBe(true);
    expect(f.elaborate).toHaveBeenCalledTimes(1);
  });

  it('charges failed attempts against the token budget before retry admission', async () => {
    const f = fixture(1), agent = recoveryAgent('plan-1', upstream), waitForRetry = vi.fn(async () => {});
    expect(await runFormalization(f.directory, f.root, { openSession: agent.open,
      elaborate: f.elaborate, waitForRetry })).toMatchObject({ status: 'stopped', rounds: 1,
      candidatesTried: 0, error: 'math_total_token_limit' });
    expect(agent.seen).toHaveLength(1); expect(waitForRetry).not.toHaveBeenCalled();
    expect(readFormalizationState(f.directory)!.sessions[0]).toMatchObject({ usage: { totalTokens: 1 },
      usageAccounting: { startedTurns: 1, reportedTurns: 1, pending: false, incomplete: false } });
  });

  it('resumes the active finite round, reusing completed roles and compilation without recounting the candidate', async () => {
    const f = await cancelledReviewFixture();
    expect(f.state.activeRound?.directory).toMatch(/^round-01-/);
    const completed = f.state.sessions.filter(item => item.status === 'completed');
    expect(completed).toHaveLength(4);
    for (const item of completed) {
      expect(item.workspace).toBeTruthy(); expect(path.isAbsolute(item.workspace!)).toBe(false);
      expect(item.workspace).not.toMatch(/^\.\./);
      const output = JSON.parse(readMathText(path.join(f.directory, item.workspace!, 'OUTPUT.json')));
      expect(item.outputDigest).toBe(formalizationDigest(output));
    }
    const resumed = await runFormalization(f.directory, f.root, { openSession: f.agent.open,
      elaborate: f.elaborate, waitForRetry: async () => {} });
    expect(resumed).toMatchObject({ status: 'approved', rounds: 1, candidatesTried: 1, firstCandidateApproved: true });
    expect(f.agent.seen.map(item => item.role)).toEqual([...roles, 'compare-reviewer-2']);
    expect(f.elaborate).toHaveBeenCalledTimes(1);
    expect(readFormalizationState(f.directory)!.generatedCandidates).toBe(1);
  });

  it('restores the accepted second plan without rerunning a schema-invalid first planning attempt', async () => {
    const f = fixture(0, workflow => { workflow.maxPlanningRounds = 2; }), controller = new AbortController();
    const agent = recoveryAgent('compare-reviewer-2', upstream, { alterOutput: (role, attempt, output) => {
      if (role !== 'plan-1') return output;
      expect(attempt, 'A rejected first plan must not run again after the second plan was accepted.').toBe(1);
      const invalid = structuredClone(output as FormalizationPlan);
      invalid.objects[0].id = invalid.spans[0].id; // Rejected by the actual schema superRefine.
      return invalid;
    } });
    expect(await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate: f.elaborate,
      signal: controller.signal, waitForRetry: async (_ms, signal) => { controller.abort(); signal.throwIfAborted(); } }))
      .toMatchObject({ status: 'stopped', rounds: 1, candidatesTried: 1 });
    const state = readFormalizationState(f.directory)!;
    const rejectedPlan = state.sessions.find(item => item.role === 'plan' && item.workspace?.endsWith('/plan-1'))!;
    expect(rejectedPlan.outputDigest).toBeUndefined();
    expect(state.sessions.find(item => item.role === 'plan' && item.workspace?.endsWith('/plan-2'))?.outputDigest)
      .toMatch(/^[a-f0-9]{64}$/u);
    expect(await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate: f.elaborate,
      waitForRetry: async () => {} })).toMatchObject({ status: 'approved', rounds: 1, candidatesTried: 1 });
    expect(agent.seen.map(item => item.role)).toEqual(['plan-1', 'plan-2', ...roles.slice(1), 'compare-reviewer-2']);
    expect(f.elaborate).toHaveBeenCalledTimes(1);
    const evidence = readFormalizationArtifact(path.join(f.directory, 'artifact'));
    expect(evidence.workflow?.plan.input.planningRound).toBe(2);
    expect(evidence.generation.input.planDigest).toBe(evidence.workflow?.plan.digest);
  });

  it('retries a cancelled real reference comparison in a fresh directory while restoring completed roles', async () => {
    const source = 'theorem gold (n : Nat) : n + 0 = n := by sorry\n';
    const f = fixture(0, workflow => {
      workflow.reference = { source, sourceSha256: mathDigest(source), maxSeconds: 0,
        provenance: 'Synthetic recovery test only.', pairs: [{ candidateTarget: 'addition', referenceTarget: 'gold' }] };
    });
    const agent = recoveryAgent(undefined, upstream), controller = new AbortController();
    const comparisons: { directory: string; result: FormalizationReferenceResult }[] = [];
    const compareReference: NonNullable<RunOptions['compareReference']> = async (directory, input, options) => {
      expect(fs.existsSync(directory), 'A native reference attempt requires its own fresh directory.').toBe(false);
      expect(options.signal?.aborted).toBe(false);
      // The first cancellation stops the run; the second keeps the real native
      // unknown-receipt path but avoids launching Lean in this contract test.
      const localCancellation = new AbortController(); localCancellation.abort();
      if (comparisons.length === 0) controller.abort();
      const result = await compareFormalizationReference(directory, input, { ...options,
        signal: comparisons.length === 0 ? options.signal : localCancellation.signal });
      expect(result).toMatchObject({ check: 'unavailable', status: 'not-established' });
      expect(fs.existsSync(path.join(directory, 'comparison.json'))).toBe(true);
      comparisons.push({ directory, result });
      return result;
    };
    expect(await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate: f.elaborate,
      compareReference, signal: controller.signal })).toMatchObject({ status: 'stopped', rounds: 1, candidatesTried: 1 });
    expect(comparisons).toHaveLength(1);
    const resumed = await runFormalization(f.directory, f.root, { openSession: agent.open,
      elaborate: f.elaborate, compareReference });
    expect(comparisons).toHaveLength(2);
    expect(comparisons[0].directory).not.toBe(comparisons[1].directory);
    expect(resumed).toMatchObject({ rounds: 1, candidatesTried: 1 });
    expect(resumed.error).toContain('formalization_reference_not_established');
    expect(agent.seen.map(item => item.role)).toEqual(roles);
    expect(f.elaborate).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(path.join(f.directory, 'artifact'))).toBe(false);
  });

  it.each(['plan-1', 'generate', 'backtranslate', 'compare-reviewer-1'] as const)(
    'stops if the saved successful %s output changes before resume', async role => {
      const f = await cancelledReviewFixture(), workspace = f.agent.seen.find(item => item.role === role)!.workspace;
      const file = path.join(workspace, 'OUTPUT.json'), output = JSON.parse(readMathText(file));
      if (role === 'plan-1') output.objects[0].description += ' Changed after submission.';
      else if (role === 'generate') output.definitionsExplanation += ' Changed after submission.';
      else if (role === 'backtranslate') output.mathematics += ' Changed after submission.';
      else output.summary += ' Changed after submission.';
      fs.writeFileSync(file, JSON.stringify(output));
      const result = await runFormalization(f.directory, f.root, { openSession: f.agent.open,
        elaborate: f.elaborate, waitForRetry: async () => {} });
      expect(result.status).toBe('stopped'); expect(result.error).toContain('formalization_checkpoint_changed');
      expect(result).toMatchObject({ rounds: 1, candidatesTried: 1 });
      for (const successful of roles.filter(item => item !== 'compare-reviewer-2'))
        expect(f.agent.attempts.get(successful)).toBe(1);
      expect(f.elaborate).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(path.join(f.directory, 'artifact'))).toBe(false);
    });
});
