import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MathAgentOptions, MathAgentSession } from '../src/runtime/codexSession';
import { formalizationEvaluationInputDigest, formalizationEvaluationLeanSource,
  prepareFormalizationEvaluation, readFormalizationEvaluationBundle, scoreFormalizationEvaluation,
  type FormalizationEvaluationReviewerInput } from '../src/math/formalizationEvaluation';
import { eraseFormalizationProofs } from '../src/math/formalizationSource';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { mathDigest } from '../src/math/mathRuntimeIo';
import * as mathBuildManifest from '../src/math/mathBuildManifest';
import {
  resolveReviewEnvironment, STRUCTURED_REVIEW_EVIDENCE_VERSION,
  structuredReviewAspects, structuredReviewDigest, structuredReviewInput,
  formalizationReviewInstructions,
  type ReviewStatementObservation, type ReviewStatementSnapshot, type StructuredReviewInput,
  type StructuredSemanticReview,
} from '../src/math/formalizationReviewV2';
import type { FormalizationTranslation } from '../src/math/formalization';
import { runStructuredFormalizationReview } from '../src/solver/formalizationReviewV2';
import { semanticContextFixture } from './helpers/formalizationFixture';

const forbidden = vi.hoisted(() => ({ model: vi.fn(), lean: vi.fn() }));
vi.mock('../src/runtime/codexSession', () => ({ createCodexMathSession: forbidden.model }));
vi.mock('../src/solver/formalizationElaboration', () => ({ elaborateFormalization: forbidden.lean }));

// Actual disposable files and flock leases, but only handwritten observations and role outputs.
// No benchmark, model, Lean invocation or real model-profile read is part of these integration fixtures.
const roots: string[] = [];
let expectedElaborationAdapterCalls = 0;
beforeEach(() => {
  expectedElaborationAdapterCalls = 0;
  forbidden.model.mockReset().mockImplementation(() => { throw new Error('test_forbids_model'); });
  forbidden.lean.mockReset().mockImplementation(() => { throw new Error('test_forbids_lean'); });
});
afterEach(() => {
  try { expect(forbidden.model).not.toHaveBeenCalled(); expect(forbidden.lean).toHaveBeenCalledTimes(expectedElaborationAdapterCalls); }
  finally {
    vi.restoreAllMocks();
    for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  }
});
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
function write(file: string, value: unknown, frozen = false) {
  if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
  fs.writeFileSync(file, JSON.stringify(value));
  if (frozen) fs.chmodSync(file, 0o400);
}

function observation(input: FormalizationEvaluationReviewerInput, nested: boolean): ReviewStatementObservation {
  const environment = resolveReviewEnvironment({ sourceToolchain: getLeanTaskEnvironment('mathlib').toolchain }, 'auto');
  const source = eraseFormalizationProofs(formalizationEvaluationLeanSource(input));
  const snapshot: ReviewStatementSnapshot = {
    schema: 'theorem-os.formalization-snapshot.v1', source, sourceSha256: mathDigest(source),
    environment: environment.environment, environmentDigest: environment.environmentDigest,
    targets: [{ name: /theorem (\w+)/u.exec(input.candidate)![1], declarationHash: mathDigest('handwritten:' + source),
      context: {
        type: nested ? '∀ (n : Nat), (∀ (m : Nat), Eq m m) → Eq n n' : '∀ (n : Nat), Eq n n',
        constants: [{ name: 'Eq', module: 'Init.Prelude', type: '{α : Sort u} → α → α → Prop' }], omitted: [],
        bindings: {
          binders: [{ id: 'b0', name: 'n', type: 'Nat', kind: 'explicit', dependencies: [] },
            ...(nested ? [{ id: 'b1', name: 'h', type: '∀ (m : Nat), Eq m m', kind: 'explicit' as const, dependencies: [] }] : [])],
          conclusion: '@Eq Nat n n', conclusionDependencies: ['b0'],
        },
      },
    }],
  };
  return { schema: 'theorem-os.formalization-review-observation.v2', caseId: input.caseId,
    inputDigest: formalizationEvaluationInputDigest(input), sourceSha256: snapshot.sourceSha256, environment,
    status: 'elaborated', snapshot, snapshotDigest: structuredReviewDigest(snapshot), diagnostics: '' };
}

function fixture(count = 1, nested = false) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'structured-review-preset-')));
  roots.push(base);
  const inputFile = path.join(base, 'PRIVATE_FILENAME_LABELS.jsonl'), bundleDirectory = path.join(base, 'bundle');
  const rows = Array.from({ length: count }, (_, index) => ({
    id: 'PRIVATE_SOURCE_' + index, sourceFamily: 'PRIVATE_FAMILY', split: 'test', kind: 'synthetic', label: 'correct',
    original: 'For every natural number n, n = n. Equality uses its usual natural-number meaning.' +
      (nested ? ' Assume every natural number equals itself.' : ''),
    header: 'import Mathlib\n',
    candidate: `theorem proposed_${index} (n : Nat)${nested ? ' (h : ∀ m : Nat, m = m)' : ''} : n = n := by rfl\n`,
    reference: 'PRIVATE_REFERENCE_CANARY', mutation: 'PRIVATE_MUTATION_CANARY', labelProvenance: 'PRIVATE_LABEL_CANARY',
  }));
  fs.writeFileSync(inputFile, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  prepareFormalizationEvaluation({ directory: bundleDirectory, inputFile, format: 'normalized',
    provenance: { name: 'Handwritten offline runtime fixtures', kind: 'synthetic-fixture',
      labelProvenance: 'Disposable fixtures, not reviewer accuracy annotations.',
      sourceToolchain: getLeanTaskEnvironment('mathlib').toolchain } });
  const prepared = readFormalizationEvaluationBundle(bundleDirectory);
  const inputs = [...prepared.inputs.values()].sort((left, right) => left.caseId.localeCompare(right.caseId));
  const observations = inputs.map(input => observation(input, nested));
  const replayFile = path.join(base, 'replay.json');
  const replay = { schema: 'theorem-os.formalization-review-replay.v2', bundleDigest: prepared.bundleDigest,
    observations, roles: [] as { caseId: string; role: string; output: unknown }[] };
  write(replayFile, replay);
  return { base, bundleDirectory, runDirectory: path.join(base, 'run'), prepared, inputs, observations, replay, replayFile,
    config: { execution: 'replay' as const, protocol: 'v2' as const, replayFile, environment: 'auto' as const } };
}

