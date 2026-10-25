import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertFormalizationEvidence, formalizationDigest, prepareFormalization, readFormalizationArtifact,
  readFormalizationRequest } from '../src/math/formalization';
import { defaultFormalizationWorkflow, type FormalizationWorkflow } from '../src/math/formalizationWorkflow';
import type { FormalizationPlan } from '../src/math/formalizationPlan';
import type { MathAgentOptions, MathAgentSession } from '../src/runtime/codexSession';
import { readFormalizationState, runFormalization } from '../src/solver/formalization';
import { readMathText } from '../src/math/mathRuntimeIo';
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
    environment: 'standard', execution: 'replay', ...author, workflow,
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
  incompleteFinalUsage?: boolean; submitted?: boolean; afterOutput?: (role: string) => void } = {}) {
  let sequence = 0, plans = 0;
  const seen: { role: string; config: MathAgentOptions; input: any }[] = [];
  const open = async (config: MathAgentOptions): Promise<MathAgentSession> => {
    const number = ++sequence, role = path.basename(config.workspace);
    return { threadId: options.reuseThread && role.startsWith('compare-') ? 'reused-review-thread' : 'preset-thread-' + number,
      close: async () => {}, interrupt: async () => {}, run: async (_message, _id, workspace, onStarted) => {
        onStarted('preset-turn-' + number);
        if (!options.missingFinalUsage || role !== 'compare-reviewer-2') config.onUsage({ totalTokens: 1 });
        if (options.incompleteFinalUsage && role === 'compare-reviewer-2') config.onUsageIncomplete?.();
        const input = JSON.parse(readMathText(path.join(workspace, 'INPUT.json'))); seen.push({ role, config, input });
        let output: unknown;
        if (role.startsWith('plan-')) {
          plans++; const value = plan(input.statement);
          if (options.badSpanFirst && plans === 1) value.spans[0].text = 'x'.repeat(input.statement.length);
          if (options.unresolved) value.unresolved.push({ id: 'unknown-domain', spanIds: ['source'], description: 'The domain is unresolved.' });
          if (options.taskKind) value.taskKind = options.taskKind;
          output = value;
        } else if (role === 'generate') {
          const value = candidateFixture(input.statement);
          if (options.addUnplannedDefinition) value.source = 'def hiddenMeaning : Nat := 0\n' + value.source;
          if (input.round > 1) {
            value.definitionsExplanation += ' Changed author notes.';
            if (options.changeSource) value.source = value.source.replace(/\bn\b/gu, 'm');
          }
          output = value;
        } else if (role === 'backtranslate') {
          output = { snapshotDigest: input.snapshotDigest, mathematics: 'The natural zero identity.', assumptions: [], definitions: [],
            targets: input.targets.map((target: { name: string }) => ({ name: target.name, mathematics: 'For every n, n + 0 = n.' })) };
        } else {
          const index = input.reviewerId === 'reviewer-1' ? 0 : 1;
          const round = seen.filter(item => item.role === 'generate').at(-1)!.input.round;
          const verdict = options.rejectedFirstRound && round === 1 ? 'changes_requested' :
            options.unknownFirstRound && round === 1 ? 'unknown' : options.verdicts?.[index] ?? 'approved';
          output = input.schema === 'theorem-os.formalization-review-input.v2' ?
            semanticReviewFixture(input, verdict, verdict === 'approved' ? 'Preset faithful translation.' : 'Preset uncertain domain.',
              options.mismatchAspects?.[index]) :
            { inputDigest: input.inputDigest, snapshotDigest: input.snapshotDigest, translationDigest: input.translationDigest,
              verdict, summary: 'Legacy workflow test review.',
              checks: { equivalent: true, complete: true, assumptions: true, definitions: true }, issues: [] };
        }
        fs.writeFileSync(path.join(workspace, 'OUTPUT.json'), JSON.stringify(output)); options.afterOutput?.(role);
        if (options.submitted) config.completedOutput!.validate(output);
        return options.submitted ? 'submitted' : 'completed';
      } };
  };
  return { open, seen };
}
const elaborate: NonNullable<Parameters<typeof runFormalization>[2]>['elaborate'] =
  async (_directory, source, environment, options) => syntheticElaboration(source, environment, options);

describe('planned formalization and unanimous review protocol', () => {
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
    expect(readFormalizationRequest(f.directory).contextProtocol).toBe('kernel-v2');
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
