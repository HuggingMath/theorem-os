export type InstalledLibraryReference = { file: string; catalogDigest: string; declaration: string; chat: string; editedProblem: string };
export const libraryReferenceKeys = ['libraryModule', 'libraryCatalog', 'libraryDeclaration'] as const;

export function readLibraryReference(parameters: URLSearchParams): InstalledLibraryReference | undefined {
  if (!libraryReferenceKeys.some(key => parameters.has(key))) return;
  return { file: parameters.get('libraryModule') ?? '', catalogDigest: parameters.get('libraryCatalog') ?? '',
    declaration: parameters.get('libraryDeclaration') ?? '', chat: parameters.get('chat') ?? '', editedProblem: parameters.get('editProblem') ?? '' };
}

export function libraryReferenceHref(file: string, catalogDigest: string, declaration: string, chat?: string | null, editedProblem?: string | null) {
  const parameters = new URLSearchParams({ libraryModule: file, libraryCatalog: catalogDigest, libraryDeclaration: declaration });
  if (chat && /^[a-f0-9-]{36}$/u.test(chat)) parameters.set('chat', chat);
  else if (editedProblem && /^[A-Za-z0-9_-]{1,128}$/u.test(editedProblem)) parameters.set('editProblem', editedProblem);
  return `./?${parameters}`;
}