function review(input: StructuredReviewInput, equivalent = false,
  verdict: StructuredSemanticReview['verdict'] = 'approved'): StructuredSemanticReview {
  const value: StructuredSemanticReview = {
    schema: 'theorem-os.formalization-semantic-review.v2', caseId: input.caseId, inputDigest: structuredReviewDigest(input),
    evidenceVersion: STRUCTURED_REVIEW_EVIDENCE_VERSION,
    verdict, summary: input.role === 'primary' ? 'PRIVATE_FIRST_REVIEW_CANARY' : 'Independent preset recheck fixture.',
    checks: { domains: 'faithful', assumptions: 'faithful', conclusions: 'faithful', definitions: 'faithful',
      quantifierScope: 'faithful', instanceCoherence: 'faithful' },
    correspondences: structuredReviewAspects.map(aspect => ({ aspect, originalFragment: input.original,
      candidateFragment: 'Nat', relation: 'direct', explanation: 'Handwritten fragment-linking fixture for ' + aspect + '.',
      forwardArgument: '', reverseArgument: '', sourceReadings: [], mismatchEvidence: null })),
  };
  const conclusion = value.correspondences.find(item => item.aspect === 'conclusions')!;
  if (verdict !== 'approved') {
    value.checks.conclusions = verdict === 'unknown' ? 'uncertain' : 'mismatch';
    conclusion.relation = verdict === 'unknown' ? 'unresolved' : 'mismatch';
    if (verdict === 'changes_requested') conclusion.mismatchEvidence = {
      sourceClaim: 'The full source claim under its stated hypotheses.',
      candidateClaim: 'The full candidate claim under corresponding hypotheses.',
      separationArgument: 'Handwritten role-output fixture; this test does not certify semantic truth.',
    };
  } else if (equivalent) {
    conclusion.relation = 'equivalent';
    conclusion.forwardArgument = 'PRIVATE_FIRST_REVIEW_CONVERSION_CANARY: both equalities read n = n.';
    conclusion.reverseArgument = 'Reading the same reflexive equality supplies the reverse conversion.';
  }
  return value;
}

type TranslationInput = ReviewStatementSnapshot & { snapshotDigest: string };
type Role = 'primary' | 'backtranslate' | 'recheck';
type RoleInput = StructuredReviewInput | TranslationInput;
type Visit = { role: Role; input: RoleInput; config: MathAgentOptions; threadId: string; closed: boolean };
function backtranslation(input: TranslationInput): FormalizationTranslation {
  return { snapshotDigest: input.snapshotDigest, mathematics: 'Each natural number equals itself.',
    assumptions: [], definitions: ['Usual equality on natural numbers.'],
    targets: input.targets.map(target => ({ name: target.name, mathematics: 'For every natural number n, n = n.' })) };
}
function sessions(options: { equivalent?: boolean; recheckVerdict?: StructuredSemanticReview['verdict']; threadId?: string;
  behavior?: (visit: Visit, output: StructuredSemanticReview | FormalizationTranslation) => string | Promise<string>;
  afterClose?: (visit: Visit) => void } = {}) {
  const seen: Visit[] = [];
  const open = async (config: MathAgentOptions): Promise<MathAgentSession> => {
    const input = read(path.join(config.workspace, 'INPUT.json')) as RoleInput;
    const role = input.schema === 'theorem-os.formalization-snapshot.v1' ? 'backtranslate' : input.role;
    const visit: Visit = { role, input, config, threadId: options.threadId ?? 'preset-thread-' + randomUUID(), closed: false };
    seen.push(visit);
    return { threadId: visit.threadId, interrupt: async () => {}, close: async () => {
      if (visit.closed) return;
      visit.closed = true; options.afterClose?.(visit);
    }, run: async (_message, _messageId, workspace, onStarted) => {
      expect(workspace).toBe(config.workspace); onStarted('preset-turn-' + randomUUID());
      config.onUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
      const output = role === 'backtranslate' ? backtranslation(input as TranslationInput) :
        review(input as StructuredReviewInput, role === 'primary' && options.equivalent,
          role === 'recheck' ? options.recheckVerdict : undefined);
      if (options.behavior) return options.behavior(visit, output);
      write(path.join(workspace, 'OUTPUT.json'), output);
      config.completedOutput!.validate(output);
      return 'submitted';
    } };
  };
  return { open, seen };
}
function roleReceipt(f: ReturnType<typeof fixture>, role: Role) {
  return path.join(f.runDirectory, 'role-receipts', f.inputs[0].caseId + '-' + role + '.json');
}
function roleWorkspace(f: ReturnType<typeof fixture>, role: Role) {
  return path.join(f.runDirectory, read(roleReceipt(f, role)).attempt.workspace);
}
function decisions(file: string): { caseId: string; verdict: string; compileStatus: string; compilation?: unknown }[] {
  return read(file).decisions;
}

function modelFixture() {
  const f = fixture(), profile = path.join(f.base, 'disposable-profile'), manifest = path.join(f.base, 'build.json');
  fs.mkdirSync(profile); fs.writeFileSync(path.join(profile, 'config.toml'), 'model_provider = "offline-fixture"\n');
  write(manifest, { fixture: 'No model or runtime build is launched.' }, true);
  vi.spyOn(mathBuildManifest, 'readMathBuildManifest').mockReturnValue({ buildId: 'offline-fixture' } as any);
  const config = { execution: 'model' as const, protocol: 'v2' as const, environment: 'auto' as const,
    model: 'offline-fixture', effort: 'offline', profile, executable: '/offline/no-model', buildManifestRef: manifest };
  return { ...f, config, observeStatement: async (_directory: string, input: FormalizationEvaluationReviewerInput) =>
    f.observations.find(item => item.caseId === input.caseId)! };
}

