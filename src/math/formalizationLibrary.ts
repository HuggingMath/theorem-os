import path from 'node:path';
import { z } from 'zod';
import { getLeanTaskEnvironment, type LeanTaskEnvironment } from './leanTaskEnvironment';
import { isLibraryPackFile, parseLibraryPack, type LibraryPack } from './libraryPacks';
import { localModuleFile, mathConstructionImports } from './mathConstructionSources';
import { canonicalMathJson, mathDigest } from './mathRuntimeIo';
import { readLibraryCatalog } from '../solver/libraryCatalog';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
/** Keep the release identity separate from the unchanged Lean/Mathlib environment identity. */
export const formalizationLibrarySchema = z.object({
  file: z.string().min(1).max(4096).refine(path.isAbsolute), digest: hash,
  id: z.string().min(1).max(512), revision: z.string().min(1).max(128), environmentDigest: hash,
  modules: z.array(z.object({ file: z.string().refine(isLibraryPackFile), digest: hash }).strict()).min(1).max(100_000),
}).strict();
export type FormalizationLibrary = z.infer<typeof formalizationLibrarySchema>;
const importedSource = (source: string | readonly string[]) => typeof source === 'string' ? source :
  source.flatMap(text => mathConstructionImports(text).map(name => 'import ' + name)).join('\n');

/** Freeze every available module's source identity, without copying proof bodies into each role input. */
export function prepareFormalizationLibrary(access: { file: string; digest: string }, environment: LeanTaskEnvironment): FormalizationLibrary {
  const file = path.resolve(access.file), catalog = readLibraryCatalog(file, access.digest);
  if (catalog.environment !== environment || catalog.identity.environmentDigest !== getLeanTaskEnvironment(environment).dependencyDigest)
    throw new Error('formalization_library_environment_changed');
  return formalizationLibrarySchema.parse({ file, digest: access.digest, id: catalog.identity.id,
    revision: catalog.identity.revision, environmentDigest: catalog.identity.environmentDigest,
    modules: catalog.moduleFiles.map(file => ({ file, digest: mathDigest(catalog.readModule(file).source) })) });
}

/** Validate the task's imported source closure using only its frozen evidence, including after a release changes. */
export function assertFormalizationLibraryPack(library: FormalizationLibrary | undefined, source: string | readonly string[], value: unknown): LibraryPack | undefined {
  const imports = mathConstructionImports(importedSource(source)).filter(name => name.replaceAll('«', '').replaceAll('»', '').startsWith('Submission.Library.'))
    .map(localModuleFile);
  if (value === undefined) {
    if (library && imports.length) throw new Error('formalization_library_pack_missing');
    return;
  }
  if (!library) throw new Error('formalization_library_not_configured');
  const pack = parseLibraryPack(value), expected = new Map(library.modules.map(module => [module.file, module.digest]));
  if (pack.requires?.length || pack.modules.some(module => expected.get(module.file) !== mathDigest(module.source)) ||
      imports.some(file => !pack.modules.some(module => module.file === file)))
    throw new Error('formalization_library_source_changed');
  return pack;
}

/** Only explicit imports enter compilation; the whole release remains available for discovery. */
export function selectFormalizationLibraryPack(library: FormalizationLibrary, source: string | readonly string[]): LibraryPack | undefined {
  const importsSource = importedSource(source);
  const current = prepareFormalizationLibrary({ file: library.file, digest: library.digest }, 'mathlib');
  if (canonicalMathJson(current) !== canonicalMathJson(library)) throw new Error('formalization_library_changed');
  const catalog = readLibraryCatalog(library.file, library.digest);
  const pack = catalog.materialize(catalog.select({ source: importsSource, task: '', automatic: false, environmentDigest: library.environmentDigest }));
  return assertFormalizationLibraryPack(library, importsSource, pack);
}
