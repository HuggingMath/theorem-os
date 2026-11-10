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
import { freePort, startBrowser, preferFullCollaboration, settled } from '../scripts/web-scenario';

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'out/product-continuity/post-lifecycle-20261111/reviews');
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
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot, THEOREMOS_WEB_CONCURRENCY: '4' }), runner,
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
   const assigned=(await http<{item:ResearchFeedback}>(page,'POST',`${projectPath}/feedback/${item.id}/review`,{requestId:crypto.randomUUID(),expectedRevision:item.revision,action:'assign',reviewerId:peerId})).item;
   await page.waitForFunction(async({pathname,id})=>(await(await fetch(pathname)).json()).item.feedback.find((f:{id:string})=>f.id===id)?.proofCheck?.status==='checked',{pathname:projectPath,id:item.id});return assigned;
  };
  const feedbackUrl=(id:string)=>`${origin}/theorems.html?${new URLSearchParams({id:project.id,run:run.id,version:target.statementVersionId,task:'goal',taskVersion:'goal-v1'})}#feedback-${id}`;
  const inbox=(who:string)=>service.research.projects.collaborationInbox(who);
  const forCandidate=(who:string,id:string)=>inbox(who).items.filter(item=>item.href?.includes(id));

  phase=`comment-notification-${language}-${width}`;
  const candidate1=await createCandidate('Candidate A: review comment delivery');
  await page.waitForFunction(async({pathname,id})=>(await(await fetch(pathname)).json()).item.feedback.find((f:{id:string})=>f.id===id)?.proofCheck?.status==='checked',{pathname:projectPath,id:candidate1.id});
  const initialReview=forCandidate(peerOwner,candidate1.id).filter(item=>item.kind==='review');assert.equal(initialReview.length,1);
  await peer.goto(origin+'/workspace.html?tab=inbox');await peer.locator(`[data-inbox-item="${initialReview[0].id}"]`).getByRole('link',{name:language==='zh'?'打开并继续':'Open and continue',exact:true}).click();
  const peerCard=peer.locator(`#feedback-${candidate1.id}`);await peerCard.waitFor();
  const comment='REVIEW_ACTION_REQUIRED: Please justify the boundary case before using this lemma.';
  await peerCard.locator('[data-review-comment]').fill(comment);
  const response=peer.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===`${projectPath}/feedback/${candidate1.id}/review-comments`);
  await peerCard.locator('[data-save-review-comment]').click();assert.equal((await response).status(),200);
  await peerCard.locator('[data-candidate-review-comment]').filter({hasText:comment}).waitFor();
  const authorMessages=forCandidate(owner,candidate1.id);const savedComment=service.research.projects.detail(owner,project.id).feedback.find(x=>x.id===candidate1.id)!.reviewComments!.at(-1)!;
  const commentMessage=authorMessages.find(x=>x.id===`review-comment:${savedComment.id}`)!;assert.ok(commentMessage);assert.equal(commentMessage.read,false);assert.equal(commentMessage.category,'progress');assert.equal(new URL(commentMessage.href,origin).searchParams.get('reviewComment'),savedComment.id);
  assert.equal(forCandidate(peerOwner,candidate1.id).some(x=>x.id===commentMessage.id),false);
  await page.goto(origin+'/workspace.html?tab=inbox&inbox=unread');await page.locator('[data-collaboration-inbox]').waitFor();await settled(page);
  await page.locator('[data-collaboration-inbox]').screenshot({path:path.join(output,`comment-author-inbox-${language}-${width}.png`)});
  await peerCard.locator('[data-feedback-review]').screenshot({path:path.join(output,`comment-saved-by-reviewer-${language}-${width}.png`)});
  await page.locator(`[data-inbox-item="${commentMessage.id}"]`).getByRole('link',{name:language==='zh'?'打开并继续':'Open and continue',exact:true}).click();
  phase=`comment-focus-${language}-${width}`;await page.waitForFunction(id=>document.activeElement?.id===`review-comment-${id}`,savedComment.id);assert.equal(await page.locator(`[data-candidate-review-comment="${savedComment.id}"]`).innerText().then(x=>x.includes(comment)),true);
  await http(page,'POST','/api/research/collaboration/inbox/'+encodeURIComponent(commentMessage.id),{requestId:crypto.randomUUID(),action:'read'});assert.equal(inbox(owner).items.find(x=>x.id===commentMessage.id)?.read,true);
  checks.push({id:'D4-review-comment-reaches-author-and-focuses-exact-comment',language,width,candidateId:candidate1.id,comment,savedComment:service.research.projects.detail(owner,project.id).feedback.find(x=>x.id===candidate1.id)?.reviewComments?.at(-1),authorCandidateMessages:authorMessages,positiveControlReviewerInitiallyNotified:initialReview[0].id});

  phase=`removed-reviewer-${language}-${width}`;
  const candidate2=await createCandidate('Candidate B: reviewer permission changed');
  assert.equal(forCandidate(peerOwner,candidate2.id).filter(x=>x.kind==='review').length,1);
  project=service.research.projects.detail(owner,project.id);project=service.research.projects.setMember(owner,project.id,peerId,{requestId:crypto.randomUUID(),expectedRevision:project.revision,role:'reader'});
  await page.goto(feedbackUrl(candidate2.id));const ownerCard=page.locator(`#feedback-${candidate2.id}`);await ownerCard.waitFor();const review=ownerCard.locator('[data-feedback-review]');
  assert.match(await review.locator('[data-reviewer-unavailable]').innerText(),/Independent Reviewer/);assert.equal(await review.locator('[data-reviewer-select]').count(),0);assert.equal(await review.locator('[data-reviewer-members]').count(),1);
  const ownerPending=forCandidate(owner,candidate2.id).filter(x=>x.category!=='progress'&&!x.resolved&&!x.processed),formerPending=forCandidate(peerOwner,candidate2.id).filter(x=>x.category!=='progress'&&!x.resolved&&!x.processed);
  assert.equal(ownerPending.filter(x=>x.reviewReassignment).length,1);assert.equal(formerPending.length,0);
  await review.screenshot({path:path.join(output,`reviewer-now-reader-${language}-${width}.png`)});
  await page.goto(`${origin}/problem.html?run=${run.id}&project=${project.id}`);const attention=page.locator(`[data-problem-attention-item="feedback:${candidate2.id}"]`);await attention.waitFor();
  const responsibility=await attention.locator('.problem-responsibility').innerText();assert.match(responsibility,/Candidate Author/);assert.ok(!responsibility.includes('Independent Reviewer'));await attention.screenshot({path:path.join(output,`inactive-reviewer-responsibility-${language}-${width}.png`)});
  checks.push({id:'D5-inactive-reviewer-reassignment-and-invitation',language,width,candidateId:candidate2.id,responsibility,ownerPending,formerPending,storedReviewer:project.feedback.find(x=>x.id===candidate2.id)?.review,memberRole:project.members.find(x=>x.researcherId===peerId)?.role,reviewerSelectCount:0,memberLinkCount:1});

  phase=`new-version-review-resubmit-${language}-${width}`;
  project=service.research.projects.detail(owner,project.id);project=service.research.projects.setMember(owner,project.id,peerId,{requestId:crypto.randomUUID(),expectedRevision:project.revision,role:'collaborator'});
  const candidate3=await createCandidate('Candidate C: reviewer requests a new task version');
  const next=controls.get(run.id)!.observation;next.history=[structuredClone(next.inspection.tasks[0])];next.inspection.tasks[0].version='goal-v2';next.inspection.tasks[0].objective='Prove True after revising the boundary condition';next.sources[0].taskVersion='goal-v2';next.sequence=2;next.snapshot.stateDigest=mathDigest('candidate-v2');controls.get(run.id)!.emit();
  await peer.goto(feedbackUrl(candidate3.id));const work=peer.locator(`[data-work-impact-item="review:${candidate3.id}"]`);await work.waitFor();
  await work.getByText(language==='zh'?'核对后处理这项工作':'Review and handle this work',{exact:true}).click();
  const requestText='Please submit a new candidate for goal-v2; the old task boundary has changed.';
  await work.getByLabel(language==='zh'?'接续或结束的说明':'Reason for continuing or ending',{exact:true}).fill(requestText);await work.locator('[data-work-confirm]').check();
  const requestResponse=peer.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===`${projectPath}/work-continuations`);await work.locator('[data-continue-work]').click();assert.equal((await requestResponse).status(),200);
  const needsInfo=forCandidate(owner,candidate3.id).find(item=>item.kind==='needs-info');assert.ok(needsInfo);
  await page.goto(origin+'/workspace.html?tab=inbox');await page.locator(`[data-inbox-item="${needsInfo!.id}"]`).getByRole('link',{name:language==='zh'?'打开并继续':'Open and continue',exact:true}).click();
  const card=page.locator(`#feedback-${candidate3.id}`);await card.locator('[data-review-new-candidate]').waitFor();
  assert.equal(await card.locator('[data-resubmit-review]').count(),0);
  assert.equal(await card.locator('[data-revise-candidate]').count(),0);
  const deliveryStatus=await card.locator('[data-candidate-delivery-status]').innerText();
  assert.ok(!deliveryStatus.includes(language==='zh'?'等待人工批准':'waiting for human approval'));
  assert.ok(deliveryStatus.includes(language==='zh'?'按当前任务版本修订源码并重新检查':'Revise the source for the current task and check it again'));
  const before=service.research.projects.feedback(owner,project.id,candidate3.id);
  const rejected=await page.evaluate(async({pathname,revision})=>{const session=await(await fetch('/api/session')).json();const r=await fetch(pathname,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},body:JSON.stringify({requestId:crypto.randomUUID(),expectedRevision:revision,action:'resubmit',text:'A text-only explanation cannot replace the new candidate.'})});return r.status;},{pathname:`${projectPath}/feedback/${candidate3.id}/review`,revision:before.revision});
  assert.equal(rejected,409);assert.equal(service.research.projects.feedback(owner,project.id,candidate3.id).decision.status,'needs-info');assert.ok(forCandidate(owner,candidate3.id).some(x=>x.kind==='needs-info'));
  const supplement='I have adapted this proof to the updated boundary case.';
  await page.evaluate(({researcherId,projectId,feedbackId,target,supplement})=>{const scope={owner:researcherId,projectId,kind:'review',sourceFeedbackId:feedbackId,runId:target.runId,statementVersionId:target.statementVersionId,taskId:target.taskRef.id,taskVersion:target.taskRef.version,purpose:'resubmit'};const key='theoremos:human-draft:v1:'+encodeURIComponent(JSON.stringify([researcherId,projectId,'review',scope.statementVersionId,scope.runId,scope.taskId,scope.taskVersion,'','', '',feedbackId,'','resubmit']));localStorage.setItem(key,JSON.stringify({schema:'theorem-os.human-draft.v1',scope,value:{text:supplement},summary:supplement,updatedAt:new Date().toISOString()}));},{researcherId:service.research.projects.identity(owner),projectId:project.id,feedbackId:candidate3.id,target,supplement});
  await page.reload();await card.locator('[data-review-new-candidate-link]').click();
  const revisionForm=page.locator(`[data-work-impact-item="candidate:${candidate3.id}"]`);
  await revisionForm.locator('[data-work-next-source]').waitFor();assert.equal(await revisionForm.getByLabel(language==='zh'?'接续或结束的说明':'Reason for continuing or ending',{exact:true}).inputValue(),supplement);
  await card.screenshot({path:path.join(output,`new-version-guidance-${language}-${width}.png`)});
  await revisionForm.locator('[data-work-next-source]').fill('theorem target : True := by trivial\n');await revisionForm.locator('[data-work-confirm]').check();
  const createdResponse=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===`${projectPath}/work-continuations`);await revisionForm.locator('[data-continue-work]').click();const created=await createdResponse;assert.equal(created.status(),200);const child=(await created.json()).feedback as ResearchFeedback;assert.ok(child);assert.equal(child.target?.taskRef?.version,'goal-v2');assert.equal(child.text,supplement);
  await page.waitForFunction(async({pathname,id})=>(await(await fetch(pathname)).json()).item.feedback.find((f:{id:string})=>f.id===id)?.proofCheck?.status==='checked',{pathname:projectPath,id:child.id});
  assert.equal(service.research.projects.feedback(owner,project.id,candidate3.id).target?.taskRef?.version,'goal-v1');assert.equal(forCandidate(owner,candidate3.id).some(x=>x.kind==='needs-info'),false);assert.ok(forCandidate(peerOwner,child.id).some(x=>x.kind==='review'));
  await peer.goto(origin+'/workspace.html?tab=inbox');await peer.locator('[data-collaboration-inbox]').waitFor();await settled(peer);await peer.locator('[data-collaboration-inbox]').screenshot({path:path.join(output,`new-candidate-reviewer-inbox-${language}-${width}.png`)});
  const newReview=forCandidate(peerOwner,child.id).find(x=>x.kind==='review')!;await peer.locator(`[data-inbox-item="${newReview.id}"]`).getByRole('link',{name:language==='zh'?'打开并继续':'Open and continue',exact:true}).click();await peer.locator(`#feedback-${child.id}`).waitFor();
  checks.push({id:'D6-new-candidate-required-and-checked-before-review',language,width,candidateId:candidate3.id,childId:child.id,originalTask:'goal-v1',currentTask:'goal-v2',textOnlyResubmit:rejected,explanationPreserved:true,reviewerNotified:true});
  service.jobs.cancel(owner,run.id);await Promise.all(actors.map(a=>a.close()));
 }
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.equal(prohibited,0);
}catch(cause){failure=cause;if(active&&!active.isClosed())await active.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});}
finally{await fs.writeFile(path.join(output,'report.json'),JSON.stringify({status:failure?'failed':'passed',at:new Date().toISOString(),build:JSON.parse(await fs.readFile(path.join(root,'out/web/build-info.json'),'utf8')),phase,checks,commands,compileCalls,prohibited,errors,external,limitation:'Disposable fixture runs and check responses only; no model, Lean, email or production writes.',...(failure?{error:failure instanceof Error?failure.message:String(failure),url:active&&!active.isClosed()?active.url():undefined,activeElement:active&&!active.isClosed()?await active.evaluate(()=>({id:document.activeElement?.id,tag:document.activeElement?.tagName})).catch(()=>undefined):undefined}:{})},null,2));await browser.close();await service.close();await fs.rm(dataRoot,{recursive:true,force:true});}
if(failure)throw failure;console.log(`Passed ${checks.length} desktop/mobile review product regression workflows`);
