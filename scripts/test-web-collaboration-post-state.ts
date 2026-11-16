#!/usr/bin/env bun
// Disposable HTTP/Chromium state and a controlled runner. No models, Lean or mail.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Locator, Page } from 'playwright';
import { WebStorage } from '../apps/web/storage';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import { loadWebSample } from '../apps/web/sample';
import { mathDigest } from '../src/math/mathRuntimeIo';
import type { WebRunner } from '../apps/web/runner';
import type { WebObservation } from '../apps/web/collaboration';
import type { ResearchFeedback, ResearchProjectDetail } from '../apps/web/researchProjectTypes';
import { freePort, startBrowser, preferFullCollaboration, settled } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..'), output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/product-continuity/post-state-20261111/collaboration');
const staticRoot = process.env.THEOREMOS_FRONTEND_TEST_STATIC_ROOT ?? path.join(root, 'out/web');
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-collaboration-post-state-audit-'));
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
    if (command.type === 'guidance-withdraw') return { id: command.id, status: 'rejected', reason: 'fixture_guidance_withdraw_not_simulated' };
    const id = command.type === 'guidance' ? command.guidance.id : command.type === 'plan-approval' ? command.approval.id : command.proposal.id;
    commands.push({ id, type: command.type }); return { id, status: 'unknown', reason: 'Recorded fixture: command acknowledgement unavailable' };
  },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const config = readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: staticRoot, THEOREMOS_WEB_DATA_ROOT: dataRoot, THEOREMOS_WEB_CONCURRENCY: '4', THEOREMOS_WEB_AUTH: 'email', THEOREMOS_WEB_SMTP_URL: 'log:', THEOREMOS_WEB_ALLOWLIST: 'owner-zh@example.org,reviewer-zh@example.org,other-zh@example.org,owner-en@example.org,reviewer-en@example.org,other-en@example.org' });
