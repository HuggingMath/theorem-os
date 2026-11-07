import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queueResearchObservation } from '../src/solver/researchObservation';
import { researchPublicationNotes } from '../src/solver/researchPublication';
import { parseMathResponse } from '../src/solver/deliveries';
import { assignmentDeliveryFile, parseCooperationPlan } from '../src/solver/tasks';
import { committedSource } from '../src/solver/problem';
import { readSolverRunState, writeSolverRunState } from '../src/solver/archive';
import { cooperativeResearch } from './helpers/cooperation';
import { leadWorker, localExample, peerWorker, solverState } from './helpers/solver';

const host = vi.hoisted(() => ({ createSession: vi.fn() }));
vi.mock('../src/runtime/codexSession', () => ({ createCodexMathSession: host.createSession }));
const instances: { stop: () => Promise<void>; directory: string }[] = [];
afterEach(async () => {
  for (const item of instances.splice(0)) { await item.stop(); fs.rmSync(item.directory, { recursive: true, force: true }); }
  expect(host.createSession).not.toHaveBeenCalled();
});

async function fixture() {
  const example = localExample('research-observation-'), lead = leadWorker(example.problem, example.workspace), peer = peerWorker(example, 'peer');
  const plan = parseCooperationPlan(example.problem, { tasks: [
    ...example.problem.targets.map((target, index) => ({ ...target, id: `goal_${index}`, kind: 'goal', objective: 'Prove the original target.', status: 'paused' })),
    { id: 'investigate', kind: 'research', objective: 'Check a concrete construction.', ownerId: peer.id },
  ] });
  const state = solverState(example.problem, example.workspace, { runId: 'observation-fixture', phase: 'running',
    cooperation: { canonicalCommit: example.problem.baseCommit, tasks: plan.tasks.map(task => ({ task, status: 'pending', attempts: 0 })),
      groups: plan.groups.map(group => ({ group, turns: 0 })) } });
  const controller = new AbortController();
  const cooperative = cooperativeResearch({ state, workers: [lead, peer], retrievalRoot: example.directory, signal: controller.signal });
  instances.push({ directory: example.directory, stop: async () => { controller.abort(); await cooperative.stop(); } });
  const action = await cooperative.next(peer, { maxTurns: Infinity, remainingMs: Infinity });
  if (action?.kind !== 'task') throw new Error('missing observation assignment');
  expect(action.task.id).toBe('investigate');
  expect(cooperative.started(peer, action)).toBe(true);
  cooperative.activate(peer, action, async () => {}, async () => {});
  await cooperative.pulse(peer.id);
  return { ...example, state, peer, cooperative, action, log: path.join(peer.worktree, assignmentDeliveryFile(action.assignment)) };
}

describe('immediate advisory observation publication', () => {
  it('retains a deleted scratch probe through actual host intake and checkpoint reload without accepting a proof', async () => {
    const f = await fixture(), probe = path.join(f.peer.worktree, '.scratch', 'probe.lean');
    fs.mkdirSync(path.dirname(probe), { recursive: true });
    const code = 'namespace ObservationProbe\nlemma identity (n : Nat) : n = n := by rfl\nend ObservationProbe';
    fs.writeFileSync(probe, code);
    const result = queueResearchObservation({ worktree: f.peer.worktree, finding: {
      summary: 'The identity check is retained; the original construction remains open.',
      leanChecks: [{ status: 'passed', path: 'RESEARCH.md', declarations: ['ObservationProbe.identity'] }],
    }, probes: [probe] });
    expect(result).toMatchObject({ status: 'queued', authority: 'advisory-unverified', retainedProbes: 1 });
    fs.rmSync(probe);
    await f.cooperative.pulse(f.peer.id);
    const records = f.state.cooperation!.deliveries!.filter(record => record.submissionId === result.submissionId);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: 'research', status: 'advisory', taskId: 'investigate',
      artifacts: { scope: 'advisory-unverified', artifacts: [{ kind: 'notes-lean', declarations: [{ name: 'ObservationProbe.identity' }] }] } });
    expect(committedSource(f.peer.worktree, records[0]!.commit!, 'RESEARCH.md')).toContain(code);
    expect(f.state.cooperation!.tasks.some(node => node.proof || node.integratedCheck)).toBe(false);
    const checkpoint = path.join(f.directory, 'state.json');
    writeSolverRunState(checkpoint, f.state);
    expect(readSolverRunState(checkpoint).cooperation!.deliveries!.find(record => record.id === records[0]!.id)?.artifacts)
      .toEqual(records[0]!.artifacts);
  });

  it('reports an invalid field before appending and permits a corrected submission', async () => {
    const f = await fixture(), before = fs.existsSync(f.log) ? fs.readFileSync(f.log, 'utf8') : '';
    expect(() => queueResearchObservation({ worktree: f.peer.worktree,
      finding: { summary: 'One missing premise.', remainingObligations: 'the bound' } }))
      .toThrow('math_delivery_invalid');
    expect(fs.existsSync(f.log) ? fs.readFileSync(f.log, 'utf8') : '').toBe(before);
    queueResearchObservation({ worktree: f.peer.worktree,
      finding: { summary: 'One missing premise.', remainingObligations: ['the bound'] } });
    await f.cooperative.pulse(f.peer.id);
    expect(f.state.cooperation!.deliveries!.at(-1)?.remainingObligations).toEqual(['the bound']);
  });

  it('uses the existing host identity to deduplicate a repeated observation', async () => {
    const f = await fixture(), input = { worktree: f.peer.worktree, finding: { summary: 'A scoped negative search.' } };
    const first = queueResearchObservation(input), second = queueResearchObservation(input);
    expect(second.submissionId).toBe(first.submissionId);
    await f.cooperative.pulse(f.peer.id);
    expect(f.state.cooperation!.deliveries!.filter(record => record.submissionId === first.submissionId)).toHaveLength(1);
  });

  it('freezes explicit source bytes at publication before the writer changes them', async () => {
    const f = await fixture(), file = path.join(f.peer.worktree, f.problem.projectRelative, f.problem.ownedFiles.find(file => file.endsWith('.lean'))!);
    const saved = fs.readFileSync(file, 'utf8');
    queueResearchObservation({ worktree: f.peer.worktree, finding: { summary: 'This observation concerns the current saved sources.' }, snapshotSources: true });
    const event = JSON.parse(fs.readFileSync(f.log, 'utf8').trim());
    fs.writeFileSync(file, saved + '\n-- later edit\n');
    expect(Object.values(event.sources)).toContain(saved);
    expect(Object.values(event.sources)).not.toContain(saved + '\n-- later edit\n');
  });

  it('keeps a single parseable result with probe artifacts and rejects ambiguous fences', () => {
    const finding = { taskId: 'a', taskDigest: 'd', conclusion: 'inconclusive' as const, summary: 'Partial check.' };
    const notes = researchPublicationNotes(finding, [{ source: 'probe.lean', code: 'lemma p : True := by trivial' }]);
    expect(parseMathResponse(notes, 'math-result')).toEqual(finding);
    expect(() => researchPublicationNotes(finding, [{ source: 'probe.lean', code: '```math-result\n{}\n```' }]))
      .toThrow('math_research_delivery_invalid');
  });
});
