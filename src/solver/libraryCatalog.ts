import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getLeanTaskEnvironment, type LeanTaskEnvironment } from '../math/leanTaskEnvironment';
import { inspectScopedLeanDeclarations } from '../math/leanSource';
import { leanScopeCommands, leanScopeNamespace, maskLeanCommentsAndStrings, qualifiedLeanReferences, updateLeanScopes, type LeanScope } from '../math/leanSyntax';
import { isLibraryPackFile, LIBRARY_PACK_SCHEMA, libraryPackOriginSchema, MAX_LIBRARY_MODULE_BYTES,
  MAX_LIBRARY_PACK_BYTES, MAX_LIBRARY_PACK_MODULES, parseLibraryPack, type LibraryPack, type LibraryPackModule } from '../math/libraryPacks';
import { localModuleFile, mathConstructionImports } from '../math/mathConstructionSources';
import { limitMathOutput } from '../math/mathProcess';
import { canonicalMathJson, mathDigest, readMathText, syncMathDirectory, writeMathFrozen } from '../math/mathRuntimeIo';
import { assertMathCanonicalPath } from '../math/paths';
import { libraryKnowledgeCandidates } from './theoremKnowledgeLibrary';
import type { TheoremKnowledgeEntry } from './theoremKnowledge';
import { createTheoremKnowledgeSearchIndex, knowledgeTypeExpression } from './theoremKnowledgeSearch';

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const file = z.string().refine(isLibraryPackFile);
const entrySchema = z.object({ name: z.string().min(1), kind: z.enum(['lemma', 'definition']),
  type: z.string().min(1), description: z.string() }).strict();
const catalogSchema = z.object({
  schema: z.literal('theorem-os.library-catalog.v1'),
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u),
  revision: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u),
  environment: z.enum(['standard', 'mathlib', 'mathlib-4.8', 'openai-math',
    'openai-math-cartier-reviewed-v1', 'openai-math-character-reviewed-v1']),
  environmentDigest: hash, toolchain: z.string().min(1),
  modules: z.array(z.object({ file, sha256: hash, bytes: z.number().int().min(0).max(MAX_LIBRARY_MODULE_BYTES),
    origin: libraryPackOriginSchema, imports: z.array(file), declarations: z.array(z.string().min(1)),
    entries: z.array(entrySchema) }).strict()).min(1).max(100_000),
}).strict();
export type LibraryCatalogManifest = z.infer<typeof catalogSchema>;
export type LibrarySelection = Readonly<{
  schema: 'theorem-os.library-selection.v1'; id: string; revision: string; catalogDigest: string; environmentDigest: string;
  roots: readonly string[]; modules: readonly { file: string; sha256: string }[];
  omitted: readonly { file: string; reason: 'installation-budget' }[];
}>;

/** Conflict metadata includes explicit type names without changing the solver's theorem/definition interfaces. */
function declarationConflictNames(source: string): string[] {
  const masked = maskLeanCommentsAndStrings(source), scopes: LeanScope[] = [];
  const declarations = inspectScopedLeanDeclarations(source).map(({ startOffset, name }) => ({ startOffset, name }));
  for (const match of masked.matchAll(/^([ \t]*(?:(?:public|private|protected|noncomputable|nonrec|unsafe)\s+|@\[[^\]]*\]\s*)*)(?:structure|inductive|class(?:\s+inductive)?)\s+([\p{L}_][\p{L}\p{M}\p{N}_'?!]*(?:\.[\p{L}_][\p{L}\p{M}\p{N}_'?!]*)*)/gmu))
    declarations.push({ startOffset: match.index + match[1]!.length, name: match[2]! });
  declarations.sort((a, b) => a.startOffset - b.startOffset);
  const names = new Set<string>(), visibility = [!/^\s*(?:prelude\s+)?module\b/u.test(masked)];
  const commands = leanScopeCommands(masked);
  let command = commands.next(), precedingStart = 0;
  for (const declaration of declarations) {
    while (!command.done && command.value.index < declaration.startOffset) {
      const current = command.value, kind = current[1]!;
      updateLeanScopes(scopes, kind, current[2]?.trim());
      if (kind === 'end') { if (visibility.length > 1) visibility.pop(); }
      else if (['namespace', 'section', 'mutual'].includes(kind)) {
        const modifier = /\b(public|private)\b/u.exec(current[0].slice(0, current[0].indexOf(kind)))?.[1];
        visibility.push(modifier ? modifier === 'public' : visibility.at(-1)!);
      }
      command = commands.next();
    }
    const prefix = masked.slice(precedingStart, declaration.startOffset);
    const modifier = /\b(public|private)(?:\s+(?:noncomputable|nonrec|partial|protected|meta|unsafe)|\s*@\[[^\]]*\])*\s*$/u.exec(prefix)?.[1];
    if (modifier ? modifier === 'public' : visibility.at(-1)) {
      const namespace = leanScopeNamespace(scopes);
      names.add(declaration.name.startsWith('_root_.') ? declaration.name.slice(7) :
        [namespace, declaration.name].filter(Boolean).join('.'));
    }
    precedingStart = declaration.startOffset;
  }
  return [...names];
}