type RepairTurn = { message: string; messageId: string; turnId: string };
type RepairVisit = Visit & { turns: RepairTurn[] };
function repairSessions(options: {
  verdict?: StructuredSemanticReview['verdict'];
  run?: (visit: RepairVisit, turn: RepairTurn, output: StructuredSemanticReview | FormalizationTranslation) => string | Promise<string>;
  close?: (visit: RepairVisit) => void;
} = {}) {
  const seen: RepairVisit[] = [];
  const open = async (config: MathAgentOptions): Promise<MathAgentSession> => {
    const input = read(path.join(config.workspace, 'INPUT.json')) as RoleInput;
    const role = input.schema === 'theorem-os.formalization-snapshot.v1' ? 'backtranslate' : input.role;
    const visit: RepairVisit = { input, role, config, threadId: 'offline-repair-thread-' + randomUUID(), closed: false, turns: [] };
    seen.push(visit);
    return { threadId: visit.threadId, interrupt: async () => {}, close: async () => {
      if (visit.closed) return;
      visit.closed = true; options.close?.(visit);
    }, run: async (message, messageId, workspace, onStarted) => {
      expect(visit.closed).toBe(false); expect(workspace).toBe(config.workspace);
      const turn = { message, messageId, turnId: 'offline-repair-turn-' + randomUUID() };
      visit.turns.push(turn); onStarted(turn.turnId);
      const count = visit.turns.length;
      config.onUsage({ inputTokens: 10 * count, outputTokens: 5 * count, totalTokens: 15 * count });
      const output = role === 'backtranslate' ? backtranslation(input as TranslationInput) :
        review(input as StructuredReviewInput, false, options.verdict);
      if (options.run) return options.run(visit, turn, output);
      write(path.join(workspace, 'OUTPUT.json'), output); return 'completed';
    } };
  };
  return { open, seen };
}
function feedbackEvidence(f: ReturnType<typeof modelFixture>, attempt: any) {
  return (attempt.outputFeedback ?? []).map((item: { file: string; sha256: string }) => {
    const file = path.resolve(f.runDirectory, item.file), raw = fs.readFileSync(file, 'utf8');
    expect(path.relative(f.runDirectory, file)).toMatch(new RegExp('^output-feedback/' + attempt.id + '/[a-f0-9-]{36}\\.json$'));
    expect(fs.statSync(file).mode & 0o222).toBe(0); expect(mathDigest(raw)).toBe(item.sha256);
    return read(file);
  });
}

describe('structured offline role execution', () => {
  it('runs only primary for an ordinary case and records preset decisions without compilation authority', async () => {
    const f = fixture(2), agent = sessions();
    const result = await runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, f.config, { openSession: agent.open });
    expect(result).toMatchObject({ status: 'complete', totalCases: 2, completedCases: 2, recheckedCases: 0,
      modelInvoked: false, compilationObserved: false, timeoutMs: 0,
      statementObservations: { elaborated: 2, unavailable: 0, authority: 'preset' } });
    expect(agent.seen.map(visit => visit.role)).toEqual(['primary', 'primary']);
    expect(agent.seen.map(visit => (visit.input as StructuredReviewInput).caseId)).toEqual(f.inputs.map(input => input.caseId));
    expect(agent.seen.every(visit => visit.closed)).toBe(true);
    expect(read(result.decisionsFile).origin).toMatchObject({ kind: 'preset' });
    expect(read(result.decisionsFile).origin).not.toHaveProperty('model');
    expect(decisions(result.decisionsFile)).toHaveLength(2);
    expect(decisions(result.decisionsFile).every(item => item.compileStatus === 'unknown' && !item.compilation)).toBe(true);
    expect(scoreFormalizationEvaluation(f.bundleDirectory, result.decisionsFile)).toMatchObject({
      modelInvoked: false, modelAccuracyMeasuredByThisCommand: false, interpretation: 'preset-verdict-fixture-not-model-accuracy',
      splits: { test: { cases: 2, approvals: 2, unknown: 0, compileUnknown: 2 } },
    });
    for (const visit of agent.seen) {
      expect(visit.config.threadId).toBeUndefined();
      expect(visit.config.turnTimeoutMs ?? 0).toBe(0);
      expect(visit.config.readIsolation).toEqual({ environment: 'mathlib' });
      expect(visit.config.profile).toBe(visit.config.workspace);
      for (const name of ['INPUT.json', 'ROLE.md', 'OUTPUT.schema.json', 'OUTPUT.json'])
        expect(fs.statSync(path.join(visit.config.workspace, name)).mode & 0o222).toBe(0);
      const visible = JSON.stringify({ input: visit.input, instructions: visit.config.instructions,
        schema: read(path.join(visit.config.workspace, 'OUTPUT.schema.json')) });
      for (const secret of ['PRIVATE_REFERENCE_CANARY', 'PRIVATE_MUTATION_CANARY', 'PRIVATE_LABEL_CANARY',
        'PRIVATE_SOURCE_', 'PRIVATE_FAMILY', 'PRIVATE_FILENAME_LABELS']) expect(visible).not.toContain(secret);
    }
  });

  it.each(['equivalence', 'nested-scope'] as const)('routes %s risk through three independent fresh sessions', async risk => {
    const f = fixture(1, risk === 'nested-scope'), agent = sessions({ equivalent: risk === 'equivalence' });
    const result = await runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, f.config, { openSession: agent.open });
    expect(result).toMatchObject({ status: 'complete', completedCases: 1, attempts: 3, recheckedCases: 1, disagreementCases: 0 });
    expect(agent.seen.map(visit => visit.role)).toEqual(['primary', 'backtranslate', 'recheck']);
    expect(new Set(agent.seen.map(visit => visit.threadId)).size).toBe(3);
    expect(new Set(agent.seen.map(visit => visit.config.workspace)).size).toBe(3);
    expect(agent.seen.every(visit => visit.closed && visit.config.threadId === undefined)).toBe(true);
    const back = agent.seen[1].input as TranslationInput, recheck = agent.seen[2].input as StructuredReviewInput;
    expect(Object.keys(back).sort()).toEqual(['environment', 'environmentDigest', 'schema', 'snapshotDigest', 'source', 'sourceSha256', 'targets']);
    expect(JSON.stringify(back)).not.toContain(f.inputs[0].original);
    expect(back).not.toHaveProperty('original'); expect(back).not.toHaveProperty('caseId');
    expect(recheck.original).toBe(f.inputs[0].original);
    expect(recheck.translation).toEqual(backtranslation(back));
    for (const payload of [back, recheck]) {
      expect(payload).not.toHaveProperty('review'); expect(payload).not.toHaveProperty('primaryReview');
      expect(JSON.stringify(payload)).not.toContain('PRIVATE_FIRST_REVIEW_CANARY');
      expect(JSON.stringify(payload)).not.toContain('PRIVATE_FIRST_REVIEW_CONVERSION_CANARY');
    }
    const receipt = read(path.join(f.runDirectory, 'receipts', f.inputs[0].caseId + '.json'));
    expect(receipt).toMatchObject({ verdict: 'approved', resolution: 'independent-agreement',
      reasons: [risk === 'equivalence' ? 'equivalence-conversion' : 'nested-quantifiers'] });
    expect(Object.keys(receipt.roles).sort()).toEqual(['backtranslate', 'primary', 'recheck']);
  });

  it('records reviewer disagreement as unknown while retaining both completed reviews', async () => {
    const f = fixture(), agent = sessions({ equivalent: true, recheckVerdict: 'changes_requested' });
    const result = await runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, f.config, { openSession: agent.open });
    expect(result).toMatchObject({ status: 'complete', completedCases: 1, unknownCases: 1, disagreementCases: 1 });
    expect(decisions(result.decisionsFile)).toMatchObject([{ verdict: 'unknown', compileStatus: 'unknown' }]);
    expect(read(path.join(f.runDirectory, 'receipts', f.inputs[0].caseId + '.json')))
      .toMatchObject({ verdict: 'unknown', resolution: 'review-disagreement' });
  });

  it.each(['shared', 'disjoint', 'shared-with-dispute'] as const)('checks rejection reasons across isolated roles: %s', async mode => {
    const f = fixture();
    const agent = sessions({ behavior: (visit, output) => {
      if (visit.role !== 'backtranslate') {
        const value = output as StructuredSemanticReview;
        const reject = (aspect: typeof structuredReviewAspects[number]) => {
          const item = value.correspondences.find(item => item.aspect === aspect)!;
          value.verdict = 'changes_requested'; value.checks[aspect] = 'mismatch'; item.relation = 'mismatch';
          item.mismatchEvidence = { sourceClaim: 'Complete source implication.', candidateClaim: 'Complete candidate implication.',
            separationArgument: 'Handwritten separation-evidence fixture, not a mathematical certificate.' };
        };
        reject(mode === 'disjoint' && visit.role === 'primary' ? 'domains' : 'conclusions');
        if (mode === 'shared-with-dispute' && visit.role === 'recheck') reject('domains');
      }
      write(path.join(visit.config.workspace, 'OUTPUT.json'), output); return 'completed';
    } });
    const result = await runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, f.config, { openSession: agent.open });
    expect(agent.seen.map(visit => visit.role)).toEqual(['primary', 'backtranslate', 'recheck']);
    expect(result).toMatchObject({ status: 'complete', completedCases: 1, attempts: 3,
      unknownCases: mode === 'disjoint' ? 1 : 0, aspectDisagreementCases: mode === 'shared' ? 0 : 1 });
    expect(read(path.join(f.runDirectory, 'receipts', f.inputs[0].caseId + '.json'))).toMatchObject({
      verdict: mode === 'disjoint' ? 'unknown' : 'changes_requested',
      resolution: mode === 'disjoint' ? 'review-disagreement' : 'shared-mismatch-aspect',
      reasons: ['proposed-rejection'],
      reviewAgreement: {
        sharedMismatches: mode === 'disjoint' ? [] : ['conclusions'],
        aspectDisagreements: mode === 'disjoint' ? ['domains', 'conclusions'] : mode === 'shared' ? [] : ['domains'],
      },
    });
    expect(await runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, f.config,
      { openSession: async () => { throw new Error('completed_case_must_not_reopen_roles'); } }))
      .toMatchObject({ status: 'complete', attempts: 3 });
  });

  it('rejects a thread reused between roles and closes both sessions', async () => {
    const f = fixture(), agent = sessions({ equivalent: true, threadId: 'preset-reused-thread' });
    await expect(runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, f.config, { openSession: agent.open }))
      .rejects.toThrow('formalization_review_thread_reused');
    expect(agent.seen.map(visit => visit.role)).toEqual(['primary', 'backtranslate']);
    expect(agent.seen.every(visit => visit.closed)).toBe(true);
  });

  it('uses the actual flock lease to prevent concurrent writes to the same run', async () => {
    const f = fixture();
    const agent = sessions({ behavior: async (visit, output) => {
      await expect(runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, f.config, { openSession: agent.open }))
        .rejects.toThrow('math_runtime_lease_busy');
      write(path.join(visit.config.workspace, 'OUTPUT.json'), output); return 'completed';
    } });
    const result = await runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, f.config, { openSession: agent.open });
    expect(result.status).toBe('complete'); expect(agent.seen).toHaveLength(1);
  });
});

