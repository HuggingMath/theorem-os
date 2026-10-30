import path from 'node:path';
import { z } from 'zod';
import { mathDigest, readMathText } from './mathRuntimeIo';
import { assertMathCanonicalPath } from './paths';
import type { LeanStatementKernelExpr, LeanStatementKernelName } from './leanStatementSemantic';

/**
 * Declaration-name compatibility with a second, pinned evaluation library.
 *
 * Candidates elaborate in the runtime's Lean/Mathlib, but a benchmark may type-check
 * them in an older release (ProofNet# pins Lean v4.8.0 and its Mathlib). A name that
 * exists only in the newer library (`IsMulCommutative`, `LinearIndepOn`) elaborates
 * here and fails there, which no semantic reviewer can see. The host therefore
 * compares the library constants a candidate writes against the frozen declaration
 * list of that release and returns missing names as compile feedback.
 *
 * Only names the candidate spells are checked: instances, projections and other
 * constants that elaboration inserts are named by the library itself and may differ
 * between releases without the source being incompatible. The list is frozen into
 * the case directory and bound by digest; it is a name check, not a type check.
 */

const MAX_NAMES_BYTES = 64 * 1024 * 1024;
export const FORMALIZATION_NAMES_FILE = 'compatibility-names.txt';
export const formalizationNameCompatibilitySchema = z.object({
  schema: z.literal('theorem-os.formalization-name-compatibility.v1'),
  provenance: z.string().min(1).max(4_000),
  namesSha256: z.string().regex(/^[a-f0-9]{64}$/u), namesCount: z.number().int().positive(),
}).strict();
export type FormalizationNameCompatibility = z.infer<typeof formalizationNameCompatibilitySchema>;
export type FormalizationNameCompatibilitySource = { namesFile: string; provenance: string };

export function prepareFormalizationNameCompatibility(source: FormalizationNameCompatibilitySource):
  { configuration: FormalizationNameCompatibility; namesText: string } {
  const file = path.resolve(source.namesFile); assertMathCanonicalPath(file);
  const namesText = readMathText(file, MAX_NAMES_BYTES), names = parseNames(namesText);
  return { namesText, configuration: formalizationNameCompatibilitySchema.parse({
    schema: 'theorem-os.formalization-name-compatibility.v1', provenance: source.provenance,
    namesSha256: mathDigest(namesText), namesCount: names.size }) };
}

function parseNames(text: string): Set<string> {
  const names = new Set(text.split('\n').filter(line => line.length > 0));
  if (names.size === 0) throw new Error('formalization_compatibility_names_empty');
  return names;
}

const cache = new Map<string, Set<string>>();
/** Reads the frozen list from a case directory and refuses it if its bytes changed. */
export function readFormalizationCompatibilityNames(directory: string, configuration: FormalizationNameCompatibility): Set<string> {
  const text = readMathText(path.join(directory, FORMALIZATION_NAMES_FILE), MAX_NAMES_BYTES);
  if (mathDigest(text) !== configuration.namesSha256) throw new Error('formalization_compatibility_names_changed');
  const cached = cache.get(configuration.namesSha256);
  if (cached) return cached;
  const names = parseNames(text);
  if (names.size !== configuration.namesCount) throw new Error('formalization_compatibility_names_changed');
  cache.set(configuration.namesSha256, names);
  return names;
}

