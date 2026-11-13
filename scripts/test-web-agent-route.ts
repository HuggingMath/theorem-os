#!/usr/bin/env bun
// The Agent route map: each step opens to what the Agent did in it (reasoning, reads, Mathlib searches, Lean checks,
// edits, messages), filtered by kind, walked by keyboard, followed while live, folded when long, and never on a share page.
// Local fixtures only: the sample with synthetic Agent actions, replayed through a runner. No model, no Lean.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { readWebConfig } from '../apps/web/config';
import { createWebService } from '../apps/web/server';
import { sanitizeAgentItem } from '../apps/web/agentActions';
import { loadWebSample } from '../apps/web/sample';
import type { WebRunner } from '../apps/web/runner';
import { webAgentActionLimits, webSampleRunId, type WebRunInput, type WorkerMessage } from '../apps/web/shared';
import { agentRoutes, mergeAgentActions } from '../apps/web/client/agentRoute';
import { audit } from './web-a11y';
import { openTab } from './web-ui-controls';
import { deferred, freePort, postRun, ready, settled, startBrowser, waitForRun } from './web-scenario';
import { longLane, withAgentActions } from './web-agent-action-fixture';
import { replaySample } from './web-trajectory-fixture';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web-agent-route');
await fs.access(path.join(root, 'out/web/app.js')).catch(() => { throw new Error('Run bun run build:web before the route map check.'); });
await fs.mkdir(output, { recursive: true });
const buildOutput = Array.from({ length: 400 }, (_, index) => `✔ [${index + 1}/400] Built Tutorial.Part${index + 1} (${(index % 7) + 1}ms)`.padEnd(Math.ceil(webAgentActionLimits.output / 400) + 32, '.')).join('\n');
assert.ok(Buffer.byteLength(buildOutput) > webAgentActionLimits.output);
const sample = withAgentActions(loadWebSample()!, buildOutput);
const lead = sample.observations.at(-1)!.inspection.workers.find(worker => worker.role === 'lead')?.id;
// Two pauses in the live replay: before the Engineer's second turn starts, and before that turn's Lean check ends.
const turnGate = { reached: deferred(), open: deferred() }, checkGate = { reached: deferred(), open: deferred() };
const gate = (held: typeof turnGate) => { held.reached.resolve(); return held.open.promise; };
const libraryIdentity = { id: 'theorem-os-standard', revision: 'standard-v1', catalogDigest: 'a'.repeat(64), environmentDigest: 'b'.repeat(64) };
const libraryEntry = (name: string, installation = 'not-installed') => ({ name, installation, file: 'Submission/Library/Tutorial.lean',
  import: 'Submission.Library.Tutorial', sourceDigest: 'c'.repeat(64), origin: { file: '/opt/theorem-os/private-library.lean' } });
