import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import type { WebStorage } from './storage';
import { accountLogin, type WebAccountIdentity } from './shared';

/**
 * `admins` may always sign in and manage the allowlist file; they see no other account's runs.
 * `signup: 'open'` admits every valid email that can receive a code; the allowlist then only marks how an address
 * arrived. `termsVersion` names the terms an account has to accept when it first signs in.
 */
export type WebAuthConfig = { smtpUrl: string; from: string; allowlist: string[]; allowlistFile?: string; admins?: string[];
  signup?: WebSignupMode; termsVersion?: string };
export type WebSignupMode = 'allowlist' | 'open';
/** Where an address is admitted from: only `file` entries can be removed in the workbench. */
export type WebAllowlistEntry = { email: string; source: 'admin' | 'config' | 'file' };
/**
 * `createdAt` is account creation. The two milestones record when the account first submitted a run and first had one pass
 * acceptance; scripts/web-funnel.ts reports them only as totals, and they go with the account when it is deleted.
 * `completionEmail: false` turns off the mail sent when a run ends; absent means on.
 */
export type WebAccount = WebAccountIdentity & { id: string; createdAt: string; firstLoginAt?: string; firstRunAt?: string; firstAcceptedAt?: string; completionEmail?: boolean;
  /** When this account accepted the terms, and which version; an open signup records it before the account exists. */
  termsAt?: string; termsVersion?: string; suspendedAt?: string };
export type WebMilestone = 'firstRunAt' | 'firstAcceptedAt';
export type WebMailer = (message: { to: string; subject: string; text: string }) => Promise<void>;
export class WebAuthError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const codeTtlMs = 10 * 60_000, captchaTtlMs = 5 * 60_000, resendAfterMs = 60_000;
type PasswordRecord = { algorithm: 'scrypt'; salt: string; digest: string };
const samePasswordRecord = (a?: PasswordRecord, b?: PasswordRecord) => a?.salt === b?.salt && a?.digest === b?.digest;
const derivePassword = (password: string, salt: Buffer) => new Promise<Buffer>((resolve, reject) =>
  crypto.scrypt(password, salt, 64, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
    (error, key) => error ? reject(error) : resolve(key)));
const validPassword = (value: unknown): value is string =>
  typeof value === 'string' && value.length >= 12 && Buffer.byteLength(value, 'utf8') <= 256;
