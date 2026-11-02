import { describe, expect, it } from 'vitest';
import { buildResearchRoadmap, type ResearchRoadmapInput } from '../apps/web/client/researchRoadmap';
import { buildTrajectory, emptyTrajectory, mergeTrajectory, trajectoryTaskNames, type TrajectoryData, type TrajectoryStep } from '../apps/web/client/trajectory';
import type { WebEvent, WebEventDetails, WebRunStatus } from '../apps/web/shared';
import { recordedTrajectory, trajectoryPage, type TrajectoryGuidance, type TrajectoryPlan, type TrajectoryPlanItem } from '../apps/web/trajectory';
import { loadWebSample, type WebSampleFile } from '../apps/web/sample';
import { withFailedAttempt } from '../scripts/web-trajectory-fixture';

const epoch = Date.UTC(2026, 9, 1);
const stamp = (seconds: number) => epoch + seconds * 1_000;
const event = (sequence: number, type: string, details?: WebEventDetails): WebEvent => ({ sequence, at: new Date(stamp(sequence)).toISOString(), type, message: '', details });
const item = (id: string, dependsOn: string[] = []): TrajectoryPlanItem => ({ id, kind: 'goal', name: `Test.${id}`, objective: id, dependsOn, status: 'active' });
const plan = (observation: number, added: TrajectoryPlanItem[], changed: TrajectoryPlan['changed'] = [], removed: TrajectoryPlanItem[] = []): TrajectoryPlan =>
  ({ observation, at: stamp(observation), added, changed, removed, omitted: 0, revision: observation });
const attempt = (taskId: string, number: number, outcome: 'passed' | 'failed' | 'conditional', time: number): TrajectoryStep =>
  ({ kind: 'attempt', taskId, workerId: 'engineer', number, outcome, at: stamp(time), integrated: false, reused: false });
const guidance = (id: string, status: TrajectoryGuidance['status'], recipient: TrajectoryGuidance['recipient'], deliveredTo?: string[]): TrajectoryGuidance =>
  ({ id, status, recipient, deliveredTo, text: 'Expand the square.', createdAt: new Date(stamp(2)).toISOString(), updatedAt: new Date(stamp(5)).toISOString(), revision: 1 });
function project(data: TrajectoryData, status: WebRunStatus = 'completed', explicitSteps?: readonly TrajectoryStep[],
  taskDetails?: ResearchRoadmapInput['taskDetails'], originalSource?: string) {
  const steps = explicitSteps ?? buildTrajectory({ data, status, createdAt: new Date(epoch).toISOString(), finishedAt: new Date(stamp(30)).toISOString() });
  return { roadmap: buildResearchRoadmap({ data, steps, status, tasks: trajectoryTaskNames(data), taskDetails, originalSource }), steps };
}
function sampleProject(file: WebSampleFile = loadWebSample()!) {
  const data = mergeTrajectory(emptyTrajectory(), trajectoryPage(recordedTrajectory(file.events, file.observations), { after: 0, since: 0 }));
  const steps = buildTrajectory({ data, status: file.run.status, createdAt: file.run.createdAt, finishedAt: file.run.finishedAt });
  return { data, steps, roadmap: buildResearchRoadmap({ data, steps, status: file.run.status, tasks: trajectoryTaskNames(data) }) };
}

