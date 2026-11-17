import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as sandboxRuntime from '../src/runtime/formalizationSandbox';
import { assertFormalizationCompiledCandidate, assertFormalizationEvidence, formalizationCompiledCandidate,
  formalizationCompiledCandidateDigest, formalizationDigest, formalizationEvidenceSchema, prepareFormalization,
  readFormalizationArtifact, readFormalizationRequest, type FormalizationCompiledCandidate } from '../src/math/formalization';
import { defaultFormalizationWorkflow, type FormalizationWorkflow } from '../src/math/formalizationWorkflow';
import type { FormalizationPlan } from '../src/math/formalizationPlan';
import type { MathAgentFailureDiagnostic, MathAgentOptions, MathAgentSession } from '../src/runtime/codexSession';
import type { ModelRequestReceipt } from '../src/runtime/modelRequest';
import { readFormalizationState, runFormalization } from '../src/solver/formalization';
import { canonicalMathJson, readMathText } from '../src/math/mathRuntimeIo';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { structuredReviewAspects } from '../src/math/formalizationReviewV2';
import { buildFixture, candidateFixture, fixtureStatement, semanticReviewFixture, syntheticElaboration } from './helpers/formalizationFixture';

const roots: string[] = [];
afterEach(() => { for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
const author = { model: 'preset-author', effort: 'none', profile: '/preset-author', executable: '/no-model' };
function fixture(configure?: (workflow: FormalizationWorkflow) => void, requestOverrides: Record<string, unknown> = {}) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'formalization-v2-contract-'))); roots.push(parent);
  const { root, manifest } = buildFixture(parent), directory = path.join(parent, 'run');
  const workflow = defaultFormalizationWorkflow(author);
  // This fixture deliberately exercises finite retry behavior; new CLI requests default to unlimited.
  workflow.maxPlanningRounds = 2; configure?.(workflow);
  const request = prepareFormalization(directory, { problemId: 'synthetic_addition', statement: fixtureStatement,
    environment: 'standard', execution: 'replay', outputDelivery: 'file', ...author, workflow,
    buildManifestRef: manifest, maxRounds: 1, maxRunSeconds: 60, maxTurnSeconds: 10, maxCompileSeconds: 10,
    maxTotalTokens: 0, ...requestOverrides });
  return { parent, root, manifest, directory, request };
}
function plan(statement: string): FormalizationPlan {
  return { schema: 'theorem-os.formalization-plan.v1', taskKind: 'prove',
    spans: [{ id: 'source', start: 0, end: statement.length, text: statement }],
    objects: [{ id: 'natural-number', spanIds: ['source'], description: 'Every natural number n.', leanType: 'Nat' }],
    assumptions: [], definitions: [], unresolved: [], conclusions: [{ id: 'zero-identity', spanIds: ['source'],
      mathematics: 'For every natural n, n + 0 = n.', targetNames: ['addition'], assumptionIds: [] }] };
}
function preset(options: { verdicts?: ('approved' | 'changes_requested' | 'unknown')[]; badSpanFirst?: boolean;
  unresolved?: boolean; taskKind?: 'decision' | 'construction'; addUnplannedDefinition?: boolean;
  rejectedFirstRound?: boolean; unknownFirstRound?: boolean; mismatchAspects?: (typeof structuredReviewAspects[number])[];
  changeSource?: boolean; reuseThread?: boolean; missingFinalUsage?: boolean;
  incompleteFinalUsage?: boolean; submitted?: boolean; claimShapeFirst?: boolean; afterOutput?: (role: string) => void;
  additionalTargets?: readonly string[]; candidateSource?: string;
  refutations?: (input: any) => unknown[]; refuteStatus?: string; refuteDiagnostic?: MathAgentFailureDiagnostic } = {}) {
  let sequence = 0, plans = 0;
  const seen: { role: string; config: MathAgentOptions; input: any; message: string }[] = [];
  const open = async (config: MathAgentOptions): Promise<MathAgentSession> => {
    const number = ++sequence, role = path.basename(config.workspace);
    return { threadId: options.reuseThread && role.startsWith('compare-') ? 'reused-review-thread' : 'preset-thread-' + number,
      ...(role === 'refute' && options.refuteDiagnostic ? { lastFailureDiagnostic: options.refuteDiagnostic } : {}),
      close: async () => {}, interrupt: async () => {}, run: async (message, _id, workspace, onStarted) => {
        onStarted('preset-turn-' + number);
        if (!options.missingFinalUsage || role !== 'compare-reviewer-2') config.onUsage({ totalTokens: 1 });
        if (options.incompleteFinalUsage && role === 'compare-reviewer-2') config.onUsageIncomplete?.();
        const input = JSON.parse(readMathText(path.join(workspace, 'INPUT.json'))); seen.push({ role, config, input, message });
        let output: unknown;
        if (role.startsWith('plan-')) {
          plans++; const value = plan(input.statement);
          value.conclusions[0].targetNames.push(...options.additionalTargets ?? []);
          if (options.claimShapeFirst && plans === 1) value.conclusions[0].mathematics = 'IsConj (n + 0) (0 + n).';
          if (options.badSpanFirst && plans === 1) value.spans[0].text = 'x'.repeat(input.statement.length);
          if (options.unresolved) value.unresolved.push({ id: 'unknown-domain', spanIds: ['source'], description: 'The domain is unresolved.' });
          if (options.taskKind) value.taskKind = options.taskKind;
          output = value;
        } else if (role === 'generate') {
          const value = candidateFixture(input.statement);
          if (options.candidateSource) value.source = options.candidateSource;
          for (const name of options.additionalTargets ?? []) {
            value.source += `theorem ${name} (n : Nat) : n + 0 = n := by sorry\n`;
            value.coverage[0].targetNames.push(name);
          }
          if (options.addUnplannedDefinition) value.source = 'def hiddenMeaning : Nat := 0\n' + value.source;
          if (input.round > 1) {
            value.definitionsExplanation += ' Changed author notes.';
            if (options.changeSource) value.source = value.source.replace(/\bn\b/gu, 'm');
          }
          output = value;
        } else if (role === 'backtranslate') {
          output = { snapshotDigest: input.snapshotDigest, mathematics: 'The natural zero identity.', assumptions: [], definitions: [],
            targets: input.targets.map((target: { name: string }) => ({ name: target.name, mathematics: 'For every n, n + 0 = n.' })) };
        } else if (role === 'refute') {
          output = { snapshotDigest: input.snapshotDigest, refutations: options.refutations?.(input) ?? [],
            summary: 'Preset refutation attempt.' };
        } else {
          const index = input.reviewerId === 'reviewer-1' ? 0 : 1;
          const round = seen.filter(item => item.role === 'generate').at(-1)!.input.round;
          const verdict = options.rejectedFirstRound && round === 1 ? 'changes_requested' :
            options.unknownFirstRound && round === 1 ? 'unknown' : options.verdicts?.[index] ?? 'approved';
          const review = input.schema === 'theorem-os.formalization-review-input.v2' ?
            semanticReviewFixture(input, verdict, verdict === 'approved' ? 'Preset faithful translation.' : 'Preset uncertain domain.',
              options.mismatchAspects?.[index]) :
            { inputDigest: input.inputDigest, snapshotDigest: input.snapshotDigest, translationDigest: input.translationDigest,
              verdict, summary: 'Legacy workflow test review.',
              checks: { equivalent: true, complete: true, assumptions: true, definitions: true }, issues: [] };
          if (input.fidelityPolicy && 'schema' in review) review.fidelity = {
            policy: input.fidelityPolicy,
            targets: input.observation.snapshot.targets.map(target => ({ targetName: target.name,
              originalFragment: input.original, sourceClaim: input.original, candidateClaim: 'For every natural n, n + 0 = n.',
              hypothesisScope: 'Only the natural-number domain is assumed.', quantifierOrder: 'n is universally quantified.',
              binderIds: target.context.bindings.binders.map(binder => binder.id),
              conclusionDependencies: target.context.bindings.conclusionDependencies })),
            sourceContract: verdict === 'approved' ? { source: input.observation.snapshot.source,
              pairs: input.observation.snapshot.targets.map(target => ({ candidateTarget: target.name, referenceTarget: target.name })) } : null,
          };
          output = review;
        }
        fs.writeFileSync(path.join(workspace, 'OUTPUT.json'), JSON.stringify(output)); options.afterOutput?.(role);
        if (options.submitted) config.completedOutput!.validate(output);
        if (role === 'refute' && options.refuteStatus) return options.refuteStatus;
        return options.submitted ? 'submitted' : 'completed';
      } };
  };
  return { open, seen };
}

const completeRequest: ModelRequestReceipt = { complete: true, outcome: 'completed',
  usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 } };

/** Simulate provider admission/settlement without a transport, model or Lean process. */
function withProviderRequests(agent: ReturnType<typeof preset>, receipts: readonly ModelRequestReceipt[] =
  Array.from({ length: 5 }, () => completeRequest), batchSize = 1) {
  const notices: { role: string; reported: number; pending: number; waitForRequest: boolean | undefined }[] = [];
  const checkpoints: { role: string; settled: number; notices: number }[] = [];
  const opened: string[] = [], interrupted: string[] = [], denied: string[] = [];
  const open = async (config: MathAgentOptions): Promise<MathAgentSession> => {
    const base = await agent.open(config), role = path.basename(config.workspace);
    opened.push(role);
    let reported = 0, pending = 0, noticeCount = 0;
    return { ...base, usageSource: 'upstream-requests',
      notify: async (_message, options) => {
        noticeCount++; notices.push({ role, reported, pending, waitForRequest: options?.waitForRequest });
      },
      interrupt: async () => { interrupted.push(role); await base.interrupt(); },
      run: (message, id, workspace, onStarted) => base.run(message, id, workspace, turnId => {
        onStarted(turnId);
        for (let start = 0; start < receipts.length; start += batchSize) {
          const admissions = receipts.slice(start, start + batchSize).map((receipt, index) => {
            const admission = config.requestGate!({ requestId: role + '-' + (start + index), source: 'responses-relay' });
            if (!admission.allowed) { denied.push(admission.reason); throw new Error(admission.reason); }
            pending++;
            return { receipt, admission };
          });
          for (const [index, { receipt, admission }] of admissions.entries()) {
            pending--; if (receipt.complete) reported++;
            admission.settle(receipt);
            checkpoints.push({ role, settled: start + index + 1, notices: noticeCount });
          }
        }
      }),
    };
  };
  return { open, notices, checkpoints, opened, interrupted, denied };
}