describe('role checkpoints and complete receipt recovery', () => {
  it('resumes a failed recheck without rerunning primary or backtranslation, then restores final receipts without sessions', async () => {
    const f = fixture(); let failed = false;
    const agent = sessions({ equivalent: true, behavior: (visit, output) => {
      if (visit.role === 'recheck' && !failed) { failed = true; throw new Error('synthetic_recheck_transport_failure'); }
      write(path.join(visit.config.workspace, 'OUTPUT.json'), output); return 'submitted';
    } });
    const first = await runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, f.config, { openSession: agent.open });
    expect(first).toMatchObject({ status: 'partial', completedCases: 0, unknownCases: 1, attempts: 3,
      caseErrors: { [f.inputs[0].caseId]: 'synthetic_recheck_transport_failure' } });
    expect(decisions(first.decisionsFile)).toMatchObject([{ verdict: 'unknown' }]);
    expect(fs.existsSync(roleReceipt(f, 'primary'))).toBe(true);
    expect(fs.existsSync(roleReceipt(f, 'backtranslate'))).toBe(true);
    expect(fs.existsSync(roleReceipt(f, 'recheck'))).toBe(false);
    const second = await runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, f.config, { openSession: agent.open });
    expect(second).toMatchObject({ status: 'complete', completedCases: 1, attempts: 4, caseErrors: {} });
    expect(agent.seen.map(visit => visit.role)).toEqual(['primary', 'backtranslate', 'recheck', 'recheck']);
    const savedDecisions = read(second.decisionsFile);
    const third = await runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, f.config, { openSession: agent.open });
    expect(third.status).toBe('complete'); expect(agent.seen).toHaveLength(4);
    expect(read(third.decisionsFile)).toEqual(savedDecisions);
  });

  it('rebuilds a lost state checkpoint from all three frozen role receipts without opening sessions', async () => {
    const f = fixture(), agent = sessions({ equivalent: true });
    const first = await runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, f.config, { openSession: agent.open });
    const savedDecisions = read(first.decisionsFile);
    fs.rmSync(path.join(f.runDirectory, 'state.json'));
    const recovered = await runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, f.config, { openSession: agent.open });
    expect(recovered).toMatchObject({ status: 'complete', completedCases: 1, attempts: 3, recheckedCases: 1 });
    expect(agent.seen).toHaveLength(3); expect(read(recovered.decisionsFile)).toEqual(savedDecisions);
    expect(read(path.join(f.runDirectory, 'state.json')).attempts).toHaveLength(3);
  });

  it.each(['primary', 'backtranslate', 'recheck'] as const)('refuses a final case with a missing %s receipt before opening any session', async role => {
    const f = fixture(), agent = sessions({ equivalent: true });
    const first = await runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, f.config, { openSession: agent.open });
    const savedDecisions = read(first.decisionsFile);
    fs.rmSync(roleReceipt(f, role));
    await expect(runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, f.config, { openSession: agent.open }))
      .rejects.toThrow('formalization_review_receipt_missing');
    expect(agent.seen).toHaveLength(3); expect(read(first.decisionsFile)).toEqual(savedDecisions);
  });

  it.each(['final-receipt', 'role-receipt', 'output', 'observation'] as const)('rejects changed %s evidence without reopening sessions', async kind => {
    const f = fixture(), agent = sessions();
    const first = await runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, f.config, { openSession: agent.open });
    const savedDecisions = read(first.decisionsFile);
    const file = kind === 'final-receipt' ? path.join(f.runDirectory, 'receipts', f.inputs[0].caseId + '.json') :
      kind === 'role-receipt' ? roleReceipt(f, 'primary') : kind === 'output' ? path.join(roleWorkspace(f, 'primary'), 'OUTPUT.json') :
        path.join(f.runDirectory, 'observations', f.inputs[0].caseId + '.json');
    const changed = read(file);
    if (kind === 'final-receipt') changed.inputDigest = 'f'.repeat(64);
    else if (kind === 'role-receipt') changed.outputDigest = 'f'.repeat(64);
    else if (kind === 'output') changed.summary = 'Changed completed output.';
    else changed.diagnostics = 'Changed completed observation.';
    write(file, changed, true);
    await expect(runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, f.config, { openSession: agent.open }))
      .rejects.toThrow('formalization_review_receipt_changed');
    expect(agent.seen).toHaveLength(1); expect(read(first.decisionsFile)).toEqual(savedDecisions);
  });
});