function validateManifest(value: unknown): LibraryCatalogManifest {
  const manifest = catalogSchema.parse(value), environment = getLeanTaskEnvironment(manifest.environment);
  if (manifest.environmentDigest !== environment.dependencyDigest || manifest.toolchain !== environment.toolchain)
    throw new Error('math_library_catalog_environment_changed');
  const modules = new Map(manifest.modules.map(module => [module.file, module]));
  if (modules.size !== manifest.modules.length) throw new Error('math_library_catalog_duplicate_module');
  const declarationFiles = new Map<string, string>();
  for (const module of manifest.modules) for (const name of module.declarations) {
    const previous = declarationFiles.get(name);
    if (previous && previous !== module.file)
      throw new Error(`math_library_catalog_duplicate_declaration: ${name}: ${previous}, ${module.file}`);
    declarationFiles.set(name, module.file);
  }
  // A release can contain far more modules than one task installs. Check its graph without recursive traversal.
  const remaining = new Map<string, number>(), dependents = new Map<string, string[]>();
  for (const module of manifest.modules) {
    const imports = new Set(module.imports);
    if (imports.size !== module.imports.length || [...imports].some(file => !modules.has(file)))
      throw new Error(`math_library_catalog_dependency_missing: ${module.file}`);
    remaining.set(module.file, imports.size);
    for (const dependency of imports) dependents.set(dependency, [...(dependents.get(dependency) ?? []), module.file]);
  }
  const ready = [...remaining].filter(([, count]) => !count).map(([file]) => file);
  for (let cursor = 0; cursor < ready.length; cursor++) for (const dependent of dependents.get(ready[cursor]!) ?? []) {
    const count = remaining.get(dependent)! - 1;
    remaining.set(dependent, count);
    if (!count) ready.push(dependent);
  }
  if (ready.length !== modules.size) throw new Error('math_library_catalog_import_cycle');
  return manifest;
}

/** Build metadata once for a named, immutable release. Proof bodies live only in content-addressed source objects. */
export function writeLibraryCatalog(directory: string, input: {
  id: string; revision: string; environment: LeanTaskEnvironment; packs: readonly LibraryPack[];
}) {
  const environment = getLeanTaskEnvironment(input.environment), modules = new Map<string, LibraryPackModule>();
  for (const pack of input.packs) {
    const checked = parseLibraryPack(pack);
    if (checked.requires?.length) throw new Error('math_library_catalog_external_requirement');
    for (const module of checked.modules) {
      const previous = modules.get(module.file);
      if (previous && canonicalMathJson(previous) !== canonicalMathJson(module))
        throw new Error(`math_library_catalog_module_conflict: ${module.file}`);
      modules.set(module.file, module);
    }
  }
  const manifest = validateManifest({ schema: 'theorem-os.library-catalog.v1', id: input.id, revision: input.revision,
    environment: input.environment, environmentDigest: environment.dependencyDigest, toolchain: environment.toolchain,
    modules: [...modules.values()].sort((a, b) => a.file.localeCompare(b.file)).map(module => {
      const { candidates } = libraryKnowledgeCandidates({ [module.file]: module.source }, {
        kind: 'frozen-library-pack', problemId: input.id, source: 'library-catalog',
        sourceDigest: mathDigest(module.source), sourceCommit: input.revision, environmentDigest: environment.dependencyDigest,
        receiptIds: [],
      }, { publicOnly: true });
      return { file: module.file, sha256: mathDigest(module.source), bytes: Buffer.byteLength(module.source), origin: module.origin,
        imports: mathConstructionImports(module.source).map(localModuleFile).filter(file => modules.has(file)),
        declarations: declarationConflictNames(module.source),
        entries: candidates.map(({ name, kind, type, description }) => ({ name, kind, type, description })) };
    }) });
  const root = path.resolve(directory), objects = path.join(root, 'objects');
  assertMathCanonicalPath(root);
  if (fs.existsSync(root)) throw new Error('math_library_catalog_destination_exists');
  fs.mkdirSync(objects, { recursive: true, mode: 0o700 });
  const written = new Set<string>();
  for (const module of manifest.modules) if (!written.has(module.sha256)) {
    writeMathFrozen(path.join(objects, module.sha256 + '.lean'), modules.get(module.file)!.source);
    written.add(module.sha256);
  }
  syncMathDirectory(objects);
  const text = canonicalMathJson(manifest) + '\n', file = path.join(root, 'catalog.json');
  writeMathFrozen(file, text); syncMathDirectory(root);
  return { file, digest: mathDigest(text), id: manifest.id, revision: manifest.revision,
    modules: manifest.modules.length, declarations: manifest.modules.reduce((count, module) => count + module.entries.length, 0) };
}

