import { leanScopeCommands, leanScopeNamespace, maskLeanCommentsAndStrings, updateLeanScopes, type LeanScope } from '../../../src/math/leanSyntax';

export type LeanHeadingKind = 'theorem' | 'definition' | 'structure' | 'instance' | 'axiom';
/** A named declaration of a Lean file: where it starts, its name as written and in full, and whether its body leaves a placeholder. */
export type LeanHeading = { line: number; kind: LeanHeadingKind; keyword: string; name: string; qualifiedName: string; sorry: boolean };

const kinds: Record<string, LeanHeadingKind> = { theorem: 'theorem', lemma: 'theorem', def: 'definition', abbrev: 'definition', opaque: 'definition',
  structure: 'structure', class: 'structure', inductive: 'structure', instance: 'instance', axiom: 'axiom' };
// A declaration keyword at the start of a command, after attributes and modifiers; an unnamed instance or example has no entry.
const header = /^[ \t]*(?:@\[[^\]\n]*\][ \t]*)*(?:(?:private|protected|public|noncomputable|partial|unsafe|nonrec|scoped|local)[ \t]+)*(theorem|lemma|def|abbrev|opaque|structure|class(?:[ \t]+inductive)?|inductive|instance|axiom)\b(?:[ \t]*\([^)\n]*\))?[ \t]+((?:«[^»\n]+»|[\p{L}_][\p{L}\p{M}\p{N}_'!?]*)(?:\.(?:«[^»\n]+»|[\p{L}_][\p{L}\p{M}\p{N}_'!?]*))*)/gmu;
const maximumHeadings = 400;

/**
 * The declarations of `source` in order, read the way the server's outline reads them: comments and strings are
 * masked, and `namespace … end` qualifies each name. A lexical pass for navigation; Lean remains the authority.
 */
export function leanOutline(source: string): LeanHeading[] {
  const masked = maskLeanCommentsAndStrings(source.replace(/\r\n?/gu, '\n'));
  const marks: { index: number; scope?: RegExpExecArray; heading?: RegExpExecArray }[] = [
    ...[...leanScopeCommands(masked)].map(match => ({ index: match.index, scope: match })),
    ...[...masked.matchAll(header)].map(match => ({ index: match.index, heading: match }))].sort((a, b) => a.index - b.index);
  const scopes: LeanScope[] = [], headings: LeanHeading[] = [], starts: number[] = [];
  let line = 1, counted = 0;
  for (const mark of marks) {
    if (mark.scope) { updateLeanScopes(scopes, mark.scope[1]!, mark.scope[2]?.trim()); continue; }
    if (headings.length >= maximumHeadings) break;
    const match = mark.heading!, keyword = match[1]!.replace(/\s+/gu, ' '), name = match[2]!;
    for (; counted < match.index; counted++) if (masked.charCodeAt(counted) === 10) line++;
    const namespace = leanScopeNamespace(scopes);
    starts.push(match.index);
    headings.push({ line, kind: kinds[keyword.split(' ')[0]!]!, keyword, name,
      qualifiedName: name.startsWith('_root_.') ? name.slice(7) : [namespace, name].filter(Boolean).join('.'), sorry: false });
  }
  // A body runs to the next declaration or the end of its scope; only a placeholder outside comments and strings counts.
  const bounds = marks.filter(mark => mark.heading || /^(?:namespace|section|end)$/u.test(mark.scope![1]!)).map(mark => mark.index);
  for (const [index, heading] of headings.entries()) {
    const start = starts[index]!, end = bounds.find(bound => bound > start) ?? masked.length;
    heading.sorry = /(?<![\p{L}\p{N}_'.])(?:sorry|admit)(?![\p{L}\p{N}_'!?])/u.test(masked.slice(start, end));
  }
  return headings;
}

/** The line a declaration named `name` (in full or as written) starts on. */
export function headingLine(headings: readonly LeanHeading[], name: string): number | undefined {
  return (headings.find(item => item.qualifiedName === name) ?? headings.find(item => item.name === name))?.line;
}

/**
 * How the file itself writes each declaration: `Tutorial.add_zero` declared inside `namespace Tutorial` reads as
 * `add_zero`. A name the file does not declare, or one written the same way twice, stays in full.
 */
export function writtenNames(headings: readonly LeanHeading[]): (name: string) => string {
  const written = new Map<string, string>(), count = new Map<string, number>();
  for (const heading of headings) {
    const short = heading.name.startsWith('_root_.') ? heading.name.slice(7) : heading.name;
    count.set(short, (count.get(short) ?? 0) + 1);
    written.set(heading.qualifiedName, short);
  }
  return name => {
    const short = written.get(name);
    return short && count.get(short) === 1 ? short : name;
  };
}

/** A Lean file named after the theorem it proves, the first one with a placeholder if any; `suffix` tells two files of one problem apart. */
export function leanFileName(source: string, suffix = '') {
  const headings = leanOutline(source).filter(heading => heading.kind === 'theorem');
  const name = (headings.find(heading => heading.sorry) ?? headings[0])?.name.replace(/[^\p{L}\p{N}_.-]+/gu, '_').slice(0, 80);
  return `${name || 'Submission'}${suffix}.lean`;
}
