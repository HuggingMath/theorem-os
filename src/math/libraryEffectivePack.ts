import { z } from 'zod';
import { mathConstructionImports } from './mathConstructionSources';
import { mathDigest } from './mathRuntimeIo';
import { libraryPackDigest, parseLibraryPack, type LibraryPack } from './libraryPacks';
import { canonicalLibraryJson, libraryReleaseEnvironmentSchema, libraryUnicodeCompare, validateLibraryRelease,
  type LibraryDeclarationMetadata, type LibraryReleaseArtifacts } from './libraryRelease';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const selectionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('mapped'), exclusionKeys: z.array(z.string().min(1)).min(1).max(256) }).strict(),
  z.object({ mode: z.literal('unrestricted') }).strict(),
]);
export const libraryTaskPolicySchema = z.object({ schema: z.literal('theorem-os.library-task-policy.v1'),
  taskId: z.string().min(1).max(512), manifestSha256: hash, environment: libraryReleaseEnvironmentSchema,
  runtimeEnvironmentDigest: hash, selection: selectionSchema,
}).strict();
export type LibraryTaskPolicy = z.infer<typeof libraryTaskPolicySchema>;
export const effectiveLibraryBindingSchema = z.object({ schema: z.literal('theorem-os.effective-library-binding.v1'),
  taskId: z.string().min(1).max(512), manifestSha256: hash, sourcePackSha256: hash, policySha256: hash,
  environment: libraryReleaseEnvironmentSchema, runtimeEnvironmentDigest: hash,
  effectivePackDigest: hash, moduleSetSha256: hash, declarationSetSha256: hash,
}).strict();
export type EffectiveLibraryBinding = z.infer<typeof effectiveLibraryBindingSchema>;
export type EffectiveLibraryPack = Readonly<{ pack: LibraryPack | null; binding: EffectiveLibraryBinding;
  modules: readonly Readonly<{ file: string; module: string; sha256: string }>[];
  declarations: readonly LibraryDeclarationMetadata[] }>;
const canonicalDigest = (value: unknown) => mathDigest(canonicalLibraryJson(value));

/**
 * Host-only policy resolution. An explicit unrestricted selection is required to omit a task mapping.
 * Only the filtered pack/catalogue leave this function; full-release metadata stays outside task files.
 * Empty allowed sets return pack=null rather than a fabricated module or an invalid empty code pack.
 */
export function resolveEffectiveLibraryPack(artifacts: LibraryReleaseArtifacts, policyInput: unknown): EffectiveLibraryPack {
  const parsed = libraryTaskPolicySchema.parse(policyInput);
  const selection = parsed.selection.mode === 'mapped' ? { mode: 'mapped' as const,
    exclusionKeys: [...new Set(parsed.selection.exclusionKeys)].sort(libraryUnicodeCompare) } : parsed.selection;
  const policy: LibraryTaskPolicy = { ...parsed, selection };
  const release = validateLibraryRelease(artifacts, policy.manifestSha256);
  if (canonicalLibraryJson(release.environment) !== canonicalLibraryJson(policy.environment))
    throw new Error('library_task_environment_mismatch');
  const direct = selection.mode === 'unrestricted' ? [] : selection.exclusionKeys.flatMap(key => {
    if (!Object.hasOwn(release.exclusions, key)) throw new Error('library_task_policy_unresolved');
    return release.exclusions[key]!;
  });
  const sourceToFile = new Map(release.modules.map(module => [module.source_file, module.file]));
  const excluded = new Set(direct.map(file => sourceToFile.get(file)!));
  const moduleByName = new Map(release.modules.map(module => [module.module, module.file]));
  const imports = new Map(release.pack.modules.map(module => [module.file, mathConstructionImports(module.source)
    .map(name => name.replaceAll('«', '').replaceAll('»', '')).flatMap(name => moduleByName.has(name) ? [moduleByName.get(name)!] : [])]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [file, dependencies] of imports) if (!excluded.has(file) && dependencies.some(dependency => excluded.has(dependency))) {
      excluded.add(file); changed = true;
    }
  }
  const retained = release.pack.modules.filter(module => !excluded.has(module.file));
  const pack = retained.length ? parseLibraryPack({ ...release.pack, modules: retained }) : null;
  const modules = release.modules.filter(module => !excluded.has(module.file)).map(({ file, module, sha256 }) => ({ file, module, sha256 }));
  const declarations = release.declarations.filter(item => !excluded.has(item.installed_file));
  const binding: EffectiveLibraryBinding = { schema: 'theorem-os.effective-library-binding.v1', taskId: policy.taskId,
    manifestSha256: policy.manifestSha256, sourcePackSha256: mathDigest(artifacts['pack.json']), policySha256: canonicalDigest(policy),
    environment: release.environment, runtimeEnvironmentDigest: policy.runtimeEnvironmentDigest,
    effectivePackDigest: pack ? libraryPackDigest(pack) : canonicalDigest(null), moduleSetSha256: canonicalDigest(modules),
    declarationSetSha256: canonicalDigest(declarations.map(item => ({ id: item.id, name: item.name, module: item.installed_module }))) };
  return { pack, binding, modules, declarations };
}
