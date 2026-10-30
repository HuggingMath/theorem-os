// Frozen representation-correspondence-v3 generator and validator for saved receipts.
import { z } from 'zod';
import { formalizationReferenceResultSchema as legacyResultSchema, formalizationReferenceInputSchema,
  assertFormalizationReferenceResult as assertLegacyResult, type FormalizationReferenceInput } from './formalizationReferenceV2';
export { formalizationReferenceInputSchema, type FormalizationReferenceInput } from './formalizationReferenceV2';
import { representationProgramLines } from './formalizationReferenceV3Program';
import { eraseFormalizationProofs, formalizationTargets } from './formalizationSource';
import { getLeanTaskEnvironment } from './leanTaskEnvironment';
import { inspectLeanDeclarationRegions, inspectScopedLeanDeclarations } from './leanSource';
import { isSimpleLeanName, leanScopeCommands, maskLeanCommentsAndStrings } from './leanSyntax';
import { canonicalMathJson, mathDigest } from './mathRuntimeIo';
import { LAKE_CONFIGURATION_FILES } from './mathConstructionSources';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const target = z.string().max(1000).refine(isSimpleLeanName);
const direction = z.object({ status: z.enum(['established', 'not-established']), reason: z.string().min(1).max(1000),
  proofDeclaration: target.optional() }).strict();
const pairResult = z.object({ candidateTarget: target, referenceTarget: target,
  candidateToReference: direction, referenceToCandidate: direction }).strict();
const expressionSnapshot = z.object({
  expression: z.string().min(1).max(300000),
  context: z.array(z.object({ index: z.number().int().nonnegative(), binderInfo: z.string().min(1),
    type: z.string().min(1).max(300000) }).strict()),
  universes: z.array(z.string().min(1)),
}).strict();
const transformation = z.object({
  ruleId: z.enum(['group-conjugacy-exists', 'group-multiplication-association']), ruleVersion: z.literal(1),
  side: z.enum(['candidate', 'reference']),
  position: z.object({ kind: z.literal('forall-conclusion'), binderCount: z.number().int().nonnegative() }).strict(),
  before: expressionSnapshot, after: expressionSnapshot,
  sideConditions: z.array(z.object({ kind: z.literal('group-instance'),
    type: z.string().min(1).max(300000), term: z.string().min(1).max(300000) }).strict()),
  proof: z.object({ forward: z.string().min(1).max(300000), backward: z.string().min(1).max(300000) }).strict(),
}).strict();
export const formalizationReferenceV3ResultSchema = z.object({
  schema: z.literal('theoremos.formalization-reference.v2'), authority: z.literal('advisory-lean-process'),
  method: z.literal('representation-correspondence-v3'), status: z.enum(['established', 'not-established']),
  check: z.enum(['completed', 'unsupported', 'unavailable']),
  proofVerified: z.literal(false), semanticEquivalenceClaimed: z.literal(false), modelInvoked: z.literal(false),
  inputDigest: digest, candidateSourceSha256: digest, referenceSourceSha256: digest,
  environment: z.enum(['standard', 'mathlib']), environmentDigest: digest,
  limits: z.object({ timeoutMs: z.number().int().safe().nonnegative(), maxPairs: z.literal(16), maxHeartbeats: z.literal(100000) }).strict(),
  pairs: z.array(pairResult).min(1).max(16), reason: z.string().min(1).max(1000).optional(),
  files: z.array(z.object({ file: z.string().min(1).max(100), text: z.string().max(300000), sha256: digest }).strict()).max(6),
  evidence: z.object({ toolIdentity: digest, sourceDigest: digest, environmentDigest: digest,
    latest: z.unknown(), artifacts: z.array(z.object({ digest, text: z.string().max(4000000) }).strict()).min(1).max(4),
    reportText: z.string().max(1000000), reportSha256: digest }).strict().optional(),
}).strict();
export type CurrentFormalizationReferenceResult = z.infer<typeof formalizationReferenceV3ResultSchema>;
export const formalizationReferenceResultSchema = z.discriminatedUnion('schema', [legacyResultSchema, formalizationReferenceV3ResultSchema]);
export type FormalizationReferenceResult = z.infer<typeof formalizationReferenceResultSchema>;

export const FORMALIZATION_REFERENCE_QUERY = 'ReferenceComparison.lean';
export const FORMALIZATION_REFERENCE_REPORT = '.lake/reference-report.json';
const carrierNamespaces = { candidate: 'TheoremOSCandidate', reference: 'TheoremOSReference' } as const;

