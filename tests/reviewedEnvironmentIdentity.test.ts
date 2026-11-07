import { describe, expect, it } from 'vitest';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';

describe('previously reviewed dependency environments', () => {
  it.each([
    ['openai-math-cartier-reviewed-v1', 'a8cdd8e06146d3a9695fd194f25aa8aeafc72d6ac7b6f819eb2769185b267cc7', 12],
    ['openai-math-character-reviewed-v1', '776e5201fa24ba3dba47f84d50336a9c3426372bd58f711b923b94219c4b632d', 57],
  ] as const)('preserves the frozen identity of %s', (id, digest, supportFiles) => {
    const environment = getLeanTaskEnvironment(id);
    expect(environment.dependencyDigest).toBe(digest);
    expect(environment.toolchain).toBe('leanprover/lean4:v4.34.1');
    expect(environment.mathlibRevision).toBe('d13f23b723b8a846827a245b89c10fc7d3f11612');
    expect(Object.keys(environment.files).filter(file => file.startsWith('OAI/'))).toHaveLength(supportFiles);
    expect(Object.keys(environment.files).some(file => /\/(?:ProducedSolution|Solution|Submission|Challenge)\.lean$/u.test(file))).toBe(false);
  });
});
