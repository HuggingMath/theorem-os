#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, BrowserContext, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import type { WebRunner } from '../apps/web/runner';
import { createWebService } from '../apps/web/server';
import type { WebRunInput, WebSession } from '../apps/web/shared';
import type { ArchiveCatalog, ArchiveRecord } from '../docs/web/types';
import { freePort, settled, startBrowser } from './web-scenario';
import { checkArchiveReplay, checkStaticArchiveReceipt } from './archive-replay-checks.mjs';

// Real workbench HTTP and email login, with disposable accounts and a runner that never calls a provider or Lean.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web-classics');
const staticRoot = path.join(root, 'out/web');
const catalogFile = path.join(staticRoot, 'classics/data/catalog.json');
await fs.access(catalogFile).catch(() => { throw new Error('Run bun run build:web before the classic problems check.'); });
const catalog = JSON.parse(await fs.readFile(catalogFile, 'utf8')) as ArchiveCatalog;
const replayEvidence = JSON.parse(await fs.readFile(path.join(staticRoot, 'classics/assets/replay.json'), 'utf8'));
const expectedIds = catalog.records.map(record => record.id).sort();
assert.equal(catalog.records.length, 16, 'The workbench must ship the sixteen completed campaign problems');
assert.equal(new Set(expectedIds).size, catalog.records.length, 'Every classic problem has its own stable identity');
assert.ok(catalog.records.every(record => record.status === 'locally_verified' && record.campaign && record.process),
  'Every classic problem must retain its local acceptance and recorded process');
const example = catalog.records.find(record => record.campaign?.target === 'TotientCompanionZero');
assert.ok(example, 'Totient is required to exercise the automatically built helper library');
assert.equal(example.sources.length, 46, 'The helper library must be included, not just the final Lean file');
await fs.mkdir(output, { recursive: true });

const data = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-web-classics-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const privateTask = 'Alice private fixture: verify owner isolation from the shared classics';
const credential = 'sk-classics-isolation-fixture-never-publish';
let runnerCalls = 0;
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Local classic problems fixture; no model or Lean' }; },
  async run(input, send) {
    runnerCalls++;
    assert.equal(input.input.task, privateTask, 'Browsing the classics must never start a research worker');
    send({ type: 'result', result: { status: 'limit_reached', proof: '', report: { fixture: true } } });
  },
};
const mail: { to: string; text: string }[] = [];
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: staticRoot, THEOREMOS_WEB_AUTH: 'email', THEOREMOS_WEB_SMTP_URL: 'log:',
  THEOREMOS_WEB_ALLOWLIST: 'alice@example.org,bob@example.org', THEOREMOS_WEB_DATA_ROOT: data }), runner,
{ mailer: async message => { mail.push(message); }, captchaAnswer: () => '24680' });
const checks: string[] = [], errors: string[] = [];
const replayChecks: unknown[] = [];
let browser: Browser | undefined, activePage: Page | undefined, currentCheck = 'Start browser';
const mark = (check: string) => { checks.push(check); currentCheck = check; console.log(`PASS ${check}`); };
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const noOverflow = async (page: Page, label: string) => {
  await settled(page);
  const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth }));
  assert.ok(width.scroll <= width.viewport, `${label} overflows: ${JSON.stringify(width)}`);
};
const idsOnPage = async (page: Page) => (await page.locator('.proof-row').evaluateAll(rows =>
  rows.map(row => (row as HTMLElement).dataset.proofId!))).sort();
const readSession = async (page: Page) => (await (await page.request.get(`${origin}/api/session`)).json()) as WebSession;
const readRuns = async (page: Page) => {
  const response = await page.request.get(`${origin}/api/runs`);
  assert.equal(response.status(), 200);
  return (await response.json()).runs as { id: string; task: string; status: string }[];
};

