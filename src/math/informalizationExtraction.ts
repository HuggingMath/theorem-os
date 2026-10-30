import { z } from 'zod';
import { isSimpleLeanName } from './leanSyntax';

/**
 * Host-side declaration outline of a checked Lean proof (lean-proof-informalization-v1).
 *
 * A Lean command in a fresh project imports the proof module and reads the
 * elaborated environment, never the source text: every non-auxiliary declaration
 * of the proof modules with a declaration range is a unit; compiler auxiliaries
 * (proof_n, match_n, equation lemmas) are expanded into the unit that uses them,
 * and a candidate inside the range of its name prefix (a where clause) belongs to
 * that prefix. For each unit reachable from the target the command records the
 * owned units its statement and its proof term use, the external constants they
 * use, its pretty-printed signature and its range. collectAxioms of the target
 * exposes sorryAx and any other trust escape. The result file carries a host nonce
 * so a proof module cannot forge it.
 */

export const INFORMALIZATION_EXTRACTION_PROTOCOL = 'lean-declaration-outline-v1';
const limits = { maxUnits: 2000, maxExternal: 4000, maxLibrary: 2000, maxSignature: 800, maxUnitSignature: 16_000 };

const leanString = (value: string) => JSON.stringify(value);

/** One command reading the environment; the proof modules must already compile. */
export function informalizationExtractionQuery(input: { nonce: string; rootModule: string; modules: readonly string[]; target: string }) {
  const { nonce, rootModule, modules, target } = input;
  if (!/^[a-f0-9]{32}$/u.test(nonce)) throw new Error('informalization_extraction_nonce_invalid');
  if (![rootModule, target, ...modules].every(name => isSimpleLeanName(name)) || !modules.includes(rootModule))
    throw new Error('informalization_extraction_name_invalid');
  const output = `.lake/informalization-${nonce}.json`;
  const query = [
    'import Lean', `import ${rootModule}`, '',
    `namespace TheoremOSInformalization_${nonce}`,
    'open Lean Elab Command Meta', '',
    'def tosUnitCandidate (env : Environment) (n : Name) : ConstantInfo → Bool',
    '  | .thmInfo _ | .defnInfo _ | .inductInfo _ | .opaqueInfo _ | .axiomInfo _ =>',
    '    !(privateToUserName n).isInternal && !isReservedName env n && !isAuxRecursor env n && !isNoConfusion env n &&',
    '      !isMatcherCore env n && !env.isProjectionFn n',
    '  | _ => false', '',
    'def tosCitable (env : Environment) (n : Name) : ConstantInfo → Bool',
    '  | .thmInfo _ | .defnInfo _ | .inductInfo _ | .ctorInfo _ | .opaqueInfo _ | .axiomInfo _ =>',
    '    !isPrivateName n && !n.isInternal && !isReservedName env n && !isAuxRecursor env n && !isNoConfusion env n &&',
    '      !isMatcherCore env n && !isInstanceCore env n',
    '  | _ => false', '',
    'def tosKind (env : Environment) (n : Name) : ConstantInfo → String',
    '  | .thmInfo _ => if isInstanceCore env n then "instance" else "theorem"',
    '  | .defnInfo _ => if isInstanceCore env n then "instance" else "definition"',
    '  | .opaqueInfo _ => "opaque"',
    '  | .axiomInfo _ => "axiom"',
    '  | .inductInfo _ => if isClass env n then "class" else if isStructure env n then "structure" else "inductive"',
    '  | .ctorInfo _ => "constructor"',
    '  | _ => "other"', '',
    'def tosStatementConstants (env : Environment) : ConstantInfo → Array Name',
    '  | info@(.inductInfo v) => v.ctors.foldl (init := info.type.getUsedConstants) fun acc ctor =>',
    '      match env.find? ctor with',
    '      | some ctorInfo => acc ++ ctorInfo.type.getUsedConstants',
    '      | none => acc',
    '  | info => info.type.getUsedConstants', '',
    'def tosValueConstants (info : ConstantInfo) : Array Name :=',
    '  match info.value? (allowOpaque := true) with',
    '  | some value => value.getUsedConstants',
    '  | none => #[]', '',
    'def tosContains (outer inner : DeclarationRange) : Bool :=',
    '  (outer.pos.line < inner.pos.line || outer.pos.line == inner.pos.line && outer.pos.column ≤ inner.pos.column) &&',
    '    (inner.endPos.line < outer.endPos.line || inner.endPos.line == outer.endPos.line && inner.endPos.column ≤ outer.endPos.column)', '',
    'def tosPrefixIn (set : NameSet) (n : Name) : Option Name := Id.run do',
    '  let mut current := n.getPrefix',
    '  while !current.isAnonymous do',
    '    if set.contains current then return some current',
    '    current := current.getPrefix',
    '  return none', '',
    '/-- Owned units used by `start`, expanding compiler auxiliaries inline, and the external constants. -/',
    'def tosExpand (env : Environment) (owned : Name → Bool) (units candidates : NameSet) (owner : Name → Option Name)',
    '    (self : Name) (start : Array Name) : NameSet × NameSet := Id.run do',
    '  let mut stack := start',
    '  let mut seen : NameSet := {}',
    '  let mut deps : NameSet := {}',
    '  let mut external : NameSet := {}',
    '  while !stack.isEmpty do',
    '    let c := stack.back!',
    '    stack := stack.pop',
    '    if seen.contains c || c == self then continue',
    '    seen := seen.insert c',
    '    if !owned c then',
    '      external := external.insert c',
    '    else if units.contains c then',
    '      deps := deps.insert c',
    '    else',
    '      let attributed := if candidates.contains c then owner c else none',
    '      if let some unit := attributed then',
    '        if unit != self then',
    '          deps := deps.insert unit',
    '          continue',
    '      if let some info := env.find? c then stack := stack ++ info.type.getUsedConstants ++ tosValueConstants info',
    '  return (deps, external)', '',
    'def tosNames (set : NameSet) : Array String :=',
    '  (set.foldl (init := #[]) fun acc n => acc.push n.toString).qsort (· < ·)', '',
    'def tosTruncate (text : String) (limit : Nat) : String :=',
    '  if text.length ≤ limit then text else (text.take limit).toString ++ " …"', '',
    'def tosSignature (n : Name) (limit : Nat) : CommandElabM String := do',
    '  try',
    '    let signature ← liftTermElabM <| PrettyPrinter.ppSignature n',
    '    return tosTruncate (signature.fmt.pretty 100) limit',
    '  catch _ => return n.toString', '',
    'set_option maxHeartbeats 0 in',
    'run_cmd do',
    '  let env ← getEnv',
    `  let target := ${leanString(target)}.toName`,
    `  let modules : Array Name := #[${modules.map(name => leanString(name) + '.toName').join(', ')}]`,
    `  let mut ownedModules : Std.HashSet Nat := {}`,
    '  let mut ranges : NameMap DeclarationRange := {}',
    '  let mut candidates : NameSet := {}',
    '  for module in modules do',
    '    let some index := env.getModuleIdx? module | throwError "informalization module {module} is not imported"',
    '    ownedModules := ownedModules.insert index.toNat',
    '    for n in env.header.moduleData[index.toNat]!.constNames do',
    '      let some info := env.find? n | continue',
    '      unless tosUnitCandidate env n info do continue',
    '      let some range ← findDeclarationRanges? n | continue',
    '      ranges := ranges.insert n range.range',
    '      candidates := candidates.insert n',
    '  let owned := fun (n : Name) => match env.getModuleIdxFor? n with',
    '    | some index => ownedModules.contains index.toNat',
    '    | none => false',
    '  let units := candidates.foldl (init := ({} : NameSet)) fun acc n =>',
    '    match tosPrefixIn candidates n with',
    '    | some parent => if tosContains (ranges.get! parent) (ranges.get! n) then acc else acc.insert n',
    '    | none => acc.insert n',
    '  let owner := tosPrefixIn units',
    '  let some targetInfo := env.find? target | throwError "informalization target is missing"',
    '  unless targetInfo matches .thmInfo _ do throwError "informalization target is not a theorem"',
    '  unless units.contains target do throwError "informalization target is not a declaration of the proof modules"',
    '  let mut queue := #[target]',
    '  let mut done : NameSet := {}',
    '  let mut records : Array Json := #[]',
    '  let mut library : NameSet := {}',
    '  while !queue.isEmpty do',
    '    let unit := queue.back!',
    '    queue := queue.pop',
    '    if done.contains unit then continue',
    '    done := done.insert unit',
    `    if done.size > ${limits.maxUnits} then throwError "informalization closure exceeds ${limits.maxUnits} declarations"`,
    '    let info := (env.find? unit).get!',
    '    let (statementDeps, statementExternal) := tosExpand env owned units candidates owner unit (tosStatementConstants env info)',
    '    let (proofDeps, proofExternal) := tosExpand env owned units candidates owner unit (tosValueConstants info)',
    '    let external := (statementExternal.foldl (init := proofExternal) fun acc n => acc.insert n).foldl',
    '      (init := ({} : NameSet)) fun acc n => match env.find? n with',
    '        | some externalInfo => if tosCitable env n externalInfo then acc.insert n else acc',
    '        | none => acc',
    '    let externalNames := tosNames external',
    '    for n in external do library := library.insert n',
    '    for n in statementDeps do queue := queue.push n',
    '    for n in proofDeps do queue := queue.push n',
    '    let range := ranges.get! unit',
    '    let module := (env.getModuleIdxFor? unit).map fun index => env.header.moduleNames[index.toNat]!',
    `    let signature ← tosSignature unit ${limits.maxUnitSignature}`,
    '    records := records.push <| Json.mkObj [',
    '      ("name", toJson unit.toString), ("displayName", toJson (privateToUserName unit).toString),',
    '      ("kind", toJson (tosKind env unit info)), ("module", toJson (module.map Name.toString)),',
    '      ("range", Json.mkObj [("line", toJson range.pos.line), ("column", toJson range.pos.column),',
    '        ("endLine", toJson range.endPos.line), ("endColumn", toJson range.endPos.column)]),',
    '      ("signature", toJson signature),',
    '      ("statementDependencies", toJson (tosNames statementDeps)), ("proofDependencies", toJson (tosNames proofDeps)),',
    `      ("external", toJson (externalNames.extract 0 ${limits.maxExternal})),`,
    `      ("externalTruncated", toJson (decide (externalNames.size > ${limits.maxExternal})))]`,
    '  let libraryNames := (library.foldl (init := #[]) fun acc n => acc.push n).qsort (·.toString < ·.toString)',
    '  let mut libraryRecords : Array Json := #[]',
    `  for n in libraryNames.extract 0 ${limits.maxLibrary} do`,
    '    let some info := env.find? n | continue',
    '    let module := (env.getModuleIdxFor? n).map fun index => env.header.moduleNames[index.toNat]!',
    `    let signature ← tosSignature n ${limits.maxSignature}`,
    '    libraryRecords := libraryRecords.push <| Json.mkObj [("name", toJson n.toString), ("kind", toJson (tosKind env n info)),',
    '      ("module", toJson (module.map Name.toString)), ("signature", toJson signature)]',
    '  let axioms ← liftCoreM <| collectAxioms target',
    `  let report := Json.mkObj [("nonce", toJson ${leanString(nonce)}), ("target", toJson target.toString),`,
    '    ("axioms", toJson ((axioms.map Name.toString).qsort (· < ·))), ("units", Json.arr records),',
    `    ("library", Json.arr libraryRecords), ("libraryTruncated", toJson (decide (libraryNames.size > ${limits.maxLibrary})))]`,
    `  liftCoreM <| Core.liftIOCore <| IO.FS.writeFile ${leanString(output)} report.compress`, '',
    `end TheoremOSInformalization_${nonce}`, '',
  ].join('\n');
  return { query, resultFile: output };
}

