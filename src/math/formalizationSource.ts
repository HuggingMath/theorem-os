import { inspectLeanDeclarationRegions, inspectScopedLeanDeclarations } from './leanSource';
import { isSimpleLeanName, maskLeanComments, maskLeanCommentsAndStrings } from './leanSyntax';
import { mathDigest } from './mathRuntimeIo';

const keywords = (words: string) => new RegExp(
  `(?<![\\p{L}\\p{M}\\p{N}_'])(?:${words})(?![\\p{L}\\p{M}\\p{N}_'])`, 'gu');
const simpleName = "[\\p{L}_][\\p{L}\\p{M}\\p{N}_']*(?:\\.[\\p{L}_][\\p{L}\\p{M}\\p{N}_']*)*";
const names = `${simpleName}(?:[ \\t]+${simpleName})*`;
const modifiers = /^(?:(?:noncomputable|public|protected|nonrec)[ \t]+)*$/u;

/** Character literals are terms, rather than placeholders or command tokens. */
function admissionText(source: string): string {
  return maskLeanCommentsAndStrings(source).replace(
    /(?<![\p{L}\p{M}\p{N}_'])'(?:\\(?:u\{[\da-fA-F]+\}|u[\da-fA-F]{4}|x[\da-fA-F]{2}|[^\r\n])|[^'\\\r\n])'/gu,
    value => ' '.repeat(value.length));
}

/**
 * Limit declaration-exterior commands to the ordinary source subset
 * understood by our inspector. This complements the metaprogramming checks;
 * source inspection is not a complete Lean parser or an execution sandbox.
 */
function assertSupportedCommands(cleaned: string, regions: ReturnType<typeof inspectLeanDeclarationRegions>): void {
  let exterior = '', cursor = 0;
  for (const region of regions) {
    const lineStart = cleaned.lastIndexOf('\n', region.startOffset - 1) + 1;
    const prefix = cleaned.slice(lineStart, region.startOffset);
    if (!modifiers.test(prefix.trimStart())) throw new Error('formalization_unsupported_declaration');
    if (lineStart < cursor) throw new Error('formalization_unsupported_declaration');
    const hidden = cleaned.slice(lineStart, region.endOffset).replace(/[^\r\n]/gu, ' ');
    // A marker prevents a variable continuation from crossing a declaration.
    exterior += cleaned.slice(cursor, lineStart) + '\x01' + hidden.slice(1);
    cursor = region.endOffset;
  }
  exterior += cleaned.slice(cursor);

  const binders: string[] = [];
  const consumeBinders = (text: string) => {
    for (const value of text) {
      const opening = '([{⦃'.indexOf(value);
      if (opening >= 0) binders.push(')]}⦄'[opening]);
      else if (')]}⦄'.includes(value)) {
        if (binders.pop() !== value) throw new Error('formalization_unsupported_declaration');
      } else if (!binders.length && !/\s/u.test(value)) throw new Error('formalization_unsupported_declaration');
    }
  };
  let variableContinuation = false;
  for (const line of exterior.split(/\r?\n/u)) {
    const text = line.trim();
    if (!text) continue;
    if (text === '\x01') {
      if (binders.length) throw new Error('formalization_unsupported_declaration');
      variableContinuation = false;
      continue;
    }
    if (binders.length) { consumeBinders(text); continue; }
    const variable = /^variables?\s+([\s\S]+)$/u.exec(text);
    if (variable) { variableContinuation = true; consumeBinders(variable[1]!); continue; }
    if (variableContinuation && /^[([{⦃]/u.test(text)) { consumeBinders(text); continue; }
    variableContinuation = false;
    if (new RegExp(`^(?:import|universes?|include|omit)\\s+${names}$`, 'u').test(text) ||
        new RegExp(`^namespace\\s+${simpleName}$`, 'u').test(text) ||
        new RegExp(`^(?:(?:noncomputable|public)\\s+)?section(?:\\s+${simpleName})?$`, 'u').test(text) ||
        new RegExp(`^end(?:\\s+${simpleName})?$`, 'u').test(text) ||
        new RegExp(`^open\\s+(?:scoped\\s+)?${names}$`, 'u').test(text) && !keywords('in').test(text)) continue;
    throw new Error('formalization_unsupported_declaration');
  }
  if (binders.length) throw new Error('formalization_unsupported_declaration');
}

/** Generated and reference statements stay at 128 KiB; the Lean task limit (leanTask.ts) is 1 MiB for prepared statements. */
export const FORMALIZATION_SOURCE_MAX_BYTES = 128 * 1024;

function inspectFormalizationSource(source: string) {
  if (!source || Buffer.byteLength(source, 'utf8') > FORMALIZATION_SOURCE_MAX_BYTES ||
      Buffer.from(source, 'utf8').toString('utf8') !== source || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(source))
    throw new Error('formalization_source_invalid');
  const statement = maskLeanComments(source), cleaned = admissionText(source);
  const interpolation = [...cleaned.matchAll(/\b[smf]!/gu)]
    .some(match => /^\s*"/u.test(statement.slice(match.index + match[0].length)));
  if (keywords('axiom|constant|sorryAx|unsafe|partial|partial_fixpoint|initialize|builtin_initialize|macro|macro_rules|elab|elab_rules|syntax|example|opaque|set_option|run_cmd|run_elab|run_tac|run_meta|deriving').test(cleaned) ||
      cleaned.includes('#') || interpolation)
    throw new Error('formalization_unsupported_declaration');
  const declarations = inspectScopedLeanDeclarations(statement), targets = declarations.filter(item => item.kind === 'theorem');
  if (!targets.length || declarations.length > 256) throw new Error('formalization_targets_missing');
  const basenames = declarations.map(item => item.name.split('.').at(-1));
  if (new Set(basenames).size !== basenames.length || declarations.some(item => !isSimpleLeanName(item.qualifiedName)))
    throw new Error('formalization_declarations_ambiguous');

  const offsets = new Set(declarations.map(item => item.startOffset));
  const declarationKeywords = [...cleaned.matchAll(keywords('theorem|lemma|def|abbrev|instance'))];
  if (declarationKeywords.length !== declarations.length || declarationKeywords.some(item => !offsets.has(item.index)))
    throw new Error('formalization_unsupported_declaration');
  // Scope commands can be indented more deeply than a declaration without
  // belonging to its proof. Preserve them when removing theorem bodies.
  const commandLines = [...cleaned.matchAll(
    /^[ \t]*(?:(?:noncomputable|public|private|protected|nonrec|unsafe|scoped|local|partial)[ \t]+)*(?:namespace|section|end|variables?|universes?|import|include|omit|open|attribute|structure|inductive|class|mutual|instance|theorem|lemma|def|abbrev|constant|axiom|opaque|syntax|macro|elab|run_cmd|run_elab|deriving)(?=\s|$)/gmu
  )].map(match => match.index);
  const regions = inspectLeanDeclarationRegions(statement).map(region => ({ ...region,
    endOffset: commandLines.find(offset => offset > region.bodyOffset && offset < region.endOffset) ?? region.endOffset }));
  if (regions.some((region, index) => region.bodyOffset > region.endOffset ||
      index > 0 && regions[index - 1]!.endOffset > region.startOffset))
    throw new Error('formalization_unsupported_declaration');
  assertSupportedCommands(cleaned, regions);

  const theoremOffsets = new Set(targets.map(item => item.startOffset));
  const theoremRegions = regions.filter(item => theoremOffsets.has(item.startOffset));
  for (const hole of [...cleaned.matchAll(keywords('sorry|admit')),
    ...cleaned.matchAll(/(?<![\p{L}\p{M}\p{N}_'.])_(?![\p{L}\p{M}\p{N}_'.])|(?<![\p{L}\p{M}\p{N}_'])\?/gu)]) {
    // Term proofs (including a benchmark's `:= sorry`) are erased just like
    // tactic proofs. Placeholders in declarations and definitions stay forbidden.
    const owner = theoremRegions.find(region => hole.index >= region.bodyOffset && hole.index < region.endOffset);
    if (!owner) throw new Error('formalization_placeholder_outside_proof');
  }
  return { statement, targets, theoremRegions };
}

/**
 * Conservative statement admission, independent of Lean elaboration and of
 * mathematical fidelity. Supported commands are imports, ordinary scopes and
 * variable/universe declarations; named def/abbrev/instance declarations and
 * theorem/lemma targets use the existing source inspector. Attributes, custom
 * commands, structure/inductive declarations and metaprogramming are excluded.
 * Existing theorem proofs may be supplied, but never count as solver evidence.
 */
export function formalizationTargets(source: string): { name: string; declarationHash: string }[] {
  return inspectFormalizationSource(source).targets.map(item => ({ name: item.qualifiedName,
    declarationHash: mathDigest(item.declarationType) }));
}

/** Check statement-only theorem bodies without changing submitted source bytes. */
export function hasErasedFormalizationProofs(source: string): boolean {
  const inspected = inspectFormalizationSource(source);
  // Keep the existing comment-free contract. Inspect only theorem bodies so
  // whitespace inside definitions, strings and statement types stays significant.
  return inspected.statement === source && inspected.theoremRegions.every(region =>
    source.slice(region.bodyOffset - 2, region.bodyOffset) === ':=' &&
    /^\s+by\s+sorry\s*$/u.test(source.slice(region.bodyOffset, region.endOffset)));
}

/** Remove comments and every theorem proof before elaboration or blind review. */
export function eraseFormalizationProofs(source: string): string {
  const inspected = inspectFormalizationSource(source);
  let result = inspected.statement;
  for (const region of [...inspected.theoremRegions].reverse()) {
    const assignment = inspected.statement.slice(region.bodyOffset - 2, region.bodyOffset) === ':=';
    result = result.slice(0, region.bodyOffset) + (assignment ? ' by sorry\n' : ':= by sorry\n') + result.slice(region.endOffset);
  }
  return result;
}
