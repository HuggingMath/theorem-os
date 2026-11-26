import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCodexMathSession, type MathAgentSession } from '../src/runtime/codexSession';
import { readMathAgentSkill } from '../src/runtime/codexSkills';
import type { ModelRequestGate } from '../src/runtime/modelRequest';
import type { NativeResearchAgent } from '../src/runtime/nativeDelegation';

const relay = vi.hoisted(() => ({ close: vi.fn(async () => {}), gate: undefined as ModelRequestGate | undefined }));
vi.mock('../src/runtime/formalizationRelay', () => ({ startFormalizationRelay: async (options: { requestGate?: ModelRequestGate }) => {
  relay.gate = options.requestGate; return ({
  close: relay.close, baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'disposable-fixture-only',
}); } }));

const peer = String.raw`
const fs=require('node:fs'),path=require('node:path'),readline=require('node:readline');
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
let child=0,parentTurn,callback=100;
const finish=(status='completed')=>{
 send({method:'item/completed',params:{threadId:'parent',turnId:parentTurn,item:{type:'agentMessage',id:'response',text:'Saved research.'}}});
 send({method:'turn/completed',params:{threadId:'parent',turn:{id:parentTurn,status}}});
};
readline.createInterface({input:process.stdin}).on('line',line=>{
 const c=JSON.parse(line),p=c.params||{},reply=result=>send({id:c.id,result});
 fs.appendFileSync(process.env.TRACE,JSON.stringify(c)+'\n');
 if(c.method==='initialize')return reply({});
 if(c.method==='skills/list')return reply({data:[{cwd:p.cwds[0],errors:[],skills:[{name:'fixture',enabled:true,path:process.env.SKILL}]}]});
 if(!c.method){
  if(c.id===100){
   if(process.env.MODE==='duplicate') {callback=101;return send({id:101,method:'item/tool/call',params:{threadId:'parent',turnId:parentTurn,callId:'investigate',namespace:null,tool:'theoremos_investigate',arguments:{questions:['Read local sources.','Check a bounded argument.']}}});}
   return finish();
  }
  if(c.id===101)return finish();
 }
 if(c.method==='thread/start'||c.method==='thread/resume'){
  const turns=c.method==='thread/resume'&&process.env.MODE==='long-resume'&&!p.excludeTurns
   ? [{id:'saved-turn',items:[{type:'agentMessage',text:'x'.repeat(8*1024*1024)}]}] : [];
  return reply({thread:{id:p.permissions==='math-investigator'?'child-'+(++child):'parent',turns},model:'fixture-model',reasoningEffort:'high',modelProvider:'sub2api',approvalPolicy:'never',activePermissionProfile:{id:p.permissions==='math-investigator'?(process.env.MODE==='wrong-permission'?'math-worker':'math-investigator'):'math-worker'}});
 }
 if(c.method==='thread/archive')return process.env.MODE==='archive-error'?send({id:c.id,error:{code:-32603}}):reply({});
 if(c.method==='turn/interrupt'){reply({});return finish('interrupted');}
 if(c.method==='turn/start'){
  const turn=p.clientUserMessageId;reply({turn:{id:turn}});
  if(p.threadId!=='parent'){
   fs.writeFileSync(process.env.CHILD_READY,p.threadId);
   if(process.env.MODE==='waiting')return;
   send({method:'thread/tokenUsage/updated',params:{threadId:p.threadId,turnId:turn,tokenUsage:{total:{totalTokens:7}}}});
   send({method:'item/completed',params:{threadId:p.threadId,turnId:turn,item:{type:'agentMessage',id:'response',text:'Advisory '+p.threadId}}});
   return send({method:'turn/completed',params:{threadId:p.threadId,turn:{id:turn,status:'completed'}}});
  }
  parentTurn=turn;
  if(p.input[0].text==='delegate'){
   send({id:100,method:'item/tool/call',params:{threadId:'parent',turnId:turn,callId:'investigate',namespace:null,tool:'theoremos_investigate',arguments:{questions:['Read local sources.','Check a bounded argument.']}}});
   if(process.env.MODE==='parent-early')finish();
   return;
  }
  return finish();
 }
 if(c.method==='thread/compact/start'){
  reply({});
  const turnId = 'compact-turn';
  const notify = (method, params) => send({ method, params: { threadId: 'parent', ...params } });
  const release = path.join(path.dirname(process.env.TRACE), 'compact-release');
  const timer = setInterval(() => {
   if (!fs.existsSync(release)) return;
   clearInterval(timer);
   notify('turn/completed', { turn: { id: turnId, status: fs.readFileSync(release, 'utf8') } });
  }, 5);
  notify('turn/started', { turn: { id: turnId, status: 'inProgress' } });
  notify('turn/completed', { turn: { id: 'older-turn', status: 'failed' } });
  notify('thread/compacted', {});
  notify('item/completed', {
   turnId: process.env.MODE === 'wrong-summary' ? 'older-turn' : turnId,
   item: { type: 'contextCompaction', id: 'compacted' },
  });
 }
});`;