function reviewerQuoteSessions(options: { activeFeedback?: boolean; validFirst?: boolean;
  verdict?: 'unknown' | 'changes_requested'; accounting?: 'upstream' | 'native'; missingUsage?: boolean;
  tamperInput?: boolean } = {}) {
  const verdict = options.verdict ?? 'unknown', agent = preset({ verdicts: [verdict, verdict] });
  const visits: { role: string; threadId: string; closed: boolean; messages: string[]; messageIds: string[];
    turnIds: string[]; protocolBytes: string[][]; validOutputs: string[]; feedback: string[] }[] = [];
  const open = async (config: MathAgentOptions): Promise<MathAgentSession> => {
    const role = path.basename(config.workspace), native = options.accounting === 'native';
    const visit = { role, threadId: '', closed: false, messages: [] as string[], messageIds: [] as string[],
      turnIds: [] as string[], protocolBytes: [] as string[][], validOutputs: [] as string[], feedback: [] as string[] };
    const base = await agent.open({ ...config, onUsage: usage => {
      if (native && options.missingUsage && role === 'compare-reviewer-2') return;
      config.onUsage({ ...usage, totalTokens: visit.messages.length });
    } });
    visit.threadId = base.threadId; visits.push(visit);
    return { ...base, usageSource: native ? 'native-thread-totals' : 'upstream-requests',
      close: async () => { visit.closed = true; await base.close(); },
      run: async (message, id, workspace, onStarted) => {
        expect(visit.closed).toBe(false); expect(workspace).toBe(config.workspace);
        visit.messages.push(message); visit.messageIds.push(id);
        const turn = visit.messages.length, turnId = base.threadId + '-turn-' + turn;
        visit.turnIds.push(turnId);
        visit.protocolBytes.push(['INPUT.json', 'ROLE.md', 'OUTPUT.schema.json']
          .map(file => readMathText(path.join(workspace, file))));
        const status = await base.run(message, id, workspace, () => {
          onStarted(turnId);
          if (native) return;
          const admission = config.requestGate!({ requestId: turnId, source: 'responses-relay' });
          if (!admission.allowed) throw new Error(admission.reason);
          admission.settle(options.missingUsage && role === 'compare-reviewer-2' ?
            { complete: false, outcome: 'completed', missingReason: 'provider-usage-missing' } : completeRequest);
        });
        const file = path.join(workspace, 'OUTPUT.json'), valid = readMathText(file);
        visit.validOutputs.push(valid);
        if (role !== 'compare-reviewer-2' || turn !== 1 || options.validFirst) return status;
        const invalid = JSON.parse(valid);
        invalid.correspondences[0].candidateFragment = '@Eq Nat (Nat.add n 0) n';
        const invalidText = JSON.stringify(invalid); fs.writeFileSync(file, invalidText);
        let error: unknown;
        try { config.completedOutput!.validate(invalid); } catch (cause) { error = cause; }
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('formalization_review_fragment_not_found');
        if (options.tamperInput) {
          const input = path.join(workspace, 'INPUT.json');
          fs.chmodSync(input, 0o600); fs.appendFileSync(input, '\n');
        }
        if (!options.activeFeedback) return 'completed';
        const feedback = config.completedOutput!.validationFeedback!(error, { text: invalidText, turnId });
        expect(feedback).toContain('formalization_review_fragment_not_found'); visit.feedback.push(feedback);
        fs.writeFileSync(file, valid); config.completedOutput!.validate(JSON.parse(valid));
        return 'submitted';
      },
    };
  };
  return { open, visits, seen: agent.seen };
}

const elaborate: NonNullable<Parameters<typeof runFormalization>[2]>['elaborate'] =
  async (_directory, source, environment, options) => {
    const result = syntheticElaboration(source, environment, options);
    if (environment !== 'mathlib') return result;
    // The shared helper models standard Lean. Mathlib additionally records its
    // installed package override, so bind a disposable synthetic receipt here.
    const diagnostics = result.compilation.diagnostics;
    diagnostics.latest.configuration.find(item => item.file === '.lake/package-overrides.json')!.digest =
      mathDigest('synthetic installed Mathlib override');
    const sourceDigest = mathDigest(JSON.stringify([diagnostics.latest.configuration.map(item => item.digest ?? ''),
      diagnostics.latest.sourceFiles.map(item => [item.file, item.digest])]));
    diagnostics.sourceDigest = sourceDigest; diagnostics.latest.sourceDigest = sourceDigest;
    for (const [index, record] of diagnostics.artifactRecords.entries()) {
      const artifact = JSON.parse(record.text); artifact.sourceDigest = sourceDigest;
      record.text = canonicalMathJson(artifact); record.digest = mathDigest(record.text);
      const reference = diagnostics.diagnosticArtifacts[index]!;
      reference.sourceDigest = sourceDigest; reference.digest = record.digest;
      reference.path = 'compilation-artifacts/' + record.digest + '.json';
    }
    return result;
  };

describe('source planning and sealed package preparation', () => {
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(yes => { resolve = yes; });
    return { promise, resolve };
  }
  const overrides = { environment: 'mathlib', execution: 'model', fidelityPolicy: 'task-preserving-v2' };

  it('warms packages when the web activity recorder wraps the real session factory', async () => {
    const f = fixture(undefined, overrides), agent = preset({ verdicts: ['unknown', 'unknown'] });
    const warm = vi.spyOn(sandboxRuntime, 'warmFormalizationPackages').mockResolvedValue();
    try {
      const result = await runFormalization(f.directory, f.root, { openSession: options => agent.open(options), elaborate });
      expect(result.error).toContain('formalization_semantic_unknown');
      expect(warm).toHaveBeenCalledOnce();
      expect(warm.mock.calls[0][0]).toBe('mathlib');
    } finally { warm.mockRestore(); }
  });

  it('runs source planning during preparation and waits before generation', async () => {
    const f = fixture(undefined, overrides), ready = deferred(), planned = deferred();
    const agent = preset({ verdicts: ['unknown', 'unknown'] });
    let preparationCalls = 0;
    const running = runFormalization(f.directory, f.root, { openSession: agent.open, elaborate,
      preparePackages: async (environment, options) => {
        preparationCalls++; expect(environment).toBe('mathlib');
        expect(options.signal?.aborted).toBe(false); expect(options.deadlineAt).toBeGreaterThan(Date.now());
        await ready.promise;
      }, onEvent: e => { if (e.event === 'formalization_role_finished' && e.role === 'plan') planned.resolve(); },
    });
    try {
      await planned.promise;
      expect(preparationCalls).toBe(1); expect(agent.seen.map(item => item.role)).toEqual(['plan-1']);
      expect(agent.seen[0].config.readIsolation).toEqual({ environment: 'mathlib', packages: 'none' });
      expect(agent.seen[0].config.instructions).toContain('no Mathlib packages; /opt/lean-packages is not mounted');
      ready.resolve();
      const result = await running;
      expect(result.status).toBe('exhausted'); expect(result.error).toContain('formalization_semantic_unknown');
      expect(agent.seen.find(item => item.role === 'generate')!.config.readIsolation).toEqual({ environment: 'mathlib' });
    } finally { ready.resolve(); await running; }
  });

  it('retains library access for a repair plan that must resolve a missing meaning', async () => {
    const f = fixture(undefined, overrides), ready = deferred(), planned = deferred();
    const agent = preset({ verdicts: ['unknown', 'unknown'], afterOutput: role => {
      if (role !== 'plan-1') return;
      const file = path.join(agent.seen.at(-1)!.config.workspace, 'OUTPUT.json');
      const output = JSON.parse(fs.readFileSync(file, 'utf8'));
      output.unresolved.push({ id: 'inspect-library', spanIds: ['source'], description: 'A specialized meaning needs pinned library inspection.' });
      fs.writeFileSync(file, JSON.stringify(output));
    } });
    const running = runFormalization(f.directory, f.root, { openSession: agent.open, elaborate,
      preparePackages: async () => { await ready.promise; },
      onEvent: e => { if (e.event === 'formalization_role_finished' && e.role === 'plan') planned.resolve(); },
    });
    try {
      await planned.promise;
      expect(agent.seen.map(item => item.role)).toEqual(['plan-1']);
      ready.resolve(); await running;
      const repaired = agent.seen.find(item => item.role === 'plan-2')!;
      expect(repaired.input.feedback).toContain('formalization_plan_unresolved');
      expect(repaired.config.readIsolation).toEqual({ environment: 'mathlib' });
      expect(repaired.config.instructions).toContain('pinned Mathlib and dependencies are in /opt/lean-packages');
    } finally { ready.resolve(); await running; }
  });

  it.each(['cancel', 'unresolved'] as const)('joins and releases preparation when planning ends with %s', async mode => {
    const f = fixture(workflow => { workflow.maxPlanningRounds = 1; }, overrides);
    const controller = new AbortController(), planned = deferred();
    const agent = preset({ unresolved: mode === 'unresolved' });
    let released = false;
    const running = runFormalization(f.directory, f.root, { openSession: agent.open, elaborate, signal: controller.signal,
      preparePackages: async (_environment, options) => {
        await new Promise<void>((_resolve, reject) => options.signal!.addEventListener('abort', () => {
          released = true; reject(new Error('preparation cancelled'));
        }, { once: true }));
      }, onEvent: e => { if (e.event === 'formalization_role_finished' && e.role === 'plan') planned.resolve(); },
    });
    await planned.promise;
    if (mode === 'cancel') controller.abort();
    const result = await running;
    expect(released).toBe(true); expect(agent.seen.map(item => item.role)).toEqual(['plan-1']);
    expect(result.status).toBe(mode === 'cancel' ? 'stopped' : 'exhausted');
  });
});

