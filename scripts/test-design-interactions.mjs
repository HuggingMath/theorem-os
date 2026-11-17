import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.resolve(process.env.THEOREMOS_DESIGN_SITE || path.join(root, 'out/site'));
const output = path.resolve(process.env.THEOREMOS_DESIGN_CHECKS || path.join(root, 'out/site-checks/design'));
fs.mkdirSync(output, { recursive: true });
const errors = [], missing = [], writes = [], external = [], results = [];
let currentCase = 'setup';
const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  let file = path.resolve(site, `.${pathname}`);
  if (file !== site && !file.startsWith(site + path.sep)) { response.writeHead(404).end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!path.extname(file) && fs.existsSync(file + '.html')) file += '.html';
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { response.writeHead(404).end(); return; }
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
    '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.txt': 'text/plain' };
  response.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(response);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
let failure;

async function createPage(width, options = {}) {
  const context = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 900 },
    reducedMotion: 'reduce', acceptDownloads: true, ...options });
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (!['GET', 'HEAD'].includes(request.method())) {
      writes.push({ case: currentCase, method: request.method(), url: request.url() });
      await route.abort('blockedbyclient');
      return;
    }
    if (['https://cloud.umami.is', 'https://static.cloudflareinsights.com'].includes(url.origin)) {
      await route.fulfill({ contentType: 'text/javascript', body: '' });
      return;
    }
    if (url.origin !== origin) {
      external.push({ case: currentCase, url: request.url() });
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push({ case: currentCase, error: error.message }));
  page.on('response', response => {
    if (response.url().startsWith(origin) && response.status() >= 400) missing.push({ case: currentCase, status: response.status(), url: response.url() });
  });
  page.on('dialog', async dialog => {
    errors.push({ case: currentCase, error: `Unexpected browser ${dialog.type()}: ${dialog.message()}` });
    await dialog.dismiss();
  });
  await page.addInitScript(() => {
    window.__copyMode = 'success';
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => {
      if (window.__copyMode === 'denied') throw new Error('Synthetic clipboard denial');
      window.__copiedText = text;
    } } });
  });
  return { page, context };
}

async function load(page, relative, ready = 'designReady') {
  await page.goto(`${origin}/${relative}`);
  await page.waitForFunction(key => document.documentElement.dataset[key] === 'true', ready);
  await page.evaluate(() => document.fonts.ready);
}
async function fits(page) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Horizontal overflow: ${currentCase}`);
}
async function focused(locator, message) {
  assert.equal(await locator.evaluate(node => node === document.activeElement), true, message);
}
async function noStorage(page) {
  assert.deepEqual(await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) })),
    { local: [], session: [] }, 'The local demonstration must not store visitor data');
}
async function checkMenu(page, anchor) {
  const button = page.locator('.menu-toggle');
  if (!(await button.isVisible())) return;
  await button.click();
  assert.equal(await button.getAttribute('aria-expanded'), 'true');
  assert.equal(await page.locator('#mobile-nav').isVisible(), true);
  await page.keyboard.press('Escape');
  assert.equal(await button.getAttribute('aria-expanded'), 'false');
  await focused(button, 'Escape restores focus to the menu button');
  await button.click();
  await page.locator(`#mobile-nav a[href="${anchor}"]`).click();
  assert.equal(await page.locator('#mobile-nav').isVisible(), false);
  assert.equal(await button.getAttribute('aria-expanded'), 'false');
  assert.equal(new URL(page.url()).hash, anchor);
  await fits(page);
}

