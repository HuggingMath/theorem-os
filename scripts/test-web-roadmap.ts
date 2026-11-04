#!/usr/bin/env bun
// Recorded fixtures only. Exercise the default graph and its links to real version feedback, without a model or Lean.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import { loadWebSample } from '../apps/web/sample';
import type { WebRunner } from '../apps/web/runner';
import type { WebRunInput, WorkerMessage } from '../apps/web/shared';
import { audit } from './web-a11y';
import { freePort, postRun, settled, startBrowser, waitForRun } from './web-scenario';
import { openTab, selectHistoryRun } from './web-ui-controls';
import { replaySample, withFailedAttempt } from './web-trajectory-fixture';

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'out/web-roadmap');
await fs.mkdir(output, { recursive: true });
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const recording = withFailedAttempt(loadWebSample()!);
const gate = () => {
  let arrive = () => {}, release = () => {};
  const reached = new Promise<void>(resolve => { arrive = resolve; }), open = new Promise<void>(resolve => { release = resolve; });
  return { arrive, release, reached, open };
};
const beforeFailure = gate(), beforePass = gate(), beforeIntegration = gate();
const hold = (message: WorkerMessage) => {
  if (message.type !== 'progress' || message.details?.taskId !== 'goal_2') return;
  const held = message.event === 'task_checked' ? message.details.passed ? beforePass : beforeFailure
    : message.event === 'task_integrated' ? beforeIntegration : undefined;
  held?.arrive(); return held?.open;
};
const runner: WebRunner = { async readiness() { return { ready: true, message: '本地路线图验证环境' }; },
  run: (input, send, signal) => replaySample(recording, input.id, send, signal, { hold }) };
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web') }), runner, { sample: recording });
const browser = await startBrowser(service.server, port);
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', locale: 'zh-CN' });
const page = await context.newPage(), errors: string[] = [], writes: string[] = [];
page.setDefaultTimeout(10_000);
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => { if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/runs')) writes.push(request.url()); });
const map = () => page.locator('.research-roadmap');
const node = (id: string) => page.locator(`[data-roadmap-node="${id}"]`);
const shot = async (name: string) => { await page.locator('#detail-panel').evaluate(element => { element.scrollTop = 0; });
  await settled(page); await page.screenshot({ path: path.join(output, name) }); };
const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth
  && document.querySelector('.research-roadmap')!.getBoundingClientRect().right <= innerWidth + 1);
