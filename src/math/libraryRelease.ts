import { z } from 'zod';
import { mathConstructionImportSpans } from './mathConstructionSources';
import { mathDigest } from './mathRuntimeIo';
import { parseLibraryPack, type LibraryPack } from './libraryPacks';

const hash = z.string().regex(/^[a-f0-9]{64}$/u), commit = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const sourceFile = z.string().regex(/^TheoremOS(?:\/[A-Z][A-Za-z0-9_]*)+\.lean$/u);
const sourceModule = z.string().regex(/^TheoremOS(?:\.[A-Z][A-Za-z0-9_]*)*$/u);
export const libraryReleaseEnvironmentSchema = z.object({
  toolchain: z.literal('leanprover/lean4:v4.34.1'), mathlib: z.literal('d13f23b723b8a846827a245b89c10fc7d3f11612'),
  lake_manifest_sha256: hash,
}).strict();
export type LibraryReleaseEnvironment = z.infer<typeof libraryReleaseEnvironmentSchema>;
const artifactNames = ['pack.json', 'library.json', 'verification.json', 'declaration-metadata.jsonl'] as const;
export type LibraryReleaseArtifacts = Readonly<Record<typeof artifactNames[number] | 'search-index-manifest.json', Uint8Array>>;
const setSchema = z.object({ count: z.number().int().nonnegative(), sha256: hash }).strict();
const manifestSchema = z.object({
  schema: z.literal('theorem-os.search-index-manifest.v1'), generator: z.literal('theorem-os-library-metadata-v1'),
  repository: z.literal('theorem-os-library'), commit, environment: libraryReleaseEnvironmentSchema,
  artifacts: z.record(z.string(), z.object({ sha256: hash, bytes: z.number().int().nonnegative() }).strict()),
  exclusions_sha256: hash, module_set: setSchema, declaration_set: setSchema,
}).strict();
const catalogueSchema = z.object({ file: z.string(), module: z.string(), sha256: hash, source_file: sourceFile,
  source_sha256: hash, imports: z.array(z.string()), sources: z.string(), declarations: z.array(z.string().min(1)) }).strict();
const librarySchema = z.object({ schema: z.literal('theorem-os.library-release.v1'), repository: z.literal('theorem-os-library'),
  commit, toolchain: z.string(), mathlib: z.string(), environment: libraryReleaseEnvironmentSchema,
  exclusions: z.record(z.string().min(1), z.array(sourceFile)), modules: z.array(catalogueSchema).min(1).max(256),
}).strict();
const kernelKind = z.enum(['def', 'theorem', 'inductive', 'ctor', 'rec']);
const coverageSchema = z.object({ schema: z.literal('theorem-os.library-replay-coverage.v1'),
  environment: libraryReleaseEnvironmentSchema,
  tools: z.object({ lean: hash, leanchecker: hash, lean4export: hash, nanoda: hash }).strict(),
  modules: z.array(z.object({ module: sourceModule, source_sha256: hash }).strict()),
  declarations: z.array(z.object({ name: z.string().min(1), module: sourceModule, kind: kernelKind }).strict()),
  module_set_sha256: hash, declaration_set_sha256: hash,
}).strict();
const exitSchema = z.object({ exit: z.number().int() }).passthrough();
const verificationSchema = z.object({ schema: z.literal('theorem-os.library-verification.v1'), commit,
  environment: libraryReleaseEnvironmentSchema,
  replay: z.object({ coverage: coverageSchema.optional() }).passthrough(),
  sanity: z.record(z.string(), z.unknown()),
}).strict();
const referenceSchema = z.object({ file: z.literal('verification.json'), sha256: hash, pointer: z.literal('/replay/coverage'),
  scope: z.literal('declaration-set'), declaration_set_sha256: hash }).strict();
