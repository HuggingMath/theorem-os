import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildArchiveRoadmap } from '../docs/web/processRoadmap';
import type { ArchiveIndexRecord, ArchiveProcess } from '../docs/web/types';

type Run = ArchiveProcess['runs'][number];
const at = (minute: number) => new Date(Date.UTC(2026, 10, 8, 8, minute)).toISOString();
const task = (id: string, dependencies: string[] = [], status = 'integrated'): Run['tasks'][number] => ({
  id, theorem: `Example.${id}`, objective: `Prove the recorded ${id} statement.`, status,
  attempts: status === 'pending' ? 0 : 2, dependencies, receiptIds: [],
});
const check = (id: string, taskId: string | undefined, status = 'kernel_verified', scope: 'task' | 'original' = 'task'): NonNullable<Run['checks']>[number] => ({
  id, at: at(3), scope, taskId, status, commit: id.padEnd(40, 'a'), receiptIds: [`receipt:${id}`],
});
function fixture() {
  const run: Run = { runId: 'accepted-run', startedAt: at(0), finishedAt: at(8), phase: 'finished', resultStatus: 'evaluated_passed',
    workers: 4, turns: 12, tasks: [task('root'), task('left', ['root']), task('right', ['root']), task('goal', ['left', 'right']),
      task('blocked', ['root'], 'blocked'), task('independent', [], 'pending')], events: [{ at: at(1), kind: 'plan-edit', status: 'applied' }],
    checks: [check('left-failed', 'left', 'failed'), { ...check('left-passed', 'left'), at: at(4) },
      check('right-passed', 'right'), check('blocked-failed', 'blocked', 'failed'), check('original-passed', undefined, 'kernel_verified', 'original')],
    deliveries: [
      { id: 'finding', at: at(1), kind: 'research', status: 'advisory', taskId: 'left', workerId: 'researcher', summary: 'Use the saved auxiliary identity.' },
      { id: 'proof', at: at(2), kind: 'proof', status: 'accepted', taskId: 'left', workerId: 'engineer', summary: 'The auxiliary proof is ready for checking.' },
      { id: 'review', at: at(7), kind: 'review', status: 'accepted', workerId: 'reviewer', summary: 'The checked original statement matches the problem.' },
    ], review: { status: 'accepted', summary: 'Final review.' } };
  const record: ArchiveIndexRecord = { id: 'example', title: 'An archived example', subtitle: '归档例题', area: '代数', summary: '保留真实依赖与验收。',
    en: { subtitle: 'Archived example', area: 'Algebra', summary: 'Recorded dependencies and acceptance.' }, status: 'locally_verified', model: 'Fixture',
    updatedAt: at(8), archiveUrl: 'data/proofs/example/process.json', sources: [], excerpt: '', campaign: {
      target: 'Example', runId: run.runId, targets: ['Example.goal'], proofCommit: 'a'.repeat(40), proofSha256: 'b'.repeat(64),
      kernelReceiptIds: ['original-receipt'], comparatorExitCode: 0, attribution: 'Saved fixture', evidenceUrl: 'data/proofs/example/verification.json',
    } };
  return { record, run };
}
const dependencyPairs = (model: ReturnType<typeof buildArchiveRoadmap>) => model.edges.filter(edge => edge.kind === 'dependency')
  .map(edge => `${edge.from}->${edge.to}`).sort();