async function checkHomepage(page) {
  const example = page.locator('[data-human-decision]');
  const confirm = example.locator('[data-decision="confirm"]');
  const revise = example.locator('[data-decision="revise"]');
  const reset = example.locator('[data-decision="reset"]');
  const edit = example.locator('[data-decision-edit]');
  const question = edit.locator('[data-decision-field="question"]');
  const goal0 = edit.locator('[data-decision-field="goal-0"]');
  const goal1 = edit.locator('[data-decision-field="goal-1"]');
  const continuation = example.locator('[data-decision-continue]');
  const originalQuestion = await example.locator('[data-decision-question]').innerText();
  assert.equal(await example.getAttribute('data-decision-state'), 'review');
  assert.equal(await continuation.isVisible(), false);
  await confirm.click();
  assert.equal(await example.getAttribute('data-decision-state'), 'confirm');
  assert.equal(await continuation.isVisible(), true);
  assert.match(await example.locator('[data-decision-description]').innerText(), /本页演练|本地/);
  await revise.click();
  assert.equal(await example.getAttribute('data-decision-state'), 'revise');
  await focused(question, 'Editing starts with the original question');
  for (const field of [question, goal0, goal1]) await field.fill('   ');
  await edit.locator('[type="submit"]').click();
  assert.equal(await example.getAttribute('data-decision-state'), 'revise');
  assert.equal(await edit.locator('[aria-invalid="true"]').count(), 3);
  assert.equal(await edit.locator('[data-decision-error]:visible').count(), 3);
  await focused(question, 'An empty statement focuses the first invalid field');
  const revision = '合成浏览器测试：比较有限集合中的两个计数。';
  await question.fill(revision);
  await goal0.fill('synthetic count A = synthetic count B');
  await goal1.fill('synthetic count B = synthetic count A');
  await edit.locator('[type="submit"]').click();
  assert.equal(await example.getAttribute('data-decision-state'), 'saved');
  assert.equal(await example.locator('[data-decision-question]').innerText(), revision);
  assert.equal(await continuation.isVisible(), false);
  await focused(confirm, 'A saved revision returns focus for review');
  await confirm.click();
  assert.equal(await continuation.isVisible(), false, 'A changed statement must not lead to the old recorded proof');
  assert.equal(await example.locator('[data-decision-workbench]').isVisible(), true);
  const copy = example.locator('[data-decision-copy]');
  const exported = example.locator('[data-decision-export]');
  await copy.click();
  await page.waitForFunction(() => !document.querySelector('[data-decision-copy]').disabled);
  const copied = await page.evaluate(() => window.__copiedText);
  assert.ok(copied.includes(revision) && copied.includes('synthetic count A'));
  assert.match(await example.locator('[data-decision-copy-status]').innerText(), /已复制/);
  await page.evaluate(() => { window.__copyMode = 'denied'; });
  await copy.click();
  await exported.waitFor({ state: 'visible' });
  await focused(exported, 'Copy denial selects a visible manual export');
  assert.equal(await exported.inputValue(), copied);
  assert.equal(await exported.evaluate(node => node.selectionEnd - node.selectionStart), copied.length);
  await revise.click();
  await question.fill('Synthetic unsaved text');
  await page.keyboard.press('Escape');
  assert.equal(await example.getAttribute('data-decision-state'), 'confirm');
  assert.equal(await example.locator('[data-decision-question]').innerText(), revision);
  await focused(revise, 'Escape restores focus to the revision action');
  await reset.click();
  assert.equal(await example.getAttribute('data-decision-state'), 'review');
  assert.equal(await example.locator('[data-decision-question]').innerText(), originalQuestion);
  await focused(confirm, 'Reset returns focus to an available confirmation');
  await fits(page);

  const replay = page.locator('[data-replay-root]');
  const stages = ['candidate', 'feedback', 'repair', 'verified'];
  for (const stage of stages) {
    const tab = replay.locator(`[data-replay-stage="${stage}"]`);
    await tab.click();
    assert.equal(await tab.getAttribute('aria-selected'), 'true');
    assert.equal(await replay.locator(`#stage-${stage}`).isVisible(), true);
    assert.equal(await replay.locator('[role="tabpanel"]:visible').count(), 1);
    assert.equal(await replay.locator('#replay-step-label').innerText(), await tab.getAttribute('data-step-name'));
  }
  await replay.locator('[data-replay-stage="verified"]').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await replay.locator('[data-replay-stage="candidate"]').getAttribute('aria-selected'), 'true');
  await page.keyboard.press('End');
  await focused(replay.locator('[data-replay-stage="verified"]'));
  await page.keyboard.press('Home');
  await focused(replay.locator('[data-replay-stage="candidate"]'));

  const components = page.locator('[data-components-root]');
  for (const name of ['M1', 'M2', 'M3', 'M4', 'M5']) {
    const tab = components.locator(`[data-component="${name}"]`);
    await tab.click();
    assert.equal(await tab.getAttribute('aria-selected'), 'true');
    assert.equal(await components.locator('[data-comp-detail-title]').innerText(), await tab.getAttribute('data-title'));
    assert.equal(await components.locator(`[data-diagram-node="${name}"]`).getAttribute('class'), 'diagram-node is-highlighted');
  }
  await components.locator('[data-component="M5"]').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await components.locator('[data-component="M1"]').getAttribute('aria-selected'), 'true');
  await components.locator('[data-comp-view="library"]').click();
  assert.equal(await components.locator('[data-comp-panel="library"]').isVisible(), true);
  assert.equal(await components.locator('[data-comp-panel="map"]').isVisible(), false);
  await page.keyboard.press('ArrowLeft');
  assert.equal(await components.locator('[data-comp-view="map"]').getAttribute('aria-selected'), 'true');
  assert.equal(await components.locator('[data-comp-panel="map"]').isVisible(), true);

  const opener = page.locator('[data-open-dialog="workbench-dialog"]').first();
  await opener.click();
  assert.equal(await page.locator('#workbench-dialog').evaluate(dialog => dialog.open), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#workbench-dialog').evaluate(dialog => dialog.open), false);
  await focused(opener, 'Closing the screenshot restores focus to its trigger');
  await opener.click();
  await page.locator('[data-close-dialog="workbench-dialog"]').click();
  assert.equal(await page.locator('#workbench-dialog').evaluate(dialog => dialog.open), false);
  await checkMenu(page, '#research-entry');
  await fits(page);
  await noStorage(page);
}

