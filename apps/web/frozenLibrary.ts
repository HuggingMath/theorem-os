import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLeanTaskEnvironment, type LeanTaskEnvironment } from '../../src/math/leanTaskEnvironment';
import { LIBRARY_PACK_SCHEMA, libraryPackDigest, parseLibraryPack, type LibraryPack } from '../../src/math/libraryPacks';
import { readLibraryCatalog } from '../../src/solver/libraryCatalog';
import type { LibraryAccess } from '../../src/solver/libraryAccess';

const bundledCatalog = fileURLToPath(new URL('../../resources/theorem-os-library/release/catalog.json', import.meta.url));
let current: { key: string; catalog: ReturnType<typeof readLibraryCatalog> } | undefined;

/** A private image may supply another named release, pinned by its exact manifest SHA-256. */
export function webLibraryCatalog(env: NodeJS.ProcessEnv = process.env) {
  const file = env.THEOREMOS_LIBRARY_CATALOG, digest = env.THEOREMOS_LIBRARY_CATALOG_SHA256;
  if (Boolean(file) !== Boolean(digest)) throw new Error('web_library_catalog_pin_missing');
  const resolved = file ? path.resolve(file) : bundledCatalog, key = JSON.stringify([resolved, digest ?? null]);
  if (current?.key === key) return current.catalog;
  const catalog = readLibraryCatalog(resolved, digest);
  if (catalog.environment !== 'mathlib') throw new Error('web_library_release_changed');
  current = { key, catalog };
  return catalog;
}

/** The image publishes this pinned metadata/source tree outside the hidden application for agent tools. */
export function webAgentLibraryAccess(environment: LeanTaskEnvironment, env: NodeJS.ProcessEnv = process.env): LibraryAccess | undefined {
  if (environment !== 'mathlib') return;
  const catalog = webLibraryCatalog(env), digest = catalog.identity.catalogDigest;
  const file = path.resolve(env.THEOREMOS_AGENT_LIBRARY_CATALOG || '/opt/theoremos-library/release/catalog.json');
  readLibraryCatalog(file, digest);
  return { file, digest };
}

/** Build-time compatibility interface; normal task selection reads only its selected source objects. */
export function webLibraryRelease() {
  const catalog = webLibraryCatalog();
  const pack = parseLibraryPack({ schema: LIBRARY_PACK_SCHEMA, modules: catalog.moduleFiles.map(file => catalog.readModule(file)) });
  return { pack, environmentDigest: catalog.identity.environmentDigest, digest: libraryPackDigest(pack) };
}

export function selectWebLibraryPack(input: { source: string; task: string; environment?: LeanTaskEnvironment }): LibraryPack | undefined {
  if (input.environment !== 'mathlib') return undefined;
  const catalog = webLibraryCatalog();
  try {
    return catalog.materialize(catalog.select({ ...input, environmentDigest: getLeanTaskEnvironment(input.environment).dependencyDigest }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith('math_library_catalog_module_missing:')) throw new Error(message.replace('math_library_catalog_module_missing:', 'web_library_module_unavailable:'));
    if (message.startsWith('math_library_catalog_declaration_conflict:')) throw new Error(message.replace('math_library_catalog_declaration_conflict:', 'web_library_declaration_conflict:'));
    throw error;
  }
}
