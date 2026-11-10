export type ConditionalDependency = Readonly<{ theoremName: string; type: string }>;

export type ConditionalProjectionInput = Readonly<{ theoremName: string; writtenName: string; declaration: string;
  dependencies: readonly ConditionalDependency[] }>;

/** Host-only elaborators. The projected theorem remains an ordinary source declaration. */
export const conditionalProjectionPrelude = `namespace TheoremOS.Host.ConditionalProjection
open Lean Meta Elab Term

structure Dependency where
  theoremName : String
  type : String
  deriving FromJson, Inhabited

structure Payload where
  declaration : String
  dependencies : Array Dependency
  deriving FromJson, Inhabited

private def parsePayload (text : String) : TermElabM Payload := do
  match Json.parse text >>= fromJson? with
  | .ok value => pure value
  | .error message => throwError "Invalid host conditional projection: {message}"

private def parseTerm (text : String) : TermElabM Syntax := do
  match Parser.runParserCategory (← getEnv) \`term text with
  | .ok stx => pure stx
  | .error message => throwError "Invalid conditional type: {message}"

private def addDependency (dependency : Dependency) : TermElabM Unit := do
  let name := dependency.theoremName.toName
  if (← getEnv).contains name then throwError "Conditional declaration already exists: {name}"
  let type ← withoutErrToSorry <| elabType (← parseTerm dependency.type)
  synthesizeSyntheticMVarsNoPostponing
  let type ← levelMVarToParam (← instantiateMVars type)
  if type.hasFVar || type.hasMVar || type.hasLevelMVar then
    throwError "Conditional dependency type must be closed"
  let params := (collectLevelParams {} type).params.toList
  addDecl <| .axiomDecl { name, levelParams := params, type, isUnsafe := false }

private def addDependencies (dependencies : Array Dependency) : TermElabM Unit := do
  let mut pending := dependencies
  while !pending.isEmpty do
    let mut next := #[]
    let mut lastError : Option Exception := none
    for dependency in pending do
      let saved ← Term.saveState
      try addDependency dependency
      catch error =>
        saved.restore
        next := next.push dependency
        lastError := some error
    if next.size == pending.size then
      match lastError with
      | some error => throw error
      | none => throwError "Conditional dependency types contain a cycle"
    pending := next

private def declarationTerm (text : String) : TermElabM Syntax := do
  let parsed ← match Parser.runParserCategory (← getEnv) \`command text with
    | .ok stx => pure stx
    | .error message => throwError "Invalid conditional declaration: {message}"
  let sectionVars := (← read).sectionVars
  let parsed ← parsed.replaceM fun stx => do
    match stx with
    | .ident info raw name resolved =>
      let localInputs := Quotation.resolveSectionVariable sectionVars name
      if localInputs.isEmpty then pure none else
        pure (some (.ident info raw name (localInputs.map (fun (name, fields) => .decl name fields) ++ resolved)))
    | _ => pure none
  let declaration := parsed[1]
  unless [\`\`Lean.Parser.Command.theorem, \`Lean.Parser.Command.lemma, \`\`Lean.Parser.Command.definition, \`\`Lean.Parser.Command.abbrev].contains declaration.getKind do
    throwError "Conditional projection requires a named declaration"
  unless declaration[3].getKind == \`\`Lean.Parser.Command.declValSimple do
    throwError "Conditional projection requires a proof term"
  let (rawBinders, result?) := if declaration[2].getKind == \`\`Lean.Parser.Command.declSig then
    let (binders, result) := expandDeclSig declaration[2]
    (binders, some result)
  else expandOptDeclSig declaration[2]
  let binders : TSyntaxArray \`\`Lean.Parser.Term.funBinder := rawBinders.getArgs.map (fun stx => ⟨stx⟩)
  let proof : TSyntax \`term := ⟨declaration[3][1]⟩
  let value ← match result? with
    | some result => do
      let result : TSyntax \`term := ⟨result⟩
      \`(show $result from $proof)
    | none => pure proof
  if binders.isEmpty then pure value else \`(fun $binders* => $value)

private partial def inlineTemporary (base : Environment) (dependencies : Array Dependency)
    (expression : Expr) (stack : List Name := []) : TermElabM Expr := do
  match expression with
  | .const name levels =>
    if base.contains name || dependencies.any (fun dep => dep.theoremName.toName == name) then return expression
    if stack.contains name then throwError "Recursive temporary declaration in conditional proof: {name}"
    let info ← getConstInfo name
    let some value := (match info with
      | .defnInfo value => some value.value
      | .thmInfo value => some value.value
      | .opaqueInfo value => some value.value
      | _ => none)
      | throwError "Unsupported temporary declaration in conditional proof: {name}"
    inlineTemporary base dependencies (value.instantiateLevelParams info.levelParams levels) (name :: stack)
  | .app f a => return .app (← inlineTemporary base dependencies f stack) (← inlineTemporary base dependencies a stack)
  | .lam n t b bi => return .lam n (← inlineTemporary base dependencies t stack) (← inlineTemporary base dependencies b stack) bi
  | .forallE n t b bi => return .forallE n (← inlineTemporary base dependencies t stack) (← inlineTemporary base dependencies b stack) bi
  | .letE n t v b nondep => return .letE n (← inlineTemporary base dependencies t stack) (← inlineTemporary base dependencies v stack) (← inlineTemporary base dependencies b stack) nondep
  | .mdata data body => return .mdata data (← inlineTemporary base dependencies body stack)
  | .proj name index body => return .proj name index (← inlineTemporary base dependencies body stack)
  | _ => return expression

private partial def collectUses (dependencies : Array Dependency) (expression : Expr)
    (uses : Array Expr := #[]) : Array Expr := Id.run do
  let mut uses := uses
  match expression with
  | .const name _ =>
    if dependencies.any (fun dep => dep.theoremName.toName == name) && !uses.contains expression then
      uses := uses.push expression
  | .app f a => uses := collectUses dependencies a (collectUses dependencies f uses)
  | .lam _ t b _ | .forallE _ t b _ => uses := collectUses dependencies b (collectUses dependencies t uses)
  | .letE _ t v b _ => uses := collectUses dependencies b (collectUses dependencies v (collectUses dependencies t uses))
  | .mdata _ b | .proj _ _ b => uses := collectUses dependencies b uses
  | _ => pure ()
  return uses

private def orderUses (dependencies : Array Dependency) (uses : Array Expr) : TermElabM (Array Expr) := do
  let mut pending := uses
  let mut ordered := #[]
  while !pending.isEmpty do
    let mut next := #[]
    for use in pending do
      let required := collectUses dependencies (← inferType use)
      if required.all (fun input => ordered.contains input) then
        ordered := ordered.push use
      else
        next := next.push use
    if next.size == pending.size then throwError "Conditional dependency instances contain a cycle"
    pending := next
  return ordered

private def replaceUses (expression : Expr) (uses localInputs : Array Expr) : Expr :=
  expression.replace fun current =>
    (uses.findIdx? (fun use => use == current)).map (fun index => localInputs[index]!)

private partial def abstractUses (dependencies : Array Dependency) (uses : Array Expr) (proof : Expr)
    (index : Nat := 0) (localInputs : Array Expr := #[]) : TermElabM Expr := do
  if index == uses.size then
    return ← mkLambdaFVars localInputs (replaceUses proof uses localInputs)
  let use := uses[index]!
  let dependencyIndex := dependencies.findIdx? (fun dep => dep.theoremName.toName == use.constName!) |>.getD 0
  let type := replaceUses (← inferType use) (uses.extract 0 index) localInputs
  withLocalDeclD (Name.mkSimple s!"_theoremOS_condition_{dependencyIndex}_{index}") type fun input =>
    abstractUses dependencies uses proof (index + 1) (localInputs.push input)

private def generate (text : String) : TermElabM (List Name × Expr × Expr) := do
  let initialLevels ← getLevelNames
  withLevelNames initialLevels do
  let payload ← parsePayload text
  let base ← getEnv
  withoutModifyingEnv do
    addDependencies payload.dependencies
    setLevelNames initialLevels
    let value ← withoutErrToSorry <| elabTerm (← declarationTerm payload.declaration) none
    synthesizeSyntheticMVarsNoPostponing
    let value ← instantiateMVars value
    let value ← inlineTemporary base payload.dependencies value
    let value ← mkLambdaFVars (← getLCtx).getFVars value (usedOnly := true)
    let mut uses := collectUses payload.dependencies (← inferType value) (collectUses payload.dependencies value)
    let mut cursor := 0
    while cursor < uses.size do
      uses := collectUses payload.dependencies (← inferType uses[cursor]!) uses
      cursor := cursor + 1
    let ordered ← orderUses payload.dependencies uses
    let value ← abstractUses payload.dependencies ordered value
    let value ← levelMVarToParam value
    let type ← inferType value
    if value.hasFVar || value.hasMVar || value.hasLevelMVar || type.hasFVar || type.hasMVar || type.hasLevelMVar then
      throwError "Conditional projection did not close its proof"
    unless (collectUses payload.dependencies value).isEmpty && (collectUses payload.dependencies type).isEmpty do
      throwError "Conditional placeholder escaped abstraction"
    let params := (collectLevelParams (collectLevelParams {} type) value).params.toList.filter (fun p => !initialLevels.contains p)
    return (params, type, value)

private def cacheKey (text : String) : TermElabM Name := do
  pure <| Name.str (← getCurrNamespace) ("_theoremOS_conditional_cache_" ++ toString (hash text))

private def obtain (text : String) : TermElabM (List Name × Expr × Expr) := do
  let key ← cacheKey text
  if let some info := (← getEnv).find? key then
    let some proof := (match info with
      | .defnInfo value => some value.value
      | _ => none) | throwError "Invalid conditional projection cache declaration"
    let scope ← getLevelNames
    return (info.levelParams.filter (fun name => !scope.contains name), info.type, proof)
  let (params, type, proof) ← generate text
  let allParams := (collectLevelParams (collectLevelParams {} type) proof).params.toList
  addDecl <| .defnDecl { name := key, levelParams := allParams, type := type, value := proof, hints := .opaque, safety := .safe }
  return (params, type, proof)

elab "theorem_os_conditional_type% " payload:str : term => do
  let (params, type, _) ← obtain payload.getString
  let levels ← params.mapM fun _ => mkFreshLevelMVar
  pure (type.instantiateLevelParams params levels)

elab "theorem_os_conditional_proof% " payload:str : term => do
  let (params, _, proof) ← obtain payload.getString
  let levels ← params.mapM fun _ => mkFreshLevelMVar
  pure (proof.instantiateLevelParams params levels)

private def inputIndex (name : Name) : Option (Nat × Nat) := do
  match name.toString.splitOn "_" with
  | ["", "theoremOS", "condition", dependency, occurrence] =>
    return (← dependency.toNat?, ← occurrence.toNat?)
  | _ => none

private partial def validateExpected (dependencies : Array Dependency) (taskType : Syntax)
    (actual : Expr) (index : Nat := 0) : TermElabM Unit := do
  match actual with
  | .forallE name domain body info =>
    if let some (dependency, occurrence) := inputIndex name then
      unless occurrence == index && dependency < dependencies.size && info == .default do
        throwError "Invalid host conditional premise identity"
      let premise ← mkConstWithFreshMVarLevels dependencies[dependency]!.theoremName.toName
      unless ← isDefEq domain (← inferType premise) do
        throwError "Host conditional premise has a different dependency type"
      withLocalDecl name info domain fun input =>
        validateExpected dependencies taskType (body.instantiate1 input) (index + 1)
    else
      let expected ← withoutErrToSorry <| elabType taskType
      synthesizeSyntheticMVarsNoPostponing
      unless ← isDefEq actual (← instantiateMVars expected) do
        throwError "Helper declaration has a different type or additional assumptions"
  | _ =>
    let expected ← withoutErrToSorry <| elabType taskType
    synthesizeSyntheticMVarsNoPostponing
    unless ← isDefEq actual (← instantiateMVars expected) do
      throwError "Helper declaration has a different type or additional assumptions"

elab "theorem_os_conditional_expected% " theoremName:str taskType:str dependencies:str : term => do
  let dependencies : Array Dependency ← match Json.parse dependencies.getString >>= fromJson? with
    | .ok value => pure value
    | .error message => throwError "Invalid host conditional dependency contracts: {message}"
  let actual ← inferType (← mkConstWithFreshMVarLevels theoremName.getString.toName)
  let levels ← getLevelNames
  withLevelNames levels <| withoutModifyingEnv do
    addDependencies dependencies
    setLevelNames levels
    validateExpected dependencies (← parseTerm taskType.getString) actual
    levelMVarToParam (← instantiateMVars actual)

end TheoremOS.Host.ConditionalProjection
`;

export function conditionalProjection(input: ConditionalProjectionInput): { source: string; prelude: string } {
  const match = /^(noncomputable\s+)?(theorem|lemma|def|abbrev)\s/u.exec(input.declaration.trimStart());
  const kind = match?.[2], prefix = match?.[1] ?? '';
  if (!kind) throw new Error('math_task_conditional_header_unsupported');
  const payload = JSON.stringify(JSON.stringify({ declaration: input.declaration, dependencies: input.dependencies }));
  return { source: prefix + kind + ' ' + input.writtenName + ' : theorem_os_conditional_type% ' + payload +
    ' :=\n  theorem_os_conditional_proof% ' + payload + '\n', prelude: conditionalProjectionPrelude };
}

export function conditionalExpectedType(theoremName: string, taskType: string,
  dependencies: readonly ConditionalDependency[]): string {
  return 'theorem_os_conditional_expected% ' + JSON.stringify(theoremName) + ' ' + JSON.stringify(taskType) + ' ' +
    JSON.stringify(JSON.stringify(dependencies));
}