describe('research roadmap', () => {
  it('projects the sample as assignments, the current planned dependency, integration, review and independent acceptance', () => {
    const { roadmap, steps } = sampleProject();
    expect(roadmap.nodes.find(node => node.id === 'task:goal_1')).toMatchObject({ title: 'add_zero', status: 'passed', workerId: 'engineer' });
    expect(roadmap.nodes.find(node => node.id === 'task:goal_2')).toMatchObject({ title: 'zero_add', status: 'passed', workerId: 'engineer' });
    expect(roadmap.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: 'plan', to: 'task:goal_1', kind: 'assignment', active: true }),
      expect.objectContaining({ from: 'task:goal_1', to: 'task:goal_2', kind: 'dependency' }),
      expect.objectContaining({ from: 'task:goal_2', to: 'proof', kind: 'integration', active: true }),
    ]));
    expect(roadmap.nodes.find(node => node.id === 'review:researcher-1')).toMatchObject({ kind: 'review', workerId: 'researcher-1', status: 'passed', detail: 'Researcher → Reviewer' });
    expect(roadmap.nodes.find(node => node.id === 'evaluation')).toMatchObject({ status: 'passed' });
    expect(roadmap.nodes.every(node => node.stepIndexes.every(index => index >= 0 && index < steps.length))).toBe(true);
    expect(roadmap.edges.every(edge => roadmap.nodes.some(node => node.id === edge.from) && roadmap.nodes.some(node => node.id === edge.to))).toBe(true);
    expect(new Set(roadmap.edges.map(edge => edge.id)).size).toBe(roadmap.edges.length);
    expect(roadmap.partial).toBe(false);
  });

  it('reconstructs pending tasks and current dependencies across plan changes without inventing dependencies from Agent order', () => {
    const data = emptyTrajectory(), a = item('a'), b = item('b'), old = item('old');
    data.plans.set(2, plan(2, [item('pending')], [{ before: b, after: item('b', ['a']) }], [old]));
    data.plans.set(1, plan(1, [a, b, old]));
    data.events = [event(3, 'task_assigned', { taskId: 'a', workerId: 'engineer' }), event(4, 'task_assigned', { taskId: 'b', workerId: 'engineer' })];
    const { roadmap } = project(data);
    expect(roadmap.nodes.filter(node => node.kind === 'task').map(node => node.taskId)).toEqual(['a', 'b', 'pending']);
    expect(roadmap.nodes.find(node => node.taskId === 'pending')).toMatchObject({ status: 'pending', attempts: [] });
    expect(roadmap.nodes.find(node => node.taskId === 'pending')?.stepIndexes.length).toBeGreaterThan(0);
    expect(roadmap.edges.filter(edge => edge.kind === 'dependency')).toEqual([expect.objectContaining({ from: 'task:a', to: 'task:b' })]);
    data.plans.set(3, plan(3, [], [{ before: item('b', ['a']), after: b }]));
    expect(project(data).roadmap.edges.filter(edge => edge.kind === 'dependency')).toEqual([]);
  });

  it('shows recorded goal and auxiliary lemma mathematics from the latest task observation without inventing a dependency', () => {
    const data = emptyTrajectory();
    data.plans.set(1, plan(1, [item('goal'), item('helper')]));
    const taskDetails: NonNullable<ResearchRoadmapInput['taskDetails']> = [
      { id: 'goal', kind: 'goal', theorem: 'Inequality.sq_le_sq_add', type: '(a b : ℤ) : a * a ≤ (a + b) * (a + b) + b * b',
        informalStatement: 'The first square is bounded by the sum of the other squares.', objective: 'Prove the frozen inequality.' },
      { id: 'helper', kind: 'lemma', theorem: 'Inequality.sq_add', type: '(a b : ℤ) :\n  (a + b) * (a + b) = a * a + 2 * a * b + b * b',
        informalStatement: 'Expand the square of a sum.', objective: 'Establish the expansion identity for integer inputs.' },
    ];
    const { roadmap } = project(data, 'running', undefined, taskDetails);
    expect(roadmap.nodes.find(node => node.id === 'task:goal')).toMatchObject({ taskKind: 'goal', theoremName: 'Inequality.sq_le_sq_add',
      statement: taskDetails[0]!.informalStatement, type: taskDetails[0]!.type, objective: taskDetails[0]!.objective });
    expect(roadmap.nodes.find(node => node.id === 'task:helper')).toMatchObject({ taskKind: 'lemma', theoremName: 'Inequality.sq_add',
      statement: taskDetails[1]!.informalStatement, type: taskDetails[1]!.type, objective: taskDetails[1]!.objective });
    expect(roadmap.edges.filter(edge => edge.kind === 'dependency')).toEqual([]);
  });

  it('falls back only to current plan fields and keeps missing statements unknown, including historical and newly observed tasks', () => {
    const data = emptyTrajectory(), original = item('old');
    const current = { ...item('current'), kind: 'lemma' as const, name: 'Namespace.full_lemma_name', objective: 'Prove the documented auxiliary identity.' };
    data.plans.set(1, plan(1, [original, current]));
    data.plans.set(2, plan(2, [], [], [original]));
    const taskDetails: NonNullable<ResearchRoadmapInput['taskDetails']> = [
      { id: 'newly-observed', kind: 'sketch', objective: 'Look for another argument.' },
      { id: 'new-goal', kind: 'goal', theorem: 'Tutorial.new_goal', objective: 'Prove the newly observed goal.' },
    ];
    const { roadmap } = project(data, 'running', [attempt('old', 1, 'passed', 1)], taskDetails);
    const lemma = roadmap.nodes.find(node => node.id === 'task:current')!;
    expect(lemma).toMatchObject({ taskKind: 'lemma', theoremName: current.name, objective: current.objective });
    expect(lemma.statement).toBeUndefined(); expect(lemma.type).toBeUndefined();
    const historical = roadmap.nodes.find(node => node.id === 'task:old')!;
    expect(historical.taskKind).toBeUndefined(); expect(historical.theoremName).toBeUndefined();
    expect(historical.statement).toBeUndefined(); expect(historical.type).toBeUndefined(); expect(historical.objective).toBeUndefined();
    expect(roadmap.nodes.find(node => node.id === 'task:newly-observed')).toMatchObject({ taskKind: 'sketch', objective: 'Look for another argument.', status: 'pending' });
    expect(roadmap.nodes.find(node => node.id === 'task:new-goal')).toMatchObject({ title: 'new_goal', theoremName: 'Tutorial.new_goal' });
  });

  it('reads a uniquely named original goal signature from the frozen source while recorded types remain authoritative', () => {
    const data = emptyTrajectory();
    const taskDetails: NonNullable<ResearchRoadmapInput['taskDetails']> = [
      { id: 'goal', kind: 'goal', theorem: 'Demo.two_mul_eq', objective: 'Prove the frozen goal.' },
      { id: 'typed', kind: 'goal', theorem: 'Demo.two_mul_eq', type: '(n : Nat) → 2 * n = n + n', objective: 'Already typed.' },
      { id: 'helper', kind: 'lemma', theorem: 'Demo.two_mul_eq', objective: 'Do not infer auxiliary types from the original goal.' },
    ];
    const originalSource = `namespace Demo\n/-- Ignore a fake := here. -/\n@[simp] theorem two_mul_eq (n : Nat) :\n  2 * n = n + n := by\n  sorry\nend Demo\n`;
    const { roadmap } = project(data, 'running', [], taskDetails, originalSource);
    expect(roadmap.nodes.find(node => node.id === 'task:goal')).toMatchObject({ title: 'two_mul_eq', type: '(n : Nat) :\n  2 * n = n + n' });
    expect(roadmap.nodes.find(node => node.id === 'task:typed')?.type).toBe(taskDetails[1]!.type);
    expect(roadmap.nodes.find(node => node.id === 'task:helper')?.type).toBeUndefined();
  });

  it('keeps the objective once when the recorded informal statement repeats it and retains the guidance text verbatim', () => {
    const data = emptyTrajectory();
    const objective = 'Prove\n  n + 0 = n.';
    const taskDetails: NonNullable<ResearchRoadmapInput['taskDetails']> = [
      { id: 'a', kind: 'goal', theorem: 'Tutorial.add_zero', objective, informalStatement: '  Prove n + 0 = n. ', type: '(n : Nat) : n + 0 = n' },
    ];
    data.plans.set(1, plan(1, [item('a')]));
    const record = { ...guidance('exact-guidance', 'delivered', { kind: 'task', id: 'a' }, ['engineer']),
      text: '先展开平方：\n(a + b)² = a² + 2ab + b²。\n再尝试 `omega`，保留全部假设。' };
    data.guidance.set(record.id, record);
    const { roadmap } = project(data, 'running', undefined, taskDetails);
    expect(roadmap.nodes.find(node => node.id === 'task:a')).toMatchObject({ objective, type: taskDetails[0]!.type });
    expect(roadmap.nodes.find(node => node.id === 'task:a')!.statement).toBeUndefined();
    expect(roadmap.nodes.find(node => node.id === 'guidance:exact-guidance')).toMatchObject({ guidanceText: record.text, status: 'human' });
  });

  it('retains failure, retry and their original detail indexes while reused checks add no new attempt', () => {
    const { roadmap, steps } = sampleProject(withFailedAttempt(loadWebSample()!));
    const node = roadmap.nodes.find(entry => entry.id === 'task:goal_2')!;
    const source = steps.flatMap((step, index) => step.kind === 'attempt' && step.taskId === 'goal_2' && !step.reused ? [{ number: step.number, outcome: step.outcome, stepIndex: index }] : []);
    expect(node.attempts).toEqual(source);
    expect(node.attempts?.map(entry => entry.outcome)).toEqual(['failed', 'passed']);
    expect(node.stepIndexes).toEqual(expect.arrayContaining(source.map(entry => entry.stepIndex)));
    expect(node.status).toBe('passed');
    const data = emptyTrajectory();
    const first = attempt('a', 1, 'failed', 1), reused = { ...attempt('a', 2, 'failed', 2), reused: true };
    const again = project(data, 'completed', [first, reused]).roadmap.nodes.find(entry => entry.taskId === 'a')!;
    expect(again.attempts).toEqual([{ number: 1, outcome: 'failed', stepIndex: 0 }]);
    expect(again.stepIndexes).toEqual([0, 1]);
  });

  it('uses the latest real check, keeps conditional results distinct, and recognizes new live assignments', () => {
    const data = emptyTrajectory();
    data.plans.set(1, plan(1, [item('a')]));
    const checked = [attempt('a', 1, 'failed', 1), attempt('a', 2, 'conditional', 2)];
    expect(project(data, 'completed', checked).roadmap.nodes.find(node => node.taskId === 'a')?.status).toBe('conditional');
    const recheck: TrajectoryStep = { kind: 'recheck', at: stamp(3), results: [{ taskId: 'a', passed: true }] };
    expect(project(data, 'completed', [...checked, recheck]).roadmap.nodes.find(node => node.taskId === 'a')?.status).toBe('passed');
    data.events = [event(4, 'task_assigned', { taskId: 'a', workerId: 'engineer' })];
    expect(project(data, 'running', [...checked, recheck]).roadmap.nodes.find(node => node.taskId === 'a')?.status).toBe('running');
    expect(project(data, 'completed', [...checked, recheck]).roadmap.nodes.find(node => node.taskId === 'a')?.status).toBe('passed');
    data.events.push(event(5, 'task_recheck_dependency_invalidated', { taskId: 'a' }));
    expect(project(data, 'completed', [...checked, recheck]).roadmap.nodes.find(node => node.taskId === 'a')?.status).toBe('pending');
    const integrated = { ...attempt('a', 1, 'passed', 1), integrated: true };
    expect(project(data, 'completed', [integrated, attempt('a', 2, 'failed', 6)]).roadmap.edges.find(edge => edge.kind === 'integration')?.active).toBe(false);
  });

  it('lights integration only for the latest work, while a reused check keeps its integration', () => {
    const data = emptyTrajectory();
    data.events = [event(2, 'task_integrated', { taskId: 'a' })];
    const first = { ...attempt('a', 1, 'passed', 1), integrated: true };
    const active = (steps: TrajectoryStep[]) => project(data, 'completed', steps).roadmap.edges.find(edge => edge.kind === 'integration')?.active;
    expect(active([first])).toBe(true);
    expect(active([first, { ...attempt('a', 2, 'passed', 3), reused: true }])).toBe(true);
    for (const outcome of ['passed', 'conditional'] as const) {
      const next = attempt('a', 2, outcome, 3);
      expect(active([first, next])).toBe(false);
      data.events.push(event(4, 'task_integrated', { taskId: 'a' }));
      expect(active([first, next])).toBe(true);
      data.events.pop();
    }
    const recheck: TrajectoryStep = { kind: 'recheck', at: stamp(5), results: [{ taskId: 'a', passed: true }] };
    expect(active([first, recheck])).toBe(false);
    data.events.push(event(6, 'task_recheck_finished', { taskId: 'a', passed: true }));
    expect(active([first, recheck])).toBe(true);
  });

  it('distinguishes intended guidance destinations from actual delivery and connects reviewer guidance to the same Agent', () => {
    const data = emptyTrajectory();
    data.context.workers = [{ id: 'solver', role: 'lead' }, { id: 'researcher-1', role: 'researcher' }, { id: 'engineer', role: 'engineer' }];
    data.plans.set(1, plan(1, [item('a')]));
    data.events = [event(2, 'task_assigned', { taskId: 'a', workerId: 'engineer' }), event(4, 'review_assigned', { workerId: 'researcher-1', role: 'reviewer' })];
    for (const record of [guidance('queued', 'queued', { kind: 'task', id: 'a' }), guidance('deferred', 'deferred', { kind: 'task', id: 'a' }),
      guidance('failed', 'failed', { kind: 'task', id: 'a' }), guidance('sent', 'delivered', { kind: 'task', id: 'a' }, ['engineer']),
      guidance('review', 'delivered', { kind: 'worker', id: 'researcher-1' }, ['researcher-1'])]) data.guidance.set(record.id, record);
    const { roadmap } = project(data, 'running');
    expect(roadmap.edges.filter(edge => edge.kind === 'guidance').map(edge => [edge.from, edge.to, edge.active])).toEqual([
      ['guidance:queued', 'task:a', false], ['guidance:deferred', 'task:a', false], ['guidance:failed', 'task:a', false],
      ['guidance:sent', 'task:a', true], ['guidance:review', 'review:researcher-1', true],
    ]);
    expect(roadmap.nodes.find(node => node.id === 'guidance:sent')).toMatchObject({ status: 'human', workerId: 'engineer' });
    expect(roadmap.nodes.find(node => node.id === 'guidance:failed')?.status).toBe('failed');
    expect(roadmap.nodes.find(node => node.id === 'guidance:queued')?.status).toBe('pending');
    expect(roadmap.nodes.find(node => node.id === 'guidance:deferred')?.status).toBe('pending');
    expect(roadmap.nodes.find(node => node.id === 'review:researcher-1')).toMatchObject({ status: 'running', workerId: 'researcher-1' });
  });

  it('takes review verdicts from saved deliveries rather than a completion event or a fourth Agent', () => {
    const data = emptyTrajectory();
    data.context.workers = [{ id: 'researcher-1', role: 'researcher' }];
    data.events = [event(1, 'review_assigned', { workerId: 'researcher-1', role: 'reviewer' }), event(2, 'review_completed', { workerId: 'researcher-1' })];
    expect(project(data).roadmap.nodes.find(node => node.kind === 'review')).toMatchObject({ id: 'review:researcher-1', status: 'pending', detail: 'Researcher → Reviewer' });
    const delivery = { id: 'review-result', producer: 'researcher-1', kind: 'review', status: 'changes_requested', summary: '', createdAt: stamp(3), revision: 1 };
    data.deliveries.set(delivery.id, delivery);
    const result = project(data);
    expect(result.roadmap.nodes.filter(node => node.kind === 'review')).toHaveLength(1);
    const index = result.steps.findIndex(step => step.kind === 'delivery' && step.delivery.id === delivery.id);
    expect(result.roadmap.nodes.find(node => node.kind === 'review')).toMatchObject({ status: 'failed', stepIndexes: expect.arrayContaining([index]) });
    data.deliveries.set(delivery.id, { ...delivery, status: 'accepted' });
    expect(project(data).roadmap.nodes.find(node => node.kind === 'review')?.status).toBe('passed');
    data.events = [event(2, 'review_completed', { workerId: 'researcher-1' })]; data.deliveries.clear();
    expect(project(data).roadmap.nodes.find(node => node.kind === 'review')?.status).toBe('pending');
  });

  it('shows an advisory research delivery without claiming a passed check or leaving an old assignment running', () => {
    const data = emptyTrajectory();
    data.plans.set(1, plan(1, [{ ...item('research'), kind: 'research', name: undefined, objective: 'Find a useful identity' }]));
    data.events = [event(2, 'task_assigned', { taskId: 'research', workerId: 'researcher-1' })];
    data.deliveries.set('finding', { id: 'finding', producer: 'researcher-1', taskId: 'research', kind: 'research', status: 'advisory', createdAt: stamp(3), summary: '', revision: 1 });
    expect(project(data, 'running').roadmap.nodes.find(node => node.taskId === 'research')).toMatchObject({ title: 'Find a useful identity', status: 'muted', detail: '已交付', attempts: [] });
    data.events.push(event(4, 'task_assigned', { taskId: 'research', workerId: 'researcher-1' }));
    expect(project(data, 'running').roadmap.nodes.find(node => node.taskId === 'research')?.status).toBe('running');
  });

  it('always shows acceptance, and never treats completed, candidate checks or Reviewer approval as accepted proof', () => {
    const data = emptyTrajectory();
    const proof: TrajectoryStep = { kind: 'proof', assembled: true, number: 1, outcome: 'passed', at: stamp(1), workerId: 'solver' };
    data.deliveries.set('review-result', { id: 'review-result', producer: 'reviewer', kind: 'review', status: 'accepted', summary: '', createdAt: stamp(2), revision: 1 });
    expect(project(data, 'completed', [proof]).roadmap.nodes.find(node => node.id === 'evaluation')?.status).toBe('pending');
    for (const [status, expected] of [['passed', 'passed'], ['failed', 'failed'], ['error', 'failed'], ['skipped', 'pending']] as const) {
      const evaluation: TrajectoryStep = { kind: 'evaluation', at: stamp(3), status, outcome: status === 'passed' ? 'passed' : 'failed' };
      expect(project(data, 'completed', [proof, evaluation]).roadmap.nodes.find(node => node.id === 'evaluation')?.status).toBe(expected);
    }
    expect(project(emptyTrajectory(), 'queued', []).roadmap.nodes.find(node => node.id === 'evaluation')?.status).toBe('pending');
  });

  it('marks an incomplete retained record as partial and keeps nodes stable across equivalent projections', () => {
    const { data, steps, roadmap } = sampleProject();
    const again = buildResearchRoadmap({ data, steps, status: 'completed', tasks: trajectoryTaskNames(data) });
    expect(again).toEqual(roadmap);
    expect(project({ ...data, dropped: { ...data.dropped, events: 1 } }).roadmap.partial).toBe(true);
    const limited = emptyTrajectory(); limited.plans.set(1, { ...plan(1, [item('a')]), omitted: 1 });
    expect(project(limited).roadmap.partial).toBe(true);
  });
});
