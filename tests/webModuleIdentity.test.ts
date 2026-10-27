import { describe, expect, it } from 'vitest';
import { configurableSolverModules } from '../src/solver/modules/custom';
import { solverMethodDigest, solverModuleConfiguration } from '../src/solver/modules';
import { configuredResearchModuleIdentity, solverIdentityMethodDigest } from '../src/solver/modules/moduleIdentity';
import { freezeModuleConfiguration, registeredWebModules } from '../apps/web/moduleRegistry';
import { webSolverModules } from '../apps/web/worker';
import type { WorkerInput } from '../apps/web/shared';
import type { CustomResearchModule, ResearchModulePlan } from '../src/solver/modules/policy';

const custom: CustomResearchModule[] = [
  { id: 'probe', name: 'Probe', slot: 'M1', mode: 'replace', enabled: true, instructions: 'Search exact assumptions.' },
  { id: 'roles', name: 'Roles', slot: 'M5', mode: 'append', enabled: true, instructions: 'Assign explicit deliverables.' },
];

describe('one frozen identity for executable research modules and the optional web registry', () => {
  it('matches committed runtime method digests after extracting the shared identity functions', () => {
    // Golden digests: runtime b52f047 identity plus the theory-building module versions (tactic battery and its vacuity probe, untouched-seed request failures, Lead inbox, stopped-worker release, definition tasks, reference search, definition knowledge, math tools, isolated module builds, kernel certificates, goal-path review and stall wake, blueprint fields, theory modules, definition sanity lemmas, goal-path answers, owned declaration index, frozen library modules, library packs and task families).
    const original: [ResearchModulePlan['scheduler'], ResearchModulePlan['context'], string][] = [
      ['plan', 'full', '081459ca81837455596156a45c7c8bbedef9769b901a7b6acc7cd97000f1aad1'],
      ['plan', 'essential', 'ef662f4dc6f572ed26fd299ac3d730c3c0e068f5140bafa49576f44f84212dfc'],
      ['critical-path', 'full', 'f4cef87b069d9a87e94baf95bdfb3553176bdacf34647b1fbc5984b62928ece8'],
      ['critical-path', 'essential', '4e170e3dd99c14859831e6a3ddb059c8b4a1aa5847ce36188f556d74eb6222d7'],
      ['continuation', 'full', 'ccf14cf4615d41134c81a7de85236356a385886e76c0439172d63b2a9070b70f'],
      ['continuation', 'essential', 'd8ae27662e47861899b1dbdbf47c11e8fa7b80bc47fcc4108623648dd2cd1200'],
    ];
    for (const [scheduler, context, digest] of original) {
      const plan = { scheduler, context, custom: [] };
      expect(solverMethodDigest(configurableSolverModules(plan), 'cooperative')).toBe(digest);
      expect(solverIdentityMethodDigest(configuredResearchModuleIdentity(plan).identity, 'cooperative')).toBe(digest);
    }
    const advised: ['cooperative' | 'independent', number, string][] = [
      ['cooperative', 1, '7e5902522d8e45c0164dc661da844a1baf6197c61bcd60ad91b0cb507a0df491'],
      ['cooperative', 4, 'ff31f358d14d8a21838184af85b17c239821268eb553f8b1c9fcb35ce6f3b290'],
      ['independent', 1, 'e804f7e426b39731202487d3f7661771dd3768e6e63659206688e5ecd978ae90'],
      ['independent', 4, 'e804f7e426b39731202487d3f7661771dd3768e6e63659206688e5ecd978ae90'],
    ];
    for (const [coordination, workers, digest] of advised) {
      const plan: ResearchModulePlan = { scheduler: 'continuation', context: 'essential', custom };
      expect(solverMethodDigest(configurableSolverModules(plan, coordination, workers), coordination)).toBe(digest);
      expect(solverIdentityMethodDigest(configuredResearchModuleIdentity(plan, coordination, workers).identity, coordination)).toBe(digest);
    }
  });

  it('uses executable component versions for all registered choices, modes, worker counts and advice rules', () => {
    for (const scheduler of ['plan', 'critical-path', 'continuation'] as const)
      for (const context of ['full', 'essential'] as const)
        for (const coordination of ['cooperative', 'independent'] as const)
          for (const workers of [1, 4])
            for (const rules of [[], custom, custom.map(module => ({ ...module, enabled: false }))]) {
              const plan = { scheduler, context, custom: rules }, runtime = configurableSolverModules(plan, coordination, workers);
              const { identity } = configuredResearchModuleIdentity(plan, coordination, workers);
              expect(identity).toEqual(solverModuleConfiguration(runtime));
              expect(solverIdentityMethodDigest(identity, coordination)).toBe(solverMethodDigest(runtime, coordination));
            }
  });

  it('freezes the actual BYOK worker method for every preset, advice plan, coordination mode and supported worker count', () => {
    const request = (plan: ResearchModulePlan | undefined, coordination: 'cooperative' | 'independent', workers: number): WorkerInput => ({
      id: 'identity-fixture', provider: { id: 'fixture', name: 'Offline fixture', baseUrl: 'https://example.invalid/v1' },
      input: { providerId: 'fixture', apiKey: 'sk-never-used-identity-fixture', model: 'never-called', effort: 'high',
        source: 'theorem example : True := by sorry', task: 'Offline module identity', maxTurns: 1, maxRunSeconds: 30,
        coordination, workers, ...(plan ? { modulePlan: plan } : {}) } });
    const plans: (ResearchModulePlan | undefined)[] = [undefined];
    for (const scheduler of ['plan', 'critical-path', 'continuation'] as const)
      for (const context of ['full', 'essential'] as const)
        for (const rules of [[], custom, custom.map(module => ({ ...module, enabled: false }))])
          plans.push({ scheduler, context, custom: rules });
    for (const plan of plans)
      for (const coordination of ['cooperative', 'independent'] as const)
        for (const workers of [1, 2, 4, 8]) {
          const worker = webSolverModules(request(plan, coordination, workers));
          const frozen = freezeModuleConfiguration(plan, coordination, workers);
          expect({ id: frozen.id, versions: frozen.versions }).toEqual(solverModuleConfiguration(worker));
          expect(frozen.methodDigest).toBe(solverMethodDigest(worker, coordination));
        }
    const defaults = webSolverModules(request(undefined, 'cooperative', 2));
    expect(registeredWebModules().entries.find(entry => entry.slot === 'M1')?.version).toBe(defaults.M1.version);
  });
});
