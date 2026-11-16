import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { buildSync } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MathAgentToolDispatcher, type MathAgentTools } from '../src/runtime/agentTeamTools';
import { createCodexMathSession, type MathAgentSession } from '../src/runtime/codexSession';
import { confirmHarnessProcessStopped, type HarnessProcessIdentity } from '../src/runtime/harnessProcess';

const definitions = [{ name: 'theoremos_team', description: 'Manage isolated research workers.',
  inputSchema: { type: 'object', properties: { action: { type: 'string' } }, required: ['action'] } }];
const request = (callId: string, args: unknown = { action: 'status' }) => ({
  threadId: 'parent', turnId: 'one', callId, namespace: null, tool: 'theoremos_team', arguments: args,
});
const failure = (result: Record<string, unknown>) => (result.contentItems as { text: string }[])[0].text;

describe('turn-scoped host tools', () => {
  it('deduplicates one call while allowing independent calls to overlap', async () => {
    const releases: (() => void)[] = [];
    const call = vi.fn(async (_name, args) => { await new Promise<void>(resolve => releases.push(resolve)); return args; });
    const dispatcher = new MathAgentToolDispatcher({ definitions, call }, () => true);
    dispatcher.beginTurn();
    const first = dispatcher.call(request('a')), duplicate = dispatcher.call(request('a'));
    const second = dispatcher.call(request('b'));
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(failure(await dispatcher.call(request('a', { action: 'different' })))).toBe('math_agent_tool_call_mismatch');
    releases.forEach(release => release());
    expect(await first).toEqual(await duplicate);
    expect((await second).success).toBe(true);
    await dispatcher.settled(); expect(dispatcher.busy).toBe(false);
  });

  it('rejects unknown, stale and namespaced operations without calling the host', async () => {
    const call = vi.fn(async () => null);
    const dispatcher = new MathAgentToolDispatcher({ definitions, call }, (thread, turn) => thread === 'parent' && turn === 'one');
    dispatcher.beginTurn();
    expect(failure(await dispatcher.call({ ...request('a'), tool: 'unknown' }))).toBe('math_agent_tool_unknown');
    for (const invalid of [{ threadId: 'other' }, { turnId: 'old' }, { namespace: 'foreign' }, { callId: '' }])
      expect(failure(await dispatcher.call({ ...request('a'), ...invalid }))).toBe('math_agent_tool_not_active');
    expect(call).not.toHaveBeenCalled();
  });

  it('cancels and drains callbacks before admitting another turn or stopping', async () => {
    let cancelled = false;
    const dispatcher = new MathAgentToolDispatcher({ definitions, call: async (_name, _args, { signal }) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { cancelled = true; resolve(); }, { once: true }));
      return 'cancelled';
    } }, () => true);
    dispatcher.beginTurn(); const pending = dispatcher.call(request('a'));
    await Promise.resolve(); expect(dispatcher.busy).toBe(true);
    expect(() => dispatcher.beginTurn()).toThrow('math_agent_tools_unsettled');
    dispatcher.cancel(); await dispatcher.settled();
    expect(cancelled).toBe(true); expect(failure(await pending)).toBe('math_agent_tool_cancelled');
    dispatcher.beginTurn(); dispatcher.stop();
    expect(() => dispatcher.beginTurn()).toThrow('math_agent_tools_unsettled');
  });
});

const peer = String.raw`
const fs=require('node:fs'),readline=require('node:readline');
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
let turn,received=0,expected=1;
const finish=(status='completed')=>{
 send({method:'item/completed',params:{threadId:'parent',turnId:turn,item:{type:'agentMessage',id:'final',text:'Saved research.'}}});
 send({method:'turn/completed',params:{threadId:'parent',turn:{id:turn,status}}});
};
readline.createInterface({input:process.stdin}).on('line',line=>{
 const c=JSON.parse(line),p=c.params||{},reply=result=>send({id:c.id,result});
 fs.appendFileSync(process.env.TRACE,JSON.stringify(c)+'\n');
 if(c.method==='initialize')return reply({});
 if(c.method==='thread/start'||c.method==='thread/resume')return reply({thread:{id:'parent'},model:'fixture',reasoningEffort:'high',approvalPolicy:'never',activePermissionProfile:{id:'math-worker'}});
 if(c.method==='turn/start'){
  turn=p.clientUserMessageId;received=0;expected=process.env.MODE==='parallel'?2:1;
  const call=(id,overrides={})=>send({id,method:'item/tool/call',params:{threadId:'parent',turnId:turn,callId:'call-'+id,namespace:null,tool:'theoremos_team',arguments:{action:'work'},...overrides}});
  call(100,process.env.MODE==='unknown'?{tool:'unknown'}:process.env.MODE==='stale'?{turnId:'old'}:{});
  if(process.env.MODE==='parallel')call(101);
  reply({turn:{id:turn}});
  if(process.env.MODE==='early-completion')setTimeout(()=>finish(),50);
  return;
 }
 if(c.method==='turn/interrupt'){reply({});return finish('interrupted');}
 if(!c.method&&c.id>=100&&++received===expected&&process.env.MODE!=='waiting'&&process.env.MODE!=='early-completion')finish();
});`;

