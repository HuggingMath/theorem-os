#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import { webResearchArguments } from '../apps/web/researchMode';
import type { WebRunner } from '../apps/web/runner';
import type { WorkerInput } from '../apps/web/shared';
import { freePort, ready, startBrowser } from './web-scenario';
import { enterLean, fillConfig, showChat, withSettings } from './web-ui-controls';

const port = await freePort(), origin = 'http://127.0.0.1:' + port;
const output = process.env.THEOREMOS_TEST_OUTPUT ?? 'out/web-native-team';
const config = readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin,
  THEOREMOS_WEB_DATA_ROOT: await fs.mkdtemp(path.join(os.tmpdir(), 'web-native-team-')),
  THEOREMOS_WEB_STATIC_ROOT: process.env.THEOREMOS_FRONTEND_TEST_STATIC_ROOT ?? 'out/web' });
config.providers = [{ id: 'offline', name: 'Offline fixture', baseUrl: 'http://127.0.0.1:1/v1' }];
const started: WorkerInput[] = [];
let nativeTeam = true, nativeTeamPreferences = true, nativeTeamExpertCards = true;
const runner: WebRunner = {
  async readiness() { return { ready: true, nativeTeam, nativeTeamPreferences, nativeTeamExpertCards, message: 'Offline fixture' }; },
  async run(request, send) {
    started.push(request);
    send({ type: 'result', result: { status: 'incomplete', proof: '', report: { reason: 'offline_fixture' } } });
  },
};
const service = createWebService(config, runner);
if (process.argv.includes('--serve')) {
  service.server.listen(port, '127.0.0.1'); await once(service.server, 'listening');
  console.log(origin); // Offline fixture; no credentials from an external provider are needed.
  await Promise.race([once(process, 'SIGINT'), once(process, 'SIGTERM')]);
  await service.close(); await fs.rm(config.dataRoot!, { recursive: true, force: true });
} else {
  const browser = await startBrowser(service.server, port);
  try {
    await fs.mkdir(output, { recursive: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    await page.goto(origin); await ready(page); await enterLean(page);
    const owner = (await page.context().cookies(origin)).find(c => c.name === 'theoremos_session')!.value;
    const assets = service.research.assets;
    const saved = assets.create(owner, { type: 'agent', requestId: 'expert-fixture', name: 'Valuation expert',
      description: 'Discrete valuations normalize a uniformizer to one.', content: { model: 'old-model', workers: 2 } });
    const preview = await assets.preview(owner, saved.id), release = await assets.publish(owner, saved.id, {
      expectedRevision: saved.revision, requestId: 'publish-expert', previewDigest: preview.previewDigest,
      version: 'v1', license: 'MIT', visibility: 'private' });
    assert.equal((await assets.waitForPublication(owner, release.id)).status, 'completed');
    await fillConfig(page, 'source', 'theorem original : True := by sorry');
    await page.locator('#task').fill('Prove original.');
    await withSettings(page, async () => {
      await page.locator('#provider').selectOption('offline');
      await page.locator('#research-mode').selectOption('native-team');
      const capacity = page.locator('#native-team-capacity');
      assert.equal(await capacity.inputValue(), '3');
      assert.deepEqual(await capacity.locator('option').allTextContents(), ['2', '3', '4', '5', '6', '7', '8']);
      await capacity.selectOption('8');
      await page.locator('#model').fill('fixture');
      const experts = page.locator('#native-team-personal-experts'); await experts.locator('summary').click();
      const chosen = page.waitForResponse(r => r.url().endsWith('/api/research/configuration') && r.request().method() === 'POST');
      await experts.getByLabel(/Valuation expert/u).click();
      const fixed = await chosen; assert.equal(fixed.status(), 200, await fixed.text());
      await page.waitForFunction(() => document.querySelector('.composer-research-selection')?.textContent?.includes('Valuation expert'));
      assert.equal(await page.locator('#model').inputValue(), 'fixture');
      const picker = page.locator('#native-team-profiles');
      await picker.locator('summary').click();
      await picker.locator('input[type=search]').fill('engineer');
      await picker.locator('input[value=engineer]').check();
      await picker.locator('input[type=search]').fill('D011');
      assert.equal(await picker.locator('input[value=engineer]').count(), 0);
      await picker.locator('input[value=D011]').check();
      await picker.locator('input[type=search]').fill('D012');
      await picker.locator('input[value=D012]').check();
      await picker.locator('input[value=D012]').uncheck();
      await picker.locator('input[type=search]').fill('D011');
      assert.match(await picker.locator('summary').innerText(), /工程师|Engineer/u);
      assert.equal(await page.locator('fieldset.coordination').isVisible(), false);
      assert.equal(await page.locator('#workers').isDisabled(), true);
      await page.locator('#settings-execution').scrollIntoViewIfNeeded();
      await page.locator('#settings-execution').screenshot({ path: path.join(output, 'team-settings.png') });
    });
    await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('theorem-os.web-draft.v1') ?? '{}').draft?.nativeTeamPreferredProfiles?.join(',') === 'D011,engineer');
    await page.reload(); await ready(page); await enterLean(page);
    await withSettings(page, async () => {
      assert.equal(await page.locator('#research-mode').inputValue(), 'native-team');
      assert.equal(await page.locator('#native-team-capacity').inputValue(), '8');
      assert.equal(await page.locator('#model').inputValue(), 'fixture');
      const experts = page.locator('#native-team-personal-experts'); await experts.locator('summary').click();
      assert.equal(await experts.getByLabel(/Valuation expert/u).isChecked(), true);
      const picker = page.locator('#native-team-profiles');
      await picker.locator('summary').click();
      await picker.locator('input[value=D013]').waitFor();
      assert.equal(await picker.locator('input[value=engineer]').isChecked(), true);
      assert.equal(await picker.locator('input[value=D011]').isChecked(), true);
      await page.locator('#research-mode').selectOption('skill');
      await page.waitForFunction(() => !JSON.parse(sessionStorage.getItem('theorem-os.web-draft.v1') ?? '{}').draft?.nativeTeamPreferredProfiles);
      await page.locator('#research-mode').selectOption('native-team');
      await page.locator('#model').fill('fixture'); await page.locator('#api-key').fill('offline-fixture-key');
    });
    await showChat(page);
    const posting = page.waitForResponse(response => response.url().endsWith('/api/runs') && response.request().method() === 'POST');
    await page.locator('#submit-run').click(); const response = await posting;
    assert.equal(response.status(), 201, await response.text());
    const { run } = await response.json();
    assert.equal(run.nativeTeamCapacity, 8); assert.equal(started.length, 1);
    assert.deepEqual(run.nativeTeamPreferredProfiles, ['D011', 'engineer']);
    const request = started[0]!, args = webResearchArguments(request.input, request.provider);
    assert.equal(request.input.model, 'fixture');
    assert.deepEqual(request.researchConfiguration?.personalExpertSelection?.agent,
      { assetId: saved.id, version: 'v1', digest: assets.release(owner, saved.id, 'v1').digest });
    assert.equal(request.researchConfiguration?.personalExperts?.[0]?.name, saved.name);
    assert.match(request.researchConfiguration!.personalExperts![0]!.knowledge, /uniformizer/);
    assert.equal(request.input.coordination, 'independent'); assert.equal(request.input.workers, 1);
    assert.deepEqual(args, ['--research-mode', 'skill', '--skill-loading', 'native', '--skill-delegation', 'team', '--skill-max-agents', '8',
      '--skill-preferred-profiles', 'D011,engineer']);
    const { requestId: _replay, ...newSubmission } = response.request().postDataJSON();
    const resubmit = (nativeTeamCapacity: number, preferences: string[] = ['engineer']) => page.evaluate(async body => {
      const session = await (await fetch('/api/session')).json();
      return (await fetch('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
        body: JSON.stringify(body) })).status;
    }, { ...newSubmission, nativeTeamCapacity, nativeTeamPreferredProfiles: preferences });
    const overCapacity = await resubmit(9); assert.equal(overCapacity, 400);
    assert.equal(await resubmit(8, ['lead']), 400);
    nativeTeamExpertCards = false;
    assert.equal(await resubmit(8), 503);
    nativeTeamExpertCards = true;
    nativeTeamPreferences = false;
    assert.equal(await resubmit(8), 503);
    assert.equal(await resubmit(8, []), 201);
    nativeTeam = false;
    const refused = await resubmit(8);
    assert.equal(refused, 503); assert.equal(started.length, 2);
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', capacity: run.nativeTeamCapacity,
      hostWorkers: run.workers, frozenCoordination: run.coordination, args, personalExpert: saved.name,
      personalExpertVersion: 'v1', oldExpertImageStatus: 503, overCapacityStatus: overCapacity, oldImageStatus: refused, modelRequests: 0 }, null, 2));
  } finally { await browser.close(); await service.close(); await fs.rm(config.dataRoot!, { recursive: true, force: true }); }
}
