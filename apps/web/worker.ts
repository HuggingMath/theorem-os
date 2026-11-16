import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify as stringifyToml } from 'smol-toml';
import { prepareWebProblem } from './formalizationSeed';
import { classifyWebError, classifyWebResult } from './failure';
import { getLeanTaskEnvironment, type LeanTaskEnvironment } from '../../src/math/leanTaskEnvironment';
import { PANTOGRAPH_DIGEST_ENV, PANTOGRAPH_MANIFEST_ENV } from '../../src/math/pantographSession';
import { mathDigest, readMathJson, readMathText } from '../../src/math/mathRuntimeIo';
import { readMathBuildManifest } from '../../src/math/mathBuildManifest';
import { isMathPathWithin } from '../../src/math/paths';
import { researchHarness } from '../../src/runtime/researchHarness';
import { sub2apiModelCatalog } from '../../src/runtime/sub2api';
import { type SolverModules } from '../../src/solver/modules';
import { configurableSolverModules } from '../../src/solver/modules/custom';
import { solverModuleConfiguration } from '../../src/solver/modules/moduleIdentity';
import { researchWorkers } from '../../src/solver/modules/organization';
import { readSolverProblem } from '../../src/solver/problem';
import { runSolver } from '../../src/solver/run';
import { readKnowledgeCatalog } from '../../src/solver/theoremKnowledgeStore';
import { createWebProgressForwarder } from './progress';
import { withoutCheckMarkers } from './report';
import { webArtifactMaxBytes, webPreparationSeconds, type WebAgentActionBody, type WebArtifact, type WorkerInput, type WorkerMessage } from './shared';
import { createAgentActionStream, sanitizeAgentItem } from './agentActions';
import { createWebWorkerBridge, freezeWebKnowledge, writeWebActiveRun } from './workerBridge';
import { webByokModuleIdentity } from './webModuleIdentity';
import { webAgentLibraryAccess } from './frozenLibrary';
import { runWebLibraryResearch } from './libraryResearch';
import { webResearchArguments } from './researchMode';
import { bindWebWorkerProfile, pinWebWorkerSession, prepareWebNativeProfile, webHarnessEnvironment,
  webHarnessExecutable, webHarnessModel, webProviderHarness } from './harness';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
type WebWorkerState = {
  worktree: string;
  workers?: { id: string; worktree: string }[];
  check?: { passed: boolean; verification?: { status?: string; results?: Record<string, unknown>[] } };
};

