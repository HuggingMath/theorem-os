// Turns the archive written by test:web-cooperative-runtime into the workbench's read-only sample run.
// That run uses the real Docker host, command pipe and Lean checks, with a scripted offline agent in place of a model,
// so the sample needs no API key and the page says so. Usage: bun scripts/build-web-sample.ts [archive.json]
import fs from 'node:fs';
import path from 'node:path';
import { webSampleRunId, webSampleSchema, type WebSampleFile } from '../apps/web/sample';
import { sampleActions } from './web-sample-actions';
import type { StoredWebArchive } from '../apps/web/storage';

const input = path.resolve(process.argv[2] ?? 'out/web-cooperative-smoke/archive.json');
const output = path.resolve('apps/web/sample/run.json');
const archive = JSON.parse(fs.readFileSync(input, 'utf8')) as StoredWebArchive;
if (archive.schema !== 'theorem-os.web-archive.v1' || archive.run.result?.status !== 'evaluated_passed')
  throw new Error(`${input} is not an accepted web archive`);

const from = archive.run.id;
const title = '示例运行：自然数加法';
const task = '证明两个自然数加法定理，保持原题声明不变。根据 Lean 反馈修复候选，并验收完整原题。';
// The scripted agent acts on marker-prefixed instructions and writes a fixed review; the sample shows them as a person would say them.
const readable: [recorded: string, shown: string][] = [
  ['WEB_COOPERATIVE_PROVE_FIRST: use definitional equality and leave the other original target unchanged.',
    '先证 add_zero：n + 0 按定义就等于 n，可以直接用 rfl。另一个定理先不要动。'],
  ['WEB_COOPERATIVE_RELEASE_REVIEW: report the review of this fixed candidate. Final acceptance remains with S3.',
    '请把对这份完整证明的审阅结论交上来。最后是否通过，以独立的 Lean 验收为准。'],
  ['Offline independent reviewer inspected the fixed two-target candidate; only host Lean/S3 checks can accept it.',
    '审阅者看过了两个定理的完整证明，同意提交。最终是否通过，仍以独立的 Lean 验收为准。'],
  // The scripted Lead's plan objectives.
  ['Prove Tutorial.add_zero by definitional equality.', '证明 Tutorial.add_zero：n + 0 按定义就等于 n。'],
  ['Prove Tutorial.zero_add using Nat.zero_add.', '证明 Tutorial.zero_add：可以直接用 Nat.zero_add。'],
];
// Ids, the smoke marker and the container work directory are replaced everywhere, including nested records.
let text = JSON.stringify({ run: archive.run, observations: archive.observations, events: archive.events });
text = text.replaceAll(from, webSampleRunId)
  .replaceAll('WEB_COOPERATIVE_SMOKE\\n', '').replaceAll('WEB_COOPERATIVE_SMOKE', title)
  .replace(/\/work\/run-[A-Za-z0-9]+\//gu, '/workspace/');
for (const [recorded, shown] of readable) text = text.replaceAll(JSON.stringify(recorded).slice(1, -1), JSON.stringify(shown).slice(1, -1));
const data = JSON.parse(text) as Pick<StoredWebArchive, 'run' | 'observations' | 'events'>;
const sample: WebSampleFile = {
  schema: webSampleSchema,
  recordedAt: archive.summary.createdAt,
  run: { ...data.run, id: webSampleRunId, title, task, model: '离线示例 Agent', providerId: 'sample', archives: [] },
  observations: data.observations,
  events: data.events,
};
sample.actions = sampleActions(sample);
sample.run.actions = { count: sample.actions.length };
for (const leak of [/\/home\//u, /\/data\//u, /theorem-os-worker/u, /sha256:/u, /127\.0\.0\.1/u, /host\.docker\.internal/u, /apiKey/u, /WEB_COOPERATIVE_/u, /Lean\/S3/u]) {
  if (leak.test(JSON.stringify(sample))) throw new Error(`sample still contains ${leak}`);
}
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(sample) + '\n');
console.log(`Wrote ${path.relative(process.cwd(), output)} (${sample.observations.length} observations, ${sample.events.length} events, ${(fs.statSync(output).size / 1024).toFixed(0)} KB)`);
