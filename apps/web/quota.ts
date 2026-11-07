import crypto from 'node:crypto';
import type { WebQuotaUsage, WebQuotaView } from './shared';
import type { WebStorage } from './storage';

/**
 * What one account may start in a fixed window, without payment. Counts are per account and per kind: a request that
 * the service refuses never spends one, and a run that fails still does, so the ledger records attempts rather than
 * successes. Providers are paid with the account's own API key, so this bounds how much work the service itself does.
 */
export const webQuotaKinds = ['runs', 'formalizations', 'explanations'] as const;
export type WebQuotaKind = (typeof webQuotaKinds)[number];
export type WebQuotaLimits = { windowHours: number } & Record<WebQuotaKind, number>;
/** Zero turns a kind off for non-admin accounts. */
export const webQuotaDefaults: WebQuotaLimits = Object.freeze({ windowHours: 24, runs: 30, formalizations: 8, explanations: 4 });

const schema = 'theorem-os.web-usage.v1';
type UsageRecord = { schema: typeof schema; accountId: string; windowStart: number; counts: Record<WebQuotaKind, number> };
export class WebQuotaError extends Error {
  constructor(readonly kind: WebQuotaKind, readonly status: number, message: string) { super(message); }
}
const empty = (accountId: string, windowStart = Date.now()): UsageRecord =>
  ({ schema, accountId, windowStart, counts: { runs: 0, formalizations: 0, explanations: 0 } });

export class WebQuota {
  constructor(private readonly storage: WebStorage, private readonly limits: WebQuotaLimits = webQuotaDefaults) {}

  private windowMs() { return this.limits.windowHours * 60 * 60_000; }
  private path(accountId: string) { return ['usage', `${crypto.createHash('sha256').update(accountId).digest('hex')}.json`]; }
  /** The current record; a window that has run out starts again at zero. */
  private read(accountId: string): UsageRecord {
    const stored = this.storage.getRecord<UsageRecord>(this.path(accountId));
    if (!stored || stored.schema !== schema) return empty(accountId);
    if (Date.now() - stored.windowStart >= this.windowMs()) return empty(accountId);
    // A record written by an older build may lack a kind added later.
    return { ...stored, counts: { ...empty(accountId).counts, ...stored.counts } };
  }
  private write(record: UsageRecord) { this.storage.saveRecord(this.path(record.accountId), record); }

  /** The allowance itself, without an account: what the admin dialog names above its per-account counts. */
  settings(): { windowHours: number; limits: { research: number; formalizations: number; explanations: number } } {
    return { windowHours: this.limits.windowHours,
      limits: { research: this.limits.runs, formalizations: this.limits.formalizations, explanations: this.limits.explanations } };
  }
  /** What is left in the current window; also what the account is told in its session and the admin list. */
  view(accountId: string): WebQuotaView {
    const record = this.read(accountId);
    const usage = (kind: WebQuotaKind): WebQuotaUsage => ({ used: record.counts[kind], limit: this.limits[kind] });
    return { windowHours: this.limits.windowHours,
      windowEndsAt: new Date(record.windowStart + this.windowMs()).toISOString(),
      runs: usage('runs'), formalizations: usage('formalizations'), explanations: usage('explanations') };
  }
  /**
   * Counts one use of `kind`, or refuses it once the window's allowance is gone. Count before the work starts, so two
   * requests in a row cannot both pass on the last unit.
   */
  take(accountId: string, kind: WebQuotaKind): void {
    const limit = this.limits[kind];
    if (!(limit > 0)) throw this.refuse(kind);
    const record = this.read(accountId);
    if (record.counts[kind] >= limit) throw this.refuse(kind);
    record.counts[kind] += 1;
    this.write(record);
  }
  /** The refusal the account sees; the limit and window are read from the configured allowance, not the request. */
  private refuse(kind: WebQuotaKind): WebQuotaError {
    const limit = this.limits[kind], hours = this.limits.windowHours;
    if (kind === 'runs') return new WebQuotaError(kind, 429, `已达到每 ${hours} 小时 ${limit} 次研究的额度。已开始的运行不受影响；额度会在窗口结束后恢复。`);
    if (kind === 'formalizations') return new WebQuotaError(kind, 429, `已达到每 ${hours} 小时 ${limit} 次形式化的额度。已开始的形式化不受影响；额度会在窗口结束后恢复。`);
    return new WebQuotaError(kind, 429, `已达到每 ${hours} 小时 ${limit} 份证明讲解的额度。已开始的不受影响；额度会在窗口结束后恢复。`);
  }
  /** Gives a unit back when the work it was counted for never started; it never raises a count above zero. */
  refund(accountId: string, kind: WebQuotaKind): void {
    const record = this.read(accountId);
    if (record.counts[kind] <= 0) return;
    record.counts[kind] -= 1;
    this.write(record);
  }
  /** Goes with the account: a new account with the same id never sees the old counts (ids are fresh anyway). */
  forget(accountId: string) { this.storage.deleteRecord(this.path(accountId)); }
}