export const INFORMALIZATION_GOALS_PROTOCOL = 'lean-tactic-goals-v1';
const goalLimits = { maxGoals: 4, maxGoalText: 3000, maxRecords: 20_000, maxFileText: 16_000_000, maxUnitBytes: 48_000, maxTactic: 200 };
// Nodes that group or focus tactics (sequences, `by`, `·`, `case`, rewrite rules); their goals repeat those of the
// tactics inside them, and a bullet's goals list the cases it does not focus.
const GOAL_WRAPPERS = ['null', 'Lean.Parser.Term.byTactic', 'Lean.Parser.Tactic.tacticSeq', 'Lean.Parser.Tactic.tacticSeq1Indented',
  'Lean.Parser.Tactic.tacticSeqBracketed', 'Lean.cdot', 'Lean.cdotTk', 'Lean.Parser.Tactic.case', 'Lean.calcSteps'];

/**
 * One command that elaborates a proof file again, with info trees on, and records the goals before and after each
 * tactic as written. The header is processed as the frontend processes it. The command exits after writing, because
 * the nested import registers linters and environment extensions that the query's own environment lacks.
 */
export function informalizationGoalsQuery(input: { nonce: string; module: string; file: string; index: number }) {
  const { nonce, module, file, index } = input;
  if (!/^[a-f0-9]{32}$/u.test(nonce)) throw new Error('informalization_extraction_nonce_invalid');
  if (!isSimpleLeanName(module) || !/^[^/\0"\\][^\0"\\]*\.lean$/u.test(file) || file.split('/').includes('..') ||
      !Number.isSafeInteger(index) || index < 0)
    throw new Error('informalization_extraction_name_invalid');
  const output = `.lake/informalization-goals-${nonce}-${index}.json`;
  const query = [
    'import Lean', '',
    `namespace TheoremOSInformalizationGoals_${nonce}`,
    'open Lean Elab Meta', '',
    'def tosClip (text : String) (limit : Nat) : String :=',
    '  if text.length ≤ limit then text else (text.take limit).toString ++ " …"', '',
    'def tosGoals (ci : ContextInfo) (mctx : MetavarContext) (goals : List MVarId) : IO (Array String) := do',
    '  let ci := { ci with mctx }',
    '  let mut out := #[]',
    `  for goal in goals.take ${goalLimits.maxGoals} do`,
    '    let text ← try ci.runMetaM {} (do return (← ppGoal goal).pretty 100) catch _ => pure "<unprintable goal>"',
    `    out := out.push (tosClip text ${goalLimits.maxGoalText})`,
    '  return out', '',
    `def tosWrappers : List Name := [${GOAL_WRAPPERS.map(kind => '`' + kind).join(', ')}]`, '',
    'def tosTactics (trees : Array InfoTree) : Array (ContextInfo × TacticInfo) :=',
    '  trees.foldl (init := #[]) fun acc tree => tree.foldInfo (init := acc) fun ci info acc =>',
    '    match info with',
    '    | .ofTacticInfo ti => if ti.stx.isAtom || tosWrappers.contains ti.stx.getKind then acc else acc.push (ci, ti)',
    '    | _ => acc', '',
    'def tosRun (nonce module file output : String) : IO Unit := do',
    '  let base := [("nonce", toJson nonce), ("module", toJson module)]',
    '  try',
    '    let input ← IO.FS.readFile file',
    '    let inputCtx := Parser.mkInputContext input file',
    '    let (header, parserState, messages) ← Parser.parseHeader inputCtx',
    '    unsafe enableInitializersExecution',
    '    let (env, messages) ← processHeader header {} messages inputCtx (trustLevel := 1024) (mainModule := module.toName)',
    '    let commandState := { Command.mkState env messages {} with infoState := { enabled := true } }',
    '    let state ← IO.processCommands inputCtx parserState commandState',
    '    let messages := state.commandState.messages',
    '    if messages.hasErrors then',
    '      let text ← match messages.toList.find? (fun message => message.severity == .error) with',
    '        | some message => message.toString',
    '        | none => pure ""',
    '      throw <| IO.userError s!"the proof did not elaborate again: {text}"',
    '    let mut records : Array Json := #[]',
    '    let mut size := 0',
    '    let mut truncated := false',
    '    for (ci, ti) in tosTactics state.commandState.infoState.trees.toArray do',
    '      let some start := ti.stx.getPos? (canonicalOnly := true) | continue',
    '      let some stop := ti.stx.getTailPos? (canonicalOnly := true) | continue',
    `      if records.size ≥ ${goalLimits.maxRecords} || size > ${goalLimits.maxFileText} then`,
    '        truncated := true',
    '        break',
    '      let before ← tosGoals ci ti.mctxBefore ti.goalsBefore',
    '      let after ← tosGoals ci ti.mctxAfter ti.goalsAfter',
    '      size := size + before.foldl (· + ·.length) 0 + after.foldl (· + ·.length) 0',
    '      let p := inputCtx.fileMap.toPosition start',
    '      let q := inputCtx.fileMap.toPosition stop',
    '      records := records.push <| Json.mkObj [',
    '        ("range", Json.mkObj [("line", toJson p.line), ("column", toJson p.column),',
    '          ("endLine", toJson q.line), ("endColumn", toJson q.column)]),',
    '        ("before", toJson before), ("beforeCount", toJson ti.goalsBefore.length),',
    '        ("after", toJson after), ("afterCount", toJson ti.goalsAfter.length)]',
    '    IO.FS.writeFile output (Json.mkObj (base ++ [("truncated", toJson truncated), ("tactics", Json.arr records)])).compress',
    '  catch error =>',
    '    IO.FS.writeFile output (Json.mkObj (base ++ [("error", toJson (tosClip (toString error) 4000))])).compress',
    '  IO.Process.exit 0', '',
    'set_option maxHeartbeats 0 in',
    `#eval tosRun ${[nonce, module, file, output].map(leanString).join(' ')}`, '',
    `end TheoremOSInformalizationGoals_${nonce}`, '',
  ].join('\n');
  return { query, resultFile: output };
}
const name = z.string().min(1).max(4096);
const range = z.object({ line: z.number().int().positive(), column: z.number().int().nonnegative(),
  endLine: z.number().int().positive(), endColumn: z.number().int().nonnegative() }).strict();
