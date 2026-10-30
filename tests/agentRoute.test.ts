import { describe, expect, test } from 'vitest';
import { agentNames, agentRoutes, mergeAgentActions, taskNames } from '../apps/web/client/agentRoute';
import { loadWebSample } from '../apps/web/sample';
import type { WebAgentAction, WebEvent } from '../apps/web/shared';

let sequence = 0, actionSequence = 0;
const action = (workerId: string, itemId: string, at: string, extra: Partial<WebAgentAction> = {}): WebAgentAction =>
  ({ sequence: ++actionSequence, at, workerId, itemId, phase: 'completed', kind: 'message', status: 'done', ...extra });
const after = (value: WebEvent, ms = 1) => new Date(Date.parse(value.at) + ms).toISOString();
const event = (type: string, details?: WebEvent['details']): WebEvent => ({ sequence: ++sequence, at: new Date(Date.UTC(2026, 9, 27, 0, 0, sequence)).toISOString(), type, message: type, ...(details ? { details } : {}) });
const shape = (events: WebEvent[]) => agentRoutes(events).map(route => ({ workerId: route.workerId,
  steps: route.steps.map(step => [step.kind, step.count, step.outcome ?? '', step.taskId ?? '', step.reviewing ? 'review' : ''].join(':')) }));

describe('agent routes', () => {
  test('a direct solve is one lane from reading to acceptance', () => {
    expect(shape([event('queued'), event('proof_environment'), event('solve_started'),
      event('research_action', { workerId: 'solver', operation: 'direct' }), event('context_compiled', { workerId: 'solver' }),
      event('turn_started', { workerId: 'solver', turn: 1 }), event('worker_activity', { workerId: 'solver' }),
      event('proof_check_started', { workerId: 'solver', turn: 1 }), event('proof_checked', { workerId: 'solver', passed: false }),
      event('turn_started', { workerId: 'solver', turn: 2 }), event('proof_checked', { workerId: 'solver', passed: true }),
      event('candidate_selected', { workerId: 'solver' }), event('evaluation_started', { workerId: 'solver' }),
      event('evaluation_finished', { status: 'passed' }), event('finished')])).toEqual([{ workerId: 'solver',
      steps: ['read:1:::', 'write:1:::', 'check:1:failed::', 'write:1:::', 'check:1:passed::', 'accept:1:passed::'] }]);
  });

  test('repeats merge with a count, and events without an Agent go to their task owner', () => {
    expect(shape([event('task_assigned', { workerId: 'prover-1', taskId: 'bridge' }), event('turn_started', { workerId: 'prover-1', turn: 1 }),
      event('turn_started', { workerId: 'prover-1', turn: 2 }), event('task_checked', { taskId: 'bridge', passed: false }),
      event('task_recheck_finished', { taskId: 'bridge', passed: true }), event('task_integrated', { taskId: 'bridge', workerId: 'prover-1' }),
      event('task_checked', { taskId: 'unowned', passed: true })])).toEqual([{ workerId: 'prover-1',
      steps: ['read:1::bridge:', 'write:2:::', 'check:2:passed:bridge:', 'deliver:1::bridge:'] }]);
  });

  test('a reviewer writes a review until it is given a task', () => {
    expect(shape([event('review_assigned', { workerId: 'researcher-1', role: 'reviewer' }), event('turn_started', { workerId: 'researcher-1', turn: 1 }),
      event('review_completed', { workerId: 'researcher-1' }), event('task_assigned', { workerId: 'researcher-1', taskId: 'base' }),
      event('turn_started', { workerId: 'researcher-1', turn: 2 })])[0].steps).toEqual(['read:1:::', 'write:1:::review', 'deliver:1:::', 'read:1::base:', 'write:1:::']);
  });

  test('the shipped sample has a lane for each of its three Agents', () => {
    const routes = agentRoutes(loadWebSample()!.run.events);
    expect(routes.map(route => route.workerId)).toEqual(['solver', 'engineer', 'researcher-1']);
    expect(routes[0].steps.at(-1)).toMatchObject({ kind: 'accept', outcome: 'passed' });
  });

  test('actions join the step their Agent is in; after a check or a delivery they open a new writing step', () => {
    const assigned = event('task_assigned', { workerId: 'prover-1', taskId: 'bridge' }), turn = event('turn_started', { workerId: 'prover-1', turn: 1 });
    const heartbeat = event('worker_activity', { workerId: 'prover-1' }), checked = event('task_checked', { taskId: 'bridge', passed: false });
    const steered = event('guidance_delivered', { workerId: 'prover-1' });
    const actions = [action('prover-1', 'read', after(assigned)), action('prover-1', 'edit', after(turn), { kind: 'edit' }),
      action('prover-1', 'fix', after(steered), { kind: 'command' })];
    const routes = agentRoutes([assigned, turn, heartbeat, checked, steered], { actions });
    expect(routes[0].steps.map(step => [step.kind, step.items.map(item => item.type === 'event' ? item.event.type : item.action.itemId)])).toEqual([
      ['read', ['task_assigned', 'read']], ['write', ['turn_started', 'edit']], ['check', ['task_checked', 'guidance_delivered']], ['write', ['fix']]]);
    expect(routes[0].steps[3]).toMatchObject({ at: actions[2].at, count: 1 });
    // An Agent with actions but no events still has its lane.
    expect(agentRoutes([], { actions: [action('researcher-2', 'note', assigned.at)] }).map(route => route.workerId)).toEqual(['researcher-2']);
  });

  test('a completed report replaces its started one where it began', () => {
    const merged = mergeAgentActions([action('a', '1:cmd', 't1', { kind: 'command', phase: 'started', status: 'running' }), action('b', '1:cmd', 't2'),
      action('a', '1:cmd', 't3', { kind: 'command', status: 'failed', exitCode: 1 })]);
    expect(merged.map(item => [item.workerId, item.at, item.sequence, item.status])).toEqual([['a', 't1', actionSequence - 2, 'failed'], ['b', 't2', actionSequence - 1, 'done']]);
  });

  test('a plan change is the Lead\'s planning only when it comes from the Lead\'s turn, not from a person\'s edit', () => {
    const turn = event('turn_started', { workerId: 'solver', turn: 1 }), planned = event('plan_updated');
    const edit = event('human_edit_queued'), applied = event('plan_updated');
    const next = event('turn_started', { workerId: 'solver', turn: 2 }), revised = event('plan_updated');
    const routes = agentRoutes([turn, planned, edit, applied, next, revised], { lead: 'solver' });
    expect(routes[0].steps.map(step => [step.kind, step.planning ?? false, step.items.map(item => item.type === 'event' ? item.event.sequence : '')]))
      .toEqual([['write', true, [turn.sequence, planned.sequence, next.sequence, revised.sequence]]]);
    const split = agentRoutes([turn, planned, edit, applied, event('proof_checked', { workerId: 'solver', passed: true }), next, revised], { lead: 'solver' });
    expect(split[0].steps.map(step => [step.kind, step.planning ?? false, step.items.length])).toEqual([['write', true, 2], ['check', false, 1], ['write', true, 2]]);
  });

  test('the sample\'s recorded writes sit in the steps that made them', () => {
    const sample = loadWebSample()!;
    expect(sample.run.actions).toEqual({ count: sample.actions!.length });
    const routes = agentRoutes(sample.events, { actions: mergeAgentActions(sample.actions!), lead: 'solver' });
    const writes = routes.map(route => [route.workerId, route.steps.flatMap(step => step.items.flatMap(item => item.type === 'action'
      ? [`${step.kind}${step.planning ? '+plan' : ''}${step.reviewing ? '+review' : ''}:${item.action.changes!.map(change => change.path).join(',')}`] : []))]);
    expect(writes).toEqual([
      ['solver', ['write+plan:./RESEARCH.md', 'write+plan:./RESEARCH.md']],
      ['engineer', ['write:./generated/problem/Submission.lean', 'write:./generated/problem/Submission.lean']],
      ['researcher-1', ['write+review:./RESEARCH.md']]]);
    expect(JSON.stringify(sample.actions)).not.toMatch(/\/workspace|\/work\/|WEB_COOPERATIVE|Offline/u);
  });

  test('Agents are named by role, numbered only when a role is shared', () => {
    expect([...agentNames([{ id: 'solver', role: 'Lead' }, { id: 'researcher-1', role: 'Researcher' }, { id: 'researcher-2', role: 'Researcher' },
      { id: 'engineer', role: 'Engineer' }, { id: 'unknown' }])]).toEqual([['solver', 'Lead'], ['researcher-1', 'Researcher 1'],
      ['researcher-2', 'Researcher 2'], ['engineer', 'Engineer']]);
    expect([...taskNames([{ id: 'goal_1', theorem: 'Tutorial.add_zero' }, { id: 'bridge', theorem: 'zero_add' }, { id: 'draft' }])])
      .toEqual([['goal_1', 'add_zero'], ['bridge', 'zero_add']]);
  });
});
