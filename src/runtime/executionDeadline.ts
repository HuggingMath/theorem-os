/** A finite execution allowance that excludes time explicitly spent waiting for a person. */
export class ExecutionDeadline {
  private timer?: ReturnType<typeof setTimeout>;
  private activeSince = Date.now();
  private usedMs = 0;
  private waitedMs = 0;
  private waitingSince?: number;
  private stopped = false;

  constructor(private readonly limitMs: number, private readonly expire: () => void) { this.arm(); }

  get waiting() { return this.waitingSince !== undefined; }
  executionMs() { return this.usedMs + (this.stopped || this.waiting ? 0 : Math.max(0, Date.now() - this.activeSince)); }
  waitingMs() { return this.waitedMs + (this.waitingSince === undefined ? 0 : Math.max(0, Date.now() - this.waitingSince)); }
  remainingMs() { return Math.max(0, this.limitMs - this.executionMs()); }

  setWaiting(waiting: boolean) {
    if (this.stopped || waiting === this.waiting) return;
    const now = Date.now();
    if (waiting) {
      this.usedMs = this.executionMs();
      clearTimeout(this.timer);
      // A late pause must not revive an execution allowance that already ran out.
      if (this.usedMs >= this.limitMs) { this.stopped = true; this.expire(); return; }
      this.waitingSince = now;
    } else {
      this.waitedMs = this.waitingMs();
      this.waitingSince = undefined;
      this.activeSince = now;
      this.arm();
    }
  }

  stop() {
    if (this.stopped) return;
    this.usedMs = this.executionMs();
    this.waitedMs = this.waitingMs();
    this.waitingSince = undefined;
    this.stopped = true;
    clearTimeout(this.timer);
  }

  private arm() {
    if (Number.isFinite(this.limitMs)) this.timer = setTimeout(() => { this.stop(); this.expire(); }, this.remainingMs());
  }
}
