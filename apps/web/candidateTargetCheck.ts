import { leanDeclarationContextCommands } from '../../src/math/leanSource';

/** Runs in a separate host-written module after the candidate compiles. Other original goals may remain open;
 * the selected declaration must have a value, the requested type and no admitted or additional axioms. */
export function candidateTargetQuery(sourceModule: string, source: string,
  target: { name: string; expectedType?: string }, marker: string): string {
  const context = leanDeclarationContextCommands(source, target.name);
  return [
    'import Lean', `import ${sourceModule}`,
    ...(target.expectedType ? [
      ...context.before,
      'run_cmd Lean.Elab.Command.liftTermElabM do',
      `  let parsedType ← match Lean.Parser.runParserCategory (← Lean.getEnv) (Lean.Name.mkSimple "term") ${JSON.stringify(target.expectedType)} with`,
      '    | .ok stx => pure stx',
      '    | .error message => throwError "{message}"',
      '  let expected ← Lean.Elab.Term.elabType parsedType',
      '  Lean.Elab.Term.synthesizeSyntheticMVarsNoPostponing',
      '  let expected ← Lean.instantiateMVars expected',
      '  if expected.hasMVar || expected.hasFVar then throwError "Candidate expected type must be closed"',
      `  let declaration ← Lean.Meta.mkConstWithFreshMVarLevels (${JSON.stringify(target.name)}.toName)`,
      '  let actual ← Lean.Meta.inferType declaration',
      '  unless (← Lean.Meta.isDefEq actual expected) do throwError "Candidate declaration has a different type or additional assumptions"',
      ...context.after,
    ] : []),
    'run_cmd do',
    `  let target := ${JSON.stringify(target.name)}.toName`,
    '  let some info := (← Lean.getEnv).find? target | throwError "Candidate target is missing"',
    '  unless info.value? (allowOpaque := true) |>.isSome do throwError "Candidate target has no proof value"',
    '  let axioms ← Lean.Elab.Command.liftCoreM <| Lean.collectAxioms target',
    '  let permitted : List String := ["propext", "Classical.choice", "Quot.sound"]',
    '  for dependency in axioms do',
    '    unless permitted.contains dependency.toString do throwError "Candidate target depends on an unproved declaration or unsupported axiom: {dependency}"',
    `  Lean.logInfo ${JSON.stringify(marker)}`,
    '',
  ].join('\n');
}

export function candidateTargetWasChecked(output: string, marker: string): boolean {
  return output.split('\n').some(line => {
    try {
      const item = JSON.parse(line);
      return item.severity === 'information' && item.data === marker;
    } catch { return false; }
  });
}
