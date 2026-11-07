import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebQuota, WebQuotaError, webQuotaDefaults } from '../apps/web/quota';
import { WebStorage } from '../apps/web/storage';

const limits = { windowHours: 2, runs: 2, formalizations: 1, explanations: 0 };
const quota = (storage = new WebStorage(), settings = limits) => new WebQuota(storage, settings);

describe('per-account allowance', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('counts each kind separately and reports what is left', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-07T09:00:00Z'));
    const subject = quota();
    expect(subject.view('acc-1')).toEqual({ windowHours: 2, windowEndsAt: '2026-11-07T11:00:00.000Z',
      runs: { used: 0, limit: 2 }, formalizations: { used: 0, limit: 1 }, explanations: { used: 0, limit: 0 } });
    subject.take('acc-1', 'runs');
    subject.take('acc-1', 'runs');
    subject.take('acc-1', 'formalizations');
    expect(subject.view('acc-1')).toMatchObject({ runs: { used: 2, limit: 2 }, formalizations: { used: 1, limit: 1 } });
    // Another account has its own ledger.
    expect(subject.view('acc-2').runs.used).toBe(0);
  });

  it('refuses once the allowance is spent, and always refuses a kind set to zero', () => {
    const subject = quota();
    subject.take('acc-1', 'formalizations');
    expect(() => subject.take('acc-1', 'formalizations')).toThrow(WebQuotaError);
    try { subject.take('acc-1', 'formalizations'); } catch (error) {
      expect(error).toMatchObject({ kind: 'formalizations', status: 429 });
      expect((error as Error).message).toContain('每 2 小时 1 次形式化');
    }
    expect(() => subject.take('acc-1', 'explanations')).toThrow(/每 2 小时 0 份证明讲解/u);
  });

  it('refunds only work that never started, and never below zero', () => {
    const subject = quota();
    subject.take('acc-1', 'runs');
    subject.refund('acc-1', 'runs');
    subject.refund('acc-1', 'runs');
    expect(subject.view('acc-1').runs.used).toBe(0);
    subject.refund('acc-2', 'runs');
    expect(subject.view('acc-2').runs.used).toBe(0);
  });

  it('starts a fresh window once the configured hours have passed', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-07T09:00:00Z'));
    const subject = quota();
    subject.take('acc-1', 'runs');
    subject.take('acc-1', 'runs');
    expect(() => subject.take('acc-1', 'runs')).toThrow(WebQuotaError);
    vi.setSystemTime(new Date('2026-11-07T10:59:59Z'));
    expect(subject.view('acc-1').runs.used).toBe(2);
    vi.setSystemTime(new Date('2026-11-07T11:00:00Z'));
    expect(subject.view('acc-1')).toMatchObject({ runs: { used: 0, limit: 2 }, windowEndsAt: '2026-11-07T13:00:00.000Z' });
    subject.take('acc-1', 'runs');
    expect(subject.view('acc-1').runs.used).toBe(1);
  });

  it('keeps counts in a record named after the account and forgets them with it', () => {
    const storage = new WebStorage();
    const subject = quota(storage);
    subject.take('acc-1', 'runs');
    const files = storage.listRecords(['usage']);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[0-9a-f]{64}\.json$/u);
    expect(files[0]).not.toContain('acc-1');
    subject.forget('acc-1');
    expect(storage.listRecords(['usage'])).toEqual([]);
    expect(subject.view('acc-1').runs.used).toBe(0);
  });

  it('treats a record from an unknown schema or an older build as empty', () => {
    const storage = new WebStorage();
    const subject = quota(storage);
    subject.take('acc-1', 'runs');
    const [file] = storage.listRecords(['usage']);
    const view = subject.view('acc-1');
    // A record missing a kind added later still reads as zero for that kind.
    storage.saveRecord(['usage', file!], { schema: 'theorem-os.web-usage.v1', accountId: 'hash', windowStart: Date.now(), counts: { runs: 1 } });
    expect(subject.view('acc-1').formalizations.used).toBe(0);
    expect(subject.view('acc-1').runs.used).toBe(1);
    storage.saveRecord(['usage', file!], { schema: 'something-else', accountId: 'hash', windowStart: Date.now(), counts: { runs: 1 } });
    expect(subject.view('acc-1').runs.used).toBe(0);
    expect(view.windowHours).toBe(2);
  });

  it('names the allowance without an account, and ships defaults that allow some work', () => {
    const subject = quota(new WebStorage());
    expect(subject.settings()).toEqual({ windowHours: 2, limits: { research: 2, formalizations: 1, explanations: 0 } });
    expect(webQuotaDefaults).toEqual({ windowHours: 24, runs: 30, formalizations: 8, explanations: 4 });
    expect(Object.isFrozen(webQuotaDefaults)).toBe(true);
  });
});
