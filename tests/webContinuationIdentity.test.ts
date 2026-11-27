import { afterEach, describe, expect, it } from 'vitest';
import { createWebService } from '../apps/web/server';
import { readWebConfig } from '../apps/web/config';
import { WebJobs } from '../apps/web/jobs';
import { loadWebSample } from '../apps/web/sample';
import type { WebRunner } from '../apps/web/runner';
import type { WebContinuation, WebRun, WorkerInput } from '../apps/web/shared';
import { freePort } from '../scripts/web-scenario';

const closing: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(closing.splice(0).map(close => close())); });
describe('web continuation frozen source identity', () => {
  it('freezes the actually selected saved source without changing request replay or the worker input', async () => {
    const calls: WorkerInput[] = [], port = await freePort(), origin = `http://127.0.0.1:${port}`;
    const runner: WebRunner = { async readiness() { return { ready: true, nativeTeam: true, message: 'Offline fixture' }; },
      async run(input, send) { calls.push(structuredClone(input)); send({ type: 'result', result: { status: 'limit_reached', proof: '', report: {} } }); } };
    const config = readWebConfig({ THEOREMOS_WEB_PORT: String(port), THEOREMOS_WEB_PUBLIC_URL: origin });
    const service = createWebService(config, runner, { sample: null }); closing.push(() => service.close());
    await new Promise<void>(resolve => service.server.listen(port, '127.0.0.1', resolve));
    const sessionResponse = await fetch(origin + '/api/session'), cookie = sessionResponse.headers.get('set-cookie')!.split(';')[0];
    const session = await sessionResponse.json(), owner = cookie.slice('theoremos_session='.length), provider = config.providers[0];
    const post = (body: unknown) => fetch(origin + '/api/runs', { method: 'POST', headers: { Cookie: cookie, 'X-CSRF-Token': session.csrfToken,
      'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const sample = loadWebSample()!, input = { providerId: provider.id, apiKey: 'sk-offline-continuation', model: 'fixture-model', effort: 'high' as const,
      source: sample.run.source.trim(), task: 'Offline parent', maxTurns: 2, maxRunSeconds: 60, maxTotalTokens: 0, workers: 2, coordination: 'cooperative' as const,
      environment: sample.run.environment };
    const parent = service.jobs.create(owner, input, provider);
    await new Promise<void>(resolve => setImmediate(resolve));
    const observation = structuredClone(sample.observations.at(-1)!);
    observation.webRunId = parent.id;
    const target = observation.sources.find(source => observation.checks.some(check => check.taskId === source.taskId &&
      check.taskVersion === source.taskVersion && check.commit === source.commit && check.record.passed === true))!;
    const receipt = observation.checks.find(check => check.taskId === target.taskId && check.taskVersion === target.taskVersion &&
      check.commit === target.commit && check.record.passed === true)!;
    const earlierRevision = 'earlier-task-version-at-the-same-commit';
    service.storage.saveObservation(owner, { ...observation, sequence: 1,
      sources: [{ ...target, taskVersion: earlierRevision, file: 'Earlier.lean', source: '-- earlier revision\n' }],
      checks: [{ ...receipt, id: 'earlier-failed-check', taskVersion: earlierRevision,
        record: { ...receipt.record, proofPath: 'Earlier.lean', passed: false, status: 'failed' } }] });
    service.storage.saveObservation(owner, { ...observation, sequence: 2, sources: [], checks: [receipt] });
    parent.observation = { ...observation, sequence: 3, sources: [target], checks: [] };
    service.storage.saveRun(owner, parent);
    const query = await fetch(`${origin}/api/runs/${parent.id}/trajectory`, { headers: { Cookie: cookie } });
    expect(query.status).toBe(200);
    const { trajectory } = await query.json();
    const matching = trajectory.versions.find((item: { taskId: string; commit: string }) => item.taskId === target.taskId && item.commit === target.commit);
    expect(matching.checks).toMatchObject([{ taskVersion: earlierRevision, passed: false }, { taskVersion: target.taskVersion, passed: true }]);
    const detail = async (taskVersion?: string) => {
      const params = new URLSearchParams({ task: target.taskId, commit: target.commit, ...(taskVersion ? { taskVersion } : {}) });
      const response = await fetch(`${origin}/api/runs/${parent.id}/trajectory/version?${params}`, { headers: { Cookie: cookie } });
      expect(response.status).toBe(200);
      return (await response.json()).version;
    };
    expect(await detail()).toMatchObject({ source: { taskVersion: earlierRevision }, checks: [{ id: 'earlier-failed-check' }, { id: receipt.id }] });
    expect(await detail(target.taskVersion)).toMatchObject({ source: target, checks: [{ id: receipt.id }] });
    expect(await detail(earlierRevision)).toMatchObject({ source: { file: 'Earlier.lean' }, checks: [{ id: 'earlier-failed-check' }] });
    const from: WebContinuation = { runId: parent.id, taskId: target.taskId, commit: target.commit, label: 'Saved version',
      taskVersion: matching.checks.find((check: { passed: boolean }) => check.passed).taskVersion };
    const expected = { ...from, sourceDigest: target.sourceDigest, environmentDigest: target.environmentDigest, file: target.file };
    const continuedInput = { ...input, workers: 1, coordination: 'independent' as const, task: 'Continued offline', continueFrom: from };
    const body = { ...continuedInput, requestId: 'freeze-source-once' };
    const response = await post(body); expect(response.status).toBe(201);
    const continued = (await response.json()).run as WebRun;
    expect(continued.continueFrom).toEqual(expected); expect(continued.continueFrom).not.toHaveProperty('source');
    expect(service.storage.getRun(owner, continued.id)?.continueFrom).toEqual(expected);
    expect(body.continueFrom).toEqual(from);
    await new Promise<void>(resolve => setImmediate(resolve));
    const worker = calls.find(call => call.id === continued.id)!;
    expect(worker.input.nativeTeamCapacity).toBe(3);
    expect(worker.input.continueFrom).toEqual(from);
    expect(worker.continuation).toEqual({ ...expected, source: target.source });
    const { taskVersion: _taskVersion, ...legacyFrom } = from;
    const legacy = service.jobs.create(owner, { ...input, task: 'Legacy continuation', continueFrom: legacyFrom }, provider);
    await new Promise<void>(resolve => setImmediate(resolve));
    const journeyResponse = await fetch(`${origin}/api/research/workspace/problem/${continued.id}/journey`, { headers: { Cookie: cookie } });
    expect(journeyResponse.status).toBe(200);
    const journey = (await journeyResponse.json()).item;
    expect(journey.lineage.find((edge: { toRunId: string }) => edge.toRunId === continued.id)).toMatchObject({ status: 'recorded',
      source: { runId: from.runId, taskId: from.taskId, commit: from.commit, taskVersion: target.taskVersion,
        sourceDigest: target.sourceDigest, environmentDigest: target.environmentDigest, file: target.file } });
    expect(journey.lineage.find((edge: { toRunId: string }) => edge.toRunId === legacy.id)).toMatchObject({ status: 'ambiguous' });
    const replay = await post(body); expect(replay.status).toBe(200); expect((await replay.json()).run.id).toBe(continued.id);
    expect(calls.filter(call => call.id === continued.id)).toHaveLength(1);
    const wrong = await post({ ...body, requestId: 'forged-identity', continueFrom: { ...from, taskVersion: 'not-the-selected-version' } });
    expect(wrong.status).toBe(409);
    const restart = new WebJobs(runner, { concurrency: 1, queueLimit: 8 }, { storage: service.storage }); closing.push(() => restart.close());
    expect(restart.replay(owner, continuedInput, provider, body.requestId)?.id).toBe(continued.id);
    expect(restart.get(owner, continued.id)?.continueFrom).toEqual(expected);
  });
});