const seed = new WebStorage(dataRoot);
const accounts = ['owner-zh', 'reviewer-zh', 'other-zh', 'owner-en', 'reviewer-en', 'other-en'].map(name => ({ id: crypto.randomUUID(), email: `${name}@example.org`, createdAt: new Date().toISOString(), termsAt: new Date().toISOString(), termsVersion: config.auth!.termsVersion }));
accounts.forEach(account => seed.saveRecord(['accounts', `${mathDigest(account.email)}.json`], account));
const sessions = accounts.map(account => ({ id: crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', ''), csrf: mathDigest(crypto.randomUUID()), touchedAt: Date.now(), account: { id: account.id, email: account.email } }));
sessions.forEach(session => seed.saveSession(session));
const releases: (() => void)[] = [];
const makeService = () => createWebService(config, runner, { sample: null, mailer: async () => { prohibited++; throw new Error('No mail allowed'); } });
let service = makeService();
const browser = await startBrowser(service.server, port);
async function http<T>(page: Page, method: string, pathname: string, input?: unknown): Promise<T> {
  return page.evaluate(async ({ method, pathname, input }) => {
    const session = await (await fetch('/api/session')).json();
    const response = await fetch(pathname, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const body = await response.json(); if (!response.ok) throw new Error(`${response.status}: ${body.error}`); return body;
  }, { method, pathname, input }) as Promise<T>;
}
async function openDetails(details: Locator) { if (!await details.evaluate(node => (node as HTMLDetailsElement).open)) await details.locator(':scope>summary').click(); }
try {
 for (const [language,width] of [['zh',1440],['en',390]] as const) {
  phase=`setup-${language}-${width}`;
  const offset=language==='zh'?0:3;
  const actors=await Promise.all([0,1,1,2].map(async index=>{
    const actor=await browser.newContext({locale:language==='zh'?'zh-CN':'en-US',viewport:{width,height:1000},reducedMotion:'reduce'});
    await actor.addCookies([{name:'theoremos_session',value:sessions[offset+index].id,url:origin}]);
    await actor.addInitScript(language=>localStorage.setItem('theorem-os.web-locale.v1',language),language);await preferFullCollaboration(actor);
    await actor.route(/^https?:\/\//u,async route=>{if(new URL(route.request().url()).origin!==origin){external.push(route.request().url());await route.abort();}else await route.continue();});return actor;
  }));
  const [page,peer,second,other]=await Promise.all(actors.map(actor=>actor.newPage()));active=page;
  for(const p of [page,peer,second,other]){p.setDefaultTimeout(15000);p.on('pageerror',e=>errors.push(e.message));await p.goto(origin+'/workspace.html');await p.locator('.workspace-tabs').waitFor();}
  const owner=`account:${accounts[offset].id}`,reviewer=`account:${accounts[offset+1].id}`,peerId=service.research.projects.identity(reviewer);
  for(const [p,name]of [[page,'Project Owner'],[peer,'Independent Reviewer'],[other,'Unrelated Account']]as const)await http(p,'PUT','/api/research/profile',{requestId:crypto.randomUUID(),expectedRevision:0,displayName:name,visibility:'public'});
  const {run}=await http<{run:{id:string}}>(page,'POST','/api/runs',{requestId:crypto.randomUUID(),providerId:'openai',apiKey:'sk-disposable-collaboration-fixture',model:'fixture',effort:'low',environment:'standard',source,task:'Prove True',maxTurns:2,maxRunSeconds:600,workers:2,coordination:'cooperative'});
  await page.waitForFunction(async id=>(await(await fetch(`/api/runs/${id}`)).json()).run.observation,run.id);
  let project=(await http<{item:ResearchProjectDetail}>(page,'POST','/api/research/theorems',{requestId:crypto.randomUUID(),title:'Decision and discussion continuity',visibility:'members',candidateDeliveryPolicy:'reviewed'})).item;
  const projectPath=`/api/research/theorems/${project.id}`;
  project=(await http<{item:ResearchProjectDetail}>(page,'PUT',`${projectPath}/members/${peerId}`,{requestId:crypto.randomUUID(),expectedRevision:project.revision,role:'collaborator'})).item;
  project=(await http<{item:ResearchProjectDetail}>(page,'POST',`${projectPath}/versions`,{requestId:crypto.randomUUID(),expectedRevision:project.revision,source,statement:'Prove True',environment:'standard'})).item;
  project=(await http<{item:ResearchProjectDetail}>(page,'POST',`${projectPath}/runs`,{requestId:crypto.randomUUID(),expectedRevision:project.revision,runId:run.id,statementVersionId:project.currentStatementVersionId,grants:{guidance:true,edit:true,approve:true,proof:true}})).item;
  const target={runId:run.id,statementVersionId:project.currentStatementVersionId!,observationRef:{sequence:1,stateDigest:controls.get(run.id)!.observation.snapshot.stateDigest},taskRef:{id:'goal',version:'goal-v1'}};
  const createCandidate=async(text:string,assign=true)=>{
    const item=(await http<{item:ResearchFeedback}>(page,'POST',`${projectPath}/feedback`,{requestId:crypto.randomUUID(),kind:'proof-submission',text,source:'theorem target : True := by trivial\n',base:{commit,sourceDigest:mathDigest(source),environmentDigest,file:'Main.lean'},target})).item;
    await page.waitForFunction(async({pathname,id})=>(await(await fetch(pathname)).json()).item.feedback.find((f:{id:string})=>f.id===id)?.proofCheck?.status==='checked',{pathname:projectPath,id:item.id});
    const checked=service.research.projects.feedback(owner,project.id,item.id);
    return assign?(await http<{item:ResearchFeedback}>(page,'POST',`${projectPath}/feedback/${item.id}/review`,{requestId:crypto.randomUUID(),expectedRevision:checked.revision,action:'assign',reviewerId:peerId})).item:checked;
  };
  const feedbackUrl=(id:string)=>`${origin}/theorems.html?${new URLSearchParams({id:project.id,run:run.id,version:target.statementVersionId,task:'goal',taskVersion:'goal-v1'})}#feedback-${id}`;
  const inbox=(who:string)=>service.research.projects.collaborationInbox(who);

  phase=`issue-results-reach-participants-${language}-${width}`;
  const issuesPath=`${projectPath}/issues`;
  let issue=(await http<{item:{id:string;revision:number;replies:{id:string}[]}}>(page,'POST',issuesPath,{requestId:crypto.randomUUID(),expectedRevision:project.revision,title:'Choose the next proof strategy',text:'Decide whether to use the explicit constructor.',target})).item;
  issue=(await http<{item:typeof issue}>(peer,'POST',`${issuesPath}/${issue.id}/replies`,{requestId:crypto.randomUUID(),expectedRevision:issue.revision,kind:'proposal',text:'Use True.intro with an explicit explanation.'})).item;
  const proposalMessage=inbox(owner).items.find(item=>item.kind==='reply'&&item.href.includes(issue.id))!;assert.ok(proposalMessage);
  await page.goto(origin+'/workspace.html?tab=inbox&inbox=reply');await page.locator(`[data-inbox-item="${proposalMessage.id}"]`).getByRole('link',{name:language==='zh'?'打开并继续':'Open and continue',exact:true}).click();
  const issueCard=page.locator(`[data-collaboration-issue="${issue.id}"]`);await issueCard.getByText(language==='zh'?'补充意见或记录决议':'Reply or record a resolution',{exact:true}).click();
  const contribution=issueCard.getByLabel(language==='zh'?'补充内容':'Your contribution',{exact:true});
  await contribution.fill('Adopt the constructor; its type directly matches the target.');await issueCard.getByLabel(language==='zh'?'采用的方案（可选）':'Selected proposal (optional)').selectOption(issue.replies[0].id);
  let response=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===`${issuesPath}/${issue.id}/resolution`);
  await issueCard.getByRole('button',{name:language==='zh'?'记录决议':'Record resolution',exact:true}).click();assert.equal((await response).status(),200);
  const resolution=inbox(reviewer).items.find(item=>item.issueAction==='resolve'&&item.href.includes(issue.id))!;assert.ok(resolution);assert.equal(resolution.read,false);assert.equal(resolution.category,'progress');
  await peer.goto(origin+'/workspace.html?tab=inbox&inbox=unread');await peer.locator(`[data-inbox-item="${resolution.id}"]`).getByText(language==='zh'?'议题已有决议':'Issue resolved',{exact:true}).waitFor();
  await peer.locator('[data-collaboration-inbox]').screenshot({path:path.join(output,`issue-resolution-inbox-${language}-${width}.png`)});
  await peer.locator(`[data-inbox-item="${resolution.id}"]`).getByRole('link',{name:language==='zh'?'打开并继续':'Open and continue',exact:true}).click();
  await peer.locator(`[data-collaboration-issue="${issue.id}"]`).getByText('Adopt the constructor; its type directly matches the target.',{exact:true}).waitFor();assert.equal(new URL(peer.url()).searchParams.get('taskVersion'),'goal-v1');
  assert.equal(inbox(reviewer).items.find(item=>item.id===resolution.id)?.read,true);
  await issueCard.getByText('Adopt the constructor; its type directly matches the target.',{exact:true}).waitFor();
  if(!await contribution.isVisible())await issueCard.getByText(language==='zh'?'重新讨论':'Reopen discussion',{exact:true}).click();
  await contribution.fill('Recheck the boundary case before continuing.');response=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===`${issuesPath}/${issue.id}/resolution`);
  await issueCard.getByRole('button',{name:language==='zh'?'重新打开议题':'Reopen issue',exact:true}).click();assert.equal((await response).status(),200);
  const reopening=inbox(reviewer).items.find(item=>item.issueAction==='reopen'&&item.href.includes(issue.id))!;assert.ok(reopening);assert.notEqual(reopening.id,resolution.id);assert.equal(reopening.read,false);assert.equal(reopening.processed,false);
  await peer.goto(origin+'/workspace.html?tab=inbox&inbox=reply');await peer.locator(`[data-inbox-item="${reopening.id}"]`).getByRole('link',{name:language==='zh'?'打开并继续':'Open and continue',exact:true}).click();
  await peer.locator(`[data-collaboration-issue="${issue.id}"]`).getByText('Recheck the boundary case before continuing.',{exact:true}).waitFor();
  assert.equal(inbox(owner).items.some(item=>item.issueAction),false);
  checks.push({id:'C1-resolution-reopening-exact-inbox-continuation',language,width,proposalMessageId:proposalMessage.id,resolutionMessageId:resolution.id,reopeningMessageId:reopening.id,independentReadState:true,exactTaskVersion:'goal-v1'});

  const candidate=await createCandidate('Candidate A: decision draft continuity'),different=await createCandidate('Candidate B: separate decision');
  phase=`decision-draft-refresh-isolation-${language}-${width}`;
  await peer.goto(feedbackUrl(candidate.id));active=peer;
  const card=peer.locator(`#feedback-${candidate.id}`),decision=card.locator('[data-feedback-decision]');await openDetails(decision);
  const status=decision.locator('[data-decision-status]'),reason=decision.getByLabel(language==='zh'?'理由':'Reason',{exact:true}),evidence=decision.getByLabel(language==='zh'?'证据引用，每行一项':'Evidence references, one per line',{exact:true}),plan=decision.getByLabel(language==='zh'?'关联计划版本（可选）':'Related plan version (optional)',{exact:true});
  const before={status:'needs-info',text:'Explain why the constructor closes the target.',evidence:'task:goal@goal-v1\ncheck:fixture',planVersion:'plan-v1'};
  await status.selectOption(before.status);await reason.fill(before.text);await evidence.fill(before.evidence);await plan.fill(before.planVersion);
  await card.locator('[data-review-comment]').fill('A separate review comment remains independent.');
  await peer.reload();await openDetails(decision);assert.equal(await status.inputValue(),before.status);assert.equal(await reason.inputValue(),before.text);assert.equal(await evidence.inputValue(),before.evidence);assert.equal(await plan.inputValue(),before.planVersion);assert.equal(await card.locator('[data-review-comment]').inputValue(),'A separate review comment remains independent.');
  await peer.goto(feedbackUrl(different.id));const differentDecision=peer.locator(`#feedback-${different.id} [data-feedback-decision]`);await openDetails(differentDecision);assert.equal(await differentDecision.getByLabel(language==='zh'?'理由':'Reason',{exact:true}).inputValue(),'');
  await differentDecision.getByLabel(language==='zh'?'理由':'Reason',{exact:true}).fill('Independent decision for candidate B.');
  await peer.goto(feedbackUrl(candidate.id));await openDetails(decision);assert.equal(await reason.inputValue(),before.text);
  const local=decision.locator('[data-human-drafts]>details');await openDetails(local);
  response=peer.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/research/personal/drafts');await local.locator('[data-save-account-draft]').click();assert.equal((await response).status(),201);await decision.locator('[data-account-draft-notice]').waitFor();
  await second.goto(feedbackUrl(candidate.id));const remoteDecision=second.locator(`#feedback-${candidate.id} [data-feedback-decision]`);await openDetails(remoteDecision);const remote=remoteDecision.locator('[data-account-drafts]>details');await openDetails(remote);await remote.locator('[data-restore-account-draft]').click();
  await second.waitForFunction(({id,text})=>(document.querySelector(`#feedback-${id} [data-feedback-decision] textarea`)as HTMLTextAreaElement)?.value===text,{id:candidate.id,text:before.text});assert.equal(await remoteDecision.locator('[data-decision-status]').inputValue(),before.status);assert.equal(await remoteDecision.getByLabel(language==='zh'?'关联计划版本（可选）':'Related plan version (optional)',{exact:true}).inputValue(),before.planVersion);
  const otherDrafts=await http<{items:unknown[]}>(other,'GET','/api/research/personal/drafts?kind=review');assert.deepEqual(otherDrafts.items,[]);
  await decision.screenshot({path:path.join(output,`decision-restored-${language}-${width}.png`)});
  checks.push({id:'C2-complete-local-and-account-draft-restoration',language,width,fieldsRestored:true,otherCandidateIsolated:true,otherAccountIsolated:true,secondDeviceRestored:true});

  phase=`decision-version-check-${language}-${width}`;
  let current=service.research.projects.feedback(owner,project.id,candidate.id);
  await http(page,'POST',`${projectPath}/feedback/${candidate.id}/review`,{requestId:crypto.randomUUID(),expectedRevision:current.revision,action:'assign',reviewerId:peerId});
  await peer.reload();await openDetails(decision);await decision.locator('[data-decision-stale]').waitFor();assert.equal(await decision.locator('[data-save-decision]').isDisabled(),true);assert.equal(await reason.inputValue(),before.text);
  await decision.getByRole('button',{name:language==='zh'?'基于最新反馈提交':'Use latest feedback revision',exact:true}).click();assert.equal(await decision.locator('[data-save-decision]').isEnabled(),true);
  checks.push({id:'C2-changed-feedback-requires-explicit-review',language,width,editingPreserved:true,staleSubmitBlocked:true});

  phase=`decision-late-success-preserves-new-edits-${language}-${width}`;
  let held=false,release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);releases.push(release);
  const decisionPath=`${projectPath}/feedback/${candidate.id}/decision`;
  await peer.route(origin+decisionPath,async route=>{if(route.request().method()==='POST'&&!held){held=true;const saved=await route.fetch();await gate;await route.fulfill({response:saved});}else await route.continue();});
  response=peer.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===decisionPath);await decision.locator('[data-save-decision]').click();
  await peer.waitForFunction(async({path,id})=>(await(await fetch(path)).json()).item.feedback.find((item:{id:string})=>item.id===id)?.decision.status==='needs-info',{path:projectPath,id:candidate.id});
  const later={status:'declined',text:'New edits made while the saved response was pending.',evidence:'task:goal@goal-v1',planVersion:''};
  await status.selectOption(later.status);await reason.fill(later.text);await evidence.fill(later.evidence);await plan.fill(later.planVersion);release();assert.equal((await response).status(),200);
  await decision.locator('[data-save-decision]').waitFor();await settled(peer);assert.equal(await reason.inputValue(),later.text);assert.equal(await status.inputValue(),later.status);assert.equal(await evidence.inputValue(),later.evidence);
  await peer.unroute(origin+decisionPath);
  await peer.waitForFunction(async({projectId,feedbackId})=>{const result=await fetch(`/api/research/personal/drafts?projectId=${projectId}&kind=review&status=all`);if(!result.ok)throw new Error(`Draft verification HTTP ${result.status}`);const data=await result.json();return data.items.some((item:{scope:{sourceFeedbackId?:string;purpose?:string};versions:{status?:string}[]})=>item.scope.sourceFeedbackId===feedbackId&&item.scope.purpose==='decision'&&item.versions.some(version=>version.status==='submitted'));},{projectId:project.id,feedbackId:candidate.id},{polling:300});
  await peer.reload();await openDetails(decision);assert.equal(await reason.inputValue(),later.text);assert.equal(await status.inputValue(),later.status);assert.equal(await plan.inputValue(),later.planVersion);await decision.locator('[data-decision-stale]').waitFor();
  await decision.getByRole('button',{name:language==='zh'?'基于最新反馈提交':'Use latest feedback revision',exact:true}).click();
  // Once the saved form clears, a refresh must stay clear even while account archiving is pending.
  let heldArchive=false,releaseArchive!:()=>void,startArchive!:()=>void;const archiveGate=new Promise<void>(resolve=>releaseArchive=resolve);releases.push(releaseArchive);
  const archiveStarted=new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Final draft archival did not start')),15000);startArchive=()=>{clearTimeout(timer);resolve();};});releases.push(startArchive);
  const archivePattern=origin+'/api/research/personal/drafts?*';
  await peer.route(archivePattern,async route=>{
    const url=new URL(route.request().url());
    if(route.request().method()==='GET'&&!heldArchive&&url.searchParams.get('projectId')===project.id&&url.searchParams.get('kind')==='review'){
      heldArchive=true;startArchive();await archiveGate;await route.continue().catch(()=>{});
    }else await route.continue();
  });
  response=peer.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===decisionPath);await decision.locator('[data-save-decision]').click();assert.equal((await response).status(),200);
  await archiveStarted;assert.equal(heldArchive,true);
  await peer.waitForFunction(id=>(document.querySelector(`#feedback-${id} [data-feedback-decision] textarea`)as HTMLTextAreaElement)?.value==='',candidate.id);
  assert.equal(await status.inputValue(),'accepted');assert.equal(await evidence.inputValue(),'');assert.equal(await plan.inputValue(),'');
  await peer.reload();await openDetails(decision);assert.equal(await reason.inputValue(),'');assert.equal(await decision.locator('[data-human-drafts]>details').count(),0);
  releaseArchive();await peer.unroute(archivePattern);
  await decision.screenshot({path:path.join(output,`decision-submitted-cleared-${language}-${width}.png`)});
  checks.push({id:'C2-delayed-success-archives-submitted-snapshot-keeps-new-edit',language,width,savedSnapshotArchived:true,newEditsRetainedAcrossRefresh:true,finalSubmissionClearedAllFields:true,immediateRefreshWhileArchivePending:true});

  phase=`author-peer-review-next-step-${language}-${width}`;
  const ownCandidate=await createCandidate('Project owner candidate awaiting another member',false);
  await page.goto(feedbackUrl(ownCandidate.id));active=page;const ownCard=page.locator(`#feedback-${ownCandidate.id}`);await ownCard.locator('[data-decision-peer-required]').waitFor();
  const authorDecision=ownCard.locator('[data-feedback-decision]');await openDetails(authorDecision);
  assert.equal(await authorDecision.locator('[data-decision-status]').inputValue(),'');assert.equal(await authorDecision.locator('option[value="accepted"]').count(),0);
  assert.equal(await authorDecision.locator('option[value="needs-info"]').count(),1);assert.equal(await authorDecision.locator('option[value="declined"]').count(),1);
  assert.equal(await authorDecision.locator('[data-save-decision]').isDisabled(),true);assert.equal(await ownCard.locator('[data-candidate-approve]').count(),0);
  await ownCard.locator('[data-decision-peer-review]').click();assert.equal(await ownCard.locator('[data-reviewer-select]').evaluate(node=>node===document.activeElement),true);
  await ownCard.locator('[data-reviewer-select]').selectOption(peerId);response=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===`${projectPath}/feedback/${ownCandidate.id}/review`);await ownCard.getByRole('button',{name:language==='zh'?'确认分配':'Confirm assignment',exact:true}).click();assert.equal((await response).status(),200);
  assert.equal(inbox(reviewer).items.some(item=>item.kind==='review'&&item.feedbackId===ownCandidate.id),true);
  await ownCard.locator('[data-decision-peer-required]').screenshot({path:path.join(output,`author-peer-review-next-step-${language}-${width}.png`)});
  const protectedFeedback=service.research.projects.feedback(owner,project.id,ownCandidate.id);
  const selfReviewStatus=await page.evaluate(async({path,revision})=>{const session=await(await fetch('/api/session')).json();return(await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},body:JSON.stringify({requestId:crypto.randomUUID(),expectedRevision:revision,status:'accepted',reason:'Direct API self-review must remain forbidden.'})})).status;},{path:`${projectPath}/feedback/${ownCandidate.id}/decision`,revision:protectedFeedback.revision});assert.equal(selfReviewStatus,403);
  await peer.goto(feedbackUrl(ownCandidate.id));const independent=peer.locator(`#feedback-${ownCandidate.id}`);await independent.locator('[data-candidate-approve]').waitFor();assert.equal(await independent.locator('[data-feedback-decision]').count(),1);
  await authorDecision.locator('[data-decision-status]').selectOption('needs-info');await authorDecision.getByLabel(language==='zh'?'理由':'Reason',{exact:true}).fill('Author records that this argument needs an additional explanation.');
  response=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===`${projectPath}/feedback/${ownCandidate.id}/decision`);await authorDecision.locator('[data-save-decision]').click();assert.equal((await response).status(),200);
  assert.equal(service.research.projects.feedback(owner,project.id,ownCandidate.id).decision.status,'needs-info');
  await page.waitForFunction(id=>(document.querySelector(`#feedback-${id} [data-feedback-decision] textarea`)as HTMLTextAreaElement)?.value==='',ownCandidate.id);
  await authorDecision.locator('[data-decision-status]').selectOption('declined');await authorDecision.getByLabel(language==='zh'?'理由':'Reason',{exact:true}).fill('Author retires this approach after reviewing the missing explanation.');
  response=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===`${projectPath}/feedback/${ownCandidate.id}/decision`);await authorDecision.locator('[data-save-decision]').click();assert.equal((await response).status(),200);
  assert.equal(service.research.projects.feedback(owner,project.id,ownCandidate.id).decision.status,'declined');
  checks.push({id:'C3-author-assigns-reviewer-without-invalid-acceptance',language,width,authorAcceptanceAbsent:true,defaultChoiceEmpty:true,legalAuthorNeedsInfoRetained:200,legalAuthorDeclineRetained:200,peerNextStepFocused:true,assignmentSucceeded:200,reviewerNotified:true,independentApprovalAvailable:true,serverSelfApprovalRejected:403});
  for(const p of [page,peer,second,other])assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'No page overflow');
  service.jobs.cancel(owner,run.id);await Promise.all(actors.map(actor=>actor.close()));
  if(language==='zh'){
    // Each locale gets a fresh disposable HTTP service so full-page checks do not share one IP rate window.
    await service.close();service=makeService();
    await new Promise<void>((resolve,reject)=>{service.server.once('error',reject);service.server.listen(port,'127.0.0.1',resolve);});
  }
 }
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.equal(prohibited,0);assert.deepEqual(commands,[]);
}catch(cause){failure=cause;if(active&&!active.isClosed())await active.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});}
finally{
 releases.forEach(release=>release());
 await fs.writeFile(path.join(output,'report.json'),JSON.stringify({status:failure?'failed':'passed',at:new Date().toISOString(),build:JSON.parse(await fs.readFile(path.join(staticRoot,'build-info.json'),'utf8')),phase,checks,commands,controlledCheckCalls:compileCalls,realModels:0,realLean:0,externalMail:prohibited,errors,external,...(failure?{error:failure instanceof Error?failure.stack:String(failure),url:active&&!active.isClosed()?active.url():undefined}:{})},null,2));
 await browser.close();await service.close();await fs.rm(dataRoot,{recursive:true,force:true});
 await fs.writeFile(path.join(output,'cleanup.json'),JSON.stringify({browserClosed:true,serviceClosed:true,disposableDataRootRemoved:true},null,2));
}
if(failure)throw failure;console.log(`Passed ${checks.length} desktop/mobile collaboration continuity workflows`);
