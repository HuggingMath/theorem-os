// Turns the archive written by test:web-cooperative-runtime into the workbench's read-only sample run.
// That run uses the real Docker host, command pipe and Lean checks, with a scripted offline agent in place of a model,
// so the sample needs no API key and the page says so. Usage: bun scripts/build-web-sample.ts [archive.json]
import fs from 'node:fs';
import path from 'node:path';
import { webSampleRunId, webSampleSchema, type WebSampleFile } from '../apps/web/sample';
import type { StoredWebArchive } from '../apps/web/storage';

const input = path.resolve(process.argv[2] ?? 'out/web-cooperative-smoke/archive.json');
const output = path.resolve('apps/web/sample/run.json');
const archive = JSON.parse(fs.readFileSync(input, 'utf8')) as StoredWebArchive;
if (archive.schema !== 'theorem-os.web-archive.v1' || archive.run.result?.status !== 'evaluated_passed')
  throw new Error(`${input} is not an accepted web archive`);

const from = archive.run.id;
const title = '示例运行：自然数加法';
const task = '证明两个自然数加法定理，保持原题声明不变。根据 Lean 反馈修复候选，并验收完整原题。';
// Ids, the smoke marker and the container work directory are replaced everywhere, including nested records.
let text = JSON.stringify({ run: archive.run, observations: archive.observations, events: archive.events });
text = text.replaceAll(from, webSampleRunId)
  .replaceAll('WEB_COOPERATIVE_SMOKE\\n', '').replaceAll('WEB_COOPERATIVE_SMOKE', title)
  .replace(/\/work\/run-[A-Za-z0-9]+\//gu, '/workspace/');
const data = JSON.parse(text) as Pick<StoredWebArchive, 'run' | 'observations' | 'events'>;
const sample: WebSampleFile = {
  schema: webSampleSchema,
  recordedAt: archive.summary.createdAt,
  run: { ...data.run, id: webSampleRunId, title, task, model: '离线示例 Agent', providerId: 'sample', archives: [] },
  observations: data.observations,
  events: data.events,
};
for (const leak of [/\/home\//u, /\/data\//u, /theorem-os-worker/u, /sha256:/u, /127\.0\.0\.1/u, /host\.docker\.internal/u, /apiKey/u]) {
  if (leak.test(JSON.stringify(sample))) throw new Error(`sample still contains ${leak}`);
}
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(sample) + '\n');
console.log(`Wrote ${path.relative(process.cwd(), output)} (${sample.observations.length} observations, ${sample.events.length} events, ${(fs.statSync(output).size / 1024).toFixed(0)} KB)`);
