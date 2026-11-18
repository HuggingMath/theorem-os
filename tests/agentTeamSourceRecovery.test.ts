import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { readMathAgentSkill } from '../src/runtime/agentSkills';
import type { MathAgentOptions, MathAgentSession } from '../src/runtime/agentSession';
import { readSolverRunState, writeSolverRunState, type SolverRunState } from '../src/solver/archive';
import { AgentResearchTeam } from '../src/solver/agentTeam';
import { readAgentTeamProofDelivery } from '../src/solver/agentTeamProof';
import { directSolverModules } from '../src/solver/modules';
import { git, readSolverProblem } from '../src/solver/problem';
import { prepareResearchSkill, researchSkillIdentity } from '../src/solver/researchSkill';
import { deferred } from './helpers/async';
import { temporaryDirectory } from './helpers/files';
import { solverState } from './helpers/solver';

vi.mock('../src/math/mathBuildManifest', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/mathBuildManifest')>(), readMathBuildManifest: vi.fn(),
}));

const original = 'namespace Recovery\ntheorem goal : True := by sorry\nend Recovery\n';
const helper = 'theorem helper : True := by trivial\n';
const declarations = [{ file: 'Submission.lean', name: 'Recovery.helper', type: 'True' }];
const fixtures: ReturnType<typeof fixture>[] = [];

function fixture(maxAgents = 2) {
  const directory = temporaryDirectory('agent-team-source-recovery-');
  const receipt = bootstrapLeanTask(path.join(directory, 'primary'), { source: original, task: 'Prove True.' });
  const problem = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath), root = path.resolve('.');
  const identity = researchSkillIdentity(readMathAgentSkill(path.join(root, 'skills/theoremos-research/SKILL.md')));
  const state = solverState(problem, receipt.workspaceRoot, { runId: 'agent-team-source-recovery', phase: 'running',
    environmentDigest: mathDigest('real Lean True recovery fixture'), researchMode: 'skill', researchSkillWorkflow: 'full',
    researchSkill: identity, researchDelegation: { mode: 'team', maxAgents }, workerCount: 1, coordination: 'independent' });
  const skill = prepareResearchSkill(root, state.worktree, identity, problem);
  const toolchain = path.join(os.homedir(), '.elan/toolchains/leanprover--lean4---v4.33.0');
  if (!fs.existsSync(path.join(toolchain, 'bin/lean'))) throw new Error('Real Lean 4.33.0 is required.');
  const environment = { PATH: `${toolchain}/bin:${path.dirname(process.execPath)}:/usr/bin:/bin`,
    ELAN_HOME: path.join(os.homedir(), '.elan'), LEAN_PATH: '', LEAN_SYSROOT: '',
    DEEPSCIENTIST_MATH_SANDBOX_BACKEND: 'bwrap', DEEPSCIENTIST_MATH_ENV_FILE: path.join(directory, 'missing.env') };
  const controller = new AbortController(), teams: AgentResearchTeam[] = [];
  const sessions: { options: MathAgentOptions; message: string; complete: () => void }[] = [];
  const events: { event: string; details?: Record<string, unknown> }[] = [];
  const stateFile = path.join(directory, 'run-state.json');
  const makeTeam = (current: SolverRunState) => {
    const team = new AgentResearchTeam({ state: current, root, taskText: 'Prove True.',
      leadAccess: { environment, retrievalRoot: path.join(current.worktree, problem.projectRelative), researchSkill: skill },
      modules: { ...directSolverModules, M1: { ...directSolverModules.M1, open: async options => {
        const outcome = deferred<string>(), record = { options, message: '', complete: () => outcome.resolve('completed') };
        sessions.push(record);
        const session: MathAgentSession = { threadId: options.threadId ?? 'source-recovery-member',
          usageSource: 'upstream-requests',
          run: async (message, _id, _workspace, started) => {
            record.message = message; started('source-recovery-turn-' + sessions.length); return outcome.promise;
          },
          notify: async () => {}, interrupt: async () => { outcome.resolve('interrupted'); },
          stopForFreeze: async () => ({ status: 'stopped' }), close: async () => {},
        };
        return session;
      } } },
      executable: 'offline-no-model', profile: 'offline-no-credentials', signal: controller.signal,
      maxAgents, maxTurns: Infinity, maxTurnMs: Infinity, maxTotalTokens: 0, remainingMs: () => Infinity,
      save: () => writeSolverRunState(stateFile, current), emit: (event, details) => { events.push({ event, details }); },
      exclusiveCheck: operation => operation(),
    });
    teams.push(team); return team;
  };
  const team = makeTeam(state); let calls = 0;
  const call = (operation: Record<string, unknown>, actor = 'lead', target = team) => target.tools(actor).call('theoremos_team', operation,
    { callId: 'source-recovery-call-' + ++calls, turnId: 'source-recovery-turn', threadId: 'source-recovery-thread', signal: controller.signal }) as Promise<any>;
  const current = { directory, state, stateFile, controller, sessions, teams, team, makeTeam, call, events, problem,
    source: (worktree: string) => path.join(worktree, problem.projectRelative, 'Submission.lean'),
    session: async (index: number) => {
      await expect.poll(() => sessions[index]?.message, { timeout: 10_000 }).toBeTruthy(); return sessions[index]!;
    },
  };
  fixtures.push(current); return current;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    f.controller.abort(); for (const session of f.sessions) session.complete();
    await Promise.allSettled(f.teams.map(team => team.close()));
    fs.rmSync(f.directory, { recursive: true, force: true });
  }
});
async function idle(team: AgentResearchTeam) {
  await expect.poll(() => team.hasActiveWorkers, { timeout: 30_000 }).toBe(false);
}

