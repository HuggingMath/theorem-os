import { describe, expect, it, vi } from 'vitest';
import { AgentTeamNativeControl, type AgentTeamNativeLifecycle } from '../src/solver/agentTeamNative';
import type { AgentTeamState, AgentTeamWorker } from '../src/solver/agentTeamState';
import type { NativeAgentControlConnection } from '../src/runtime/nativeAgentControl';
import { agentTeamInstructions } from '../src/solver/agentTeamContext';
import { agentTeamOperationAllowed, agentTeamToolDefinition } from '../src/solver/agentTeamTool';
import { deferred } from './helpers/async';

type Json = Record<string, any>;
const ROOT = '00000000-0000-4000-8000-000000000001';
const CHILD = '00000000-0000-4000-8000-000000000002';

function member(id = 'analyst', threadId = CHILD): AgentTeamWorker {
  return { id, role: 'researcher', worktree: '/isolated/' + id, phase: 'prepared', status: 'idle', turns: 0,
    seedCommit: 'a'.repeat(40), tasks: [], cursor: 0,
    native: { sessionId: ROOT, threadId, parentThreadId: ROOT, agentPath: '/root/' + id,
      bootstrap: { threadId, sessionId: ROOT }, initialInput: { author: '/root', input: {} },
      agent: { threadId, metadata: { agentId: threadId, agentPath: '/root/' + id }, status: { completed: 'Saved advisory research.' } },
      configSnapshot: { cwd: '/isolated/' + id } } };
}

function connection(threadId = ROOT, path = '/root') {
  const current: NativeAgentControlConnection = {
    info: { sessionId: ROOT, agent: { threadId, metadata: { agentId: threadId, agentPath: path }, status: 'running' },
      configSnapshot: { cwd: '/isolated' + path } },
    request: vi.fn(async () => ({})), input: vi.fn(async () => ({ accepted: true, threadId, submissionId: 'submission' })),
    update: vi.fn(async request => ({ acceptedSequence: request.sequence })),
  };
  return current;
}

async function fixture() {
  const archive: AgentTeamState = { schema: 'theorem-os.agent-team.v1', transport: 'native-agent-control',
    workers: [member()], events: [], deliveries: [], adoptions: [], operations: [] };
  const accepted = { agent: archive.workers[0].native!.agent!, configSnapshot: { cwd: '/isolated/analyst' }, submissionId: 'turn-a' };
  const lifecycle: AgentTeamNativeLifecycle = { spawn: vi.fn(async () => accepted),
    followup: vi.fn(async () => accepted), interrupt: vi.fn(async () => {}), load: vi.fn(async () => {}), admit: vi.fn() };
  const save = vi.fn(), control = new AgentTeamNativeControl(archive, lifecycle, save), root = connection();
  let index = 0;
  const call = (operation: string, payload: Json, actor = 'lead', channel = root, operationId = 'op-' + ++index) => {
    const threadId = actor === 'lead' ? ROOT : archive.workers.find(worker => worker.id === actor)!.native!.threadId;
    return control.options(actor).request({ version: 1, sessionId: ROOT, threadId, operation, operationId, payload }, channel,
      { signal: new AbortController().signal });
  };
  await call('attach', { threadId: ROOT, sessionId: ROOT });
  await control.options('lead').bound!(root);
  return { archive, lifecycle, save, control, root, call, accepted };
}

