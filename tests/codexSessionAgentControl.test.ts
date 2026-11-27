import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCodexMathSession } from '../src/runtime/codexSession';
import type { MathAgentOptions, MathAgentSession } from '../src/runtime/agentSession';
import type { NativeAgentControlOptions } from '../src/runtime/nativeAgentControl';
import { nativeAgentControlModelCatalog } from '../src/runtime/nativeAgentControl';
import { readMathAgentSkill } from '../src/runtime/agentSkills';
import { deferred } from './helpers/async';

const fixture = String.raw`
const fs = require('node:fs'), path = require('node:path'), readline = require('node:readline');
const directory = process.env.CODEX_HOME;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let start, settings, threadId, counter = 0, planningTurn;
const host = (operation, id, extra = {}) => send({id,method:'theoremos/agentControl/request',params:{version:1,
  sessionId:'root-id',threadId,operationId:'operation-'+id,operation,payload:{threadId,sessionId:'root-id',...extra}}});
readline.createInterface({input:process.stdin}).on('line', line => {
  const call = JSON.parse(line);
  fs.appendFileSync(path.join(directory,'calls.jsonl'), JSON.stringify(call)+'\n');
  const reply = result => send({id:call.id,result});
  if (call.id === 'invalid-plan-tool') {
    send({method:'item/completed',params:{threadId,turnId:planningTurn.id,item:{id:'invalid',type:'dynamicToolCall',
      tool:'theoremos_team',arguments:null,success:call.result.success}}});
    return send({id:'plan-tool',method:'item/tool/call',params:{threadId,turnId:planningTurn.id,
      tool:'theoremos_team',callId:'publish',arguments:{operation:'publish_plan'}}});
  }
  if (call.id === 'plan-tool') {
    send({method:'item/completed',params:{threadId,turnId:planningTurn.id,item:{id:'publish',type:'dynamicToolCall',
      tool:'theoremos_team',arguments:{operation:'publish_plan'},success:call.result.success}}});
    return;
  }
  if (call.id === 'attach') {
    fs.writeFileSync(path.join(directory,'attach.json'), JSON.stringify(call));
    const turns = process.env.LONG_RESUME_HISTORY && !settings.excludeTurns
      ? [{id:'old-turn', items:[{type:'agentMessage', text:'x'.repeat(8 * 1024 * 1024)}]}] : [];
    return send({id:start.id,result:{thread:{id:threadId,turns},model:settings.model,approvalPolicy:'never',
      reasoningEffort:settings.config.model_reasoning_effort,
      activePermissionProfile:start.params.bootstrap ? null : {id:'math-worker'},
      agentControl:{sessionId:'root-id',agent:{threadId},configSnapshot:{model:settings.model,
        fullAccess:Boolean(process.env.BAD_CHILD_PERMISSIONS),permissionProfile:{type:'managed'}}}}});
  }
  if (call.method === 'initialize') return reply({});
  if (call.method === 'theoremos/agentControl/capabilities') return reply({version:process.env.BAD_BACKEND ? 2 : 1,
    backend:'theoremos-host',nativeTools:true,isolatedChildBootstrap:true});
  if (call.method === 'skills/list') return reply({data:[{cwd:settings.cwd,errors:[],skills:[{
    name:'pinned-fixture',path:process.env.FIXTURE_SKILL_PATH,enabled:true}]}]});
  if (['thread/start','thread/resume','theoremos/agentControl/start'].includes(call.method)) {
    start = call; settings = call.params.thread || call.params.resume || call.params;
    threadId = settings.threadId || call.params.bootstrap?.threadId || 'root-id';
    fs.writeFileSync(path.join(directory,'backend-env.json'),JSON.stringify({enabled:process.env.THEOREMOS_HOST_AGENT_CONTROL}));
    if (process.env.THEOREMOS_HOST_AGENT_CONTROL === '1') return host('attach','attach');
    return reply({thread:{id:threadId},model:settings.model,approvalPolicy:'never',
      reasoningEffort:settings.config.model_reasoning_effort,activePermissionProfile:{id:'math-worker'}});
  }
  if (call.method === 'thread/compact/start') {
    const turn = { id:'compact-turn',status:'inProgress' };
    host('admitTurn','compact-admit',{turnId:turn.id});
    send({method:'turn/started',params:{threadId,turn}});
    send({method:'item/completed',params:{threadId,turnId:turn.id,item:{id:'summary',type:'contextCompaction'}}});
    send({method:'turn/completed',params:{threadId,turn:{...turn,status:'completed'}}});
    host('turnFinished','compact-finished',{outcome:{threadId,turnId:turn.id,status:{completed:null}}});
    host('releaseTurn','compact-release',{turnId:turn.id});
    return reply({});
  }
  if (['turn/start','theoremos/agentControl/input'].includes(call.method)) {
    const turn = {id:'native-turn-'+ ++counter,status:'inProgress'};
    const native = process.env.THEOREMOS_HOST_AGENT_CONTROL === '1';
    if (native) host('admitTurn','admit-'+counter,{turnId:turn.id});
    if (process.env.PLAN_TOOL_FIXTURE) {
      planningTurn = turn;
      reply({threadId,submissionId:turn.id,turn,accepted:true});
      return send({id:'invalid-plan-tool',method:'item/tool/call',params:{threadId,turnId:turn.id,
        tool:'theoremos_team',callId:'invalid',arguments:null}});
    }
    if (process.env.HOLD_HOST_CALLBACK) host('recordUsage','usage');
    send({method:'item/completed',params:{threadId,turnId:turn.id,item:{id:'answer',type:'agentMessage',text:'Research saved.'}}});
    send({method:'turn/completed',params:{threadId,turn:{...turn,status:'completed'}}});
    if (native) setImmediate(() => {
      host('turnFinished','finished-'+counter,{outcome:{threadId,turnId:turn.id,status:{completed:'Research saved.'}}});
      host('releaseTurn','released-'+counter,{turnId:turn.id});
    });
    return reply({threadId,submissionId:turn.id,turn,accepted:true});
  }
  if (call.method === 'turn/interrupt' && planningTurn) {
    reply({});
    send({method:'turn/completed',params:{threadId,turn:{...planningTurn,status:'interrupted'}}});
    return host('releaseTurn','release-plan',{turnId:planningTurn.id});
  }
  if (call.method === 'theoremos/agentControl/update') return reply({acceptedSequence:call.params.sequence});
});
`;

