import { z } from 'zod';
import { mathDigest } from './mathRuntimeIo';
import { canonicalLibraryJson, libraryReleaseEnvironmentSchema, parseLibraryJson, validateLibraryRelease,
  type LibraryReleaseArtifacts } from './libraryRelease';
import { libraryTaskPolicySchema, resolveEffectiveLibraryPack, type EffectiveLibraryPack } from './libraryEffectivePack';

const hash = z.string().regex(/^[a-f0-9]{64}$/u), commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const descriptor = z.object({ sha256: hash, bytes: z.number().int().nonnegative() }).strict();
export const legacyLibraryArtifactLimits = { 'pack.json': 40 << 20, 'library.json': 8 << 20, 'verification.json': 32 << 20 };
export type LegacyLibraryArtifacts = Readonly<Record<keyof typeof legacyLibraryArtifactLimits, Uint8Array>>;
const schema = z.object({ schema: z.literal('theorem-os.legacy-library-binding.v1'),
  generator: z.literal('theorem-os-legacy-binding-v1'), repository: z.literal('theorem-os-library'), commit,
  environment: libraryReleaseEnvironmentSchema,
  artifacts: z.object({ 'pack.json': descriptor, 'library.json': descriptor, 'verification.json': descriptor }).strict(),
  source_evidence: z.object({ commit, toolchain_sha256: hash, lake_manifest_sha256: hash,
    modules: z.array(z.object({ file: z.string(), sha256: hash }).strict()).min(1).max(256) }).strict(),
  policy_source: z.object({ commit, file: z.literal('exclusions.json'), sha256: hash, contents: z.string() }).strict(),
  normalized: z.object({ 'library.json': z.string(), 'verification.json': z.string(),
    'declaration-metadata.jsonl': z.string(), 'search-index-manifest.json': z.string() }).strict(),
}).strict();
const same = (a: unknown, b: unknown) => canonicalLibraryJson(a) === canonicalLibraryJson(b);
function requireLegacy(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(`library_legacy_${reason}`);
}
const object = (bytes: Uint8Array) => z.record(z.unknown()).parse(parseLibraryJson(bytes));
const exit = z.object({ exit: z.literal(0) }).passthrough();
const summarySchema = z.object({ schema: z.literal('theorem-os.library-verification.v1'), commit,
  replay: z.object({ leanchecker: exit, export: exit,
    nanoda: exit.extend({ checked: z.number().int().positive(), permittedAxioms: z.array(z.string()) }),
    selfTest: z.object({ compiled: z.literal(true), export: exit,
      leanchecker: z.object({ exit: z.number().int().refine(value => value !== 0), rejected: z.literal(true) }).passthrough(),
      nanoda: z.object({ exit: z.number().int().refine(value => value !== 0), rejected: z.literal(true) }).passthrough(),
    }).passthrough(),
  }).passthrough(), sanity: z.record(exit).refine(value => Object.keys(value).length > 0),
}).strict();

/** Host-pinned migration of the historical three-file format. Normalization never invents replay coverage. */
export function validateLegacyLibraryBinding(original: LegacyLibraryArtifacts, bytes: Uint8Array, expectedSha256: string) {
  requireLegacy(bytes instanceof Uint8Array && bytes.byteLength <= (64 << 20), 'binding_size');
  requireLegacy(hash.safeParse(expectedSha256).success && mathDigest(bytes) === expectedSha256, 'binding_digest_mismatch');
  const binding = schema.parse(parseLibraryJson(bytes));
  for (const [name, limit] of Object.entries(legacyLibraryArtifactLimits)) {
    const data = original[name as keyof LegacyLibraryArtifacts];
    requireLegacy(data instanceof Uint8Array && data.byteLength <= limit, 'artifact_size');
    requireLegacy(same(binding.artifacts[name as keyof LegacyLibraryArtifacts],
      { sha256: mathDigest(data), bytes: data.byteLength }), 'artifact_digest_mismatch');
  }
  const artifacts = { 'pack.json': original['pack.json'], ...Object.fromEntries(Object.entries(binding.normalized)
    .map(([name, value]) => [name, Buffer.from(value)])) } as LibraryReleaseArtifacts;
  const normalizedPin = mathDigest(artifacts['search-index-manifest.json']);
  const release = validateLibraryRelease(artifacts, normalizedPin);
  requireLegacy(release.commit === binding.commit && same(release.environment, binding.environment) &&
    binding.source_evidence.commit === binding.commit && binding.policy_source.commit === binding.commit &&
    binding.source_evidence.lake_manifest_sha256 === binding.environment.lake_manifest_sha256 &&
    same(binding.source_evidence.modules, release.modules.map(item => ({ file: item.source_file, sha256: item.source_sha256 }))),
  'source_mismatch');
  const library = object(original['library.json']);
  const normalizedLibrary = object(artifacts['library.json']);
  const { environment: _env, modules: _modules, ...header } = normalizedLibrary;
  requireLegacy(same(library, { ...header, modules: release.modules.map(({ source_file: _file,
    source_sha256: _sha, imports: _imports, ...item }) => item) }), 'catalogue_mismatch');
  const policyBytes = Buffer.from(binding.policy_source.contents);
  const policy = z.object({ schema: z.literal('theorem-os.library-exclusions.v1'),
    exclusions: z.record(z.array(z.string())) }).strict().parse(parseLibraryJson(policyBytes));
  requireLegacy(mathDigest(policyBytes) === binding.policy_source.sha256 && same(policy.exclusions, release.exclusions), 'policy_mismatch');
  const verification = summarySchema.parse(parseLibraryJson(original['verification.json']));
  requireLegacy(!Object.hasOwn(verification.replay, 'coverage'), 'coverage_unsupported');
  requireLegacy(same([...verification.replay.nanoda.permittedAxioms].sort(), ['Classical.choice', 'Quot.sound', 'propext']), 'trust_policy_mismatch');
  requireLegacy(same(object(artifacts['verification.json']), { ...verification, environment: binding.environment }), 'verification_mismatch');
  requireLegacy(release.declarations.every(item => item.proof_status === 'unknown' && item.kernel_kind === null &&
    item.verification_refs.length === 0), 'invented_coverage');
  return { artifacts, normalizedPin, release };
}

export function resolveLegacyEffectiveLibraryPack(original: LegacyLibraryArtifacts, bytes: Uint8Array,
  policyInput: unknown): EffectiveLibraryPack {
  const parsed = libraryTaskPolicySchema.parse(policyInput);
  const normalized = validateLegacyLibraryBinding(original, bytes, parsed.manifestSha256);
  const effective = resolveEffectiveLibraryPack(normalized.artifacts, { ...parsed, manifestSha256: normalized.normalizedPin });
  // Include both the normalized release policy and the host-approved migration identity in the receipt.
  return { ...effective, binding: { ...effective.binding, manifestSha256: parsed.manifestSha256,
    legacyBindingSha256: parsed.manifestSha256,
    policySha256: mathDigest(canonicalLibraryJson({ normalizedPolicySha256: effective.binding.policySha256,
      legacyBindingSha256: parsed.manifestSha256 })) } };
}