export const informalizationUnitKindSchema = z.enum(['theorem', 'definition', 'instance', 'opaque', 'axiom', 'inductive', 'structure', 'class']);
export type InformalizationUnitKind = z.infer<typeof informalizationUnitKindSchema>;
const reportSchema = z.object({
  nonce: z.string().regex(/^[a-f0-9]{32}$/u), target: name, axioms: z.array(name).max(4096),
  units: z.array(z.object({
    name, displayName: name, kind: informalizationUnitKindSchema, module: name, range, signature: z.string().min(1).max(64_000),
    statementDependencies: z.array(name).max(limits.maxUnits), proofDependencies: z.array(name).max(limits.maxUnits),
    external: z.array(name).max(limits.maxExternal), externalTruncated: z.boolean(),
  }).strict()).min(1).max(limits.maxUnits),
  library: z.array(z.object({ name, kind: z.enum([...informalizationUnitKindSchema.options, 'constructor', 'other']),
    module: name.nullable(), signature: z.string().min(1).max(4096) }).strict()).max(limits.maxLibrary),
  libraryTruncated: z.boolean(),
}).strict();
// Lean clips by codepoints; a codepoint is at most two UTF-16 units.
const utf16Bound = (codepoints: number) => 2 * (codepoints + 2);
const goalText = z.string().max(utf16Bound(goalLimits.maxGoalText));
/** A goals query wrote either an error or its tactics. */
const goalsReportSchema = z.object({ nonce: z.string(), module: name, error: z.string().max(utf16Bound(4000)).optional(),
  truncated: z.boolean().optional(),
  tactics: z.array(z.object({ range, before: z.array(goalText).max(goalLimits.maxGoals), beforeCount: z.number().int().nonnegative(),
    after: z.array(goalText).max(goalLimits.maxGoals), afterCount: z.number().int().nonnegative() }).strict())
    .max(goalLimits.maxRecords).optional(),
}).strict().refine(value => value.error === undefined ? value.tactics !== undefined && value.truncated !== undefined :
  value.tactics === undefined && value.truncated === undefined);