describe('fidelity role context and submission reminders', () => {
  it('delivers each small frozen input and schema in the first message while keeping backtranslation blind', async () => {
    const statement = fixtureStatement + '\nSource tag: "原题🙂" \\n';
    const f = fixture(undefined, { statement, fidelityPolicy: 'task-preserving-v2' });
    const agent = preset({ verdicts: ['unknown', 'unknown'] });
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate });
    expect(result.status).toBe('exhausted'); expect(result.error).toContain('formalization_semantic_unknown');
    expect(agent.seen.map(item => item.role)).toEqual(['plan-1', 'generate', 'backtranslate', 'compare-reviewer-1', 'compare-reviewer-2']);
    for (const { config, input, message } of agent.seen) {
      const inputText = readMathText(path.join(config.workspace, 'INPUT.json'));
      const schemaText = readMathText(path.join(config.workspace, 'OUTPUT.schema.json'));
      expect(Buffer.byteLength(inputText) + Buffer.byteLength(schemaText)).toBeLessThanOrEqual(64 * 1024);
      expect(message.match(/\nBEGIN INPUT\.json\n([\s\S]*?)\nEND INPUT\.json\n/u)?.[1]).toBe(inputText);
      expect(message.match(/\nBEGIN OUTPUT\.schema\.json\n([\s\S]*?)\nEND OUTPUT\.schema\.json$/u)?.[1]).toBe(schemaText);
      expect(JSON.parse(inputText)).toEqual(input);
      expect(message).toContain('shared with generation, Lean compilation, backtranslation and independent review');
    }
    const blind = agent.seen.find(item => item.role === 'backtranslate')!;
    const planner = agent.seen.find(item => item.role === 'plan-1')!;
    const protocol = readMathText(path.join(planner.config.workspace, 'ROLE.md'));
    expect(protocol).toContain('explicitly construct a witness and prove its stated properties');
    expect(protocol).toContain('never relabel an unsupported task merely to pass admission');
    const sourceSpan = JSON.parse(protocol.match(/^HOST_SOURCE_SPAN=(.+)$/mu)![1]);
    expect(sourceSpan).toEqual({ id: 'source', start: 0, end: statement.length, text: statement });
    expect(statement.slice(sourceSpan.start, sourceSpan.end)).toBe(statement);
    expect(protocol).not.toContain('Parse INPUT.json with Python');
    expect(protocol).not.toContain('the checker relates a candidate to a reference only');
    expect(protocol).toContain('directions of equivalence and boundary cases');
    expect(readMathText(path.join(blind.config.workspace, 'ROLE.md'))).not.toContain('HOST_SOURCE_SPAN');
    for (const hidden of [statement, JSON.stringify(statement), 'Source tag:', 'zero-identity'])
      expect(blind.message).not.toContain(hidden);
    expect(blind.input).not.toHaveProperty('statement'); expect(blind.input).not.toHaveProperty('plan');
    expect(fs.existsSync(path.join(f.directory, 'artifact'))).toBe(false);
  });

  it.each([32_000, 32_001])('only supplies a full-source span that fits candidate coverage at %i code units', async length => {
    const statement = 'x'.repeat(length - fixtureStatement.length) + fixtureStatement;
    const f = fixture(workflow => { workflow.maxPlanningRounds = 1; }, { statement, fidelityPolicy: 'task-preserving-v2' });
    const agent = preset({ unresolved: true });
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate });
    expect(result.status).toBe('exhausted'); expect(result.error).toContain('formalization_plan_unresolved');
    expect(agent.seen).toHaveLength(1);
    const protocol = readMathText(path.join(agent.seen[0]!.config.workspace, 'ROLE.md'));
    expect(protocol.includes('HOST_SOURCE_SPAN=')).toBe(length === 32_000);
    expect(protocol.includes('Parse INPUT.json with Python')).toBe(length > 32_000);
  });

  it.each([
    ['ASCII', 'x'.repeat(70 * 1024)], ['multibyte', '汉'.repeat(22 * 1024)],
  ])('keeps the complete %s input in its file when inline context exceeds 64 KiB', async (_kind, padding) => {
    const statement = 'large-source-start\n' + padding + '\nlarge-source-end\n' + fixtureStatement;
    const f = fixture(workflow => { workflow.maxPlanningRounds = 1; }, { statement, fidelityPolicy: 'task-preserving-v2' });
    const agent = preset({ unresolved: true });
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate });
    expect(result.status).toBe('exhausted'); expect(result.error).toContain('formalization_plan_unresolved');
    expect(agent.seen).toHaveLength(1);
    const { config, input, message } = agent.seen[0]!;
    const inputText = readMathText(path.join(config.workspace, 'INPUT.json'));
    const schemaText = readMathText(path.join(config.workspace, 'OUTPUT.schema.json'));
    expect(Buffer.byteLength(inputText) + Buffer.byteLength(schemaText)).toBeGreaterThan(64 * 1024);
    if (_kind === 'multibyte') expect(inputText.length + schemaText.length).toBeLessThan(64 * 1024);
    expect(JSON.parse(inputText).statement).toBe(statement); expect(input.statement).toBe(statement);
    expect(message).toContain('INPUT.json'); expect(message).toContain('OUTPUT.schema.json');
    expect(message).not.toContain('BEGIN INPUT.json');
    expect(message.match(/\nBEGIN OUTPUT\.schema\.json\n([\s\S]*?)\nEND OUTPUT\.schema\.json/u)?.[1]).toBe(schemaText);
    expect(message).not.toContain('large-source-start'); expect(message).not.toContain('large-source-end');
    expect(readMathText(path.join(config.workspace, 'ROLE.md'))).not.toContain('HOST_SOURCE_SPAN');
    expect(fs.existsSync(path.join(f.directory, 'artifact'))).toBe(false);
  });

  it('inlines exact target navigation and schema while retaining all large raw observations', async () => {
    const statement = fixtureStatement + '\nOriginal-only marker 原题🙂';
    const f = fixture(undefined, { statement, fidelityPolicy: 'task-preserving-v2' });
    const agent = preset({ verdicts: ['unknown', 'unknown'], additionalTargets: ['addition_copy_one', 'addition_copy_two'] });
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open,
      elaborate: async (...args) => {
        const result = await elaborate!(...args);
        for (const target of result.snapshot.targets)
          target.context.constants = Array.from({ length: 20 }, (_, index) => ({
            name: 'ObservedConstant' + index, module: 'Init', type: 'Nat',
            definition: 'complete-definition-' + crypto.randomBytes(8200).toString('base64'),
          }));
        result.snapshotDigest = formalizationDigest(result.snapshot);
        return result;
      },
    });
    expect(result.error).toContain('formalization_semantic_unknown');
    for (const role of ['backtranslate', 'compare-reviewer-1', 'compare-reviewer-2']) {
      const seen = agent.seen.find(item => item.role === role)!;
      const input = JSON.parse(readMathText(path.join(seen.config.workspace, 'INPUT.json')));
      const snapshot = role === 'backtranslate' ? input : input.observation.snapshot;
      expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(512 * 1024);
      expect(seen.message).not.toContain('BEGIN INPUT.json');
      const index = JSON.parse(seen.message.match(/\nBEGIN SNAPSHOT INDEX\n([\s\S]*?)\nEND SNAPSHOT INDEX/u)![1]);
      expect(index.snapshotDigest).toBe(role === 'backtranslate' ? input.snapshotDigest : input.observation.snapshotDigest);
      expect(index.source).toBe(snapshot.source);
      expect(seen.config.instructions).toContain('iterate context.structures.entries');
      expect(seen.config.instructions).toContain('INPUT.translation, outside the snapshot');
      expect(index.targets.map((item: any) => item.name)).toEqual(snapshot.targets.map((target: any) => target.name));
      expect(index.targets[0].type).toBe(snapshot.targets[0].context.type);
      expect(index.targets[0].bindings).toEqual(snapshot.targets[0].context.bindings);
      expect(index.targets[0].omitted).toEqual(snapshot.targets[0].context.omitted);
      expect(index.targets[0].remainingFields).toContainEqual({
        path: (role === 'backtranslate' ? '$' : '$.observation.snapshot') + '.targets[0].context.constants',
        bytes: Buffer.byteLength(canonicalMathJson(snapshot.targets[0].context.constants)),
      });
      expect(snapshot.targets[0].context.constants).toHaveLength(20);
      expect(snapshot.targets[0].context.constants[19].definition).toMatch(/^complete-definition-[A-Za-z0-9+/]+=*$/u);
      expect(seen.message).toContain('BEGIN OUTPUT.schema.json');
    }
    const blind = agent.seen.find(item => item.role === 'backtranslate')!;
    expect(blind.message).not.toContain('Original-only marker'); expect(blind.input).not.toHaveProperty('original');
  });

  it.each([
    [4096, []], [11000, ['addition_copy_one', 'addition_copy_two']],
  ] as const)('shares complete review observations with %i-byte definitions losslessly in the first message', async (length, additionalTargets) => {
    const statement = fixtureStatement + '\nOriginal-only marker 原题🙂';
    const f = fixture(undefined, { statement, fidelityPolicy: 'task-preserving-v2' });
    const agent = preset({ verdicts: ['unknown', 'unknown'], additionalTargets });
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open,
      elaborate: async (...args) => {
        const result = await elaborate!(...args);
        for (const target of result.snapshot.targets)
          target.context.constants = Array.from({ length: 20 }, (_, index) => ({
            name: 'ObservedConstant' + index, module: 'Init', type: 'Nat', definition: 'complete-definition-' + 'x'.repeat(length),
          }));
        result.snapshotDigest = formalizationDigest(result.snapshot);
        return result;
      },
    });
    expect(result.error).toContain('formalization_semantic_unknown');
    for (const role of ['backtranslate', 'compare-reviewer-1', 'compare-reviewer-2']) {
      const seen = agent.seen.find(item => item.role === role)!;
      const inputText = readMathText(path.join(seen.config.workspace, 'INPUT.json'));
      const schemaText = readMathText(path.join(seen.config.workspace, 'OUTPUT.schema.json'));
      const bytes = Buffer.byteLength(inputText) + Buffer.byteLength(schemaText);
      expect(bytes).toBeGreaterThan(64 * 1024);
      expect(bytes > 512 * 1024).toBe(length === 11000);
      const transport = JSON.parse(seen.message.match(/\nBEGIN SHARED INPUT\.json\n([\s\S]*?)\nEND SHARED INPUT\.json\n/u)![1]);
      expect(transport.schema).toBe('theorem-os.formalization-shared-context.v1');
      expect(transport.canonicalInputSha256).toBe(mathDigest(inputText));
      // Independently consume the documented wire representation, including backward references.
      const expanded: unknown[] = [];
      const decode = (value: any): any => {
        if (Array.isArray(value)) return value.map(decode);
        if (value && typeof value === 'object') {
          if (Object.keys(value).length === 1 && Object.hasOwn(value, '$ref')) {
            expect(Number.isSafeInteger(value.$ref) && value.$ref >= 0 && value.$ref < expanded.length).toBe(true);
            return expanded[value.$ref];
          }
          return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, decode(child)]));
        }
        return value;
      };
      for (const entry of transport.dictionary) expanded.push(decode(entry));
      expect(canonicalMathJson(decode(transport.input))).toBe(inputText);
      expect(Buffer.byteLength(JSON.stringify(transport))).toBeLessThan(Buffer.byteLength(inputText) / 2);
      expect(seen.config.instructions).toContain('checked byte-for-byte equality');
      expect(seen.message.match(/\nBEGIN OUTPUT\.schema\.json\n([\s\S]*?)\nEND OUTPUT\.schema\.json$/u)?.[1]).toBe(schemaText);
      expect(seen.message).toContain('complete-definition-' + 'x'.repeat(length));
      expect(seen.message).not.toContain('BEGIN SNAPSHOT INDEX');
    }
    const blind = agent.seen.find(item => item.role === 'backtranslate')!;
    expect(blind.message).not.toContain('Original-only marker'); expect(blind.input).not.toHaveProperty('original');
    expect(fs.existsSync(path.join(f.directory, 'artifact'))).toBe(false);
  });

  it.each([false, true])('keeps focused review input complete and selects file navigation when oversized=%s', async oversized => {
    const statement = fixtureStatement + '\nOriginal-only marker 原题🙂';
    const f = fixture(undefined, { statement, fidelityPolicy: 'task-preserving-v2' });
    const agent = preset({ verdicts: ['unknown', 'unknown'],
      additionalTargets: oversized ? ['additionSecond', 'additionThird', 'additionFourth'] : [] });
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open,
      elaborate: async (...args) => {
        const result = await elaborate!(...args);
        for (const target of result.snapshot.targets) {
          target.context.references = { statement: [], proof: [] };
          target.context.constants = Array.from({ length: 20 }, (_, index) => ({
            name: index === 0 ? 'True' : 'ObservedConstant' + index, module: 'Init', type: 'Prop',
            definition: 'complete-definition-' + crypto.randomBytes(3500).toString('base64'),
          }));
          if (oversized) target.context.semantic!.rawType += crypto.randomBytes(100000).toString('base64');
        }
        result.snapshotDigest = formalizationDigest(result.snapshot); return result;
      },
    });
    expect(result.error).toContain('formalization_semantic_unknown');
    for (const role of ['backtranslate', 'compare-reviewer-1', 'compare-reviewer-2']) {
      const seen = agent.seen.find(item => item.role === role)!;
      const inputText = readMathText(path.join(seen.config.workspace, 'INPUT.json')), input = JSON.parse(inputText);
      const original = role === 'backtranslate' ? input : input.observation.snapshot;
      if (oversized) {
        expect(seen.message).not.toContain('BEGIN REVIEW CONTEXT');
        expect(seen.config.instructions).toContain('First list target indices and names');
        expect(seen.config.instructions).not.toContain('Use the supplied reading view and exact output schema directly');
        expect(seen.config.instructions).toContain('theorem-os.formalization-review-context.v3');
        continue;
      }
      expect(seen.config.instructions).toContain('Use the supplied reading view and exact output schema directly');
      expect(seen.config.instructions).not.toContain('First list target indices and names');
      const packet = JSON.parse(seen.message.match(/\nBEGIN REVIEW CONTEXT\n([\s\S]*?)\nEND REVIEW CONTEXT/u)![1]);
      const view = role === 'backtranslate' ? packet.input : packet.input.observation.snapshot;
      expect(packet.canonicalInputSha256).toBe(mathDigest(inputText));
      expect(view.source).toBe(original.source); expect(view.targets[0].context.semantic).toEqual(original.targets[0].context.semantic);
      expect(view.targets[0].context.bindings).toEqual(original.targets[0].context.bindings);
      const library = view.targets[0].context.importedLibrary;
      expect(packet.schema).toBe('theorem-os.formalization-review-context.v3');
      expect(library.constants.count).toBe(20);
      expect(library.constants.directEntries).toHaveLength(1);
      expect(packet.libraryCatalog.constants[library.constants.directEntries[0].catalogIndex].definition).toBe(original.targets[0].context.constants[0].definition);
      expect(seen.message).not.toContain('ObservedConstant19');
      expect(original.targets[0].context.constants[19].definition).toMatch(/^complete-definition-/u);
      expect(seen.config.instructions).toContain('Read all fields of a relevant structure');
      expect(seen.message).not.toContain('complete lossless shared input');
      expect(seen.message).not.toContain('BEGIN SNAPSHOT INDEX');
    }
    const blind = agent.seen.find(item => item.role === 'backtranslate')!;
    expect(blind.message).not.toContain('Original-only marker'); expect(blind.input).not.toHaveProperty('original');
    expect(new Set(agent.seen.map(item => item.config.workspace)).size).toBe(5);
  });

  it.each(['unknown', 'changes_requested'] as const)(
    'reminds planning and each reviewer after a settled request and preserves a %s verdict', async verdict => {
      const f = fixture(workflow => { workflow.reviewScheduling = 'parallel'; },
        { fidelityPolicy: 'task-preserving-v2', maxTotalTokens: 100 });
      const agent = preset({ verdicts: [verdict, verdict] }), provider = withProviderRequests(agent);
      const result = await runFormalization(f.directory, f.root, { openSession: provider.open, elaborate });
      expect(result.status).toBe('exhausted'); expect(result.error).toContain('formalization_semantic_' + verdict);
      expect(result.roleTurns).toMatchObject({ plan: 1, generate: 1, backtranslate: 1, compare: 2 });
      expect(provider.notices).toEqual([
        { role: 'plan-1', reported: 1, pending: 0, waitForRequest: true },
        { role: 'backtranslate', reported: 3, pending: 0, waitForRequest: true },
        { role: 'compare-reviewer-1', reported: 1, pending: 0, waitForRequest: true },
        { role: 'compare-reviewer-2', reported: 1, pending: 0, waitForRequest: true },
      ]);
      expect(provider.checkpoints.filter(item => item.role === 'plan-1').map(item => item.notices)).toEqual([1, 1, 1, 1, 1]);
      expect(provider.checkpoints.filter(item => item.role === 'backtranslate').map(item => item.notices)).toEqual([0, 0, 1, 1, 1]);
      for (const role of ['compare-reviewer-1', 'compare-reviewer-2'])
        expect(provider.checkpoints.filter(item => item.role === role).map(item => item.notices)).toEqual([1, 1, 1, 1, 1]);
      expect(provider.checkpoints.filter(item => item.role === 'generate').every(item => item.notices === 0)).toBe(true);
      expect(provider.denied).toEqual([]); expect(provider.interrupted).toEqual([]);
      const state = readFormalizationState(f.directory);
      expect(state.sessions).toHaveLength(5);
      for (const session of state.sessions) expect(session.requestUsageAccounting).toMatchObject({
        startedRequests: 5, reportedRequests: 5, pendingRequests: 0, incomplete: false,
      });
      const reviews = state.sessions.filter(item => item.role === 'compare');
      expect(reviews.map(item => item.reviewerId)).toEqual(['reviewer-1', 'reviewer-2']);
      expect(new Set(reviews.map(item => item.threadId)).size).toBe(2);
      const round = fs.readdirSync(f.directory).find(name => name.startsWith('round-'))!;
      const saved = JSON.parse(readMathText(path.join(f.directory, round, 'reviews.json')));
      expect(saved.reviews.map(item => item.review.verdict)).toEqual([verdict, verdict]);
      expect(fs.existsSync(path.join(f.directory, 'artifact'))).toBe(false);
      expect(fs.existsSync(path.join(f.directory, 'workspace'))).toBe(false);
    });

  it('waits for every pending request before reminding each independent reviewer', async () => {
    const f = fixture(workflow => { workflow.reviewScheduling = 'parallel'; },
      { fidelityPolicy: 'task-preserving-v2', maxTotalTokens: 100 });
    const provider = withProviderRequests(preset({ verdicts: ['unknown', 'unknown'] }),
      Array.from({ length: 5 }, () => completeRequest), 5);
    const result = await runFormalization(f.directory, f.root, { openSession: provider.open, elaborate });
    expect(result.error).toContain('formalization_semantic_unknown');
    const reviewers = provider.notices.filter(item => item.role.startsWith('compare-'));
    expect(reviewers).toEqual(['compare-reviewer-1', 'compare-reviewer-2'].map(role =>
      ({ role, reported: 5, pending: 0, waitForRequest: true })));
    for (const role of ['compare-reviewer-1', 'compare-reviewer-2'])
      expect(provider.checkpoints.filter(item => item.role === role).map(item => item.notices)).toEqual([0, 0, 0, 0, 1]);
    expect(provider.interrupted).toEqual([]); expect(provider.denied).toEqual([]);
    expect(fs.existsSync(path.join(f.directory, 'artifact'))).toBe(false);
  });

  it('withholds reminders while requests are pending and stops after a receipt loses usage', async () => {
    const f = fixture(undefined, { fidelityPolicy: 'task-preserving-v2', maxTotalTokens: 100 }), agent = preset();
    const provider = withProviderRequests(agent, [completeRequest, completeRequest, completeRequest,
      { complete: false, outcome: 'completed', missingReason: 'provider-usage-missing' }, completeRequest], 4);
    const result = await runFormalization(f.directory, f.root, { openSession: provider.open, elaborate });
    expect(result).toMatchObject({ status: 'stopped', error: 'math_model_usage_unavailable' });
    expect(provider.opened).toEqual(['plan-1']); expect(provider.notices).toEqual([]);
    expect(provider.checkpoints.map(item => item.notices)).toEqual([0, 0, 0, 0]);
    expect(provider.denied).toEqual(['math_model_usage_unavailable']);
    expect(readFormalizationState(f.directory).sessions[0].requestUsageAccounting).toMatchObject({
      startedRequests: 4, reportedRequests: 3, pendingRequests: 0, incomplete: true,
    });
    expect(fs.existsSync(path.join(f.directory, 'artifact'))).toBe(false);
  });

  it('stops for the shared token allowance before sending a first-request reminder', async () => {
    const f = fixture(undefined, { fidelityPolicy: 'task-preserving-v2', maxTotalTokens: 1 }), agent = preset();
    const provider = withProviderRequests(agent);
    const result = await runFormalization(f.directory, f.root, { openSession: provider.open, elaborate });
    expect(result).toMatchObject({ status: 'stopped', error: 'math_total_token_limit' });
    expect(provider.opened).toEqual(['plan-1']); expect(provider.notices).toEqual([]);
    expect(provider.interrupted).toContain('plan-1'); expect(provider.denied).toEqual(['math_model_request_stopped']);
    expect(readFormalizationState(f.directory).sessions[0].requestUsageAccounting).toMatchObject({
      startedRequests: 1, reportedRequests: 1, pendingRequests: 0, incomplete: false,
    });
    expect(fs.existsSync(path.join(f.directory, 'artifact'))).toBe(false);
  });
});