describe('recoverable team source rejections', () => {
  it('preserves the rejected Lean interface and check receipt for the producer, a repair peer and restored history', async () => {
    const f = fixture(3); await f.call({ operation: 'spawn', agentId: 'member', message: 'Prove the helper.' });
    const first = await f.session(0), worker = f.team.archive.workers[0]!;
    fs.writeFileSync(f.source(worker.worktree), original.replace('end Recovery', helper + 'end Recovery'));
    const wrong = [{ ...declarations[0]!, type: 'False' }];
    await f.call({ operation: 'submit', summary: 'Check this interface.', declarations: wrong }, 'member');
    first.complete(); await idle(f.team);
    const task = worker.tasks[0]!, locator = { operation: 'history', agentId: worker.id, offset: 0, limit: 1 };
    const failure = task.failedCheck!;
    expect(task.status).toBe('failed');
    expect(failure).toMatchObject({ declaration: wrong[0], commit: git(worker.worktree, ['rev-parse', 'HEAD']),
      seedCommit: f.problem.baseCommit, objectiveRevision: 1, environmentDigest: f.state.environmentDigest,
      problemReceiptDigest: f.problem.receiptDigest, sourceDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      projectionCommit: expect.stringMatching(/^[a-f0-9]{40,64}$/),
      results: [expect.objectContaining({ receiptId: expect.any(String), checkId: expect.any(String) })] });
    expect(f.team.archive.events.find(event => event.kind === 'failed')?.text).toContain(JSON.stringify(locator));
    expect(f.team.archive.deliveries).toHaveLength(0);
    expect(readSolverRunState(f.stateFile).agentTeam!.workers[0]!.tasks[0]!.failedCheck).toEqual(failure);
    await f.call({ operation: 'assign', agentId: 'member', message: 'Repair the rejected declaration.' });
    const next = await f.session(1);
    expect(next.message).toContain('failedCheck');
    expect((await f.call(locator, 'member')).tasks[0]?.failedCheck).toEqual(failure);
    await f.call({ operation: 'spawn', agentId: 'repair', message: 'Read the earlier failed interface: ' + JSON.stringify(locator) });
    await f.session(2);
    expect((await f.call(locator, 'repair')).tasks[0]?.failedCheck).toEqual(failure);
    expect(f.state.check).toBeUndefined();
  }, 60_000);

  it('rejects a non-owned declaration file before nomination, and accepts a corrected submission on the same turn', async () => {
    const f = fixture(); await f.call({ operation: 'spawn', agentId: 'member', message: 'Prove the helper.' });
    const session = await f.session(0), worker = f.team.archive.workers[0]!;
    expect(await f.call({ operation: 'submit', summary: 'Helper ready.', declarations: [
      { ...declarations[0], file: `${f.problem.projectRelative}/Submission.lean` }] }, 'member')).toMatchObject({
      ok: false, error: 'math_agent_team_proof_declaration_outside_ownership',
      rejectedFiles: [`${f.problem.projectRelative}/Submission.lean`], ownedFiles: ['Submission.lean'],
      hint: expect.stringContaining('relative to the Lean project'),
    });
    expect(worker.tasks[0]!.declarations).toBeUndefined(); expect(worker.pendingDelivery).toBeUndefined();
    expect(session.options.requestGate!.checkpoint!()).toBe(false);
    fs.writeFileSync(f.source(worker.worktree), original.replace('end Recovery', helper + 'end Recovery'));
    expect(await f.call({ operation: 'submit', summary: 'Corrected relative path.', declarations }, 'member'))
      .toMatchObject({ ok: true, status: 'pending-writer-stop' });
    session.complete(); await idle(f.team);
    expect(f.team.archive.deliveries).toHaveLength(1); expect(worker.pendingDelivery).toBeUndefined();
    expect(f.state.check).toBeUndefined();
  }, 60_000);

  it.each(['outside-ownership', 'original-declaration'] as const)(
    'preserves a %s draft and notes, then permits an explicit same-member correction', async kind => {
      const f = fixture(); await f.call({ operation: 'spawn', agentId: 'member', message: 'Prove the helper.' });
      const first = await f.session(0), worker = f.team.archive.workers[0]!, file = f.source(worker.worktree);
      const valid = original.replace('end Recovery', helper + 'end Recovery');
      const invalid = kind === 'original-declaration' ? valid.replace('goal : True', 'goal : False') : valid;
      fs.writeFileSync(file, invalid); fs.writeFileSync(path.join(worker.worktree, 'RESEARCH.md'), 'Keep this unfinished investigation.\n');
      if (kind === 'outside-ownership') {
        fs.writeFileSync(path.join(worker.worktree, 'Sketch.lean'), 'theorem exploratory : True := by trivial\n');
        git(worker.worktree, ['add', 'Sketch.lean']);
      }
      expect(await f.call({ operation: 'submit', summary: 'Nominate helper.', declarations }, 'member')).toMatchObject({ ok: true });
      first.complete(); await idle(f.team);
      const rejected = worker.tasks[0]!;
      expect(worker).toMatchObject({ status: 'idle', activity: 'idle', phase: 'prepared' });
      expect(worker.pendingDelivery).toBeUndefined(); expect(rejected.status).toBe('failed');
      expect(rejected.error).toContain(kind === 'outside-ownership' ? 'Sketch.lean' : 'math_original_declaration_changed');
      expect(rejected.sourceCommit).toBeUndefined(); expect(rejected.researchArtifactId).toBeUndefined();
      expect(f.team.archive.researchArtifacts ?? []).toHaveLength(0); expect(f.team.archive.deliveries).toHaveLength(0);
      expect(fs.readFileSync(file, 'utf8')).toBe(invalid);
      expect(fs.readFileSync(path.join(worker.worktree, 'RESEARCH.md'), 'utf8')).toBe('Keep this unfinished investigation.\n');
      expect(git(worker.worktree, ['rev-parse', 'HEAD'])).toBe(f.problem.baseCommit);
      if (kind === 'outside-ownership') expect(git(worker.worktree, ['diff', '--cached', '--name-only'])).toBe('Sketch.lean');
      expect(f.team.archive.events.some(event => event.kind === 'failed' && event.text.includes('Lead can assign a correction'))).toBe(true);
      await f.call({ operation: 'assign', agentId: 'member', message: 'Correct the rejected source and resubmit the helper.' });
      const correction = await f.session(1);
      expect(correction.options.threadId).toBe('source-recovery-member');
      expect(correction.message).toContain('Host rejected the edited source');
      expect(correction.message).toContain(kind === 'outside-ownership' ? 'Sketch.lean' : 'math_original_declaration_changed');
      expect(fs.readFileSync(file, 'utf8')).toBe(invalid);
      if (kind === 'outside-ownership') {
        git(worker.worktree, ['reset', 'HEAD', '--', 'Sketch.lean']);
        fs.renameSync(path.join(worker.worktree, 'Sketch.lean'), path.join(worker.worktree, '.scratch', 'Sketch.lean'));
      }
      fs.writeFileSync(file, valid);
      expect(await f.call({ operation: 'submit', summary: 'Source corrected; helper ready.', declarations }, 'member')).toMatchObject({ ok: true });
      correction.complete(); await idle(f.team);
      expect(f.team.archive.deliveries).toHaveLength(1); expect(worker.tasks[1]!.deliveryId).toBeDefined();
      expect(worker.tasks[1]!.researchArtifactId).toBeDefined(); expect(worker.pendingDelivery).toBeUndefined();
      expect(rejected.status).toBe('failed'); expect(f.state.check).toBeUndefined();
    }, 60_000);

  it('clears a restored stopped-writer nomination without rewriting its invalid source or fabricating an artifact', async () => {
    const f = fixture(); await f.call({ operation: 'spawn', agentId: 'member', message: 'Prove the helper.' });
    const first = await f.session(0), worker = f.team.archive.workers[0]!;
    first.complete(); await idle(f.team); await f.team.close();
    fs.writeFileSync(f.source(worker.worktree), original.replace('goal : True', 'goal : False'));
    fs.writeFileSync(path.join(worker.worktree, 'RESEARCH.md'), 'Notes saved before the previous process stopped.\n');
    const saved = readSolverRunState(f.stateFile), recoveredWorker = saved.agentTeam!.workers[0]!, task = recoveredWorker.tasks[0]!;
    recoveredWorker.status = 'failed'; recoveredWorker.activity = 'checking'; recoveredWorker.phase = 'checking';
    recoveredWorker.pendingSourceBase = f.problem.baseCommit;
    recoveredWorker.pendingDelivery = { taskId: task.id, seedCommit: f.problem.baseCommit, declarations };
    task.declarations = declarations; const artifactCount = saved.agentTeam!.researchArtifacts?.length ?? 0;
    const restored = f.makeTeam(saved); await restored.restore();
    expect(recoveredWorker).toMatchObject({ status: 'idle', activity: 'idle', phase: 'prepared' });
    expect(recoveredWorker.pendingDelivery).toBeUndefined(); expect(task.status).toBe('failed');
    expect(saved.agentTeam!.researchArtifacts ?? []).toHaveLength(artifactCount); expect(saved.agentTeam!.deliveries).toHaveLength(0);
    expect(fs.readFileSync(f.source(recoveredWorker.worktree), 'utf8')).toContain('goal : False');
    expect(fs.readFileSync(path.join(recoveredWorker.worktree, 'RESEARCH.md'), 'utf8')).toContain('previous process stopped');
    await f.call({ operation: 'assign', agentId: 'member', message: 'Repair the statement and prove the helper.' }, 'lead', restored);
    const correction = await f.session(1); expect(correction.message).toContain('math_original_declaration_changed');
    fs.writeFileSync(f.source(recoveredWorker.worktree), original.replace('end Recovery', helper + 'end Recovery'));
    expect(await f.call({ operation: 'submit', summary: 'Recovered and repaired.', declarations }, 'member', restored)).toMatchObject({ ok: true });
    correction.complete(); await idle(restored);
    expect(saved.agentTeam!.deliveries).toHaveLength(1); expect(saved.check).toBeUndefined();
  }, 60_000);

  it('retains a nomination on an unrelated infrastructure failure', async () => {
    const f = fixture(); await f.call({ operation: 'spawn', agentId: 'member', message: 'Prove the helper.' });
    const first = await f.session(0), worker = f.team.archive.workers[0]!;
    fs.writeFileSync(f.source(worker.worktree), original.replace('end Recovery', helper + 'end Recovery'));
    expect(await f.call({ operation: 'submit', summary: 'Helper ready.', declarations }, 'member')).toMatchObject({ ok: true });
    const read = fs.readFileSync.bind(fs);
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] === f.source(worker.worktree)) throw Object.assign(new Error('fixture-source-EIO'), { code: 'EIO' });
      return read(...args);
    });
    first.complete(); await idle(f.team); spy.mockRestore();
    expect(worker.status).toBe('failed'); expect(worker.error).toBe('fixture-source-EIO');
    expect(worker.pendingDelivery).toBeDefined(); expect(f.team.archive.deliveries).toHaveLength(0);
  });

  it('resumes the exact acknowledged nomination after writer loss but honors an explicit cancellation', async () => {
    const f = fixture(); await f.call({ operation: 'spawn', agentId: 'member', message: 'Investigate.' });
    await f.session(0);
    const worker = f.team.archive.workers[0]!, task = worker.tasks[0]!;
    const message = 'Prove the helper.';
    expect(await f.call({ operation: 'amend', agentId: worker.id, taskId: task.id, message,
      workKind: 'proof', reason: 'The interface is ready.' })).toMatchObject({ ok: true });
    fs.writeFileSync(f.source(worker.worktree), original.replace('end Recovery', helper + 'end Recovery'));
    const reply = await f.call({ operation: 'submit', summary: 'Ready to check.', objectiveRevision: 2, declarations }, 'member');
    expect(reply).toMatchObject({ status: 'pending-writer-stop' });
    const beforeCancel = readSolverRunState(f.stateFile);
    expect(await f.call({ operation: 'cancel', agentId: worker.id, taskId: task.id })).toMatchObject({ ok: true });
    await idle(f.team);
    expect(f.team.archive.deliveries).toHaveLength(0);
    const cancelled = f.makeTeam(readSolverRunState(f.stateFile));
    await cancelled.restore();
    expect(cancelled.archive.deliveries).toHaveLength(0);
    // Legacy shutdown saved source and status but did not register the acknowledged submission.
    const legacy = readSolverRunState(f.stateFile);
    const old = legacy.agentTeam!.workers[0]!.tasks[0]!;
    old.status = 'interrupted'; delete old.cancelRequested; delete old.nomination;
    const sourceFile = f.source(worker.worktree), fixed = fs.readFileSync(sourceFile, 'utf8');
    fs.writeFileSync(sourceFile, fixed + '\n-- newer draft\n');
    const dirty = f.makeTeam(structuredClone(legacy)); await dirty.restore();
    expect(dirty.archive.deliveries).toHaveLength(0);
    fs.writeFileSync(sourceFile, fixed);
    const exact = f.makeTeam(legacy); await exact.restore();
    expect(exact.archive.deliveries).toHaveLength(1);
    // It has amended history, but no evidence of which revision nominated it.
    expect(readAgentTeamProofDelivery(exact.archive.deliveries[0]!.path, legacy).provenance).not.toHaveProperty('objectiveRevision');
    const recovered = f.makeTeam(beforeCancel);
    await recovered.restore();
    expect(recovered.archive.workers[0]!.tasks[0]!.status).toBe('interrupted');
    expect(recovered.archive.deliveries).toHaveLength(1);
    expect(readAgentTeamProofDelivery(recovered.archive.deliveries[0]!.path, beforeCancel).provenance)
      .toMatchObject({ taskId: task.id, objectiveRevision: 2, objectiveDigest: mathDigest(message), workKind: 'proof' });
    expect(f.sessions).toHaveLength(1);
  }, 60_000);
});
