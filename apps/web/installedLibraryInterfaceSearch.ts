import type { InstalledLibraryDeclarationContext, InstalledLibraryDefinition, InstalledLibraryEntry } from './installedLibraryTypes';
import { installedLibraryMathematics } from './installedLibraryMathematics';

/** Build the text shared by module search and the release's precomputed directory metadata. */
export function installedLibraryInterfaceSearchText(entry: InstalledLibraryEntry, moduleImport: string,
  definition?: InstalledLibraryDefinition, sourceContext?: InstalledLibraryDeclarationContext): string {
  const mathematics = installedLibraryMathematics(entry, moduleImport, definition, sourceContext);
  return [entry.name, entry.type, entry.description, mathematics.summary.zh, mathematics.summary.en,
    mathematics.conclusion.zh, mathematics.conclusion.en, mathematics.expression, definition?.documentation, sourceContext?.documentation,
    ...[...mathematics.conditions, ...mathematics.scopeConditions].flatMap(condition => [condition.label.zh, condition.label.en, condition.meaning.zh,
      condition.meaning.en, condition.expression])].join('\n').toLocaleLowerCase();
}

export function matchesInstalledLibrarySearchText(searchable: string, query: string): boolean {
  return query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean).every(token => searchable.includes(token));
}

/** Search the same frozen interface and mathematical explanation that the reader can see. */
export function matchesInstalledLibraryInterface(entry: InstalledLibraryEntry, moduleImport: string, query: string,
  definition?: InstalledLibraryDefinition, sourceContext?: InstalledLibraryDeclarationContext): boolean {
  if (!query.trim()) return true;
  return matchesInstalledLibrarySearchText(installedLibraryInterfaceSearchText(entry, moduleImport, definition, sourceContext), query);
}