describe('same-thread reviewer output correction', () => {
  it.each([
    ['completed upstream turn', false, 'upstream', 2],
    ['completed native turn', false, 'native', 2],
    ['active upstream turn', true, 'upstream', 1],
  ] as const)('repairs an invalid quote from a %s without rerunning another role', async (_name, activeFeedback, accounting, turns) => {
    const f = fixture(workflow => { workflow.reviewScheduling = 'parallel'; },
      { fidelityPolicy: 'task-preserving-v2', maxTotalTokens: 100 });
    const agent = reviewerQuoteSessions({ activeFeedback, accounting });
    const repairs: string[] = [];
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate,
      onEvent: event => { if (event.event === 'formalization_review_output_repairing') repairs.push(event.error!); } });
    expect(result).toMatchObject({ status: 'exhausted', rounds: 1, candidatesTried: 1,
      roleTurns: { plan: 1, generate: 1, backtranslate: 1, compare: 1 + turns } });
    expect(result.error).toContain('formalization_semantic_unknown');
    expect(result.error).not.toContain('formalization_review_fragment_not_found');
    expect(agent.visits.map(visit => visit.role)).toEqual(['plan-1', 'generate', 'backtranslate', 'compare-reviewer-1', 'compare-reviewer-2']);
    expect(new Set(agent.visits.map(visit => visit.threadId)).size).toBe(5);
    const repaired = agent.visits.find(visit => visit.role === 'compare-reviewer-2')!;
    for (const visit of agent.visits) {
      expect(visit.closed).toBe(true);
      expect(visit.messages).toHaveLength(visit === repaired ? turns : 1);
      for (const protocol of visit.protocolBytes) expect(protocol).toEqual(visit.protocolBytes[0]);
    }
    expect(new Set(repaired.messageIds).size).toBe(turns);
    expect(new Set(repaired.turnIds).size).toBe(turns);
    if (activeFeedback) {
      expect(repaired.feedback).toHaveLength(1); expect(repairs).toEqual([]);
    } else {
      expect(repaired.messages[1]).toContain('formalization_review_fragment_not_found');
      expect(repaired.feedback).toEqual([]); expect(repairs).toHaveLength(1);
    }
    const state = readFormalizationState(f.directory), review = state.sessions.find(item => item.reviewerId === 'reviewer-2')!;
    expect(review).toMatchObject({ threadId: repaired.threadId, turnId: repaired.turnIds.at(-1), turns,
      usage: { totalTokens: turns }, usageAccounting: { startedTurns: turns, reportedTurns: turns, pending: false, incomplete: false } });
    expect(review.inputDigest).toBe(formalizationDigest(JSON.parse(repaired.protocolBytes[0][0])));
    expect(review.outputDigest).toBe(formalizationDigest(JSON.parse(repaired.validOutputs.at(-1)!)));
    expect(result.tokenBudget).toMatchObject({ reportedTotalTokens: 4 + turns, usageComplete: true });
    if (accounting === 'upstream') expect(review.requestUsageAccounting).toMatchObject({
      startedRequests: turns, reportedRequests: turns, pendingRequests: 0, incomplete: false,
    });
    else expect(review.requestUsageAccounting).toBeUndefined();
    expect(state.sessions.filter(item => item.role === 'compare')).toHaveLength(2);
    expect(fs.existsSync(path.join(f.directory, 'artifact'))).toBe(false);
  });

  it('keeps valid changes_requested judgments without a correction turn and still calls both reviewers', async () => {
    const f = fixture(workflow => { workflow.reviewScheduling = 'parallel'; },
      { fidelityPolicy: 'task-preserving-v2', maxTotalTokens: 100 });
    const agent = reviewerQuoteSessions({ validFirst: true, verdict: 'changes_requested' });
    const repairs: string[] = [];
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate,
      onEvent: event => { if (event.event === 'formalization_review_output_repairing') repairs.push(event.role!); } });
    expect(result.status).toBe('exhausted'); expect(result.error).toContain('formalization_semantic_changes_requested');
    expect(agent.visits).toHaveLength(5); expect(agent.visits.every(visit => visit.messages.length === 1)).toBe(true);
    const reviews = agent.visits.filter(visit => visit.role.startsWith('compare-'));
    expect(reviews.map(visit => visit.role)).toEqual(['compare-reviewer-1', 'compare-reviewer-2']);
    expect(reviews.map(visit => JSON.parse(visit.validOutputs[0]).verdict)).toEqual(['changes_requested', 'changes_requested']);
    expect(repairs).toEqual([]); expect(fs.existsSync(path.join(f.directory, 'artifact'))).toBe(false);
  });

  it.each([
    ['missing upstream usage', 'upstream', true, 100, 'math_model_usage_unavailable'],
    ['missing native usage', 'native', true, 100, 'math_model_usage_unavailable'],
    ['spent shared budget', 'upstream', false, 5, 'math_total_token_limit'],
  ] as const)('stops correction before another call after %s', async (_name, accounting, missingUsage, maxTotalTokens, error) => {
    const f = fixture(workflow => { workflow.reviewScheduling = 'parallel'; },
      { fidelityPolicy: 'task-preserving-v2', maxTotalTokens });
    const agent = reviewerQuoteSessions({ accounting, missingUsage });
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate });
    expect(result).toMatchObject({ status: 'stopped', error });
    expect(agent.visits).toHaveLength(5); expect(agent.visits.every(visit => visit.messages.length === 1)).toBe(true);
    const repaired = readFormalizationState(f.directory).sessions.find(item => item.reviewerId === 'reviewer-2')!;
    expect(repaired.turns).toBe(1); expect(repaired.usageAccounting.startedTurns).toBe(1);
    expect(fs.existsSync(path.join(f.directory, 'artifact'))).toBe(false);
  });

  it('rejects changed frozen reviewer input instead of starting a correction turn', async () => {
    const f = fixture(workflow => { workflow.reviewScheduling = 'parallel'; },
      { fidelityPolicy: 'task-preserving-v2', maxTotalTokens: 100 });
    const agent = reviewerQuoteSessions({ tamperInput: true });
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate });
    expect(result.error).toBe('formalization_role_contract_changed');
    expect(agent.visits).toHaveLength(5); expect(agent.visits.every(visit => visit.messages.length === 1)).toBe(true);
    expect(fs.existsSync(path.join(f.directory, 'artifact'))).toBe(false);
  });
});

