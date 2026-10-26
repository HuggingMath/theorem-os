import { describe, expect, it } from 'vitest';
import type { WebAccount } from '../apps/web/auth';
import { formatWebFunnel, webFunnel } from '../scripts/web-funnel';

const account = (email: string, createdAt: string, firstRunAt?: string, firstAcceptedAt?: string): WebAccount =>
  ({ id: email, email, createdAt, ...(firstRunAt ? { firstRunAt } : {}), ...(firstAcceptedAt ? { firstAcceptedAt } : {}) });

describe('closed-beta funnel report', () => {
  const accounts = [
    account('a@example.org', '2026-11-01T00:00:00Z', '2026-11-01T02:00:00Z', '2026-11-01T03:00:00Z'),
    account('b@example.org', '2026-11-01T00:00:00Z', '2026-11-01T06:00:00Z'),
    account('c@example.org', '2026-11-02T00:00:00Z'),
    // Removed from the allowlist after logging in; still counted as admitted.
    account('d@example.org', '2026-11-02T00:00:00Z'),
  ];
  const allowlist = new Set(['a@example.org', 'b@example.org', 'c@example.org', 'e@example.org']);

  it('counts each step with its share of the previous one and the median time between milestones', () => {
    expect(webFunnel(accounts, allowlist, 10)).toEqual({
      steps: [
        { step: 'applied', count: 10 },
        { step: 'allowlisted', count: 5, ofPrevious: 50 },
        { step: 'logged_in', count: 4, ofPrevious: 80 },
        { step: 'submitted', count: 2, ofPrevious: 50 },
        { step: 'accepted', count: 1, ofPrevious: 50 },
      ],
      medianHours: { loginToRun: 4, runToAccepted: 1 },
    });
  });

  it('starts at the allowlist without an application count, and prints totals without any address', () => {
    const funnel = webFunnel(accounts, allowlist);
    expect(funnel.steps[0]).toEqual({ step: 'allowlisted', count: 5 });
    const text = formatWebFunnel(funnel);
    expect(text).toMatch(/首次通过验收\s+1\s+50%/u);
    expect(text).not.toMatch(/@/u);
    expect(webFunnel([], new Set()).steps.map(step => step.count)).toEqual([0, 0, 0, 0]);
  });
});
