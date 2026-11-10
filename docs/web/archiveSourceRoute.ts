import { createHash } from 'node:crypto';
import { inspectLeanDeclarationRegions, inspectScopedLeanDeclarations } from '../../src/math/leanSource';
import { maskLeanComments, maskLeanCommentsAndStrings } from '../../src/math/leanSyntax';
import type { ArchiveProcess, ArchiveRecord, ArchiveSourceRoute } from './types';

type File = ArchiveSourceRoute['files'][number];
const sha256 = (code: string) => createHash('sha256').update(code).digest('hex');
function sourceLines(code: string) {
  const starts = [0];
  for (let at = code.indexOf('\n'); at >= 0; at = code.indexOf('\n', at + 1)) starts.push(at + 1);
  return (offset: number) => {
    let low = 0, high = starts.length;
    while (low < high) { const middle = (low + high) >>> 1; if (starts[middle] <= offset) low = middle + 1; else high = middle; }
    return low;
  };
}

/** Split only outer source blocks. Indentation and delimiters keep continuations and nested blocks together. */
function proofSourceSteps(code: string, start: number, end: number, digest: string, lineAt: (offset: number) => number): File['declarations'][number]['steps'] {
  const body = code.slice(start, end);
  const withoutComments = maskLeanComments(body);
  if (!withoutComments.trim()) return [];
  const masked = maskLeanCommentsAndStrings(body);
  const rows: { start: number; text: string; literalText: string; indent: number }[] = [];
  for (let offset = 0; offset < masked.length;) {
    const newline = masked.indexOf('\n', offset), after = newline < 0 ? masked.length : newline + 1;
    const text = masked.slice(offset, after);
    rows.push({ start: offset, text: text.trim(), literalText: withoutComments.slice(offset, after).trim(), indent: text.match(/^[ \t]*/u)![0].length });
    offset = after;
  }
  const first = rows.findIndex(row => row.text);
  // A direct term or equation body is one real source block, including literal-valued terms.
  const by = first >= 0 && /^by\b/u.test(rows[first].text);
  const starts = [start];
  if (by) {
    const inline = rows[first].text.slice(2).trim();
    const following = rows.slice(first + 1).filter(row => row.text);
    const indent = following.length ? Math.min(...following.map(row => row.indent)) : Infinity;
    let seen = Boolean(inline), depth = 0, previous = rows[first].literalText.slice(2).trim();
    const nesting = (text: string) => {
      for (const character of text) {
        if ('([{⟨'.includes(character)) depth++;
        else if (')]}⟩'.includes(character)) depth = Math.max(0, depth - 1);
      }
    };
    nesting(inline);
    for (const row of rows.slice(first + 1)) {
      if (!row.text) { if (row.literalText) previous = row.literalText; continue; }
      const continuation = /^(?:[|,.)\]}⟩]|=>|else\b|then\b|with\b)/u.test(row.text)
        || /(?:[:=,]|=>|<\||\|>|\busing)\s*$/u.test(previous);
      if (row.indent === indent && depth === 0 && !continuation) {
        if (seen) starts.push(start + row.start);
        seen = true;
      }
      nesting(row.text); previous = row.literalText;
    }
  }
  return starts.map((offset, index) => {
    const after = starts[index + 1] ?? end;
    return { id: `proof-step:${digest}:${offset}`, line: lineAt(offset), endLine: lineAt(Math.max(offset, after - 1)), code: code.slice(offset, after) };
  });
}

/** Parse once during publication; the browser receives a source index without a Lean or Node dependency. */
export function buildArchiveSourceRoute(record: Pick<ArchiveRecord, 'sources'>, process: ArchiveProcess): ArchiveSourceRoute {
  const files = new Map<string, File>();
  const bytes = new Map<string, string>();
  const add = (name: string, path: string, digest: string, code: string, recordSource: boolean) => {
    if (sha256(code) !== digest) throw new Error(`Archive route source checksum mismatch: ${name}`);
    if (files.has(digest)) {
      if (recordSource) files.get(digest)!.recordSource = true;
      return;
    }
    files.set(digest, { name, path, sha256: digest, recordSource, declarations: [],
      ...(process.sources?.[digest] ? {} : { code }) });
    bytes.set(digest, code);
  };
  for (const source of record.sources) add(source.name, source.path, source.sha256, source.code, true);
  for (const [digest, source] of Object.entries(process.sources ?? {})) {
    if (source.sha256 !== digest) throw new Error(`Archive route source identity mismatch: ${source.path}`);
    add(source.path.split('/').at(-1) || source.path, source.path, digest, source.code, false);
  }

  const parsed = [...files.values()].map(file => {
    const code = bytes.get(file.sha256)!;
    const lineAt = sourceLines(code);
    const regions = new Map(inspectLeanDeclarationRegions(code).map(region => [region.startOffset, region]));
    const declarations = inspectScopedLeanDeclarations(code).map((declaration, index, all) => {
      const region = regions.get(declaration.startOffset)!;
      const end = Math.min(region.endOffset, all[index + 1]?.startOffset ?? code.length);
      const trimmedEnd = code.slice(0, end).trimEnd().length;
      const node: File['declarations'][number] = { id: `declaration:${file.sha256}:${declaration.startOffset}`,
        name: declaration.qualifiedName, kind: declaration.kind, type: declaration.declarationType,
        line: lineAt(declaration.startOffset), endLine: lineAt(Math.max(declaration.startOffset, trimmedEnd - 1)), references: [],
        steps: proofSourceSteps(code, region.bodyOffset, end, file.sha256, lineAt) };
      file.declarations.push(node);
      return { node, namespace: declaration.namespace,
        mentions: maskLeanCommentsAndStrings(code.slice(declaration.startOffset, end)) };
    });
    const byName = new Map<string, File['declarations']>();
    for (const declaration of declarations) byName.set(declaration.node.name, [...byName.get(declaration.node.name) ?? [], declaration.node]);
    return { file, declarations, byName };
  });
  const sharedByName = new Map<string, File['declarations']>();
  for (const item of parsed.filter(item => item.file.recordSource)) for (const declaration of item.declarations)
    sharedByName.set(declaration.node.name, [...sharedByName.get(declaration.node.name) ?? [], declaration.node]);
  for (const current of parsed) for (const declaration of current.declarations) {
    const tokens = declaration.mentions.match(/[\p{L}_][\p{L}\p{M}\p{N}_'.?!]*/gu) ?? [];
    for (const token of new Set(tokens)) {
      const name = token.replace(/^_root_\./u, '');
      const forms = [...new Set([[declaration.namespace, name].filter(Boolean).join('.'), name])];
      let target: File['declarations'][number] | undefined;
      for (const form of forms) {
        const local = current.byName.get(form) ?? [];
        if (local.length === 1) { target = local[0]; break; }
        // A historical file must not inherit helper declarations from a different final proof version.
        const shared = current.file.recordSource ? sharedByName.get(form) ?? [] : [];
        if (shared.length === 1) { target = shared[0]; break; }
      }
      if (target && target.id !== declaration.node.id && !declaration.node.references.includes(target.id))
        declaration.node.references.push(target.id);
    }
  }
  return { files: [...files.values()] };
}

/** Adds a presentation projection without changing native runs, checked sources, or acceptance evidence. */
export function withArchiveSourceRoute(record: ArchiveRecord): ArchiveRecord {
  const process = record.process ?? { runs: [] };
  return { ...record, process: { ...process, sourceRoute: buildArchiveSourceRoute(record, process) },
    processSummary: record.processSummary ?? { runs: process.runs.length, tasks: process.runs.reduce((sum, run) => sum + run.tasks.length, 0) } };
}
