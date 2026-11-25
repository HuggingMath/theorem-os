import path from 'node:path';
import { isIP } from 'node:net';
import { z } from 'zod';
import { getLeanTaskEnvironment } from '../../src/math/leanTaskEnvironment';
import { webLimits, type WebEnvironment, type WebEnvironmentOption, type WebWorkerProvider, type WebTemplate } from './shared';
import { allowlistFile, normalizeEmail, type WebAuthConfig, type WebSignupMode } from './auth';
import { webQuotaDefaults, type WebQuotaLimits } from './quota';
import { cliConfigurationSchema } from '../../src/runtime/cliConfiguration';
import { researchExamples } from './problemExamples';
import { webTaskEnvironment, webTaskEnvironmentName, webTaskEnvironmentDescription } from './environment';

const providerSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  name: z.string().trim().min(1).max(80),
  baseUrl: z.string().url().max(512),
  harness: z.enum(['codex', 'claude-code', 'opencode', 'cli']).optional(),
  execution: z.object({ executable: z.string().min(1).max(4096).optional(), cli: cliConfigurationSchema.optional(),
    files: z.record(z.string().min(1).max(4096), z.string().max(256 * 1024)).refine(files => Object.keys(files).length <= 64).optional(),
    apiKeyEnvironment: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u).optional(),
    baseUrlEnvironment: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u).optional(),
  }).strict().optional(),
}).strict().superRefine((provider, ctx) => {
  if (provider.harness === 'cli' ? !provider.execution?.cli : provider.execution?.cli || provider.execution?.files ||
      provider.execution?.apiKeyEnvironment || provider.execution?.baseUrlEnvironment)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'CLI launch configuration requires a CLI provider.' });
  for (const name of Object.keys(provider.execution?.files ?? {})) if (path.isAbsolute(name) || name.split(/[\\/]/u).some(part => !part || part === '..' || part === '.') || name === 'cli.json')
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'CLI configuration file paths must be relative ordinary files.' });
  for (const name of [provider.execution?.apiKeyEnvironment, provider.execution?.baseUrlEnvironment].filter(Boolean))
    if (/^(?:HOME|PATH|TMPDIR|TMP|TEMP|ELAN_HOME|LAKE_HOME|LEAN_.+|XDG_.+|DEEPSCIENTIST_.+|THEOREMOS_.+)$/u.test(name!))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Runtime environment names are reserved.' });
});

export type WebConfig = {
  host: string;
  port: number;
  publicUrl: string;
  staticRoot: string;
  dataRoot?: string;
  workerImage: string;
  texImage: string;
  /** The git commit the image was built from (Dockerfile ARG), reported by /healthz; absent when unknown. */
  sourceCommit?: string;
  concurrency: number;
  queueLimit: number;
  sessionTtlMs: number;
  providers: WebWorkerProvider[];
  /** Operator-selected endpoints for particular accounts; keys remain bound to the account, provider and URL. */
  accountProviderUrls?: Record<string, Record<string, string>>;
  /** Present when every workbench request needs an email login; see `auth.signup` for who may register. */
  auth?: WebAuthConfig;
  /** What one account may start per window; absent when accounts do not exist (loopback preview). */
  quota?: WebQuotaLimits;
  /** A header set by the reverse proxy in front (e.g. cf-connecting-ip) that names the visitor for rate limits. */
  clientIpHeader?: string;
  /** Provider keys the server holds for admin accounts, by provider ID; never sent to a browser. */
  adminKeys?: Record<string, string>;
  /** 32 bytes that seal the API keys accounts choose to save (THEOREMOS_WEB_KEY_SECRET, 64 hex digits); absent turns saving off. */
  keySecret?: Buffer;
};

function integer(value: string | undefined, fallback: number, min: number, max: number, name = 'web service limit'): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`Invalid ${name}: expected an integer from ${min} to ${max}.`);
  return parsed;
}

