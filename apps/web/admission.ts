/** Login-page sessions cost a slot even before authentication. Bound new sessions per visitor, independently of API reads. */
type Session = { id: string; touchedAt: number; account?: unknown };
const windowMs = 10 * 60_000, perIp = 30, anonymousLimit = 200, sessionLimit = 2_000;

export class WebAdmissionError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export class WebSessionAdmission {
  private readonly visitors = new Map<string, { count: number; endsAt: number }>();
  /** Anonymous local previews own runs; only login-page sessions may be displaced. */
  constructor(private readonly replaceAnonymous = true) {}

  prune(now = Date.now()) {
    for (const [ip, entry] of this.visitors) if (entry.endsAt <= now) this.visitors.delete(ip);
  }

  /** Returns the oldest anonymous session to release, if needed; authenticated sessions are never displaced. */
  admit(ip: string, sessions: Iterable<Session>, now = Date.now()): string | undefined {
    this.prune(now);
    const visitor = this.visitors.get(ip);
    if (visitor && visitor.count >= perIp) throw new WebAdmissionError(429, '登录页面打开过于频繁，请十分钟后重试。');
    if (!visitor && this.visitors.size >= 2_000) throw new WebAdmissionError(429, '请求较多，请稍后重试。');
    let total = 0, anonymous = 0, oldest: Session | undefined;
    for (const session of sessions) {
      total++;
      if (session.account) continue;
      anonymous++;
      if (!oldest || session.touchedAt < oldest.touchedAt) oldest = session;
    }
    const full = anonymous >= anonymousLimit || total >= sessionLimit;
    if (full && (!oldest || !this.replaceAnonymous)) throw new WebAdmissionError(503, '当前会话数已满，请稍后重试。');
    this.visitors.set(ip, { count: (visitor?.count ?? 0) + 1, endsAt: visitor?.endsAt ?? now + windowMs });
    return full ? oldest?.id : undefined;
  }
}
