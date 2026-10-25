import { z } from 'zod';

export const LEAN_STATEMENT_CONTEXT_PROTOCOL = 'kernel-v2' as const;
export const leanStatementContextProtocolSchema = z.enum(['kernel-v1', 'kernel-v2']);
export type LeanStatementContextProtocol = z.infer<typeof leanStatementContextProtocolSchema>;

/** Decimal strings keep Lean's arbitrary-precision naturals exact in JSON. */
const natural = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);
export type LeanStatementKernelName = null | ['str', LeanStatementKernelName, string] |
  ['num', LeanStatementKernelName, string];
const nameSchema: z.ZodType<LeanStatementKernelName> = z.lazy(() => z.union([
  z.null(), z.tuple([z.literal('str'), nameSchema, z.string()]),
  z.tuple([z.literal('num'), nameSchema, natural]),
])) as unknown as z.ZodType<LeanStatementKernelName>;
export type LeanStatementKernelLevel = ['zero'] | ['succ', LeanStatementKernelLevel] |
  ['max' | 'imax', LeanStatementKernelLevel, LeanStatementKernelLevel] | ['param', string];
const levelSchema: z.ZodType<LeanStatementKernelLevel> = z.lazy(() => z.union([
  z.tuple([z.literal('zero')]), z.tuple([z.literal('succ'), levelSchema]),
  z.tuple([z.enum(['max', 'imax']), levelSchema, levelSchema]), z.tuple([z.literal('param'), natural]),
])) as unknown as z.ZodType<LeanStatementKernelLevel>;
const binderInfo = z.enum(['explicit', 'implicit', 'strictImplicit', 'instanceImplicit']);
type BinderInfo = z.infer<typeof binderInfo>;
export type LeanStatementKernelExpr = ['bvar', string] | ['sort', LeanStatementKernelLevel] |
  ['const', LeanStatementKernelName, LeanStatementKernelLevel[]] | ['nat' | 'string', string] |
  ['app', LeanStatementKernelExpr, LeanStatementKernelExpr] |
  ['lam' | 'forall', BinderInfo, LeanStatementKernelExpr, LeanStatementKernelExpr] |
  ['let', boolean, LeanStatementKernelExpr, LeanStatementKernelExpr, LeanStatementKernelExpr] |
  ['projection', LeanStatementKernelName, string, LeanStatementKernelExpr];
const expressionSchema: z.ZodType<LeanStatementKernelExpr> = z.lazy(() => z.union([
  z.tuple([z.literal('bvar'), natural]), z.tuple([z.literal('sort'), levelSchema]),
  z.tuple([z.literal('const'), nameSchema, z.array(levelSchema)]),
  z.tuple([z.literal('nat'), natural]), z.tuple([z.literal('string'), z.string()]),
  z.tuple([z.literal('app'), expressionSchema, expressionSchema]),
  z.tuple([z.enum(['lam', 'forall']), binderInfo, expressionSchema, expressionSchema]),
  z.tuple([z.literal('let'), z.boolean(), expressionSchema, expressionSchema, expressionSchema]),
  z.tuple([z.literal('projection'), nameSchema, natural, expressionSchema]),
])) as unknown as z.ZodType<LeanStatementKernelExpr>;

const closureEntrySchema = z.object({
  name: z.string().min(1).max(1000), kind: z.enum(['definition', 'opaque', 'theorem', 'axiom']),
  rawType: z.string().min(1), type: expressionSchema,
  value: expressionSchema.optional(), rawValue: z.string().min(1).optional(),
}).strict().superRefine((entry, context) => {
  if ((entry.value === undefined) !== (entry.rawValue === undefined) ||
      ((entry.kind === 'theorem' || entry.kind === 'axiom') && entry.value !== undefined))
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid declaration value' });
});
export const leanStatementSemanticSchema = z.object({
  schema: z.literal('theorem-os.lean-statement-semantic.v1'), rawType: z.string().min(1), kernelType: expressionSchema,
  localMeaningClosure: z.array(closureEntrySchema).max(256),
}).strict().superRefine((value, context) => {
  const names = value.localMeaningClosure.map(entry => entry.name);
  if (new Set(names).size !== names.length)
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate local declaration' });
  if (Buffer.byteLength(JSON.stringify(value)) > 240000)
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Statement semantic export exceeds its context bound' });
});
export type LeanStatementSemantic = z.infer<typeof leanStatementSemanticSchema>;

/**
 * Inside liftTermElabM, after env/localModules. Adapted from AutoformBot's
 * skeleton_probe.lean; attribution and MIT license: third_party/autoform-bot-LICENSE.txt.
 * The default exporter never includes these commands, preserving frozen legacy queries.
 */
