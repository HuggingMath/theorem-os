import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { readMathAgentSkill } from '../src/runtime/agentSkills';
import type { MathAgentOptions, MathAgentSession } from '../src/runtime/agentSession';
import { createCodexMathSession } from '../src/runtime/codexSession';
import { confirmHarnessProcessStopped } from '../src/runtime/harnessProcess';
import { readSolverRunState, writeSolverRunState } from '../src/solver/archive';
import { AgentResearchTeam } from '../src/solver/agentTeam';
import { directSolverModules } from '../src/solver/modules';
import { git, readSolverProblem } from '../src/solver/problem';
import { prepareResearchSkill, researchSkillIdentity } from '../src/solver/researchSkill';
import { deferred } from './helpers/async';
import { solverState } from './helpers/solver';

// This local protocol peer exercises the real tool dispatcher and native notification routing.
// It never contacts a model. The host writes a gate only after each turn has actually started.
const peer = String.raw`
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
const workspace = process.cwd(), actor = process.env.DEEPSCIENTIST_MATH_WORKER_ID;
const scratch = path.join(workspace, '.scratch'); fs.mkdirSync(scratch, { recursive: true });
const trace = value => fs.appendFileSync(path.join(scratch, 'native-messaging.jsonl'), JSON.stringify(value) + '\n');
const send = value => { trace({ direction: 'peer', ...value }); process.stdout.write(JSON.stringify(value) + '\n'); };
let threadId = 'messaging-' + actor, turnId, nextCall = 10000, gate, settled = true;
const finish = () => {
  if (settled) return; settled = true; clearInterval(gate);
  send({ method: 'item/completed', params: { threadId, turnId,
    item: { type: 'agentMessage', id: 'final', text: 'Advisory messages saved; writer released.' } } });
  send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'interrupted' } } });
};
const stream = readline.createInterface({ input: process.stdin });
stream.on('close', () => { clearInterval(gate); process.exit(0); });
stream.on('line', line => {
  const call = JSON.parse(line), params = call.params || {};
  trace({ direction: 'host', ...call });
  const reply = result => send({ id: call.id, result });
  if (call.method === 'initialize') return reply({});
  if (call.method === 'thread/start' || call.method === 'thread/resume') {
    threadId = params.threadId || threadId;
    return reply({ thread: { id: threadId }, model: params.model, reasoningEffort: params.config.model_reasoning_effort,
      approvalPolicy: 'never', activePermissionProfile: { id: 'math-worker' } });
  }
  if (call.method === 'skills/list') return reply({ data: [{ cwd: workspace, errors: [], skills: [{
    name: 'theoremos-research', enabled: true, path: path.join(workspace, '.agents/skills/theoremos-research/SKILL.md'),
  }] }] });
  if (call.method === 'turn/start') {
    turnId = params.clientUserMessageId; settled = false; reply({ turn: { id: turnId } });
    fs.writeFileSync(path.join(scratch, 'native-messaging-started.json'), JSON.stringify({ threadId, turnId }));
    gate = setInterval(() => {
      const file = path.join(scratch, 'native-messaging-commands.json');
      if (!fs.existsSync(file)) return;
      clearInterval(gate);
      for (const operation of JSON.parse(fs.readFileSync(file, 'utf8'))) {
        const id = ++nextCall;
        send({ id, method: 'item/tool/call', params: { threadId, turnId, callId: 'message-' + id,
          namespace: null, tool: 'theoremos_team', arguments: operation } });
      }
    }, 10);
    return;
  }
  if (call.method === 'turn/steer') return reply({});
  if (call.method === 'turn/interrupt') { reply({}); finish(); return; }
  if (call.id !== undefined && call.method) reply({});
});
`;

async function bounded<T>(operation: Promise<T>, milliseconds: number, reason: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(reason)), milliseconds);
    })]);
  } finally { clearTimeout(timer!); }
}