const unitGoalsSchema = z.object({
  /** Entries were dropped for size, nested tactics first, or the file's query stopped early. */ truncated: z.boolean(),
  /** One entry per tactic as written, in source order; at most 4 goals per state, beforeCount/afterCount give all. */
  tactics: z.array(z.object({ range, tactic: z.string(), before: z.array(z.string()), beforeCount: z.number().int().nonnegative(),
    after: z.array(z.string()), afterCount: z.number().int().nonnegative() }).strict()),
}).strict();
const unitSchema = z.object({
  /** User-facing full name (private prefixes removed); the protocol identifier. */
  name, leanName: name, kind: informalizationUnitKindSchema, module: name, file: name, range,
  source: z.string().min(1), signature: z.string().min(1),
  statementDependencies: z.array(name), proofDependencies: z.array(name),
  external: z.array(name), externalTruncated: z.boolean(),
  /** Present when the goals query covered this unit's file; absent in outlines made before it existed. */
  goals: unitGoalsSchema.optional(),
}).strict();
export const informalizationOutlineSchema = z.object({
  schema: z.literal('theorem-os.informalization-outline.v1'), protocol: z.literal(INFORMALIZATION_EXTRACTION_PROTOCOL),
  target: name, axioms: z.array(name), cyclic: z.boolean(),
  /** Dependency order (ties in source order); the target is last. */
  units: z.array(unitSchema).min(1),
  library: reportSchema.shape.library, libraryTruncated: z.boolean(),
  /** Advisory goal states; a failed goals query never fails the extraction. */
  goalStates: z.object({ protocol: z.literal(INFORMALIZATION_GOALS_PROTOCOL), status: z.enum(['complete', 'truncated', 'unavailable']),
    reason: z.string().max(utf16Bound(4000)).optional() }).strict().optional(),
}).strict();
export type InformalizationOutline = z.infer<typeof informalizationOutlineSchema>;
export type InformalizationUnit = InformalizationOutline['units'][number];

