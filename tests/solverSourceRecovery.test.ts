import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { readMathAgentSkill } from '../src/runtime/agentSkills';
import type { MathAgentOptions, MathAgentSession } from '../src/runtime/agentSession';
import { directSolverModules } from '../src/solver/modules';
import { committedSource, git, readSolverProblem } from '../src/solver/problem';
import { runResearchLead } from '../src/solver/research';
import { prepareResearchSkill, researchSkillIdentity } from '../src/solver/researchSkill';
import { solverState } from './helpers/solver';
import { temporaryDirectory } from './helpers/files';
import { receiptBatch } from './helpers/verifier';

const host = vi.hoisted(() => ({ verify: vi.fn() }));
vi.mock('../src/math/mathBuildManifest', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/mathBuildManifest')>(), readMathBuildManifest: vi.fn(),
}));
vi.mock('../src/math/verifier', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/verifier')>(),
  checkManyFormalVerifications: host.verify, formalVerificationToolIdentity: () => undefined,
  resolveMathematicsLakePackagesCache: () => undefined,
}));

describe('Lead correction after a deterministic saved-source rejection', () => {
  let root: string;
  beforeEach(() => {
    root = temporaryDirectory('solver-source-recovery-');
    host.verify.mockReset().mockImplementation(async request => receiptBatch(request, {
      sessionId: 'source-recovery-fixture', receiptId: (_, name) => `fixture-${request.targetCommit}-${name}`,
    }));
  });
  afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

  async function run(firstStatus: 'completed' | 'failed' | 'checkpoint' | 'interrupted', fatalFailure?: string) {
    const receipt = bootstrapLeanTask(path.join(root, 'workspace'), {
      source: 'theorem original : True := by sorry\n', task: 'Prove the fixed original target.',
    });
    const problem = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath), worktree = receipt.workspaceRoot;
    const source = path.join(worktree, problem.projectRelative, 'Submission.lean');
    const stray = path.join(worktree, problem.projectRelative, 'Submission.new');
    const draft = 'saved temporary draft; preserve these bytes\n';
    const state = solverState(problem, worktree, { runId: 'source-recovery', phase: 'prepared',
      model: 'offline-fixture', effort: 'high', researchMode: 'skill', researchSkillWorkflow: 'full',
      coordination: 'independent', workerCount: 1,
      researchSkill: researchSkillIdentity(readMathAgentSkill(path.resolve('skills/theoremos-research/SKILL.md'))) });
    const skill = prepareResearchSkill(process.cwd(), worktree, state.researchSkill!, problem);
    let turns = 0, lastError: string | undefined;
    const events: { event: string; details?: Record<string, unknown> }[] = [], messages: string[] = [];
    const open = vi.fn(async (options: MathAgentOptions): Promise<MathAgentSession> => ({
      threadId: options.threadId ?? 'source-repair-thread', get lastError() { return lastError; },
      close: async () => {}, interrupt: async () => {}, stopForFreeze: async () => ({ status: 'stopped' }),
      run: async (message, id, _workspace, started) => {
        turns++; messages.push(message); started(id);
        if (turns === 1) {
          fs.writeFileSync(source, 'theorem original : True := by trivial\n');
          fs.writeFileSync(stray, draft);
          lastError = fatalFailure;
          return firstStatus;
        }
        expect(message).toContain('math_source_outside_ownership');
        expect(message).toContain(JSON.stringify(path.join(problem.projectRelative, 'Submission.new')));
        expect(message).toContain('Move untracked advisory drafts or temporary outputs');
        expect(host.verify).not.toHaveBeenCalled();
        expect(git(worktree, ['rev-parse', 'HEAD'])).toBe(problem.baseCommit);
        expect(fs.readFileSync(stray, 'utf8')).toBe(draft);
        // Only the scripted agent corrects its own draft after receiving host feedback.
        fs.renameSync(stray, path.join(worktree, '.scratch', 'Submission.new'));
        lastError = undefined;
        return 'completed';
      },
    }));
    const pending = runResearchLead({ state, root: process.cwd(), buildFile: path.join(root, 'unused-build.json'),
      taskText: 'Prove the fixed original target.', executable: 'offline-fixture', profile: path.join(root, 'profile'),
      access: { environment: {}, retrievalRoot: worktree, researchSkill: skill },
      modules: { ...directSolverModules, M1: { ...directSolverModules.M1, open } },
      signal: new AbortController().signal, deadline: Infinity, maxTurns: 3, maxTurnMs: Infinity, maxTotalTokens: 0,
      save: () => {}, emit: (event, details) => { events.push({ event, details }); },
    });
    if (fatalFailure) {
      await expect(pending).rejects.toThrow(fatalFailure);
      expect(turns).toBe(1); expect(host.verify).not.toHaveBeenCalled();
      expect(fs.readFileSync(stray, 'utf8')).toBe(draft);
      expect(git(worktree, ['rev-parse', 'HEAD'])).toBe(problem.baseCommit);
      return;
    }
    const winner = await pending;
    if (firstStatus === 'interrupted') {
      expect(turns).toBe(1); expect(winner).toBeUndefined(); expect(host.verify).not.toHaveBeenCalled();
      expect(fs.readFileSync(stray, 'utf8')).toBe(draft);
      expect(git(worktree, ['rev-parse', 'HEAD'])).toBe(problem.baseCommit);
      return;
    }
    expect(turns).toBe(2); expect(messages).toHaveLength(2);
    expect(open.mock.calls[1]![0].threadId).toBe('source-repair-thread');
    expect(events.filter(item => item.event === 'source_rejected')).toMatchObject([{ details: {
      reason: expect.stringContaining(JSON.stringify(path.join(problem.projectRelative, 'Submission.new'))),
    } }]);
    expect(events.some(item => item.event === 'worker_failed')).toBe(false);
    expect(winner?.check.passed).toBe(true); expect(host.verify).toHaveBeenCalledOnce();
    expect(committedSource(worktree, winner!.check.commit, path.join(problem.projectRelative, 'Submission.lean')))
      .toBe('theorem original : True := by trivial\n');
    expect(git(worktree, ['ls-tree', '-r', '--name-only', winner!.check.commit])).not.toContain('Submission.new');
    expect(fs.readFileSync(path.join(worktree, '.scratch', 'Submission.new'), 'utf8')).toBe(draft);
  }

  it.each(['completed', 'failed', 'checkpoint'] as const)('gives a %s turn precise feedback and lets the next Lead turn correct the path before verification', async status => {
    await run(status);
  });

  it('keeps a native environment failure fatal even when a saved draft also violates ownership', async () => {
    await run('failed', 'math_lean_environment_unavailable');
  });

  it('does not restart an unmarked interrupted turn', async () => {
    await run('interrupted');
  });
});
