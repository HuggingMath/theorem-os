import type { SolverModuleIdentity } from '../../src/solver/modules/moduleIdentity';

/** BYOK session construction is part of the worker method, including its M1 version. */
export function webByokModuleIdentity(base: SolverModuleIdentity): SolverModuleIdentity {
  return { id: `${base.id}/web-byok-v1`, versions: { ...base.versions, M1: `${base.versions.M1}/web-byok-v1` } };
}
