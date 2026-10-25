import { configuredSolverModules, directSolverModules, type SolverModules } from './index';
import type { ResearchModulePlan } from './policy';
import { configuredResearchModuleIdentity } from './moduleIdentity';

export function configurableSolverModules(plan?: ResearchModulePlan,
  coordination: 'cooperative' | 'independent' = 'cooperative', workers = 4): SolverModules {
  const resolved = configuredResearchModuleIdentity(plan, coordination, workers);
  if (resolved.plan === null) return directSolverModules;
  const configuration = resolved.plan;
  const base = configuredSolverModules('direct', configuration.scheduler);
  const { identity, rules } = resolved;
  if (!resolved.customized) return base;
  return { ...base, id: identity.id,
    M1: { ...base.M1, version: identity.versions.M1! },
    M3: { ...base.M3, version: identity.versions.M3! },
    M5: { ...base.M5, version: identity.versions.M5! },
    M4: { ...base.M4, version: identity.versions.M4!,
      build: (problem, state, access) => {
        const applied = rules.filter(module => module.slot !== 'M5' || Boolean(state.cooperation));
        const context = base.M4.build(problem, state, { ...access, customModuleRules: applied,
          ...(configuration.context === 'essential' ? { maxOptionalContextBytes: 0 } : {}) });
        if (context.manifest) for (const module of applied) console.log(JSON.stringify({
          event: 'custom_module_applied', at: Date.now(), moduleId: module.id, slot: module.slot, mode: module.mode,
        }));
        return context;
      },
    },
  };
}
