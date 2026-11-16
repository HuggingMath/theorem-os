import crypto from 'node:crypto';
import { z } from 'zod';
import { configuredResearchModuleIdentity, directSolverModuleIdentity, solverIdentityMethodDigest } from '../../src/solver/modules/moduleIdentity';
import { defaultResearchModulePlan, researchModulePlanSchema, type ResearchModulePlan } from '../../src/solver/modules/policy';
import { WebStorage, WebStorageError } from './storage';
import { mathDigest } from '../../src/math/mathRuntimeIo';
import type { WebFrozenModuleConfiguration, WebHarness } from './shared';
import { webByokModuleIdentity } from './webModuleIdentity';
export type { WebFrozenModuleConfiguration } from './shared';

export const webModuleRegistryVersion = 'theorem-os.web-module-registry.v1' as const;
export type WebRegisteredModule = {
  id: string; slot: 'M1' | 'M2' | 'M3' | 'M4' | 'M5' | 'S3'; name: string; version: string;
  inputs: string[]; outputs: string[]; fixed: boolean;
  configuration?: { scheduler?: ResearchModulePlan['scheduler']; context?: ResearchModulePlan['context'] };
};
export type WebSavedModulePlan = {
  id: string; name: string; plan: ResearchModulePlan; configuration: WebFrozenModuleConfiguration;
  createdAt: string; updatedAt: string;
};

/** These entries describe code the service can construct; advice text never registers executable plugins. */
export function registeredWebModules() {
  const webIdentity = webByokModuleIdentity(directSolverModuleIdentity);
  const entries: WebRegisteredModule[] = [
    { id: 'M1:direct', slot: 'M1', name: '有界证明研究', version: webIdentity.versions.M1!,
      inputs: ['frozen-problem', 'task-contract', 'context'], outputs: ['research-delivery', 'candidate'], fixed: true },
    { id: 'M2:lean-kernel', slot: 'M2', name: 'Lean 局部检查', version: directSolverModuleIdentity.versions.M2!,
      inputs: ['owned-source', 'frozen-task-version', 'environment'], outputs: ['bound-check-receipt'], fixed: true },
    ...(['plan', 'critical-path', 'continuation'] as const).map(scheduler => ({ id: `M3:${scheduler}`, slot: 'M3' as const,
      name: { plan: '计划顺序', 'critical-path': '关键路径', continuation: '延续证明前沿' }[scheduler],
      version: configuredResearchModuleIdentity({ scheduler, context: 'full', custom: [] }).identity.versions.M3!,
      inputs: ['task-graph', 'proof-frontier', 'budgets'], outputs: ['ready-task-ranking'], fixed: false,
      configuration: { scheduler } })),
    ...(['full', 'essential'] as const).map(context => ({ id: `M4:${context}`, slot: 'M4' as const,
      name: context === 'full' ? '完整研究上下文' : '必要证明上下文',
      version: configuredResearchModuleIdentity({ scheduler: 'plan', context, custom: [] }).identity.versions.M4!,
      inputs: ['task-contract', 'proof-evidence', 'knowledge', 'advice-rules'], outputs: ['role-context'], fixed: false,
      configuration: { context } })),
    { id: 'M5:cooperation', slot: 'M5', name: '角色分工与交付', version: directSolverModuleIdentity.versions.M5!,
      inputs: ['ready-tasks', 'workers', 'review-receipts'], outputs: ['assignments', 'handoffs'], fixed: true },
    { id: 'S3:independent-final', slot: 'S3', name: '完整原题独立验收', version: 'host-final-acceptance-v1',
      inputs: ['original-problem', 'integrated-source', 'environment'], outputs: ['independent-evaluation'], fixed: true },
  ];
  return { schema: webModuleRegistryVersion, entries, scope: 'next-run' as const, adviceModes: ['append', 'replace'] as const };
}

