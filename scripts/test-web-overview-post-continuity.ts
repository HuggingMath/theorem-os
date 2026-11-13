#!/usr/bin/env bun
// Disposable HTTP/Chromium state and a controlled runner. No models, Lean or mail.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import { loadWebSample } from '../apps/web/sample';
import { mathDigest } from '../src/math/mathRuntimeIo';
import type { WebRunner } from '../apps/web/runner';
import type { WebObservation } from '../apps/web/collaboration';
import type { ResearchFeedback, ResearchProjectDetail } from '../apps/web/researchProjectTypes';
import { freePort, startBrowser, preferFullCollaboration, settled } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..'), output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/product-continuity/post-continuity-20261111/overview-personal');
const staticRoot = process.env.THEOREMOS_FRONTEND_TEST_STATIC_ROOT ?? path.join(root, 'out/web');
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-candidate-continuity-'));
const source = 'theorem target : True := by sorry\n', commit = '1'.repeat(40), environmentDigest = mathDigest('controlled-candidate-environment');
const controls = new Map<string, { observation: WebObservation; emit(): void }>();
const commands: { id: string; type: string }[] = [], errors: string[] = [], external: string[] = [], checks: object[] = [];
let compileCalls = 0, prohibited = 0, phase = 'setup', active: Page | undefined, failure: unknown;
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Controlled candidate workflow' }; },
  async check(input) { compileCalls++; return { exitCode: 0, timedOut: false, output: '', checkedTarget: input.candidateTarget?.name }; },
  async run(input, send, signal) {
    const observation = structuredClone(loadWebSample()!.observations.at(-1)!);
    observation.webRunId = input.id; observation.sequence = 1; observation.snapshot.stateDigest = mathDigest('candidate-v1');
    observation.inspection.problem = { id: 'candidate-fixture', statement: 'Prove True', formalStatement: 'True', assumptions: [], targets: [{ theoremName: 'target', proofPath: 'Main.lean' }] };
    observation.inspection.configuration.environmentDigest = environmentDigest;
    observation.inspection.tasks = [{ id: 'goal', kind: 'goal', objective: 'Prove True', theorem: 'target', type: 'True',
      group: 'main', status: 'working', control: 'active', version: 'goal-v1', premises: [], plannedDependencies: [],
      attempts: 0, proof: { status: 'open' }, parkedBy: [], parkedRoutes: {} }];
    observation.inspection.edits = []; observation.inspection.statementReviews = []; observation.inspection.planVersion = 'plan-v1';
    observation.inspection.progress = { checkedProofTasks: 0, conditionalProofTasks: 0, completedResearchTasks: 0, openProofTasks: ['goal'] };
    observation.plan = { schema: 'deepscientist.math.plan-edit.v1', baseVersion: 'plan-v1', tasks: [
      { id: 'goal', kind: 'goal', objective: 'Prove True', revision: 0, dependsOn: [], theoremName: 'target', proofPath: 'Main.lean', type: 'True' }] };
    observation.sources = [{ taskId: 'goal', taskVersion: 'goal-v1', commit, source, sourceDigest: mathDigest(source), environmentDigest, file: 'Main.lean', scope: 'owned-file' }];
    observation.checks = []; observation.guidance = []; observation.history = []; observation.deliveries = [];
    observation.coverage = { sources: 'recorded', checks: 'recorded' };
    await new Promise<void>(resolve => {
      controls.set(input.id, { observation, emit() { send({ type: 'observation', observation: structuredClone(this.observation) }); } });
      controls.get(input.id)!.emit(); signal.addEventListener('abort', () => resolve(), { once: true });
    });
  },
  async command(_id, command) {
    if (command.type === 'capture') return { id: 'capture', status: 'captured' };
    const id = command.type === 'guidance' ? command.guidance.id : command.type === 'plan-approval' ? command.approval.id : command.proposal.id;
    commands.push({ id, type: command.type }); return { id, status: 'unknown', reason: 'Recorded fixture: command acknowledgement unavailable' };
  },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: staticRoot, THEOREMOS_WEB_DATA_ROOT: dataRoot, THEOREMOS_WEB_CONCURRENCY: '4' }), runner,
{ sample: null, mailer: async () => { prohibited++; throw new Error('No mail allowed'); } });
const browser = await startBrowser(service.server, port);
async function http<T>(page: Page, method: string, pathname: string, input?: unknown): Promise<T> {
  return page.evaluate(async ({ method, pathname, input }) => {
    const session = await (await fetch('/api/session')).json();
    const response = await fetch(pathname, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const body = await response.json(); if (!response.ok) throw new Error(`${response.status}: ${body.error}`); return body;
  }, { method, pathname, input }) as Promise<T>;
}
async function home(page: Page) {
  const loaded = page.waitForResponse(response => new URL(response.url()).pathname === '/api/research/overview');
  await page.goto(origin + '/');
  await page.locator('[data-chat-research-overview] > summary').click();
  await loaded; await page.locator('[data-research-overview]').waitFor(); await settled(page);
}
try {
 for(const [language,width] of [['zh',1440],['en',390]] as const){
  phase=`setup-${language}-${width}`;
  const actors=await Promise.all([0,1].map(()=>browser.newContext({locale:language==='zh'?'zh-CN':'en-US',viewport:{width,height:1000},reducedMotion:'reduce'})));
  for(const actor of actors){await actor.addInitScript(language=>localStorage.setItem('theorem-os.web-locale.v1',language),language);await preferFullCollaboration(actor);
   await actor.route(/^https?:\/\//u,async route=>{if(new URL(route.request().url()).origin!==origin){external.push(route.request().url());await route.abort();}else await route.continue();});}
  const [page,peer]=await Promise.all(actors.map(a=>a.newPage())); active=page;
  for(const p of [page,peer]){p.setDefaultTimeout(15000);p.on('pageerror',e=>errors.push(e.message));await p.goto(origin+'/workspace.html');await p.locator('.workspace-tabs').waitFor();}
  const owner=(await actors[0].cookies(origin)).find(c=>c.name==='theoremos_session')!.value,peerOwner=(await actors[1].cookies(origin)).find(c=>c.name==='theoremos_session')!.value;
  await http(page,'PUT','/api/research/profile',{requestId:crypto.randomUUID(),expectedRevision:0,displayName:'Candidate Author',visibility:'public'});
  await http(peer,'PUT','/api/research/profile',{requestId:crypto.randomUUID(),expectedRevision:0,displayName:'Independent Reviewer',visibility:'public'});
  const peerId=service.research.projects.identity(peerOwner);
  const {run}=await http<{run:{id:string}}>(page,'POST','/api/runs',{requestId:crypto.randomUUID(),providerId:'openai',apiKey:'sk-disposable-audit-fixture',model:'fixture',effort:'low',environment:'standard',source,task:'Prove True',maxTurns:2,maxRunSeconds:600,workers:2,coordination:'cooperative'});
  await page.waitForFunction(async id=>(await(await fetch(`/api/runs/${id}`)).json()).run.observation,run.id);
  let project=(await http<{item:ResearchProjectDetail}>(page,'POST','/api/research/theorems',{requestId:crypto.randomUUID(),title:'Independent review lifecycle',visibility:'members',candidateDeliveryPolicy:'reviewed'})).item;
  const projectPath=`/api/research/theorems/${project.id}`;
  project=(await http<{item:ResearchProjectDetail}>(page,'POST',`${projectPath}/versions`,{requestId:crypto.randomUUID(),expectedRevision:project.revision,source,statement:'Prove True',environment:'standard'})).item;
  project=(await http<{item:ResearchProjectDetail}>(page,'POST',`${projectPath}/runs`,{requestId:crypto.randomUUID(),expectedRevision:project.revision,runId:run.id,statementVersionId:project.currentStatementVersionId,grants:{guidance:true,edit:true,approve:true,proof:true}})).item;
  project=service.research.projects.setMember(owner,project.id,peerId,{requestId:crypto.randomUUID(),expectedRevision:project.revision,role:'collaborator'});
  const target={runId:run.id,statementVersionId:project.currentStatementVersionId!,observationRef:{sequence:1,stateDigest:controls.get(run.id)!.observation.snapshot.stateDigest},taskRef:{id:'goal',version:'goal-v1'}};
  const createCandidate=async(text:string)=>{
   const item=(await http<{item:ResearchFeedback}>(page,'POST',`${projectPath}/feedback`,{requestId:crypto.randomUUID(),kind:'proof-submission',text,source:'theorem target : True := by trivial\n',base:{commit,sourceDigest:mathDigest(source),environmentDigest,file:'Main.lean'},target})).item;
   return(await http<{item:ResearchFeedback}>(page,'POST',`${projectPath}/feedback/${item.id}/review`,{requestId:crypto.randomUUID(),expectedRevision:item.revision,action:'assign',reviewerId:peerId})).item;
  };
  const inbox=(who:string)=>service.research.projects.collaborationInbox(who);
  const forCandidate=(who:string,id:string)=>inbox(who).items.filter(item=>item.href?.includes(id));



  phase=`late-personal-organization-${language}-${width}`;
  await http(page,'PUT',`/api/research/personal/problems?runId=${run.id}`,{requestId:crypto.randomUUID(),expectedRevision:0,pinned:false,status:'active',tags:['old'],nextNote:'Previously saved note.'});
  let release!:()=>void, held=false;const gate=new Promise<void>(resolve=>release=resolve);
  await page.route('**/api/research/personal/problems?runId=*',async route=>{
    if(route.request().method()==='GET'&&!held){held=true;const response=await route.fetch();await gate;await route.fulfill({response});}else await route.continue();
  });
  await page.goto(`${origin}/problem.html?run=${run.id}`);const organization=page.locator('[data-personal-problem]');await organization.locator(':scope>summary').click();
  await organization.locator('[data-personal-loading]').waitFor();
  const note=organization.getByLabel(language==='zh'?'下次从这里继续':'Next time, start here',{exact:true}),tags=organization.getByLabel(language==='zh'?'标签':'Tags',{exact:true});
  const nextNote='New derivation and plan typed before saved organization arrives.';
  await note.fill(nextNote);await tags.fill('new-tag');await organization.locator('[data-personal-pinned]').check();await organization.locator('[data-personal-status]').selectOption('parked');
  assert.equal(await organization.locator('[data-save-personal-problem]').isEnabled(),false);release();
  await organization.locator('[data-personal-loading]').waitFor({state:'hidden'});
  assert.equal(await note.inputValue(),nextNote);assert.equal(await tags.inputValue(),'new-tag');assert.equal(await organization.locator('[data-personal-pinned]').isChecked(),true);assert.equal(await organization.locator('[data-personal-status]').inputValue(),'parked');
  const save=page.waitForResponse(r=>r.request().method()==='PUT'&&new URL(r.url()).pathname==='/api/research/personal/problems');await organization.locator('[data-save-personal-problem]').click();assert.equal((await save).status(),200);
  await organization.screenshot({path:path.join(output,`preserved-organization-${language}-${width}.png`)});
  await page.reload();const restored=page.locator('[data-personal-problem]');await restored.locator(':scope>summary').click();await page.waitForFunction(text=>document.querySelector<HTMLTextAreaElement>('[data-personal-problem] textarea')?.value===text,nextNote);
  assert.equal(await restored.locator('[data-personal-pinned]').isChecked(),true);assert.equal(await restored.locator('[data-personal-status]').inputValue(),'parked');assert.equal(await restored.getByLabel(language==='zh'?'标签':'Tags',{exact:true}).inputValue(),'new-tag');
  checks.push({id:'N2-late-organization-load-preserves-all-edited-fields',language,width,saved:true,fields:['pinned','status','tags','nextNote'],reloaded:true});


  phase=`personal-read-retry-${language}-${width}`;
  const savedBefore=(await http<{item:{revision:number}}>(page,'GET',`/api/research/personal/problems?runId=${run.id}`)).item;
  await http(page,'PUT',`/api/research/personal/problems?runId=${run.id}`,{requestId:crypto.randomUUID(),expectedRevision:savedBefore.revision,pinned:true,status:'archived',tags:['saved-tag'],nextNote:'Previous retry note.'});
  await page.unroute('**/api/research/personal/problems?runId=*');let failFirstRead=true;
  await page.route('**/api/research/personal/problems?runId=*',async route=>{
    if(route.request().method()==='GET'&&failFirstRead){failFirstRead=false;await route.fulfill({status:503,json:{error:'Personal organization retry fixture'}});}else await route.continue();
  });
  await page.goto(`${origin}/problem.html?run=${run.id}`);const retryOrganization=page.locator('[data-personal-problem]');await retryOrganization.locator(':scope>summary').click();
  await retryOrganization.getByRole('alert').filter({hasText:'Personal organization retry fixture'}).waitFor();
  const retryNote=retryOrganization.getByLabel(language==='zh'?'下次从这里继续':'Next time, start here',{exact:true});await retryNote.fill('New note entered after the first read failed.');
  await retryOrganization.getByRole('button',{name:language==='zh'?'读取最新整理，保留当前输入':'Load the latest organization and keep my edits',exact:true}).click();
  await retryOrganization.getByRole('alert').waitFor({state:'hidden'});
  assert.equal(await retryNote.inputValue(),'New note entered after the first read failed.');assert.equal(await retryOrganization.getByLabel(language==='zh'?'标签':'Tags',{exact:true}).inputValue(),'saved-tag');assert.equal(await retryOrganization.locator('[data-personal-pinned]').isChecked(),true);assert.equal(await retryOrganization.locator('[data-personal-status]').inputValue(),'archived');
  checks.push({id:'N2-read-retry-preserves-new-note-and-loads-untouched-fields',language,width});
  // Keep this project visible while checking its attention filter below.
  await retryOrganization.locator('[data-personal-status]').selectOption('active');
  const retrySave=page.waitForResponse(r=>r.request().method()==='PUT'&&new URL(r.url()).pathname==='/api/research/personal/problems');await retryOrganization.locator('[data-save-personal-problem]').click();assert.equal((await retrySave).status(),200);

  phase=`assigned-candidate-overview-${language}-${width}`;
  const candidate=await createCandidate('Candidate requires the independent reviewer, not its author');
  await page.waitForFunction(async ({projectPath,id}) => (await(await fetch(`${projectPath}`)).json()).item.feedback.find(x=>x.id===id)?.proofCheck?.status==='checked', {projectPath,id:candidate.id});
  const ownerPending=forCandidate(owner,candidate.id).filter(x=>!x.resolved&&!x.processed&&x.category!=='progress');
  const peerPending=forCandidate(peerOwner,candidate.id).filter(x=>!x.resolved&&!x.processed&&x.category!=='progress');
  assert.equal(ownerPending.length,0);assert.equal(peerPending.filter(x=>x.kind==='review').length,1);
  await home(page);
  assert.equal(await page.locator(`[data-overview-action="feedback:${candidate.id}"]`).count(),0);
  await page.locator('[data-overview-filter="waiting"]').click();assert.equal(await page.locator('[data-overview-card]').count(),0);
  await page.locator('[data-research-overview]').screenshot({path:path.join(output,`assigned-owner-overview-${language}-${width}.png`)});
  await home(peer);const peerAction=peer.locator(`[data-overview-action="feedback:${candidate.id}"]`);await peerAction.waitFor();
  const reviewHref=new URL((await peerAction.getAttribute('href'))!,origin);assert.equal(reviewHref.searchParams.get('taskVersion'),'goal-v1');assert.equal(reviewHref.searchParams.get('version'),target.statementVersionId);
  await peerAction.click();await peer.locator(`#feedback-${candidate.id} [data-candidate-approve]`).waitFor();
  checks.push({id:'OV1-author-waits-reviewer-can-act',language,width,candidateId:candidate.id,authorAttention:false,reviewerAttention:true,exactTargetPreserved:true});

  phase=`clarification-home-${language}-${width}`;
  let current=service.research.projects.detail(peerOwner,project.id).feedback.find(x=>x.id===candidate.id)!;
  current=(await http<{item:ResearchFeedback}>(peer,'POST',`${projectPath}/feedback/${candidate.id}/decision`,{requestId:crypto.randomUUID(),expectedRevision:current.revision,status:'needs-info',reason:'Please explain the last implication.'})).item;
  await home(page);const authorAction=page.locator(`[data-overview-action="feedback:${candidate.id}"]`);await authorAction.waitFor();
  await authorAction.click();await page.locator(`#feedback-${candidate.id} [data-resubmit-review]`).waitFor();
  current=(await http<{item:ResearchFeedback}>(page,'POST',`${projectPath}/feedback/${candidate.id}/review`,{requestId:crypto.randomUUID(),expectedRevision:current.revision,action:'resubmit',text:'The last implication expands the definition.'})).item;
  await home(page);
  await page.waitForFunction(id=>!document.querySelector(`[data-overview-action="feedback:${id}"]`),candidate.id);
  await home(peer);await peer.locator(`[data-overview-action="feedback:${candidate.id}"]`).waitFor();
  checks.push({id:'OV1-clarification-goes-to-author-and-resubmission-to-reviewer',language,width,candidateId:candidate.id});

  phase=`reassignment-home-${language}-${width}`;
  project=service.research.projects.detail(owner,project.id);project=service.research.projects.setMember(owner,project.id,peerId,{requestId:crypto.randomUUID(),expectedRevision:project.revision,role:'reader'});
  await home(page);await page.locator(`[data-overview-action="feedback:${candidate.id}"]`).waitFor();
  assert.equal(forCandidate(owner,candidate.id).filter(x=>x.reviewReassignment&&!x.processed).length,1);
  await page.locator(`[data-overview-action="feedback:${candidate.id}"]`).click();const card=page.locator(`#feedback-${candidate.id}`);await card.locator('[data-reviewer-unavailable]').waitFor();
  checks.push({id:'OV1-inactive-reviewer-reassignment-goes-to-owner',language,width,candidateId:candidate.id});

  // The earlier clarification is a legitimate unread progress notification; clear that independent message before checking the empty attention filter.
  service.research.projects.readNotifications(owner,{requestId:crypto.randomUUID()});
  phase=`withdrawn-candidate-overview-${language}-${width}`;
  const withdrawn=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===`${projectPath}/feedback/${candidate.id}/candidate-delivery`);
  await card.locator('[data-candidate-withdraw]').click();assert.equal((await withdrawn).status(),200);
  await card.locator('[data-candidate-delivery-status="withdrawn"]').waitFor();
  await home(page);
  assert.equal(await page.locator(`[data-overview-action="feedback:${candidate.id}"]`).count(),0);
  await page.locator('[data-overview-filter="waiting"]').click();assert.equal(await page.locator('[data-overview-card]').count(),0);
  await page.locator('[data-research-overview]').screenshot({path:path.join(output,`withdrawn-owner-overview-${language}-${width}.png`)});
  assert.equal(forCandidate(peerOwner,candidate.id).filter(x=>x.kind==='review'&&!x.resolved).length,0);
  checks.push({id:'OV1-withdrawn-candidate-removed-from-attention',language,width,candidateId:candidate.id});
  service.jobs.cancel(owner,run.id);await Promise.all(actors.map(a=>a.close()));
 }
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.equal(prohibited,0);
}catch(cause){failure=cause;if(active&&!active.isClosed())await active.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});}
finally{await fs.writeFile(path.join(output,'report.json'),JSON.stringify({status:failure?'failed':'passed',at:new Date().toISOString(),build:JSON.parse(await fs.readFile(path.join(staticRoot,'build-info.json'),'utf8')),phase,checks,commands,compileCalls,prohibited,errors,external,limitation:'Disposable fixture runs and check responses only; no model, Lean, email or production writes.',...(failure?{error:failure instanceof Error?failure.stack:String(failure)}:{})},null,2));await browser.close();await service.close();await fs.rm(dataRoot,{recursive:true,force:true});}
if(failure)throw failure;console.log(`Verified ${checks.length} desktop/mobile overview and personal organization workflows`);
