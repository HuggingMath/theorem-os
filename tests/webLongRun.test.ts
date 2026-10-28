import { describe, expect, it } from 'vitest';
import { decodeTaskDraft, encodeTaskDraft, type TaskDraft } from '../apps/web/client/draft';
import { documentTitle, finishedSince, newlyFinished, newlyWaiting, readResume, resumeStorageKey, saveResume, waitsForOwner } from '../apps/web/client/runAwareness';
import { submissionIssues, tokenCap } from '../apps/web/client/submission';
import { formatTokens, usageEstimate } from '../apps/web/presentation';
import type { WebRun, WebSession } from '../apps/web/shared';

const run = (id: string, changes: Partial<WebRun> = {}): WebRun => ({
  id, title: id, status: 'completed', phase: 'finished', createdAt: '2026-10-26T00:00:00.000Z', updatedAt: '2026-10-26T00:05:00.000Z',
  finishedAt: '2026-10-26T00:05:00.000Z', providerId: 'openai', model: 'deepseek-flash', effort: 'max', environment: 'standard',
  source: 'theorem x : True := by sorry', task: 'Prove it', maxTurns: 5, maxRunSeconds: 300, workers: 1, coordination: 'cooperative',
  events: [], ...changes,
});
const memory = () => {
  const values = new Map<string, string>();
  return { values, storage: () => ({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } }) };
};
const draft: TaskDraft = { providerId: 'openai', model: 'deepseek-flash', source: 'theorem x : True := by sorry', task: 'Prove it',
  maxTurns: '5', maxRunSeconds: '300', workers: '1', effort: 'max', environment: 'standard', coordination: 'cooperative', templateId: '' };