async function account(email: string): Promise<{ page: Page; context: BrowserContext }> {
  assert.ok(browser);
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN', reducedMotion: 'reduce' });
  context.on('page', page => {
    page.setDefaultTimeout(15_000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  });
  const page = await context.newPage();
  activePage = page;
  await page.goto(origin);
  await page.waitForURL(/\/login\.html$/u);
  await page.locator('#send-code:enabled').waitFor();
  await page.fill('#login-email', email);
  await page.fill('#login-captcha', '24680');
  await page.click('#send-code');
  await page.locator('#code-step:not([hidden])').waitFor();
  const sent = mail.findLast(message => message.to === email)?.text.match(/\b\d{6}\b/u)?.[0];
  assert.ok(sent, `The fixture mailer must receive the login code for ${email}`);
  await page.fill('#login-code', sent);
  await page.click('#verify-code');
  await page.waitForURL(`${origin}/`);
  await page.locator('#open-account').waitFor();
  assert.equal(await page.locator('#open-account').innerText(), email);
  const session = await readSession(page);
  assert.equal(session.account?.email, email);
  assert.notEqual(session.account?.admin, true, 'A classic problem must not require an administrator account');
  assert.deepEqual(await readRuns(page), [], 'A new ordinary account starts without private research runs');
  assert.equal(await page.locator('#api-key').inputValue(), '', 'A classic problem must not require a model key');
  const entry = page.locator('#open-classics');
  assert.equal(await entry.innerText(), '经典题库');
  assert.equal(await entry.getAttribute('href'), 'classics/archive.html#status=verified');
  assert.equal(await entry.getAttribute('target'), '_blank');
  assert.equal(await entry.isVisible(), true, 'The classic library must remain visible on the natural-language start screen');
  return { page, context };
}

async function openClassics(page: Page, english = false) {
  const opened = page.waitForEvent('popup');
  await page.locator('#open-classics').click();
  const archive = await opened;
  activePage = archive;
  await archive.waitForURL(`${origin}/classics/${english ? 'en/' : ''}archive.html*`);
  await archive.locator('.proof-row').first().waitFor();
  assert.deepEqual(await idsOnPage(archive), expectedIds);
  return archive;
}

async function inspectAll(page: Page, label: string) {
  currentCheck = `${label}: every proof, process and acceptance`;
  for (const record of catalog.records) {
    await page.locator(`[data-proof-id="${record.id}"]`).click();
    await page.getByRole('tab', { name: 'Lean 源码', exact: true }).click();
    await page.locator('#source-file').waitFor();
    await page.selectOption('#source-file', 'Submission.lean');
    const submission = record.sources.find(source => source.name === 'Submission.lean');
    assert.ok(submission);
    assert.equal(await page.locator('#source-file option').count(), record.sources.length);
    assert.equal(await page.locator('.source-code .code-line').count(), submission.lines);
    assert.ok((await page.locator('.source-facts').innerText()).includes(submission.sha256));
    assert.ok((await page.locator('.source-code').innerText()).length > 0);
    await page.getByRole('tab', { name: '路线与轨迹', exact: true }).click();
    await page.locator('.global-run-lane').first().waitFor();
    assert.equal(await page.locator('.global-run-lane').count(), record.process!.runs.length);
    assert.equal(await page.locator('.global-run-lane[data-final="true"]').getAttribute('data-global-run-id'), record.campaign!.runId);
    await page.getByRole('tab', { name: '验证证据', exact: true }).click();
    const evidence = await page.locator('.campaign-evidence').innerText();
    assert.ok(evidence.includes(record.campaign!.proofSha256));
    assert.match(evidence, /kernel_verified/u);
    assert.match(evidence, /evaluated_passed/u);
    assert.equal(await page.locator('.official-result-link').count(), 0, 'Local acceptance must not become an official result');
  }
  mark(`${label} opens the same ${catalog.records.length} proofs, recorded processes and local acceptance records without a key`);
}

async function rawDownloads(page: Page, record: ArchiveRecord) {
  const submission = record.sources.find(source => source.name === 'Submission.lean')!;
  const source = await page.request.get(`${origin}/classics/data/proofs/${record.id}/Submission.lean`);
  assert.equal(source.status(), 200, 'The real workbench server must serve Lean downloads');
  assert.match(source.headers()['content-type'] ?? '', /^text\/plain(?:;|$)/u);
  assert.equal(digest(await source.body()), submission.sha256);
  const verification = await page.request.get(`${origin}/classics/data/proofs/${record.id}/verification.json`);
  assert.equal(verification.status(), 200, 'The real workbench server must serve verification JSON');
  assert.match(verification.headers()['content-type'] ?? '', /^application\/json(?:;|$)/u);
  assert.equal((await verification.json()).runId, record.campaign!.runId);
}

try {
  browser = await startBrowser(service.server, port);
  const alice = await account('alice@example.org'), bob = await account('bob@example.org');
  mark('Two ordinary accounts have a visible permanent classic link before creating a run or entering a key');
  const aliceArchive = await openClassics(alice.page), bobArchive = await openClassics(bob.page);
  await inspectAll(aliceArchive, 'Alice');
  await inspectAll(bobArchive, 'Bob');
  assert.equal(runnerCalls, 0, 'All problem views from both accounts must be read-only');

  currentCheck = 'Recorded references, typed requests, application checks and import stages';
  const evidenceFixture = structuredClone(example.process!);
  const fixtureRun = evidenceFixture.runs.find(run => run.runId === example.campaign!.runId)!;
  evidenceFixture.runs = [fixtureRun];
  const consumer = { taskId: 'fixture-original-goal', taskDigest: 'f'.repeat(64) };
  fixtureRun.sourceUses = [{ deliveryId: 'fixture-finding', deliveryStatus: 'advisory', kind: 'mathlib',
    reference: 'Mathlib fixture <img src=x onerror=alert(1)>', locator: 'Nat.add_zero', assumptions: ['n : ℕ'],
    adaptation: 'Apply a fixed recurrence at the original consumer.', consumer, lemmaRequestIds: ['fixture-bridge'],
    remaining: ['Prove the outer induction'] }];
  fixtureRun.lemmaRequests = [{ deliveryId: 'fixture-finding', deliveryStatus: 'advisory', id: 'fixture-bridge',
    objective: 'Bridge the recurrence', theorem: 'Fixture.bridge', type: '∀ n : ℕ, n + 0 = n', dependencies: [] }];
  fixtureRun.knowledgeApplications = [{ id: 'fixture-entry', consumer,
    declaration: { name: 'Fixture.bridge', file: 'Submission/Library/Fixture/Bridge.lean' },
    check: { status: 'elaborated', authority: 'advisory-application-elaboration', proofAcceptance: 'not-assessed',
      consumerCoverage: 'not-assessed', selectedDeclarationUsed: true } }];
  fixtureRun.libraryUsage = { evidence: 'saved-imports-and-lexical-mentions', installed: [{ name: 'FixtureBridge' }],
    drafts: [{ workerId: 'fixture-engineer', sourceDigest: 'd'.repeat(64), checked: false,
      modules: [{ name: 'FixtureBridge', file: 'Submission/Library/Fixture/Bridge.lean', direct: true, mentioned: ['Fixture.bridge'] }] }],
    canonical: { commit: 'c'.repeat(40), checked: false, modules: [] }, checked: null };
  const reuseTexts: string[] = [];
  for (const context of [alice.context, bob.context]) {
    const page = await context.newPage();
    await page.route(`**/classics/data/process/${example.id}.js*`, route => route.fulfill({ contentType: 'application/javascript',
      body: `(window.theoremosProcesses??={})[${JSON.stringify(example.id)}]=${JSON.stringify(evidenceFixture)};` }));
    await page.goto(`${origin}/classics/archive.html#proof=${example.id}&tab=process&status=verified&mode=roadmap`);
    const panel = page.locator('.process-research-evidence').first();
    await panel.locator('summary').click();
    const text = await panel.innerText();
    for (const fact of ['Nat.add_zero', 'Fixture.bridge', 'fixture-original-goal', '∀ n : ℕ, n + 0 = n',
      '局部表达式检查通过', '已安装: FixtureBridge', 'fixture-engineer', '未知：没有保存记录']) assert.ok(text.includes(fact), fact);
    assert.equal(await panel.locator('img').count(), 0, 'Reference text must be rendered as text');
    reuseTexts.push(text);
    await page.close();
  }
  assert.equal(reuseTexts[0], reuseTexts[1], 'Two accounts must see the same public recorded evidence');
  assert.equal(runnerCalls, 0, 'Reading recorded reuse evidence must not invoke a solver');
  mark('Two accounts render the same references, typed requests, local checks and import stages, with missing evidence marked unknown');

  currentCheck = 'Totient helper sources, process deep link and complete downloads';
  activePage = aliceArchive;
  await aliceArchive.goto(`${origin}/classics/archive.html#proof=${example.id}&tab=process&status=verified`);
  await aliceArchive.locator('.global-run-lane').first().waitFor();
  const deepLink = aliceArchive.url();
  await aliceArchive.reload();
  await aliceArchive.locator('.global-run-lane').first().waitFor();
  assert.equal(aliceArchive.url(), deepLink);
  assert.equal(await aliceArchive.getByRole('tab', { name: '路线与轨迹', exact: true }).getAttribute('aria-selected'), 'true');
  const downloadReady = aliceArchive.waitForEvent('download');
  await aliceArchive.getByRole('button', { name: '下载此题档案 JSON', exact: true }).click();
  const downloadedFile = await (await downloadReady).path();
  assert.ok(downloadedFile);
  const downloaded = JSON.parse(await fs.readFile(downloadedFile, 'utf8')) as ArchiveRecord;
  assert.deepEqual(downloaded.process, example.process);
  assert.deepEqual(downloaded.sources, example.sources, 'JSON downloads retain every helper source and its original bytes');
  await rawDownloads(aliceArchive, example);
  await rawDownloads(bobArchive, example);
  await aliceArchive.screenshot({ path: path.join(output, 'classic-process-1440.png'), fullPage: true });
  mark('Totient retains 46 Lean files, deep-link refresh and complete process/source downloads through real HTTP');

  currentCheck = 'Language switching keeps the shared archive available';
  await aliceArchive.locator('.lang-link').click();
  await aliceArchive.waitForURL(`${origin}/classics/en/archive.html*`);
  await aliceArchive.locator('.archive-process').waitFor();
  assert.deepEqual(await idsOnPage(aliceArchive), expectedIds);
  assert.equal(await aliceArchive.locator('.global-run-lane[data-final="true"]').getAttribute('data-global-run-id'), example.campaign!.runId);
  await aliceArchive.getByRole('tab', { name: 'Routes and trajectory', exact: true }).click();
  await aliceArchive.locator('.global-run-lane').first().waitFor();
  assert.equal(await aliceArchive.getByRole('tab', { name: 'Routes and trajectory', exact: true }).getAttribute('aria-selected'), 'true');
  await aliceArchive.getByRole('tab', { name: 'Evidence', exact: true }).click();
  const englishEvidence = aliceArchive.locator('.campaign-evidence a').filter({ hasText: 'verification.json' });
  assert.equal(await englishEvidence.evaluate(link => (link as HTMLAnchorElement).href),
    `${origin}/classics/data/proofs/${example.id}/verification.json`);
  await alice.page.locator('#locale-switch').click();
  await alice.page.waitForFunction(() => document.documentElement.lang === 'en-US');
  await alice.page.locator('#open-classics').waitFor();
  assert.equal(await alice.page.locator('#open-classics').innerText(), 'Classic problems');
  assert.equal(await alice.page.locator('#open-classics').getAttribute('href'), 'classics/en/archive.html#status=verified');
  const englishArchive = await openClassics(alice.page, true);
  await englishArchive.close();
  mark(`The workbench and archive language switches open the same ${catalog.records.length} shared classics in English`);

  currentCheck = '320 pixel workbench entry and Chinese/English process layouts';
  for (const page of [alice.page, bob.page]) {
    await page.setViewportSize({ width: 320, height: 760 });
    await noOverflow(page, 'The signed-in workbench at 320 pixels');
    const entry = page.locator('#open-classics');
    assert.equal(await entry.isVisible(), true);
    const box = await entry.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 320, 'The permanent classic link must stay on screen');
  }
  await alice.page.screenshot({ path: path.join(output, 'classic-entry-en-320.png') });
  await bob.page.screenshot({ path: path.join(output, 'classic-entry-zh-320.png') });
  for (const [archive, english] of [[aliceArchive, true], [bobArchive, false]] as const) {
    await archive.setViewportSize({ width: 320, height: 760 });
    await archive.goto(`${origin}/classics/${english ? 'en/' : ''}archive.html#proof=${example.id}&tab=process&status=verified`);
    await archive.locator('.global-run-lane').first().waitFor();
    await archive.locator('#inspector').scrollIntoViewIfNeeded();
    await noOverflow(archive, `${english ? 'English' : 'Chinese'} classic process at 320 pixels`);
    await archive.screenshot({ path: path.join(output, `classic-process-${english ? 'en' : 'zh'}-320.png`), fullPage: true });
  }
  assert.equal(runnerCalls, 0);
  assert.deepEqual(await readRuns(alice.page), []);
  assert.deepEqual(await readRuns(bob.page), []);
  mark('The permanent entry and full research process fit 320 pixels in Chinese and English without creating runs');

  currentCheck = 'Interactive classic replay through real authenticated service paths';
  for (const english of [false, true]) {
    for (const width of [1440, 320]) {
      const page = await alice.context.newPage();
      activePage = page;
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: width === 1440 ? 'no-preference' : 'reduce' });
      replayChecks.push(await checkArchiveReplay(page,
        `${origin}/classics/${english ? 'en/' : ''}archive.html#proof=${example.id}&status=verified&tab=overview&sort=title`, {
          english, evidence: replayEvidence, label: `${english ? 'English' : 'Chinese'} workbench classics at ${width}px`,
        }));
      assert.equal(runnerCalls, 0, 'Interactive replay must not invoke the research runner');
      await page.screenshot({ path: path.join(output, `classic-replay-${english ? 'en' : 'zh'}-${width}.png`), fullPage: true });
      await page.close();
    }
  }
  const noScriptContext = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 320, height: 844 },
    storageState: await alice.context.storageState() });
  noScriptContext.on('page', page => {
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  });
  for (const english of [false, true]) {
    const page = await noScriptContext.newPage();
    activePage = page;
    replayChecks.push(await checkStaticArchiveReceipt(page, `${origin}/classics/${english ? 'en/' : ''}archive.html#view=quickstart`, {
      english, evidence: replayEvidence, label: `${english ? 'English' : 'Chinese'} workbench no-script classics at 320px`,
    }));
    await page.screenshot({ path: path.join(output, `classic-replay-no-script-${english ? 'en' : 'zh'}-320.png`), fullPage: true });
    await page.close();
  }
  await noScriptContext.close();
  assert.equal(runnerCalls, 0);
  assert.deepEqual(await readRuns(alice.page), []);
  assert.deepEqual(await readRuns(bob.page), []);
  mark('Chinese and English classic replays support playback, keyboard, history, raw receipts and no-script reading without API calls or new runs');

  currentCheck = 'Shared classics preserve account ownership of private research';
  activePage = alice.page;
  const session = await readSession(alice.page);
  const input: WebRunInput = { providerId: 'openai', apiKey: credential, model: 'fixture-classics', effort: 'low',
    source: 'theorem private_fixture : True := by sorry\n', task: privateTask, environment: 'standard',
    maxTurns: 2, maxRunSeconds: 30, workers: 1, coordination: 'cooperative' };
  const created = await alice.page.request.post(`${origin}/api/runs`, { headers: { 'X-CSRF-Token': session.csrfToken }, data: input });
  assert.equal(created.status(), 201);
  const privateId = (await created.json()).run.id as string;
  await alice.page.waitForFunction(async id => {
    const response = await fetch(`/api/runs/${id}`);
    return response.ok && ['completed', 'cancelled', 'error'].includes((await response.json()).run.status);
  }, privateId);
  const owned = await alice.page.request.get(`${origin}/api/runs/${privateId}`);
  assert.equal(owned.status(), 200);
  assert.equal((await owned.json()).run.result?.status, 'limit_reached', 'The private fixture must finish before cleanup');
  assert.deepEqual((await readRuns(alice.page)).map(run => run.id), [privateId]);
  assert.deepEqual(await readRuns(bob.page), []);
  for (const operation of ['', '/trajectory', '/tasks/private_fixture/source', '/download']) {
    const inaccessible = await bob.page.request.get(`${origin}/api/runs/${privateId}${operation}`);
    assert.equal(inaccessible.status(), 404, `Bob must not read Alice's private ${operation || 'run'}`);
    const text = await inaccessible.text();
    assert.equal(text.includes(privateTask), false);
    assert.equal(text.includes(credential), false);
  }
  for (const page of [alice.page, bob.page]) {
    const response = await page.request.get(`${origin}/classics/data/catalog.json`);
    assert.equal(response.status(), 200);
    const body = await response.text(), shared = JSON.parse(body) as ArchiveCatalog;
    assert.deepEqual(shared.records.map(record => record.id).sort(), expectedIds);
    assert.equal(body.includes(privateId) || body.includes(privateTask) || body.includes(credential), false);
  }
  await aliceArchive.reload();
  await aliceArchive.locator('.global-run-lane').first().waitFor();
  assert.deepEqual(await idsOnPage(aliceArchive), expectedIds);
  assert.equal(runnerCalls, 1, 'Only the explicitly submitted private test run may call the fixture runner');
  mark('Shared classics stay identical while Bob cannot list, open or download Alice’s private run, trajectory or source');
  assert.deepEqual(errors, [], 'No page, resource or CSP errors');
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', checkedAt: new Date().toISOString(), checks,
    accounts: 2, classicProblems: catalog.records.length, replayChecks, fixtureRunnerCalls: runnerCalls, paidModelCalls: false,
    leanProcesses: 0, mode: 'Real workbench HTTP and Chromium with email login and disposable ordinary accounts' }, null, 2) + '\n');
  console.log(`Classic problems account checks passed. Report and screenshots: ${path.relative(root, output)}`);
} catch (error) {
  await activePage?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'failed', currentCheck, checks,
    error: error instanceof Error ? error.message : String(error), browserErrors: errors, fixtureRunnerCalls: runnerCalls,
    paidModelCalls: false, leanProcesses: 0 }, null, 2) + '\n');
  throw error;
} finally {
  await browser?.close();
  await service.close();
  await fs.rm(data, { recursive: true, force: true });
}