describe('parallel review retries after a validated revision request', () => {
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  }
  // Drain the completed review's promise chain, including host validation,
  // before releasing its peer. This advances an event-loop turn, not a timer.
  const afterValidation = () => new Promise<void>(resolve => setImmediate(resolve));
  const transient: MathAgentFailureDiagnostic = { code: 'other', reason: 'upstream_request_failed' };

  function setup(options: Parameters<typeof preset>[0] = {}, maxRounds = 1, reviewerCount = 2) {
    // Reuse an authentic saved comparison only for its exact complete input;
    // scheduling tests must never launch Lean or manufacture an acceptance.
    const saved = JSON.parse(gunzipSync(fs.readFileSync(
      new URL('./fixtures/web-formalization-fidelity-v2.json.gz', import.meta.url))).toString());
    const f = fixture(workflow => {
      workflow.reviewScheduling = 'parallel'; workflow.maxPlanningRounds = 0;
      if (reviewerCount === 3) workflow.reviewers.push({ ...workflow.reviewers[1], id: 'reviewer-3' });
    }, { fidelityPolicy: 'task-preserving-v2', maxRounds, maxRunSeconds: 0, maxTurnSeconds: 0,
      maxCompileSeconds: 0, maxTotalTokens: 0 });
    const agent = preset({ ...options, candidateSource: saved.input.candidateSource }), firstFinished = deferred();
    const compareReference = vi.fn(async (_directory: string, input: unknown) => {
      expect(input).toEqual(saved.input); return structuredClone(saved.result);
    });
    const onEvent: NonNullable<Parameters<typeof runFormalization>[2]>['onEvent'] = event => {
      if (event.event === 'formalization_role_finished' && event.role === 'compare' &&
          readFormalizationState(f.directory).sessions.some(session => session.round === 1 &&
            session.reviewerId === 'reviewer-1' && session.status === 'completed')) firstFinished.resolve();
    };
    const readReviews = (round: number) => {
      const name = fs.readdirSync(f.directory).find(name => name.startsWith(`round-${String(round).padStart(2, '0')}-`))!;
      return JSON.parse(readMathText(path.join(f.directory, name, 'reviews.json')));
    };
    return { ...f, agent, firstFinished, compareReference, onEvent, readReviews };
  }

  function failFirstPeer(openBase: ReturnType<typeof preset>['open'], beforeFailure: () => Promise<void>,
    diagnostic = transient) {
    let attempts = 0;
    const open = async (config: MathAgentOptions): Promise<MathAgentSession> => {
      const base = await openBase(config);
      if (path.basename(config.workspace) !== 'compare-reviewer-2' || ++attempts !== 1) return base;
      return { ...base, lastFailureDiagnostic: diagnostic, run: async (_message, _id, _workspace, onStarted) => {
        onStarted('preset-failed-review'); config.onUsage({ totalTokens: 1 });
        await beforeFailure(); return 'failed';
      } };
    };
    return { open, attempts: () => attempts };
  }

  it('defers a transient failed peer without blacklisting and still requires two approvals in the next round', async () => {
    const f = setup({ rejectedFirstRound: true }, 2), waitForRetry = vi.fn(async () => {});
    const peer = failFirstPeer(f.agent.open, async () => { await f.firstFinished.promise; await afterValidation(); });
    const result = await runFormalization(f.directory, f.root, {
      openSession: peer.open, elaborate, compareReference: f.compareReference, onEvent: f.onEvent, waitForRetry,
    });
    expect(result).toMatchObject({ status: 'approved', rounds: 2, candidatesTried: 2, firstCandidateApproved: false });
    expect(waitForRetry).not.toHaveBeenCalled(); expect(peer.attempts()).toBe(2);
    const incomplete = f.readReviews(1);
    expect(incomplete).toMatchObject({ agreement: 'incomplete', policy: 'all-approve',
      deferredReviews: [{ reviewerId: 'reviewer-2', error: 'formalization_role_incomplete:failed:other:upstream_request_failed' }] });
    expect(incomplete).not.toHaveProperty('decision');
    expect(incomplete.reviews.map(item => [item.reviewerId, item.review.verdict])).toEqual([['reviewer-1', 'changes_requested']]);
    const complete = f.readReviews(2);
    expect(complete.agreement).toBe('unanimous-approval'); expect(complete).not.toHaveProperty('deferredReviews');
    expect(complete.reviews.map(item => [item.reviewerId, item.review.verdict])).toEqual([
      ['reviewer-1', 'approved'], ['reviewer-2', 'approved'],
    ]);
    expect(readFormalizationState(f.directory).rejectedCandidates ?? []).toEqual([]);
    const evidence = readFormalizationArtifact(path.join(f.directory, 'artifact'));
    expect(evidence.workflow!.reviews).toHaveLength(2);
    expect(evidence.workflow!.reviews.every(item => item.review.verdict === 'approved')).toBe(true);
    expect(new Set(evidence.sessions.filter(item => item.role === 'compare').map(item => item.threadId)).size).toBe(2);
  });

  it('rechecks a validated change request received during retry backoff before reopening the peer', async () => {
    const f = setup({ verdicts: ['changes_requested', 'approved'] }), releaseFirst = deferred();
    const openFirst = async (config: MathAgentOptions): Promise<MathAgentSession> => {
      const base = await f.agent.open(config);
      if (path.basename(config.workspace) !== 'compare-reviewer-1') return base;
      return { ...base, run: async (...args) => { await releaseFirst.promise; return base.run(...args); } };
    };
    const peer = failFirstPeer(openFirst, async () => {}), waitForRetry = vi.fn(async () => {
      releaseFirst.resolve(); await f.firstFinished.promise; await afterValidation();
    });
    const result = await runFormalization(f.directory, f.root, {
      openSession: peer.open, elaborate, compareReference: f.compareReference, onEvent: f.onEvent, waitForRetry,
    });
    expect(waitForRetry).toHaveBeenCalledOnce(); expect(peer.attempts()).toBe(1);
    expect(result.status).toBe('exhausted'); expect(result.error).toContain('formalization_review_revision_requested:');
    expect(f.readReviews(1)).toMatchObject({ agreement: 'incomplete', deferredReviews: [{ reviewerId: 'reviewer-2' }] });
    expect(readFormalizationState(f.directory).rejectedCandidates ?? []).toEqual([]);
    expect(fs.existsSync(path.join(f.directory, 'artifact'))).toBe(false);
  });

  it.each(['unknown', 'approved'] as const)('continues retrying a transient peer after the other reviewer returns %s', async verdict => {
    const f = setup({ verdicts: [verdict, 'approved'] }), waitForRetry = vi.fn(async () => {});
    const peer = failFirstPeer(f.agent.open, async () => { await f.firstFinished.promise; await afterValidation(); });
    const result = await runFormalization(f.directory, f.root, {
      openSession: peer.open, elaborate, compareReference: f.compareReference, onEvent: f.onEvent, waitForRetry,
    });
    expect(waitForRetry).toHaveBeenCalledOnce(); expect(peer.attempts()).toBe(2);
    const reviews = f.readReviews(1);
    expect(reviews).not.toHaveProperty('deferredReviews'); expect(reviews.agreement).not.toBe('incomplete');
    expect(reviews.reviews.map(item => item.review.verdict)).toEqual([verdict, 'approved']);
    expect(result.status).toBe(verdict === 'approved' ? 'approved' : 'exhausted');
    if (verdict === 'unknown') expect(result.error).toContain('formalization_semantic_unknown');
  });

  it('does not use an invalid changes_requested output to suppress peer retries', async () => {
    const verdicts: ('changes_requested' | 'unknown' | 'approved')[] = ['changes_requested', 'approved'];
    const f = setup({ verdicts }), waitForRetry = vi.fn(async () => {}); let firstTurns = 0;
    const openFirst = async (config: MathAgentOptions): Promise<MathAgentSession> => {
      const base = await f.agent.open(config);
      if (path.basename(config.workspace) !== 'compare-reviewer-1') return base;
      return { ...base, run: async (...args) => {
        const status = await base.run(...args);
        if (++firstTurns === 1) {
          const file = path.join(config.workspace, 'OUTPUT.json'), output = JSON.parse(readMathText(file));
          output.correspondences[0].candidateFragment = 'this fragment is absent from the frozen candidate';
          fs.writeFileSync(file, JSON.stringify(output)); verdicts[0] = 'unknown';
        }
        return status;
      } };
    };
    const peer = failFirstPeer(openFirst, async () => { await f.firstFinished.promise; await afterValidation(); });
    const result = await runFormalization(f.directory, f.root, {
      openSession: peer.open, elaborate, compareReference: f.compareReference, onEvent: f.onEvent, waitForRetry,
    });
    expect(firstTurns).toBe(2); expect(peer.attempts()).toBe(2); expect(waitForRetry).toHaveBeenCalledOnce();
    expect(result.error).toContain('formalization_semantic_unknown');
    expect(f.readReviews(1)).not.toHaveProperty('deferredReviews');
  });

  it.each(['permanent error', 'cancellation'] as const)('preserves %s after a valid change request', async mode => {
    const f = setup({ verdicts: ['changes_requested', 'approved'] }), controller = new AbortController();
    const waitForRetry = vi.fn(async () => {});
    const peer = failFirstPeer(f.agent.open, async () => {
      await f.firstFinished.promise; await afterValidation();
      if (mode === 'cancellation') controller.abort();
    }, mode === 'permanent error' ? { code: 'unauthorized', httpStatusCode: 401 } : transient);
    const result = await runFormalization(f.directory, f.root, {
      signal: controller.signal, openSession: peer.open, elaborate, compareReference: f.compareReference,
      onEvent: f.onEvent, waitForRetry,
    });
    expect(result.status).toBe('stopped'); expect(peer.attempts()).toBe(1); expect(waitForRetry).not.toHaveBeenCalled();
    expect(result.error).not.toContain('formalization_review_revision_requested');
    if (mode === 'permanent error') expect(result.error).toBe('formalization_role_incomplete:failed:unauthorized');
    expect(fs.existsSync(path.join(f.directory, 'artifact'))).toBe(false);
  });

  it('lets a normally running peer finish after a validated change request', async () => {
    const f = setup({ verdicts: ['changes_requested', 'approved'] }), interrupted: string[] = [];
    const open = async (config: MathAgentOptions): Promise<MathAgentSession> => {
      const base = await f.agent.open(config), role = path.basename(config.workspace);
      return { ...base, interrupt: async () => { interrupted.push(role); await base.interrupt(); },
        run: async (...args) => {
          if (role === 'compare-reviewer-2') { await f.firstFinished.promise; await afterValidation(); }
          return base.run(...args);
        } };
    };
    const result = await runFormalization(f.directory, f.root, {
      openSession: open, elaborate, compareReference: f.compareReference, onEvent: f.onEvent,
    });
    expect(result.status).toBe('exhausted'); expect(result.error).toContain('formalization_semantic_unknown');
    expect(interrupted).toEqual([]);
    const reviews = f.readReviews(1);
    expect(reviews.agreement).toBe('disagreement'); expect(reviews).not.toHaveProperty('deferredReviews');
    expect(reviews.reviews.map(item => item.review.verdict)).toEqual(['changes_requested', 'approved']);
  });

  it('does not hide a third reviewer error behind another deferred transient failure', async () => {
    const f = setup({ verdicts: ['changes_requested', 'approved'] }, 1, 3), peerDeferred = deferred();
    const openThird = async (config: MathAgentOptions): Promise<MathAgentSession> => {
      const base = await f.agent.open(config);
      if (path.basename(config.workspace) !== 'compare-reviewer-3') return base;
      return { ...base, run: async (_message, _id, _workspace, onStarted) => {
        onStarted('preset-third-review-failure'); config.onUsage({ totalTokens: 1 });
        await peerDeferred.promise; throw new Error('unexpected third reviewer failure');
      } };
    };
    const peer = failFirstPeer(openThird, async () => { await f.firstFinished.promise; await afterValidation(); });
    const result = await runFormalization(f.directory, f.root, {
      openSession: peer.open, elaborate, compareReference: f.compareReference,
      onEvent: event => {
        f.onEvent!(event);
        if (event.event === 'formalization_review_retry_deferred') peerDeferred.resolve();
      },
    });
    expect(result.status).toBe('exhausted'); expect(result.error).toBe('unexpected third reviewer failure');
    expect(peer.attempts()).toBe(1); expect(fs.existsSync(path.join(f.directory, 'artifact'))).toBe(false);
  });
});

