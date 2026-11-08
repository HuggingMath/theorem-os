import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { checkArchiveReplay, checkStaticArchiveReceipt } from './archive-replay-checks.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = pathToFileURL(path.join(root, 'out/site/archive.html')).href;
const output = path.join(root, 'out/site-checks');
fs.mkdirSync(output, { recursive: true });
const catalog = JSON.parse(fs.readFileSync(path.join(root, 'out/site/data/catalog.json'), 'utf8'));
const replayEvidence = JSON.parse(fs.readFileSync(path.join(root, 'out/site/assets/replay.json'), 'utf8'));
const official = catalog.records.filter(record => record.status === 'official_accepted');
const ongoing = catalog.records.filter(record => record.status === 'in_progress_not_officially_accepted');
const local = catalog.records.filter(record => record.status === 'locally_verified');
// The shared replay, roadmap layout and bilingual node labels are UI code. Lean sources still load per record.
const archiveBundle = fs.readFileSync(path.join(root, 'out/site/site.js'), 'utf8');
assert.ok(Buffer.byteLength(archiveBundle) < 350_000, 'site.js with the replay and roadmap must not bundle the archive sources');
assert.equal(archiveBundle.includes('The no-seed alternative of the weighted totient companion theorem.'), false,
  'The Totient Lean source must stay in its lazy source asset');