async function checkInitiative(page) {
  const form = page.locator('[data-initiative-form]');
  const submit = form.locator('[type="submit"]');
  const preview = page.locator('[data-initiative-preview]');
  const name = form.locator('[name="name"]');
  const email = form.locator('[name="email"]');
  const message = form.locator('[name="message"]');
  await submit.click();
  for (const key of ['name', 'email', 'directions', 'message']) {
    assert.equal(await page.locator(`#initiative-${key}-error`).isVisible(), true);
  }
  await focused(name, 'Empty submission focuses the first invalid field');
  await name.fill('   ');
  await submit.click();
  await focused(name);
  await name.fill('  Synthetic Initiative Visitor  ');
  await email.fill('invalid-email');
  await submit.click();
  await focused(email, 'Invalid email must prevent preview');
  assert.equal(await preview.isVisible(), false);
  await email.fill('initiative-visitor@example.org');
  await submit.click();
  await focused(form.locator('[name="directions"]').first());
  await form.locator('[data-direction-code="lean"]').check();
  assert.equal(await form.locator('[name="directions"]:checked').count(), 1);
  assert.equal(await form.locator('[name="directions"]').first().isChecked(), false);
  await message.fill('   ');
  await submit.click();
  await focused(message);
  const idea = 'Synthetic public example & a reproducible issue.\n<em>Keep literal text</em> 研究想法';
  await message.fill(`  ${idea}  `);
  await form.locator('[name="institution"]').fill('  Example Research Group  ');
  await form.locator('[name="role"]').fill('Lean contributor');
  await submit.click();
  assert.equal(await preview.isVisible(), true, 'The second direction alone is a valid selection');
  assert.equal(await form.isVisible(), false);
  await focused(preview.locator('h3'));
  assert.match(await preview.innerText(), /邮件还未发送/);
  const text = preview.locator('[data-email-text]');
  const draft = await text.inputValue();
  assert.ok(draft.includes(idea) && draft.includes('Synthetic Initiative Visitor'));
  assert.ok(draft.includes('Example Research Group') && draft.includes('Lean 与 Mathlib'));
  assert.equal(await preview.locator('em').count(), 0, 'Visitor text must not be parsed as HTML');
  const mail = new URL(await preview.locator('[data-open-email]').getAttribute('href'));
  assert.equal(mail.protocol, 'mailto:');
  assert.equal(mail.pathname, 'liuzhenhao@westlake.edu.cn');
  assert.ok(mail.searchParams.get('body').includes(idea));
  assert.equal(await preview.locator('[data-long-email]').isVisible(), false);
  await fits(page);
  await page.evaluate(() => { window.__copyMode = 'success'; });
  await preview.locator('[data-copy-email]').click();
  await page.waitForFunction(() => !document.querySelector('[data-copy-email]').disabled);
  assert.equal(await page.evaluate(() => window.__copiedText), draft);
  assert.match(await preview.locator('[data-copy-status]').innerText(), /已复制/);
  await page.evaluate(() => { window.__copyMode = 'denied'; });
  await preview.locator('[data-copy-email]').click();
  await page.waitForFunction(() => !document.querySelector('[data-copy-email]').disabled);
  await focused(text);
  assert.equal(await text.evaluate(node => node.selectionEnd - node.selectionStart), draft.length);
  const downloadPromise = page.waitForEvent('download');
  await preview.locator('[data-download-email]').click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), 'theoremos-initiative-zh.txt');
  assert.equal(fs.readFileSync(await download.path(), 'utf8'), draft);
  await preview.locator('[data-edit-email]').click();
  assert.equal(await form.isVisible(), true);
  assert.equal(await message.inputValue(), idea);
  assert.equal(await name.inputValue(), 'Synthetic Initiative Visitor');
  assert.equal(await form.locator('[data-direction-code="lean"]').isChecked(), true);
  await focused(name);
  const longIdea = '这是用于本地浏览器回归的合成中文想法。'.repeat(150);
  await message.fill(longIdea);
  await submit.click();
  assert.equal(await preview.locator('[data-long-email]').isVisible(), true);
  const longMail = new URL(await preview.locator('[data-open-email]').getAttribute('href'));
  assert.equal(longMail.searchParams.has('body'), false);
  assert.ok(longMail.searchParams.get('subject'));
  const longDraft = await text.inputValue();
  assert.ok(longDraft.includes(longIdea));
  assert.ok(`mailto:${mail.pathname}?subject=${encodeURIComponent(mail.searchParams.get('subject'))}&body=${encodeURIComponent(longIdea)}`.length >= 7500);
  await fits(page);
  await noStorage(page);
  await checkMenu(page, '#participate');
}

