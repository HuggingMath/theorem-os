import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderGlobalTrajectory } from '../docs/web/globalTrajectory';
import { emptyProcessSelection, renderArchiveProcess } from '../docs/web/process';
import { buildArchiveRoadmap } from '../docs/web/processRoadmap';
import type { ArchiveIndexRecord, ArchiveProcess } from '../docs/web/types';

type Run = ArchiveProcess['runs'][number];
const at = (minute: number) => new Date(Date.UTC(2026, 10, 8, 8, minute)).toISOString();
function fixture() {
  const deliveries: NonNullable<Run['deliveries']> = [
    { id: 'lead', at: at(1), kind: 'progress', status: 'advisory', summary: 'unassigned-progress-body' },
    { id: 'historical', at: at(2), kind: 'research', status: 'superseded', taskId: 'previous-task', summary: 'historical-research-body' },
    { id: 'current', at: at(3), kind: 'proof', status: 'verified', taskId: 'current-task', summary: 'current-proof-body' },
    { id: 'review', at: at(4), kind: 'review', status: 'accepted', summary: 'review-body' },
    { id: 'historical-review', at: at(5), kind: 'review', status: 'changes_requested', taskId: 'previous-task', summary: 'historical-review-body' },
  ];
  const checks: NonNullable<Run['checks']> = [
    { id: 'unassigned', at: at(2), scope: 'task', status: 'failed', diagnostics: 'unassigned-check-diagnostic', receiptIds: [] },
    { id: 'historical', at: at(3), scope: 'task', taskId: 'previous-task', status: 'failed', diagnostics: 'historical-check-diagnostic', receiptIds: [] },
    { id: 'current', at: at(4), scope: 'task', taskId: 'current-task', status: 'kernel_verified', diagnostics: 'current-check-diagnostic', receiptIds: [] },
    { id: 'original', at: at(6), scope: 'original', status: 'kernel_verified', diagnostics: 'original-check-diagnostic', receiptIds: ['original-receipt'] },
  ];
  const run: Run = { runId: 'fixed-run', startedAt: at(0), finishedAt: at(8), phase: 'finished', resultStatus: 'evaluated_passed', workers: 2, turns: 4,
    tasks: [{ id: 'current-task', theorem: 'Example.goal', objective: 'Prove the current goal.', status: 'integrated', attempts: 1, dependencies: [], receiptIds: [] }],
    events: [], deliveries, checks };
  const record: ArchiveIndexRecord = { id: 'unseen-example', title: 'Example', subtitle: '', area: '', summary: 'Fixed problem statement.',
    status: 'locally_verified', model: 'Fixture', updatedAt: at(8), archiveUrl: 'example/process.json', sources: [], excerpt: '',
    campaign: { target: 'Example.goal', runId: run.runId, targets: ['Example.goal'], proofCommit: 'a'.repeat(40), proofSha256: 'b'.repeat(64),
      kernelReceiptIds: ['original-receipt'], comparatorExitCode: 0, attribution: 'Fixed fixture', evidenceUrl: 'example/verification.json' } };
  return { record, run, process: { runs: [run] } satisfies ArchiveProcess };
}
const selectedRecord = (html: string) => [...html.matchAll(/data-process-step="([^"]+)" aria-pressed="true"/gu)].map(match => match[1]);
const globalEntries = (html: string) => [...html.matchAll(/data-workflow-entry="([^"]+)"[^>]*>([\s\S]*?)<\/li>/gu)]
  .map(match => ({ id: match[1], node: /data-global-node="([^"]+)"/u.exec(match[2])?.[1] }));

describe('exact archived record navigation', () => {
  it('keeps unassigned and removed-task evidence on the original problem without changing current tasks or review and acceptance', () => {
    const { record, run } = fixture(), before = JSON.stringify(run);
    const model = buildArchiveRoadmap(record, run, 'en');
    expect(model.nodes.find(node => node.id === 'problem')).toMatchObject({ checkIds: ['unassigned', 'historical'], deliveryIds: ['lead', 'historical'] });
    expect(model.nodes.find(node => node.id === 'task:current-task')).toMatchObject({ checkIds: ['current'], deliveryIds: ['current'] });
    expect(model.nodes.find(node => node.id === 'original')?.checkIds).toEqual(['original']);
    expect(model.nodes.find(node => node.id === 'review')?.deliveryIds).toEqual(['review', 'historical-review']);
    expect(model.nodes.find(node => node.id === 'acceptance')?.stepId).toBe('acceptance');
    expect(model.nodes.some(node => node.id === 'task:previous-task')).toBe(false);
    expect(JSON.stringify(run)).toBe(before);
  });

  it.each(['zh', 'en'] as const)('opens exact deliveries and checks through roadmap, steps and a restored selection in %s', locale => {
    const { record, process } = fixture();
    const targets = [
      ['delivery:lead', 'problem', 'unassigned-progress-body'], ['delivery:historical', 'problem', 'historical-research-body'],
      ['delivery:current', 'task:current-task', 'current-proof-body'], ['delivery:review', 'review', 'review-body'],
      ['delivery:historical-review', 'review', 'historical-review-body'], ['check:unassigned', 'problem', 'unassigned-check-diagnostic'],
      ['check:historical', 'problem', 'historical-check-diagnostic'], ['check:current', 'task:current-task', 'current-check-diagnostic'],
      ['check:original', 'original', 'original-check-diagnostic'],
    ];
    for (const [step, node, body] of targets) {
      const selection = { ...emptyProcessSelection(), view: 'roadmap' as const, run: 'fixed-run', step };
      const first = renderArchiveProcess(record, process, selection, locale);
      expect(selection.node, step).toBe(node);
      expect(selectedRecord(first), step).toEqual([step]); expect(first, step).toContain(body);
      const steps = renderArchiveProcess(record, process, { ...selection, view: 'steps' }, locale);
      expect(selectedRecord(steps), step).toEqual([step]); expect(steps, step).toContain(body);
      renderArchiveProcess(record, process, { ...selection, view: 'global' }, locale);
      const restored = renderArchiveProcess(record, process, { ...selection }, locale);
      expect(selectedRecord(restored), step).toEqual([step]); expect(restored, step).toContain(body);
    }
    const stale = { ...emptyProcessSelection(), view: 'roadmap' as const, step: 'delivery:historical-review', node: 'task:previous-task' };
    expect(selectedRecord(renderArchiveProcess(record, process, stale, locale))).toEqual(['delivery:historical-review']);
    expect(stale.node).toBe('review');
  });

  it('gives global-trajectory buttons valid semantic destinations including historical reviews and local checks', () => {
    const { record, run, process } = fixture();
    const entries = globalEntries(renderGlobalTrajectory(record, process, 'en', status => status ?? ''));
    const model = buildArchiveRoadmap(record, run, 'en');
    expect(entries).toEqual(expect.arrayContaining([
      { id: 'delivery:lead', node: 'problem' }, { id: 'delivery:historical', node: 'problem' },
      { id: 'delivery:current', node: 'task:current-task' }, { id: 'delivery:historical-review', node: 'review' },
      { id: 'check:unassigned', node: 'problem' }, { id: 'check:historical', node: 'problem' }, { id: 'check:original', node: 'original' },
    ]));
    for (const entry of entries) expect(model.nodes.some(node => node.id === entry.node), entry.id).toBe(true);
    const acceptance = { ...emptyProcessSelection(), view: 'roadmap' as const, step: 'acceptance' };
    expect(renderArchiveProcess(record, process, acceptance, 'en')).toContain('data-process-acceptance');
    expect(acceptance.node).toBe('acceptance');
  });

  it('opens every real global delivery and check from its own saved run across all sixteen archived problems', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'research/openai-math/manifest.json'), 'utf8')) as {
      records: (ArchiveIndexRecord & { directory: string })[] };
    let records = 0, previouslyUnassigned = 0;
    for (const native of manifest.records) {
      const record = { ...native, sources: [], excerpt: '' };
      const process = JSON.parse(fs.readFileSync(path.join(root, 'research/openai-math', native.directory, 'process.json'), 'utf8')) as ArchiveProcess;
      for (const run of process.runs) {
        const entries = globalEntries(renderGlobalTrajectory(record, process, 'en', status => status ?? '', { run: run.runId }));
        for (const entry of entries) {
          if (!entry.id.startsWith('delivery:') && !entry.id.startsWith('check:')) continue;
          const selection = { ...emptyProcessSelection(), view: 'roadmap' as const, run: run.runId, node: entry.node!, step: entry.id };
          expect(selectedRecord(renderArchiveProcess(record, process, selection, 'en')), `${record.id}/${run.runId}/${entry.id}`).toEqual([entry.id]);
          if (entry.node === 'problem') previouslyUnassigned++;
          records++;
        }
      }
    }
    expect(records).toBeGreaterThan(500); expect(previouslyUnassigned).toBeGreaterThan(40);
  });
});
