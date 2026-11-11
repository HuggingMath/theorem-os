import Lean
import Submission
namespace TheoremOSE02
set_option autoImplicit false
set_option pp.fullNames true
run_cmd Lean.Elab.Command.liftTermElabM do
  let parsed <- match Lean.Parser.runParserCategory (<- Lean.getEnv) (Lean.Name.mkSimple "term") "∀ (a b : ℝ), 0 < a → 0 < b → 1 / (a + b) < 1 / a" with
    | .ok stx => pure stx
    | .error message => throwError "{message}"
  let expression <- Lean.Elab.Term.elabType parsed
  Lean.Elab.Term.synthesizeSyntheticMVarsNoPostponing
  let expression <- Lean.instantiateMVars expression
  if expression.hasMVar || expression.hasFVar || expression.hasLooseBVars then
    throwError "Requested type must be closed without free variables or metavariables"
  let rendered := (<- Lean.Meta.ppExpr expression).pretty
  if rendered.utf8ByteSize > 24000 then throwError "Elaborated type exceeds its export bound"
  let term <- match Lean.Parser.runParserCategory (<- Lean.getEnv) (Lean.Name.mkSimple "term") "fun (a b : ℝ) (ha : 0 < a) (hb : 0 < b) => one_div_lt_one_div_of_lt ha (lt_add_of_pos_right a hb)" with
    | .ok stx => pure stx
    | .error message => throwError "{message}"
  let applied <- Lean.Elab.Term.elabTermEnsuringType term expression
  Lean.Elab.Term.synthesizeSyntheticMVarsNoPostponing
  let applied <- Lean.instantiateMVars applied
  if applied.hasMVar || applied.hasFVar || applied.hasLooseBVars then
    throwError "Application must be closed without free variables or metavariables"
  let constants := applied.getUsedConstants.toList.map Lean.Name.toString
  if constants.contains "sorryAx" then throwError "Application contains an admitted term"
  if constants.length > 4096 then throwError "Application reference export exceeds its bound"
  let report := Lean.Json.mkObj [("type", Lean.toJson rendered), ("constants", Lean.toJson constants)]
  Lean.Core.liftIOCore <| IO.FS.writeFile ".lake/type-diagnostic.json" report.compress
end TheoremOSE02
