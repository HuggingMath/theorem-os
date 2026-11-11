#!/usr/bin/env bun
// Disposable team continuity regression. No model, Lean, command or mail calls.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Page, Locator } from 'playwright';
import { WebStorage } from '../apps/web/storage';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import type { WebRunner } from '../apps/web/runner';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { freePort, startBrowser, preferFullCollaboration, settled } from './web-scenario';

const sourceRoot=path.resolve(import.meta.dirname,'..');
const output=process.env.THEOREMOS_TEST_OUTPUT??path.join(sourceRoot,'out/team-continuity');
const staticRoot=process.env.THEOREMOS_FRONTEND_TEST_STATIC_ROOT??path.join(sourceRoot,'out/web');
await fs.mkdir(output,{recursive:true});
const dataRoot=await fs.mkdtemp(path.join(output,'disposable-data-'));
const port=await freePort(),origin=`http://127.0.0.1:${port}`;
const config=readWebConfig({THEOREMOS_WEB_PORT:String(port),THEOREMOS_WEB_PUBLIC_URL:origin,THEOREMOS_WEB_STATIC_ROOT:staticRoot,
  THEOREMOS_WEB_DATA_ROOT:dataRoot,THEOREMOS_WEB_AUTH:'email',THEOREMOS_WEB_SMTP_URL:'log:',
  THEOREMOS_WEB_ALLOWLIST:['owner-zh','peer-zh','applicant-zh','owner-en','peer-en','applicant-en'].map(name=>`${name}@example.org`).join(',')});
