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
    // Frozen behavior identity after notation source inputs, orphan instance cleanup
    // and yielded-advisory proof frontier scheduling (2026-11-10).
    const original: [ResearchModulePlan['scheduler'], ResearchModulePlan['context'], string][] = [
      ['plan', 'full', 'fdb7a2f589475ca08542702fb9954b2b0f909a1038d38e1ae0c54c566d228122'],
      ['plan', 'essential', 'dcce496aecaeb5ed1b8b8eee4eeac09953bde2e5fde6ba824ec9c87d71fa4d3b'],
      ['critical-path', 'full', '19c4d0569d43dca33318d06a3ea8bf1f2eb185c3f021bc98a7c86f9c8e28797d'],
      ['critical-path', 'essential', '6b2ecfac399d91eab5ef3e091cee6893c717c9a3e56c8cfd127a44e6071bdb07'],
      ['continuation', 'full', 'be7642b65e4b63fdea8ede9cfde5cfcbaeceb83373c269a72eaf449179626c41'],
      ['continuation', 'essential', '0ffef9f6747a5e2651c4f16a0de4e9fa63f9445cf669dae177ef5ee77cfc5075'],
    ];
    for (const [scheduler, context, digest] of original) {
      const plan = { scheduler, context, custom: [] };
      expect(solverMethodDigest(configurableSolverModules(plan), 'cooperative')).toBe(digest);
      expect(solverIdentityMethodDigest(configuredResearchModuleIdentity(plan).identity, 'cooperative')).toBe(digest);
    }
    const advised: ['cooperative' | 'independent', number, string][] = [
      ['cooperative', 1, 'db7f7b6a0845c9b74330f862627dbf673d7892d89d7543aaaa37f99b1f295177'],
      ['cooperative', 4, 'e9678bd76cde9f87547d7c2c82153920d5379e9e2f0cb3634f8e6934db76d725'],
      ['independent', 1, 'f116b5379fc3ccfdd6feaf032d01a7f3e9979be653cf690a7841f4fbe0a47c13'],
      ['independent', 4, 'f116b5379fc3ccfdd6feaf032d01a7f3e9979be653cf690a7841f4fbe0a47c13'],
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
