import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { getWebEnvironments, readWebConfig, webDefaults, webLimits, webTemplates, type WebConfig } from './config';
import { DockerWebRunner, type WebRunner } from './runner';
import { WebJobs } from './jobs';
import type { WebRunInput, WebSession } from './shared';
import { researchModulePlanSchema } from '../../src/solver/modules/policy';
import { WebStorage, WebStorageError } from './storage';
import { WebKnowledgeService, type WebKnowledgeDetailOptions } from './knowledgeService';
import { WebModuleRegistry } from './moduleRegistry';
import { webGuidanceSchema, webPlanProposalSchema } from './collaborationValidation';
import { WebAuth, WebAuthError, type WebMailer } from './auth';
import { shareSnapshot, webShareToken, type WebShareLink } from './share';
import { loadWebSample, webSampleResponse, webSampleRunId, type WebSampleFile } from './sample';

const inputSchema = z.object({
  providerId: z.string().min(1).max(40), apiKey: z.string().min(8).max(4096).regex(/^[\x21-\x7e]+$/),
  model: z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
  environment: z.enum(['standard', 'mathlib']).default('standard'),
  source: z.string().trim().min(1).refine(value => Buffer.byteLength(value) <= webLimits.maxSourceBytes),
  task: z.string().trim().min(1).refine(value => Buffer.byteLength(value) <= webLimits.maxTaskBytes),
  maxTurns: z.number().int().min(1).max(webLimits.maxTurns),
  maxRunSeconds: z.number().int().min(30).max(webLimits.maxRunSeconds),
  maxTotalTokens: z.number().int().min(10_000).max(webLimits.maxTotalTokens).optional(),
  workers: z.number().int().min(1).max(webLimits.maxWorkers),
  coordination: z.enum(['cooperative', 'independent']),
  modulePlan: researchModulePlanSchema.optional(),
  knowledgeDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
}).strict();

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
const equal = (left: string, right: string) => /^[a-f0-9]{64}$/.test(left) &&
  /^[a-f0-9]{64}$/.test(right) && crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
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