const fixtures: ReturnType<typeof fixture>[] = [];
function fixture(synchronizeMessages = false) {
  const temporaryRoot = process.env.TMPDIR || '/data/lzh/default-storage/tmp';
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(temporaryRoot, 'agent-team-messaging-')));
  const root = path.resolve('.'), receipt = bootstrapLeanTask(path.join(directory, 'primary'), {
    source: 'namespace Messaging\ntheorem original : True := by sorry\nend Messaging\n',
    task: 'Exercise advisory messages while preserving independent proof acceptance.',
  });
  const problem = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath), worktree = path.join(directory, 'lead');
  git(receipt.workspaceRoot, ['worktree', 'add', '--quiet', '--detach', worktree, problem.baseCommit]);
  const identity = researchSkillIdentity(readMathAgentSkill(path.join(root, 'skills/theoremos-research/SKILL.md')));
  const state = solverState(problem, worktree, { runId: 'native-team-messaging', phase: 'running', model: 'fixture', effort: 'high',
    environmentDigest: mathDigest('native-messaging-environment'), researchMode: 'skill', researchSkillWorkflow: 'full',
    researchSkill: identity, researchDelegation: { mode: 'team', maxAgents: 3 }, workerCount: 1, coordination: 'independent' });
  const skill = prepareResearchSkill(root, worktree, identity, problem);
  const profile = path.join(directory, 'profile'), executable = path.join(directory, 'peer');
  fs.mkdirSync(profile); fs.writeFileSync(path.join(profile, 'config.toml'), '');
  fs.writeFileSync(executable, '#!' + process.execPath + '\n' + peer, { mode: 0o700 });
  const controller = new AbortController(), sessions = new Map<string, MathAgentSession>();
  const messageArrivals = new Set<string>(), bothMessages = deferred();
  controller.signal.addEventListener('abort', () => bothMessages.resolve(), { once: true });
  const deadline = setTimeout(() => controller.abort(new Error('native-messaging-external-deadline')), 15000);
  const modules = { ...directSolverModules, M1: { ...directSolverModules.M1, open: async (options: MathAgentOptions) => {
    const actor = options.environment!.DEEPSCIENTIST_MATH_WORKER_ID!;
    const tools = options.tools!;
    const session = await createCodexMathSession({ ...options, tools: { ...tools, call: async (name, args, context) => {
      // Both real dispatchers must be busy before either cross-member message reaches the
      // manager. Only arrival is controlled; every response still comes from its real tools.
      if (synchronizeMessages && (args as { operation?: string }).operation === 'message') {
        messageArrivals.add(actor); if (messageArrivals.size === 2) bothMessages.resolve();
        await bothMessages.promise;
      }
      return tools.call(name, args, context);
    } } });
    sessions.set(actor, session); return session;
  } } };
  const environment = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` };
  const stateFile = path.join(directory, 'state.json');
  const team = new AgentResearchTeam({ state, root, taskText: 'Exercise message delivery without model calls.',
    leadAccess: { environment, retrievalRoot: path.join(worktree, problem.projectRelative), researchSkill: skill },
    modules, executable, profile, signal: controller.signal, maxAgents: 3, maxTurns: 12, maxTurnMs: 10000,
    maxTotalTokens: 0, remainingMs: () => Infinity, save: () => writeSolverRunState(stateFile, state), emit: () => {},
    exclusiveCheck: operation => operation(),
  });
  let callId = 0;
  const call = (operation: Record<string, unknown>) => team.tools('lead').call('theoremos_team', operation, {
    callId: `lead-${++callId}`, threadId: 'lead-thread', turnId: 'lead-turn', signal: controller.signal,
  }) as Promise<Record<string, any>>;
  const worker = (id: string) => team.archive.workers.find(item => item.id === id)!;
  const trace = (id: string): Record<string, any>[] => {
    const file = path.join(worker(id).worktree, '.scratch/native-messaging.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  };
  const start = async (id: string) => {
    expect(await call({ operation: 'spawn', agentId: id, message: `Research independently as ${id}; messages remain advisory.` }))
      .toMatchObject({ ok: true });
    await expect.poll(() => fs.existsSync(path.join(worker(id).worktree, '.scratch/native-messaging-started.json')),
      { timeout: 5000 }).toBe(true);
    expect(sessions.get(id)?.processIdentity).toMatchObject({ schema: 'theorem-os.harness-process-identity.v1' });
    expect(sessions.get(id)?.executionPlan?.harness).toBe('codex');
  };
  const send = (id: string, operations: Record<string, unknown>[]) =>
    fs.writeFileSync(path.join(worker(id).worktree, '.scratch/native-messaging-commands.json'), JSON.stringify(operations));
  const current = { directory, team, state, stateFile, controller, sessions, deadline, call, worker, trace, start, send, messageArrivals };
  fixtures.push(current); return current;
}

afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.controller.abort();
    try {
      await bounded(Promise.allSettled([...f.sessions.values()].map(session => session.close())), 6000, 'native-messaging-close-timeout');
      await bounded(f.team.close(), 6000, 'native-messaging-team-close-timeout');
      for (const session of f.sessions.values()) if (session.processIdentity)
        expect(confirmHarnessProcessStopped(session.processIdentity).status).toBe('stopped');
    } finally { clearTimeout(f.deadline); fs.rmSync(f.directory, { recursive: true, force: true }); }
  }
});

describe.skipIf(process.platform !== 'linux')('Agent team messaging through the real native adapter', () => {
  it('rejects self-messages through the native dispatcher without a notification or blocked stop', async () => {
    const f = fixture();
    await f.call({ operation: 'publish', summary: 'Revision one is the context dispatched to this member.' });
    await f.start('self');
    await f.call({ operation: 'publish', summary: 'Revision two arrives after the member started.' });
    const eventsBefore = [...f.team.archive.events];
    f.send('self', [{ operation: 'message', agentId: 'self', message: 'A self-message must not wait for its own callback.' }]);
    await expect.poll(() => f.trace('self').some(item => item.direction === 'host' && item.id === 10001 && item.result),
      { timeout: 2500 }).toBe(true);
    const response = f.trace('self').find(item => item.direction === 'host' && item.id === 10001)!.result;
    expect(response.success).toBe(true);
    expect(JSON.parse(response.contentItems[0].text)).toMatchObject({ ok: false,
      error: 'math_team_message_self_addressed', from: 'self', to: 'self',
      hint: expect.stringContaining('Use agentId: "lead"') });
    expect(readSolverRunState(f.stateFile).agentTeam!.events).toEqual(eventsBefore);
    expect(await bounded(f.call({ operation: 'stop', agentId: 'self' }), 2500, 'self-message-blocked-stop'))
      .toMatchObject({ ok: true });
    await expect.poll(() => f.team.hasActiveWorkers, { timeout: 5000 }).toBe(false);
    expect(f.worker('self').writerStopUnconfirmed).toBeUndefined();
    expect(f.trace('self').some(item => item.direction === 'host' &&
      ['turn/steer', 'thread/inject_items'].includes(item.method) &&
      JSON.stringify(item.params).includes('A self-message must not wait for its own callback.'))).toBe(false);
  }, 20000);

  it('queues advisory messages in native history while amendments retain turn-bound steering', async () => {
    const f = fixture(); await f.start('member');
    const task = f.worker('member').tasks[0]!;
    await f.call({ operation: 'message', agentId: 'member', message: 'A complementary finding is available.' });
    await expect.poll(() => f.trace('member').filter(item => item.direction === 'host' &&
      item.method === 'thread/inject_items').length, { timeout: 2500 }).toBe(1);
    const injected = f.trace('member').find(item => item.method === 'thread/inject_items')!.params;
    expect(injected).toMatchObject({ threadId: f.worker('member').threadId, items: [{
      type: 'message', role: 'user', content: [{ type: 'input_text', text: expect.stringContaining('Team update (advisory)') }],
    }] });
    expect(injected.items[0].content[0].text).toContain('A complementary finding is available.');
    expect(f.trace('member').filter(item => item.method === 'turn/steer')).toEqual([]);

    await f.call({ operation: 'amend', agentId: 'member', taskId: task.id,
      message: 'Review the dependency interface before further work.', reason: 'The effective task objective changed.' });
    await expect.poll(() => f.trace('member').filter(item => item.direction === 'host' &&
      item.method === 'turn/steer').length, { timeout: 2500 }).toBe(1);
    const steered = f.trace('member').find(item => item.method === 'turn/steer')!.params;
    expect(steered).toMatchObject({ threadId: f.worker('member').threadId, expectedTurnId: task.id });
    expect(JSON.stringify(steered.input)).toContain('Lead assignment amendment (effective objective)');
    expect(JSON.stringify(steered.input)).toContain('Review the dependency interface before further work.');
    expect(f.trace('member').filter(item => item.method === 'turn/start')).toHaveLength(1);
    expect(f.trace('member').filter(item => item.method === 'thread/inject_items')).toHaveLength(1);
  }, 20000);

  it('keeps Lead cancel and stop responsive while two busy native members exchange concurrent messages', async () => {
    const f = fixture(true); await f.start('alpha'); await f.start('beta');
    f.send('alpha', [{ operation: 'message', agentId: 'beta', message: 'Alpha shared its current interface.' }]);
    f.send('beta', [{ operation: 'message', agentId: 'alpha', message: 'Beta shared a complementary observation.' }]);
    await expect.poll(() => f.messageArrivals.size, { timeout: 2500 }).toBe(2);
    await expect.poll(() => f.team.archive.events.some(event => event.kind === 'message'), { timeout: 2500 }).toBe(true);
    const responses = await bounded(Promise.all([
      f.call({ operation: 'cancel', agentId: 'alpha', taskId: f.worker('alpha').tasks[0]!.id, reason: 'The dependency interface changed.' }),
      f.call({ operation: 'stop', agentId: 'beta' }),
    ]), 2500, 'cross-message-blocked-lead-mutations');
    expect(responses.map(response => response.ok)).toEqual([true, true]);
    await expect.poll(() => f.team.hasActiveWorkers, { timeout: 5000 }).toBe(false);
    expect(f.worker('alpha').tasks[0]!.status).toBe('cancelled'); expect(f.worker('beta').status).toBe('stopped');
    expect(f.team.archive.events.filter(event => event.kind === 'message').map(event => [event.from, event.to]))
      .toEqual(expect.arrayContaining([['alpha', 'beta'], ['beta', 'alpha']]));
    expect(f.team.archive.workers.every(worker => !worker.writerStopUnconfirmed && !worker.writerProcess)).toBe(true);
    expect(f.state.check).toBeUndefined();
  }, 20000);

  it('retains a late message to an already closed native session and releases subsequent mutations', async () => {
    const f = fixture(); await f.start('closed');
    await f.call({ operation: 'stop', agentId: 'closed' });
    await expect.poll(() => f.team.hasActiveWorkers, { timeout: 5000 }).toBe(false);
    const closed = f.sessions.get('closed')!;
    expect(await closed.stopForFreeze!()).toEqual({ status: 'stopped' });
    // Simulate a stale session reference during a close boundary, using its real notify method.
    f.team.setLeadSession(closed);
    const responses = await bounded(Promise.all([
      f.team.tools('closed').call('theoremos_team', {
        operation: 'message', agentId: 'lead', message: 'Keep the late notification in the durable inbox.',
      }, { callId: 'closed-late-message', threadId: closed.threadId, turnId: 'closed-turn', signal: f.controller.signal }),
      f.call({ operation: 'publish', summary: 'A later mutation still progresses after native shutdown.' }),
    ]), 2500, 'late-notification-blocked-serial');
    f.team.setLeadSession(undefined);
    expect(responses[0]).toMatchObject({ ok: true, delivery: 'saved-inbox' });
    expect(responses[1]).toMatchObject({ ok: true });
    expect((await f.call({ operation: 'poll' })).events).toContainEqual(expect.objectContaining({
      from: 'closed', to: 'lead', kind: 'message', text: 'Keep the late notification in the durable inbox.',
    }));
    expect(f.trace('closed').some(item => ['turn/steer', 'thread/inject_items'].includes(item.method))).toBe(false);
  }, 20000);
});
