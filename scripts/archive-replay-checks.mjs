import assert from 'node:assert/strict';

const stages = ['candidate', 'feedback', 'repair', 'verified'];
const state = page => page.locator('.replay-window').evaluate(node => ({
  current: node.dataset.replayCurrent, playing: node.dataset.replayPlaying, state: node.dataset.replayState,
}));
const progress = page => page.locator('.replay-progress-fill').evaluate(node =>
  new DOMMatrixReadOnly(getComputedStyle(node).transform).a);
const tick = (page, milliseconds) => page.clock.runFor(milliseconds);

async function assertStage(page, current, playing = false) {
  assert.equal((await state(page)).current, current);
  assert.equal((await state(page)).playing, String(playing));
  assert.equal(await page.locator(`#demo-${current}`).getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator(`#demo-${current}`).getAttribute('tabindex'), '0');
  assert.equal(await page.locator(`#stage-${current}`).isVisible(), true);
  assert.equal(await page.locator('[data-replay-stage][aria-selected="true"]').count(), 1);
  assert.equal(await page.locator('[id^="stage-"][role="tabpanel"]:visible').count(), 1);
  assert.equal(await page.locator('#replay-play').getAttribute('aria-pressed'), String(playing));
  assert.equal(await page.locator('#replay-progress').getAttribute('aria-valuenow'), String(stages.indexOf(current) + 1));
  assert.equal(await page.locator('#replay-step-number').innerText(), `0${stages.indexOf(current) + 1} / 04`);
}

async function advanceUntil(page, predicate, description) {
  for (let elapsed = 0; elapsed <= 10000; elapsed += 250) {
    if (predicate(await state(page))) return;
    await tick(page, 250);
  }
  assert.fail(`Replay did not ${description}: ${JSON.stringify(await state(page))}`);
}

async function showReplay(page) {
  await page.locator('.replay-toolbar').evaluate(node => node.scrollIntoView({ behavior: 'instant', block: 'center' }));
  await tick(page, 300);
}

async function assertReceipt(page, archiveUrl, english, evidence) {
  assert.equal(evidence.source, 'preset-replay');
  assert.equal(evidence.modelInvoked, false);
  assert.equal(evidence.official, false);
  assert.equal(evidence.status, 'evaluated_passed');
  assert.match(await page.locator('.receipt-status').innerText(), /evaluated_passed/);
  const expected = new URL(`${english ? '../' : ''}assets/replay.json`, archiveUrl).href;
  assert.equal(await page.locator('.receipt-evidence').evaluate(node => node.href), expected);
  const disclosure = page.locator('.receipt-details');
  const wasOpen = await disclosure.getAttribute('open') !== null;
  if (!wasOpen) await disclosure.locator('summary').click();
  for (const target of evidence.targets) {
    assert.equal(target.status, 'kernel_verified');
    assert.equal(target.sorryCount, 0);
    assert.ok((await page.locator('.receipt-targets').innerText()).includes(target.theorem));
  }
  if (!wasOpen) await disclosure.locator('summary').click();
  if (/^https?:/u.test(expected)) {
    const response = await page.request.get(expected, { timeout: 0 });
    assert.equal(response.status(), 200, 'The served replay receipt must be available at the local asset path');
    assert.deepEqual(await response.json(), evidence, 'The served raw receipt must match the recorded replay');
  }
  return expected;
}

