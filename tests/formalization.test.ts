import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertFormalizationEvidence, bootstrapFormalizedProblem, formalizationDigest, formalizationReviewInput, prepareFormalization,
  readFormalizationArtifact, readFormalizationRequest, type FormalizationEvidence } from '../src/math/formalization';
import { readLeanTaskReceipt } from '../src/math/leanTask';
import { canonicalMathJson, mathDigest, readMathText, writeMathJsonDurable } from '../src/math/mathRuntimeIo';
import { readFormalizationState, runFormalization } from '../src/solver/formalization';
import type { MathAgentOptions, MathAgentSession } from '../src/runtime/codexSession';
import { buildFixture, candidateFixture, fixtureStatement, semanticReviewFixture, structureContextFixture, syntheticElaboration } from './helpers/formalizationFixture';

const temporary: string[] = [];
afterEach(() => { for (const item of temporary.splice(0)) fs.rmSync(item, { recursive: true, force: true }); });
function fixture(overrides: Record<string, unknown> = {}) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'formalization-contract-fixture-')));
  temporary.push(parent);
  const { root, manifest } = buildFixture(parent), directory = path.join(parent, 'run');
  const request = prepareFormalization(directory, { problemId: 'synthetic_addition', statement: fixtureStatement,
    environment: 'standard', execution: 'replay', model: 'preset-test', effort: 'none', profile: '/preset-only', executable: '/no-model',
    buildManifestRef: manifest, maxRounds: 3, maxRunSeconds: 60, maxTurnSeconds: 10, maxCompileSeconds: 10, maxTotalTokens: 0,
    ...overrides });
  return { parent, root, manifest, directory, request };
}
function preset(options: { rejectFirst?: boolean; unknownFirst?: boolean; alwaysUnknown?: boolean; unchanged?: boolean;
  reusedThread?: boolean; mutateInput?: boolean; mutateContract?: boolean;
  missingUsage?: boolean; tokens?: number; submitted?: boolean; isolationReceipt?: Record<string, unknown>;
  changeReview?: (output: any, input: any) => unknown } = {}) {
  let generation = 0, sessions = 0;
  const seen: { role: string; input: any }[] = [];
  const open = async (config: MathAgentOptions): Promise<MathAgentSession> => {
    const sequence = ++sessions, role = path.basename(config.workspace);
    return { threadId: options.reusedThread ? 'reused' : 'fixture-thread-' + sequence,
      ...(options.isolationReceipt ? { isolationReceipt: options.isolationReceipt } : {}),
      interrupt: async () => {}, close: async () => {},
      run: async (_message, _id, workspace, onStarted) => {
        onStarted('fixture-turn-' + sequence);
        if (!options.missingUsage) config.onUsage({ totalTokens: options.tokens ?? 1 });
        const input = JSON.parse(readMathText(path.join(workspace, 'INPUT.json')));
        expect(readMathText(path.join(workspace, 'ROLE.md'))).toBe(config.instructions);
        expect(JSON.parse(readMathText(path.join(workspace, 'OUTPUT.schema.json'))))
          .toMatchObject({ type: 'object', additionalProperties: false });
        seen.push({ role, input });
        let output: unknown;
        if (role === 'generate') {
          generation++; const candidate = candidateFixture(input.statement);
          if (generation > 1 && !options.unchanged) candidate.source = candidate.source.replace(/\bn\b/gu, 'm');
          output = candidate;
        }
        else if (role === 'backtranslate') output = { snapshotDigest: input.snapshotDigest, mathematics: 'Both sides are the same natural number.',
          assumptions: [], definitions: [], targets: input.targets.map((item: { name: string }) => ({ name: item.name, mathematics: 'n + 0 = n' })) };
        else {
          const verdict = generation === 1 && options.rejectFirst ? 'changes_requested' :
            generation === 1 && options.unknownFirst ? 'unknown' : options.alwaysUnknown ? 'unknown' : 'approved';
          output = input.schema === 'theorem-os.formalization-review-input.v2' ?
            semanticReviewFixture(input, verdict, verdict === 'approved' ? 'Faithful test statement.' : 'Clarify the domain.') :
            { inputDigest: input.inputDigest, snapshotDigest: input.snapshotDigest, translationDigest: input.translationDigest,
              verdict, summary: 'Legacy test review.', checks: { equivalent: true, complete: true, assumptions: true, definitions: true }, issues: [] };
          if (options.changeReview) output = options.changeReview(output, input);
        }
        if (options.mutateInput) fs.writeFileSync(path.join(workspace, 'INPUT.json'), '{}');
        if (options.mutateContract) {
          const contract = path.join(workspace, 'ROLE.md');
          fs.chmodSync(contract, 0o600);
          fs.writeFileSync(contract, 'changed protocol');
        }
        fs.writeFileSync(path.join(workspace, 'OUTPUT.json'), JSON.stringify(output));
        if (options.submitted) config.completedOutput!.validate(output);
        return options.submitted ? 'submitted' : 'completed';
      },
    };
  };
  return { open, seen };
}
const elaborate: NonNullable<Parameters<typeof runFormalization>[2]>['elaborate'] =
  async (_directory, source, environment, options) => syntheticElaboration(source, environment, options);

