import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCodexMathSession, type MathAgentOptions, type MathAgentSession } from '../src/runtime/codexSession';
import { assertMathAgentSkillsCurrent, readMathAgentSkill } from '../src/runtime/codexSkills';
import { mathBuildSource } from '../src/math/mathBuildManifest';

// A local protocol peer only. It cannot connect to a model or execute model tools.
const peer = String.raw`const fs = require('node:fs'), readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let thread = 'skill-thread';
readline.createInterface({input: process.stdin}).on('line', line => {
  const call = JSON.parse(line), p = call.params || {};
  fs.appendFileSync(process.env.FIXTURE_TRACE, JSON.stringify(call) + '\n');
  const reply = result => send({id:call.id, result});
  if (call.method === 'initialize') return reply({});
  if (call.method === 'thread/start' || call.method === 'thread/resume') {
    thread = p.threadId || thread;
    return reply({thread:{id:thread}, model:p.model, reasoningEffort:p.config.model_reasoning_effort,
      modelProvider:p.config.model_provider, approvalPolicy:'never',activePermissionProfile:{id:'math-worker'}});
  }
  if (call.method === 'skills/list') {
    const mode = process.env.FIXTURE_SKILL_MODE;
    if (mode === 'unsupported') return send({id:call.id,error:{code:-32601,message:'unavailable'}});
    return reply({data:[{cwd:p.cwds[0], errors:mode === 'error' ? [{path:process.env.FIXTURE_SKILL_PATH,message:'invalid'}] : [],
      skills:mode === 'missing' ? [] : [{name:'fixture-research',path:mode === 'wrong-path' ? '/wrong/SKILL.md' : process.env.FIXTURE_SKILL_PATH,
        enabled:mode !== 'disabled',description:'fixture',scope:'repo'}]}]});
  }
  if (call.method === 'turn/start') {
    reply({turn:{id:p.clientUserMessageId}});
    send({method:'item/completed',params:{threadId:thread,turnId:p.clientUserMessageId,
      item:{type:'agentMessage',id:'answer',text:'Completed isolated protocol fixture.'}}});
    return send({method:'turn/completed',params:{threadId:thread,turn:{id:p.clientUserMessageId,status:'completed'}}});
  }
});`;

