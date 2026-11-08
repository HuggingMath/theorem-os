import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderGlobalTrajectory, retainedTaskSources } from '../docs/web/globalTrajectory';
import { processMessage, readableProcessText } from '../docs/web/processText';
import { workflowNote } from '../docs/web/workflowNotes';
import type { ArchiveIndexRecord, ArchiveProcess } from '../docs/web/types';

type Run = ArchiveProcess['runs'][number];
type Check = NonNullable<Run['checks']>[number];
const check = (id: string, taskId?: string, sourceDigest?: string): Check => ({
  id, taskId, sourceDigest, scope: 'task', status: 'kernel_verified', at: '2026-11-08T08:00:00Z', receiptIds: [],
});
const run = (id: string, checks?: Check[]): Run => ({
  runId: id, phase: 'finished', turns: 0, workers: 0, tasks: [], events: [], checks,
});

describe('retained evidence in the whole-problem trajectory', () => {
  it('requires both the same task and the same checked bytes', () => {
    const before = run('before', [check('a', 'lemma-a', 'bytes-a')]);
    expect(retainedTaskSources(before, run('after', [check('b', 'lemma-a', 'bytes-a')]))).toBe(1);
    expect(retainedTaskSources(before, run('after', [check('b', 'lemma-b', 'bytes-a')]))).toBe(0);
    expect(retainedTaskSources(before, run('after', [check('b', 'lemma-a', 'bytes-b')]))).toBe(0);
  });

  it('counts each task and source pair once despite repeated checks', () => {
    const before = run('before', [check('a', 'lemma-a', 'bytes-a'), check('b', 'lemma-a', 'bytes-a'), check('c', 'lemma-b', 'bytes-b')]);
    const after = run('after', [check('d', 'lemma-a', 'bytes-a'), check('e', 'lemma-a', 'bytes-a'), check('f', 'lemma-b', 'bytes-b')]);
    expect(retainedTaskSources(before, after)).toBe(2);
  });

  it('does not infer retention from missing task identities, source hashes or check lists', () => {
    const incomplete = run('before', [check('a', 'lemma-a'), check('b', undefined, 'bytes-b'), check('c')]);
    expect(retainedTaskSources(incomplete, run('after', [check('d', 'lemma-a'), check('e', undefined, 'bytes-b'), check('f')]))).toBe(0);
    expect(retainedTaskSources(run('before'), run('after'))).toBe(0);
    expect(retainedTaskSources(run('before', []), run('after', [check('a', 'lemma-a', 'bytes-a')]))).toBe(0);
  });

  it('preserves source identity without changing a failed check into acceptance', () => {
    const before = run('before', [{ ...check('a', 'lemma-a', 'bytes-a'), status: 'failed' }]);
    const after = run('after', [{ ...check('b', 'lemma-a', 'bytes-a'), status: 'failed' }]);
    const original = JSON.stringify({ before, after });
    expect(retainedTaskSources(before, after)).toBe(1);
    expect(JSON.stringify({ before, after })).toBe(original);
  });
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'research/openai-math/manifest.json'), 'utf8')) as {
  records: (ArchiveIndexRecord & { directory: string })[] };
const archived = manifest.records.map(record => ({ record: { ...record, excerpt: '', sources: [] },
  process: JSON.parse(fs.readFileSync(path.join(root, 'research/openai-math', record.directory, 'process.json'), 'utf8')) as ArchiveProcess }));
const escaped = (value: string) => value.replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const entries = (value: string) => [...value.matchAll(/<li class="workflow-record" data-workflow-entry="([^"]+)"[^>]*>([\s\S]*?)<\/li>/gu)]
  .map(match => ({ id: match[1], body: match[2] }));
const stage = (value: string, name: string) => value.split('data-workflow-stage="' + name + '">')[1]?.split('<section class="workflow-section"')[0] ?? '';
const byTime = <T extends { at: string }>(values: T[]) => values.slice().sort((a, b) => a.at.localeCompare(b.at));