describe('formalization generation and independent statement review', () => {
  it('reads a frozen v1 request and resumes its artifact without upgrading or opening a role', async () => {
    const f = fixture(), agent = preset();
    const legacy = { ...f.request, schema: 'theorem-os.formalization-request.v1' };
    delete legacy.contextProtocol;
    writeMathJsonDurable(path.join(f.directory, 'request.json'), legacy, 0o400);
    expect(await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate })).toMatchObject({ status: 'approved' });
    const file = path.join(f.directory, 'artifact', 'evidence.json'), saved = JSON.parse(readMathText(file));
    expect(saved.schema).toBe('theorem-os.formalization-evidence.v1');
    expect(saved.snapshot.targets[0].context).not.toHaveProperty('bindings');
    expect(formalizationDigest(readFormalizationArtifact(path.dirname(file)))).toBe(formalizationDigest(saved));
    expect(readFormalizationRequest(f.directory)).toEqual(legacy);
    const count = agent.seen.length;
    expect(await runFormalization(f.directory, f.root, { openSession: async () => {
      throw new Error('A completed legacy artifact must not open a role.');
    }, elaborate })).toMatchObject({ status: 'approved' });
    expect(agent.seen).toHaveLength(count);
  });

  it('reads and resumes an existing v3 request without injecting the new context protocol', async () => {
    const f = fixture(), agent = preset(), legacy = { ...f.request };
    delete legacy.contextProtocol;
    writeMathJsonDurable(path.join(f.directory, 'request.json'), legacy, 0o400);
    const originalDigest = formalizationDigest(legacy);
    expect(await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate })).toMatchObject({ status: 'approved' });
    const artifact = path.join(f.directory, 'artifact'), raw = JSON.parse(readMathText(path.join(artifact, 'evidence.json')));
    expect(raw.schema).toBe('theorem-os.formalization-evidence.v3');
    expect(raw.request).not.toHaveProperty('contextProtocol');
    expect(raw.snapshot.targets[0].context).toHaveProperty('bindings');
    expect(raw.snapshot.targets[0].context).not.toHaveProperty('semantic');
    expect(raw.snapshot.targets[0].context).not.toHaveProperty('structures');
    expect(formalizationDigest(readFormalizationArtifact(artifact))).toBe(formalizationDigest(raw));
    expect(formalizationDigest(readFormalizationRequest(f.directory))).toBe(originalDigest);
    expect(await runFormalization(f.directory, f.root, { openSession: async () => {
      throw new Error('A completed existing v3 artifact must not open a role.');
    }, elaborate })).toMatchObject({ status: 'approved' });
  });

  it.each(['fragment', 'identity', 'verdict', 'conversion', 'legacy'] as const)(
    'does not approve a new request with an invalid %s review', async defect => {
      const f = fixture({ maxRounds: 1 }), agent = preset({ submitted: true, changeReview: (output, input) => {
        if (defect === 'fragment') output.correspondences[0].originalFragment = 'This passage does not occur in the source.';
        if (defect === 'identity') output.inputDigest = '0'.repeat(64);
        if (defect === 'verdict') output.checks.domains = 'uncertain';
        if (defect === 'conversion') {
          output.correspondences[0].relation = 'equivalent'; output.correspondences[0].forwardArgument = 'One direction only.';
        }
        if (defect === 'legacy') return { inputDigest: input.baseInputDigest, snapshotDigest: input.observation.snapshotDigest,
          translationDigest: formalizationDigest(input.translation), verdict: 'approved', summary: 'Old four-boolean review.',
          checks: { equivalent: true, complete: true, assumptions: true, definitions: true }, issues: [] };
        return output;
      } });
      expect(await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate })).toMatchObject({ status: 'exhausted' });
      expect(fs.existsSync(path.join(f.directory, 'artifact'))).toBe(false);
      expect(fs.existsSync(path.join(f.directory, 'workspace'))).toBe(false);
    });

  it('requires binder observations before backtranslation and review', async () => {
    const f = fixture({ maxRounds: 1 }), agent = preset();
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open,
      elaborate: async (_directory, source, environment, options) => {
        const compiled = syntheticElaboration(source, environment, options);
        delete compiled.snapshot.targets[0].context.bindings;
        compiled.snapshotDigest = formalizationDigest(compiled.snapshot); return compiled;
      } });
    expect(result).toMatchObject({ status: 'exhausted', error: 'formalization_context_missing_bindings' });
    expect(agent.seen.map(item => item.role)).toEqual(['generate']);
  });

  it('requires opted-in kernel observations before backtranslation and review', async () => {
    const f = fixture({ maxRounds: 1 }), agent = preset();
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open,
      elaborate: async (_directory, source, environment, options) => {
        expect(options.semanticContext).toBe(true);
        const compiled = syntheticElaboration(source, environment, options);
        delete compiled.snapshot.targets[0].context.semantic;
        compiled.snapshotDigest = formalizationDigest(compiled.snapshot); return compiled;
      } });
    expect(result).toMatchObject({ status: 'exhausted', error: 'formalization_context_missing_semantic_context' });
    expect(agent.seen.map(item => item.role)).toEqual(['generate']);
    expect(fs.existsSync(path.join(f.directory, 'artifact'))).toBe(false);
  });


  it('retains explicit kernel-v1 requests without structure options, exports or upgraded query bytes', async () => {
    const f = fixture({ contextProtocol: 'kernel-v1' }), agent = preset();
    expect(f.request.contextProtocol).toBe('kernel-v1');
    expect(await runFormalization(f.directory, f.root, { openSession: agent.open,
      elaborate: async (_directory, source, environment, options) => {
        expect(options.semanticContext).toBe(true); expect(options).not.toHaveProperty('structureContext');
        return syntheticElaboration(source, environment, options);
      } })).toMatchObject({ status: 'approved', modelInvoked: false });
    const evidence = readFormalizationArtifact(path.join(f.directory, 'artifact'));
    expect(evidence.request.contextProtocol).toBe('kernel-v1');
    expect(evidence.snapshot.targets[0].context).toHaveProperty('semantic');
    expect(evidence.snapshot.targets[0].context).not.toHaveProperty('structures');
    const captured = evidence.compilation.diagnostics.latest as { sourceFiles: { file: string; digest: string }[] };
    // Frozen from the previous implementation, before structure-context export existed.
    expect(captured.sourceFiles.find(item => item.file === 'FormalizationContext.lean')!.digest)
      .toBe('3d5e0d0dfece6c5a6c7784e6fe43d81ed502094039221a9666554009baa1d4c9');
    expect(readFormalizationRequest(f.directory)).toEqual(f.request);
  });

  it('requires structure observations before opening the blind translator or any reviewer', async () => {
    const f = fixture({ maxRounds: 1 }), agent = preset();
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open,
      elaborate: async (_directory, source, environment, options) => {
        expect(options.structureContext).toBe(true);
        const compiled = syntheticElaboration(source, environment, options);
        delete compiled.snapshot.targets[0].context.structures;
        compiled.snapshotDigest = formalizationDigest(compiled.snapshot); return compiled;
      } });
    expect(result).toMatchObject({ status: 'exhausted', error: 'formalization_context_missing_structures' });
    expect(agent.seen.map(item => item.role)).toEqual(['generate']);
    expect(fs.existsSync(path.join(f.directory, 'artifact'))).toBe(false);
  });

  it('delivers direct structure fields to blind translation and review and restores their frozen artifact', async () => {
    const f = fixture(), agent = preset(), structures = structureContextFixture();
    expect(await runFormalization(f.directory, f.root, { openSession: agent.open,
      elaborate: async (_directory, source, environment, options) => {
        const compiled = syntheticElaboration(source, environment, options);
        compiled.snapshot.targets[0].context.structures = structures;
        compiled.snapshot.targets[0].context.constants.push({ name: 'OfNat', module: 'Init.Prelude', type: '(α : Type u) → Nat → Type u' });
        compiled.snapshotDigest = formalizationDigest(compiled.snapshot);
        const diagnostics = compiled.compilation.diagnostics;
        diagnostics.contextExport!.text = canonicalMathJson(compiled.snapshot.targets.map(target =>
          ({ id: target.name, context: target.context })));
        diagnostics.contextExport!.digest = mathDigest(diagnostics.contextExport!.text);
        return compiled;
      } })).toMatchObject({ status: 'approved', modelInvoked: false });
    const evidence = readFormalizationArtifact(path.join(f.directory, 'artifact'));
    expect(agent.seen.find(item => item.role === 'backtranslate')!.input.targets[0].context.structures).toEqual(structures);
    expect(agent.seen.find(item => item.role === 'compare')!.input.observation.snapshot.targets[0].context.structures).toEqual(structures);
    expect(evidence.snapshot.targets[0].context.structures).toEqual(structures);
    const digest = formalizationDigest(evidence);
    expect(await runFormalization(f.directory, f.root, {
      openSession: async () => { throw new Error('Completed kernel-v2 evidence must not reopen roles.'); },
      elaborate: async () => { throw new Error('Completed kernel-v2 evidence must not query Lean again.'); },
    })).toMatchObject({ status: 'approved', modelInvoked: false });
    expect(formalizationDigest(readFormalizationArtifact(path.join(f.directory, 'artifact')))).toBe(digest);
  });

  it('delivers a frozen readable role contract while keeping backtranslation blind', async () => {
    const f = fixture(), agent = preset();
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate });
    expect(result.status).toBe('approved');
    expect(f.request.schema).toBe('theorem-os.formalization-request.v3');
    expect(f.request.contextProtocol).toBe('kernel-v3');
    const evidence = readFormalizationArtifact(path.join(f.directory, 'artifact'));
    const reviewed = agent.seen.find(item => item.role === 'compare')!.input;
    expect(reviewed).toMatchObject({ schema: 'theorem-os.formalization-review-input.v2', original: fixtureStatement,
      header: '', candidate: evidence.candidate.source });
    expect(reviewed.observation.snapshot.targets[0].context.bindings.binders[0]).toMatchObject({ id: 'b0', kind: 'explicit' });
    expect(reviewed.observation.snapshot.targets[0].context.semantic).toEqual(evidence.snapshot.targets[0].context.semantic);
    expect(evidence.schema).toBe('theorem-os.formalization-evidence.v3');
    const state = readFormalizationState(f.directory)!;
    for (const record of state.sessions) {
      expect(record.roleContract?.schema).toBe('theorem-os.formalization-role-contract.v1');
      expect(record.roleContract?.roleInstructionsSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(record.roleContract?.outputSchemaSha256).toMatch(/^[a-f0-9]{64}$/u);
    }
    const round = fs.readdirSync(f.directory).find(name => name.startsWith('round-'))!;
    const workspace = path.join(f.directory, round, 'backtranslate');
    for (const file of ['ROLE.md', 'OUTPUT.schema.json']) {
      expect(fs.statSync(path.join(workspace, file)).mode & 0o222).toBe(0);
      expect(readMathText(path.join(workspace, file))).not.toContain(fixtureStatement);
    }
    const schema = JSON.parse(readMathText(path.join(workspace, 'OUTPUT.schema.json')));
    expect(schema.required).toContain('snapshotDigest');
    expect(schema.properties).not.toHaveProperty('original');
    expect(schema.properties).not.toHaveProperty('statement');
  });

  it('refuses a changed role contract before accepting a generated candidate', async () => {
    const f = fixture({ maxRounds: 1 }), agent = preset({ mutateContract: true });
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate });
    expect(result).toMatchObject({ status: 'exhausted', error: 'formalization_role_contract_changed' });
    expect(fs.existsSync(path.join(f.directory, 'artifact'))).toBe(false);
  });

  it('completes an unlimited request and forwards no deadline to model turns or elaboration', async () => {
    const f = fixture({ maxRounds: 0, maxRunSeconds: 0, maxTurnSeconds: 0, maxCompileSeconds: 0, maxTotalTokens: 0 });
    const agent = preset(); let opened = 0, compiled = 0;
    const result = await runFormalization(f.directory, f.root, {
      openSession: async config => { opened++; expect(config.turnTimeoutMs).toBeUndefined(); return agent.open(config); },
      elaborate: async (_directory, source, environment, options) => {
        compiled++; expect(options.timeoutMs).toBe(0); expect(options.signal?.aborted).toBe(false);
        expect(options.detailedContext).toBe(true); expect(options.semanticContext).toBe(true);
        expect(options.structureContext).toBe(true);
        return syntheticElaboration(source, environment, options);
      },
    });
    expect(result).toMatchObject({ status: 'approved', rounds: 1, modelInvoked: false });
    expect(opened).toBe(3); expect(compiled).toBe(1);
    expect(readFormalizationState(f.directory)).toMatchObject({ status: 'approved', generatedCandidates: 1 });
  });

  it.each(['opening', 'running'] as const)('returns stopped and terminal session state when interrupted during %s', async phase => {
    const f = fixture({ maxRounds: 0, maxRunSeconds: 0, maxTurnSeconds: 0, maxCompileSeconds: 0 });
    const controller = new AbortController();
    let calls = 0, interruptions = 0, closes = 0, settle: ((status: string) => void) | undefined;
    const result = await runFormalization(f.directory, f.root, { signal: controller.signal,
      openSession: async config => {
        expect(config.signal).toBeDefined();
        if (phase === 'opening') controller.abort();
        return { threadId: 'interrupted-synthetic-thread',
          interrupt: async () => { interruptions++; settle?.('interrupted'); },
          close: async () => { closes++; settle?.('interrupted'); },
          run: async (_message, _id, _workspace, onStarted) => {
            calls++; onStarted('interrupted-synthetic-turn');
            return new Promise<string>(resolve => { settle = resolve; queueMicrotask(() => controller.abort()); });
          } };
      }, elaborate: async () => { throw new Error('An interrupted role must not compile a candidate.'); },
    });
    expect(result.status).toBe('stopped');
    expect(result.error).not.toContain('math_runtime_lease_lost');
    expect(calls).toBe(phase === 'running' ? 1 : 0);
    expect(closes).toBeGreaterThanOrEqual(1);
    if (phase === 'running') expect(interruptions).toBeGreaterThanOrEqual(1);
    const state = readFormalizationState(f.directory)!;
    expect(state.status).toBe('stopped'); expect(state.activeSince).toBeUndefined();
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]).toMatchObject({ status: 'interrupted', turns: phase === 'running' ? 1 : 0,
      usageAccounting: { pending: false } });
    expect(state.sessions[0].outputDigest).toBeUndefined();
    expect(fs.existsSync(path.join(f.directory, 'artifact'))).toBe(false);
    expect(fs.existsSync(path.join(f.directory, 'workspace'))).toBe(false);
  });

  it('preserves validated submission completion and the session isolation receipt', async () => {
    const receipt = { schema: 'synthetic-isolation-receipt.v1', isolated: true, fixtureOnly: true };
    const f = fixture(), agent = preset({ submitted: true, isolationReceipt: receipt });
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate });
    expect(result).toMatchObject({ status: 'approved', modelInvoked: false });
    const state = readFormalizationState(f.directory)!;
    expect(state.sessions).toHaveLength(3);
    for (const session of state.sessions) expect(session).toMatchObject({ status: 'submitted',
      completionReason: 'validated-output', isolationReceipt: receipt, usageAccounting: { pending: false } });
    const evidence = readFormalizationArtifact(path.join(f.directory, 'artifact'));
    for (const session of evidence.sessions) expect(session).toMatchObject({ status: 'submitted', completionReason: 'validated-output' });
    expect(() => assertFormalizationEvidence(evidence)).not.toThrow();
  });

  it('prepares the entire original offline and creates no solver targets before review', () => {
    const f = fixture({ statement: fixtureStatement + '\n' + 'x'.repeat(10_000) });
    expect(readFormalizationRequest(f.directory).statement).toHaveLength(fixtureStatement.length + 10_001);
    expect(fs.readdirSync(f.directory)).toEqual(['request.json']);
    expect(() => prepareFormalization(f.directory, f.request)).toThrow('formalization_directory_exists');
    expect(() => bootstrapFormalizedProblem(f.directory)).toThrow();
  });

  it('repairs a semantic rejection in a new round and freezes every reviewed target without proving it', async () => {
    const f = fixture(), agent = preset({ rejectFirst: true });
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate });
    expect(result).toMatchObject({ status: 'approved', rounds: 2, modelInvoked: false });
    expect(agent.seen.map(item => item.role)).toEqual(['generate', 'backtranslate', 'compare', 'generate', 'backtranslate', 'compare']);
    expect(agent.seen[3].input.feedback).toContain('Clarify the domain');
    const blind = agent.seen.find(item => item.role === 'backtranslate')!.input;
    expect(JSON.stringify(blind)).not.toContain(fixtureStatement);
    expect(blind).not.toHaveProperty('coverage');
    const evidence = readFormalizationArtifact(path.join(f.directory, 'artifact'));
    expect(evidence).toMatchObject({ authority: 'model', execution: 'replay', modelInvoked: false, proofVerified: false });
    expect(new Set(evidence.sessions.map(item => item.threadId)).size).toBe(3);
    const receipt = readLeanTaskReceipt(path.join(f.directory, 'workspace/active-problem.json'));
    expect(receipt.publicObligations).toEqual(evidence.targets);
    expect(receipt.contract.formalStatement).toContain('by sorry');
    expect(readMathText(path.join(f.directory, 'task.md'))).toContain(fixtureStatement);
    const opens = agent.seen.length;
    expect(await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate })).toMatchObject({ status: 'approved' });
    expect(agent.seen).toHaveLength(opens);
  });

  it('returns compiler feedback for repair before opening either review role', async () => {
    const f = fixture(), agent = preset();
    let compilations = 0;
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open,
      elaborate: async (_dir, source, environment, options) => {
        if (++compilations === 1) throw new Error('unknown identifier fixture'); return syntheticElaboration(source, environment, options);
      } });
    expect(result.status).toBe('approved');
    expect(agent.seen.map(item => item.role)).toEqual(['generate', 'generate', 'backtranslate', 'compare']);
    expect(agent.seen[1].input.feedback).toContain('unknown identifier fixture');
  });

  it('requires a rejected candidate to change before another review can approve it', async () => {
    const f = fixture({ maxRounds: 2 }), agent = preset({ rejectFirst: true, unchanged: true });
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate });
    expect(result).toMatchObject({ status: 'exhausted', error: 'formalization_candidate_unchanged_after_rejection' });
    expect(agent.seen.map(item => item.role)).toEqual(['generate', 'backtranslate', 'compare', 'generate']);
    expect(fs.existsSync(path.join(f.directory, 'artifact'))).toBe(false);
  });

  it('rechecks an unchanged source after an unknown semantic review without blacklisting it', async () => {
    const f = fixture({ maxRounds: 2 }), agent = preset({ unknownFirst: true, unchanged: true });
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate });
    expect(result).toMatchObject({ status: 'approved', rounds: 2 });
    expect(agent.seen.filter(item => item.role === 'compare')).toHaveLength(2);
    expect(agent.seen.filter(item => item.role === 'generate')[1].input.feedback).toContain('unknown');
    expect(readFormalizationState(f.directory)!.rejectedCandidates ?? []).toEqual([]);
  });

  it('ends an unlimited-round run after three consecutive unknown semantic reviews', async () => {
    const f = fixture({ maxRounds: 0, maxRunSeconds: 0, maxTurnSeconds: 0, maxCompileSeconds: 0 }),
      agent = preset({ alwaysUnknown: true });
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate });
    expect(result).toMatchObject({ status: 'exhausted', rounds: 3 });
    expect(result.error).toContain('formalization_semantic_unknown:');
    expect(agent.seen.filter(item => item.role === 'compare')).toHaveLength(3);
    expect(readFormalizationState(f.directory)!.rejectedCandidates ?? []).toEqual([]);
    expect(fs.existsSync(path.join(f.directory, 'artifact'))).toBe(false);
  });

  it('resets the consecutive unknown count when a later round reaches a concrete verdict', async () => {
    const f = fixture({ maxRounds: 0, maxRunSeconds: 0, maxTurnSeconds: 0, maxCompileSeconds: 0 }),
      agent = preset({ unknownFirst: true });
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate });
    expect(result).toMatchObject({ status: 'approved', rounds: 2 });
    expect(readFormalizationState(f.directory)!.unknownRounds).toBeUndefined();
  });

  it.each([{ reusedThread: true }, { mutateInput: true }])('blocks reused review threads or modified role inputs: %j', async options => {
    const f = fixture({ maxRounds: 1 }), agent = preset(options);
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate });
    expect(result.status).toBe('exhausted');
    expect(fs.existsSync(path.join(f.directory, 'artifact'))).toBe(false);
    expect(fs.existsSync(path.join(f.directory, 'workspace'))).toBe(false);
  });

  it('requires all targets to be covered and all imported semantic context to be visible', async () => {
    const f = fixture({ maxRounds: 1, contextProtocol: 'kernel-v2' }), agent = preset();
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open,
      elaborate: async (_dir, source, environment, options) => {
        const result = syntheticElaboration(source, environment, options); result.snapshot.targets[0].context.omitted.push('hidden definition' as never);
        result.snapshotDigest = formalizationDigest(result.snapshot); return result;
      } });
    expect(result).toMatchObject({ status: 'exhausted', error: 'formalization_context_incomplete' });
    expect(agent.seen.map(item => item.role)).toEqual(['generate']);
  });

  it('accepts omitted imported context only under kernel-v3 and binds it in restorable evidence', async () => {
    const f = fixture({ contextProtocol: 'kernel-v3' }), agent = preset();
    expect(f.request.contextProtocol).toBe('kernel-v3');
    expect(await runFormalization(f.directory, f.root, { openSession: agent.open,
      elaborate: async (_directory, source, environment, options) => {
        expect(options).toMatchObject({ semanticContext: true, structureContext: true, boundedLibraryContext: true });
        const compiled = syntheticElaboration(source, environment, options);
        compiled.snapshot.targets[0].context.omitted.push('LinearMap.smulRight' as never);
        compiled.snapshotDigest = formalizationDigest(compiled.snapshot);
        const diagnostics = compiled.compilation.diagnostics;
        diagnostics.contextExport!.text = canonicalMathJson(compiled.snapshot.targets.map(target =>
          ({ id: target.name, context: target.context })));
        diagnostics.contextExport!.digest = mathDigest(diagnostics.contextExport!.text);
        return compiled;
      } })).toMatchObject({ status: 'approved', modelInvoked: false });
    const evidence = readFormalizationArtifact(path.join(f.directory, 'artifact'));
    expect(evidence.snapshot.targets[0].context.omitted).toEqual(['LinearMap.smulRight']);
    expect(agent.seen.find(item => item.role === 'compare')!.input.observation.snapshot.targets[0].context.omitted)
      .toEqual(['LinearMap.smulRight']);
    const round = fs.readdirSync(f.directory).find(name => name.startsWith('round-'))!;
    for (const role of ['backtranslate', 'compare'])
      expect(readMathText(path.join(f.directory, round, role, 'ROLE.md'))).toContain('This request uses kernel-v3.');
    expect(await runFormalization(f.directory, f.root, {
      openSession: async () => { throw new Error('Completed kernel-v3 evidence must not reopen roles.'); },
      elaborate: async () => { throw new Error('Completed kernel-v3 evidence must not query Lean again.'); },
    })).toMatchObject({ status: 'approved', modelInvoked: false });
  });

  it('returns pinned-library name gaps as compile feedback before any review and freezes the list', async () => {
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'formalization-compat-names-')));
    temporary.push(parent);
    const namesFile = path.join(parent, 'names.txt');
    fs.writeFileSync(namesFile, 'Eq\nHAdd.hAdd\n');
    const f = fixture({ compatibility: { namesFile, provenance: 'Lean v4.8.0 + Mathlib v4.8.0 (fixture)' } }), agent = preset();
    expect(f.request.compatibility).toMatchObject({ namesSha256: mathDigest('Eq\nHAdd.hAdd\n'), namesCount: 2 });
    expect(readMathText(path.join(f.directory, 'compatibility-names.txt'))).toBe('Eq\nHAdd.hAdd\n');
    let compilations = 0;
    expect(await runFormalization(f.directory, f.root, { openSession: agent.open,
      elaborate: async (_directory, source, environment, options) => {
        const compiled = syntheticElaboration(source, environment, options);
        // The first candidate's statement uses a written library type the pinned list lacks; the repair does not.
        if (++compilations === 1) {
          compiled.snapshot.targets[0].context.semantic!.kernelType = ['const', ['str', null, 'Nat'], []];
          compiled.snapshotDigest = formalizationDigest(compiled.snapshot);
        }
        return compiled;
      } })).toMatchObject({ status: 'approved', rounds: 2, modelInvoked: false });
    expect(agent.seen.map(item => item.role)).toEqual(['generate', 'generate', 'backtranslate', 'compare']);
    expect(agent.seen[1].input.feedback).toContain('formalization_compatibility_names_unavailable: Nat');
    expect(readFormalizationState(f.directory)!.rejectedCandidates ?? []).toEqual([]);
    const round = fs.readdirSync(f.directory).filter(name => name.startsWith('round-')).sort().at(-1)!;
    expect(readMathText(path.join(f.directory, round, 'generate', 'ROLE.md'))).toContain('older pinned library (Lean v4.8.0');
    expect(readMathText(path.join(f.directory, round, 'compare', 'ROLE.md'))).not.toContain('older pinned library');
    expect(readFormalizationArtifact(path.join(f.directory, 'artifact')).request.compatibility).toEqual(f.request.compatibility);
    // Without a semantic context protocol there are no kernel types to check.
    const legacy = { ...f.request }; delete legacy.contextProtocol;
    fs.chmodSync(path.join(f.directory, 'request.json'), 0o600);
    writeMathJsonDurable(path.join(f.directory, 'request.json'), legacy, 0o400);
    expect(() => readFormalizationRequest(f.directory)).toThrow('formalization_compatibility_requires_semantic_v3');
  });

  it('keeps kernel-v2 role contracts free of kernel-v3 text', async () => {
    const f = fixture({ contextProtocol: 'kernel-v2' }), agent = preset();
    expect(await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate: async (_directory, source, environment, options) => {
      expect(options).not.toHaveProperty('boundedLibraryContext');
      return syntheticElaboration(source, environment, options);
    } })).toMatchObject({ status: 'approved' });
    const round = fs.readdirSync(f.directory).find(name => name.startsWith('round-'))!;
    expect(readMathText(path.join(f.directory, round, 'compare', 'ROLE.md'))).not.toContain('kernel-v3');
  });

  it('retains cumulative token consumption on resume and stops when usage is unavailable', async () => {
    for (const missingUsage of [false, true]) {
      const f = fixture({ maxTotalTokens: 1 }), agent = preset({ missingUsage });
      const first = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate });
      expect(first.status).toBe('stopped');
      const count = agent.seen.length;
      const resumed = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate });
      expect(resumed.status).toBe('stopped');
      expect(agent.seen).toHaveLength(count);
      expect(readFormalizationState(f.directory)!.sessions).toHaveLength(1);
      expect(fs.existsSync(path.join(f.directory, 'workspace'))).toBe(false);
    }
  });

  it.each(['responses-relay', 'native-model-relay'] as const)(
    'charges %s receipts once, persists them and retains the budget on resume', async source => {
    const f = fixture({ maxTotalTokens: 20 }), agent = preset({ tokens: 9999, submitted: true });
    let requests = 0;
    const openSession = async (config: MathAgentOptions): Promise<MathAgentSession> => {
      const session = await agent.open(config);
      return { ...session, usageSource: 'upstream-requests', run: async (...args) => {
        const admission = config.requestGate!({ requestId: 'request-' + ++requests, source });
        expect(admission.allowed).toBe(true);
        if (admission.allowed) {
          const receipt = { complete: true, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
          admission.settle(receipt); admission.settle(receipt);
        }
        return session.run(...args);
      } };
    };
    expect(await runFormalization(f.directory, f.root, { openSession, elaborate }))
      .toMatchObject({ status: 'approved', tokenBudget: { reportedTotalTokens: 6, usageComplete: true,
        enforcement: 'provider-observed-upstream-request-limit' } });
    const state = readFormalizationState(f.directory)!;
    expect(state.sessions).toHaveLength(3);
    for (const record of state.sessions) expect(record).toMatchObject({ usage: { totalTokens: 2 },
      requestUsageAccounting: { startedRequests: 1, reportedRequests: 1, pendingRequests: 0, incomplete: false } });
    const again = await runFormalization(f.directory, f.root, { openSession, elaborate });
    expect(again.tokenBudget.reportedTotalTokens).toBe(6); expect(requests).toBe(3);
  });

  it.each(['exhausted', 'missing'] as const)('blocks the next upstream request after %s usage', async reason => {
    const f = fixture({ maxTotalTokens: 2 }), agent = preset();
    let attempted = 0;
    const openSession = async (config: MathAgentOptions): Promise<MathAgentSession> => {
      const session = await agent.open(config);
      return { ...session, usageSource: 'upstream-requests', run: async (...args) => {
        args[3]('receipt-turn');
        const first = config.requestGate!({ requestId: 'first', source: 'responses-relay' });
        expect(first.allowed).toBe(true); attempted++;
        if (first.allowed) first.settle(reason === 'missing' ? { complete: false, missingReason: 'provider-usage-missing' }
          : { complete: true, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } });
        expect(config.requestGate!({ requestId: 'next', source: 'responses-relay' }).allowed).toBe(false);
        return 'interrupted';
      } };
    };
    const result = await runFormalization(f.directory, f.root, { openSession, elaborate });
    expect(result.status).toBe('stopped'); expect(result.tokenBudget.status).toBe(reason === 'missing' ? 'usage-unavailable' : 'exhausted');
    await runFormalization(f.directory, f.root, { openSession, elaborate });
    expect(attempted).toBe(1);
  });

  it('invalidates a run when the frozen problem, build or environment identity changes', async () => {
    const f = fixture(), agent = preset();
    await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate });
    writeMathJsonDurable(path.join(f.directory, 'request.json'), { ...f.request, statement: 'Changed original', statementSha256: '0'.repeat(64) });
    expect(() => readFormalizationRequest(f.directory)).toThrow('formalization_request_identity_changed');
    await expect(runFormalization(f.directory, f.root, { openSession: agent.open, elaborate })).rejects.toThrow();
  });

  it('charges a crashed active interval against the cumulative time budget on resume', async () => {
    const f = fixture({ maxRunSeconds: 1 }), agent = preset({ mutateInput: true });
    await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate });
    const state = readFormalizationState(f.directory)!;
    state.status = 'running'; state.rounds = 0; state.elapsedMs = 0; state.activeSince = Date.now() - 5000;
    writeMathJsonDurable(path.join(f.directory, 'state.json'), state);
    const count = agent.seen.length;
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate });
    expect(result).toMatchObject({ status: 'stopped', error: 'formalization_time_limit' });
    expect(agent.seen).toHaveLength(count);
    expect(readFormalizationState(f.directory)!.elapsedMs).toBeGreaterThanOrEqual(5000);
    expect(readFormalizationState(f.directory)!.activeSince).toBeUndefined();
  });
});