/** Replace proof-bearing declarations by predicates; no source theorem is admitted or executed. */
function carrierSource(source: string, side: keyof typeof carrierNamespaces): string {
  source = eraseFormalizationProofs(source);
  const declarations = inspectScopedLeanDeclarations(source), regions = inspectLeanDeclarationRegions(source);
  const masked = maskLeanCommentsAndStrings(source);
  if (/\b(?:TheoremOSCandidate|TheoremOSReference|ReferenceCandidate|ReferenceGold|ReferenceComparison)\b/u.test(masked) ||
      declarations.some(item => item.name.startsWith('_root_.')))
    throw new Error('reference_source_namespace_unsupported');
  // Lean generalizes section variables differently for theorem and def commands,
  // including otherwise unused instances. Keep all target binders explicit here.
  if ([...masked.matchAll(/^[ \t]*(?:variables?|include|omit)\b/gmu)].some(match =>
    !regions.some(region => match.index >= region.startOffset && match.index < region.endOffset)))
    throw new Error('reference_source_section_variables_unsupported');
  const frames: string[] = [];
  for (const command of leanScopeCommands(masked)) {
    if (regions.some(region => command.index >= region.startOffset && command.index < region.endOffset)) continue;
    const kind = command[1], name = command[2]?.trim() ?? '';
    if (kind === 'namespace' || kind === 'section') {
      if (name.split('.').includes('_root_')) throw new Error('reference_source_namespace_unsupported');
      frames.push(name);
    } else if (kind === 'end') {
      if (!frames.length || name && frames.at(-1) !== name) throw new Error('reference_source_scope_unsupported');
      frames.pop();
    }
  }
  if (frames.length) throw new Error('reference_source_scope_unsupported');
  for (const declaration of [...declarations].reverse()) {
    if (declaration.kind !== 'theorem') continue;
    // The eraser's host-produced proof hole is the only text removed here.
    const header = declaration.declarationType;
    if (!header.startsWith(declaration.name)) throw new Error('reference_source_header_unsupported');
    const rest = header.slice(declaration.name.length);
    const scanned = maskLeanCommentsAndStrings(rest).replace(/'(?:\\.|[^'\\\r\n])'/gu, text => ' '.repeat(text.length));
    let colon = -1;
    const stack: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      const character = scanned[i], opening = '([{⦃'.indexOf(character);
      if (opening >= 0) stack.push(')]}⦄'[opening]);
      else if (')]}⦄'.includes(character)) {
        if (stack.pop() !== character) throw new Error('reference_source_header_unsupported');
      } else if (!stack.length && character === ':') { colon = i; break; }
    }
    if (colon < 0 || !rest.slice(colon + 1).trim()) throw new Error('reference_source_header_unsupported');
    const region = regions.find(item => item.startOffset === declaration.startOffset)!;
    const afterBody = /^\s*by sorry\s*\n/u.exec(source.slice(region.bodyOffset));
    if (!afterBody) throw new Error('reference_source_header_unsupported');
    const replacement = `def ${declaration.name}${rest.slice(0, colon)}: Prop := ${rest.slice(colon + 1).trim()}\n`;
    source = source.slice(0, declaration.startOffset) + replacement + source.slice(region.bodyOffset + afterBody[0].length);
  }
  const imports: string[] = [];
  source = source.replace(/^[ \t]*import[ \t]+[^\n]+\r?$/gmu, line => { imports.push(line.trim()); return ''; });
  if (/\b(?:sorry|sorryAx|admit|axiom|constant)\b/u.test(maskLeanCommentsAndStrings(source)))
    throw new Error('reference_source_admission_unsupported');
  return [...imports, `namespace ${carrierNamespaces[side]}`, source, `end ${carrierNamespaces[side]}`, ''].join('\n');
}

