import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { z } from 'zod';
import { getWebEnvironments, readWebConfig, webDefaults, webExplanationLimits, webLimits, webTemplates, type WebConfig } from './config';
import { DockerWebRunner, type WebRunner } from './runner';
import { WebJobs } from './jobs';
import { webAgentActionLimits, webContinuationLabelMax, type WebAdminOverview, type WebContinuation, type WebEffort, type WebEnvironment,
  type WebExplanationLanguage, type WebExplanationOverview, type WebProvider, type WebRun, type WebRunInput, type WebSession } from './shared';
import { researchModulePlanSchema } from '../../src/solver/modules/policy';
import { WebStorage, WebStorageError } from './storage';
import { WebKnowledgeService, type WebKnowledgeDetailOptions } from './knowledgeService';
import { WebModuleRegistry } from './moduleRegistry';
import { webGuidanceSchema, webPlanApprovalSchema, webPlanProposalSchema } from './collaborationValidation';
import { WebAuth, WebAuthError, type WebMailer, type WebMilestone } from './auth';
import { shareSnapshot, webShareToken, type WebShareLink } from './share';
import { loadWebSample, webSampleResponse, webSampleRunId, type WebSampleFile } from './sample';
import { PrecheckSuperseded, WebPrechecker } from './precheck';
import { proofOutline, verificationKit } from './verificationKit';
import { acceptedEncoding, sendStatic } from './staticFiles';
import { webFunnel } from './funnel';
import { completionMail, mailsCompletion, planApprovalMail } from './completionMail';
import { WebKeyVault } from './keyVault';
import { trajectoryQuery, trajectoryVersionQuery, WebTrajectories } from './trajectory';
import { explainInput, failedFeedback, WebExplainError, WebExplainer, webExplainLimits, type WebExplainTurn } from './explain';
import { explanationMarkdownFilename, verifyExplanationEvidence } from './explanation';
import { explanationKey, WebExplanations } from './explanations';
import { WebFormalizations } from './formalizations';
import { webFormalizationLimits, type WebFormalizationCapabilities, type WebFormalizationRequest } from './formalizationTypes';
import { SUB2API_PROVIDER } from '../../src/runtime/sub2api';
import { inspectScopedLeanDeclarations } from '../../src/math/leanSource';
import { formalizationDigest } from '../../src/math/formalization';
import { WebConversations } from './conversations';
import { webConversationLimits } from './conversationTypes';

const inputSchema = z.object({
  requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u).optional(),
  // Empty asks for the key this account saved, then the one the server holds for admins (THEOREMOS_WEB_ADMIN_KEYS).
  providerId: z.string().min(1).max(40), apiKey: z.string().max(4096).regex(/^(?:[\x21-\x7e]{8,})?$/), saveKey: z.boolean().optional(),
  model: z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
  environment: z.enum(['standard', 'mathlib']).default('standard'),
  source: z.string().min(1).refine(value => value.trim().length > 0 && Buffer.byteLength(value) <= webLimits.maxSourceBytes),
  task: z.string().trim().min(1).refine(value => Buffer.byteLength(value) <= webLimits.maxTaskBytes),
  maxTurns: z.number().int().min(1).max(webLimits.maxTurns),
  maxRunSeconds: z.number().int().min(30).max(webLimits.maxRunSeconds),
  maxTotalTokens: z.number().int().min(10_000).max(webLimits.maxTotalTokens).optional(),
  workers: z.number().int().min(1).max(webLimits.maxWorkers),
  coordination: z.enum(['cooperative', 'independent']),
  planApproval: z.boolean().optional(),
  modulePlan: researchModulePlanSchema.optional(),
  knowledgeDigest: z.string().regex(/^[a-f0-9]{64}$/u).nullable().optional(),
  formalizationId: z.string().uuid().optional(),
  // Names a version of one of the account's runs; its saved file is looked up here, never taken from the request.
  continueFrom: z.object({ runId: z.string().regex(/^[a-f0-9-]{36}$/u), taskId: z.string().min(1).max(200),
    commit: z.string().regex(/^[A-Za-z0-9]{1,128}$/u),
    label: z.string().trim().min(1).max(webContinuationLabelMax).regex(/^[^\p{Cc}]*$/u) }).strict().optional(),
}).strict();
// A question about one recorded version; its code and Lean's output are read here, never taken from the request.
const explainSchema = z.object({
  taskId: z.string().min(1).max(200), commit: z.string().regex(/^[A-Za-z0-9]{1,128}$/u),
  question: z.string().trim().min(1).max(webExplainLimits.question),
  turns: z.array(z.object({ question: z.string().min(1).max(webExplainLimits.question),
    answer: z.string().min(1).max(webExplainLimits.answer) }).strict()).max(webExplainLimits.turns).default([]),
  apiKey: z.string().max(4096).regex(/^(?:[\x21-\x7e]{8,})?$/).default(''),
}).strict();
const precheckSchema = z.object({
  checkScope: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u).optional(),
  environment: z.enum(['standard', 'mathlib']),
  source: z.string().min(1).refine(value => Buffer.byteLength(value) <= webLimits.maxSourceBytes),
}).strict();
const explanationLanguage = z.enum(['zh', 'en']);
const explanationSchema = z.object({
  target: z.string().min(1).max(512), language: explanationLanguage,
  // Empty uses the account's saved key, then the server's key for admins, as for runs.
  apiKey: z.string().max(4096).regex(/^(?:[\x21-\x7e]{8,})?$/).default(''),
}).strict();
const formalizationSchema = z.object({
  original: z.string().min(1).refine(value => value.trim().length > 0 && Buffer.byteLength(value) <= webFormalizationLimits.maxOriginalBytes),
  environment: z.enum(['standard', 'mathlib']), effort: z.enum(['low', 'high', 'max']).default('max'),
  apiKey: z.string().max(4096).regex(/^(?:[\x21-\x7e]{8,})?$/).default(''),
  solve: z.boolean().optional(),
}).strict();
const conversationSchema = z.object({ formalizationId: z.string().uuid().optional(), runId: z.string().uuid().optional() })
  .strict().refine(value => Boolean(value.formalizationId || value.runId));
const conversationMessageSchema = z.object({ text: z.string().trim().min(1).max(webConversationLimits.question),
  apiKey: z.string().max(4096).regex(/^(?:[\x21-\x7e]{8,})?$/).default('') }).strict();
// Explanation roles accept only these Codex efforts (src/runtime/sub2api.ts).
const explanationEffort = (effort: WebEffort): 'low' | 'high' | 'max' =>
  effort === 'low' ? 'low' : effort === 'medium' || effort === 'high' ? 'high' : 'max';
const gatewayProvider = (provider: WebProvider | undefined) => {
  if (provider?.id !== SUB2API_PROVIDER.id) return false;
  const url = new URL(provider.baseUrl);
  return url.protocol === 'http:' && url.pathname.replace(/\/$/u, '') === '/v1';
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const equal = (left: string, right: string) => /^[a-f0-9]{64}$/.test(left) &&
  /^[a-f0-9]{64}$/.test(right) && crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
/** The coding each request accepts, so JSON bodies can be compressed without passing the request along. */
const jsonEncodings = new WeakMap<ServerResponse, 'br' | 'gzip'>();
// A run carries its sources and report, so the list and the Agents' actions run to tens of KB each. no-transform keeps
// Cloudflare from compressing them, so the server does: a fast brotli level costs a few ms even for MBs of JSON.
const jsonBrotli = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } };
function json(response: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body), encoding = text.length >= 2048 ? jsonEncodings.get(response) : undefined;
  if (!encoding) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(text);
    return;
  }
  const compressed = encoding === 'br' ? zlib.brotliCompressSync(text, jsonBrotli) : zlib.gzipSync(text, { level: 6 });
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': encoding,
    'Content-Length': compressed.length, Vary: 'Accept-Encoding' });
  response.end(compressed);
}
function readJson(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || ''))
    throw new HttpError(415, '请求必须使用 JSON。');
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0, rejected = false;
    request.on('data', chunk => {
      if (rejected) return;
      bytes += chunk.length;
      if (bytes > 160 * 1024) { rejected = true; chunks.length = 0; reject(new HttpError(413, '请求内容过大。')); return; }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (rejected) return;
      try { resolve(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
      catch { reject(new HttpError(400, 'JSON 内容无效。')); }
    });
    request.on('error', () => reject(new HttpError(400, '请求已中断。')));
  });
}