try {
  browser = await chromium.launch({ headless: true });
  for (const width of [1440, 1024, 820, 768, 390, 320]) {
    for (const kind of ['home', 'initiative']) {
      currentCase = `zh-${kind}-${width}`;
      const { page, context } = await createPage(width);
      try {
        await load(page, kind === 'home' ? 'index.html' : 'initiative.html');
        await fits(page);
        if (kind === 'home') await checkHomepage(page);
        else {
          assert.equal(await page.locator('html').getAttribute('data-initiative-ready'), 'true');
          await checkInitiative(page);
        }
        results.push({ case: currentCase, passed: true });
      } finally { await context.close(); }
    }
  }
  for (const kind of ['home', 'initiative']) {
    currentCase = `zh-${kind}-390-no-script`;
    const { page, context } = await createPage(390, { javaScriptEnabled: false });
    try {
      await page.goto(`${origin}/${kind === 'home' ? 'index.html' : 'initiative.html'}`);
      assert.equal(await page.locator('#mobile-nav').isVisible(), true, 'No-script visitors need the primary navigation');
      assert.ok(await page.locator('#mobile-nav a').count());
      if (kind === 'initiative') {
        assert.equal(await page.locator('[data-initiative-form]').isVisible(), false);
        assert.equal(await page.locator('noscript a[href="mailto:liuzhenhao@westlake.edu.cn"]').isVisible(), true);
      }
      await fits(page);
      results.push({ case: currentCase, passed: true });
    } finally { await context.close(); }
  }
  for (const width of [1440, 390]) for (const kind of ['home', 'initiative']) {
    currentCase = `en-${kind}-${width}-smoke`;
    const { page, context } = await createPage(width);
    try {
      await load(page, `en/${kind === 'home' ? 'index.html' : 'initiative.html'}`, kind === 'home' ? 'landingReady' : 'initiativeReady');
      assert.equal(await page.locator('html').getAttribute('lang'), 'en');
      assert.equal(await page.locator('h1').count(), 1);
      assert.equal(await page.locator('h1').isVisible(), true);
      if (kind === 'initiative') assert.equal(await page.locator('[data-initiative-form]').isVisible(), true);
      await fits(page);
      results.push({ case: currentCase, passed: true });
    } finally { await context.close(); }
  }
  assert.deepEqual(errors, [], 'No page errors or browser dialogs');
  assert.deepEqual(missing, [], 'No failing local assets');
  assert.deepEqual(writes, [], 'No network writes or model calls');
  assert.deepEqual(external, [], 'No external requests apart from stubbed analytics');
} catch (error) {
  failure = { case: currentCase, message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  const report = { passed: !failure, origin, site, results, errors, missing, writes, external, failure,
    note: 'All input was synthetic. No email links were opened; no research was started.' };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  if (failure) console.error(`Design interaction check failed in ${failure.case}: ${failure.message}`);
  else console.log(`Design interactions passed: ${results.length} local scenarios, without email sending or network writes.`);
}
