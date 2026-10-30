#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import { fileURLToPath } from 'node:url';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { WebRunInput, WorkerMessage } from '../apps/web/shared';
import type { WebObservation, WebInspection, WebGuidanceInput } from '../apps/web/collaboration';
import { buildTheoremKnowledge } from '../src/solver/theoremKnowledge';
import { closeSettings, openSettings, refreshHistory, selectHistoryRun } from './web-ui-controls';
import { freePort, postRun, settled, startBrowser, webScenario, writeScenarioReport, type ScenarioSuite } from './web-scenario';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), output = path.join(root,'out/web-collaboration');
await fs.mkdir(output,{recursive:true});
const source = 'theorem original_goal : True := by sorry\n';
const digest = (character:string) => character.repeat(64);
const environmentDigest = digest('e');
const now = () => new Date().toISOString();
const fixtureCatalog = (name:string) => buildTheoremKnowledge([{name,file:'Knowledge.lean',type:'True',typeKind:'closed-task-type',kind:'lemma',description:'Known truth for a local browser fixture',premises:[],dependencies:{statement:[],proof:[],tasks:[],coverage:'recorded'},files:{'Knowledge.lean':`theorem ${name} : True := by trivial\n`},provenance:{kind:'solver-check',problemId:'browser-fixture',source:'browser fixture',sourceDigest:digest('d'),sourceCommit:'a'.repeat(40),receiptIds:['known-check'],environmentDigest}}]);
const catalog = fixtureCatalog('known_true');
const emptyCatalogTask = 'Inspect the knowledge catalog lifecycle';
type Control={observation:WebObservation;catalog?:typeof catalog;emit:()=>void;finish:()=>void;send:(message:WorkerMessage)=>void};
const controls=new Map<string,Control>();
const commands:Array<{runId:string;type:string;body:unknown}>=[];
function fixtureObservation(id:string):WebObservation {
  const plan={schema:'deepscientist.math.plan-edit.v1',baseVersion:'plan-v1',tasks:[
    {id:'base',kind:'lemma' as const,objective:'Prove the reusable premise',dependsOn:[],revision:0,theoremName:'base',proofPath:'Submission.lean',type:'True'},
    {id:'route_a',kind:'lemma' as const,objective:'Close route A using the premise',dependsOn:['base'],revision:0,theoremName:'route_a',proofPath:'Submission.lean',type:'True'},
    {id:'route_b',kind:'lemma' as const,objective:'Try the independent alternative',dependsOn:[],revision:0,theoremName:'route_b',proofPath:'Submission.lean',type:'True'},
    {id:'original',kind:'goal' as const,objective:'Prove the original theorem',dependsOn:[],revision:0,theoremName:'original_goal',proofPath:'Submission.lean',type:'True'},
  ],proofRoutes:[{id:'A',targetTaskId:'original',prerequisiteTaskIds:['base'],closingTaskId:'route_a'},{id:'B',targetTaskId:'original',prerequisiteTaskIds:[],closingTaskId:'route_b'}]};
  const snapshot={schema:'theoremos.run-observation.v1',runId:`solver-${id}`,stateDigest:digest('a'),resultDigest:null};
  const inspection:WebInspection={schema:'deepscientist.math.inspection.v1',runId:snapshot.runId,snapshot,evidence:'recorded-not-replayed',phase:'cooperative',problem:{id:'browser-fixture',statement:'Prove True',formalStatement:'True',assumptions:[],targets:[{proofPath:'Submission.lean',theoremName:'original_goal'}]},configuration:{model:'fixture',effort:'low',workers:4,coordination:'cooperative',buildDigest:digest('b'),environmentDigest},turns:2,planVersion:plan.baseVersion,scheduling:{evidence:'recorded-dispatch-state',observedWorkers:4,working:2,proofAssignments:2,preparing:0,stopping:0,idle:2,stopped:0},knowledge:{status:'disabled',evidence:'recorded-not-replayed',attribution:'model-reported-origin',retrievalCoverage:'recorded',droppedRetrievals:0,retrievals:[],originalUses:[],uses:[]},tokenBudget:{},continuation:{},mathematics:{snapshot:{schema:'theorem-os.obligation.v1',evidence:'recorded-not-replayed',acceptance:'not-assessed',digest:digest('c'),obligations:[],goals:[],blockers:[],routes:plan.proofRoutes.map(route=>({routeId:route.id,...route,remainingPrerequisiteTaskIds:route.prerequisiteTaskIds,closingStatus:'none',ready:false,targetStatus:'none',connection:'not-established',referenceCoverageMissing:[],parkedBy:[]})),advisory:[]},recentChanges:[],retainedChangeLimit:64},progress:{checkedProofTasks:1,conditionalProofTasks:1,completedResearchTasks:0,openProofTasks:['route_a','route_b','original']},groups:[],tasks:plan.tasks.map(task=>({id:task.id,kind:task.kind,objective:task.objective,group:'main',status:task.id==='route_a'?'running':'pending',control:'active',owner:task.id==='route_a'?'prover-1':undefined,version:`${task.id}-v1`,theorem:task.theoremName,type:task.type,premises:[],plannedDependencies:task.dependsOn,attempts:1,proof:task.id==='base'?{status:'checked',commit:'a'.repeat(40),sourceDigest:digest('d'),receiptIds:['base-check']}:{status:'none'},feedback:task.id==='route_a'?'Need to close the original consumer connection':undefined,parkedBy:[],parkedRoutes:{}})),workers:[{id:'lead',role:'lead',sessionRole:'lead',phase:'waiting',turns:1,scheduling:{status:'idle',since:1},dispatchWait:{status:'recorded',observation:{reason:'waiting-for-deliveries'}}},{id:'prover-1',role:'prover',sessionRole:'prover',phase:'proving',turns:2,task:'route_a',scheduling:{status:'working',since:1,taskId:'route_a'},dispatchWait:{status:'unknown'}},{id:'engineer',role:'engineer',sessionRole:'engineer',phase:'waiting',turns:0,scheduling:{status:'idle',since:1},dispatchWait:{status:'recorded',observation:{reason:'prerequisite-not-checked'}}},{id:'reviewer',role:'reviewer',phase:'waiting',turns:0,scheduling:{status:'idle',since:1},dispatchWait:{status:'unknown'}}],statementReviews:[],edits:[]};
  return {schema:'theorem-os.web-observation.v1',webRunId:id,solverRunId:snapshot.runId,observedAt:now(),sequence:1,evidence:'recorded-not-replayed',acceptance:'not-assessed',snapshot,inspection,plan,sources:[{taskId:'base',taskVersion:'base-v1',commit:'a'.repeat(40),sourceDigest:digest('d'),environmentDigest,file:'Submission.lean',source:'theorem base : True := by trivial\n',scope:'owned-file'}],checks:[{id:'base-check',taskId:'base',taskVersion:'base-v1',commit:'a'.repeat(40),sourceDigest:digest('d'),environmentDigest,record:{status:'kernel_verified',passed:true,receiptId:'base-check'}}],guidance:[],coverage:{sources:'recorded',checks:'recorded'}};
}
const runner:WebRunner={async readiness(){return{ready:true,message:'Local collaboration HTTP fixture'};},async run(input,send,signal){
  await new Promise<void>(resolve=>{
    const control:Control={observation:fixtureObservation(input.id),catalog:input.input.task===emptyCatalogTask?undefined:catalog,send,emit(){this.observation={...this.observation,sequence:this.observation.sequence+1,observedAt:now()};send({type:'observation',observation:structuredClone(this.observation)});},finish:()=>resolve()};
    controls.set(input.id,control);signal.addEventListener('abort',()=>resolve(),{once:true});if(control.catalog)send({type:'catalog',catalog:control.catalog});control.emit();
  });
},async command(runId,command){
  commands.push({runId,type:command.type,body:command});const control=controls.get(runId)!;
  if(command.type==='capture')return{id:'capture',status:'captured',observation:control.observation,catalog:control.catalog};
  if(command.type==='guidance'){
    if (command.guidance.text === 'Uncertain fixture guidance') return { id: command.guidance.id, status: 'unknown', reason: 'fixture transport uncertainty' };
    const guidance={...command.guidance,status:'queued' as const,createdAt:now(),updatedAt:now()};control.observation.guidance.push(guidance);control.emit();
    return{id:guidance.id,status:'queued',guidance,observation:control.observation};
  }
  if(command.type==='plan-approval')throw new Error('Collaboration fixture runs do not wait for plan approval');
  if(command.proposal.baseVersion!==control.observation.plan!.baseVersion)throw new Error('math_edit_version_conflict');
  if(command.type==='edit-preview')return{id:command.proposal.id,status:'validated',affectedTaskIds:['base'],changes:[{taskId:'base',fields:['type']}]};
  control.observation.plan={...command.proposal,baseVersion:'plan-v3'};control.observation.inspection.planVersion='plan-v3';
  control.observation.inspection.tasks=control.observation.inspection.tasks.map(task=>task.id==='base'?{...task,version:'base-v3',type:command.proposal.tasks.find(task=>task.id==='base')!.type,proof:{status:'stale'}}:task);
  control.observation.inspection.edits.push({id:command.proposal.id,status:'applied',baseVersion:command.proposal.baseVersion,planVersion:'plan-v3',affectedTasks:['base'],recheck:{status:'pending',tasks:[{taskId:'base',taskDigest:'base-v3',status:'pending'}]}});control.emit();
  return{id:command.proposal.id,status:'queued',baseVersion:command.proposal.baseVersion,observation:control.observation};
}};
const port=await freePort(),origin=`http://127.0.0.1:${port}`;
const service=createWebService(readWebConfig({THEOREMOS_WEB_PORT:String(port),THEOREMOS_WEB_PUBLIC_URL:origin,THEOREMOS_WEB_STATIC_ROOT:path.join(root,'out/web'),THEOREMOS_WEB_CONCURRENCY:'8'}),runner);
const browser=await startBrowser(service.server,port);
const suite:ScenarioSuite={origin,output,checks:[],failedScenario:''};
const input:WebRunInput={providerId:'openai',apiKey:'sk-local-collaboration-fixture',model:'fixture',effort:'low',environment:'standard',source,task:'Inspect collaborative proof research',maxTurns:2,maxRunSeconds:60,workers:4,coordination:'cooperative'};
async function create(page:Page,runInput=input){const run=await postRun({page},runInput);await refreshHistory(page);await selectHistoryRun(page,run.id, 'collaboration');await page.locator('.collab-surface').waitFor();await page.locator('[data-collab-task="base"]:visible').waitFor();return run;}
async function poll(page:Page){const response=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/runs'&&response.request().method()==='GET');await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await response;await settled(page);}
async function fit(page:Page){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,'workspace must fit viewport');for(const selector of ['.collab-surface','.collab-layout','.collab-guidance']){const box=await page.locator(selector).boundingBox();assert.ok(box&&box.x>=-1&&box.x+box.width<=page.viewportSize()!.width+1,selector);}}
try{
 await webScenario(browser,suite,'real HTTP collaboration, immutable evidence, conflict recovery and knowledge',async({page})=>{
  const run=await create(page),control=controls.get(run.id)!;
  assert.equal(await page.locator('#detail-tab-collaboration').getAttribute('aria-selected'),'true');
  assert.equal(await page.locator('.collab-or-edge').count(),2);assert.equal(await page.locator('.collab-and-edge').count(),1);
  await page.locator('[data-collab-route]').selectOption('A');assert.equal(await page.locator('.collab-graph [data-collab-task="route_b"]').count(),0);await page.locator('[data-collab-route]').selectOption('');
  await page.locator('.collab-graph [data-collab-task="base"]').click();await page.locator('[data-collab-source="base"]').click();await page.locator('[data-collab-artifact]').getByText('base-v1',{exact:true}).waitFor();
  await page.locator('[data-collab-check="base-check"]').click();await page.locator('[data-collab-artifact]').getByText(/kernel_verified/).waitFor();
  const guidance=page.locator('[data-guidance-text]');await page.locator('[data-collab-guide-task]').click();await guidance.fill('Keep the type and premise explicit');
  await guidance.evaluate(node=>(node as HTMLTextAreaElement).setSelectionRange(5,9));
  await page.locator('.collab-inspector').evaluate(node=>node.scrollTop=40);
  control.observation.inspection.workers[1].task='route_b';control.observation.inspection.workers[1].scheduling!.taskId='route_b';control.emit();await poll(page);
  assert.equal(await guidance.inputValue(),'Keep the type and premise explicit');assert.equal(await guidance.evaluate(node=>node===document.activeElement),true);assert.deepEqual(await guidance.evaluate(node=>[(node as HTMLTextAreaElement).selectionStart,(node as HTMLTextAreaElement).selectionEnd]),[5,9]);
  assert.equal(await page.locator('.collab-agent').filter({hasText:'prover-1'}).innerText().then(text=>text.includes('route_b')),true);
  await page.locator('.collab-agent [data-collab-task="route_b"]').click();await page.locator('[data-inspected-task-heading]').getByText('route_b · 引理',{exact:true}).waitFor();assert.equal(await page.locator('[data-inspected-task-heading]').evaluate(node=>node===document.activeElement),true);await page.locator('.collab-graph [data-collab-task="base"]').click();
  const panelScroll = await page.locator('#detail-panel').evaluate(node => { node.scrollTop = 130; node.dispatchEvent(new Event('scroll')); return node.scrollTop; });
  await page.locator('#detail-tab-source').click();await page.locator('#detail-tab-collaboration').click();assert.equal(await page.locator('#detail-panel').evaluate(node => node.scrollTop),panelScroll);assert.equal(await guidance.inputValue(),'Keep the type and premise explicit');assert.equal(await page.locator('.collab-graph [data-collab-task="base"]').getAttribute('aria-pressed'),'true');
  await page.locator('[data-collab-guidance-form] button[type="submit"]').click();await page.locator('.collab-guidance-record').filter({hasText:'排队中'}).waitFor();
  const submitted=commands.find(command=>command.runId===run.id&&command.type==='guidance')!.body as {guidance:WebGuidanceInput};assert.equal(submitted.guidance.taskRef!.version,'base-v1');assert.ok(submitted.guidance.observationRef.sequence>=2);
  control.observation.guidance[0].status='deferred';control.observation.guidance[0].reason='recipient is busy';control.emit();await poll(page);await page.locator('.collab-guidance-record').filter({hasText:'暂缓'}).waitFor();
  control.observation.guidance[0].status='delivered';control.observation.guidance[0].deliveredTo=['prover-1'];control.emit();await poll(page);await page.locator('.collab-guidance-record').filter({hasText:'已送达'}).waitFor();
  await guidance.fill('Uncertain fixture guidance');await page.locator('[data-collab-guidance-form] button[type="submit"]').click();await page.locator('[data-guidance-notice]').getByText(/结果尚未确认/).waitFor();assert.equal(await guidance.inputValue(),'Uncertain fixture guidance');
  const uncertainCalls = commands.filter(command => command.runId === run.id && command.type === 'guidance').length;
  assert.equal(await page.locator('[data-collab-guidance-form] button[type="submit"]').isDisabled(),true);await page.locator('[data-guidance-receipt-refresh]').click();await page.locator('[data-guidance-receipt-refresh]:enabled').waitFor();assert.equal(commands.filter(command => command.runId === run.id && command.type === 'guidance').length,uncertainCalls,'receipt lookup must not resend the unknown command');
  const uncertain = (commands.filter(command => command.runId === run.id && command.type === 'guidance').at(-1)!.body as {guidance:WebGuidanceInput}).guidance;control.observation.guidance.push({...uncertain,status:'delivered',createdAt:now(),updatedAt:now(),deliveredTo:['lead']});control.emit();await poll(page);await page.waitForFunction(()=>!(document.querySelector('[data-guidance-text]') as HTMLTextAreaElement).value);
  await page.locator('[data-collab-plan]').click();await page.locator('[data-plan-task]').selectOption('base');await page.locator('[data-plan-type]').fill('True ∧ True');
  const draft=await page.locator('#collab-plan-json').inputValue();assert.equal((JSON.parse(draft).tasks as Array<{id:string,type:string}>).find(task=>task.id==='base')!.type,'True ∧ True');
  assert.equal((await page.locator('[data-plan-owner] option').allTextContents()).some(text=>text.includes('lead')||text.includes('reviewer')),false,'ineligible roles are not offered');
  control.observation.plan!.baseVersion='plan-v2';control.observation.inspection.planVersion='plan-v2';control.emit();
  await page.locator('[data-plan-preview]').click();await page.locator('[data-plan-receipt]').getByText(/math_edit_version_conflict/).waitFor();assert.equal(await page.locator('#collab-plan-json').inputValue(),draft);
  await page.locator('[data-plan-current]').click();await page.locator('[data-plan-comparison]').getByText(/plan-v2/).waitFor();assert.equal(await page.locator('#collab-plan-json').inputValue(),draft);
  await page.locator('[data-plan-rebase]').click();await page.locator('[data-plan-apply]:enabled').waitFor();assert.equal(JSON.parse(await page.locator('#collab-plan-json').inputValue()).tasks.find((task:{id:string})=>task.id==='base').type,'True ∧ True');
  await page.locator('[data-plan-apply]').click();await page.locator('[data-plan-receipt]').getByText(/回执 .* · 已应用/).waitFor();await page.locator('[data-plan-recheck]').getByText('待重新检查',{exact:true}).waitFor();await page.locator('[data-plan-close]').click();
  await page.locator('[data-collab-inspector]').getByText('base-v3',{exact:true}).waitFor();assert.ok((await page.locator('[data-collab-edits]').innerText()).includes('待重新检查'));assert.ok((await page.locator('.collab-metrics').innerText()).includes('尚未验收通过'));
  await page.locator('[data-collab-check="base-check"]').click();await page.locator('[data-collab-artifact]').getByText('base-v1',{exact:true}).waitFor();assert.equal(await page.locator('[data-collab-artifact]').getByText('base-v3',{exact:true}).count(),0);
  await page.locator('#knowledge-search').fill('known_true');await page.locator('.collab-knowledge-search button').click();await page.locator('.collab-knowledge-hit').getByText('known_true',{exact:true}).click();await page.locator('[data-knowledge-reference]').click();assert.ok((await guidance.inputValue()).includes(catalog.entries[0].id));
  await page.locator('[data-collab-archive]').click();await page.locator('[data-collab-archives] [data-collab-archive-download]').waitFor();
  const archiveId = await page.locator('[data-collab-archive-id]').getAttribute('data-collab-archive-id');control.emit();await poll(page);assert.equal(await page.locator('[data-collab-archive-id]').getAttribute('data-collab-archive-id'),archiveId,'archive summary survives polling');
  await page.reload();await page.locator('#submit-run:enabled').waitFor({ state: 'attached' });await selectHistoryRun(page,run.id, 'collaboration');await page.locator('[data-collab-archive-download]').waitFor();assert.equal(await page.locator('[data-collab-archive-id]').getAttribute('data-collab-archive-id'),archiveId,'archive summary reloads from the server run');
  const downloadReady = page.waitForEvent('download');await page.locator('[data-collab-archive-download]').click();const download=await downloadReady;const archiveFile=path.join(output,'downloaded-archive.json');await download.saveAs(archiveFile);const archiveText=await fs.readFile(archiveFile,'utf8');const archived=JSON.parse(archiveText) as {schema:string;summary:{id:string;runId:string;evidence:string};sources:Array<{taskVersion:string}>;checks:Array<{id:string}>};assert.equal(archived.schema,'theorem-os.web-archive.v1');assert.equal(archived.summary.runId,run.id);assert.equal(archived.summary.id,archiveId);assert.equal(archived.summary.evidence,'recorded-not-replayed');assert.ok(archived.sources.some(source=>source.taskVersion==='base-v1'));assert.ok(archived.checks.some(check=>check.id==='base-check'));assert.equal(archiveText.includes(input.apiKey),false);await page.locator('.collab-archives').screenshot({path:path.join(output,'archive-summary.png')});
  await openSettings(page);await page.locator('[data-server-module-library] > summary').click();await page.locator('[data-server-plan-name]').fill('Saved on server');await page.locator('#module-plan-scheduler').selectOption('critical-path');await page.locator('#module-plan-context').selectOption('essential');await page.locator('[data-server-plan-save]').click();await page.locator('[data-server-plan-notice]').getByText(/已保存/).waitFor();
  await page.locator('#module-plan-scheduler').selectOption('plan');await page.locator('[data-server-plan-load]').click();assert.equal(await page.locator('#module-plan-scheduler').inputValue(),'critical-path');
  const catalogs=await page.evaluate(async()=>await(await fetch('/api/knowledge/catalogs')).json());await page.locator('#knowledge-catalog').selectOption(catalogs.catalogs[0].digest);await closeSettings(page);
  // Settings belong to the next research and open on the new-research page; return to the run.
  await selectHistoryRun(page,run.id,'collaboration');await page.locator('.collab-surface').waitFor();
  await fit(page);await page.locator('#detail-panel').evaluate(node=>node.scrollTop=0);await page.screenshot({path:path.join(output,'desktop.png')});
 },{context:{viewport:{width:1440,height:1000},reducedMotion:'reduce'},harness:(page,context)=>({page,context,requests:[]}),routes:{local:'Browser fixture must stay local'},open:true,timeout:{label:'Collaboration',seconds:90}});
 await webScenario(browser,suite,'live catalogs recover from empty archives and preserve historical evidence',async({page,requests})=>{
  const run=await create(page,{...input,task:emptyCatalogTask}),control=controls.get(run.id)!;
  const knowledge=page.locator('.collab-knowledge'),selector=page.locator('#knowledge-catalog-search'),detail=page.locator('.collab-knowledge-detail');
  const hit=(name:string)=>page.locator('.collab-knowledge-hit').getByText(name,{exact:true});
  const archive=async()=>{const response=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/runs/${run.id}/archive`&&response.request().method()==='POST');await page.locator('[data-collab-archive]').click();const {archive}=await(await response).json();await page.locator('[data-collab-archive]:enabled').waitFor();assert.equal(typeof archive.catalogDigest,'string');return archive.catalogDigest as string;};
  await knowledge.getByText('尚无已归档知识目录',{exact:true}).waitFor();
  await page.locator('#knowledge-search').fill('true');await page.locator('.collab-knowledge-search button').click();await knowledge.getByText('未找到相关记录',{exact:true}).waitFor();
  control.catalog=catalog;const firstDigest=await archive();await selector.locator(`option[value="${firstDigest}"]`).waitFor({state:'attached'});await hit('known_true').waitFor();
  assert.equal(await selector.inputValue(),'','latest selection stays live after the first archive');assert.equal(await knowledge.getByText('尚无已归档知识目录',{exact:true}).count(),0);
  await selector.selectOption(firstDigest);await hit('known_true').click();await detail.getByText(new RegExp(firstDigest)).waitFor();
  control.catalog=fixtureCatalog('new_true');const secondDigest=await archive();assert.notEqual(secondDigest,firstDigest);await selector.locator(`option[value="${secondDigest}"]`).waitFor({state:'attached'});
  assert.equal(await selector.inputValue(),firstDigest,'archiving preserves an explicit historical catalog');await detail.getByText(new RegExp(firstDigest)).waitFor();assert.equal(await hit('new_true').count(),0);
  control.emit();await poll(page);assert.equal(await selector.inputValue(),firstDigest);await detail.getByText(new RegExp(firstDigest)).waitFor();
  await selector.selectOption('');await hit('new_true').waitFor();assert.equal(await selector.inputValue(),'');assert.equal(await detail.locator('[data-knowledge-reference]').count(),0);assert.equal(await detail.innerText(),'','catalog changes clear the old evidence');
  await selector.selectOption(firstDigest);await hit('known_true').click();await detail.locator('[data-knowledge-reference]').waitFor();await detail.getByText(new RegExp(firstDigest)).waitFor();
  await selector.selectOption('');await hit('new_true').waitFor();await hit('known_true').click();await detail.getByText(new RegExp(secondDigest)).waitFor();await detail.locator('[data-knowledge-reference]').click();assert.ok((await page.locator('[data-guidance-text]').inputValue()).includes(`目录 ${secondDigest}`));
  await page.locator('#knowledge-search').fill('new_true');await page.locator('.collab-knowledge-search button').click();await hit('new_true').waitFor();assert.equal(await detail.locator('[data-knowledge-reference]').count(),0,'a new search cannot retain another result’s reference');await hit('new_true').click();await detail.locator('[data-knowledge-reference]').waitFor();
  control.catalog=fixtureCatalog('imported_true');control.send({type:'catalog',catalog:control.catalog});control.emit();await poll(page);await selector.locator('option').filter({hasText:/3 定理/}).waitFor({state:'attached'});await hit('new_true').waitFor();assert.equal(await selector.inputValue(),'');assert.equal(await page.locator('#knowledge-search').inputValue(),'new_true');assert.equal(await detail.locator('[data-knowledge-reference]').count(),0,'a newer latest catalog invalidates an open older detail');
  await page.locator('#knowledge-search').fill('imported_true');await page.locator('.collab-knowledge-search button').click();await hit('imported_true').waitFor();
  const catalogRequests=requests.filter(request=>request.pathname==='/api/knowledge/catalogs').length;await poll(page);assert.equal(requests.filter(request=>request.pathname==='/api/knowledge/catalogs').length,catalogRequests,'ordinary polling does not repeatedly reload known catalogs');
  await knowledge.screenshot({path:path.join(output,'knowledge-live.png')});
 },{context:{viewport:{width:1440,height:1000},reducedMotion:'reduce'},harness:(page,context)=>({page,context,requests:[]}),routes:{local:'Browser fixture must stay local'},open:true,timeout:{label:'Live knowledge catalogs',seconds:60}});
 for(const width of [375,320])await webScenario(browser,suite,`mobile task list and plan at ${width}px`,async({page})=>{
  await create(page);await page.locator('.collab-task-list [data-collab-task="base"]').click();await fit(page);await page.locator('[data-collab-plan]').click();await page.locator('[data-plan-type]').fill('True ∧ True');const box=await page.locator('.collab-plan-dialog').boundingBox();assert.ok(box&&box.x>=0&&box.x+box.width<=width+1);await page.screenshot({path:path.join(output,`mobile-${width}-plan.png`)});await page.locator('[data-plan-close]').click();await page.screenshot({path:path.join(output,`mobile-${width}.png`)});
 },{context:{viewport:{width,height:812},reducedMotion:'reduce'},harness:(page,context)=>({page,context,requests:[]}),routes:{local:'Browser fixture must stay local'},open:true,timeout:{label:'Mobile collaboration',seconds:40}});
 await writeScenarioReport(path.join(output,'report.json'),suite,'passed',undefined,'local-real-http-runtime-fixture',{checks:suite.checks,commands:commands.map(command=>({runId:command.runId,type:command.type})),screenshots:['desktop.png','archive-summary.png','knowledge-live.png','mobile-375.png','mobile-320.png']});
 console.log('Collaboration browser checks passed');
}catch(error){await writeScenarioReport(path.join(output,'report.json'),suite,'failed',error,'local-real-http-runtime-fixture',{checks:suite.checks});throw error;}
finally{for(const control of controls.values())control.finish();await browser.close();await service.close();}