describe('native host-tool bridge', () => {
  let root: string | undefined, session: MathAgentSession | undefined;
  afterEach(async () => { await session?.close(); session = undefined; if (root) fs.rmSync(root, { recursive: true, force: true }); });
  const open = async (call: MathAgentTools['call'], mode = 'normal', resumed = false) => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-team-tools-'));
    const profile = path.join(root, 'profile'); fs.mkdirSync(profile);
    fs.writeFileSync(path.join(profile, 'config.toml'), '');
    const executable = path.join(root, 'peer'); fs.writeFileSync(executable, '#!' + process.execPath + '\n' + peer, { mode: 0o700 });
    session = await createCodexMathSession({ executable, profile, workspace: root, model: 'fixture', effort: 'high',
      instructions: 'Fixed research assignment.', onUsage: () => {}, tools: { definitions, call },
      ...(resumed ? { threadId: 'parent' } : {}), environment: { PATH: process.env.PATH, TRACE: path.join(root, 'trace'), MODE: mode } });
    return session;
  };
  const trace = () => fs.readFileSync(path.join(root!, 'trace'), 'utf8').trim().split('\n').map(line => JSON.parse(line));

  it.each([false, true])('binds tools before turn acknowledgment and preserves native resume=%s', async resumed => {
    const call = vi.fn(async (_name, args) => ({ saved: args }));
    const native = await open(call, 'normal', resumed);
    expect(await native.run('Work.', 'one', root!, () => {})).toBe('completed');
    const calls = trace(), start = calls.find(call => call.method === (resumed ? 'thread/resume' : 'thread/start'));
    expect(calls.find(call => call.method === 'initialize').params.capabilities).toEqual({ experimentalApi: true });
    expect(start.params.config['agents.enabled']).toBe(false);
    expect(start.params.dynamicTools).toEqual(resumed ? undefined : [{ type: 'function', ...definitions[0] }]);
    expect(call).toHaveBeenCalledTimes(1);
    expect(calls.find(call => call.id === 100 && !call.method).result.success).toBe(true);
    expect(await native.stopForFreeze!()).toEqual({ status: 'stopped' });
  });

  it('allows independent tool requests to complete without serializing dispatch', async () => {
    const releases: (() => void)[] = [];
    const native = await open(async () => { await new Promise<void>(resolve => releases.push(resolve)); return { ready: true }; }, 'parallel');
    const running = native.run('Work.', 'one', root!, () => {});
    await vi.waitFor(() => expect(releases).toHaveLength(2)); releases.forEach(release => release());
    expect(await running).toBe('completed');
  });

  it.each(['unknown', 'stale'])('does not dispatch %s calls to the host', async mode => {
    const call = vi.fn(async () => null), native = await open(call, mode);
    expect(await native.run('Work.', 'one', root!, () => {})).toBe('completed');
    expect(call).not.toHaveBeenCalled();
    expect(trace().find(call => call.id === 100 && !call.method).result.success).toBe(false);
  });

  it.each(['interrupt', 'early-completion', 'close'])('cancels pending tools on %s and drains before freezing', async mode => {
    let started = false, cancelled = false;
    const native = await open(async (_name, _args, { signal }) => {
      started = true;
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { cancelled = true; resolve(); }, { once: true }));
      return null;
    }, mode === 'early-completion' ? mode : 'waiting');
    const running = native.run('Work.', 'one', root!, () => {}); void running.catch(() => {});
    await vi.waitFor(() => expect(started).toBe(true));
    if (mode === 'early-completion') expect(await running).toBe('completed');
    else if (mode === 'interrupt') { await native.interrupt(); expect(await running).toBe('interrupted'); }
    else { await native.close(); await expect(running).rejects.toThrow('math_codex_transport'); }
    expect(cancelled).toBe(true); expect(await native.stopForFreeze!()).toEqual({ status: 'stopped' });
  });
});

