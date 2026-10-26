import fs from 'node:fs';
import type { WebObservation } from './collaboration';
import { webSampleRunId, type WebEvent, type WebRun } from './shared';

export { webSampleRunId };

/** A recorded, accepted run every visitor can open without an API key. It is read-only and never counts as one of theirs. */
export const webSampleSchema = 'theorem-os.web-sample.v1';
export type WebSampleFile = { schema: typeof webSampleSchema; recordedAt: string; run: WebRun; observations: WebObservation[]; events: WebEvent[] };
export type WebSampleResponse = { status: number; body: unknown; filename?: string };

const readOnly: WebSampleResponse = { status: 403, body: { error: '示例运行只读。新建研究后可以提交指导、编辑计划和归档。' } };

/** A missing or malformed file disables the sample; the workbench then hides its entry. */
export function loadWebSample(file = new URL('./sample/run.json', import.meta.url)): WebSampleFile | undefined {
  try {
    const sample = JSON.parse(fs.readFileSync(file, 'utf8')) as WebSampleFile;
    return sample.schema === webSampleSchema && sample.run?.id === webSampleRunId ? sample : undefined;
  } catch { return undefined; }
}

/** Mirrors the read routes of /api/runs/:id for the sample; every write is refused. */
export function webSampleResponse(sample: WebSampleFile, operation: string | undefined, method: string, query: URLSearchParams): WebSampleResponse {
  if (method !== 'GET') return readOnly;
  const latest = sample.observations.at(-1);
  if (!operation) return { status: 200, body: { run: sample.run } };
  if (operation === 'observation') return { status: 200, body: { observation: latest ?? null } };
  if (operation === 'share') return { status: 200, body: { share: null } };
  if (operation === 'download') return { status: 200, body: { schema: 'theorem-os.web-export.v1', run: sample.run }, filename: `theoremos-${sample.run.id}.json` };
  if (operation === 'events') {
    const after = Number(query.get('after') ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) return { status: 400, body: { error: '事件游标无效。' } };
    return { status: 200, body: { events: sample.events.filter(event => event.sequence > after).slice(0, 200),
      firstSequence: sample.events[0]?.sequence ?? 0, lastSequence: sample.events.at(-1)?.sequence ?? 0, droppedBefore: null } };
  }
  const newestFirst = [...sample.observations].reverse();
  const source = /^tasks\/([^/]+)\/source$/u.exec(operation);
  if (source) {
    const taskId = decodeURIComponent(source[1]), version = query.get('version') ?? undefined;
    const found = newestFirst.flatMap(item => item.sources).find(item => item.taskId === taskId && (version === undefined || item.taskVersion === version));
    return found ? { status: 200, body: { source: found } } : { status: 404, body: { error: '该任务版本没有已保存的源码。' } };
  }
  const check = /^checks\/([^/]+)$/u.exec(operation);
  if (check) {
    const found = newestFirst.flatMap(item => item.checks).find(item => item.id === decodeURIComponent(check[1]));
    return found ? { status: 200, body: { check: found } } : { status: 404, body: { error: '检查回执不存在或未保存。' } };
  }
  return { status: 404, body: { error: '示例运行没有保存这项记录。' } };
}
