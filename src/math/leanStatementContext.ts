import { z } from 'zod';
import type { LeanDeclarationReferences } from './leanReferences';
import { leanStatementSemanticCommands, leanStatementSemanticSchema, type LeanStatementSemantic } from './leanStatementSemantic';

const structureName = z.string().min(1).max(1000);
export const leanStatementStructuresSchema = z.object({
  schema: z.literal('theorem-os.lean-statement-structures.v1'),
  entries: z.array(z.object({ name: structureName, class: z.boolean(),
    fields: z.array(z.object({ name: structureName,
      type: z.string().min(1).refine(value => value.trim().length > 0 && !value.includes('⋯') && Buffer.byteLength(value) <= 8000),
    }).strict()),
  }).strict()).max(256),
}).strict().superRefine((value, context) => {
  if (new Set(value.entries.map(entry => entry.name)).size !== value.entries.length ||
      value.entries.some(entry => new Set(entry.fields.map(field => field.name)).size !== entry.fields.length))
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate structure or projection name' });
});
export type LeanStatementStructures = z.infer<typeof leanStatementStructuresSchema>;

export type LeanStatementBindings = {
  /** IDs identify telescope positions; display names need not be unique. */
  binders: { id: string; name: string; type: string;
    kind: 'explicit' | 'implicit' | 'strictImplicit' | 'instanceImplicit'; dependencies: string[] }[];
  conclusion: string;
  conclusionDependencies: string[];
};

/** Formal meaning exported from Lean's elaborated type, never from a theorem's proof. */
export type LeanStatementContext = {
  type: string;
  constants: { name: string; module: string; type: string; definition?: string }[];
  omitted: string[];
  /** Independent complete local closure; absent for legacy, unsupported or bounded exports. */
  references?: LeanDeclarationReferences;
  /** Direct free-variable dependencies from the elaborated top-level telescope. */
  bindings?: LeanStatementBindings;
  /** Versioned kernel material; theorem proof terms are excluded. */
  semantic?: LeanStatementSemantic;
  /** Direct fields of the imported structures actually exported in constants. */
  structures?: LeanStatementStructures;
};

/** The type is parsed as one term; the generated declaration exists only in the advisory query. */
export function leanStatementTypeCommands(name: string, type: string) {
  return ['set_option autoImplicit false', 'run_cmd do',
    `  let parsed <- match Lean.Parser.runParserCategory (<- Lean.getEnv) (Lean.Name.mkSimple "term") ${JSON.stringify(type)} with`,
    '    | .ok stx => pure stx', '    | .error message => throwError "{message}"',
    '  let parsed : Lean.TSyntax `term := ⟨parsed⟩',
    `  Lean.Elab.Command.elabCommand (← \`(axiom $(Lean.mkIdent (${JSON.stringify('_root_.' + name)}.toName)) : $parsed))`].join('\n');
}

