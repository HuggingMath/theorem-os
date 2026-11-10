import type { InstalledLibraryEntry } from './installedLibraryTypes';
import { installedLibraryMathematics } from './installedLibraryMathematics';

/** Search the same frozen interface and mathematical explanation that the reader can see. */
export function matchesInstalledLibraryInterface(entry: InstalledLibraryEntry, moduleImport: string, query: string): boolean {
  const tokens = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  if (!tokens.length) return true;
  const mathematics = installedLibraryMathematics(entry, moduleImport);
  const searchable = [entry.name, entry.type, entry.description, mathematics.summary.zh, mathematics.summary.en,
    mathematics.conclusion.zh, mathematics.conclusion.en, mathematics.expression,
    ...mathematics.conditions.flatMap(condition => [condition.label.zh, condition.label.en, condition.meaning.zh,
      condition.meaning.en, condition.expression])].join('\n').toLocaleLowerCase();
  return tokens.every(token => searchable.includes(token));
}
