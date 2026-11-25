import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebStorage } from '../apps/web/storage';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import { WebSharedProofs } from '../apps/web/sharedProofs';
import { shareSnapshot } from '../apps/web/share';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { readingRun } from '../tests/helpers/shareReadingFixture';
import { freePort, startBrowser } from './web-scenario';
import { localeStorageKey } from '../apps/web/i18n';
import type { Page } from 'playwright';

const root=path.resolve(import.meta.dirname,'..'), output=process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root,'out/product-continuity/post-continuity-20261111/onboarding');
await fs.mkdir(output,{recursive:true});
const data=await fs.mkdtemp(path.join(os.tmpdir(),'theoremos-onboarding-audit-')),port=await freePort(),origin=`http://127.0.0.1:${port}`;
const config=readWebConfig({THEOREMOS_WEB_PORT:String(port),THEOREMOS_WEB_PUBLIC_URL:origin,THEOREMOS_WEB_STATIC_ROOT:path.join(root,'out/web'),THEOREMOS_WEB_DATA_ROOT:data,
 THEOREMOS_WEB_AUTH:'email',THEOREMOS_WEB_SMTP_URL:'log:',THEOREMOS_WEB_ALLOWLIST:'onboarding-audit@example.org',
 THEOREMOS_WEB_PROVIDERS:JSON.stringify([{id:'fixture',name:'Fixture',baseUrl:'https://fixture.invalid/v1'}])});
