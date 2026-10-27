import path from 'node:path';
import { inspectLeanDeclarationRegions, inspectScopedLeanDeclarations } from '../math/leanSource';
import { maskLeanCommentsAndStrings } from '../math/leanSyntax';
import { readMathText, writeMathTextDurable } from '../math/mathRuntimeIo';
import { assertMathCanonicalPath } from '../math/paths';

/**
 * A host-written lexical index of the declarations in the owned Lean files, one JSON line each, at the worktree root.
 * Workers search it for an existing helper's exact name and type instead of scanning large owned files. It is rebuilt
 * from the saved sources at the start of every turn, so edits made during a turn are not in it; nothing in it is
 * checked by Lean, and a declaration's sorry flag only records a lexical sorry or admit in its source region.
 */
export const DECLARATION_INDEX_FILE = 'DECLARATIONS.jsonl';
export const MAX_DECLARATION_INDEX_TYPE_CHARS = 4000;
export const MAX_DECLARATION_INDEX_BYTES = 8 * 1024 * 1024;
const MAX_INDEXED_SOURCE_BYTES = 16 * 1024 * 1024;

export type OwnedDeclaration = { name: string; kind: 'theorem' | 'definition' | 'instance'; file: string; line: number;
  sorry: boolean; type: string; truncated?: true };
type OwnedSources = { projectRelative: string; ownedFiles: readonly string[] };

const clip = (value: string) => {
  if (value.length <= MAX_DECLARATION_INDEX_TYPE_CHARS) return value;
  let end = MAX_DECLARATION_INDEX_TYPE_CHARS;
  // Do not split a surrogate pair such as 𝓝.
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return value.slice(0, end);
};

/** Declarations of one owned source, in source order; `file` is relative to the Lean project. */
export function ownedSourceDeclarations(file: string, source: string): OwnedDeclaration[] {
  const masked = maskLeanCommentsAndStrings(source), regions = inspectLeanDeclarationRegions(source);
  let line = 1, cursor = 0;
  return inspectScopedLeanDeclarations(source).map((declaration, index) => {
    for (let next = source.indexOf('\n', cursor); next >= 0 && next < declaration.startOffset; next = source.indexOf('\n', cursor)) {
      line++; cursor = next + 1;
    }
    const region = regions[index]?.startOffset === declaration.startOffset ? regions[index] : undefined;
    // Without a matching region the body is unknown, so it is reported as possibly incomplete.
    const sorry = !region || /\b(?:sorry|admit)\b/u.test(masked.slice(region.bodyOffset, region.endOffset));
    const type = clip(declaration.declarationType);
    return { name: declaration.qualifiedName, kind: declaration.kind, file, line, sorry, type,
      ...(type.length < declaration.declarationType.length ? { truncated: true as const } : {}) };
  });
}

/**
 * Rebuild the worktree's declaration index from its saved owned sources. An owned file that cannot be read safely is
 * listed in a final `{"omitted":...}` line rather than indexed, as are declarations past the byte cap.
 */
export function writeOwnedDeclarationIndex(problem: OwnedSources, worktree: string): { declarations: number; bytes: number } {
  const lines: string[] = [], unreadable: string[] = [];
  let bytes = 0, declarations = 0, omitted = 0;
  for (const file of problem.ownedFiles) {
    let source: string;
    try {
      const target = path.join(worktree, problem.projectRelative, file);
      assertMathCanonicalPath(target);
      source = readMathText(target, MAX_INDEXED_SOURCE_BYTES);
    } catch { unreadable.push(file); continue; }
    for (const declaration of ownedSourceDeclarations(file, source)) {
      const text = JSON.stringify(declaration), size = Buffer.byteLength(text) + 1;
      if (bytes + size > MAX_DECLARATION_INDEX_BYTES) { omitted++; continue; }
      lines.push(text); bytes += size; declarations++;
    }
  }
  if (omitted || unreadable.length) lines.push(JSON.stringify({ omitted: { declarations: omitted, unreadableFiles: unreadable } }));
  const contents = lines.length ? `${lines.join('\n')}\n` : '';
  writeMathTextDurable(path.join(worktree, DECLARATION_INDEX_FILE), contents);
  return { declarations, bytes: Buffer.byteLength(contents) };
}
