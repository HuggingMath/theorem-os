import { z } from 'zod';
import { getLeanTaskEnvironment, type LeanTaskEnvironment } from '../math/leanTaskEnvironment';
import { canonicalMathJson, mathDigest } from '../math/mathRuntimeIo';

/** Match the host sandbox receipt to the actual role payload and pinned environment. */
export function assertFormalizationReviewIsolation(receipt: Record<string, unknown> | undefined,
  environment: LeanTaskEnvironment, input: string, instructions: string, schema: string) {
  const config = getLeanTaskEnvironment(environment);
  const expected = { schema: 'theorem-os.formalization-sandbox.v2', backend: 'bwrap',
    workspace: '/workspace', profile: '/profile',
    namespaces: ['user', 'mount', 'pid', 'ipc', 'uts', 'net'], network: 'role-model-relay-only',
    credentials: 'host-only', input: 'read-only', canary: 'passed', toolchain: config.toolchain,
    environmentDigest: config.dependencyDigest, inputSha256: mathDigest(input),
    roleInstructionsSha256: mathDigest(instructions), outputSchemaSha256: mathDigest(schema) };
  const hash = z.string().regex(/^[a-f0-9]{64}$/u);
  if (!receipt || !['sub2api', 'web_provider'].includes(String(receipt.providerId)) ||
      Object.entries(expected).some(([key, value]) => canonicalMathJson(receipt[key] ?? null) !== canonicalMathJson(value)) ||
      ![receipt.executableSha256, receipt.profileDigest].every(value => hash.safeParse(value).success))
    throw new Error('formalization_review_isolation_invalid');
  const packages = z.object({ kind: z.enum(['none', 'sealed']), root: z.literal('/opt/lean-packages').optional(),
    identity: z.string().min(1).optional() }).strict().safeParse(receipt.packages);
  if (!packages.success || config.mathlibRevision &&
      (packages.data.kind !== 'sealed' || packages.data.root !== '/opt/lean-packages' || !packages.data.identity) ||
      !config.mathlibRevision && packages.data.kind !== 'none')
    throw new Error('formalization_review_isolation_invalid');
}
