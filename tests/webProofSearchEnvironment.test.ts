import { describe, expect, it } from 'vitest';
import { configureWebProofSearchEnvironment, webPantographManifest } from '../apps/web/worker';
import { PANTOGRAPH_DIGEST_ENV, PANTOGRAPH_MANIFEST_ENV } from '../src/math/pantographSession';
import { projectMathematicsRuntimeEnvironment } from '../src/math/mathRuntimeEnvironment';

describe('web proof-search deployment environment', () => {
  it('selects the image backend for Mathlib and retains its pin in worker projections', () => {
    const env = { PATH: '/pinned-lean/bin', [PANTOGRAPH_DIGEST_ENV]: 'a'.repeat(64) };
    configureWebProofSearchEnvironment('mathlib', env);
    expect(projectMathematicsRuntimeEnvironment(env)).toMatchObject({
      [PANTOGRAPH_MANIFEST_ENV]: webPantographManifest, [PANTOGRAPH_DIGEST_ENV]: 'a'.repeat(64), PATH: '/pinned-lean/bin',
    });
  });

  it.each(['standard', 'mathlib-4.8', 'openai-math'] as const)('keeps %s unavailable even if the process inherited a backend', environment => {
    const env = { PATH: '/pinned-lean/bin', [PANTOGRAPH_MANIFEST_ENV]: '/inherited/manifest.json', [PANTOGRAPH_DIGEST_ENV]: 'b'.repeat(64) };
    configureWebProofSearchEnvironment(environment, env);
    const projected = projectMathematicsRuntimeEnvironment(env);
    expect(projected).not.toHaveProperty(PANTOGRAPH_MANIFEST_ENV);
    expect(projected).not.toHaveProperty(PANTOGRAPH_DIGEST_ENV);
    expect(projected.PATH).toBe('/pinned-lean/bin');
  });
});
