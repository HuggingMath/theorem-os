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
  it('matches runtime method digests for system progress reviews and dependency repair', () => {
    // Golden identities include M2 projection-dependency diagnostics, M4 team/source-dependency review context,
    // and M5 substantive goal-path decisions, source-dependency connections and active-goal progress reviews.
    const original: [ResearchModulePlan['scheduler'], ResearchModulePlan['context'], string][] = [
      ['plan', 'full', 'f1a8348e02b8d1ee7e841fcee37b0c4df1e247a074da5f006d45cdd1c14ea26f'],
      ['plan', 'essential', '15a8c8dab3050fb7560fff4e95e1be7388c96398a211792f3053883160a79e0c'],
      ['critical-path', 'full', '8a4773634534fb8b64f4aa581cd911119acd16b057289c3d4ac911663e5b3e83'],
      ['critical-path', 'essential', '1eed30c0a86496c11d5210d7c238ed61c16e1a4d84bf13b928f6ca63ae5554ec'],
      ['continuation', 'full', '18f57ad2f08e2f00fcfcb3d6b82e43cb5ae6507a4e4f8373df107979aa073d0e'],
      ['continuation', 'essential', 'dc606ec859a340eefb89bc4ec210a738c4720e07a441a37fdc73d0efca90aa55'],
    ];
    for (const [scheduler, context, digest] of original) {
      const plan = { scheduler, context, custom: [] };
      expect(solverMethodDigest(configurableSolverModules(plan), 'cooperative')).toBe(digest);
      expect(solverIdentityMethodDigest(configuredResearchModuleIdentity(plan).identity, 'cooperative')).toBe(digest);
    }
    const advised: ['cooperative' | 'independent', number, string][] = [
      ['cooperative', 1, '9708cc4933aaa77bff247f93950f915051067e2a0c108002db7fe5d782a68836'],
      ['cooperative', 4, '9b02976c9362352b2d9279a16f042a46c11b42b8ee5bb8c07eaa177504257bb0'],
      ['independent', 1, 'ddd11acbefda2ac21d26835864fe13941b7446bb9433e6792f1b45f7fceadc94'],
      ['independent', 4, 'ddd11acbefda2ac21d26835864fe13941b7446bb9433e6792f1b45f7fceadc94'],
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
