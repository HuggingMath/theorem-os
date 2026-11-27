import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_EXAMPLE_PROOF, LOCAL_EXAMPLE_STATEMENT } from '../src/math/localExample';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { readMathAgentSkill } from '../src/runtime/codexSkills';
import type { MathAgentOptions, MathAgentSession } from '../src/runtime/codexSession';
import { directSolverModules, type SolverModules } from '../src/solver/modules';
import { committedSource, git } from '../src/solver/problem';
import { readSolverRunState, writeSolverRunState } from '../src/solver/archive';
import { runResearchLead, type WorkerAccess } from '../src/solver/research';
import { DeclarationArtifactCheckError } from '../src/solver/declarationArtifacts';
import { VerificationCheckpointError, withVerificationCheckpoints } from '../src/solver/verificationCheckpoint';
import { VerifierFailureError } from '../src/solver/verifierFailure';
import { deferred } from './helpers/async';
import { localExample, solverState } from './helpers/solver';
import { failedBatch, receiptBatch } from './helpers/verifier';

const host = vi.hoisted(() => ({ verify: vi.fn(), declarations: vi.fn(), writeDeclarations: vi.fn() }));
vi.mock('../src/math/mathBuildManifest', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/mathBuildManifest')>(), readMathBuildManifest: vi.fn(),
}));
vi.mock('../src/math/verifier', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/verifier')>(),
  checkManyFormalVerifications: host.verify, formalVerificationToolIdentity: () => undefined,
  resolveMathematicsLakePackagesCache: () => undefined,
}));
// Declaration verification itself has separate real-Lean coverage. Here the API double
// isolates delivery scheduling, writer shutdown and host-owned persistence from that engine.
vi.mock('../src/solver/declarationArtifacts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/solver/declarationArtifacts')>(),
  checkDeclarationArtifacts: host.declarations, writeDeclarationArtifacts: host.writeDeclarations,
}));

