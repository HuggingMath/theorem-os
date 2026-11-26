import fs from 'node:fs';
import path from 'node:path';
import { getLeanTaskEnvironment } from '../math/leanTaskEnvironment';
import { readLeanTaskReceipt } from '../math/leanTask';
import { INFORMALIZATION_ALIGNMENT, INFORMALIZATION_EXPLANATION_POLICY, INFORMALIZATION_OUTLINE_POLICY,
  informalizationRequestSchema, prepareInformalization, readInformalizationRequest,
  type InformalizationPreparation, type InformalizationRequest } from '../math/informalization';
import { canonicalMathJson, mathDigest, readMathText } from '../math/mathRuntimeIo';
import { assertMathCanonicalPath } from '../math/paths';
import type { SolverProblem } from './problem';
import { runInformalization } from './informalization';

export type SolverExplanation = {
  target: string; proofPath: string; directory: string;
  status: 'pending' | 'running' | 'approved' | 'exhausted' | 'stopped' | 'error';
  artifact?: string; proof?: string; reason?: string;
};
export type SolverExplanations = {
  status: 'running' | 'approved' | 'partial' | 'stopped' | 'error' | 'disabled';
  language: 'zh' | 'en'; directory: string; targets: SolverExplanation[];
};
type Input = {
  problem: SolverProblem; worktree: string; directory: string; root: string; buildManifest: string;
  language: 'zh' | 'en'; writer: InformalizationRequest['writer']; env?: NodeJS.ProcessEnv; signal?: AbortSignal;
  onUpdate?: (summary: SolverExplanations) => void;
  onEvent?: (event: string, details: Record<string, unknown>) => void;
};
type Options = { run?: typeof runInformalization };
const reasonOf = (error: unknown) => error instanceof Error
  ? /^(?:informalization|lean_task)_[a-z_]+/u.exec(error.message)?.[0] ?? 'automatic_explanation_failed'
  : 'automatic_explanation_failed';

/** Recompile in the same runtime-owned environment; never silently switch a proof to another Mathlib revision. */
function explanationEnvironment(problem: SolverProblem, project: string): InformalizationRequest['environment'] {
  if (problem.kind === 'lean-task') return readLeanTaskReceipt(problem.activeProblemPath).environment ?? 'standard';
  const toolchain = readMathText(path.join(project, 'lean-toolchain'), 4096).trim();
  const manifestFile = path.join(project, 'lake-manifest.json');
  const manifest = fs.existsSync(manifestFile)
    ? JSON.parse(readMathText(manifestFile, 4_000_000)) as { packages?: { name?: string; rev?: string }[] } : undefined;
  const revision = manifest?.packages?.find(item => item.name === 'mathlib')?.rev ?? null;
  const environment = informalizationRequestSchema.shape.environment.options.find(id => {
    const config = getLeanTaskEnvironment(id);
    return config.toolchain === toolchain && (config.mathlibRevision ?? null) === revision;
  });
  if (!environment) throw new Error('informalization_environment_unsupported');
  return environment;
}

/** An accepted run's explanations, generated directly from its proof and resumable without another solver turn. */
export async function generateSolverExplanations(input: Input, options: Options = {}): Promise<SolverExplanations> {
  const directory = path.join(input.directory, 'explanations', input.language);
  const summary: SolverExplanations = { status: 'running', language: input.language, directory,
    targets: input.problem.targets.map(target => ({ target: target.theoremName, proofPath: target.proofPath,
      directory: path.join(directory, mathDigest(`${target.proofPath}\n${target.theoremName}`)), status: 'pending' })) };
  const update = () => input.onUpdate?.(summary);
  update();
  const project = path.join(input.worktree, input.problem.projectRelative);
  const generate = options.run ?? runInformalization;
  for (const target of summary.targets) {
    if (input.signal?.aborted) { target.status = 'stopped'; target.reason = 'informalization_stopped'; update(); continue; }
    target.status = 'running'; update();
    input.onEvent?.('explanation_started', { target: target.target, language: input.language, directory: target.directory });
    try {
      const environment = explanationEnvironment(input.problem, project);
      const preparation: InformalizationPreparation = {
        proofId: `proof_${mathDigest(target.target).slice(0, 32)}`, target: target.target,
        proofFile: path.join(project, target.proofPath), projectRoot: project, environment,
        statement: input.problem.contract.informalStatement || null, language: input.language,
        outputDelivery: 'file',
        writer: input.writer, auditors: [1, 2].map(index => ({ ...input.writer, id: `auditor-${index}` })),
        alignment: INFORMALIZATION_ALIGNMENT, explanationPolicy: INFORMALIZATION_EXPLANATION_POLICY,
        outlinePolicy: INFORMALIZATION_OUTLINE_POLICY, batching: { maxUnits: 12, maxSourceBytes: 60_000 },
        maxRoundsPerBatch: 0, maxRunSeconds: 0, maxTurnSeconds: 0, maxCompileSeconds: 0, maxTotalTokens: 0,
        buildManifestRef: input.buildManifest,
      };
      assertMathCanonicalPath(target.directory);
      if (fs.existsSync(target.directory)) {
        const { request } = readInformalizationRequest(target.directory);
        if (request.target !== target.target || request.language !== input.language || request.environment !== environment ||
            request.statement !== preparation.statement || canonicalMathJson(request.writer) !== canonicalMathJson(input.writer) ||
            request.buildManifestRef !== input.buildManifest ||
            request.buildDigest !== mathDigest(readMathText(input.buildManifest, 8_000_000)) ||
            request.sources.some(source => mathDigest(readMathText(path.join(project, source.origin), 16_000_000)) !== source.sha256))
          throw new Error('informalization_resume_identity_changed');
      } else {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        prepareInformalization(target.directory, preparation);
      }
      const result = await generate(target.directory, input.root, { env: input.env, signal: input.signal,
        onEvent: ({ event, ...details }) => input.onEvent?.('explanation_progress', { target: target.target, phase: event, ...details }) });
      target.status = result.status;
      if (result.artifact) target.artifact = result.artifact;
      if (result.proof) target.proof = result.proof;
      if (result.error) target.reason = reasonOf(new Error(result.error));
    } catch (error) {
      target.status = input.signal?.aborted ? 'stopped' : 'error'; target.reason = reasonOf(error);
    }
    update();
    input.onEvent?.('explanation_finished', { target: target.target, status: target.status,
      ...(target.reason ? { reason: target.reason } : {}), ...(target.proof ? { proof: target.proof } : {}) });
  }
  summary.status = summary.targets.every(target => target.status === 'approved') ? 'approved'
    : summary.targets.some(target => target.status === 'approved') ? 'partial'
    : summary.targets.some(target => target.status === 'stopped') ? 'stopped' : 'error';
  update();
  return summary;
}