/** Addresses, accounts and milestones for the admin dialog; never a run, a key or anything an account wrote. */
function adminOverview(auth: WebAuth): WebAdminOverview {
  const accounts = auth.listAccounts(), allowed = auth.allowlist(), signedUp = new Set(accounts.map(account => account.email));
  return {
    allowlist: auth.allowlistEntries().map(entry => ({ ...entry, account: signedUp.has(entry.email) })),
    accounts: accounts.map(({ email, createdAt, firstRunAt, firstAcceptedAt }) => ({ email, admin: auth.isAdmin(email), createdAt,
      ...(firstRunAt ? { firstRunAt } : {}), ...(firstAcceptedAt ? { firstAcceptedAt } : {}), allowed: allowed.has(email) }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    funnel: webFunnel(accounts, allowed).steps,
    editable: auth.allowlistWritable(),
  };
}

type Session = { id: string; csrf: string; touchedAt: number; account?: { id: string; email: string }; passwordResetUntil?: number };
const objectBody = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
export function createWebService(config: WebConfig, runner: WebRunner = new DockerWebRunner(config),
  options: { mailer?: WebMailer; captchaAnswer?: () => string; sample?: WebSampleFile | null } = {}) {
  const storage = new WebStorage(config.dataRoot);
  // null disables the sample; omitted loads the one shipped with the image.
  const sample = options.sample === undefined ? loadWebSample() : options.sample ?? undefined;
  const knowledge = new WebKnowledgeService(storage);
  const registry = new WebModuleRegistry(storage);
  const sessions = new Map<string, Session>(storage.listSessions().map(session => [session.id, session]));
  const auth = config.auth ? new WebAuth(config.auth, storage, options.mailer, options.captchaAnswer) : undefined;
  // With login enabled, records belong to the account; otherwise to the anonymous browser session.
  // Provider IDs, never keys, that the server can fill in for this session's admin account.
  const serverKeysFor = (session: Session) => {
    const ids = config.adminKeys && session.account && auth?.isAdmin(session.account.email) ? Object.keys(config.adminKeys) : [];
    return ids.length ? ids : undefined;
  };
  // Each account reads and replaces only its own saved keys.
  const vault = auth && config.keySecret ? new WebKeyVault(config.keySecret, storage) : undefined;
  const savedKeysFor = (session: Session) => vault && session.account ? vault.list(session.account.id, config.providers) : [];
  // What an empty key field stands for: the account's saved key, then the server's key for admins.
  const heldKey = (session: Session, provider: WebProvider) =>
    (vault && session.account ? vault.get(session.account.id, provider.id, provider.baseUrl) : undefined)
      ?? (serverKeysFor(session)?.includes(provider.id) ? config.adminKeys![provider.id] : undefined);
  const ownerOf = (session: Session) => auth ? session.account && `account:${session.account.id}` : session.id;
  /** Original theorems of the proof, each with an upper bound on the declarations its explanation covers (all of them). */
  const explanationTargets = (run: WebRun) => {
    const declarations = inspectScopedLeanDeclarations(run.result?.proof ?? '').length;
    return (proofOutline(run)?.declarations ?? []).filter(item => item.role === 'target').map(item => ({ name: item.name, declarations }));
  };
  const explanationGeneration = (session: Session, run: WebRun, isSample: boolean): WebExplanationOverview['generation'] => {
    if (isSample) return { available: false, reason: 'sample' };
    if (run.status !== 'completed' || run.result?.status !== 'evaluated_passed') return { available: false, reason: 'not_accepted' };
    const provider = config.providers.find(item => item.id === run.providerId);
    if (!gatewayProvider(provider)) return { available: false, reason: 'provider' };
    if (run.model !== SUB2API_PROVIDER.defaultModel) return { available: false, reason: 'model' };
    if (!runner.explain) return { available: false, reason: 'runtime' };
    const key = savedKeysFor(session).some(item => item.providerId === provider!.id) ? 'saved'
      : serverKeysFor(session)?.includes(provider!.id) ? 'server' : 'required';
    return { available: true, model: run.model, effort: explanationEffort(run.effort), key,
      maxRunSeconds: webExplanationLimits.maxRunSeconds, maxTotalTokens: webExplanationLimits.maxTotalTokens,
      reference: { ...webExplanationLimits.reference } };
  };
  // Beta funnel milestones exist only for accounts; anonymous loopback previews record nothing.
  const milestone = (owner: string, name: WebMilestone) => {
    if (auth && owner.startsWith('account:')) try { auth.markMilestone(owner.slice(8), name); } catch { /* A milestone never fails a run. */ }
  };
  // The owner's mail goes out after the run is saved; a failed delivery is logged by run and never changes the run.
  // The same preference covers the one mail asking to approve a plan.
  const mailOwner = (owner: string, run: WebRun, kind: string, message: (run: WebRun, publicUrl: string) => { subject: string; text: string }) => {
    if (!auth || !owner.startsWith('account:')) return;
    const to = auth.completionRecipient(owner.slice(8));
    if (to) auth.sendCompletion(to, message(run, config.publicUrl)).catch(() => console.error(`[${kind} mail] run ${run.id}: delivery failed`));
  };
  const jobs = new WebJobs(runner, config, { storage, knowledge, onAccepted: owner => milestone(owner, 'firstAcceptedAt'),
    onFinished: (owner, run) => { if (mailsCompletion(run)) mailOwner(owner, run, 'completion', completionMail); },
    onPlanWaiting: (owner, run) => mailOwner(owner, run, 'plan approval', planApprovalMail) });
  const trajectories = new WebTrajectories(storage);
  const explanations = new WebExplanations(runner, storage);
  const formalizations = new WebFormalizations(runner, storage, webFormalizationLimits, (owner, formalization, evidence, input) => {
    const run = jobs.create(owner, { ...webDefaults, providerId: input.provider.id, apiKey: input.apiKey,
      model: input.model, effort: input.effort, source: evidence.candidate.source, environment: evidence.request.environment,
      task: '依据自然语言原题及其已审核的 Lean 陈述，证明全部目标，保留所有定义、假设与声明。', formalizationId: formalization.id }, input.provider, undefined, undefined,
    { evidence, provenance: { id: formalization.id, evidenceSha256: formalizationDigest(evidence), original: formalization.original,
      confirmedAt: formalization.confirmedAt!, confirmation: 'automatic' } });
    milestone(owner, 'firstRunAt');
    return run.id;
  });
  const prechecker = runner.check ? new WebPrechecker(runner.check.bind(runner)) : undefined;
  const explainer = new WebExplainer();
  const conversations = new WebConversations(storage, { run: (owner, id) => jobs.get(owner, id),
    formalization: (owner, id) => {
      try { return formalizations.read(owner, id); }
      catch (error) { if (error instanceof WebStorageError && error.status === 404) return undefined; throw error; }
    }, commandReceipt: (owner, runId, id) => jobs.commandReceipt(owner, runId, id) }, (owner, call, signal) => explainer.ask(owner, call, signal));
  const rates = new Map<string, { count: number; expiresAt: number }>();
  const runStreams = new Map<string, Set<() => void>>();
  const origin = new URL(config.publicUrl);
  const secure = origin.protocol === 'https:';
  const setSessionCookie = (response: ServerResponse, session: Session) => {
    response.setHeader('Set-Cookie', `theoremos_session=${session.id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(config.sessionTtlMs / 1000)}${secure ? '; Secure' : ''}`);
  };
  const clearSessionCookie = (response: ServerResponse) => {
    response.setHeader('Set-Cookie', `theoremos_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`);
  };
  const startSession = (account?: Session['account'], verifiedByEmail = false) => {
    const session: Session = { id: crypto.randomBytes(32).toString('hex'), csrf: crypto.randomBytes(32).toString('hex'), touchedAt: Date.now(),
      ...(account ? { account } : {}), ...(verifiedByEmail ? { passwordResetUntil: Date.now() + 10 * 60_000 } : {}) };
    sessions.set(session.id, session);
    return session;
  };
  /** Ends one browser session. Anonymous records go with it; account records stay with the account. */
  const endSession = (id: string) => {
    for (const stop of runStreams.get(id) ?? []) stop();
    if (!auth) { conversations.forget(id); formalizations.forget(id); explanations.forget(id); jobs.forget(id); storage.deleteOwner(id); trajectories.forgetOwner(id); }
    sessions.delete(id); storage.deleteSession(id);
  };
  const prune = () => {
    for (const [id, session] of sessions) {
      // Login-page sessions without an account only need to outlive one sign-in attempt.
      const ttl = auth && !session.account ? Math.min(config.sessionTtlMs, 60 * 60_000) : config.sessionTtlMs;
      if (Date.now() - session.touchedAt > ttl) endSession(id);
    }
    for (const [ip, rate] of rates) if (rate.expiresAt <= Date.now()) rates.delete(ip);
    prechecker?.prune();
    explainer.prune();
    auth?.prune();
  };
  const maintenance = setInterval(prune, 60_000).unref();
  /** The browser session named by the cookie. An address removed from the allowlist, or a deleted account, loses its signed-in sessions. */
  const cookieSession = (request: IncomingMessage) => {
    const cookie = request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith('theoremos_session='))?.slice(18);
    const session = cookie ? sessions.get(cookie) : undefined;
    if (session?.account && auth && !(auth.allowed(session.account.email) && auth.getAccount(session.account.email)?.id === session.account.id)) {
      endSession(session.id); return undefined;
    }
    return session;
  };
  const server = http.createServer(async (request, response) => {
    const encoding = acceptedEncoding(request.headers['accept-encoding']);
    if (encoding) jsonEncodings.set(response, encoding);
    response.setHeader('Cache-Control', 'no-store, no-transform');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('X-Robots-Tag', 'noindex, nofollow');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (secure) response.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      if (request.url === '/healthz') { json(response, 200, { ok: true, ...config.sourceCommit ? { commit: config.sourceCommit } : {} }); return; }
      if (request.headers.host !== origin.host) throw new HttpError(403, '访问地址与服务配置不一致。');
      if (request.headers.origin && request.headers.origin !== origin.origin) throw new HttpError(403, '跨站请求已拒绝。');
      const url = new URL(request.url || '/', origin);
      if (url.origin !== origin.origin) throw new HttpError(403, '访问地址无效。');
      if (url.pathname.startsWith('/api/')) {
        prune();
        // Behind a tunnel every request comes from the proxy, so the configured proxy header names the visitor.
        const forwarded = config.clientIpHeader ? request.headers[config.clientIpHeader] : undefined;
        const ip = (typeof forwarded === 'string' && forwarded.trim().slice(0, 64)) || request.socket.remoteAddress || '';
        let rate = rates.get(ip);
        if (!rate) {
          if (rates.size >= 2_000) throw new HttpError(429, '请求较多，请稍后重试。');
          rates.set(ip, rate = { count: 0, expiresAt: Date.now() + 60_000 });
        }
        if (++rate.count > 600) throw new HttpError(429, '请求过于频繁，请稍后重试。');
        // Share links are public read-only snapshots: no session, no cookie, nothing beyond the stored whitelist.
        const shared = /^\/api\/share\/([^/]+)$/u.exec(url.pathname);
        if (shared) {
          if (request.method !== 'GET') throw new HttpError(405, '请求方法不受支持。');
          const share = webShareToken.test(shared[1]) ? storage.getShare(shared[1]) : undefined;
          if (!share) throw new HttpError(404, '分享链接不存在或已停止分享。');
          json(response, 200, { share: share.snapshot }); return;
        }
        let session = cookieSession(request);
        if (request.method === 'GET' && url.pathname === '/api/session') {
          if (!session) {
            const anonymous = [...sessions.values()].filter(item => !item.account).length;
            if (anonymous >= 200 || sessions.size >= 2_000) throw new HttpError(503, '当前会话数已满，请稍后重试。');
            session = startSession();
          }
          setSessionCookie(response, session);
          session.touchedAt = Date.now();
          storage.saveSession(session);
          const body: WebSession = { draftOwner: crypto.createHash('sha256').update(ownerOf(session) || session.id).digest('hex'), csrfToken: session.csrf, auth: auth ? 'email' : 'none',
            ...(session.account ? { account: { email: session.account.email, ...(auth?.isAdmin(session.account.email) ? { admin: true } : {}),
              ...(auth ? { passwordSet: auth.hasPassword(session.account.email), passwordResetAllowed: Boolean(session.passwordResetUntil && session.passwordResetUntil > Date.now()) } : {}),
              ...(serverKeysFor(session) ? { serverKeys: serverKeysFor(session) } : {}),
              ...(vault ? { keyVault: true, ...(savedKeysFor(session).length ? { savedKeys: savedKeysFor(session) } : {}) } : {}),
              ...(auth?.getAccount(session.account.email)?.completionEmail === false ? { completionEmail: false } : {}) } } : {}), providers: config.providers, environments: getWebEnvironments(),
            templates: webTemplates, defaults: webDefaults, limits: webLimits, runtime: await runner.readiness(),
            ...(sample ? { sample: { id: sample.run.id, title: sample.run.title } } : {}), ...(prechecker ? { precheck: true } : {}) };
          const owner = url.searchParams.has('runs') ? ownerOf(session) : undefined;
          if (owner) body.runs = { runs: jobs.list(owner), version: jobs.version(owner) };
          json(response, 200, body); return;
        }
        if (session) response.setHeader('X-Theoremos-Owner', crypto.createHash('sha256').update(ownerOf(session) || session.id).digest('hex'));
        if (!session) throw new HttpError(401, '会话已过期，请刷新页面。');
        session.touchedAt = Date.now();
        if (request.method !== 'GET' && !equal(String(request.headers['x-csrf-token'] || ''), session.csrf))
          throw new HttpError(403, '会话校验失败，请刷新页面。');
        setSessionCookie(response, session);
        storage.saveSession(session);
        if (url.pathname.startsWith('/api/auth/')) {
          if (!auth) throw new HttpError(404, '当前服务未启用登录。');
          if (url.pathname === '/api/auth/captcha' && request.method === 'POST') { json(response, 200, auth.captcha(ip)); return; }
          if (url.pathname === '/api/auth/code' && request.method === 'POST') {
            json(response, 200, await auth.requestCode(ip, objectBody(await readJson(request)))); return;
          }
          if (url.pathname === '/api/auth/verify' && request.method === 'POST') {
            const account = auth.verifyCode(objectBody(await readJson(request)));
            // A fresh identifier and CSRF token after login; the pre-login cookie stops working.
            endSession(session.id);
            const next = startSession({ id: account.id, email: account.email }, true);
            storage.saveSession(next); setSessionCookie(response, next);
            json(response, 200, { account: { email: account.email }, csrfToken: next.csrf }); return;
          }
          if (url.pathname === '/api/auth/password/login' && request.method === 'POST') {
            const account = await auth.loginPassword(ip, objectBody(await readJson(request)));
            endSession(session.id);
            const next = startSession({ id: account.id, email: account.email });
            storage.saveSession(next); setSessionCookie(response, next);
            json(response, 200, { account: { email: account.email }, csrfToken: next.csrf }); return;
          }
          if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
            endSession(session.id); clearSessionCookie(response); json(response, 200, { ok: true }); return;
          }
          if (url.pathname === '/api/auth/account' && request.method === 'PATCH') {
            if (!session.account) throw new HttpError(401, '请先登录。');
            const completionEmail = objectBody(await readJson(request)).completionEmail;
            if (typeof completionEmail !== 'boolean') throw new HttpError(400, '设置格式不正确。');
            auth.setCompletionEmail(session.account.email, completionEmail);
            json(response, 200, { completionEmail }); return;
          }
          if (url.pathname === '/api/auth/password' && request.method === 'PATCH') {
            if (!session.account) throw new HttpError(401, '请先登录。');
            const body = objectBody(await readJson(request));
            await auth.setPassword(session.account.email, body.password, body.currentPassword,
              Boolean(session.passwordResetUntil && session.passwordResetUntil > Date.now()));
            session.passwordResetUntil = undefined;
            storage.saveSession(session);
            for (const [id, other] of sessions) if (id !== session.id && other.account?.id === session.account.id) endSession(id);
            json(response, 200, { passwordSet: true }); return;
          }
          if (url.pathname === '/api/auth/account' && request.method === 'DELETE') {
            const account = session.account;
            if (!account) throw new HttpError(401, '请先登录。');
            const confirmation = objectBody(await readJson(request)).email;
            if (typeof confirmation !== 'string' || confirmation.trim().toLowerCase() !== account.email)
              throw new HttpError(400, '请输入当前账号的邮箱以确认删除。');
            const owner = ownerOf(session)!;
            conversations.forget(owner); formalizations.forget(owner); explanations.forget(owner); jobs.forget(owner); storage.deleteOwner(owner); trajectories.forgetOwner(owner); vault?.forgetAccount(account.id);
            auth.deleteAccount(account.email);
            for (const [id, other] of sessions) if (other.account?.id === account.id) endSession(id);
            clearSessionCookie(response); json(response, 200, { deleted: true }); return;
          }
          const savedKey = /^\/api\/auth\/keys\/([a-z][a-z0-9-]{0,39})$/u.exec(url.pathname);
          if (savedKey && request.method === 'DELETE') {
            if (!session.account) throw new HttpError(401, '请先登录。');
            if (!vault) throw new HttpError(404, '当前服务未启用保存 Key。');
            vault.forget(session.account.id, savedKey[1]);
            json(response, 200, { savedKeys: savedKeysFor(session) }); return;
          }
          throw new HttpError(405, '请求方法不受支持。');
        }
        if (url.pathname.startsWith('/api/admin/')) {
          // Checked on every request, so removing an address from THEOREMOS_WEB_ADMINS takes effect at the next restart.
          if (!auth || !session.account || !auth.isAdmin(session.account.email)) throw new HttpError(403, '需要管理员账号。');
          if (url.pathname === '/api/admin/overview' && request.method === 'GET') { json(response, 200, adminOverview(auth)); return; }
          if (url.pathname === '/api/admin/allowlist' && ['POST', 'DELETE'].includes(request.method ?? '')) {
            const email = objectBody(await readJson(request)).email;
            if (request.method === 'POST') auth.addToAllowlist(email);
            else {
              auth.removeFromAllowlist(email);
              // The removed address is signed out now, not at its next request.
              for (const [id, other] of sessions) if (other.account && !auth.allowed(other.account.email)) endSession(id);
            }
            json(response, 200, adminOverview(auth)); return;
          }
          throw new HttpError(405, '请求方法不受支持。');
        }
        const owner = ownerOf(session);
        if (!owner) throw new HttpError(401, '请先登录。');
        if (url.pathname === '/api/conversations') {
          if (request.method === 'GET') { json(response, 200, { conversations: conversations.list(owner) }); return; }
          if (request.method === 'POST') {
            const parsed = conversationSchema.safeParse(await readJson(request));
            if (!parsed.success) throw new HttpError(400, '请选择要讨论的题目。');
            json(response, 201, { conversation: conversations.create(owner, parsed.data) }); return;
          }
          throw new HttpError(405, '请求方法不受支持。');
        }
        const conversationMatch = /^\/api\/conversations\/([a-f0-9-]{36})(?:\/(messages|stop|guidance))?$/u.exec(url.pathname);
        if (conversationMatch) {
          const [, id, action] = conversationMatch;
          if (!action && request.method === 'GET') { json(response, 200, { conversation: conversations.read(owner, id) }); return; }
          if (action === 'stop' && request.method === 'POST') { json(response, 200, { conversation: conversations.stop(owner, id) }); return; }
          if (action === 'guidance' && request.method === 'POST') {
            const parsed = webGuidanceSchema.safeParse(await readJson(request));
            if (!parsed.success) throw new HttpError(400, '请检查指导对象、任务版本与内容。');
            const conversation = await conversations.guide(owner, id, parsed.data, (runId, guidance) => jobs.command(owner, runId, { type: 'guidance', guidance }));
            json(response, 200, { conversation }); return;
          }
          if (action === 'messages' && request.method === 'POST') {
            const conversation = conversations.read(owner, id);
            const parsed = conversationMessageSchema.safeParse(await readJson(request));
            if (!parsed.success) throw new HttpError(400, '请检查问题内容与 API Key。');
            const run = conversation.runId ? jobs.get(owner, conversation.runId) : undefined;
            const provider = config.providers.find(item => item.id === (run?.providerId ?? SUB2API_PROVIDER.id));
            if (!provider) throw new HttpError(400, '当前服务没有配置这个题目使用的模型服务。');
            const apiKey = parsed.data.apiKey || heldKey(session, provider);
            if (!apiKey) throw new HttpError(400, '请填写 API Key。');
            const model = run?.model ?? SUB2API_PROVIDER.defaultModel;
            json(response, 202, { conversation: conversations.send(owner, id, parsed.data.text, { baseUrl: provider.baseUrl, apiKey, model }) }); return;
          }
          throw new HttpError(405, '请求方法不受支持。');
        }
        if (url.pathname === '/api/formalizations') {
          const provider = config.providers.find(item => item.id === SUB2API_PROVIDER.id);
          if (request.method === 'GET') {
            const formalizationReady = Boolean(runner.formalize) && (await runner.readiness()).ready;
            const generation: WebFormalizationCapabilities = { available: gatewayProvider(provider) && formalizationReady,
              ...(!gatewayProvider(provider) ? { reason: 'provider' as const } : !formalizationReady ? { reason: 'runtime' as const } : {}),
              ...(provider ? { providerId: provider.id } : {}), model: SUB2API_PROVIDER.defaultModel,
              key: provider && savedKeysFor(session).some(item => item.providerId === provider.id) ? 'saved'
                : provider && serverKeysFor(session)?.includes(provider.id) ? 'server' : 'required', limits: webFormalizationLimits };
            json(response, 200, { formalizations: formalizations.list(owner), generation }); return;
          }
          if (request.method === 'POST') {
            const parsed = formalizationSchema.safeParse(await readJson(request));
            if (!parsed.success) throw new HttpError(400, '请检查原题、证明环境与 API Key。');
            if (!gatewayProvider(provider)) throw new HttpError(409, '自然语言形式化需要配置 Sub2API 服务。');
            if (!runner.formalize || !(await runner.readiness()).ready) throw new HttpError(503, '形式化运行环境尚未就绪。');
            const apiKey = parsed.data.apiKey || heldKey(session, provider!);
            if (!apiKey) throw new HttpError(400, '请填写 API Key。');
            json(response, 201, { formalization: formalizations.create(owner, { ...parsed.data, apiKey } as WebFormalizationRequest, provider!, SUB2API_PROVIDER.defaultModel) }); return;
          }
          throw new HttpError(405, '请求方法不受支持。');
        }
        const formalizationMatch = /^\/api\/formalizations\/([a-f0-9-]{36})(?:\/(cancel|confirm))?$/u.exec(url.pathname);
        if (formalizationMatch) {
          const id = formalizationMatch[1], action = formalizationMatch[2];
          if (!action && request.method === 'GET') { json(response, 200, { formalization: formalizations.read(owner, id) }); return; }
          if (!action && request.method === 'DELETE') {
            if (jobs.list(owner).some(run => run.formalizationId === id)) throw new HttpError(409, '已有研究使用这份原题，请先删除相关研究记录。');
            formalizations.remove(owner, id); json(response, 200, { deletedId: id }); return;
          }
          if (action === 'cancel' && request.method === 'POST') { json(response, 200, { formalization: formalizations.cancel(owner, id) }); return; }
          if (action === 'confirm' && request.method === 'POST') {
            const parsed = z.object({ evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict().safeParse(await readJson(request));
            if (!parsed.success) throw new HttpError(400, '请提供当前核对版本。');
            json(response, 200, { formalization: formalizations.confirm(owner, id, parsed.data.evidenceSha256) }); return;
          }
          throw new HttpError(405, '请求方法不受支持。');
        }
        if (['/api/module-registry', '/api/modules'].includes(url.pathname) && request.method === 'GET') {
          json(response, 200, registry.registry()); return;
        }
        if (url.pathname === '/api/module-plans') {
          if (request.method === 'GET') { json(response, 200, { plans: registry.listPlans(owner) }); return; }
          if (request.method === 'POST') {
            json(response, 200, { plan: registry.savePlan(owner, await readJson(request)) }); return;
          }
          throw new HttpError(405, '请求方法不受支持。');
        }
        const scheme = /^\/api\/module-plans\/([A-Za-z0-9_-]{1,64})$/u.exec(url.pathname);
        if (scheme && request.method === 'DELETE') {
          registry.deletePlan(owner, scheme[1], url.searchParams.get('updatedAt') ?? undefined);
          json(response, 200, { deletedId: scheme[1] }); return;
        }
        if (url.pathname === '/api/knowledge/search' && request.method === 'GET') {
          const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined;
          if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 32))
            throw new HttpError(400, '知识查询数量须为 1 至 32。');
          json(response, 200, knowledge.search(owner, {
            query: url.searchParams.get('q') ?? '', goal: url.searchParams.get('goal') ?? undefined,
            catalogDigest: url.searchParams.get('catalogDigest') ?? undefined,
            limit, problemId: url.searchParams.get('problemId') ?? undefined,
            environmentDigest: url.searchParams.get('environmentDigest') ?? undefined,
            problemReceiptDigest: url.searchParams.get('problemReceiptDigest') ?? undefined,
          })); return;
        }
        if (url.pathname === '/api/knowledge/catalogs' && request.method === 'GET') {
          const catalogs = knowledge.listCatalogs(owner);
          json(response, 200, { catalogs, latestDigest: catalogs.at(-1)?.digest ?? null }); return;
        }
        const material = /^\/api\/knowledge\/([a-f0-9]{64})$/u.exec(url.pathname);
        if (material && request.method === 'GET') {
          const view = url.searchParams.get('view') ?? undefined;
          if (view && !['metadata', 'source', 'dependencies', 'consumers', 'finding'].includes(view))
            throw new HttpError(400, '知识读取视图无效。');
          const pagination: Partial<WebKnowledgeDetailOptions> = {};
          for (const field of ['startOffset', 'startLine', 'lines', 'maxBytes', 'offset', 'limit', 'depth', 'maxNodes', 'maxReferences'] as const) {
            if (!url.searchParams.has(field)) continue;
            const value = Number(url.searchParams.get(field));
            if (!Number.isSafeInteger(value) || value < 0) throw new HttpError(400, '知识分页参数无效。');
            pagination[field] = value;
          }
          const field = url.searchParams.get('field') ?? undefined;
          const metadataFields = ['name', 'file', 'type', 'premises', 'environmentDigest', 'description',
            'dependencies', 'provenance', 'relatedVersions', 'files', 'elaboration'];
          if (field && !metadataFields.includes(field)) throw new HttpError(400, '知识字段无效。');
          json(response, 200, knowledge.detail(owner, material[1], {
            catalogDigest: url.searchParams.get('catalogDigest') ?? undefined,
            file: url.searchParams.get('file') ?? url.searchParams.get('sourceFile') ?? undefined,
            view: view as WebKnowledgeDetailOptions['view'],
            field: field as WebKnowledgeDetailOptions['field'], name: url.searchParams.get('name') ?? undefined, ...pagination,
          })); return;
        }
        if (url.pathname === '/api/runs/stream' && request.method === 'GET') {
          response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          let lastVersion = '';
          const notify = (version: string) => {
            if (version === lastVersion || response.destroyed || response.writableEnded) return;
            lastVersion = version;
            response.write(`event: runs-changed\ndata: ${JSON.stringify({ version })}\n\n`);
          };
          const unsubscribe = jobs.subscribe(owner, notify);
          const heartbeat = setInterval(() => {
            if (!response.destroyed && !response.writableEnded) response.write(': keep-alive\n\n');
          }, 20_000).unref();
          let streams = runStreams.get(session.id);
          if (!streams) runStreams.set(session.id, streams = new Set());
          const stop = () => response.end();
          streams.add(stop);
          response.once('close', () => {
            clearInterval(heartbeat); unsubscribe(); streams.delete(stop);
            if (!streams.size) runStreams.delete(session.id);
          });
          notify(jobs.version(owner));
          return;
        }
        if (url.pathname === '/api/runs' && request.method === 'GET') {
          const version = jobs.version(owner);
          response.setHeader('ETag', version);
          if (request.headers['if-none-match'] === version) { response.writeHead(304); response.end(); }
          else json(response, 200, { runs: jobs.list(owner) });
          return;
        }
        if (url.pathname === '/api/precheck' && request.method === 'POST') {
          if (!prechecker) throw new HttpError(503, '当前服务不提供提交前检查。');
          const parsed = precheckSchema.safeParse(await readJson(request));
          if (!parsed.success) throw new HttpError(400, '请检查证明环境与 Lean 源码。');
          // A closed tab or a newer edit stops the compile; a superseded check has no reader left to answer.
          const gone = new AbortController();
          response.once('close', () => { if (!response.writableFinished) gone.abort(new PrecheckSuperseded()); });
          try { json(response, 200, { precheck: await prechecker.check(owner, parsed.data as { environment: WebEnvironment; source: string }, gone.signal) }); }
          catch (error) {
            if (error instanceof PrecheckSuperseded) { if (!response.destroyed) json(response, 409, { error: '检查已被更新的版本取代。' }); return; }
            throw error;
          }
          return;
        }
        if (url.pathname === '/api/runs' && request.method === 'POST') {
          const parsed = inputSchema.safeParse(await readJson(request));
          if (!parsed.success) throw new HttpError(400, '请检查题目、API Key、模型、模块方案及运行预算。');
          const provider = config.providers.find(item => item.id === parsed.data.providerId);
          if (!provider) throw new HttpError(400, '该模型服务尚未配置。');
          const { saveKey, requestId: bodyRequestId, ...input } = parsed.data;
          const headerId = request.headers['idempotency-key'];
          if (headerId !== undefined && (typeof headerId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(headerId)
              || bodyRequestId && bodyRequestId !== headerId)) throw new HttpError(400, '提交请求标识无效或不一致。');
          const requestId = bodyRequestId ?? (typeof headerId === 'string' ? headerId : undefined);
          // Confirmed statements retain their exact artifact bytes; ordinary Lean drafts keep the existing normalization.
          if (!input.formalizationId) input.source = input.source.trim();
          if (input.planApproval && (input.coordination !== 'cooperative' || input.workers < 2))
            throw new HttpError(400, '先审计划需要协作模式和至少 2 个 Agent。');
          if (!input.planApproval) delete input.planApproval;
          const previous = jobs.replay(owner, input as WebRunInput, provider, requestId);
          if (previous) { json(response, 200, { run: previous, ...(vault ? { savedKeys: savedKeysFor(session) } : {}) }); return; }
          // A typed key wins; an empty one uses the account's saved key, then the server's key for admins.
          const typed = input.apiKey;
          if (!typed) {
            const held = heldKey(session, provider);
            if (!held) throw new HttpError(400, '请填写 API Key。');
            input.apiKey = held;
          }
          const readiness = await runner.readiness();
          // Another request can be accepted while readiness is being checked.
          const raced = jobs.replay(owner, input as WebRunInput, provider, requestId);
          if (raced) { json(response, 200, { run: raced, ...(vault ? { savedKeys: savedKeysFor(session) } : {}) }); return; }
          if (!readiness.ready) throw new HttpError(503, '运行环境尚未就绪，请先构建 worker 镜像。');
          const from = input.continueFrom as WebContinuation | undefined;
          const saved = from && jobs.get(owner, from.runId) ? trajectories.version(owner, from.runId, from.taskId, from.commit)?.source : undefined;
          if (from && !saved) throw new HttpError(404, '这个版本的代码没有记录或已超出保留范围。');
          const approved = input.formalizationId ? formalizations.confirmed(owner, input.formalizationId) : undefined;
          if (approved && (input.source !== approved.evidence.candidate.source || input.environment !== approved.evidence.request.environment))
            throw new HttpError(409, 'Lean 原题或环境已改变，请重新形式化确认，或作为普通 Lean 题目创建。');
          if (from && jobs.get(owner, from.runId)?.formalizationId !== input.formalizationId)
            throw new HttpError(409, '继续研究必须保留原运行的形式化来源。');
          try {
            const run = jobs.create(owner, input as WebRunInput, provider, from && saved ? { ...from, file: saved.file, source: saved.source } : undefined, requestId,
              approved ? { evidence: approved.evidence, provenance: { id: approved.formalization.id,
                evidenceSha256: approved.formalization.report!.evidenceSha256, original: approved.formalization.original,
                confirmedAt: approved.formalization.confirmedAt!, confirmation: approved.formalization.confirmation ?? 'manual' } } : undefined);
            milestone(owner, 'firstRunAt');
            if (saveKey && typed && vault && session.account) vault.save(session.account.id, provider.id, provider.baseUrl, typed);
            json(response, 201, { run, ...(vault ? { savedKeys: savedKeysFor(session) } : {}) });
          }
          catch (error) {
            if (error instanceof WebStorageError) throw error;
            throw new HttpError(429, error instanceof Error ? error.message : '运行队列已满。');
          }
          return;
        }
        const match = /^\/api\/runs\/([a-f0-9-]{36})(?:\/(.*))?$/.exec(url.pathname);
        if (!match) throw new HttpError(404, '页面或运行不存在。');
        // Derived from the finished proof alone, so the sample answers the same way as an owned run.
        if (['outline', 'verification-kit'].includes(match[2] ?? '')) {
          if (request.method !== 'GET') throw new HttpError(405, '请求方法不受支持。');
          const run = sample && match[1] === webSampleRunId ? sample.run : jobs.get(owner, match[1]);
          if (!run) throw new HttpError(404, '运行不存在或不属于当前会话。');
          if (!run.result?.proof) throw new HttpError(409, '这次运行没有可检查的候选证明。');
          if (match[2] === 'outline') { json(response, 200, { outline: proofOutline(run) }); return; }
          const kit = verificationKit(run);
          if (!kit) throw new HttpError(409, '候选证明中没有找到原题的目标定理。');
          response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': kit.content.length,
            'Content-Disposition': `attachment; filename="${kit.filename}"`, 'Cache-Control': 'no-store' });
          response.end(kit.content); return;
        }
        if (match[2] === 'explanations' || match[2]?.startsWith('explanations/')) {
          const isSample = Boolean(sample && match[1] === webSampleRunId);
          const run = isSample ? sample!.run : jobs.get(owner, match[1]);
          if (!run) throw new HttpError(404, '运行不存在或不属于当前会话。');
          if (!run.result?.proof) throw new HttpError(409, '这次运行没有可讲解的候选证明。');
          const targets = explanationTargets(run);
          if (match[2] === 'explanations' && request.method === 'GET') {
            const overview: WebExplanationOverview = {
              run: { id: run.id, title: run.title, environment: run.environment, providerId: run.providerId, model: run.model,
                effort: run.effort, proof: run.result.proof },
              targets, explanations: isSample ? [] : explanations.list(owner, run.id),
              generation: explanationGeneration(session, run, isSample) };
            json(response, 200, overview); return;
          }
          if (match[2] === 'explanations' && request.method === 'POST') {
            const parsed = explanationSchema.safeParse(await readJson(request));
            if (!parsed.success) throw new HttpError(400, '请检查讲解的目标定理、语言与 API Key。');
            const generation = explanationGeneration(session, run, isSample);
            if ('reason' in generation) throw new HttpError(409, {
              sample: '示例运行只读，不能生成讲解。', not_accepted: '只有通过独立验收的运行可以生成讲解。',
              provider: '证明讲解目前只支持 Sub2API 模型服务。', model: '证明讲解目前只支持 deepseek-flash 模型。',
              runtime: '当前服务不提供证明讲解。' }[generation.reason]);
            if (!targets.some(item => item.name === parsed.data.target)) throw new HttpError(400, '目标定理不在原题中。');
            const provider = config.providers.find(item => item.id === run.providerId)!;
            let apiKey = parsed.data.apiKey;
            if (!apiKey) {
              const saved = vault && session.account ? vault.get(session.account.id, provider.id, provider.baseUrl) : undefined;
              const held = saved ?? (serverKeysFor(session)?.includes(provider.id) ? config.adminKeys![provider.id] : undefined);
              if (!held) throw new HttpError(400, '请填写 API Key。');
              apiKey = held;
            }
            if (!(await runner.readiness()).ready) throw new HttpError(503, '运行环境尚未就绪，请先构建 worker 镜像。');
            json(response, 201, { explanation: explanations.create(owner, run, { target: parsed.data.target,
              language: parsed.data.language as WebExplanationLanguage, apiKey, provider, model: generation.model,
              effort: generation.effort }) });
            return;
          }
          const target = url.searchParams.get('target') ?? '';
          const language = explanationLanguage.safeParse(url.searchParams.get('language'));
          if (!language.success || !targets.some(item => item.name === target)) throw new HttpError(400, '请检查讲解的目标定理与语言。');
          const lang = language.data as WebExplanationLanguage;
          if (match[2] === 'explanations/item' && request.method === 'GET') {
            const explanation = isSample ? undefined : explanations.read(owner, run, target, lang);
            if (!explanation) throw new HttpError(404, '这份讲解还没有生成。');
            json(response, 200, { explanation }); return;
          }
          if (match[2] === 'explanations/item' && request.method === 'DELETE') {
            const removed = isSample ? 'missing' : explanations.remove(owner, run.id, target, lang);
            if (removed === 'active') throw new HttpError(409, '讲解正在生成，请先取消。');
            if (removed === 'missing') throw new HttpError(404, '这份讲解还没有生成。');
            json(response, 200, { deleted: true }); return;
          }
          if (match[2] === 'explanations/cancel' && request.method === 'POST') {
            const explanation = isSample ? undefined : explanations.cancel(owner, run.id, target, lang);
            if (!explanation) throw new HttpError(404, '这份讲解还没有生成。');
            json(response, 200, { explanation }); return;
          }
          if (match[2] === 'explanations/markdown' && request.method === 'GET') {
            const stored = isSample ? undefined : explanations.get(owner, run.id, target, lang);
            const evidence = stored?.status === 'approved' ? storage.getExplanationEvidence(owner, run.id, explanationKey(target, lang)) : undefined;
            if (!evidence) throw new HttpError(404, '这份讲解还没有生成。');
            let markdown: string;
            // Checked again on every download: the evidence must still match this run's proof and environment.
            try { ({ markdown } = verifyExplanationEvidence(evidence, { proof: run.result.proof, target, language: lang, environment: run.environment })); }
            catch { throw new HttpError(409, '已保存的讲解与这次运行的证明不一致。'); }
            const body = Buffer.from(markdown, 'utf8');
            response.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Length': body.length,
              'Content-Disposition': `attachment; filename="${explanationMarkdownFilename(run.id, target, lang)}"`, 'Cache-Control': 'no-store' });
            response.end(body); return;
          }
          throw new HttpError(405, '请求方法不受支持。');
        }
        if (sample && match[1] === webSampleRunId) {
          const answer = webSampleResponse(sample, match[2], request.method || 'GET', url.searchParams);
          if (answer.filename) response.setHeader('Content-Disposition', `attachment; filename="${answer.filename}"`);
          json(response, answer.status, answer.body); return;
        }
        const run = jobs.get(owner, match[1]);
        if (!run) throw new HttpError(404, '运行不存在或不属于当前会话。');
        const operation = match[2];
        if (operation === 'observation' && request.method === 'GET') {
          json(response, 200, { observation: run.observation ?? null }); return;
        }
        if (operation === 'events' && request.method === 'GET') {
          const after = Number(url.searchParams.get('after') ?? 0);
          if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, '事件游标无效。');
          // Pages read only their own records, so a reader can walk a long run's whole history.
          const { first: firstSequence, last: lastSequence } = storage.eventRange(owner, run.id);
          json(response, 200, { events: storage.listEventsAfter(owner, run.id, after, 200),
            firstSequence, lastSequence, droppedBefore: firstSequence > 1 ? firstSequence : null }); return;
        }
        if (operation === 'trajectory' && request.method === 'GET') {
          const query = trajectoryQuery(url.searchParams);
          if (!query) throw new HttpError(400, '轨迹游标无效。');
          json(response, 200, { trajectory: trajectories.page(owner, run.id, query) }); return;
        }
        if (operation === 'actions' && request.method === 'GET') {
          const after = Number(url.searchParams.get('after') ?? 0);
          if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, '动作游标无效。');
          const actions = storage.listActionsAfter(owner, run.id, after, webAgentActionLimits.page);
          json(response, 200, { actions, count: run.actions?.count ?? 0, dropped: run.actions?.dropped ?? 0 }); return;
        }
        if (operation === 'trajectory/version' && request.method === 'GET') {
          const query = trajectoryVersionQuery(url.searchParams);
          if (!query) throw new HttpError(400, '版本参数无效。');
          const version = trajectories.version(owner, run.id, query.taskId, query.commit);
          if (!version) throw new HttpError(404, '这个版本没有记录或已超出保留范围。');
          json(response, 200, { version }); return;
        }
        if (operation === 'explain' && request.method === 'POST') {
          const parsed = explainSchema.safeParse(await readJson(request));
          if (!parsed.success) throw new HttpError(400, '请检查问题、版本与 API Key。');
          const provider = config.providers.find(item => item.id === run.providerId);
          if (!provider) throw new HttpError(409, '这次运行的模型服务已不在配置中。');
          const apiKey = parsed.data.apiKey || heldKey(session, provider);
          if (!apiKey) throw new HttpError(400, '请填写 API Key。');
          const version = trajectories.version(owner, run.id, parsed.data.taskId, parsed.data.commit);
          if (!version) throw new HttpError(404, '这个版本没有记录或已超出保留范围。');
          const feedback = failedFeedback(version.checks);
          if (!feedback) throw new HttpError(409, '这个版本没有未通过的 Lean 检查可以解释。');
          const objective = run.observation?.plan?.tasks.find(task => task.id === version.taskId)?.objective;
          const input = explainInput(run, version, feedback, parsed.data.turns as WebExplainTurn[], parsed.data.question, objective);
          // Closing the panel or the tab stops the call; the provider bills what it already produced.
          const gone = new AbortController();
          response.once('close', () => { if (!response.writableFinished) gone.abort(); });
          try { json(response, 200, await explainer.ask(owner, { baseUrl: provider.baseUrl, apiKey, model: run.model, input }, gone.signal)); }
          catch (error) {
            if (!(error instanceof WebExplainError)) throw error;
            if (gone.signal.aborted) return;
            throw new HttpError(error.status, error.message);
          }
          return;
        }
        const sourceMatch = /^tasks\/([^/]+)\/source$/u.exec(operation ?? '');
        if (sourceMatch && request.method === 'GET') {
          const source = storage.getTaskSource(owner, run.id, decodeURIComponent(sourceMatch[1]), url.searchParams.get('version') ?? undefined);
          if (!source) throw new HttpError(404, '该任务版本没有已保存的源码。');
          json(response, 200, { source }); return;
        }
        const checkMatch = /^checks\/([^/]+)$/u.exec(operation ?? '');
        if (checkMatch && request.method === 'GET') {
          const check = storage.getCheckReceipt(owner, run.id, decodeURIComponent(checkMatch[1]));
          if (!check) throw new HttpError(404, '检查回执不存在或未保存。');
          json(response, 200, { check }); return;
        }
        const guidanceMatch = /^guidance\/([A-Za-z0-9_-]{1,64})$/u.exec(operation ?? '');
        if (guidanceMatch && request.method === 'GET') {
          const guidance = jobs.guidance(owner, run.id, guidanceMatch[1]);
          if (!guidance) throw new HttpError(404, '指导回执尚不可用。');
          json(response, 200, { guidance }); return;
        }
        const commandMatch = /^commands\/([A-Za-z0-9_-]{1,64})$/u.exec(operation ?? '');
        if (commandMatch && request.method === 'GET') {
          const receipt = jobs.commandReceipt(owner, run.id, commandMatch[1]);
          if (!receipt) throw new HttpError(404, '命令回执尚不可用。');
          json(response, 200, { receipt }); return;
        }
        if (operation === 'guidance' && request.method === 'POST') {
          const parsed = webGuidanceSchema.safeParse(await readJson(request));
          if (!parsed.success) throw new HttpError(400, '请检查指导对象、任务版本与内容。');
          try { json(response, 200, { receipt: await jobs.command(owner, run.id, { type: 'guidance', guidance: parsed.data }) }); }
          catch (error) { throw new HttpError(409, error instanceof Error ? error.message : '指导未能提交。'); }
          return;
        }
        if (operation === 'plan-approval' && request.method === 'POST') {
          const parsed = webPlanApprovalSchema.safeParse(await readJson(request));
          if (!parsed.success) throw new HttpError(400, '请重新读取当前计划后再批准。');
          try { json(response, 200, { receipt: await jobs.command(owner, run.id, { type: 'plan-approval', approval: parsed.data }) }); }
          catch (error) { throw new HttpError(409, error instanceof Error ? error.message : '计划批准未能提交。'); }
          return;
        }
        if (['edits/preview', 'edits'].includes(operation ?? '') && request.method === 'POST') {
          const parsed = webPlanProposalSchema.safeParse(await readJson(request));
          if (!parsed.success) throw new HttpError(400, '计划草稿格式无效，请保留完整计划与基线版本。');
          try { json(response, 200, { receipt: await jobs.command(owner, run.id, {
            type: operation === 'edits/preview' ? 'edit-preview' : 'edit', proposal: parsed.data,
          }) }); }
          catch (error) { throw new HttpError(409, error instanceof Error ? error.message : '计划未能提交。'); }
          return;
        }
        if (operation === 'archive' && request.method === 'POST') {
          json(response, 200, { archive: await jobs.archive(owner, run.id) }); return;
        }
        const archiveMatch = /^archives\/([a-f0-9-]{36})$/u.exec(operation ?? '');
        if (archiveMatch && request.method === 'GET') {
          const archive = storage.getArchive(owner, run.id, archiveMatch[1]);
          if (!archive) throw new HttpError(404, '归档不存在。');
          response.setHeader('Content-Disposition', `attachment; filename="theoremos-${run.id}-archive.json"`);
          json(response, 200, archive); return;
        }
        if (operation === 'share') {
          const link = (token: string, createdAt: string): WebShareLink =>
            ({ token, createdAt, url: new URL(`share.html#${token}`, origin).href });
          if (request.method === 'GET') {
            const share = storage.getOwnShare(owner, run.id);
            json(response, 200, { share: share ? link(share.token, share.createdAt) : null }); return;
          }
          if (request.method === 'POST') {
            const existing = storage.getOwnShare(owner, run.id);
            if (existing) { json(response, 200, { share: link(existing.token, existing.createdAt) }); return; }
            const createdAt = new Date().toISOString(), snapshot = shareSnapshot(run, createdAt);
            if (!snapshot) throw new HttpError(409, '只有通过独立验收的运行可以分享。');
            const token = crypto.randomBytes(24).toString('base64url');
            storage.saveShare(owner, run.id, { token, createdAt, snapshot });
            json(response, 201, { share: link(token, createdAt) }); return;
          }
          if (request.method === 'DELETE') { storage.deleteShare(owner, run.id); json(response, 200, { share: null }); return; }
          throw new HttpError(405, '请求方法不受支持。');
        }
        if (match[2] === 'cancel' && request.method === 'POST') { json(response, 200, { run: jobs.cancel(owner, run.id) }); return; }
        if (!match[2] && request.method === 'DELETE') {
          if (explanations.active(owner, run.id)) throw new HttpError(409, '这次运行的证明讲解正在生成，请先取消或等待结束。');
          const removed = jobs.remove(owner, run.id);
          if (removed === 'active') throw new HttpError(409, '排队中或运行中的任务不能删除，请先取消或等待结束。');
          if (removed === 'missing') throw new HttpError(404, '运行不存在或不属于当前会话。');
          trajectories.forget(owner, run.id);
          json(response, 200, { deletedId: run.id }); return;
        }
        if (match[2] === 'download' && request.method === 'GET') {
          if (!run.result && !['completed', 'cancelled', 'error'].includes(run.status))
            throw new HttpError(409, '运行尚未结束，且结果尚未生成。');
          response.setHeader('Content-Disposition', `attachment; filename="theoremos-${run.id}.json"`);
          json(response, 200, { schema: 'theorem-os.web-export.v1', run }); return;
        }
        if (!match[2] && request.method === 'GET') { json(response, 200, { run }); return; }
        throw new HttpError(405, '请求方法不受支持。');
      }
      if (!['GET', 'HEAD'].includes(request.method || '')) throw new HttpError(405, '请求方法不受支持。');
      // A signed-out visitor goes straight to the login page instead of loading the workbench only to be sent there;
      // a run link keeps its run (login.html?run=<id>) so signing in returns to it.
      if (auth && ['/', '/index.html'].includes(url.pathname) && !cookieSession(request)?.account) {
        const run = url.searchParams.get('run');
        response.writeHead(302, { Location: run && /^[a-f0-9-]{1,36}$/u.test(run) ? `/login.html?run=${run}` : '/login.html' });
        response.end(); return;
      }
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      const file = path.resolve(config.staticRoot, relative);
      if (!file.startsWith(config.staticRoot + path.sep) || !fs.existsSync(file) || !fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())
        throw new HttpError(404, '页面不存在，请先运行 bun run build:web。');
      if (!fs.realpathSync(file).startsWith(fs.realpathSync(config.staticRoot) + path.sep))
        throw new HttpError(404, '文件不存在。');
      const allowed: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
      // Only the checked, shared proof archive adds JSON/Lean downloads; account-owned records remain behind /api/runs.
      const extension = path.extname(file);
      const archiveType = file.startsWith(path.join(config.staticRoot, 'classics') + path.sep)
        ? extension === '.json' ? 'application/json; charset=utf-8' : extension === '.lean' ? 'text/plain; charset=utf-8' : undefined
        : undefined;
      const contentType = allowed[extension] ?? archiveType;
      if (!contentType) throw new HttpError(404, '文件不存在。');
      sendStatic(request, response, file, path.extname(file), contentType);
    } catch (error) {
      const invalidKnowledgeInput = error instanceof Error && /^math_knowledge_(?:invalid_query|invalid_dependency_options|(?:source|metadata|consumers|finding)_(?:options_invalid|position_invalid|budget_too_small))$/u.test(error.message);
      const known = error instanceof HttpError || error instanceof WebStorageError || error instanceof WebAuthError;
      if (!response.headersSent) json(response, known ? error.status : invalidKnowledgeInput ? 400 : 500,
        { error: known ? error.message : invalidKnowledgeInput ? '知识查询或分页参数无效。' : '服务暂时不可用。' });
      else response.end();
    }
  });
  server.requestTimeout = 15_000; server.headersTimeout = 10_000;
  const close = async () => {
    clearInterval(maintenance);
    prechecker?.close();
    for (const streams of runStreams.values()) for (const stop of streams) stop();
    server.closeIdleConnections();
    await Promise.all([jobs.close(), explanations.close(), formalizations.close(), conversations.close(), new Promise<void>(resolve => server.close(() => resolve()))]);
  };
  return { server, jobs, explanations, formalizations, conversations, storage, knowledge, registry, auth, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const config = readWebConfig({ ...process.env, THEOREMOS_WEB_DATA_ROOT: process.env.THEOREMOS_WEB_DATA_ROOT || 'out/web-data' });
  const service = createWebService(config);
  service.server.listen(config.port, config.host, () => console.log(`TheoremOS workbench: ${config.publicUrl}`));
  let stopping = false;
  const stop = () => { if (!stopping) { stopping = true; void service.close().then(() => process.exit(0)); } };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
