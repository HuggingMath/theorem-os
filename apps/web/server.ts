import { publicWebProvider, webProviderHarness, webHarnessResearchError } from './harness';
import { nativeTeamCapacitySchema, nativeTeamPreferencesSchema, webDefaultSkillLoading, webPortfolioSecondsSchema } from './researchMode';
import { webTeamProfiles } from './nativeTeamProfiles';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { z } from 'zod';
import { getWebEnvironments, readWebConfig, webDefaults, webExplanationLimits, webLimits, webTemplates, webProvidersForAccount, type WebConfig } from './config';
import { DockerWebRunner, type WebRunner } from './runner';
import { WebJobs } from './jobs';
import { accountLogin, webAgentActionLimits, webContinuationLabelMax, type WebAccountIdentity, type WebAdminOverview, type WebContinuation, type WebEffort,
  type WebExplanationLanguage, type WebExplanationOverview, type WebProvider, type WebRun, type WebRunInput, type WebSession, workbenchReturn } from './shared';
import { researchModulePlanSchema, type ResearchModulePlan } from '../../src/solver/modules/policy';
import { WebStorage, WebStorageError } from './storage';
import { WebKnowledgeService, type WebKnowledgeDetailOptions } from './knowledgeService';
import { WebModuleRegistry } from './moduleRegistry';
import { webGuidanceSchema, webPlanApprovalSchema, webPlanProposalSchema } from './collaborationValidation';
import { WebAuth, WebAuthError, type WebMailer, type WebMilestone } from './auth';
import { WebSessionAdmission, WebAdmissionError } from './admission';
import { WebOperations } from './operations';
import { checkWebProvider, WebProviderCheckError } from './providerCheck';
import { shareSnapshot, webShareToken, type WebShareLink } from './share';
import { productStatus, readProductBuild } from './productStatus';
import { loadWebSample, webSampleResponse, webSampleRunId, type WebSampleFile } from './sample';
import { PrecheckSuperseded, WebPrechecker } from './precheck';
import { proofOutline, verificationKit, zip } from './verificationKit';
import { WebPaperDrafts } from './paperDrafts';
import { WebPaperPdf, WebPaperPdfError } from './paperPdf';
import type { WebPaperOverview } from './paperTypes';
import { paperTemplate } from '../../src/math/paperDraft';
import { acceptedEncoding, sendStatic } from './staticFiles';
import { webFunnel } from './funnel';
import { completionMail, mailsCompletion, planApprovalMail } from './completionMail';
import { WebKeyVault } from './keyVault';
import { WebQuota, WebQuotaError, type WebQuotaKind } from './quota';
import { trajectoryQuery, trajectoryVersionQuery, WebTrajectories } from './trajectory';
import { explainInput, failedFeedback, WebExplainError, WebExplainer, webExplainLimits, type WebExplainTurn } from './explain';
import { explanationMarkdownFilename, verifyExplanationEvidence } from './explanation';
import { explanationKey, WebExplanations } from './explanations';
import { WebFormalizations } from './formalizations';
import { webFormalizationDefaults, webFormalizationLimits, type WebFormalizationCapabilities, type WebFormalizationRequest } from './formalizationTypes';
import { SUB2API_PROVIDER } from '../../src/runtime/sub2api';
import { inspectScopedLeanDeclarations } from '../../src/math/leanSource';
import { formalizationCompiledCandidate, formalizationCompiledCandidateDigest, formalizationDigest } from '../../src/math/formalization';
import { isStatementReviewed } from './presentation';
import { WebConversations } from './conversations';
import { webConversationLimits } from './conversationTypes';
import { WebResearchApi, researchSelectionSchema } from './researchApi';
import { combineWebLibraryPacks } from './formalizationSeed';
import { selectWebLibraryPack } from './frozenLibrary';
import type { ResearchConfigurationSelection, ResearchLibraryPack } from './researchAssetTypes';
import { canonicalMathJson, mathDigest } from '../../src/math/mathRuntimeIo';
import { researchLibraryProposalOriginSchema } from './researchLibraryProposalOrigin';
import { webResearchModeError } from './researchMode';

const inputSchema = z.object({
  requestId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u).optional(),
  // Empty asks for the key this account saved, then the one the server holds for admins (THEOREMOS_WEB_ADMIN_KEYS).
  providerId: z.string().min(1).max(40), apiKey: z.string().max(4096).regex(/^(?:[\x21-\x7e]{8,})?$/), saveKey: z.boolean().optional(),
  model: z.string().trim().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/),
  effort: z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max']),
  environment: z.enum(['standard', 'mathlib']).optional(),
  source: z.string().min(1).refine(value => value.trim().length > 0 && Buffer.byteLength(value) <= webLimits.maxSourceBytes),
  task: z.string().trim().min(1).refine(value => Buffer.byteLength(value) <= webLimits.maxTaskBytes),
  maxTurns: z.union([z.literal(0), z.number().int().min(1).max(webLimits.maxTurns)]).default(0),
  maxRunSeconds: z.union([z.literal(0), z.number().int().min(30).max(webLimits.maxRunSeconds)]).default(0),
  maxTotalTokens: z.union([z.literal(0), z.number().int().min(10_000).max(webLimits.maxTotalTokens)]).default(0),
  workers: z.number().int().min(1).max(webLimits.maxWorkers),
  coordination: z.enum(['cooperative', 'independent']),
  autoExplain: z.boolean().optional(),
  explanationLanguage: z.enum(['zh', 'en']).optional(),
  researchMode: z.enum(['legacy', 'skill']).optional(),
  skillLoading: z.enum(['native', 'file']).optional(),
  portfolioExploration: z.boolean().optional(),
  portfolioSeconds: webPortfolioSecondsSchema.optional(),
  nativeTeamCapacity: nativeTeamCapacitySchema.optional(),
  nativeTeamPreferredProfiles: nativeTeamPreferencesSchema.optional(),
  planApproval: z.boolean().optional(),
  modulePlan: researchModulePlanSchema.optional(),
  researchSelection: researchSelectionSchema.optional(),
  libraryProposalOrigin: researchLibraryProposalOriginSchema.optional(),
  budgetOrigin: z.object({ runId: z.string().uuid(), projectId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u) }).strict().optional(),
  knowledgeDigest: z.string().regex(/^[a-f0-9]{64}$/u).nullable().optional(),
  formalizationId: z.string().uuid().optional(),
  // Names a version of one of the account's runs; its saved file is looked up here, never taken from the request.
  continueFrom: z.object({ runId: z.string().regex(/^[a-f0-9-]{36}$/u), taskId: z.string().min(1).max(200),
    commit: z.string().regex(/^[A-Za-z0-9]{1,128}$/u),
    taskVersion: z.string().min(1).max(200).optional(), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    environmentDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(), file: z.string().min(1).max(1000).regex(/^[^\p{Cc}]*$/u).optional(),
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
  nativeTeam: z.boolean().optional(),
  checkScope: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/u).optional(),
  environment: z.enum(['standard', 'mathlib']).default(webDefaults.environment),
  source: z.string().min(1).refine(value => Buffer.byteLength(value) <= webLimits.maxSourceBytes),
  researchSelection: researchSelectionSchema.optional(),
}).strict();
const explanationLanguage = z.enum(['zh', 'en']);
const explanationSchema = z.object({
  target: z.string().min(1).max(512), language: explanationLanguage,
  // Empty uses the account's saved key, then the server's key for admins, as for runs.
  apiKey: z.string().max(4096).regex(/^(?:[\x21-\x7e]{8,})?$/).default(''),
}).strict();
const formalizationSchema = z.object({
  requestId: inputSchema.shape.requestId,
  original: z.string().min(1).refine(value => value.trim().length > 0 && Buffer.byteLength(value) <= webFormalizationLimits.maxOriginalBytes),
  environment: z.enum(['standard', 'mathlib']).default(webDefaults.environment), effort: z.enum(['low', 'high', 'max']).optional(),
  researchEffort: z.enum(['low', 'high', 'max']).optional(),
  autoExplain: inputSchema.shape.autoExplain,
  explanationLanguage: inputSchema.shape.explanationLanguage,
  apiKey: z.string().max(4096).regex(/^(?:[\x21-\x7e]{8,})?$/).default(''),
  solve: z.boolean().optional(), humanReview: z.boolean().optional(),
  providerId: inputSchema.shape.providerId.optional(), model: inputSchema.shape.model.optional(),
  maxRunSeconds: z.union([z.literal(0), z.number().int().min(30).max(webFormalizationLimits.maxRunSeconds)]).optional(),
  maxTotalTokens: z.union([z.literal(0), z.number().int().min(10_000).max(webFormalizationLimits.maxTotalTokens)]).optional(),
  research: z.object({ maxRunSeconds: inputSchema.shape.maxRunSeconds, maxTurns: inputSchema.shape.maxTurns,
    maxTotalTokens: inputSchema.shape.maxTotalTokens }).strict().optional(),
}).strict();
const conversationSchema = z.object({ formalizationId: z.string().uuid().optional(), runId: z.string().uuid().optional() })
  .strict().refine(value => Boolean(value.formalizationId || value.runId));
const conversationMessageSchema = z.object({ text: z.string().trim().min(1).max(webConversationLimits.question),
  requestId: inputSchema.shape.requestId,
  apiKey: z.string().max(4096).regex(/^(?:[\x21-\x7e]{8,})?$/).default('') }).strict();