export function leanStatementSemanticCommands(): string[] {
  return [
    // Explicit postorder stacks work inside run_cmd in both supported Lean versions.
    "  let semanticName (root : Lean.Name) : Lean.Json := Id.run do",
    "    let mut name := root",
    "    let mut components : List (String \u00d7 Lean.Json) := []",
    "    let mut finished := false",
    "    while !finished do",
    "      match name with",
    "      | .anonymous => finished := true",
    "      | .str parent component =>",
    "        components := (\"str\", Lean.toJson component) :: components",
    "        name := parent",
    "      | .num parent component =>",
    "        components := (\"num\", Lean.toJson (toString component)) :: components",
    "        name := parent",
    "    let mut result := Lean.Json.null",
    "    for component in components do",
    "      result := Lean.Json.arr #[Lean.toJson component.1, result, component.2]",
    "    return result",
    "  let semanticParameterIndex (name : Lean.Name) (params : List Lean.Name) : Option Nat :=",
    "    params.foldr (fun n rest => if n == name then some 0 else rest.map Nat.succ) none",
    "  let semanticLevel (params : List Lean.Name) (root : Lean.Level) : Lean.Elab.Term.TermElabM Lean.Json := do",
    "    let mut todo : List (Lean.Level \u00d7 Bool) := [(root, false)]",
    "    let mut values : List Lean.Json := []",
    "    while !todo.isEmpty do",
    "      let (level, completed) := todo.head!",
    "      todo := todo.tail!",
    "      match level, completed with",
    "      | .succ u, false => todo := (u, false) :: (level, true) :: todo",
    "      | .max u v, false | .imax u v, false => todo := (u, false) :: (v, false) :: (level, true) :: todo",
    "      | .succ _, true =>",
    "        let u := values.head!",
    "        values := Lean.Json.arr #[Lean.toJson \"succ\", u] :: values.tail!",
    "      | .max _ _, true | .imax _ _, true =>",
    "        let v := values.head!",
    "        values := values.tail!",
    "        let u := values.head!",
    "        let kind := match level with | .max _ _ => \"max\" | _ => \"imax\"",
    "        values := Lean.Json.arr #[Lean.toJson kind, u, v] :: values.tail!",
    "      | .zero, _ => values := Lean.Json.arr #[Lean.toJson \"zero\"] :: values",
    "      | .param name, _ =>",
    "        match semanticParameterIndex name params with",
    "        | some index => values := Lean.Json.arr #[Lean.toJson \"param\", Lean.toJson (toString index)] :: values",
    "        | none => throwError \"Unknown universe parameter in statement semantic export\"",
    "      | .mvar _, _ => throwError \"Unresolved universe metavariable in statement semantic export\"",
    "    return values.head!",
    "  let semanticBinder (info : Lean.BinderInfo) : Lean.Json := Lean.toJson <| match info with",
    "    | .default => \"explicit\"",
    "    | .implicit => \"implicit\"",
    "    | .strictImplicit => \"strictImplicit\"",
    "    | .instImplicit => \"instanceImplicit\"",
    "  let semanticExpression (params : List Lean.Name) (root : Lean.Expr) : Lean.Elab.Term.TermElabM Lean.Json := do",
    "    let mut todo : List (Lean.Expr \u00d7 Bool) := [(root, false)]",
    "    let mut values : List Lean.Json := []",
    "    while !todo.isEmpty do",
    "      let (expression, completed) := todo.head!",
    "      todo := todo.tail!",
    "      match expression, completed with",
    "      | .app fn arg, false => todo := (fn, false) :: (arg, false) :: (expression, true) :: todo",
    "      | .lam _ type body _, false | .forallE _ type body _, false =>",
    "        todo := (type, false) :: (body, false) :: (expression, true) :: todo",
    "      | .letE _ type value body _, false =>",
    "        todo := (type, false) :: (value, false) :: (body, false) :: (expression, true) :: todo",
    "      | .proj _ _ body, false => todo := (body, false) :: (expression, true) :: todo",
    "      | .mdata _ body, _ => todo := (body, false) :: todo",
    "      | .app _ _, true =>",
    "        let arg := values.head!",
    "        values := values.tail!",
    "        let fn := values.head!",
    "        values := Lean.Json.arr #[Lean.toJson \"app\", fn, arg] :: values.tail!",
    "      | .lam _ _ _ info, true | .forallE _ _ _ info, true =>",
    "        let body := values.head!",
    "        values := values.tail!",
    "        let type := values.head!",
    "        let kind := match expression with | .lam _ _ _ _ => \"lam\" | _ => \"forall\"",
    "        values := Lean.Json.arr #[Lean.toJson kind, semanticBinder info, type, body] :: values.tail!",
    "      | .letE _ _ _ _ nonDep, true =>",
    "        let body := values.head!",
    "        values := values.tail!",
    "        let value := values.head!",
    "        values := values.tail!",
    "        let type := values.head!",
    "        values := Lean.Json.arr #[Lean.toJson \"let\", Lean.toJson nonDep, type, value, body] :: values.tail!",
    "      | .proj name index _, true =>",
    "        let body := values.head!",
    "        values := Lean.Json.arr #[Lean.toJson \"projection\", semanticName name, Lean.toJson (toString index), body] :: values.tail!",
    "      | .bvar index, _ => values := Lean.Json.arr #[Lean.toJson \"bvar\", Lean.toJson (toString index)] :: values",
    "      | .fvar _, _ => throwError \"Unbound free variable in statement semantic export\"",
    "      | .mvar _, _ => throwError \"Unresolved metavariable in statement semantic export\"",
    "      | .sort level, _ => values := Lean.Json.arr #[Lean.toJson \"sort\", <- semanticLevel params level] :: values",
    "      | .const name levels, _ =>",
    "        values := Lean.Json.arr #[Lean.toJson \"const\", semanticName name, Lean.toJson (<- levels.mapM (semanticLevel params))] :: values",
    "      | .lit (.natVal value), _ => values := Lean.Json.arr #[Lean.toJson \"nat\", Lean.toJson (toString value)] :: values",
    "      | .lit (.strVal value), _ => values := Lean.Json.arr #[Lean.toJson \"string\", Lean.toJson value] :: values",
    "    return values.head!",
    '  let semanticRaw (expression : Lean.Expr) : Lean.Elab.Term.TermElabM String :=',
    '    Lean.withOptions (fun options => (((options.setBool `pp.raw true).setBool `pp.universes true).setBool `pp.explicit true).setBool `pp.proofs false) do',
    '      return (<- Lean.Meta.ppExpr expression).pretty',
    '  let collectStatementSemantic (root : Lean.ConstantInfo) : Lean.Elab.Term.TermElabM Lean.Json := do',
    '    let kernelType <- semanticExpression root.levelParams root.type',
    '    let rawType <- semanticRaw root.type',
    '    let mut todo := (Lean.Expr.getUsedConstants root.type).toList',
    '    let mut visited : Lean.NameSet := {}',
    '    let mut localNames : Array Lean.Name := #[]',
    '    while !todo.isEmpty do',
    '      let name := todo.head!',
    '      todo := todo.tail!',
    '      if !visited.contains name then',
    '        visited := visited.insert name',
    '        let moduleName := match env.getModuleIdxFor? name with',
    '          | some index => env.header.moduleNames[index.toNat]!.toString',
    '          | none => ""',
    '        if moduleName.isEmpty || localModules.contains moduleName then',
    '          if localNames.size >= 256 then throwError "Local semantic closure exceeds its context declaration bound"',
    '          let info <- Lean.getConstInfo name',
    '          let value : Option Lean.Expr <- match info with',
    '            | .defnInfo item => if (<- Lean.Meta.isProp info.type) then pure none else pure (some item.value)',
    '            | .opaqueInfo item => if (<- Lean.Meta.isProp info.type) then pure none else pure (some item.value)',
    '            | .thmInfo _ | .axiomInfo _ => pure none',
    '            | _ => throwError "Unsupported local declaration in statement semantic export: {name}"',
    '          localNames := localNames.push name',
    '          todo := (Lean.Expr.getUsedConstants info.type).toList ++ todo',
    '          if let some value := value then todo := (Lean.Expr.getUsedConstants value).toList ++ todo',
    '    let mut closure : Array Lean.Json := #[]',
    '    for name in localNames.qsort Lean.Name.lt do',
    '      let info <- Lean.getConstInfo name',
    '      let (kind, candidate) : String × Option Lean.Expr := match info with',
    '        | .defnInfo item => ("definition", some item.value)',
    '        | .opaqueInfo item => ("opaque", some item.value)',
    '        | .thmInfo _ => ("theorem", none)',
    '        | .axiomInfo _ => ("axiom", none)',
    '        | _ => ("unsupported", none)',
    '      let mut fields := [("name", Lean.toJson name.toString), ("kind", Lean.toJson kind),',
    '        ("rawType", Lean.toJson (<- semanticRaw info.type)), ("type", <- semanticExpression info.levelParams info.type)]',
    '      if !(<- Lean.Meta.isProp info.type) then',
    '        if let some value := candidate then',
    '          fields := fields ++ [("value", <- semanticExpression info.levelParams value), ("rawValue", Lean.toJson (<- semanticRaw value))]',
    '      closure := closure.push (Lean.Json.mkObj fields)',
    '    let report := Lean.Json.mkObj [("schema", Lean.toJson "theorem-os.lean-statement-semantic.v1"),',
    '      ("rawType", Lean.toJson rawType), ("kernelType", kernelType), ("localMeaningClosure", Lean.toJson closure)]',
    '    if report.compress.utf8ByteSize > 240000 then throwError "Statement semantic export exceeds its context byte bound"',
    '    return report',
  ];
}
