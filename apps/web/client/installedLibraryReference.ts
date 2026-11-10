import type { InstalledLibraryDetail } from '../installedLibraryTypes';
import { installedLibraryLabels } from '../installedLibraryLabels';
import { locale, t } from '../i18n';
import { researchNavigation } from '../shared';

export type InstalledLibraryReference = { file: string; catalogDigest: string; declaration: string; chat: string };
export const libraryReferenceKeys = ['libraryModule', 'libraryCatalog', 'libraryDeclaration'] as const;

export function readLibraryReference(parameters: URLSearchParams): InstalledLibraryReference | undefined {
  if (!libraryReferenceKeys.some(key => parameters.has(key))) return;
  return { file: parameters.get('libraryModule') ?? '', catalogDigest: parameters.get('libraryCatalog') ?? '',
    declaration: parameters.get('libraryDeclaration') ?? '', chat: parameters.get('chat') ?? '' };
}

export function libraryReferenceHref(file: string, catalogDigest: string, declaration: string, chat?: string | null) {
  const parameters = new URLSearchParams({ libraryModule: file, libraryCatalog: catalogDigest, libraryDeclaration: declaration });
  if (chat && /^[a-f0-9-]{36}$/u.test(chat)) parameters.set('chat', chat);
  return `./?${parameters}`;
}

/** Read the interface from the pinned module, never from URL-supplied code. */
export function libraryReferenceText(detail: InstalledLibraryDetail, declaration: string) {
  const entry = detail.module.entries.find(item => item.name === declaration);
  if (!entry) throw new Error(t('该版本中没有此接口，请返回数学库重新选择。'));
  const labels = installedLibraryLabels(detail.module.name), title = labels?.[locale].title ?? detail.module.name;
  const source = new URL(researchNavigation(location.search, 'workbench').library, location.href);
  source.searchParams.set('source', 'installed'); source.searchParams.set('module', detail.module.file);
  source.searchParams.set('catalogDigest', detail.library.catalogDigest);
  source.hash = `declaration-${encodeURIComponent(entry.name)}`;
  return [t('引用数学库：{0}', title), '', '```lean', detail.module.import, `#check ${entry.name}`, '```', '',
    t('接口类型：'), '```lean', entry.type, '```', '', `${t('来源：')}${source.href}`].join('\n');
}