const paperQuery = z.object({ target: z.string().min(1).max(512).optional(), language: z.enum(['en', 'zh']).default('en') });
const paperRequest = paperQuery.extend({ providerId: inputSchema.shape.providerId.optional(), model: inputSchema.shape.model.optional(),
  apiKey: conversationMessageSchema.shape.apiKey }).strict();
// Explanation roles accept only these Codex efforts (src/runtime/sub2api.ts).
const explanationEffort = (effort: WebEffort): 'low' | 'high' | 'max' =>
  effort === 'low' ? 'low' : effort === 'medium' || effort === 'high' ? 'high' : 'max';
const gatewayProvider = (provider: WebProvider | undefined) => {
  if (provider?.id !== SUB2API_PROVIDER.id || webProviderHarness(provider) !== 'codex') return false;
  const url = new URL(provider.baseUrl);
  return url.protocol === 'http:' && url.pathname.replace(/\/$/u, '') === '/v1';
};
const formalizationProvider = (provider: WebProvider | undefined) => !!provider && webProviderHarness(provider) === 'codex' &&
  (gatewayProvider(provider) || provider.id !== SUB2API_PROVIDER.id && new URL(provider.baseUrl).protocol === 'https:');
const providerModel = (provider: WebProvider) => provider.id === SUB2API_PROVIDER.id ? SUB2API_PROVIDER.defaultModel : 'gpt-6.1-sol';

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
function paperPdfHttpError(error: WebPaperPdfError): HttpError {
  const location = error.file && Number.isSafeInteger(error.line) ? `${error.file}:${error.line}` : '';
  const detail = error.detail ? ' ' + error.detail : '';
  switch (error.code) {
    case 'paper_pdf_busy': return new HttpError(429, 'PDF 编译任务较多，请稍后重试。');
    case 'paper_pdf_runtime_unavailable': return new HttpError(503, 'PDF 编译环境尚未配置。');
    case 'paper_pdf_timeout': return new HttpError(504, 'PDF 编译超时，请稍后重试。');
    case 'paper_pdf_source_too_large': return new HttpError(413, '论文源稿过大。');
    case 'paper_pdf_output_too_large': return new HttpError(413, 'PDF 编译产物过大。');
    case 'paper_pdf_cancelled': return new HttpError(499, 'PDF 编译已取消。');
    case 'paper_pdf_container_failed': return new HttpError(503, 'PDF 编译容器不可用。');
    case 'paper_pdf_invalid_output': return new HttpError(502, 'PDF 编译结果无效。');
    case 'paper_pdf_missing_output': return new HttpError(422, 'PDF 编译未生成产物。');
    default: return location
      ? new HttpError(422, `PDF 编译失败（${location}）。${detail || '请检查 LaTeX 源码。'}`)
      : new HttpError(422, `PDF 编译失败。${detail || '请检查 LaTeX 源码。'}`);
  }
}
const equal = (left: string, right: string) => /^[a-f0-9]{64}$/.test(left) &&
  /^[a-f0-9]{64}$/.test(right) && crypto.timingSafeEqual(Buffer.from(left), Buffer.from(right));