const seed=new WebStorage(dataRoot);
const accounts=['owner-zh','peer-zh','applicant-zh','owner-en','peer-en','applicant-en'].map(name=>({id:crypto.randomUUID(),email:`${name}@example.org`,createdAt:new Date().toISOString(),termsAt:new Date().toISOString(),termsVersion:config.auth!.termsVersion}));
accounts.forEach(account=>seed.saveRecord(['accounts',`${mathDigest(account.email)}.json`],account));
const sessions=accounts.map(account=>({id:crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-',''),csrf:mathDigest(crypto.randomUUID()),touchedAt:Date.now(),account:{id:account.id,email:account.email}}));
sessions.forEach(session=>seed.saveSession(session));
let forbiddenCalls=0;
const forbidden=async()=>{forbiddenCalls++;throw new Error('Model, Lean, command and mail are not allowed in this probe');};
const runner:WebRunner={readiness:async()=>({ready:true,message:'Local team continuity fixture'}),run:forbidden,check:forbidden,command:forbidden};
const makeService=()=>createWebService(config,runner,{sample:null,mailer:forbidden});
let service=makeService();
const browser=await startBrowser(service.server,port);
const requests:object[]=[],checks:object[]=[],errors:string[]=[],external:string[]=[];
let active:Page|undefined,phase='setup',failure:unknown;

async function http(page:Page,method:string,pathname:string,input?:unknown){
  const result=await page.evaluate(async({method,pathname,input})=>{
    const session=await(await fetch('/api/session')).json();
    const response=await fetch(pathname,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken},...(input===undefined?{}:{body:JSON.stringify(input)})});
    return {status:response.status,body:await response.json()};
  },{method,pathname,input});
  requests.push({phase,method,pathname,...(input===undefined?{}:{input}),...result});return result;
}
async function ok(page:Page,method:string,pathname:string,input?:unknown){const result=await http(page,method,pathname,input);assert.ok(result.status<300,JSON.stringify(result));return result.body;}
async function openDetails(details:Locator){if(!await details.evaluate(n=>(n as HTMLDetailsElement).open))await details.locator(':scope>summary').click();}
async function capture(page:Page,file:string,selector?:string){await settled(page);if(selector)await page.locator(selector).screenshot({path:path.join(output,file)});else await page.screenshot({path:path.join(output,file),fullPage:true});}
async function takeResponse(page:Page,method:string,pathname:string,click:()=>Promise<unknown>){
 let captured:any,complete!:(result:any)=>void;
 const completed=new Promise<any>(resolve=>{complete=resolve;});
 const pattern=origin+pathname;
 const intercept=async(route:any)=>{
  if(route.request().method()!==method){await route.continue();return;}
  const response=await route.fetch();captured={status:response.status(),body:await response.json()};
  requests.push({phase,method,pathname,input:route.request().postDataJSON(),...captured});await route.fulfill({response});complete(captured);
 };
 await page.route(pattern,intercept);
 try{await click();return await completed;}
 finally{await page.unroute(pattern,intercept);}
}
try{
 for(const [language,width,offset]of [['zh',1440,0],['en',390,3]]as const){
  const tx=(zh:string,en:string)=>language==='zh'?zh:en;
  phase=`setup-${language}`;
  const actors=await Promise.all([0,1,2].map(async n=>{
    const context=await browser.newContext({locale:language==='zh'?'zh-CN':'en-US',viewport:{width,height:1000},reducedMotion:'reduce'});
    await context.addCookies([{name:'theoremos_session',value:sessions[offset+n].id,url:origin}]);
    await context.addInitScript(language=>localStorage.setItem('theorem-os.web-locale.v1',language),language);await preferFullCollaboration(context);
    await context.route(/^https?:\/\//u,async route=>{if(new URL(route.request().url()).origin!==origin){external.push(route.request().url());await route.abort();}else await route.continue();});
    const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
    await page.goto(origin+'/workspace.html');await page.locator('.workspace-tabs').waitFor();return {context,page};
  }));
  const [owner,peer,applicant]=actors.map(a=>a.page);active=owner;
  const peerId=service.research.projects.identity(`account:${accounts[offset+1].id}`),applicantId=service.research.projects.identity(`account:${accounts[offset+2].id}`);
  for(const [page,displayName]of [[owner,'Team Owner'],[peer,'Team Colleague'],[applicant,'Joining Colleague']]as const)await ok(page,'PUT','/api/research/profile',{requestId:crypto.randomUUID(),expectedRevision:0,displayName,visibility:'public'});

  phase=`T1-default-private-add-member-${language}`;
  // Actual discovery-to-participation UI: a public colleague's profile, new theorem, prefilled member form.
  await owner.goto(`${origin}/people.html?id=${peerId}`);await owner.locator(`[data-add-researcher="${peerId}"]`).click();
  const picker=owner.locator('[data-researcher-project-picker]');await picker.getByRole('link',{name:new RegExp(tx('^创建题目','^Create a theorem'))}).click();
  await owner.getByRole('textbox',{name:tx('定理名称','Theorem title'),exact:true}).fill(`Default private collaboration ${language}`);
  const createResult=await takeResponse(owner,'POST','/api/research/theorems',()=>owner.getByRole('button',{name:tx('创建定理','Create theorem'),exact:true}).click());assert.equal(createResult.status,201);
  const privateId=createResult.body.item.id,privatePath=`/api/research/theorems/${privateId}`;
  const memberForm=owner.locator('[data-project-member-form]');await memberForm.waitFor();assert.equal(await memberForm.locator('[data-project-member-person]').inputValue(),peerId);
  const saveMember=memberForm.getByRole('button',{name:tx('保存成员','Save member'),exact:true});
  assert.equal(await saveMember.isDisabled(),true);
  const unconfirmed=await http(owner,'PUT',`${privatePath}/members/${peerId}`,{requestId:crypto.randomUUID(),expectedRevision:createResult.body.item.revision,role:'collaborator'});
  assert.equal(unconfirmed.status,409);
  const beforeConsent=(await ok(owner,'GET',privatePath)).item;assert.equal(beforeConsent.visibility,'private');assert.deepEqual(beforeConsent.members,[]);
  assert.equal((await http(peer,'GET',privatePath)).status,404);
  await capture(owner,`T1-confirm-visibility-${language}-${width}.png`,'#research-members');
  await owner.locator('[data-confirm-member-visibility]').check();assert.equal(await saveMember.isEnabled(),true);
  const addResult=await takeResponse(owner,'PUT',`${privatePath}/members/${peerId}`,()=>saveMember.click());assert.equal(addResult.status,200);
  await owner.locator(`[data-project-member="${peerId}"]`).waitFor();await capture(owner,`T1-owner-added-${language}-${width}.png`,'#research-members');
  const storedPrivate=(await ok(owner,'GET',privatePath)).item;
  const peerPrivate=await http(peer,'GET',privatePath);assert.equal(storedPrivate.visibility,'members');assert.equal(storedPrivate.members.find((m:any)=>m.researcherId===peerId)?.role,'collaborator');assert.equal(peerPrivate.status,200);assert.equal(peerPrivate.body.item.permissions.edit,true);
  const outsider=await http(applicant,'GET',privatePath);assert.equal(outsider.status,404);
  await peer.goto(`${origin}/theorems.html?id=${privateId}`);await peer.locator('#research-members').waitFor();await capture(peer,`T1-member-opens-${language}-${width}.png`,'#research-members');
  checks.push({id:'T1-private-membership-requires-explicit-visibility-consent',language,width,projectId:privateId,
    unconfirmedStatus:unconfirmed.status,noSideEffectsBeforeConfirmation:beforeConsent.members.length===0&&beforeConsent.visibility==='private',
    ownerSaveStatus:addResult.status,storedVisibility:storedPrivate.visibility,savedMemberRole:storedPrivate.members.find((m:any)=>m.researcherId===peerId)?.role,memberReadStatus:peerPrivate.status,memberCanEdit:peerPrivate.body.item.permissions.edit,outsiderStatus:outsider.status,
    screenshots:[`T1-confirm-visibility-${language}-${width}.png`,`T1-owner-added-${language}-${width}.png`,`T1-member-opens-${language}-${width}.png`]});

  phase=`invite-link-control-${language}`;
  let project=(await ok(owner,'POST','/api/research/theorems',{requestId:crypto.randomUUID(),title:`Link invitation control ${language}`,visibility:'private'})).item;
  const ppath=`/api/research/theorems/${project.id}`;
  // Both supported invitation surfaces target the same colleague before any membership exists.
  const invitation=(await ok(owner,'POST',`${ppath}/invitations`,{requestId:crypto.randomUUID(),expectedRevision:project.revision,recipientId:peerId,role:'collaborator',note:'Join the research team to work on the proof.'})).item;
  project=(await ok(owner,'GET',ppath)).item;
  const link=(await ok(owner,'POST',`${ppath}/invitation-links`,{requestId:crypto.randomUUID(),expectedRevision:project.revision,role:'reader',note:'Read the project together.',confirmed:true})).item;
  const pending=await actors[1].context.newPage();pending.setDefaultTimeout(12000);pending.on('pageerror',e=>errors.push(e.message));
  await pending.goto(`${origin}/workspace.html?tab=inbox&inbox=decision#collaboration-inbox`);
  const pendingCard=pending.locator(`[data-inbox-item="invitation:${invitation.id}"]`);await pendingCard.waitFor();
  // Hold this tab at the already loaded pre-join response until the stale button is exercised.
  const initialInbox=await ok(pending,'GET','/api/research/collaboration/inbox');
  const inboxPath=origin+'/api/research/collaboration/inbox';
  await pending.route(inboxPath,async route=>{if(route.request().method()==='GET')await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(initialInbox)});else await route.continue();});
  await peer.goto(`${origin}/invite.html?invite=${link.token}`);await peer.locator('[data-confirm-invitation-accept]').check();
  const linkAccepted=await takeResponse(peer,'POST',`/api/research/invitation-links/${link.token}/accept`,()=>peer.locator('[data-accept-invitation-link]').click());assert.equal(linkAccepted.status,200);
  await peer.locator('[data-invitation-member]').waitFor();await peer.locator('[data-open-invited-project]').click();await peer.locator('#research-members').waitFor();
  const linkedState=(await ok(owner,'GET',ppath)).item;assert.equal(linkedState.visibility,'members');assert.equal(linkedState.members.find((m:any)=>m.researcherId===peerId)?.role,'reader');
  checks.push({id:'link-accept-opens-private-project',language,width,status:linkAccepted.status,memberRole:'reader',visibility:linkedState.visibility});

  phase=`T2-stale-invitation-after-joining-${language}`;
  const inboxAfterJoin=await ok(peer,'GET','/api/research/collaboration/inbox');
  const closed=inboxAfterJoin.items.find((item:any)=>item.id===`invitation:${invitation.id}`);
  assert.equal(closed.invitation.status,'joined');assert.equal(closed.invitation.currentMemberRole,'reader');assert.equal(closed.invitation.role,'collaborator');assert.equal(closed.category,'progress');assert.equal(closed.resolved,true);assert.equal(inboxAfterJoin.counts.decision,0);
  await pending.unroute(inboxPath);
  const staleAccepted=await takeResponse(pending,'POST',`${ppath}/invitations/${invitation.id}/respond`,()=>pendingCard.getByRole('button',{name:tx('接受','Accept'),exact:true}).click());
  assert.equal(staleAccepted.status,200);assert.equal(staleAccepted.body.item.status,'joined');assert.equal(staleAccepted.body.item.currentMemberRole,'reader');
  await pendingCard.waitFor({state:'detached'});await pending.close();
  await peer.goto(`${origin}/workspace.html?tab=inbox&inbox=progress#collaboration-inbox`);
  const inviteCard=peer.locator(`[data-inbox-item="invitation:${invitation.id}"]`);await inviteCard.waitFor();
  await inviteCard.locator('[data-invitation-already-joined]').waitFor();
  const joinedNotice=await inviteCard.locator('[data-invitation-already-joined]').innerText();assert.ok(joinedNotice.includes(tx('只读成员','Reader')));assert.ok((await inviteCard.innerText()).includes(tx('协作者','Collaborator')));
  assert.equal(await inviteCard.getByRole('button',{name:tx('接受','Accept'),exact:true}).count(),0);
  assert.equal(await inviteCard.getByRole('button',{name:tx('拒绝','Decline'),exact:true}).count(),0);
  await capture(peer,`T2-already-joined-current-role-${language}-${width}.png`);
  await peer.reload();await inviteCard.locator('[data-invitation-already-joined]').waitFor();
  const inboxAfterReload=await ok(peer,'GET','/api/research/collaboration/inbox');const persisted=inboxAfterReload.items.find((item:any)=>item.id===`invitation:${invitation.id}`);
  assert.equal(persisted.invitation.status,'joined');assert.equal(persisted.resolved,true);assert.equal(inboxAfterReload.counts.decision,0);
  await inviteCard.getByRole('link',{name:tx('打开并继续','Open and continue'),exact:true}).click();await peer.locator('#collaboration-members').waitFor();
  await peer.locator('#collaboration-members [data-invitation-already-joined]').waitFor();
  const actualMember=(await ok(peer,'GET',ppath)).item;assert.equal(actualMember.members.find((m:any)=>m.researcherId===peerId).role,'reader');assert.equal(actualMember.permissions.edit,false);
  checks.push({id:'T2-reconciles-other-route-membership-without-role-promotion',language,width,projectId:project.id,invitationId:invitation.id,
    actualMemberRole:'reader',originalRequestedRole:'collaborator',staleAcceptStatus:staleAccepted.status,statusAfterReload:persisted.invitation.status,resolvedAfterReload:persisted.resolved,decisionsAfterReload:inboxAfterReload.counts.decision,memberCanEdit:actualMember.permissions.edit,joinedNotice,
    screenshot:`T2-already-joined-current-role-${language}-${width}.png`});
  // Positive control: an ordinary invitation can be accepted and is resolved in the inbox.
  project=(await ok(owner,'GET',ppath)).item;
  const normal=(await ok(owner,'POST',`${ppath}/invitations`,{requestId:crypto.randomUUID(),expectedRevision:project.revision,recipientId:applicantId,role:'collaborator',note:'Normal single-channel collaboration invitation.'})).item;
  await applicant.goto(`${origin}/workspace.html?tab=inbox&inbox=decision#collaboration-inbox`);
  const normalCard=applicant.locator(`[data-inbox-item="invitation:${normal.id}"]`);await normalCard.waitFor();
  const normalAccepted=await takeResponse(applicant,'POST',`${ppath}/invitations/${normal.id}/respond`,()=>normalCard.getByRole('button',{name:tx('接受','Accept'),exact:true}).click());assert.equal(normalAccepted.status,200);
  const normalInbox=(await ok(applicant,'GET','/api/research/collaboration/inbox')).items.find((item:any)=>item.id===`invitation:${normal.id}`);assert.equal(normalInbox.resolved,true);
  checks.push({id:'single-channel-invitation-accept',language,width,status:normalAccepted.status,resolved:normalInbox.resolved});

  phase=`join-public-control-${language}`;
  const publicProject=(await ok(owner,'POST','/api/research/theorems',{requestId:crypto.randomUUID(),title:`Public join journey ${language}`,visibility:'public'})).item;
  const jpath=`/api/research/theorems/${publicProject.id}`;
  await applicant.goto(`${origin}/theorems.html?collection=research&q=${encodeURIComponent(publicProject.title)}`);
  await applicant.getByRole('link',{name:publicProject.title,exact:true}).click();await applicant.locator('#research-members').waitFor();
  const join=applicant.locator('#collaboration-members>details').filter({has:applicant.locator('summary',{hasText:tx('申请加入研究','Request to join')})});await openDetails(join);
  await join.getByRole('textbox',{name:tx('想参与的方向与可提供的帮助','Your research interest and what you can contribute'),exact:true}).fill('I can contribute a direct proof and a checked example.');
  const joinResult=await takeResponse(applicant,'POST',`${jpath}/join-requests`,()=>join.getByRole('button',{name:tx('提交加入申请','Send join request'),exact:true}).click());assert.equal(joinResult.status,201);
  const application=joinResult.body.item;await owner.goto(`${origin}/workspace.html?tab=inbox&inbox=decision#collaboration-inbox`);
  const applicationCard=owner.locator(`[data-inbox-item="invitation:${application.id}"]`);await applicationCard.waitFor();
  const approved=await takeResponse(owner,'POST',`${jpath}/invitations/${application.id}/respond`,()=>applicationCard.getByRole('button',{name:tx('接受','Accept'),exact:true}).click());assert.equal(approved.status,200);
  const joined=(await ok(applicant,'GET',jpath)).item;assert.equal(joined.permissions.edit,true);
  checks.push({id:'discovery-public-join-request-owner-accept',language,width,requestStatus:joinResult.status,approvalStatus:approved.status,memberCanEdit:joined.permissions.edit});

  phase=`permission-loss-and-draft-control-${language}`;
  await applicant.goto(`${origin}/theorems.html?id=${publicProject.id}#research-discussion`);await applicant.locator('[data-discussion-composer]').waitFor();
  const draftText=`Unsent proof discussion preserved across permission loss ${language}`;
  await applicant.locator('[data-discussion-composer] textarea').fill(draftText);
  // Switch to members before removing, so the next poll must remove the view, then restore the same membership.
  let current=(await ok(owner,'GET',jpath)).item;
  current=(await ok(owner,'PATCH',jpath,{requestId:crypto.randomUUID(),expectedRevision:current.revision,visibility:'members'})).item;
  current=(await ok(owner,'PUT',`${jpath}/members/${applicantId}`,{requestId:crypto.randomUUID(),expectedRevision:current.revision,role:null})).item;
  await applicant.locator('[data-theorem-detail-retry]').waitFor({timeout:16000});assert.equal(await applicant.locator('[data-discussion-composer]').count(),0);
  const denied=await http(applicant,'GET',jpath);assert.equal(denied.status,404);
  const draftPresent=await applicant.evaluate(text=>Object.values(localStorage).some(value=>String(value).includes(text)),draftText);assert.equal(draftPresent,true);
  await ok(owner,'PUT',`${jpath}/members/${applicantId}`,{requestId:crypto.randomUUID(),expectedRevision:current.revision,role:'collaborator'});
  await applicant.locator('[data-theorem-detail-retry]').click();await applicant.locator('[data-discussion-composer] textarea').waitFor();assert.equal(await applicant.locator('[data-discussion-composer] textarea').inputValue(),draftText);
  checks.push({id:'membership-revocation-clears-view-and-restores-unsent-discussion',language,width,deniedStatus:denied.status,oldComposerRemoved:true,localDraftPreserved:true,restoredText:draftText});
  for(const p of [owner,peer,applicant])assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Unexpected page overflow');
  await Promise.all(actors.map(actor=>actor.context.close()));
  console.log(`PASS team continuity ${language} ${width}`);
  if(language==='zh'){await service.close();service=makeService();await new Promise<void>((resolve,reject)=>{service.server.once('error',reject);service.server.listen(port,'127.0.0.1',resolve);});}
 }
 assert.equal(forbiddenCalls,0);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
}catch(error){failure=error;await active?.screenshot({path:path.join(output,'probe-failure.png'),fullPage:true}).catch(()=>undefined);}
finally{
 await browser.close();await service.close();await fs.rm(dataRoot,{recursive:true,force:true});
 await fs.writeFile(path.join(output,'requests.json'),JSON.stringify(requests,null,2)+'\n');
 await fs.writeFile(path.join(output,'report.json'),JSON.stringify({status:failure?'failed':'passed',phase,sourceRoot,build:JSON.parse(await fs.readFile(path.join(staticRoot,'build-info.json'),'utf8')),checks,forbiddenCalls,errors,external,...(failure?{error:String(failure)}:{})},null,2)+'\n');
 await fs.writeFile(path.join(output,'cleanup.json'),JSON.stringify({browserClosed:true,serviceClosed:true,disposableDataRemoved:await fs.stat(dataRoot).then(()=>false,()=>true),forbiddenCalls,disposableLocalhostOnly:true},null,2)+'\n');
}
if(failure)throw failure;
