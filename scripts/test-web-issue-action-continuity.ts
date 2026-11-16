#!/usr/bin/env bun
// Disposable HTTP/Chromium state and a controlled runner. No models, Lean or mail.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
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

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/product-continuity/issue-action-continuity');
const staticRoot = process.env.THEOREMOS_FRONTEND_TEST_STATIC_ROOT ?? path.join(root, 'out/web');
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(output, 'disposable-data-'));
const source = 'theorem target : True := by sorry\n', commit = '1'.repeat(40), environmentDigest = mathDigest('controlled-candidate-environment');
const controls = new Map<string, { observation: WebObservation; emit(): void }>();
const commands: { id: string; type: string }[] = [], errors: string[] = [], external: string[] = [], checks: object[] = [];
let delivery: 'unknown' | 'delivered' = 'delivered';
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
    commands.push({ id, type: command.type }); if(command.type==='edit-preview')return {id,status:'validated',baseVersion:'plan-v1',affectedTaskIds:['goal']}; return { id, status: delivery, reason: delivery === 'unknown' ? 'Controlled delivery acknowledgement unavailable' : 'Controlled delivered receipt' };
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
const findings: object[] = [], dialogs: {language:string,type:string,message:string}[]=[];
const provenance={baseHead:'a9c7a7e4e2fe66a5822a1ccf80584ccbfcf76374',build:JSON.parse(await fs.readFile(path.join(staticRoot,'build-info.json'),'utf8'))};
try {
 for(const [language,width] of [['zh',1440],['en',390]] as const){
  phase=`setup-${language}`;const offset=language==='zh'?0:3;
  const actors=await Promise.all([0,1].map(async index=>{
   const actor=await browser.newContext({locale:language==='zh'?'zh-CN':'en-US',viewport:{width,height:1000},reducedMotion:'reduce'});
   await actor.addCookies([{name:'theoremos_session',value:sessions[offset+index].id,url:origin}]);
   await actor.addInitScript(language=>localStorage.setItem('theorem-os.web-locale.v1',language),language);await preferFullCollaboration(actor);
   await actor.route(/^https?:\/\//u,async route=>{if(new URL(route.request().url()).origin!==origin){external.push(route.request().url());await route.abort();}else await route.continue();});return actor;
  }));
  const [page,peer]=await Promise.all(actors.map(actor=>actor.newPage()));active=page;
  for(const p of [page,peer]){p.setDefaultTimeout(15000);p.on('pageerror',e=>errors.push(e.message));p.on('dialog',async dialog=>{dialogs.push({language,type:dialog.type(),message:dialog.message()});await dialog.accept();});await p.goto(origin+'/workspace.html');await p.locator('.workspace-tabs').waitFor();}
  const owner=`account:${accounts[offset].id}`,reviewer=`account:${accounts[offset+1].id}`,peerId=service.research.projects.identity(reviewer);
  for(const [p,name]of [[page,'Project Owner'],[peer,'Independent Reviewer']]as const)await http(p,'PUT','/api/research/profile',{requestId:crypto.randomUUID(),expectedRevision:0,displayName:name,visibility:'public'});
  const {run}=await http<{run:{id:string}}>(page,'POST','/api/runs',{requestId:crypto.randomUUID(),providerId:'openai',apiKey:'sk-disposable-collaboration-fixture',model:'fixture',effort:'low',environment:'standard',source,task:'Prove True',maxTurns:2,maxRunSeconds:600,workers:2,coordination:'cooperative'});
  await page.waitForFunction(async id=>(await(await fetch(`/api/runs/${id}`)).json()).run.observation,run.id);
  let project=(await http<{item:ResearchProjectDetail}>(page,'POST','/api/research/theorems',{requestId:crypto.randomUUID(),title:'Human decision and action continuity',visibility:'members',candidateDeliveryPolicy:'reviewed'})).item;
  const projectPath=`/api/research/theorems/${project.id}`;
  project=(await http<{item:ResearchProjectDetail}>(page,'PUT',`${projectPath}/members/${peerId}`,{requestId:crypto.randomUUID(),expectedRevision:project.revision,role:'collaborator'})).item;
  project=(await http<{item:ResearchProjectDetail}>(page,'POST',`${projectPath}/versions`,{requestId:crypto.randomUUID(),expectedRevision:project.revision,source,statement:'Prove True',environment:'standard'})).item;
  project=(await http<{item:ResearchProjectDetail}>(page,'POST',`${projectPath}/runs`,{requestId:crypto.randomUUID(),expectedRevision:project.revision,runId:run.id,statementVersionId:project.currentStatementVersionId,grants:{guidance:true,edit:true,approve:true,proof:true}})).item;
  const target={runId:run.id,statementVersionId:project.currentStatementVersionId!,observationRef:{sequence:1,stateDigest:controls.get(run.id)!.observation.snapshot.stateDigest},taskRef:{id:'goal',version:'goal-v1'}};
  const issueUrl=(id:string)=>`${origin}/theorems.html?${new URLSearchParams({id:project.id,run:run.id,version:target.statementVersionId,task:'goal',taskVersion:'goal-v1'})}#issue-${id}`;
  const createIssue=async(title:string,resolution?:string)=>{
   project=service.research.projects.detail(owner,project.id);
   let issue=(await http<{item:any}>(page,'POST',`${projectPath}/issues`,{requestId:crypto.randomUUID(),expectedRevision:project.revision,title,text:'Review the argument and agree on an explicit action.',target})).item;
   if(resolution)issue=(await http<{item:any}>(page,'POST',`${projectPath}/issues/${issue.id}/resolution`,{requestId:crypto.randomUUID(),expectedRevision:issue.revision,action:'resolve',text:resolution})).item;
   return issue;
  };
  const openIssue=async(p:Page,id:string)=>{active=p;await p.goto(issueUrl(id));const card=p.locator(`[data-collaboration-issue="${id}"]`);await card.waitFor();return card;};
  const openExecution=async(p:Page,id:string)=>{const card=await openIssue(p,id),execution=card.locator('[data-issue-execution]');await openDetails(execution.locator(':scope>details'));await execution.locator('[data-prepare-issue-execution]').waitFor();await p.waitForFunction(()=>!document.querySelector('main[aria-busy="true"]'));return execution;};
  const submitExecution=async(p:Page,execution:Locator)=>{
   await execution.locator('[data-prepare-issue-execution]').click();await execution.locator('[data-issue-execution-preview]').waitFor();await execution.locator('[data-confirm-issue-execution]').check();
   const response=p.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===`${projectPath}/feedback`);await execution.locator('[data-send-issue-execution]').click();const saved=await response;assert.equal(saved.status(),201);return(await saved.json()).item as ResearchFeedback;
  };

  phase=`normal-contribution-draft-${language}`;
  const open=await createIssue('Control: issue contribution survives navigation');
  const contributionText='CONTROL_DRAFT: explain how the constructor closes the theorem.';
  await http(peer,'POST',`${projectPath}/issues/${open.id}/replies`,{requestId:crypto.randomUUID(),expectedRevision:open.revision,kind:'proposal',text:'Message entry control: a proposal from the colleague.'});
  const message=service.research.projects.collaborationInbox(owner).items.find(item=>item.kind==='reply'&&item.href.includes(open.id))!;assert.ok(message);
  await page.goto(origin+'/workspace.html?tab=inbox&inbox=reply#collaboration-inbox');await page.locator(`[data-inbox-item="${message.id}"]`).getByRole('link',{name:language==='zh'?'打开并继续':'Open and continue',exact:true}).click();
  await page.locator(`[data-collaboration-issue="${open.id}"]`).waitFor();assert.equal(new URL(page.url()).searchParams.get('taskVersion'),'goal-v1');assert.equal(new URL(page.url()).hash,`#issue-${open.id}`);
  await page.goBack();await page.locator('[data-collaboration-inbox]').waitFor();assert.equal(new URL(page.url()).searchParams.get('inbox'),'reply');
  checks.push({id:'normal-message-exact-issue-and-browser-return',language,width,taskVersion:'goal-v1',issueId:open.id,backRestoresInbox:'reply'});
  let card=await openIssue(page,open.id);const contribution=card.locator('textarea[id^="issue-input-"]');await openDetails(card.locator(':scope>details').last());await contribution.fill(contributionText);await page.reload();card=page.locator(`[data-collaboration-issue="${open.id}"]`);await openDetails(card.locator(':scope>details').last());
  const picker=card.locator('[data-human-drafts]>details');await openDetails(picker);await picker.locator('[data-restore-draft]').click();assert.equal(await contribution.inputValue(),contributionText);
  await card.screenshot({path:path.join(output,`control-contribution-draft-${language}-${width}.png`)});
  checks.push({id:'normal-contribution-draft',language,width,localPickerAvailable:true,restoredText:await contribution.inputValue()});

  phase=`execution-edit-refresh-${language}`;
  const resolved=await createIssue('Decision: prepare the next exact step','Use the explicit constructor after checking all dependencies.');
  let execution=await openExecution(page,resolved.id);
  const edited='UNSAVED_ACTION: Check the current goal, explicitly construct True.intro, and record why no assumptions are needed.';
  const instructions=execution.getByLabel(language==='zh'?'执行说明':'Execution instructions',{exact:true});await instructions.fill(edited);
  await execution.locator('[data-issue-execution-kind]').selectOption('plan-edit');await execution.getByLabel(language==='zh'?'任务目标':'Task objective',{exact:true}).fill('HUMAN_PLAN_EDIT: Explain the construction and then close the exact goal.');await execution.getByLabel(language==='zh'?'前置任务，用逗号分隔':'Prerequisite task IDs, separated by commas',{exact:true}).fill('lemma-a, lemma-b');
  await execution.locator('[data-prepare-issue-execution]').waitFor({state:'visible'});
  await execution.screenshot({path:path.join(output,`execution-edit-before-refresh-${language}-${width}.png`)});
  const localBefore=await page.evaluate(()=>Object.keys(localStorage).filter(key=>key.startsWith('theoremos:issue-execution-draft:v1:')).map(key=>localStorage.getItem(key)).filter(Boolean));
  const dialogBefore=dialogs.length;await page.reload();execution=await openExecution(page,resolved.id);
  const afterInstructions=await execution.getByLabel(language==='zh'?'执行说明':'Execution instructions',{exact:true}).inputValue(),afterMode=await execution.locator('[data-issue-execution-kind]').inputValue();
  const restoredObjective=await execution.getByLabel(language==='zh'?'任务目标':'Task objective',{exact:true}).inputValue();
  assert.equal(afterInstructions,edited);assert.equal(afterMode,'plan-edit');assert.equal(restoredObjective,'HUMAN_PLAN_EDIT: Explain the construction and then close the exact goal.');assert.equal(await execution.getByLabel(language==='zh'?'前置任务，用逗号分隔':'Prerequisite task IDs, separated by commas',{exact:true}).inputValue(),'lemma-a, lemma-b');assert.equal(dialogs.length,dialogBefore);assert.equal(localBefore.some(v=>v!.includes('UNSAVED_ACTION')&&v!.includes('HUMAN_PLAN_EDIT')),true);
  await execution.locator('[data-issue-execution-restored]').waitFor();assert.equal(await execution.locator('[data-prepare-issue-execution]').isDisabled(),true);assert.equal(await execution.locator('[data-issue-execution-preview]').count(),0);
  await execution.screenshot({path:path.join(output,`execution-edit-restored-${language}-${width}.png`)});
  await execution.locator('[data-confirm-issue-task-version]:enabled').click();await execution.locator('[data-prepare-issue-execution]:enabled').waitFor();
  checks.push({id:'A4-complete-action-draft-restores-and-requires-review',language,width,mode:afterMode,text:afterInstructions,objective:restoredObjective,restoredWithoutOldConfirmation:true});

  phase=`normal-execution-and-return-${language}`;
  delivery='delivered';await execution.locator('[data-issue-execution-kind]').selectOption('guidance');const normal=await submitExecution(page,execution);assert.equal(normal.delivery.status,'delivered');await execution.getByRole('button',{name:language==='zh'?'查看后续采纳与执行':'View decisions and execution',exact:true}).click();
  const feedback=page.locator(`#feedback-${normal.id}`);await feedback.waitFor();assert.ok((await feedback.innerText()).includes(edited));
  await feedback.screenshot({path:path.join(output,`control-execution-feedback-${language}-${width}.png`)});
  checks.push({id:'normal-resolution-execution-feedback',language,width,feedbackId:normal.id,delivery:normal.delivery.status,exactTaskVersion:new URL(page.url()).searchParams.get('taskVersion')});

  phase=`unknown-execution-refresh-${language}`;
  const uncertain=await createIssue('Decision: an acknowledgement may arrive late','Follow the resolved construction exactly once.');delivery='unknown';execution=await openExecution(peer,uncertain.id);await execution.locator('[data-prepare-issue-execution]:enabled').waitFor();
  const first=await submitExecution(peer,execution);assert.equal(first.delivery.status,'unknown');await execution.locator('[data-issue-execution-pending]').waitFor();
  const beforeCommands=commands.filter(command=>command.type==='guidance').length;
  const checkResponse=peer.waitForResponse(r=>r.request().method()==='GET'&&new URL(r.url()).pathname===`${projectPath}/feedback`);await execution.locator('[data-query-issue-execution]').click();assert.equal((await checkResponse).status(),200);await settled(peer);
  assert.equal(commands.filter(command=>command.type==='guidance').length,beforeCommands);
  assert.equal(await execution.locator('[data-retry-issue-execution]').count(),0);
  await execution.screenshot({path:path.join(output,`unknown-execution-before-refresh-${language}-${width}.png`)});
  await peer.reload();execution=await openExecution(peer,uncertain.id);await execution.locator('[data-issue-execution-pending]').waitFor();assert.equal(await execution.locator('[data-issue-execution-pending]').getAttribute('data-issue-execution-request'),first.requestId);assert.equal(await execution.locator('[data-prepare-issue-execution]').isDisabled(),true);
  await execution.locator('[data-issue-execution-notice]').waitFor();assert.equal(await execution.locator('[data-retry-issue-execution]').count(),0);
  await execution.screenshot({path:path.join(output,`unknown-execution-restored-${language}-${width}.png`)});
  await peer.goto(origin+'/workspace.html?tab=inbox');execution=await openExecution(peer,uncertain.id);await execution.locator('[data-issue-execution-pending]').waitFor();assert.equal(await execution.locator('[data-issue-execution-pending]').getAttribute('data-issue-execution-request'),first.requestId);
  assert.equal(commands.filter(command=>command.id===first.id).length,1);assert.equal(service.research.projects.detail(owner,project.id).feedback.filter(f=>f.issueSource?.issueId===uncertain.id).length,1);
  service.research.projects.recordCommand(owner,project.id,first.id,{id:first.id,status:'delivered'});await peer.reload();execution=await openExecution(peer,uncertain.id);await peer.waitForFunction(()=>!document.querySelector('[data-issue-execution-pending]'));
  checks.push({id:'A3-unknown-original-survives-refresh-and-reopen',language,width,originalRequestId:first.requestId,controlledDeliveries:1,newActionBlockedWhileUnknown:true,confirmedReceiptClearsPending:true});

  phase=`missing-original-retry-and-changed-target-${language}`;
  const interrupted=await createIssue('Decision: a request was not received','Send the original action once.');execution=await openExecution(peer,interrupted.id);await execution.locator('[data-prepare-issue-execution]:enabled').waitFor();
  let interruptedBody:any,interruptionDone!:()=>void;const interruption=new Promise<void>(resolve=>interruptionDone=resolve);const feedbackPath=origin+`${projectPath}/feedback`;
  await peer.route(feedbackPath,async route=>{if(route.request().method()==='POST'){interruptedBody=route.request().postDataJSON();await route.abort('failed');interruptionDone();}else await route.continue();});
  await execution.locator('[data-prepare-issue-execution]').click();await execution.locator('[data-confirm-issue-execution]').check();await execution.locator('[data-send-issue-execution]').click();await interruption;await execution.locator('[data-issue-execution-pending]').waitFor();await peer.unroute(feedbackPath);
  assert.ok(interruptedBody.requestId);await peer.reload();execution=await openExecution(peer,interrupted.id);await execution.locator('[data-retry-issue-execution]:enabled').waitFor();assert.equal(await execution.locator('[data-issue-execution-pending]').getAttribute('data-issue-execution-request'),interruptedBody.requestId);
  const control=controls.get(run.id)!,originalObservation=structuredClone(control.observation);control.observation.history=[structuredClone(control.observation.inspection.tasks[0])];control.observation.inspection.tasks[0].version='goal-v2';control.observation.sources[0].taskVersion='goal-v2';control.observation.sequence=2;control.observation.snapshot.stateDigest=mathDigest('version-changed');control.emit();
  await peer.reload();execution=await openExecution(peer,interrupted.id);await execution.locator('[data-retry-issue-execution]').waitFor();assert.equal(await execution.locator('[data-retry-issue-execution]').isDisabled(),true);assert.equal(await execution.locator('[data-issue-execution-pending]').getAttribute('data-issue-execution-request'),interruptedBody.requestId);
  await execution.screenshot({path:path.join(output,`original-retry-blocked-changed-task-${language}-${width}.png`)});
  control.observation={...originalObservation,sequence:3,snapshot:{...originalObservation.snapshot,stateDigest:mathDigest('task-version-restored')}};control.emit();await peer.reload();execution=await openExecution(peer,interrupted.id);await execution.locator('[data-retry-issue-execution]:enabled').waitFor();
  const retriedResponse=peer.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===`${projectPath}/feedback`);await execution.locator('[data-retry-issue-execution]').click();const retryResponse=await retriedResponse;assert.equal(retryResponse.status(),201);const retryRecord=(await retryResponse.json()).item;assert.equal(retryRecord.requestId,interruptedBody.requestId);assert.equal(retryRecord.text,interruptedBody.text);assert.deepEqual(retryRecord.target,interruptedBody.target);assert.equal(commands.filter(command=>command.id===retryRecord.id).length,1);
  checks.push({id:'A3-missing-request-retry-keeps-original-id-and-frozen-target',language,width,originalId:interruptedBody.requestId,retriedId:retryRecord.requestId,targetChangesBlockRetry:true,controlledDeliveries:1});

  phase=`issue-contribution-late-success-${language}`;
  const late=await createIssue('Control: later contribution keeps its explicit reply target');
  let thread=(await http<{item:any}>(peer,'POST',`${projectPath}/issues/${late.id}/replies`,{requestId:crypto.randomUUID(),expectedRevision:late.revision,kind:'proposal',text:'Proposal A: use a constructor.'})).item;
  thread=(await http<{item:any}>(peer,'POST',`${projectPath}/issues/${late.id}/replies`,{requestId:crypto.randomUUID(),expectedRevision:thread.revision,kind:'proposal',text:'Proposal B: use the elimination rule.'})).item;
  card=await openIssue(page,late.id);await openDetails(card.locator(':scope>details').last());const input=card.locator('textarea[id^="issue-input-"]');
  await card.locator('.collaboration-replies>li').first().getByRole('button',{name:language==='zh'?'回复此条':'Reply',exact:true}).click();await input.fill('First reply sent to proposal A.');
  const replyPath=`${projectPath}/issues/${late.id}/replies`;let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);releases.push(release);
  await page.route(origin+replyPath,async route=>{if(route.request().method()==='POST'){const result=await route.fetch();await gate;await route.fulfill({response:result});}else await route.continue();});
  const savedResponse=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===replyPath);await card.getByRole('button',{name:language==='zh'?'提交意见':'Post reply',exact:true}).click();
  await page.waitForFunction(async({path,id})=>(await(await fetch(path)).json()).item.issues.find((issue:any)=>issue.id===id)?.replies.length===3,{path:`${projectPath}/collaboration`,id:late.id});
  await card.locator('.collaboration-replies>li').nth(1).getByRole('button',{name:language==='zh'?'回复此条':'Reply',exact:true}).click();await input.fill('Second unsent reply is specifically about proposal B.');assert.equal(await card.getByText(language==='zh'?'取消回复关联':'Clear reply target',{exact:true}).count(),1);
  release();const firstReplyResponse=await savedResponse;assert.equal(firstReplyResponse.status(),200);const firstSaved=(await firstReplyResponse.json()).item.replies.at(-1);assert.equal(firstSaved.replyTo,thread.replies[0].id);await page.unroute(origin+replyPath);
  await card.getByRole('button',{name:language==='zh'?'提交意见':'Post reply',exact:true}).waitFor({state:'visible'});await page.waitForFunction(id=>!document.querySelector(`#issue-${id} button[type="submit"]`)?.hasAttribute('disabled'),late.id);await settled(page);
  const lateText=await input.inputValue(),replyTargetVisible=await card.getByText(language==='zh'?'取消回复关联':'Clear reply target',{exact:true}).count();assert.equal(lateText,'Second unsent reply is specifically about proposal B.');assert.equal(replyTargetVisible,1);
  await card.screenshot({path:path.join(output,`contribution-late-success-${language}-${width}.png`)});
  await page.reload();await openDetails(card.locator(':scope>details').last());const recoveredReply=card.locator('[data-human-drafts]>details');await openDetails(recoveredReply);await recoveredReply.locator('[data-restore-draft]').click();assert.equal(await input.inputValue(),lateText);assert.equal(await card.getByText(language==='zh'?'取消回复关联':'Clear reply target',{exact:true}).count(),1);assert.equal(await card.getByRole('button',{name:language==='zh'?'提交意见':'Post reply',exact:true}).isEnabled(),true);
  const secondReplyResponse=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===replyPath);await card.getByRole('button',{name:language==='zh'?'提交意见':'Post reply',exact:true}).click();const secondSavedResponse=await secondReplyResponse;assert.equal(secondSavedResponse.status(),200);const secondSaved=(await secondSavedResponse.json()).item.replies.at(-1);assert.equal(secondSaved.text,lateText);assert.equal(secondSaved.replyTo,thread.replies[1].id);
  await card.getByText(lateText,{exact:true}).waitFor();await card.screenshot({path:path.join(output,`contribution-second-saved-with-target-${language}-${width}.png`)});
  checks.push({id:'A5-delayed-reply-success-preserves-new-reply-target',language,width,issueId:late.id,firstSavedReplyTarget:firstSaved.replyTo,intendedSecondReplyTarget:thread.replies[1].id,newTextPreserved:lateText,secondSaved:{text:secondSaved.text,replyTo:secondSaved.replyTo??null},positiveControlFirstReplyTargetPreserved:true});

  for(const p of [page,peer])assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  service.jobs.cancel(owner,run.id);await Promise.all(actors.map(actor=>actor.close()));
  if(language==='zh'){await service.close();service=makeService();await new Promise<void>((resolve,reject)=>{service.server.once('error',reject);service.server.listen(port,'127.0.0.1',resolve);});}
 }
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.equal(prohibited,0);
}catch(cause){failure=cause;if(active&&!active.isClosed())await active.screenshot({path:path.join(output,'probe-failure.png'),fullPage:true}).catch(()=>{});}
finally{
 releases.forEach(release=>release());
 await fs.writeFile(path.join(output,'report.json'),JSON.stringify({status:failure?'failed':'passed',at:new Date().toISOString(),...provenance,phase,findings,checks,dialogs,commands,controlledCheckCalls:compileCalls,realModels:0,realLean:0,externalMail:prohibited,errors,external,...(failure?{error:failure instanceof Error?failure.stack:String(failure)}:{})},null,2));
 await browser.close();await service.close();await fs.rm(dataRoot,{recursive:true,force:true});await fs.writeFile(path.join(output,'cleanup.json'),JSON.stringify({browserClosed:true,serviceClosed:true,disposableDataRemoved:true}));
}
if(failure)throw failure;console.log(`Passed ${checks.length} collaboration action continuity workflows`);
