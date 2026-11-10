import { z } from 'zod';
import { canonicalMathJson, mathDigest } from '../../src/math/mathRuntimeIo';
import { WebStorage, WebStorageError } from './storage';
import type { WebResearchProblems } from './researchProblems';
import type { WebResearchWorkspace } from './researchWorkspace';
import type { ResearchBudgetView, ResearchProblemBudget, ResearchBudgetSource } from './researchBudgetTypes';
import { researchStatementIdentity } from './client/researchOverviewModel';

const inputSchema = z.object({ requestId: z.string().min(1).max(200), expectedRevision: z.number().int().min(0),
  currency: z.enum(['CNY', 'USD']), tokenLimit: z.number().int().min(0).max(1e12).nullable(), amountLimit: z.number().finite().min(0).max(1e9).nullable() }).strict();
type StoredBudget = { plan: ResearchProblemBudget; requests: { id: string; digest: string }[] };
/** A private planning budget spans all readable attempts. Existing runtime limits remain authoritative. */
export class WebResearchBudgets {
  constructor(private storage: WebStorage, private problems: WebResearchProblems, private workspace: WebResearchWorkspace) {}
  private path(viewer: string, key: string) { return ['owners', mathDigest(viewer), 'problem-budgets', `${key}.json`]; }
  private locate(viewer: string, runId: string, projectId?: string) {
    const problem = this.problems.detail(viewer, runId, projectId);
    const path = this.path(viewer, problem.key), current = this.storage.getRecord<StoredBudget>(path);
    const sources = new Map<string, ResearchBudgetSource>();
    if (problem.project) for (const attempt of problem.brief.attempts) {
      // Only this viewer's own records can supply a private budget, even in a shared project.
      const owned = this.storage.getRun(viewer, attempt.id); if (!owned) continue;
      const key = mathDigest(researchStatementIdentity(owned)); if (key === problem.key) continue;
      const before = this.storage.getRecord<StoredBudget>(this.path(viewer, key)); if (!before) continue;
      const source = sources.get(key);
      if (source) source.runIds.push(attempt.id);
      else sources.set(key, { key, title: attempt.title, runIds: [attempt.id], plan: before.plan });
    }
    const candidates = [...sources.values()].sort((a, b) => a.key.localeCompare(b.key));
    const digest = mathDigest(canonicalMathJson(candidates.map(source => ({ key: source.key, plan: source.plan }))));
    const different = new Set(candidates.map(source => canonicalMathJson({ currency: source.plan.currency, tokenLimit: source.plan.tokenLimit, amountLimit: source.plan.amountLimit })));
    const continuity = !current && candidates.length ? { status: different.size > 1 ? 'conflict' as const : 'inherited' as const, digest, sources: candidates } : undefined;
    const selected = continuity?.status === 'inherited' ? candidates.toSorted((a, b) => (b.plan.updatedAt ?? '').localeCompare(a.plan.updatedAt ?? ''))[0] : undefined;
    const inherited = selected && this.storage.getRecord<StoredBudget>(this.path(viewer, selected.key));
    const stored = current ?? (inherited ? { ...inherited, plan: { ...inherited.plan, key: problem.key } } : {
      plan: { key: problem.key, revision: 0, currency: 'CNY' as const, tokenLimit: null, amountLimit: null }, requests: [] });
    return { problem, path, stored, current, continuity };
  }
  view(viewer: string, runId: string, projectId?: string, nextTokens = 0, nextModel?: { providerId: string; model: string }): ResearchBudgetView {
    const { problem, stored: { plan }, continuity } = this.locate(viewer, runId, projectId), entries = problem.brief.usage.entries;
    const knownTokens = entries.reduce((total, entry) => total + (entry.tokens ?? 0), 0);
    const spent = { CNY: 0, USD: 0 };
    for (const entry of entries) if (entry.estimate) spent[entry.estimate.currency] += entry.estimate.amount;
    const current = nextModel ?? entries.find(entry => entry.id === `proof:${runId}`);
    const rate = current && this.workspace.rates(viewer).find(rate => rate.model === current.model && rate.providerId === current.providerId);
    const amount = rate ? nextTokens * rate.perMillion / 1e6 : null;
    return { plan, title: problem.brief.title, knownTokens, missingUsage: entries.filter(entry => entry.tokens === null).length,
      unpricedEntries: entries.filter(entry => !entry.estimate).length, spent,
      ...(continuity ? { continuity } : {}), remainingTokens: plan.tokenLimit === null ? null : plan.tokenLimit - knownTokens,
      remainingAmount: plan.amountLimit === null ? null : plan.amountLimit - spent[plan.currency],
      forecast: { tokens: nextTokens, model: current?.model ?? '', currency: rate?.currency ?? null, amount,
        perMillion: rate?.perMillion ?? null, overTokens: plan.tokenLimit !== null && knownTokens + nextTokens > plan.tokenLimit,
        overAmount: Boolean(plan.amountLimit !== null && rate?.currency === plan.currency && amount !== null && spent[plan.currency] + amount > plan.amountLimit) } };
  }
  save(viewer: string, runId: string, projectId: string | undefined, raw: unknown): ResearchBudgetView {
    const parsed = inputSchema.safeParse(raw);
    if (!parsed.success) throw new WebStorageError(400, '请填写有效的题目预算。');
    const input = parsed.data, { path, stored, continuity } = this.locate(viewer, runId, projectId), digest = mathDigest(canonicalMathJson(input));
    if (continuity?.status === 'conflict') throw new WebStorageError(409, '这个项目有多份不同的个人预算，请先核对接续哪一份。');
    const previous = stored.requests.find(request => request.id === input.requestId);
    if (previous) {
      if (previous.digest !== digest) throw new WebStorageError(409, '同一请求不能保存不同的预算。');
      return this.view(viewer, runId, projectId);
    }
    if (input.expectedRevision !== stored.plan.revision) throw new WebStorageError(409, '预算已在另一处更新，请重新读取后保存。');
    stored.plan = { key: stored.plan.key, revision: stored.plan.revision + 1, currency: input.currency,
      tokenLimit: input.tokenLimit, amountLimit: input.amountLimit, updatedAt: new Date().toISOString() };
    stored.requests.push({ id: input.requestId, digest });
    this.storage.saveRecord(path, stored);
    return this.view(viewer, runId, projectId);
  }
  inherit(viewer: string, runId: string, projectId: string | undefined, raw: unknown): ResearchBudgetView {
    const schema = z.object({ requestId: z.string().min(1).max(200), expectedRevision: z.number().int().nonnegative(),
      sourceKey: z.string().regex(/^[a-f0-9]{64}$/u).nullable(), sourceRevision: z.number().int().nonnegative().nullable(),
      sourcesDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
    const parsed = schema.safeParse(raw); if (!parsed.success) throw new WebStorageError(400, '请选择要接续的有效预算。');
    const input = parsed.data, { problem, path, stored, current, continuity } = this.locate(viewer, runId, projectId), digest = mathDigest(canonicalMathJson(input));
    const previous = stored.requests.find(request => request.id === input.requestId);
    if (previous) { if (previous.digest !== digest) throw new WebStorageError(409, '同一请求不能保存不同的预算。'); return this.view(viewer, runId, projectId); }
    if (current || continuity?.status !== 'conflict' || stored.plan.revision !== input.expectedRevision || continuity.digest !== input.sourcesDigest)
      throw new WebStorageError(409, '预算来源已更新，请重新读取后核对。');
    const selected = continuity.sources.find(source => source.key === input.sourceKey);
    if (input.sourceKey && (!selected || selected.plan.revision !== input.sourceRevision) || !input.sourceKey && input.sourceRevision !== null)
      throw new WebStorageError(409, '预算来源已更新，请重新读取后核对。');
    const plan: ResearchProblemBudget = { ...(selected?.plan ?? stored.plan), key: problem.key, revision: stored.plan.revision + 1, updatedAt: new Date().toISOString() };
    this.storage.saveRecord(path, { plan, requests: [{ id: input.requestId, digest }] });
    return this.view(viewer, runId, projectId);
  }
}
export function createResearchBudgetsHandler(dependencies: { storage: WebStorage; problems: WebResearchProblems; workspace: WebResearchWorkspace }) {
  const service = new WebResearchBudgets(dependencies.storage, dependencies.problems, dependencies.workspace);
  return { service, async handle(url: URL, method: string, viewer: string, readBody: () => Promise<unknown>) {
    const match = /^\/api\/research\/workspace\/problem\/([^/]+)\/budget(?:\/(inherit))?$/u.exec(url.pathname);
    if (!match) return;
    const run = decodeURIComponent(match[1]!), project = url.searchParams.get('project') ?? undefined;
    if (match[2]) return method === 'POST' ? { status: 200, body: { item: service.inherit(viewer, run, project, await readBody()) } }
      : { status: 405, body: { error: '此预算接续操作不支持该请求方式。' } };
    if (method === 'GET') {
      const tokens = Number(url.searchParams.get('tokens') ?? '0');
      if (!Number.isSafeInteger(tokens) || tokens < 0 || tokens > 1e12) throw new WebStorageError(400, '请填写有效的题目预算。');
      const providerId = url.searchParams.get('provider'), model = url.searchParams.get('model');
      return { status: 200, body: { item: service.view(viewer, run, project, tokens, providerId && model ? { providerId, model } : undefined) } };
    }
    if (method === 'PUT') return { status: 200, body: { item: service.save(viewer, run, project, await readBody()) } };
  } };
}