try {
  await page.route(/\/api\/runs\/[^/]+\/trajectory(?:\?|$)/u,
    route => route.fulfill({ status: 503, json: { error: 'Recorded read failure' } }), { times: 1 });
  await page.goto(`${origin}/?sample`); await page.locator('#research-conversation-panel').waitFor();
  await page.locator('[data-research-artifact="roadmap"]').click();
  await openTab(page, 'result');
  await page.locator('[data-result-roadmap] .trajectory-error').getByRole('button', { name: '重试', exact: true }).click();
  await page.locator('[data-result-roadmap] [data-roadmap-node="evaluation"]').waitFor();
  assert.equal(await page.locator('[data-result-roadmap] [data-trajectory-view]').count(), 0, 'retry keeps the result overview and its node navigation');
  assert.equal(await page.locator('.result-agent-actions').getAttribute('open'), null, 'the result opens with the visual map and folded action details');
  await shot('roadmap-result-entry.png');
  await page.locator('[data-result-roadmap] [data-roadmap-node="task:goal_2"]').click();
  await page.locator('#detail-panel[data-tab="trajectory"]').waitFor();
  assert.equal(await node('task:goal_2').getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: '关闭节点详情', exact: true }).click();
  await node('evaluation').waitFor();
  assert.equal(await page.locator('[data-trajectory-view="roadmap"]').getAttribute('aria-pressed'), 'true');
  assert.equal(await map().locator('output').innerText(), '100%', 'the graph starts at readable size instead of shrinking to fit');
  assert.equal(await page.locator('.trajectory-steps').count(), 0, 'the first view is a graph, without a text history');
  assert.equal(await page.locator('[data-node-kind="task"]').count(), 2);
  assert.equal(await node('evaluation').getAttribute('data-status'), 'passed');
  assert.match(await node('task:goal_2').locator('.roadmap-node-type').innerText(), /0 \+ n = n/u, 'the proposition is visible on the node');
  assert.match(await node('task:goal_2').innerText(), /原始目标/u);
  assert.match(await node('task:goal_2').locator('strong').innerText(), /Tutorial\.zero_add/u, 'the full theorem name is shown');
  assert.ok((await node('task:goal_2').boundingBox())!.width >= 300, 'task cards have room for their mathematical content');
  assert.ok(await node('task:goal_2').locator('.roadmap-node-type').evaluate(element => parseFloat(getComputedStyle(element).fontSize)) >= 14);
  assert.ok(await page.locator('.roadmap-connectors>path[data-edge-kind="assignment"]').count() > 0);
  assert.ok(await page.locator('.roadmap-connectors>path[data-edge-kind="guidance"][data-active=true]').count() > 0);
  assert.deepEqual(await node('task:goal_2').locator('.roadmap-attempt').evaluateAll(items => items.map(item => item.getAttribute('data-outcome'))), ['failed', 'passed']);
  assert.deepEqual(await audit(page, { scope: '#detail-panel' }), [], 'the graph is accessible');
  await shot('roadmap-desktop.png');
  await map().getByRole('button', { name: '展开画布', exact: true }).click();
  await page.locator('.roadmap-dialog[open]').waitFor();
  assert.ok(await page.locator('.roadmap-dialog').evaluate(element => element.matches(':modal')));
  assert.ok((await map().boundingBox())!.width > 1400, 'the expanded graph uses the full screen');
  assert.equal(await map().locator('output').innerText(), '100%', 'expanding preserves readable size');
  assert.deepEqual(await audit(page, { scope: '.roadmap-dialog[open]' }), [], 'expanded canvas is accessible');
  await shot('roadmap-expanded.png');
  await page.keyboard.press('Escape');
  await page.locator('.roadmap-dialog[open]').waitFor({ state: 'detached' });
  assert.equal(await map().getByRole('button', { name: '展开画布', exact: true }).evaluate(element => element === document.activeElement), true);
  console.log('PASS the graph is the default; assignments, delivered guidance, failed retry and acceptance come from the recording');

  await node('task:goal_2').click();
  await page.locator('.roadmap-detail').waitFor();
  assert.match(await page.locator('.roadmap-detail-summary').innerText(), /0 \+ n = n/u, 'the selected task keeps its full proposition');
  assert.match(await page.locator('.roadmap-detail-summary').innerText(), /可以直接用 Nat\.zero_add/u, 'the task objective remains available in the detail reader');
  assert.equal(await page.locator('.roadmap-detail .trajectory-step[data-kind="attempt"]').count(), 2);
  await page.locator('.roadmap-detail .trajectory-step[data-tone="failed"] [data-trajectory-mode="feedback"]').click();
  await page.locator('#trajectory-viewer[open]').waitFor();
  assert.match(await page.locator('#trajectory-viewer').innerText(), /rfl/u);
  await shot('roadmap-check-feedback.png');
  await page.keyboard.press('Escape');
  await page.locator('#trajectory-viewer').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.roadmap-detail [data-action="guide-task"]').count(), 0, 'the recorded sample offers read-only actions');
  await page.locator('.roadmap-detail [data-action="inspect-task"]').click();
  await page.locator('[data-inspected-task-heading]').waitFor();
  assert.match(await page.locator('.collab-inspector').innerText(), /goal_2/u, 'the node opens its own task');
  await openTab(page, 'trajectory');
  assert.equal(await node('task:goal_2').getAttribute('aria-pressed'), 'true');
  await page.locator('.roadmap-detail [data-action="show-statement-review"]').click();
  await page.locator('[data-review-task]').waitFor();
  assert.equal(await page.locator('[data-review-task]').inputValue(), 'goal_2');
  assert.match(await page.locator('[data-review-list]').innerText(), /任务 goal_2 尚无已保存的声明审阅/u);
  const palette = async (query: string) => {
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
    await page.locator('#command-palette[open] input').fill(query);
  };
  for (const [query, command, target] of [['原意', 'run-statement-review', '[data-review-task]'], ['知识', 'run-knowledge', '.collab-knowledge'],
    ['归档', 'run-records', '[data-collab-records]'], ['指导', 'run-guidance-history', '[data-collab-guidance-records]']]) {
    await palette(query!); await page.locator(`#palette-${command}`).click();
    assert.equal(await page.locator(target!).isVisible(), true, `${query} opens its collaboration section`);
  }
  assert.equal(await page.locator('[data-review-task]').inputValue(), '', 'the global review command clears the task filter');
  await palette('自然语言');
  const [explanation] = await Promise.all([context.waitForEvent('page'), page.locator('#palette-run-explanation').click()]);
  assert.equal(new URL(explanation.url()).pathname, '/explain.html');
  assert.equal(new URL(explanation.url()).searchParams.get('run'), recording.run.id);
  await explanation.close();
  await palette('形式化');
  const [languageGuide] = await Promise.all([context.waitForEvent('page'), page.locator('#palette-open-language-guide').click()]);
  await languageGuide.locator('#language-heading').waitFor();
  assert.equal(new URL(languageGuide.url()).hash, '#language');
  await languageGuide.close();
  await openTab(page, 'trajectory');
  await shot('roadmap-task-actions.png');
  console.log('PASS nodes open the matching task and statement review; search reaches explanation, knowledge, archives and guidance');
  await page.getByRole('button', { name: '关闭节点详情', exact: true }).click();
  await node('plan').focus(); await page.keyboard.press('ArrowRight');
  assert.match(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.roadmapNode ?? ''), /^task:/u);
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('[data-node-kind="task"][aria-pressed=true]').count(), 1);
  await page.getByRole('button', { name: '关闭节点详情', exact: true }).click();
  const before = await map().locator('output').innerText();
  await map().getByRole('button', { name: '放大', exact: true }).click();
  assert.notEqual(await map().locator('output').innerText(), before);
  await map().getByRole('button', { name: '适应画布', exact: true }).click();
  console.log('PASS nodes open the saved failed check; keyboard navigation and zoom work');

  await page.locator('#expand-research-output').click();
  assert.equal(await page.locator('#research-conversation-panel').isVisible(), false);
  assert.ok((await page.locator('#runs-panel').boundingBox())!.width > 1000, 'expanded output gives the map and source their full workspace');

  await node('task:goal_1').click();
  await page.locator('[data-trajectory-view="steps"]').click();
  await page.locator('.trajectory-step[data-kind="evaluation"]').waitFor();
  await openTab(page, 'result'); await openTab(page, 'trajectory');
  assert.equal(await page.locator('[data-trajectory-view="steps"]').getAttribute('aria-pressed'), 'true');
  const proof = page.locator('.trajectory-step[data-kind="proof"]');
  if (await proof.getAttribute('data-open') === 'false') await proof.locator('.trajectory-fold').click();
  await proof.locator('[data-trajectory-mode="code"]').click();
  await page.locator('#trajectory-viewer[open]').waitFor();
  await page.locator('[data-trajectory-view="roadmap"]').click(); await node('evaluation').waitFor();
  assert.equal(await node('task:goal_1').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#trajectory-viewer').count(), 0, 'switching modes closes an unrelated source panel');
  await page.getByRole('button', { name: '关闭节点详情', exact: true }).click();
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await shot('roadmap-dark.png');
  assert.deepEqual(await audit(page, { scope: '#detail-panel' }), [], 'the dark graph is accessible');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.setViewportSize({ width: 375, height: 850 });
  await node('evaluation').waitFor();
  assert.ok(await fits(), 'the map scrolls inside its frame on mobile');
  assert.ok(await node('problem').evaluate(element => {
    const viewport = element.closest('.roadmap-viewport')!.getBoundingClientRect(), box = element.getBoundingClientRect();
    return box.top >= viewport.top && box.bottom <= viewport.bottom && box.left >= viewport.left && box.right <= viewport.right;
  }), 'the original problem is visible when the mobile roadmap opens');
  await shot('roadmap-mobile.png');
  const viewport = page.locator('.roadmap-viewport');
  await viewport.evaluate(element => { element.scrollLeft = 100; });
  const area = (await viewport.boundingBox())!;
  await page.mouse.move(area.x + 170, area.y + 12); await page.mouse.down();
  await page.mouse.move(area.x + 65, area.y + 12, { steps: 8 }); await page.mouse.up();
  assert.ok(await viewport.evaluate(element => element.scrollLeft) > 150, 'dragging the canvas pans the map');
  await map().getByRole('button', { name: '适应画布', exact: true }).click();
  assert.ok(await fits());
  assert.deepEqual(errors, []); assert.deepEqual(writes, []);
  console.log('PASS graph/detail preference survives tab changes; mobile panning, both themes, and read-only interaction work');

  await page.setViewportSize({ width: 1440, height: 1000 });
  const input: WebRunInput = { providerId: 'openai', apiKey: 'sk-theoremos-roadmap-fixture', model: 'fixture-roadmap-model',
    effort: 'low', environment: 'standard', source: recording.run.source, task: recording.run.task,
    maxTurns: 12, maxRunSeconds: 300, workers: 3, coordination: 'cooperative' };
  const run = await postRun({ page }, input, 'Recorded roadmap');
  await selectHistoryRun(page, run.id, 'trajectory');
  await beforeFailure.reached;
  await node('task:goal_2').waitFor();
  assert.equal(await node('evaluation').getAttribute('data-status'), 'pending');
  await node('task:goal_2').click();
  await page.locator('.roadmap-detail [data-action="guide-task"]').click();
  await page.locator('[data-guidance-text]').waitFor();
  assert.equal(await page.locator('[data-guidance-kind]').inputValue(), 'task');
  assert.equal(await page.locator('[data-guidance-target]').inputValue(), 'goal_2');
  assert.equal(await page.locator('[data-guidance-text]').inputValue(), '', 'opening guidance does not send or invent a message');
  await openTab(page, 'trajectory');
  await map().getByRole('button', { name: '放大', exact: true }).click();
  const liveZoom = await map().locator('output').innerText();
  beforeFailure.release(); await beforePass.reached;
  await node('task:goal_2').locator('.roadmap-attempt[data-outcome="failed"]').waitFor();
  assert.equal(await node('task:goal_2').getAttribute('aria-pressed'), 'true');
  assert.equal(await map().locator('output').innerText(), liveZoom, 'live updates preserve the chosen zoom');
  assert.equal(await node('evaluation').getAttribute('data-status'), 'pending');
  await shot('roadmap-live-failed.png');
  beforePass.release(); await beforeIntegration.reached;
  await node('task:goal_2').locator('.roadmap-attempt[data-outcome="passed"]').waitFor();
  const integration = page.locator('.roadmap-connectors>path[data-edge-kind="integration"]').last();
  assert.equal(await integration.getAttribute('data-active'), 'false', 'a local pass does not claim integration');
  assert.equal(await node('evaluation').getAttribute('data-status'), 'pending');
  beforeIntegration.release();
  await waitForRun({ page }, run.id, run => run.status === 'completed');
  await page.waitForFunction(() => document.querySelector('[data-roadmap-node="evaluation"]')?.getAttribute('data-status') === 'passed');
  assert.deepEqual(await node('task:goal_2').locator('.roadmap-attempt').evaluateAll(items => items.map(item => item.getAttribute('data-outcome'))), ['failed', 'passed']);
  assert.equal(await integration.getAttribute('data-active'), 'true');
  assert.equal(await node('task:goal_2').getAttribute('aria-pressed'), 'true');
  assert.equal(await map().locator('output').innerText(), liveZoom);
  await shot('roadmap-live-completed.png');
  assert.deepEqual(errors, []);
  assert.equal(writes.length, 1, 'only the explicit local replay creates a run');
  console.log('PASS recorded live work updates failed → passed → integrated → accepted, preserving selection and zoom');
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', paidModelCalls: false,
    checks: ['default graph', 'recorded branches and hint', 'failed retry', 'independent acceptance', 'saved check feedback', 'keyboard', 'zoom',
      'readable default size', 'theorem names and propositions', 'expanded canvas and keyboard close', 'view memory', 'source panel cleanup',
      'dark theme', 'mobile panning', 'read-only browsing', 'task and statement review navigation', 'task guidance draft', 'feature command search',
      'recorded live progression', 'live selection and zoom'], errors }, null, 2) + '\n');
} catch (error) { await shot('failure.png').catch(() => {}); throw error; }
finally { beforeFailure.release(); beforePass.release(); beforeIntegration.release();
  await context.close(); await browser.close(); await new Promise<void>(resolve => service.server.close(() => resolve())); }