export function freezeModuleConfiguration(plan?: ResearchModulePlan, coordination: 'cooperative' | 'independent' = 'cooperative',
  workers = 4, harness: WebHarness = 'codex'): WebFrozenModuleConfiguration {
  const selected = plan === undefined ? defaultResearchModulePlan() : researchModulePlanSchema.parse(plan) as ResearchModulePlan;
  const configuration = webByokModuleIdentity(configuredResearchModuleIdentity(plan, coordination, workers).identity);
  if (harness !== 'codex') configuration.versions.M1 += ':' + harness + ':v1';
  const ids = new Set(['M1:direct', 'M2:lean-kernel', `M3:${selected.scheduler}`, `M4:${selected.context}`, 'M5:cooperation', 'S3:independent-final']);
  return { registryVersion: webModuleRegistryVersion, ...configuration, methodDigest: solverIdentityMethodDigest(configuration, coordination),
    coordination, workers, selection: { scheduler: selected.scheduler, context: selected.context,
      implementations: registeredWebModules().entries.filter(entry => ids.has(entry.id))
        .map(entry => ({ slot: entry.slot, id: entry.id, version: configuration.versions[entry.slot] ?? entry.version })) } };
}

export class WebModuleRegistry {
  constructor(private readonly storage: WebStorage) {}
  registry() { return registeredWebModules(); }
  private plansPath(owner: string) { return ['owners', mathDigest(owner), 'module-plans.json']; }
  listPlans(owner: string): WebSavedModulePlan[] { return this.storage.getRecord(this.plansPath(owner)) ?? []; }
  getPlan(owner: string, id: string): WebSavedModulePlan | undefined { return this.listPlans(owner).find(plan => plan.id === id); }
  savePlan(owner: string, value: unknown): WebSavedModulePlan {
    const validated = z.object({ name: z.string().trim().min(1).max(40).refine(name => !name.includes('\0')),
      plan: researchModulePlanSchema, id: z.string().max(128).optional(), baseUpdatedAt: z.string().datetime().optional() }).strict().safeParse(value);
    if (!validated.success) throw new WebStorageError(400, '模块方案无效，请检查名称、注册实现和规则。');
    const input = validated.data;
    const plans = this.listPlans(owner), previous = input.id ? plans.find(plan => plan.id === input.id) : undefined;
    if (input.id && !previous) throw new WebStorageError(404, '方案不存在或不属于当前会话。');
    if (previous && input.baseUpdatedAt !== previous.updatedAt) throw new WebStorageError(409, '此方案已被其他页面修改，请重新核对后保存。');
    if (!previous && plans.length >= 12) throw new WebStorageError(409, '方案库已达到 12 项上限。');
    const name = input.name.trim();
    if (plans.some(plan => plan.id !== previous?.id && plan.name.toLowerCase() === name.toLowerCase()))
      throw new WebStorageError(409, '已有同名方案，请更换名称。');
    const plan = input.plan as ResearchModulePlan;
    const now = new Date(Math.max(Date.now(), previous ? Date.parse(previous.updatedAt) + 1 : 0)).toISOString();
    const saved: WebSavedModulePlan = { id: previous?.id ?? crypto.randomUUID(), name, plan,
      configuration: freezeModuleConfiguration(plan), createdAt: previous?.createdAt ?? now, updatedAt: now };
    this.storage.saveRecord(this.plansPath(owner), [saved, ...plans.filter(item => item.id !== saved.id)]);
    return saved;
  }
  deletePlan(owner: string, id: string, updatedAt?: string): void {
    const plans = this.listPlans(owner), previous = plans.find(plan => plan.id === id);
    if (!previous) throw new WebStorageError(404, '方案不存在或不属于当前会话。');
    if (updatedAt !== undefined && updatedAt !== previous.updatedAt) throw new WebStorageError(409, '此方案已被修改，请重新选择后删除。');
    this.storage.saveRecord(this.plansPath(owner), plans.filter(plan => plan.id !== id));
  }
}