function readCandidateSource(directory: string, file: string): { source: string; modifiedAt: number } | undefined {
  let descriptor: number | undefined;
  try {
    if (!file.startsWith(directory + path.sep)) return;
    const segments = path.relative(directory, file).split(path.sep);
    let current = directory;
    for (const [index, segment] of segments.entries()) {
      current = path.join(current, segment);
      const info = fs.lstatSync(current);
      if (info.isSymbolicLink() || (index < segments.length - 1 && !info.isDirectory())) return;
    }
    if (fs.realpathSync(file) !== file) return;
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > webArtifactMaxBytes) return;
    // Resolve the opened inode on Linux as well as the path, so directory swaps cannot escape the run.
    const openedPath = () => process.platform === 'linux' ? fs.realpathSync(`/proc/self/fd/${descriptor}`) : fs.realpathSync(file);
    if (openedPath() !== file) return;
    const buffer = Buffer.alloc(webArtifactMaxBytes + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = fs.readSync(descriptor, buffer, bytes, buffer.length - bytes, null);
      if (!count) break;
      bytes += count;
    }
    const after = fs.fstatSync(descriptor), currentInfo = fs.lstatSync(file);
    if (bytes > webArtifactMaxBytes || bytes !== before.size || after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
      currentInfo.isSymbolicLink() || currentInfo.ino !== after.ino || currentInfo.dev !== after.dev ||
      fs.realpathSync(file) !== file || openedPath() !== file) return;
    return { source: new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes)), modifiedAt: after.mtimeMs };
  } catch { return undefined; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

export function createWebArtifactSampler(options: {
  directory: string; output: string; workers: number; source: string; apiKey: string;
  onArtifact(artifact: WebArtifact): void;
}) {
  const directory = fs.realpathSync(options.directory);
  const workers = researchWorkers(path.join(options.output + '.runtime', 'worktree'), [], options.workers);
  const previous = new Map(workers.map(worker => [worker.id, options.source]));
  let lastSource = options.source;
  return () => {
    let latest: { workerId: string; source: string; modifiedAt: number } | undefined;
    for (const worker of workers) {
      const candidate = readCandidateSource(directory, path.join(worker.worktree, 'generated/problem/Submission.lean'));
      if (!candidate || candidate.source === previous.get(worker.id)) continue;
      previous.set(worker.id, candidate.source);
      if (!latest || candidate.modifiedAt >= latest.modifiedAt) latest = { ...candidate, workerId: worker.id };
    }
    if (!latest || latest.source === lastSource) return;
    const source = options.apiKey ? latest.source.replaceAll(options.apiKey, '[REDACTED]') : latest.source;
    if (Buffer.byteLength(source) > webArtifactMaxBytes) return;
    lastSource = latest.source;
    options.onArtifact({ source, workerId: latest.workerId, capturedAt: new Date().toISOString(), status: 'candidate' });
  };
}

export function readWebResultProof(options: {
  directory: string; workspace: string; status: unknown; winningWorker: unknown;
  state?: WebWorkerState; artifact?: WebArtifact;
}): string {
  const accepted = options.status === 'evaluated_passed';
  const selected = typeof options.winningWorker === 'string' && options.winningWorker.length > 0;
  // A parallel attempt can finish before any winner exists while another worker has useful live source.
  if (!accepted && !selected && !options.state?.check?.passed && options.artifact) return options.artifact.source;
  if (!options.state) return '';
  const tree = accepted ? options.workspace :
    options.state.workers?.find(worker => worker.id === options.winningWorker)?.worktree ?? options.state.worktree;
  const file = path.resolve(tree, 'generated/problem/Submission.lean');
  if (file.startsWith(options.directory + path.sep)) {
    try { return readMathText(file, webArtifactMaxBytes); } catch { /* Rejected or oversized candidates have no downloadable source. */ }
  }
  return '';
}

/**
 * Why a run ended `incomplete` without a failure: its shared turn allowance ran out, its solving budget ran out
 * before the abort fired, or no research route was left to run. Settings come from the request the worker ran.
 */
export function webIncompleteReason(raw: Record<string, unknown>, input: Pick<WorkerInput['input'], 'maxTurns' | 'maxRunSeconds'>) {
  if (raw.status !== 'incomplete' || raw.reason) return;
  if (input.maxTurns > 0 && typeof raw.turns === 'number' && raw.turns >= input.maxTurns) return 'math_turn_limit_reached';
  const elapsed = raw.solveExecutionMs ?? raw.solveWallMs;
  if (input.maxRunSeconds > 0 && typeof elapsed === 'number' && elapsed >= input.maxRunSeconds * 1_000) return 'math_run_stopped';
  return 'math_research_routes_exhausted';
}

type ProviderInput = Pick<WorkerInput, 'provider'> & { input: Pick<WorkerInput['input'], 'model' | 'effort'> };
export function webProviderConfig(input: ProviderInput, modelCatalog?: string): string {
  return stringifyToml({
    model: input.input.model, model_provider: 'web_provider', model_reasoning_effort: input.input.effort,
    ...(modelCatalog ? { model_catalog_json: modelCatalog,
      features: { multi_agent: false, multi_agent_v2: false, goals: false, view_image: false } } : {}),
    approval_policy: 'never', sandbox_mode: 'workspace-write',
    model_providers: { web_provider: { name: input.provider.name, base_url: input.provider.baseUrl,
      wire_api: 'responses', env_key: 'THEOREMOS_PROVIDER_API_KEY', requires_openai_auth: false,
      request_max_retries: 0, stream_max_retries: 0, stream_idle_timeout_ms: 60_000 } },
    shell_environment_policy: { inherit: 'all', exclude: ['THEOREMOS_PROVIDER_API_KEY'] },
    history: { persistence: 'none' }, analytics: { enabled: false },
  });
}

export function prepareWebProviderProfile(profile: string, request: ProviderInput): void {
  fs.mkdirSync(profile, { mode: 0o700 });
  const modelCatalog = request.provider.id === 'sub2api' ? path.join(profile, 'models.json') : undefined;
  if (modelCatalog) fs.writeFileSync(modelCatalog, JSON.stringify(sub2apiModelCatalog()), { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(path.join(profile, 'config.toml'), webProviderConfig(request, modelCatalog), { mode: 0o600, flag: 'wx' });
}

/**
 * Writes the version a run continues from beside the task as the solver's continuation input: the file is an advisory
 * attachment every Agent can read, recorded but not replayed here; the task file and the problem stay the original's.
 * Returns the manifest to pass as --continuation-manifest.
 */
export function writeWebContinuation(directory: string, continuation: NonNullable<WorkerInput['continuation']>,
  identity: { taskFile: string; workspace: string; receiptFile: string }): string {
  const content = Buffer.from(continuation.source, 'utf8'), file = path.join(directory, 'continuation-previous.lean');
  fs.writeFileSync(file, content, { mode: 0o600, flag: 'wx' });
  const manifest = {
    schema: 'theorem-os.continuation-input.v1',
    taskDigest: mathDigest(fs.readFileSync(identity.taskFile, 'utf8')),
    problemReceiptDigest: readSolverProblem(identity.workspace, identity.receiptFile).receiptDigest,
    attachments: [{ id: 'previous-version', kind: 'proof-source', path: path.basename(file), bytes: content.length, sha256: mathDigest(content),
      provenance: { source: `${continuation.label} (${continuation.file})`.slice(0, 1000), evidence: 'recorded-not-replayed', runId: continuation.runId,
        ...(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(continuation.commit) ? { commit: continuation.commit } : {}) } }],
  };
  const manifestFile = path.join(directory, 'continuation-input.json');
  fs.writeFileSync(manifestFile, JSON.stringify(manifest), { mode: 0o600, flag: 'wx' });
  return manifestFile;
}

/**
 * Agent shells in this container cannot read the application or its build state; they run the bundled commands from
 * scripts/build-agent-tools.ts instead, which the image installs here.
 */
export const webAgentToolsDefault = '/opt/theoremos-agent-tools/math.mjs';
export const webPantographManifest = '/opt/theoremos-pantograph/manifest.json';
/** Proof search needs the existing sealed Mathlib/FUSE environment. Standard workers have no lease. */
export function configureWebProofSearchEnvironment(environment: LeanTaskEnvironment, env: NodeJS.ProcessEnv = process.env): void {
  if (environment === 'mathlib') env[PANTOGRAPH_MANIFEST_ENV] = webPantographManifest;
  else { delete env[PANTOGRAPH_MANIFEST_ENV]; delete env[PANTOGRAPH_DIGEST_ENV]; }
}
export type WebAgentIsolation = { tools: string; hiddenRoots: readonly string[] };

const webProofProgressInstructions = `Public mathematical progress for the user:
Use public commentary messages in the language of the original problem. At the start of this turn and when meaningful mathematical progress or a change of approach occurs, explain the current proof route and why it applies. As relevant, state concrete lemma statements and their hypotheses, the mathematical conclusions established so far, how Lean feedback changes the approach, and what you will verify next. Use formulas and coherent mathematical explanations to make the results understandable. Distinguish proposed arguments, local Lean checks and independent host acceptance.
Write user-facing mathematical explanations and observed results; keep private reasoning and scratch work private. Continue to maintain RESEARCH.md and the required protocol JSON, and also provide the public explanation through commentary. Keep the existing delivery contracts, allowed edits and independent proof acceptance unchanged.
Continue the assigned work in this same turn after each update. Updates need no extra model request or user confirmation. Give updates at meaningful points; an update is not required before every command.`;

export function webSolverModules(request: WorkerInput, actions?: { sink: (action: WebAgentActionBody) => void; hidden: readonly string[] },
  isolation?: WebAgentIsolation): SolverModules {
  webResearchArguments(request.input, request.provider);
  const base = configurableSolverModules(request.input.modulePlan, request.input.coordination, request.input.workers);
  const identity = webByokModuleIdentity(solverModuleConfiguration(base));
  let sessions = 0;
  return { ...base, id: identity.id,
    ...(isolation ? { M4: { ...base.M4, tools: isolation.tools,
      build: (problem, state, access) => base.M4.build(problem, state, { ...access, tools: isolation.tools }) } } : {}),
    M1: { ...base.M1, version: identity.versions.M1!,
      open: options => {
        const workerId = options.environment?.DEEPSCIENTIST_MATH_WORKER_ID;
        // Each item is sanitized here, inside the container, before it is written to the host.
        const context = actions && workerId ? { workerId, worktree: options.workspace, hidden: actions.hidden,
          tool: isolation?.tools ?? path.join(root, 'bin/math.ts'), apiKey: request.input.apiKey } : undefined;
        // Native item ids are scoped to one session; a restarted session may number its own.
        const session = ++sessions;
        const stream = context ? createAgentActionStream(actions!.sink) : undefined;
        if (stream) { options.signal?.addEventListener('abort', stream.stop, { once: true }); if (options.signal?.aborted) stream.stop(); }
        const show = (phase: 'started' | 'completed', item: Record<string, unknown>, incremental = false) => {
          const id = typeof item.id === 'string' ? `${session}:${item.id}` : item.id;
          const action = sanitizeAgentItem(phase, { ...item, id }, context!);
          if (typeof id === 'string') stream!.write(phase, id, action, incremental);
        };
        const harness = researchHarness(webProviderHarness(request.provider));
        const binding = harness.id === 'codex' ? undefined : bindWebWorkerProfile(options, request.provider);
        return harness.open({ ...options, ...(binding ? { profile: binding.profile } : {}),
          ...(isolation ? { hiddenRoots: [...(options.hiddenRoots ?? []), ...isolation.hiddenRoots] } : {}),
          environment: { ...options.environment, ...webHarnessEnvironment(request.provider, request.input.apiKey) },
          ...(context ? { onItem: (phase, item) => show(phase, item),
            onItemUpdate: (item, context) => { options.onItemUpdate?.(item, context); show('started', item, true); } } : {}) })
          .then(opened => {
            if (binding) pinWebWorkerSession(opened, binding);
            if (!stream) return opened;
            const run = opened.run, interrupt = opened.interrupt, close = opened.close;
            opened.run = async (...args) => {
              stream.reset(); if (options.signal?.aborted) stream.stop();
              args[0] += `\n\n${webProofProgressInstructions}`;
              try { return await run(...args); } finally { stream.stop(); }
            };
            opened.interrupt = async () => { stream.stop(); await interrupt(); };
            opened.close = async () => { stream.stop(); options.signal?.removeEventListener('abort', stream.stop); await close(); };
            return opened;
          });
      } } };
}

async function main() {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 16 * 1024 * 1024) throw new Error('运行输入过大。');
    chunks.push(chunk);
  }
  const request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as WorkerInput;
  const key = request.input.apiKey;
  const send = (message: WorkerMessage) => process.stdout.write(
    JSON.stringify(message).replaceAll(JSON.stringify(key).slice(1, -1), '[REDACTED]') + '\n');
  const workspaceRoot = process.env.THEOREMOS_WORKER_ROOT || '/work';
  const directory = fs.mkdtempSync(path.join(workspaceRoot, 'run-'));
  let output = path.join(directory, 'result.json');
  writeWebActiveRun({ webRunId: request.id, directory, output }, path.join(workspaceRoot, 'active-run.json'));
  let bridge = createWebWorkerBridge({ webRunId: request.id, directory, output, apiKey: key, onMessage: send });
  const harness = webProviderHarness(request.provider);
  const profile = path.join(directory, harness === 'codex' ? 'codex' : 'harness');
  if (harness === 'codex') prepareWebProviderProfile(profile, request);
  else prepareWebNativeProfile(profile, request.provider, request.input);
  fs.mkdirSync(process.env.HOME || '/work/home', { recursive: true, mode: 0o700 });
  // Each container owns this profile. No machine profile or authentication file is read.
  if (harness === 'codex') process.env.CODEX_HOME = profile;
  process.env.DEEPSCIENTIST_MATH_ENV_FILE = path.join(directory, 'math.env');
  fs.writeFileSync(process.env.DEEPSCIENTIST_MATH_ENV_FILE, '', { mode: 0o400, flag: 'wx' });
  const originalLog = console.log;
  let sampleArtifact: (() => void) | undefined;
  let artifactTimer: ReturnType<typeof setInterval> | undefined;
  let observationTimer: ReturnType<typeof setInterval> | undefined;
  let capturePending: Promise<unknown> | undefined;
  const capture = (final = false) => capturePending ??= bridge.capture({ includeCatalog: final, force: final })
    .catch(error => {
      // The marker exists during preparation, before the first solver checkpoint is available.
      if (fs.existsSync(`${output}.runtime/state.json`) && error instanceof Error && error.message !== 'math_runtime_lease_busy')
        send({ type: 'progress', event: 'observation_unavailable', message: `研究观察暂不可用：${error.message}。` });
    }).finally(() => { capturePending = undefined; });
  let latestArtifact: WebArtifact | undefined;
  const forwardProgress = createWebProgressForwarder(send);
  console.log = (...args: unknown[]) => {
    for (const value of args) if (typeof value === 'string') {
      try {
        const event = JSON.parse(value);
        forwardProgress(event);
        if (['turn_checkpoint', 'proof_check_started', 'candidate_selected', 'evaluation_started'].includes(event.event)) sampleArtifact?.();
      } catch { /* Unstructured runtime output stays private to this disposable container. */ }
    }
  };
  console.error = () => {};
  try {
    const environment = getLeanTaskEnvironment(request.input.environment ?? 'standard');
    configureWebProofSearchEnvironment(environment.id);
    const receipt = prepareWebProblem(directory, request);
    const buildFile = process.env.THEOREMOS_WORKER_BUILD || '/opt/theoremos-build.json';
    const buildIndex = readMathJson(buildFile) as { buildManifestRef: string };
    readMathBuildManifest(buildIndex.buildManifestRef, root, path.join(root, 'out/main'));
    const taskFile = receipt.taskFile;
    const knowledgeFile = freezeWebKnowledge(directory, request.knowledgeCatalog);
    if (request.input.knowledgeDigest) {
      if (!knowledgeFile) throw new Error('math_knowledge_identity_changed');
      readKnowledgeCatalog(knowledgeFile, request.input.knowledgeDigest);
    }
    const continuationFile = request.continuation && writeWebContinuation(directory, request.continuation,
      { taskFile, workspace: receipt.workspaceRoot, receiptFile: receipt.activeProblemPath });
    artifactTimer = setInterval(() => sampleArtifact?.(), 1_500);
    observationTimer = setInterval(() => { void capture(); }, 1_500);
    const buildState = path.dirname(path.dirname(path.dirname(buildIndex.buildManifestRef)));
    const tools = process.env.THEOREMOS_WORKER_AGENT_TOOLS || webAgentToolsDefault;
    // Without the bundle the shells would need the application itself, so the run stops rather than expose it.
    if (!fs.existsSync(tools) || isMathPathWithin(root, fs.realpathSync(tools))) throw new Error('math_agent_tools_unavailable');
    const modules = webSolverModules(request, { sink: action => send({ type: 'action', action }),
      // The application, its build state (…/builds/<id>/manifest.json) and this run's directory: the other Agents' worktrees,
      // the Codex profile and the solver's state. An Agent's own worktree inside the run directory is shown relative.
      hidden: [root, buildState, buildFile, directory, path.join(workspaceRoot, 'active-run.json')] },
      { tools, hiddenRoots: [root, buildState] });
    const completed = await runWebLibraryResearch({ directory, request, seed: receipt, output, continuationFile,
      libraryCatalog: webAgentLibraryAccess(environment.id), run: async round => {
      output = round.output;
      writeWebActiveRun({ webRunId: request.id, directory, output }, path.join(workspaceRoot, 'active-run.json'));
      bridge = createWebWorkerBridge({ webRunId: request.id, directory, output, apiKey: key, onMessage: send,
        ...(round.previousSolverRunId ? { libraryRestart: { previousSolverRunId: round.previousSolverRunId, round: round.round } } : {}) });
      sampleArtifact = createWebArtifactSampler({ directory, output, workers: request.input.workers,
        source: request.input.source, apiKey: key, onArtifact: artifact => {
          latestArtifact = artifact;
          send({ type: 'artifact', artifact });
        } });
      if (round.round) send({ type: 'progress', event: 'library_continuation_started',
        message: `已装入请求的库依赖，保留原题与研究材料，开始第 ${round.round + 1} 轮。` });
      await runSolver(['--workspace', round.seed.workspaceRoot, '--task-file', round.seed.taskFile, '--output', output,
      '--receipt-file', round.seed.activeProblemPath, '--build-manifest', buildIndex.buildManifestRef,
      '--model', webHarnessModel(request.provider, request.input.model), '--effort', request.input.effort, '--workers', String(request.input.workers), '--no-explanations',
      '--coordination', request.input.coordination, '--max-turns', String(round.limits.maxTurns),
      ...webResearchArguments(request.input, request.provider),
      ...(harness !== 'codex' || request.provider.execution?.executable ? ['--harness', harness, '--harness-profile', profile, '--harness-executable', webHarnessExecutable(request.provider)] : []),
      ...(request.input.planApproval ? ['--plan-approval'] : []),
      ...(knowledgeFile ? ['--knowledge-base', knowledgeFile] : []),
      ...(round.continuationFile ? ['--continuation-manifest', round.continuationFile] : []),
      ...(round.libraryCatalog ? ['--library-catalog', round.libraryCatalog.file, '--library-catalog-sha256', round.libraryCatalog.digest] : []),
      // Cooperative role checkpoints preserve streaming requests and saved decisions; the shared run budget still applies.
      '--max-run-seconds', String(round.limits.maxRunSeconds),
      '--max-turn-seconds', request.input.coordination === 'cooperative' ? '0' : String(round.limits.maxRunSeconds),
      ...(round.limits.maxTotalTokens ? ['--max-total-tokens', String(round.limits.maxTotalTokens)] : []),
      '--prepare-timeout-seconds', String(round.limits.maxRunSeconds === 0 ? 0 : webPreparationSeconds[environment.id === 'mathlib' ? 'mathlib' : 'standard']),
      ...(round.limits.maxRunSeconds === 0 ? ['--proof-timeout-seconds', '0'] : []),
      '--evaluator-timeout-seconds', round.limits.maxRunSeconds === 0 ? '0' : '120'], root, modules);
      sampleArtifact();
      await capturePending;
      await capture(true);
    } });
    clearInterval(artifactTimer);
    clearInterval(observationTimer);
    const raw = completed.raw;
    const report = Object.fromEntries(['schema', 'runId', 'problemId', 'status', 'solution_commit',
      'solver_ready_receipt_valid', 'completion_signal_valid', 'evaluator', 'turns', 'solveWallMs', 'solveExecutionMs', 'solveWaitingMs', 'usage',
      'winningWorker', 'workers', 'reason', 'tokenBudget', 'libraryResearch', 'libraryUsage'].filter(field => Object.hasOwn(raw, field)).map(field => [field, raw[field]]));
    const failure = classifyWebResult(raw);
    if (failure) report.failure = failure;
    const stopReason = webIncompleteReason(raw, request.input);
    if (stopReason) report.stopReason = stopReason;
    report.environment = { id: environment.id, toolchain: environment.toolchain,
      dependencyDigest: environment.dependencyDigest,
      ...(environment.mathlibRevision ? { mathlibRevision: environment.mathlibRevision } : {}) };
    const stateFile = `${output}.runtime/state.json`;
    const state = fs.existsSync(stateFile) ? readMathJson(stateFile) as WebWorkerState : undefined;
    if (state) {
      if (state.check) report.candidateCheck = { passed: state.check.passed,
        status: state.check.verification?.status,
        results: state.check.verification?.results?.slice(0, 64).map(result => Object.fromEntries(
          ['theoremName', 'status', 'sorryCount', 'admitCount', 'error', 'stdoutPreview', 'stderrPreview']
            .filter(field => Object.hasOwn(result, field)).map(field => [field, typeof result[field] !== 'string' ? result[field]
              : (field.endsWith('Preview') ? withoutCheckMarkers(result[field]) : result[field]).slice(0, 2_000)])
            .filter(([, value]) => value !== ''))) };
    }
    const proof = readWebResultProof({ directory, workspace: completed.seed.workspaceRoot, status: raw.status,
      winningWorker: raw.winningWorker, state, artifact: latestArtifact });
    send({ type: 'result', result: { status: String(raw.status || 'runtime_error'), proof, report } });
  } catch (error) {
    await capturePending;
    await capture(true);
    send({ type: 'error', message: '运行未能完成。请检查 Lean 原题、模型服务配置与隔离环境。', failure: classifyWebError(error) });
    process.exitCode = 1;
  } finally {
    clearInterval(artifactTimer);
    clearInterval(observationTimer);
    request.input.apiKey = '';
    console.log = originalLog;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stdout.write(JSON.stringify({ type: 'error', message: '运行输入无效或环境无法初始化。' }) + '\n');
    process.exitCode = 1;
  });
}
