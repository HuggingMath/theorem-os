import { describe, expect, it } from 'vitest';
import { assertFormalizationReviewIsolation } from '../src/solver/formalizationReviewIsolation';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { mathDigest } from '../src/math/mathRuntimeIo';

const input = '{"fixture":"role input"}', instructions = 'Review the original faithfully.', schema = '{"type":"object"}';
function receipt(providerId: string) {
  const environment = getLeanTaskEnvironment('standard');
  return { schema: 'theorem-os.formalization-sandbox.v2', backend: 'bwrap', workspace: '/workspace', profile: '/profile', providerId,
    namespaces: ['user', 'mount', 'pid', 'ipc', 'uts', 'net'], network: 'role-model-relay-only', credentials: 'host-only',
    input: 'read-only', canary: 'passed', toolchain: environment.toolchain, environmentDigest: environment.dependencyDigest,
    inputSha256: mathDigest(input), roleInstructionsSha256: mathDigest(instructions), outputSchemaSha256: mathDigest(schema),
    executableSha256: 'a'.repeat(64), profileDigest: 'b'.repeat(64), packages: { kind: 'none' } };
}
const check = (value: Record<string, unknown>) => assertFormalizationReviewIsolation(value, 'standard', input, instructions, schema);
describe('review receipt compatibility across the fixed gateway and HTTPS providers', () => {
  it.each(['sub2api', 'web_provider'])('accepts a valid %s receipt with the original v2 evidence schema', providerId => {
    expect(() => check(receipt(providerId))).not.toThrow();
  });
  it.each(['sub2api', 'web_provider'])('keeps content, environment and isolation binding for %s receipts', providerId => {
    for (const override of [{ inputSha256: 'c'.repeat(64) }, { roleInstructionsSha256: 'c'.repeat(64) },
      { outputSchemaSha256: 'c'.repeat(64) }, { environmentDigest: 'c'.repeat(64) }, { credentials: 'in-role' },
      { network: 'unrestricted' }, { namespaces: ['user', 'mount'] }, { packages: { kind: 'sealed' } }])
      expect(() => check({ ...receipt(providerId), ...override })).toThrow('formalization_review_isolation_invalid');
  });
  it.each(['openai', 'other', '', undefined])('rejects unrecognized provider identities: %s', providerId => {
    expect(() => check({ ...receipt('sub2api'), providerId })).toThrow('formalization_review_isolation_invalid');
  });
  it('permits source packages only for an explicitly source-reading Mathlib audit', () => {
    const config = getLeanTaskEnvironment('mathlib');
    const full = { ...receipt('web_provider'), toolchain: config.toolchain, environmentDigest: config.dependencyDigest,
      packages: { kind: 'sealed', root: '/opt/lean-packages', identity: 'c'.repeat(64) } };
    const source = { ...full, packages: { ...full.packages, contents: 'sources' } };
    for (const value of [full, source])
      expect(() => assertFormalizationReviewIsolation(value, 'mathlib', input, instructions, schema, 'sources')).not.toThrow();
    expect(() => assertFormalizationReviewIsolation(full, 'mathlib', input, instructions, schema)).not.toThrow();
    expect(() => assertFormalizationReviewIsolation(source, 'mathlib', input, instructions, schema))
      .toThrow('formalization_review_isolation_invalid');
    expect(() => check({ ...receipt('web_provider'), packages: { kind: 'none', contents: 'sources' } }))
      .toThrow('formalization_review_isolation_invalid');
  });
});
