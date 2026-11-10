import { inspectLeanDeclarationRegions, inspectScopedLeanDeclarations } from '../math/leanSource';
import { mathConstructionImports } from '../math/mathConstructionSources';

/** Only explicit modules from the pinned Mathlib package may extend proof imports. */
export function solverMathlibImports(source: string): string[] {
  return mathConstructionImports(source).filter(module => /^Mathlib(?:\.[A-Za-z_][A-Za-z0-9_']*)+$/u.test(module));
}

/** Regions of `source` holding an original: the same written name and, for a repeated one, the same qualified name. */
export function originalDeclarationRegions(source: string, regions = inspectLeanDeclarationRegions(source)) {
  let qualified: Map<number, string> | undefined;
  const qualifiedName = (offset: number) => (qualified ??= new Map(inspectScopedLeanDeclarations(source)
    .map(item => [item.startOffset, item.qualifiedName]))).get(offset);
  return (original: { name: string; qualifiedName?: string }) => regions.filter(region => region.name === original.name &&
    (original.qualifiedName === undefined || qualifiedName(region.startOffset) === original.qualifiedName));
}

/** Read-only instance queries allow simple names or balanced parenthesized types. */
function isInstanceQuery(line: string): boolean {
  const query = /^#synth[ \t]+[\p{L}_][\p{L}\p{M}\p{N}_'.]*(.*)$/u.exec(line);
  if (!query || /["`#;]/u.test(query[1])) return false;
  let depth = 0;
  let bare = '';
  const validBare = () => !bare || /^[\p{L}_][\p{L}\p{M}\p{N}_'.]*$|^[0-9]+$/u.test(bare) &&
    !/^(?:import|public|private|meta|namespace|section|end|theorem|lemma|def|example|abbrev|opaque|instance|inductive|structure|class|axiom|constant|variable|universe|open|export|set_option|attribute|noncomputable|unsafe|syntax|macro|elab|notation|infix|infixl|infixr|prefix|postfix|initialize|builtin_initialize)$/u.test(bare);
  for (const character of query[1]) {
    if (character === '(') { if (!depth && !validBare()) return false; bare = ''; depth++; }
    else if (character === ')') { if (--depth < 0) return false; }
    else if (!depth) {
      if (character === ' ' || character === '\t') { if (!validBare()) return false; bare = ''; }
      else bare += character;
    }
  }
  return depth === 0 && validBare();
}
export function solverSourceContext(source: string, originals: readonly { name: string; qualifiedName?: string }[],
  originalImports?: readonly string[], allowedImports = solverMathlibImports(source), regions = inspectLeanDeclarationRegions(source)): string {
  const addedImports = new Set(originalImports === undefined ? [] :
    allowedImports.filter(module => !originalImports.includes(module)));
  const matching = originalDeclarationRegions(source, regions);
  const original = new Set(originals.flatMap(item => matching(item)).map(region => region.startOffset));
  let frozen = '';
  let cursor = 0;
  for (const region of regions) {
    const context = source.slice(cursor, region.startOffset);
    frozen += original.has(region.startOffset) ? context : context.replace(/\bnoncomputable[ \t]+$/u, '');
    if (original.has(region.startOffset)) frozen += `${region.declarationType}\n`;
    cursor = region.endOffset;
  }
  frozen += source.slice(cursor);
  // Read-only name and instance queries leave the original proof context intact.
  return frozen.split('\n').map(line => line.trim()).filter(line => line &&
    !addedImports.has(/^import[ \t]+([^ \t]+)$/u.exec(line)?.[1] ?? '') &&
    !/^#check[ \t]+[\p{L}_][\p{L}\p{M}\p{N}_'.]*$/u.test(line) && !isInstanceQuery(line)).join('\n');
}
