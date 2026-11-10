import { canonicalMathJson, mathDigest } from '../math/mathRuntimeIo';
import type { LeanStatementContext } from '../math/leanStatementContext';
import type { LeanStatementKernelName } from '../math/leanStatementSemantic';
import { isSimpleLeanName } from '../math/leanSyntax';

export const SHARED_FORMALIZATION_CONTEXT_PROTOCOL = [
  'The turn may supply theorem-os.formalization-shared-context.v1 instead of literal INPUT.json bytes.',
  'This is a lossless JSON representation of the complete frozen input: input is the root, and an object with exactly one key "$ref" and integer value i means dictionary[i]. Apply this substitution recursively, including inside dictionary entries; entries only refer to earlier entries. All other objects, arrays, strings and scalar values retain their exact meaning and order.',
  'Resolve a reference wherever it appears before interpreting that field. Shared entries are identical observations, not omitted context or semantic approval. Use all supplied observations. The host has expanded this representation and checked byte-for-byte equality with canonical INPUT.json.',
  'canonicalInputSha256 binds the original INPUT.json bytes; it is transport metadata, not the inputDigest or snapshotDigest required in your output. Read those binding values from the represented input. You may use the complete shared representation directly without rereading INPUT.json or printing expanded duplicate observations.',
].join('\n');

export const FOCUSED_FORMALIZATION_CONTEXT_PROTOCOL = [
  'The turn may supply theorem-os.formalization-review-context.v3, a reading view of the complete frozen INPUT.json, not a replacement snapshot or a semantic verdict.',
  'Read packet.input as the role input. It preserves the complete task data, source, environment, identity fields, every target and its full type, bindings, references, omitted list and semantic context, including rawType, kernelType and every localMeaningClosure type/value. Inspect all these target and local-definition observations.',
  'Only imported-library context.constants and context.structures are organized under context.importedLibrary. Each collection gives its exact INPUT.json inputPath, original count and directEntries. Each direct entry maps original index to catalogIndex: read packet.libraryCatalog.constants[catalogIndex] or packet.libraryCatalog.structures[catalogIndex], the complete original record at inputPath[index]. Records are shared only when their complete original contents are identical. This shares observations, not target meanings or review judgments.',
  'Every exported imported constant or structure directly used by a target kernel type or local closure type/value has its complete record inline. importedLibrary.unavailableDirectNames, when present, lists direct names already recorded in the unchanged context.omitted whose records were not exported. They remain unavailable observations: inspect the exact pinned-library declaration before relying on an unfamiliar meaning, and use unknown if a necessary fact remains unresolved. Do not treat these names as inspected or reconstruct missing records. Other exported imported records remain in the full INPUT.json collection at inputPath, with count entries; their names and details are not listed here. They are deferred, not empty, absent or already checked. This changes reading presentation, not context.omitted or the original export. When a definition refers to an unfamiliar imported dependency, find that exact name in the original collection and read its complete record.',
  'Inspect the actual constant and instance arguments in the complete kernel observations. Read the relevant indexed imported records before relying on an unfamiliar definition, an instance or topology choice, a structure-strength or parent-projection fact, or a representation or boundary-case conversion. Read all fields of a relevant structure before deciding that its hypotheses are missing or redundant. Do not claim to have inspected deferred fields without reading them; use unknown if a necessary fact remains unresolved.',
  'Imported dependencies that only implement an already understood pinned-library operation need not all be unfolded. Every local definition and all target semantics remain mandatory. The complete original INPUT.json is available for any additional inspection; reuse inline observations instead of rereading them.',
  'canonicalInputSha256 binds the unchanged INPUT.json bytes. Copy output caseId/inputDigest/snapshotDigest from the represented role input or supplied output schema, never from this transport hash. The full original input and the original output validators remain authoritative.',
].join('\n');

/** Only simple names are rendered here; other names keep the existing full-input path. */
function observedKernelName(root: LeanStatementKernelName): string | undefined {
  const parts: string[] = [];
  let name = root;
  while (name !== null) {
    if (name[0] !== 'str' || name[2].includes('.') || !isSimpleLeanName(name[2])) return;
    parts.push(name[2]); name = name[1];
  }
  return parts.reverse().join('.');
}

function directKernelConstants(context: LeanStatementContext): { names: Set<string>; unavailable: string[] } | undefined {
  if (!context.semantic || !context.bindings || !context.references || !context.structures) return;
  const names = new Set<string>(), stack: unknown[] = [context.semantic.kernelType,
    ...context.semantic.localMeaningClosure.flatMap(entry => [entry.type, ...(entry.value ? [entry.value] : [])])];
  while (stack.length) {
    const value = stack.pop();
    if (!Array.isArray(value)) continue;
    if (value[0] === 'const' || value[0] === 'projection') {
      const name = observedKernelName(value[1] as LeanStatementKernelName);
      if (name === undefined) return;
      names.add(name);
    }
    stack.push(...value.filter(Array.isArray));
  }
  const observed = new Set([...context.constants.map(entry => entry.name),
    ...context.structures.entries.map(entry => entry.name), ...context.semantic.localMeaningClosure.map(entry => entry.name)]);
  const unavailable = [...names].filter(name => !observed.has(name)).sort();
  if (unavailable.some(name => !context.omitted.includes(name))) return;
  return { names, unavailable };
}