describe('the complete archived research workflow', () => {
  it('defaults to the evidence-bound final run even when a later saved run exists', () => {
    const { record } = archived[0];
    const process = { runs: [run('earlier'), run(record.campaign!.runId), run('later-unaccepted')] };
    const acceptance = '<div data-test-acceptance>Exact original acceptance</div>';
    const output = renderGlobalTrajectory(record, process, 'en', value => value ?? '', { acceptance });
    expect(output).toContain('data-global-selected-run="' + record.campaign!.runId + '"');
    expect(output).toContain('data-global-select="' + record.campaign!.runId + '" aria-pressed="true"');
    expect((output.match(/data-test-acceptance/gu) ?? [])).toHaveLength(1);
    const later = renderGlobalTrajectory(record, process, 'en', value => value ?? '', { run: 'later-unaccepted', acceptance });
    expect(later).toContain('data-global-selected-run="later-unaccepted"');
    expect(later).not.toContain('data-test-acceptance');
    expect(later).not.toContain('class="global-final-badge"');
    expect(later).toContain('data-global-node="end"');
  });

  it('marks a repeated delivery as earlier saved evidence even when its timestamp is within the selected run', () => {
    const { record } = archived[0];
    const at = '2026-11-08T08:15:00Z';
    const delivery = { id: 'repeated', at, kind: 'research', status: 'advisory', summary: 'A saved finite-sum reduction.' };
    const earlier = { ...run('earlier'), deliveries: [delivery] };
    const selected = { ...run('selected'), startedAt: '2026-11-08T08:00:00Z', deliveries: [delivery,
      { ...delivery, id: 'new-at-start', at: '2026-11-08T08:00:00Z' },
      { ...delivery, id: 'older-timestamp', at: '2026-11-08T07:59:59Z' }], events: [
      { at, kind: 'plan-edit', message: 'Keep both branches of the finite-sum argument.' },
      { at, kind: 'transition', message: '' },
    ] };
    const output = renderGlobalTrajectory(record, { runs: [earlier, selected] }, 'en', value => value ?? '', { run: selected.runId });
    const rows = new Map(entries(output).map(row => [row.id, row.body]));
    expect(rows.get('delivery:repeated')).toContain('Earlier saved record');
    expect(rows.get('delivery:older-timestamp')).toContain('Earlier saved record');
    expect(rows.get('delivery:new-at-start')).not.toContain('Earlier saved record');
    expect(rows.get('event:0')).toContain('Keep both branches of the finite-sum argument.');
    expect(rows.has('event:1')).toBe(false);
  });

  it('preserves all recorded bodies, objectives, chronological entries and exact evidence destinations in all saved runs', () => {
    expect(archived).toHaveLength(16);
    let runs = 0, deliveryRows = 0, checkRows = 0, retainedRows = 0, notes = 0;
    for (const { record, process } of archived) {
      const original = JSON.stringify(process);
      for (const selected of process.runs) for (const locale of ['zh', 'en'] as const) {
        const output = renderGlobalTrajectory(record, process, locale, value => value ?? '', { run: selected.runId,
          acceptance: '<div data-test-acceptance>Exact original acceptance</div>' });
        const context = [record.id, selected.runId, locale].join('/');
        const lanes = [...output.matchAll(/<li class="global-run-lane" data-global-run-id="([^"]+)" data-final="(true|false)">/gu)];
        expect(lanes.map(match => match[1]), context).toEqual(process.runs.map(run => run.runId));
        expect(lanes.filter(match => match[2] === 'true').map(match => match[1]), context).toEqual([record.campaign!.runId]);
        expect(output, context).toContain('data-global-select="' + selected.runId + '" aria-pressed="true"');
        expect(output, context).toContain('data-global-selected-run="' + selected.runId + '"');
        expect([...output.matchAll(/data-workflow-stage="([^"]+)"/gu)].map(match => match[1])).toEqual(['plan', 'research', 'implementation', 'review']);
        expect((output.match(/data-test-acceptance/gu) ?? []).length).toBe(Number(selected.runId === record.campaign!.runId));
        expect((output.match(/class="global-final-badge"/gu) ?? []).length).toBe(Number(selected.runId === record.campaign!.runId));

        const rows = entries(output), allIds = rows.map(row => row.id), map = new Map(rows.map(row => [row.id, row.body]));
        const planIds = selected.events.flatMap((event, index) => event.kind === 'plan-edit' && event.message?.trim() ? ['event:' + index] : []);
        expect(allIds.slice().sort(), context).toEqual([...planIds, ...(selected.deliveries ?? []).map(delivery => 'delivery:' + delivery.id),
          ...(selected.checks ?? []).map(check => 'check:' + check.id)].sort());
        expect(new Set(allIds).size, context).toBe(allIds.length);
        const research = byTime((selected.deliveries ?? []).filter(delivery => ['research', 'progress'].includes(delivery.kind)));
        expect(entries(stage(output, 'research')).slice(0, research.length).map(row => row.id), context).toEqual(research.map(delivery => 'delivery:' + delivery.id));
        const implementation = byTime([...(selected.deliveries ?? []).filter(delivery => ['proof', 'failure'].includes(delivery.kind))
          .map(delivery => ({ at: delivery.at, id: 'delivery:' + delivery.id })), ...(selected.checks ?? []).map(check => ({ at: check.at, id: 'check:' + check.id }))]);
        expect(entries(stage(output, 'implementation')).map(row => row.id), context).toEqual(implementation.map(item => item.id));
        expect(entries(stage(output, 'review')).map(row => row.id), context).toEqual(byTime((selected.deliveries ?? []).filter(delivery => delivery.kind === 'review')).map(delivery => 'delivery:' + delivery.id));
        expect([...output.matchAll(/data-workflow-task="([^"]+)"/gu)].map(match => match[1]), context).toEqual(selected.tasks.map(task => task.id));
        for (const task of selected.tasks) expect(output, context + '/' + task.id + ': full task objective').toContain(escaped(readableProcessText(task.objective, Number.MAX_SAFE_INTEGER)));
        const older = new Set(process.runs.slice(0, process.runs.indexOf(selected)).flatMap(run => (run.deliveries ?? []).map(delivery => delivery.id)));
        for (const delivery of selected.deliveries ?? []) {
          const body = map.get('delivery:' + delivery.id)!;
          const expected = processMessage(delivery.summary, locale), note = workflowNote(delivery.id, locale);
          if (expected) expect(body, context + '/' + delivery.id + ': complete saved prose remains reachable').toContain(escaped(expected));
          if (note) { expect(body).toContain(escaped(note)); expect(body).toContain('class="workflow-full-text"'); notes++; }
          expect(body).toContain('data-global-run="' + selected.runId + '"');
          expect(body).toContain('data-global-step="delivery:' + delivery.id + '"');
          expect(body).toContain('data-global-node="' + (delivery.taskId ? 'task:' + delivery.taskId : delivery.kind === 'review' ? 'review' : 'problem') + '"');
          const retained = older.has(delivery.id) || !!selected.startedAt && delivery.at < selected.startedAt;
          expect(body.includes('class="workflow-retained"'), context + '/' + delivery.id + ': inherited marker').toBe(retained);
          if (retained) retainedRows++;
        }
        for (const check of selected.checks ?? []) {
          const body = map.get('check:' + check.id)!;
          expect(body).toContain('data-global-run="' + selected.runId + '"');
          expect(body).toContain('data-global-step="check:' + check.id + '"');
          expect(body).toContain('data-global-node="' + (check.scope === 'original' ? 'original' : check.taskId ? 'task:' + check.taskId : 'problem') + '"');
          expect(body.includes('class="workflow-retained"')).toBe(!!selected.startedAt && check.at < selected.startedAt);
        }
        if (locale === 'zh') { runs++; deliveryRows += selected.deliveries?.length ?? 0; checkRows += selected.checks?.length ?? 0; }
      }
      expect(JSON.stringify(process)).toBe(original);
    }
    expect(runs).toBe(45); expect(deliveryRows).toBeGreaterThan(400); expect(checkRows).toBeGreaterThan(300);
    expect(retainedRows).toBeGreaterThan(0); expect(notes).toBeGreaterThan(0);
  });
});
