import { describe, expect, test } from 'vitest';
import { agentNames, agentRoutes, taskNames } from '../apps/web/client/agentRoute';
import { loadWebSample } from '../apps/web/sample';
import type { WebEvent } from '../apps/web/shared';

let sequence = 0;
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

  test('Agents are named by role, numbered only when a role is shared', () => {
    expect([...agentNames([{ id: 'solver', role: 'Lead' }, { id: 'researcher-1', role: 'Researcher' }, { id: 'researcher-2', role: 'Researcher' },
      { id: 'engineer', role: 'Engineer' }, { id: 'unknown' }])]).toEqual([['solver', 'Lead'], ['researcher-1', 'Researcher 1'],
      ['researcher-2', 'Researcher 2'], ['engineer', 'Engineer']]);
    expect([...taskNames([{ id: 'goal_1', theorem: 'Tutorial.add_zero' }, { id: 'bridge', theorem: 'zero_add' }, { id: 'draft' }])])
      .toEqual([['goal_1', 'add_zero'], ['bridge', 'zero_add']]);
  });
});
