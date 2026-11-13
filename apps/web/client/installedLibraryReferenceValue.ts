import type { InstalledLibraryDetail } from '../installedLibraryTypes';
import { installedLibraryLabels } from '../installedLibraryLabels';
import { installedLibraryMathematics } from '../installedLibraryMathematics';
import { t } from '../i18n';
import { researchNavigation } from '../shared';
import type { ChatLibraryReference } from './chatReference';

/** Read the interface from the pinned module, never from URL-supplied code. */
export function libraryReference(detail: InstalledLibraryDetail, declaration: string): ChatLibraryReference {
  const entry = detail.module.entries.find(item => item.name === declaration);
  if (!entry) throw new Error(t('该版本中没有此接口，请返回数学库重新选择。'));
  const labels = installedLibraryLabels(detail.module.name);
  const mathematics = installedLibraryMathematics(entry, detail.module.import, detail.definitions[entry.name], detail.contexts?.[entry.name]);
  const source = new URL(researchNavigation(location.search, 'workbench').library, location.href);
  source.searchParams.set('source', 'installed'); source.searchParams.set('module', detail.module.file);
  source.searchParams.set('catalogDigest', detail.library.catalogDigest);
  source.hash = `declaration-${encodeURIComponent(entry.name)}`;
  return { catalogDigest: detail.library.catalogDigest, file: detail.module.file, declaration: entry.name,
    title: { zh: labels?.zh.title ?? detail.module.name, en: labels?.en.title ?? detail.module.name },
    summary: mathematics.summary, expression: mathematics.expression, type: entry.type, import: detail.module.import, source: source.href,
    conditions: [...mathematics.scopeConditions, ...mathematics.conditions].map(item => ({ expression: item.expression, meaning: item.meaning })),
    context: detail.contexts?.[entry.name]?.context ?? detail.definitions[entry.name]?.context ?? [] };
}
