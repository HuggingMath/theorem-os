import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderGlobalTrajectory, retainedTaskSources } from '../docs/web/globalTrajectory';
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

describe('whole-problem archived trajectories', () => {
  it('renders every saved run in order, exposes real destinations and binds final acceptance to exactly one run', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'research/openai-math/manifest.json'), 'utf8')) as {
      records: (ArchiveIndexRecord & { directory: string })[] };
    expect(manifest.records).toHaveLength(16);
    let totalRuns = 0, retained = 0, failedDestinations = 0;
    for (const record of manifest.records) {
      const process = JSON.parse(fs.readFileSync(path.join(root, 'research/openai-math', record.directory, 'process.json'), 'utf8')) as ArchiveProcess;
      const original = JSON.stringify(process);
      for (const locale of ['zh', 'en'] as const) {
        const output = renderGlobalTrajectory({ ...record, excerpt: '', sources: [] }, process, locale, value => value ?? '');
        const lanes = [...output.matchAll(/<li class="global-run-lane" data-global-run-id="([^"]+)" data-final="(true|false)">([\s\S]*?)<\/li>/gu)];
        expect(lanes.map(match => match[1]), `${record.id}/${locale}: chronological recorded runs`).toEqual(process.runs.map(run => run.runId));
        expect(lanes.filter(match => match[2] === 'true').map(match => match[1])).toEqual([record.campaign!.runId]);
        expect((output.match(/class="global-final-badge"/gu) ?? [])).toHaveLength(1);
        for (let index = 0; index < lanes.length; index++) {
          const saved = process.runs[index], body = lanes[index][3];
          expect((body.match(/<button class="global-stage /gu) ?? [])).toHaveLength(3);
          expect((body.match(/data-global-run="([^"]+)"/gu) ?? [])).toEqual(Array(3).fill(`data-global-run="${saved.runId}"`));
          expect(body).toContain(`data-global-node="${saved.runId === record.campaign!.runId ? 'acceptance' : 'end'}"`);
          const selected = saved.checks?.find(check => check.status === 'failed')
            ?? saved.checks?.filter(check => check.scope === 'original').at(-1) ?? saved.checks?.at(-1);
          if (selected) {
            expect(body).toContain(`data-global-step="check:${selected.id}"`);
            expect(body).toContain(`data-global-node="${selected.scope === 'original' ? 'original' : selected.taskId ? `task:${selected.taskId}` : 'problem'}"`);
            if (selected.status === 'failed') failedDestinations++;
          } else expect(body).not.toContain('data-global-step=');
          const count = index ? retainedTaskSources(process.runs[index - 1], saved) : 0;
          if (count) {
            expect(body).toContain(locale === 'en' ? `${count} checked sources retained` : `保留前轮 ${count} 份检查源码`);
            retained += count;
          } else expect(body).not.toContain('checked sources retained').not.toContain('保留前轮');
        }
      }
      expect(JSON.stringify(process)).toBe(original);
      totalRuns += process.runs.length;
    }
    expect(totalRuns).toBeGreaterThan(16);
    expect(retained).toBeGreaterThan(0);
    expect(failedDestinations).toBeGreaterThan(0);
  });
});