const declarationSchema = z.object({ schema: z.literal('theorem-os.declaration-metadata.v1'), id: z.string().min(1),
  name: z.string().min(1), kind: z.enum(['def', 'abbrev', 'theorem', 'lemma', 'structure', 'class', 'inductive', 'instance']),
  kernel_kind: kernelKind.nullable(), proof_system: z.literal('lean4'),
  source: z.object({ repository: z.literal('theorem-os-library'), commit, file: sourceFile, module: sourceModule, sha256: hash }).strict(),
  installed_module: z.string(), installed_file: z.string(), proof_status: z.enum(['kernel_verified', 'unknown']),
  verification_refs: z.array(referenceSchema), informal_description: z.null(), tags: z.array(z.never()),
  human_review: z.object({ grade: z.null(), evidence_scope: z.literal('unknown'), evidence_refs: z.array(z.never()) }).strict(),
}).strict();
export type LibraryDeclarationMetadata = z.infer<typeof declarationSchema>;
export type ValidatedLibraryRelease = Readonly<{ manifestSha256: string; commit: string; environment: LibraryReleaseEnvironment;
  pack: LibraryPack; modules: z.infer<typeof catalogueSchema>[]; exclusions: Record<string, string[]>;
  declarations: LibraryDeclarationMetadata[] }>;

function requireBinding(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(`library_release_${reason}`);
}
/** Python's Unicode code-point ordering differs from JavaScript's UTF-16 ordering. */
export function libraryUnicodeCompare(a: string, b: string): number {
  const aa = Array.from(a, c => c.codePointAt(0)!), bb = Array.from(b, c => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) if (aa[i] !== bb[i]) return aa[i]! - bb[i]!;
  return aa.length - bb.length;
}
/** Serialize directly: creating a sorted JS object would reorder integer-shaped keys again. */
export function canonicalLibraryJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalLibraryJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => libraryUnicodeCompare(a, b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalLibraryJson(item)}`).join(',')}}`;
  if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  throw new Error('library_release_invalid_json');
}
const same = (a: unknown, b: unknown) => canonicalLibraryJson(a) === canonicalLibraryJson(b);
const setDigest = (value: unknown) => mathDigest(canonicalLibraryJson(value));
const moduleName = (file: string) => file.slice(0, -5).replaceAll('/', '.');

function parseJson(bytes: Uint8Array): unknown {
  // Bound decoding, reject duplicate keys (including escaped spellings), then use the platform parser.
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  let offset = 0;
  const space = () => { while (/\s/u.test(text[offset] ?? '') && offset < text.length) offset++; };
  const string = (): string => {
    const start = offset++;
    while (offset < text.length) {
      if (text[offset] === '\\') { offset += 2; continue; }
      if (text[offset++] === '"') return JSON.parse(text.slice(start, offset)) as string;
    }
    throw new Error('library_release_invalid_json');
  };
  const value = (depth: number): void => {
    requireBinding(depth < 100, 'json_depth'); space();
    if (text[offset] === '"') { string(); return; }
    if (text[offset] === '{' || text[offset] === '[') {
      const object = text[offset++] === '{', end = object ? '}' : ']', keys = new Set<string>();
      space(); if (text[offset] === end) { offset++; return; }
      while (offset < text.length) {
        if (object) {
          space(); requireBinding(text[offset] === '"', 'invalid_json');
          const key = string(); requireBinding(!keys.has(key), 'duplicate_json_key'); keys.add(key);
          space(); requireBinding(text[offset++] === ':', 'invalid_json');
        }
        value(depth + 1); space();
        if (text[offset] === end) { offset++; return; }
        requireBinding(text[offset++] === ',', 'invalid_json');
      }
      throw new Error('library_release_invalid_json');
    }
    const start = offset;
    while (offset < text.length && !/[\s,\]}]/u.test(text[offset]!)) offset++;
    requireBinding(offset > start, 'invalid_json');
  };
  value(0); space(); requireBinding(offset === text.length, 'invalid_json');
  return JSON.parse(text);
}