const session = { providers: [{ id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' }],
  environments: [{ id: 'standard', name: 'Lean', description: '', toolchain: 'v4' }],
  limits: { maxTurns: 20, maxRunSeconds: 900, maxWorkers: 4, maxTotalTokens: 100_000_000, maxSourceBytes: 32_768, maxTaskBytes: 8_000 } } as unknown as WebSession;

describe('usage estimate and token cap before submission', () => {
  it('estimates from this account\'s finished runs on the same model, by reported tokens per turn', () => {
    const runs = [
      run('a', { result: { status: 'incomplete', proof: '', report: { turns: 4, usage: { totalTokens: 400_000 } } } }),
      run('b', { result: { status: 'evaluated_passed', proof: '', report: { turns: 2, usage: { inputTokens: 150_000, outputTokens: 50_000 } } } }),
      run('other-model', { model: 'gpt', result: { status: 'incomplete', proof: '', report: { turns: 1, usage: { totalTokens: 9e9 } } } }),
      run('no-usage', { result: { status: 'runtime_error', proof: '', report: { turns: 3 } } }),
      run('running', { status: 'running' }),
    ];
    expect(usageEstimate(runs, 'deepseek-flash', 10)).toEqual({ perTurn: 100_000, ceiling: 1_000_000, samples: 2 });
    expect(usageEstimate(runs, 'unknown-model', 10)).toBeUndefined();
    expect([formatTokens(1_000_000), formatTokens(250_000_000), formatTokens(800)]).toEqual(['100 万', '2.5 亿', '800']);
  });

  it('accepts an empty cap as unlimited and a whole number of 万 tokens within the limit', () => {
    expect(tokenCap('', 1e8)).toBeUndefined();
    expect(tokenCap('50', 1e8)).toBe(500_000);
    for (const value of ['0', '1.5', '-3', '10001', 'abc']) expect(tokenCap(value, 1e8)).toBeUndefined();
    expect(submissionIssues({ ...draft, maxTotalTokens: '' }, 'sk-valid-key', session)).toEqual([]);
    expect(submissionIssues({ ...draft, maxTotalTokens: '0' }, 'sk-valid-key', session).map(issue => issue.field)).toEqual(['max-tokens']);
  });

  it('keeps the cap in drafts and archives and still reads drafts saved before it existed', () => {
    const capped = { ...draft, maxTotalTokens: '80' };
    expect(decodeTaskDraft(JSON.parse(encodeTaskDraft(capped)))).toEqual(capped);
    expect(decodeTaskDraft(JSON.parse(encodeTaskDraft(draft)))).not.toHaveProperty('maxTotalTokens');
    expect(decodeTaskDraft({ schema: 'theorem-os.web-export.v1', run: { ...draft, maxTurns: 5, maxRunSeconds: 300, workers: 1, maxTotalTokens: 800_000 } }).maxTotalTokens)
      .toBe('800000');
  });
});

describe('returning to long runs', () => {
  it('remembers only the open run ID and visit time, and survives unreadable storage', () => {
    const { values, storage } = memory();
    const id = '1a05fff7-724c-4d67-8000-000000000000';
    saveResume(storage, { selectedId: id, seenAt: '2026-10-26T00:00:00.000Z' });
    expect(readResume(storage)).toEqual({ selectedId: id, seenAt: '2026-10-26T00:00:00.000Z' });
    expect(JSON.parse(values.get(resumeStorageKey)!)).toEqual({ selectedId: id, seenAt: '2026-10-26T00:00:00.000Z' });
    for (const raw of ['{broken', '{"selectedId":"<img>","seenAt":"2026-10-26T00:00:00.000Z"}', '{"selectedId":"","seenAt":"later"}']) {
      values.set(resumeStorageKey, raw);
      expect(readResume(storage)).toBeUndefined();
    }
    const blocked = () => { throw new DOMException('blocked', 'SecurityError'); };
    expect(readResume(blocked)).toBeUndefined();
    expect(() => saveResume(blocked, { selectedId: id, seenAt: '2026-10-26T00:00:00.000Z' })).not.toThrow();
  });

  it('finds runs that ended while away and runs that just ended', () => {
    const early = run('early', { finishedAt: '2026-10-26T00:01:00.000Z' }), late = run('late', { finishedAt: '2026-10-26T00:09:00.000Z' });
    const active = run('active', { status: 'running', finishedAt: undefined });
    expect(finishedSince([late, early, active], '2026-10-26T00:02:00.000Z').map(item => item.id)).toEqual(['late']);
    expect(newlyFinished([{ ...late, status: 'running' }, active], [late, active]).map(item => item.id)).toEqual(['late']);
  });

  it('puts finished and active counts in the tab title', () => {
    expect(documentTitle('TheoremOS', 0, 0)).toBe('TheoremOS');
    expect(documentTitle('TheoremOS', 2, 0)).toBe('2 项进行中 · TheoremOS');
    expect(documentTitle('TheoremOS', 2, 1)).toBe('(1) 研究已结束 · TheoremOS');
    expect(documentTitle('TheoremOS', 2, 1, 1)).toBe('(1) 等你批准计划 · TheoremOS');
  });

  it('finds plans that just started waiting for the owner, not ones being revised or already waiting', () => {
    const plan = (id: string, status: string, leadRevising = false) => run(id, { status: 'running', finishedAt: undefined,
      observation: { inspection: { planApproval: { required: true, status, planVersion: 'plan-v1', rejections: [], leadRevising } } } as unknown as WebRun['observation'] });
    expect([plan('a', 'pending'), plan('b', 'pending', true), plan('c', 'awaiting-plan'), plan('d', 'approved'), run('e')].map(waitsForOwner))
      .toEqual([true, false, false, false, false]);
    expect(waitsForOwner({ ...plan('f', 'pending'), status: 'completed' })).toBe(false);
    const before = [plan('drafted', 'awaiting-plan'), plan('revised', 'pending', true), plan('waiting', 'pending'), plan('approved', 'pending')];
    const after = [plan('drafted', 'pending'), plan('revised', 'pending'), plan('waiting', 'pending'), plan('approved', 'approved'), plan('new', 'pending')];
    expect(newlyWaiting(before, after).map(item => item.id)).toEqual(['drafted', 'revised']);
    expect(newlyWaiting([], after)).toEqual([]);
  });
});
