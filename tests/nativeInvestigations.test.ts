import { describe, expect, it, vi } from 'vitest';
import { NativeInvestigations, type NativeResearchAgent } from '../src/runtime/nativeDelegation';

function fixture(maxAgents = 3) {
  const agents: NativeResearchAgent[] = [];
  let next = 0;
  const request = vi.fn(async (method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (method === 'thread/start') return { thread: { id: `child-${++next}` }, model: 'fixture',
      reasoningEffort: 'high', approvalPolicy: 'never', activePermissionProfile: { id: 'math-investigator' } };
    if (method === 'turn/start') return { turn: { id: params.threadId + '-turn' } };
    return {};
  });
  const fail = vi.fn();
  const controller = new NativeInvestigations({ maxAgents, parentThreadId: 'parent', workspace: '/workspace', model: 'fixture',
    effort: 'high', settings: { developerInstructions: 'Fixed original problem.' }, request,
    active: turnId => turnId === 'parent-turn', changed: agent => agents.push(agent), activity: vi.fn(), fail });
  const call = (changes: Record<string, unknown> = {}) => controller.call({ threadId: 'parent', turnId: 'parent-turn',
    callId: 'call-1', namespace: null, tool: 'theoremos_investigate', arguments: { questions: ['Bounded question.'] }, ...changes });
  return { controller, request, call, agents, fail };
}

describe('bounded native investigation tool', () => {
  it.each([
    { threadId: 'another-thread' }, { turnId: 'old-turn' }, { namespace: 'other' },
    { arguments: { questions: [] } }, { arguments: { questions: ['a', 'b', 'c'] } },
    { arguments: { questions: ['a'], executable: '/host/command' } },
  ])('rejects foreign or invalid requests before native dispatch: %j', async changes => {
    const f = fixture();
    expect(await f.call(changes)).toMatchObject({ success: false });
    expect(f.request).not.toHaveBeenCalled();
  });

  it('reserves capacity atomically, keeps call identity, and only releases after native archive', async () => {
    const f = fixture(2);
    const first = f.call();
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledWith('turn/start', expect.anything()));
    expect(await f.call({ callId: 'call-2' })).toMatchObject({ success: false });
    expect(await f.call({ arguments: { questions: ['Changed question.'] } })).toMatchObject({ success: false });
    expect(f.controller.busy).toBe(true);
    f.controller.observe('turn/completed', { threadId: 'unrelated', turn: { id: 'child-1-turn', status: 'completed' } });
    expect(f.controller.busy).toBe(true);
    f.controller.observe('turn/completed', { threadId: 'child-1', turn: { id: 'child-1-turn', status: 'completed',
      items: [{ type: 'agentMessage', text: 'Source reference and advisory findings.' }] } });
    expect(await first).toMatchObject({ success: true });
    expect(await f.call()).toEqual(await first);
    expect(f.request.mock.calls.filter(([method]) => method === 'thread/start')).toHaveLength(1);
    expect(f.request).toHaveBeenCalledWith('thread/archive', { threadId: 'child-1' });
    expect(f.agents.at(-1)).toMatchObject({ status: 'completed', stoppedAt: expect.any(Number),
      dispatch: 'host-mediated-native-threads', question: 'Bounded question.' });
    expect(f.controller.busy).toBe(false);
  });

  it('does not silently abandon a child when archive fails', async () => {
    const f = fixture();
    f.request.mockImplementation(async method => {
      if (method === 'thread/start') return { thread: { id: 'child-1' }, model: 'fixture', reasoningEffort: 'high',
        approvalPolicy: 'never', activePermissionProfile: { id: 'math-investigator' } };
      if (method === 'turn/start') return { turn: { id: 'child-1-turn' } };
      throw new Error('archive fixture failure');
    });
    const first = f.call();
    await vi.waitFor(() => expect(f.request).toHaveBeenCalledWith('turn/start', expect.anything()));
    f.controller.observe('turn/completed', { threadId: 'child-1', turn: { id: 'child-1-turn', status: 'completed' } });
    await first;
    expect(f.fail).toHaveBeenCalledOnce();
    expect(f.agents.at(-1)).not.toHaveProperty('stoppedAt');
    f.controller.stop(); await f.controller.settled(); f.controller.confirmStopped(false);
    expect(f.agents.at(-1)?.status).toBe('unknown');
  });
});
