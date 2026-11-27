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
import type { ResearchIssue } from '../apps/web/researchCollaborationTypes';
import type { ResearchFeedback, ResearchProjectDetail } from '../apps/web/researchProjectTypes';
import { seedCooperativeRun } from './web-cooperative-fixture';
import { freePort, startBrowser, preferFullCollaboration, settled } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..');
const output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/product-continuity/issue-action-continuity');
const staticRoot = process.env.THEOREMOS_FRONTEND_TEST_STATIC_ROOT ?? path.join(root, 'out/web');
await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(output, 'disposable-data-'));
const source = 'theorem target : True := by sorry\n', commit = '1'.repeat(40), environmentDigest = mathDigest('controlled-candidate-environment');
const stateDigest = mathDigest('candidate-v1');
const commands: string[] = [], executionWrites: string[] = [], errors: string[] = [], external: string[] = [], checks: object[] = [];
let compileCalls = 0, prohibited = 0, phase = 'setup', active: Page | undefined, failure: unknown;
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Controlled candidate workflow' }; },
  async check(input) { compileCalls++; return { exitCode: 0, timedOut: false, output: '', checkedTarget: input.candidateTarget?.name }; },
  async run(input, send, signal) {
    const observation = structuredClone(loadWebSample()!.observations.at(-1)!);
    observation.webRunId = input.id; observation.sequence = 1; observation.snapshot.stateDigest = stateDigest;
    observation.inspection.problem = { id: 'candidate-fixture', statement: 'Prove True', formalStatement: 'True', assumptions: [], targets: [{ theoremName: 'target', proofPath: 'Main.lean' }] };
    const configuration = observation.inspection.configuration;
    const { model, effort, workers, coordination } = input.input;
    Object.assign(configuration, { model, effort, workers, coordination, environmentDigest });
    delete configuration.researchMode;
    delete configuration.researchDelegation;
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
      signal.addEventListener('abort', () => resolve(), { once: true });
      send({ type: 'observation', observation });
    });
  },
  async command(_id, command) {
    if (command.type === 'capture') return { id: 'capture', status: 'captured' };
    commands.push(command.type);
    throw new Error('Historical issue execution must not dispatch a command');
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
  const run=await seedCooperativeRun(service,page.context(),origin,{providerId:'openai',apiKey:'sk-disposable-collaboration-fixture',model:'fixture',effort:'low',environment:'standard',source,task:'Prove True',maxTurns:2,maxRunSeconds:600,workers:2,coordination:'cooperative'});
  await page.waitForFunction(async id=>(await(await fetch(`/api/runs/${id}`)).json()).run.observation,run.id);
  let project=(await http<{item:ResearchProjectDetail}>(page,'POST','/api/research/theorems',{requestId:crypto.randomUUID(),title:'Human decision and action continuity',visibility:'members',candidateDeliveryPolicy:'reviewed'})).item;
  const projectPath=`/api/research/theorems/${project.id}`;
  project=(await http<{item:ResearchProjectDetail}>(page,'PUT',`${projectPath}/members/${peerId}`,{requestId:crypto.randomUUID(),expectedRevision:project.revision,role:'collaborator'})).item;
  project=(await http<{item:ResearchProjectDetail}>(page,'POST',`${projectPath}/versions`,{requestId:crypto.randomUUID(),expectedRevision:project.revision,source,statement:'Prove True',environment:'standard'})).item;
  project=(await http<{item:ResearchProjectDetail}>(page,'POST',`${projectPath}/runs`,{requestId:crypto.randomUUID(),expectedRevision:project.revision,runId:run.id,statementVersionId:project.currentStatementVersionId,grants:{guidance:true,edit:true,approve:true,proof:true}})).item;
  const target={runId:run.id,statementVersionId:project.currentStatementVersionId!,observationRef:{sequence:1,stateDigest},taskRef:{id:'goal',version:'goal-v1'}};
  const issueUrl=(id:string)=>`${origin}/theorems.html?${new URLSearchParams({id:project.id,run:run.id,version:target.statementVersionId,task:'goal',taskVersion:'goal-v1'})}#issue-${id}`;
  const createIssue=async(title:string,resolution?:string)=>{
   project=service.research.projects.detail(owner,project.id);
   let issue=(await http<{item:ResearchIssue}>(page,'POST',`${projectPath}/issues`,{requestId:crypto.randomUUID(),expectedRevision:project.revision,title,text:'Review the argument and agree on an explicit action.',target})).item;
   if(resolution)issue=(await http<{item:ResearchIssue}>(page,'POST',`${projectPath}/issues/${issue.id}/resolution`,{requestId:crypto.randomUUID(),expectedRevision:issue.revision,action:'resolve',text:resolution})).item;
   return issue;
  };
  const openIssue=async(p:Page,id:string)=>{active=p;await p.goto(issueUrl(id));const card=p.locator(`[data-collaboration-issue="${id}"]`);await card.waitFor();return card;};

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

  phase=`historical-execution-${language}`;
  const resolved = await createIssue('Decision: use the explicit constructor', 'Apply True.intro after checking the dependencies.');
  const resolution = resolved.resolution!;
  const issueSource = { issueId: resolved.id, issueRevision: resolved.revision, resolutionAt: resolution.createdAt };
  const feedbackId = 'historical-action-' + language;
  const savedText = 'Historical execution: the constructor closes the exact goal.';
  const historicalFeedback: ResearchFeedback = {
    id: feedbackId, requestId: crypto.randomUUID(), projectId: project.id,
    author: resolution.author, kind: 'guidance', text: savedText, visibility: 'members',
    issueSource: { ...issueSource, title: resolved.title, resolution: { text: resolution.text, author: resolution.author }, originalTarget: target },
    target, payload: { recipient: { kind: 'task', id: target.taskRef.id } },
    delivery: { status: 'delivered', commandId: feedbackId },
    decision: { status: 'not-recorded', evidenceRefs: [] },
    execution: { status: 'not-started', taskRefs: [], resultRefs: [] },
    revision: 1, createdAt: resolution.createdAt, updatedAt: resolution.createdAt,
  };
  const projectRecord = ['research', 'projects', `${project.id}.json`];
  const stored = seed.getRecord<{ feedback: ResearchFeedback[] }>(projectRecord)!;
  stored.feedback.push(historicalFeedback);
  seed.saveRecord(projectRecord, stored);

  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'POST' && [`${projectPath}/feedback`, `/api/runs/${run.id}/edits/preview`].includes(pathname)) {
      executionWrites.push(pathname);
    }
  });
  const draft = { kind: 'plan-edit', text: 'Unsent execution draft.', objective: 'Explain the proof step.', dependencies: 'lemma-a, lemma-b' };
  const pendingText = 'Execution request with a missing acknowledgement.';
  await page.evaluate(({ suffix, draft, input }) => {
    localStorage.setItem(`theoremos:issue-execution-draft:v1:${suffix}`, JSON.stringify(draft));
    localStorage.setItem(`theoremos:issue-execution-pending:v1:${suffix}`, JSON.stringify({ input }));
  }, {
    suffix: encodeURIComponent(JSON.stringify([service.research.projects.identity(owner), project.id, resolved.id])),
    draft, input: { kind: 'guidance', requestId: crypto.randomUUID(), text: pendingText, issueSource, target },
  });
  const execution = (await openIssue(page, resolved.id)).locator('[data-issue-execution]');
  const restored = execution.locator('[data-issue-execution-restored]');
  await openDetails(restored);
  for (const note of [draft.text, draft.objective, draft.dependencies, pendingText]) {
    await restored.getByText(note, { exact: true }).waitFor();
  }
  assert.equal(await execution.locator('form, button, input, select, textarea').count(), 0);
  await execution.screenshot({ path: path.join(output, `historical-execution-${language}-${width}.png`) });

  await execution.getByRole('link', {
    name: language === 'zh' ? '查看此议题的执行反馈' : 'View execution feedback from this issue', exact: true,
  }).click();
  await page.waitForURL(url => url.hash === `#feedback-${feedbackId}`);
  const feedback = page.locator(`#feedback-${feedbackId}`);
  await feedback.getByText(savedText, { exact: true }).waitFor();
  const feedbackSource = feedback.locator('[data-feedback-issue-source]');
  assert.ok((await feedbackSource.locator('summary').innerText()).includes(resolved.title));
  await openDetails(feedbackSource);
  await feedbackSource.getByText(resolution.text, { exact: true }).waitFor();
  assert.equal(await feedbackSource.locator('a').getAttribute('href'), `#issue-${resolved.id}`);
  assert.ok((await feedbackSource.locator('code').innerText()).includes(target.taskRef.version));
  await feedback.screenshot({ path: path.join(output, `historical-execution-feedback-${language}-${width}.png`) });
  checks.push({ id: 'historical-execution-is-read-only', language, width, feedbackId, restoredDraft: true, savedResolutionVisible: true });

  phase=`issue-contribution-late-success-${language}`;
  const late=await createIssue('Control: later contribution keeps its explicit reply target');
  let thread=(await http<{item:ResearchIssue}>(peer,'POST',`${projectPath}/issues/${late.id}/replies`,{requestId:crypto.randomUUID(),expectedRevision:late.revision,kind:'proposal',text:'Proposal A: use a constructor.'})).item;
  thread=(await http<{item:ResearchIssue}>(peer,'POST',`${projectPath}/issues/${late.id}/replies`,{requestId:crypto.randomUUID(),expectedRevision:thread.revision,kind:'proposal',text:'Proposal B: use the elimination rule.'})).item;
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
 assert.deepEqual(executionWrites, []);assert.deepEqual(commands, []);
}catch(cause){failure=cause;if(active&&!active.isClosed())await active.screenshot({path:path.join(output,'probe-failure.png'),fullPage:true}).catch(()=>{});}
finally{
 releases.forEach(release=>release());
 await fs.writeFile(path.join(output,'report.json'),JSON.stringify({status:failure?'failed':'passed',at:new Date().toISOString(),...provenance,phase,findings,checks,dialogs,commands,executionWrites,controlledCheckCalls:compileCalls,realModels:0,realLean:0,externalMail:prohibited,errors,external,...(failure?{error:failure instanceof Error?failure.stack:String(failure)}:{})},null,2));
 await browser.close();await service.close();await fs.rm(dataRoot,{recursive:true,force:true});await fs.writeFile(path.join(output,'cleanup.json'),JSON.stringify({browserClosed:true,serviceClosed:true,disposableDataRemoved:true}));
}
if(failure)throw failure;console.log(`Passed ${checks.length} collaboration action continuity workflows`);
