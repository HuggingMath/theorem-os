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
import { freePort, startBrowser, preferFullCollaboration, settled, waitForRun } from './web-scenario';

const root = path.resolve('.'), output = path.resolve(root, process.env.THEOREMOS_TEST_OUTPUT ?? 'out/product-continuity/research-lifecycle/decisions');
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
    if (command.type === 'guidance-withdraw') return { id: command.id, status: 'rejected', reason: 'fixture_guidance_withdraw_not_simulated' };
    const id = command.type === 'guidance' ? command.guidance.id : command.type === 'plan-approval' ? command.approval.id : command.proposal.id;
    commands.push({ id, type: command.type }); return { id, status: 'unknown', reason: 'Recorded fixture: command acknowledgement unavailable' };
  },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const fixtureClientIpHeader = 'x-fixture-client-ip';
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot, THEOREMOS_WEB_CONCURRENCY: '4',
  THEOREMOS_WEB_CLIENT_IP_HEADER: fixtureClientIpHeader }), runner,
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
  for (const [language, width] of [['zh', 1440], ['en', 390]] as const) {
    phase = `setup-${language}-${width}`;
    // Each simulated visitor has its own rate limit, even though Chromium connects over loopback.
    const firstAddress = language === 'zh' ? 1 : 3;
    const actors = await Promise.all([0, 1].map(index => browser.newContext({ locale: language === 'zh' ? 'zh-CN' : 'en-US',
      viewport: { width, height: 1000 }, reducedMotion: 'reduce',
      extraHTTPHeaders: { [fixtureClientIpHeader]: `192.0.2.${firstAddress + index}` } })));
    for (const actor of actors) {
      await actor.addInitScript(language => { try { localStorage.setItem('theorem-os.web-locale.v1', language); } catch {} }, language);
      await preferFullCollaboration(actor);
      await actor.route(/^https?:\/\//u, async route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue(); });
    }
    const [page, peer] = await Promise.all(actors.map(actor => actor.newPage())); active = page;
    for (const current of [page, peer]) { current.setDefaultTimeout(15_000); current.on('pageerror', error => errors.push(error.message)); }
    await Promise.all([page, peer].map(async current => { await current.goto(origin + '/workspace.html'); await current.locator('.workspace-tabs').waitFor(); }));
    const owner = (await actors[0].cookies(origin)).find(cookie => cookie.name === 'theoremos_session')!.value;
    const peerOwner = (await actors[1].cookies(origin)).find(cookie => cookie.name === 'theoremos_session')!.value;
    await http(page, 'PUT', '/api/research/profile', { requestId: crypto.randomUUID(), expectedRevision: 0, displayName: 'Solo Researcher', visibility: 'public' });
    await http(peer, 'PUT', '/api/research/profile', { requestId: crypto.randomUUID(), expectedRevision: 0, displayName: 'Private Teammate', visibility: 'private' });
    const peerId = service.research.projects.identity(peerOwner);
    const { run } = await http<{ run: { id: string } }>(page, 'POST', '/api/runs', { requestId: crypto.randomUUID(), providerId: 'openai', apiKey: 'sk-disposable-audit-fixture', model: 'fixture', effort: 'low', environment: 'standard', source, task: 'Prove True', maxTurns: 2, maxRunSeconds: 600, workers: 2, coordination: 'cooperative' });
    await waitForRun({page},run.id,item=>Boolean(item.observation));

    phase = `personal-guidance-unknown-${language}-${width}`;
    const route = `${origin}/problem.html?run=${run.id}&tab=route`;
    const sent: any[] = [];
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/runs/${run.id}/guidance`) sent.push(request.postDataJSON()); });
    await page.goto(route); await page.locator('[data-inline-open]').click();
    const note = language === 'zh' ? '请先核对归纳基，再按 n 到 n+1 的顺序处理归纳步。' : 'Check the induction base before deriving the step from n to n+1.';
    await page.locator('[data-inline-guidance] > summary').click();
    const guide = page.locator('[data-inline-guidance]');
    await guide.getByLabel(language === 'zh' ? '希望怎样改进这一步或路线' : 'How should this step or route improve?', { exact: true }).fill(note);
    await guide.locator('[data-inline-confirm-guidance]').check(); await guide.locator('[data-inline-send-guidance]').click();
    await guide.locator('[data-inline-command-status="unknown"]').waitFor();
    const original = structuredClone(sent[0]);
    await page.reload(); await page.locator('[data-inline-open]').click(); await guide.locator('[data-inline-pending-guidance]').waitFor();
    assert.equal(await guide.getByLabel(language === 'zh' ? '希望怎样改进这一步或路线' : 'How should this step or route improve?', { exact: true }).inputValue(), note);
    assert.equal(sent.length, 1); assert.equal(await guide.locator('[data-inline-send-guidance]').isDisabled(), true);
    await guide.locator('[data-inline-retry-command]').click(); await settled(page); assert.equal(sent.length, 1);
    // Receipt absent on the server: only an explicit retry may POST the original command.
    let missing = true, resolved = false, hold = false, release: (() => void) | undefined;
    await page.route(`**/api/runs/${run.id}/commands/${original.id}`, async route => {
      if (hold) await new Promise<void>(resolve => { release = resolve; });
      if (resolved) await route.fulfill({ json: { receipt: { id: original.id, status: 'delivered' } } });
      else if (missing) await route.fulfill({ status: 404, json: { error: 'Fixture receipt absent' } });
      else await route.continue();
    });
    await page.reload(); await page.locator('[data-inline-open]').click(); await guide.locator('[data-inline-pending-guidance]').waitFor();
    await settled(page); assert.equal(sent.length, 1);
    await guide.locator('[data-inline-retry-command]').click(); await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[data-inline-retry-command]')?.disabled);
    assert.equal(sent.length, 2); assert.deepEqual(sent[1], original);
    const revised = note + ' NEW UNSUBMITTED DETAIL';
    await guide.getByLabel(language === 'zh' ? '希望怎样改进这一步或路线' : 'How should this step or route improve?', { exact: true }).fill(revised);
    controls.get(run.id)!.observation.inspection.planVersion = 'plan-v2'; controls.get(run.id)!.observation.sequence++; controls.get(run.id)!.emit();
    await waitForRun({page},run.id,item=>item.observation?.inspection.planVersion==='plan-v2');
    await page.reload(); await page.locator('[data-inline-open]').click(); await guide.locator('[data-inline-pending-guidance]').waitFor(); await settled(page);
    assert.equal(await guide.locator('[data-inline-retry-command]').count(), 0); assert.equal(sent.length, 2);
    assert.equal(await guide.getByLabel(language === 'zh' ? '希望怎样改进这一步或路线' : 'How should this step or route improve?', { exact: true }).inputValue(), revised);
    await page.locator('[data-inline-drawer]').screenshot({path:path.join(output, `guidance-changed-target-${language}-${width}.png`)});
    missing = false; resolved = true; hold = true;
    await guide.locator('[data-inline-query-command]').click();
    for(let i=0;i<50&&!release;i++)await page.waitForTimeout(20);
    const newer = revised + ' WHILE WAITING';
    await guide.getByLabel(language === 'zh' ? '希望怎样改进这一步或路线' : 'How should this step or route improve?', { exact: true }).fill(newer);
    assert.ok(release); release!(); hold = false;
    await guide.locator('[data-inline-command-status="delivered"]').waitFor();
    assert.equal(await guide.getByLabel(language === 'zh' ? '希望怎样改进这一步或路线' : 'How should this step or route improve?', { exact: true }).inputValue(), newer);
    await page.reload(); await page.locator('[data-inline-open]').click(); await guide.waitFor(); await settled(page);
    assert.equal(await guide.locator('[data-inline-pending-guidance]').count(), 0); assert.equal(sent.length, 2);
    checks.push({id:'guidance-original-id-refresh-retry-version-change-late-result',language,width,requestIds:sent.map(x=>x.id),preservedDraft:newer});

    phase = `solo-candidate-review-${language}-${width}`;
    let project = (await http<{item:ResearchProjectDetail}>(page,'POST','/api/research/theorems',{requestId:crypto.randomUUID(),title:'Solo reviewed candidate',visibility:'members',candidateDeliveryPolicy:'reviewed'})).item;
    const projectPath=`/api/research/theorems/${project.id}`;
    project=(await http<{item:ResearchProjectDetail}>(page,'POST',`${projectPath}/versions`,{requestId:crypto.randomUUID(),expectedRevision:project.revision,source,statement:'Prove True',environment:'standard'})).item;
    project=(await http<{item:ResearchProjectDetail}>(page,'POST',`${projectPath}/runs`,{requestId:crypto.randomUUID(),expectedRevision:project.revision,runId:run.id,statementVersionId:project.currentStatementVersionId,grants:{guidance:true,edit:true,approve:true,proof:true}})).item;
    const target={runId:run.id,statementVersionId:project.currentStatementVersionId!,observationRef:{sequence:controls.get(run.id)!.observation.sequence,stateDigest:controls.get(run.id)!.observation.snapshot.stateDigest},taskRef:{id:'goal',version:'goal-v1'}};
    const candidate=(await http<{item:ResearchFeedback}>(page,'POST',`${projectPath}/feedback`,{requestId:crypto.randomUUID(),kind:'proof-submission',text:'A direct proof of True',source:'theorem target : True := by trivial\n',base:{commit,sourceDigest:mathDigest(source),environmentDigest,file:'Main.lean'},target})).item;
    assert.equal(candidate.candidateDelivery?.status,'awaiting-review');
    const problemUrl=`${origin}/problem.html?run=${run.id}&project=${project.id}`;
    await page.goto(problemUrl); const attention=page.locator(`[data-problem-attention-item="feedback:${candidate.id}"]`);await attention.waitFor();
    const responsibility=await attention.locator('.problem-responsibility').innerText();assert.doesNotMatch(responsibility,/Solo Researcher/);
    await attention.screenshot({path:path.join(output,`solo-candidate-responsibility-${language}-${width}.png`)});
    await attention.getByRole('link',{name:language==='zh'?'打开评审记录 →':'Open review record →',exact:true}).click();
    const card=page.locator(`#feedback-${candidate.id}`);await card.waitFor();
    const review=card.locator('[data-feedback-review]');
    await review.locator('[data-reviewer-empty]').waitFor(); assert.equal(await review.locator('[data-candidate-approve]').count(),0);
    await review.screenshot({path:path.join(output,`solo-candidate-review-${language}-${width}.png`)});
    await review.locator('[data-reviewer-members]').click();
    await page.locator('[data-reviewer-return] a').waitFor();
    assert.equal(new URL(page.url()).searchParams.get('reviewFeedback'), candidate.id);
    assert.equal(new URL(page.url()).searchParams.get('taskVersion'), 'goal-v1');
    const returnHref=await page.locator('[data-reviewer-return] a').getAttribute('href'); assert.ok(returnHref?.includes(candidate.id));
    project=service.research.projects.detail(owner,project.id);
    project=service.research.projects.setMember(owner,project.id,peerId,{requestId:crypto.randomUUID(),expectedRevision:project.revision,role:'collaborator'});
    await page.reload(); await page.locator('[data-reviewer-return] a').click(); await card.waitFor();
    await review.locator('[data-reviewer-select]').selectOption(peerId);
    await Promise.all([page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===`${projectPath}/feedback/${candidate.id}/review`), review.getByRole('button',{name:language==='zh'?'确认分配':'Confirm assignment',exact:true}).click()]);
    await page.waitForFunction(({candidateId}) => document.querySelector(`#feedback-${candidateId} [data-feedback-review]`)?.textContent?.includes('Private Teammate'), {candidateId:candidate.id,peerId});
    assert.equal(service.research.projects.detail(owner,project.id).feedback.find(item=>item.id===candidate.id)?.review?.reviewer.id,peerId);
    assert.equal(await review.locator('[data-candidate-approve]').count(),0);
    checks.push({id:'independent-reviewer-empty-members-return-assign',language,width,responsibility,returnHref,reviewer:peerId,selfApprove:false});

    phase=`handoff-draft-${language}-${width}`;
    project=service.research.projects.detail(owner,project.id);
    const taskUrl=`${origin}/theorems.html?${new URLSearchParams({id:project.id,run:run.id,task:'goal',taskVersion:'goal-v1'})}`;
    await page.goto(taskUrl);const workspace=page.locator('[data-task-workspace]');await workspace.waitFor();
    await workspace.getByRole('combobox').first().selectOption(JSON.stringify(['goal','goal-v1']));
    await workspace.getByText(language==='zh'?'正式交接给同行':'Hand off to a colleague',{exact:true}).click();
    const recipient=workspace.getByLabel(language==='zh'?'接手人':'Next researcher');await recipient.selectOption(peerId);
    const noteLabel=language==='zh'?'已有结果、未解问题与下一步':'Current results, open questions and next steps';
    const handoffNote='HANDOFF_AUDIT: normalization is checked; the induction step needs a bound. Please verify the boundary case before editing the conclusion.';
    await workspace.getByLabel(noteLabel,{exact:true}).fill(handoffNote);
    await workspace.screenshot({path:path.join(output,`handoff-before-refresh-${language}-${width}.png`)});
    const locallySaved=await page.evaluate(text=>Object.values(localStorage).some(value=>value.includes(text)),handoffNote);
    await page.reload();await workspace.waitFor();await workspace.getByRole('combobox').first().selectOption(JSON.stringify(['goal','goal-v1']));
    await workspace.locator('[data-handoff-restored]').waitFor();
    const restoredNote=await workspace.getByLabel(noteLabel,{exact:true}).inputValue(),restoredRecipient=await workspace.locator('[data-handoff-recipient]').inputValue();
    assert.equal(restoredNote,handoffNote);assert.equal(restoredRecipient,peerId);assert.equal(locallySaved,true);
    await workspace.screenshot({path:path.join(output,`handoff-after-refresh-${language}-${width}.png`)});
    project=service.research.projects.detail(owner,project.id);
    project=service.research.projects.setMember(owner,project.id,peerId,{requestId:crypto.randomUUID(),expectedRevision:project.revision,role:'reader'});
    await page.reload(); await workspace.waitFor(); await workspace.getByRole('combobox').first().selectOption(JSON.stringify(['goal','goal-v1']));
    await workspace.locator('[data-handoff-review]').waitFor(); assert.equal(await workspace.locator('[data-handoff-submit]').isDisabled(),true);
    assert.equal(await workspace.getByLabel(noteLabel,{exact:true}).inputValue(),handoffNote);
    project=service.research.projects.detail(owner,project.id);
    project=service.research.projects.setMember(owner,project.id,peerId,{requestId:crypto.randomUUID(),expectedRevision:project.revision,role:'collaborator'});
    const next=controls.get(run.id)!.observation; next.history=[structuredClone(next.inspection.tasks[0])]; next.inspection.tasks[0].version='goal-v2'; next.sources[0].taskVersion='goal-v2'; next.sequence++; controls.get(run.id)!.emit();
    await waitForRun({page},run.id,item=>item.observation?.inspection.tasks[0].version==='goal-v2');
    await page.reload(); await workspace.waitFor(); await workspace.getByRole('combobox').first().selectOption(JSON.stringify(['goal','goal-v2']));
    await workspace.locator('[data-handoff-review]').waitFor(); assert.equal(await workspace.getByLabel(noteLabel,{exact:true}).inputValue(),handoffNote);
    assert.equal(await workspace.locator('[data-handoff-submit]').isDisabled(),true);
    await workspace.locator('[data-handoff-confirm-context]').click(); assert.equal(await workspace.locator('[data-handoff-submit]').isEnabled(),true);
    let completeHandoff: (()=>void)|undefined;
    await page.route(`**${projectPath}/handoffs`,async route=>{
      if(route.request().method()!=='POST')return route.continue();
      const response=await route.fetch(); await new Promise<void>(resolve=>{completeHandoff=resolve;}); await route.fulfill({response});
    });
    await workspace.locator('[data-handoff-submit]').click();
    for(let i=0;i<30&&!completeHandoff;i++)await page.waitForTimeout(30);
    assert.ok(completeHandoff);
    const laterNote=handoffNote+' ANOTHER HANDOFF DRAFT';await workspace.getByLabel(noteLabel,{exact:true}).fill(laterNote);
    completeHandoff!();await settled(page);
    assert.equal(await workspace.getByLabel(noteLabel,{exact:true}).inputValue(),laterNote);
    await page.reload();await workspace.waitFor();await workspace.getByRole('combobox').first().selectOption(JSON.stringify(['goal','goal-v2']));
    await workspace.locator('[data-handoff-restored]').waitFor();assert.equal(await workspace.getByLabel(noteLabel,{exact:true}).inputValue(),laterNote);
    await page.unroute(`**${projectPath}/handoffs`);
    const handoff=service.research.projects.collaboration(owner,project.id).handoffs.find(item=>item.status==='pending'&&item.target.taskRef?.version==='goal-v2')!;
    assert.ok(handoff); service.research.projects.respondHandoff(peerOwner,project.id,handoff.id,{requestId:crypto.randomUUID(),expectedRevision:handoff.revision,action:'decline'});
    await page.reload();await workspace.waitFor();await workspace.getByRole('combobox').first().selectOption(JSON.stringify(['goal','goal-v2']));
    await workspace.locator('[data-handoff-submit]').click();await page.waitForFunction(()=>document.querySelector<HTMLTextAreaElement>('[data-handoff-composer] textarea')?.value==='');
    assert.equal(await page.evaluate(text=>Object.values(localStorage).some(value=>value.includes(text)),laterNote),false);
    checks.push({id:'handoff-reload-role-version-review-exact-cleanup',language,width,restoredNote,restoredRecipient,laterDraftPreserved:true});
    service.jobs.cancel(owner,run.id);await Promise.all(actors.map(actor=>actor.close()));
  }
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.equal(prohibited,0);
} catch(cause){failure=cause;if(active&&!active.isClosed())await active.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});}
finally{
 await fs.writeFile(path.join(output,'report.json'),JSON.stringify({status:failure?'failed':'passed',at:new Date().toISOString(),build:JSON.parse(await fs.readFile(path.join(root,'out/web/build-info.json'),'utf8')),phase,checks,commands,compileCalls,prohibited,errors,external,limitation:'Disposable fixture runs and check responses only; no model, Lean, email or production writes.',...(failure?{error:failure instanceof Error?failure.message:String(failure)}:{})},null,2));
 await browser.close();await service.close();await fs.rm(dataRoot,{recursive:true,force:true});
}
if(failure)throw failure;
console.log(`Passed ${checks.length} desktop/mobile decision lifecycle cases`);