/** Open metadata only. Selecting a task reads just its chosen modules and their import closure, with exact hashes. */
export function readLibraryCatalog(file: string, expectedDigest?: string) {
  const absolute = path.resolve(file); assertMathCanonicalPath(absolute);
  const text = readMathText(absolute, 128 * 1024 * 1024), digest = mathDigest(text);
  if (expectedDigest !== undefined && expectedDigest !== digest) throw new Error('math_library_catalog_changed');
  const manifest = validateManifest(JSON.parse(text));
  const modules = new Map(manifest.modules.map(module => [module.file, module]));
  const contexts = { [digest]: Object.fromEntries(manifest.modules.map(module => [module.file, module.sha256])) };
  const entries: TheoremKnowledgeEntry[] = manifest.modules.flatMap(module => module.entries.map(entry => ({ ...entry,
    id: mathDigest(canonicalMathJson([digest, module.file, entry])), contextDigest: digest, file: module.file,
    typeKind: 'source-header' as const, declaration: entry.type, environmentDigest: manifest.environmentDigest, premises: [],
    dependencies: { statement: [], proof: [], tasks: [], coverage: 'unavailable' as const },
    provenance: [{ kind: 'frozen-library-pack' as const, problemId: manifest.id, source: absolute,
      sourceDigest: digest, sourceCommit: manifest.revision, environmentDigest: manifest.environmentDigest, receiptIds: [] }],
  })));
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const search = createTheoremKnowledgeSearchIndex({ entries, evidence: 'recorded-not-replayed', contexts });
  const dependents = new Map<string, string[]>();
  const declarations = new Map<string, string[]>();
  for (const module of manifest.modules) {
    for (const dependency of module.imports) dependents.set(dependency, [...(dependents.get(dependency) ?? []), module.file]);
    for (const name of module.declarations) declarations.set(name, [...(declarations.get(name) ?? []), module.file]);
  }
  // Exact qualified names also locate modules containing only structures, classes or inductive types.
  // Keep these name-only references separate from indexed theorem/definition interfaces.
  const namedReferences = (text: string) => {
    return qualifiedLeanReferences(text).filter(name => declarations.has(name)).map(name => {
      const file = declarations.get(name)![0]!;
      return { name, file, import: `import ${file.slice(0, -5).replaceAll('/', '.')}`, sourceDigest: modules.get(file)!.sha256 };
    });
  };
  const identity = { id: manifest.id, revision: manifest.revision, catalogDigest: digest, environmentDigest: manifest.environmentDigest };
  const readModule = (file: string): LibraryPackModule => {
    const module = modules.get(file);
    if (!module) throw new Error(`math_library_catalog_module_missing: ${file}`);
    const object = path.join(path.dirname(absolute), 'objects', module.sha256 + '.lean');
    assertMathCanonicalPath(object);
    const source = readMathText(object, MAX_LIBRARY_MODULE_BYTES);
    if (Buffer.byteLength(source) !== module.bytes || mathDigest(source) !== module.sha256)
      throw new Error(`math_library_catalog_source_changed: ${file}`);
    return { file, source, origin: structuredClone(module.origin) };
  };
  const select = (input: { source: string; task: string; environmentDigest: string; rootLimit?: number }): LibrarySelection => {
    if (input.environmentDigest !== manifest.environmentDigest) throw new Error('math_library_catalog_environment_changed');
    const rootLimit = input.rootLimit ?? 4;
    if (!Number.isInteger(rootLimit) || rootLimit < 1 || rootLimit > 32) throw new Error('math_library_catalog_root_limit');
    const owned = inspectScopedLeanDeclarations(input.source), unavailable = new Set<string>();
    const pending = declarationConflictNames(input.source).flatMap(name => declarations.get(name) ?? []);
    for (let cursor = 0; cursor < pending.length; cursor++) {
      const file = pending[cursor]!;
      if (unavailable.has(file)) continue;
      unavailable.add(file); pending.push(...(dependents.get(file) ?? []));
    }
    const selected = new Set<string>(), roots = new Set<string>(), omitted: LibrarySelection['omitted'][number][] = [];
    let bytes = 0;
    const include = (file: string, required = false) => {
      if (unavailable.has(file)) {
        if (required) throw new Error(`math_library_catalog_declaration_conflict: ${file}`);
        return false;
      }
      const closure = new Set<string>(), queue = [file];
      for (let cursor = 0; cursor < queue.length; cursor++) {
        const next = queue[cursor]!;
        if (selected.has(next) || closure.has(next)) continue;
        closure.add(next); queue.push(...modules.get(next)!.imports);
      }
      const added = [...closure].reduce((sum, file) => sum + modules.get(file)!.bytes, 0);
      if (selected.size + closure.size > MAX_LIBRARY_PACK_MODULES || bytes + added > MAX_LIBRARY_PACK_BYTES) {
        if (required) throw new Error(`math_library_catalog_installation_budget: ${file}`);
        if (omitted.length < 32) omitted.push({ file, reason: 'installation-budget' });
        return false;
      }
      for (const next of closure) selected.add(next);
      bytes += added; roots.add(file); return true;
    };
    for (const name of mathConstructionImports(input.source)) if (name.startsWith('Submission.Library.')) {
      const file = localModuleFile(name);
      if (!modules.has(file)) throw new Error(`math_library_catalog_module_missing: ${file}`);
      include(file, true);
    }
    let automatic = 0;
    const attempted = new Set<string>();
    const includeAutomatic = (file: string) => {
      if (attempted.has(file) || selected.has(file) || unavailable.has(file)) return;
      attempted.add(file);
      if (include(file)) automatic++;
    };
    // A named request takes priority over broad goal matches, within the same automatic installation budget.
    for (const { file } of namedReferences(input.task)) {
      if (automatic === rootLimit) break;
      includeAutomatic(file);
    }
    const requests = owned.filter(declaration => declaration.kind === 'theorem').slice(0, 7).map(declaration => ({ query: '',
      goal: limitMathOutput(knowledgeTypeExpression({ type: declaration.declarationType, typeKind: 'source-header' }), 16_000, 'head') }));
    if (input.task.trim()) requests.push({ query: limitMathOutput(input.task, 4000, 'head'), goal: '' });
    const availableSearch = unavailable.size ? createTheoremKnowledgeSearchIndex({
      entries: entries.filter(entry => !unavailable.has(entry.file)), evidence: 'recorded-not-replayed', contexts,
    }) : search;
    const results = requests.length && automatic < rootLimit ? availableSearch.search(requests, { limit: 32, resultGrouping: 'module',
      environmentDigest: manifest.environmentDigest }) : [];
    // Every original target gets its best module before additional alternatives compete for the remaining slots.
    for (let rank = 0; rank < 32 && automatic < rootLimit; rank++) for (const result of results) {
      const hit = result.hits[rank], file = hit && byId.get(hit.id)!.file;
      if (file) includeAutomatic(file);
      if (automatic === rootLimit) break;
    }
    return { schema: 'theorem-os.library-selection.v1', ...identity, roots: [...roots].sort(), omitted,
      modules: [...selected].sort().map(file => ({ file, sha256: modules.get(file)!.sha256 })) };
  };
  const materialize = (selection: LibrarySelection): LibraryPack | undefined => {
    if (selection.schema !== 'theorem-os.library-selection.v1' || selection.id !== identity.id || selection.revision !== identity.revision ||
        selection.catalogDigest !== identity.catalogDigest || selection.environmentDigest !== identity.environmentDigest)
      throw new Error('math_library_catalog_selection_changed');
    if (selection.modules.some(module => modules.get(module.file)?.sha256 !== module.sha256))
      throw new Error('math_library_catalog_selection_changed');
    if (selection.modules.length > MAX_LIBRARY_PACK_MODULES ||
        selection.modules.reduce((sum, module) => sum + modules.get(module.file)!.bytes, 0) > MAX_LIBRARY_PACK_BYTES)
      throw new Error('math_library_catalog_installation_budget');
    if (!selection.modules.length) return undefined;
    return parseLibraryPack({ schema: LIBRARY_PACK_SCHEMA, modules: selection.modules.map(module => readModule(module.file)) });
  };
  return { identity: Object.freeze(identity), environment: manifest.environment, toolchain: manifest.toolchain,
    moduleCount: manifest.modules.length, declarationCount: entries.length,
    moduleFiles: Object.freeze(manifest.modules.map(module => module.file)), readModule, select, materialize,
    search: (requests: Parameters<typeof search.search>[0], options: Parameters<typeof search.search>[1] = {}) =>
      search.search(requests, { ...options, environmentDigest: manifest.environmentDigest }).map((result, index) => ({ ...result,
        schema: 'theorem-os.library-search.v1' as const, library: identity,
        namedReferences: namedReferences(`${requests[index]!.query}\n${requests[index]!.goal ?? ''}`).slice(0, options.limit ?? 10),
        hits: result.hits.map(({ consumers: _consumers, ...hit }) => {
          const entry = byId.get(hit.id)!;
          return { ...hit, file: entry.file, import: `import ${entry.file.slice(0, -5).replaceAll('/', '.')}`,
            sourceDigest: modules.get(entry.file)!.sha256 };
        }) })) };
}
