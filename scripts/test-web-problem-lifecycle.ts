#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page, BrowserContext } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { ResearchAccountDraftResult, ResearchAccountDraft } from '../apps/web/researchPersonalTypes';
import type { ProblemDraftValue } from '../apps/web/problemDraftTypes';
import { freePort, startBrowser } from './web-scenario';
import { enterLean, closeSettings, openAdvancedChatSettings, openChatModelSettings } from './web-ui-controls';
import { webFormalizationEvidence, webFormalizationStatement } from '../tests/helpers/webFormalizationFixture';

const root=path.resolve(import.meta.dirname,'..'),output=process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root,'out/product-continuity/research-lifecycle/entry');
await fs.mkdir(output,{recursive:true});
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'theoremos-lifecycle-'));
const port=await freePort(),origin=`http://127.0.0.1:${port}`;
const mail:{to:string;text:string}[]=[],external:string[]=[],errors:string[]=[],checks:object[]=[],contexts:BrowserContext[]=[];
let formalizations=0,runs=0,phase='initial',failure:unknown,active:Page|undefined;
const runner:WebRunner={async readiness(){return {ready:true,message:'Disposable lifecycle fixture'};},async formalize(input,send){formalizations++;send({type:'result',status:'approved',evidence:webFormalizationEvidence(input)});},async run(_input,send){runs++;send({type:'error',message:'Recorded lifecycle fixture; no proof execution.'});}};
const emails=['lifecycle-zh@example.org','lifecycle-en@example.org'];
const service=createWebService(readWebConfig({THEOREMOS_WEB_PORT:String(port),THEOREMOS_WEB_PUBLIC_URL:origin,THEOREMOS_WEB_STATIC_ROOT:path.join(root,'out/web'),THEOREMOS_WEB_DATA_ROOT:temporary,THEOREMOS_WEB_AUTH:'email',THEOREMOS_WEB_SMTP_URL:'log:',THEOREMOS_WEB_ALLOWLIST:emails.join(','),THEOREMOS_WEB_PROVIDERS:JSON.stringify([{id:'fixture',name:'Local fixture',baseUrl:'https://fixture.invalid/v1'}])}),runner,{sample:null,mailer:async message=>{mail.push(message);},captchaAnswer:()=> '24680'});
const browser=await startBrowser(service.server,port);
const panel=(page:Page)=>page.locator('[data-problem-account-drafts]:visible');
async function openPanel(page:Page){if(await page.locator('#formalize-settings[open]:visible').count())await page.locator('#formalize-settings > summary').click();if(await panel(page).getAttribute('open')!=='')await panel(page).locator(':scope > summary').click();await panel(page).locator('[data-problem-draft-title]').waitFor();}
async function save(page:Page,title:string):Promise<ResearchAccountDraftResult<ProblemDraftValue>>{
 if(await panel(page).count()){
  await openPanel(page);await panel(page).locator('[data-problem-draft-title]').fill(title);
  const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/research/personal/drafts'&&r.request().method()==='POST');
  await panel(page).locator('[data-save-problem-draft]').click();const r=await response;assert.equal(r.status(),201,await r.text());await panel(page).locator('[data-save-problem-draft]:enabled').waitFor();return (await r.json()).item;
 }
 assert.equal(await panel(page).count(),0);
 if(await page.locator('body[data-entry=lean]').count()){
  const task=await page.locator('#task').inputValue();
  await page.waitForFunction(expected=>{try{return JSON.parse(sessionStorage.getItem('theorem-os.web-draft.v1')||'{}')?.draft?.task===expected;}catch{return false;}},task);
 }else{
  const text=await page.locator('#formalize-original').inputValue();
  await page.waitForFunction(expected=>Object.entries(sessionStorage).some(([k,v])=>{if(!k.startsWith('theorem-os.chat-draft.')||k.endsWith('.quotes')||k.endsWith('.position'))return false;try{return JSON.parse(v).text===expected;}catch{return false;}}),text);
 }
 return await page.evaluate(async savedTitle=>{
  const session=await(await fetch('/api/session')).json(),owner=session.draftOwner,mode=document.body.dataset.entry==='lean'?'lean':'natural';
  let value:ProblemDraftValue;
  if(mode==='lean'){const stored=JSON.parse(sessionStorage.getItem('theorem-os.web-draft.v1')||'{}').draft||{};const{autoExplain:_ae,explanationLanguage:_el,continueFrom:_cf,formalization:_fm,problemBudget:_pb,...leanDraft}=stored;value={mode:'lean',draft:leanDraft};}
  else{const k=Object.keys(sessionStorage).find(x=>x.startsWith('theorem-os.chat-draft.')&&!x.endsWith('.quotes')&&!x.endsWith('.position'));const stored=k?JSON.parse(sessionStorage.getItem(k)||'{}'):{};value={mode:'natural',text:stored.text??'',settings:stored.settings};}
  const bindingKey=`theorem-os.problem-draft.${owner}.${mode}`;
  const binding=JSON.parse(sessionStorage.getItem(bindingKey)||'null')||{draftKey:crypto.randomUUID(),revision:0,title:''};
  const sig=(v:unknown,t:string)=>JSON.stringify([t,v],(_k,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b))):x);
  const reply=await fetch('/api/research/personal/drafts',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':session.csrfToken},body:JSON.stringify({requestId:crypto.randomUUID(),expectedRevision:binding.revision,scope:{kind:'problem',draftKey:binding.draftKey},value,summary:savedTitle,deviceId:'test-device',deviceName:'Desktop browser',clientUpdatedAt:new Date().toISOString()})});
  if(!reply.ok)throw new Error(await reply.text());
  const item=(await reply.json()).item;
  sessionStorage.setItem(bindingKey,JSON.stringify({draftKey:binding.draftKey,revision:item.version.revision,title:savedTitle,draftId:item.draft.id,versionId:item.version.id,savedSignature:sig(value,savedTitle)}));
  return item;
 },title);
}
async function list(page:Page):Promise<ResearchAccountDraft[]>{return page.evaluate(async()=> (await (await fetch('/api/research/personal/drafts?kind=problem&status=all')).json()).items);}
async function waitSubmitted(page:Page,draftId:string,submissionId?:string,versionId?:string){
 const deadline=Date.now()+10000;
 for(;;){const item=(await list(page)).find(item=>item.id===draftId);if(item?.versions.some(version=>version.status==='submitted'&&(!submissionId||version.submission?.id===submissionId)&&(!versionId||version.id===versionId)))return item;
  if(Date.now()>deadline)throw new Error(`Draft submission did not synchronize: ${JSON.stringify(item)}`);await page.waitForTimeout(100);}
}
async function restore(page:Page,item:ResearchAccountDraftResult<ProblemDraftValue>){
 const u=new URL(page.url());
 if(u.searchParams.get('accountDraft')!==item.draft.id||u.searchParams.get('draftVersion')!==item.version.id)await page.goto(`${origin}/?accountDraft=${item.draft.id}&draftVersion=${item.version.id}`);
 await openPanel(page);await panel(page).getByRole('button',{name:/刷新账号版本|Refresh account versions/}).click();const group=panel(page).locator(`[data-problem-draft="${item.draft.id}"]`);await group.waitFor();if(await group.getAttribute('open')!=='')await group.locator(':scope > summary').click();await group.locator(`[data-problem-draft-version="${item.version.id}"] [data-restore-problem-draft]`).click();
}
async function context(language:string,width:number){const context=await browser.newContext({viewport:{width,height:1000},locale:language==='zh'?'zh-CN':'en-US',reducedMotion:'reduce'});contexts.push(context);
 await context.addInitScript(language=>{try{localStorage.setItem('theorem-os.web-locale.v1',language);}catch{}},language);
 await context.route(/^https?:\/\//,async route=>{const u=new URL(route.request().url());if(u.origin!==origin){external.push(u.origin);await route.abort();return;}await route.continue();});
 context.on('page',page=>{page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));});return context;}