/** Host-only consumer. The expected digest must come from trusted release selection, never an Agent query. */
export function validateLibraryRelease(artifacts: LibraryReleaseArtifacts, expectedManifestSha256: string): ValidatedLibraryRelease {
  const limits = { 'pack.json': 40 << 20, 'library.json': 8 << 20, 'verification.json': 32 << 20,
    'declaration-metadata.jsonl': 32 << 20, 'search-index-manifest.json': 64 << 10 };
  for (const [name, limit] of Object.entries(limits)) {
    const bytes = artifacts[name as keyof LibraryReleaseArtifacts];
    requireBinding(bytes instanceof Uint8Array && bytes.byteLength <= limit, 'artifact_size');
  }
  requireBinding(hash.safeParse(expectedManifestSha256).success &&
    mathDigest(artifacts['search-index-manifest.json']) === expectedManifestSha256, 'manifest_digest_mismatch');
  const manifest = manifestSchema.parse(parseJson(artifacts['search-index-manifest.json']));
  requireBinding(same(Object.keys(manifest.artifacts).sort(), [...artifactNames].sort()), 'artifact_set_mismatch');
  for (const name of artifactNames) requireBinding(same(manifest.artifacts[name],
    { sha256: mathDigest(artifacts[name]), bytes: artifacts[name].byteLength }), 'artifact_digest_mismatch');
  const pack = parseLibraryPack(parseJson(artifacts['pack.json']));
  const library = librarySchema.parse(parseJson(artifacts['library.json']));
  const verification = verificationSchema.parse(parseJson(artifacts['verification.json']));
  requireBinding(manifest.commit === library.commit && verification.commit === library.commit, 'identity_mismatch');
  requireBinding(same(manifest.environment, library.environment) && same(verification.environment, library.environment) &&
    library.toolchain === library.environment.toolchain && library.mathlib === library.environment.mathlib, 'environment_mismatch');
  requireBinding(setDigest(library.exclusions) === manifest.exclusions_sha256, 'exclusions_digest_mismatch');
  const files = pack.modules.map(item => item.file), catalogue = library.modules;
  requireBinding(!pack.requires?.length && same(files, [...new Set(files)].sort(libraryUnicodeCompare)) &&
    same(files, catalogue.map(item => item.file)), 'module_set_mismatch');
  const sourceFiles = new Set(catalogue.map(item => item.source_file));
  requireBinding(sourceFiles.size === files.length, 'module_set_mismatch');
  for (const excluded of Object.values(library.exclusions)) requireBinding(new Set(excluded).size === excluded.length &&
    excluded.every(file => sourceFiles.has(file)), 'exclusions_invalid');
  const available = new Set(catalogue.map(item => moduleName(item.source_file)));
  for (let i = 0; i < pack.modules.length; i++) {
    const module = pack.modules[i]!, item = catalogue[i]!;
    requireBinding(module.file === `Submission/Library/${item.source_file}` && item.module === moduleName(module.file) &&
      item.sha256 === mathDigest(module.source) && same(module.origin,
        { kind: 'upstream', repository: library.repository, commit: library.commit, file: item.source_file }), 'module_origin_mismatch');
    let original = module.source;
    const imports = mathConstructionImportSpans(original);
    const originalImports = imports.map(span => {
      const name = span.name;
      if (name.startsWith('Submission.Library.TheoremOS.')) return name.slice('Submission.Library.'.length);
      requireBinding(name === 'Mathlib' || name.startsWith('Mathlib.'), 'import_missing');
      return name;
    });
    requireBinding(originalImports.every(name => name === 'Mathlib' || name.startsWith('Mathlib.') || available.has(name)) &&
      same(item.imports, [...new Set(originalImports)].sort(libraryUnicodeCompare)), 'import_binding_mismatch');
    for (const span of [...imports].reverse()) if (span.name.startsWith('Submission.Library.TheoremOS.'))
      original = original.slice(0, span.start) + span.name.slice('Submission.Library.'.length) + original.slice(span.end);
    requireBinding(item.source_sha256 === mathDigest(original), 'source_digest_mismatch');
  }
  const modules = catalogue.map(({ file, module, sha256 }) => ({ file, module, sha256 }));
  requireBinding(same(manifest.module_set, { count: modules.length, sha256: setDigest(modules) }), 'module_set_mismatch');
  const coverage = verification.replay.coverage;
  if (coverage) {
    requireBinding(same(coverage.environment, library.environment), 'environment_mismatch');
    const replay = verification.replay;
    const control = z.object({ compiled: z.literal(true), export: exitSchema,
      leanchecker: exitSchema.extend({ rejected: z.literal(true) }), nanoda: exitSchema.extend({ rejected: z.literal(true) }),
    }).passthrough().parse(replay.selfTest);
    requireBinding(control.export.exit === 0 && control.leanchecker.exit !== 0 && control.nanoda.exit !== 0, 'negative_control_failed');
    const leanchecker = exitSchema.extend({ modules: z.number().int() }).parse(replay.leanchecker);
    const nanoda = exitSchema.extend({ checked: z.number().int().positive(), permittedAxioms: z.array(z.string()) }).parse(replay.nanoda);
    requireBinding(leanchecker.exit === 0 && exitSchema.parse(replay.export).exit === 0 && nanoda.exit === 0, 'replay_failed');
    requireBinding(same(nanoda.permittedAxioms, ['Classical.choice', 'Quot.sound', 'propext']), 'trust_policy_mismatch');
    requireBinding(setDigest(coverage.modules) === coverage.module_set_sha256 &&
      setDigest(coverage.declarations) === coverage.declaration_set_sha256, 'coverage_digest_mismatch');
    requireBinding(leanchecker.modules === coverage.modules.length && coverage.modules.length === catalogue.length + 1 &&
      coverage.modules[0]?.module === 'TheoremOS' &&
      same(coverage.modules.slice(1), catalogue.map(item => ({ module: moduleName(item.source_file), source_sha256: item.source_sha256 }))
        .sort((a, b) => libraryUnicodeCompare(a.module, b.module))), 'coverage_module_mismatch');
    const moduleSet = new Set(coverage.modules.map(item => item.module));
    requireBinding(new Set(coverage.declarations.map(item => item.name)).size === coverage.declarations.length &&
      coverage.declarations.every(item => moduleSet.has(item.module)) && same(coverage.declarations,
        [...coverage.declarations].sort((a, b) => libraryUnicodeCompare(a.module, b.module) || libraryUnicodeCompare(a.name, b.name))), 'coverage_invalid');
  }
  const metadataBytes = artifacts['declaration-metadata.jsonl'];
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(metadataBytes);
  requireBinding(text === '' || text.endsWith('\n'), 'metadata_invalid');
  const declarations = text ? text.slice(0, -1).split('\n').map(line => declarationSchema.parse(parseJson(Buffer.from(line)))) : [];
  const expectedNames = catalogue.flatMap(item => item.declarations);
  requireBinding(new Set(expectedNames).size === expectedNames.length && declarations.length === expectedNames.length &&
    same(declarations.map(item => item.name).sort(libraryUnicodeCompare), [...expectedNames].sort(libraryUnicodeCompare)), 'declaration_set_mismatch');
  const byFile = new Map(catalogue.map(item => [item.file, item])), covered = new Map(coverage?.declarations.map(item => [item.name, item]));
  const namesByFile = new Map(catalogue.map(item => [item.file, new Set(item.declarations)]));
  // Artifact bytes were hashed once above; do not rehash the entire replay inventory per declaration.
  const verificationSha256 = manifest.artifacts['verification.json']!.sha256;
  for (const declaration of declarations) {
    const item = byFile.get(declaration.installed_file), evidence = covered.get(declaration.name);
    requireBinding(item && namesByFile.get(item.file)!.has(declaration.name) && declaration.id === `lean4:theorem-os-library@${library.commit}:${declaration.name}` &&
      declaration.installed_module === item.module && same(declaration.source, { repository: library.repository, commit: library.commit,
        file: item.source_file, module: moduleName(item.source_file), sha256: item.source_sha256 }), 'declaration_binding_mismatch');
    const expectedKind = ({ lemma: 'theorem', abbrev: 'def', structure: 'inductive', class: 'inductive' } as Record<string, string>)[declaration.kind] ?? declaration.kind;
    if (evidence) requireBinding(evidence.module === declaration.source.module && (declaration.kind === 'instance'
      ? ['def', 'theorem'].includes(evidence.kind) : evidence.kind === expectedKind), 'coverage_declaration_mismatch');
    requireBinding(declaration.proof_status === (evidence ? 'kernel_verified' : 'unknown') &&
      declaration.kernel_kind === (evidence?.kind ?? null) && same(declaration.verification_refs, evidence ? [{ file: 'verification.json',
        sha256: verificationSha256, pointer: '/replay/coverage', scope: 'declaration-set',
        declaration_set_sha256: coverage!.declaration_set_sha256 }] : []), 'proof_evidence_mismatch');
  }
  requireBinding(same(declarations.map(item => item.id), declarations.map(item => item.id).sort(libraryUnicodeCompare)), 'declaration_order');
  const declarationSet = declarations.map(item => ({ id: item.id, name: item.name, module: item.installed_module }));
  requireBinding(same(manifest.declaration_set, { count: declarations.length, sha256: setDigest(declarationSet) }), 'declaration_set_mismatch');
  return { manifestSha256: expectedManifestSha256, commit: library.commit, environment: library.environment,
    pack, modules: catalogue, exclusions: library.exclusions, declarations };
}