describe('planned formalization and unanimous review protocol', () => {
  it('publishes a complete frozen candidate and awaits its handoff before starting semantic review', async () => {
    const f = fixture(), agent = preset();
    let publish!: (candidate: FormalizationCompiledCandidate) => void, release!: () => void;
    const published = new Promise<FormalizationCompiledCandidate>(resolve => { publish = resolve; });
    const handoff = new Promise<void>(resolve => { release = resolve; });
    const running = runFormalization(f.directory, f.root, { openSession: agent.open, elaborate,
      onCompiledCandidate: async candidate => { publish(candidate); await handoff; } });
    let result: Awaited<typeof running>;
    try {
      const candidate = await Promise.race([published, running.then(() => { throw new Error('Candidate was never published'); })]);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(agent.seen.map(item => item.role)).toEqual(['plan-1', 'generate']);
      expect(() => assertFormalizationCompiledCandidate(candidate)).not.toThrow();
      expect(candidate.candidate.source).toBe(candidate.snapshot.source);
      expect(candidate.sourceSha256).toBe(mathDigest(candidate.candidate.source));
      expect(formalizationEvidenceSchema.safeParse(candidate).success).toBe(false);
      expect(fs.existsSync(path.join(f.directory, 'artifact'))).toBe(false);
      expect(fs.existsSync(path.join(f.directory, 'workspace'))).toBe(false);
    } finally { release(); result = await running; }
    expect(result.status).toBe('approved');
    const approved = formalizationCompiledCandidate(readFormalizationArtifact(path.join(f.directory, 'artifact')));
    expect(formalizationCompiledCandidateDigest(await published)).toBe(formalizationCompiledCandidateDigest(approved));
    expect(agent.seen.map(item => item.role)).toEqual(['plan-1', 'generate', 'backtranslate', 'compare-reviewer-1', 'compare-reviewer-2']);
  });

  it('does not publish a candidate whose compilation failed', async () => {
    const f = fixture(), agent = preset(), published: FormalizationCompiledCandidate[] = [];
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open,
      elaborate: async () => { throw new Error('synthetic_compilation_failed'); },
      onCompiledCandidate: candidate => { published.push(candidate); } });
    expect(result).toMatchObject({ status: 'exhausted', error: 'synthetic_compilation_failed' });
    expect(published).toEqual([]);
    expect(agent.seen.map(item => item.role)).toEqual(['plan-1', 'generate']);
  });

  it('retains frozen v2 workflow evidence and restores its artifact without model calls', async () => {
    const f = fixture(), agent = preset(), legacy = { ...f.request, schema: 'theorem-os.formalization-request.v2' };
    delete legacy.contextProtocol;
    fs.chmodSync(path.join(f.directory, 'request.json'), 0o600);
    fs.writeFileSync(path.join(f.directory, 'request.json'), JSON.stringify(legacy));
    fs.chmodSync(path.join(f.directory, 'request.json'), 0o400);
    expect(await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate })).toMatchObject({ status: 'approved' });
    const artifact = path.join(f.directory, 'artifact'), raw = JSON.parse(readMathText(path.join(artifact, 'evidence.json')));
    expect(raw).toMatchObject({ schema: 'theorem-os.formalization-evidence.v2',
      workflow: { schema: 'theorem-os.formalization-workflow-evidence.v2' } });
    expect(raw.snapshot.targets[0].context).not.toHaveProperty('bindings');
    expect(formalizationDigest(readFormalizationArtifact(artifact))).toBe(formalizationDigest(raw));
    expect(readFormalizationRequest(f.directory)).toEqual(legacy);
    expect(await runFormalization(f.directory, f.root, { openSession: async () => {
      throw new Error('A completed v2 artifact must not open a role.');
    }, elaborate })).toMatchObject({ status: 'approved' });
  });

  it('freezes the plan and separately configured fresh sessions while keeping the backtranslation blind', async () => {
    const f = fixture(workflow => {
      workflow.planner.model = 'preset-planner'; workflow.backtranslator.model = 'preset-translator';
      workflow.reviewers[0].model = 'preset-judge-a'; workflow.reviewers[1].model = 'preset-judge-b';
    }), agent = preset();
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate });
    expect(result).toMatchObject({ status: 'approved', modelInvoked: false, candidatesTried: 1, firstCandidateApproved: true,
      distinctModelConfigurations: 5, roleTurns: { plan: 1, generate: 1, backtranslate: 1, compare: 2 } });
    expect(readFormalizationRequest(f.directory).schema).toBe('theorem-os.formalization-request.v3');
    expect(readFormalizationRequest(f.directory).contextProtocol).toBe('kernel-v3');
    expect(agent.seen.map(item => item.role)).toEqual(['plan-1', 'generate', 'backtranslate', 'compare-reviewer-1', 'compare-reviewer-2']);
    expect(agent.seen.map(item => item.config.model)).toEqual(['preset-planner', 'preset-author', 'preset-translator', 'preset-judge-a', 'preset-judge-b']);
    expect(agent.seen[1].input.plan).toEqual(plan(fixtureStatement));
    const blind = JSON.stringify(agent.seen[2].input);
    expect(blind).not.toContain(fixtureStatement); expect(blind).not.toContain('zero-identity');
    expect(agent.seen[4].input).not.toHaveProperty('reviews');
    expect(agent.seen[4].input).not.toHaveProperty('verdict');
    const e = readFormalizationArtifact(path.join(f.directory, 'artifact'));
    expect(e).toMatchObject({ schema: 'theorem-os.formalization-evidence.v3', proofVerified: false,
      workflow: { schema: 'theorem-os.formalization-workflow-evidence.v3', reviewAgreement: 'unanimous', distinctModelConfigurations: 5 } });
    expect(e.snapshot.targets[0].context.semantic).toEqual(agent.seen[2].input.targets[0].context.semantic);
    expect(e.snapshot.targets[0].context.structures).toEqual({ schema: 'theorem-os.lean-statement-structures.v1', entries: [] });
    expect(agent.seen[2].input.targets[0].context.structures).toEqual(e.snapshot.targets[0].context.structures);
    expect(agent.seen[3].input.observation.snapshot.targets[0].context.structures).toEqual(e.snapshot.targets[0].context.structures);
    expect(agent.seen[4].input.observation.snapshot.targets[0].context.structures).toEqual(e.snapshot.targets[0].context.structures);
    expect(e.sessions).toHaveLength(5); expect(new Set(e.sessions.map(item => item.threadId)).size).toBe(5);
    const count = agent.seen.length;
    expect(await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate })).toMatchObject({ status: 'approved' });
    expect(agent.seen).toHaveLength(count);
  });

  it('records equal model configurations honestly even with separate threads', async () => {
    const f = fixture(), agent = preset();
    expect(await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate })).toMatchObject({ distinctModelConfigurations: 1 });
    expect(readFormalizationArtifact(path.join(f.directory, 'artifact')).workflow.distinctModelConfigurations).toBe(1);
  });

  it.each(['changes_requested', 'unknown'] as const)('blocks %s from any reviewer and saves disagreement', async verdict => {
    const f = fixture(), agent = preset({ verdicts: ['approved', verdict] });
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate });
    expect(result.status).toBe('exhausted'); expect(result.error).toContain(verdict);
    expect(agent.seen.filter(item => item.role.startsWith('compare-'))).toHaveLength(2);
    const round = fs.readdirSync(f.directory).find(name => name.startsWith('round-'))!;
    const reviews = JSON.parse(readMathText(path.join(f.directory, round, 'reviews.json')));
    expect(reviews.agreement).toBe('disagreement');
    expect(fs.existsSync(path.join(f.directory, 'artifact'))).toBe(false);
    expect(fs.existsSync(path.join(f.directory, 'workspace'))).toBe(false);
  });

  it('repairs planning before generation within its own bounded budget', async () => {
    const f = fixture(), agent = preset({ badSpanFirst: true });
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate });
    expect(result).toMatchObject({ status: 'approved', rounds: 1, roleTurns: { plan: 2, generate: 1 } });
    expect(agent.seen[1].input.feedback).toContain('formalization_plan_span_invalid');
    expect(readFormalizationArtifact(path.join(f.directory, 'artifact')).workflow.plan.input.planningRound).toBe(2);
  });

  it('re-plans a wrong claim shape before spending a generation turn', async () => {
    const f = fixture(), agent = preset({ claimShapeFirst: true });
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate });
    expect(result).toMatchObject({ status: 'approved', rounds: 1, candidatesTried: 1, roleTurns: { plan: 2, generate: 1 } });
    const feedback = agent.seen[1].input.feedback;
    expect(feedback).toContain('formalization_plan_claim_shape');
    expect(feedback).toContain('R5_bundled_relation');
    expect(feedback).toContain('not a claim that the mathematics is wrong');
    expect(readFormalizationArtifact(path.join(f.directory, 'artifact')).workflow.plan.input.planningRound).toBe(2);
  });

  it('gives frozen exemplars to the planner and author only and binds them in the evidence', async () => {
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'formalization-exemplar-corpus-'))); roots.push(parent);
    const corpusFile = path.join(parent, 'corpus.json');
    fs.writeFileSync(corpusFile, JSON.stringify({ schema: 'theorem-os.formalization-exemplar-corpus.v1', provenance: 'workflow fixture',
      items: [{ id: 'own', statement: fixtureStatement, lean: 'theorem own : True :=' },
        { id: 'nat-add', statement: 'Prove that zero is a right identity for natural number addition.', lean: 'theorem z (n : ℕ) : n + 0 = n :=' },
        { id: 'other', statement: 'Prove that a group of even order has an element of order two.', lean: 'theorem o : True :=' }] }));
    const f = fixture(undefined, { exemplars: { corpusFile, count: 2 } }), agent = preset();
    expect(f.request.exemplars).toMatchObject({ corpusSize: 3, excludedIds: ['own'] });
    expect(f.request.exemplars!.items.map(item => item.id)).not.toContain('own');
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate });
    expect(result).toMatchObject({ status: 'approved' });
    const pairs = f.request.exemplars!.items.map(({ id, statement, lean }) => ({ id, statement, lean }));
    const byRole = Object.fromEntries(agent.seen.map(item => [item.role, item]));
    expect(byRole['plan-1'].input.exemplars).toEqual(pairs);
    expect(byRole.generate.input.exemplars).toEqual(pairs);
    for (const role of ['backtranslate', 'compare-reviewer-1', 'compare-reviewer-2'])
      expect(JSON.stringify(byRole[role].input)).not.toContain('theorem own');
    const instructions = (role: string) => readMathText(path.join(byRole[role].config.workspace, 'ROLE.md'));
    expect(instructions('plan-1')).toContain('INPUT.exemplars');
    expect(instructions('generate')).toContain('INPUT.exemplars');
    for (const rule of ['rather than assuming ∃! x, P x', 'bind (p : ℕ) with its primality hypothesis']) {
      expect(instructions('generate')).toContain(rule);
      expect(instructions('compare-reviewer-1')).not.toContain(rule);
    }
    expect(instructions('compare-reviewer-1')).not.toContain('INPUT.exemplars');
    const evidence = readFormalizationArtifact(path.join(f.directory, 'artifact'));
    expect(() => assertFormalizationEvidence(evidence)).not.toThrow();
    const tampered = structuredClone(evidence);
    tampered.generation.input.exemplars = tampered.generation.input.exemplars!.slice(0, 1);
    expect(() => assertFormalizationEvidence(tampered)).toThrow('formalization_exemplar_input_mismatch');
  });

  it('keeps requests without exemplars byte-identical in role inputs', async () => {
    const f = fixture(), agent = preset();
    await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate });
    expect(f.request).not.toHaveProperty('exemplars');
    for (const item of agent.seen) expect(item.input).not.toHaveProperty('exemplars');
  });

  it('never generates a target while definitions are unresolved', async () => {
    const f = fixture(), agent = preset({ unresolved: true });
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate });
    expect(result).toMatchObject({ status: 'exhausted', candidatesTried: 0, firstCandidateApproved: false });
    expect(result.error).toContain('formalization_plan_unresolved');
    expect(agent.seen.map(item => item.role)).toEqual(['plan-1', 'plan-2']);
    expect(fs.existsSync(path.join(f.directory, 'workspace'))).toBe(false);
  });

  it('excludes a failed planning-only round from generated-candidate sampling', async () => {
    const f = fixture(workflow => { workflow.maxPlanningRounds = 1; }, { maxRounds: 0, maxRunSeconds: 0,
      maxTurnSeconds: 0, maxCompileSeconds: 0, maxTotalTokens: 0 }), agent = preset({ badSpanFirst: true });
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open,
      elaborate: async (_directory, source, environment, options) => {
        expect(options.timeoutMs).toBe(0); return syntheticElaboration(source, environment, options);
      } });
    expect(result).toMatchObject({ status: 'approved', rounds: 2, candidatesTried: 1, firstCandidateApproved: true,
      roleTurns: { plan: 2, generate: 1, backtranslate: 1, compare: 2 } });
    expect(agent.seen.map(item => item.role)).toEqual(['plan-1', 'plan-1', 'generate', 'backtranslate', 'compare-reviewer-1', 'compare-reviewer-2']);
    expect(agent.seen.every(item => item.config.turnTimeoutMs === undefined)).toBe(true);
    expect(readFormalizationState(f.directory).generatedCandidates).toBe(1);
    expect(readFormalizationArtifact(path.join(f.directory, 'artifact')).round).toBe(2);
  });

  it('repairs planning without a planning cap when all execution limits are zero', async () => {
    const f = fixture(workflow => { workflow.maxPlanningRounds = 0; }, { maxRounds: 0, maxRunSeconds: 0,
      maxTurnSeconds: 0, maxCompileSeconds: 0, maxTotalTokens: 0 }), agent = preset({ badSpanFirst: true });
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate });
    expect(result).toMatchObject({ status: 'approved', rounds: 1, candidatesTried: 1, firstCandidateApproved: true,
      roleTurns: { plan: 2, generate: 1 } });
    expect(readFormalizationArtifact(path.join(f.directory, 'artifact')).workflow.plan.input.planningRound).toBe(2);
  });

  it('keeps validated submission markers for the plan, generator, translator and every unanimous reviewer', async () => {
    const f = fixture(), agent = preset({ submitted: true });
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate });
    expect(result).toMatchObject({ status: 'approved', candidatesTried: 1, firstCandidateApproved: true });
    const evidence = readFormalizationArtifact(path.join(f.directory, 'artifact'));
    expect(evidence.sessions).toHaveLength(5);
    expect(evidence.sessions.map(item => item.role)).toEqual(['plan', 'generate', 'backtranslate', 'compare', 'compare']);
    for (const item of evidence.sessions) expect(item).toMatchObject({ status: 'submitted', completionReason: 'validated-output' });
    expect(() => assertFormalizationEvidence(evidence)).not.toThrow();
  });

  it('forwards an unlimited timeout to optional reference comparison and can still be cancelled', async () => {
    const f = fixture(workflow => {
      workflow.maxPlanningRounds = 0;
      const source = 'theorem gold (n : Nat) : n + 0 = n := by sorry\n';
      workflow.reference = { source, sourceSha256: mathDigest(source), maxSeconds: 0, provenance: 'Synthetic reference fixture.',
        pairs: [{ candidateTarget: 'addition', referenceTarget: 'gold' }] };
    }, { maxRounds: 0, maxRunSeconds: 0, maxTurnSeconds: 0, maxCompileSeconds: 0, maxTotalTokens: 0 });
    const controller = new AbortController(), agent = preset(); let comparisons = 0;
    const result = await runFormalization(f.directory, f.root, { signal: controller.signal, openSession: agent.open,
      elaborate: async (_directory, source, environment, options) => {
        expect(options.timeoutMs).toBe(0); return syntheticElaboration(source, environment, options);
      }, compareReference: async (_directory, input, options) => {
        comparisons++; expect(options.timeoutMs).toBe(0); expect(options.signal?.aborted).toBe(false);
        expect(input.referenceSource).toContain('theorem gold'); controller.abort();
        return { status: 'not-established' } as any;
      } });
    expect(result).toMatchObject({ status: 'stopped', rounds: 1, candidatesTried: 1, firstCandidateApproved: false });
    expect(result.error).not.toContain('math_runtime_lease_lost');
    expect(comparisons).toBe(1);
    expect(readFormalizationState(f.directory).activeSince).toBeUndefined();
    expect(fs.existsSync(path.join(f.directory, 'artifact'))).toBe(false);
  });

  it.each(['decision', 'construction'] as const)('fails closed for unsupported %s answer contracts', async taskKind => {
    const f = fixture(undefined, { maxRounds: 3 }), agent = preset({ taskKind });
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate });
    expect(result).toMatchObject({ status: 'stopped', rounds: 1, error: 'formalization_plan_task_kind_unsupported' });
    expect(agent.seen.map(item => item.role)).toEqual(['plan-1']);
    const replacement = preset();
    expect(await runFormalization(f.directory, f.root, { openSession: replacement.open, elaborate })).toMatchObject({ status: 'stopped', rounds: 1 });
    expect(replacement.seen).toHaveLength(0);
    expect(readFormalizationState(f.directory).unsupportedTaskKind).toBe(taskKind);
    expect(fs.existsSync(path.join(f.directory, 'workspace'))).toBe(false);
  });

  it('blocks unplanned definitions before compilation and review', async () => {
    const f = fixture(), agent = preset({ addUnplannedDefinition: true });
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open,
      elaborate: async () => { throw new Error('must not compile'); } });
    expect(result).toMatchObject({ status: 'exhausted', error: 'formalization_plan_definition_unplanned' });
    expect(agent.seen.map(item => item.role)).toEqual(['plan-1', 'generate']);
  });

  it('does not accept a rejected source by changing only author notes', async () => {
    const f = fixture(undefined, { maxRounds: 2 }), agent = preset({ rejectedFirstRound: true });
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate });
    expect(result).toMatchObject({ status: 'exhausted', error: 'formalization_candidate_unchanged_after_rejection' });
    expect(agent.seen.filter(item => item.role.startsWith('compare-'))).toHaveLength(2);
  });

  it('rechecks an unchanged source after unanimous unknown reviews', async () => {
    const f = fixture(undefined, { maxRounds: 2 }), agent = preset({ unknownFirstRound: true });
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate });
    expect(result).toMatchObject({ status: 'approved', rounds: 2, candidatesTried: 2, firstCandidateApproved: false });
    expect(agent.seen.filter(item => item.role.startsWith('compare-'))).toHaveLength(4);
    expect(readFormalizationState(f.directory).rejectedCandidates ?? []).toEqual([]);
  });

  it('does not blacklist a source when reviewers request changes for different aspects', async () => {
    const f = fixture(undefined, { maxRounds: 2 }), agent = preset({ rejectedFirstRound: true,
      mismatchAspects: ['domains', 'conclusions'] });
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate });
    expect(result).toMatchObject({ status: 'approved', rounds: 2 });
    expect(agent.seen.filter(item => item.role.startsWith('compare-'))).toHaveLength(4);
    expect(readFormalizationState(f.directory).rejectedCandidates ?? []).toEqual([]);
  });

  it('permits retrying an unchanged candidate after a transient infrastructure failure', async () => {
    const f = fixture(undefined, { maxRounds: 2 }), agent = preset(); let compilations = 0;
    expect(await runFormalization(f.directory, f.root, { openSession: agent.open,
      elaborate: async (_directory, source, environment, options) => {
        if (++compilations === 1) throw new Error('temporary compiler transport unavailable');
        return syntheticElaboration(source, environment, options);
      } })).toMatchObject({ status: 'approved', rounds: 2 });
    expect(readFormalizationState(f.directory).rejectedCandidates ?? []).toEqual([]);
  });

  it('reports candidate sampling without disguising second-round approval as pass at one', async () => {
    const f = fixture(undefined, { maxRounds: 2 }), agent = preset({ rejectedFirstRound: true, changeSource: true });
    expect(await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate })).toMatchObject({ status: 'approved',
      candidatesTried: 2, firstCandidateApproved: false, candidateSelection: 'first-unanimously-approved' });
  });

  it('charges planning turns against the shared token cap', async () => {
    const f = fixture(undefined, { maxTotalTokens: 1 }), agent = preset();
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate });
    expect(result).toMatchObject({ status: 'stopped', candidatesTried: 0, firstCandidateApproved: false });
    expect(agent.seen.map(item => item.role)).toEqual(['plan-1']);
    expect(readFormalizationState(f.directory).sessions).toHaveLength(1);
  });

  it.each([{ missingFinalUsage: true }, { incompleteFinalUsage: true }])('blocks unaccounted final reviewer usage with a finite cap: %j', async options => {
    const f = fixture(undefined, { maxTotalTokens: 100 }), agent = preset(options);
    expect(await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate })).toMatchObject({ status: 'stopped',
      error: 'math_model_usage_unavailable' });
    expect(agent.seen).toHaveLength(5); expect(fs.existsSync(path.join(f.directory, 'artifact'))).toBe(false);
  });

  it('detects profile changes during the final role before an artifact is written', async () => {
    const profiles = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'formalization-v2-profile-fixture-'))); roots.push(profiles);
    const configFile = path.join(profiles, 'config.toml'); fs.writeFileSync(configFile, '# disposable profile\n');
    const f = fixture(workflow => {
      for (const item of [workflow.planner, workflow.backtranslator, ...workflow.reviewers]) item.profile = profiles;
    }, { execution: 'model', profile: profiles });
    const agent = preset({ afterOutput: role => { if (role === 'compare-reviewer-2') fs.appendFileSync(configFile, '# changed\n'); } });
    expect(await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate })).toMatchObject({ status: 'stopped',
      error: 'formalization_profile_changed_during_run' });
    expect(fs.existsSync(path.join(f.directory, 'artifact'))).toBe(false);
    await expect(runFormalization(f.directory, f.root, { openSession: agent.open, elaborate })).rejects.toThrow('formalization_resume_identity_changed');
  });

  it('binds an external model catalog referenced by a reviewer profile', async () => {
    const profiles = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'formalization-v2-catalog-fixture-'))); roots.push(profiles);
    const configFile = path.join(profiles, 'config.toml'), catalogFile = path.join(profiles, 'external-catalog.json');
    fs.writeFileSync(configFile, 'model_catalog_json = ' + JSON.stringify(catalogFile) + '\n'); fs.writeFileSync(catalogFile, '{}');
    const f = fixture(workflow => {
      for (const item of [workflow.planner, workflow.backtranslator, ...workflow.reviewers]) item.profile = profiles;
    }, { execution: 'model', profile: profiles });
    const agent = preset({ afterOutput: role => { if (role === 'compare-reviewer-2') fs.writeFileSync(catalogFile, '{"changed":true}'); } });
    expect(await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate })).toMatchObject({ status: 'stopped',
      error: 'formalization_profile_changed_during_run' });
    expect(fs.existsSync(path.join(f.directory, 'artifact'))).toBe(false);
  });

  it('requires fresh reviewer threads even when all decisions approve', async () => {
    const f = fixture(), agent = preset({ reuseThread: true });
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate });
    expect(result).toMatchObject({ status: 'exhausted', error: 'formalization_role_thread_reused' });
    expect(fs.existsSync(path.join(f.directory, 'artifact'))).toBe(false);
  });

  it('a configured reference must establish correspondence before any artifact can be created', async () => {
    const f = fixture(workflow => {
      const source = 'theorem gold (n : Nat) : n + 0 = n := by sorry\n';
      workflow.reference = { source, sourceSha256: mathDigest(source), maxSeconds: 2, provenance: 'Synthetic fixture only.',
        pairs: [{ candidateTarget: 'addition', referenceTarget: 'gold' }] };
    }), agent = preset();
    let compared = false;
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate,
      compareReference: async (_directory, input) => { compared = true; expect(input.referenceSource).toContain('theorem gold');
        return { status: 'not-established' } as any; } });
    expect(compared).toBe(true); expect(result).toMatchObject({ status: 'exhausted', error: 'formalization_reference_not_established' });
    expect(JSON.stringify(agent.seen.filter(item => item.role !== 'generate').map(item => item.input))).not.toContain('theorem gold');
    expect(fs.existsSync(path.join(f.directory, 'artifact'))).toBe(false);
  });

  it.each(['plan', 'generation-plan', 'reviewer', 'configuration', 'review-count', 'version'] as const)(
    'rejects changed %s evidence even when the outer JSON remains valid', async field => {
      const f = fixture(), agent = preset();
      await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate });
      const e = structuredClone(readFormalizationArtifact(path.join(f.directory, 'artifact')));
      if (field === 'plan') { e.workflow.plan.output.objects[0].leanType = 'Int'; e.workflow.plan.digest = formalizationDigest(e.workflow.plan.output); }
      if (field === 'generation-plan') e.generation.input.planDigest = '0'.repeat(64);
      if (field === 'reviewer') e.workflow.reviews[1].review.checks.conclusions = 'mismatch';
      if (field === 'configuration') e.sessions[4].configurationDigest = '0'.repeat(64);
      if (field === 'review-count') e.workflow.reviews.pop();
      if (field === 'version') e.schema = 'theorem-os.formalization-evidence.v1';
      expect(() => assertFormalizationEvidence(e)).toThrow();
    });
});

