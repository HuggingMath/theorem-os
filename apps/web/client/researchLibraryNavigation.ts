import type { ResearchReleaseRef } from '../researchAssetTypes';

/** Continue browsing releases without substituting another research step or carrying a different trial. */
export function researchLibraryHref(ref: Pick<ResearchReleaseRef, 'assetId'> & { version?: string }, current: URLSearchParams,
  preserveFilters = false): string {
  const next = new URLSearchParams({ entry: ref.assetId, ...(ref.version ? { version: ref.version } : {}) });
  const names = ['run', 'project', 'task', 'taskVersion', 'commit', 'lang',
    ...(preserveFilters ? ['q', 'type', 'area', 'author', 'environment', 'mine', 'offset', 'workbenchChat', 'workbenchRun', 'workbenchEdit'] : [])];
  for (const name of names) if (current.has(name)) next.set(name, current.get(name)!);
  if (preserveFilters) next.set('collection', 'shared');
  return `library.html?${next}`;
}