const errors = [];
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async value => { window.testClipboard = value; } }, configurable: true });
  });
  await page.goto(url);
  await page.waitForSelector('.proof-row');
  assert.equal(await page.locator('.proof-row').count(), catalog.records.length);
  assert.equal(await page.locator('.proof-row.is-selected').count(), 1);
  assert.equal(await page.locator('#inspector .detail-title').textContent(), official[0].title);
  await page.screenshot({ path: path.join(output, 'desktop.png'), fullPage: true });

  await page.locator('input[name="status"][value="verified"]').check();
  assert.equal(await page.locator('.proof-row').count(), local.length);
  assert.equal(await page.locator('#verified-count').innerText(), String(local.length));
  for (const record of local) {
    await page.locator(`[data-proof-id="${record.id}"]`).click();
    await page.getByRole('tab', { name: '验证证据' }).click();
    assert.match(await page.locator('.campaign-evidence').innerText(), /kernel_verified/);
    assert.match(await page.locator('.campaign-evidence').innerText(), new RegExp(record.campaign.proofSha256));
    assert.equal(await page.locator('.official-result-link').count(), 0);
    await page.getByRole('tab', { name: '解题过程' }).click();
    await page.locator('.process-run').first().waitFor();
    assert.equal(await page.locator('.process-run').count(), record.process.runs.length);
    await page.locator('[data-action="back-list"]').first().click();
  }
  const example = local.find(record => record.campaign.target === 'TotientCompanionZero');
  assert.ok(example, 'the completed Totient result must be displayed');
  await page.locator(`[data-proof-id="${example.id}"]`).click();
  await page.getByRole('tab', { name: 'Lean 源码' }).click();
  await page.locator('#source-file').waitFor();
  assert.equal(await page.locator('#source-file option').count(), example.sources.length);
  assert.match(await page.locator('.source-code').innerText(), /companion_zero_case/);
  await page.getByRole('tab', { name: '解题过程' }).click();
  const processLink = page.url();
  await page.reload();
  await page.locator('.process-run').first().waitFor();
  assert.equal(page.url(), processLink);
  const localDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载此题档案 JSON' }).click();
  const downloaded = JSON.parse(fs.readFileSync(await (await localDownload).path(), 'utf8'));
  assert.deepEqual(downloaded.process, example.process);
  assert.equal(downloaded.sources.find(source => source.name === 'Submission.lean').code,
    example.sources.find(source => source.name === 'Submission.lean').code);
  await page.screenshot({ path: path.join(output, 'openai-process-desktop.png'), fullPage: true });
  await page.locator('[data-action="back-list"]').first().click();

  await page.getByRole('radio', { name: /已验收/ }).check();
  assert.equal(await page.locator('.proof-row').count(), official.length);
  await page.getByRole('radio', { name: /研究中/ }).check();
  assert.equal(await page.locator('.proof-row').count(), ongoing.length);
  assert.match(await page.locator('#inspector').innerText(), /尚未官方验收/);
  await page.getByRole('tab', { name: '验证证据' }).click();
  assert.equal(await page.locator('.official-result-link').count(), 0);

  await page.getByRole('radio', { name: /全部/ }).check();
  await page.getByRole('searchbox').fill('不存在的题目');
  assert.equal(await page.locator('.proof-row').count(), 0);
  assert.equal(await page.locator('#empty-state').isVisible(), true);
  await page.getByRole('button', { name: '清除筛选' }).click();
  await page.getByRole('searchbox').fill('群环');
  assert.equal(await page.locator('.proof-row').count(), 1);
  assert.equal(await page.locator('#inspector .detail-title').textContent(), 'Unit conjecture');
  await page.getByRole('tab', { name: '概览' }).click();
  assert.equal(await page.locator('#inspector').innerText().then(text => text.includes('DeepScientist + GPT-5.6')), true);
  await page.getByRole('tab', { name: '验证证据' }).click();
  assert.equal(await page.locator('.official-result-link').getAttribute('href'), official.find(record => record.id === 'annals_unit_conjecture').official.resultUrl);
  assert.equal(await page.locator('#inspector').innerText().then(text => text.includes('comparator:')), false);

  await page.getByRole('searchbox').fill('');
  await page.selectOption('#sort', 'title');
  const titles = await page.locator('.row-title').allTextContents();
  assert.deepEqual(titles, [...titles].sort((a, b) => a.localeCompare(b, 'en')));
  await page.locator('[data-proof-id="annals_rademacher_enflo_type"]').click();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  assert.notEqual(await page.locator('.proof-row.is-selected').getAttribute('data-proof-id'), 'annals_rademacher_enflo_type');
  await page.locator('[data-proof-id="annals_rademacher_enflo_type"]').click();
  await page.getByRole('tab', { name: 'Lean 源码' }).click();
  assert.match(await page.locator('.is-declaration').innerText(), /theorem theorem_1_1/);
  await page.locator('[data-proof-id="annals_equiangular_lines_fixed_angle"]').click();
  await page.getByRole('tab', { name: '验证证据' }).click();
  assert.match(await page.locator('.binding-note').innerText(), /源码哈希与当前归档不同/);
  await page.getByRole('tab', { name: 'Lean 源码' }).click();
  assert.match(await page.locator('.source-code').innerText(), /theorem theorem_1_2/);
  assert.ok(await page.locator('.source-code').evaluate(element => element.scrollTop > 0));
  await page.getByRole('button', { name: '复制 Lean 源码' }).click();
  assert.equal(await page.evaluate(() => window.testClipboard), official.find(record => record.id === 'annals_equiangular_lines_fixed_angle').sources.find(source => source.name === 'Submission.lean').code);
  await page.selectOption('#source-file', 'Submission/Helpers.lean');
  assert.equal(await page.locator('.source-code .code-line').count(), official.find(record => record.id === 'annals_equiangular_lines_fixed_angle').sources.find(source => source.name === 'Submission/Helpers.lean').lines);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载此题档案 JSON' }).click();
  const download = await downloadPromise;
  assert.equal(download.suggestedFilename(), 'annals_equiangular_lines_fixed_angle.json');
  const record = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
  assert.equal(record.status, 'official_accepted');
  assert.ok(record.official.resultUrl.includes('/issues/2135'));
  assert.deepEqual(record.sources.map(source => source.code), official.find(item => item.id === record.id).sources.map(source => source.code), 'The record download must include the lazily loaded Lean sources');
  assert.equal(record.excerpt, undefined);
  const deepLink = page.url();
  await page.reload();
  assert.equal(page.url(), deepLink);
  assert.equal(await page.getByRole('tab', { name: 'Lean 源码' }).getAttribute('aria-selected'), 'true');
  await page.getByRole('tab', { name: 'Lean 源码' }).focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('tab', { name: '验证证据' }).getAttribute('aria-selected'), 'true');

  const beforeReplay = page.url();
  const beforeReplayProof = await page.locator('.proof-row.is-selected').getAttribute('data-proof-id');
  await page.locator('[data-view-link="quickstart"]').click();
  assert.equal(await page.locator('#quickstart-view').isVisible(), true);
  assert.match(await page.locator('#quickstart-view').innerText(), /不调用模型/);
  assert.match(await page.locator('.quickstart-access').innerText(), /申请内测/);
  assert.equal(await page.locator('.quickstart-access a').getAttribute('href'), 'index.html#start');
  assert.equal(await page.locator('[data-action^="copy-install"], [data-action^="copy-replay"]').count(), 0);
  assert.match(await page.locator('#stage-verified').innerText(), /exact Nat.zero_add n/u);
  assert.equal(await page.locator('.replay-playback').isVisible(), true);
  assert.equal(await page.locator('.receipt-evidence').getAttribute('href'), 'assets/replay.json');
  await page.screenshot({ path: path.join(output, 'quickstart.png'), fullPage: true });
  await page.goBack();
  assert.equal(await page.locator('#archive-view').isVisible(), true);
  assert.equal(page.url(), beforeReplay);
  assert.equal(await page.locator('.proof-row.is-selected').getAttribute('data-proof-id'), beforeReplayProof);

  for (const viewport of [{ width: 1920, height: 1080 }, { width: 768, height: 1000 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
    await page.setViewportSize(viewport);
    await page.goto(url);
    await page.waitForSelector('.proof-row');
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.evaluate(() => scrollY), 0, `The generic archive starts at the list at ${viewport.width}px`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Horizontal overflow at ${viewport.width}px`);
    assert.ok(await page.locator('.brand-mark').evaluate(image => image.complete && image.naturalWidth > 0));
    await page.screenshot({ path: path.join(output, `archive-${viewport.width}.png`), fullPage: true });
    await page.getByRole('searchbox').fill('long-query-'.repeat(30));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Search overflow at ${viewport.width}px`);
    await page.getByRole('searchbox').fill('');
    await page.locator('[data-proof-id="hopf_rinow"]').click();
    if (viewport.width <= 700) {
      assert.equal(await page.locator('#inspector').evaluate(element => document.activeElement === element), true);
      assert.ok(Math.abs(await page.locator('#inspector').evaluate(element => element.getBoundingClientRect().top)) <= 1);
      await page.locator('[data-action="back-list"]').first().click();
      assert.equal(await page.locator('[data-proof-id="hopf_rinow"]').evaluate(element => document.activeElement === element), true);
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('#inspector').evaluate(element => document.activeElement === element), true);
    }
    await page.getByRole('tab', { name: 'Lean 源码' }).click();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Source overflow at ${viewport.width}px`);
    await page.screenshot({ path: path.join(output, `source-${viewport.width}.png`), fullPage: true });
    await page.goto(`${url}?deep-link=${viewport.width}#proof=${example.id}&tab=process&status=verified`);
    await page.locator('.process-run').first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    if (viewport.width <= 700) {
      await page.waitForFunction(() => document.activeElement?.id === 'inspector');
      assert.ok(Math.abs(await page.locator('#inspector').evaluate(element => element.getBoundingClientRect().top)) <= 1, 'Mobile proof links reveal details without manual scrolling');
      const proofLink = page.url();
      await page.locator('[data-action="back-list"]').first().click();
      const previous = new URLSearchParams(new URL(proofLink).hash.slice(1));
      const returned = new URLSearchParams(new URL(page.url()).hash.slice(1));
      for (const key of ['proof', 'status', 'q', 'sort']) assert.equal(returned.get(key), previous.get(key), 'Returning to the list keeps the selected record and filters');
      assert.equal(await page.locator('.catalog').isVisible(), true);
      assert.equal(await page.locator('.proof-row.is-selected').evaluate(element => document.activeElement === element), true);
      await page.keyboard.press('Enter');
      assert.equal(await page.locator('.archive-access a').getAttribute('href'), 'index.html#start');
    } else {
      assert.equal(await page.locator('.catalog').isVisible(), false, 'Desktop trajectories use the full reading width');
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `Process overflow at ${viewport.width}px`);
    await page.screenshot({ path: path.join(output, `openai-process-${viewport.width}.png`), fullPage: true });
  }
  for (const width of [1440, 320]) {
    const replayPage = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: width === 1440 ? 'no-preference' : 'reduce' });
    replayPage.on('pageerror', error => errors.push(error.message));
    replayPage.on('console', message => { if (['error', 'warning'].includes(message.type())) errors.push(message.text()); });
    await checkArchiveReplay(replayPage, `${url}#proof=${example.id}&status=verified&tab=overview&sort=title`, {
      evidence: replayEvidence, label: `Chinese public archive at ${width}px`,
    });
    await replayPage.screenshot({ path: path.join(output, `replay-${width}.png`), fullPage: true });
    await replayPage.close();
  }
  const noScript = await browser.newPage({ javaScriptEnabled: false, viewport: { width: 320, height: 844 } });
  noScript.on('pageerror', error => errors.push(error.message));
  await checkStaticArchiveReceipt(noScript, `${url}#view=quickstart`, { evidence: replayEvidence, label: 'Chinese public no-script archive at 320px' });
  await noScript.screenshot({ path: path.join(output, 'replay-no-script-320.png'), fullPage: true });
  await noScript.close();
  assert.deepEqual(errors, []);
  console.log('Site checks passed: filters, search, provenance, evidence, source files, clipboard, JSON download, mobile proof links and focus, return to results, access links, interactive replay with zero API/write requests, no-script receipt, navigation, and 5 viewport sizes.');
  console.log(`Screenshots: ${path.relative(root, output)}`);
} finally {
  await browser.close();
}
