import { getLeanTaskEnvironment, type LeanTaskEnvironment } from './leanTaskEnvironment';

/** Encode data as character codes; caller strings can never introduce Lean commands. */
const leanString = (value: string, environment: LeanTaskEnvironment) =>
  `(${environment === 'mathlib-4.8' ? 'String.mk' : 'String.ofList'} [${[...value].map(character => `Char.ofNat ${character.codePointAt(0)}`).join(', ')}])`;

/** Only constant types and direct field projection types are inspected, never declaration values. */
export function leanLibrarySymbolCommands(names: readonly string[], environment: LeanTaskEnvironment): string {
  getLeanTaskEnvironment(environment);
  if (names.some(name => typeof name !== 'string' || !name.length || Buffer.from(name, 'utf8').toString('utf8') !== name))
    throw new Error('lean_library_symbols_names_invalid');
  return symbolProgram(environment,
    [`  let requested : List String := [${names.map(value => leanString(value, environment)).join(', ')}]`],
    '  Lean.Core.liftIOCore <| IO.FS.writeFile ".lake/library-symbols.json" (Lean.toJson reports).compress');
}

function symbolProgram(environment: LeanTaskEnvironment, requested: string[], result: string): string {
  return [
    'import Lean', ...(environment === 'standard' ? [] : ['import Mathlib']),
    'set_option pp.all true', 'set_option pp.fullNames true', 'set_option pp.explicit true',
    'set_option pp.universes true', 'set_option pp.notation false', 'set_option pp.deepTerms true',
    // 4.8 has no pp.maxSteps option; in 4.33, zero immediately omits the term.
    ...(environment === 'mathlib-4.8' ? [] : ['set_option pp.maxSteps 18446744073709551615']),
    // In 4.8 zero is an immediate recursion error; 4.33 gives zero unlimited semantics.
    `set_option maxRecDepth ${environment === 'mathlib-4.8' ? '18446744073709551615' : '0'}`,
    'run_cmd Lean.Elab.Command.liftTermElabM do',
    '  let renderType := fun (type : Lean.Expr) => do',
    '    if type.hasMVar || type.hasLevelMVar || type.hasFVar || type.hasLooseBVars then',
    '      throwError "Library symbol type is not closed"',
    '    let result := (<- Lean.Meta.ppExpr type).pretty',
    '    if result.isEmpty || result.contains \'⋯\' then',
    '      throwError "Library symbol type export is incomplete"',
    '    pure result',
    '  let env <- Lean.getEnv', '  let mut reports : Array Lean.Json := #[]',
    ...requested,
    '  for requestedName in requested do',
    '    let name := requestedName.toName',
    '    match env.find? name with',
    '    | none => reports := reports.push (Lean.Json.mkObj [("name", Lean.toJson requestedName), ("exists", Lean.toJson false)])',
    '    | some info =>',
    '      let moduleName := match env.getModuleIdxFor? name with',
    '        | some index => env.header.moduleNames[index.toNat]!.toString',
    '        | none => ""',
    '      let kind := match info with',
    '        | .defnInfo _ => "definition" | .thmInfo _ => "theorem" | .opaqueInfo _ => "opaque"',
    '        | .axiomInfo _ => "axiom" | .inductInfo _ => "inductive" | .ctorInfo _ => "constructor"',
    '        | .recInfo _ => "recursor" | .quotInfo _ => "quotient"',
    '      let type <- renderType info.type',
    '      let mut fields : Array Lean.Json := #[]',
    '      if let some structureInfo := Lean.getStructureInfo? env name then',
    '        for field in structureInfo.fieldNames do',
    '          let some fieldInfo := Lean.getFieldInfo? env name field',
    '            | throwError "Library structure field projection is unavailable"',
    '          let fieldType <- renderType (<- Lean.getConstInfo fieldInfo.projFn).type',
    '          fields := fields.push (Lean.Json.mkObj [("name", Lean.toJson fieldInfo.projFn.toString), ("type", Lean.toJson fieldType)])',
    '      reports := reports.push (Lean.Json.mkObj [("name", Lean.toJson requestedName), ("exists", Lean.toJson true),',
    '        ("module", Lean.toJson moduleName), ("kind", Lean.toJson kind), ("class", Lean.toJson (Lean.isClass env name)),',
    '        ("structure", Lean.toJson (Lean.getStructureInfo? env name).isSome), ("type", Lean.toJson type), ("fields", Lean.toJson fields)])',
    result,
  ].join('\n') + '\n';
}