const seed=new WebStorage(data),account={id:crypto.randomUUID(),email:'onboarding-audit@example.org',completionEmail:false,createdAt:new Date().toISOString(),termsAt:new Date().toISOString(),termsVersion:config.auth!.termsVersion};
seed.saveRecord(['accounts',`${mathDigest(account.email)}.json`],account);
const session={id:crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-',''),csrf:mathDigest(crypto.randomUUID()),touchedAt:Date.now(),account:{id:account.id,email:account.email}};seed.saveSession(session);
let recordedRuns=0,blockedLeanChecks=0,prohibitedModelCalls=0,prohibitedMailCalls=0;
const service=createWebService(config,{async readiness(){return{ready:true,message:'Disposable browser audit'};},async run(_input,send){recordedRuns++;send({type:'result',result:{status:'limit_reached',proof:'',report:{usage:{totalTokens:100}}}});},async formalize(){prohibitedModelCalls++;throw new Error('No models');},async check(){blockedLeanChecks++;throw new Error('Automatic source precheck blocked by disposable fixture; no Lean is executed');}},
 {sample:null,mailer:async()=>{prohibitedMailCalls++;throw new Error('No mail');}});
const browser=await startBrowser(service.server,port),checks:object[]=[],errors:string[]=[],external:string[]=[];
let active:Page|undefined,phase='setup',failure:unknown;
async function actor(language:'zh'|'en',width:number,denied=false){
 const context=await browser.newContext({viewport:{width,height:1000},reducedMotion:'reduce',locale:language==='zh'?'zh-CN':'en-US'});
 await context.addCookies([{name:'theoremos_session',value:session.id,url:origin}]);
 await context.addInitScript(({language,key,denied})=>{localStorage.setItem(key,language);if(denied){const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith('theorem-os.chat-draft.') && !(window as unknown as {allowChatDraftWrite?:boolean}).allowChatDraftWrite)throw new DOMException('Audit fixture quota exceeded','QuotaExceededError');return original.call(this,key,value);};}}, {language,key:localeStorageKey,denied});
 await context.route(/^https?:\/\//u,async route=>{if(new URL(route.request().url()).origin!==origin){external.push(route.request().url());await route.abort();}else await route.continue();});
 const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));active=page;return{context,page};
}
try{
 for(const [language,width] of [['zh',1440],['en',390]] as const){
  phase=`tab-storage-failure-${language}`;
  const {page,context}=await actor(language,width,true);await page.goto(origin);await page.locator('#formalize-original').waitFor();
  const original=`UNSAVED_${language}: prove a nontrivial inequality, with the derivation entered in this tab.`;
  await page.locator('#formalize-original').fill(original);
  const warning=page.locator('[data-chat-draft-save-error]');await warning.waitFor();
  assert.match(await warning.innerText(),language==='zh'?/草稿尚未保存/:/draft has not been saved/);
  assert.equal(await page.evaluate(text=>Object.values(sessionStorage).some(value=>value.includes(text)),original),false);
  const download=page.waitForEvent('download');await warning.locator('[data-download-chat-draft]').click();
  const file=await download;await file.saveAs(path.join(output,`recovered-problem-${language}.txt`));
  assert.equal(await fs.readFile(path.join(output,`recovered-problem-${language}.txt`),'utf8'),original);
  const leave=page.waitForEvent('dialog');const reload=page.reload().catch(()=>undefined);
  const dialog=await leave;assert.equal(dialog.type(),'beforeunload');await dialog.dismiss();await reload;
  assert.equal(await page.locator('#formalize-original').inputValue(),original);
  await page.screenshot({path:path.join(output,`storage-failure-visible-${language}.png`),fullPage:true});
  // Retry after storage is writable. This must persist the exact original and remove the failure state.
  await page.evaluate(()=>{(window as unknown as {allowChatDraftWrite?:boolean}).allowChatDraftWrite=true;});
  await warning.locator('[data-retry-chat-draft]').click();await warning.waitFor({state:'hidden'});
  await page.reload();await page.locator('#formalize-original').waitFor();assert.equal(await page.locator('#formalize-original').inputValue(),original);
  checks.push({id:'N1-persistence-failure-visible-download-and-retry',language,width,downloaded:true,retryPreservedOriginal:true});
  // Main also keeps historical problem edits independent from the unfinished home question.
  phase=`historical-edit-storage-failure-${language}`;
  await page.evaluate(()=>{(window as unknown as {allowChatDraftWrite?:boolean}).allowChatDraftWrite=true;});
  if(await warning.isVisible())await warning.locator('[data-retry-chat-draft]').click();
  assert.equal(await page.evaluate(text=>Object.values(sessionStorage).some(value=>value.includes(text)),original),true);
  const recorded=readingRun(),provider=config.providers[0]!;
  const editedRun=service.jobs.create(`account:${account.id}`,{providerId:provider.id,apiKey:'sk-disposable-unused',model:'fixture',effort:'high',
   environment:'standard',source:recorded.source,task:recorded.task,maxTurns:1,maxRunSeconds:0,workers:1,coordination:'independent'},provider);
  const editedConversation=service.conversations.create(`account:${account.id}`,{runId:editedRun.id});
  await page.goto(`${origin}/?editProblem=${editedConversation.id}`);await page.locator('#formalize-original').waitFor();
  const edited=`UNSAVED_EDIT_${language}: preserve this independent historical problem edit.`;
  await page.locator('#formalize-original').fill(edited);await warning.waitFor();
  assert.equal(await page.evaluate(text=>Object.values(sessionStorage).some(value=>value.includes(text)),edited),false);
  await page.evaluate(()=>{(window as unknown as {allowChatDraftWrite?:boolean}).allowChatDraftWrite=true;});
  await warning.locator('[data-retry-chat-draft]').click();await warning.waitFor({state:'hidden'});
  await page.reload();await page.locator('#formalize-original').waitFor();assert.equal(await page.locator('#formalize-original').inputValue(),edited);
  await page.locator('[data-chat-return-home]').click();assert.equal(await page.locator('#formalize-original').inputValue(),original);
  checks.push({id:'N1-historical-edit-storage-failure-is-independent-from-home',language,width,editRecovered:true,homePreserved:true});
  await context.close();

  phase=`shared-account-draft-provenance-${language}`;
  const a=await actor(language,width);const shareRun=readingRun(crypto.randomUUID()),snapshot=shareSnapshot(shareRun)!,token=crypto.randomUUID().replaceAll('-','');
  service.storage.saveRun('account:original-author',shareRun);service.storage.saveShare('account:original-author',shareRun.id,{token,createdAt:snapshot.sharedAt,snapshot});
  const references=new WebSharedProofs(service.storage),reading=references.register(`account:${account.id}`,{token,requestId:crypto.randomUUID()}),prepared=references.prepare(`account:${account.id}`,reading.id,{requestId:crypto.randomUUID(),expectedDigest:reading.digest,confirmed:true});
  await a.page.goto(`${origin}/?sharedDraft=${prepared.id}`);await a.page.locator('[data-shared-proof-origin][data-shared-proof-status=available]').waitFor();await a.page.locator('#source').waitFor({state:'visible'});
  const source=await a.page.locator('#source').inputValue(),beforeOrigin=await a.page.locator('[data-shared-proof-origin]').innerText();
  const savePanel=a.page.locator('[data-problem-account-drafts]:visible');
  await savePanel.locator(':scope > summary').click();
  await savePanel.locator('[data-problem-draft-title]').fill(`Shared proof ${language}`);
  const saved=a.page.waitForResponse(reply=>new URL(reply.url()).pathname==='/api/research/personal/drafts'&&reply.request().method()==='POST');
  await savePanel.locator('[data-save-problem-draft]').click();
  const saveResponse=await saved;assert.equal(saveResponse.status(),201,await saveResponse.text());
  const {item}=await saveResponse.json();
  assert.equal(item.version.value.mode,'lean');assert.deepEqual(item.version.value.draft.sharedProofOrigin,{readingId:reading.id,title:reading.share.title,digest:reading.digest});
  await a.page.screenshot({path:path.join(output,`shared-account-before-${language}.png`),fullPage:true});
  const b=await actor(language,width);await b.page.goto(`${origin}/?accountDraft=${item.draft.id}&draftVersion=${item.version.id}`);const restorePanel=b.page.locator('[data-problem-account-drafts]:visible');const row=restorePanel.locator(`[data-problem-draft-version="${item.version.id}"]`);await row.locator('[data-restore-problem-draft]').click();await b.page.locator('#source').waitFor({state:'visible'});
  assert.equal(await b.page.locator('#source').inputValue(),source);
  const originCard=b.page.locator('[data-shared-proof-origin][data-shared-proof-status=available]');await originCard.waitFor();
  assert.match((await originCard.locator('a').getAttribute('href'))!,new RegExp(`reading=${reading.id}`));
  await b.page.reload();await b.page.locator('body[data-entry=lean]').waitFor();
  await b.page.locator('[data-shared-proof-origin][data-shared-proof-status=available]').waitFor();
  assert.equal(await b.page.locator('#source').inputValue(),source);assert.equal(await b.page.locator('#source').isVisible(),true);
  await b.page.screenshot({path:path.join(output,`shared-account-restored-${language}.png`),fullPage:true});
  checks.push({id:'N3-shared-account-draft-restores-source-link-and-editor',language,width,beforeOrigin,sourcePreserved:true,originPreserved:true,leanVisibleAfterReload:true});
  service.storage.deleteShare('account:original-author',shareRun.id);
  await b.page.reload();const unavailable=b.page.locator('[data-shared-proof-origin][data-shared-proof-status=unavailable]');await unavailable.waitFor();
  assert.equal(await unavailable.locator('a').count(),0);assert.equal(await b.page.locator('#source').inputValue(),source);
  assert.match(await unavailable.innerText(),language==='zh'?/已保存的原题仍可继续编辑/:/continue editing your saved problem/);
  await unavailable.locator('[data-retry-shared-proof-origin]').click();await b.page.locator('[data-shared-proof-origin][data-shared-proof-status=unavailable]').waitFor();
  await b.page.screenshot({path:path.join(output,`shared-account-source-unavailable-${language}.png`),fullPage:true});
  checks.push({id:'N3-revoked-source-explained-with-editable-saved-problem',language,width,unavailableSourceExplained:true,sourcePreserved:true});
  await a.context.close();await b.context.close();
 }
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.equal(prohibitedModelCalls,0);assert.equal(prohibitedMailCalls,0);
}catch(error){failure=error;await active?.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});}
finally{await fs.writeFile(path.join(output,'report.json'),JSON.stringify({status:failure?'failed':'completed',phase,checks,errors,external,recordedRuns,blockedLeanChecks,prohibitedModelCalls,prohibitedMailCalls,realModelCalls:0,realLeanCalls:0,realMailCalls:0,mode:'Disposable local HTTP service, seeded account, blocked automatic prechecks and isolated Chromium; no product source or build edits',...(failure?{error:String(failure)}:{})},null,2));await browser.close();await service.close();await fs.rm(data,{recursive:true,force:true});}
if(failure)throw failure;console.log(`Onboarding continuity completed ${checks.length} checks`);
