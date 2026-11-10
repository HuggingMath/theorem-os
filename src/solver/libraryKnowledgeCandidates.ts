import { isLibraryPackFile } from '../math/libraryPacks';
import { inspectLeanDeclarationRegions, inspectScopedLeanDeclarations } from '../math/leanSource';
import { leanScopeCommands, maskLeanCommentsAndStrings } from '../math/leanSyntax';
import type { KnowledgeCandidate } from './theoremKnowledge';

/** Generated module documentation is searchable advice, never an application or proof receipt. */
function libraryDescription(file: string, header: string): string {
  const fallback = `Frozen library declaration from ${file.slice(0, -5).replaceAll('/', '.')}.`;
  const name = /^Submission\/Library\/Auto\/([A-Z][A-Za-z0-9]{2,47})\.lean$/u.exec(file)?.[1];
  if (!name) return fallback;
  const documentation = /^\/-! # TheoremOS auto-library module `([A-Z][A-Za-z0-9]{2,47})`\r?\n([\s\S]*?)-\//mu.exec(header);
  if (documentation?.[1] !== name) return fallback;
  // Keep every planned use and remaining obligation in the catalog. Search hits use a shorter preview.
  return 'Advisory frozen auto-library documentation for the triggering challenge; applicability here is unverified. ' +
    `Search previews may omit remaining obligations; read the full frozen source: ${file}.\n${documentation[2]!.trim()}`;
}

/** Module headers default to private; visibility sections and declaration modifiers override that default. */
function importableLibraryNames(source: string): Set<string> {
  const masked = maskLeanCommentsAndStrings(source), commands = leanScopeCommands(masked);
  const regions = inspectLeanDeclarationRegions(source), names = new Set<string>();
  const visibility = [!/^\s*(?:prelude\s+)?module\b/u.test(masked)];
  let command = commands.next(), precedingEnd = 0;
  for (const declaration of inspectScopedLeanDeclarations(source)) {
    while (!command.done && command.value.index < declaration.startOffset) {
      const current = command.value;
      if (!regions.some(region => current.index >= region.bodyOffset && current.index < region.endOffset)) {
        if (current[1] === 'end') { if (visibility.length > 1) visibility.pop(); }
        else if (['namespace', 'section', 'mutual'].includes(current[1]!)) {
          const modifier = /\b(public|private)\b/u.exec(current[0].slice(0, current[0].indexOf(current[1]!)))?.[1];
          visibility.push(modifier ? modifier === 'public' : visibility.at(-1)!);
        }
      }
      command = commands.next();
    }
    const prefix = masked.slice(precedingEnd, declaration.startOffset);
    const modifier = /\b(public|private)(?:\s+(?:noncomputable|nonrec|partial|protected))*\s*$/u.exec(prefix)?.[1];
    if (modifier ? modifier === 'public' : visibility.at(-1)) names.add(declaration.qualifiedName);
    precedingEnd = regions.find(region => region.startOffset === declaration.startOffset)?.endOffset ?? declaration.startOffset;
  }
  return names;
}

/** Share the frozen module interfaces between offline catalogs and current-run library retrieval. */
export function libraryKnowledgeCandidates(files: Record<string, string>, provenance: KnowledgeCandidate['provenance'],
  options: { publicOnly?: boolean } = {}) {
  const candidates: KnowledgeCandidate[] = [], skipped: { source: string; name?: string; reason: string }[] = [];
  for (const file of Object.keys(files).filter(isLibraryPackFile).sort()) {
    const source = files[file], regions = new Map(inspectLeanDeclarationRegions(source).map(item => [item.startOffset, item]));
    const declarations = inspectScopedLeanDeclarations(source), counts = new Map<string, number>();
    const publicNames = options.publicOnly ? importableLibraryNames(source) : undefined;
    const description = libraryDescription(file, source.slice(0, declarations[0]?.startOffset ?? source.length));
    for (const item of declarations) counts.set(item.qualifiedName, (counts.get(item.qualifiedName) ?? 0) + 1);
    for (const item of declarations) {
      if (item.kind !== 'theorem' && item.kind !== 'definition') continue;
      if (publicNames && !publicNames.has(item.qualifiedName)) continue;
      const region = regions.get(item.startOffset);
      if (!region || counts.get(item.qualifiedName) !== 1) {
        skipped.push({ source: file, name: item.qualifiedName, reason: 'declaration-missing-or-ambiguous' });
        continue;
      }
      candidates.push({ name: item.qualifiedName, file, type: region.declarationType, typeKind: 'source-header',
        kind: item.kind === 'definition' ? 'definition' : 'lemma', description, premises: [],
        dependencies: { statement: [], proof: [], tasks: [], coverage: 'unavailable' }, files, provenance });
    }
  }
  return { candidates, skipped };
}
