import { inspectLeanDeclarationRegions, inspectScopedLeanDeclarations } from '../math/leanSource';
import { maskLeanComments } from '../math/leanSyntax';
import type { SolverProblem } from './problem';
import type { CooperativeTask } from './tasks';

const identifiers = (text: string) => [...text.matchAll(/[\p{L}_][\p{L}\p{M}\p{N}_'?!]*(?:\.[\p{L}_][\p{L}\p{M}\p{N}_'?!]*)*/gu)]
  .map(match => match[0].replace(/^_root_\./u, ''));
const leaf = (name: string) => name.split('.').at(-1)!;

/** An optimization, never dependency evidence. Keep definitions, attributes, commands and every
 * possible same-name reference; a failed compact check is retried with the complete projection. */
export function compactTaskSources(problem: SolverProblem, sources: ReadonlyMap<string, string>,
  task: CooperativeTask, retainedGoals: readonly string[],
  preserved: readonly { file: string; name: string }[] = []): Map<string, string> {
  const files = [...sources].filter(([file]) => file.endsWith('.lean')).map(([file, raw]) => {
    const source = maskLeanComments(raw), scoped = inspectScopedLeanDeclarations(source);
    const regions = inspectLeanDeclarationRegions(source);
    const originals = new Set((problem.declarations[file] ?? []).map(item => leaf(item.name)));
    const nodes = regions.map((region, index) => {
      const declaration = scoped.find(item => item.startOffset === region.startOffset)!;
      const line = source.lastIndexOf('\n', region.startOffset - 1) + 1;
      const plainLine = !source.slice(line, region.startOffset).trim();
      const start = plainLine ? line : region.startOffset;
      const gap = source.slice(index ? regions[index - 1]!.endOffset : 0, start);
      const root = file === task.proofPath && leaf(declaration.name) === leaf(task.theoremName!) ||
        retainedGoals.some(name => name === declaration.qualifiedName || name === declaration.name) ||
        preserved.some(item => item.file === file && leaf(item.name) === leaf(declaration.name));
      const removable = !root && !originals.has(leaf(declaration.name)) && plainLine && !gap.trim() &&
        /^(?:theorem|lemma)\s/u.test(source.slice(region.startOffset)) &&
        /^[\p{L}_][\p{L}\p{M}\p{N}_'?!]*(?:\.[\p{L}_][\p{L}\p{M}\p{N}_'?!]*)*$/u.test(declaration.name);
      return { ...region, start, id: `${file}\0${region.startOffset}`, name: declaration.qualifiedName,
        removable, text: source.slice(start, region.endOffset) };
    });
    return { file, source, nodes };
  });
  const nodes = files.flatMap(file => file.nodes), byId = new Map(nodes.map(node => [node.id, node]));
  const names = new Map<string, Set<string>>();
  for (const node of nodes) for (const name of new Set([node.name, leaf(node.name)])) {
    const matches = names.get(name) ?? new Set<string>(); matches.add(node.id); names.set(name, matches);
  }
  const keep = new Set<string>(), pending: string[] = [];
  const retain = (id: string) => { if (!keep.has(id)) { keep.add(id); pending.push(id); } };
  const references = (text: string) => {
    // Strings are intentionally scanned too: tactics can look up quoted declaration names.
    for (const token of identifiers(text)) {
      // A dotted name can use a declaration prefix as its receiver, as in lemma.mpr.
      for (let end = token.length; end > 0; end = token.lastIndexOf('.', end - 1)) {
        const prefix = token.slice(0, end);
        for (const name of new Set([prefix, leaf(prefix)]))
          for (const id of names.get(name) ?? []) retain(id);
      }
    }
  };
  for (const file of files) {
    let cursor = 0;
    for (const node of file.nodes) {
      references(file.source.slice(cursor, node.start));
      if (!node.removable) retain(node.id);
      cursor = node.endOffset;
    }
    references(file.source.slice(cursor));
  }
  while (pending.length) references(byId.get(pending.pop()!)!.text);
  const result = new Map(sources);
  for (const file of files) {
    // Preserve the exact full projection when nothing is omitted. Formatting alone
    // must not select another verification mode or trigger a retry.
    if (!file.nodes.some(node => !keep.has(node.id))) continue;
    let source = '', cursor = 0;
    for (const node of file.nodes) {
      const gap = file.source.slice(cursor, node.start);
      if (gap.trim()) source += gap;
      if (keep.has(node.id)) source += node.text.trimEnd() + '\n\n';
      cursor = node.endOffset;
    }
    const tail = file.source.slice(cursor);
    if (tail.trim()) source += tail;
    result.set(file.file, source);
  }
  return result;
}