async function assertLayout(page, label) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label}: horizontal overflow`);
  const controls = page.locator('.replay-playback button, [data-replay-stage]');
  for (const control of await controls.all()) {
    const bounds = await control.boundingBox();
    assert.ok(bounds && bounds.width >= 44 && bounds.height >= 44 && bounds.x >= 0 &&
      bounds.x + bounds.width <= page.viewportSize().width + 1, `${label}: replay controls need visible 44px touch targets`);
    assert.ok((await control.getAttribute('aria-label') ?? await control.innerText()).trim(), `${label}: replay controls need accessible names`);
  }
}

/** Run on a fresh page: its controlled animation clock never affects the caller's main scenario.
 * @param {import('playwright').Page} page
 * @param {string} archiveUrl
 * @param {{ english?: boolean, evidence: any, label?: string }} options
 */
export async function checkArchiveReplay(page, archiveUrl, { english = false, evidence, label = 'archive replay' }) {
  const start = new Date('2026-10-17T04:00:00Z');
  await page.clock.install({ time: start });
  // Installation advances the clock slightly; pause in the future before any application is loaded.
  await page.clock.pauseAt(new Date(start.getTime() + 10_000));
  const initial = new URL(archiveUrl);
  const params = new URLSearchParams(initial.hash.slice(1));
  params.delete('view');
  initial.hash = params.toString();
  await page.goto(initial.href);
  await page.locator('.proof-row.is-selected').waitFor({ state: 'attached' });
  await tick(page, 600);
  const selected = await page.locator('.proof-row.is-selected').getAttribute('data-proof-id');
  const archiveHash = new URLSearchParams(new URL(page.url()).hash.slice(1));
  assert.equal(await page.locator('#quickstart-view').isVisible(), false, 'The player must initialize while its archive view is hidden');
  await tick(page, 6000);
  assert.deepEqual(await state(page), { current: 'verified', playing: 'false', state: 'paused' });

  const requests = [];
  const track = request => {
    if (['fetch', 'xhr'].includes(request.resourceType()) || /\/api\//u.test(new URL(request.url()).pathname) ||
      !['GET', 'HEAD'].includes(request.method())) requests.push({ method: request.method(), url: request.url() });
  };
  page.on('request', track);
  let receipt;
  try {
    await page.locator('[data-view-link="quickstart"]').click();
    assert.equal(await page.locator('#quickstart-view').isVisible(), true);
    await showReplay(page);
    await assertStage(page, 'verified');
    assert.equal(await page.locator('.replay-playback').isVisible(), true);
    assert.equal(await page.locator('.replay-badge').innerText(), english ? 'Proof replay' : '证明回放');
    receipt = await assertReceipt(page, archiveUrl, english, evidence);
    await showReplay(page);
    await assertLayout(page, label);

    const contents = {};
    for (const id of stages) {
      await page.locator(`#demo-${id}`).click();
      await tick(page, 300);
      await assertStage(page, id);
      assert.equal(await page.locator(`#demo-${id}`).evaluate(node => node === document.activeElement), true);
      contents[id] = await page.locator(`#stage-${id}`).innerText();
    }
    assert.equal(new Set(Object.values(contents)).size, 4, 'The four stages must display different code, diagnostics or verification context');
    assert.match(contents.candidate, /0 \+ n = n := by rfl/u);
    assert.match(contents.feedback, /n : Nat/u);
    assert.match(contents.feedback, /0 \+ n = n/u);
    assert.match(contents.repair, /exact Nat.zero_add n/u);
    assert.match(contents.verified, /exact Nat.zero_add n/u);
    await page.locator('#demo-verified').focus();
    for (const [key, id] of [['ArrowRight', 'candidate'], ['End', 'verified'], ['Home', 'candidate']]) {
      await page.keyboard.press(key);
      await assertStage(page, id);
      assert.equal(await page.locator(`#demo-${id}`).evaluate(node => node === document.activeElement), true);
    }
    await page.locator('#demo-repair').focus();
    await page.keyboard.press('Space');
    await assertStage(page, 'repair');
    await page.locator('#replay-prev').click();
    await assertStage(page, 'feedback');
    await page.locator('#replay-next').click();
    await assertStage(page, 'repair');

    await showReplay(page);
    await page.locator('#replay-play').click();
    await assertStage(page, 'candidate', true);
    assert.equal(await page.locator('#replay-play').evaluate(node => node === document.activeElement), true);
    await tick(page, 1000);
    await page.locator('#replay-play').click();
    await assertStage(page, 'candidate');
    const pausedProgress = await progress(page);
    await tick(page, 6000);
    await assertStage(page, 'candidate');
    assert.ok(Math.abs(await progress(page) - pausedProgress) < .001, 'Paused progress must not move');
    await page.locator('#replay-play').click();
    await advanceUntil(page, value => value.current === 'feedback', 'advance after resuming');
    await assertStage(page, 'feedback', true);
    await page.locator('#demo-repair').click();
    await assertStage(page, 'repair');
    await tick(page, 5000);
    await assertStage(page, 'repair');

    await showReplay(page);
    await page.locator('#replay-restart').click();
    await assertStage(page, 'candidate', true);
    for (const id of ['feedback', 'repair', 'verified']) {
      await advanceUntil(page, value => value.current === id, `play through ${id}`);
      await assertStage(page, id, true);
    }
    await advanceUntil(page, value => value.state === 'complete', 'finish playback');
    await assertStage(page, 'verified');
    assert.equal(await page.locator('#replay-next').isDisabled(), true);
    assert.ok(Math.abs(await progress(page) - 1) < .001, 'The completed replay fills its progress indicator');

    await page.locator('#replay-restart').click();
    await assertStage(page, 'candidate', true);
    await tick(page, 500);
    await page.locator('[data-view-link="archive"]').click();
    await tick(page, 300);
    const hidden = await state(page), hiddenProgress = await progress(page);
    assert.equal(hidden.playing, 'false', 'Changing archive views pauses the hidden player');
    await tick(page, 6000);
    assert.deepEqual(await state(page), hidden);
    assert.ok(Math.abs(await progress(page) - hiddenProgress) < .001);
    await page.goBack();
    await showReplay(page);
    assert.deepEqual(await state(page), hidden, 'History returns to the same paused stage without auto-resuming');
    await page.goBack();
    assert.equal(await page.locator('#archive-view').isVisible(), true);
    assert.equal(await page.locator('.proof-row.is-selected').getAttribute('data-proof-id'), selected);
    const restored = new URLSearchParams(new URL(page.url()).hash.slice(1));
    for (const key of ['proof', 'status', 'tab', 'q', 'sort']) assert.equal(restored.get(key), archiveHash.get(key), `Back preserves ${key}`);

    const direct = new URL(initial.href), directParams = new URLSearchParams(direct.hash.slice(1));
    directParams.set('view', 'quickstart');
    direct.hash = directParams.toString();
    // Enter from another document: changing only this page's hash preserves the paused replay by design.
    await page.goto('about:blank');
    await page.goto(direct.href);
    await showReplay(page);
    await assertStage(page, 'verified');
    await page.reload();
    await showReplay(page);
    await assertStage(page, 'verified');
    await assertLayout(page, `${label}: reloaded direct link`);
  } finally {
    page.off('request', track);
    await page.clock.resume();
  }
  assert.deepEqual(requests, [], `${label}: playback must not call a model, fetch data or submit a run`);
  console.log(`Replay ${label}: four real stages, playback/pause/restart, keyboard, history, direct reload and zero API/write requests.`);
  return { label, stages, receipt, interactionRequests: requests.length };
}

/** @param {import('playwright').Page} page
 * @param {string} archiveUrl
 * @param {{ english?: boolean, evidence: any, label?: string }} options
 */
export async function checkStaticArchiveReceipt(page, archiveUrl, { english = false, evidence, label = 'no-script archive replay' }) {
  await page.goto(archiveUrl);
  await page.evaluate(() => document.fonts.ready);
  assert.equal(await page.locator('#quickstart-view').isVisible(), true);
  assert.equal(await page.locator('#stage-verified').isVisible(), true);
  assert.match(await page.locator('#stage-verified').innerText(), /exact Nat.zero_add n/u);
  assert.equal(await page.locator('.replay-playback').isVisible(), false, `${label}: hide playback without JavaScript`);
  assert.equal(await page.locator('.replay-tabs').isVisible(), false, `${label}: hide inactive stage tabs without JavaScript`);
  assert.ok(await page.locator('[data-replay-stage]').evaluateAll(buttons => buttons.length === 4 && buttons.every(button => button.disabled)));
  const receipt = await assertReceipt(page, archiveUrl, english, evidence);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label}: no-script receipt must fit`);
  return { label, receipt, staticVerifiedReadable: true };
}