function querySource(input: FormalizationReferenceInput): string {
  return ['import Lean', 'import ReferenceCandidate', 'import ReferenceGold',
    'set_option maxHeartbeats 100000', 'set_option maxRecDepth 512',
    'set_option pp.fullNames true', 'set_option pp.notation false',
    'run_cmd Lean.Elab.Command.liftTermElabM do',
    '  let proposition (name : Lean.Name) : Lean.Elab.Term.TermElabM Lean.Expr := do',
    '    let info ← Lean.getConstInfo name',
    '    let some value := info.value? | throwError "predicate value unavailable"',
    '    let closed ← Lean.Meta.lambdaTelescope value fun xs body => Lean.Meta.mkForallFVars xs body',
    // Alpha-rename rigid universe parameters in first-use order. Never specialize
    // them to concrete levels or unify two independent parameters.
    '    let params := (Lean.collectLevelParams {} closed).params.toList',
    '    let levels := params.zipIdx |>.map fun (_, i) => Lean.Level.param (Lean.Name.mkSimple s!"theoremOSu{i}")',
    '    let result := closed.instantiateLevelParams params levels',
    '    unless (← Lean.Meta.isProp result) do throwError "target is not a closed proposition"',
    '    if result.hasMVar || result.hasFVar then throwError "open target unsupported"',
    '    return result',
    '  let baseline (proposition : Lean.Expr) : Lean.Elab.Term.TermElabM Bool := do',
    '    let saved ← Lean.Meta.saveState',
    '    try',
    '      Lean.Meta.forallTelescopeReducing proposition fun xs conclusion => do',
    '        let conclusion ← Lean.Meta.whnf conclusion',
    '        if conclusion.isConstOf ``True then return true',
    '        if conclusion.isAppOfArity ``Eq 3 then',
    '          if ← Lean.Meta.isDefEq conclusion.appFn!.appArg! conclusion.appArg! then return true',
    '        for x in xs do',
    '          let type ← Lean.Meta.inferType x',
    '          if (← Lean.Meta.whnf type).isConstOf ``False then return true',
    '          if (← Lean.Meta.isProp type) && (← Lean.Meta.isDefEq type conclusion) then return true',
    '        return false',
    '    finally saved.restore',
    // Match every binder bijectively. Only already introduced target variables
    // are available, so dependent domains retain their original dependencies.
    '  let permutation (premise conclusion : Lean.Expr) : Lean.Meta.MetaM Lean.Expr := do',
    '    Lean.Meta.withLocalDeclD `opposite premise fun opposite => do',
    '      let value ← Lean.Meta.forallTelescope conclusion fun ys body => do',
    '        let rec align (type : Lean.Expr) (args : Array Lean.Expr) (used : Array Bool) : Lean.Meta.MetaM (Array Lean.Expr) := do',
    '          match type.headBeta with',
    '          | .forallE _ domain rest _ =>',
    '            for i in [:ys.size] do',
    '              if used[i]! then continue',
    '              let saved ← Lean.Meta.saveState',
    '              try',
    '                if ← Lean.Meta.isDefEq domain (← Lean.Meta.inferType ys[i]!) then',
    '                  return ← align (rest.instantiate1 ys[i]!) (args.push ys[i]!) (used.set! i true)',
    '              catch _ => pure ()',
    '              saved.restore',
    '            throwError "binder bijection unavailable"',
    '          | result =>',
    '            unless used.all id && (← Lean.Meta.isDefEq result body) do',
    '              throwError "conclusion or binder bijection differs"',
    '            return args',
    '        let args ← align premise #[] (Array.replicate ys.size false)',
    '        Lean.Meta.mkLambdaFVars ys (Lean.mkAppN opposite args)',
    '      Lean.Meta.mkLambdaFVars #[opposite] value',
    '  let permutations (premise conclusion : Lean.Expr) : Lean.Meta.MetaM (Option (Lean.Expr × Lean.Expr)) := do',
    '    try',
    '      let forward ← permutation premise conclusion',
    '      let backward ← permutation conclusion premise',
    '      return some (forward, backward)',
    '    catch _ => return none',
    '  let prove (name : Lean.Name) (premise conclusion value : Lean.Expr) : Lean.Elab.Term.TermElabM Unit := do',
    '    let type := Lean.Expr.forallE `opposite premise conclusion Lean.BinderInfo.default',
    '    let levelParams := (Lean.collectLevelParams {} type).params.toList',
    '    Lean.addDecl (.thmDecl { name, levelParams, type, value })',
    ...representationProgramLines(input.environment),
    '  let mut reports : Array Lean.Json := #[]',
    ...input.pairs.flatMap((pair, index) => {
      const forward = `TheoremOSCorrespondence.candidateToReference${index}`;
      const backward = `TheoremOSCorrespondence.referenceToCandidate${index}`;
      return [
        '  let pairReport ← (show Lean.Elab.Term.TermElabM Lean.Json from do',
        `    let candidateTarget := ${JSON.stringify(pair.candidateTarget)}`,
        `    let referenceTarget := ${JSON.stringify(pair.referenceTarget)}`,
        '    let mut status := "not-established"', '    let mut reason := "unsupported-target"',
        '    let mut candidateType := ""', '    let mut referenceType := ""',
        '    let mut candidateBaseline := false', '    let mut referenceBaseline := false',
        '    let mut definitionallyEqual := false', '    let mut binderPermutation := false',
        '    let mut representationCorrespondence := false', '    let mut transformations := Lean.Json.arr #[]',
        '    try',
        `      let candidate ← proposition (${JSON.stringify(carrierNamespaces.candidate + '.' + pair.candidateTarget)}.toName)`,
        `      let reference ← proposition (${JSON.stringify(carrierNamespaces.reference + '.' + pair.referenceTarget)}.toName)`,
        '      candidateType := (← Lean.Meta.ppExpr candidate).pretty',
        '      referenceType := (← Lean.Meta.ppExpr reference).pretty',
        '      candidateBaseline ← baseline candidate', '      referenceBaseline ← baseline reference',
        '      definitionallyEqual ← Lean.Meta.isDefEq candidate reference',
        '      if candidateBaseline || referenceBaseline then reason := "baseline-trivial"',
        '      else',
        '        match ← permutations candidate reference with',
        '        | none =>',
        '          match ← representations candidate reference with',
        '          | none => reason := "not-definitionally-equal"',
        '          | some (forwardProof, backwardProof, trace) =>',
        `            prove (${JSON.stringify(forward)}.toName) candidate reference forwardProof`,
        `            prove (${JSON.stringify(backward)}.toName) reference candidate backwardProof`,
        '            representationCorrespondence := true',
        '            transformations := trace',
        '            status := "established"',
        '            reason := "proved-representation-conversion-with-opposite-assumption"',
        '        | some (forwardProof, backwardProof) =>',
        `          prove (${JSON.stringify(forward)}.toName) candidate reference forwardProof`,
        `          prove (${JSON.stringify(backward)}.toName) reference candidate backwardProof`,
        '          binderPermutation := true',
        '          status := "established"',
        '          reason := if definitionallyEqual then "definitional-identity-with-opposite-assumption" else "bijective-binder-permutation-with-opposite-assumption"',
        '    catch _ => pure ()',
        '    let direction (name : String) := Lean.Json.mkObj <| [("status", Lean.toJson status), ("reason", Lean.toJson reason)] ++',
        '      (if status == "established" then [("proofDeclaration", Lean.toJson name)] else [])',
        '    return Lean.Json.mkObj [',
        '      ("candidateTarget", Lean.toJson candidateTarget), ("referenceTarget", Lean.toJson referenceTarget),',
        '      ("candidateType", Lean.toJson candidateType), ("referenceType", Lean.toJson referenceType),',
        '      ("candidateBaseline", Lean.toJson candidateBaseline), ("referenceBaseline", Lean.toJson referenceBaseline),',
        '      ("definitionallyEqual", Lean.toJson definitionallyEqual), ("binderPermutation", Lean.toJson binderPermutation),',
        '      ("representationCorrespondence", Lean.toJson representationCorrespondence), ("transformations", transformations),',
        `      ("candidateToReference", direction ${JSON.stringify(forward)}),`,
        `      ("referenceToCandidate", direction ${JSON.stringify(backward)})])`,
        '  reports := reports.push pairReport',
      ];
    }),
    '  let report := (Lean.Json.mkObj [("schema", Lean.toJson "theoremos.reference-report.v2"), ("pairs", Lean.toJson reports)]).compress',
    '  if report.utf8ByteSize > 1000000 then throwError "reference report bound exceeded"',
    '  Lean.logInfo m!"THEOREMOS_REFERENCE_REPORT:{report}"',
    `  Lean.Core.liftIOCore <| IO.FS.writeFile ${JSON.stringify(FORMALIZATION_REFERENCE_REPORT)} report`, ''].join('\n');
}