const runner: WebRunner = {
  async readiness() { return { ready: true, message: '本地路线图验证环境' }; },
  async run(input, send, signal) {
    if (input.input.model === 'fixture-route-library') {
      send({ type: 'progress', event: 'turn_started', message: 'Library tool fixture', details: { workerId: 'solver', turn: 1 } });
      const declaration = libraryEntry('Tutorial.zero_add'), installed = libraryEntry('Tutorial.add_zero', 'installed-frozen');
      const results: [string, object][] = [
        ['search', { schema: 'theorem-os.library-search.v1', library: libraryIdentity, query: 'zero_add', goal: '0 + n = n',
          hits: [declaration, installed], namedReferences: [declaration] }],
        ['get', { schema: 'theorem-os.library-source.v1', library: libraryIdentity, declaration, installation: 'not-installed',
          source: { text: 'library-source-private', offset: 0, nextOffset: 2048, complete: false } }],
        ['get', { schema: 'theorem-os.library-source.v1', library: libraryIdentity, declaration, installation: 'not-installed',
          source: { text: 'library-source-private', offset: 2048, nextOffset: null, complete: true } }],
        ['request', { schema: 'theorem-os.library-request-result.v1', library: libraryIdentity, declarations: [declaration], status: 'queued' }],
        ['request', { schema: 'theorem-os.library-request-result.v1', library: libraryIdentity, declarations: [installed], status: 'already-installed' }],
      ];
      for (const [index, [operation, result]] of results.entries()) {
        const action = sanitizeAgentItem('completed', { id: `library-${index}`, type: 'commandExecution', status: 'completed', exitCode: 0,
          command: `math library ${operation}`, aggregatedOutput: JSON.stringify(result), cwd: '/work/run-fixture/workspace/workers/solver' },
        { workerId: 'solver', worktree: '/work/run-fixture/workspace/workers/solver', hidden: ['/opt/theorem-os', '/work/run-fixture'], apiKey: input.input.apiKey });
        assert.ok(action); send({ type: 'action', action });
      }
      send({ type: 'result', result: { status: 'incomplete', proof: '', report: { turns: 1 } } }); return;
    }
    if (input.input.model === 'fixture-route-long') {
      // One message every few milliseconds, so each keeps its own server time and order.
      for (const message of longLane(30)) { send(message); await new Promise(resolve => setTimeout(resolve, 3)); }
      send({ type: 'result', result: { status: 'incomplete', proof: '', report: { turns: 30 } } }); return;
    }
    await replaySample(sample, input.id, send, signal, { hold: (message: WorkerMessage) => {
      if (message.type === 'progress' && message.event === 'turn_started' && message.details?.workerId === 'engineer' && message.details.turn === 2) return gate(turnGate);
      if (message.type === 'action' && message.action.workerId === 'engineer' && message.action.itemId === '2:c2' && message.action.phase === 'completed') return gate(checkGate);
      return undefined;
    } });
  },
};
const port = await freePort(), origin = `http://127.0.0.1:${port}`;
const service = createWebService(readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_STATIC_ROOT: path.join(root, 'out/web') }), runner, { sample });
const input = (model: string): WebRunInput => ({ providerId: 'openai', apiKey: 'sk-theoremos-route-fixture', model, effort: 'low', environment: 'standard',
  source: sample.run.source, task: sample.run.task, maxTurns: 12, maxRunSeconds: 300, workers: 3, coordination: 'cooperative' });
const mark = (check: string) => console.log(`PASS ${check}`);
const map = '#detail-panel [data-result-route]';
const lane = (page: Page, workerId: string, scope = map) => page.locator(`${scope} .agent-route-lane[data-worker-id="${workerId}"]`);
const chips = (page: Page, workerId: string, scope = map) => lane(page, workerId, scope).locator(':scope > .agent-route-steps [data-route-step]');
const inspector = (page: Page, workerId: string, scope = map) => page.locator(`${scope} #route-inspector-${workerId}`);
const rows = (page: Page, workerId: string) => inspector(page, workerId).locator('.route-item');
const rowKinds = (page: Page, workerId: string) => rows(page, workerId).evaluateAll(items => items.map(item => item.getAttribute('data-kind')));
/** The open row with this title; its body renders only once it is open. */
const openRow = async (page: Page, workerId: string, title: RegExp) => {
  const row = rows(page, workerId).filter({ has: page.locator('.route-item-label', { hasText: title }) }).first();
  if (!await row.locator('details[open]').count()) await row.locator('summary').click();
  await row.locator('.route-item-body').waitFor();
  return row;
};
const focusedStep = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.routeStep ?? '');
const fits = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth
  && [...document.querySelectorAll('.route-inspector, .agent-route-lane')].every(item => item.getBoundingClientRect().right <= innerWidth + 1));
const shot = async (page: Page, name: string, selector: string) => {
  await settled(page);
  await page.locator(selector).first().screenshot({ path: path.join(output, name) });
};