/** Lean columns count codepoints; Lean reads sources with normalized line endings. */
const sourceLines = (text: string) => text.replaceAll('\r\n', '\n').split('\n').map(line => [...line]);
function rangeLines(lines: readonly string[][], value: z.infer<typeof range>) {
  const first = lines[value.line - 1], last = lines[value.endLine - 1];
  if (!first || !last || value.endLine < value.line || value.column > first.length || value.endColumn > last.length ||
      value.line === value.endLine && value.endColumn < value.column)
    throw new Error('informalization_declaration_range_invalid');
  return { first, last };
}
export function leanSourceSlice(text: string, value: z.infer<typeof range>): string {
  const lines = sourceLines(text), { first, last } = rangeLines(lines, value);
  if (value.line === value.endLine) return first.slice(value.column, value.endColumn).join('');
  return [first.slice(value.column).join(''), ...lines.slice(value.line, value.endLine - 1).map(line => line.join('')),
    last.slice(0, value.endColumn).join('')].join('\n');
}

/**
 * Validate the nonce-bound report against the frozen sources and order the units.
 * sorryAx in the target's axioms, or an axiom declared by the proof, refuses the proof.
 */
export function informalizationOutline(report: unknown, input: { nonce: string; target: string;
  sources: readonly { module: string; file: string; text: string }[] }): InformalizationOutline {
  const parsed = reportSchema.parse(report);
  if (parsed.nonce !== input.nonce || parsed.target !== input.target) throw new Error('informalization_extraction_report_invalid');
  if (parsed.axioms.includes('sorryAx')) throw new Error('informalization_proof_incomplete: the target depends on sorryAx');
  const assumed = parsed.units.filter(unit => unit.kind === 'axiom');
  if (assumed.length) throw new Error('informalization_proof_assumes_axiom: ' + assumed.map(unit => unit.displayName).join(', '));
  const display = new Map<string, string>();
  for (const unit of parsed.units) {
    if (display.has(unit.name) || [...display.values()].includes(unit.displayName))
      throw new Error('informalization_declaration_name_ambiguous: ' + unit.displayName);
    display.set(unit.name, unit.displayName);
  }
  const target = parsed.units.find(unit => unit.name === input.target);
  if (!target || target.kind !== 'theorem') throw new Error('informalization_extraction_report_invalid');
  const sources = new Map(input.sources.map((source, index) => [source.module, { ...source, index }]));
  const rename = (names: readonly string[]) => names.map(item => {
    const mapped = display.get(item);
    if (mapped === undefined) throw new Error('informalization_extraction_report_invalid');
    return mapped;
  }).toSorted();
  const units: InformalizationUnit[] = parsed.units.map(unit => {
    const source = sources.get(unit.module);
    if (!source) throw new Error('informalization_declaration_outside_sources: ' + unit.displayName);
    const text = leanSourceSlice(source.text, unit.range);
    if (!text.trim()) throw new Error('informalization_declaration_range_invalid');
    return { name: unit.displayName, leanName: unit.name, kind: unit.kind, module: unit.module, file: source.file, range: unit.range,
      source: text, signature: unit.signature, statementDependencies: rename(unit.statementDependencies),
      proofDependencies: rename(unit.proofDependencies), external: unit.external, externalTruncated: unit.externalTruncated };
  });
  const position = (unit: InformalizationUnit) => [sources.get(unit.module)!.index, unit.range.line, unit.range.column];
  const compare = (a: InformalizationUnit, b: InformalizationUnit) => {
    const [x, y] = [position(a), position(b)];
    return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;
  };
  // Kahn order with source-position ties. Mutual recursion releases its earliest member.
  const byName = new Map(units.map(unit => [unit.name, unit]));
  const dependencies = new Map(units.map(unit => [unit.name, new Set([...unit.statementDependencies, ...unit.proofDependencies])]));
  const dependents = new Map<string, string[]>();
  for (const [unit, items] of dependencies) for (const item of items) dependents.set(item, [...dependents.get(item) ?? [], unit]);
  const pending = new Map([...dependencies].map(([unit, items]) => [unit, items.size]));
  const placed = new Set<string>(), ordered: InformalizationUnit[] = [];
  const ready = units.filter(unit => pending.get(unit.name) === 0);
  let cyclic = false;
  while (ordered.length < units.length) {
    if (!ready.length) {
      cyclic = true;
      const open = units.filter(unit => !placed.has(unit.name)).toSorted(compare);
      ready.push(open.find(unit => unit.name !== target.displayName) ?? open[0]!);
    }
    ready.sort(compare);
    const next = ready.shift()!;
    if (placed.has(next.name)) continue;
    placed.add(next.name); ordered.push(next);
    for (const item of dependents.get(next.name) ?? []) {
      const count = pending.get(item)! - 1;
      pending.set(item, count);
      if (count <= 0 && !placed.has(item)) ready.push(byName.get(item)!);
    }
  }
  const targetUnit = byName.get(target.displayName)!;
  return { schema: 'theorem-os.informalization-outline.v1', protocol: INFORMALIZATION_EXTRACTION_PROTOCOL,
    target: target.displayName, axioms: parsed.axioms, cyclic,
    units: [...ordered.filter(unit => unit !== targetUnit), targetUnit],
    library: parsed.library, libraryTruncated: parsed.libraryTruncated };
}

