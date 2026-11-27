#!/usr/bin/env bun
// Disposable accounts, recorded observations and a controlled runner; no model, Lean or mail calls.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext, Locator, Page } from 'playwright';
import { WebStorage } from '../apps/web/storage';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import { loadWebSample } from '../apps/web/sample';
import { mathDigest } from '../src/math/mathRuntimeIo';
import type { WebRunner } from '../apps/web/runner';
import { freePort, preferFullCollaboration, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..'), output = process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/product-continuity/draft-lifecycle');
const staticRoot = process.env.THEOREMOS_FRONTEND_TEST_STATIC_ROOT ?? path.join(root, 'out/web');
await fs.access(path.join(staticRoot, 'research.js')); await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-input-drafts-'));
const port = await freePort(), origin = `http://127.0.0.1:${port}`, sample = loadWebSample()!;
const config = readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin, THEOREMOS_WEB_STATIC_ROOT: staticRoot,
  THEOREMOS_WEB_DATA_ROOT: dataRoot, THEOREMOS_WEB_AUTH: 'email', THEOREMOS_WEB_SMTP_URL: 'log:', THEOREMOS_WEB_ALLOWLIST: 'alice@example.org,bob@example.org', THEOREMOS_WEB_CLIENT_IP_HEADER: 'x-fixture-visitor' });
const seed = new WebStorage(dataRoot), accounts = ['alice', 'bob'].map(name => ({ id: crypto.randomUUID(), email: `${name}@example.org`,
  createdAt: new Date().toISOString(), termsAt: new Date().toISOString(), termsVersion: config.auth!.termsVersion }));
for (const account of accounts) seed.saveRecord(['accounts', `${mathDigest(account.email)}.json`], account);
const sessions = accounts.map(account => ({ id: crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', ''),
  csrf: mathDigest(crypto.randomUUID()), touchedAt: Date.now(), account: { id: account.id, email: account.email } }));
