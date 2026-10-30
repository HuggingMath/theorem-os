import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MathAgentOptions, MathAgentSession } from '../src/runtime/codexSession';
import { prepareFormalizationEvaluation, readFormalizationEvaluationBundle,
  formalizationEvaluationInputDigest, scoreFormalizationEvaluation,
  type FormalizationEvaluationReviewerInput } from '../src/math/formalizationEvaluation';
import { assertFormalizationSemanticReview, formalizationSemanticReviewSchema,
  type FormalizationSemanticReview } from '../src/math/formalizationReview';
import { runFormalizationReview } from '../src/solver/formalizationReview';

const production = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../src/runtime/codexSession', () => ({ createCodexMathSession: production.open }));

// Disposable handwritten inputs and verdicts only. No model, provider, Lean compiler,
// reference comparator or external benchmark is used by this suite.
const roots: string[] = [];
beforeEach(() => {
  production.open.mockReset();
  production.open.mockImplementation(async () => { throw new Error('test_forbids_real_model_session'); });
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
function write(file: string, value: unknown) {
  if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
  fs.writeFileSync(file, JSON.stringify(value));
}
function review(input: FormalizationEvaluationReviewerInput,
  verdict: FormalizationSemanticReview['verdict'] = 'approved'): FormalizationSemanticReview {
  return { schema: 'theorem-os.formalization-semantic-review.v1', caseId: input.caseId,
    inputDigest: formalizationEvaluationInputDigest(input), verdict,
    summary: 'Preset output for local protocol testing; no actual semantic reviewer ran.',
    checks: { domains: 'faithful', assumptions: 'faithful',
      conclusions: verdict === 'approved' ? 'faithful' : verdict === 'changes_requested' ? 'mismatch' : 'uncertain',
      definitions: 'faithful' } };
}
function fixture(count = 3) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-review-preset-')));
  roots.push(base);
  const inputFile = path.join(base, 'PRIVATE_FILENAME_LABELS.jsonl'), bundleDirectory = path.join(base, 'bundle');
  const rows = [
    { id: 'PRIVATE_SOURCE_POSITIVE', candidate: 'theorem proposed_a (n : Nat) : n + 0 = n := by sorry\n', label: 'correct' },
    { id: 'PRIVATE_SOURCE_NEGATIVE', candidate: 'theorem proposed_b (n : Nat) : True := by sorry\n', label: 'incorrect' },
    { id: 'PRIVATE_SOURCE_UNCERTAIN', candidate: 'theorem proposed_c (n : Nat) : 0 + n = n := by sorry\n', label: 'correct' },
  ].slice(0, count).map(item => ({ ...item, sourceFamily: 'PRIVATE_SOURCE_FAMILY', split: 'test', kind: 'mutation',
    original: 'For every natural number n, prove n + 0 = n.', header: 'import Std\n',
    reference: 'PRIVATE_REFERENCE_CANARY', mutation: 'PRIVATE_MUTATION_CANARY',
    labelProvenance: 'PRIVATE_LABEL_PROVENANCE_CANARY' }));
  fs.writeFileSync(inputFile, rows.map(item => JSON.stringify(item)).join('\n') + '\n');
  prepareFormalizationEvaluation({ directory: bundleDirectory, inputFile, format: 'normalized',
    provenance: { name: 'Preset test fixture, never a benchmark result', kind: 'synthetic-fixture',
      sourceToolchain: 'leanprover/lean4:v4.8.0', labelProvenance: 'Handwritten fixtures; no actual reviewer annotations.' } });
  const prepared = readFormalizationEvaluationBundle(bundleDirectory);
  const inputs = [...prepared.inputs.values()].sort((a, b) => a.caseId.localeCompare(b.caseId));
  const outputs = inputs.map(input => review(input, input.candidate.includes(' : True') ? 'changes_requested' : 'approved'));
  const replayFile = path.join(base, 'replay.json');
  write(replayFile, { schema: 'theorem-os.formalization-review-replay.v1', bundleDigest: prepared.bundleDigest, outputs });
  return { base, bundleDirectory, runDirectory: path.join(base, 'review-run'), inputs, prepared, outputs, replayFile,
    config: { execution: 'replay' as const, replayFile, environment: 'standard' as const } };
}
type SessionBehavior = (input: FormalizationEvaluationReviewerInput, config: MathAgentOptions,
  visit: number) => Promise<string> | string;
function sessions(behavior?: SessionBehavior, options: {
  threadId?: string; afterClose?: (input: FormalizationEvaluationReviewerInput, config: MathAgentOptions) => void;
} = {}) {
  const seen: { input: FormalizationEvaluationReviewerInput; config: MathAgentOptions; closed: boolean }[] = [];
  const open = async (config: MathAgentOptions): Promise<MathAgentSession> => {
    const input = read(path.join(config.workspace, 'INPUT.json')) as FormalizationEvaluationReviewerInput;
    const entry = { input, config, closed: false }; seen.push(entry);
    return { threadId: options.threadId ?? 'preset-thread-' + randomUUID(),
      interrupt: async () => {}, close: async () => {
        if (entry.closed) return;
        entry.closed = true; options.afterClose?.(input, config);
      },
      run: async (_message, _messageId, workspace, onStarted) => {
        expect(workspace).toBe(config.workspace); onStarted('preset-turn-' + randomUUID());
        config.onUsage({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
        if (behavior) return behavior(input, config, seen.length);
        const output = review(input);
        write(path.join(workspace, 'OUTPUT.json'), output);
        config.completedOutput!.validate(output);
        return 'submitted';
      } };
  };
  return { open, seen };
}
function filesUnder(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}
function firstOutput(runDirectory: string) {
  const file = filesUnder(runDirectory).find(file => path.basename(file) === 'OUTPUT.json');
  expect(file).toBeDefined(); return file!;
}

describe('isolated semantic review execution with offline sessions', () => {
  it('runs preset decisions through the existing scorer without opening a production session', async () => {
    const f = fixture();
    const result = await runFormalizationReview(f.bundleDirectory, f.runDirectory, f.config);
    expect(result).toMatchObject({ status: 'complete', modelInvoked: false });
    expect(production.open).not.toHaveBeenCalled();
    const decisions = read(result.decisionsFile);
    expect(decisions).toMatchObject({ schema: 'theorem-os.formalization-review-decisions.v1',
      bundleDigest: f.prepared.bundleDigest, origin: { kind: 'preset' } });
    expect(decisions.origin).not.toHaveProperty('model');
    expect(decisions.decisions).toHaveLength(3);
    expect(decisions.decisions.every((item: any) => item.compileStatus === 'unknown' && !('compilation' in item))).toBe(true);
    const score = scoreFormalizationEvaluation(f.bundleDirectory, result.decisionsFile);
    expect(score).toMatchObject({ modelInvoked: false, modelAccuracyMeasuredByThisCommand: false,
      interpretation: 'preset-verdict-fixture-not-model-accuracy' });
    expect(score.splits.test).toMatchObject({ cases: 3, positives: 2, negatives: 1,
      trueAcceptances: 2, trueRejections: 1, falseAcceptances: 0, falseRejections: 0,
      unknown: 0, compileUnknown: 3, coverage: { numerator: 3, denominator: 3, rate: 1 } });
    expect(fs.existsSync(path.join(f.runDirectory, 'state.json'))).toBe(true);
    for (const input of f.inputs) expect(fs.existsSync(path.join(f.runDirectory, 'receipts', input.caseId + '.json'))).toBe(true);
  });

  it('visits opaque IDs in order and exposes only each exact blinded input and bound output contract', async () => {
    const f = fixture(), agent = sessions((input, config) => {
      expect(fs.readdirSync(config.workspace).sort()).toEqual(['INPUT.json', 'OUTPUT.schema.json', 'ROLE.md']);
      expect(input).toEqual(f.prepared.inputs.get(input.caseId));
      expect(Object.keys(input).sort()).toEqual(['candidate', 'caseId', 'header', 'original', 'schema']);
      expect(config.readIsolation).toEqual({ environment: 'standard' });
      expect(config.threadId).toBeUndefined();
      expect(config.turnTimeoutMs === undefined || config.turnTimeoutMs === 0).toBe(true);
      expect(config.completedOutput!.file).toBe(path.join(config.workspace, 'OUTPUT.json'));
      const schema = read(path.join(config.workspace, 'OUTPUT.schema.json'));
      expect(schema.properties.caseId).toEqual({ const: input.caseId });
      expect(schema.properties.inputDigest).toEqual({ const: formalizationEvaluationInputDigest(input) });
      const roleText = fs.readFileSync(path.join(config.workspace, 'ROLE.md'), 'utf8');
      expect(config.instructions).toBe(roleText);
      const visible = JSON.stringify({ input, schema, roleText, instructions: config.instructions });
      for (const secret of ['PRIVATE_REFERENCE_CANARY', 'PRIVATE_LABEL_PROVENANCE_CANARY', 'PRIVATE_MUTATION_CANARY',
        'PRIVATE_SOURCE_', 'PRIVATE_FILENAME_LABELS']) expect(visible).not.toContain(secret);
      const output = review(input); config.completedOutput!.validate(output);
      write(path.join(config.workspace, 'OUTPUT.json'), output); return 'submitted';
    });
    expect(await runFormalizationReview(f.bundleDirectory, f.runDirectory, f.config, { openSession: agent.open }))
      .toMatchObject({ status: 'complete', modelInvoked: false });
    expect(agent.seen.map(item => item.input.caseId)).toEqual(f.inputs.map(item => item.caseId));
    expect(new Set(agent.seen.map(item => item.config.workspace)).size).toBe(3);
    expect(agent.seen.every(item => item.closed)).toBe(true);
    expect(production.open).not.toHaveBeenCalled();
  });

  it('closes the writer before reading and accepting its final output', async () => {
    const f = fixture(1), agent = sessions((_input, config) => {
      fs.writeFileSync(path.join(config.workspace, 'OUTPUT.json'), '{"incomplete":');
      return 'completed';
    }, { afterClose: (input, config) => write(path.join(config.workspace, 'OUTPUT.json'), review(input)) });
    const result = await runFormalizationReview(f.bundleDirectory, f.runDirectory, f.config, { openSession: agent.open });
    expect(result).toMatchObject({ status: 'complete', modelInvoked: false });
    expect(read(result.decisionsFile).decisions).toMatchObject([{ verdict: 'approved', compileStatus: 'unknown' }]);
    expect(agent.seen[0].closed).toBe(true);
  });

  it('keeps failed cases unknown, preserves explicit unknown, and resumes only the failed case', async () => {
    const f = fixture(), failedId = f.inputs[0].caseId, unknownId = f.inputs[1].caseId;
    const failed = new Set<string>();
    const agent = sessions((input, config) => {
      if (input.caseId === failedId && !failed.has(input.caseId)) {
        failed.add(input.caseId); throw new Error('synthetic_session_transport_failure');
      }
      const output = review(input, input.caseId === unknownId ? 'unknown' : 'approved');
      write(path.join(config.workspace, 'OUTPUT.json'), output); config.completedOutput!.validate(output);
      return 'submitted';
    });
    const first = await runFormalizationReview(f.bundleDirectory, f.runDirectory, f.config, { openSession: agent.open });
    expect(first).toMatchObject({ status: 'partial', modelInvoked: false });
    expect(scoreFormalizationEvaluation(f.bundleDirectory, first.decisionsFile).splits.test)
      .toMatchObject({ cases: 3, unknown: 2 });
    expect(agent.seen.map(item => item.input.caseId)).toEqual(f.inputs.map(item => item.caseId));
    const second = await runFormalizationReview(f.bundleDirectory, f.runDirectory, f.config, { openSession: agent.open });
    expect(second).toMatchObject({ status: 'complete', modelInvoked: false });
    expect(agent.seen.map(item => item.input.caseId)).toEqual([...f.inputs.map(item => item.caseId), failedId]);
    expect(scoreFormalizationEvaluation(f.bundleDirectory, second.decisionsFile).splits.test)
      .toMatchObject({ cases: 3, unknown: 1 });
    const count = agent.seen.length;
    expect(await runFormalizationReview(f.bundleDirectory, f.runDirectory, f.config, { openSession: agent.open }))
      .toMatchObject({ status: 'complete' });
    expect(agent.seen).toHaveLength(count);
    expect(agent.seen.every(item => item.closed)).toBe(true);
  });

  it.each(['caseId', 'inputDigest'] as const)('rejects an otherwise valid output bound to the wrong %s', async field => {
    const f = fixture(1), agent = sessions((input, config) => {
      const output = { ...review(input), [field]: field === 'caseId' ? 'case_' + 'f'.repeat(64) : 'f'.repeat(64) };
      expect(() => config.completedOutput!.validate(output)).toThrow();
      write(path.join(config.workspace, 'OUTPUT.json'), output); return 'completed';
    });
    const result = await runFormalizationReview(f.bundleDirectory, f.runDirectory, f.config, { openSession: agent.open });
    expect(result).toMatchObject({ status: 'partial', modelInvoked: false });
    expect(scoreFormalizationEvaluation(f.bundleDirectory, result.decisionsFile).splits.test)
      .toMatchObject({ cases: 1, approvals: 0, rejections: 0, unknown: 1 });
  });

  it('does not treat a failed turn with a valid output as a completed semantic decision', async () => {
    const f = fixture(1), agent = sessions((input, config) => {
      write(path.join(config.workspace, 'OUTPUT.json'), review(input)); return 'failed';
    });
    const result = await runFormalizationReview(f.bundleDirectory, f.runDirectory, f.config, { openSession: agent.open });
    expect(result.status).toBe('partial');
    expect(scoreFormalizationEvaluation(f.bundleDirectory, result.decisionsFile).splits.test)
      .toMatchObject({ cases: 1, unknown: 1, approvals: 0 });
  });

  it('rejects a session thread reused for a second case', async () => {
    const f = fixture(2), agent = sessions(undefined, { threadId: 'preset-reused-thread' });
    await expect(runFormalizationReview(f.bundleDirectory, f.runDirectory, f.config, { openSession: agent.open })).rejects.toThrow();
    expect(agent.seen).toHaveLength(2);
    expect(agent.seen.every(item => item.closed)).toBe(true);
  });

  it.each(['INPUT.json', 'ROLE.md', 'OUTPUT.schema.json'] as const)('rejects %s changed while a case runs', async name => {
    const f = fixture(1), agent = sessions((input, config) => {
      write(path.join(config.workspace, 'OUTPUT.json'), review(input));
      const file = path.join(config.workspace, name); fs.chmodSync(file, 0o600); fs.appendFileSync(file, '\nchanged');
      return 'completed';
    });
    await expect(runFormalizationReview(f.bundleDirectory, f.runDirectory, f.config, { openSession: agent.open })).rejects.toThrow();
    expect(agent.seen[0].closed).toBe(true);
  });

  it.each(['receipt', 'output'] as const)('rejects changed completed %s evidence before opening another session', async kind => {
    const f = fixture(1), agent = sessions();
    const initial = await runFormalizationReview(f.bundleDirectory, f.runDirectory, f.config, { openSession: agent.open });
    expect(initial.status).toBe('complete');
    const file = kind === 'receipt' ? path.join(f.runDirectory, 'receipts', f.inputs[0].caseId + '.json') : firstOutput(f.runDirectory);
    if (kind === 'receipt') write(file, { ...read(file), inputDigest: '0'.repeat(64) });
    else write(file, { ...read(file), summary: 'Altered after completion.' });
    fs.chmodSync(file, 0o400);
    await expect(runFormalizationReview(f.bundleDirectory, f.runDirectory, f.config, { openSession: agent.open }))
      .rejects.toThrow('formalization_review_receipt_changed');
    expect(agent.seen).toHaveLength(1);
    expect(production.open).not.toHaveBeenCalled();
  });

  it('rejects protocol changes even when the turn itself fails', async () => {
    const f = fixture(1), agent = sessions((_input, config) => {
      const file = path.join(config.workspace, 'ROLE.md');
      fs.chmodSync(file, 0o600); fs.appendFileSync(file, '\nchanged'); fs.chmodSync(file, 0o400);
      return 'failed';
    });
    await expect(runFormalizationReview(f.bundleDirectory, f.runDirectory, f.config, { openSession: agent.open }))
      .rejects.toThrow('formalization_review_protocol_changed');
    expect(agent.seen).toHaveLength(1);
    expect(agent.seen[0].closed).toBe(true);
    expect(production.open).not.toHaveBeenCalled();
  });

  it('checkpoints pre-start cancellation without opening a session and resumes normally', async () => {
    const f = fixture(2), agent = sessions(), controller = new AbortController();
    controller.abort();
    const stopped = await runFormalizationReview(f.bundleDirectory, f.runDirectory, f.config,
      { openSession: agent.open, signal: controller.signal });
    expect(stopped).toMatchObject({ status: 'stopped', modelInvoked: false, completedCases: 0, attempts: 0 });
    expect(agent.seen).toHaveLength(0);
    expect(scoreFormalizationEvaluation(f.bundleDirectory, stopped.decisionsFile).splits.test)
      .toMatchObject({ cases: 2, unknown: 2, approvals: 0, rejections: 0 });
    expect(read(path.join(f.runDirectory, 'state.json'))).toMatchObject({ status: 'stopped', attempts: [] });
    const resumed = await runFormalizationReview(f.bundleDirectory, f.runDirectory, f.config, { openSession: agent.open });
    expect(resumed).toMatchObject({ status: 'complete', completedCases: 2, attempts: 2 });
    expect(agent.seen).toHaveLength(2);
    expect(agent.seen.every(item => item.closed)).toBe(true);
    expect(production.open).not.toHaveBeenCalled();
  });

  it('recovers completed receipts after losing the state checkpoint without rerunning sessions', async () => {
    const f = fixture(2), agent = sessions();
    const initial = await runFormalizationReview(f.bundleDirectory, f.runDirectory, f.config, { openSession: agent.open });
    expect(initial).toMatchObject({ status: 'complete', completedCases: 2, attempts: 2 });
    const initialDecisions = read(initial.decisionsFile);
    fs.rmSync(path.join(f.runDirectory, 'state.json'));
    const recovered = await runFormalizationReview(f.bundleDirectory, f.runDirectory, f.config, { openSession: agent.open });
    expect(recovered).toMatchObject({ status: 'complete', completedCases: 2, attempts: 2, modelInvoked: false });
    expect(agent.seen).toHaveLength(2);
    const state = read(path.join(f.runDirectory, 'state.json'));
    expect(state.status).toBe('complete');
    expect(Object.keys(state.receipts).sort()).toEqual(f.inputs.map(input => input.caseId).sort());
    expect(state.attempts).toHaveLength(2);
    expect(state.attempts.every((attempt: any) => attempt.status === 'completed')).toBe(true);
    expect(read(recovered.decisionsFile)).toEqual(initialDecisions);
    expect(production.open).not.toHaveBeenCalled();
  });

  it('preserves stopped unknown accounting when cancellation interrupts a case', async () => {
    const f = fixture(2), controller = new AbortController();
    const agent = sessions((_input, _config) => { controller.abort(); return 'interrupted'; });
    const result = await runFormalizationReview(f.bundleDirectory, f.runDirectory, f.config,
      { openSession: agent.open, signal: controller.signal });
    expect(result).toMatchObject({ status: 'stopped', modelInvoked: false });
    expect(scoreFormalizationEvaluation(f.bundleDirectory, result.decisionsFile).splits.test)
      .toMatchObject({ cases: 2, unknown: 2, approvals: 0, rejections: 0 });
    expect(agent.seen).toHaveLength(1);
    expect(agent.seen[0].closed).toBe(true);
  });

  it('rejects replay outputs from another bundle without falling back to production', async () => {
    const f = fixture(1), replay = read(f.replayFile);
    write(f.replayFile, { ...replay, bundleDigest: 'f'.repeat(64) });
    await expect(runFormalizationReview(f.bundleDirectory, f.runDirectory, f.config)).rejects.toThrow();
    expect(production.open).not.toHaveBeenCalled();
  });
});

describe('semantic-review output admission', () => {
  it('requires all faithful checks for approval and a concrete mismatch for rejection', () => {
    const input = fixture(1).inputs[0], valid = review(input);
    expect(formalizationSemanticReviewSchema.parse(valid)).toEqual(valid);
    expect(() => formalizationSemanticReviewSchema.parse({ ...valid,
      checks: { ...valid.checks, domains: 'uncertain' } })).toThrow();
    expect(() => formalizationSemanticReviewSchema.parse({ ...valid, verdict: 'changes_requested' })).toThrow();
    expect(formalizationSemanticReviewSchema.parse(review(input, 'changes_requested')).verdict).toBe('changes_requested');
    expect(assertFormalizationSemanticReview(input, review(input, 'unknown')).verdict).toBe('unknown');
    expect(() => assertFormalizationSemanticReview(input, { ...valid, inputDigest: '0'.repeat(64) })).toThrow();
  });
});
