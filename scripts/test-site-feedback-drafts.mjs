import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site=path.join(root,'out/site'), output=process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root,'out/product-continuity/research-lifecycle/feedback');
fs.mkdirSync(output,{recursive:true});
const server=http.createServer((req,res)=>{
 const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
 if(!pathname.startsWith('/TheoremOS/')){res.writeHead(404).end();return;}
 let file=path.resolve(site,pathname.slice('/TheoremOS/'.length));
 if(!file.startsWith(site+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404).end();return;}
 const mime={'.html':'text/html;charset=utf-8','.js':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.woff2':'font/woff2','.png':'image/png'};
 res.writeHead(200,{'Content-Type':mime[path.extname(file)]??'application/octet-stream'});fs.createReadStream(file).pipe(res);
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});const errors=[],external=[],writes=[],checks=[];
const key='theoremos:feedback-draft:v1';let failure;
const ready=async page=>{await page.waitForFunction(()=>document.documentElement.dataset.feedbackReady==='true');};
const snapshot=page=>page.evaluate(()=>({kind:document.querySelector('input[name="feedback-kind"]:checked').value,area:document.querySelector('#feedback-area').value,subject:document.querySelector('#feedback-subject').value,description:document.querySelector('#feedback-description').value,environment:document.querySelector('#feedback-environment').value}));
try {
 for(const [language,width] of [['zh',1440],['en',390]]){
  const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce'});
  await context.route(/^https?:\/\//,async route=>{const req=route.request(),url=new URL(req.url());
   if(url.origin!==origin){if(url.hostname==='github.com'&&req.method()==='GET'){await route.fulfill({contentType:'text/html',body:'<title>Local GitHub destination</title>'});return;}external.push(req.url());await route.abort();return;}
   if(req.method()!=='GET')writes.push(req.url());await route.continue();
  });
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  const prefix=language==='en'?'en/':'';
  const prefill={kind:'question',area:'workbench',subject:'',description:'',environment:'TheoremOS · Linux · Chrome 142 · web fixture-build · failure: runtime_error'};
  await page.goto(`${origin}/TheoremOS/${prefix}feedback.html?area=workbench&kind=question&environment=${encodeURIComponent(prefill.environment)}`);await ready(page);
  assert.deepEqual(await snapshot(page),prefill);await page.locator('.lang-link').click();await ready(page);assert.deepEqual(await snapshot(page),prefill,'Untouched entry context survives a language switch');
  await page.reload();await ready(page);assert.deepEqual(await snapshot(page),prefill,'Untouched entry context survives reload');
  const exact={kind:'feature',area:'lean',subject:'完整推导路线 $n+0=n$',description:'  推导细节：\n\n1. 展开定义\n2. 保留 $\\sum_{i=1}^n i$\n<script>plain text</script>  ',environment:'中文 · Linux · 390×900'};
  await page.locator('[name=feedback-kind][value=feature]').check();await page.locator('#feedback-area').selectOption(exact.area);
  await page.locator('#feedback-subject').fill(exact.subject);await page.locator('#feedback-description').fill(exact.description);await page.locator('#feedback-environment').fill(exact.environment);
  assert.deepEqual(await snapshot(page),exact);await page.reload();await ready(page);assert.deepEqual(await snapshot(page),exact);
  assert.match(await page.locator('#feedback-draft-status').innerText(),/恢复|restored/);
  await page.locator('.lang-link').click();await ready(page);assert.deepEqual(await snapshot(page),exact);
  await page.goto(`${origin}/TheoremOS/${prefix}feedback.html?area=website&kind=bug&environment=different-link`);await ready(page);assert.deepEqual(await snapshot(page),exact,'A new entry hint cannot overwrite existing work');
  await page.locator('#feedback-preview').click();await page.locator('#feedback-review[open]').waitFor();
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{}}}));
  await page.locator('#feedback-copy').click();const download=page.waitForEvent('download');await page.locator('#feedback-download').click();await (await download).saveAs(path.join(output,`${language}-feedback.md`));
  const popupPromise=page.waitForEvent('popup');await page.locator('#feedback-github').click();const popup=await popupPromise;await popup.waitForLoadState();assert.equal(await popup.title(),'Local GitHub destination');await popup.close();
  await page.locator('#feedback-review-close').click();assert.deepEqual(await snapshot(page),exact);assert.ok(await page.evaluate(key=>sessionStorage.getItem(key),key));
  page.once('dialog',d=>d.dismiss());await page.locator('#feedback-clear-draft').click();assert.deepEqual(await snapshot(page),exact,'Cancel clear keeps input');
  await page.screenshot({path:path.join(output,`${language}-${width}-restored.png`),fullPage:true});
  assert.ok(await page.evaluate(()=>Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)<=innerWidth+1));
  page.once('dialog',d=>d.accept());await page.locator('#feedback-clear-draft').click();
  assert.deepEqual(await snapshot(page),{kind:'bug',area:'',subject:'',description:'',environment:''});
  assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),key),null);await page.reload();await ready(page);assert.equal((await snapshot(page)).description,'');assert.equal((await snapshot(page)).area,'');
  const other=await context.newPage();await other.goto(`${origin}/TheoremOS/feedback.html`);await ready(other);assert.equal((await snapshot(other)).description,'');await other.close();
  checks.push({language,width,untouchedPrefillLanguageSwitch:true,untouchedPrefillReload:true,exactReload:true,languageSwitch:true,entryDoesNotOverwrite:true,exportKeepsDraft:true,clearCancel:true,clearPersists:true,isolatedTab:true});await context.close();
 }
 const context=await browser.newContext();await context.route(/^https?:\/\//,async route=>{if(new URL(route.request().url()).origin!==origin){external.push(route.request().url());await route.abort();}else await route.continue();});
 await context.addInitScript(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){if(k==='theoremos:feedback-draft:v1')throw new DOMException('Fixture denied storage','QuotaExceededError');return original.call(this,k,v);};});
 const page=await context.newPage();await page.goto(`${origin}/TheoremOS/feedback.html`);await ready(page);await page.locator('#feedback-description').fill('Storage failure must not erase this text.');
 assert.equal(await page.locator('#feedback-description').inputValue(),'Storage failure must not erase this text.');assert.match(await page.locator('#feedback-draft-status').innerText(),/未能保留草稿/);
 checks.push({storageFailureIsVisible:true,editorPreserved:true});await context.close();
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(writes,[]);
} catch(error){failure=error;}
finally{await browser.close();await new Promise(r=>server.close(r));fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({status:failure?'failed':'passed',at:new Date().toISOString(),checks,errors,external,writes,...(failure?{error:String(failure)}:{})},null,2)+'\n');}
if(failure)throw failure;
console.log('Feedback draft recovery passed desktop/mobile, language changes, export, clear/cancel and storage failure.');
