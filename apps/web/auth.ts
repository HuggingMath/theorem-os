import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import type { WebStorage } from './storage';

export type WebAuthConfig = { smtpUrl: string; from: string; allowlist: string[]; allowlistFile?: string };
export type WebAccount = { id: string; email: string; createdAt: string };
export type WebMailer = (message: { to: string; subject: string; text: string }) => Promise<void>;
export class WebAuthError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const codeTtlMs = 10 * 60_000, captchaTtlMs = 5 * 60_000, resendAfterMs = 60_000;
const emailPattern = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
export const normalizeEmail = (value: unknown) => {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (email.length > 254 || !emailPattern.test(email)) throw new WebAuthError(400, '请输入有效的邮箱地址。');
  return email;
};

/** Seven-segment strokes on a 20×36 cell; jitter and noise keep the answer out of the markup. */
const segments: Record<string, [number, number, number, number][]> = {
  a: [[2, 2, 18, 2]], b: [[18, 2, 18, 18]], c: [[18, 18, 18, 34]], d: [[2, 34, 18, 34]], e: [[2, 18, 2, 34]], f: [[2, 2, 2, 18]], g: [[2, 18, 18, 18]],
};
const digits = ['abcdef', 'bc', 'abged', 'abgcd', 'fgbc', 'afgcd', 'afgedc', 'abc', 'abcdefg', 'abcdfg'];
const random = (min: number, max: number) => min + crypto.randomInt(0, 10_000) / 10_000 * (max - min);
export function captchaImage(answer: string): string {
  const width = 36 + answer.length * 30, height = 56, parts: string[] = [];
  for (let line = 0; line < 4; line++)
    parts.push(`<path d="M${random(0, 20).toFixed(1)} ${random(4, 52).toFixed(1)} Q${random(30, width - 30).toFixed(1)} ${random(0, 56).toFixed(1)} ${random(width - 20, width).toFixed(1)} ${random(4, 52).toFixed(1)}" stroke="#a8a294" stroke-width="1.4" fill="none"/>`);
  [...answer].forEach((digit, index) => {
    const x = 20 + index * 30 + random(-3, 3), y = 10 + random(-3, 3), angle = random(-14, 14).toFixed(1);
    const strokes = [...digits[Number(digit)]!].flatMap(name => segments[name]!).map(([x1, y1, x2, y2]) =>
      `M${(x1 + random(-1.6, 1.6)).toFixed(1)} ${(y1 + random(-1.6, 1.6)).toFixed(1)}L${(x2 + random(-1.6, 1.6)).toFixed(1)} ${(y2 + random(-1.6, 1.6)).toFixed(1)}`).join('');
    parts.push(`<path transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${angle} 10 18) skewX(${random(-10, 10).toFixed(1)})" d="${strokes}" stroke="#292824" stroke-width="${random(2.6, 3.4).toFixed(1)}" stroke-linecap="round" fill="none"/>`);
  });
  for (let dot = 0; dot < 24; dot++)
    parts.push(`<circle cx="${random(0, width).toFixed(1)}" cy="${random(0, height).toFixed(1)}" r="${random(.6, 1.6).toFixed(1)}" fill="#8f897b"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#f3f1ea"/>${parts.join('')}</svg>`;
}

export function smtpMailer(config: WebAuthConfig): WebMailer {
  // A loopback-only development transport: the code goes to the server log instead of an inbox.
  if (config.smtpUrl === 'log:') return async message => { console.error(`[login code] ${message.to}: ${message.text.match(/\b\d{6}\b/u)?.[0]}`); };
  const transport = nodemailer.createTransport(config.smtpUrl);
  return async message => { await transport.sendMail({ from: config.from, ...message }); };
}

type Limit = { times: number[] };
export class WebAuth {
  private readonly secret = crypto.randomBytes(32);
  private readonly captchas = new Map<string, { answer: string; expiresAt: number }>();
  private readonly codes = new Map<string, { digest: Buffer; expiresAt: number; attempts: number; sentAt: number }>();
  private readonly limits = new Map<string, Limit>();

  constructor(private readonly config: WebAuthConfig, private readonly storage: WebStorage,
    private readonly mailer: WebMailer = smtpMailer(config),
    private readonly answer: () => string = () => String(crypto.randomInt(0, 100_000)).padStart(5, '0')) {}

  /** Sliding-window counter; returns false once `max` events already fall inside `windowMs`. */
  private allow(key: string, max: number, windowMs: number): boolean {
    const now = Date.now(), limit = this.limits.get(key) ?? { times: [] };
    limit.times = limit.times.filter(time => now - time < windowMs);
    if (limit.times.length >= max) { this.limits.set(key, limit); return false; }
    limit.times.push(now); this.limits.set(key, limit); return true;
  }
  private digest(email: string, code: string) { return crypto.createHmac('sha256', this.secret).update(`${email}\n${code}`).digest(); }
  prune() {
    const now = Date.now();
    for (const [id, captcha] of this.captchas) if (captcha.expiresAt <= now) this.captchas.delete(id);
    for (const [email, code] of this.codes) if (code.expiresAt <= now) this.codes.delete(email);
    for (const [key, limit] of this.limits) if (limit.times.every(time => now - time > 60 * 60_000)) this.limits.delete(key);
  }

  allowed(email: string): boolean {
    const file = this.config.allowlistFile && fs.existsSync(this.config.allowlistFile)
      ? fs.readFileSync(this.config.allowlistFile, 'utf8').split('\n') : [];
    return [...this.config.allowlist, ...file].map(line => line.replace(/#.*/u, '').trim().toLowerCase()).includes(email);
  }

  captcha(ip: string): { id: string; image: string } {
    if (!this.allow(`captcha:${ip}`, 30, 10 * 60_000) || this.captchas.size >= 5_000) throw new WebAuthError(429, '请求过于频繁，请稍后重试。');
    const id = crypto.randomUUID(), answer = this.answer();
    this.captchas.set(id, { answer, expiresAt: Date.now() + captchaTtlMs });
    return { id, image: `data:image/svg+xml;base64,${Buffer.from(captchaImage(answer)).toString('base64')}` };
  }

  async requestCode(ip: string, body: { email?: unknown; captchaId?: unknown; captcha?: unknown }) {
    if (!this.allow(`code-ip:${ip}`, 10, 10 * 60_000)) throw new WebAuthError(429, '请求过于频繁，请稍后重试。');
    const captcha = typeof body.captchaId === 'string' ? this.captchas.get(body.captchaId) : undefined;
    if (captcha && typeof body.captchaId === 'string') this.captchas.delete(body.captchaId);
    if (!captcha || captcha.expiresAt <= Date.now() || String(body.captcha ?? '').trim() !== captcha.answer)
      throw new WebAuthError(400, '图形验证码不正确或已过期，请换一张重试。');
    const email = normalizeEmail(body.email);
    if (!this.allowed(email)) throw new WebAuthError(403, '这个邮箱还没有内测资格。请先申请内测，通过后再登录。');
    const previous = this.codes.get(email);
    if (previous && Date.now() - previous.sentAt < resendAfterMs) throw new WebAuthError(429, '验证码刚刚发送过，请稍后再试。');
    if (!this.allow(`code-email:${email}`, 5, 60 * 60_000)) throw new WebAuthError(429, '这个邮箱的验证码请求过多，请一小时后再试。');
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    try {
      await this.mailer({ to: email, subject: `TheoremOS 登录验证码 ${code}`,
        text: `你的 TheoremOS 登录验证码是 ${code}，10 分钟内有效。\n如果不是你本人操作，请忽略这封邮件。\n\nYour TheoremOS login code is ${code}. It expires in 10 minutes.\n` });
    } catch { throw new WebAuthError(502, '验证码邮件发送失败，请稍后重试。'); }
    this.codes.set(email, { digest: this.digest(email, code), expiresAt: Date.now() + codeTtlMs, attempts: 0, sentAt: Date.now() });
    return { email, expiresInSeconds: codeTtlMs / 1000, resendAfterSeconds: resendAfterMs / 1000 };
  }

  verifyCode(body: { email?: unknown; code?: unknown }): WebAccount {
    const email = normalizeEmail(body.email), pending = this.codes.get(email);
    if (!pending || pending.expiresAt <= Date.now()) throw new WebAuthError(400, '验证码已过期，请重新获取。');
    const code = String(body.code ?? '').trim();
    if (!/^\d{6}$/u.test(code) || !crypto.timingSafeEqual(pending.digest, this.digest(email, code))) {
      if (++pending.attempts >= 5) { this.codes.delete(email); throw new WebAuthError(400, '验证码错误次数过多，请重新获取。'); }
      throw new WebAuthError(400, '验证码不正确。');
    }
    this.codes.delete(email);
    // Removing an address from the allowlist also blocks its next login.
    if (!this.allowed(email)) throw new WebAuthError(403, '这个邮箱还没有内测资格。请先申请内测，通过后再登录。');
    return this.account(email);
  }

  private accountPath(email: string) { return ['accounts', `${crypto.createHash('sha256').update(email).digest('hex')}.json`]; }
  private account(email: string): WebAccount {
    const existing = this.storage.getRecord<WebAccount>(this.accountPath(email));
    if (existing) return existing;
    const account = { id: crypto.randomUUID(), email, createdAt: new Date().toISOString() };
    this.storage.saveRecord(this.accountPath(email), account);
    return account;
  }
  getAccount(email: string): WebAccount | undefined { return this.storage.getRecord(this.accountPath(email)); }
  deleteAccount(email: string) { this.storage.deleteRecord(this.accountPath(email)); this.codes.delete(email); }
}

export const allowlistFile = (dataRoot?: string) => dataRoot ? path.join(dataRoot, 'allowlist.txt') : undefined;
