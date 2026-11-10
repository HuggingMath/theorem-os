#!/usr/bin/env bun
/** Export recorded results for the website. Reads the campaign; never changes or runs its solver. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { ArchiveKnowledgeApplication, ArchiveLibraryUsage, ArchiveProcess, ArchiveRecord } from '../docs/web/types';
import { archivedSourceReader, extractProcessEvidence } from './enrich-archive-process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
const iso = (value: number | undefined) => value ? new Date(value).toISOString() : undefined;
const publicText = (value: unknown): string => String(value ?? '')
  .replace(/\/(?:home|tmp|data|runtime)\/[^\s"'`<>\])}]+/gu, '[local file]')
  .replace(/\bsk-[A-Za-z0-9_-]{12,}/gu, '[redacted key]');
const descriptions: Record<string, [string, string, string, string, string]> = {
  CartierChartCompactnessSupport: ['Normalized Cartier chart retractions', '归一化 Cartier 坐标回缩的紧致性', '代数几何与拓扑', '在题设代数条件下，证明由归一化权重参数化的闭坐标图域回缩族构成紧集。', 'Under the stated algebraic hypotheses, the closed-chart field retractions parametrized by normalized weights form a compact set.'],
  SnakyCertificate: ['The 35-move Snaky certificate', 'Snaky 的 35 步证书核验', '组合博弈', '验证 Snaky 证书的 610 条表项、1,837 个放置项，以及关键重建局面和递归深度界。', 'Verifies the 610-entry Snaky certificate, its 1,837 placements, reconstructed positions and depth bounds.'],
  SnakyConditional: ['A 35-move winning strategy for Snaky', 'Snaky 的 35 步获胜策略', '组合博弈', '构造面对合法应手时能在 35 步内完成 Snaky 的合法策略，并证明题设棋盘不变量。', 'Constructs a legal strategy completing a Snaky within 35 moves against legal replies while preserving the stated board invariants.'],
  TotientCompanionZero: ['Totient companion: zero case', '欧拉函数伴随定理的零值情形', '数论', '不存在满足指定倍数条件的种子时，证明加权计数与极限系数均为零。', 'In the no-seed case, the weighted count and its limiting coefficient both vanish.'],
  TruffetCounterexample: ['A finite counterexample to Truffet’s procedure', 'Truffet 优化程序的有限反例', '热带优化', '构造两步均具有唯一选择且正常终止的执行，所得可行解目标值为 1，而另一可行解目标值为 0。', 'A forced two-step execution terminates with objective value 1 despite a feasible alternative of value 0.'],
  HoneycombFreeEnergy: ['The honeycomb free-energy limit', '蜂窝格自由能极限的存在性', '概率与统计物理', '证明蜂窝格自避游走的单位长度对数配分函数在给定外力参数下收敛。', 'Convergence of the normalized logarithmic partition function for honeycomb self-avoiding walks under the specified force parameters.'],
  PlaneColoring: ['A seven-coloring of the Euclidean plane', '欧氏平面的七色着色', '离散几何', '证明欧氏平面存在七色着色，使任意距离恰为 1 的两点颜色不同。', 'The Euclidean plane admits a seven-coloring in which points at unit distance have different colors.'],
  FiniteCongruenceGraph: ['A colored-graph criterion for congruence lattices', '有限同余格的彩色图判据', '泛代数与格论', '证明有限格可表示为非空有限代数的完整同余格，当且仅当它具有满足给定条件的有限非空彩色图见证。', 'A finite lattice is the full congruence lattice of a nonempty finite algebra exactly when it admits the specified finite colored-graph witness.'],
  HadamardCubeFiber: ['Hadamard cube-fiber cancellation', '六阶 Hadamard 行比值的立方纤维消去', '线性代数', '对矩阵及其逐项平方均为复 Hadamard 的六阶情形，证明题设指定立方纤维上的行比值之和为零。', 'For an order-six complex Hadamard matrix whose entrywise square is also Hadamard, proves cancellation on the cube fiber specified by the statement.'],
  SurfaceConeCandidateSupport: ['A three-dimensional complete local candidate ring', '三维完备局部候选环', '交换代数', '构造 Krull 维数为 3、剩余域为复数域的完备诺特正规局部复代数。', 'A complete Noetherian normal local complex algebra of Krull dimension three with residue field equal to the complex numbers.'],
  ThreeStateTreeClauses: ['Supercritical reconstruction for three-state tree channels', '三状态树信道的超临界重构', '概率论', '证明三状态信道与泊松分支分布的概率性质，并在 Kesten–Stigum 超临界条件下证明规则树和泊松树上的重构。', 'Proves the channel and Poisson offspring probability properties, and reconstruction on regular and Poisson trees above the Kesten–Stigum threshold.'],
  CharacterVarietiesAllSeamsSupport: ['Marked trace values across all surface seams', '曲面全部接缝上的标记迹值', '代数几何', '对题设曲面表示的全部接缝，证明产生的标记迹值满足指定的接缝等式。', 'For every seam in the stated surface presentation, proves the specified seam equations for the produced marked trace values.'],
};
const areas: Record<string, string> = { '代数几何': 'Algebraic geometry', '组合博弈': 'Combinatorial games', '数论': 'Number theory',
  '概率论': 'Probability', '概率与统计物理': 'Probability and statistical physics', '离散几何': 'Discrete geometry', '线性代数': 'Linear algebra',
  '泛代数与格论': 'Universal algebra and lattice theory', '热带优化': 'Tropical optimization', '交换代数': 'Commutative algebra', '代数几何与拓扑': 'Algebraic geometry and topology' };
const receiptIds = (verification: any): string[] => [...new Set<string>((verification?.results ?? []).flatMap((result: any) =>
  [result.receiptId, result.receipt?.id, ...(result.checks ?? []).map((check: any) => check.receiptId)].filter(Boolean)))];

function recordedLibraryUsage(state: any, usage: any): ArchiveLibraryUsage | undefined {
  if (!usage || typeof usage.checked !== 'boolean' || !Array.isArray(usage.modules)) return;
  const expected = usage.checked ? state.check?.passed === true && state.check.commit : state.cooperation?.canonicalCommit;
  if (!expected || usage.commit !== expected) return;
  const modules = usage.modules.map((module: any) => ({ name: publicText(module.name), file: publicText(module.file),
    direct: module.direct === true, mentioned: (module.mentioned ?? []).map(publicText) }));
  return { evidence: 'saved-imports-and-lexical-mentions',
    ...(Array.isArray(usage.installed) ? { installed: usage.installed.map((name: string) => ({ name: publicText(name) })) } : {}),
    ...(usage.checked ? { checked: { commit: usage.commit, checked: true, modules } }
      : { canonical: { commit: usage.commit, checked: false, modules } }) };
}

function recordedApplication(use: any, deliveryId?: string): ArchiveKnowledgeApplication {
  const check = use.application?.check;
  return { ...(deliveryId ? { deliveryId: publicText(deliveryId) } : {}), id: publicText(use.id),
    consumer: { taskId: publicText(use.consumer?.taskId), taskDigest: publicText(use.consumer?.taskDigest) },
    declaration: { name: publicText(use.declaration?.name), file: publicText(use.declaration?.file) },
    check: check ? { status: publicText(check.status), reason: check.reason === undefined ? undefined : publicText(check.reason),
      authority: check.authority, proofAcceptance: check.proofAcceptance, consumerCoverage: check.consumerCoverage,
      commit: check.commit, selectedDeclarationUsed: check.selectedDeclarationUsed } : null };
}

export function processRun(state: any, result?: any, savedLibraryUsage?: any): ArchiveProcess['runs'][number] {
  if (result?.runId !== state.runId) result = undefined;
  const cooperation = state.cooperation ?? {};
  const deliveries = cooperation.deliveries ?? [];
  const sourceUses = deliveries.some((delivery: any) => delivery.sourceUses !== undefined)
    ? deliveries.flatMap((delivery: any) => (delivery.sourceUses ?? []).map((use: any) => ({
      deliveryId: publicText(delivery.id), deliveryStatus: publicText(delivery.status), kind: publicText(use.kind),
      reference: publicText(use.reference), locator: publicText(use.locator),
      assumptions: use.assumptions.map(publicText), adaptation: publicText(use.adaptation),
      consumer: { taskId: publicText(use.consumer.taskId), taskDigest: publicText(use.consumer.taskDigest) },
      lemmaRequestIds: use.lemmaRequestIds.map(publicText), remaining: use.remaining.map(publicText),
    }))) : undefined;
  const lemmaRequests = deliveries.some((delivery: any) => delivery.lemmaRequests !== undefined)
    ? deliveries.flatMap((delivery: any) => (delivery.lemmaRequests ?? []).map((task: any) => ({
      deliveryId: publicText(delivery.id), deliveryStatus: publicText(delivery.status), id: publicText(task.id),
      objective: publicText(String(task.objective ?? '').split(/\n\s*\n/u)[0]),
      theorem: task.theoremName === undefined ? undefined : publicText(task.theoremName),
      type: task.type === undefined ? undefined : publicText(task.type),
      proofPath: task.proofPath === undefined ? undefined : publicText(task.proofPath),
      dependencies: (task.dependsOn ?? []).map(publicText),
    }))) : undefined;
  const recordedUses = deliveries.flatMap((delivery: any) => (delivery.knowledgeUses ?? [])
    .filter((use: any) => use.application).map((use: any) => recordedApplication(use, delivery.id)));
  const signature = ({ deliveryId: _deliveryId, ...use }: ArchiveKnowledgeApplication) => JSON.stringify(use);
  const known = new Set(recordedUses.map(signature));
  const independentUses = (state.knowledgeUses ?? []).filter((use: any) => use.application)
    .map((use: any) => recordedApplication(use)).filter((use: ArchiveKnowledgeApplication) => !known.has(signature(use)));
  const knowledgeApplications = state.knowledgeUses !== undefined || deliveries.some((delivery: any) => delivery.knowledgeUses !== undefined)
    ? [...recordedUses, ...independentUses] : undefined;
  const libraryUsage = recordedLibraryUsage(state, savedLibraryUsage);
  const events: ArchiveProcess['runs'][number]['events'] = [];
  for (const edit of cooperation.edits ?? []) if (edit.appliedAt || edit.receivedAt) events.push({
    at: iso(edit.appliedAt || edit.receivedAt)!, kind: 'plan-edit', status: edit.status,
    message: (edit.affectedTasks ?? []).join(', '),
  });
  for (const progress of cooperation.progressReceipts ?? []) if (progress.at) events.push({
    at: iso(progress.at)!, kind: progress.kind, status: progress.acceptance,
    message: publicText((progress.routes ?? []).map((route: any) => typeof route === 'string' ? route : route.summary ?? route.status ?? '').filter(Boolean).join('\n')),
  });
  const tasks = (cooperation.tasks ?? []).map((entry: any) => {
    const task = entry.task ?? {};
    const verification = entry.integratedCheck?.verification ?? entry.proof?.verification;
    if (verification?.checkedAt) events.push({ at: iso(verification.checkedAt)!, kind: 'lean-check', taskId: task.id, status: verification.status });
    return { id: task.id ?? 'unknown', theorem: task.theoremName,
      // Loader bodies and inline candidates remain in the private raw archive; this view shows the recorded objective.
      objective: publicText(String(task.objective ?? '').split(/\n\s*\n/u)[0]), status: entry.status ?? 'unknown',
      attempts: entry.attempts ?? 0, dependencies: task.dependsOn ?? [],
      proofCommit: entry.proof?.commit, checkStatus: verification?.status, receiptIds: receiptIds(verification) };
  });
  return { runId: state.runId, startedAt: iso(state.solveStartedAt), finishedAt: iso(state.solveFinishedAt), phase: state.phase,
    resultStatus: result?.status, reason: result?.run_outcome?.reason ? publicText(result.run_outcome.reason) : undefined,
    turns: state.turns ?? 0, workers: state.workerCount ?? 0, tasks,
    ...(sourceUses === undefined ? {} : { sourceUses }),
    ...(lemmaRequests === undefined ? {} : { lemmaRequests }),
    ...(knowledgeApplications === undefined ? {} : { knowledgeApplications }),
    ...(libraryUsage ? { libraryUsage } : {}),
    review: cooperation.review ? { status: cooperation.review.status, summary: publicText(cooperation.review.summary) } : undefined,
    events: events.sort((a, b) => a.at.localeCompare(b.at)) };
}

export function importMathCampaign(campaign: string, destination = path.join(root, 'research/openai-math')) {
  fs.mkdirSync(destination, { recursive: true });
  const state = read(path.join(campaign, 'campaign-state.json'));
  const index = read(path.join(campaign, 'trajectories/index.json'));
  const previous = fs.existsSync(path.join(destination, 'manifest.json')) ? read(path.join(destination, 'manifest.json')).records : [];
  const snapshot = (reference: { object: string; sha256: string }) => {
    const bytes = gunzipSync(fs.readFileSync(path.join(campaign, 'trajectories', reference.object)));
    if (hash(bytes) !== reference.sha256) throw new Error(`Checkpoint hash mismatch: ${reference.object}`);
    return JSON.parse(bytes.toString());
  };
  const passed = (result: any) => result.status === 'evaluated_passed' && result.evaluator?.status === 'passed'
    && result.evaluator?.result?.exitCode === 0 && /^[a-f0-9]{40}$/u.test(result.solution_commit ?? '');
  const records: any[] = [];
  for (const activeJob of state.jobs) {
    const archivedFile = path.join(campaign, 'trajectories/problems', activeJob.id, 'index.json');
    if (activeJob.status !== 'accepted' && !fs.existsSync(archivedFile)) continue;
    const archived = read(archivedFile), historical = activeJob.status !== 'accepted';
    // A later unsuccessful attempt must not erase an independently accepted, frozen original proof.
    const saved = historical ? archived.runs.flatMap((run: any) => {
      const resultPath = run.state.replace(/\.runtime\/state\.json$/u, ''), reference = index.files[resultPath]?.versions?.at(-1);
      if (!reference) return [];
      const result = snapshot(reference);
      if (result.runId !== run.runId || !passed(result)) return [];
      const native = snapshot(run.stateSnapshot);
      return [{ run, resultPath, result, native }];
    }).sort((a: any, b: any) => (b.native.solveFinishedAt ?? 0) - (a.native.solveFinishedAt ?? 0))[0] : undefined;
    if (historical && !saved) continue;
    const job = saved ? { ...activeJob, result: saved.resultPath, runId: saved.result.runId,
      solutionCommit: saved.result.solution_commit, nativeAcceptanceAudit: undefined, autoLibraryUsage: undefined,
      externalMathematicalAssistance: undefined } : activeJob;
    const result = saved?.result ?? read(job.result);
    if (!passed(result) ||
      result.solution_commit !== job.solutionCommit || result.runId !== job.runId) throw new Error(`Inconsistent accepted result: ${job.id}`);
    const current = saved?.run ?? archived.runs.find((run: any) => run.runId === job.runId && run.state === job.result + '.runtime/state.json');
    if (!current) throw new Error(`No archived native run: ${job.id}`);
    const native = saved?.native ?? read(current.state);
    if (native.runId !== job.runId || native.check?.verification?.status !== 'kernel_verified') throw new Error(`No kernel receipt: ${job.id}`);
    const repositories = Object.values(archived.repositories) as { archive: string }[];
    const repository = repositories.find(repo => {
      try { execFileSync('git', ['--git-dir=' + repo.archive, 'cat-file', '-e', job.solutionCommit + '^{commit}'], { stdio: 'pipe' }); return true; }
      catch { return false; }
    });
    if (!repository) throw new Error(`No archived proof commit: ${job.id}`);
    const git = (...args: string[]) => execFileSync('git', ['--git-dir=' + repository.archive, ...args], { maxBuffer: 32 * 1024 * 1024 });
    const project = native.problem.projectRelative;
    const proofFiles = git('ls-tree', '-r', '--name-only', job.solutionCommit, project).toString().trim().split('\n')
      .filter(file => file.endsWith('.lean'));
    const id = 'openai_' + job.id.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    const directory = path.join(destination, job.id);
    fs.mkdirSync(directory, { recursive: true });
    const files: Record<string, string> = {};
    const write = (name: string, data: Buffer | string) => {
      const target = path.join(directory, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });fs.writeFileSync(target, data);files[name] = hash(data);
    };
    for (const file of proofFiles) write(file.slice(project.length + 1), git('show', `${job.solutionCommit}:${file}`));
    if (!files['Submission.lean'] || !files['Challenge.lean']) throw new Error(`Missing proof or statement: ${job.id}`);
    if (native.check.commit !== job.solutionCommit || !native.check.verification.results?.some((receipt: any) =>
      receipt.status === 'kernel_verified' && receipt.proofHash === files['Submission.lean'])) throw new Error(`Unbound kernel source: ${job.id}`);
    const audit = job.nativeAcceptanceAudit ? read(job.nativeAcceptanceAudit) : undefined;
    if (audit?.submissionSha256 && audit.submissionSha256 !== files['Submission.lean']) throw new Error(`Receipt hash mismatch: ${job.id}`);
    const runs = new Map<string, ArchiveProcess['runs'][number]>();
    const processSources: NonNullable<ArchiveProcess['sources']> = {};
    const readSource = archivedSourceReader(archived, project);
    const recordedRun = (sourceState: any, sourceResult?: any, usage?: any) => {
      const evidence = extractProcessEvidence(sourceState, readSource);
      Object.assign(processSources, evidence.sources);
      return { ...processRun(sourceState, sourceResult, usage), checks: evidence.checks, deliveries: evidence.deliveries };
    };
    for (const run of archived.runs) {
      if (runs.has(run.runId)) continue;
      const sourceState = snapshot(run.stateSnapshot);
      const sourceResultPath = run.state.replace(/\.runtime\/state\.json$/u, '');
      const resultFile = index.files[sourceResultPath]?.versions?.at(-1);
      const sourceResult = resultFile ? snapshot(resultFile) : undefined;
      runs.set(run.runId, recordedRun(sourceState, sourceResult));
    }
    // The current accepted run may have advanced since the last incremental archive cycle.
    runs.set(job.runId, recordedRun(native, result, job.autoLibraryUsage));
    const usedSources = new Set([...runs.values()].flatMap(run => run.checks?.flatMap(check => check.sourceDigest ? [check.sourceDigest] : []) ?? []));
    const sources = Object.fromEntries(Object.entries(processSources).filter(([digest]) => usedSources.has(digest)));
    const process: ArchiveProcess = { runs: [...runs.values()].sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? '')),
      ...(Object.keys(sources).length ? { sources } : {}) };
    write('process.json', JSON.stringify(process, null, 2) + '\n');
    const assisted = job.externalMathematicalAssistance || (native.cooperation?.edits ?? []).some((edit: any) => /candidate|independent|reference/u.test(edit.id));
    const attribution = historical && (native.cooperation?.edits ?? []).length
      ? 'TheoremOS 历史原生运行；保留保存候选的接续及数学编辑记录。'
      : assisted
      ? 'TheoremOS 原生运行；记录包含外部代理提供的独立数学辅助、已保存候选的交接或续跑。'
      : 'TheoremOS 原生运行；当前接受运行未见外部数学编辑记录，保留已记录的历史续跑。';
    const evidence: ArchiveRecord['campaign'] = { target: job.id, runId: job.runId,
      targets: native.problem.targets.map((target: any) => target.theoremName),
      proofCommit: job.solutionCommit, proofSha256: files['Submission.lean'],
      kernelReceiptIds: audit?.kernelReceiptIds ?? receiptIds(native.check.verification),
      comparatorExitCode: result.evaluator.result.exitCode, reviewStatus: native.cooperation?.review?.status,
      attribution: publicText(attribution), attributionEn: historical && (native.cooperation?.edits ?? []).length
        ? 'Historical TheoremOS native run with saved-candidate continuation and recorded mathematical edits.'
        : assisted
        ? 'TheoremOS native run with recorded independent mathematical assistance from external agents, saved-candidate handoff or continuation.'
        : 'TheoremOS native run. No external mathematical edit was found in the accepted run; recorded continuation is retained.',
      evidenceUrl: `data/proofs/${id}/verification.json` };
    write('verification.json', JSON.stringify({ ...evidence, recordedAttribution: publicText(audit?.attribution ?? ''), status: result.status,
      kernelStatus: native.check.verification.status, comparatorOutput: publicText(result.evaluator.result.stdout) }, null, 2) + '\n');
    const prior = previous.find((entry: any) => entry.directory === job.id);
    const d = descriptions[job.id] ?? (prior ? [prior.title, prior.subtitle, prior.area, prior.summary, prior.en.summary]
      : [job.id, job.id, '数学', '原题的 Lean 证明与验收记录。', 'The Lean proof and recorded acceptance of the frozen statement.']);
    records.push({ id, title: d[0], subtitle: d[1], area: d[2], summary: d[3], en: { subtitle: d[0], area: areas[d[2]] ?? prior?.en.area ?? 'Mathematics', summary: d[4] },
      status: 'locally_verified', model: `TheoremOS · ${native.model}`, updatedAt: iso(native.solveFinishedAt) ?? job.finishedAt,
      directory: job.id, files, declaration: `theorem ${evidence.targets[0]?.split('.').at(-1)}`,
      campaign: evidence, processSummary: { runs: process.runs.length, tasks: process.runs.reduce((sum, run) => sum + run.tasks.length, 0) } });
  }
  fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify({ schema: 'theoremos.campaign-archive.v1',
    capturedAt: new Date().toISOString(), records }, null, 2) + '\n');
  console.log(`Exported ${records.length} independently verified results and their recorded research processes to research/openai-math`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const campaign = process.argv[2] && path.resolve(process.argv[2]);
  if (!campaign) throw new Error('Usage: bun scripts/import-math-campaign.ts <campaign directory>');
  importMathCampaign(campaign);
}
