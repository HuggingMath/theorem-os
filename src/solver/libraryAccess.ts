import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { LIBRARY_PACK_SCHEMA, libraryDeclarationConflict, parseLibraryPack } from '../math/libraryPacks';
import { canonicalMathJson, mathDigest, readMathText, writeMathJsonDurable } from '../math/mathRuntimeIo';
import { assertMathCanonicalPath } from '../math/paths';
import { readLibraryCatalog } from './libraryCatalog';
import { committedSource, git, type SolverProblem } from './problem';
import { largestFittingPage, splitsSurrogate } from './textPage';

export const LIBRARY_ACCESS_FILE = 'LIBRARY.json';
export const LIBRARY_REQUEST_FILE = 'LIBRARY_REQUEST.json';
export type LibraryAccess = { file: string; digest: string };
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const names = z.array(z.string().trim().min(1).max(512)).min(1).max(8);
export const libraryRequestSchema = z.object({ schema: z.literal('theorem-os.library-request.v1'),
  catalogDigest: hash, problemReceiptDigest: hash, seedCommit: z.string().regex(/^[a-f0-9]{40,64}$/u),
  names, reason: z.string().trim().min(1).max(2000) }).strict();
export type LibraryRequest = z.infer<typeof libraryRequestSchema>;
const contextSchema = z.object({ schema: z.literal('theorem-os.library-access.v1'),
  catalog: z.object({ file: z.string(), digest: hash }).strict(), problemReceiptDigest: hash,
  seedCommit: z.string(), frozenFiles: z.record(hash), requestInstallation: z.literal(false).optional() }).strict();

/** Full release search and installation have no task-policy projection yet. */
export function assertLibraryCatalogAccess(problem: SolverProblem): void {
  if (problem.libraryBinding?.hostConfiguration) throw new Error('library_knowledge_catalog_unauthorized');
}

/** Published by the host before a turn; shell requests are advisory until the host validates them. */
export function writeLibraryAccess(problem: SolverProblem, worktree: string, catalog: LibraryAccess, requestInstallation = true) {
  assertLibraryCatalogAccess(problem);
  writeMathJsonDurable(path.join(worktree, LIBRARY_ACCESS_FILE), { schema: 'theorem-os.library-access.v1', catalog,
    problemReceiptDigest: problem.receiptDigest, seedCommit: git(worktree, ['rev-parse', 'HEAD']),
    frozenFiles: problem.frozenFiles ?? {}, ...(requestInstallation ? {} : { requestInstallation: false }) }, 0o400);
}

export function agentLibrary(worktreeInput: string) {
  const worktree = path.resolve(worktreeInput); assertMathCanonicalPath(worktree);
  const context = contextSchema.parse(JSON.parse(readMathText(path.join(worktree, LIBRARY_ACCESS_FILE), 128 * 1024)));
  const catalog = readLibraryCatalog(context.catalog.file, context.catalog.digest);
  const installed = (file: string, digest: string) => context.frozenFiles[file] === digest ? 'installed-frozen' : 'not-installed';
  return {
    search(query: string, goal?: string, limit = 10) {
      if (!query.trim() && !goal?.trim()) throw new Error('library_search_requires_query_or_goal');
      if (!Number.isInteger(limit) || limit < 1 || limit > 32) throw new Error('library_search_limit');
      const result = catalog.search([{ query, goal }], { limit })[0]!;
      return { ...result, hits: result.hits.map(hit => ({ ...hit, installation: installed(hit.file, hit.sourceDigest) })),
        namedReferences: result.namedReferences.map(hit => ({ ...hit, installation: installed(hit.file, hit.sourceDigest) })) };
    },
    get(name: string, offset = 0, maxBytes = 16_000) {
      const declaration = catalog.declaration(name), module = catalog.readModule(declaration.file), source = module.source;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > source.length || splitsSurrogate(source, offset))
        throw new Error('library_source_offset');
      if (!Number.isInteger(maxBytes) || maxBytes < 1024 || maxBytes > 32_000) throw new Error('library_source_budget');
      return largestFittingPage(source, offset, source.length, maxBytes, end => ({ schema: 'theorem-os.library-source.v1' as const,
        library: catalog.identity, declaration,
        installation: installed(declaration.file, declaration.sourceDigest), source: { text: source.slice(offset, end),
          offset, nextOffset: end < source.length ? end : null, complete: end === source.length,
          note: 'Source headers may use section variables. Read every page for the full module context; applicability requires a fresh Lean check.' } }),
      'library_source_budget');
    },
    request(requestedNames: string[], reason: string) {
      if (context.requestInstallation === false) throw new Error('math_library_request_lead_required: send Lead the declaration name and intended application');
      const request = libraryRequestSchema.parse({ schema: 'theorem-os.library-request.v1',
        catalogDigest: context.catalog.digest, problemReceiptDigest: context.problemReceiptDigest,
        seedCommit: context.seedCommit, names: [...new Set(requestedNames.map(name => name.replace(/^_root_\./u, '')))], reason });
      const declarations = request.names.map(name => {
        const declaration = catalog.declaration(name);
        return { name: declaration.name, file: declaration.file, import: declaration.import,
          sourceDigest: declaration.sourceDigest, installation: installed(declaration.file, declaration.sourceDigest) };
      });
      const result = { schema: 'theorem-os.library-request-result.v1' as const, library: catalog.identity, declarations };
      if (declarations.every(item => item.installation === 'installed-frozen'))
        return { ...result, status: 'already-installed' as const };
      writeMathJsonDurable(path.join(worktree, LIBRARY_REQUEST_FILE), request);
      return { ...result, status: 'queued' as const, requestDigest: mathDigest(canonicalMathJson(request)),
        nextStep: 'Save current proof work and RESEARCH.md, then return. The host validates the dependency closure and starts a new frozen continuation. Queued is not installation or proof acceptance.' };
    },
  };
}