describe('native AgentControl mathematical-team host routing', () => {
  it('uses real canonical identities and returns only loaded native agents', async () => {
    const f = await fixture();
    expect(await f.call('resolve', { caller: ROOT, target: { kind: 'reference', reference: '/root/analyst' } })).toEqual({ result: { threadId: CHILD } });
    await expect(f.call('resolve', { caller: ROOT, target: { kind: 'reference', reference: 'analyst' } })).rejects.toThrow('reference_unknown');
    await expect(f.call('resolve', { caller: ROOT, target: { kind: 'id', threadId: '00000000-0000-4000-8000-000000000099' } })).rejects.toThrow('reference_unknown');
    expect((await f.call('list', { caller: ROOT })).result).toMatchObject({ agents: [{ threadId: ROOT }] });
    const child = connection(CHILD, '/root/analyst');
    await f.call('attach', { threadId: CHILD, sessionId: ROOT }, 'analyst', child);
    expect(child.update).not.toHaveBeenCalled();
    await f.control.options('analyst').bound!(child);
    expect((await f.call('list', { caller: ROOT, pathPrefix: '/root/analyst' })).result).toMatchObject({ agents: [{ threadId: CHILD }] });
    await expect(f.call('list', { caller: CHILD })).rejects.toThrow('caller_changed');
    await f.control.options('analyst').disconnected!(child);
    const result = await f.call('interrupt', { caller: ROOT, target: { kind: 'id', threadId: CHILD } });
    expect(result.result).toMatchObject({ kind: 'unloaded', metadata: { agentPath: '/root/analyst' } });
    expect(f.lifecycle.interrupt).toHaveBeenCalledWith(f.archive.workers[0]);
    expect(f.archive.workers[0].status).toBe('idle');
  });

  it('keeps repeated native reads and usage acknowledgments out of the durable mutation journal', async () => {
    const f = await fixture();
    f.save.mockClear();
    for (let index = 0; index < 3; index++) {
      expect(await f.call('resolve', { caller: ROOT, target: { kind: 'reference', reference: '/root/analyst' } }))
        .toEqual({ result: { threadId: CHILD } });
      expect((await f.call('list', { caller: ROOT })).result).toMatchObject({ agents: [{ threadId: ROOT }] });
      expect(await f.call('childPaths', { parent: ROOT })).toEqual({ result: { paths: ['/root/analyst'] } });
      expect(await f.call('recordUsage', { caller: ROOT, threadId: ROOT, turnId: 'turn-' + index,
        usage: { total_tokens: index } })).toEqual({ result: {} });
      expect(await f.call('releaseTurn', { caller: ROOT, threadId: ROOT, turnId: 'turn-' + index })).toEqual({ result: {} });
    }
    await expect(f.call('recordUsage', { caller: CHILD })).rejects.toThrow('caller_changed');
    await expect(f.call('releaseTurn', { caller: CHILD })).rejects.toThrow('caller_changed');
    expect(f.archive.operations).toEqual([]); expect(f.save).not.toHaveBeenCalled();
    expect(f.root.update).not.toHaveBeenCalled(); expect(f.lifecycle.followup).not.toHaveBeenCalled();
  });

  it('reads current loaded membership instead of replaying a saved list snapshot', async () => {
    const f = await fixture();
    const payload = { caller: ROOT };
    expect((await f.call('list', payload, 'lead', f.root, 'same-read')).result).toMatchObject({ agents: [{ threadId: ROOT }] });
    const child = connection(CHILD, '/root/analyst');
    await f.call('attach', { threadId: CHILD, sessionId: ROOT }, 'analyst', child);
    await f.control.options('analyst').bound!(child);
    f.save.mockClear();
    expect((await f.call('list', payload, 'lead', f.root, 'same-read')).result).toMatchObject({
      agents: [{ threadId: ROOT }, { threadId: CHILD }],
    });
    expect(f.archive.operations).toEqual([]); expect(f.save).not.toHaveBeenCalled();
  });

  it('keeps queue-only mail durable without starting an idle model turn', async () => {
    const f = await fixture();
    const result = await f.call('send', { caller: ROOT, target: { kind: 'id', threadId: CHILD },
      input: { kind: 'message', mode: 'queueOnly', message: { kind: 'plaintext', text: 'A dependency is ready.' } } });
    expect(result.result).toMatchObject({ threadId: CHILD, metadata: { agentPath: '/root/analyst' } });
    expect(f.lifecycle.followup).not.toHaveBeenCalled(); expect(f.lifecycle.load).not.toHaveBeenCalled();
    expect(f.archive.nativeControl!.mailbox).toMatchObject([{ status: 'queued', author: '/root', recipient: '/root/analyst' }]);
    const child = connection(CHILD, '/root/analyst');
    await f.call('attach', { threadId: CHILD, sessionId: ROOT }, 'analyst', child);
    expect(child.update).not.toHaveBeenCalled();
    await f.control.options('analyst').bound!(child);
    expect(child.update).toHaveBeenCalledTimes(1);
    expect(f.archive.nativeControl!.mailbox[0].status).toBe('accepted');
    await f.control.options('analyst').disconnected!(child);
    expect(f.archive.nativeControl!.mailbox[0].status).toBe('uncertain');
    await f.call('attach', { threadId: CHILD, sessionId: ROOT }, 'analyst', child);
    expect(child.update).toHaveBeenCalledTimes(1);
  });

  it('keeps a reconnecting child unloaded and retains mail if its startup fails before binding', async () => {
    const f = await fixture(), provisional = { ...connection(CHILD, '/root/analyst'), info: undefined };
    await f.call('attach', { threadId: CHILD, sessionId: ROOT }, 'analyst', provisional);
    expect(await f.call('list', { caller: ROOT, pathPrefix: '/root/analyst' })).toEqual({ result: { agents: [] } });
    const target = { kind: 'reference', reference: '/root/analyst' };
    expect(await f.call('resolve', { caller: ROOT, target })).toEqual({ result: { threadId: CHILD } });
    const sent = await f.call('send', { caller: ROOT, target,
      input: { kind: 'message', mode: 'queueOnly', message: { kind: 'plaintext', text: 'Use the checked dependency.' } } });
    expect(sent.result).toMatchObject({ threadId: CHILD, submissionId: expect.any(String) });
    expect(provisional.update).not.toHaveBeenCalled();
    expect(f.archive.nativeControl!.mailbox[0].status).toBe('queued');
    await f.control.options('analyst').disconnected!(provisional);
    const child = connection(CHILD, '/root/analyst');
    await f.call('attach', { threadId: CHILD, sessionId: ROOT }, 'analyst', child);
    expect(child.update).not.toHaveBeenCalled();
    await f.control.options('analyst').bound!(child);
    expect(child.update).toHaveBeenCalledTimes(1);
    expect(f.archive.nativeControl!.mailbox[0].status).toBe('accepted');
    expect((await f.call('list', { caller: ROOT, pathPrefix: '/root/analyst' })).result).toMatchObject({ agents: [{ threadId: CHILD }] });
  });

  it('leaves delivery uncertain when an in-flight update is acknowledged by the replaced connection', async () => {
    const f = await fixture(), child = connection(CHILD, '/root/analyst');
    await f.call('attach', { threadId: CHILD, sessionId: ROOT }, 'analyst', child);
    await f.control.options('analyst').bound!(child);
    await f.control.advisory(null, 'analyst', 'Already forwarded to the old connection.');
    expect(f.archive.nativeControl!.mailbox[0].status).toBe('accepted');
    const updating = deferred(), release = deferred();
    vi.mocked(child.update).mockImplementationOnce(async request => {
      updating.resolve(); await release.promise;
      return { acceptedSequence: request.sequence };
    });
    const sent = f.call('send', { caller: ROOT, target: { kind: 'id', threadId: CHILD },
      input: { kind: 'message', mode: 'queueOnly', message: { kind: 'plaintext', text: 'Do not replay an unconfirmed delivery.' } } });
    await updating.promise;
    const replacement = connection(CHILD, '/root/analyst');
    await f.call('attach', { threadId: CHILD, sessionId: ROOT }, 'analyst', replacement);
    await f.control.options('analyst').disconnected!(child);
    release.resolve();
    await f.control.options('analyst').bound!(replacement);
    await sent;
    expect(child.update).toHaveBeenCalledTimes(2);
    expect(replacement.update).not.toHaveBeenCalled();
    expect(f.archive.nativeControl!.mailbox.map(mail => mail.status)).toEqual(['uncertain', 'uncertain']);
  });

  it('preserves native sender identity and enforces the flat Lead dispatch authority', async () => {
    const f = await fixture(), child = connection(CHILD, '/root/analyst');
    await f.call('attach', { threadId: CHILD, sessionId: ROOT }, 'analyst', child);
    await f.call('send', { caller: CHILD, target: { kind: 'reference', reference: '/root' },
      input: { kind: 'message', mode: 'queueOnly', message: { kind: 'plaintext', text: 'An advisory finding.' } } }, 'analyst', child);
    expect(f.archive.nativeControl!.mailbox[0]).toMatchObject({ author: '/root/analyst', recipient: '/root', status: 'accepted' });
    expect(f.archive.nativeControl!.mailbox[0].hostEventSequence).toBeUndefined();
    await f.control.advisory('analyst', 'lead', 'Checked declarations are ready.');
    expect(f.archive.nativeControl!.mailbox[1]).toMatchObject({ status: 'accepted' });
    expect(f.archive.nativeControl!.mailbox[1]).not.toHaveProperty('hostEventSequence');
    const notification = vi.mocked(f.root.update).mock.calls.at(-1)![0].mailbox![0];
    expect(notification).not.toHaveProperty('hostEventSequence');
    await expect(f.call('spawn', { caller: CHILD }, 'analyst', child)).rejects.toThrow('lead_operation_required');
    await expect(f.call('interrupt', { caller: CHILD, target: { kind: 'id', threadId: ROOT } }, 'analyst', child))
      .rejects.toThrow('lead_operation_required');
    await expect(f.call('send', { caller: CHILD, target: { kind: 'id', threadId: CHILD },
      input: { kind: 'message', mode: 'queueOnly', message: { kind: 'plaintext', text: 'Self.' } } }, 'analyst', child))
      .rejects.toThrow('self_addressed');
    await expect(f.call('send', { caller: ROOT, target: { kind: 'id', threadId: ROOT },
      input: { kind: 'message', mode: 'triggerTurn', message: { kind: 'plaintext', text: 'Root followup.' } } }))
      .rejects.toThrow();
  });

  it('delivers host adoption and failure observations without looking up a nonexistent host worker', async () => {
    const f = await fixture(), child = connection(CHILD, '/root/analyst');
    await f.call('attach', { threadId: CHILD, sessionId: ROOT }, 'analyst', child);
    await f.control.options('analyst').bound!(child);
    await f.control.advisory(null, 'lead', 'Checked declarations were integrated.');
    await f.control.advisory(null, 'analyst', 'The dependency is ready.');
    expect(f.archive.nativeControl!.mailbox).toMatchObject([
      { author: '/morpheus', recipient: '/root', status: 'accepted' },
      { author: '/morpheus', recipient: '/root/analyst', status: 'accepted' },
    ]);
    expect(f.archive.nativeControl!.mailbox.every(item => item.hostEventSequence === undefined)).toBe(true);
    expect(f.lifecycle.followup).not.toHaveBeenCalled();
  });

  it('keeps a member named host distinct from the native host author', async () => {
    const f = await fixture();
    f.archive.workers[0] = member('host');
    await f.control.advisory('host', 'lead', 'Member checked delivery.');
    await f.control.advisory(null, 'host', 'Checked dependency ready.');
    expect(f.archive.nativeControl!.mailbox).toMatchObject([
      { author: '/root/host', recipient: '/root', status: 'accepted' },
      { author: '/morpheus', recipient: '/root/host', status: 'queued' },
    ]);
  });

  it('passes attributed followup to the current member lifecycle without amending its objective', async () => {
    const f = await fixture(), worker = f.archive.workers[0];
    worker.tasks.push({ id: 'same-task', message: 'Profiles: D006\nInvestigate this gap.', status: 'running', objectiveRevision: 2 });
    const input = { kind: 'message', mode: 'triggerTurn', message: { kind: 'plaintext', text: 'Continue with the new evidence.' } };
    await f.call('send', { caller: ROOT, target: { kind: 'id', threadId: CHILD }, input, startOptions: { parentTurnId: 'parent-turn' } });
    expect(f.lifecycle.followup).toHaveBeenCalledWith(worker, {
      author: '/root', input, startOptions: { parentTurnId: 'parent-turn' },
    }, expect.any(AbortSignal));
    expect(worker.tasks).toMatchObject([{ id: 'same-task', objectiveRevision: 2, status: 'running' }]);
  });

  it('deduplicates one native operation and rejects changed completed or pending payloads', async () => {
    const f = await fixture(), gate = deferred<ReturnType<typeof fixture> extends Promise<infer F> ? F['accepted'] : never>();
    vi.mocked(f.lifecycle.followup).mockReturnValue(gate.promise);
    const payload = { caller: ROOT, target: { kind: 'id', threadId: CHILD },
      input: { kind: 'message', mode: 'triggerTurn', message: { kind: 'plaintext', text: 'Continue.' } } };
    const first = f.call('send', payload, 'lead', f.root, 'stable-op');
    const repeated = f.call('send', payload, 'lead', f.root, 'stable-op');
    await expect(f.call('send', { ...payload, startOptions: { parentTurnId: 'different' } }, 'lead', f.root, 'stable-op'))
      .rejects.toThrow('call_changed');
    gate.resolve(f.accepted);
    expect(await first).toEqual(await repeated); expect(f.lifecycle.followup).toHaveBeenCalledTimes(1);
    await expect(f.call('send', { ...payload, startOptions: { parentTurnId: 'changed' } }, 'lead', f.root, 'stable-op'))
      .rejects.toThrow('call_changed');
  });

  it('replays a saved native dispatch receipt after recovery without dispatching the member twice', async () => {
    const f = await fixture();
    const payload = { caller: ROOT, target: { kind: 'id', threadId: CHILD },
      input: { kind: 'message', mode: 'triggerTurn', message: { kind: 'plaintext', text: 'Continue the assignment.' } } };
    const accepted = await f.call('send', payload, 'lead', f.root, 'saved-dispatch');
    expect(f.lifecycle.followup).toHaveBeenCalledTimes(1);
    const archive = structuredClone(f.archive), save = vi.fn();
    const lifecycle = { ...f.lifecycle, followup: vi.fn(async () => f.accepted) };
    const recovered = new AgentTeamNativeControl(archive, lifecycle, save), root = connection();
    const request = (operation: string, operationId: string, payload: Json) => recovered.options('lead').request({
      version: 1, sessionId: ROOT, threadId: ROOT, operation, operationId, payload,
    }, root, { signal: new AbortController().signal });
    await request('attach', 'recovered-attach', { threadId: ROOT, sessionId: ROOT });
    save.mockClear();
    expect(await request('send', 'saved-dispatch', payload)).toEqual(accepted);
    await expect(request('send', 'saved-dispatch', { ...payload, startOptions: { parentTurnId: 'changed' } })).rejects.toThrow('call_changed');
    expect(lifecycle.followup).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
    expect(archive.operations).toEqual(f.archive.operations);
  });

  it('records native completion as advisory without manufacturing a proof delivery', async () => {
    const f = await fixture(), child = connection(CHILD, '/root/analyst');
    await f.call('attach', { threadId: CHILD, sessionId: ROOT }, 'analyst', child);
    await f.call('turnFinished', { outcome: { threadId: CHILD, turnId: 'native-turn', status: { completed: 'A useful result.' } } }, 'analyst', child);
    expect(f.archive.workers[0].native!.status).toEqual({ completed: 'A useful result.' });
    expect(f.archive.workers[0].tasks).toEqual([]); expect(f.archive.deliveries).toEqual([]); expect(f.archive.adoptions).toEqual([]);
    expect(f.archive.workers[0].pendingDelivery).toBeUndefined();
  });

  it('preserves the native completion communication without adding another plaintext wrapper', async () => {
    const f = await fixture(), child = connection(CHILD, '/root/analyst');
    await f.call('attach', { threadId: CHILD, sessionId: ROOT }, 'analyst', child);
    const communication = { author: '/root/analyst', recipient: '/root', citations: [],
      content: '<native-final-result>Useful advisory result.</native-final-result>', trigger_turn: false };
    await f.call('turnFinished', { outcome: { threadId: CHILD, turnId: 'terminal-turn', status: { completed: 'Useful result.' } },
      parentThreadId: ROOT, completionMessage: communication }, 'analyst', child);
    expect(f.archive.nativeControl!.mailbox[0]).toMatchObject({ communication, status: 'accepted' });
    expect(f.archive.nativeControl!.mailbox[0].message).toBeUndefined();
    const sent = vi.mocked(f.root.update).mock.calls[0][0] as Json;
    expect(sent.mailbox[0].communication).toEqual(communication);
    expect(sent.mailbox[0].message).toBeUndefined();
  });

  it('resolves cold child attachment to the persisted tree and leaves uncertain delivery unreplayed', async () => {
    const f = await fixture(), child = connection(CHILD, '/root/analyst');
    const response = await f.control.options('analyst').request({ version: 1, sessionId: CHILD, threadId: CHILD,
      operationId: 'cold-attach', operation: 'attach', payload: { threadId: CHILD, sessionId: CHILD } }, child,
    { signal: new AbortController().signal });
    expect(response).toEqual({ result: { sessionId: ROOT } });
    await f.control.options('analyst').bound!(child);
    vi.mocked(child.update).mockRejectedValueOnce(new Error('response-lost-after-native-acceptance'));
    await f.call('send', { caller: ROOT, target: { kind: 'id', threadId: CHILD },
      input: { kind: 'message', mode: 'queueOnly', message: { kind: 'plaintext', text: 'No false read receipt.' } } });
    expect(f.archive.nativeControl!.mailbox[0]).toMatchObject({ status: 'uncertain', sequence: 1 });
    await f.control.options('analyst').bound!(child);
    expect(child.update).toHaveBeenCalledTimes(1);
    expect(f.lifecycle.followup).not.toHaveBeenCalled();
  });

  it('retries queued mail on reattach if the recipient disconnected before the update could send it', async () => {
    const f = await fixture(), child = connection(CHILD, '/root/analyst');
    await f.call('attach', { threadId: CHILD, sessionId: ROOT }, 'analyst', child);
    await f.control.options('analyst').bound!(child);
    const updating = deferred(), release = deferred();
    vi.mocked(child.update).mockImplementationOnce(async request => {
      updating.resolve(); await release.promise;
      return { acceptedSequence: request.sequence };
    });
    const configUpdate = f.call('configUpdate', { serviceTier: 'priority' }).catch(error => (error as Error).message);
    await updating.promise;
    const send = f.call('send', { caller: ROOT, target: { kind: 'id', threadId: CHILD },
      input: { kind: 'message', mode: 'queueOnly', message: { kind: 'plaintext', text: 'A dependency is ready.' } } });
    await expect.poll(() => f.archive.nativeControl!.mailbox.length).toBe(1);
    await f.control.options('analyst').disconnected!(child);
    release.resolve();
    await configUpdate;
    await send;
    const [mail] = f.archive.nativeControl!.mailbox;
    expect(mail).toMatchObject({ status: 'queued' });
    expect(mail.sequence).toBeUndefined();
    expect(child.update).toHaveBeenCalledTimes(1);

    const resumed = connection(CHILD, '/root/analyst');
    await f.call('attach', { threadId: CHILD, sessionId: ROOT }, 'analyst', resumed);
    await f.control.options('analyst').bound!(resumed);
    expect(resumed.update).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      mailbox: [expect.objectContaining({ id: mail.id, message: { kind: 'plaintext', text: 'A dependency is ready.' } })],
    }));
    expect(mail.status).toBe('accepted');
  });

  it('returns one spawn receipt for the same operation and rejects a reused path for another assignment', async () => {
    const f = await fixture();
    const payload = { caller: ROOT, source: { subagent: { thread_spawn: { parent_thread_id: ROOT, agent_path: '/root/prover' } } },
      bootstrap: { sessionId: ROOT, threadId: null, config: { cwd: '/lead' } },
      input: { kind: 'message', mode: 'triggerTurn', message: { kind: 'plaintext', text: 'Profiles: prover\nProve the helper.' } }, startOptions: {} };
    vi.mocked(f.lifecycle.spawn).mockImplementationOnce(async request => {
      const worker = member('prover', request.threadId);
      worker.native!.spawnOperationId = request.operationId;
      worker.native!.spawnRequestDigest = request.requestDigest;
      worker.native!.submissionId = 'actual-submission';
      f.archive.workers.push(worker);
      return { agent: worker.native!.agent!, configSnapshot: worker.native!.configSnapshot!, submissionId: 'actual-submission' };
    });
    const accepted = await f.call('spawn', payload, 'lead', f.root, 'spawn-accepted');
    expect(await f.call('spawn', payload, 'lead', f.root, 'spawn-accepted')).toEqual(accepted);
    // Recover the acceptance-before-parent-receipt save window from the fixed child binding.
    const archive = structuredClone(f.archive);
    archive.operations = [];
    const recovered = new AgentTeamNativeControl(archive, f.lifecycle, f.save), root = connection();
    const call = (operation: string, operationId: string, payload: Json) => recovered.options('lead').request({
      version: 1, sessionId: ROOT, threadId: ROOT, operation, operationId, payload,
    }, root, { signal: new AbortController().signal });
    await call('attach', 'recovered-attach', { threadId: ROOT, sessionId: ROOT });
    await expect(call('spawn', 'spawn-accepted', { ...payload, startOptions: { parentTurnId: 'different-task-lineage' } }))
      .rejects.toThrow('call_changed');
    expect(await call('spawn', 'spawn-accepted', payload)).toEqual(accepted);
    await expect(call('spawn', 'another-spawn', payload)).rejects.toThrow('agent_exists');
    expect(f.lifecycle.spawn).toHaveBeenCalledTimes(1);
  });

  it('makes native transport operations unavailable through the mathematical dynamic tool', () => {
    const tool = agentTeamToolDefinition('lead');
    const operations = (tool.inputSchema.properties as Json).operation.enum;
    for (const operation of ['spawn', 'assign', 'message', 'poll', 'wait', 'stop', 'resume', 'amend', 'cancel', 'coordinate', 'publish', 'budget', 'progress']) {
      expect(operations).not.toContain(operation);
      expect(agentTeamOperationAllowed('lead', operation)).toBe(false);
    }
    expect(operations).toEqual(['finish', 'history', 'inspect', 'inspect-research', 'adopt', 'retire_route', 'route_summary']);
    const memberTool = agentTeamToolDefinition('analyst');
    expect((memberTool.inputSchema.properties as Json).operation.enum).toEqual(['yield', 'history', 'inspect', 'inspect-research', 'submit', 'route_summary']);
    expect(agentTeamInstructions({ id: 'lead', role: 'lead' }, 4)).toContain('native collaboration tools');
    expect(agentTeamInstructions({ id: 'lead', role: 'lead' }, 4)).not.toContain('Built-in spawn/fork is disabled');
  });
});