function providerBaseUrl(value: string): string {
  const url = new URL(value), [first, second] = url.hostname.split('.').map(Number);
  const privateIPv4 = isIP(url.hostname) === 4 && (first === 10 || first === 172 && second >= 16 && second <= 31 || first === 192 && second === 168);
  const internalHttp = url.protocol === 'http:' && (url.hostname === 'host.docker.internal' || privateIPv4);
  if ((!internalHttp && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash)
    throw new Error('Provider base URLs must use HTTPS or HTTP on host.docker.internal or a private IPv4 address, without credentials, queries or fragments.');
  return url.href.replace(/\/$/, '');
}

/** Resolve only the signed-in account's operator configuration, preserving provider identity and execution settings. */
export function webProvidersForAccount(config: Pick<WebConfig, 'providers' | 'accountProviderUrls'>, accountId?: string): WebWorkerProvider[] {
  const urls = accountId ? config.accountProviderUrls?.[accountId] : undefined;
  return urls ? config.providers.map(provider => urls[provider.id] ? { ...provider, baseUrl: urls[provider.id] } : provider) : config.providers;
}

export function readWebConfig(env: NodeJS.ProcessEnv = process.env): WebConfig {
  const port = integer(env.THEOREMOS_WEB_PORT, 8787, 1, 65535);
  const publicUrl = new URL(env.THEOREMOS_WEB_PUBLIC_URL || `http://127.0.0.1:${port}`);
  if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.pathname !== '/' || publicUrl.search ||
      publicUrl.hash || publicUrl.username || publicUrl.password) throw new Error('Use an HTTP(S) origin for THEOREMOS_WEB_PUBLIC_URL.');
  const providers = z.array(providerSchema).min(1).max(20).parse(JSON.parse(env.THEOREMOS_WEB_PROVIDERS ||
    '[{"id":"sub2api","name":"Sub2API · DeepSeek","baseUrl":"http://host.docker.internal:8080/v1"},'
    + '{"id":"openai","name":"OpenAI","baseUrl":"https://api.openai.com/v1"}]')) as WebWorkerProvider[];
  if (new Set(providers.map(provider => provider.id)).size !== providers.length) throw new Error('Provider IDs must be unique.');
  for (const provider of providers) provider.baseUrl = providerBaseUrl(provider.baseUrl);
  const accountProviderUrls = env.THEOREMOS_WEB_ACCOUNT_PROVIDER_URLS
    ? z.record(z.string().uuid(), z.record(z.string(), z.string().url().max(512))).parse(JSON.parse(env.THEOREMOS_WEB_ACCOUNT_PROVIDER_URLS))
    : undefined;
  for (const urls of Object.values(accountProviderUrls ?? {})) for (const [id, baseUrl] of Object.entries(urls)) {
    if (!providers.some(provider => provider.id === id)) throw new Error('THEOREMOS_WEB_ACCOUNT_PROVIDER_URLS names an unknown provider.');
    urls[id] = providerBaseUrl(baseUrl);
  }
  // A public address requires login unless the operator opts out explicitly; loopback previews stay anonymous.
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(publicUrl.hostname);
  const authMode = env.THEOREMOS_WEB_AUTH || (loopback ? 'none' : 'email');
  if (!['none', 'email'].includes(authMode)) throw new Error('THEOREMOS_WEB_AUTH must be none or email.');
  if (accountProviderUrls && authMode !== 'email') throw new Error('THEOREMOS_WEB_ACCOUNT_PROVIDER_URLS needs THEOREMOS_WEB_AUTH=email.');
  // An allowlist is the default: one address at a time is admitted until the operator opens signup.
  const signup = (env.THEOREMOS_WEB_SIGNUP || 'allowlist') as WebSignupMode;
  if (!['allowlist', 'open'].includes(signup)) throw new Error('THEOREMOS_WEB_SIGNUP must be allowlist or open.');
  if (signup === 'open' && authMode !== 'email') throw new Error('THEOREMOS_WEB_SIGNUP=open needs email login (THEOREMOS_WEB_AUTH=email).');
  const termsVersion = env.THEOREMOS_WEB_TERMS_VERSION?.trim() || (signup === 'open' ? '2026-11-07' : undefined);
  if (termsVersion && !/^[0-9A-Za-z._-]{1,32}$/u.test(termsVersion)) throw new Error('THEOREMOS_WEB_TERMS_VERSION must be 1-32 letters, digits, dots, dashes or underscores.');
  let auth: WebAuthConfig | undefined;
  if (env.THEOREMOS_WEB_ADMINS && authMode !== 'email') throw new Error('THEOREMOS_WEB_ADMINS needs email login (THEOREMOS_WEB_AUTH=email).');
  if (authMode === 'email') {
    const smtpUrl = env.THEOREMOS_WEB_SMTP_URL || '';
    if (smtpUrl === 'log:' ? !loopback : !/^smtps?:\/\//u.test(smtpUrl))
      throw new Error('Email login needs THEOREMOS_WEB_SMTP_URL (smtp:// or smtps://); log: is only allowed on a loopback address.');
    const from = env.THEOREMOS_WEB_MAIL_FROM || (smtpUrl === 'log:' ? 'TheoremOS <login@localhost>' : '');
    if (!from) throw new Error('Email login needs THEOREMOS_WEB_MAIL_FROM.');
    const dataRoot = env.THEOREMOS_WEB_DATA_ROOT ? path.resolve(env.THEOREMOS_WEB_DATA_ROOT) : undefined;
    const list = (value?: string) => (value || '').split(',').map(item => item.trim()).filter(Boolean).map(normalizeEmail);
    auth = { smtpUrl, from, allowlist: list(env.THEOREMOS_WEB_ALLOWLIST), admins: list(env.THEOREMOS_WEB_ADMINS),
      signup, ...(termsVersion ? { termsVersion } : {}),
      ...(env.THEOREMOS_WEB_ALLOWLIST_FILE || dataRoot ? { allowlistFile: path.resolve(env.THEOREMOS_WEB_ALLOWLIST_FILE || allowlistFile(dataRoot)!) } : {}) };
  }
  const clientIpHeader = env.THEOREMOS_WEB_CLIENT_IP_HEADER?.trim().toLowerCase();
  if (clientIpHeader && !/^[a-z0-9-]{1,64}$/u.test(clientIpHeader)) throw new Error('THEOREMOS_WEB_CLIENT_IP_HEADER must be a header name.');
  let adminKeys: Record<string, string> | undefined;
  if (env.THEOREMOS_WEB_ADMIN_KEYS) {
    if (!auth?.admins?.length) throw new Error('THEOREMOS_WEB_ADMIN_KEYS needs THEOREMOS_WEB_ADMINS.');
    let parsed: unknown;
    try { parsed = JSON.parse(env.THEOREMOS_WEB_ADMIN_KEYS); } catch { throw new Error('THEOREMOS_WEB_ADMIN_KEYS must be a JSON object of provider ID to key.'); }
    // The messages name provider IDs only, never a key.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('THEOREMOS_WEB_ADMIN_KEYS must be a JSON object of provider ID to key.');
    adminKeys = {};
    for (const [id, key] of Object.entries(parsed)) {
      if (!providers.some(provider => provider.id === id)) throw new Error(`THEOREMOS_WEB_ADMIN_KEYS names an unknown provider: ${id.slice(0, 40)}`);
      if (typeof key !== 'string' || !/^[\x21-\x7e]{8,4096}$/u.test(key)) throw new Error(`THEOREMOS_WEB_ADMIN_KEYS has an invalid key for ${id}.`);
      adminKeys[id] = key;
    }
  }
  const keySecretText = env.THEOREMOS_WEB_KEY_SECRET?.trim();
  if (keySecretText && !auth) throw new Error('THEOREMOS_WEB_KEY_SECRET needs THEOREMOS_WEB_AUTH=email.');
  if (keySecretText && !/^[0-9a-f]{64}$/iu.test(keySecretText)) throw new Error('THEOREMOS_WEB_KEY_SECRET must be 64 hex digits.');
  // A published service needs an allowance per account; an anonymous loopback preview has no account to count against.
  const quota: WebQuotaLimits | undefined = auth ? {
    windowHours: integer(env.THEOREMOS_WEB_QUOTA_WINDOW_HOURS, webQuotaDefaults.windowHours, 1, 24 * 30, 'THEOREMOS_WEB_QUOTA_WINDOW_HOURS'),
    runs: integer(env.THEOREMOS_WEB_QUOTA_RUNS, webQuotaDefaults.runs, 0, 10_000, 'THEOREMOS_WEB_QUOTA_RUNS'),
    formalizations: integer(env.THEOREMOS_WEB_QUOTA_FORMALIZATIONS, webQuotaDefaults.formalizations, 0, 10_000, 'THEOREMOS_WEB_QUOTA_FORMALIZATIONS'),
    explanations: integer(env.THEOREMOS_WEB_QUOTA_EXPLANATIONS, webQuotaDefaults.explanations, 0, 10_000, 'THEOREMOS_WEB_QUOTA_EXPLANATIONS'),
  } : undefined;
  return {
    host: env.THEOREMOS_WEB_HOST || '127.0.0.1', port, publicUrl: publicUrl.origin,
    staticRoot: path.resolve(env.THEOREMOS_WEB_STATIC_ROOT || 'out/web'),
    ...(env.THEOREMOS_WEB_DATA_ROOT ? { dataRoot: path.resolve(env.THEOREMOS_WEB_DATA_ROOT) } : {}),
    workerImage: env.THEOREMOS_WEB_WORKER_IMAGE || 'theorem-os-worker:local',
    texImage: env.THEOREMOS_WEB_TEX_IMAGE || 'theorem-os-tex:local',
    ...(/^[0-9a-f]{7,40}$/u.test(env.THEOREMOS_SOURCE_COMMIT ?? '') ? { sourceCommit: env.THEOREMOS_SOURCE_COMMIT } : {}),
    concurrency: integer(env.THEOREMOS_WEB_CONCURRENCY, 1, 1, 8),
    queueLimit: integer(env.THEOREMOS_WEB_QUEUE_LIMIT, 8, 1, 32),
    sessionTtlMs: 1000 * integer(env.THEOREMOS_WEB_SESSION_TTL_SECONDS,
      env.THEOREMOS_WEB_DATA_ROOT ? 30 * 24 * 60 * 60 : 60 * 60, 60, 365 * 24 * 60 * 60), providers,
    ...(accountProviderUrls ? { accountProviderUrls } : {}),
    ...(auth ? { auth } : {}),
    ...(quota ? { quota } : {}),
    ...(clientIpHeader ? { clientIpHeader } : {}),
    ...(adminKeys ? { adminKeys } : {}),
    ...(keySecretText ? { keySecret: Buffer.from(keySecretText, 'hex') } : {}),
  };
}

export { webLimits };
// The first provider is the host's deployed sub2api gateway, reached from isolated Docker workers.
export const webDefaults = Object.freeze({ model: 'deepseek-flash', effort: 'high' as const,
  environment: webTaskEnvironment, maxTurns: 0, maxRunSeconds: 0, maxTotalTokens: 0, workers: 1, coordination: 'cooperative' as const });
/**
 * Proof explanations (docs/informalization.md) run one at a time on the sub2api gateway. The reference is the measured
 * Mathlib smoke run of 2026-10-29: 14 declarations, about 4.5 hours and 10.75 million provider tokens.
 */
export const webExplanationLimits = Object.freeze({ maxRunSeconds: 0, maxTotalTokens: 0,
  maxRoundsPerBatch: 0, auditors: 2, concurrency: 1, queueLimit: 4, perOwner: 2,
  reference: Object.freeze({ declarations: 14, seconds: 16_200, tokens: 10_750_000 }) });

export function getWebEnvironments(): WebEnvironmentOption[] {
  return (['standard', 'mathlib'] as WebEnvironment[]).map(id => {
    const trusted = getLeanTaskEnvironment(id);
    return { id, name: id === webTaskEnvironment ? webTaskEnvironmentName : 'Lean 标准库',
      description: id === webTaskEnvironment ? webTaskEnvironmentDescription : 'Lean 核心与标准库，无第三方数学依赖。',
      toolchain: trusted.toolchain, ...(trusted.mathlibRevision ? { mathlibRevision: trusted.mathlibRevision } : {}) };
  });
}
export const webTemplates: WebTemplate[] = [
  ...researchExamples.map(({ id, name, environment, source, task }) => ({ id, name, environment, source, task })),
  { id: 'addition', name: '自然数加法', environment: webTaskEnvironment,
    source: 'namespace Tutorial\n\ntheorem add_zero (n : Nat) : n + 0 = n := by sorry\n\ntheorem zero_add (n : Nat) : 0 + n = n := by sorry\n\nend Tutorial\n',
    task: '证明两个自然数加法定理，保持原题声明不变。根据 Lean 反馈修复候选，并验收完整原题。' },
  { id: 'logic', name: '命题逻辑', environment: webTaskEnvironment,
    source: 'namespace Logic\n\ntheorem and_comm (P Q : Prop) : P ∧ Q → Q ∧ P := by sorry\n\nend Logic\n',
    task: '构造这个命题逻辑定理的 Lean 证明，保留全部参数与命题。' },
  { id: 'polynomial', name: '实数多项式', environment: 'mathlib',
    source: 'import Mathlib\n\nnamespace Algebra\n\ntheorem square_add (x y : ℝ) : (x + y) ^ 2 = x ^ 2 + 2 * x * y + y ^ 2 := by sorry\n\nend Algebra\n',
    task: '使用 Mathlib 证明实数平方展开，可使用 ring 策略。保留原题的全部变量、类型与声明。' },
];