try{
 for(const [language,width,email] of [['zh',1440,emails[0]],['en',390,emails[1]]] as const){
  const current=await context(language,width),page=await current.newPage();active=page;
  await page.goto(origin);await page.locator('#send-code:enabled').waitFor();await page.locator('#login-email').fill(email);await page.locator('#login-captcha').fill('24680');if(await page.locator('#terms-option').isVisible())await page.locator('#accept-terms').check();await page.locator('#send-code').click();await page.locator('#code-step:visible').waitFor();await page.locator('#login-code').fill(mail.at(-1)!.text.match(/\b\d{6}\b/u)![0]);await page.locator('#verify-code').click();await page.locator('#formalize-original').waitFor();
  await page.locator('#formalize-original').fill(webFormalizationStatement);await openChatModelSettings(page);await page.locator('#formalize-model').fill('fixture-model');await openAdvancedChatSettings(page);await page.locator('#formalize-environment').selectOption('standard');await page.locator('#formalize-settings > summary').click();
  phase=`refresh-status-${language}`;assert.equal(await panel(page).count(),0);const first=await save(page,'Problem A');await page.goto(`${origin}/?accountDraft=${first.draft.id}&draftVersion=${first.version.id}`);await page.locator('#formalize-original').waitFor();await openPanel(page);
  await panel(page).locator('[data-problem-draft-notice]').waitFor();
  await page.locator('#formalize-original').fill(webFormalizationStatement+'\nUse induction.');await panel(page).getByText(/新修改尚未保存到账号|Your new edits are not yet saved to your account/).waitFor();
  await page.screenshot({path:path.join(output,`${language}-${width}-dirty-after-reload.png`),fullPage:true});
  phase=`new-problem-${language}`;await page.locator('#topbar-draft').click();await page.locator('#formalize-original').waitFor();assert.equal(await page.locator('#formalize-original').inputValue(),'');assert.equal(await panel(page).count(),0);
  await page.locator('#formalize-original').fill('A different theorem about even squares.');const second=await save(page,'Problem B');assert.notEqual(second.draft.id,first.draft.id);assert.equal(second.version.revision,1);assert.equal((await list(page)).length,2);
  const renamed=await save(page,'Problem B renamed');assert.equal(renamed.draft.id,second.draft.id);
  phase=`discard-filter-${language}`;await page.goto(`${origin}/workspace.html?tab=drafts`);const group=page.locator(`[data-personal-draft="${first.draft.id}"]`);await group.waitFor();await group.locator(':scope > summary').click();const discarded=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/'+first.draft.id)&&r.request().method()==='PATCH');await group.locator('[data-personal-discard-account-draft]').click();assert.equal((await discarded).status(),200);
  await page.goto(`${origin}/?accountDraft=${first.draft.id}&draftVersion=${first.version.id}`);await page.locator('#formalize-original').waitFor();await openPanel(page);await panel(page).getByRole('button',{name:/刷新账号版本|Refresh account versions/}).click();
  const showArchived=panel(page).getByRole('checkbox',{name:/已提交|submitted/});
  await showArchived.uncheck();await panel(page).locator(`[data-problem-draft-version="${first.version.id}"]`).waitFor({state:'detached'});assert.equal(await panel(page).locator(`[data-problem-draft-version="${first.version.id}"]`).count(),0);
  await showArchived.check();const history=panel(page).locator(`[data-problem-draft="${first.draft.id}"]`);await history.waitFor();if(await history.getAttribute('open')!=='')await history.locator(':scope > summary').click();const row=history.locator(`[data-problem-draft-version="${first.version.id}"]`);assert.match(await row.innerText(),/已丢弃|Discarded/);
  await row.locator('[data-restore-problem-draft]').click();await page.waitForFunction(text=>(document.querySelector('#formalize-original') as HTMLTextAreaElement)?.value===text,webFormalizationStatement);
  phase=`submit-exact-version-${language}`;
  await page.locator('#formalize-settings > summary').click();await page.locator('#formalize-key').fill('sk-disposable-lifecycle');await page.locator('#formalize-settings > summary').click();
  let loseFormalizationReply=true;
  const unknownPattern='**/api/formalizations';
  await page.route(unknownPattern,async route=>{if(route.request().method()==='POST'&&loseFormalizationReply){loseFormalizationReply=false;const reply=await route.fetch();assert.ok(reply.ok());await route.abort('failed');}else await route.continue();});
  const unknown=page.waitForEvent('requestfailed',request=>new URL(request.url()).pathname==='/api/formalizations'&&request.method()==='POST');
  await page.locator('#formalize-start:enabled').click();await unknown;await page.locator('#formalize-start:enabled').waitFor();
  assert.equal((await list(page)).find(x=>x.id===first.draft.id)!.versions.find(x=>x.id===first.version.id)!.status??'open','open');
  await page.unroute(unknownPattern);await page.locator('#formalize-start:enabled').click();await page.waitForURL(url=>url.searchParams.has('chat'));
  await waitSubmitted(page,first.draft.id,undefined,first.version.id);
  const all=await list(page),submitted=all.find(x=>x.id===first.draft.id)!.versions.find(x=>x.id===first.version.id)!;assert.ok(submitted.submission?.href);assert.equal(all.find(x=>x.id===second.draft.id)!.versions[0].status??'open','open');
  const another=await context(language,width);await another.addCookies(await current.cookies(origin));const other=await another.newPage();active=other;await other.goto(`${origin}/workspace.html?tab=drafts`);await other.locator('[data-personal-show-archived-drafts]').check();const archived=other.locator(`[data-personal-draft="${first.draft.id}"]`);await archived.waitFor();await archived.locator(':scope > summary').click();await archived.locator('[data-draft-status=submitted] a').waitFor();assert.equal(await archived.locator('[data-draft-status=submitted] a').getAttribute('href'),submitted.submission!.href);
  await other.screenshot({path:path.join(output,`${language}-${width}-submitted-on-another-device.png`),fullPage:true});assert.ok(await other.evaluate(()=>Math.max(document.body.scrollWidth,document.documentElement.scrollWidth)<=innerWidth+1));
  await archived.locator('[data-draft-status=submitted] a').click();await other.waitForURL(url=>url.searchParams.has('chat')||url.searchParams.has('formalization')||url.searchParams.has('run')||url.pathname.endsWith('/formalize.html')&&url.searchParams.has('id'));
  phase=`restore-submitted-${language}`;active=page;
  await page.goto(`${origin}/?accountDraft=${first.draft.id}&draftVersion=${first.version.id}`);await page.locator('#formalize-original').waitFor();await restore(page,first);
  await page.waitForFunction(text=>(document.querySelector('#formalize-original') as HTMLTextAreaElement)?.value===text,webFormalizationStatement);
  const copied=await save(page,'Independent copy of submitted problem');assert.notEqual(copied.draft.id,first.draft.id);
  assert.equal((await list(page)).find(x=>x.id===first.draft.id)!.versions.find(x=>x.id===first.version.id)!.status,'submitted');
  phase=`lean-exact-submission-${language}`;await page.locator('#topbar-draft').click();await page.locator('#formalize-original').waitFor();await enterLean(page);
  assert.equal(await panel(page).count(),0);
  const leanSource='theorem lifecycle_target (n : Nat) : n + 0 = n := by\n  sorry\n';
  await page.locator('#source').fill(leanSource);await page.locator('#task').fill('Initial Lean instructions');
  await page.locator('#composer-settings').click();await page.locator('#model').fill('fixture-lean');await page.locator('#api-key').fill('sk-disposable-lifecycle');
  await page.locator('[data-settings-section="settings-execution"]').click();await page.locator('#max-turns').fill('4');await page.locator('#max-seconds').fill('120');await page.locator('#workers').fill('1');await closeSettings(page);
  const lean=await save(page,'Lean original');assert.equal(lean.version.value.mode,'lean');
  const parallel=await page.evaluate(async saved=>{const session=await(await fetch('/api/session')).json();const value=saved.version.value as Extract<ProblemDraftValue,{mode:'lean'}>;
    const reply=await fetch('/api/research/personal/drafts',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':session.csrfToken},body:JSON.stringify({requestId:crypto.randomUUID(),expectedRevision:saved.version.revision,scope:{kind:'problem',draftKey:saved.draft.scope.draftKey},value:{...value,draft:{...value.draft,task:'Parallel device instructions'}},summary:'Parallel Lean original',deviceId:'another-device',deviceName:'Another device',clientUpdatedAt:new Date().toISOString()})});if(!reply.ok)throw new Error(await reply.text());return(await reply.json()).item;},lean);
  await page.locator('#task').fill('Exact submitted Lean instructions after editing');
  let refusal=true;await page.route('**/api/runs',async route=>{if(route.request().method()==='POST'&&refusal){refusal=false;await route.fulfill({status:422,json:{error:'Recorded fixture rejection'}});}else await route.continue();});
  const refused=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/runs'&&response.request().method()==='POST');await page.locator('#submit-run:enabled').click();assert.equal((await refused).status(),422);await page.locator('#submit-run:enabled').waitFor();
  assert.ok((await list(page)).find(x=>x.id===lean.draft.id)!.versions.every(x=>(x.status??'open')==='open'));
  await page.unroute('**/api/runs');const accepted=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/runs'&&response.request().method()==='POST');await page.locator('#submit-run:enabled').click();const runReply=await accepted;assert.ok(runReply.ok(),await runReply.text());const acceptedRun=(await runReply.json()).run;
  await waitSubmitted(page,lean.draft.id,acceptedRun.id);
  const versions=(await list(page)).find(x=>x.id===lean.draft.id)!.versions;assert.equal(versions.length,3);assert.equal(versions.find(x=>x.id===parallel.version.id)!.status??'open','open');
  const submittedLean=versions.find(x=>x.submission?.id===acceptedRun.id&&x.revision===3)!;assert.ok(submittedLean,JSON.stringify({run:acceptedRun.id,versions}));assert.equal(submittedLean.submission!.href,`./?run=${acceptedRun.id}`);
  const exact=await page.evaluate(async({id,version})=>(await(await fetch(`/api/research/personal/drafts/${id}?version=${version}`)).json()).item.version.value,{id:lean.draft.id,version:submittedLean.id});assert.equal(exact.draft.task,'Exact submitted Lean instructions after editing');assert.equal(exact.draft.source,leanSource);
  await page.goto(`${origin}/workspace.html?tab=drafts`);await page.locator('[data-personal-show-archived-drafts]').check();const leanArchive=page.locator(`[data-personal-draft="${lean.draft.id}"]`);await leanArchive.waitFor();await leanArchive.locator(':scope > summary').click();await page.screenshot({path:path.join(output,`${language}-${width}-lean-submitted-parallel-preserved.png`),fullPage:true});
  checks.push({language,width,unknownResponsePreservesDraft:true,submittedCopyIndependent:true,leanEditedSnapshotArchived:true,leanParallelPreserved:true,refusedSubmissionPreservesDraft:true,refreshDirty:true,newProblemIdentity:true,renameIdentity:true,discardedState:true,exactSubmissionArchived:true,otherDraftPreserved:true,secondDeviceTaskLink:true});
 }
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.equal(runs,2);assert.equal(formalizations,2);
}catch(error){failure=error;await active?.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});}
finally{await fs.writeFile(path.join(output,'report.json'),JSON.stringify({status:failure?'failed':'passed',at:new Date().toISOString(),phase,build:JSON.parse(await fs.readFile(path.join(root,'out/web/build-info.json'),'utf8')),checks,errors,external,formalizations,recordedRuns:runs,proofRuns:0,...(failure?{error:String(failure)}:{})},null,2));for(const c of contexts)await c.close();await browser.close();await service.close();await fs.rm(temporary,{recursive:true,force:true});}
if(failure)throw failure;
console.log('Problem lifecycle passed desktop and mobile with recorded formalizations/runs and no proof execution.');