describe('lean-refutation-v1 falsification gate', () => {
  const falsification = { schema: 'theorem-os.formalization-falsification.v1', protocol: 'lean-refutation-v1', maxSeconds: 60, maxTurnSeconds: 0 };
  const refuting = (proof = 'by intro h; exact absurd (h 0) (by decide)') => () =>
    [{ target: 'addition', opens: [], proof, explanation: 'At n = 0 the claim fails.' }];
  type Refute = NonNullable<NonNullable<Parameters<typeof runFormalization>[2]>['refute']>;
  // Synthetic Lean verdicts: the listed calls refute every probe, the others leave them open.
  const lean = (refutedCalls: number[]) => {
    const calls: { directory: string; source: string; environment: string; timeoutMs: number }[] = [];
    const refute: Refute = async (directory, source, environment, probes, options) => {
      calls.push({ directory, source, environment, timeoutMs: options.timeoutMs });
      const refuted = refutedCalls.includes(calls.length);
      return { schema: 'theorem-os.formalization-refutation-check.v1', status: 'checked', sourceSha256: mathDigest(source), timedOut: false,
        probes: probes.map(probe => refuted ? { ...probe, status: 'refuted' as const, axioms: ['propext'] } :
          { ...probe, status: 'not-refuted' as const, reason: 'no result: the proof did not elaborate' }) };
    };
    return { refute, calls };
  };
  const roundDirectory = (directory: string, round: number) => path.join(directory,
    fs.readdirSync(directory).find(name => name.startsWith(`round-${String(round).padStart(2, '0')}-`))!);
  const roundFile = (directory: string, round: number, file: string) =>
    JSON.parse(readMathText(path.join(roundDirectory(directory, round), file)));

  it('rejects a Lean-refuted candidate, blacklists its source and revises from the checked counterexample', async () => {
    const f = fixture(undefined, { environment: 'mathlib', falsification, maxRounds: 2, maxRunSeconds: 600 });
    const agent = preset({ changeSource: true, refutations: refuting() }), checked = lean([1]);
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate, refute: checked.refute });
    expect(result).toMatchObject({ status: 'approved', rounds: 2, candidatesTried: 2, firstCandidateApproved: false,
      roleTurns: { plan: 2, generate: 2, backtranslate: 2, refute: 2, compare: 2 } });
    expect(checked.calls).toHaveLength(2);
    expect(checked.calls[0]).toMatchObject({ environment: 'mathlib', timeoutMs: 60_000 });
    const second = agent.seen.filter(item => item.role === 'generate')[1]!.input;
    expect(second.feedback).toContain('formalization_refuted: Lean proved the negation of addition');
    expect(second.feedback).toContain('At n = 0 the claim fails.');
    expect(second.feedback).toContain('by intro h; exact absurd (h 0) (by decide)');
    expect(readFormalizationState(f.directory).rejectedCandidates).toEqual([mathDigest(checked.calls[0]!.source)]);
    expect(roundFile(f.directory, 1, 'refutation-result.json')).toMatchObject({ status: 'checked', probes: [{ status: 'refuted' }] });
    const evidence = readFormalizationArtifact(path.join(f.directory, 'artifact'));
    expect(evidence.sessions.map(item => item.role)).toEqual(['plan', 'generate', 'backtranslate', 'compare', 'compare']);
    expect(() => assertFormalizationEvidence(evidence)).not.toThrow();
  });

  it('does not accept the refuted source again after a note-only revision', async () => {
    const f = fixture(undefined, { environment: 'mathlib', falsification, maxRounds: 2 });
    const agent = preset({ refutations: refuting() }), checked = lean([1]);
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate, refute: checked.refute });
    expect(result).toMatchObject({ status: 'exhausted', error: 'formalization_candidate_unchanged_after_rejection' });
    expect(checked.calls).toHaveLength(1);
    expect(agent.seen.filter(item => item.role.startsWith('compare-'))).toHaveLength(0);
  });

  it('keeps the refuter blind and gives each role only its own falsification rule', async () => {
    const f = fixture(undefined, { environment: 'mathlib', falsification }), agent = preset(), checked = lean([]);
    expect(await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate, refute: checked.refute }))
      .toMatchObject({ status: 'approved', rounds: 1, firstCandidateApproved: true });
    const byRole = Object.fromEntries(agent.seen.map(item => [item.role, item]));
    expect(byRole.refute.input).toMatchObject({ schema: 'theorem-os.formalization-refutation-input.v1',
      targets: [{ name: 'addition', type: 'forall (n : Nat), n + 0 = n' }] });
    const blind = JSON.stringify(byRole.refute.input);
    for (const hidden of [fixtureStatement, 'zero-identity', 'Natural-number domain.', 'Standard addition.']) expect(blind).not.toContain(hidden);
    expect(byRole.refute.config.model).toBe(f.request.workflow!.backtranslator.model);
    const instructions = (role: string) => readMathText(path.join(byRole[role].config.workspace, 'ROLE.md'));
    expect(instructions('refute')).toContain('Try to disprove the formal Lean statement');
    expect(instructions('refute')).not.toContain('Do not search for or construct theorem proofs');
    expect(instructions('refute')).not.toContain('Preserve the complete original task');
    for (const role of ['plan-1', 'generate']) expect(instructions(role)).toContain('add exactly one minimal hypothesis');
    expect(instructions('compare-reviewer-1')).toContain('only exception to recording a suspected source error');
    expect(instructions('compare-reviewer-1')).not.toContain('add exactly one minimal hypothesis');
    expect(instructions('backtranslate')).not.toContain('lean-refutation-v1');
  });

  it.each([
    ['a crashed refuter', async () => { throw new Error('refuter transport reset'); }],
    ['a broken harness', async () => { throw new Error('formalization_refutation_harness_failed: sentinel probe missing'); }],
  ] as [string, Refute][])('treats %s as no evidence either way', async (_name, refute) => {
    const f = fixture(undefined, { environment: 'mathlib', falsification }), agent = preset({ refutations: refuting() });
    expect(await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate, refute }))
      .toMatchObject({ status: 'approved', rounds: 1, firstCandidateApproved: true });
    expect(fs.readdirSync(roundDirectory(f.directory, 1)).some(name => name.startsWith('refutation-failure-'))).toBe(true);
  });

  it('treats a timed-out check as unavailable and approves on review alone', async () => {
    const f = fixture(undefined, { environment: 'mathlib', falsification }), agent = preset({ refutations: refuting() });
    const refute: Refute = async (_directory, source, _environment, probes) => ({ schema: 'theorem-os.formalization-refutation-check.v1',
      status: 'unavailable', sourceSha256: mathDigest(source), timedOut: true,
      probes: probes.map(probe => ({ ...probe, status: 'not-refuted' as const, reason: 'timed out' })) });
    expect(await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate, refute }))
      .toMatchObject({ status: 'approved', rounds: 1 });
    expect(roundFile(f.directory, 1, 'refutation-result.json')).toMatchObject({ status: 'unavailable', timedOut: true });
  });

  it('never sends unknown, duplicate or inadmissible probes to Lean', async () => {
    const f = fixture(undefined, { environment: 'mathlib', falsification });
    const agent = preset({ refutations: () => [
      { target: 'missing', opens: [], proof: 'by simp', explanation: 'Unknown target.' },
      { target: 'addition', opens: [], proof: 'by native_decide', explanation: 'Trust escape.' },
      { target: 'addition', opens: [], proof: 'by decide', explanation: 'Duplicate target.' }] }), checked = lean([1]);
    expect(await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate, refute: checked.refute }))
      .toMatchObject({ status: 'approved', rounds: 1 });
    expect(checked.calls).toHaveLength(0);
    expect(roundFile(f.directory, 1, 'refutation-result.json')).toMatchObject({ status: 'no-probes',
      rejected: [{ reason: 'unknown target' }, { reason: 'forbidden token native_decide' }, { reason: 'duplicate target' }] });
  });

  it('treats an interrupted refuter turn as no evidence and bounds it separately', async () => {
    const f = fixture(undefined, { environment: 'mathlib', falsification: { ...falsification, maxTurnSeconds: 3 } });
    const agent = preset({ refutations: refuting(), refuteStatus: 'checkpoint' }), checked = lean([1]);
    expect(await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate, refute: checked.refute }))
      .toMatchObject({ status: 'approved', rounds: 1, firstCandidateApproved: true });
    expect(checked.calls).toHaveLength(0);
    const byRole = Object.fromEntries(agent.seen.map(item => [item.role, item]));
    expect(byRole.refute.config.turnTimeoutMs).toBe(3000);
    expect(byRole.backtranslate.config.turnTimeoutMs).toBe(10_000);
    expect(fs.readdirSync(roundDirectory(f.directory, 1)).some(name => name.startsWith('refutation-failure-'))).toBe(true);
  });

  it('stops when the refuter account is rejected, as for any role', async () => {
    const f = fixture(undefined, { environment: 'mathlib', falsification });
    const agent = preset({ refutations: refuting(), refuteStatus: 'failed', refuteDiagnostic: { code: 'unauthorized', httpStatusCode: 401 } });
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate, refute: lean([1]).refute });
    expect(result).toMatchObject({ status: 'stopped', error: expect.stringContaining('formalization_role_incomplete:failed:unauthorized') });
    expect(agent.seen.filter(item => item.role.startsWith('compare-'))).toHaveLength(0);
  });

  it('stops on an infrastructure failure of the refuter instead of reviewing without it', async () => {
    const f = fixture(undefined, { environment: 'mathlib', falsification }), agent = preset({ refutations: refuting() });
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate,
      refute: async () => { throw new Error('formalization_sandbox_unavailable: synthetic'); } });
    expect(result).toMatchObject({ status: 'stopped', error: expect.stringContaining('formalization_sandbox_unavailable') });
    expect(agent.seen.filter(item => item.role.startsWith('compare-'))).toHaveLength(0);
    expect(fs.existsSync(path.join(f.directory, 'artifact'))).toBe(false);
  });

  it('requires the semantic Mathlib v3 workflow and leaves other requests without a refute role', async () => {
    expect(() => fixture(undefined, { falsification })).toThrow('formalization_falsification_requires_semantic_mathlib_v3');
    const f = fixture(undefined, { environment: 'mathlib' }), agent = preset({ refutations: refuting() });
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate,
      refute: async () => { throw new Error('must not refute'); } });
    expect(result).toMatchObject({ status: 'approved' }); expect(result.roleTurns).not.toHaveProperty('refute');
    expect(agent.seen.map(item => item.role)).not.toContain('refute');
    expect(readMathText(path.join(agent.seen[1]!.config.workspace, 'ROLE.md'))).not.toContain('lean-refutation-v1');
  });
});