/** Deterministic host files are also rebuilt when validating persisted evidence. */
export function formalizationReferenceFiles(input: FormalizationReferenceInput): Record<string, string> {
  input = formalizationReferenceInputSchema.parse(input);
  const candidateTargets = formalizationTargets(input.candidateSource).map(item => item.name);
  const referenceTargets = formalizationTargets(input.referenceSource).map(item => item.name);
  if (input.pairs.length !== candidateTargets.length || input.pairs.length !== referenceTargets.length ||
      input.pairs.some(pair => !candidateTargets.includes(pair.candidateTarget) || !referenceTargets.includes(pair.referenceTarget)))
    throw new Error('reference_target_mapping_incomplete');
  return { ...getLeanTaskEnvironment(input.environment).files,
    'ReferenceCandidate.lean': carrierSource(input.candidateSource, 'candidate'),
    'ReferenceGold.lean': carrierSource(input.referenceSource, 'reference'),
    [FORMALIZATION_REFERENCE_QUERY]: querySource(input) };
}

/** Validate saved advisory evidence against the exact request and host-generated files. */
export function assertFormalizationReferenceResult(input: FormalizationReferenceInput, value: unknown): asserts value is FormalizationReferenceResult {
  input = formalizationReferenceInputSchema.parse(input);
  const parsed = formalizationReferenceResultSchema.parse(value);
  if (parsed.schema === 'theoremos.formalization-reference.v1') {
    assertLegacyResult(input, value);
    return;
  }
  const result = parsed;
  const invalid = () => { throw new Error('formalization_reference_evidence_invalid'); };
  if (result.inputDigest !== mathDigest(canonicalMathJson(input)) ||
      result.candidateSourceSha256 !== mathDigest(input.candidateSource) || result.referenceSourceSha256 !== mathDigest(input.referenceSource) ||
      result.environment !== input.environment || result.environmentDigest !== getLeanTaskEnvironment(input.environment).dependencyDigest ||
      canonicalMathJson(result.pairs.map(pair => ({ candidateTarget: pair.candidateTarget, referenceTarget: pair.referenceTarget }))) !== canonicalMathJson(input.pairs))
    invalid();
  const allEstablished = result.pairs.every(pair => pair.candidateToReference.status === 'established' && pair.referenceToCandidate.status === 'established');
  if ((result.status === 'established') !== allEstablished) invalid();
  let expected: Record<string, string> | undefined;
  try { expected = formalizationReferenceFiles(input); } catch (cause) {
    if (cause instanceof Error && cause.message === 'reference_target_mapping_incomplete') invalid();
    // Unsupported source syntax only carries an unsupported, unknown receipt.
  }
  if (!expected) {
    if (result.status === 'established' || result.check !== 'unsupported' || !result.reason || result.files.length || result.evidence) invalid();
    return;
  }
  if (canonicalMathJson(result.files) !== canonicalMathJson(Object.entries(expected).map(([file, text]) => ({ file, text, sha256: mathDigest(text) })))) invalid();
  if (!result.evidence) {
    if (result.status === 'established' || result.check !== 'unavailable' || !result.reason) invalid();
    return;
  }
  if (result.check !== 'completed') invalid();
  const evidence = result.evidence, latest = evidence.latest as any;
  const sources = Object.entries(expected).filter(([file]) => file.endsWith('.lean')).map(([file, text]) => ({ file, digest: mathDigest(text) }));
  if (!latest || latest.schema !== 'theoremos.lean-diagnostics-latest.v1' || latest.authority !== 'advisory-lean-process' ||
      latest.toolIdentity !== evidence.toolIdentity || latest.sourceDigest !== evidence.sourceDigest || latest.environmentDigest !== evidence.environmentDigest ||
      latest.exitCode !== 0 || latest.timedOut !== false || latest.aborted !== false ||
      !Array.isArray(latest.sourceFiles) || canonicalMathJson([...latest.sourceFiles].sort((a, b) => a.file.localeCompare(b.file))) !== canonicalMathJson(sources.sort((a, b) => a.file.localeCompare(b.file))) ||
      !Array.isArray(latest.configuration) || latest.configuration.length !== LAKE_CONFIGURATION_FILES.length ||
      latest.configuration.some((entry: any, index: number) => entry.file !== LAKE_CONFIGURATION_FILES[index] ||
        (entry.file === '.lake/package-overrides.json' && input.environment === 'mathlib' ? !digest.safeParse(entry.digest).success :
          entry.digest !== (expected[entry.file] ? mathDigest(expected[entry.file]) : null))) ||
      evidence.sourceDigest !== mathDigest(JSON.stringify([latest.configuration.map((entry: any) => entry.digest ?? ''),
        latest.sourceFiles.map((entry: any) => [entry.file, entry.digest])])) ||
      mathDigest(evidence.reportText) !== evidence.reportSha256) invalid();
  const report = JSON.parse(evidence.reportText);
  if (report.schema !== 'theoremos.reference-report.v2' || !Array.isArray(report.pairs) || report.pairs.length !== result.pairs.length ||
      canonicalMathJson(report.pairs.map((pair: any) => ({ candidateTarget: pair.candidateTarget, referenceTarget: pair.referenceTarget,
        candidateToReference: pair.candidateToReference, referenceToCandidate: pair.referenceToCandidate }))) !== canonicalMathJson(result.pairs)) invalid();
  report.pairs.forEach((pair: any, index: number) => {
    const established = result.pairs[index].candidateToReference.status === 'established';
    if (typeof pair.representationCorrespondence !== 'boolean' || !Array.isArray(pair.transformations)) invalid();
    const transformations = z.array(transformation).parse(pair.transformations);
    if (pair.representationCorrespondence !== (transformations.length > 0) ||
        pair.representationCorrespondence && !established) invalid();
    for (const step of transformations) {
      if (step.before.context.length !== step.position.binderCount ||
          step.after.context.length !== step.position.binderCount ||
          step.before.context.some((entry, i) => entry.index !== i) ||
          step.after.context.some((entry, i) => entry.index !== i) ||
          canonicalMathJson(step.before.context) !== canonicalMathJson(step.after.context) ||
          canonicalMathJson(step.before.universes) !== canonicalMathJson(step.after.universes) ||
          !step.sideConditions.length) invalid();
    }
    if (established && (pair.candidateBaseline !== false || pair.referenceBaseline !== false ||
        (pair.definitionallyEqual !== true && pair.binderPermutation !== true && pair.representationCorrespondence !== true) ||
        pair.candidateToReference.proofDeclaration !== `TheoremOSCorrespondence.candidateToReference${index}` ||
        pair.referenceToCandidate.proofDeclaration !== `TheoremOSCorrespondence.referenceToCandidate${index}`)) invalid();
  });
  if (!Array.isArray(latest.diagnosticArtifacts) || latest.diagnosticArtifacts.length !== evidence.artifacts.length ||
      new Set(evidence.artifacts.map(record => record.digest)).size !== evidence.artifacts.length ||
      new Set(latest.diagnosticArtifacts.map((record: any) => record.digest)).size !== evidence.artifacts.length) invalid();
  for (const record of evidence.artifacts) {
    if (mathDigest(record.text) !== record.digest) invalid();
    const artifact = JSON.parse(record.text);
    if (!latest.diagnosticArtifacts.some((item: any) => item.digest === record.digest && item.captureComplete === true &&
        item.path === `.lake/diagnostic-artifacts/${record.digest}.json` && item.sourceDigest === evidence.sourceDigest && item.environmentDigest === evidence.environmentDigest) ||
        artifact.schema !== 'theoremos.lean-diagnostics.v1' || artifact.authority !== 'advisory-lean-process' || artifact.toolIdentity !== evidence.toolIdentity ||
        artifact.sourceDigest !== evidence.sourceDigest || artifact.environmentDigest !== evidence.environmentDigest || artifact.sourceCurrent !== true ||
        artifact.exitCode !== 0 || artifact.timedOut !== false || artifact.aborted !== false || artifact.captureComplete !== true ||
        canonicalMathJson(artifact.sourceFiles) !== canonicalMathJson(latest.sourceFiles) ||
        typeof artifact.stdout !== 'string' || typeof artifact.stderr !== 'string' ||
        mathDigest(artifact.stdout) !== artifact.stdoutSha256 || mathDigest(artifact.stderr) !== artifact.stderrSha256) invalid();
  }
  if (!evidence.artifacts.some(record => {
    const artifact = JSON.parse(record.text);
    return artifact.file === FORMALIZATION_REFERENCE_QUERY && artifact.stdout.split('\n').some((line: string) => {
      try {
        const message = JSON.parse(line);
        return ['info', 'information'].includes(message.severity) &&
          message.fileName === FORMALIZATION_REFERENCE_QUERY && message.data === 'THEOREMOS_REFERENCE_REPORT:' + evidence.reportText;
      } catch { return false; }
    });
  })) invalid();
}