describe('frozen protocol and request binding', () => {
  it('rejects an opted-in replay without semantic context before opening any role', async () => {
    const f = fixture(), agent = sessions();
    await expect(runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory,
      { ...f.config, contextProtocol: 'kernel-v1' }, { openSession: agent.open }))
      .rejects.toThrow('formalization_review_observation_missing_semantic_context');
    expect(agent.seen).toHaveLength(0);
    expect(fs.existsSync(f.runDirectory)).toBe(false);
  });

  it('rejects an injected observation without requested semantic context before opening any role', async () => {
    const f = modelFixture(), agent = sessions();
    const result = await runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory,
      { ...f.config, contextProtocol: 'kernel-v1' }, { openSession: agent.open, observeStatement: f.observeStatement });
    expect(result).toMatchObject({ status: 'partial', attempts: 0, completedCases: 0, unknownCases: 1,
      caseErrors: { [f.inputs[0].caseId]: 'formalization_review_observation_missing_semantic_context' } });
    expect(agent.seen).toHaveLength(0);
  });

  it('rejects kernel-v2 replay or injected observations missing structure context before opening any role', async () => {
    const replay = fixture(), replayAgent = sessions();
    for (const observation of replay.observations) {
      for (const target of observation.snapshot!.targets) target.context.semantic = semanticContextFixture();
      observation.snapshotDigest = structuredReviewDigest(observation.snapshot);
    }
    write(replay.replayFile, replay.replay);
    await expect(runStructuredFormalizationReview(replay.bundleDirectory, replay.runDirectory,
      { ...replay.config, contextProtocol: 'kernel-v2' }, { openSession: replayAgent.open }))
      .rejects.toThrow('formalization_review_observation_missing_structure_context');
    expect(fs.existsSync(replay.runDirectory)).toBe(false);
    expect(replayAgent.seen).toHaveLength(0);
    const model = modelFixture(), modelAgent = sessions();
    for (const observation of model.observations) {
      for (const target of observation.snapshot!.targets) target.context.semantic = semanticContextFixture();
      observation.snapshotDigest = structuredReviewDigest(observation.snapshot);
    }
    const result = await runStructuredFormalizationReview(model.bundleDirectory, model.runDirectory,
      { ...model.config, contextProtocol: 'kernel-v2' }, { openSession: modelAgent.open, observeStatement: model.observeStatement });
    expect(result).toMatchObject({ status: 'partial', attempts: 0, completedCases: 0, unknownCases: 1,
      caseErrors: { [model.inputs[0].caseId]: 'formalization_review_observation_missing_structure_context' } });
    expect(modelAgent.seen).toHaveLength(0);
    expect(decisions(result.decisionsFile)[0].verdict).toBe('unknown');
  });

  it.each([undefined, 'kernel-v1', 'kernel-v2'] as const)(
    'selects the host elaboration options for %s and restores without another observation', async contextProtocol => {
      const f = modelFixture(), agent = sessions();
      const snapshot = f.observations[0].snapshot!;
      for (const target of snapshot.targets) {
        if (contextProtocol) target.context.semantic = semanticContextFixture();
        if (contextProtocol === 'kernel-v2') target.context.structures = { schema: 'theorem-os.lean-statement-structures.v1', entries: [] };
      }
      expectedElaborationAdapterCalls = 1;
      forbidden.lean.mockResolvedValue({ sourceSha256: snapshot.sourceSha256, snapshot, snapshotDigest: structuredReviewDigest(snapshot) });
      const config = { ...f.config, ...(contextProtocol ? { contextProtocol } : {}) };
      const first = await runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, config, { openSession: agent.open });
      expect(first).toMatchObject({ status: 'complete', attempts: 1, unknownCases: 0, modelInvoked: false });
      const elaborationOptions = forbidden.lean.mock.calls[0]![3];
      expect(elaborationOptions).toMatchObject({ detailedContext: true, timeoutMs: 0 });
      if (contextProtocol === 'kernel-v2') expect(elaborationOptions).toHaveProperty('structureContext', true);
      else expect(elaborationOptions).not.toHaveProperty('structureContext');
      if (contextProtocol === 'kernel-v1') expect(elaborationOptions).toHaveProperty('semanticContext', true);
      else expect(elaborationOptions).not.toHaveProperty('semanticContext');
      const roleInput = agent.seen[0].input as StructuredReviewInput;
      expect(roleInput.observation.snapshot).toEqual(snapshot);
      const resumed = await runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, config, { openSession: agent.open });
      expect(resumed).toMatchObject({ status: 'complete', attempts: 1, unknownCases: 0 });
      expect(agent.seen).toHaveLength(1);
    });

  it('records a failed kernel-v2 structure export as unavailable and unknown without opening a role', async () => {
    const f = modelFixture(), agent = sessions();
    expectedElaborationAdapterCalls = 1;
    forbidden.lean.mockRejectedValue(new Error('synthetic structure export unavailable'));
    const result = await runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory,
      { ...f.config, contextProtocol: 'kernel-v2' }, { openSession: agent.open });
    expect(result).toMatchObject({ status: 'complete', attempts: 0, completedCases: 1, unknownCases: 1,
      modelInvoked: false, statementObservations: { elaborated: 0, unavailable: 1 } });
    expect(agent.seen).toHaveLength(0);
    expect(read(path.join(f.runDirectory, 'receipts', f.inputs[0].caseId + '.json')))
      .toMatchObject({ roles: {}, verdict: 'unknown', resolution: 'observation-unavailable' });
  });

  it.each([undefined, 'kernel-v1', 'kernel-v2'] as const)('freezes selected instruction bytes and restores context protocol %s', async contextProtocol => {
    const f = fixture(1, true), agent = sessions();
    const semanticContext = contextProtocol !== undefined, structureContext = contextProtocol === 'kernel-v2';
    if (semanticContext) {
      for (const observation of f.observations) {
        for (const target of observation.snapshot!.targets) {
          target.context.semantic = semanticContextFixture();
          if (structureContext) target.context.structures = { schema: 'theorem-os.lean-statement-structures.v1', entries: [] };
        }
        observation.snapshotDigest = structuredReviewDigest(observation.snapshot);
      }
      write(f.replayFile, f.replay);
    }
    const config = { ...f.config, ...(contextProtocol ? { contextProtocol } : {}) };
    const first = await runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, config, { openSession: agent.open });
    expect(first).toMatchObject({ status: 'complete', attempts: 3, recheckedCases: 1 });
    const file = path.join(f.runDirectory, 'request.json'), requestText = fs.readFileSync(file, 'utf8'), request = read(file);
    if (semanticContext) expect(request.configuration.contextProtocol).toBe(contextProtocol);
    else expect(request.configuration).not.toHaveProperty('contextProtocol');
    expect(request.instructions).toEqual({ primary: mathDigest(formalizationReviewInstructions('review', semanticContext, structureContext)),
      recheck: mathDigest(formalizationReviewInstructions('review', semanticContext, structureContext)),
      backtranslate: mathDigest(formalizationReviewInstructions('backtranslate', semanticContext, structureContext)) });
    for (const role of ['primary', 'backtranslate', 'recheck'] as const) {
      expect(fs.readFileSync(path.join(roleWorkspace(f, role), 'ROLE.md'), 'utf8'))
        .toBe(formalizationReviewInstructions(role === 'backtranslate' ? 'backtranslate' : 'review', semanticContext, structureContext));
    }
    const resumed = await runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, config, { openSession: agent.open });
    expect(resumed).toMatchObject({ status: 'complete', attempts: 3, recheckedCases: 1 });
    expect(fs.readFileSync(file, 'utf8')).toBe(requestText);
    expect(agent.seen).toHaveLength(3);
    if (semanticContext) {
      await expect(runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, f.config, { openSession: agent.open }))
        .rejects.toThrow('formalization_review_request_changed');
      expect(agent.seen).toHaveLength(3);
    }
  });

  it.each(['INPUT.json', 'ROLE.md', 'OUTPUT.schema.json'] as const)('rejects altered %s even when the role fails', async name => {
    const f = fixture(), agent = sessions({ behavior: visit => {
      const file = path.join(visit.config.workspace, name);
      fs.chmodSync(file, 0o600); fs.appendFileSync(file, '\nchanged'); fs.chmodSync(file, 0o400);
      return 'failed';
    } });
    await expect(runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, f.config, { openSession: agent.open }))
      .rejects.toThrow('formalization_review_protocol_changed');
    expect(agent.seen).toHaveLength(1); expect(agent.seen[0].closed).toBe(true);
  });

  it.each(['configuration', 'replay', 'bundle-input', 'request-permissions'] as const)('binds resumed execution to frozen %s', async kind => {
    const f = fixture(), agent = sessions();
    await runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, f.config, { openSession: agent.open });
    const changedConfig = { ...f.config, environment: kind === 'configuration' ? 'mathlib' as const : f.config.environment };
    if (kind === 'replay') fs.appendFileSync(f.replayFile, '\n');
    if (kind === 'bundle-input') {
      const file = path.join(f.bundleDirectory, 'review', 'inputs', f.inputs[0].caseId + '.json');
      write(file, { ...read(file), header: 'import Mathlib\n\n' }, true);
    }
    if (kind === 'request-permissions') fs.chmodSync(path.join(f.runDirectory, 'request.json'), 0o600);
    await expect(runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, changedConfig, { openSession: agent.open }))
      .rejects.toThrow(kind === 'bundle-input' ? 'formalization_eval_reviewer_input_changed' :
        kind === 'request-permissions' ? 'formalization_review_evidence_not_frozen' : 'formalization_review_request_changed');
    expect(agent.seen).toHaveLength(1);
  });

  it('closes the output writer before accepting its completed file', async () => {
    const f = fixture(), agent = sessions({ behavior: visit => {
      fs.writeFileSync(path.join(visit.config.workspace, 'OUTPUT.json'), '{"incomplete":'); return 'completed';
    }, afterClose: visit => write(path.join(visit.config.workspace, 'OUTPUT.json'), review(visit.input as StructuredReviewInput)) });
    expect(await runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, f.config, { openSession: agent.open }))
      .toMatchObject({ status: 'complete', completedCases: 1 });
    expect(agent.seen[0].closed).toBe(true);
  });

  it('keeps a failed session unknown even if it writes a valid review', async () => {
    const f = fixture(), agent = sessions({ behavior: (visit, output) => {
      write(path.join(visit.config.workspace, 'OUTPUT.json'), output); return 'failed';
    } });
    const result = await runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, f.config, { openSession: agent.open });
    expect(result).toMatchObject({ status: 'partial', completedCases: 0, unknownCases: 1,
      caseErrors: { [f.inputs[0].caseId]: 'formalization_review_session_incomplete' } });
    expect(decisions(result.decisionsFile)).toMatchObject([{ verdict: 'unknown' }]);
    expect(fs.existsSync(roleReceipt(f, 'primary'))).toBe(false);
  });
});