describe('native delegation availability and compaction', () => {
  let root: string, profile: string, executable: string, skill: ReturnType<typeof readMathAgentSkill>;
  let session: MathAgentSession | undefined;
  beforeEach(() => {
    root=fs.mkdtempSync(path.join(os.tmpdir(),'native-investigation-test-'));
    profile=path.join(root,'profile');fs.mkdirSync(profile);
    fs.writeFileSync(path.join(profile,'config.toml'),'model_provider="sub2api"\n[model_providers.sub2api]\nbase_url="http://127.0.0.1:1/v1"\nwire_api="responses"\n');
    const directory=path.join(root,'.agents/skills/fixture');fs.mkdirSync(directory,{recursive:true});
    fs.writeFileSync(path.join(directory,'SKILL.md'),'---\nname: fixture\ndescription: Fixed research methods.\n---\nRead the original question.\n');
    skill=readMathAgentSkill(path.join(directory,'SKILL.md'));
    executable=path.join(root,'peer');fs.writeFileSync(executable,'#!'+process.execPath+'\n'+peer,{mode:0o700});
    relay.close.mockClear();
  });
  afterEach(async()=>{await session?.close();session=undefined;fs.rmSync(root,{recursive:true,force:true});});
  const options=()=>({executable,profile,workspace:root,model:'fixture-model',effort:'high',skills:[skill],
    instructions:'Fixed problem.',onUsage:vi.fn(),requestGate:()=>({allowed:true as const,settle:()=>{}}),
    environment:{PATH:process.env.PATH,SKILL:skill.path,TRACE:path.join(root,'trace'),CHILD_READY:path.join(root,'child-ready')}});

  const trace=()=>fs.readFileSync(path.join(root,'trace'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  const delegated=(mode='normal',onNativeAgent=(agent:NativeResearchAgent)=>{})=>({...options(),delegation:{mode:'read-only' as const,maxAgents:3},
    onNativeAgent,environment:{...options().environment,MODE:mode}});

  it('dispatches independent named read-only threads through one native tool and archives before returning',async()=>{
    const observations:NativeResearchAgent[]=[];
    const configured=delegated('normal',agent=>observations.push(agent));
    session=await createCodexMathSession(configured);
    expect(await session.run('delegate','one',root,()=>{})).toBe('completed');
    const calls=trace(),start=calls.find(c=>c.method==='thread/start');
    expect(calls.find(c=>c.method==='initialize').params.capabilities).toEqual({experimentalApi:true});
    expect(start.params.dynamicTools[0].name).toBe('theoremos_investigate');
    expect(start.params.config['agents.enabled']).toBe(false);
    const children=calls.filter(c=>c.method==='thread/start'&&c.params.permissions==='math-investigator');
    expect(children).toHaveLength(2);
    expect(children.every(c=>!c.params.dynamicTools&&!c.params.sandbox)).toBe(true);
    expect(children[0].params.config['permissions.math-investigator.filesystem'][root]).toBe('read');
    expect(children[0].params.config['permissions.math-investigator.network.enabled']).toBe(false);
    expect(calls.filter(c=>c.method==='thread/archive')).toHaveLength(2);
    const returned=calls.find(c=>c.id===100&&!c.method);
    expect(returned.result.success).toBe(true);
    expect(JSON.parse(returned.result.contentItems[0].text)).toMatchObject({dispatch:'host-mediated-native-threads',advisory:true});
    expect(observations.some(agent=>agent.status==='completed'&&agent.stoppedAt&&agent.usage?.totalTokens===7)).toBe(true);
    expect(configured.onUsage).not.toHaveBeenCalled();
    expect(await session.stopForFreeze!()).toEqual({status:'stopped'});
  });

  it('does not execute a duplicate native call twice',async()=>{
    session=await createCodexMathSession(delegated('duplicate'));
    expect(await session.run('delegate','one',root,()=>{})).toBe('completed');
    expect(trace().filter(c=>c.method==='thread/start'&&c.params.permissions==='math-investigator')).toHaveLength(2);
  });

  it.each(['wrong-permission','archive-error'])('stops the whole tree after %s instead of returning unsafe evidence',async mode=>{
    session=await createCodexMathSession(delegated(mode));
    await expect(session.run('delegate','one',root,()=>{})).rejects.toThrow(/math_native_investigation|math_codex_transport/u);
    if(mode==='wrong-permission')expect(trace().filter(c=>c.method==='turn/start'&&c.params.threadId!=='parent')).toHaveLength(0);
    expect(await session.stopForFreeze!()).toEqual({status:'stopped'});
  });

  it('cancels active investigators and confirms the entire owned process group stopped',async()=>{
    const observations:NativeResearchAgent[]=[];
    session=await createCodexMathSession(delegated('waiting',agent=>observations.push(agent)));
    const running=session.run('delegate','one',root,()=>{});void running.catch(()=>{});
    await vi.waitFor(()=>expect(fs.existsSync(path.join(root,'child-ready'))).toBe(true));
    const identity={requestId:'child-request',threadId:fs.readFileSync(path.join(root,'child-ready'),'utf8')};
    expect(relay.gate!(identity)).toMatchObject({allowed:true});
    expect(await session.stopForFreeze!()).toEqual({status:'unconfirmed',reason:'turn-not-settled'});
    await session.interrupt();
    await expect(running).rejects.toThrow(/math_codex_transport/u);
    expect(await session.stopForFreeze!()).toEqual({status:'stopped'});
    expect(observations.filter(agent=>agent.stoppedAt).length).toBeGreaterThanOrEqual(2);
    expect(relay.gate!(identity)).toMatchObject({allowed:false});
  });

  it('restores the persisted native tool on resume without creating replacement tools or children',async()=>{
    session=await createCodexMathSession({...delegated(),threadId:'parent'});
    expect(await session.run('delegate','one',root,()=>{})).toBe('completed');
    const resume=trace().find(c=>c.method==='thread/resume');
    expect(resume.params.dynamicTools).toBeUndefined();
    expect(trace().filter(c=>c.method==='thread/start'&&c.params.permissions==='math-investigator')).toHaveLength(2);
  });

  it('resumes a regular metered thread whose history exceeds the stdio frame limit', async () => {
    session = await createCodexMathSession({ ...options(), threadId: 'parent',
      environment: { ...options().environment, MODE: 'long-resume' } });
    expect(session.usageSource).toBe('upstream-requests');
    expect(await session.run('Continue the saved research.', 'next', root, () => {})).toBe('completed');
  });

  it('preserves a configured checkpoint result while stopping active child threads',async()=>{
    session=await createCodexMathSession({...delegated('waiting'),turnTimeoutMs:75});
    expect(await session.run('delegate','one',root,()=>{})).toBe('checkpoint');
    expect(await session.stopForFreeze!()).toEqual({status:'stopped'});
  });

  it('rejects delegation when no metered provider gate exists',async()=>{
    await expect(createCodexMathSession({...options(),requestGate:undefined,delegation:{mode:'read-only',maxAgents:2}}))
      .rejects.toThrow('math_native_delegation_requires_skill_and_metered_relay');
    expect(fs.existsSync(path.join(root,'trace'))).toBe(false);
  });

  it.each([
    ['matching-summary','completed',undefined],
    ['matching-summary','failed','math_codex_compaction_failed'],
    ['wrong-summary','completed','math_codex_compaction_missing_summary'],
  ])('settles ordinary compaction using the matching terminal turn (%s, %s)', async (mode, status, error) => {
    const onItem = vi.fn();
    session = await createCodexMathSession({ ...options(), onItem, environment: { ...options().environment, MODE: mode } });
    expect(await session.run('Initial research.', 'one', root, () => {})).toBe('completed');
    const compact = session.compact!();
    void compact.catch(() => {});
    try {
      await vi.waitFor(() => expect(onItem).toHaveBeenCalledWith('completed',
        expect.objectContaining({ type: 'contextCompaction' }), expect.anything()));
      await expect(session.run('Overlapping.', 'overlap', root, () => {})).rejects.toThrow('math_codex_turn_already_running');
    } finally {
      fs.writeFileSync(path.join(root, 'compact-release'), status);
    }
    if (error) await expect(compact).rejects.toThrow(error);
    else {
      await compact;
      expect(session.threadId).toBe('parent');
      expect(await session.run('Continue from preserved sources.', 'two', root, () => {})).toBe('completed');
    }
  });

});