export class LibraryInstallationRequested extends Error {
  constructor(readonly request: LibraryRequest, readonly worktree: string) { super('math_library_installation_requested'); }
}

/** Resolve only explicit requests and retain the previous pack. Every new bootstrap still rechecks it in Lean. */
export function requestedLibraryPack(problem: SolverProblem, requestInput: unknown, access: LibraryAccess, worktree: string) {
  assertLibraryCatalogAccess(problem);
  const request = libraryRequestSchema.parse(requestInput), catalog = readLibraryCatalog(access.file, access.digest);
  if (request.catalogDigest !== access.digest || request.problemReceiptDigest !== problem.receiptDigest)
    throw new Error('math_library_request_identity_changed');
  git(worktree, ['merge-base', '--is-ancestor', problem.baseCommit, request.seedCommit]);
  git(worktree, ['merge-base', '--is-ancestor', request.seedCommit, 'HEAD']);
  const requested = request.names.map(name => catalog.declaration(name));
  const catalogFiles = new Set(catalog.moduleFiles), requiredFiles: string[] = [], retainedSources: Record<string, string> = {};
  for (const [file, digest] of Object.entries(problem.frozenFiles ?? {})) {
    if (catalogFiles.has(file)) {
      if (mathDigest(catalog.readModule(file).source) !== digest) throw new Error('math_library_request_existing_module_changed');
      requiredFiles.push(file);
    } else {
      // Shared releases are not objects in the built-in catalog. Only the frozen seed, never a worker's
      // current files, supplies their bytes to the next problem and its independent library checks.
      const source = committedSource(worktree, problem.baseCommit, path.posix.join(problem.projectRelative, file));
      if (mathDigest(source) !== digest) throw new Error('math_library_request_existing_module_changed');
      retainedSources[file] = source;
    }
  }
  if (requested.every(item => problem.frozenFiles?.[item.file] === item.sourceDigest))
    throw new Error('math_library_request_already_installed');
  // Keep module/prelude visibility and original imports intact when checking declaration conflicts.
  const selection = catalog.select({ source: problem.contract.formalStatement, task: '',
    environmentDigest: catalog.identity.environmentDigest, automatic: false,
    retainedSources, requiredFiles: [...requiredFiles, ...requested.map(item => item.file)] });
  const selected = catalog.materialize(selection)!;
  const pack = parseLibraryPack({ schema: LIBRARY_PACK_SCHEMA, modules: [...selected.modules,
    ...Object.entries(retainedSources).map(([file, source]) => ({ file, source,
      origin: { kind: 'upstream', repository: problem.workspace, commit: problem.baseCommit,
        file: path.posix.join(problem.projectRelative, file) } }))] });
  const conflict = libraryDeclarationConflict(Object.fromEntries(pack.modules.map(module => [module.file, module.source])),
    { 'Submission.lean': problem.contract.formalStatement });
  if (conflict) throw new Error(`math_library_catalog_declaration_conflict: ${conflict.libraryFile}`);
  return { request, selection, pack };
}

export function takeLibraryRequest(problem: SolverProblem, worktree: string, access: LibraryAccess) {
  const file = path.join(worktree, LIBRARY_REQUEST_FILE);
  if (!fs.existsSync(file)) return;
  assertMathCanonicalPath(file);
  const value = JSON.parse(readMathText(file, 16_000));
  const result = requestedLibraryPack(problem, value, access, worktree);
  return new LibraryInstallationRequested(result.request, worktree);
}