describe('model output format correction in the same session', () => {
  it('corrects missing, JSON, schema and fragment failures without a turn cap and freezes exact feedback bytes', async () => {
    const f = modelFixture(), invalidTexts: (string | null)[] = [];
    const agent = repairSessions({ run: (visit, _turn, output) => {
      const index = visit.turns.length - 1, file = path.join(visit.config.workspace, 'OUTPUT.json');
      if (!index) visit.config.onUsageIncomplete?.();
      const badFragment = structuredClone(output) as StructuredSemanticReview;
      badFragment.correspondences[0].candidateFragment = 'ABSENT_FRAGMENT_WITH_UNICODE_λ';
      const invalid = [null, '{"unfinished":', '{}\n', JSON.stringify(badFragment, null, 2) + '\n'];
      if (index < invalid.length) {
        const text = invalid[index]; invalidTexts.push(text);
        if (text !== null) fs.writeFileSync(file, text);
      } else write(file, output);
      return 'completed';
    } });
    const result = await runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, f.config,
      { openSession: agent.open, observeStatement: f.observeStatement });
    expect(result).toMatchObject({ status: 'complete', completedCases: 1, attempts: 1 });
    expect(agent.seen).toHaveLength(1); expect(agent.seen[0].closed).toBe(true);
    const visit = agent.seen[0], attempt = read(roleReceipt(f, 'primary')).attempt;
    expect(visit.turns).toHaveLength(5);
    expect(new Set(visit.turns.map(turn => turn.messageId)).size).toBe(5);
    expect(attempt).toMatchObject({ status: 'completed', threadId: visit.threadId,
      turnId: visit.turns.at(-1)!.turnId, usage: { inputTokens: 50, outputTokens: 25, totalTokens: 75 }, usageIncomplete: true });
    expect(attempt.turns).toHaveLength(5);
    for (const [index, turn] of visit.turns.entries()) expect(attempt.turns[index]).toMatchObject({
      messageId: turn.messageId, messageSha256: mathDigest(turn.message), turnId: turn.turnId, sessionStatus: 'completed',
      usage: { inputTokens: 10 * (index + 1), outputTokens: 5 * (index + 1), totalTokens: 15 * (index + 1) },
    });
    expect(attempt.turns[0].usageIncomplete).toBe(true);
    const feedback = feedbackEvidence(f, attempt);
    expect(feedback).toHaveLength(4);
    for (const [index, saved] of feedback.entries()) {
      expect(saved).toMatchObject({ trigger: 'completed-turn-validation', turnId: visit.turns[index].turnId,
        outputText: invalidTexts[index], outputSha256: invalidTexts[index] === null ? null : mathDigest(invalidTexts[index]!) });
      expect(saved.error).toEqual(expect.any(String)); expect(saved.error.length).toBeGreaterThan(0);
      expect(saved.message).toBe(visit.turns[index + 1].message);
    }
    expect(read(path.join(f.runDirectory, 'state.json')).attempts[0]).toEqual(attempt);
    expect(decisions(result.decisionsFile)).toMatchObject([{ verdict: 'approved', compileStatus: 'unknown' }]);
  });

  it('archives active-turn validation feedback and still revalidates submitted output after close', async () => {
    const f = modelFixture(); let sent = '', invalidText = '';
    const agent = repairSessions({ run: (visit, turn, output) => {
      const invalid = structuredClone(output) as StructuredSemanticReview;
      invalid.correspondences[0].candidateFragment = 'ABSENT_ACTIVE_FRAGMENT';
      invalidText = JSON.stringify(invalid, null, 2) + '\n';
      fs.writeFileSync(path.join(visit.config.workspace, 'OUTPUT.json'), invalidText);
      let invalidError: unknown;
      try { visit.config.completedOutput!.validate(invalid); } catch (cause) { invalidError = cause; }
      expect(invalidError).toBeInstanceOf(Error);
      sent = visit.config.completedOutput!.validationFeedback!(invalidError, { text: invalidText, turnId: turn.turnId });
      expect(sent).toEqual(expect.any(String)); expect(sent.length).toBeGreaterThan(0);
      write(path.join(visit.config.workspace, 'OUTPUT.json'), output); return 'submitted';
    }, close: visit => {
      const file = path.join(visit.config.workspace, 'OUTPUT.json');
      write(file, { ...read(file), summary: 'Final bytes written while closing the disposable writer.' });
    } });
    const result = await runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, f.config,
      { openSession: agent.open, observeStatement: f.observeStatement });
    expect(result).toMatchObject({ status: 'complete', completedCases: 1, attempts: 1 });
    const visit = agent.seen[0], receipt = read(roleReceipt(f, 'primary'));
    expect(visit.closed).toBe(true); expect(visit.turns).toHaveLength(1);
    expect(feedbackEvidence(f, receipt.attempt)).toMatchObject([{ trigger: 'active-turn-validation',
      turnId: visit.turns[0].turnId, outputText: invalidText, outputSha256: mathDigest(invalidText), message: sent }]);
    const raw = fs.readFileSync(path.join(visit.config.workspace, 'OUTPUT.json'), 'utf8');
    expect(JSON.parse(raw).summary).toBe('Final bytes written while closing the disposable writer.');
    expect(receipt.outputFileSha256).toBe(mathDigest(raw));
  });

  it.each(['completed', 'submitted'])('rejects %s output invalidated while closing without accepting or repairing a closed session', async status => {
    const f = modelFixture(), agent = repairSessions({ run: (visit, _turn, output) => {
      write(path.join(visit.config.workspace, 'OUTPUT.json'), output); return status;
    }, close: visit => {
      const file = path.join(visit.config.workspace, 'OUTPUT.json'), changed = read(file);
      changed.correspondences[0].candidateFragment = 'INVALID_AFTER_CLOSE'; write(file, changed);
    } });
    const result = await runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, f.config,
      { openSession: agent.open, observeStatement: f.observeStatement });
    expect(result).toMatchObject({ status: 'partial', completedCases: 0, unknownCases: 1, attempts: 1 });
    expect(agent.seen).toHaveLength(1); expect(agent.seen[0].closed).toBe(true); expect(agent.seen[0].turns).toHaveLength(1);
    expect(fs.existsSync(roleReceipt(f, 'primary'))).toBe(false);
    expect(decisions(result.decisionsFile)).toMatchObject([{ verdict: 'unknown' }]);
  });

  it.each(['failed', 'checkpoint', 'interrupted'])('does not correct or accept a %s session despite a valid output file', async status => {
    const f = modelFixture(), agent = repairSessions({ run: (visit, _turn, output) => {
      write(path.join(visit.config.workspace, 'OUTPUT.json'), output); return status;
    } });
    const result = await runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, f.config,
      { openSession: agent.open, observeStatement: f.observeStatement });
    expect(result).toMatchObject({ status: 'partial', completedCases: 0, unknownCases: 1, attempts: 1 });
    expect(agent.seen[0].closed).toBe(true); expect(agent.seen[0].turns).toHaveLength(1);
    const attempt = read(path.join(f.runDirectory, 'state.json')).attempts[0];
    expect(attempt.status).toBe('failed'); expect(attempt.sessionStatus).toBe(status);
    expect(attempt.outputFeedback ?? []).toHaveLength(0); expect(fs.existsSync(roleReceipt(f, 'primary'))).toBe(false);
    expect(decisions(result.decisionsFile)).toMatchObject([{ verdict: 'unknown' }]);
  });

  it('keeps a valid unknown and reuses its final routed receipts on resume without extra turns or sessions', async () => {
    const f = modelFixture(), agent = repairSessions({ verdict: 'unknown' });
    const options = { openSession: agent.open, observeStatement: f.observeStatement };
    const result = await runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, f.config, options);
    expect(result).toMatchObject({ status: 'complete', completedCases: 1, unknownCases: 1, attempts: 3, recheckedCases: 1 });
    expect(agent.seen.map(visit => visit.role)).toEqual(['primary', 'backtranslate', 'recheck']);
    expect(agent.seen.every(visit => visit.closed && visit.turns.length === 1)).toBe(true);
    const receipts = ['primary', 'backtranslate', 'recheck'].map(role => fs.readFileSync(roleReceipt(f, role as Role), 'utf8'));
    expect(receipts.every(raw => (JSON.parse(raw).attempt.outputFeedback ?? []).length === 0)).toBe(true);
    const savedDecisions = fs.readFileSync(result.decisionsFile, 'utf8');
    const resumed = await runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, f.config, options);
    expect(resumed).toMatchObject({ status: 'complete', unknownCases: 1, attempts: 3 });
    expect(agent.seen).toHaveLength(3); expect(fs.readFileSync(result.decisionsFile, 'utf8')).toBe(savedDecisions);
    expect(['primary', 'backtranslate', 'recheck'].map(role => fs.readFileSync(roleReceipt(f, role as Role), 'utf8'))).toEqual(receipts);
  });

  it('preserves one-shot replay failure instead of sampling corrective turns', async () => {
    const f = fixture(), agent = sessions({ behavior: visit => {
      fs.writeFileSync(path.join(visit.config.workspace, 'OUTPUT.json'), '{"unfinished":'); return 'completed';
    } });
    const result = await runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, f.config, { openSession: agent.open });
    expect(result).toMatchObject({ status: 'partial', completedCases: 0, unknownCases: 1, attempts: 1 });
    expect(agent.seen).toHaveLength(1); expect(agent.seen[0].closed).toBe(true);
    expect(read(path.join(f.runDirectory, 'state.json')).attempts[0].outputFeedback ?? []).toHaveLength(0);
  });
});