const emailPattern = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;
export const normalizeEmail = (value: unknown) => {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (email.length > 254 || !emailPattern.test(email)) throw new WebAuthError(400, '请输入有效的邮箱地址。');
  return email;
};
export const normalizeLogin = (value: unknown): string => {
  const login = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (login.includes('@')) return normalizeEmail(login);
  if (!/^[a-z][a-z0-9_-]{2,31}$/u.test(login))
    throw new WebAuthError(400, '用户名需为 3–32 位，以字母开头，仅包含字母、数字、下划线或连字符。');
  return login;
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

  /** Allowlisted addresses from the environment and the allowlist file, which is read on every call. */
  allowlist(): Set<string> {
    return new Set([...this.admins(), ...this.config.allowlist, ...this.fileEntries()]);
  }
  /** True when this address may sign in: an open signup takes any address, otherwise only the allowlist does. */
  allowed(login: string): boolean {
    if (this.isAdmin(login)) return true;
    const account = this.getAccount(login);
    if (account?.suspendedAt) return false;
    if (!login.includes('@')) return Boolean(account?.username);
    return this.config.signup === 'open' || this.allowlist().has(login);
  }
  admins(): Set<string> { return new Set(this.config.admins ?? []); }
  isAdmin(email: string): boolean { return this.admins().has(email); }
  /** `open` when anyone may register; the login page says so. */
  signup(): WebSignupMode { return this.config.signup ?? 'allowlist'; }
  /** The terms version a new account accepts; absent when the service does not ask. */
  get termsVersion(): string | undefined { return this.config.termsVersion; }
  needsTerms(email: string): boolean {
    return Boolean(this.termsVersion && this.getAccount(email)?.termsVersion !== this.termsVersion);
  }
  private checkTerms(body: { terms?: unknown; termsVersion?: unknown }, account?: WebAccount): string | undefined {
    const version = this.termsVersion;
    if (!version || account?.termsVersion === version) return undefined;
    if (body.terms !== true) throw new WebAuthError(400, '请先阅读并同意使用条款与隐私说明。');
    if (body.termsVersion !== version) throw new WebAuthError(428, '使用条款已更新，请刷新页面后重新确认。');
    return version;
  }
  /** A signed-in account can accept the current terms without losing its running work or verifying its inbox again. */
  acceptTerms(login: string, body: { terms?: unknown; termsVersion?: unknown }): WebAccount {
    const account = this.getAccount(login);
    if (!account || !this.allowed(login)) throw new WebAuthError(403, '这个账号目前无法使用，请联系支持。');
    const version = this.checkTerms(body, account);
    return this.recordTerms(account, version);
  }
  /** Suspension keeps records for restoration, blocks both login methods and invalidates admission on the next request. */
  setSuspended(value: unknown, suspended: boolean): WebAccount {
    const login = normalizeLogin(value), account = this.getAccount(login);
    if (!account) throw new WebAuthError(404, '账号不存在。');
    if (this.isAdmin(login) && suspended) throw new WebAuthError(400, '管理员账号不能暂停。');
    const { suspendedAt: _previous, ...rest } = account;
    const updated = suspended ? { ...rest, suspendedAt: account.suspendedAt ?? new Date().toISOString() } : rest;
    this.storage.saveRecord(this.accountPath(login), updated);
    if (suspended) this.codes.delete(login);
    return updated;
  }
  private fileLines(): string[] {
    const file = this.config.allowlistFile;
    const lines = file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : [];
    while (lines.length && !lines.at(-1)!.trim()) lines.pop();
    return lines;
  }
  private fileEntries(): string[] { return this.fileLines().map(line => line.replace(/#.*/u, '').trim().toLowerCase()).filter(Boolean); }
  /** Each admitted address once, with the most fixed source: an admin, then the environment, then the file. */
  allowlistEntries(): WebAllowlistEntry[] {
    const entries = new Map<string, WebAllowlistEntry['source']>();
    for (const email of this.fileEntries()) entries.set(email, 'file');
    for (const email of this.config.allowlist) entries.set(email, 'config');
    for (const email of this.admins()) entries.set(email, 'admin');
    return [...entries].map(([email, source]) => ({ email, source })).sort((a, b) => a.email.localeCompare(b.email));
  }
  /** Appends an address to the allowlist file; comments and other lines are kept as written. */
  addToAllowlist(value: unknown): WebAllowlistEntry {
    const email = normalizeEmail(value), file = this.writableFile();
    const existing = this.allowlistEntries().find(entry => entry.email === email);
    if (existing) return existing;
    this.writeFile(file, [...this.fileLines(), email]);
    return { email, source: 'file' };
  }
  /** Removes every file line for the address; an admin or environment entry cannot be removed here. */
  removeFromAllowlist(value: unknown) {
    const email = normalizeEmail(value), file = this.writableFile();
    const source = this.allowlistEntries().find(entry => entry.email === email)?.source;
    if (!source) throw new WebAuthError(404, '这个邮箱不在白名单中。');
    if (source !== 'file') throw new WebAuthError(409, '这个邮箱由服务配置加入，需要在部署配置中移除。');
    this.writeFile(file, this.fileLines().filter(line => line.replace(/#.*/u, '').trim().toLowerCase() !== email));
    this.codes.delete(email);
  }
  allowlistWritable(): boolean { return Boolean(this.config.allowlistFile); }
  private writableFile(): string {
    if (!this.config.allowlistFile) throw new WebAuthError(409, '服务没有配置白名单文件，无法在线修改。');
    return this.config.allowlistFile;
  }
  /** Written beside the target and renamed, so a concurrent login never reads half a file. */
  private writeFile(file: string, lines: string[]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temporary, lines.length ? `${lines.join('\n')}\n` : '', { mode: 0o600 });
    fs.renameSync(temporary, file);
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
    if (!this.allowed(email)) throw new WebAuthError(403, this.getAccount(email)?.suspendedAt
      ? '这个账号目前无法使用，请联系支持。' : '这个邮箱还没有内测资格。请先申请内测，通过后再登录。');
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

  /** `terms` is the signup form's checkbox; an open signup requires it before the account exists. */
  verifyCode(body: { email?: unknown; code?: unknown; terms?: unknown; termsVersion?: unknown }): WebAccount {
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
    // The terms are accepted before the account is created, so no account exists without a record of consent.
    return this.account(email, this.checkTerms(body, this.getAccount(email)));
  }

  private accountPath(login: string) { return ['accounts', `${crypto.createHash('sha256').update(login).digest('hex')}.json`]; }
  private recordTerms(account: WebAccount, termsVersion?: string): WebAccount {
    if (!termsVersion || account.termsVersion === termsVersion) return account;
    const updated = { ...account, termsAt: new Date().toISOString(), termsVersion };
    this.storage.saveRecord(this.accountPath(accountLogin(account)), updated);
    return updated;
  }
  private account(email: string, termsVersion?: string): WebAccount {
    const existing = this.storage.getRecord<WebAccount>(this.accountPath(email));
    // An account that signed in before the terms existed records them at its next code login.
    if (existing) return this.recordTerms(existing, termsVersion);
    const account = { id: crypto.randomUUID(), email, createdAt: new Date().toISOString(),
      ...(termsVersion ? { termsAt: new Date().toISOString(), termsVersion } : {}) };
    this.storage.saveRecord(this.accountPath(email), account);
    return account;
  }
  /** Local operator provisioning only; there is no HTTP username signup endpoint. */
  async createUsernameAccount(value: unknown, password: unknown): Promise<WebAccount> {
    const username = normalizeLogin(value);
    if (username.includes('@')) throw new WebAuthError(400, '请输入用户名，不要使用邮箱地址。');
    if (!validPassword(password)) throw new WebAuthError(400, '密码至少 12 位且不超过 256 字节。');
    if (this.getAccount(username)) throw new WebAuthError(409, '这个用户名已存在。');
    const salt = crypto.randomBytes(16), digest = await derivePassword(password, salt);
    const account: WebAccount = { id: crypto.randomUUID(), username, createdAt: new Date().toISOString(), completionEmail: false };
    const passwordPath = this.passwordPath(username);
    if (!this.storage.createRecord(passwordPath, { algorithm: 'scrypt', salt: salt.toString('hex'), digest: digest.toString('hex') } satisfies PasswordRecord))
      throw new WebAuthError(409, '这个用户名已存在。');
    try {
      if (!this.storage.createRecord(this.accountPath(username), account)) throw new WebAuthError(409, '这个用户名已存在。');
    } catch (error) {
      this.storage.deleteRecord(passwordPath);
      throw error;
    }
    return account;
  }
  getAccount(login: string): WebAccount | undefined { return this.storage.getRecord(this.accountPath(login)); }
  private passwordPath(login: string) { return ['passwords', this.accountPath(login)[1]!]; }
  private passwordRecord(login: string): PasswordRecord | undefined {
    const record = this.storage.getRecord<PasswordRecord>(this.passwordPath(login));
    return record?.algorithm === 'scrypt' && /^[a-f0-9]{32}$/u.test(record.salt) && /^[a-f0-9]{128}$/u.test(record.digest)
      ? record : undefined;
  }
  hasPassword(login: string): boolean { return Boolean(this.passwordRecord(login)); }
  private async matchesPassword(value: string, record?: PasswordRecord): Promise<boolean> {
    const salt = record ? Buffer.from(record.salt, 'hex') : Buffer.alloc(16);
    const expected = record ? Buffer.from(record.digest, 'hex') : Buffer.alloc(64);
    const actual = await derivePassword(value, salt);
    return Boolean(record) && crypto.timingSafeEqual(actual, expected);
  }
  async loginPassword(ip: string, body: { login?: unknown; username?: unknown; email?: unknown; password?: unknown; terms?: unknown; termsVersion?: unknown }, authorize?: () => void): Promise<WebAccount> {
    const login = normalizeLogin(body.login ?? body.username ?? body.email);
    if (!this.allow('password-ip:' + ip, 20, 60 * 60_000) || !this.allow('password-email:' + login, 5, 60 * 60_000))
      throw new WebAuthError(429, login.includes('@') ? '密码尝试过多，请一小时后再试，或使用邮箱验证码登录。' : '密码尝试过多，请一小时后再试。');
    if (typeof body.password !== 'string' || Buffer.byteLength(body.password, 'utf8') > 256)
      throw new WebAuthError(401, login.includes('@') ? '邮箱或密码不正确。' : '账号或密码不正确。');
    const initialAccount = this.getAccount(login), record = this.passwordRecord(login);
    const matches = await this.matchesPassword(body.password, record);
    authorize?.();
    const account = this.getAccount(login);
    if (!matches || !account || account.id !== initialAccount?.id || !this.allowed(login)
      || !samePasswordRecord(record, this.passwordRecord(login)))
      throw new WebAuthError(401, login.includes('@') ? '邮箱或密码不正确。' : '账号或密码不正确。');
    const version = this.checkTerms(body, account);
    const admitted = this.recordTerms(account, version);
    if (admitted.username && !admitted.firstLoginAt) {
      const signedIn = { ...admitted, firstLoginAt: new Date().toISOString() };
      this.storage.saveRecord(this.accountPath(login), signedIn);
      return signedIn;
    }
    return admitted;
  }
  async setPassword(login: string, next: unknown, current: unknown, verifiedByEmail: boolean, authorize?: () => void) {
    const account = this.getAccount(login);
    if (!account) throw new WebAuthError(404, '账号不存在。');
    if (!validPassword(next)) throw new WebAuthError(400, '密码至少 12 位且不超过 256 字节。');
    if (!this.allow('password-change:' + login, 5, 60 * 60_000)) throw new WebAuthError(429, '密码修改过于频繁，请一小时后再试。');
    const record = this.passwordRecord(login);
    if (!(verifiedByEmail && account.email) && (!record || typeof current !== 'string' || !(await this.matchesPassword(current, record))))
      throw new WebAuthError(403, account.email ? '请输入当前密码；忘记密码请用邮箱验证码重新登录后设置。' : '请输入当前密码；忘记密码请联系管理员。');
    const salt = crypto.randomBytes(16);
    const digest = await derivePassword(next, salt);
    // Derivation yields; deletion, recreation or suspension must not leave a password written by the old session.
    authorize?.();
    if (this.getAccount(login)?.id !== account.id) throw new WebAuthError(404, '账号不存在。');
    if (!this.allowed(login)) throw new WebAuthError(403, '这个账号目前无法使用，请联系支持。');
    if (!samePasswordRecord(record, this.passwordRecord(login))) throw new WebAuthError(409, '密码已变更，请刷新页面后重试。');
    this.storage.saveRecord(this.passwordPath(login), { algorithm: 'scrypt', salt: salt.toString('hex'), digest: digest.toString('hex') } satisfies PasswordRecord);
  }
  /** Every account record; the funnel report and run milestones read these (a closed beta keeps the list short). */
  listAccounts(): WebAccount[] {
    return this.storage.listRecords(['accounts']).filter(file => /^[a-f0-9]{64}\.json$/u.test(file))
      .flatMap(file => this.storage.getRecord<WebAccount>(['accounts', file]) ?? []);
  }
  /** Stamps a milestone the first time it happens; later runs leave the first time unchanged. */
  markMilestone(accountId: string, milestone: WebMilestone, at = new Date().toISOString()) {
    const account = this.listAccounts().find(item => item.id === accountId);
    if (account && !account[milestone]) this.storage.saveRecord(this.accountPath(accountLogin(account)), { ...account, [milestone]: at });
  }
  /** The address to tell when a run ends, unless the account turned the mail off or lost its allowlist entry. */
  completionRecipient(accountId: string): string | undefined {
    const account = this.listAccounts().find(item => item.id === accountId);
    return account?.email && account.completionEmail !== false && this.allowed(account.email) ? account.email : undefined;
  }
  setCompletionEmail(login: string, enabled: boolean) {
    const account = this.getAccount(login);
    if (!account) throw new WebAuthError(404, '账号不存在。');
    if (!account.email && enabled) throw new WebAuthError(400, '用户名账号未绑定邮箱，无法开启邮件提醒。');
    const { completionEmail: _previous, ...rest } = account;
    this.storage.saveRecord(this.accountPath(login), enabled ? rest : { ...rest, completionEmail: false });
  }
  async sendCompletion(to: string, message: { subject: string; text: string }) { await this.mailer({ to, ...message }); }
  deleteAccount(login: string) {
    // Keep the account retryable if credential deletion fails; a recreated account must never inherit its password.
    this.storage.deleteRecord(this.passwordPath(login));
    this.storage.deleteRecord(this.accountPath(login));
    this.codes.delete(login);
  }
}

export const allowlistFile = (dataRoot?: string) => dataRoot ? path.join(dataRoot, 'allowlist.txt') : undefined;