describe('the archived research roadmap', () => {
  it('preserves a diamond and an abandoned branch without turning chronology or worker order into dependencies', () => {
    const { record, run } = fixture();
    const model = buildArchiveRoadmap(record, run, 'zh');
    expect(dependencyPairs(model)).toEqual(['task:left->task:goal', 'task:right->task:goal', 'task:root->task:blocked',
      'task:root->task:left', 'task:root->task:right']);
    expect(model.nodes.filter(node => node.kind === 'task').map(node => node.taskId).sort()).toEqual(run.tasks.map(task => task.id).sort());
    expect(model.nodes.find(node => node.id === 'task:independent')).toBeDefined();
    expect(model.nodes.find(node => node.id === 'task:blocked')?.status).not.toBe(model.nodes.find(node => node.id === 'acceptance')?.status);
    expect(model.nodes.find(node => node.id === 'plan')).toMatchObject({ kind: 'plan', stepId: 'event:0' });
    expect(model.edges.some(edge => edge.from === 'task:independent' && edge.kind === 'dependency')).toBe(false);
    expect(model.edges.filter(edge => edge.kind === 'flow' && ['task:blocked', 'task:independent'].includes(edge.from))).toEqual([]);
    expect(model.edges).toContainEqual({ from: 'task:goal', to: 'original', kind: 'flow' });
    expect(model.edges.every(edge => model.nodes.some(node => node.id === edge.from) && model.nodes.some(node => node.id === edge.to))).toBe(true);
    expect(new Set(model.nodes.map(node => node.id)).size).toBe(model.nodes.length);
    expect(new Set(model.edges.map(edge => `${edge.kind}:${edge.from}->${edge.to}`)).size).toBe(model.edges.length);
  });

  it('binds task, whole-problem and review nodes to their recorded checks and deliveries', () => {
    const { record, run } = fixture();
    const model = buildArchiveRoadmap(record, run, 'zh');
    expect(model.nodes.find(node => node.id === 'task:left')).toMatchObject({ taskId: 'left',
      checkIds: ['left-failed', 'left-passed'], deliveryIds: ['finding', 'proof'] });
    expect(model.nodes.find(node => node.id === 'task:blocked')?.checkIds).toEqual(['blocked-failed']);
    expect(model.nodes.find(node => node.id === 'original')?.checkIds).toEqual(['original-passed']);
    expect(model.nodes.filter(node => node.kind === 'review').flatMap(node => node.deliveryIds)).toContain('review');
    expect(model.nodes.find(node => node.id === 'task:independent')?.checkIds).toEqual([]);
    for (const node of model.nodes) {
      expect(node.checkIds.every(id => run.checks!.some(check => check.id === id))).toBe(true);
      expect(node.deliveryIds.every(id => run.deliveries!.some(delivery => delivery.id === id))).toBe(true);
    }
  });

  it('shows acceptance only for the run named by the original accepted evidence', () => {
    const { record, run } = fixture();
    expect(buildArchiveRoadmap(record, run, 'zh').nodes.some(node => node.id === 'acceptance' && node.kind === 'acceptance')).toBe(true);
    const earlier = { ...run, runId: 'earlier-run' };
    const historical = buildArchiveRoadmap(record, earlier, 'zh');
    expect(historical.nodes.some(node => node.kind === 'acceptance')).toBe(false);
    expect(historical.nodes.some(node => node.kind === 'end')).toBe(true);
    expect(historical.nodes.find(node => node.id === 'original')?.checkIds).toEqual(['original-passed']);
    const unaccepted = { ...record, status: 'in_progress_not_officially_accepted' as const, campaign: undefined };
    expect(buildArchiveRoadmap(unaccepted, run, 'zh').nodes.some(node => node.kind === 'acceptance')).toBe(false);
  });

  it('leaves evidence absent for unfinished tasks and does not synthesize a passed check from task completion', () => {
    const { record, run } = fixture();
    run.tasks.push(task('completed-without-check', [], 'completed'));
    const model = buildArchiveRoadmap(record, run, 'zh');
    expect(model.nodes.find(node => node.id === 'task:completed-without-check')).toMatchObject({ checkIds: [], deliveryIds: [] });
    expect(model.nodes.find(node => node.id === 'task:independent')).toMatchObject({ checkIds: [], deliveryIds: [] });
    expect(model.nodes.flatMap(node => node.checkIds).every(id => run.checks!.some(check => check.id === id))).toBe(true);
  });

  it('changes presentation language while keeping the same mathematical identities, edges and evidence', () => {
    const { record, run } = fixture();
    const before = JSON.stringify({ record, run });
    const zh = buildArchiveRoadmap(record, run, 'zh'), en = buildArchiveRoadmap(record, run, 'en');
    expect(en.nodes.map(({ title: _title, ...node }) => node)).toEqual(zh.nodes.map(({ title: _title, ...node }) => node));
    expect(en.edges).toEqual(zh.edges);
    expect(en.nodes.find(node => node.id === 'problem')?.title).not.toBe(zh.nodes.find(node => node.id === 'problem')?.title);
    expect(JSON.stringify({ record, run })).toBe(before);
  });

  it('renders every real archived task dependency and keeps final acceptance bound across all sixteen problems', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'research/openai-math/manifest.json'), 'utf8')) as {
      records: (ArchiveIndexRecord & { directory: string })[] };
    expect(manifest.records).toHaveLength(16);
    let runs = 0, taskCount = 0, dependencies = 0;
    for (const record of manifest.records) {
      const process = JSON.parse(fs.readFileSync(path.join(root, 'research/openai-math', record.directory, 'process.json'), 'utf8')) as ArchiveProcess;
      for (const run of process.runs) {
        const model = buildArchiveRoadmap({ ...record, excerpt: '', sources: [] }, run, 'zh');
        const ids = new Set(run.tasks.map(task => task.id));
        const expected = [...new Set(run.tasks.flatMap(task => task.dependencies.filter(id => ids.has(id))
          .map(id => `task:${id}->task:${task.id}`)))].sort();
        expect(dependencyPairs(model), `${record.id}/${run.runId}: actual recorded dependencies`).toEqual(expected);
        expect(model.nodes.filter(node => node.kind === 'task').map(node => node.taskId).sort()).toEqual([...ids].sort());
        expect(model.nodes.some(node => node.kind === 'acceptance')).toBe(run.runId === record.campaign!.runId);
        for (const node of model.nodes) {
          expect(node.checkIds.every(id => run.checks?.some(check => check.id === id) ?? false)).toBe(true);
          expect(node.deliveryIds.every(id => run.deliveries?.some(delivery => delivery.id === id) ?? false)).toBe(true);
        }
        runs++; taskCount += ids.size; dependencies += expected.length;
      }
    }
    expect(runs).toBeGreaterThan(16); expect(taskCount).toBeGreaterThan(100); expect(dependencies).toBeGreaterThan(100);
  });
});