/** Follow local definitions and two levels of imported definitions; expose all bounds explicitly. */
export function leanStatementContextCommands(roots: readonly { id: string; name: string }[],
  projectModules: readonly { module: string; file: string }[], outputFile: string,
  options?: { omitOversizedType?: boolean; detailedContext?: boolean; semanticContext?: boolean; structureContext?: boolean;
    boundedLibraryContext?: boolean }): string {
  const semanticContext = options?.semanticContext === true || options?.structureContext === true;
  const detailedContext = options?.detailedContext === true || semanticContext;
  return [
    'set_option pp.fullNames true',
    'set_option pp.notation false',
    'set_option pp.proofs false',
    ...(detailedContext ? ['set_option pp.explicit true'] : []),
    'run_cmd Lean.Elab.Command.liftTermElabM do',
    '  let env <- Lean.getEnv',
    `  let localModules : List String := ${JSON.stringify(projectModules.map(item => item.module))}`,
    `  let projectModules : List (String × String) := [${projectModules.map(item => `(${JSON.stringify(item.module)}, ${JSON.stringify(item.file)})`).join(', ')}]`,
    ...(semanticContext ? leanStatementSemanticCommands() : []),
    ...(options?.structureContext === true ? [
      '  let collectStructure (name : Lean.Name) : Lean.Elab.Term.TermElabM (Option Lean.Json) := do',
      '    let some structureInfo := Lean.getStructureInfo? env name | return none',
      '    let mut fields : Array Lean.Json := #[]',
      '    for field in structureInfo.fieldNames do',
      '      let some fieldInfo := Lean.getFieldInfo? env name field',
      '        | throwError "Statement structure projection is unavailable"',
      '      let type := (<- Lean.getConstInfo fieldInfo.projFn).type',
      '      if type.hasMVar || type.hasLevelMVar || type.hasFVar || type.hasLooseBVars then',
      '        throwError "Statement structure field type is not closed"',
      '      let rendered <- Lean.withOptions (fun options =>',
      '        ((((((((options.setBool `pp.all true).setBool `pp.proofs true).setBool `pp.fullNames true).setBool `pp.explicit true).setBool `pp.universes true).setBool `pp.notation false).setBool `pp.deepTerms true).set `pp.maxSteps (18446744073709551615 : Nat)).set `maxRecDepth (18446744073709551615 : Nat)) do',
      '          Lean.Meta.ppExpr type',
      '      let text := rendered.pretty',
      '      if text.isEmpty || text.contains \'⋯\' || text.utf8ByteSize > 8000 then',
      // kernel-v3: Json.null marks an imported structure whose fields cannot be exported within bounds.
      ...(options.boundedLibraryContext === true ? ['        return some Lean.Json.null'] :
        ['        throwError "Statement structure field type export is incomplete or exceeds its export bound"']),
      '      fields := fields.push (Lean.Json.mkObj [("name", Lean.toJson fieldInfo.projFn.toString), ("type", Lean.toJson text)])',
      '    return some (Lean.Json.mkObj [("name", Lean.toJson name.toString),',
      '      ("class", Lean.toJson (Lean.isClass env name)), ("fields", Lean.toJson fields)])',
    ] : []),
    '  let collectReferences (expression : Lean.Expr) : Lean.Elab.Term.TermElabM (Option (Array (String × String))) := do',
    '    let mut todo := (Lean.Expr.getUsedConstants expression).toList',
    '    let mut visited : Lean.NameSet := {}',
    '    let mut references : Array (String × String) := #[]',
    '    let mut fuel := 200000',
    '    while !todo.isEmpty do',
    '      if fuel == 0 then return none',
    '      fuel := fuel - 1',
    '      let name := todo.head!',
    '      todo := todo.tail!',
    '      if !visited.contains name then',
    '        visited := visited.insert name',
    '        let moduleName := match env.getModuleIdxFor? name with',
    '          | some index => env.header.moduleNames[index.toNat]!.toString',
    '          | none => ""',
    '        if moduleName.isEmpty then return none',
    '        if let some entry := projectModules.find? (fun entry => entry.1 == moduleName) then',
    '          if references.size >= 256 then return none',
    '          references := references.push (name.toString, entry.2)',
    '          let info <- Lean.getConstInfo name',
    '          match info with',
    '          | .inductInfo _ | .ctorInfo _ | .recInfo _ | .quotInfo _ => return none',
    '          | _ => pure ()',
    '          todo := (Lean.Expr.getUsedConstants info.type).toList ++ todo',
    '          if !(<- Lean.Meta.isProp info.type) then',
    ...(detailedContext ? [
      '            let value : Option Lean.Expr := match info with',
      '              | .defnInfo item => some item.value',
      '              | .thmInfo item => some item.value',
      '              | .opaqueInfo item => some item.value',
      '              | _ => none',
      '            if let some value := value then',
    ] : ['            if let some value := info.value? (allowOpaque := true) then']),
    '              todo := (Lean.Expr.getUsedConstants value).toList ++ todo',
    '    return some references',
    ...(detailedContext ? [
      '  let collectBindings (type : Lean.Expr) : Lean.Elab.Term.TermElabM Lean.Json := do',
      '    Lean.Meta.forallTelescope type fun xs conclusion => do',
      '      if xs.size > 256 then throwError "Statement binder count exceeds its export bound"',
      '      let dependencies (expression : Lean.Expr) (count : Nat) : List String :=',
      '        (List.range count).filterMap fun index =>',
      '          if expression.containsFVar xs[index]!.fvarId! then some ("b" ++ toString index) else none',
      '      let mut binders : Array Lean.Json := #[]',
      '      for index in List.range xs.size do',
      '        let declaration <- xs[index]!.fvarId!.getDecl',
      '        let kind := match declaration.binderInfo with',
      '          | .default => "explicit"',
      '          | .implicit => "implicit"',
      '          | .strictImplicit => "strictImplicit"',
      '          | .instImplicit => "instanceImplicit"',
      '        let text := (<- Lean.Meta.ppExpr declaration.type).pretty',
      '        if text.utf8ByteSize > 24000 then throwError "Statement binder type exceeds its export bound"',
      '        binders := binders.push (Lean.Json.mkObj [("id", Lean.toJson ("b" ++ toString index)),',
      '          ("name", Lean.toJson declaration.userName.toString), ("type", Lean.toJson text),',
      '          ("kind", Lean.toJson kind), ("dependencies", Lean.toJson (dependencies declaration.type index))])',
      '      let text := (<- Lean.Meta.ppExpr conclusion).pretty',
      '      if text.utf8ByteSize > 24000 then throwError "Statement conclusion exceeds its export bound"',
      '      return Lean.Json.mkObj [("binders", Lean.toJson binders), ("conclusion", Lean.toJson text),',
      '        ("conclusionDependencies", Lean.toJson (dependencies conclusion xs.size))]',
    ] : []),
    '  let collect (rootName : Lean.Name) : Lean.Elab.Term.TermElabM Lean.Json := do',
      '    let root <- Lean.getConstInfo rootName',
      '    let statement := (<- Lean.Meta.ppExpr root.type).pretty',
      options?.omitOversizedType === true
        ? '    if statement.utf8ByteSize > 24000 then return Lean.Json.mkObj [("unavailable", Lean.toJson "statement-type-export-bound"), ("bytes", Lean.toJson statement.utf8ByteSize), ("limit", Lean.toJson (24000 : Nat))]'
        : '    if statement.utf8ByteSize > 24000 then throwError "Statement type exceeds its export bound"',
      '    let mut todo := (Lean.Expr.getUsedConstants root.type).toList.map (fun name => (name, 0))',
      '    let mut visited : Lean.NameSet := {}',
      '    let mut constants : Array Lean.Json := #[]',
      ...(options?.structureContext === true ? ['    let mut structures : Array Lean.Json := #[]'] : []),
      '    let mut omitted : Array String := #[]',
      ...(detailedContext ? [
        '    let bindings <- collectBindings root.type',
        '    let mut bytes := statement.utf8ByteSize + bindings.compress.utf8ByteSize',
        '    if bytes > 240000 then throwError "Statement bindings exceed their export bound"',
      ] : ['    let mut bytes := statement.utf8ByteSize']),
      ...(semanticContext ? [
        '    let semantic <- collectStatementSemantic root',
        '    bytes := bytes + semantic.compress.utf8ByteSize',
        '    if bytes > 240000 then throwError "Statement semantics exceed their export bound"',
      ] : []),
      '    let mut fuel := 10000',
      '    while !todo.isEmpty && fuel > 0 && constants.size < 256 do',
      '      fuel := fuel - 1',
      '      let (name, depth) := todo.head!',
      '      todo := todo.tail!',
      '      if !visited.contains name then',
      '        visited := visited.insert name',
      '        let info <- Lean.getConstInfo name',
      '        let moduleName := match env.getModuleIdxFor? name with',
      '          | some index => env.header.moduleNames[index.toNat]!.toString',
      '          | none => ""',
      '        let isLocal := moduleName.isEmpty || localModules.contains moduleName',
      '        let value <- match info with',
      '          | .defnInfo definition => do',
      '            if (<- Lean.Meta.isProp info.type) then pure none else pure (some definition.value)',
      '          | _ => pure none',
      '        if isLocal then',
      '          todo := todo ++ (Lean.Expr.getUsedConstants info.type).toList.map (fun name => (name, 0))',
      '        else',
      '          let type := (<- Lean.Meta.ppExpr info.type).pretty',
      '          let definition <- match value with',
      '            | some expression => pure (some (<- Lean.Meta.ppExpr expression).pretty)',
      '            | none => pure none',
      '          let mut fields := [("name", Lean.toJson name.toString), ("module", Lean.toJson moduleName), ("type", Lean.toJson type)]',
      '          if let some text := definition then',
      '            if text.utf8ByteSize <= 12000 then fields := fields ++ [("definition", Lean.toJson text)]',
      '            else if omitted.size < 256 then omitted := omitted.push name.toString',
      '          let record := Lean.Json.mkObj fields',
      '          let size := record.compress.utf8ByteSize',
      '          if constants.size < 256 && type.utf8ByteSize <= 8000 && bytes + size <= 240000 then',
      '            constants := constants.push record',
      '            bytes := bytes + size',
      ...(options?.structureContext === true ? [
        '            if let some structureRecord ← collectStructure name then',
        // kernel-v3 records an imported structure past the byte bound as omitted; kernel-v2 stays fatal.
        ...(options.boundedLibraryContext === true ? [
          '              let structureSize := structureRecord.compress.utf8ByteSize',
          '              if structureRecord != Lean.Json.null && bytes + structureSize <= 240000 then',
          '                bytes := bytes + structureSize',
          '                structures := structures.push structureRecord',
          '              else if omitted.size < 256 then omitted := omitted.push name.toString',
        ] : [
          '              bytes := bytes + structureRecord.compress.utf8ByteSize',
          '              if bytes > 240000 then throwError "Statement structure fields exceed their context export bound"',
          '              structures := structures.push structureRecord',
        ]),
      ] : []),
      '          else if omitted.size < 256 then omitted := omitted.push name.toString',
      '        if let some expression := value then',
      '          if isLocal || depth < 2 then',
      '            todo := todo ++ (Lean.Expr.getUsedConstants expression).toList.map (fun name => (name, if isLocal then 0 else depth + 1))',
      '    if !todo.isEmpty then omitted := omitted.push "dependency traversal bound reached"',
    '    let mut fields := [("type", Lean.toJson statement), ("constants", Lean.toJson constants), ("omitted", Lean.toJson omitted)]',
    ...(detailedContext ? ['    fields := fields ++ [("bindings", bindings)]'] : []),
    ...(semanticContext ? ['    fields := fields ++ [("semantic", semantic)]'] : []),
    ...(options?.structureContext === true ? [
      '    fields := fields ++ [("structures", Lean.Json.mkObj [("schema", Lean.toJson "theorem-os.lean-statement-structures.v1"), ("entries", Lean.toJson structures)])]',
    ] : []),
    ...(detailedContext ? [
      '    let references ← collectReferences root.type',
      '    if let some references := references then',
    ] : ['    if let some references <- collectReferences root.type then']),
    '      let report := Lean.Json.mkObj [("statement", Lean.toJson (references.map (fun (name, file) => Lean.Json.mkObj [("name", Lean.toJson name), ("file", Lean.toJson file)]))), ("proof", Lean.toJson (#[] : Array Lean.Json))]',
    '      if report.compress.utf8ByteSize <= 8000 then fields := fields ++ [("references", report)]',
    '    return Lean.Json.mkObj fields',
    '  let mut reports : Array Lean.Json := #[]',
    ...roots.flatMap(root => [
      `  let context <- collect (${JSON.stringify(root.name)}.toName)`,
      `  reports := reports.push (Lean.Json.mkObj [("id", Lean.toJson ${JSON.stringify(root.id)}), ("context", context)])`,
    ]),
    '  let report := (Lean.toJson reports).compress',
    '  if report.utf8ByteSize > 4000000 then throwError "Statement context exceeds its export bound"',
    `  Lean.Core.liftIOCore <| IO.FS.writeFile ${JSON.stringify(outputFile)} report`,
  ].join('\n');
}

