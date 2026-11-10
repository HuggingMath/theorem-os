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
  it('pins the remediation behavior digests for both executable modules and shared identity functions', () => {
    // Freeze connection checkpoint scheduling and knowledge packet candidate refill
    // with the inherited feedback, continuation and host authorization behavior
    // in the repaired runtime (2026-11-11).
    const original: [ResearchModulePlan['scheduler'], ResearchModulePlan['context'], string][] = [
      ['plan', 'full', 'a54904fa4727d0ecc40fa4dc3888a5d7f96f85442990fdfeff0a1410eecfe56f'],
      ['plan', 'essential', '639245051c544df3640830cec74828984c672c2be49fa1a5c3cab4a3cfe4fc57'],
      ['critical-path', 'full', '2cd536c9eae3663fc037c9377bf75c293f2b017c9ce382f52da80b7ea04b9150'],
      ['critical-path', 'essential', 'e7354db751ec21170c11e935754e98615d16a954b6536015f60e1118b473f1eb'],
      ['continuation', 'full', '1ce601ec173d4ee341644183d3fae1aaecd9f0d2641134b1b21584ec8d4a35b7'],
      ['continuation', 'essential', '918b13c23767f9b6bb561fb4ccbf018afb60192452a3420b1c646ad20b703488'],
    ];
    for (const [scheduler, context, digest] of original) {
      const plan = { scheduler, context, custom: [] };
      expect(solverMethodDigest(configurableSolverModules(plan), 'cooperative')).toBe(digest);
      expect(solverIdentityMethodDigest(configuredResearchModuleIdentity(plan).identity, 'cooperative')).toBe(digest);
    }
    const advised: ['cooperative' | 'independent', number, string][] = [
      ['cooperative', 1, '5293dc576a1ec101ebdd6f6ab6d9d1ce2eaf8095d124b685a17a00de0eba2184'],
      ['cooperative', 4, 'a817718214caf4342cfbb04cbcf857ae839f02b1b4f06c1cf73c94a4bb31f9e2'],
      ['independent', 1, '47c7fee07335333877760cbae0dca6329afa54a74c6eeeb92695c73526c78a45'],
      ['independent', 4, '47c7fee07335333877760cbae0dca6329afa54a74c6eeeb92695c73526c78a45'],
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