/** Keep complete target/local meaning inline; index transitive imported details in the unchanged file. */
export function focusFormalizationContext(inputText: string, role: 'backtranslate' | 'compare'): string | undefined {
  if (Buffer.byteLength(inputText) <= 64 * 1024) return;
  const input = JSON.parse(inputText), snapshot = role === 'backtranslate' ? input : input.observation?.snapshot;
  if (!snapshot?.targets?.length) return;
  const root = role === 'backtranslate' ? '$' : '$.observation.snapshot';
  const libraryCatalog = { constants: [] as unknown[], structures: [] as unknown[] };
  const catalogIndices = { constants: new Map<string, number>(), structures: new Map<string, number>() };
  const recordIndex = (kind: keyof typeof libraryCatalog, full: unknown) => {
    const key = canonicalMathJson(full), prior = catalogIndices[kind].get(key);
    if (prior !== undefined) return prior;
    const index = libraryCatalog[kind].push(full) - 1;
    catalogIndices[kind].set(key, index);
    return index;
  };
  for (const [targetIndex, target] of snapshot.targets.entries()) {
    const context = target.context as LeanStatementContext, direct = directKernelConstants(context);
    if (!direct) return;
    const { constants, structures, ...complete } = context;
    const base = `${root}.targets[${targetIndex}].context`;
    target.context = { ...complete, importedLibrary: {
      ...(direct.unavailable.length ? { unavailableDirectNames: direct.unavailable } : {}),
      constants: { inputPath: base + '.constants', count: constants.length,
        directEntries: constants.flatMap((entry, index) => direct.names.has(entry.name) ?
          [{ index, catalogIndex: recordIndex('constants', entry) }] : []) },
      structures: { schema: structures!.schema, inputPath: base + '.structures.entries', count: structures!.entries.length,
        directEntries: structures!.entries.flatMap((entry, index) => direct.names.has(entry.name) ?
          [{ index, catalogIndex: recordIndex('structures', entry) }] : []) },
    } };
  }
  return canonicalMathJson({ schema: 'theorem-os.formalization-review-context.v3',
    canonicalInputSha256: mathDigest(inputText), input, libraryCatalog });
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Share identical JSON values only; the frozen input and its evidence digest do not change. */
export function shareFormalizationContext(inputText: string): string | undefined {
  if (Buffer.byteLength(inputText) <= 64 * 1024) return;
  const input = JSON.parse(inputText) as Json;
  const counts = new Map<string, number>();
  let reservedKey = false;
  const visit = (value: Json): void => {
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) >= 96) counts.set(text, (counts.get(text) ?? 0) + 1);
    if (value && typeof value === 'object') {
      if (!Array.isArray(value) && Object.hasOwn(value, '$ref')) reservedKey = true;
      for (const child of Object.values(value)) visit(child);
    }
  };
  visit(input);
  // A literal reserved key uses the existing raw-input path, with no escaping language.
  if (reservedKey) return;
  let dictionary: Json[] = [];
  const indices = new Map<string, number>();
  const children = (value: Json): Json => Array.isArray(value) ? value.map(encode) :
    value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, encode(child)])) : value;
  const encode = (value: Json): Json => {
    const text = JSON.stringify(value);
    if ((counts.get(text) ?? 0) < 2) return children(value);
    let index = indices.get(text);
    if (index === undefined) {
      const entry = children(value);
      index = dictionary.length;
      dictionary.push(entry); indices.set(text, index);
    }
    return { $ref: index };
  };
  let root = encode(input);
  // Sharing a parent can leave its children transmitted only once. Inline those
  // children so the model need not resolve references that save no repetition.
  const uses = dictionary.map(() => 0);
  const countReferences = (value: Json): void => {
    if (value && typeof value === 'object') {
      if (!Array.isArray(value) && Object.hasOwn(value, '$ref')) uses[value.$ref as number]!++;
      else for (const child of Object.values(value)) countReferences(child);
    }
  };
  for (const entry of [...dictionary, root]) countReferences(entry);
  const replacements: Json[] = [], shared: Json[] = [];
  const replace = (value: Json): Json => Array.isArray(value) ? value.map(replace) :
    value && typeof value === 'object' ? Object.hasOwn(value, '$ref') ? replacements[value.$ref as number]! :
      Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replace(child)])) : value;
  for (const [index, entry] of dictionary.entries()) {
    const value = replace(entry);
    replacements.push(uses[index]! > 1 ? { $ref: shared.push(value) - 1 } : value);
  }
  root = replace(root); dictionary = shared;
  const packed = canonicalMathJson({ schema: 'theorem-os.formalization-shared-context.v1',
    canonicalInputSha256: mathDigest(inputText), dictionary, input: root });
  if (Buffer.byteLength(packed) + Buffer.byteLength(SHARED_FORMALIZATION_CONTEXT_PROTOCOL) >= Buffer.byteLength(inputText) * 0.8) return;

  const expanded: Json[] = [];
  const expand = (value: Json): Json => {
    if (Array.isArray(value)) return value.map(expand);
    if (value && typeof value === 'object') {
      if (Object.keys(value).length === 1 && Object.hasOwn(value, '$ref')) {
        const index = value.$ref;
        if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || index >= expanded.length)
          throw new Error('formalization_context_reference_invalid');
        return expanded[index]!;
      }
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, expand(child)]));
    }
    return value;
  };
  for (const entry of dictionary) expanded.push(expand(entry));
  if (canonicalMathJson(expand(root)) !== inputText) throw new Error('formalization_context_roundtrip_mismatch');
  return packed;
}
