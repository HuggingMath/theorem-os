import { describe, expect, it } from 'vitest';
import type { WebFormalization, WebFormalizationActivity } from '../apps/web/formalizationTypes';
import type { WebFormalizationReport } from '../apps/web/shared';
import { buildSolveProcess } from '../apps/web/client/solveProcess';
import { formalizationProgress } from '../apps/web/client/ui/FormalizationProgress';

const at = '2026-11-09T04:00:00Z';
const item = (phase: NonNullable<WebFormalization['progress']>['phase'], patch: Partial<WebFormalization> = {}): WebFormalization => ({
  id: 'statement-progress', original: 'Prove n + 0 = n.', environment: 'standard', model: 'fixture', effort: 'max',
  status: 'running', reviewMode: 'direct', createdAt: at, updatedAt: at, progress: { phase }, ...patch,
});
const compile = (sequence: number, state: 'started' | 'failed' | 'passed'): WebFormalizationActivity => ({
  sequence, at, type: 'step', step: { round: sequence < 3 ? 1 : 2, step: 'compile', state,
    ...(state === 'started' ? { source: 'theorem addition (n : Nat) : n + 0 = n := by sorry' }
      : { lean: { passed: state === 'passed', messages: state === 'passed' ? [] : [{ severity: 'error', text: 'type mismatch', line: 1 }] } }),
  },
});
const progress = (formalization: WebFormalization, activity: WebFormalizationActivity[] = []) =>
  formalizationProgress(formalization, buildSolveProcess({ formalization, activity }));
const activeStep = (value: ReturnType<typeof progress>) => value.steps.filter(step => step.tone === 'active').map(step => step.id);

describe('formalization progress overview', () => {
  it('shows one current step from recorded phases without invented code or completion', () => {
    for (const [phase, step] of [['queued', 'prepare'], ['preparing', 'prepare'], ['planning', 'write'],
      ['generating', 'write'], ['compiling', 'compile']] as const) {
      const value = progress(item(phase));
      expect(activeStep(value)).toEqual([step]);
      expect(value.ready).toBe(false);
      expect(value.checks).toBe(0);
      expect(value.steps.at(-1)!.tone).toBe('pending');
    }
  });

  it('explains revisions after a Lean error and follows the next real compilation', () => {
    const activity = [compile(1, 'started'), compile(2, 'failed')];
    const revision = progress(item('compiling'), activity);
    expect(activeStep(revision)).toEqual(['write']);
    expect(revision.description).toContain('根据报错修改');
    expect(revision.failures).toBe(1);
    const next = progress(item('compiling'), [...activity, compile(3, 'started')]);
    expect(activeStep(next)).toEqual(['compile']);
    expect(next.checks).toBe(2); expect(next.failures).toBe(1);
    expect(next.description).toContain('检查类型、定义和语法');
  });

  it('waits for the saved report before claiming the compiled code can be used', () => {
    const value = progress(item('compiling'), [compile(1, 'started'), compile(2, 'passed')]);
    expect(value.ready).toBe(false);
    expect(value.steps.find(step => step.id === 'compile')!.tone).toBe('done');
    expect(activeStep(value)).toEqual(['ready']);
    expect(value.description).toContain('正在保存');
  });

  it('keeps saved code ready through every independent background review state', () => {
    const report = { statement: 'theorem addition (n : Nat) : n + 0 = n := by sorry' } as WebFormalizationReport;
    for (const status of ['queued', 'running', 'changes_requested', 'error', 'approved'] as const) {
      const value = progress(item('finishing', { status: 'confirmed', report,
        backgroundReview: { status, evidenceSha256: 'e', sourceSha256: 's', queuedAt: at } }));
      expect(value.ready).toBe(true);
      expect(value.steps.every(step => step.tone === 'done')).toBe(true);
      expect(activeStep(value)).toEqual([]);
      expect(value.description).toContain('可查看和下载');
    }
  });

  it('does not mark a restored record failed or expose code before its report has loaded', () => {
    const value = progress(item('finishing', { status: 'confirmed' }));
    expect(value.ready).toBe(false);
    expect(value.steps.some(step => step.tone === 'failed' || step.tone === 'active')).toBe(false);
    expect(value.steps.at(-1)!.tone).toBe('pending');
    expect(value.description).toContain('正在读取已保存');
  });

  it('stops animation on cancellation or failure and does not count an interrupted check as a Lean rejection', () => {
    for (const status of ['cancelled', 'error', 'exhausted'] as const) {
      const value = progress(item('compiling', { status }), [compile(1, 'started')]);
      expect(activeStep(value)).toEqual([]);
      expect(value.ready).toBe(false);
      expect(value.failures).toBe(0);
      expect(value.steps.find(step => step.id === 'compile')!.tone).toBe(status === 'cancelled' ? 'stopped' : 'failed');
    }
  });

  it('keeps legacy semantic checking visible without treating it as a proof', () => {
    const value = progress(item('reviewing', { reviewMode: undefined }));
    expect(value.description).toContain('与原题的一致性');
    expect(value.ready).toBe(false);
    expect(activeStep(value)).toEqual(['ready']);
    expect(value.description).not.toContain('证明通过');
  });
});
