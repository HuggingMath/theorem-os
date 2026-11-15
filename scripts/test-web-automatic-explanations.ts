#!/usr/bin/env bun
// Disposable loopback service, synthetic evidence and real Chromium. No model, Lean or solver process.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { WebExplanationLanguage, WorkerExplanationInput, WorkerExplanationMessage } from '../apps/web/shared';
import { localeStorageKey } from '../apps/web/i18n';
import { webExplanationEvidence } from '../tests/helpers/webExplanationFixture';
import { freePort, postRun, settled, startBrowser } from './web-scenario';
import { clickWorkbenchAction, closeSettings, enterLean, openChatParticipation, openChatResultDetails } from './web-ui-controls';

const root = path.resolve(import.meta.dirname, '..');
const output = path.resolve(process.env.THEOREMOS_TEST_OUTPUT ?? path.join(root, 'out/web-automatic-explanations'));
await fs.access(path.join(root, 'out/web/app.js'));
await fs.mkdir(output, { recursive: true });
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-automatic-explanations-'));
const targets = ['automatic_first', 'automatic_second'];
const declarations = targets.map(target => `theorem ${target} : True := by exact True.intro`);
const proof = declarations.join('\n\n') + '\n';
const source = targets.map(target => `theorem ${target} : True := by sorry`).join('\n\n') + '\n';
const credential = 'sk-disposable-automatic-explanation-fixture';
type Pending = { input: WorkerExplanationInput; send(message: WorkerExplanationMessage): void; resolve(): void };
const pending: Pending[] = [];
let runCalls = 0, formalizationCalls = 0;
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Disposable automatic explanation browser fixture' }; },
  async run(_input, send) {
    runCalls++;
    send({ type: 'result', result: { status: 'evaluated_passed', proof, report: { fixture: true } } });
  },
  async formalize() { formalizationCalls++; throw new Error('Payload checks must not start formalization'); },
  explain(input, send, signal) {
    send({ type: 'progress', progress: { phase: 'writing', batches: 1, approvedBatches: 0 } });
    return new Promise<void>(resolve => {
      pending.push({ input, send, resolve });
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  },
};
function approve(job: Pending) {
  const { input } = job;
  job.send({ type: 'result', status: 'approved', evidence: webExplanationEvidence({ proof, target: input.target,
    environment: input.environment, language: input.language, units: [{ name: input.target, kind: 'theorem',
      snippet: declarations[targets.indexOf(input.target)]!, statement: `${input.language}: statement of ${input.target}.`,
      texts: [`${input.language}: automatically saved explanation of ${input.target}.`] }] }) });
  job.resolve();
}
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: path.join(temporary, 'data'),
  THEOREMOS_WEB_CLIENT_IP_HEADER: 'x-automatic-explanation-fixture' }), runner, { sample: null });
