#!/usr/bin/env bun
// A focused public/member entry check. The disposable runner never invokes a model or Lean.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import type { WebRunner } from '../apps/web/runner';
import type { ResearchProjectDetail } from '../apps/web/researchProjectTypes';
import { freePort, startBrowser } from './web-scenario';

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'out/product-continuity/collaboration-entry-permissions');
await fs.access(path.join(root, 'out/web/research.js')); await fs.mkdir(output, { recursive: true });
const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-collaboration-entry-'));
const errors: string[] = [], external: string[] = [], mail: unknown[] = [], finishers: (() => void)[] = [], checks: object[] = [];
const source = 'theorem collaboration_entry_fixture : True := by sorry\n';
const runner: WebRunner = {
  async readiness() { return { ready: true, message: 'Disposable entry-permission check' }; },
  async run(_input, _send, signal) { await new Promise<void>(resolve => { finishers.push(resolve); signal.addEventListener('abort', () => resolve(), { once: true }); }); },
  async check() { throw new Error('This check must not invoke Lean'); },
  async command() { throw new Error('This check must not dispatch solver commands'); },
};
const port = await freePort(), origin = 'http://127.0.0.1:' + port;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web'), THEOREMOS_WEB_DATA_ROOT: dataRoot }), runner,
{ sample: null, mailer: async message => { mail.push(message); throw new Error('No mail allowed'); } });
const browser = await startBrowser(service.server, port), contexts = await Promise.all([0, 1, 2].map(() => browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })));
for (const context of contexts) {
  context.on('page', page => { page.setDefaultTimeout(12000); page.on('pageerror', error => errors.push(error.message)); });
  await context.route(/^https?:\/\//u, async route => { if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); await route.abort(); } else await route.continue(); });
}
const pages = await Promise.all(contexts.map(context => context.newPage())), [owner, member, visitor] = pages;
async function http<T>(page: Page, method: string, pathname: string, input?: unknown): Promise<T> {
  return page.evaluate(async ({ method, pathname, input }) => {
    const session = await (await fetch('/api/session')).json();
    const response = await fetch(pathname, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const body = await response.json(); if (!response.ok) throw new Error(`Fixture HTTP ${response.status}: ${body.error}`); return body;
  }, { method, pathname, input }) as Promise<T>;
}
try {
  await Promise.all(pages.map(page => page.goto(origin + '/theorems.html')));
  await Promise.all(pages.map(page => page.locator('main[aria-busy="false"]').waitFor()));
  const researcher = await http<{ researcherId: string }>(member, 'GET', '/api/research/session');
  let project = (await http<{ item: ResearchProjectDetail }>(owner, 'POST', '/api/research/theorems', { requestId: crypto.randomUUID(), title: '公开入口授权', visibility: 'public' })).item;
  const projectPath = '/api/research/theorems/' + project.id;
  project = (await http<{ item: ResearchProjectDetail }>(owner, 'POST', projectPath + '/versions', { requestId: crypto.randomUUID(), expectedRevision: project.revision, statement: 'Prove True', source, environment: 'standard' })).item;
  const run = (await http<{ run: { id: string } }>(owner, 'POST', '/api/runs', { requestId: crypto.randomUUID(), providerId: 'openai', apiKey: 'sk-disposable-entry-check', model: 'fixture', effort: 'low', environment: 'standard', source, task: 'Check entry permissions', maxTurns: 1, maxRunSeconds: 600, workers: 1, coordination: 'cooperative' })).run;
  project = (await http<{ item: ResearchProjectDetail }>(owner, 'POST', projectPath + '/runs', { requestId: crypto.randomUUID(), expectedRevision: project.revision, statementVersionId: project.currentStatementVersionId, runId: run.id, exposure: 'public' })).item;
  project = (await http<{ item: ResearchProjectDetail }>(owner, 'PUT', projectPath + '/members/' + researcher.researcherId, { requestId: crypto.randomUUID(), expectedRevision: project.revision, role: 'reader' })).item;
  const href = `${origin}/theorems.html?id=${project.id}&run=${run.id}&version=${project.currentStatementVersionId}`;
  for (const [index, page] of pages.entries()) {
    await page.goto(href); await page.locator('.research-run-tools').waitFor();
    const projected = (await http<{ item: ResearchProjectDetail }>(page, 'GET', projectPath)).item;
    assert.equal(projected.runs[0].permissions.read, true, 'All three actors can read the public run summary');
    const expected = index === 2 ? 0 : 1;
    for (const [label, tab] of [['研究简报', 'brief'], ['用量', 'usage']]) {
      const link = page.locator('.research-run-tools').getByRole('link', { name: label, exact: true });
      assert.equal(await link.count(), expected, `${['owner', 'reader-member', 'public-outsider'][index]} ${tab} entry`);
      if (expected) {
        const url = new URL((await link.getAttribute('href'))!, origin);
        assert.equal(url.searchParams.get('tab'), tab); assert.equal(url.searchParams.get('project'), project.id); assert.equal(url.searchParams.get('run'), run.id);
      }
    }
    checks.push({ actor: ['owner', 'reader-member', 'public-outsider'][index], member: projected.permissions.member, publicSummaryReadable: true, briefEntry: Boolean(expected), usageEntry: Boolean(expected) });
  }
  // The public visitor can still open the theorem; the member controls remain intact on a narrow screen.
  await member.setViewportSize({ width: 390, height: 844 }); assert.equal(await member.locator('.research-run-tools').getByRole('link', { name: '研究简报', exact: true }).isVisible(), true);
  await member.screenshot({ path: path.join(output, 'member-390.png'), fullPage: true });
  await visitor.screenshot({ path: path.join(output, 'public-outsider.png'), fullPage: true });
  assert.deepEqual(errors, []); assert.deepEqual(external, []); assert.deepEqual(mail, []);
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', checks, realModels: 0, realLean: 0, externalMail: 0, productionTouched: false, errors }, null, 2) + '\n');
  console.log(JSON.stringify({ status: 'passed', scenarios: checks.length, output }));
} catch (error) {
  await fs.writeFile(path.join(output, 'failure.json'), JSON.stringify({ error: String(error), checks, errors, external }, null, 2) + '\n'); throw error;
} finally {
  for (const finish of finishers) finish(); await Promise.all(contexts.map(context => context.close())); await browser.close(); await service.close(); await fs.rm(dataRoot, { recursive: true, force: true });
}
