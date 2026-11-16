#!/usr/bin/env bun
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { parseFlags, required } from './arguments';
import { withWorkflowHarness, workflowHarnessFlags } from './workflowHarness';
import { formalizationEvaluationProvenanceSchema, prepareFormalizationEvaluation,
  scoreFormalizationEvaluation } from '../../src/math/formalizationEvaluation';
import { readMathText, writeMathFrozen } from '../../src/math/mathRuntimeIo';
import { assertMathCanonicalPath, isMathPathWithin } from '../../src/math/paths';
import { fileURLToPath } from 'node:url';
import { formalizationReviewConfigurationSchema } from '../../src/math/formalizationReview';
import { LEAN_STATEMENT_CONTEXT_PROTOCOL } from '../../src/math/leanStatementSemantic';
import { readFormalizationAdjudications } from '../../src/math/formalizationAdjudication';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
export async function evaluateFormalization(argv: string[]): Promise<number> {
  const flags = parseFlags(argv, ['phase', 'directory', 'input', 'format', 'provenance',
    'validation-percent', 'split-seed', 'source-split', 'decisions', 'output', 'run-directory',
    'execution', 'replay', 'environment', 'protocol', 'model', 'effort', 'profile', 'codex', ...workflowHarnessFlags, 'build-manifest', 'adjudications']);
  if (flags.has('help')) {
    console.log('Usage: theorem-os evaluate-formalization --phase prepare|review|score --directory DIR [options]\n'
      + 'prepare, score and replay: no model, Lean compiler, provider or credentials are accessed.\n'
      + 'prepare: --input JSONL --format proofnetverif|normalized --provenance JSON\n'
      + '  [--source-split validation|test] preserves the supplied upstream ProofNetVerif export split.\n'
      + '  Otherwise [--validation-percent 20 --split-seed TEXT] creates a local partition, not an official split.\n'
      + '  These flags apply to proofnetverif only; normalized rows carry explicit splits.\n'
      + '  Produces frozen review/ inputs without labels, references, split names or original IDs; keep private/ separate.\n'
      + 'review: --run-directory DIR --execution replay|model [--environment mathlib|standard]\n'
      + '  [--protocol v1|v2] New model runs default to v2 with --environment auto; saved v1 runs retain v1.\n'
      + '  v2 environments: auto|standard|mathlib|mathlib-4.8. Source-aware host statement elaboration, structured evidence and targeted independent recheck.\n'
      + '  New v2 model reviews freeze kernel-v3 complete local semantics and bounded imported structure fields; missing required observations remain unknown.\n'
      + '  New model reviews also freeze task-preserving-v1: whole-claim scope evidence and guarded Lean correspondence before approval.\n'
      + '  replay requires --replay JSON; runs saved preset outputs, not a model accuracy test.\n'
      + '  model requires --build-manifest FILE and invokes real models in isolated fresh sessions.\n'
      + '  Model options: --model deepseek-flash --effort max --profile DIR --codex FILE; explicit --harness ID --harness-profile DIR --harness-executable FILE freezes the backend. Sealed roles currently require Codex.\n'
      + '  Direct semantic review; resume reuses completed receipts, including explicit unknown. No run or turn time limit.\n'
      + 'score: --decisions JSON; missing decisions remain unknown, invalid or duplicate records are rejected.\n'
      + '  [--adjudications JSON] adds saved candidate-refutation evidence separately; labels and scores remain unchanged.\n'
      + '  Reports validation, test and descriptive overall denominators; heldOut always excludes validation.\n'
      + '  Measures upstream-label agreement; semantic truth, candidate generation and original theorem proof acceptance are not measured.\n'
      + '--output FILE exclusively writes the returned JSON outside the repository, prepared bundle and review run.\n'
      + 'See docs/formalization-evaluation.md for strict schemas, label provenance and compilation observations.');
    return 0;
  }
  const phase = required(flags, 'phase');
  const modelFlags = ['model', 'effort', 'profile', 'codex', ...workflowHarnessFlags, 'build-manifest'];
  const allowed: Record<string, string[]> = {
    prepare: ['input', 'format', 'provenance', 'validation-percent', 'split-seed', 'source-split'],
    review: ['run-directory', 'execution', 'replay', 'environment', 'protocol', ...modelFlags], score: ['decisions', 'adjudications'],
  };
  if (!Object.hasOwn(allowed, phase)) throw new Error('Unknown formalization evaluation phase.');
  for (const key of flags.keys()) if (!['phase', 'directory', 'output', ...allowed[phase]].includes(key))
    throw new Error(`--${key} is not valid for --phase ${phase}`);
  const directory = path.resolve(required(flags, 'directory'));
  const runDirectory = phase === 'review' ? path.resolve(required(flags, 'run-directory')) : undefined;
  const output = flags.has('output') ? path.resolve(required(flags, 'output')) : undefined;
  if (output) {
    assertMathCanonicalPath(output);
    if (isMathPathWithin(root, output) || isMathPathWithin(directory, output) ||
        runDirectory && isMathPathWithin(runDirectory, output))
      throw new Error('formalization_eval_report_must_be_external');
    if (fs.existsSync(output)) throw new Error('formalization_eval_report_exists');
    if (!fs.statSync(path.dirname(output)).isDirectory()) throw new Error('formalization_eval_report_parent_missing');
  }
  let report: unknown, code = 0;
  if (phase === 'prepare') {
    const provenanceFile = path.resolve(required(flags, 'provenance')); assertMathCanonicalPath(provenanceFile);
    const provenance = formalizationEvaluationProvenanceSchema.parse(JSON.parse(readMathText(provenanceFile, 64 * 1024)));
    const format = required(flags, 'format');
    if (format !== 'proofnetverif' && format !== 'normalized') throw new Error('--format must be proofnetverif or normalized');
    const percentage = flags.get('validation-percent');
    if (percentage !== undefined && (!/^[1-9][0-9]?$/u.test(percentage) || Number(percentage) > 99))
      throw new Error('--validation-percent must be an integer from 1 to 99');
    const suppliedSplit = flags.get('source-split');
    let sourceSplit: 'validation' | 'test' | undefined;
    if (suppliedSplit === 'validation' || suppliedSplit === 'test') sourceSplit = suppliedSplit;
    else if (suppliedSplit !== undefined) throw new Error('--source-split must be validation or test');
    report = prepareFormalizationEvaluation({ directory, inputFile: path.resolve(required(flags, 'input')), format, provenance,
      ...(percentage === undefined ? {} : { validationPercent: Number(percentage) }),
      ...(sourceSplit === undefined ? {} : { sourceSplit }),
      ...(flags.has('split-seed') ? { splitSeed: required(flags, 'split-seed') } : {}) });
  } else if (phase === 'review') {
    const execution = required(flags, 'execution');
    if (execution !== 'replay' && execution !== 'model') throw new Error('--execution must be replay or model');
    const incompatible = execution === 'replay' ? modelFlags : ['replay'];
    for (const key of incompatible) if (flags.has(key)) throw new Error(`--${key} is not valid for --execution ${execution}`);
    let protocol = flags.get('protocol');
    if (protocol !== undefined && protocol !== 'v1' && protocol !== 'v2') throw new Error('--protocol must be v1 or v2');
    // An omitted flag resumes the existing frozen protocol; it never upgrades old evidence.
    const savedRequest = path.join(runDirectory!, 'request.json');
    let saved: { schema?: string; configuration?: { contextProtocol?: unknown; fidelityPolicy?: unknown;
      model?: string; effort?: string; profile?: string; executable?: string;
      agentHarness?: import('../../src/math/agentHarnessIdentity').AgentHarnessIdentity } } | undefined;
    if (fs.existsSync(savedRequest)) {
      assertMathCanonicalPath(savedRequest);
      saved = JSON.parse(readMathText(savedRequest, 32_000_000));
      if (saved.schema !== 'theorem-os.formalization-review-run.v1' && saved.schema !== 'theorem-os.formalization-review-run.v2')
        throw new Error('formalization_review_request_protocol_invalid');
      if (protocol === undefined) protocol = saved.schema === 'theorem-os.formalization-review-run.v2' ? 'v2' : 'v1';
    }
    protocol ??= execution === 'model' ? 'v2' : 'v1';
    const environment = flags.get('environment') ?? (protocol === 'v2' ? 'auto' : 'mathlib');
    if (!['standard', 'mathlib', ...(protocol === 'v2' ? ['auto', 'mathlib-4.8'] : [])].includes(environment))
      throw new Error('--environment is not supported by --protocol ' + protocol);
    // Context protocol is frozen independently of v2: old saved v2 requests stay unchanged.
    const contextProtocol = saved ? saved.schema === 'theorem-os.formalization-review-run.v2' ?
      saved.configuration?.contextProtocol : undefined : execution === 'model' && protocol === 'v2' ? LEAN_STATEMENT_CONTEXT_PROTOCOL : undefined;
    const fidelityPolicy = saved ? saved.schema === 'theorem-os.formalization-review-run.v2' ?
      saved.configuration?.fidelityPolicy : undefined : execution === 'model' && protocol === 'v2' ? 'task-preserving-v2' : undefined;
    const savedModel = saved?.configuration?.agentHarness ? saved.configuration : undefined;
    const common = { environment, ...(protocol === 'v2' ? { protocol: 'v2',
      ...(contextProtocol === undefined ? {} : { contextProtocol }),
      ...(fidelityPolicy === undefined ? {} : { fidelityPolicy }) } : {}) };
    const configuration = formalizationReviewConfigurationSchema.parse(execution === 'replay' ? {
      execution, replayFile: path.resolve(required(flags, 'replay')), ...common,
    } : {
      execution, ...common, buildManifestRef: path.resolve(required(flags, 'build-manifest')),
      ...withWorkflowHarness(flags, {
        model: flags.has('model') ? required(flags, 'model') : savedModel?.model ?? 'deepseek-flash',
        effort: flags.has('effort') ? required(flags, 'effort') : savedModel?.effort ?? 'max',
        profile: path.resolve(flags.has('profile') ? required(flags, 'profile') :
          savedModel?.profile || process.env.CODEX_HOME || path.join(os.homedir(), '.config/deepscientist/math-sol-codex')),
        executable: flags.has('codex') ? required(flags, 'codex') : savedModel?.executable || process.env.DEEPSCIENTIST_MATH_CODEX_EXECUTABLE || 'codex',
        ...(savedModel?.agentHarness ? { agentHarness: savedModel.agentHarness } : {}),
      }, { environment: environment === 'auto' ? 'mathlib' : environment as 'mathlib' | 'standard' }),
    });
    const controller = new AbortController(), interrupt = () => controller.abort();
    process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
    try {
      const { runFormalizationReview } = await import('../../src/solver/formalizationReview');
      const result = await runFormalizationReview(directory, runDirectory!, configuration, { signal: controller.signal });
      report = result; code = result.status === 'complete' ? 0 : result.status === 'stopped' ? 130 : 2;
    } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
  } else {
    const score = scoreFormalizationEvaluation(directory, path.resolve(required(flags, 'decisions')));
    report = flags.has('adjudications') ? { ...score,
      candidateTruthEvidence: readFormalizationAdjudications(directory, path.resolve(required(flags, 'adjudications'))) } : score;
  }
  if (output) writeMathFrozen(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  return code;
}
export { evaluateFormalization as main };
if (import.meta.main) evaluateFormalization(process.argv.slice(2)).then(code => { process.exitCode = code; }, cause => {
  console.error(errorText(cause)); process.exitCode = 1;
});