sessions.forEach(session => seed.saveSession(session));
let prohibited = 0, workers = 0;
const runner: WebRunner = { async readiness() { return { ready: true, message: 'Controlled input draft fixture' }; },
  async run(input, send, signal) { workers++; const observation = structuredClone(sample.observations.at(-1)!); observation.webRunId = input.id;
    send({ type: 'observation', observation }); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); },
  async check() { prohibited++; throw new Error('No Lean calls in input draft verification'); },
  async formalize() { prohibited++; throw new Error('No model calls in input draft verification'); },
  async command() { prohibited++; throw new Error('No solver commands in input draft verification'); },
};
const service = createWebService(config, runner, { sample: null, mailer: async () => { prohibited++; throw new Error('No mail in this fixture'); } });
const owner = `account:${accounts[0].id}`, reviewerOwner = `account:${accounts[1].id}`, provider = config.providers[0];
const browser = await startBrowser(service.server, port), contexts: BrowserContext[] = [], checks: object[] = [], errors: string[] = [], external: string[] = [];
let active: Page | undefined, phase = 'setup';
async function actor(index: number, width: number, language: 'zh' | 'en') {
  const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: language === 'zh' ? 'zh-CN' : 'en-US', reducedMotion: 'reduce', extraHTTPHeaders: { 'x-fixture-visitor': `draft-${index}-${width}-${language}` } }); contexts.push(context);
  await context.addCookies([{ name: 'theoremos_session', value: sessions[index].id, url: origin }]);
  await preferFullCollaboration(context); await context.addInitScript(language => localStorage.setItem('theorem-os.web-locale.v1', language), language);
  await context.route(/^https?:\/\//u, async route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue(); });
  const page = await context.newPage(); page.setDefaultTimeout(15_000); page.on('pageerror', error => errors.push(error.message)); return page;
}
async function openDetails(details: Locator) { if (!(await details.evaluate(element => (element as HTMLDetailsElement).open))) await details.locator(':scope>summary').click(); }
async function saveAccount(host: Locator) {
  const local = host.locator('[data-human-drafts]>details').first(); await openDetails(local); await local.locator('[data-save-account-draft]').first().click();
  await host.locator('[data-account-draft-notice]').first().waitFor();
}
async function archived(page: Page, kind: string, projectId: string) {
  await page.waitForFunction(async ({ kind, projectId }) => {
    const data = await (await fetch(`/api/research/personal/drafts?${new URLSearchParams({ kind, projectId, status: 'all' })}`)).json();
    return data.items.some((item: { versions: { status?: string }[] }) => item.versions.some(version => version.status === 'submitted'));
  }, { kind, projectId });
}
try {
  for (const width of [1440, 390]) for (const language of ['zh', 'en'] as const) {
    const run = service.jobs.create(owner, { providerId: provider.id, apiKey: 'sk-disposable-never-used', model: 'fixture-model', effort: 'high',
      environment: sample.run.environment, source: sample.run.source.trim(), task: `Draft lifecycle ${width} ${language}`, maxTurns: 2, maxRunSeconds: 600, workers: 1, coordination: 'independent' }, provider);
    for (let attempt = 0; attempt < 80 && !run.observation; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(run.observation); const observation = run.observation, [firstTask, secondTask] = observation.inspection.tasks;
    let project = service.research.projects.create(owner, { requestId: `project-${width}-${language}`, title: 'Draft lifecycle fixture', visibility: 'members' });
    project = service.research.projects.setMember(owner, project.id, service.research.projects.identity(reviewerOwner), { requestId: 'reviewer', expectedRevision: project.revision, role: 'collaborator' });
    project = service.research.projects.addVersion(owner, project.id, { requestId: 'statement', expectedRevision: project.revision, statement: run.task, source: run.source, environment: run.environment });
    project = service.research.projects.bindRun(owner, project.id, { requestId: 'binding', expectedRevision: project.revision, runId: run.id, statementVersionId: project.versions[0].id, exposure: 'members', grants: { proof: true, guidance: true } });
    const target = { runId: run.id, statementVersionId: project.versions[0].id, observationRef: { sequence: observation.sequence, stateDigest: observation.snapshot.stateDigest }, taskRef: { id: firstTask.id, version: firstTask.version } };
    const source = observation.sources.find(item => item.taskId === firstTask.id && item.taskVersion === firstTask.version)!;
    const candidate = service.research.projects.submitFeedback(owner, project.id, { requestId: 'candidate', kind: 'proof-submission', text: 'Candidate for review text preservation', target,
      source: source.source, base: { file: source.file, commit: source.commit, sourceDigest: source.sourceDigest, environmentDigest: source.environmentDigest } });
    const alicePage = await actor(0, width, language), reviewerPage = await actor(1, width, language); active = alicePage;
    const problemHref = (task = firstTask, extra: Record<string, string> = {}) => `${origin}/problem.html?${new URLSearchParams({ project: project.id, run: run.id, tab: 'route', task: task.id, taskVersion: task.version, ...extra })}`;
    const openDrawer = async (page: Page) => { const drawer = page.locator('[data-inline-drawer]'); await page.locator('[data-inline-open]').waitFor(); if (!(await drawer.evaluate(element => (element as HTMLDialogElement).open))) await page.locator('[data-inline-open]').click(); return drawer; };
    phase = `${width}-${language}-annotation-and-thread-reply`;
    const annotationText = 'Explain how the displayed premise gives this result.';
    const newerText = 'Add the derivation after checking the intermediate expression.';
    await alicePage.goto(problemHref()); const drawer = await openDrawer(alicePage);
    const annotations = alicePage.locator('[data-research-annotations]');
    const annotationForm = () => annotations.locator('form').filter({ has: alicePage.locator('[data-save-annotation]') });
    const annotationInput = () => annotationForm().getByRole('textbox').last();
    await openDetails(annotations.locator(':scope>details').last());
    await annotations.locator('[data-annotation-whole-field]').click();
    await annotationInput().fill(annotationText);
    await drawer.locator('[data-inline-close]').click(); await openDrawer(alicePage);
    assert.equal(await annotationInput().inputValue(), annotationText);
    await alicePage.goto(problemHref(secondTask)); await openDrawer(alicePage);
    await openDetails(annotations.locator(':scope>details').last());
    assert.equal(await annotationInput().inputValue(), '');
    await alicePage.goto(problemHref()); await openDrawer(alicePage);
    assert.equal(await annotationInput().inputValue(), annotationText);
    await annotations.locator('[data-annotation-selection]').waitFor();
    await saveAccount(annotations);

    const annotationRoute = `**/api/research/theorems/${project.id}/runs/${run.id}/annotations*`;
    let release: (() => void) | undefined;
    await alicePage.route(annotationRoute, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch();
      await new Promise<void>(resolve => { release = resolve; });
      await route.fulfill({ response });
    });
    await annotations.locator('[data-save-annotation]').click();
    await annotationInput().fill(newerText);
    for (let attempt = 0; attempt < 100 && !release; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(release); release();
    await archived(alicePage, 'annotation', project.id);
    assert.equal(await annotationInput().inputValue(), newerText);
    await alicePage.unroute(annotationRoute);
    const thread = annotations.locator('[data-annotation-thread]').first(); await thread.waitFor(); const annotationId = (await thread.getAttribute('data-annotation-thread'))!;
    await thread.getByRole('textbox').fill('Use the original equality to rewrite the target.'); await alicePage.reload(); await openDrawer(alicePage);
    const restoredThread = alicePage.locator(`[data-annotation-thread="${annotationId}"]`); assert.equal(await restoredThread.getByRole('textbox').inputValue(), 'Use the original equality to rewrite the target.');
    await saveAccount(restoredThread); await restoredThread.locator('[data-reply-annotation]').click(); await archived(alicePage, 'annotation-reply', project.id);
    await alicePage.goto(problemHref(firstTask, { annotation: annotationId })); await alicePage.locator('[data-inline-drawer][open]').waitFor();
    await alicePage.waitForFunction(id => document.activeElement?.getAttribute('data-annotation-thread') === id, annotationId);
    checks.push({ phase, anchorAndTextRestored: true, threadTextRestored: true, completionLinked: true, deepLinkFocused: true });

    phase = `${width}-${language}-review-comment-and-author-supplement`; active = reviewerPage;
    const theoremHref = `${origin}/theorems.html?${new URLSearchParams({ id: project.id, run: run.id, version: project.versions[0].id })}#feedback-${candidate.id}`;
    await reviewerPage.goto(theoremHref); let review = reviewerPage.locator(`#feedback-${candidate.id} [data-feedback-review]`);
    await review.locator('[data-review-comment]').fill('Please justify the final rewrite.'); await reviewerPage.reload(); review = reviewerPage.locator(`#feedback-${candidate.id} [data-feedback-review]`);
    assert.equal(await review.locator('[data-review-comment]').inputValue(), 'Please justify the final rewrite.');
    const reviewForm = review.locator('form').filter({ has: reviewerPage.locator('[data-review-comment]') }); await saveAccount(reviewForm);
    await review.locator('[data-save-review-comment]').click(); await archived(reviewerPage, 'review', project.id);
    const current = service.research.projects.feedback(owner, project.id, candidate.id);
    service.research.projects.decideFeedback(reviewerOwner, project.id, candidate.id, { requestId: 'needs-info', expectedRevision: current.revision, status: 'needs-info', reason: 'Explain the intermediate equality' });
    active = alicePage; await alicePage.goto(theoremHref); let supplement = alicePage.locator(`#feedback-${candidate.id} [data-resubmit-review]`);
    await supplement.locator('textarea').fill('The intermediate equality follows by substitution.'); await alicePage.reload(); supplement = alicePage.locator(`#feedback-${candidate.id} [data-resubmit-review]`);
    assert.equal(await supplement.locator('textarea').inputValue(), 'The intermediate equality follows by substitution.');
    await saveAccount(supplement);
    const resubmitted = alicePage.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/research/theorems/${project.id}/feedback/${candidate.id}/review`);
    await supplement.locator('button[type=submit]').click(); const reviewedResponse = await resubmitted; assert.equal(reviewedResponse.status(), 200, await reviewedResponse.text());
    assert.ok((await reviewedResponse.json()).item.reviewHistory?.some((item: { action: string }) => item.action === 'resubmit'));
    await archived(alicePage, 'review', project.id);
    assert.ok(service.research.projects.feedback(owner, project.id, candidate.id).reviewHistory?.some(item => item.action === 'resubmit'));
    checks.push({ phase, reviewerTextRestored: true, authorTextRestored: true, bothCloudDraftsArchived: true });

    phase = `${width}-${language}-archive-management-and-restore`;
    await alicePage.goto(`${origin}/workspace.html?tab=drafts`); const panel = alicePage.locator('[data-personal-drafts-panel]'); await panel.locator('[data-personal-show-archived-drafts]').check();
    const savedAnnotation = await alicePage.evaluate(async projectId => (await (await fetch(`/api/research/personal/drafts?${new URLSearchParams({ kind: 'annotation', projectId, status: 'archived' })}`)).json()).items[0], project.id);
    const row = panel.locator(`[data-personal-draft="${savedAnnotation.id}"]`); await openDetails(row);
    const restoreHref = (await row.getByRole('link').filter({ hasText: /回到编辑器恢复|Open the editor to restore/u }).first().getAttribute('href'))!;
    assert.ok(restoreHref.startsWith('problem.html?')); await alicePage.goto(`${origin}/${restoreHref}`);
    const requested = alicePage.locator(`[data-account-draft-version="${savedAnnotation.versions[0].id}"]`); await requested.locator('[data-restore-account-draft]').click();
    await alicePage.waitForFunction(text => Array.from(document.querySelectorAll<HTMLTextAreaElement>('[data-research-annotations] textarea'))
      .some(input => input.value === text), annotationText);
    assert.equal(await annotationInput().inputValue(), annotationText);
    assert.ok(await alicePage.evaluate(text => Object.keys(localStorage).some(key => key.startsWith('theoremos:human-draft') && (localStorage.getItem(key) ?? '').includes(text)), newerText));
    assert.ok(await alicePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await alicePage.screenshot({ path: path.join(output, `drafts-${language}-${width}.png`), fullPage: true });
    checks.push({ phase, archivedRestorable: true, localAlternativePreserved: true, fitsViewport: true });
    await alicePage.context().close(); await reviewerPage.context().close(); service.jobs.cancel(owner, run.id);
  }
  assert.equal(prohibited, 0); assert.deepEqual(errors, []); assert.deepEqual(external, []);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', fixtureOnly: true, checks, workers, prohibited, errors, external }, null, 2));
  console.log(JSON.stringify({ status: 'passed', output, checks: checks.length }));
} catch (cause) {
  await active?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => undefined);
  const alerts = await active?.locator('[role=alert]').allTextContents().catch(() => []);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'failed', phase, error: String(cause), url: active?.url(), checks, alerts, workers, prohibited, errors, external }, null, 2)); throw cause;
} finally { await Promise.all(contexts.map(context => context.close())); await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true }); }
