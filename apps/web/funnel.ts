import type { WebAccount } from './auth';

/**
 * Closed-beta funnel totals: applications → allowlisted → first login → first submitted run → first accepted run.
 * scripts/web-funnel.ts prints it from the data root; the admin dialog shows the same numbers. Never an address.
 */
export type WebFunnelStep = { step: string; count: number; ofPrevious?: number };
export type WebFunnel = { steps: WebFunnelStep[]; medianHours: { loginToRun?: number; runToAccepted?: number } };

const hours = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / 3_600_000;
const median = (values: number[]) => {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1;
  const value = sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return Math.round(value * 10) / 10;
};

export function webFunnel(accounts: WebAccount[], allowlist: Set<string>, applications?: number): WebFunnel {
  // Accounts whose address left the allowlist still count: they were admitted and logged in.
  const admitted = new Set([...allowlist, ...accounts.map(account => account.email)]);
  const ran = accounts.filter(account => account.firstRunAt), accepted = ran.filter(account => account.firstAcceptedAt);
  const counts: [string, number][] = [
    ...(applications === undefined ? [] : [['applied', applications] as [string, number]]),
    ['allowlisted', admitted.size], ['logged_in', accounts.length], ['submitted', ran.length], ['accepted', accepted.length],
  ];
  const steps = counts.map(([step, count], index) => {
    const previous = index ? counts[index - 1]![1] : undefined;
    return { step, count, ...(previous ? { ofPrevious: Math.round(count / previous * 1000) / 10 } : {}) };
  });
  return { steps, medianHours: {
    loginToRun: median(ran.map(account => hours(account.createdAt, account.firstRunAt!))),
    runToAccepted: median(accepted.map(account => hours(account.firstRunAt!, account.firstAcceptedAt!))),
  } };
}
