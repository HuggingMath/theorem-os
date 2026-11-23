import type { WebInspectedTask, WebNativeTeamTask, WebTeamAdoption, WebTeamDelivery, WebTeamFinding } from '../collaboration';
import type { WebFormalization } from '../formalizationTypes';
import type { WebRun } from '../shared';
import { locale as currentLocale, t, translator } from '../i18n';
import { checkOutcome, type LiveTask, type ProcessTone, type SolveProcess } from './solveProcess';

export type ProofMapOrigin = 'checked' | 'conditional' | 'active' | 'blocked' | 'pending';
export type ProofMapNodeKind = 'research' | 'sketch' | 'lemma' | 'goal' | 'pipeline';
export type ProofMapEdgeKind = 'settled' | 'dependency' | 'conditional';

export type ProofMapGoalBridge = {
  originalLabel: string;
  originalGoal: string;
  bridgeLabel: string;
  bridgeNote?: string;
  bridgeTone: ProcessTone;
  formalLabel: string;
  formalTarget: string;
  theoremNames: string[];
};

export type ProofMapReductionStep = {
  step: string;
  title: string;
  value: string;
  detail: string;
  tone: ProcessTone;
};

export type ProofMapHandoff = {
  id: string;
  label: string;
  settled?: boolean;
};

export type ProofMapNode = {
  id: string;
  taskId?: string;
  version?: string;
  stageIndex: number;
  kind: ProofMapNodeKind;
  kindLabel: string;
  origin: ProofMapOrigin;
  tone: ProcessTone;
  statusLabel: string;
  title: string;
  codeName?: string;
  statement?: string;
  formulaOrType?: string;
  checkpointsIn: ProofMapHandoff[];
  handoffsOut: ProofMapHandoff[];
  useSummary: string;
  proveSummary: string;
  conditions: string[];
  reason?: string;
  finding?: string;
  note?: string;
  who?: string;
  attempts?: number;
  canGuide: boolean;
  native?: {
    task?: WebNativeTeamTask; delivery?: WebTeamDelivery; adoptions: WebTeamAdoption[];
    findings: WebTeamFinding[]; trials: { id: string; ref: string; consumer: string; passed: boolean }[];
  };
};

export type ProofMapStage = {
  index: number;
  number: string;
  title: string;
  subtitle?: string;
  tone: ProcessTone;
  nodeIds: string[];
};

export type ProofMapEdge = {
  id: string;
  from: string;
  to: string;
  kind: ProofMapEdgeKind;
};

export type ProofMapExternalAgent = {
  id: string;
  who?: string;
  text: string;
  code?: string;
  targetNodeId?: string;
  targetLabel?: string;
};

export type ProofMapExternalCheck = {
  id: string;
  label: string;
  outcomeText: string;
  outcomeTone: 'passed' | 'failed' | 'muted';
  at: string;
};

export type ProofMapExternalCitation = {
  id: string;
  label: string;
  detail?: string;
  targetNodeId?: string;
};

export type ProofMapModel = {
  key: string;
  mode: 'planned' | 'pipeline' | 'native';
  active: boolean;
  goalBridge?: ProofMapGoalBridge;
  reduction: ProofMapReductionStep[];
  stages: ProofMapStage[];
  nodes: ProofMapNode[];
  edges: ProofMapEdge[];
  external: {
    agents: ProofMapExternalAgent[];
    checks: ProofMapExternalCheck[];
    citations: ProofMapExternalCitation[];
  };
};

export type ProofMapBox = { x: number; y: number; width: number; height: number };
export type ProofMapChannel = { afterStage: number; y: number };
export type RoutedProofEdge = {
  id: string;
  from: string;
  to: string;
  kind: ProofMapEdgeKind;
  path: string;
};

export type BuildProofMapInput = {
  formalization?: WebFormalization;
  run?: WebRun;
  process: SolveProcess;
  locale?: 'zh' | 'en';
};

// Accept the compact proof-map records as well as the workbench's saved observation schema.
type MapTask = WebInspectedTask & {
  dependsOn?: readonly string[];
  files?: readonly string[];
  declaration?: string;
  verifiedArtifact?: unknown;
};
type MapFormalization = WebFormalization & { problem?: string; leanCode?: string; backTranslation?: string };
type MapRun = WebRun & { problem?: string; result?: WebRun['result'] & { theoremNames?: string[] } };