describe('native AgentControl stdio integration without model calls', () => {
  let directory: string, options: MathAgentOptions, session: MathAgentSession | undefined;
  let host: NativeAgentControlOptions;
  const calls = () => fs.readFileSync(path.join(directory, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-agent-control-'));
    const executable = path.join(directory, 'codex-fixture');
    fs.writeFileSync(executable, `#!${process.execPath}\n${fixture}`, { mode: 0o700 });
    host = { request: vi.fn(async request => ({ result: { sessionId: request.sessionId,
      ...(request.operation === 'admitTurn' ? { admitted: true } : {}) } })) };
    options = { executable, profile: directory, workspace: directory, model: 'fixture-model', effort: 'high',
      instructions: 'Frozen proof role.', environment: { PATH: process.env.PATH }, onUsage: vi.fn() };
  });

  afterEach(async () => {
    await session?.close(); session = undefined;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('allows a direct provider to correct invalid plan arguments before the successful checkpoint', async () => {
    const workspace = path.join(directory, 'workspace'), profile = path.join(directory, 'profile');
    fs.mkdirSync(workspace); fs.mkdirSync(profile);
    let published = false;
    const requestGate: NonNullable<MathAgentOptions['requestGate']> = () => ({ allowed: true, settle: () => {} });
    requestGate.checkpoint = () => published;
    session = await createCodexMathSession({ ...options, workspace, profile, isolateProcess: true, readOnlyWorkspace: true,
      nativeAgentControl: host, requestGate, turnTimeoutMs: 5000, tools: {
        definitions: [{ name: 'theoremos_team', description: 'Publish initial route', inputSchema: { type: 'object' } }],
        call: async (_tool, args) => {
          if (args === null) return { ok: false, error: 'Expected a plan object' };
          published = true; return { ok: true };
        },
      }, environment: { ...options.environment, PLAN_TOOL_FIXTURE: '1' } });
    expect(session.usageSource).toBe('native-thread-totals');
    expect(await session.run('Publish a plan.', 'task', workspace, () => {})).toBe('checkpoint');
    expect(published).toBe(true);
    expect(await session.stopForFreeze!()).toMatchObject({ status: 'stopped' });
    const rpc = fs.readFileSync(path.join(profile, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(rpc.find(call => call.id === 'invalid-plan-tool')?.result.success).toBe(true);
    expect(rpc.findIndex(call => call.id === 'plan-tool')).toBeLessThan(rpc.findIndex(call => call.method === 'turn/interrupt'));
  });

  it('dispatches factory attach before thread startup returns and enables actual native tools explicitly', async () => {
    session = await createCodexMathSession({ ...options, nativeAgentControl: host });
    expect(host.request).toHaveBeenCalledWith(expect.objectContaining({ operation: 'attach', threadId: 'root-id',
      operationId: 'operation-attach' }), expect.any(Object), expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(session.nativeAgentControl?.info).toEqual(expect.objectContaining({ sessionId: 'root-id' }));
    const start = calls().find(call => call.method === 'thread/start').params;
    expect(start.config).toMatchObject({ 'features.multi_agent': true,
      'features.multi_agent_v2': { enabled: true, root_agent_usage_hint_text: '', subagent_usage_hint_text: '',
        multi_agent_mode_hint_text: expect.stringContaining('Proactively delegate useful complementary work') },
      'features.defer_mailbox_preemption': true, 'skills.include_instructions': false, 'agents.enabled': true });
    expect(session.nativeConfiguration).toEqual({ source: 'thread-start-overrides', overrides: {
      includeSkillInstructions: false, deferMailboxPreemption: true, rootAgentUsageHintText: '', subagentUsageHintText: '',
      multiAgentModeHintText: start.config['features.multi_agent_v2'].multi_agent_mode_hint_text,
    } });
    expect(start.dynamicTools).toBeUndefined();
    expect(await session.nativeAgentControl!.update({ sessionId: 'root-id', threadId: session.threadId, sequence: 4 }))
      .toEqual({ acceptedSequence: 4 });
    expect(await session.run('Work from the fixed source.', 'task', directory, () => {})).toBe('completed');
    expect((await session.stopForFreeze!()).status).toBe('stopped');
  });

  it('creates an idle child then starts its attributed input only with run observers installed', async () => {
    const bootstrap = { version: 1, sessionId: 'root-id', threadId: 'child-id', source: { subagent: {} } };
    const initialInput = { author: '/root', input: { kind: 'message',
      message: { kind: 'plaintext', text: 'Investigate this gap.' }, mode: 'triggerTurn' },
      startOptions: { parentTurnId: 'parent-turn' } };
    session = await createCodexMathSession({ ...options, nativeAgentControl: { ...host, bootstrap, initialInput } });
    expect(calls().some(call => call.method === 'theoremos/agentControl/input')).toBe(false);
    const start = calls().find(call => call.method === 'theoremos/agentControl/start').params;
    expect(start.bootstrap).toMatchObject(bootstrap);
    expect(start.thread).toMatchObject({ cwd: directory, model: 'fixture-model' });
    const onStarted = vi.fn();
    expect(await session.run('Host proof context.', 'task', directory, onStarted)).toBe('completed');
    expect(onStarted).toHaveBeenCalledWith('native-turn-1');
    expect(session.lastCompletedResponse).toEqual({ turnId: 'native-turn-1', text: 'Research saved.' });
    const input = calls().find(call => call.method === 'theoremos/agentControl/input').params;
    expect(input).toMatchObject({ ...initialInput, version: 1, threadId: 'child-id', contextItems: [
      { role: 'user', content: [{ type: 'input_text', text: 'Host proof context.' }] },
    ] });
    expect(calls().some(call => call.method === 'turn/start')).toBe(false);
    expect(await session.run('Continue from saved work.', 'next', directory, () => {})).toBe('completed');
    const next = calls().filter(call => call.method === 'theoremos/agentControl/input').at(-1).params;
    expect(next.input).toEqual({ kind: 'userInput', items: [{ type: 'text', text: 'Continue from saved work.', text_elements: [] }] });
  });

  it.each(['root', 'resumed-root', 'child', 'resumed-child'] as const)('preserves explicit pinned skill dispatch with the global catalog suppressed (%s)', async mode => {
    const isLead = mode === 'root' || mode === 'resumed-root';
    const skillDirectory = path.join(directory, '.agents', 'skills', 'pinned-fixture');
    fs.mkdirSync(skillDirectory, { recursive: true });
    const skillPath = path.join(skillDirectory, 'SKILL.md');
    fs.writeFileSync(skillPath, '---\nname: pinned-fixture\ndescription: Fixed mathematical fixture instructions.\n---\nUse the pinned fixture contract.\n');
    const bootstrap = { version: 1, sessionId: 'root-id', threadId: 'child-id', source: { subagent: {} } };
    const initialInput = { author: '/root', input: { kind: 'message', mode: 'triggerTurn',
      message: { kind: 'plaintext', text: 'Assigned fixture.' } }, startOptions: {} };
    session = await createCodexMathSession({ ...options,
      environment: { ...options.environment, FIXTURE_SKILL_PATH: skillPath },
      skills: [readMathAgentSkill(skillPath)],
      ...(mode.startsWith('resumed-') ? { threadId: isLead ? 'root-id' : 'child-id' } : {}),
      nativeAgentControl: { ...host, ...(isLead ? {} : { bootstrap, initialInput }) },
    });
    expect(await session.run('Read the fixed proof context.', 'task', directory, () => {})).toBe('completed');
    const started = calls().find(call => ['thread/start', 'thread/resume', 'theoremos/agentControl/start'].includes(call.method)).params;
    const settings = started.thread ?? started.resume ?? started;
    expect(settings.config['skills.include_instructions']).toBe(false);
    const delegation = settings.config['features.multi_agent_v2'].multi_agent_mode_hint_text;
    expect(delegation).toContain(isLead
      ? 'You are the Lead of an explicitly requested flat team.'
      : 'You are a member of an explicitly requested flat team.');
    if (!isLead) {
      expect(delegation).toContain('Do not spawn sub-agents');
      expect(delegation).not.toContain('Proactively delegate');
      expect(delegation).toContain('first usable finding, probe result or blocker');
      expect(delegation).toContain('without waiting for a complete proof');
    } else {
      expect(delegation).toContain('concrete gaps with a consumer and first usable result');
      expect(delegation).toContain('instead of competing for the same deliverable');
    }
    expect(calls().some(call => call.method === 'skills/list')).toBe(true);
    const input = calls().find(call => ['turn/start', 'theoremos/agentControl/input'].includes(call.method)).params;
    if (isLead) expect(input.input).toContainEqual({ type: 'skill', name: 'pinned-fixture', path: skillPath });
    else expect(input.contextItems[0].content[0].text).toContain(JSON.stringify(skillPath));
  });

  it('rejects an incompatible executable before dispatching a thread', async () => {
    await expect(createCodexMathSession({ ...options, environment: { ...options.environment, BAD_BACKEND: '1' },
      nativeAgentControl: host })).rejects.toThrow('math_native_agent_control_backend_required');
    expect(calls().some(call => call.method === 'thread/start')).toBe(false);
    expect(host.request).not.toHaveBeenCalled();
  });

  it('requires the native child to report its actual restricted permission intersection', async () => {
    const bound = vi.fn();
    await expect(createCodexMathSession({ ...options, environment: { ...options.environment, BAD_CHILD_PERMISSIONS: '1' },
      nativeAgentControl: { ...host, bound, bootstrap: { version: 1, sessionId: 'root-id', threadId: 'child-id' } },
    })).rejects.toThrow('math_codex_sandbox_profile_mismatch');
    expect(bound).not.toHaveBeenCalled();
    expect(calls().some(call => call.method === 'theoremos/agentControl/input')).toBe(false);
  });

  it('registers the captured child identity before cold resume without replaying fork history', async () => {
    const bootstrap = { version: 1, sessionId: 'root-id', threadId: 'saved-child', initialHistory: 'parent-fork' };
    session = await createCodexMathSession({ ...options, threadId: 'saved-child',
      environment: { ...options.environment, LONG_RESUME_HISTORY: '1' }, nativeAgentControl: {
      ...host, bootstrap, initialInput: { author: '/root', input: { kind: 'message', mode: 'triggerTurn',
        message: { kind: 'plaintext', text: 'Continue the saved child.' } }, startOptions: {} },
    } });
    const start = calls().find(call => call.method === 'theoremos/agentControl/start').params;
    expect(start.bootstrap).toMatchObject(bootstrap);
    expect(start.resume.threadId).toBe('saved-child');
    expect(start.thread).toBeUndefined();
    expect(calls().some(call => call.method === 'thread/resume')).toBe(false);
    expect(await session.run('Current source and feedback.', 'task', directory, () => {})).toBe('completed');
  });

  it('resumes the Lead when the stored history exceeds the stdio frame limit', async () => {
    session = await createCodexMathSession({ ...options, threadId: 'root-id', nativeAgentControl: host,
      environment: { ...options.environment, LONG_RESUME_HISTORY: '1' } });
    expect(session.threadId).toBe('root-id');
    expect(await session.run('Continue the saved proof.', 'task', directory, () => {})).toBe('completed');
  });

  it('keeps resume usage replay for a direct provider with a budget gate', async () => {
    session = await createCodexMathSession({ ...options, threadId: 'root-id', nativeAgentControl: host,
      requestGate: () => ({ allowed: true, settle: () => {} }) });
    const resume = calls().find(call => call.method === 'thread/resume').params;
    expect(resume.excludeTurns).toBeUndefined();
    expect(session.usageSource).toBe('native-thread-totals');
  });

  it('keeps native compaction open until the completed maintenance turn releases the writer', async () => {
    const release = deferred<void>(), reachedRelease = deferred<void>();
    session = await createCodexMathSession({ ...options, nativeAgentControl: { request: async request => {
      if (request.operation === 'releaseTurn' && request.payload.turnId === 'compact-turn') {
        reachedRelease.resolve();
        await release.promise;
      }
      return { result: { admitted: request.operation === 'admitTurn' } };
    } } });
    let settled = false;
    const compact = session.compact!().then(() => { settled = true; });
    try {
      await reachedRelease.promise;
      expect(settled).toBe(false);
      await expect(session.run('Too early.', 'task', directory, () => {})).rejects.toThrow('math_codex_turn_already_running');
    } finally { release.resolve(); await compact; }
    expect(await session.run('Use the compacted context.', 'task', directory, () => {})).toBe('completed');
  });

  it('does not activate a backend through inherited process environment', async () => {
    session = await createCodexMathSession({ ...options, environment: { ...options.environment, THEOREMOS_HOST_AGENT_CONTROL: '1' } });
    expect(session.nativeAgentControl).toBeUndefined();
    expect(calls().some(call => call.method === 'theoremos/agentControl/capabilities')).toBe(false);
    const start = calls().find(call => call.method === 'thread/start').params;
    expect(start.config).not.toHaveProperty('features.multi_agent_v2');
    expect(session.nativeConfiguration?.overrides).not.toHaveProperty('multiAgentModeHintText');
    expect(JSON.parse(fs.readFileSync(path.join(directory, 'backend-env.json'), 'utf8'))).toEqual({});
  });

  it('withholds freeze confirmation until host callbacks settle, and cancels them on writer shutdown', async () => {
    const cancelled = vi.fn();
    host = { request: async (request, _connection, { signal }) => {
      if (request.operation === 'recordUsage') await new Promise<void>(resolve => signal.addEventListener('abort', () => {
        cancelled(); resolve();
      }, { once: true }));
      return { result: { sessionId: request.sessionId } };
    } };
    session = await createCodexMathSession({ ...options, nativeAgentControl: host,
      environment: { ...options.environment, HOLD_HOST_CALLBACK: '1' } });
    expect(await session.run('Finish with a pending lifecycle report.', 'task', directory, () => {})).toBe('completed');
    expect(await session.stopForFreeze!()).toEqual({ status: 'unconfirmed', reason: 'turn-not-settled' });
    await session.close();
    expect(cancelled).toHaveBeenCalledOnce();
    expect((await session.stopForFreeze!()).status).toBe('stopped');
  });

  it('waits for the native terminal handoff and guard release before reporting a completed writer', async () => {
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const releasing = new Promise<void>(resolve => { entered = resolve; });
    const request = host.request;
    host = { request: async (...args) => {
      if (args[0].operation === 'releaseTurn') { entered(); await blocked; }
      return request(...args);
    } };
    session = await createCodexMathSession({ ...options, nativeAgentControl: host });
    let completed = false;
    const run = session.run('Save the final research result.', 'task', directory, () => {}).then(result => {
      completed = true; return result;
    });
    await releasing;
    await new Promise<void>(resolve => setImmediate(resolve));
    try { expect(completed).toBe(false); }
    finally { release(); }
    expect(await run).toBe('completed');
    expect((await session.stopForFreeze!()).status).toBe('stopped');
  });

  it('projects only the selected model capability without changing provider catalog bytes', () => {
    const file = path.join(directory, 'models.json');
    const source = JSON.stringify({ models: [{ slug: 'fixture-model', multi_agent_version: null, custom: 'retained' },
      { slug: 'other', multi_agent_version: null }] });
    fs.writeFileSync(file, source);
    const projected = nativeAgentControlModelCatalog(file, 'fixture-model', path.join(directory, 'runtime'));
    expect(fs.readFileSync(file, 'utf8')).toBe(source);
    expect(JSON.parse(fs.readFileSync(projected, 'utf8'))).toEqual({ models: [
      { slug: 'fixture-model', multi_agent_version: 'v2', custom: 'retained' }, { slug: 'other', multi_agent_version: null },
    ] });
    expect(() => nativeAgentControlModelCatalog(file, 'missing', path.join(directory, 'runtime')))
      .toThrow('math_native_agent_control_model_missing');
  });
});
