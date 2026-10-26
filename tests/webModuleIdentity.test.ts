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
    // Golden digests: runtime b52f047 identity plus the theory-building module versions (tactic battery and its vacuity probe, untouched-seed request failures, Lead inbox, stopped-worker release, definition tasks, reference search, definition knowledge, math tools, isolated module builds, kernel certificates, goal-path review and stall wake, blueprint fields).
    const original: [ResearchModulePlan['scheduler'], ResearchModulePlan['context'], string][] = [
      ['plan', 'full', '6df82fdba3761845725ba9f7ed76171bf4b9f6fd8050cbebf0be9157941f7094'],
      ['plan', 'essential', '8b92c06af7f11483fd26f4e4c1dfd5bfe69d84ec7cb31eab882e99caa14cbd71'],
      ['critical-path', 'full', 'aa0f526e60c9f1008ac81d542a9cc73dcfd2f43d061e00115687f635f4e85232'],
      ['critical-path', 'essential', '5153facc2df90cf06a669a8a52ab8b4dd70647fe0433c4232677b6ecd076273c'],
      ['continuation', 'full', '2c5797e23f10077c1f7b74f7fd0f2b51f1c5c185a648406ed506bc68714a59fc'],
      ['continuation', 'essential', '4a72648185c709beb1bdce189c5767b761693099a3da69f85a30344d81ddfd25'],
    ];
    for (const [scheduler, context, digest] of original) {
      const plan = { scheduler, context, custom: [] };
      expect(solverMethodDigest(configurableSolverModules(plan), 'cooperative')).toBe(digest);
      expect(solverIdentityMethodDigest(configuredResearchModuleIdentity(plan).identity, 'cooperative')).toBe(digest);
    }
    const advised: ['cooperative' | 'independent', number, string][] = [
      ['cooperative', 1, '2c3202a519940aa2ad8187392eee36292f52bd1437caffc95b920e83fb839879'],
      ['cooperative', 4, '7bd4ab97e8206f0dc1d51edabe6f0d285be83efe9cd83791a9b0737de660373e'],
      ['independent', 1, '14654b6eb0166c1876e30effddf2a157487d68945f2611c9abf2ab7cef5b90d4'],
      ['independent', 4, '14654b6eb0166c1876e30effddf2a157487d68945f2611c9abf2ab7cef5b90d4'],
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
