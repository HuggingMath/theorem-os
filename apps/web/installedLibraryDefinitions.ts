import { inspectLeanDeclarationRegions, inspectScopedLeanDeclarations } from '../../src/math/leanSource';
import { leanScopeCommands, maskLeanCommentsAndStrings } from '../../src/math/leanSyntax';
import type { InstalledLibraryDefinition, InstalledLibraryEntry } from './installedLibraryTypes';

/** Project definition text from the digest-checked module; the catalog itself stays unchanged. */
export function installedLibraryDefinitions(source: string, entries: readonly InstalledLibraryEntry[]): Record<string, InstalledLibraryDefinition> {
  const definitions: Record<string, InstalledLibraryDefinition> = {};
  const regions = inspectLeanDeclarationRegions(source), scoped = inspectScopedLeanDeclarations(source);
  const masked = maskLeanCommentsAndStrings(source);
  const commands = [...leanScopeCommands(masked)];
  for (const entry of entries) {
    if (entry.kind !== 'definition') continue;
    const declaration = scoped.find(item => item.qualifiedName === entry.name);
    const region = declaration && regions.find(item => item.startOffset === declaration.startOffset);
    if (!declaration || !region) throw new Error(`Definition source is missing: ${entry.name}`);
    const start = source.lastIndexOf('\n', region.startOffset - 1) + 1;
    let bodyStart = region.bodyOffset;
    // The source inspector treats the first field's := as the boundary of a `where` definition.
    // Include the complete record construction, including fields without explicit assignments.
    const header = masked.slice(region.startOffset, bodyStart);
    const where = /\bwhere\b/u.exec(header);
    if (where) bodyStart = region.startOffset + where.index;
    const frames: string[][] = [[]];
    for (const command of commands) {
      if (command.index >= region.startOffset) break;
      if (regions.some(item => command.index >= item.startOffset && command.index < item.endOffset)) continue;
      const kind = command[1];
      if (kind === 'namespace' || kind === 'section' || kind === 'mutual') frames.push([]);
      else if (kind === 'end') { if (frames.length > 1) frames.pop(); }
      else if (kind === 'variable') {
        let end = command.index + command[0].length;
        // Lean permits a variable command to continue on indented binder lines.
        let continuation: RegExpExecArray | null;
        while ((continuation = /^\n([ \t]+[^\n]*)/u.exec(masked.slice(end)))) {
          if (!/^\s*[([{⦃]/u.test(continuation[1])) break;
          end += continuation[0].length;
        }
        frames.at(-1)!.push(source.slice(command.index, end).trim());
      }
    }
    const before = source.slice(0, start).trimEnd(), docStart = before.lastIndexOf('/--');
    const doc = docStart < 0 ? undefined : /^\/--([\s\S]*?)-\/$/u.exec(before.slice(docStart));
    definitions[entry.name] = { source: source.slice(start, region.endOffset).trimEnd(),
      body: source.slice(bodyStart, region.endOffset).trim(), documentation: doc?.[1].trim() ?? '',
      context: frames.flat(), line: source.slice(0, start).split('\n').length };
  }
  return definitions;
}