export function parseLeanStatementContexts(text: string, ids: readonly string[]): Map<string, LeanStatementContext> {
  const invalid = () => { throw new Error('math_statement_elaboration_invalid'); };
  if (Buffer.byteLength(text) > 4_000_000) return invalid();
  const reports: unknown = JSON.parse(text);
  if (!Array.isArray(reports) || reports.length !== ids.length) return invalid();
  const contexts = new Map<string, LeanStatementContext>();
  for (const report of reports) {
    const context = report?.context;
    if (!ids.includes(report?.id) || contexts.has(report.id) || !context || typeof context.type !== 'string' ||
        !context.type.trim() || Buffer.byteLength(context.type) > 24000 || !Array.isArray(context.constants) || context.constants.length > 256 ||
        !context.constants.every((item: any) => item && typeof item.name === 'string' && item.name.length <= 1000 &&
          typeof item.module === 'string' && item.module.length <= 1000 && typeof item.type === 'string' && Buffer.byteLength(item.type) <= 8000 &&
          (item.definition === undefined || (typeof item.definition === 'string' && Buffer.byteLength(item.definition) <= 12000))) ||
        !Array.isArray(context.omitted) || context.omitted.length > 257 || !context.omitted.every((item: unknown) => typeof item === 'string' && item.length <= 1000) ||
        Buffer.byteLength(JSON.stringify(context)) > 256000) return invalid();
    const references = context.references;
    if (references !== undefined && (!references || !Array.isArray(references.statement) || references.statement.length > 256 ||
        !Array.isArray(references.proof) || references.proof.length !== 0 || Buffer.byteLength(JSON.stringify(references)) > 8000 || !references.statement.every((item: any) => item &&
          typeof item.name === 'string' && item.name.length > 0 && item.name.length <= 1000 &&
          typeof item.file === 'string' && item.file.length > 0 && item.file.length <= 1000))) return invalid();
    const bindings = context.bindings;
    if (bindings !== undefined) {
      if (!bindings || !Array.isArray(bindings.binders) || bindings.binders.length > 256 ||
          typeof bindings.conclusion !== 'string' || !bindings.conclusion.trim() ||
          Buffer.byteLength(bindings.conclusion) > 24000) return invalid();
      const validDependencies = (dependencies: unknown, count: number): dependencies is string[] => {
        if (!Array.isArray(dependencies) || dependencies.length > count) return false;
        let previous = -1;
        for (const dependency of dependencies) {
          if (typeof dependency !== 'string' || !/^b(?:0|[1-9][0-9]*)$/u.test(dependency)) return false;
          const index = Number(dependency.slice(1));
          if (!Number.isSafeInteger(index) || index <= previous || index >= count) return false;
          previous = index;
        }
        return true;
      };
      for (const [index, binder] of bindings.binders.entries()) {
        if (!binder || binder.id !== 'b' + index || typeof binder.name !== 'string' || !binder.name.length ||
            binder.name.length > 1000 || typeof binder.type !== 'string' || !binder.type.trim() ||
            Buffer.byteLength(binder.type) > 24000 ||
            !['explicit', 'implicit', 'strictImplicit', 'instanceImplicit'].includes(binder.kind) ||
            !validDependencies(binder.dependencies, index)) return invalid();
      }
      if (!validDependencies(bindings.conclusionDependencies, bindings.binders.length)) return invalid();
    }
    const semantic = context.semantic;
    if (semantic !== undefined && !leanStatementSemanticSchema.safeParse(semantic).success) return invalid();
    const structures = context.structures;
    if (structures !== undefined && (!leanStatementStructuresSchema.safeParse(structures).success ||
        structures.entries.some((entry: LeanStatementStructures['entries'][number]) =>
          !context.constants.some((constant: { name: string }) => constant.name === entry.name)))) return invalid();
    contexts.set(report.id, { type: context.type, constants: context.constants, omitted: context.omitted,
      ...(references === undefined ? {} : { references }), ...(bindings === undefined ? {} : { bindings }),
      ...(semantic === undefined ? {} : { semantic }), ...(structures === undefined ? {} : { structures }) });
  }
  return contexts;
}
