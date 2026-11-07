import { describe, expect, it } from 'vitest';
import { WebSessionAdmission } from '../apps/web/admission';

describe('login session admission', () => {
  it('limits fresh sessions from one visitor without locking out another visitor', () => {
    const admission = new WebSessionAdmission();
    for (let index = 0; index < 30; index++) expect(admission.admit('visitor-one', [], 1_000)).toBeUndefined();
    expect(() => admission.admit('visitor-one', [], 1_000)).toThrow(/十分钟/u);
    expect(admission.admit('visitor-two', [], 1_000)).toBeUndefined();
    expect(admission.admit('visitor-one', [], 601_000)).toBeUndefined();
  });

  it('replaces only the oldest anonymous session when abandoned login pages fill the pool', () => {
    const sessions = [{ id: 'signed-in', touchedAt: 0, account: { id: 'owner' } },
      ...Array.from({ length: 200 }, (_, i) => ({ id: `visitor-${i}`, touchedAt: i + 1 }))];
    expect(new WebSessionAdmission().admit('new-visitor', sessions)).toBe('visitor-0');
    expect(sessions).toHaveLength(201);
  });

  it('never evicts an account session when authenticated capacity is full', () => {
    const sessions = Array.from({ length: 2_000 }, (_, i) => ({ id: `account-${i}`, touchedAt: i, account: { id: `owner-${i}` } }));
    expect(() => new WebSessionAdmission().admit('new-visitor', sessions)).toThrow(/会话数已满/u);
  });

  it('keeps anonymous local-preview sessions because those sessions own runs', () => {
    const sessions = Array.from({ length: 200 }, (_, i) => ({ id: `preview-${i}`, touchedAt: i }));
    expect(() => new WebSessionAdmission(false).admit('new-visitor', sessions)).toThrow(/会话数已满/u);
  });
});
