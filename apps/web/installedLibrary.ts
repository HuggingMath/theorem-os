import { webLibraryCatalog } from './frozenLibrary';
import { WebStorageError } from './storage';
import { installedLibraryLabels } from './installedLibraryLabels';
import { matchesInstalledLibraryModuleAlias } from './installedLibrarySearch';
import { installedLibraryDeclarations } from './installedLibraryDefinitions';
import { installedLibraryInterfaceSearchText, matchesInstalledLibrarySearchText } from './installedLibraryInterfaceSearch';
import { installedLibraryMathematics } from './installedLibraryMathematics';
import { installedLibrarySearchData } from './installedLibrarySearchData';
import type { InstalledLibraryDetail, InstalledLibraryDirectory, InstalledLibraryInfo, InstalledLibraryModule,
  InstalledLibraryModuleSummary, InstalledLibrarySource } from './installedLibraryTypes';

function installedCatalog() {
  try { return webLibraryCatalog(); }
  catch { throw new WebStorageError(503, '现有 Lean 库目录读取失败，请检查服务的库版本配置后重试。'); }
}
type Catalog = ReturnType<typeof installedCatalog>;
function libraryInfo(catalog: Catalog): InstalledLibraryInfo {
  return { ...catalog.identity, environment: catalog.environment, toolchain: catalog.toolchain,
    moduleCount: catalog.moduleCount, declarationCount: catalog.declarationCount };
}
function moduleInfo(catalog: Catalog, file: string): InstalledLibraryModule {
  if (!catalog.moduleFiles.includes(file)) throw new WebStorageError(404, '现有 Lean 库中没有此模块。');
  // The catalog reader validates every required field, including when the root TS build uses non-strict Zod inference.
  const module = catalog.moduleMetadata(file) as Omit<InstalledLibraryModule, 'name' | 'area' | 'import'>;
  const name = file.slice('Submission/Library/'.length, -'.lean'.length).replaceAll('/', '.');
  return { ...module, name, area: name.split('.')[1] ?? '', import: `import ${file.slice(0, -'.lean'.length).replaceAll('/', '.')}` };
}

/** The installed solver release is visible even when no researcher has published an asset. */
export function installedLibraryDirectory(options: {
  q?: string; area?: string; environment?: string; offset?: number; limit?: number;
} = {}): InstalledLibraryDirectory {
  const catalog = installedCatalog(), all = catalog.moduleFiles.map(file => moduleInfo(catalog, file));
  const tokens = (options.q ?? '').toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
  const matches = (text: string) => tokens.every(token => text.toLocaleLowerCase().includes(token));
  const interfaceMatches = new Map<string, InstalledLibraryModuleSummary['matchingInterfaces']>();
  const filtered = all.filter(module => {
    const labels = installedLibraryLabels(module.name);
    if (options.area && !module.area.toLocaleLowerCase().includes(options.area.toLocaleLowerCase())
      || options.environment && options.environment !== catalog.environment) return false;
    const indexed = installedLibrarySearchData.catalogDigest === catalog.identity.catalogDigest
      && installedLibrarySearchData.modules[module.file]?.sha256 === module.sha256 ? installedLibrarySearchData.modules[module.file].entries : undefined;
    const matching = tokens.length ? module.entries.flatMap(entry => {
      const value = indexed?.[entry.name] ?? { text: installedLibraryInterfaceSearchText(entry, module.import),
        summary: installedLibraryMathematics(entry, module.import).summary };
      return matchesInstalledLibrarySearchText(value.text, options.q ?? '') ? [{ name: entry.name, summary: value.summary }] : [];
    }) : [];
    interfaceMatches.set(module.file, matching);
    return matching.length > 0 || matchesInstalledLibraryModuleAlias(module.name, options.q ?? '')
        || matches([module.name, module.file, labels?.zh.title, labels?.zh.description, labels?.en.title, labels?.en.description,
          ...module.declarations, ...module.entries.map(entry => `${entry.name} ${entry.type} ${entry.description}`)].filter(Boolean).join('\n'));
  }).sort((left, right) => Number(matchesInstalledLibraryModuleAlias(right.name, options.q ?? ''))
    - Number(matchesInstalledLibraryModuleAlias(left.name, options.q ?? '')));
  const offset = options.offset ?? 0, limit = options.limit ?? 24;
  const items: InstalledLibraryModuleSummary[] = filtered.slice(offset, offset + limit).map(module => {
    const { entries, declarations, ...metadata } = module;
    const matchingEntries = tokens.length ? entries.filter(entry => matches(`${entry.name} ${entry.type} ${entry.description}`)) : [];
    const matchingInterfaces = interfaceMatches.get(module.file) ?? [];
    return { ...metadata, entryCount: entries.length, declarationCount: declarations.length,
      preview: (matchingEntries.length ? matchingEntries : entries).slice(0, 3),
      matchingInterfaces: matchingInterfaces.slice(0, 3), matchingInterfaceCount: matchingInterfaces.length };
  });
  return { library: libraryInfo(catalog), items, areas: [...new Set(all.map(module => module.area))].sort(),
    total: filtered.length, offset, limit, ...(offset + limit < filtered.length ? { nextOffset: offset + limit } : {}) };
}

function pinnedModule(file: string, digest: string) {
  const catalog = installedCatalog();
  if (digest !== catalog.identity.catalogDigest) throw new WebStorageError(409, '库版本已改变，请返回目录重新选择模块。');
  return { catalog, module: moduleInfo(catalog, file) };
}
export function installedLibraryDetail(file: string, digest: string): InstalledLibraryDetail {
  const { catalog, module } = pinnedModule(file, digest);
  try {
    const declarations = installedLibraryDeclarations(catalog.readModule(file).source, module.entries);
    return { library: libraryInfo(catalog), module, ...declarations };
  } catch { throw new WebStorageError(503, '声明与定义源码读取失败或与固定版本不一致，请检查服务的库文件后重试。'); }
}
export function installedLibrarySource(file: string, digest: string): InstalledLibrarySource {
  const { catalog, module } = pinnedModule(file, digest);
  try {
    const { source } = catalog.readModule(file);
    return { library: libraryInfo(catalog), file, sourceDigest: module.sha256, source };
  } catch { throw new WebStorageError(503, '模块源码读取失败或与固定版本不一致，请检查服务的库文件后重试。'); }
}
