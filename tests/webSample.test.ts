import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadWebSample, webSampleResponse, webSampleRunId } from '../apps/web/sample';

const file = new URL('../apps/web/sample/run.json', import.meta.url);

describe('web sample run', () => {
  it('ships an accepted, self-consistent recording with no host details', () => {
    const sample = loadWebSample(file)!;
    expect(sample).toBeDefined();
    expect(sample.run).toMatchObject({ id: webSampleRunId, status: 'completed', result: { status: 'evaluated_passed' }, archives: [] });
    expect(sample.observations.length).toBeGreaterThan(0);
    expect(sample.observations.every(observation => observation.webRunId === webSampleRunId)).toBe(true);
    expect(sample.events.map(event => event.sequence)).toEqual([...sample.events.map(event => event.sequence)].sort((a, b) => a - b));
    const text = fs.readFileSync(file, 'utf8');
    for (const leak of ['/home/', '/data/', 'theorem-os-worker', 'sha256:', '127.0.0.1', 'host.docker.internal', 'apiKey', 'WEB_COOPERATIVE_', 'Lean/S3'])
      expect(text, leak).not.toContain(leak);
  });

  it('rejects a file with another schema or run id instead of serving it', () => {
    const dir = fs.mkdtempSync(new URL('../out/web-sample-test-', import.meta.url).pathname);
    try {
      const sample = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.writeFileSync(`${dir}/schema.json`, JSON.stringify({ ...sample, schema: 'other' }));
      fs.writeFileSync(`${dir}/id.json`, JSON.stringify({ ...sample, run: { ...sample.run, id: 'other' } }));
      fs.writeFileSync(`${dir}/broken.json`, '{');
      for (const name of ['schema', 'id', 'broken', 'missing']) expect(loadWebSample(new URL(`file://${dir}/${name}.json`))).toBeUndefined();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('pages events by cursor and refuses an invalid one', () => {
    const sample = loadWebSample(file)!;
    const last = sample.events.at(-1)!.sequence;
    const page = webSampleResponse(sample, 'events', 'GET', new URLSearchParams({ after: String(last - 1) })).body as { events: unknown[]; lastSequence: number };
    expect(page.events).toHaveLength(1);
    expect(page.lastSequence).toBe(last);
    expect(webSampleResponse(sample, 'events', 'GET', new URLSearchParams({ after: '-1' })).status).toBe(400);
    expect(webSampleResponse(sample, 'tasks/nope/source', 'GET', new URLSearchParams()).status).toBe(404);
    expect(webSampleResponse(sample, 'checks/nope', 'GET', new URLSearchParams()).status).toBe(404);
  });
});