const unique = (values: readonly string[]) => [...new Set(values.filter(value => value.trim()))];
const short = (value: string, length = 260) => {
  const line = value.trim().replace(/\s+/gu, ' ');
  return line.length > length ? `${line.slice(0, length - 1)}…` : line;
};
const cleanLean = (source: string) => source.replace(/\/-[\s\S]*?-\//gu, '').replace(/--[^\n]*/gu, '').trim();
const declarationNames = (source: string) => unique([...cleanLean(source).matchAll(/^\s*(?:(?:private|protected|noncomputable)\s+)*(?:theorem|lemma)\s+(«[^»]+»|[\p{L}\p{N}_'.]+)/gmu)].map(match => match[1]!));

/** Keep mathematical signatures, excluding tactic bodies and surrounding imports. */
function leanTarget(source: string): string {
  const clean = cleanLean(source);
  const headers: string[] = [];
  let inHeader = false;
  for (const line of clean.split('\n')) {
    if (/^\s*(?:(?:private|protected|noncomputable)\s+)*(?:theorem|lemma)\s/u.test(line)) inHeader = true;
    if (!inHeader) continue;
    const end = /:=|\bwhere\b/u.exec(line);
    const header = (end ? line.slice(0, end.index) : line).trim();
    if (header) headers.push(header);
    if (end) inHeader = false;
  }
  return (headers.length ? headers.join('\n') : clean.split('\n').filter(line => !/^\s*import\s/u.test(line)).slice(0, 6).join('\n')).slice(0, 1_000);
}

function taskNote(liveTask: LiveTask, t: ReturnType<typeof translator>) {
  return [liveTask.who, liveTask.waits?.length ? t('等待 {0}', liveTask.waits.join(t('、'))) : '',
    liveTask.attempts ? t('已尝试 {0} 次', liveTask.attempts) : ''].filter(Boolean).join(' · ') || undefined;
}

function aggregateTone(nodes: readonly ProofMapNode[]): ProcessTone {
  if (nodes.every(node => node.tone === 'done')) return 'done';
  for (const tone of ['failed', 'active', 'pending', 'stopped', 'skipped'] as const)
    if (nodes.some(node => node.tone === tone)) return tone;
  return 'pending';
}

/** Dependency depth is independent of plan order; cyclic records retain finite, stable bands. */
function taskLayers(tasks: readonly LiveTask[], dependencies: ReadonlyMap<string, readonly string[]>) {
  const ids = new Set(tasks.map(task => task.id)), visiting = new Set<string>(), depths = new Map<string, number>();
  const depth = (id: string): number => {
    const saved = depths.get(id);
    if (saved !== undefined) return saved;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const upstream = (dependencies.get(id) ?? []).filter(dep => ids.has(dep));
    const value = upstream.length ? 1 + Math.max(...upstream.map(depth)) : 0;
    visiting.delete(id);
    depths.set(id, value);
    return value;
  };
  tasks.forEach(task => depth(task.id));
  const levels = [...new Set(depths.values())].sort((a, b) => a - b);
  const stage = (value: number) => {
    const index = levels.indexOf(value);
    if (levels.length <= 6) return index;
    // Keep roots, initial reduction, and final closure separate from merged lemma bands.
    return index < 2 ? index : index === levels.length - 1 ? 5 : 2 + Math.floor((index - 2) * 3 / (levels.length - 3));
  };
  return new Map([...depths].map(([id, value]) => [id, stage(value)]));
}

function nativeTeamMap(process: SolveProcess, theoremNames: string[], tx: (zh: string, en: string) => string) {
  const team = process.nativeTeam, nodes: ProofMapNode[] = [], stages: ProofMapStage[] = [], edges: ProofMapEdge[] = [];
  const accepted = process.state === 'accepted';
  const findings = team?.findings ?? [];
  const trials = process.checks.flatMap(check => {
    const candidate = check.lean?.candidate;
    if (!team || !candidate || candidate.solverRunId !== team.runId || !check.lean?.checkedSource || !check.workerId) return [];
    const source = findings.find(finding => finding.ref === candidate.ref);
    if (!source || source.from === check.workerId || source.to && source.to !== check.workerId ||
        source.at !== undefined && source.at > Date.parse(check.at)) return [];
    return [{ id: check.id, ref: candidate.ref, consumer: check.workerId, passed: check.state === 'passed' }];
  });
  const stage = (title: string, nodesForStage: ProofMapNode[]) => {
    if (!nodesForStage.length) return;
    const index = stages.length;
    nodesForStage.forEach(node => { node.stageIndex = index; });
    stages.push({ title, index, number: String(index + 1).padStart(2, '0'), tone: aggregateTone(nodesForStage), nodeIds: nodesForStage.map(node => node.id) });
    nodes.push(...nodesForStage);
  };
  const node = (id: string, title: string, kindLabel: string, statusLabel: string, tone: ProcessTone): ProofMapNode => ({
    id, title, stageIndex: 0, kind: 'pipeline', kindLabel, statusLabel, tone,
    origin: tone === 'failed' ? 'blocked' : tone === 'active' ? 'active' : 'pending',
    checkpointsIn: [], handoffsOut: [], useSummary: '', proveSummary: title, conditions: [], canGuide: false,
  });
  const taskTitle = tx('成员任务', 'Member assignments');
  const noTask = team?.taskCount === 0 ? tx('尚未派工', 'No assignments yet') : tx('任务记录未提供', 'Assignment evidence unavailable');
  const tasks = process.tasks.filter(task => task.native).map(live => {
    const task = live.native!;
    const item = node(task.id, live.label, tx('成员任务', 'Assignment'), live.status, live.tone);
    const related = findings.filter(entry => !entry.ref.startsWith('delivery:') &&
      (entry.taskId === task.id || entry.ref === task.reassignment?.ref));
    return { ...item, statement: live.statement, reason: live.reason, finding: live.finding, who: live.who,
      useSummary: [task.memberId, ...task.profiles].join(' · '),
      note: task.researchRef && !findings.some(entry => entry.ref === task.researchRef) ? tx('研究产物未记录', 'Research artifact unavailable') : undefined,
      native: { task, adoptions: [], findings: related, trials: trials.filter(trial =>
        related.some(entry => entry.ref === trial.ref && entry.taskId === task.id)).slice(-8) } };
  });
  stage(taskTitle, tasks.length ? tasks : [node('native-unassigned', noTask, taskTitle, tx('等待记录', 'Awaiting evidence'), 'pending')]);
  const deliveries = (team?.deliveries ?? []).map(record => {
    const delivery = accepted ? record : { ...record, references: [] };
    const adoptions = team!.adoptions.filter(adoption => adoption.deliveryId === delivery.id);
    const recordedAdoption = adoptions.some(adoption => adoption.status === 'completed' && adoption.receiptId);
    const status = recordedAdoption ? tx('已采纳', 'Adopted') : delivery.proof ? tx('交付已核验', 'Delivery checked') : tx('交付证据未记录', 'Delivery evidence unavailable');
    const names = delivery.proof?.declarations.map(item => item.name);
    const title = names?.length ? names.slice(0, 3).join(', ') : tx('成员交付', 'Member delivery');
    const item = node('delivery:' + delivery.id, title, tx('成员交付', 'Member delivery'), status, delivery.proof ? 'done' : 'pending');
    return { ...item, origin: delivery.proof ? 'checked' as const : item.origin, useSummary: delivery.memberId, proveSummary: status,
      native: { delivery, adoptions, findings: [], trials: trials.filter(trial => trial.ref === 'delivery:' + delivery.id).slice(-8) } };
  });
  stage(tx('已记录交付', 'Recorded deliveries'), deliveries);
  const finalStage = process.stages.find(item => item.id === 'verify');
  const finalTitle = tx('独立 Lean 验收', 'Independent Lean acceptance');
  const finalStatus = accepted ? tx('原题已通过验收', 'Original problem accepted') : tx('原题尚未通过验收', 'Original problem not yet accepted');
  const final = node('native-final', theoremNames.join(', ') || finalTitle, finalTitle, finalStatus,
    accepted ? 'done' : finalStage?.tone === 'done' ? 'pending' : finalStage?.tone ?? 'pending');
  final.origin = accepted ? 'checked' : final.origin;
  stage(finalTitle, [final]);
  const byId = new Map(nodes.map(node => [node.id, node]));
  const connect = (source: string, target: string, kind: ProofMapEdgeKind) => {
    const a = byId.get(source), b = byId.get(target);
    if (!a || !b || a === b) return;
    edges.push({ id: source + '->' + target, from: source, to: target, kind });
    a.handoffsOut.push({ id: target, label: b.title, settled: kind === 'settled' });
    b.checkpointsIn.push({ id: source, label: a.title, settled: kind === 'settled' });
  };
  for (const item of deliveries) {
    const delivery = item.native.delivery;
    if (delivery.proof) connect(delivery.taskId, item.id, 'settled');
    if (accepted && delivery.proof && delivery.references.length) connect(item.id, final.id, 'settled');
  }
  for (const item of tasks) {
    const basis = item.native.task.reassignment;
    const source = basis && findings.find(entry => entry.ref === basis.ref);
    if (source?.taskId) connect(source.taskId, item.id, 'dependency');
  }
  const reduction: ProofMapReductionStep[] = [
    { step: '01', title: taskTitle, value: team ? `${team.memberCount} / ${Math.max(0, team.maxAgents - 1)} · ${team.taskCount} ${tx('项任务', 'assignments')}` : noTask,
      detail: team?.taskOmissions ? tx(`另有 ${team.taskOmissions} 项历史任务`, `${team.taskOmissions} earlier assignments`) :
        tx('成员由 Lead 按缺口派工。', 'Lead assigns members to proof gaps.'), tone: stages[0]!.tone },
    { step: '02', title: tx('成员交付与采纳', 'Deliveries and adoptions'),
      value: `${deliveries.filter(item => item.native.delivery.proof).length} ${tx('项交付已核验', 'deliveries checked')} · ${team?.adoptions.filter(item => item.receiptId).length ?? 0} ${tx('项已采纳', 'adoptions')}`,
      detail: tx('采纳以宿主保存的整合回执为准。', 'Adoption is shown when its integration receipt is recorded.'), tone: deliveries.some(item => item.tone === 'done') ? 'done' : 'pending' },
    { step: '03', title: finalTitle, value: finalStatus, detail: theoremNames.join(', '), tone: final.tone },
  ];
  return { nodes, stages, edges, reduction };
}

export function buildProofMap(input: BuildProofMapInput): ProofMapModel {
  const activeLocale = input.locale ?? currentLocale;
  const tx = (zh: string, en: string) => (activeLocale === 'en' ? en : zh);
  const { process } = input, run = input.run as MapRun | undefined, formalization = input.formalization as MapFormalization | undefined;
  const inspected = (run?.observation?.inspection.tasks ?? []) as MapTask[];
  const agents = new Map(inspected.filter(task => task.control === 'active').map(task => [task.id, task]));
  const planned = new Map((run?.observation?.plan?.tasks ?? []).map(task => [task.id, task]));
  const liveById = new Map(process.tasks.map(task => [task.id, task]));
  const noteTranslator = activeLocale === currentLocale ? t : translator(activeLocale);
  const originalGoal = (formalization?.problem ?? run?.problem ?? formalization?.backTranslation
    ?? formalization?.original ?? run?.formalization?.original ?? run?.observation?.inspection.problem?.statement
    ?? formalization?.report?.backtranslation?.mathematics ?? run?.task ?? '').trim();
  const recordedNames = unique(run?.result?.theoremNames ?? []);
  const leanCode = formalization?.leanCode ?? (process.current?.kind === 'statement' ? process.current.source : undefined)
    ?? (recordedNames.length ? recordedNames.join(', ') : undefined)
    ?? formalization?.report?.statement ?? formalization?.compiled?.source ?? run?.source ?? '';
  const theoremNames = recordedNames.length ? recordedNames : declarationNames(leanCode);
  const formalTarget = leanTarget(leanCode) || theoremNames.join(', ');
  let goalBridge: ProofMapGoalBridge | undefined;
  if (originalGoal || formalTarget) {
    const status: string = formalization?.status ?? '';
    const reviews = run?.observation?.inspection.statementReviews ?? [];
    const review = [...reviews].reverse().find(item => !agents.size || agents.get(item.taskId)?.kind === 'goal');
    const failed = ['failed', 'error', 'exhausted'].includes(status) || ['failed', 'rejected', 'changes_requested', 'mismatch'].includes(review?.status ?? '')
      || formalization?.backgroundReview?.status === 'changes_requested';
    const checked = ['reviewed', 'accepted'].includes(status) || ['reviewed', 'accepted', 'approved'].includes(review?.status ?? '')
      || formalization?.backgroundReview?.status === 'approved'
      || ['review', 'confirmed'].includes(status) && formalization?.reviewMode !== 'direct' && formalization?.report?.semanticReview !== 'not-performed';
    const aligning = ['queued', 'running', 'formalizing'].includes(status) || process.state === 'formalizing';
    goalBridge = {
      originalLabel: tx('原始数学问题', 'Original mathematical problem'), originalGoal,
      formalLabel: tx('Lean 形式化目标', 'Formal Lean target'), formalTarget, theoremNames,
      bridgeLabel: failed ? tx('形式化陈述需修正', 'Formal statement needs revision')
        : checked ? tx('原题 ⇔ Lean 陈述已核对', 'Problem ⇔ Lean statement checked')
          : aligning ? tx('正在对齐形式化陈述', 'Aligning formal statement')
            : formalTarget ? tx('Lean 陈述已记录', 'Lean statement recorded') : tx('等待 Lean 陈述', 'Waiting for a Lean statement'),
      bridgeTone: failed ? 'failed' : checked ? 'done' : aligning ? 'active' : formalTarget ? 'done' : 'pending',
      bridgeNote: failed ? formalization?.reason ?? tx('核对假设、量词与结论后修正陈述。', 'Revise the statement after checking its hypotheses, quantifiers, and conclusion.')
        : checked ? tx('对照原题假设与结论。', 'Checked against the problem hypotheses and conclusion.')
          : aligning ? tx('对照原题，整理 Lean 假设与目标。', 'Aligning the problem with Lean hypotheses and targets.')
            : tx('完整证明以独立 Lean 验收为准。', 'The complete proof requires independent Lean acceptance.'),
    };
  }

  let nodes: ProofMapNode[], stages: ProofMapStage[], edges: ProofMapEdge[];
  const mode = process.nativeTeam || run?.nativeTeamCapacity ? 'native' : process.tasks.length ? 'planned' : 'pipeline';
  const native = mode === 'native' ? nativeTeamMap(process, theoremNames, tx) : undefined;
  const baseContext = tx('原始命题假设与基础 Mathlib 环境', 'Problem hypotheses and base Mathlib context');
  if (native) ({ nodes, stages, edges } = native);
  else if (mode === 'planned') {
    const dependencies = new Map(process.tasks.map(live => {
      const agent = agents.get(live.id);
      const upstream = agent?.dependsOn ?? agent?.plannedDependencies ?? planned.get(live.id)?.dependsOn
        ?? (live.waits ?? []).map(wait => liveById.has(wait) ? wait : process.tasks.find(task => task.label === wait)?.id ?? wait);
      return [live.id, unique(upstream)] as const;
    }));
    const layers = taskLayers(process.tasks, dependencies);
    const dependents = new Map<string, string[]>();
    for (const [id, upstream] of dependencies) for (const dep of upstream) {
      const downstream = dependents.get(dep) ?? [];
      downstream.push(id); dependents.set(dep, downstream);
    }
    const obligations = {
      research: tx('给出可用于证明的调研结论与依据', 'Supply research findings and supporting references'),
      sketch: tx('将目标归约为明确的引理与待证前提', 'Reduce the target to explicit lemmas and open premises'),
      lemma: tx('证明该引理并通过 Lean 核验', 'Prove this lemma and pass Lean verification'),
      goal: tx('完成目标定理并交付完整证明', 'Close the target theorem and deliver its complete proof'),
    };
    nodes = process.tasks.map((liveTask): ProofMapNode => {
      const agentTask = agents.get(liveTask.id), planTask = planned.get(liveTask.id);
      const kind = agentTask?.kind ?? planTask?.kind ?? (Object.keys(obligations) as (keyof typeof obligations)[])
        .find(key => liveTask.kind.toLowerCase().includes(key) || liveTask.kind === ({
          research: tx('研究', 'Research'), sketch: tx('草图', 'Sketch'), lemma: tx('引理', 'Lemma'), goal: tx('原始目标', 'Original goal'),
        })[key]) ?? 'lemma';
      const recordedProof = agentTask?.proof;
      const conditionalCheck = recordedProof?.status === 'conditional';
      const verified = agentTask?.verifiedArtifact !== undefined ? Boolean(agentTask.verifiedArtifact)
        : Boolean(recordedProof && ['checked', 'verified', 'integrated'].includes(recordedProof.status) && !recordedProof.conditions?.length);
      const origin: ProofMapOrigin = liveTask.tone === 'failed' || agentTask?.status === 'blocked' ? 'blocked'
        : conditionalCheck ? 'conditional'
          : liveTask.tone === 'done' ? !agentTask || agentTask.kind === 'research' || verified ? 'checked' : 'conditional'
            : liveTask.tone === 'active' ? 'active' : 'pending';
      const checkpointsIn = (dependencies.get(liveTask.id) ?? []).map(id => ({ id, label: liveById.get(id)?.label ?? id,
        settled: liveById.get(id)?.tone === 'done' && agents.get(id)?.proof?.status !== 'conditional' }));
      const settled = liveTask.tone === 'done' && !conditionalCheck;
      const handoffsOut: ProofMapHandoff[] = (dependents.get(liveTask.id) ?? []).map(id => ({ id, label: liveById.get(id)!.label, settled }));
      if (!handoffsOut.length && kind === 'goal') handoffsOut.push({ id: '__closure__', label: tx('目标定理闭合', 'Target theorem closure'), settled });
      const files = agentTask?.files ?? recordedProof?.actualReferences?.inputs.map(item => item.file) ?? (planTask?.proofPath ? [planTask.proofPath] : []);
      const declaration = agentTask?.declaration ?? agentTask?.type ?? planTask?.type;
      const conditions = unique([...(liveTask.waits ?? []), ...(recordedProof?.conditions ?? []).map(item => liveById.get(item.taskId)?.label ?? item.taskId),
        ...(kind === 'sketch' && origin !== 'checked' ? [tx('路线草稿仍需下游引理验证', 'Proof sketch still needs downstream lemma verification')] : []),
        ...(origin === 'conditional' && !conditionalCheck && kind !== 'sketch' ? [tx('尚未记录该任务的 Lean 核验', 'No Lean verification is recorded for this task')] : []),
        ...(liveTask.reason ? [liveTask.reason] : [])]);
      return {
        id: liveTask.id, taskId: liveTask.id, version: agentTask?.version, stageIndex: layers.get(liveTask.id)!, kind,
        kindLabel: liveTask.kind, origin, tone: liveTask.tone,
        statusLabel: origin === 'conditional' && conditionalCheck ? tx('条件核验通过', 'Checked with open premises') : liveTask.status,
        title: liveTask.label,
        codeName: agentTask?.theorem ?? planTask?.theoremName ?? (declaration ? declarationNames(declaration)[0] : undefined),
        statement: liveTask.statement, formulaOrType: declaration ?? liveTask.statement, checkpointsIn, handoffsOut,
        useSummary: checkpointsIn.length ? checkpointsIn.map(item => item.label).join(', ') : files.length ? files.join(', ') : baseContext,
        proveSummary: short(liveTask.statement?.trim() || declaration?.trim() || liveTask.finding?.trim() || obligations[kind]),
        conditions, reason: liveTask.reason, finding: liveTask.finding, note: taskNote(liveTask, noteTranslator),
        who: liveTask.who, attempts: liveTask.attempts, canGuide: liveTask.tone !== 'done' && liveTask.tone !== 'skipped',
      };
    });
    const byId = new Map(nodes.map(node => [node.id, node]));
    edges = nodes.flatMap(node => node.checkpointsIn.filter(dep => byId.has(dep.id)).map(dep => {
      const upstream = byId.get(dep.id)!;
      return { id: `${dep.id}->${node.id}`, from: dep.id, to: node.id,
        kind: upstream.origin === 'conditional' ? 'conditional' as const : upstream.origin === 'checked' || upstream.tone === 'done' ? 'settled' as const : 'dependency' as const };
    }));
    const titles = {
      research: tx('调研与背景分解', 'Research & decomposition'), sketch: tx('路线草稿与归约', 'Proof sketch & reduction'),
      lemma: tx('关键引理攻关', 'Key lemma verification'), goal: tx('主定理闭合与验收', 'Target theorem closure'),
    };
    stages = [...new Set(nodes.map(node => node.stageIndex))].sort((a, b) => a - b).map(index => {
      const members = nodes.filter(node => node.stageIndex === index);
      const kinds = ['goal', 'lemma', 'sketch', 'research'] as const;
      const dominant = [...kinds].sort((a, b) => members.filter(node => node.kind === b).length - members.filter(node => node.kind === a).length)[0]!;
      return { index, number: String(index + 1).padStart(2, '0'), title: titles[dominant],
        subtitle: `${members.length} ${members.length === 1 ? tx('项证明任务', 'proof task') : tx('项证明任务', 'proof tasks')}`, tone: aggregateTone(members), nodeIds: members.map(node => node.id) };
    });
  } else {
    const ids = ['formalize', 'prove', 'verify'] as const;
    const titles = [tx('形式化与原题对照', 'Formalization & problem alignment'), tx('证明构造与策略', 'Proof construction & tactics'), tx('独立 Lean 内核验收', 'Independent Lean kernel acceptance')];
    const uses = [originalGoal || baseContext, formalTarget || tx('固定 Lean 陈述与命题假设', 'Fixed Lean statement and problem hypotheses'), tx('完整候选证明与固定目标', 'Complete candidate proof and fixed targets')];
    const proves = [tx('固定与原题对照的 Lean 陈述', 'Fix the Lean statement aligned with the problem'), tx('构造目标定理的完整证明', 'Construct a complete proof of the target theorem'), tx('在独立环境中通过完整 Lean 验收', 'Pass complete Lean acceptance in an independent environment')];
    const currentStage = process.state === 'verifying' || process.state === 'accepted' ? 2 : process.state === 'proving' ? 1
      : ids.indexOf(process.checks.at(-1)?.stage ?? 'formalize');
    nodes = ids.map((id, index): ProofMapNode => {
      const saved = process.stages.find(stage => stage.id === id);
      const ended = ['failed', 'stopped', 'cancelled'].includes(process.state);
      const tone: ProcessTone = saved?.tone ?? (process.state === 'accepted' || index < currentStage || index === 0 && process.state === 'review' ? 'done'
        : index > currentStage ? ended ? 'skipped' : 'pending' : process.state === 'failed' ? 'failed'
          : ended ? 'stopped' : process.state === 'queued' ? 'pending' : 'active');
      const reason = tone === 'failed' ? [...process.checks].reverse().find(check => check.stage === id && check.state === 'failed')?.text : undefined;
      return { id: `stage-${index}`, stageIndex: index, kind: 'pipeline', kindLabel: tx('证明阶段', 'Proof stage'),
        origin: tone === 'done' ? 'checked' : tone === 'failed' ? 'blocked' : tone === 'active' ? 'active' : 'pending', tone,
        statusLabel: tone === 'done' ? tx('已完成', 'Done') : tone === 'active' ? tx('进行中', 'Active') : tone === 'failed' ? tx('未通过', 'Failed')
          : tone === 'stopped' ? tx('已停止', 'Stopped') : tone === 'skipped' ? tx('未执行', 'Skipped') : tx('待推进', 'Pending'),
        title: titles[index]!, checkpointsIn: [], handoffsOut: [], useSummary: uses[index]!, proveSummary: proves[index]!,
        conditions: reason ? [reason] : [], reason, note: saved?.summary || (index === currentStage ? process.now.map(item => item.text).filter(Boolean).join(' · ') || undefined : undefined), canGuide: false };
    });
    for (const [index, node] of nodes.entries()) {
      const before = nodes[index - 1], after = nodes[index + 1];
      if (before) node.checkpointsIn.push({ id: before.id, label: before.title, settled: before.tone === 'done' });
      node.handoffsOut.push({ id: after?.id ?? '__closure__', label: after?.title ?? tx('目标定理闭合', 'Target theorem closure'), settled: node.tone === 'done' });
    }
    stages = nodes.map(node => ({ index: node.stageIndex, number: String(node.stageIndex + 1).padStart(2, '0'), title: node.title, tone: node.tone, nodeIds: [node.id] }));
    edges = nodes.slice(1).map((node, index) => ({ id: `stage-${index}->${node.id}`, from: `stage-${index}`, to: node.id, kind: nodes[index]!.tone === 'done' ? 'settled' : 'dependency' }));
  }

  const done = nodes.filter(node => node.tone === 'done').length, checked = nodes.filter(node => node.origin === 'checked').length;
  const passed = process.checks.filter(check => check.state === 'passed').length, active = nodes.filter(node => node.tone === 'active').length;
  const conditional = nodes.filter(node => node.origin === 'conditional').length;
  const waiting = nodes.filter(node => node.tone === 'pending' || node.origin === 'conditional' || liveById.get(node.id)?.waits?.length).length;
  const closed = process.state === 'accepted' || done === nodes.length;
  const deepest = [...nodes].sort((a, b) => b.stageIndex - a.stageIndex);
  const bottleneck = deepest.find(node => node.origin === 'blocked')
    ?? deepest.find(node => node.tone === 'active' && node.kind === 'lemma') ?? deepest.find(node => node.tone === 'active')
    ?? deepest.find(node => node.origin === 'conditional') ?? deepest.find(node => node.tone !== 'done');
  const reduction: ProofMapReductionStep[] = native?.reduction ?? [
    { step: '01', title: tx('全局证明义务', 'Planned obligations'), value: `${nodes.length} ${mode === 'planned' ? (nodes.length === 1 ? tx('项任务', 'task') : tx('项任务', 'tasks')) : (nodes.length === 1 ? tx('个证明阶段', 'proof stage') : tx('个证明阶段', 'proof stages'))} · ${edges.length} ${edges.length === 1 ? tx('条依赖', 'dependency') : tx('条依赖', 'dependencies')}`,
      detail: tx('按依赖组织输入、引理与目标定理。', 'Inputs, lemmas, and the target theorem organized by dependency.'), tone: closed ? 'done' : 'pending' },
    { step: '02', title: tx('已核验供给', 'Verified supply'), value: `${checked} ${tx('项已核验', 'verified')} · ${passed} ${passed === 1 ? tx('次 Lean 检查通过', 'passed Lean check') : tx('次 Lean 检查通过', 'passed Lean checks')}`,
      detail: `${done} ${tx('项已完成；条件结果仍保留其待证前提。', 'done; conditional results retain their open premises.')}`, tone: checked || passed ? 'done' : 'pending' },
    { step: '03', title: tx('推进与条件层', 'Active & conditional'), value: `${active} ${tx('项推进中', 'active')} · ${waiting} ${tx('项等待', 'waiting')} · ${conditional} ${tx('项有条件', 'conditional')}`,
      detail: tx('前沿只反映当前任务和依赖记录。', 'The frontier reflects the recorded tasks and dependencies.'), tone: closed ? 'done' : active ? 'active' : 'pending' },
    { step: '04', title: closed ? tx('主定理已闭合', 'Target theorem closed') : tx('当前核心瓶颈', 'Current bottleneck'),
      value: closed ? theoremNames.join(', ') || nodes.find(node => node.kind === 'goal')?.title || tx('完整目标证明', 'Complete target proof')
        : bottleneck?.title ?? tx('等待独立 Lean 验收', 'Waiting for independent Lean acceptance'),
      detail: closed ? process.state === 'accepted' ? tx('完整目标已通过独立 Lean 验收。', 'The complete target passed independent Lean acceptance.')
        : tx('计划任务均已完成；完整证明仍需独立 Lean 验收。', 'All planned tasks are done; the complete proof still requires independent Lean acceptance.')
        : short(bottleneck?.reason || bottleneck?.conditions.join(' · ') || bottleneck?.proveSummary || tx('核对完整目标与依赖供给。', 'Check the complete target and its dependency supply.')),
      tone: closed ? 'done' : bottleneck?.tone ?? 'pending' },
  ];

  const citations: ProofMapExternalCitation[] = [], cited = new Set<string>();
  const cite = (label: string, detail: string, targetNodeId?: string) => {
    label = label.trim();
    if (!label || cited.has(label) || citations.length >= 6) return;
    cited.add(label); citations.push({ id: `citation-${citations.length}`, label, detail, ...(targetNodeId ? { targetNodeId } : {}) });
  };
  for (const task of inspected) {
    const target = liveById.has(task.id) ? task.id : undefined, refs = task.proof?.actualReferences;
    for (const file of task.files ?? []) cite(file, tx('引用文件', 'Referenced file'), target);
    for (const name of task.citations ?? []) cite(name, tx('引用声明', 'Referenced declaration'), target);
    for (const item of [...(refs?.inputs ?? []), ...(refs?.statement ?? []), ...(refs?.proof ?? [])]) {
      cite(item.name || item.file, tx('引用依据', 'Referenced input'), target);
    }
    if (task.theorem) cite(task.theorem, tx('任务声明', 'Task declaration'), target);
  }
  for (const name of run?.result?.theoremNames ?? theoremNames) cite(name, tx('目标声明', 'Target declaration'));
  const checks = [...process.checks].reverse().slice(0, 5).map((check): ProofMapExternalCheck => {
    const outcome = checkOutcome(check), line = check.lean?.messages.find(message => message.severity === 'error')?.line;
    const outcomeText = activeLocale === currentLocale ? outcome.text : check.state === 'running' ? tx('检查中…', 'Checking…')
      : check.state === 'passed' ? tx('通过', 'Passed') : check.lean?.timedOut ? tx('超时', 'Timed out')
        : line !== undefined ? tx('第 {0} 行出错', 'Error on line {0}').replace('{0}', String(line)) : tx('未通过', 'Failed');
    return { id: check.id, label: check.label, outcomeText, outcomeTone: outcome.tone, at: check.at };
  });
  return { key: process.key, mode, active: process.active, ...(goalBridge ? { goalBridge } : {}), reduction, stages, nodes, edges,
    external: { agents: process.now.map(item => ({ id: item.id, who: item.who, text: item.text, code: item.code,
      targetNodeId: item.task?.id, targetLabel: item.task?.label })), checks, citations } };
}

type Point = readonly [number, number];
const coordinate = (value: number) => String(Number(value.toFixed(3)));
const pointText = ([x, y]: Point) => `${coordinate(x)} ${coordinate(y)}`;
const visibleBox = (box: ProofMapBox | undefined): box is ProofMapBox => Boolean(box && box.width > 0 && box.height > 0
  && [box.x, box.y, box.width, box.height].every(Number.isFinite));

function roundedPath(points: readonly Point[]): string {
  const compact: Point[] = [];
  for (const point of points) {
    const last = compact.at(-1), before = compact.at(-2);
    if (last && last[0] === point[0] && last[1] === point[1]) continue;
    if (before && last && (before[0] === last[0] && last[0] === point[0] || before[1] === last[1] && last[1] === point[1])) compact.pop();
    compact.push(point);
  }
  let path = `M ${pointText(compact[0]!)}`;
  for (let index = 1; index < compact.length - 1; index++) {
    const a = compact[index - 1]!, b = compact[index]!, c = compact[index + 1]!;
    const ab = Math.hypot(b[0] - a[0], b[1] - a[1]), bc = Math.hypot(c[0] - b[0], c[1] - b[1]);
    const radius = Math.min(8, ab / 2, bc / 2);
    const entry: Point = [b[0] - (b[0] - a[0]) * radius / ab, b[1] - (b[1] - a[1]) * radius / ab];
    const exit: Point = [b[0] + (c[0] - b[0]) * radius / bc, b[1] + (c[1] - b[1]) * radius / bc];
    path += ` L ${pointText(entry)} Q ${pointText(b)} ${pointText(exit)}`;
  }
  return `${path} L ${pointText(compact.at(-1)!)}`;
}

export function routeProofMapEdges(
  boxes: Readonly<Record<string, ProofMapBox>>,
  stageByNode: Readonly<Record<string, number>>,
  channels: readonly ProofMapChannel[],
  edges: readonly ProofMapEdge[],
): RoutedProofEdge[] {
  const routes = edges.filter(edge => visibleBox(boxes[edge.from]) && visibleBox(boxes[edge.to]));
  const right = Math.max(0, ...Object.values(boxes).filter(visibleBox).map(box => box.x + box.width));
  return routes.map(edge => {
    const src = boxes[edge.from]!, dst = boxes[edge.to]!, fromStage = stageByNode[edge.from] ?? 0, toStage = stageByNode[edge.to] ?? fromStage + 1;
    const x1 = src.x + src.width / 2, y1 = src.y + src.height, x2 = dst.x + dst.width / 2, y2 = dst.y;
    const channel = channels.find(item => item.afterStage === fromStage)?.y ?? (y1 + y2) / 2;
    const sourcePeers = routes.filter(item => item.from === edge.from), targetPeers = routes.filter(item => item.to === edge.to);
    const channelPeers = routes.filter(item => (stageByNode[item.from] ?? 0) === fromStage);
    const peers = sourcePeers.length > 1 ? sourcePeers : targetPeers.length > 1 ? targetPeers : channelPeers;
    const index = peers.indexOf(edge), offset = (index - (peers.length - 1) / 2) * 6;
    const start: Point = [x1, y1], end: Point = [x2, y2];
    let path: string;
    if (toStage - fromStage > 1 || y2 <= y1) {
      // Long dependencies pass outside intermediate cards, including expanded details.
      const lane = right + 16 + (peers.length - 1) * 3 + offset;
      const entryY = y2 - 12;
      path = roundedPath([start, [x1, channel + offset], [lane, channel + offset], [lane, entryY], [x2, entryY], end]);
    } else if (Math.abs(x2 - x1) <= 2 && offset === 0) {
      path = x1 === x2 ? `M ${pointText(start)} L ${pointText(end)}`
        : `M ${pointText(start)} C ${coordinate(x1)} ${coordinate(channel)} ${coordinate(x2)} ${coordinate(channel)} ${pointText(end)}`;
    } else {
      const laneY = Math.max(y1 + (y2 - y1) / 4, Math.min(y2 - (y2 - y1) / 4, channel + offset));
      const exitY = y1 + Math.min(12, (laneY - y1) / 2), entryY = y2 - Math.min(12, (y2 - laneY) / 2);
      path = roundedPath([start, [x1, exitY], [x1 + offset, exitY], [x1 + offset, laneY],
        [x2 + offset, laneY], [x2 + offset, entryY], [x2, entryY], end]);
    }
    return { ...edge, path };
  });
}