let browser: Awaited<ReturnType<typeof startBrowser>> | undefined;
try {
  browser = await startBrowser(service.server, port);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error' && !/Failed to load resource/u.test(message.text())) errors.push(message.text()); });

  // The finished sample: one lane per Agent, and each step's badge counts the actions in it.
  await page.goto(`${origin}/?sample`);
  await ready(page);
  // A run opens on its chat; the result is in the run panel beside it.
  await openTab(page, 'result');
  await page.locator('.result-agent-actions>summary').click();
  await lane(page, 'researcher-1').waitFor();
  const expected = agentRoutes(sample.events, { actions: mergeAgentActions(sample.actions!), lead });
  assert.deepEqual(await page.locator(`${map} .agent-route-lane`).evaluateAll(items => items.map(item => item.getAttribute('data-worker-id'))),
    expected.map(route => route.workerId));
  for (const route of expected) {
    const counts = await chips(page, route.workerId).evaluateAll(items => items.map(item => Number(item.querySelector('.agent-route-count')?.textContent ?? 0)));
    assert.deepEqual(counts, route.steps.map(step => step.items.filter(item => item.type === 'action').length), `${route.workerId} badges`);
  }
  assert.equal(expected.flatMap(route => route.steps).reduce((sum, step) => sum + step.items.filter(item => item.type === 'action').length, 0), 27);
  assert.match(await lane(page, 'solver').innerText(), /制定计划[\s\S]*制定计划/u, 'the Lead\'s turns read as planning');
  mark('the sample map has one lane per Agent and each step counts the actions in it');

  // A step opens to everything in it, oldest first, with a chip per kind.
  const engineerKeys = await chips(page, 'engineer').evaluateAll(items => items.map(item => (item as HTMLElement).dataset.routeStep!));
  const firstWrite = chips(page, 'engineer').nth(1);
  await firstWrite.click();
  assert.equal(await firstWrite.getAttribute('aria-expanded'), 'true');
  assert.equal(await firstWrite.getAttribute('aria-controls'), 'route-inspector-engineer');
  assert.equal(await inspector(page, 'engineer').locator('h4').innerText(), 'Engineer · 写证明');
  assert.match(await inspector(page, 'engineer').locator('.route-inspector-meta').innerText(), /9 个动作 · 1 条平台记录/u);
  assert.deepEqual(await rowKinds(page, 'engineer'), ['event', 'reasoning', 'command', 'command', 'edit', 'command', 'reasoning', 'edit', 'command', 'message']);
  assert.deepEqual(await inspector(page, 'engineer').locator('.route-filter').evaluateAll(items => items.map(item => (item as HTMLElement).innerText.replace(/\s+/gu, ''))),
    ['全部10', '思考2', '查看1', '修改2', 'Lean3', '说明1', '平台1']);
  await shot(page, '1440-step-open.png', `${map} .agent-route-lane[data-worker-id="engineer"]`);
  mark('a step opens to its reasoning, reads, searches, edits, Lean checks and messages, with a chip per kind');

  // The Lean chip leaves the checks and the search; a failed check shows Lean's error, a search the names it found.
  await inspector(page, 'engineer').locator('.route-filter[data-group="lean"]').click();
  assert.equal(await inspector(page, 'engineer').locator('.route-filter[data-group="lean"]').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(await rowKinds(page, 'engineer'), ['command', 'command', 'command']);
  const outcomes = await rows(page, 'engineer').locator('.route-item-outcome').evaluateAll(items => items.map(item => `${item.getAttribute('data-tone')}:${item.textContent}`));
  assert.deepEqual(outcomes, ['muted:5 条结果', 'failed:1 个错误', 'muted:没有错误，但用了 sorry']);
  const failed = await openRow(page, 'engineer', /^Lean 检查$/u);
  assert.equal(await failed.locator('.route-command').innerText(), 'math check-lean --workspace ./generated/problem --file Submission.lean --timeout-seconds 120');
  assert.equal(await failed.locator('.route-lean li[data-severity="error"] .route-lean-where').innerText(), '错误 · Submission.lean:5:45');
  assert.match(await failed.locator('.route-lean li[data-severity="error"] pre').innerText(), /The rfl tactic failed[\s\S]*⊢ 0 \+ n = n/u);
  const found = await openRow(page, 'engineer', /检索 Mathlib/u);
  assert.deepEqual(await found.locator('.route-found-names code').allInnerTexts(), ['Nat.add_zero', 'Nat.add_zero_iff', 'AddMonoid.add_zero', 'Nat.add_zero', 'add_zero']);
  await shot(page, '1440-lean-filter.png', '#route-inspector-engineer');
  mark('the Lean chip keeps the checks and searches; a failed check shows its error and place, a search its names');

  // The edit chip: each edit is its diff.
  await inspector(page, 'engineer').locator('.route-filter[data-group="edit"]').click();
  assert.deepEqual(await rowKinds(page, 'engineer'), ['edit', 'edit']);
  const edit = await openRow(page, 'engineer', /^修改$/u);
  assert.match(await edit.locator('.route-item-outcome').innerText(), /^\+2 −2$/u);
  const lines = await edit.locator('.route-diff-line').evaluateAll(items => items.map(item => `${item.getAttribute('data-line')}:${item.textContent!.trimEnd()}`));
  assert.ok(lines.includes('del:theorem add_zero (n : Nat) : n + 0 = n := by sorry') && lines.includes('add:theorem zero_add (n : Nat) : 0 + n = n := by rfl'), lines.join('\n'));
  await inspector(page, 'engineer').locator('.route-filter', { hasText: '全部' }).first().click();
  await inspector(page, 'engineer').getByRole('button', { name: '全部展开' }).click();
  assert.equal(await rows(page, 'engineer').locator('details:not([open])').count(), 0);
  await inspector(page, 'engineer').getByRole('button', { name: '全部收起' }).click();
  assert.equal(await rows(page, 'engineer').locator('details[open]').count(), 0);
  mark('the edit chip shows each edit as its diff, and 全部展开 opens every row');

  // Keys: arrows along a lane and across lanes, Home and End, Enter to open, Escape to close back to the step.
  await firstWrite.focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await focusedStep(page), engineerKeys[2]);
  await page.keyboard.press('Enter');
  assert.equal(await inspector(page, 'engineer').locator('h4').innerText(), 'Engineer · Lean 检查');
  assert.match(await inspector(page, 'engineer').innerText(), /这一步是平台的记录，Agent 没有在其中动作。/u);
  await page.keyboard.press('End');
  assert.equal(await focusedStep(page), engineerKeys.at(-1));
  await page.keyboard.press('Home');
  assert.equal(await focusedStep(page), engineerKeys[0]);
  await page.keyboard.press('ArrowDown');
  assert.match(await focusedStep(page), /^researcher-1\|/u);
  await page.keyboard.press('ArrowUp');
  assert.equal(await focusedStep(page), engineerKeys[0]);
  await inspector(page, 'engineer').getByRole('button', { name: '上一步' }).click();
  assert.equal(await inspector(page, 'engineer').locator('h4').innerText(), 'Engineer · 写证明');
  await inspector(page, 'engineer').getByRole('button', { name: '下一步' }).click();
  assert.equal(await inspector(page, 'engineer').locator('h4').innerText(), 'Engineer · Lean 检查');
  await page.keyboard.press('Escape');
  assert.equal(await inspector(page, 'engineer').count(), 0);
  assert.equal(await focusedStep(page), engineerKeys[2], 'closing returns to the step that was open');
  mark('arrow keys, Home and End walk the map; Enter opens a step, the inspector steps back and forth, Escape closes to its chip');

  // The reviewer: a command that read another Agent's files keeps its output back, a long build shows its ends.
  const reviewing = chips(page, 'researcher-1').filter({ hasText: '审阅候选' });
  await reviewing.click();
  assert.equal(await inspector(page, 'engineer').count(), 0, 'one inspector open at a time');
  const withheld = await openRow(page, 'researcher-1', /^运行命令$/u);
  assert.equal(await withheld.locator('.route-command').innerText(), 'cat …');
  assert.match(await withheld.innerText(), /这条命令读到了平台自己的文件，输出不显示。/u);
  assert.equal(await withheld.locator('.route-output').count(), 0);
  const build = await openRow(page, 'researcher-1', /^运行 Lean$/u);
  const log = await build.locator('.route-output').innerText();
  assert.ok(log.includes('[1/400]') && log.includes('[400/400]') && !log.includes('[100/400]'), 'a long output keeps its first and last lines');
  assert.match(await build.innerText(), /输出较长，只显示开头和结尾。/u);
  await inspector(page, 'researcher-1').getByRole('button', { name: '全部展开' }).click();
  const shown = await page.locator('#detail-panel').innerText();
  for (const secret of ['/opt/theorem-os', '/work/run-fixture', '/var/lib', 'sk-action-fixture', '.lake/packages'])
    assert.ok(!shown.includes(secret), `the map shows no ${secret}`);
  const served = await page.evaluate(async id => (await fetch(`/api/runs/${id}/actions?after=0`)).text(), webSampleRunId);
  assert.ok(!/\/opt\/|\/work\/|sk-action|\.lake\/packages/u.test(served), 'the served actions carry no host path or key');
  assert.deepEqual(await audit(page, { scope: map }), [], 'route map accessibility');
  await shot(page, '1440-reviewer.png', '#route-inspector-researcher-1');
  mark('a command that read another Agent\'s files withholds its output, a long build shows its ends, and nothing shows a host path');

  // The collaboration tab draws the same map, with the same step open.
  await openTab(page, 'collaboration');
  const collab = '.collab-agent-route';
  await lane(page, 'researcher-1', collab).waitFor();
  assert.equal(await page.locator(`${collab} .agent-route-lane`).count(), 3);
  assert.equal(await inspector(page, 'researcher-1', collab).locator('h4').innerText(), 'Researcher · 审阅候选');
  await chips(page, 'engineer', collab).nth(1).click();
  assert.equal(await inspector(page, 'engineer', collab).locator('h4').innerText(), 'Engineer · 写证明');
  await openTab(page, 'result');
  await page.locator('.result-agent-actions>summary').click();
  assert.equal(await inspector(page, 'engineer').locator('h4').innerText(), 'Engineer · 写证明', 'the result tab opens the same step');
  mark('the collaboration tab draws the same map and keeps the open step across tabs');

  // A phone: the open step and its diffs fit the screen.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', hasTouch: true, isMobile: true });
  const small = await phone.newPage();
  small.on('pageerror', error => errors.push(`390: ${error.message}`));
  await small.goto(`${origin}/?sample`);
  await ready(small);
  await openTab(small, 'result');
  await small.locator('.result-agent-actions>summary').click();
  await chips(small, 'engineer').nth(1).click();
  await inspector(small, 'engineer').getByRole('button', { name: '全部展开' }).click();
  assert.ok(await fits(small), 'the open step fits a 390 px screen');
  await shot(small, '390-step-open.png', '#route-inspector-engineer');
  await phone.close();
  mark('on a 390 px phone the open step and its diffs fit the screen');

  // A live run: 跟随最新 moves the open step to the Agent's newest one, which fills in while it works.
  const live = await postRun({ page }, input('fixture-route-rich'));
  await turnGate.reached.promise;
  await page.goto(`${origin}/?run=${live.id}`);
  // A running run may hold the submit button back, so only wait for the page to be there.
  await page.locator('#submit-run').waitFor({ state: 'attached' });
  await page.locator('body[data-view="run"] .detail-heading[data-run]').waitFor({ state: 'attached' });
  await openTab(page, 'result');
  await page.locator('.result-agent-actions>summary').click();
  await lane(page, 'engineer').locator('.agent-route-count').first().waitFor();
  const current = lane(page, 'engineer').locator('.agent-route-step[data-current] [data-route-step]');
  assert.match(await current.innerText(), /接任务 zero_add/u);
  await current.click();
  const follow = inspector(page, 'engineer').getByRole('button', { name: '跟随最新' });
  assert.equal(await follow.getAttribute('aria-pressed'), 'true', 'opening a live lane\'s newest step follows it');
  assert.match(await inspector(page, 'engineer').innerText(), /Agent 的动作会在发生时出现在这里。/u);
  turnGate.open.resolve();
  await checkGate.reached.promise;
  await page.waitForFunction(() => document.querySelector('#detail-panel #route-inspector-engineer h4')?.textContent === 'Engineer · 写证明');
  await page.waitForFunction(() => document.querySelectorAll('#detail-panel #route-inspector-engineer .route-item[data-kind="command"]').length === 2);
  assert.equal(await lane(page, 'engineer').locator('.agent-route-now').innerText(), '正在：Lean 检查 Submission.lean');
  assert.equal(await follow.getAttribute('aria-pressed'), 'true');
  assert.deepEqual(await rowKinds(page, 'engineer'), ['event', 'reasoning', 'command', 'edit', 'command']);
  await shot(page, '1440-live-follow.png', `${map} .agent-route-lane[data-worker-id="engineer"]`);
  checkGate.open.resolve();
  await page.waitForFunction(() => /没有错误/u.test(document.querySelector('#detail-panel #route-inspector-engineer')?.textContent ?? ''));
  const finished = await waitForRun({ page }, live.id, run => run.status !== 'running' && run.status !== 'queued', 30_000);
  assert.equal(finished.status, 'completed');
  mark('跟随最新 moves to the Agent\'s new step as it starts, shows what is running, and fills in its actions');

  // A share link shows the proof, never the route or what the Agents did.
  const token = await page.evaluate(async id => {
    const session = await (await fetch('/api/session')).json();
    const response = await fetch(`/api/runs/${id}/share`, { method: 'POST', headers: { 'X-CSRF-Token': session.csrfToken } });
    return (await response.json()).share.url.split('#')[1] as string;
  }, live.id);
  const visitor = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const reader = await visitor.newPage();
  reader.on('pageerror', error => errors.push(`share: ${error.message}`));
  await reader.goto(`${origin}/share.html#${token}`);
  await reader.locator('#share-content:not([hidden])').waitFor();
  assert.equal(await reader.locator('.agent-route, .route-inspector').count(), 0);
  assert.ok(!/先看原题|直接用标准库|search-lean/u.test(await reader.locator('body').innerText()), 'the share page carries no Agent action');
  await visitor.close();
  mark('a share page shows no route and no Agent action');

  // A long lane folds to its newest 24 steps.
  const long = await postRun({ page }, input('fixture-route-long'));
  await waitForRun({ page }, long.id, run => run.status !== 'running' && run.status !== 'queued', 20_000);
  await page.goto(`${origin}/?run=${long.id}`);
  await ready(page);
  await openTab(page, 'result');
  await page.locator('.result-agent-actions>summary').click();
  await lane(page, 'solver').waitFor();
  assert.equal(await chips(page, 'solver').count(), 24);
  await lane(page, 'solver').getByRole('button', { name: '显示更早的 36 步' }).click();
  assert.equal(await chips(page, 'solver').count(), 60);
  assert.match(await chips(page, 'solver').first().innerText(), /写证明\s*1/u);
  await lane(page, 'solver').getByRole('button', { name: '收起更早的步骤' }).click();
  assert.equal(await chips(page, 'solver').count(), 24);
  assert.match(await chips(page, 'solver').last().innerText(), /Lean 检查\s*通过/u);
  await shot(page, '1440-long-lane.png', `${map} .agent-route-lane[data-worker-id="solver"]`);
  mark('a lane of 60 steps shows its newest 24 and opens the earlier 36 on request');

  // Library tools report what they returned, separately from the proof's Lean checks and actual references.
  const libraryRun = await postRun({ page }, input('fixture-route-library'));
  await waitForRun({ page }, libraryRun.id, run => run.status !== 'running' && run.status !== 'queued', 20_000);
  await page.goto(`${origin}/?run=${libraryRun.id}`); await ready(page); await openTab(page, 'result');
  await page.locator('.result-agent-actions>summary').click(); await lane(page, 'solver').waitFor();
  await chips(page, 'solver').last().click();
  await inspector(page, 'solver').getByRole('button', { name: '全部展开' }).click();
  const libraryCards = page.locator(`${map} [data-library-operation]`);
  assert.equal(await libraryCards.count(), 5);
  assert.deepEqual(await rows(page, 'solver').locator('.route-item-label').allInnerTexts(),
    ['Library tool fixture', '搜索定理库', '读取库源码', '读取库源码', '请求装入库声明', '请求装入库声明']);
  assert.deepEqual(await rows(page, 'solver').locator('.route-item-outcome').allInnerTexts(),
    ['2 个候选', '还有后续页', '已到文件末尾', '请求已排队', '已冻结装入']);
  assert.equal(await rows(page, 'solver').locator('.route-item-outcome[data-tone="passed"]').count(), 0);
  const search = libraryCards.filter({ has: page.locator('[data-library-identity]') }).first();
  assert.deepEqual(await search.locator('[data-library-identity] code').allInnerTexts(), [libraryIdentity.id, libraryIdentity.revision]);
  assert.ok((await search.innerText()).includes(libraryIdentity.catalogDigest));
  assert.match(await search.innerText(), /Tutorial.zero_add\s+未装入[\s\S]*Tutorial.add_zero\s+已冻结装入/u);
  assert.match(await libraryCards.nth(1).innerText(), /源码偏移 0；下一页从 2048 开始。/u);
  assert.match(await libraryCards.nth(2).innerText(), /源码偏移 2048；已到文件末尾。/u);
  assert.match(await libraryCards.nth(3).innerText(), /请求已排队，等待校验并在后续轮次装入。/u);
  assert.match(await libraryCards.nth(4).innerText(), /请求的声明已冻结装入。/u);
  const libraryServed = await page.evaluate(async id => (await fetch(`/api/runs/${id}/actions?after=0`)).text(), libraryRun.id);
  assert.ok(!/library-source-private|private-library|\/opt\/|\/work\//u.test(libraryServed), 'library activities carry no source text or host origin');
  await inspector(page, 'solver').locator('.route-filter[data-group="look"]').click();
  assert.equal(await rows(page, 'solver').count(), 3, 'library search and source reads belong to 查看');
  await inspector(page, 'solver').locator('.route-filter[data-group="run"]').click();
  assert.equal(await rows(page, 'solver').count(), 2, 'installation requests belong to 命令');
  await inspector(page, 'solver').locator('.route-filter', { hasText: '全部' }).first().click();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 }); await settled(page);
    assert.ok(await fits(page), `library activities fit a ${width}px screen`);
  }
  await shot(page, '320-library-tools.png', '#route-inspector-solver');
  mark('library searches, source pages and installation requests show bounded tool reports with no proof acceptance or source leakage');

  assert.deepEqual(errors, [], 'no page errors');
  console.log(`agent route checks passed; screenshots in ${path.relative(root, output)}`);
} finally {
  turnGate.open.resolve(); checkGate.open.resolve();
  await browser?.close(); await service.close();
}