const checks: string[] = [], errors: string[] = [], requests: { method: string; pathname: string }[] = [], external: string[] = [];
const screenshots: string[] = [];
let browser: Browser | undefined, currentPage: Page | undefined, failure: unknown;
async function until(check: () => boolean | Promise<boolean>, description: string) {
  for (const started = Date.now(); Date.now() - started < 15_000;) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out: ${description}`);
}
async function open(language: WebExplanationLanguage, width = 1440): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser!.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce',
    extraHTTPHeaders: { 'x-automatic-explanation-fixture': crypto.randomUUID() } });
  await context.addInitScript(([key, value, fixtureOrigin]) => {
    if (location.origin === fixtureOrigin) localStorage.setItem(key, value);
  }, [localeStorageKey, language, origin]);
  await context.route(/^https?:\/\//u, async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { external.push(url.href); await route.abort(); return; }
    requests.push({ method: request.method(), pathname: url.pathname });
    await route.continue();
  });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const page = await context.newPage(); currentPage = page;
  page.setDefaultTimeout(20_000); page.setDefaultNavigationTimeout(30_000);
  return { context, page };
}
async function shot(page: Page, filename: string) {
  await settled(page);
  await page.screenshot({ path: path.join(output, filename), fullPage: true }); screenshots.push(filename);
}
const mark = (name: string) => { checks.push(name); console.log(`PASS ${name}`); };

try {
  browser = await startBrowser(service.server, port);
  for (const [language, width] of [['zh', 1440], ['en', 390]] as const) {
    const { page, context } = await open(language, width);
    try {
      await page.goto(`${origin}/?lang=${language}`);
      const offset = pending.length;
      const run = await postRun({ page }, { providerId: 'sub2api', apiKey: credential, model: 'deepseek-flash', effort: 'high',
        environment: 'standard', source, task: 'Synthetic automatic explanation fixture', autoExplain: true, explanationLanguage: language,
        maxTurns: 1, maxRunSeconds: 60, workers: 1, coordination: 'cooperative' });
      await until(() => pending.length === offset + 1, 'the accepted proof starts automatic explanation');
      assert.equal(pending[offset]!.input.target, targets[0]);
      assert.equal(pending[offset]!.input.language, language);
      await page.goto(`${origin}/?run=${run.id}&lang=${language}`);
      await page.locator('[data-chat-answer-status="running"]').waitFor();
      await page.locator('[data-chat-answer-select]').selectOption(targets[1]!);
      await page.locator('[data-chat-answer-status="queued"]').waitFor();
      assert.equal(await page.locator('[data-chat-answer-document]').count(), 0);
      await shot(page, `queued-${language}-${width}.png`);
      await page.locator('[data-chat-answer-select]').selectOption(targets[0]!);
      approve(pending[offset]!);
      await page.locator(`[data-chat-answer-document="${targets[0]}"]`).waitFor();
      assert.ok((await page.locator('[data-chat-answer-derivation]').innerText()).includes(`${language}: automatically saved explanation`));
      await until(() => pending.length === offset + 2, 'the second target starts after the first');
      await page.locator('[data-chat-answer-select]').selectOption(targets[1]!);
      await page.locator('[data-chat-answer-status="running"]').waitFor();
      approve(pending[offset + 1]!);
      await page.locator(`[data-chat-answer-document="${targets[1]}"]`).waitFor();
      await shot(page, `approved-${language}-${width}.png`);
      await openChatResultDetails(page);
      const href = await page.locator('[data-chat-explain]').getAttribute('href');
      const address = new URL(href!, origin);
      assert.equal(address.searchParams.get('language'), language);
      assert.equal(address.searchParams.get('target'), targets[1]);
      const [reader] = await Promise.all([page.waitForEvent('popup'), page.locator('[data-chat-explain]').click()]);
      await reader.locator('.explain-document').waitFor();
      assert.ok((await reader.locator('.explain-document').innerText()).includes(`${language}: automatically saved explanation of ${targets[1]}`));
      await reader.close();
      if (language === 'zh') {
        await page.goto(`${origin}/?run=${run.id}&lang=en`);
        await page.locator('[data-chat-answer-document]').waitFor();
        assert.ok((await page.locator('[data-chat-answer-derivation]').innerText()).includes('zh: automatically saved explanation'));
        assert.equal(new URL((await page.locator('[data-chat-explain]').getAttribute('href'))!, origin).searchParams.get('language'), 'zh');
      }
      mark(`${language}/${width}: automatic queued→running→approved, both targets, saved-language reader and chat fallback`);
    } catch (error) { await shot(page, `failure-${language}-${width}.png`); throw error; }
    finally { await context.close(); }
  }

  for (const mode of ['chat', 'lean', 'formalize'] as const) {
    const { page, context } = await open('en');
    const payloads: Record<string, any>[] = [];
    const pathname = mode === 'lean' ? '/api/runs' : '/api/formalizations';
    await page.route(`${origin}${pathname}`, async route => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      payloads.push(route.request().postDataJSON());
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Disposable uncertain-submission checkpoint' }) });
    });
    try {
      const address = mode === 'formalize' ? '/formalize.html' : '/';
      await page.goto(`${origin}${address}?lang=en`);
      const prepare = async (initial: boolean) => {
        if (mode === 'lean') {
          await page.waitForFunction(() => ['natural', 'lean'].includes(document.body.dataset.entry ?? ''));
          await enterLean(page);
          await closeSettings(page);
          if (initial) { await page.locator('#source').fill(source); await page.locator('#task').fill('Synthetic replay fixture'); }
          if (!await page.locator('#run-settings[open]').count()) await clickWorkbenchAction(page, '#open-settings');
          await page.locator('#provider').selectOption('sub2api');
          await page.locator('#model').fill('deepseek-flash'); await page.locator('#api-key').fill(credential);
          await closeSettings(page);
        } else {
          await page.locator('#formalize-original').waitFor();
          if (initial) await page.locator('#formalize-original').fill('Disposable statement for checking request replay.');
          if (mode === 'chat') {
            await openChatParticipation(page);
            await page.locator('input[name="chat-participation"][value="automatic"]').check();
          } else await page.locator('#formalize-settings').evaluate(node => { (node as HTMLDetailsElement).open = true; });
          await page.locator('#formalize-key').fill(credential);
        }
      };
      const submit = mode === 'lean' ? '#submit-run' : '#formalize-start';
      await prepare(true); await page.locator(`${submit}:enabled`).click();
      await until(() => payloads.length === 1, `${mode} first request`);
      await until(() => page.locator(`${submit}:enabled`).count().then(Boolean), `${mode} uncertain submission is editable`);
      assert.equal(payloads[0]!.autoExplain, true); assert.equal(payloads[0]!.explanationLanguage, 'en');
      assert.ok(payloads[0]!.requestId);
      await page.goto(`${origin}${address}?lang=zh`);
      await prepare(false); await page.locator(`${submit}:enabled`).click();
      await until(() => payloads.length === 2, `${mode} replay after refresh`);
      assert.equal(payloads[1]!.requestId, payloads[0]!.requestId);
      assert.equal(payloads[1]!.autoExplain, true); assert.equal(payloads[1]!.explanationLanguage, 'en');
      mark(`${mode}: new requests record the interface language, refresh in another language retains settings and request identity`);
    } catch (error) { await shot(page, `failure-${mode}.png`); throw error; }
    finally { await context.close(); }
  }
  assert.equal(runCalls, 2); assert.equal(formalizationCalls, 0);
  assert.deepEqual(external, []); assert.deepEqual(errors, []);
  assert.equal(requests.some(request => request.method === 'POST' && /\/explanations$/u.test(request.pathname)), false);
  assert.equal(requests.some(request => /^\/(?:classics|data\/classics)(?:[/.]|$)/u.test(request.pathname)), false);
  mark('reading and automatic completion use no generation POST, static classic catalog, external service, model or Lean call');
} catch (error) {
  failure = error;
  await currentPage?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  console.error(error);
} finally {
  await browser?.close(); await service.close(); await fs.rm(temporary, { recursive: true, force: true });
  const report = { status: failure ? 'failed' : 'passed', mode: 'disposable-fake-runner-real-chromium', paidModelCalls: false,
    leanCalls: false, checks, screenshots, runCalls, formalizationCalls,
    ...(failure ? { error: failure instanceof Error ? failure.stack : String(failure) } : {}) };
  assert.equal(JSON.stringify(report).includes(credential), false);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
if (failure) process.exitCode = 1;