/** The coding each request accepts, so JSON bodies can be compressed without passing the request along. */
const jsonEncodings = new WeakMap<ServerResponse, 'br' | 'gzip'>();
// A run carries its sources and report, so the list and the Agents' actions run to tens of KB each. no-transform keeps
// Cloudflare from compressing them, so the server does: a fast brotli level costs a few ms even for MBs of JSON.
const jsonBrotli = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } };
function json(response: ServerResponse, status: number, body: unknown, revalidate?: IncomingMessage) {
  const text = JSON.stringify(body);
  if (revalidate) {
    // Hash the response itself: streamed text and linked records can change within the same millisecond.
    const tag = `"${crypto.createHash('sha256').update(text).digest('hex')}"`;
    response.setHeader('ETag', `W/${tag}`);
    if (text.length >= 2048) response.setHeader('Vary', 'Accept-Encoding');
    if (revalidate.headers['if-none-match']?.split(',').some(candidate => {
      const value = candidate.trim();
      return value === '*' || value.replace(/^W\//u, '') === tag;
    })) {
      response.writeHead(304);
      response.end();
      return;
    }
  }
  const encoding = text.length >= 2048 ? jsonEncodings.get(response) : undefined;
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

/** Addresses, accounts, milestones and this window's usage for the admin dialog; never a run, a key or anything written. */
const accountIdentity = (account: WebAccountIdentity): WebAccountIdentity =>
  account.username === undefined ? { email: account.email } : { username: account.username };
function adminOverview(auth: WebAuth, quota?: WebQuota): WebAdminOverview {
  const accounts = auth.listAccounts(), allowed = auth.allowlist(), signedUp = new Set(accounts.map(accountLogin));
  return {
    allowlist: auth.allowlistEntries().map(entry => ({ ...entry, account: signedUp.has(entry.email) })),
    accounts: accounts.map(account => {
      const { id, createdAt, firstRunAt, firstAcceptedAt, suspendedAt } = account, login = accountLogin(account);
      const view = quota && !auth.isAdmin(login) ? quota.view(id) : undefined;
      return { ...accountIdentity(account), admin: auth.isAdmin(login), createdAt,
        ...(firstRunAt ? { firstRunAt } : {}), ...(firstAcceptedAt ? { firstAcceptedAt } : {}), allowed: auth.allowed(login),
        ...(suspendedAt ? { suspended: true } : {}),
        ...(view ? { usage: { research: view.runs.used, formalizations: view.formalizations.used, explanations: view.explanations.used } } : {}) };
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    funnel: webFunnel(accounts, allowed).steps,
    editable: auth.allowlistWritable(), signup: auth.signup(),
    ...(quota ? { quota: quota.settings() } : {}),
  };
}

type Session = { id: string; csrf: string; touchedAt: number; account?: WebAccountIdentity & { id: string }; passwordResetUntil?: number };
const objectBody = (value: unknown) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
export function createWebService(config: WebConfig, runner: WebRunner = new DockerWebRunner(config),
  options: { mailer?: WebMailer; captchaAnswer?: () => string; sample?: WebSampleFile | null } = {}) {
  const storage = new WebStorage(config.dataRoot);
  const operations = new WebOperations(storage, config.dataRoot);
  const productBuild = readProductBuild(config.staticRoot);
  const admission = new WebSessionAdmission(Boolean(config.auth));
  // null disables the sample; omitted loads the one shipped with the image.
  const sample = options.sample === undefined ? loadWebSample() : options.sample ?? undefined;
  const papers = new WebPaperDrafts(storage);
  const paperPdf = new WebPaperPdf(runner);
  const knowledge = new WebKnowledgeService(storage);
  const registry = new WebModuleRegistry(storage);
  const sessions = new Map<string, Session>(storage.listSessions().map(session => [session.id, session]));
  const auth = config.auth ? new WebAuth(config.auth, storage, options.mailer, options.captchaAnswer) : undefined;
  const quota = auth && config.quota ? new WebQuota(storage, config.quota) : undefined;
  const providersFor = (session: Session) => webProvidersForAccount(config, session.account?.id);
  // With login enabled, records belong to the account; otherwise to the anonymous browser session.
  // Provider IDs, never keys, that the server can fill in for this session's admin account.
  const serverKeysFor = (session: Session) => {
    const ids = config.adminKeys && session.account && auth?.isAdmin(accountLogin(session.account))
      ? Object.keys(config.adminKeys).filter(id => providersFor(session).find(provider => provider.id === id)?.baseUrl ===
        config.providers.find(provider => provider.id === id)?.baseUrl) : [];
    return ids.length ? ids : undefined;
  };
  // Each account reads and replaces only its own saved keys.
  const vault = auth && config.keySecret ? new WebKeyVault(config.keySecret, storage) : undefined;
  const savedKeysFor = (session: Session) => vault && session.account ? vault.list(session.account.id, providersFor(session)) : [];
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
    if (run.status !== 'completed' || run.result?.status !== 'evaluated_passed' || !isStatementReviewed(run)) return { available: false, reason: 'not_accepted' };
    const provider = providersFor(session).find(item => item.id === run.providerId);
    if (!gatewayProvider(provider)) return { available: false, reason: 'provider' };
    if (run.model !== SUB2API_PROVIDER.defaultModel) return { available: false, reason: 'model' };
    if (!runner.explain) return { available: false, reason: 'runtime' };
    const key = savedKeysFor(session).some(item => item.providerId === provider!.id) ? 'saved'
      : serverKeysFor(session)?.includes(provider!.id) ? 'server' : 'required';
    return { available: true, model: run.model, effort: explanationEffort(run.effort), key,
      maxRunSeconds: webExplanationLimits.maxRunSeconds, maxTotalTokens: webExplanationLimits.maxTotalTokens,
      reference: { ...webExplanationLimits.reference } };
  };
  /**
   * Counts one use of the account's allowance before the work starts and answers what to call if the work never did.
   * Admins and anonymous loopback previews are not counted; a refusal is the 429 the reader sees.
   */
  const spend = (session: Session, kind: WebQuotaKind): (() => void) => {
    if (!quota || !auth || !session.account || auth.isAdmin(accountLogin(session.account))) return () => undefined;
    try { quota.take(session.account.id, kind); }
    catch (error) { throw error instanceof WebQuotaError ? new HttpError(error.status, error.message) : error; }
    const id = session.account.id;
    return () => quota.refund(id, kind);
  };
  const usageOf = (session: Session) => quota && session.account && !auth?.isAdmin(accountLogin(session.account)) ? quota.view(session.account.id) : undefined;
  // Beta funnel milestones exist only for accounts; anonymous loopback previews record nothing.
  const milestone = (owner: string, name: WebMilestone) => {
    if (auth && owner.startsWith('account:')) try { auth.markMilestone(owner.slice(8), name); } catch { /* A milestone never fails a run. */ }
  };
  // The owner's mail goes out after the run is saved; a failed delivery is logged by run and never changes the run.
  // The same preference covers the one mail asking to approve a plan.
  const mailOwner = (owner: string, run: WebRun, kind: string, message: (run: WebRun, publicUrl: string) => { subject: string; text: string }) => {
    if (!auth || !owner.startsWith('account:')) return;
    const to = auth.completionRecipient(owner.slice(8));
    if (to) auth.sendCompletion(to, message(run, config.publicUrl)).catch(() => {
      operations.mailFailed(); console.error(`[${kind} mail] run ${run.id}: delivery failed`);
    });
  };
  const explanations = new WebExplanations(runner, storage, webExplanationLimits, owner => {
    if (!auth || !quota || !owner.startsWith('account:')) return;
    const account = auth.listAccounts().find(item => item.id === owner.slice(8));
    if (!account) throw new Error('explanation_account_unavailable');
    if (auth.isAdmin(accountLogin(account))) return;
    try { quota.take(account.id, 'explanations'); }
    catch (error) { throw error instanceof WebQuotaError ? new Error('explanation_quota_exhausted') : error; }
  });
  const jobs = new WebJobs(runner, config, { storage, knowledge, onAccepted: owner => milestone(owner, 'firstAcceptedAt'),
    onProofAccepted: (owner, run, credentials) => {
      if (run.autoExplain === false || !runner.explain || !gatewayProvider(credentials.provider)
        || run.model !== SUB2API_PROVIDER.defaultModel) return;
      explanations.createAutomatic(owner, run, { ...credentials, targets: explanationTargets(run).map(target => target.name),
        language: run.explanationLanguage ?? 'zh', model: run.model, effort: explanationEffort(run.effort) });
    },
    onStatementReview: (owner, run) => explanations.review(owner, run),
    onFinished: (owner, run) => { if (mailsCompletion(run)) mailOwner(owner, run, 'completion', completionMail); },
    onPlanWaiting: (owner, run) => mailOwner(owner, run, 'plan approval', planApprovalMail) });
  const trajectories = new WebTrajectories(storage);
  const research = new WebResearchApi(storage, jobs, knowledge, runner);
  const formalizations = new WebFormalizations(runner, storage, webFormalizationLimits, (owner, formalization, evidence, input) => {
    const digest = formalizationCompiledCandidateDigest(formalizationCompiledCandidate(evidence));
    const existing = jobs.list(owner).find(run => run.formalizationId === formalization.id && !run.continueFrom &&
      run.source === evidence.candidate.source && run.environment === evidence.request.environment &&
      !['rejected', 'interrupted', 'superseded'].includes(run.formalization?.confirmation ?? '') &&
      (!run.formalization?.candidateDigest || run.formalization.candidateDigest === digest));
    if (existing) return existing.id;
    const run = jobs.create(owner, { ...webDefaults, ...webFormalizationDefaults.research, ...formalization.research,
      ...(formalization.humanReview ? { workers: 2, coordination: 'cooperative' as const, planApproval: true } : {}),
      providerId: input.provider.id, apiKey: input.apiKey,
      autoExplain: formalization.autoExplain, explanationLanguage: formalization.explanationLanguage,
      model: input.model, effort: formalization.researchEffort ?? input.effort, source: evidence.candidate.source, environment: evidence.request.environment,
      task: '依据自然语言原题及其 Lean 陈述，证明全部目标，保留所有定义、假设与声明。', formalizationId: formalization.id }, input.provider, undefined, undefined,
    { evidence, provenance: { id: formalization.id, evidenceSha256: formalizationDigest(evidence), original: formalization.original,
      candidateDigest: digest, confirmedAt: formalization.confirmedAt!, confirmation: formalization.confirmation ?? 'automatic',
      ...(formalization.reviewMode ? { reviewMode: formalization.reviewMode } : {}) } });
    milestone(owner, 'firstRunAt');
    return run.id;
  }, {
    start: (owner, formalization, compiled, input) => {
      const digest = formalizationCompiledCandidateDigest(compiled);
      const existing = jobs.list(owner).find(run => run.formalizationId === formalization.id && !run.continueFrom &&
        run.formalization?.candidateDigest === digest && run.source === compiled.candidate.source && run.environment === compiled.request.environment);
      if (existing) return existing.id;
      const run = jobs.create(owner, { ...webDefaults, ...webFormalizationDefaults.research, ...formalization.research,
        providerId: input.provider.id, apiKey: input.apiKey, model: input.model, effort: formalization.researchEffort ?? input.effort,
        autoExplain: formalization.autoExplain, explanationLanguage: formalization.explanationLanguage,
        source: compiled.candidate.source, environment: compiled.request.environment, formalizationId: formalization.id,
        task: '证明编译通过的固定候选陈述的全部目标，保留所有定义、假设与声明。原题含义审核正在后台进行。' }, input.provider, undefined, undefined,
      { compiled, provenance: { id: formalization.id, original: formalization.original, candidateDigest: digest, confirmation: 'pending' } });
      milestone(owner, 'firstRunAt');
      return run.id;
    },
    update: (owner, id, digest, confirmation, approved) => jobs.reviewFormalization(owner, id, digest, confirmation, approved),
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
  const sessionCookie = 'theoremos_session', bootstrapCookie = 'theoremos_bootstrap';
  const cookieValue = (name: string, value: string, maxAge: number) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  const setSessionCookie = (response: ServerResponse, session: Session) => {
    // A delayed anonymous bootstrap must not replace an identity established by another tab.
    // Keep the existing signed-in cookie name so persisted browser sessions continue to work.
    const anonymous = auth && !session.account;
    const maxAge = auth && session.account ? 365 * 24 * 60 * 60
      : Math.floor((anonymous ? Math.min(config.sessionTtlMs, 60 * 60_000) : config.sessionTtlMs) / 1000);
    const value = cookieValue(anonymous ? bootstrapCookie : sessionCookie, session.id, maxAge);
    response.setHeader('Set-Cookie', auth && session.account ? [value, cookieValue(bootstrapCookie, '', 0)] : value);
  };
  const clearSessionCookie = (response: ServerResponse) => {
    const value = cookieValue(sessionCookie, '', 0);
    response.setHeader('Set-Cookie', auth ? [value, cookieValue(bootstrapCookie, '', 0)] : value);
  };
  const startSession = (account?: Session['account'], verifiedByEmail = false) => {
    const session: Session = { id: crypto.randomBytes(32).toString('hex'), csrf: crypto.randomBytes(32).toString('hex'), touchedAt: Date.now(),
      ...(account ? { account } : {}), ...(verifiedByEmail ? { passwordResetUntil: Date.now() + 10 * 60_000 } : {}) };
    sessions.set(session.id, session);
    return session;
  };
  /** Ends one browser session. Anonymous records go with it; account records stay with the account. */
  const endSession = (id: string) => {
    // Revocation must take effect even when deleting persisted records fails.
    sessions.delete(id);
    for (const stop of runStreams.get(id) ?? []) stop();
    let failure: unknown;
    if (!auth) {
      conversations.forget(id); formalizations.forget(id); explanations.forget(id);
      research.projects.forgetOwner(id);
      void research.assets.deleteOwner(id).catch(() => console.error('[web_cleanup_failed] research cleanup failed'));
      try { jobs.forget(id); } catch (error) { failure = error; }
      try { storage.deleteOwner(id); } catch (error) { failure ??= error; }
      trajectories.forgetOwner(id);
    }
    try { storage.deleteSession(id); } catch (error) { failure ??= error; }
    if (failure) throw failure;
  };
  const endSessions = (matches: (session: Session) => boolean) => {
    let failure: unknown;
    for (const [id, session] of sessions) if (matches(session)) {
      try { endSession(id); } catch (error) { failure ??= error; }
    }
    if (failure) throw failure;
  };
  const prune = () => {
    admission.prune(); quota?.prune();
    let failure: unknown;
    try {
      endSessions(session => {
        // Login-page sessions without an account only need to outlive one sign-in attempt.
        const ttl = auth && !session.account ? Math.min(config.sessionTtlMs, 60 * 60_000) : config.sessionTtlMs;
        return Date.now() - session.touchedAt > ttl;
      });
    } catch (error) { failure = error; }
    for (const [ip, rate] of rates) if (rate.expiresAt <= Date.now()) rates.delete(ip);
    prechecker?.prune();
    explainer.prune();
    auth?.prune();
    if (failure) throw failure;
  };
  const maintenance = setInterval(() => {
    try { prune(); } catch { console.error('[web_cleanup_failed] background cleanup failed'); }
  }, 60_000).unref();
  /** The browser session named by the cookie. An address removed from the allowlist, or a deleted account, loses its signed-in sessions. */
  const cookieSession = (request: IncomingMessage) => {
    const cookies = request.headers.cookie?.split(';').map(value => value.trim()) ?? [];
    const read = (name: string) => {
      const value = cookies.find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
      return value ? sessions.get(value) : undefined;
    };
    let session = read(sessionCookie);
    if (!auth) return session;
    if (session?.account && !(auth.allowed(accountLogin(session.account)) && auth.getAccount(accountLogin(session.account))?.id === session.account.id)) {
      endSession(session.id); session = undefined;
    }
    if (session?.account) return session;
    const bootstrap = read(bootstrapCookie);
    // Accept legacy anonymous cookies until their normal expiry; bootstrap cookies never authenticate.
    return bootstrap && !bootstrap.account ? bootstrap : session;
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
      if (request.url === '/readyz' && request.method === 'GET') {
        const maintenance = operations.maintenance;
        const ready = !maintenance && operations.writable() && (await runner.readiness()).ready;
        json(response, ready ? 200 : 503, { ready, maintenance, ...(config.sourceCommit ? { commit: config.sourceCommit } : {}) }); return;
      }
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
        if (++rate.count > 600) {
          response.setHeader('Retry-After', Math.max(1, Math.ceil((rate.expiresAt - Date.now()) / 1000)));
          response.setHeader('X-Theoremos-Rate-Limit-Scope', 'api');
          throw new HttpError(429, '请求过于频繁，请稍后重试。');
        }
        // Share links are public read-only snapshots: no session, no cookie, nothing beyond the stored whitelist.
        const shared = /^\/api\/share\/([^/]+)$/u.exec(url.pathname);
        if (shared) {
          if (request.method !== 'GET') throw new HttpError(405, '请求方法不受支持。');
          const share = webShareToken.test(shared[1]) ? storage.getShare(shared[1]) : undefined;
          if (!share) throw new HttpError(404, '分享链接不存在或已停止分享。');
          json(response, 200, { share: share.snapshot }); return;
        }
        if (url.pathname === '/api/product/status' && request.method === 'GET') {
          json(response, 200, productStatus({ build: productBuild, commit: config.sourceCommit, maintenance: operations.maintenance,
            writable: operations.writable(), runtimeReady: (await runner.readiness()).ready })); return;
        }
        let session = cookieSession(request);
        if (request.method === 'GET' && url.pathname === '/api/session') {
          if (!session) {
            const displaced = admission.admit(ip, sessions.values());
            if (displaced) endSession(displaced);
            session = startSession();
            setSessionCookie(response, session);
          } else if (!auth) setSessionCookie(response, session);
          session.touchedAt = Date.now();
          storage.saveSession(session);
          const usage = usageOf(session);
          const body: WebSession = { draftOwner: crypto.createHash('sha256').update(ownerOf(session) || session.id).digest('hex'), csrfToken: session.csrf, auth: auth ? 'email' : 'none',
            ...(operations.maintenance ? { maintenance: true } : {}),
            ...(auth?.termsVersion ? { termsVersion: auth.termsVersion } : {}),
            ...(auth && session.account && auth.needsTerms(accountLogin(session.account)) ? { termsRequired: true } : {}),
            ...(auth?.signup() === 'open' ? { signup: 'open' as const } : {}),
            ...(usage ? { quota: usage } : {}),
            ...(session.account ? { account: { ...accountIdentity(session.account), ...(auth?.isAdmin(accountLogin(session.account)) ? { admin: true } : {}),
              ...(auth ? { passwordSet: auth.hasPassword(accountLogin(session.account)), passwordResetAllowed: Boolean(session.passwordResetUntil && session.passwordResetUntil > Date.now()) } : {}),
              ...(serverKeysFor(session) ? { serverKeys: serverKeysFor(session) } : {}),
              ...(vault ? { keyVault: true, ...(savedKeysFor(session).length ? { savedKeys: savedKeysFor(session) } : {}) } : {}),
              ...(auth?.getAccount(accountLogin(session.account))?.completionEmail === false ? { completionEmail: false } : {}) } } : {}), providers: providersFor(session).map(publicWebProvider), environments: getWebEnvironments(),
            templates: webTemplates, defaults: webDefaults, limits: webLimits, runtime: await runner.readiness(),
            ...(sample ? { sample: { id: sample.run.id, title: sample.run.title } } : {}), ...(prechecker ? { precheck: true } : {}) };
          const owner = url.searchParams.has('runs') ? ownerOf(session) : undefined;
          if (owner) body.runs = { runs: jobs.list(owner), version: jobs.version(owner) };
          json(response, 200, body); return;
        }
        if (!session && request.method === 'GET' && url.pathname.startsWith('/api/research/')) {
          const denied = (): never => { throw new HttpError(401, '请先登录。'); };
          const result = await research.handle(url, 'GET', undefined, async () => denied(), denied);
          if (result.filename) response.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
          json(response, result.status, result.body); return;
        }
        if (session) response.setHeader('X-Theoremos-Owner', crypto.createHash('sha256').update(ownerOf(session) || session.id).digest('hex'));
        if (!session) throw new HttpError(401, '会话已过期，请刷新页面。');
        session.touchedAt = Date.now();
        if (request.method !== 'GET' && !equal(String(request.headers['x-csrf-token'] || ''), session.csrf))
          throw new HttpError(403, '会话校验失败，请刷新页面。');
        // An earlier response may arrive after another tab logs in. It must not replace the new identity cookie.
        if (!auth) setSessionCookie(response, session);
        storage.saveSession(session);
        const requireSession = () => {
          if (cookieSession(request) !== session) throw new HttpError(401, '会话已过期，请刷新页面。');
        };
        const readBody = async () => {
          const body = await readJson(request);
          // A request may still be uploading when another request revokes its session.
          requireSession();
          return body;
        };
        if (url.pathname.startsWith('/api/auth/')) {
          if (!auth) throw new HttpError(404, '当前服务未启用登录。');
          if (url.pathname === '/api/auth/captcha' && request.method === 'POST') { json(response, 200, auth.captcha(ip)); return; }
          if (url.pathname === '/api/auth/code' && request.method === 'POST') {
            try { json(response, 200, await auth.requestCode(ip, objectBody(await readBody()))); }
            catch (error) {
              if (error instanceof WebAuthError && error.status === 502) {
                operations.mailFailed(); console.error('[smtp_delivery_failed] verification code delivery failed');
              }
              throw error;
            }
            return;
          }
          if (url.pathname === '/api/auth/verify' && request.method === 'POST') {
            const account = auth.verifyCode(objectBody(await readBody()));
            quota?.restore(account.id, accountLogin(account));
            // A fresh identifier and CSRF token after login; the pre-login cookie stops working.
            endSession(session.id);
            const next = startSession({ id: account.id, ...accountIdentity(account) }, true);
            storage.saveSession(next); setSessionCookie(response, next);
            json(response, 200, { account: accountIdentity(account), csrfToken: next.csrf }); return;
          }
          if (url.pathname === '/api/auth/password/login' && request.method === 'POST') {
            const account = await auth.loginPassword(ip, objectBody(await readBody()), requireSession);
            quota?.restore(account.id, accountLogin(account));
            endSession(session.id);
            const next = startSession({ id: account.id, ...accountIdentity(account) });
            storage.saveSession(next); setSessionCookie(response, next);
            json(response, 200, { account: accountIdentity(account), csrfToken: next.csrf }); return;
          }
          if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
            endSession(session.id); clearSessionCookie(response); json(response, 200, { ok: true }); return;
          }
          if (url.pathname === '/api/auth/terms' && request.method === 'POST') {
            if (!session.account) throw new HttpError(401, '请先登录。');
            auth.acceptTerms(accountLogin(session.account), objectBody(await readBody()));
            json(response, 200, { ok: true }); return;
          }
          if (url.pathname === '/api/auth/account' && request.method === 'PATCH') {
            if (!session.account) throw new HttpError(401, '请先登录。');
            const completionEmail = objectBody(await readBody()).completionEmail;
            if (typeof completionEmail !== 'boolean') throw new HttpError(400, '设置格式不正确。');
            auth.setCompletionEmail(accountLogin(session.account), completionEmail);
            json(response, 200, { completionEmail }); return;
          }
          if (url.pathname === '/api/auth/password' && request.method === 'PATCH') {
            if (!session.account) throw new HttpError(401, '请先登录。');
            const body = objectBody(await readBody());
            await auth.setPassword(accountLogin(session.account), body.password, body.currentPassword,
              Boolean(session.passwordResetUntil && session.passwordResetUntil > Date.now()), requireSession);
            session.passwordResetUntil = undefined;
            let failure: unknown;
            try { storage.saveSession(session); } catch (error) { failure = error; }
            try { endSessions(other => other.id !== session.id && other.account?.id === session.account!.id); }
            catch (error) { failure ??= error; }
            if (failure) throw failure;
            json(response, 200, { passwordSet: true }); return;
          }
          if (url.pathname === '/api/auth/account' && request.method === 'DELETE') {
            const account = session.account;
            if (!account) throw new HttpError(401, '请先登录。');
            const body = objectBody(await readBody()), confirmation = body.login ?? body.username ?? body.email;
            if (typeof confirmation !== 'string' || confirmation.trim().toLowerCase() !== accountLogin(account))
              throw new HttpError(400, account.username ? '请输入当前账号的用户名以确认删除。' : '请输入当前账号的邮箱以确认删除。');
            const owner = ownerOf(session)!;
            research.projects.forgetOwner(owner); await research.assets.deleteOwner(owner);
            conversations.forget(owner); formalizations.forget(owner); explanations.forget(owner); jobs.forget(owner); storage.deleteOwner(owner); trajectories.forgetOwner(owner); vault?.forgetAccount(account.id);
            quota?.forget(account.id, accountLogin(account));
            auth.deleteAccount(accountLogin(account));
            endSessions(other => other.account?.id === account.id);
            clearSessionCookie(response); json(response, 200, { deleted: true }); return;
          }
          const savedKey = /^\/api\/auth\/keys\/([a-z][a-z0-9-]{0,39})$/u.exec(url.pathname);
          if (savedKey && ['PUT', 'DELETE'].includes(request.method ?? '')) {
            if (!session.account) throw new HttpError(401, '请先登录。');
            if (!vault) throw new HttpError(404, '当前服务未启用保存 Key。');
            if (request.method === 'PUT') {
              if (auth.needsTerms(accountLogin(session.account))) throw new HttpError(428, '使用条款已更新，请先确认后继续。');
              const provider = providersFor(session).find(item => item.id === savedKey[1]);
              if (!provider) throw new HttpError(400, '请选择可用的服务商');
              const body = z.object({ apiKey: inputSchema.shape.apiKey.min(8) }).strict().safeParse(await readBody());
              if (!body.success) throw new HttpError(400, '请填写有效的 API Key。');
              if (auth.needsTerms(accountLogin(session.account))) throw new HttpError(428, '使用条款已更新，请先确认后继续。');
              vault.save(session.account.id, provider.id, provider.baseUrl, body.data.apiKey);
            } else vault.forget(session.account.id, savedKey[1]);
            json(response, 200, { savedKeys: savedKeysFor(session) }); return;
          }
          throw new HttpError(405, '请求方法不受支持。');
        }
        if (auth && session.account && auth.needsTerms(accountLogin(session.account)))
          throw new HttpError(428, '使用条款已更新，请先确认后继续。');
        if (url.pathname.startsWith('/api/admin/')) {
          // Checked on every request, so removing an address from THEOREMOS_WEB_ADMINS takes effect at the next restart.
          if (!auth || !session.account || !auth.isAdmin(accountLogin(session.account))) throw new HttpError(403, '需要管理员账号。');
          if (url.pathname === '/api/admin/overview' && request.method === 'GET') { json(response, 200, adminOverview(auth, quota)); return; }
          if (url.pathname === '/api/admin/operations' && request.method === 'GET') {
            const ready = operations.writable() && (await runner.readiness()).ready;
            let disk: ReturnType<WebOperations['disk']>;
            try { disk = operations.disk(); } catch { /* ready reports an inaccessible data volume. */ }
            json(response, 200, { maintenance: operations.maintenance, ready, ...(disk ? { disk } : {}), failures: operations.failures(),
              queues: { research: jobs.counts(), formalization: formalizations.counts(), explanation: explanations.counts(),
                precheck: prechecker?.counts() ?? { running: 0, queued: 0 }, conversation: explainer.counts() } }); return;
          }
          if (url.pathname === '/api/admin/maintenance' && request.method === 'PUT') {
            const enabled = objectBody(await readBody()).enabled;
            if (typeof enabled !== 'boolean') throw new HttpError(400, '请选择是否暂停接单。');
            operations.setMaintenance(enabled); json(response, 200, { maintenance: enabled }); return;
          }
          if (url.pathname === '/api/admin/accounts' && request.method === 'PATCH') {
            const body = objectBody(await readBody());
            const login = body.login ?? body.username ?? body.email;
            if (typeof login !== 'string' || typeof body.suspended !== 'boolean') throw new HttpError(400, '请检查账号与暂停状态。');
            const account = auth.setSuspended(login, body.suspended);
            if (body.suspended) {
              const owner = `account:${account.id}`;
              for (const run of jobs.list(owner)) {
                jobs.cancel(owner, run.id);
                for (const item of explanations.list(owner, run.id)) explanations.cancel(owner, run.id, item.target, item.language);
              }
              for (const item of formalizations.list(owner)) formalizations.cancel(owner, item.id);
              for (const item of conversations.list(owner)) conversations.stop(owner, item.id);
              endSessions(other => other.account?.id === account.id);
            }
            json(response, 200, adminOverview(auth, quota)); return;
          }
          if (url.pathname === '/api/admin/allowlist' && ['POST', 'DELETE'].includes(request.method ?? '')) {
            const email = objectBody(await readBody()).email;
            if (request.method === 'POST') auth.addToAllowlist(email);
            else {
              auth.removeFromAllowlist(email);
              // The removed address is signed out now, not at its next request.
              endSessions(other => Boolean(other.account && !auth.allowed(accountLogin(other.account))));
            }
            json(response, 200, adminOverview(auth, quota)); return;
          }
          throw new HttpError(405, '请求方法不受支持。');
        }
        const owner = ownerOf(session);
        if (url.pathname.startsWith('/api/research/')) {
          const writable = () => {
            requireSession();
            if (!owner) throw new HttpError(401, '请先登录。');
            if (auth && session.account && auth.needsTerms(accountLogin(session.account))) throw new HttpError(428, '使用条款已更新，请先确认后继续。');
            if (operations.maintenance || !operations.writable()) throw new HttpError(503, '服务暂不接收研究修改，请稍后重试。');
          };
          const result = await research.handle(url, request.method ?? 'GET', owner, readBody, writable);
          if (result.filename) response.setHeader('Content-Disposition', `attachment; filename="${result.filename}"`);
          json(response, result.status, result.body); return;
        }
        if (!owner) throw new HttpError(401, '请先登录。');
        if (url.pathname === '/api/team-profiles' && request.method === 'GET') {
          json(response, 200, { profiles: webTeamProfiles() }); return;
        }
        const newWork = request.method === 'POST' && (['/api/runs', '/api/formalizations', '/api/precheck'].includes(url.pathname)
          || /^\/api\/runs\/[^/]+\/(?:explain|explanations|paper)$/u.test(url.pathname)
          || /^\/api\/formalizations\/[^/]+\/research$/u.test(url.pathname));
        // Body reads and readiness checks yield. Recheck admission immediately before dispatch so a pending
        // submission cannot start work after logout, suspension, account deletion or maintenance activation.
        const admitWork = () => {
          requireSession();
          if (auth && session.account && auth.needsTerms(accountLogin(session.account))) throw new HttpError(428, '使用条款已更新，请先确认后继续。');
          if (operations.maintenance) throw new HttpError(503, '服务正在维护，暂不接收新任务；已有任务会继续，历史与下载仍可使用。');
          if (!operations.writable()) throw new HttpError(503, '存储空间暂时不足，请稍后重试。');
        };
        if (newWork) admitWork();
        const connection = /^\/api\/providers\/([a-z][a-z0-9-]{0,39})\/check$/u.exec(url.pathname);
        if (connection && request.method === 'POST') {
          const provider = providersFor(session).find(item => item.id === connection[1]);
          const body = z.object({ apiKey: formalizationSchema.shape.apiKey, model: inputSchema.shape.model }).strict().safeParse(await readBody());
          if (!provider || !body.success) throw new HttpError(400, '请检查服务商、模型名与 API Key。');
          const key = body.data.apiKey || heldKey(session, provider);
          if (!key) throw new HttpError(400, '请填写 API Key。');
          admitWork();
          json(response, 200, await checkWebProvider(provider, key, body.data.model)); return;
        }
        if (url.pathname === '/api/conversations') {
          if (request.method === 'GET') { json(response, 200, { conversations: conversations.list(owner) }); return; }
          if (request.method === 'POST') {
            const parsed = conversationSchema.safeParse(await readBody());
            if (!parsed.success) throw new HttpError(400, '请选择要讨论的题目。');
            json(response, 201, { conversation: conversations.create(owner, parsed.data) }); return;
          }
          throw new HttpError(405, '请求方法不受支持。');
        }
        const conversationMatch = /^\/api\/conversations\/([a-f0-9-]{36})(?:\/(messages|stop|guidance|guidance-withdraw))?$/u.exec(url.pathname);
        if (conversationMatch) {
          const [, id, action] = conversationMatch;
          if (!action && request.method === 'GET') {
            json(response, 200, { conversation: conversations.read(owner, id) }, request);
            return;
          }
          if (!action && request.method === 'PATCH') {
            conversations.read(owner, id);
            const parsed = z.object({ title: z.string() }).strict().safeParse(await readBody());
            if (!parsed.success) throw new HttpError(400, '请输入不超过 80 字的对话标题。');
            json(response, 200, { conversation: conversations.rename(owner, id, parsed.data.title) }); return;
          }
          if (!action && request.method === 'DELETE') {
            conversations.delete(owner, id); json(response, 200, { deleted: true }); return;
          }
          if (action === 'stop' && request.method === 'POST') { json(response, 200, { conversation: conversations.stop(owner, id) }); return; }
          if (action === 'guidance' && request.method === 'POST') {
            const { runId, ...input } = objectBody(await readBody());
            const expectedRun = z.string().uuid().optional().safeParse(runId);
            const parsed = webGuidanceSchema.safeParse(input);
            if (!parsed.success || !expectedRun.success) throw new HttpError(400, '请检查指导对象、任务版本与内容。');
            const conversation = await conversations.guide(owner, id, parsed.data,
              (runId, guidance) => jobs.command(owner, runId, { type: 'guidance', guidance }), expectedRun.data);
            json(response, 200, { conversation }); return;
          }
          if (action === 'guidance-withdraw' && request.method === 'POST') {
            const commandId = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/u);
            const parsed = z.object({ id: commandId, guidanceId: commandId }).strict().safeParse(await readBody());
            if (!parsed.success) throw new HttpError(400, '请检查要撤回的指导。');
            json(response, 200, await conversations.withdrawGuidance(owner, id,
              { id: parsed.data.id, guidanceId: parsed.data.guidanceId }, (runId, command) => jobs.command(owner, runId, command))); return;
          }
          if (action === 'messages' && request.method === 'POST') {
            const conversation = conversations.read(owner, id);
            const parsed = conversationMessageSchema.safeParse(await readBody());
            if (!parsed.success) throw new HttpError(400, '请检查问题内容与 API Key。');
            const accepted = conversations.messageReceipt(owner, id, parsed.data.requestId, parsed.data.text);
            if (accepted) { json(response, 202, { conversation: accepted }); return; }
            const run = conversation.runId ? jobs.get(owner, conversation.runId) : undefined;
            const formalization = conversation.formalizationId ? formalizations.read(owner, conversation.formalizationId) : undefined;
            const provider = providersFor(session).find(item => item.id === (run?.providerId ?? formalization?.providerId ?? SUB2API_PROVIDER.id));
            if (!provider) throw new HttpError(400, '当前服务没有配置这个题目使用的模型服务。');
            const apiKey = parsed.data.apiKey || heldKey(session, provider);
            if (!apiKey) throw new HttpError(400, '请填写 API Key。');
            const model = run?.model ?? formalization?.model ?? providerModel(provider);
            admitWork();
            json(response, 202, { conversation: conversations.send(owner, id, parsed.data.text, { baseUrl: provider.baseUrl, apiKey, model }, parsed.data.requestId) }); return;
          }
          throw new HttpError(405, '请求方法不受支持。');
        }
        if (url.pathname === '/api/formalizations') {
          const providers = providersFor(session).filter(formalizationProvider);
          const defaultProvider = providers[0];
          const keyKind = (provider: WebProvider): 'saved' | 'server' | 'required' =>
            savedKeysFor(session).some(item => item.providerId === provider.id) ? 'saved'
              : serverKeysFor(session)?.includes(provider.id) ? 'server' : 'required';
          if (request.method === 'GET') {
            const formalizationReady = Boolean(runner.formalize) && (await runner.readiness()).ready;
            const generation: WebFormalizationCapabilities = { available: !!defaultProvider && formalizationReady,
              ...(!defaultProvider ? { reason: 'provider' as const } : !formalizationReady ? { reason: 'runtime' as const } : {}),
              ...(defaultProvider ? { providerId: defaultProvider.id } : {}), model: defaultProvider ? providerModel(defaultProvider) : SUB2API_PROVIDER.defaultModel,
              key: defaultProvider ? keyKind(defaultProvider) : 'required', limits: webFormalizationLimits,
              defaults: webFormalizationDefaults,
              providers: providers.map(provider => ({ ...publicWebProvider(provider), defaultModel: providerModel(provider), key: keyKind(provider),
                ...(provider.id === 'openai' && new URL(provider.baseUrl).origin === 'https://api.openai.com'
                  ? { keyUrl: 'https://platform.openai.com/api-keys' } : {}) })) };
            json(response, 200, { formalizations: formalizations.list(owner), generation }); return;
          }
          if (request.method === 'POST') {
            const parsed = formalizationSchema.safeParse(await readBody());
            if (!parsed.success) throw new HttpError(400, '请检查原题、证明环境与 API Key。');
            // Omitted settings use separate defaults; explicit and older requests retain their chosen effort.
            const input = { ...parsed.data, effort: parsed.data.effort ?? 'high' as const,
              researchEffort: parsed.data.researchEffort ?? parsed.data.effort ?? webDefaults.effort };
            if (parsed.data.humanReview && !parsed.data.solve) throw new HttpError(400, '人工审核模式需要启用证明研究。');
            const provider = parsed.data.providerId ? providers.find(item => item.id === parsed.data.providerId) : defaultProvider;
            if (!provider) throw new HttpError(409, '当前服务没有配置这个题目使用的模型服务。');
            const model = parsed.data.model ?? providerModel(provider);
            if (provider.id === SUB2API_PROVIDER.id && model !== SUB2API_PROVIDER.defaultModel)
              throw new HttpError(400, 'Sub2API 形式化目前支持 deepseek-flash 模型。');
            const previous = formalizations.replay(owner, input as WebFormalizationRequest, provider, model);
            if (previous) { json(response, 200, { formalization: previous }); return; }
            const ready = Boolean(runner.formalize) && (await runner.readiness()).ready;
            // Readiness yields to concurrent requests; replay again before spending quota.
            const raced = formalizations.replay(owner, input as WebFormalizationRequest, provider, model);
            if (raced) { json(response, 200, { formalization: raced }); return; }
            if (!ready) throw new HttpError(503, '形式化运行环境尚未就绪。');
            const apiKey = parsed.data.apiKey || heldKey(session, provider);
            if (!apiKey) throw new HttpError(400, '请填写 API Key。');
            // A confirmed formalization starts its proof through jobs.create itself, so it costs this kind only.
            admitWork();
            const refund = spend(session, 'formalizations');
            try {
              json(response, 201, { formalization: formalizations.create(owner, { ...input, apiKey } as WebFormalizationRequest, provider, model) }); return;
            } catch (error) {
              refund();
              throw error;
            }
          }
          throw new HttpError(405, '请求方法不受支持。');
        }
        const formalizationMatch = /^\/api\/formalizations\/([a-f0-9-]{36})(?:\/(cancel|confirm|activity|research))?$/u.exec(url.pathname);
        if (formalizationMatch) {
          const id = formalizationMatch[1], action = formalizationMatch[2];
          if (!action && request.method === 'GET') { json(response, 200, { formalization: formalizations.read(owner, id) }); return; }
          // The owner's process view: role actions, compilations and review feedback. Never part of a share.
          if (action === 'activity' && request.method === 'GET') {
            const after = Number(url.searchParams.get('after') ?? 0);
            if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, '动作游标无效。');
            json(response, 200, formalizations.activity(owner, id, after)); return;
          }
          if (!action && request.method === 'DELETE') {
            if (jobs.list(owner).some(run => run.formalizationId === id)) throw new HttpError(409, '已有研究使用这份原题，请先删除相关研究记录。');
            formalizations.remove(owner, id); json(response, 200, { deletedId: id }); return;
          }
          if (action === 'cancel' && request.method === 'POST') { json(response, 200, { formalization: formalizations.cancel(owner, id) }); return; }
          if (action === 'research' && request.method === 'POST') {
            const parsed = z.object({ apiKey: formalizationSchema.shape.apiKey }).strict().safeParse(await readBody());
            if (!parsed.success) throw new HttpError(400, '请检查 API Key。');
            const item = formalizations.read(owner, id);
            if (item.runId) { json(response, 200, { formalization: item }); return; }
            const provider = providersFor(session).find(provider => provider.id === (item.providerId ?? SUB2API_PROVIDER.id));
            if (!provider) throw new HttpError(409, '这次运行的模型服务已不在配置中。');
            const apiKey = parsed.data.apiKey || heldKey(session, provider);
            if (!apiKey) throw new HttpError(400, '请填写 API Key。');
            if (!(await runner.readiness()).ready) throw new HttpError(503, '自动证明运行环境尚未就绪。');
            admitWork();
            try { json(response, 200, { formalization: formalizations.retryResearch(owner, id, provider, apiKey) }); }
            catch (error) {
              if (error instanceof WebStorageError) throw error;
              if (error instanceof Error && error.message.startsWith('运行队列已满')) throw new HttpError(429, error.message);
              throw error;
            }
            return;
          }
          if (action === 'confirm' && request.method === 'POST') {
            const parsed = z.object({ evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict().safeParse(await readBody());
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
            json(response, 200, { plan: registry.savePlan(owner, await readBody()) }); return;
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
          response.write('retry: 5000\n\n');
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
          const parsed = precheckSchema.safeParse(await readBody());
          if (!parsed.success) throw new HttpError(400, '请检查证明环境与 Lean 源码。');
          // A closed tab or a newer edit stops the compile; a superseded check has no reader left to answer.
          const gone = new AbortController();
          response.once('close', () => { if (!response.writableFinished) gone.abort(new PrecheckSuperseded()); });
          admitWork();
          const frozen = !parsed.data.researchSelection ? undefined : parsed.data.nativeTeam
            ? research.assets.freezeNativeTeam(owner, parsed.data.researchSelection as ResearchConfigurationSelection, parsed.data.environment)
            : research.assets.freeze(owner, parsed.data.researchSelection as ResearchConfigurationSelection, parsed.data.environment);
          const libraryPack = frozen ? combineWebLibraryPacks(frozen.libraryPack,
            selectWebLibraryPack({ source: parsed.data.source!, task: '', environment: parsed.data.environment })) : undefined;
          try { json(response, 200, { precheck: await prechecker.check(owner, { ...parsed.data,
            ...(libraryPack ? { libraryPack } : {}) } as Parameters<WebPrechecker['check']>[1], gone.signal) }); }
          catch (error) {
            if (error instanceof PrecheckSuperseded) { if (!response.destroyed) json(response, 409, { error: '检查已被更新的版本取代。' }); return; }
            throw error;
          }
          return;
        }
        if (url.pathname === '/api/runs' && request.method === 'POST') {
          const parsed = inputSchema.safeParse(await readBody());
          if (!parsed.success) throw new HttpError(400, '请检查题目、API Key、模型、模块方案及运行预算。');
          const provider = providersFor(session).find(item => item.id === parsed.data.providerId);
          if (!provider) throw new HttpError(400, '该模型服务尚未配置。');
          const { saveKey, requestId: bodyRequestId, ...input } = parsed.data;
          const legacyEnvironmentOmitted = input.environment === undefined;
          input.environment ??= webDefaults.environment;
          const headerId = request.headers['idempotency-key'];
          if (headerId !== undefined && (typeof headerId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(headerId)
              || bodyRequestId && bodyRequestId !== headerId)) throw new HttpError(400, '提交请求标识无效或不一致。');
          const requestId = bodyRequestId ?? (typeof headerId === 'string' ? headerId : undefined);
          // Confirmed statements retain their exact artifact bytes; ordinary Lean drafts keep the existing normalization.
          if (!input.formalizationId) input.source = input.source.trim();
          if (webProviderHarness(provider) !== 'codex') {
            input.researchMode ??= 'skill'; input.skillLoading ??= 'file';
          }
          const harnessError = webHarnessResearchError(provider, input as WebRunInput);
          if (harnessError) throw new HttpError(400, harnessError);
          const researchModeError = webResearchModeError(input as WebRunInput, provider);
          if (researchModeError) throw new HttpError(400, researchModeError);
          if (input.researchMode === 'skill') input.skillLoading ??= webDefaultSkillLoading(provider);
          if (input.planApproval && (input.coordination !== 'cooperative' || input.workers < 2))
            throw new HttpError(400, '先审计划需要协作模式和至少 2 个 Agent。');
          if (!input.planApproval) delete input.planApproval;
          const typed = input.apiKey;
          const submissionKeys = (failed = false) => vault ? { savedKeys: savedKeysFor(session),
            ...(failed || saveKey && typed && session.account && vault.get(session.account.id, provider.id, provider.baseUrl) !== typed
              ? { keySaveFailed: true } : {}) } : {};
          const previous = jobs.replay(owner, input as WebRunInput, provider, requestId, legacyEnvironmentOmitted);
          if (previous) { json(response, 200, { run: previous, ...submissionKeys() }); return; }
          if (input.libraryProposalOrigin) research.validateLibraryProposalOrigin(owner, input.libraryProposalOrigin);
          if (input.budgetOrigin) {
            const origin = research.projects.resolveBinding(owner, input.budgetOrigin.projectId, input.budgetOrigin.runId);
            if (origin.run.source !== input.source || origin.run.environment !== input.environment)
              throw new HttpError(409, '运行的原题或环境与陈述版本不一致。');
          }
          const frozenResearch = !input.researchSelection ? undefined : input.nativeTeamCapacity
            ? research.assets.freezeNativeTeam(owner, input.researchSelection as ResearchConfigurationSelection, input.environment)
            : research.assets.freeze(owner, input.researchSelection as ResearchConfigurationSelection, input.environment,
              input.researchSelection.agent ? undefined : input.modulePlan as ResearchModulePlan | undefined);
          if (frozenResearch && input.researchSelection?.agent && input.modulePlan
              && JSON.stringify(input.modulePlan) !== JSON.stringify(frozenResearch.modulePlan))
            throw new HttpError(409, '所选 Agent 的方案与当前自定义方案不同，请清除自定义方案后重新提交。');
          if (frozenResearch) {
            // Freeze the exact combined source pack once. The worker and future evidence reads use this copy.
            const libraryPack = combineWebLibraryPacks(selectWebLibraryPack(input as WebRunInput), frozenResearch.libraryPack);
            if (libraryPack) frozenResearch.libraryPack = libraryPack as ResearchLibraryPack;
            const { digest: _digest, ...configuration } = frozenResearch;
            frozenResearch.digest = mathDigest(canonicalMathJson(configuration));
          }
          // A typed key wins; an empty one uses the account's saved key, then the server's key for admins.
          if (!typed) {
            const held = heldKey(session, provider);
            if (!held) throw new HttpError(400, '请填写 API Key。');
            input.apiKey = held;
          }
          const readiness = await runner.readiness();
          // Another request can be accepted while readiness is being checked.
          const raced = jobs.replay(owner, input as WebRunInput, provider, requestId, legacyEnvironmentOmitted);
          if (raced) { json(response, 200, { run: raced, ...submissionKeys() }); return; }
          if (!readiness.ready) throw new HttpError(503, '运行环境尚未就绪，请先构建 worker 镜像。');
          if (input.nativeTeamCapacity && !readiness.nativeTeam) throw new HttpError(503, '当前运行镜像未安装原生团队后端。');
          if (frozenResearch?.personalExperts?.length && !readiness.nativeTeamExpertCards)
            throw new HttpError(503, '当前运行镜像不支持个人专家资料。请移除专家资产或更新运行镜像。');
          if (input.nativeTeamPreferredProfiles?.length && !readiness.nativeTeamPreferences) throw new HttpError(503, '当前运行镜像不支持角色偏好。清空偏好后仍可使用原生团队。');
          const from = input.continueFrom as WebContinuation | undefined;
          const saved = from && jobs.get(owner, from.runId) ? trajectories.version(owner, from.runId, from.taskId, from.commit)?.source : undefined;
          if (from && !saved) throw new HttpError(404, '这个版本的代码没有记录或已超出保留范围。');
          if (from && saved && (['taskVersion', 'sourceDigest', 'environmentDigest', 'file'] as const).some(field => from[field] !== undefined && from[field] !== saved[field]))
            throw new HttpError(409, '续跑来源的固定版本与保存记录不一致，请重新选择。');
          const approved = input.formalizationId ? formalizations.confirmed(owner, input.formalizationId) : undefined;
          if (approved && (input.source !== approved.evidence.candidate.source || input.environment !== approved.evidence.request.environment))
            throw new HttpError(409, 'Lean 原题或环境已改变，请重新形式化确认，或作为普通 Lean 题目创建。');
          if (from && jobs.get(owner, from.runId)?.formalizationId !== input.formalizationId)
            throw new HttpError(409, '继续研究必须保留原运行的形式化来源。');
          // Only a new run costs allowance; a replayed request above already returned the run it created.
          admitWork();
          const refund = spend(session, 'runs');
          let run: WebRun;
          try {
            run = jobs.create(owner, input as WebRunInput, provider, from && saved ? { ...from, taskVersion: saved.taskVersion,
              sourceDigest: saved.sourceDigest, environmentDigest: saved.environmentDigest, file: saved.file, source: saved.source } : undefined, requestId,
              approved ? { evidence: approved.evidence, provenance: { id: approved.formalization.id,
                evidenceSha256: approved.formalization.report!.evidenceSha256, original: approved.formalization.original,
                confirmedAt: approved.formalization.confirmedAt!, confirmation: approved.formalization.confirmation ?? 'manual' } } : undefined,
              frozenResearch);
          }
          catch (error) {
            // A submit that never became a run gives the allowance back.
            refund();
            if (error instanceof WebStorageError) throw error;
            throw new HttpError(429, error instanceof Error ? error.message : '运行队列已满。');
          }
          milestone(owner, 'firstRunAt');
          let keySaveFailed = false;
          if (saveKey && typed && vault && session.account) {
            try { vault.save(session.account.id, provider.id, provider.baseUrl, typed); }
            catch { keySaveFailed = true; }
          }
          // The run has been accepted. An optional key save must not reject or refund its work.
          json(response, 201, { run, ...submissionKeys(keySaveFailed) });
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
            const parsed = explanationSchema.safeParse(await readBody());
            if (!parsed.success) throw new HttpError(400, '请检查讲解的目标定理、语言与 API Key。');
            const generation = explanationGeneration(session, run, isSample);
            if ('reason' in generation) throw new HttpError(409, {
              sample: '示例运行只读，不能生成讲解。', not_accepted: '只有通过独立验收的运行可以生成讲解。',
              provider: '证明讲解目前只支持 Sub2API 模型服务。', model: '证明讲解目前只支持 deepseek-flash 模型。',
              runtime: '当前服务不提供证明讲解。' }[generation.reason]);
            if (!targets.some(item => item.name === parsed.data.target)) throw new HttpError(400, '目标定理不在原题中。');
            const provider = providersFor(session).find(item => item.id === run.providerId)!;
            let apiKey = parsed.data.apiKey;
            if (!apiKey) {
              const saved = vault && session.account ? vault.get(session.account.id, provider.id, provider.baseUrl) : undefined;
              const held = saved ?? (serverKeysFor(session)?.includes(provider.id) ? config.adminKeys![provider.id] : undefined);
              if (!held) throw new HttpError(400, '请填写 API Key。');
              apiKey = held;
            }
            if (!(await runner.readiness()).ready) throw new HttpError(503, '运行环境尚未就绪，请先构建 worker 镜像。');
            admitWork();
            // The owned run may have been deleted while its body or readiness was awaited.
            if (!jobs.get(owner, run.id)) throw new HttpError(404, '运行不存在或不属于当前会话。');
            const refund = spend(session, 'explanations');
            try {
              json(response, 201, { explanation: explanations.create(owner, run, { target: parsed.data.target,
                language: parsed.data.language as WebExplanationLanguage, apiKey, provider, model: generation.model,
                effort: generation.effort }) });
            } catch (error) {
              refund();
              throw error;
            }
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
        if (operation === 'paper' || operation === 'paper/download' || operation === 'paper/pdf') {
          const creating = operation === 'paper' && request.method === 'POST';
          if (!creating && request.method !== 'GET') throw new HttpError(405, '请求方法不受支持。');
          const proof = run.result?.proof;
          if (run.status !== 'completed' || run.result?.status !== 'evaluated_passed' || !proof)
            throw new HttpError(409, '只有通过独立验收的运行可以生成论文初稿。');
          const parsed = paperRequest.safeParse(creating ? await readBody() : {
            target: url.searchParams.get('target') ?? undefined, language: url.searchParams.get('language') ?? undefined,
          });
          if (!parsed.success) throw new HttpError(400, '请检查论文初稿的目标定理、语言和 API Key。');
          const targets = (proofOutline(run)?.declarations ?? []).filter(item => item.role === 'target');
          const selected = parsed.data.target ? targets.find(item => item.name === parsed.data.target) : targets[0];
          if (!selected) throw new HttpError(400, '这次运行没有对应的已验收目标定理。');
          const { name: target, type: statement } = selected, { language } = parsed.data;
          const job = papers.get(owner, run, target, language);
          if (operation === 'paper/download') {
            if (!job?.draft) throw new HttpError(404, '论文初稿还没有生成。');
            const content = zip([{ name: 'template.tex', content: job.draft.template }, { name: 'main.tex', content: job.draft.main }]);
            response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': content.length,
              'Content-Disposition': `attachment; filename="paper-${run.id.slice(0, 8)}-${language}.zip"`, 'Cache-Control': 'no-store' });
            response.end(content); return;
          }
          if (operation === 'paper/pdf') {
            if (!job?.draft) throw new HttpError(404, '论文初稿还没有生成。');
            try {
              const { pdf } = await paperPdf.compile({ template: job.draft.template, main: job.draft.main });
              response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdf.length,
                'Content-Disposition': `attachment; filename="paper-${run.id.slice(0, 8)}-${language}.pdf"`, 'Cache-Control': 'no-store' });
              response.end(pdf);
            } catch (error) {
              if (error instanceof WebPaperPdfError) throw paperPdfHttpError(error);
              throw error;
            }
            return;
          }
          const providers = providersFor(session).filter(provider => webProviderHarness(provider) === 'codex');
          const defaultProvider = providers.find(provider => provider.id === job?.providerId)
            ?? providers.find(provider => provider.id === run.providerId)
            ?? providers.find(provider => provider.id === SUB2API_PROVIDER.id) ?? providers[0];
          const defaultModel = (provider: WebProvider) => {
            if (job?.providerId === provider.id && job.model) return job.model;
            if (run.providerId === provider.id) return run.model;
            if (provider.id === SUB2API_PROVIDER.id || provider.id === 'openai') return providerModel(provider);
            return '';
          };
          if (creating) {
            admitWork();
            const provider = parsed.data.providerId ? providers.find(item => item.id === parsed.data.providerId) : defaultProvider;
            if (!provider) throw new HttpError(409, '请选择已配置且支持 Responses API 的模型服务商。');
            const model = parsed.data.model ?? defaultModel(provider);
            if (!model) throw new HttpError(400, '请填写模型名称。');
            const apiKey = parsed.data.apiKey || heldKey(session, provider);
            if (!apiKey) throw new HttpError(400, '请填写 API Key。');
            const reuseResearchModel = provider.id === run.providerId && model === run.model && (!run.harness || run.harness === 'codex');
            const effort = reuseResearchModel ? run.effort : provider.id === SUB2API_PROVIDER.id ? 'high' : 'none';
            json(response, 202, { job: papers.start(owner, run, { target, statement, proof, language, template: paperTemplate },
              { providerId: provider.id, baseUrl: provider.baseUrl, apiKey, model,
                effort: effort === 'none' ? null : effort }) }); return;
          }
          const savedKeys = savedKeysFor(session), serverKeys = serverKeysFor(session);
          const overview: WebPaperOverview = { title: run.title, target, targets: targets.map(item => item.name), language,
            defaultProviderId: defaultProvider?.id, providers: providers.map(provider => ({ id: provider.id, name: provider.name,
              defaultModel: defaultModel(provider), key: savedKeys.some(key => key.providerId === provider.id) ? 'saved'
                : serverKeys?.includes(provider.id) ? 'server' : 'required' })), job };
          json(response, 200, overview); return;
        }
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
          const parsed = explainSchema.safeParse(await readBody());
          if (!parsed.success) throw new HttpError(400, '请检查问题、版本与 API Key。');
          const provider = providersFor(session).find(item => item.id === run.providerId);
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
          admitWork();
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
          const source = storage.getTaskSource(owner, run.id, decodeURIComponent(sourceMatch[1]), url.searchParams.get('version') ?? undefined,
            url.searchParams.get('commit') ?? undefined);
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
          const parsed = webGuidanceSchema.safeParse(await readBody());
          if (!parsed.success) throw new HttpError(400, '请检查指导对象、任务版本与内容。');
          try { json(response, 200, { receipt: await jobs.command(owner, run.id, { type: 'guidance', guidance: parsed.data }) }); }
          catch (error) { throw new HttpError(409, error instanceof Error ? error.message : '指导未能提交。'); }
          return;
        }
        if (operation === 'plan-approval' && request.method === 'POST') {
          const parsed = webPlanApprovalSchema.safeParse(await readBody());
          if (!parsed.success) throw new HttpError(400, '请重新读取当前计划后再批准。');
          try { json(response, 200, { receipt: await jobs.command(owner, run.id, { type: 'plan-approval', approval: parsed.data }) }); }
          catch (error) { throw new HttpError(409, error instanceof Error ? error.message : '计划批准未能提交。'); }
          return;
        }
        if (['edits/preview', 'edits'].includes(operation ?? '') && request.method === 'POST') {
          const parsed = webPlanProposalSchema.safeParse(await readBody());
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
            let review;
            if (run.formalization) {
              try { review = formalizations.read(owner, run.formalization.id).report; }
              catch (error) { if (!(error instanceof WebStorageError && error.status === 404)) throw error; }
            }
            const approved = explanations.list(owner, run.id).filter(item => item.status === 'approved').flatMap(item => {
              const document = explanations.read(owner, run, item.target, item.language)?.document;
              return document ? [document] : [];
            });
            const createdAt = new Date().toISOString(), snapshot = shareSnapshot(run, createdAt, review, { explanations: approved });
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
        if (['download', 'snapshot'].includes(operation ?? '') && request.method === 'GET') {
          if (!run.result && !['completed', 'cancelled', 'error'].includes(run.status))
            throw new HttpError(409, '运行尚未结束，且结果尚未生成。');
          response.setHeader('Content-Disposition', `attachment; filename="theoremos-${run.id}${operation === 'snapshot' ? '-snapshot' : ''}.json"`);
          json(response, 200, operation === 'snapshot' ? { schema: 'theorem-os.web-export.v1', run }
            : storage.exportRun(owner, run, run.knowledgeCatalogDigest)); return;
        }
        if (!match[2] && request.method === 'GET') { json(response, 200, { run }); return; }
        throw new HttpError(405, '请求方法不受支持。');
      }
      if (!['GET', 'HEAD'].includes(request.method || '')) throw new HttpError(405, '请求方法不受支持。');
      // A signed-out visitor goes straight to the login page instead of loading the workbench only to be sent there;
      // a run or conversation link keeps its record (login.html?run=<id>, ?chat=<id>) so signing in returns to it.
      if (auth && ['/', '/index.html'].includes(url.pathname) && !cookieSession(request)?.account) {
        response.writeHead(302, { Location: `/login.html${workbenchReturn(url.search)}` });
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
      sendStatic(request, response, file, extension, contentType, path.relative(config.staticRoot, file).split(path.sep).join('/'));
    } catch (error) {
      const invalidKnowledgeInput = error instanceof Error && /^math_knowledge_(?:invalid_query|invalid_dependency_options|(?:source|metadata|consumers|finding)_(?:options_invalid|position_invalid|budget_too_small))$/u.test(error.message);
      const known = error instanceof HttpError || error instanceof WebStorageError || error instanceof WebAuthError
        || error instanceof WebAdmissionError || error instanceof WebProviderCheckError;
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
    const closed = await Promise.allSettled([jobs.close(), research.close(), explanations.close(), papers.close(), paperPdf.close(), formalizations.close(), conversations.close(), new Promise<void>(resolve => server.close(() => resolve()))]);
    for (const result of closed) if (result.status === 'rejected') throw result.reason;
  };
  return { server, jobs, research, explanations, formalizations, conversations, storage, knowledge, registry, auth, close };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const config = readWebConfig({ ...process.env, THEOREMOS_WEB_DATA_ROOT: process.env.THEOREMOS_WEB_DATA_ROOT || 'out/web-data' });
  const service = createWebService(config);
  service.server.listen(config.port, config.host, () => console.log(`TheoremOS workbench: ${config.publicUrl}`));
  let stopping = false;
  const stop = () => { if (!stopping) { stopping = true; void service.close().then(() => process.exit(0)); } };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