/** Role-local discovery and type inspection, using only the installed Lean environment. */
export function leanLibraryApiProgram(environment: LeanTaskEnvironment): string {
  const config = getLeanTaskEnvironment(environment);
  return symbolProgram(environment, [
    '  let text <- Lean.Core.liftIOCore <| IO.FS.readFile ".lake/library-api-query.json"',
    '  let .ok input := Lean.Json.parse text | throwError "Invalid library API query JSON"',
    '  let .ok names := input.getObjValAs? (Array String) "names" | throwError "Invalid library API names"',
    '  let .ok queries := input.getObjValAs? (Array String) "queries" | throwError "Invalid library API queries"',
    '  let .ok limit := input.getObjValAs? Nat "limit" | throwError "Invalid library API limit"',
    '  let requested := names.toList',
    '  let mut searches : Array Lean.Json := #[]',
    '  for query in queries do',
    '    let term := query.toLower',
    '    let foundNames := env.constants.fold (init := #[]) fun found name _ =>',
    '      if (name.toString.toLower.splitOn term).length > 1 then found.push name else found',
    '    let sorted := foundNames.qsort fun a b =>',
    '      let left := a.toString',
    '      let right := b.toString',
    '      if (left.toLower == term) != (right.toLower == term) then left.toLower == term',
    '      else if left.length != right.length then left.length < right.length else left < right',
    '    let selected := sorted.toList.take limit',
    '    let mut hits : Array Lean.Json := #[]',
    '    for name in selected do',
    '      let some info := env.find? name | throwError "Library discovery entry is unavailable"',
    '      let moduleName := match env.getModuleIdxFor? name with',
    '        | some index => env.header.moduleNames[index.toNat]!.toString',
    '        | none => ""',
    '      let kind := match info with',
    '        | .defnInfo _ => "definition" | .thmInfo _ => "theorem" | .opaqueInfo _ => "opaque"',
    '        | .axiomInfo _ => "axiom" | .inductInfo _ => "inductive" | .ctorInfo _ => "constructor"',
    '        | .recInfo _ => "recursor" | .quotInfo _ => "quotient"',
    '      hits := hits.push (Lean.Json.mkObj [("name", Lean.toJson name.toString),',
    '        ("module", Lean.toJson moduleName), ("kind", Lean.toJson kind),',
    '        ("class", Lean.toJson (Lean.isClass env name)), ("structure", Lean.toJson (Lean.getStructureInfo? env name).isSome)])',
    '    searches := searches.push (Lean.Json.mkObj [("query", Lean.toJson query),',
    '      ("totalMatches", Lean.toJson foundNames.size), ("truncated", Lean.toJson (decide (foundNames.size > limit))),',
    '      ("names", Lean.toJson (selected.map fun name => name.toString)), ("matches", Lean.toJson hits)])',
  ], [
    '  let result := Lean.Json.mkObj [("schema", Lean.toJson "theorem-os.library-api.v2"),',
    '    ("authority", Lean.toJson "advisory-lean-process"),',
    `    ("environment", Lean.toJson ${leanString(environment, environment)}),`,
    `    ("toolchain", Lean.toJson ${leanString(config.toolchain, environment)}),`,
    `    ("environmentDigest", Lean.toJson ${leanString(config.dependencyDigest, environment)}),`,
    `    ("mathlibRevision", ${config.mathlibRevision ? 'Lean.toJson ' + leanString(config.mathlibRevision, environment) : 'Lean.Json.null'}),`,
    '    ("queries", Lean.toJson searches), ("symbols", Lean.toJson reports)]',
    '  Lean.Core.liftIOCore <| IO.FS.writeFile ".lake/library-api.json" result.compress',
  ].join('\n'));
}