describe('isolated native writer process lifetime', () => {
  let root: string | undefined, owner: ChildProcess | undefined;
  afterEach(async () => {
    if (owner && owner.exitCode === null && owner.signalCode === null) { const exit = once(owner, 'exit'); owner.kill('SIGKILL'); await exit; }
    if (root) {
      const identityFile = path.join(root, 'identity.json');
      if (fs.existsSync(identityFile)) {
        const identity = JSON.parse(fs.readFileSync(identityFile, 'utf8')) as HarnessProcessIdentity;
        if (confirmHarnessProcessStopped(identity).status !== 'stopped') {
          try { process.kill(identity.pid, 'SIGKILL'); } catch { /* This owned namespace may already have stopped. */ }
        }
        await vi.waitFor(() => expect(confirmHarnessProcessStopped(identity)).toEqual({ status: 'stopped' }));
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['SIGKILL', 'close'])('records namespace-init identity and stops detached background writers after %s', async mode => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-writer-lifetime-')));
    const workspace = path.join(root, 'work'), profile = path.join(root, 'profile');
    fs.mkdirSync(workspace); fs.mkdirSync(profile); fs.writeFileSync(path.join(profile, 'config.toml'), '');
    const executable = path.join(root, 'peer');
    const peerSource = String.raw`
const fs=require('node:fs'), cp=require('node:child_process'), readline=require('node:readline');
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
readline.createInterface({input:process.stdin}).on('line', line=>{
 const c=JSON.parse(line),p=c.params||{},reply=result=>send({id:c.id,result});
 if(c.method==='initialize')return reply({});
 if(c.method==='thread/start')return reply({thread:{id:'writer'},model:'fixture',reasoningEffort:'high',approvalPolicy:'never',activePermissionProfile:{id:'math-worker'}});
 if(c.method==='turn/start'){
  const code='const fs=require("node:fs");setInterval(()=>fs.appendFileSync(process.env.COUNTER,"tick\\n"),15);';
  cp.spawn(process.execPath,['-e',code],{detached:true,stdio:'ignore',env:process.env}).unref();
  reply({turn:{id:p.clientUserMessageId}});
  if(process.env.FINISH==='yes')setTimeout(()=>{
   send({method:'item/completed',params:{threadId:'writer',turnId:p.clientUserMessageId,item:{type:'agentMessage',id:'final',text:'Saved proof.'}}});
   send({method:'turn/completed',params:{threadId:'writer',turn:{id:p.clientUserMessageId,status:'completed'}}});
  },100);
 }
});`;
    fs.writeFileSync(executable, '#!' + process.execPath + '\n' + peerSource, { mode: 0o700 });
    const ownerFile = path.join(root, 'owner.mjs');
    buildSync({ stdin: { loader: 'ts', resolveDir: process.cwd(), contents: `
import fs from 'node:fs';
import { createCodexMathSession } from './src/runtime/codexSession';
const options=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const session=await createCodexMathSession({...options,isolateProcess:true,onUsage:()=>{}});
fs.writeFileSync(process.argv[3],JSON.stringify(session.processIdentity));
await session.run('Save proof sources.','writer-turn',options.workspace,()=>{});
fs.writeFileSync(process.argv[3]+'.stopped',JSON.stringify(await session.stopForFreeze()));
` }, outfile: ownerFile, bundle: true, platform: 'node', format: 'esm', loader: { '.py': 'text', '.lean': 'text' },
      banner: { js: "import { createRequire } from 'node:module'; const require=createRequire(import.meta.url);" } });
    const config = path.join(root, 'config.json'), counter = path.join(workspace, 'counter');
    fs.writeFileSync(config, JSON.stringify({ executable, profile, workspace, model: 'fixture', effort: 'high', instructions: 'Fixed original statement.',
      environment: { PATH: process.env.PATH, COUNTER: counter, FINISH: mode === 'close' ? 'yes' : 'no' } }));
    owner = spawn(process.execPath, [ownerFile, config, path.join(root, 'identity.json')], { stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = ''; owner.stderr!.on('data', chunk => { errors += chunk; });
    await vi.waitFor(() => {
      if (owner!.exitCode !== null && owner!.exitCode !== 0) throw new Error(errors);
      expect(fs.existsSync(counter)).toBe(true);
    }, { timeout: 10_000 });
    const identity = JSON.parse(fs.readFileSync(path.join(root, 'identity.json'), 'utf8')) as HarnessProcessIdentity;
    if (mode === 'SIGKILL') {
      expect(confirmHarnessProcessStopped(identity).status).toBe('unconfirmed');
      const exited = once(owner, 'exit'); owner.kill('SIGKILL'); await exited;
    } else {
      await vi.waitFor(() => expect(fs.existsSync(path.join(root!, 'identity.json.stopped'))).toBe(true), { timeout: 8000 });
      expect(JSON.parse(fs.readFileSync(path.join(root!, 'identity.json.stopped'), 'utf8'))).toEqual({ status: 'stopped' });
    }
    await vi.waitFor(() => expect(confirmHarnessProcessStopped(identity)).toEqual({ status: 'stopped' }));
    const saved = fs.readFileSync(counter, 'utf8');
    await new Promise(resolve => setTimeout(resolve, 120));
    expect(fs.readFileSync(counter, 'utf8')).toBe(saved);
    expect(confirmHarnessProcessStopped({ ...identity, startTime: 'invalid' }).status).toBe('unconfirmed');
  }, 15_000);
});