describe('portable approved formalization evidence', () => {
  async function approved() {
    const f = fixture(), agent = preset();
    const result = await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate });
    expect(result.status).toBe('approved');
    return { ...f, evidence: readFormalizationArtifact(path.join(f.directory, 'artifact')) };
  }
  it.each(['original', 'source', 'compilation', 'translation', 'review', 'session', 'generation'] as const)('rejects a changed %s binding', async field => {
    const f = await approved(), e = structuredClone(f.evidence);
    if (field === 'original') e.request.statement += ' changed';
    if (field === 'source') e.candidate.source += '\n';
    if (field === 'compilation') (e.compilation.diagnostics.artifactRecords as { text: string }[])[0].text += '\n';
    if (field === 'translation') e.translation.mathematics += ' changed';
    if (field === 'review') e.review.checks.conclusions = 'mismatch';
    if (field === 'session') e.sessions[1].threadId = e.sessions[0].threadId;
    if (field === 'generation') e.sessions[0].outputDigest = '0'.repeat(64);
    expect(() => assertFormalizationEvidence(e)).toThrow();
  });
  it('rejects substituted elaborated types even when the snapshot digest is recomputed', async () => {
    const f = await approved(), e = structuredClone(f.evidence);
    e.snapshot.targets[0].context.type = 'True';
    e.snapshotDigest = formalizationDigest(e.snapshot);
    expect(() => assertFormalizationEvidence(e)).toThrow('formalization_compilation_evidence_invalid');
  });
  it('accepts a quote from kernel context and rejects its substitution after the review digest is recomputed', async () => {
    const f = fixture(), agent = preset({ changeReview: output => {
      output.correspondences[0].candidateFragment = 'True'; return output;
    } });
    expect(await runFormalization(f.directory, f.root, { openSession: agent.open, elaborate })).toMatchObject({ status: 'approved' });
    const e = structuredClone(readFormalizationArtifact(path.join(f.directory, 'artifact')));
    if (!('correspondences' in e.review)) throw new Error('Expected a structured review.');
    e.review.correspondences[0].candidateFragment = 'False';
    e.sessions[2].outputDigest = formalizationDigest(e.review);
    expect(() => assertFormalizationEvidence(e)).toThrow('formalization_review_fragment_not_found');
  });
  it('binds kernel context to the captured compiler export after all downstream digests are recomputed', async () => {
    const f = await approved(), e = structuredClone(f.evidence);
    e.snapshot.targets[0].context.semantic!.rawType = 'False';
    e.snapshotDigest = formalizationDigest(e.snapshot);
    e.translation.snapshotDigest = e.snapshotDigest;
    e.translationDigest = formalizationDigest(e.translation);
    const input = formalizationReviewInput(e.request, e.candidate, e.snapshot, e.translation);
    e.review.inputDigest = formalizationDigest(input);
    e.sessions[1].inputDigest = e.snapshotDigest; e.sessions[1].outputDigest = e.translationDigest;
    e.sessions[2].inputDigest = formalizationDigest(input); e.sessions[2].outputDigest = formalizationDigest(e.review);
    expect(() => assertFormalizationEvidence(e)).toThrow('formalization_compilation_evidence_invalid');
  });
  it('rejects missing required structures and substituted fields after downstream digests are recomputed', async () => {
    const f = await approved();
    for (const defect of ['missing', 'field'] as const) {
      const e = structuredClone(f.evidence);
      if (defect === 'missing') delete e.snapshot.targets[0].context.structures;
      else {
        e.snapshot.targets[0].context.structures = structureContextFixture();
        e.snapshot.targets[0].context.constants.push({ name: 'OfNat', module: 'Init.Prelude', type: '(α : Type u) → Nat → Type u' });
      }
      e.snapshotDigest = formalizationDigest(e.snapshot);
      e.translation.snapshotDigest = e.snapshotDigest;
      e.translationDigest = formalizationDigest(e.translation);
      const input = formalizationReviewInput(e.request, e.candidate, e.snapshot, e.translation);
      e.review.inputDigest = formalizationDigest(input);
      e.sessions[1].inputDigest = e.snapshotDigest; e.sessions[1].outputDigest = e.translationDigest;
      e.sessions[2].inputDigest = formalizationDigest(input); e.sessions[2].outputDigest = formalizationDigest(e.review);
      expect(() => assertFormalizationEvidence(e)).toThrow(defect === 'missing'
        ? 'formalization_context_missing_structures' : 'formalization_compilation_evidence_invalid');
    }
  });
  it('rejects a bare compiler success with missing captured source evidence', async () => {
    const f = await approved(), e = structuredClone(f.evidence);
    e.compilation.diagnostics = { exitCode: 0, timedOut: false, environmentDigest: e.compilation.environmentDigest };
    expect(() => assertFormalizationEvidence(e as FormalizationEvidence)).toThrow('formalization_compilation_evidence_invalid');
  });
});
