import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCodexMathSession, type MathAgentSession } from '../src/runtime/codexSession';
import { readMathAgentSkill } from '../src/runtime/codexSkills';
import type { ModelRequestGate } from '../src/runtime/modelRequest';

const relay = vi.hoisted(() => ({ close: vi.fn(async () => {}), gate: undefined as ModelRequestGate | undefined }));
vi.mock('../src/runtime/formalizationRelay', () => ({ startFormalizationRelay: async (options: { requestGate?: ModelRequestGate }) => {
  relay.gate = options.requestGate; return ({
  close: relay.close, baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'disposable-fixture-only',
}); } }));

const peer = String.raw`
const fs=require('node:fs'),readline=require('node:readline');
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const c=JSON.parse(line),p=c.params||{},reply=result=>send({id:c.id,result});
 fs.appendFileSync(process.env.TRACE,JSON.stringify(c)+'\n');
 if(c.method==='initialize')return reply({});
 if(c.method==='skills/list')return reply({data:[{cwd:p.cwds[0],errors:[],skills:[{name:'fixture',enabled:true,path:process.env.SKILL}]}]});
 if(c.method==='thread/start'||c.method==='thread/resume')return reply({thread:{id:'parent'},model:'fixture-model',reasoningEffort:'high',modelProvider:'sub2api',approvalPolicy:'never',activePermissionProfile:{id:'math-worker'}});
 if(c.method==='turn/start'){
  const turn=p.clientUserMessageId;reply({turn:{id:turn}});
  send({method:'item/completed',params:{threadId:'parent',turnId:turn,item:{type:'agentMessage',id:'response',text:'Saved research.'}}});
  return send({method:'turn/completed',params:{threadId:'parent',turn:{id:turn,status:'completed'}}});
 }
 if(c.method==='thread/compact/start'){
  reply({});
  return setTimeout(()=>send({method:'item/completed',params:{threadId:'parent',turnId:'compact-turn',item:{type:'contextCompaction',id:'compacted'}}}),40);
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
    environment:{PATH:process.env.PATH,SKILL:skill.path,TRACE:path.join(root,'trace')}});

  it('rejects unsupported native read-only children before opening a provider or native process',async()=>{
    relay.gate=undefined;
    await expect(createCodexMathSession({...options(),delegation:{mode:'read-only',maxAgents:2}}))
      .rejects.toThrow('math_native_read_only_delegation_unsupported');
    expect(relay.gate).toBeUndefined();
    expect(fs.existsSync(path.join(root,'trace'))).toBe(false);
  });

  it('rejects delegation when no metered provider gate exists',async()=>{
    await expect(createCodexMathSession({...options(),requestGate:undefined,delegation:{mode:'read-only',maxAgents:2}}))
      .rejects.toThrow('math_native_delegation_requires_skill_and_metered_relay');
    expect(fs.existsSync(path.join(root,'trace'))).toBe(false);
  });

  it('waits for native compaction completion, excludes overlapping turns and continues the same thread',async()=>{
    session=await createCodexMathSession({...options(),environment:{...options().environment,MODE:'compact'}});
    expect(await session.run('Initial research.','one',root,()=>{})).toBe('completed');
    let completed=false;const compact=session.compact!().then(()=>{completed=true;});
    await expect(session.run('Overlapping.','overlap',root,()=>{})).rejects.toThrow('math_codex_turn_already_running');
    expect(completed).toBe(false);await compact;expect(completed).toBe(true);
    expect(await session.run('Continue from preserved sources.','two',root,()=>{})).toBe('completed');
  });

});