describe('versioned Codex research skills', () => {
  let root: string, skillFile: string, reference: string, trace: string, executable: string, profile: string;
  let session: MathAgentSession | undefined;
  const calls = () => fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const options = (): MathAgentOptions => ({executable, profile, workspace: root, model:'fixture-model',effort:'high',
    instructions:'Frozen mathematical statement.',onUsage:vi.fn(),
    environment:{PATH:process.env.PATH,FIXTURE_TRACE:trace,FIXTURE_SKILL_PATH:skillFile}});
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-skills-'));
    profile = path.join(root,'profile');fs.mkdirSync(profile);
    fs.writeFileSync(path.join(profile,'config.toml'),'model_provider = "fixture"\n[model_providers.fixture]\nbase_url = "https://fixture.invalid/v1"\nwire_api = "responses"\n');
    const skillDirectory = path.join(root,'.agents','skills','fixture-research');fs.mkdirSync(path.join(skillDirectory,'references'),{recursive:true});
    skillFile = path.join(skillDirectory,'SKILL.md'); reference = path.join(skillDirectory,'references','lemma.md');
    fs.writeFileSync(skillFile,'---\nname: fixture-research\ndescription: Research the frozen fixture.\n---\nRead references/lemma.md as needed.\n');
    fs.writeFileSync(reference,'Keep exact assumptions.\n');
    trace = path.join(root,'calls.jsonl'); executable = path.join(root,'fake-codex');
    fs.writeFileSync(executable,'#!'+process.execPath+'\n'+peer,{mode:0o700});
    vi.stubGlobal('fetch',vi.fn(() => {throw new Error('No provider requests allowed');}));
  });
  afterEach(async () => {await session?.close();session=undefined;vi.unstubAllGlobals();fs.rmSync(root,{recursive:true,force:true});});

  it('pins the whole directory independently of its projection path', () => {
    const native = readMathAgentSkill(skillFile);
    const destination = path.join(root,'other','fixture-research');fs.cpSync(path.dirname(skillFile),destination,{recursive:true});
    expect(readMathAgentSkill(path.join(destination,'SKILL.md')).digest).toBe(native.digest);
    fs.writeFileSync(reference,'A changed conditional hypothesis.\n');
    expect(() => assertMathAgentSkillsCurrent([native])).toThrow('math_codex_skill_changed:fixture-research');
  });

  it('rejects linked skill resources and duplicate frozen names', () => {
    const skill = readMathAgentSkill(skillFile);
    expect(() => assertMathAgentSkillsCurrent([skill,skill])).toThrow('math_codex_skill_invalid');
    expect(() => assertMathAgentSkillsCurrent([{...skill,loading:undefined!}])).toThrow('math_codex_skill_invalid');
    fs.symlinkSync(reference,path.join(path.dirname(skillFile),'alias.md'));
    expect(() => readMathAgentSkill(skillFile)).toThrow('math_codex_skill_file_invalid');
  });

  it.each([false,true])('discovers native skills and loads them on the first turn only (resume=%s)',async resume => {
    const skill = readMathAgentSkill(skillFile);
    session = await createCodexMathSession({...options(),skills:[skill],...(resume ? {threadId:'saved-skill-thread'} : {})});
    expect(await session.run('Research the exact task.','first',root,()=>{})).toBe('completed');
    expect(await session.run('Continue from your artifacts.','second',root,()=>{})).toBe('completed');
    expect(calls().find(call=>call.method==='skills/list').params).toEqual({cwds:[root],forceReload:true});
    expect(calls().find(call=>call.method===(resume?'thread/resume':'thread/start')).params.config)
      .toMatchObject({'features.multi_agent':false,'features.multi_agent_v2':false,'features.goals':false});
    const turns=calls().filter(call=>call.method==='turn/start');
    expect(turns[0].params.input.filter(item=>item.type==='skill')).toEqual([{type:'skill',name:skill.name,path:skill.path}]);
    expect(turns[1].params.input.some(item=>item.type==='skill')).toBe(false);
  });

  it('uses explicit file loading without claiming native discovery',async()=>{
    const skill = readMathAgentSkill(skillFile,'file');
    session=await createCodexMathSession({...options(),skills:[skill]});
    await session.run('Investigate.','first',root,()=>{});
    expect(calls().some(call=>call.method==='skills/list')).toBe(false);
    const inputs=calls().find(call=>call.method==='turn/start').params.input;
    expect(inputs).toHaveLength(3);
    expect(inputs[2]).toMatchObject({type:'text',text:expect.stringContaining(JSON.stringify(skillFile))});
    expect(inputs[2].text).toContain('explicit file loading, not native');
  });

  it.each([
    ['unsupported','math_codex_rpc_failed:-32601:skills/list'],
    ['missing','math_codex_skill_not_discovered:fixture-research'],
    ['wrong-path','math_codex_skill_not_discovered:fixture-research'],
    ['disabled','math_codex_skill_disabled:fixture-research'],
    ['error','math_codex_skill_discovery_error:fixture-research'],
  ])('fails %s native discovery without a fallback or model turn',async(mode,error)=>{
    const configured=options();configured.environment!.FIXTURE_SKILL_MODE=mode;
    await expect(createCodexMathSession({...configured,skills:[readMathAgentSkill(skillFile)]})).rejects.toThrow(error);
    expect(calls().some(call=>call.method==='turn/start')).toBe(false);
  });

  it('rejects changed references before any subsequent model turn',async()=>{
    const skill=readMathAgentSkill(skillFile);
    session=await createCodexMathSession({...options(),skills:[skill]});
    await session.run('Start.','first',root,()=>{});
    fs.writeFileSync(reference,'Changed after first turn.\n');
    await expect(session.run('Continue.','second',root,()=>{})).rejects.toThrow('math_codex_skill_changed:fixture-research');
    expect(calls().filter(call=>call.method==='turn/start')).toHaveLength(1);
  });

  it('keeps legacy sessions free of skill discovery and inputs',async()=>{
    session=await createCodexMathSession(options());await session.run('Legacy.','legacy',root,()=>{});
    expect(calls().some(call=>call.method==='skills/list')).toBe(false);
    expect(calls().find(call=>call.method==='turn/start').params.input).toHaveLength(2);
    const config=calls().find(call=>call.method==='thread/start').params.config;
    for(const feature of ['features.multi_agent','features.multi_agent_v2','features.goals']) expect(config).not.toHaveProperty(feature);
  });

  it('does not project research skills through a formalization read mount',async()=>{
    await expect(createCodexMathSession({...options(),skills:[readMathAgentSkill(skillFile)],
      readIsolation:{environment:'standard'}})).rejects.toThrow('math_codex_skill_read_isolation_unsupported');
    expect(calls()).toHaveLength(0);
  });

  it('includes project skill resources in the build source identity',()=>{
    const buildRoot=path.join(root,'build');fs.mkdirSync(path.join(buildRoot,'skills','example','references'),{recursive:true});
    fs.writeFileSync(path.join(buildRoot,'extraction.json'),JSON.stringify({schema:'deepscientist.math.extraction.v1',sourceCommit:'a'.repeat(40)}));
    const entry=path.join(buildRoot,'skills','example','SKILL.md'),ref=path.join(buildRoot,'skills','example','references','lean.md');
    fs.writeFileSync(entry,'version one');fs.writeFileSync(ref,'exact assumptions');
    const before=mathBuildSource(buildRoot,[]);fs.writeFileSync(ref,'updated assumptions');
    const after=mathBuildSource(buildRoot,[]);
    expect(before.inputs.map(file=>path.relative(buildRoot,file.path))).toEqual(['skills/example/SKILL.md','skills/example/references/lean.md']);
    expect(after).not.toEqual(before);
  });
});