describe('skill research runtime', () => {
  type Fixture = ReturnType<typeof fixture>;
  type Plan = (current: Omit<Fixture, 'completion'>, options: MathAgentOptions, message: string) => void | Promise<void>;
  const fixtures: Fixture[] = [];
  const verified = (request: Parameters<typeof receiptBatch>[0]) => receiptBatch(request, {
    sessionId: 'skill-runtime-host', receiptId: (_, name) => request.targetCommit + '-' + name,
  });
  beforeEach(() => {
    host.verify.mockReset().mockImplementation(async request => verified(request));
    host.declarations.mockReset().mockImplementation(async input => {
      input.assertWriterStopped();
      return input.declarations.map((declaration: { name: string }) => ({ id: 'checked-' + declaration.name,
        declaration, proof: { commit: input.commit, passed: true } }));
    });
    host.writeDeclarations.mockReset().mockImplementation((directory, state, artifacts) => {
      fs.writeFileSync(path.join(directory, 'declarations.json'), JSON.stringify({ runId: state.runId, artifacts }));
    });
  });
  afterEach(async () => {
    for (const current of fixtures.splice(0)) {
      current.controller.abort(); await Promise.allSettled([current.completion]);
      fs.rmSync(current.directory, { recursive: true, force: true });
    }
  });

  function fixture(plans: Plan[], stop: 'confirmed' | 'missing' | 'unconfirmed' | 'throw' = 'confirmed', tools?: string,
    common = false, fullWorkflow = false, nativeTeam = false) {
    const base = localExample('skill-research-runtime-');
    const { directory, workspace, problem } = base;
    const projected = path.join(workspace, '.agents/skills/theoremos-research');
    fs.mkdirSync(path.dirname(projected), { recursive: true });
    fs.cpSync(path.resolve('skills/theoremos-research'), projected, { recursive: true });
    const skill = readMathAgentSkill(path.join(projected, 'SKILL.md'));
    const state = solverState(problem, workspace, { runId: 'skill-runtime', phase: 'prepared', researchMode: 'skill',
      researchSkill: { name: skill.name, digest: skill.digest, loading: skill.loading },
      ...(fullWorkflow ? { researchSkillWorkflow: 'full' } : {}),
      ...(nativeTeam ? { researchDelegation: { mode: 'team', maxAgents: 2 },
        agentTeam: { schema: 'theorem-os.agent-team.v1', transport: 'native-agent-control',
          workers: [], events: [], deliveries: [], adoptions: [], operations: [] } } as const : {}),
      ...(common ? { commonResearchSkill: { name: skill.name, digest: skill.digest, loading: skill.loading } } : {}) });
    const controller = new AbortController();
    const opened: MathAgentOptions[] = [], messages: string[] = [], events: { event: string; details?: Record<string, unknown> }[] = [];
    const stops = vi.fn(async () => {
      if (stop === 'throw') throw new Error('fixture-shutdown-failed');
      return stop === 'unconfirmed' ? { status: 'unconfirmed' as const, reason: 'turn-not-settled' as const }
        : { status: 'stopped' as const };
    });
    const close = vi.fn(async () => {}), select = vi.fn((...args: Parameters<typeof directSolverModules.M3.select>) => {
      if (fullWorkflow) return directSolverModules.M3.select(...args);
      throw new Error('skill-must-not-use-M3');
    });
    const build = vi.fn((...args: Parameters<typeof directSolverModules.M4.build>) => {
      if (common || fullWorkflow) return directSolverModules.M4.build(...args);
      throw new Error('skill-must-not-use-M4');
    });
    const applyLibrary = vi.fn(async () => {
      if (fullWorkflow) return { status: 'skipped' as const, reason: 'no-fixture-candidate', candidates: [] };
      throw new Error('skill-must-not-auto-apply-library');
    });
    const open = vi.fn(async (options: MathAgentOptions): Promise<MathAgentSession> => {
      const index = opened.push(options) - 1;
      return { threadId: options.threadId ?? 'persistent-native-research-thread', close,
        ...(nativeTeam ? { usageSource: 'upstream-requests' as const } : {}),
        run: async (message, id, _workspace, started) => {
          messages.push(message); started(id);
          const admission = nativeTeam ? options.requestGate?.({ requestId: id }) : undefined;
          if (nativeTeam) expect(admission?.allowed).toBe(true);
          await plans[index]?.(current, options, message);
          if (admission?.allowed) admission.settle({ complete: true, outcome: 'completed',
            usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } });
          if (nativeTeam) expect(options.requestGate?.checkpoint?.()).toBe(false);
          return 'completed';
        }, interrupt: async () => {}, ...(stop === 'missing' ? {} : { stopForFreeze: stops }),
      };
    });
    const modules: SolverModules = { ...directSolverModules,
      M1: { ...directSolverModules.M1, open }, M2: { ...directSolverModules.M2, applyLibrary },
      M3: { ...directSolverModules.M3, select }, M4: { ...directSolverModules.M4, build, tools },
    };
    const access: WorkerAccess = { environment: {}, retrievalRoot: directory,
      researchSkill: skill, ...(common ? { commonResearchSkill: skill } : {}), installedLibrary: { digest: 'installed-fixture',
        base: { entries: [], evidence: [], contexts: [], routeFindings: [] } } };
    const source = path.join(workspace, problem.projectRelative, 'Submission.lean'), notes = path.join(workspace, 'RESEARCH.md');
    const requestFile = path.join(workspace, '.scratch/declaration-submission.json');
    const savedStates: Record<string, unknown>[] = [];
    const current = { ...base, state, access, modules, controller, opened, messages, events, savedStates,
      open, close, stops, select, build, applyLibrary, source, notes, requestFile, skill };
    const completion = withVerificationCheckpoints({ environmentDigest: state.environmentDigest,
      problemReceiptDigest: problem.receiptDigest, checkpoints: state.verificationCheckpoints ??= [],
      save: () => { savedStates.push(JSON.parse(JSON.stringify(state))); },
      emit: (event, details) => events.push({ event, details }) }, () => runResearchLead({ state, access, modules, root: directory,
      buildFile: path.join(directory, 'unused-build.json'), taskText: 'Prove both original addition targets.',
      executable: 'offline-no-model', profile: 'offline-no-credentials', signal: controller.signal,
      deadline: Infinity, maxTurns: plans.length, maxTurnMs: Infinity, maxTotalTokens: 0,
      save: () => { savedStates.push(JSON.parse(JSON.stringify(state))); },
      emit: (event, details) => events.push({ event, details }) }));
    void completion.catch(() => {});
    const result = { ...current, completion }; fixtures.push(result); return result;
  }

  const requestHelper = (current: Omit<Fixture, 'completion'>) => {
    fs.mkdirSync(path.dirname(current.requestFile), { recursive: true });
    fs.writeFileSync(current.requestFile, JSON.stringify({ declarations: [
      { file: 'Submission.lean', name: 'Tutorial.helper', type: 'True' },
    ] }));
  };

  const resumeDeclarations = (current: Fixture, limits = { maxTurns: 1, maxTotalTokens: 0 }) => withVerificationCheckpoints({
    environmentDigest: current.state.environmentDigest, problemReceiptDigest: current.problem.receiptDigest,
    checkpoints: current.state.verificationCheckpoints ??= [],
    save: () => { current.savedStates.push(JSON.parse(JSON.stringify(current.state))); },
    emit: (event, details) => current.events.push({ event, details }),
  }, () => runResearchLead({
    state: current.state, access: current.access, modules: current.modules,
    root: current.directory, buildFile: path.join(current.directory, 'unused-build.json'),
    taskText: 'Prove both original addition targets.', executable: 'offline-no-model', profile: 'offline-no-credentials',
    signal: new AbortController().signal, deadline: Infinity, maxTurnMs: Infinity, ...limits,
    save: () => { current.savedStates.push(JSON.parse(JSON.stringify(current.state))); },
    emit: (event, details) => current.events.push({ event, details }),
  }));

  const checkpointHelper = () => host.declarations.mockImplementationOnce(async input => {
    throw new VerificationCheckpointError({ key: 'helper-checkpoint', targetCommit: input.commit,
      timeoutMs: 1000, attempts: 1, at: Date.now(), receiptIds: ['pending-helper'] });
  });

  it('retains library automation, configurable host modules and compact continuation in the full Skill workflow', async () => {
    const current = fixture([f => { fs.writeFileSync(f.notes, 'First distinct attempt saved.'); },
      f => { fs.appendFileSync(f.notes, '\nA new experiment follows.'); }], 'confirmed', undefined, false, true);
    expect(await current.completion).toBeUndefined();
    expect(current.select).toHaveBeenCalledTimes(2);
    expect(current.build).toHaveBeenCalledTimes(2);
    expect(current.applyLibrary).toHaveBeenCalledTimes(current.problem.targets.length);
    expect(current.events.filter(item => item.event === 'context_dispatched').map(item => item.details?.mode))
      .toEqual(['full', 'continuation']);
    expect(current.messages[1]).not.toContain('Prove both original addition targets.');
    expect(current.stops).toHaveBeenCalledTimes(2);
    expect(current.state.cooperation).toBeUndefined();
  });

  it('finishes a full Skill whole-proof checkpoint before model admission without rerunning host automation', async () => {
    host.verify.mockImplementationOnce(async request => {
      const batch = verified(request);
      return { ...batch, status: 'blocked', results: batch.results.map(receipt => ({
        ...receipt, status: 'blocked', error: 'Lean verification timed out.',
      })) };
    });
    const current = fixture([f => { fs.writeFileSync(f.source, LOCAL_EXAMPLE_PROOF); }], 'confirmed', undefined, false, true);
    await expect(current.completion).rejects.toThrow('math_verification_checkpoint');
    expect(current.state.pendingProofCheck).toBeDefined();
    const before = current.applyLibrary.mock.calls.length;
    const result = await resumeDeclarations(current, { maxTurns: 1, maxTotalTokens: 0 });
    expect(result?.check.passed).toBe(true);
    expect(current.state.pendingProofCheck).toBeUndefined();
    expect(current.open).toHaveBeenCalledTimes(1);
    expect(current.applyLibrary).toHaveBeenCalledTimes(before);
  });

  it.each([false, true])('saves natural turns and continues the same thread without cooperation (shared guidance: %s)', async common => {
    let frozenCommit: string | undefined;
    const current = fixture([
      f => { fs.appendFileSync(f.source, '\n-- first reproducible attempt\n'); fs.writeFileSync(f.notes, 'The two original goals remain open.\n'); },
      (f, options) => {
        frozenCommit = git(f.workspace, ['rev-parse', 'HEAD']);
        expect(committedSource(f.workspace, frozenCommit, f.problem.projectRelative + '/Submission.lean')).toContain('first reproducible attempt');
        expect(committedSource(f.workspace, frozenCommit, 'RESEARCH.md')).toContain('remain open');
        expect(f.stops).toHaveBeenCalledTimes(1);
        expect(options.threadId).toBe('persistent-native-research-thread');
        fs.appendFileSync(f.notes, 'Next probe recorded durably.\n');
      },
    ], 'confirmed', undefined, common);
    expect(await current.completion).toBeUndefined();
    expect(frozenCommit).not.toBe(current.problem.baseCommit);
    expect(current.stops).toHaveBeenCalledTimes(2);
    expect(current.opened).toHaveLength(2);
    expect(current.opened[0].skills).toEqual([current.skill]);
    expect(current.opened[0].turnTimeoutMs).toBeUndefined();
    expect(current.state.cooperation).toBeUndefined();
    expect(current.state.workers).toBeUndefined();
    expect(current.select).not.toHaveBeenCalled();
    if (common) expect(current.build).toHaveBeenCalledTimes(2);
    else expect(current.build).not.toHaveBeenCalled();
    expect(current.applyLibrary).not.toHaveBeenCalled(); expect(host.verify).not.toHaveBeenCalled();
    expect(committedSource(current.workspace, git(current.workspace, ['rev-parse', 'HEAD']), 'RESEARCH.md')).toContain('Next probe');
    expect(current.events.filter(item => item.event === 'research_saved')).toHaveLength(2);
    expect(current.events.filter(item => item.event === 'context_dispatched').map(item => item.details?.mode))
      .toEqual(['full', 'continuation']);
    expect(current.messages[0]).toContain('Prove both original addition targets.');
    expect(current.messages[1]).not.toContain('Prove both original addition targets.');
    expect(current.messages[1]).toContain(current.problem.receiptDigest);
    expect(current.messages[1]).toContain('RESEARCH.md');
  });

  it.each([false, true])('restores full task context after native compaction and then resumes concise continuation (shared guidance: %s)', async common => {
    const current = fixture([
      (_f, options) => {
        options.onActivity?.({ event: 'item_started', itemType: 'contextCompaction' });
        options.onActivity?.({ event: 'item_completed', itemType: 'contextCompaction' });
      },
      () => {},
      () => {},
    ], 'confirmed', undefined, common);
    expect(await current.completion).toBeUndefined();
    expect(current.events.filter(item => item.event === 'context_dispatched').map(item => item.details?.mode))
      .toEqual(['full', 'full', 'continuation']);
    expect(current.messages[1]).toContain('Prove both original addition targets.');
    expect(current.messages[1]).toContain(current.problem.receiptDigest);
    expect(current.messages[2]).not.toContain('Prove both original addition targets.');
    expect(current.opened.slice(1).map(options => options.threadId))
      .toEqual(['persistent-native-research-thread', 'persistent-native-research-thread']);
    expect(current.state.previousThreadIds).toBeUndefined();
    expect(current.state.cooperation).toBeUndefined();
    expect(host.verify).not.toHaveBeenCalled();
  });

  it('sends the full frozen task on the first dispatch after a host restart even with a saved native thread', async () => {
    const current = fixture([f => { fs.writeFileSync(f.notes, 'Unfinished research saved.\n'); }]);
    expect(await current.completion).toBeUndefined();
    expect(await resumeDeclarations(current, { maxTurns: 2, maxTotalTokens: 0 })).toBeUndefined();
    expect(current.opened[1].threadId).toBe(current.opened[0].threadId ?? 'persistent-native-research-thread');
    expect(current.messages).toHaveLength(2);
    for (const message of current.messages) expect(message).toContain('Prove both original addition targets.');
    expect(current.events.filter(item => item.event === 'context_dispatched').map(item => item.details?.mode))
      .toEqual(['full', 'full']);
  });

  it('uses the host-projected tool bundle when the application source is hidden', async () => {
    const current = fixture([f => {
      const help = fs.readFileSync(path.join(f.workspace, '.scratch/theoremos-help.md'), 'utf8');
      expect(help).toContain("bun '/opt/theoremos-agent-tools/math.mjs' check-lean");
      expect(help).not.toContain(path.join(f.directory, 'bin/math.ts'));
    }], 'confirmed', '/opt/theoremos-agent-tools/math.mjs');
    expect(await current.completion).toBeUndefined();
    expect(current.build).not.toHaveBeenCalled();
    expect(current.stops).toHaveBeenCalledOnce();
  });

  it('publishes a helper through the declaration API while keeping the original theorem unfinished', async () => {
    const current = fixture([f => {
      fs.writeFileSync(f.source, LOCAL_EXAMPLE_STATEMENT.replace('end Tutorial', 'theorem helper : True := by trivial\n\nend Tutorial'));
      requestHelper(f);
    }]);
    expect(await current.completion).toBeUndefined();
    expect(host.declarations).toHaveBeenCalledTimes(1);
    const checked = host.declarations.mock.calls[0][0];
    expect(checked.declarations[0]).toMatchObject({ file: 'Submission.lean', name: 'Tutorial.helper', type: 'True' });
    expect(checked.commit).toBe(git(current.workspace, ['rev-parse', 'HEAD']));
    expect(current.stops).toHaveBeenCalledTimes(1);
    expect(host.writeDeclarations.mock.calls[0][0]).toBe(current.directory);
    expect(JSON.parse(fs.readFileSync(path.join(current.directory, 'declarations.json'), 'utf8')).artifacts).toHaveLength(1);
    expect(fs.existsSync(current.requestFile)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(current.workspace, '.scratch/declaration-feedback.json'), 'utf8')))
      .toMatchObject({ status: 'checked', originalProblemAcceptance: 'not-assessed' });
    expect(current.state.check).toBeUndefined(); expect(host.verify).not.toHaveBeenCalled();
  });

  it('checks a Lead declaration submission after native completion without a coordination checkpoint', async () => {
    const current = fixture([f => {
      fs.writeFileSync(f.source, LOCAL_EXAMPLE_STATEMENT.replace('end Tutorial', 'theorem helper : True := by trivial\n\nend Tutorial'));
      requestHelper(f);
    }], 'confirmed', undefined, false, false, true);
    expect(await current.completion).toBeUndefined();
    expect(current.events.some(item => item.event === 'team_coordination_checkpoint')).toBe(false);
    expect(current.events.some(item => item.event === 'team_coordination_continued')).toBe(false);
    expect(current.stops).toHaveBeenCalledOnce();
    expect(host.declarations).toHaveBeenCalledOnce();
    expect(current.stops.mock.invocationCallOrder[0]).toBeLessThan(host.declarations.mock.invocationCallOrder[0]);
    expect(fs.existsSync(current.requestFile)).toBe(false);
    expect(current.state.check).toBeUndefined();
  });

  it('accepts a completed native original proof only after writer shutdown', async () => {
    const current = fixture([f => { fs.writeFileSync(f.source, LOCAL_EXAMPLE_PROOF); }],
      'confirmed', undefined, false, false, true);
    expect((await current.completion)?.check.passed).toBe(true);
    expect(current.events.some(item => item.event === 'team_coordination_checkpoint')).toBe(false);
    expect(current.events.some(item => item.event === 'team_coordination_continued')).toBe(false);
    expect(current.stops).toHaveBeenCalledOnce();
    expect(current.stops.mock.invocationCallOrder[0]).toBeLessThan(host.verify.mock.invocationCallOrder[0]);
  });

  it('returns invalid-source feedback after native completion without accepting the source', async () => {
    const current = fixture([f => { fs.writeFileSync(f.source, 'theorem changed : True := by trivial\n'); }],
      'confirmed', undefined, false, false, true);
    expect(await current.completion).toBeUndefined();
    expect(current.events.some(item => item.event === 'team_coordination_checkpoint')).toBe(false);
    expect(current.events.some(item => item.event === 'team_coordination_continued')).toBe(false);
    expect(current.events.some(item => item.event === 'source_rejected')).toBe(true);
    expect(current.stops).toHaveBeenCalledOnce();
    expect(host.verify).not.toHaveBeenCalled();
    expect(host.declarations).not.toHaveBeenCalled();
  });

  it('waits for writer stop and freezes the final settled bytes before independent acceptance', async () => {
    const stopped = deferred<{ status: 'stopped' }>();
    const current = fixture([f => { fs.writeFileSync(f.source, LOCAL_EXAMPLE_PROOF); }]);
    current.stops.mockImplementationOnce(() => stopped.promise);
    try {
      await expect.poll(() => current.stops.mock.calls.length).toBe(1);
      expect(host.verify).not.toHaveBeenCalled();
      expect(git(current.workspace, ['rev-parse', 'HEAD'])).toBe(current.problem.baseCommit);
      const finalBytes = LOCAL_EXAMPLE_PROOF + '\n-- final in-flight source write\n';
      fs.writeFileSync(current.source, finalBytes); fs.writeFileSync(current.notes, 'Final tool output persisted.\n');
      stopped.resolve({ status: 'stopped' });
      const result = await current.completion;
      expect(result?.check.passed).toBe(true);
      expect(committedSource(current.workspace, result!.check.commit, current.problem.projectRelative + '/Submission.lean')).toBe(finalBytes);
      expect(committedSource(current.workspace, result!.check.commit, 'RESEARCH.md')).toContain('Final tool output');
    } finally { stopped.resolve({ status: 'stopped' }); }
  });

  it('returns correctable rejected declaration feedback to the next turn', async () => {
    const current = fixture([
      f => { fs.mkdirSync(path.dirname(f.requestFile), { recursive: true }); fs.writeFileSync(f.requestFile, '{"declarations":[]}'); },
      (f, _options, message) => {
        expect(message).toContain('Declaration check feedback');
        expect(JSON.parse(fs.readFileSync(path.join(f.workspace, '.scratch/declaration-feedback.json'), 'utf8')))
          .toMatchObject({ status: 'rejected', originalProblemAcceptance: 'not-assessed' });
        requestHelper(f);
      },
    ]);
    expect(await current.completion).toBeUndefined();
    expect(host.declarations).toHaveBeenCalledTimes(1);
    expect(host.writeDeclarations).toHaveBeenCalledTimes(1);
    expect(current.events.filter(item => item.event === 'declarations_checked').map(item => item.details?.passed)).toEqual([false, true]);
  });

  it.each([
    Object.assign(new Error('fixture host checkout read EIO'), { code: 'EIO' }),
    Object.assign(new Error('fixture host checkout write ENOSPC'), { code: 'ENOSPC' }),
    new VerifierFailureError({ stage: 'fixture-declaration-check' }, new Error('fixture verifier initialization failed')),
  ])('retains a declaration request after infrastructure failure $message and retries before model admission', async error => {
    host.declarations.mockRejectedValueOnce(error);
    const current = fixture([f => { requestHelper(f); }, () => { throw new Error('must-not-dispatch-after-host-failure'); }]);
    await expect(current.completion).rejects.toThrow(error.message);
    const pending = { commit: git(current.workspace, ['rev-parse', 'HEAD']),
      requestDigest: mathDigest(fs.readFileSync(current.requestFile)) };
    expect(current.state.pendingDeclarationCheck).toEqual(pending);
    expect(current.savedStates.at(-1)?.pendingDeclarationCheck).toEqual(pending);
    expect(current.state.pendingResearchFreeze).toBeDefined();
    expect(fs.existsSync(path.join(current.workspace, '.scratch/declaration-feedback.json'))).toBe(false);
    expect(current.events.some(item => item.event === 'declarations_checked')).toBe(false);
    expect(host.writeDeclarations).not.toHaveBeenCalled();
    expect(current.open).toHaveBeenCalledTimes(1);
    expect(await resumeDeclarations(current)).toBeUndefined();
    expect(current.state.pendingDeclarationCheck).toBeUndefined();
    expect(current.state.pendingResearchFreeze).toBeUndefined();
    expect(fs.existsSync(current.requestFile)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(current.workspace, '.scratch/declaration-feedback.json'), 'utf8')))
      .toMatchObject({ status: 'checked', commit: pending.commit });
    expect(host.declarations).toHaveBeenCalledTimes(2);
    expect(host.writeDeclarations).toHaveBeenCalledTimes(1);
    expect(current.open).toHaveBeenCalledTimes(1);
    expect(current.state.turns).toBe(1);
    expect(host.verify).not.toHaveBeenCalled();
  });

  it.each(['write-error', 'corrupt-manifest'] as const)('retains a checked declaration after host artifact %s and resumes without a model turn', async failure => {
    const error = Object.assign(new Error('fixture host artifact write EIO'), { code: 'EIO' });
    const actual = await vi.importActual<typeof import('../src/solver/declarationArtifacts')>('../src/solver/declarationArtifacts');
    host.writeDeclarations.mockImplementationOnce(failure === 'write-error'
      ? () => { throw error; } : actual.writeDeclarationArtifacts);
    const current = fixture([f => {
      requestHelper(f);
      if (failure === 'corrupt-manifest') fs.writeFileSync(path.join(f.directory, 'declarations.json'), '{"schema":"broken"}');
    }]);
    await expect(current.completion).rejects.toThrow(failure === 'write-error'
      ? error.message : 'math_declaration_artifact_manifest_identity_changed');
    const request = fs.readFileSync(current.requestFile), pending = {
      commit: git(current.workspace, ['rev-parse', 'HEAD']), requestDigest: mathDigest(request),
    };
    expect(current.state.pendingDeclarationCheck).toEqual(pending);
    expect(current.savedStates.at(-1)?.pendingDeclarationCheck).toEqual(pending);
    expect(current.savedStates.some(saved =>
      (saved.pendingDeclarationCheck as { phase?: string } | undefined)?.phase === 'completed')).toBe(false);
    expect(fs.existsSync(path.join(current.workspace, '.scratch/declaration-feedback.json'))).toBe(false);
    expect(current.events.some(item => item.event === 'declarations_checked')).toBe(false);
    expect(current.state.verifierFailure).toBeUndefined();
    expect(host.declarations).toHaveBeenCalledTimes(1); expect(host.writeDeclarations).toHaveBeenCalledTimes(1);
    if (failure === 'corrupt-manifest') {
      const sidecar = path.join(current.directory, 'declarations.json');
      expect(fs.readFileSync(sidecar, 'utf8')).toBe('{"schema":"broken"}');
      fs.rmSync(sidecar);
    }
    expect(await resumeDeclarations(current)).toBeUndefined();
    expect(current.state.pendingDeclarationCheck).toBeUndefined();
    expect(fs.existsSync(current.requestFile)).toBe(false);
    expect(host.declarations).toHaveBeenCalledTimes(2); expect(host.writeDeclarations).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fs.readFileSync(path.join(current.workspace, '.scratch/declaration-feedback.json'), 'utf8')))
      .toMatchObject({ status: 'checked', commit: pending.commit });
    expect(current.events.filter(item => item.event === 'declarations_checked').map(item => item.details?.passed)).toEqual([true]);
    expect(current.open).toHaveBeenCalledTimes(1); expect(current.messages).toHaveLength(1);
    expect(current.state.turns).toBe(1); expect(host.verify).not.toHaveBeenCalled();
  });

  it('retains a checked declaration when successful feedback persistence fails and resumes without a model turn', async () => {
    const error = Object.assign(new Error('fixture host feedback write EIO'), { code: 'EIO' });
    const rename = fs.renameSync;
    let feedbackFile: string | undefined, failOnce = true;
    const persistence = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === feedbackFile && failOnce) { failOnce = false; throw error; }
      return rename(from, to);
    });
    let current: Fixture;
    try {
      current = fixture([f => {
        requestHelper(f); feedbackFile = path.join(f.workspace, '.scratch/declaration-feedback.json');
      }]);
      await expect(current.completion).rejects.toThrow(error.message);
    } finally { persistence.mockRestore(); }
    const pending = { commit: git(current.workspace, ['rev-parse', 'HEAD']),
      requestDigest: mathDigest(fs.readFileSync(current.requestFile)) };
    expect(current.state.pendingDeclarationCheck).toEqual(pending);
    expect(current.savedStates.at(-1)?.pendingDeclarationCheck).toEqual(pending);
    expect(fs.existsSync(feedbackFile!)).toBe(false);
    expect(current.events.some(item => item.event === 'declarations_checked')).toBe(false);
    expect(host.declarations).toHaveBeenCalledTimes(1); expect(host.writeDeclarations).toHaveBeenCalledTimes(1);
    const artifacts = fs.readFileSync(path.join(current.directory, 'declarations.json'));
    expect(await resumeDeclarations(current)).toBeUndefined();
    expect(current.state.pendingDeclarationCheck).toBeUndefined();
    expect(fs.existsSync(current.requestFile)).toBe(false);
    expect(fs.readFileSync(path.join(current.directory, 'declarations.json'))).toEqual(artifacts);
    expect(JSON.parse(fs.readFileSync(feedbackFile!, 'utf8'))).toMatchObject({ status: 'checked', commit: pending.commit });
    expect(current.events.filter(item => item.event === 'declarations_checked').map(item => item.details?.passed)).toEqual([true]);
    expect(host.declarations).toHaveBeenCalledTimes(2); expect(host.writeDeclarations).toHaveBeenCalledTimes(2);
    expect(current.open).toHaveBeenCalledTimes(1); expect(current.messages).toHaveLength(1);
    expect(current.state.turns).toBe(1); expect(host.verify).not.toHaveBeenCalled();
  });

  it.each(['checkpoint', 'abort'] as const)('retains a declaration request after %s without mathematical rejection', async interruption => {
    let current: Fixture;
    host.declarations.mockImplementationOnce(async input => {
      if (interruption === 'abort') {
        current.controller.abort(new Error('fixture declaration check aborted'));
        input.signal.throwIfAborted();
      }
      throw new VerificationCheckpointError({ key: 'helper-checkpoint', targetCommit: input.commit,
        timeoutMs: 1000, attempts: 1, at: Date.now(), receiptIds: ['pending-helper'] });
    });
    current = fixture([f => { requestHelper(f); }]);
    await expect(current.completion).rejects.toThrow(interruption === 'checkpoint'
      ? 'math_verification_checkpoint' : 'fixture declaration check aborted');
    expect(fs.existsSync(current.requestFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(current.requestFile, 'utf8')).declarations[0].name).toBe('Tutorial.helper');
    expect(fs.existsSync(path.join(current.workspace, '.scratch/declaration-feedback.json'))).toBe(false);
    expect(current.events.some(item => item.event === 'declarations_checked')).toBe(false);
    expect(host.writeDeclarations).not.toHaveBeenCalled(); expect(host.verify).not.toHaveBeenCalled();
    expect(current.state.verifierFailure).toBeUndefined();
    expect(current.stops).toHaveBeenCalledTimes(1);
  });

  it.each(['blocked', 'unavailable'] as const)('retains a %s declaration request and records an infrastructure failure', async status => {
    host.declarations.mockImplementationOnce(async input => {
      throw new DeclarationArtifactCheckError(input.declarations[0], {
        schema: 'deepscientist.mathematics.verification-batch/v1', status, targetCommit: input.commit,
        sessionId: 'unavailable-declaration-verifier', events: [], startedAt: 1, checkedAt: 2, durationMs: 1,
        results: [{ status, targetCommit: input.commit, proofPath: 'Submission.lean', theoremName: 'Tutorial.helper',
          receiptId: 'unavailable-helper', error: 'fixture Lean environment unavailable' }],
      });
    });
    const current = fixture([f => { requestHelper(f); }]);
    await expect(current.completion).rejects.toThrow('math_verifier_unavailable');
    expect(fs.existsSync(current.requestFile)).toBe(true);
    expect(fs.existsSync(path.join(current.workspace, '.scratch/declaration-feedback.json'))).toBe(false);
    expect(current.events.some(item => item.event === 'declarations_checked')).toBe(false);
    expect(host.writeDeclarations).not.toHaveBeenCalled(); expect(host.verify).not.toHaveBeenCalled();
    expect(current.state.verifierFailure).toMatchObject({ stage: 'declaration-check',
      sourceCommit: git(current.workspace, ['rev-parse', 'HEAD']), verification: { status,
        results: [expect.objectContaining({ error: 'fixture Lean environment unavailable' })] } });
    expect(current.stops).toHaveBeenCalledTimes(1);
  });

  it.each(['mathematical', 'invocation', 'cleanup'] as const)('classifies a failed helper receipt with %s diagnostics before consuming it', async failure => {
    host.declarations.mockImplementationOnce(async input => {
      throw new DeclarationArtifactCheckError(input.declarations[0], {
        schema: 'deepscientist.mathematics.verification-batch/v1', status: 'failed', targetCommit: input.commit,
        sessionId: 'failed-helper-verifier', events: [], startedAt: 1, checkedAt: 2, durationMs: 1,
        results: [{ status: 'failed', targetCommit: input.commit, proofPath: 'Submission.lean', theoremName: 'Tutorial.helper',
          receiptId: 'failed-helper', error: failure === 'invocation' ? 'Process exited without Lean diagnostics' : 'Lean exited with status 1.',
          ...(failure === 'invocation' ? {} : { stdoutPreview: 'Submission.lean:1:1: error: unsolved goals' }),
          ...(failure === 'cleanup' ? { cleanupError: 'fixture checkout cleanup failed' } : {}) }],
      });
    });
    const current = fixture([f => { requestHelper(f); }, (f, _options, message) => {
      expect(message).toContain('Declaration check feedback');
      expect(fs.existsSync(f.requestFile)).toBe(false);
    }]);
    if (failure === 'mathematical') {
      expect(await current.completion).toBeUndefined();
      expect(current.state.pendingDeclarationCheck).toBeUndefined();
      expect(JSON.parse(fs.readFileSync(path.join(current.workspace, '.scratch/declaration-feedback.json'), 'utf8')))
        .toMatchObject({ status: 'rejected', originalProblemAcceptance: 'not-assessed' });
      expect(current.open).toHaveBeenCalledTimes(2);
    } else {
      await expect(current.completion).rejects.toThrow('math_verifier_unavailable');
      expect(current.state.pendingDeclarationCheck).toBeDefined();
      expect(fs.existsSync(current.requestFile)).toBe(true);
      expect(fs.existsSync(path.join(current.workspace, '.scratch/declaration-feedback.json'))).toBe(false);
      expect(current.state.verifierFailure).toMatchObject({ stage: 'declaration-check', verification: { status: 'failed' } });
      expect(await resumeDeclarations(current)).toBeUndefined();
      expect(current.state.pendingDeclarationCheck).toBeUndefined();
      expect(current.open).toHaveBeenCalledTimes(1);
      expect(current.state.turns).toBe(1);
    }
  });

  it.each(['turns', 'tokens'] as const)('retries a frozen helper checkpoint before exhausted %s admission without another model turn', async exhausted => {
    checkpointHelper();
    const current = fixture([f => { requestHelper(f); }]);
    await expect(current.completion).rejects.toThrow('math_verification_checkpoint');
    const pending = { commit: git(current.workspace, ['rev-parse', 'HEAD']),
      requestDigest: mathDigest(fs.readFileSync(current.requestFile)) };
    expect(current.state.pendingDeclarationCheck).toEqual(pending);
    expect(current.savedStates.some(saved => JSON.stringify(saved.pendingDeclarationCheck) === JSON.stringify(pending))).toBe(true);
    expect(current.state.turns).toBe(1);
    if (exhausted === 'tokens') {
      current.state.usage = { totalTokens: 10, inputTokens: 8, outputTokens: 2 };
      current.state.usageAccounting = { startedTurns: 1, reportedTurns: 1, pending: false, incomplete: false };
      current.state.requestUsageAccounting = undefined;
    }
    expect(await resumeDeclarations(current, exhausted === 'turns'
      ? { maxTurns: 1, maxTotalTokens: 0 } : { maxTurns: 2, maxTotalTokens: 10 })).toBeUndefined();
    expect(host.declarations).toHaveBeenCalledTimes(2);
    expect(host.declarations.mock.calls[1][0].commit).toBe(pending.commit);
    expect(host.writeDeclarations).toHaveBeenCalledTimes(1);
    expect(current.state.pendingDeclarationCheck).toBeUndefined();
    expect(fs.existsSync(current.requestFile)).toBe(false);
    expect(current.open).toHaveBeenCalledTimes(1); expect(current.messages).toHaveLength(1);
    expect(current.state.turns).toBe(1); expect(current.stops).toHaveBeenCalledTimes(1);
    expect(host.verify).not.toHaveBeenCalled();
    if (exhausted === 'tokens') expect(current.state.tokenBudget?.status).toBe('exhausted');
  });

  it.each(['source', 'request', 'missing-request'] as const)('rejects a changed pending helper %s before checking or opening a writer', async changed => {
    checkpointHelper();
    const current = fixture([f => { requestHelper(f); }]);
    await expect(current.completion).rejects.toThrow('math_verification_checkpoint');
    expect(current.state.pendingDeclarationCheck).toBeDefined();
    const pending = { ...current.state.pendingDeclarationCheck! };
    if (changed === 'source') fs.appendFileSync(current.source, '\n-- source changed after frozen verification checkpoint\n');
    else if (changed === 'request') fs.appendFileSync(current.requestFile, '\n ');
    else fs.rmSync(current.requestFile);
    await expect(resumeDeclarations(current)).rejects.toThrow(/math_.*changed/u);
    expect(current.state.pendingDeclarationCheck).toEqual(pending);
    expect(fs.existsSync(current.requestFile)).toBe(changed !== 'missing-request');
    expect(host.declarations).toHaveBeenCalledTimes(1); expect(host.writeDeclarations).not.toHaveBeenCalled();
    expect(current.open).toHaveBeenCalledTimes(1); expect(current.messages).toHaveLength(1);
    expect(current.state.turns).toBe(1); expect(host.verify).not.toHaveBeenCalled();
  });

  it.each(['present', 'removed'] as const)('finishes durable declaration consumption with its request %s and no new check or writer', async request => {
    const current = fixture([f => { requestHelper(f); }]);
    await current.completion;
    const completed = current.savedStates.find(saved =>
      (saved.pendingDeclarationCheck as { phase?: string } | undefined)?.phase === 'completed');
    expect(completed).toBeDefined();
    Object.assign(current.state, completed);
    if (request === 'present') requestHelper(current);
    // Public feedback is not execution authority; the host completion state is.
    fs.writeFileSync(path.join(current.workspace, '.scratch/declaration-feedback.json'), '{"status":"changed"}');
    expect(await resumeDeclarations(current)).toBeUndefined();
    expect(current.state.pendingDeclarationCheck).toBeUndefined();
    expect(fs.existsSync(current.requestFile)).toBe(false);
    expect(host.declarations).toHaveBeenCalledTimes(1);
    expect(host.writeDeclarations).toHaveBeenCalledTimes(1);
    expect(current.open).toHaveBeenCalledTimes(1);
  });

  it.each(['source', 'request'] as const)('keeps completed consumption bound to the frozen %s', async changed => {
    const current = fixture([f => { requestHelper(f); }]);
    await current.completion;
    const completed = current.savedStates.find(saved =>
      (saved.pendingDeclarationCheck as { phase?: string } | undefined)?.phase === 'completed');
    expect(completed).toBeDefined();
    Object.assign(current.state, completed);
    if (changed === 'source') fs.appendFileSync(current.source, '\n-- changed after completion\n');
    else { requestHelper(current); fs.appendFileSync(current.requestFile, '\n '); }
    await expect(resumeDeclarations(current)).rejects.toThrow(changed === 'source'
      ? 'math_research_freeze_identity_changed' : 'math_declaration_checkpoint_identity_changed');
    expect(current.state.pendingDeclarationCheck?.phase).toBe('completed');
    expect(host.declarations).toHaveBeenCalledTimes(1);
    expect(current.open).toHaveBeenCalledTimes(1);
  });

  it('accepts a complete original candidate after resuming its helper checkpoint without another model turn', async () => {
    checkpointHelper();
    const current = fixture([f => { fs.writeFileSync(f.source, LOCAL_EXAMPLE_PROOF); requestHelper(f); }]);
    await expect(current.completion).rejects.toThrow('math_verification_checkpoint');
    const commit = git(current.workspace, ['rev-parse', 'HEAD']);
    expect(current.state.turns).toBe(1); expect(host.verify).not.toHaveBeenCalled();
    const result = await resumeDeclarations(current);
    expect(result?.check.passed).toBe(true);
    expect(result?.check.commit).toBe(commit);
    expect(host.declarations).toHaveBeenCalledTimes(2);
    expect(host.writeDeclarations).toHaveBeenCalledTimes(1);
    expect(host.verify).toHaveBeenCalledTimes(1);
    expect(host.verify.mock.calls[0][0].items.map((item: { theoremName: string }) => item.theoremName))
      .toEqual(current.problem.targets.map(target => target.theoremName));
    expect(current.state.pendingDeclarationCheck).toBeUndefined();
    expect(current.open).toHaveBeenCalledTimes(1); expect(current.messages).toHaveLength(1);
    expect(current.state.turns).toBe(1); expect(current.stops).toHaveBeenCalledTimes(1);
  });

  it.each(['turns', 'tokens'] as const)('resumes whole-proof verification before exhausted %s admission without another model turn', async exhausted => {
    host.verify.mockImplementationOnce(async request => {
      const batch = verified(request);
      return { ...batch, status: 'blocked', results: batch.results.map(receipt => ({
        ...receipt, status: 'blocked', error: 'Lean verification timed out.',
      })) };
    });
    const current = fixture([f => { fs.writeFileSync(f.source, LOCAL_EXAMPLE_PROOF); }]);
    await expect(current.completion).rejects.toThrow('math_verification_checkpoint');
    expect(current.state.pendingProofCheck).toMatchObject({ commit: git(current.workspace, ['rev-parse', 'HEAD']),
      environmentDigest: current.state.environmentDigest, problemReceiptDigest: current.problem.receiptDigest });
    const stateFile = path.join(current.directory, 'checkpoint-state.json');
    writeSolverRunState(stateFile, current.state);
    expect(readSolverRunState(stateFile).pendingProofCheck).toEqual(current.state.pendingProofCheck);
    Object.assign(current.state, readSolverRunState(stateFile));
    expect(current.state.verificationCheckpoints).toHaveLength(1);
    expect(current.state.verificationCheckpoints![0].attempts).toBe(1);
    if (exhausted === 'tokens') {
      current.state.usage = { totalTokens: 10, inputTokens: 8, outputTokens: 2 };
      current.state.usageAccounting = { startedTurns: 1, reportedTurns: 1, pending: false, incomplete: false };
      current.state.requestUsageAccounting = undefined;
    }
    const result = await resumeDeclarations(current, exhausted === 'turns'
      ? { maxTurns: 1, maxTotalTokens: 0 } : { maxTurns: 2, maxTotalTokens: 10 });
    expect(result?.check.passed).toBe(true);
    expect(current.state.pendingProofCheck).toBeUndefined();
    expect(host.verify).toHaveBeenCalledTimes(2);
    expect(host.verify.mock.calls[1][0].timeoutMs).toBe(host.verify.mock.calls[0][0].timeoutMs * 2);
    expect(current.open).toHaveBeenCalledTimes(1); expect(current.messages).toHaveLength(1);
    expect(current.state.turns).toBe(1); expect(current.stops).toHaveBeenCalledTimes(1);
  });

  it('retains whole-proof work after verifier storage failure and recovers without a model turn', async () => {
    host.verify.mockRejectedValueOnce(Object.assign(new Error('fixture host receipt storage EIO'), { code: 'EIO' }));
    const current = fixture([f => { fs.writeFileSync(f.source, LOCAL_EXAMPLE_PROOF); }]);
    await expect(current.completion).rejects.toThrow('fixture host receipt storage EIO');
    const pending = { ...current.state.pendingProofCheck! };
    expect(current.savedStates.at(-1)?.pendingProofCheck).toEqual(pending);
    expect(current.state.pendingDeclarationCheck).toBeUndefined();
    expect((await resumeDeclarations(current))?.check.passed).toBe(true);
    expect(current.state.pendingProofCheck).toBeUndefined();
    expect(host.verify).toHaveBeenCalledTimes(2);
    expect(current.open).toHaveBeenCalledTimes(1); expect(current.state.turns).toBe(1);
  });

  it.each(['source', 'commit', 'environment', 'problem', 'source-digest'] as const)('rejects a changed whole-proof checkpoint %s before checking or opening a writer', async changed => {
    host.verify.mockRejectedValueOnce(new Error('fixture host receipt storage EIO'));
    const current = fixture([f => { fs.writeFileSync(f.source, LOCAL_EXAMPLE_PROOF); }]);
    await expect(current.completion).rejects.toThrow('fixture host receipt storage EIO');
    expect(current.state.pendingProofCheck).toBeDefined();
    if (changed === 'source') fs.appendFileSync(current.source, '\n-- changed after pending proof check\n');
    else if (changed === 'commit') {
      fs.writeFileSync(current.notes, 'Changed after the frozen whole-proof checkpoint.\n');
      git(current.workspace, ['add', 'RESEARCH.md']);
      git(current.workspace, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
        'commit', '--quiet', '-m', 'Changed frozen proof checkpoint']);
    } else if (changed === 'environment') current.state.environmentDigest += '-changed';
    else if (changed === 'problem') current.problem.receiptDigest += '-changed';
    else current.state.pendingProofCheck!.sourceDigest = '0'.repeat(64);
    const pending = { ...current.state.pendingProofCheck! };
    await expect(resumeDeclarations(current)).rejects.toThrow('math_proof_checkpoint_identity_changed');
    expect(current.state.pendingProofCheck).toEqual(pending);
    expect(host.verify).toHaveBeenCalledTimes(1); expect(current.open).toHaveBeenCalledTimes(1);
  });

  it.each(['source', 'commit', 'environment', 'problem', 'source-digest'] as const)('rejects changed stopped-source freeze %s before checking or opening a writer', async changed => {
    const current = fixture([f => { fs.writeFileSync(f.source, LOCAL_EXAMPLE_PROOF); }]);
    expect((await current.completion)?.check.passed).toBe(true);
    const frozen = current.savedStates.find(saved => saved.pendingResearchFreeze && !saved.pendingProofCheck)!;
    expect(frozen).toBeDefined();
    Object.assign(current.state, JSON.parse(JSON.stringify(frozen)), { check: undefined, pendingProofCheck: undefined });
    const stateFile = path.join(current.directory, 'freeze-state.json');
    writeSolverRunState(stateFile, current.state);
    expect(readSolverRunState(stateFile).pendingResearchFreeze).toEqual(current.state.pendingResearchFreeze);
    if (changed === 'source') fs.appendFileSync(current.source, '\n-- changed after stopped-source freeze\n');
    else if (changed === 'commit') {
      fs.writeFileSync(current.notes, 'Unexpected commit after the host checkpoint.\n');
      git(current.workspace, ['add', 'RESEARCH.md']);
      git(current.workspace, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
        'commit', '--quiet', '-m', 'Unexpected extra commit']);
    } else if (changed === 'environment') current.state.environmentDigest += '-changed';
    else if (changed === 'problem') current.state.problem.receiptDigest += '-changed';
    else current.state.pendingResearchFreeze!.sourceDigest = '0'.repeat(64);
    const pending = { ...current.state.pendingResearchFreeze! };
    await expect(resumeDeclarations(current)).rejects.toThrow('math_research_freeze_identity_changed');
    expect(current.state.pendingResearchFreeze).toEqual(pending);
    expect(host.verify).toHaveBeenCalledTimes(1);
    expect(current.open).toHaveBeenCalledTimes(1);
  });

  it('finishes persisted whole-proof acceptance cleanup without repeating verification or opening a writer', async () => {
    const current = fixture([f => { fs.writeFileSync(f.source, LOCAL_EXAMPLE_PROOF); }]);
    expect((await current.completion)?.check.passed).toBe(true);
    const accepted = current.savedStates.find(saved => saved.pendingProofCheck &&
      (saved.check as { passed?: boolean } | undefined)?.passed);
    expect(accepted).toBeDefined();
    Object.assign(current.state, accepted);
    expect((await resumeDeclarations(current))?.check.passed).toBe(true);
    expect(current.state.pendingProofCheck).toBeUndefined();
    expect(host.verify).toHaveBeenCalledTimes(1); expect(current.open).toHaveBeenCalledTimes(1);
  });

  it.each(['missing', 'unconfirmed', 'throw'] as const)('quarantines %s writer stop before committing or checking', async stop => {
    const current = fixture([f => { fs.writeFileSync(f.source, LOCAL_EXAMPLE_PROOF); requestHelper(f); }], stop);
    await expect(current.completion).rejects.toThrow('math_writer_stop_unconfirmed');
    expect(git(current.workspace, ['rev-parse', 'HEAD'])).toBe(current.problem.baseCommit);
    expect(current.state.writerStopUnconfirmed).toMatchObject({ reason: expect.any(String) });
    expect(host.verify).not.toHaveBeenCalled(); expect(host.declarations).not.toHaveBeenCalled();
    expect(host.writeDeclarations).not.toHaveBeenCalled(); expect(current.open).toHaveBeenCalledTimes(1);
    await expect(runResearchLead({ state: current.state, access: current.access,
      modules: current.modules, root: current.directory, buildFile: 'unused', taskText: 'Same original problem.',
      executable: 'offline-no-model', profile: 'offline-no-credentials', signal: current.controller.signal,
      deadline: Infinity, maxTurns: 1, maxTurnMs: Infinity, maxTotalTokens: 0, save: () => {}, emit: () => {} }))
      .rejects.toThrow('math_writer_stop_unconfirmed');
    expect(current.open).toHaveBeenCalledTimes(1);
  });

  it.each(['turn', 'resume'] as const)('cleans up successful whole-proof acceptance from %s despite its abort and a spare model turn', async entry => {
    if (entry === 'resume') host.verify.mockRejectedValueOnce(
      Object.assign(new Error('fixture pending whole-proof receipt EIO'), { code: 'EIO' }));
    const current = fixture([
      f => { fs.writeFileSync(f.source, LOCAL_EXAMPLE_PROOF); },
      () => { throw new Error('must-not-dispatch-after-whole-proof-acceptance'); },
    ]);
    let result: Awaited<Fixture['completion']>;
    if (entry === 'resume') {
      await expect(current.completion).rejects.toThrow('fixture pending whole-proof receipt EIO');
      expect(current.state.pendingProofCheck).toBeDefined();
      result = await resumeDeclarations(current, { maxTurns: 2, maxTotalTokens: 0 });
    } else result = await current.completion;
    expect(result?.check.passed).toBe(true);
    expect(current.state.check).toEqual(result?.check);
    expect(current.state.turns).toBe(1);
    expect(current.open).toHaveBeenCalledTimes(1); expect(current.messages).toHaveLength(1);
    expect(current.stops).toHaveBeenCalledTimes(1);
    expect(host.verify).toHaveBeenCalledTimes(entry === 'resume' ? 2 : 1);
    expect(host.verify.mock.calls.at(-1)?.[1]?.signal.aborted).toBe(true);
    expect(current.controller.signal.aborted).toBe(false);
    expect(current.events.filter(item => item.event === 'candidate_selected')).toHaveLength(1);
    expect(current.state.phase).toBe('running');
    expect(current.state.pendingResearchFreeze).toBeUndefined();
    expect(current.state.pendingProofCheck).toBeUndefined();
    expect(current.state.pendingDeclarationCheck).toBeUndefined();
    expect(current.savedStates.at(-1)).toMatchObject({ phase: 'running', check: { passed: true } });
    for (const pending of ['pendingResearchFreeze', 'pendingProofCheck', 'pendingDeclarationCheck'])
      expect(current.savedStates.at(-1)).not.toHaveProperty(pending);
  });

  it('requires an independent host check of all original targets and repairs its rejected candidate', async () => {
    host.verify.mockImplementationOnce(async request => failedBatch(verified(request), { stdoutPreview: () => 'host rejected first candidate' }));
    const current = fixture([
      f => { fs.writeFileSync(f.source, LOCAL_EXAMPLE_PROOF); },
      (f, _options, message) => {
        expect(f.state.check?.passed).toBe(false); expect(message).toContain('host rejected first candidate');
        expect(f.state.pendingProofCheck).toBeUndefined();
        fs.appendFileSync(f.source, '\n-- repaired using host feedback\n');
      },
    ]);
    const result = await current.completion;
    expect(result?.check.passed).toBe(true);
    expect(host.verify).toHaveBeenCalledTimes(2);
    for (const [request] of host.verify.mock.calls) expect(request.items.map((item: { theoremName: string }) => item.theoremName))
      .toEqual(current.problem.targets.map(target => target.theoremName));
    expect(current.stops).toHaveBeenCalledTimes(2);
    expect(current.events.filter(item => item.event === 'candidate_selected')).toHaveLength(1);
  });

  it('does not accept an incomplete batch receipt even when every returned result passes', async () => {
    host.verify.mockImplementationOnce(async request => verified({ ...request, items: request.items.slice(0, 1) }));
    const current = fixture([f => { fs.writeFileSync(f.source, LOCAL_EXAMPLE_PROOF); }]);
    expect(await current.completion).toBeUndefined();
    expect(host.verify).toHaveBeenCalledTimes(1);
    expect(current.state.check?.passed).toBe(false);
    expect(current.events.some(item => item.event === 'candidate_selected')).toBe(false);
  });

  it('rejects skill changes made by a worker and never dispatches another turn', async () => {
    const current = fixture([
      f => { fs.appendFileSync(path.join(path.dirname(f.skill.path), 'references/lean.md'), '\nAltered by the worker.\n'); },
      () => { throw new Error('must-not-dispatch-after-skill-change'); },
    ]);
    await expect(current.completion).rejects.toThrow('math_codex_skill_changed:theoremos-research');
    expect(current.open).toHaveBeenCalledTimes(1); expect(current.stops).toHaveBeenCalledTimes(1);
    expect(git(current.workspace, ['rev-parse', 'HEAD'])).toBe(current.problem.baseCommit);
    expect(host.verify).not.toHaveBeenCalled(); expect(host.declarations).not.toHaveBeenCalled();
  });
});