type Session = { id: string; csrf: string; touchedAt: number; account?: { id: string; email: string } };
const objectBody = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
export function createWebService(config: WebConfig, runner: WebRunner = new DockerWebRunner(config),
  options: { mailer?: WebMailer; captchaAnswer?: () => string; sample?: WebSampleFile | null } = {}) {
  const storage = new WebStorage(config.dataRoot);
  // null disables the sample; omitted loads the one shipped with the image.
  const sample = options.sample === undefined ? loadWebSample() : options.sample ?? undefined;
  const knowledge = new WebKnowledgeService(storage);
  const registry = new WebModuleRegistry(storage);
  const sessions = new Map<string, Session>(storage.listSessions().map(session => [session.id, session]));
  const jobs = new WebJobs(runner, config, { storage, knowledge });
  const auth = config.auth ? new WebAuth(config.auth, storage, options.mailer, options.captchaAnswer) : undefined;
  // With login enabled, records belong to the account; otherwise to the anonymous browser session.
  const ownerOf = (session: Session) => auth ? session.account && `account:${session.account.id}` : session.id;
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
  const startSession = (account?: Session['account']) => {
    const session: Session = { id: crypto.randomBytes(32).toString('hex'), csrf: crypto.randomBytes(32).toString('hex'), touchedAt: Date.now(),
      ...(account ? { account } : {}) };
    sessions.set(session.id, session);
    return session;
  };
  /** Ends one browser session. Anonymous records go with it; account records stay with the account. */
  const endSession = (id: string) => {
    for (const stop of runStreams.get(id) ?? []) stop();
    if (!auth) { jobs.forget(id); storage.deleteOwner(id); }
    sessions.delete(id); storage.deleteSession(id);
  };
  const prune = () => {
    for (const [id, session] of sessions) {
      // Login-page sessions without an account only need to outlive one sign-in attempt.
      const ttl = auth && !session.account ? Math.min(config.sessionTtlMs, 60 * 60_000) : config.sessionTtlMs;
      if (Date.now() - session.touchedAt > ttl) endSession(id);
    }
    for (const [ip, rate] of rates) if (rate.expiresAt <= Date.now()) rates.delete(ip);
    auth?.prune();
  };
  const maintenance = setInterval(prune, 60_000).unref();
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('X-Robots-Tag', 'noindex, nofollow');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (secure) response.setHeader('Strict-Transport-Security', 'max-age=31536000');
    try {
      if (request.url === '/healthz') { json(response, 200, { ok: true }); return; }
      if (request.headers.host !== origin.host) throw new HttpError(403, '访问地址与服务配置不一致。');
      if (request.headers.origin && request.headers.origin !== origin.origin) throw new HttpError(403, '跨站请求已拒绝。');
      const url = new URL(request.url || '/', origin);
      if (url.origin !== origin.origin) throw new HttpError(403, '访问地址无效。');
      if (url.pathname.startsWith('/api/')) {
        prune();
        const ip = request.socket.remoteAddress || '';
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
        const cookie = request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith('theoremos_session='))?.slice(18);
        let session = cookie ? sessions.get(cookie) : undefined;
        // An address removed from the allowlist, or a deleted account, loses its signed-in sessions.
        if (session?.account && auth && !(auth.allowed(session.account.email) && auth.getAccount(session.account.email)?.id === session.account.id)) {
          endSession(session.id); session = undefined;
        }
        if (request.method === 'GET' && url.pathname === '/api/session') {
          if (!session) {
            const anonymous = [...sessions.values()].filter(item => !item.account).length;
            if (anonymous >= 200 || sessions.size >= 2_000) throw new HttpError(503, '当前会话数已满，请稍后重试。');
            session = startSession();
          }
          setSessionCookie(response, session);
          session.touchedAt = Date.now();
          storage.saveSession(session);
          const body: WebSession = { csrfToken: session.csrf, auth: auth ? 'email' : 'none',
            ...(session.account ? { account: { email: session.account.email } } : {}), providers: config.providers, environments: getWebEnvironments(),
            templates: webTemplates, defaults: webDefaults, limits: webLimits, runtime: await runner.readiness(),
            ...(sample ? { sample: { id: sample.run.id, title: sample.run.title } } : {}) };
          json(response, 200, body); return;
        }
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
            const next = startSession({ id: account.id, email: account.email });
            storage.saveSession(next); setSessionCookie(response, next);
            json(response, 200, { account: { email: account.email }, csrfToken: next.csrf }); return;
          }
          if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
            endSession(session.id); clearSessionCookie(response); json(response, 200, { ok: true }); return;
          }
          if (url.pathname === '/api/auth/account' && request.method === 'DELETE') {
            const account = session.account;
            if (!account) throw new HttpError(401, '请先登录。');
            const confirmation = objectBody(await readJson(request)).email;
            if (typeof confirmation !== 'string' || confirmation.trim().toLowerCase() !== account.email)
              throw new HttpError(400, '请输入当前账号的邮箱以确认删除。');
            const owner = ownerOf(session)!;
            jobs.forget(owner); storage.deleteOwner(owner); auth.deleteAccount(account.email);
            for (const [id, other] of sessions) if (other.account?.id === account.id) endSession(id);
            clearSessionCookie(response); json(response, 200, { deleted: true }); return;
          }
          throw new HttpError(405, '请求方法不受支持。');
        }
        const owner = ownerOf(session);
        if (!owner) throw new HttpError(401, '请先登录。');
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
        if (url.pathname === '/api/runs' && request.method === 'POST') {
          const parsed = inputSchema.safeParse(await readJson(request));
          if (!parsed.success) throw new HttpError(400, '请检查题目、API Key、模型、模块方案及运行预算。');
          const provider = config.providers.find(item => item.id === parsed.data.providerId);
          if (!provider) throw new HttpError(400, '该模型服务尚未配置。');
          if (!(await runner.readiness()).ready) throw new HttpError(503, '运行环境尚未就绪，请先构建 worker 镜像。');
          try { json(response, 201, { run: jobs.create(owner, parsed.data as WebRunInput, provider) }); }
          catch (error) {
            if (error instanceof WebStorageError) throw error;
            throw new HttpError(429, error instanceof Error ? error.message : '运行队列已满。');
          }
          return;
        }
        const match = /^\/api\/runs\/([a-f0-9-]{36})(?:\/(.*))?$/.exec(url.pathname);
        if (!match) throw new HttpError(404, '页面或运行不存在。');
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
          const events = storage.getEvents(owner, run.id);
          const firstSequence = events[0]?.sequence ?? 0, lastSequence = events.at(-1)?.sequence ?? 0;
          json(response, 200, { events: events.filter(event => event.sequence > after).slice(0, 200),
            firstSequence, lastSequence, droppedBefore: firstSequence > 1 ? firstSequence : null }); return;
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
          const removed = jobs.remove(owner, run.id);
          if (removed === 'active') throw new HttpError(409, '排队中或运行中的任务不能删除，请先取消或等待结束。');
          if (removed === 'missing') throw new HttpError(404, '运行不存在或不属于当前会话。');
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
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      const file = path.resolve(config.staticRoot, relative);
      if (!file.startsWith(config.staticRoot + path.sep) || !fs.existsSync(file) || !fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())
        throw new HttpError(404, '页面不存在，请先运行 bun run build:web。');
      if (!fs.realpathSync(file).startsWith(fs.realpathSync(config.staticRoot) + path.sep))
        throw new HttpError(404, '文件不存在。');
      const allowed: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
      const contentType = allowed[path.extname(file)];
      if (!contentType) throw new HttpError(404, '文件不存在。');
      response.writeHead(200, { 'Content-Type': contentType });
      if (request.method === 'HEAD') response.end();
      else fs.createReadStream(file).on('error', () => response.destroy()).pipe(response);
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
    for (const streams of runStreams.values()) for (const stop of streams) stop();
    server.closeIdleConnections();
    await Promise.all([jobs.close(), new Promise<void>(resolve => server.close(() => resolve()))]);
  };
  return { server, jobs, storage, knowledge, registry, auth, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const config = readWebConfig({ ...process.env, THEOREMOS_WEB_DATA_ROOT: process.env.THEOREMOS_WEB_DATA_ROOT || 'out/web-data' });
  const service = createWebService(config);
  service.server.listen(config.port, config.host, () => console.log(`TheoremOS workbench: ${config.publicUrl}`));
  let stopping = false;
  const stop = () => { if (!stopping) { stopping = true; void service.close().then(() => process.exit(0)); } };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