describe('saved replay observations and full-denominator accounting', () => {
  it('runs saved preset roles without a session adapter or production fallback', async () => {
    const f = fixture();
    f.replay.roles.push({ caseId: f.inputs[0].caseId, role: 'primary',
      output: review(structuredReviewInput(f.inputs[0], f.observations[0])) });
    write(f.replayFile, f.replay);
    const result = await runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, f.config);
    expect(result).toMatchObject({ status: 'complete', adapter: 'saved-preset', modelInvoked: false,
      compilationObserved: false, statementObservations: { authority: 'preset' } });
    expect(read(result.decisionsFile).origin.kind).toBe('preset');
  });

  it('retains every case as unknown with explicit errors when replay observations are absent', async () => {
    const f = fixture(3), agent = sessions();
    f.replay.observations = []; write(f.replayFile, f.replay);
    const result = await runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, f.config, { openSession: agent.open });
    expect(result).toMatchObject({ status: 'partial', totalCases: 3, completedCases: 0, failedOrPendingCases: 3,
      unknownCases: 3, attempts: 0, statementObservations: { elaborated: 0, unavailable: 0, authority: 'preset' } });
    expect(result.caseErrors).toEqual(Object.fromEntries(f.inputs.map(input => [input.caseId, 'formalization_review_replay_observation_missing'])));
    expect(agent.seen).toHaveLength(0);
    expect(decisions(result.decisionsFile)).toHaveLength(3);
    expect(scoreFormalizationEvaluation(f.bundleDirectory, result.decisionsFile).splits.test)
      .toMatchObject({ cases: 3, unknown: 3, compileUnknown: 3, coverage: { numerator: 0, denominator: 3, rate: 0 } });
  });

  it('records an unavailable statement as an explicit unknown without opening any role', async () => {
    const f = fixture(), agent = sessions();
    Object.assign(f.replay.observations[0], { status: 'unavailable', snapshot: null, snapshotDigest: null,
      diagnostics: 'Synthetic toolchain observation unavailable.' });
    write(f.replayFile, f.replay);
    const result = await runStructuredFormalizationReview(f.bundleDirectory, f.runDirectory, f.config, { openSession: agent.open });
    expect(result).toMatchObject({ status: 'complete', completedCases: 1, unknownCases: 1, attempts: 0,
      statementObservations: { elaborated: 0, unavailable: 1 } });
    expect(agent.seen).toHaveLength(0);
    expect(read(path.join(f.runDirectory, 'receipts', f.inputs[0].caseId + '.json')))
      .toMatchObject({ roles: {}, verdict: 'unknown', resolution: 'observation-unavailable', reasons: ['statement-observation-unavailable'] });
  });
});