type GoalRange = z.infer<typeof range>;
const rangeOrder = (a: GoalRange, b: GoalRange) => a.line - b.line || a.column - b.column;
const rangeKey = (value: GoalRange) => `${value.line}:${value.column}-${value.endLine}:${value.endColumn}`;
const encloses = (outer: GoalRange, inner: GoalRange) =>
  (outer.line < inner.line || outer.line === inner.line && outer.column <= inner.column) &&
  (inner.endLine < outer.endLine || inner.endLine === outer.endLine && inner.endColumn <= outer.endColumn);
/** One file's goals query: the report it wrote, or why there is none. */
export type InformalizationGoalsResult = { module: string; report: unknown } | { module: string; failure: string };

/**
 * Attach each file's tactic goals to the smallest unit enclosing them. A unit of a file whose query failed has no goals;
 * a unit over the size budget keeps its outermost tactics first, so a long proof keeps its top-level steps.
 */
export function attachInformalizationGoals(outline: InformalizationOutline, results: readonly InformalizationGoalsResult[],
  input: { nonce: string; sources: readonly { module: string; text: string }[] }): InformalizationOutline {
  const failures: string[] = [], tactics = new Map<string, Map<InformalizationUnit, z.infer<typeof unitGoalsSchema>['tactics']>>();
  const stopped = new Set<string>();
  for (const source of input.sources) {
    const result = results.find(item => item.module === source.module);
    if (!result) { failures.push(`${source.module}: informalization_goals_not_run`); continue; }
    if ('failure' in result) { failures.push(`${source.module}: ${result.failure}`); continue; }
    const parsed = goalsReportSchema.safeParse(result.report);
    if (!parsed.success || parsed.data.nonce !== input.nonce || parsed.data.module !== source.module) {
      failures.push(`${source.module}: informalization_goals_report_invalid`); continue;
    }
    const report = parsed.data;
    if (report.error !== undefined || !report.tactics) { failures.push(`${source.module}: ${report.error}`); continue; }
    const lines = sourceLines(source.text), units = outline.units.filter(unit => unit.module === source.module);
    const assigned = new Map(units.map(unit => [unit, [] as z.infer<typeof unitGoalsSchema>['tactics']]));
    try {
      for (const record of report.tactics) {
        if (record.before.length !== Math.min(record.beforeCount, goalLimits.maxGoals) ||
            record.after.length !== Math.min(record.afterCount, goalLimits.maxGoals)) throw new Error('informalization_goals_report_invalid');
        const { first } = rangeLines(lines, record.range);
        let owner: InformalizationUnit | undefined;
        for (const unit of units)
          if (encloses(unit.range, record.range) && (!owner || encloses(owner.range, unit.range))) owner = unit;
        if (!owner) continue;
        const line = first.slice(record.range.column, record.range.line === record.range.endLine ? record.range.endColumn : undefined);
        const text = [...line.join('').trim()];
        const tactic = text.length > goalLimits.maxTactic ? text.slice(0, goalLimits.maxTactic).join('') + ' …' : text.join('');
        assigned.get(owner)!.push({ range: record.range, tactic, before: record.before, beforeCount: record.beforeCount,
          after: record.after, afterCount: record.afterCount });
      }
    } catch { failures.push(`${source.module}: informalization_goals_report_invalid`); continue; }
    if (report.truncated) stopped.add(source.module);
    tactics.set(source.module, assigned);
  }
  const reason = () => [...failures.join('\n')].slice(0, 4000).join('');
  if (!tactics.size)
    return { ...outline, goalStates: { protocol: INFORMALIZATION_GOALS_PROTOCOL, status: 'unavailable', reason: reason() } };
  let truncated = failures.length > 0 || stopped.size > 0;
  const units = outline.units.map(unit => {
    const records = tactics.get(unit.module)?.get(unit);
    if (!records) return unit;
    // Outer tactics first by nesting depth, then source order; identical ranges (`t <;> s` runs s once per goal) once.
    const ordered = records.toSorted((a, b) => rangeOrder(a.range, b.range) ||
      b.range.endLine - a.range.endLine || b.range.endColumn - a.range.endColumn)
      .filter((item, index, all) => !index || rangeKey(all[index - 1]!.range) !== rangeKey(item.range));
    const stack: GoalRange[] = [], depth = ordered.map(item => {
      while (stack.length && !encloses(stack.at(-1)!, item.range)) stack.pop();
      stack.push(item.range);
      return stack.length - 1;
    });
    const rank = ordered.map((_, index) => index).toSorted((a, b) => depth[a]! - depth[b]! || a - b);
    const keep = new Set<number>();
    let bytes = 0;
    for (const index of rank) {
      const item = ordered[index]!, size = Buffer.byteLength(JSON.stringify(item));
      if (bytes + size > goalLimits.maxUnitBytes) continue;
      keep.add(index); bytes += size;
    }
    const cut = keep.size < ordered.length || stopped.has(unit.module);
    truncated ||= cut;
    return { ...unit, goals: { truncated: cut, tactics: ordered.filter((_, index) => keep.has(index)) } };
  });
  return { ...outline, units, goalStates: { protocol: INFORMALIZATION_GOALS_PROTOCOL, status: truncated ? 'truncated' : 'complete',
    ...(failures.length ? { reason: reason() } : {}) } };
}

// Tactic and metaprogramming internals that automation leaves in proof terms; they are
// neither listed to the writer nor citable.
const INCIDENTAL = /^(?:Lean|Mathlib\.Tactic|Mathlib\.Meta|Mathlib\.Util|Aesop|Qq|Batteries\.Tactic|Std\.Tactic|Linarith|Polyrith)(?:\.|$)/u;
export const incidentalLibraryName = (value: string) => INCIDENTAL.test(value);

/** Library theorems used by these units, with their signatures, for the writer and the auditors. */
export function informalizationLibraryContext(outline: InformalizationOutline, units: readonly InformalizationUnit[], max = 400) {
  const used = new Set(units.flatMap(unit => unit.external));
  return outline.library.filter(item => used.has(item.name) && item.kind === 'theorem' && !incidentalLibraryName(item.name))
    .slice(0, max).map(item => ({ name: item.name, module: item.module, signature: item.signature }));
}