const component = /^[\p{L}_][\p{L}\p{N}_'!?⁰-ₜᵢ-ᵪ]*$/u;
/** Dotted form of a plain kernel name; names Lean would print escaped or numbered are not checked. */
function plainName(name: LeanStatementKernelName): string | undefined {
  const parts: string[] = [];
  for (let item = name; item !== null; item = item[1]) {
    if (item[0] !== 'str' || !component.test(item[2]) || item[2].startsWith('_')) return undefined;
    parts.unshift(item[2]);
  }
  return parts.length ? parts.join('.') : undefined;
}

function collectConstants(expr: LeanStatementKernelExpr, into: Set<string>): void {
  const stack: LeanStatementKernelExpr[] = [expr];
  while (stack.length) {
    const item = stack.pop()!;
    if (item[0] === 'const') { const name = plainName(item[1]); if (name) into.add(name); }
    else if (item[0] === 'app') stack.push(item[1], item[2]);
    else if (item[0] === 'lam' || item[0] === 'forall') stack.push(item[2], item[3]);
    else if (item[0] === 'let') stack.push(item[2], item[3], item[4]);
    else if (item[0] === 'projection') stack.push(item[3]);
  }
}

/** Identifier tokens of the source, with comments and string literals removed. */
function writtenIdentifiers(source: string): Set<string> {
  const stripped = source.replace(/\/-[\s\S]*?-\//gu, ' ').replace(/--[^\n]*/gu, ' ').replace(/"(?:[^"\\]|\\.)*"/gu, ' ');
  return new Set(stripped.match(/[\p{L}_][\p{L}\p{N}_'!?⁰-ₜᵢ-ᵪ]*(?:\.[\p{L}_][\p{L}\p{N}_'!?⁰-ₜᵢ-ᵪ]*)*/gu) ?? []);
}

/** Namespaces the source opens or enters (with their prefixes); a written short name may resolve through any of them. */
function openedNamespaces(source: string): string[] {
  const result = new Set<string>();
  for (const match of source.matchAll(/^[ \t]*(open|namespace)\b([^\n]*)/gmu)) {
    const words = match[2].replace(/\([^)]*\)/gu, ' ').split(/\s+/u).filter(Boolean);
    for (const word of words) {
      if (word === 'hiding' || word === 'renaming' || word === 'in' || word === 'from') break;
      if (word === 'scoped' || !/^[\p{L}_][^\s]*$/u.test(word)) continue;
      const parts = word.split('.');
      // Inside `namespace A.B`, names resolve through A.B and A.
      for (let end = match[1] === 'namespace' ? 1 : parts.length; end <= parts.length; end++) result.add(parts.slice(0, end).join('.'));
    }
  }
  return [...result];
}

export type CompatibilityTarget = { name: string; context: { semantic?: {
  kernelType: LeanStatementKernelExpr; localMeaningClosure: { name: string; type: LeanStatementKernelExpr; value?: LeanStatementKernelExpr }[] } } };

/**
 * Library constants of the statement kernel types that the source spells, fully or as a
 * dotted suffix (`open`, namespaces and generalized field notation shorten names), and
 * that the pinned list lacks. Local declarations are the candidate's own and never checked.
 *
 * A declaration renamed between releases (`FiniteDimensional.finrank` became
 * `Module.finrank`) has no qualified spelling valid in both, so a written token that
 * itself resolves in the pinned list, at the root or through an opened namespace,
 * clears the constant it elaborated to here.
 */
export function unavailableFormalizationNames(source: string, targets: CompatibilityTarget[], available: ReadonlySet<string>): string[] {
  const constants = new Set<string>(), local = new Set<string>(targets.map(item => item.name));
  for (const target of targets) {
    const semantic = target.context.semantic;
    if (!semantic) throw new Error('formalization_compatibility_requires_semantic_context');
    collectConstants(semantic.kernelType, constants);
    for (const entry of semantic.localMeaningClosure) {
      local.add(entry.name); collectConstants(entry.type, constants);
      if (entry.value) collectConstants(entry.value, constants);
    }
  }
  // Each dotted suffix of a written token, mapped to the tokens that contain it.
  const written = new Map<string, Set<string>>();
  for (const token of writtenIdentifiers(source)) {
    const parts = token.split('.');
    for (let index = 0; index < parts.length; index++) {
      const suffix = parts.slice(index).join('.');
      written.set(suffix, (written.get(suffix) ?? new Set()).add(token));
    }
  }
  const namespaces = openedNamespaces(source);
  const resolves = (token: string) => available.has(token) || namespaces.some(item => available.has(item + '.' + token));
  return [...constants].filter(name => {
    if (local.has(name) || available.has(name)) return false;
    const parts = name.split('.'), tokens = new Set<string>();
    for (let index = 0; index < parts.length; index++) written.get(parts.slice(index).join('.'))?.forEach(token => tokens.add(token));
    return tokens.size > 0 && ![...tokens].some(resolves);
  }).sort();
}

export function nameCompatibilityRejection(missing: string[], provenance: string): string {
  return 'formalization_compatibility_names_unavailable: ' + missing.join(', ') + '\n' +
    'These declarations do not exist in the pinned evaluation library (' + provenance + '). ' +
    'Keep the same mathematics and state it with declarations of that release, for example an older name, ' +
    'a short name under `open` namespaces that resolves in both releases when a declaration was renamed, ' +
    'or a definition that unfolds to the same predicate; do not weaken or change the claim to avoid the name.';
}
