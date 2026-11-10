import type { WebFormalization, WebFormalizationActivity, WebFormalizationRole, WebFormalizationRoleSummary } from '../formalizationTypes';
import type { WebAgentAction, WebAgentLeanCheck, WebEvent, WebRun } from '../shared';
import { acceptedTitle, checkReason, isAcceptedRun, isFaultedRun, isRejectedRun, planGated, queueDescription, readableDuration, runProgress, runStages, runTokens, stoppedLabel } from '../presentation';
import { summarizeReport } from '../report';
import { localizeText, t } from '../i18n';
import { checkLeanFile, routeStepLabel, taskNames, type AgentRoute, type RouteItem } from './agentRoute';
import { workerNames } from './collaborationUi';
import { formalizationReasonText } from './formalizationReasons';
import { buildThinkingEntries, type ThinkingEntry } from './thinkingProcess';

/**
 * The solving process as one checklist: formalizing the problem, proving it, the independent acceptance. Built from the
 * formalization's activity (formalizationActivity.ts) and the run's events and Agent actions; nothing here is a verdict
 * of its own, every row says what a record says.
 */
export type ProcessTone = 'done' | 'active' | 'pending' | 'failed' | 'stopped' | 'skipped';
export type ProcessOutcome = { text: string; tone: 'passed' | 'failed' | 'muted' };
export type ProcessDetail =
  | { kind: 'note'; text: string; code?: string }
  | { kind: 'summary'; summary: WebFormalizationRoleSummary }
  | { kind: 'feedback'; text: string; clipped?: boolean }
  | { kind: 'lean'; lean: WebAgentLeanCheck }
  | { kind: 'source'; source: string; clipped?: boolean }
  | { kind: 'items'; items: RouteItem[] };
export type ProcessRow = {
  id: string; label: string; tone: ProcessTone; at?: string; outcome?: ProcessOutcome;
  /** A file or target name, shown as code; `meta` is what the row is on now, in muted text. */ code?: string; meta?: string;
  details: ProcessDetail[]; rows?: ProcessRow[];
  /** The Lean check this row opens in the live panel. */ check?: string;
  /** Open unless the reader closed it: the latest round, a live Agent. */ open?: boolean;
};
export type ProcessStageId = 'formalize' | 'prove' | 'verify';
export type ProcessStage = { id: ProcessStageId; label: string; tone: ProcessTone; rows: ProcessRow[]; summary?: string };
/** One Lean check as the live panel shows it: what was checked, what Lean said, and the file when it is known. */
export type LiveCheck = {
  id: string; stage: ProcessStageId; label: string; who?: string; at: string; state: 'running' | 'passed' | 'failed';
  lean?: WebAgentLeanCheck; text?: string; file?: string; source?: string; sourceClipped?: boolean;
  /** `changed`: the file shown was saved after this check, so its lines may have moved. */ sourceNote?: 'changed';
};
export type SolveState = 'queued' | 'formalizing' | 'review' | 'proving' | 'verifying' | 'accepted' | 'failed' | 'stopped' | 'cancelled';
export type SolveProcess = {
  key: string; state: SolveState; label: string; active: boolean; startedAt?: string; endedAt?: string; tokens?: number;
  stages: ProcessStage[]; checks: LiveCheck[]; counts: { checks: number; attempts: number; agents: number };
  /** The Lean file the task is on now: the statement being formalized, the latest candidate, or the accepted proof. */
  current?: { kind: 'statement' | 'candidate' | 'proof'; file: string; source: string; at?: string; who?: string; clipped?: boolean };
  /** Records past the stored limit, which no row shows. */ dropped: number;
  /** Public summary/commentary and actual operations, deduplicated across streaming snapshots. */
  thinking?: ThinkingEntry[];
};
export type SolveProcessInput = {
  formalization?: WebFormalization; activity?: readonly WebFormalizationActivity[]; activityDropped?: number;
  run?: WebRun; events?: readonly WebEvent[]; routes?: readonly AgentRoute[]; actionsDropped?: number;
};

const base = (file: string) => file.split('/').filter(Boolean).at(-1) ?? file;
const firstError = (lean?: WebAgentLeanCheck) => lean?.messages.find(message => message.severity === 'error');
/** How a failed Lean check reads in a row: where Lean stopped, if it said. */
function leanOutcome(lean: WebAgentLeanCheck | undefined, passed: boolean): ProcessOutcome {
  if (passed) return { text: t('通过'), tone: 'passed' };
  if (lean?.timedOut) return { text: t('超时'), tone: 'failed' };
  const line = firstError(lean)?.line;
  return { text: line !== undefined ? t('第 {0} 行出错', line) : t('未通过'), tone: 'failed' };
}
/** A check's result as one short phrase, as its row in the live panel's list reads. */
export const checkOutcome = (check: LiveCheck): ProcessOutcome => check.state === 'running' ? { text: t('检查中…'), tone: 'muted' }
  : leanOutcome(check.lean, check.state === 'passed');
const roleLabel = (role: WebFormalizationRole, slot: string) => {
  const attempt = Number(/^plan-(\d+)$/u.exec(slot)?.[1] ?? 1);
  const reviewer = /(\d+)$/u.exec(slot)?.[1];
  switch (role) {
    case 'plan': return attempt > 1 ? t('重新理解题目') : t('理解题目');
    case 'generate': return t('写 Lean 陈述');
    case 'backtranslate': return t('独立回译');
    case 'compare': return reviewer ? t('审核 {0}', reviewer) : t('审核');
    case 'refute': return t('查找反例');
  }
};
const verdicts: Record<NonNullable<WebFormalizationRoleSummary['verdict']>, ProcessOutcome> = {
  approved: { text: t('一致'), tone: 'passed' }, changes_requested: { text: t('需要修改'), tone: 'failed' }, unknown: { text: t('无法判定'), tone: 'muted' } };

/**
 * A formalization round by round: each role's session (its actions and what it handed in), each Lean compilation, the
 * host's feedback between rounds. `live` is whether it still runs, so an unfinished row reads as stopped once it ended.
 */
function formalizationRows(activity: readonly WebFormalizationActivity[], live: boolean, checks: LiveCheck[], direct: boolean) {
  type Round = { round: number; rows: ProcessRow[]; result?: 'approved' | 'revision' };
  const rounds = new Map<number, Round>(), lanes = new Map<string, { row: ProcessRow; items: RouteItem[]; starts: number }>();
  const roundOf = (round: number) => { let value = rounds.get(round); if (!value) rounds.set(round, value = { round, rows: [] }); return value; };
  const actions = new Map<string, WebAgentAction>();
  let compile: { row: ProcessRow; check: LiveCheck } | undefined, stopped: ProcessRow | undefined;
  for (const entry of activity) {
    if (entry.type === 'action') {
      const lane = lanes.get(entry.action.workerId);
      if (!lane) continue;
      // A completed report replaces its started one where that one stood, as in a run's route map.
      const key = `${entry.action.workerId}\u0000${entry.action.itemId}`, first = actions.get(key);
      const action: WebAgentAction = { ...entry.action, sequence: first?.sequence ?? entry.sequence, at: first?.at ?? entry.at };
      actions.set(key, action);
      const index = first ? lane.items.findIndex(item => item.type === 'action' && item.action.itemId === action.itemId) : -1;
      if (index >= 0) lane.items[index] = { type: 'action', action }; else lane.items.push({ type: 'action', action });
      continue;
    }
    const step = entry.step;
    switch (step.step) {
      case 'role': {
        let lane = lanes.get(step.workerId);
        if (step.state === 'started') {
          if (!lane) {
            const items: RouteItem[] = [];
            lane = { row: { id: `f:${step.workerId}`, label: roleLabel(step.role, step.slot), tone: 'active', at: entry.at, details: [{ kind: 'items', items }] }, items, starts: 0 };
            lanes.set(step.workerId, lane); roundOf(step.round).rows.push(lane.row);
          }
          lane.starts++;
          if (lane.starts > 1) { lane.row.details.push({ kind: 'note', text: t('第 {0} 次尝试', lane.starts) }); lane.row.outcome = undefined; }
          lane.row.tone = 'active';
        } else if (lane && step.state === 'finished') {
          lane.row.tone = 'done';
          // What the role handed in reads before what it did on the way.
          if (step.summary) lane.row.details.unshift({ kind: 'summary', summary: step.summary });
          lane.row.outcome = step.summary?.verdict ? verdicts[step.summary.verdict] : undefined;
        } else if (lane) {
          lane.row.tone = 'failed'; lane.row.outcome = { text: t('没有交回结果'), tone: 'failed' };
          lane.row.details.push({ kind: 'note', text: step.reason === 'formalization_role_interrupted' ? t('这一步被中断。') : t('这一步没有交回有效结果。'), ...(step.reason ? { code: step.reason } : {}) });
        }
        break;
      }
      case 'compile': {
        if (step.state === 'started') {
          const row: ProcessRow = { id: `f:compile:${entry.sequence}`, label: t('编译检查'), tone: 'active', at: entry.at, details: [], code: 'Formalization.lean' };
          const check: LiveCheck = { id: `f:${entry.sequence}`, stage: 'formalize', label: t('编译 Lean 陈述 · 第 {0} 轮', step.round), at: entry.at,
            state: 'running', file: 'Formalization.lean', ...(step.source !== undefined ? { source: step.source } : {}), ...(step.sourceClipped ? { sourceClipped: true } : {}) };
          row.check = check.id; roundOf(step.round).rows.push(row); checks.push(check); compile = { row, check };
        } else if (compile) {
          const passed = step.state === 'passed';
          compile.check.state = passed ? 'passed' : 'failed';
          if (step.lean) compile.check.lean = step.lean;
          if (step.text) compile.check.text = step.text;
          compile.row.tone = passed ? 'done' : 'failed';
          compile.row.outcome = step.lean || passed ? leanOutcome(step.lean, passed) : { text: t('未完成编译'), tone: 'failed' };
          if (step.lean) compile.row.details.push({ kind: 'lean', lean: step.lean });
          if (step.text) compile.row.details.push({ kind: 'feedback', text: step.text });
          if (passed && step.targets?.length) compile.row.details.push({ kind: 'note', text: t('目标：{0}', step.targets.join(', ')) });
          compile = undefined;
        }
        break;
      }
      case 'revision': {
        const round = roundOf(step.round);
        if (step.stage === 'round') round.result = 'revision';
        round.rows.push({ id: `f:revision:${entry.sequence}`, label: step.stage === 'plan' ? t('理解结果被退回') : t('这一轮没有通过'),
          tone: 'failed', at: entry.at, details: [{ kind: 'feedback', text: step.text, ...(step.textClipped ? { clipped: true } : {}) }] });
        break;
      }
      case 'approved': roundOf(step.round).result = 'approved';
        roundOf(step.round).rows.push({ id: `f:approved:${entry.sequence}`, label: direct ? t('Lean 编译通过') : t('两位审核都认为与原题一致'), tone: 'done', at: entry.at, details: [] }); break;
      case 'stopped': stopped = { id: `f:stopped:${entry.sequence}`, label: t('形式化停止'), tone: 'stopped', at: entry.at,
        outcome: { text: formalizationReasonText(step.reason), tone: 'muted' },
        details: step.text ? [{ kind: 'feedback', text: step.text, ...(step.textClipped ? { clipped: true } : {}) }] : [] }; break;
    }
  }
  if (!live) {
    for (const round of rounds.values()) for (const row of round.rows) if (row.tone === 'active') { row.tone = 'stopped'; row.outcome = { text: t('未完成'), tone: 'muted' }; }
    for (const check of checks) if (check.state === 'running') check.state = 'failed';
  }
  const ordered = [...rounds.values()].sort((a, b) => a.round - b.round);
  // One round reads as its steps; several read as one group each, the latest open.
  const rows: ProcessRow[] = ordered.length === 1 ? ordered[0]!.rows : ordered.map((round, index) => ({
    id: `f:round:${round.round}`, label: t('第 {0} 轮', round.round), at: round.rows[0]?.at, details: [], rows: round.rows,
    tone: round.result === 'approved' ? 'done' : round.result === 'revision' ? 'failed' : round.rows.some(row => row.tone === 'active') ? 'active' : 'stopped',
    ...(round.result ? { outcome: round.result === 'approved' ? { text: t('通过'), tone: 'passed' as const } : { text: t('退回修改'), tone: 'failed' as const } } : {}),
    open: index === ordered.length - 1 }));
  if (stopped) rows.push(stopped);
  return { rows, rounds: ordered.length, compiles: checks.length };
}

const phaseRows = ['planning', 'generating', 'compiling', 'translating', 'reviewing'] as const;
/** A formalization without recorded activity (started before it was recorded): its phases, up to the one it reached. */
function phaseFallback(item: WebFormalization, live: boolean): ProcessRow[] {
  const phase = item.progress?.phase ?? 'queued', ok = ['review', 'confirmed'].includes(item.status);
  const rows = item.reviewMode === 'direct' ? phaseRows.filter(id => id === 'generating' || id === 'compiling') : phaseRows;
  const current = ok || phase === 'finishing' ? rows.length : rows.findIndex(id => id === phase);
  const labels: Record<string, string> = { planning: t('理解题目'), generating: t('写 Lean 陈述'), compiling: t('编译检查'), translating: t('独立回译'), reviewing: t('审核与原题是否一致') };
  return rows.map((id, index): ProcessRow => ({ id: `f:phase:${id}`, label: labels[id]!, details: [],
    tone: index < current ? 'done' : index > current || current < 0 ? live ? 'pending' : 'skipped' : live ? 'active' : item.status === 'cancelled' ? 'stopped' : 'failed' }));
}

function formalizeStage(item: WebFormalization, activity: readonly WebFormalizationActivity[], checks: LiveCheck[]): ProcessStage {
  const live = item.status === 'queued' || item.status === 'running';
  const built = activity.length ? formalizationRows(activity, live, checks, item.reviewMode === 'direct') : undefined;
  const rows = built?.rows ?? phaseFallback(item, live);
  const tone: ProcessTone = live ? 'active' : ['review', 'confirmed'].includes(item.status) ? 'done' : item.status === 'cancelled' ? 'stopped' : 'failed';
  const summary = built ? [built.rounds > 1 ? t('{0} 轮', built.rounds) : '', built.compiles ? t('编译 {0} 次', built.compiles) : ''].filter(Boolean).join(' · ') : undefined;
  return { id: 'formalize', label: t('形式化原题'), tone, rows, ...(summary ? { summary } : {}) };
}

const oneLine = (text: string, limit = 80) => {
  const line = (text.split('\n').find(value => value.trim()) ?? '').trim();
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
};
// The host's own Lean checks of an Agent's work: a start, then the closing event that carries the verdict.
const hostCheckStarts = new Set(['proof_check_started', 'task_recheck_started', 'assembly_started']);
const hostCheckEnds = new Set(['proof_checked', 'task_checked', 'task_check_reused', 'task_recheck_finished', 'proof_ready_checked', 'lemma_checked']);
const taskStatusLabels: Record<string, string> = { pending: t('待调度'), running: t('进行中'), blocked: t('受阻'), conditional: t('有条件结果'),
  delivered: t('已交付'), integrated: t('已集成'), completed: t('已完成'), paused: t('暂停'), stopped: t('停止'), failed: t('失败') };
const taskKindLabels: Record<string, string> = { research: t('研究'), sketch: t('草图'), lemma: t('引理'), goal: t('原始目标') };
type Task = NonNullable<WebRun['observation']>['inspection']['tasks'][number];
const taskState = (task: Task) => task.control === 'active' ? task.status : task.control;

/** The Lead's plan when it has more than one task: each task with its state as the host records it. */
function planRow(run: WebRun, live: boolean): ProcessRow | undefined {
  const tasks = run.observation?.inspection.tasks ?? [];
  if (tasks.length < 2) return;
  const names = taskNames(tasks), lemmas = tasks.filter(task => task.kind === 'lemma').length;
  const settled = tasks.filter(task => ['integrated', 'completed'].includes(taskState(task))).length;
  const rows = tasks.map((task): ProcessRow => {
    const state = taskState(task), done = ['integrated', 'completed'].includes(state);
    const tone: ProcessTone = done ? 'done' : ['blocked', 'failed'].includes(state) ? 'failed'
      : ['running', 'delivered', 'conditional'].includes(state) ? live ? 'active' : 'stopped' : live ? 'pending' : 'skipped';
    return { id: `p:task:${task.id}`, label: names.get(task.id) ?? (oneLine(task.objective) || task.id), tone, meta: taskKindLabels[task.kind] ?? task.kind,
      outcome: { text: taskStatusLabels[state] ?? state, tone: done ? 'passed' : tone === 'failed' ? 'failed' : 'muted' },
      details: task.objective ? [{ kind: 'note', text: task.objective }] : [] };
  });
  return { id: 'p:plan', label: lemmas ? t('拆成 {0} 个引理', lemmas) : t('研究计划：{0} 个任务', tasks.length),
    tone: settled === tasks.length ? 'done' : live ? 'active' : 'stopped', meta: t('已完成 {0}/{1}', settled, tasks.length), details: [], rows };
}

/** An Agent's own `check-lean`; the file is shown when it is the candidate the run saved from that Agent. */
function selfCheck(action: WebAgentAction, file: string, run: WebRun, who: string, live: boolean): LiveCheck {
  const lean = action.lean, name = base(file || 'Submission.lean');
  const passed = lean?.passed ?? action.status === 'done';
  const state = action.status === 'running' ? live ? 'running' : 'failed' : passed ? 'passed' : 'failed';
  const check: LiveCheck = { id: `p:${action.workerId}:${action.itemId}`, stage: 'prove', label: t('{0} 自查 {1}', who, name), who, at: action.at, state, file: name,
    ...(lean ? { lean } : !passed && action.output ? { text: action.output } : {}) };
  const artifact = run.artifact;
  if (artifact && artifact.workerId === action.workerId && name === 'Submission.lean') {
    check.source = artifact.source;
    // Saved well after this check ended: the lines Lean names may have moved since.
    if (Date.parse(artifact.capturedAt) > Date.parse(action.at) + (action.durationMs ?? 0) + 3_000) check.sourceNote = 'changed';
  }
  return check;
}
const selfOutcome = (check: LiveCheck): ProcessOutcome => check.state === 'running' ? { text: t('检查中…'), tone: 'muted' }
  : check.state === 'failed' ? leanOutcome(check.lean, false)
    : check.lean?.messages.some(message => /\bsorry\b/u.test(message.text)) ? { text: t('没有错误，但用了 sorry'), tone: 'muted' } : { text: t('自查通过'), tone: 'passed' };

// A lane shows its newest steps; the roadmap has all of them.
const shownSteps = 6;
type LaneContext = { run: WebRun; live: boolean; name: string; tasks: ReadonlyMap<string, string>; checks: LiveCheck[] };
/**
 * One Agent's lane: the row says what it is on now, its latest steps sit inside, each opening to what the Agent did.
 * Acceptance steps are left to the acceptance stage. `attempts` counts the steps in which it wrote proof code.
 */
function laneRow(route: AgentRoute, ctx: LaneContext): { row: ProcessRow; attempts: number } | undefined {
  const steps = route.steps.filter(step => step.kind !== 'accept'), last = steps.at(-1);
  if (!last) return;
  const live = ctx.live && !['deliver', 'stop'].includes(last.kind) && !last.outcome, touched = new Set<string>();
  let planned = 0, attempts = 0, pending: WebEvent | undefined;
  const rows = steps.map((step, index): ProcessRow => {
    const actions = step.items.flatMap(item => item.type === 'action' ? [item.action] : []);
    const files = [...new Set(actions.flatMap(action => action.kind === 'edit' ? (action.changes ?? []).map(change => base(change.movedTo ?? change.path)) : []))];
    let label = routeStepLabel(step, ctx.tasks), code: string | undefined, check: string | undefined, outcome: ProcessOutcome | undefined;
    if (step.kind === 'write' && step.planning) label = planned++ ? t('修改计划') : t('制定计划');
    else if (step.kind === 'write' && !step.reviewing && files.length) {
      label = files.some(file => touched.has(file)) ? t('修改') : t('写');
      code = files.length > 1 ? `${files[0]} +${files.length - 1}` : files[0];
      attempts++;
    }
    for (const file of files) touched.add(file);
    for (const action of actions) {
      const file = checkLeanFile(action);
      if (file === undefined) continue;
      const self = selfCheck(action, file, ctx.run, ctx.name, ctx.live);
      ctx.checks.push(self); check = self.id; outcome = selfOutcome(self);
    }
    for (const item of step.items) {
      if (item.type !== 'event') continue;
      const event = item.event, passed = event.details?.passed;
      if (hostCheckStarts.has(event.type)) { pending = event; continue; }
      if (!hostCheckEnds.has(event.type)) continue;
      if (typeof passed === 'boolean') {
        const task = event.details?.taskId ? ctx.tasks.get(event.details.taskId) : undefined;
        const host: LiveCheck = { id: `p:e:${event.sequence}`, stage: 'prove', label: task ? t('平台检查 {0}', task) : t('平台检查'), who: ctx.name,
          at: (pending ?? event).at, state: passed ? 'passed' : 'failed', text: localizeText(event.message) };
        ctx.checks.push(host);
        if (step.kind === 'check') { check = host.id; outcome = passed ? { text: t('通过'), tone: 'passed' } : { text: t('未通过'), tone: 'failed' }; }
      }
      pending = undefined;
    }
    if (!outcome && step.outcome) outcome = step.outcome === 'passed' ? { text: t('通过'), tone: 'passed' } : { text: t('未通过'), tone: 'failed' };
    const final = index === steps.length - 1, cut = final && !ctx.live && ['read', 'write'].includes(step.kind) && !outcome;
    const tone: ProcessTone = final && live ? 'active' : step.superseded ? 'skipped' : step.kind === 'stop' || cut ? 'stopped' : outcome?.tone === 'failed' ? 'failed' : 'done';
    const details: ProcessDetail[] = [{ kind: 'items', items: step.items }];
    if (step.superseded) details.push({ kind: 'note', text: t('研究计划随后调整，这一步所做的任务分配被新版本取代，成果没有用上。') });
    return { id: `p:${route.workerId}:${step.kind}@${step.at}`, label, tone, at: step.at, details,
      ...(code ? { code } : {}), ...(outcome ? { outcome } : {}), ...(check ? { check } : {}) };
  });
  // The host check still running when the lane's records end.
  if (pending && live) ctx.checks.push({ id: `p:e:${pending.sequence}`, stage: 'prove', label: t('平台检查'), who: ctx.name, at: pending.at, state: 'running' });
  const shown = rows.slice(-shownSteps), hidden = rows.length - shown.length, latest = rows.at(-1)!;
  const tone: ProcessTone = live ? 'active' : last.kind === 'deliver' || last.outcome === 'passed' ? 'done' : latest.tone === 'failed' ? 'failed' : 'stopped';
  return { attempts, row: { id: `p:lane:${route.workerId}`, label: ctx.name, tone, at: steps[0]!.at, meta: latest.code ? `${latest.label} ${latest.code}` : latest.label,
    ...(latest.outcome ? { outcome: latest.outcome } : {}), rows: shown, open: live,
    details: hidden ? [{ kind: 'note', text: t('更早的 {0} 步见「路线图」。', hidden) }] : [] } };
}

const prepareEvents = new Set<string>(runStages[1].events);
/** Proving: the proof environment, the Lead's plan, then one lane per Agent with its latest steps. */
function proveStage(run: WebRun, events: readonly WebEvent[], routes: readonly AgentRoute[], checks: LiveCheck[]): { stage: ProcessStage; attempts: number; agents: number } {
  const live = run.status === 'queued' || run.status === 'running', progress = runProgress(run), rows: ProcessRow[] = [];
  const workers = run.observation?.inspection.workers ?? [], names = workerNames(workers), tasks = taskNames(run.observation?.inspection.tasks ?? []);
  if (run.status === 'queued') rows.push({ id: 'p:queue', label: t('等待运行'), tone: 'active', details: [{ kind: 'note', text: queueDescription(run) }] });
  const prepare = progress.steps[1]!, prepared = events.filter(event => prepareEvents.has(event.type));
  if (run.status !== 'queued') {
    const tone: ProcessTone = { done: 'done', active: 'active', error: 'failed', stopped: 'stopped', pending: 'pending', skipped: 'skipped' }[prepare.state] as ProcessTone;
    rows.push({ id: 'p:prepare', label: t('准备证明环境'), tone, ...(prepared[0] ? { at: prepared[0].at } : {}),
      ...(prepare.state === 'done' && prepare.elapsed !== null ? { outcome: { text: readableDuration(prepare.elapsed), tone: 'muted' as const } } : {}),
      ...(prepare.state === 'error' ? { outcome: { text: t('未通过'), tone: 'failed' as const } } : {}),
      ...(prepare.state === 'active' && prepared.at(-1) ? { meta: localizeText(prepared.at(-1)!.message) } : {}),
      details: prepared.length ? [{ kind: 'items', items: prepared.map(event => ({ type: 'event' as const, event })) }] : [] });
  }
  const plan = planRow(run, live);
  if (plan) rows.push(plan);
  const lead = workers.find(worker => worker.role === 'lead')?.id;
  const ordered = [...routes].sort((a, b) => Number(b.workerId === lead) - Number(a.workerId === lead));
  let attempts = 0, agents = 0;
  for (const route of ordered) {
    const lane = laneRow(route, { run, live, name: names.get(route.workerId) ?? route.workerId, tasks, checks });
    if (!lane) continue;
    rows.push(lane.row); attempts += lane.attempts; agents++;
  }
  if (!agents && live && progress.index === 2) rows.push({ id: 'p:waiting', label: planGated(run) ? t('等你批准计划') : t('Agent 正在开始工作'), tone: 'active', details: [] });
  const tone: ProcessTone = run.status === 'queued' || live && progress.index < 3 ? 'active'
    : progress.index >= 3 || isAcceptedRun(run) ? 'done' : run.status === 'cancelled' ? 'stopped' : isFaultedRun(run) ? 'failed' : 'stopped';
  const own = checks.filter(check => check.stage === 'prove').length;
  const summary = [agents ? t('{0} 个 Agent', agents) : '', own ? t('Lean 检查 {0} 次', own) : ''].filter(Boolean).join(' · ');
  return { stage: { id: 'prove', label: t('证明'), tone, rows, ...(summary ? { summary } : {}) }, attempts, agents };
}

/** The independent acceptance of the whole problem, from its events and the run's result. */
function verifyStage(run: WebRun, events: readonly WebEvent[], checks: LiveCheck[]): ProcessStage {
  const live = run.status === 'queued' || run.status === 'running';
  const started = events.find(event => event.type === 'evaluation_started'), finished = events.find(event => event.type === 'evaluation_finished');
  const accepted = isAcceptedRun(run), rejected = isRejectedRun(run);
  const report = run.result ? summarizeReport(run).checks.find(check => check.id === 'evaluation') : undefined;
  const label = t('独立验收');
  if (!started && !finished && !accepted && !rejected && (!report || report.skipped)) {
    const why = live ? undefined : report ? checkReason(report) : run.status === 'cancelled' ? undefined : checkReason({ skipped: true });
    return { id: 'verify', label, tone: live ? 'pending' : 'skipped', rows: why ? [{ id: 'v:skipped', label: t('没有进行独立验收'), tone: 'skipped', details: [{ kind: 'note', text: why }] }] : [] };
  }
  const done = Boolean(finished) || accepted || rejected || !live;
  const failing = report?.targets.filter(target => target.tone !== 'passed') ?? [];
  const feedback = failing.flatMap(target => [`${target.name} · ${target.status}`, ...target.diagnostics.map(item => item.text)]).join('\n\n');
  const check: LiveCheck = { id: 'v:evaluation', stage: 'verify', label, at: (started ?? finished)?.at ?? run.updatedAt,
    state: !done ? 'running' : accepted ? 'passed' : 'failed', file: 'Submission.lean',
    ...(run.result?.proof ? { source: run.result.proof } : {}), ...(feedback ? { text: feedback.slice(0, 6_000) } : {}) };
  checks.push(check);
  const outcome: ProcessOutcome | undefined = !done ? { text: t('检查中…'), tone: 'muted' } : accepted ? { text: t('通过'), tone: 'passed' }
    : run.result?.status === 'evaluated_rejected' ? { text: t('未满足验收约束'), tone: 'failed' } : report ? { text: report.status, tone: report.tone === 'passed' ? 'passed' : 'failed' } : undefined;
  const details: ProcessDetail[] = [];
  if (report?.method) details.push({ kind: 'note', text: t('方法：{0}', report.method) });
  if (report?.reason) details.push({ kind: 'note', text: checkReason(report) ?? report.reason });
  if (feedback) details.push({ kind: 'feedback', text: feedback });
  return { id: 'verify', label, tone: !done ? 'active' : accepted ? 'done' : 'failed', rows: [{ id: 'v:evaluation', label: run.formalization?.reviewMode === 'direct' ? t('在干净环境里重新检查完整 Lean 陈述') : run.formalization ? t('在干净环境里重新检查固定的 Lean 陈述') : t('在干净环境里重新检查完整原题'),
    tone: !done ? 'active' : accepted ? 'done' : 'failed', ...(check.at ? { at: check.at } : {}), ...(outcome ? { outcome } : {}), details, check: check.id }] };
}

function solveState(item: WebFormalization | undefined, run: WebRun | undefined): SolveState {
  if (run) {
    if (run.status === 'queued') return 'queued';
    if (run.status === 'running') return runProgress(run).index >= 3 ? 'verifying' : 'proving';
    if (isAcceptedRun(run)) return 'accepted';
    if (item?.status === 'running') return 'formalizing';
    if (run.status === 'cancelled') return 'cancelled';
    return isFaultedRun(run) || isRejectedRun(run) ? 'failed' : 'stopped';
  }
  switch (item?.status) {
    case undefined: case 'queued': return 'queued';
    case 'running': return 'formalizing';
    case 'review': return 'review';
    // A solve request starts its run as the statement is confirmed; until the run is read, it is proving.
    case 'confirmed': return item.researchError ? 'failed' : item.workflow === 'solve' || item.runId ? 'proving' : 'review';
    case 'cancelled': return 'cancelled';
    case 'exhausted': return 'stopped';
    case 'error': return 'failed';
  }
}
function stateLabel(state: SolveState, item: WebFormalization | undefined, run: WebRun | undefined): string {
  switch (state) {
    case 'queued': return run ? t('等待运行') : t('排队中');
    case 'formalizing': return t('正在形式化原题');
    case 'review': return item?.status === 'confirmed' ? t('陈述已确认') : t('陈述待核对');
    case 'proving': return run && planGated(run) ? runProgress(run).phaseLabel : run && runProgress(run).index === 1 ? t('准备证明环境') : t('正在证明');
    case 'verifying': return t('正在独立验收');
    case 'accepted': return run ? acceptedTitle(run) : t('完整原题通过');
    case 'failed': return run ? isRejectedRun(run) ? t('验收未通过') : t('运行失败') : item?.researchError ? t('证明研究未能启动') : t('形式化未完成');
    case 'stopped': return run ? stoppedLabel(run) : t('形式化未完成');
    case 'cancelled': return t('已取消');
  }
}

/** The whole solving process of one task: a formalization, the run it started, or both. */
export function buildSolveProcess(input: SolveProcessInput): SolveProcess {
  const { formalization: item, run } = input, checks: LiveCheck[] = [], stages: ProcessStage[] = [];
  const activity = input.activity ?? [], events = input.events ?? run?.events ?? [];
  if (item) stages.push(formalizeStage(item, activity, checks));
  else if (run?.formalization) stages.push({ id: 'formalize', label: t('形式化原题'), tone: 'done', rows: [] });
  let attempts = activity.filter(entry => entry.type === 'step' && entry.step.step === 'role' && entry.step.role === 'generate' && entry.step.state === 'started').length;
  let agents = 0;
  if (run) {
    const prove = proveStage(run, events, input.routes ?? [], checks);
    stages.push(prove.stage, verifyStage(run, events, checks));
    attempts += prove.attempts; agents = prove.agents;
  } else if (item) {
    // Before its run: proving waits for the statement, or will not happen because formalizing ended without one.
    const ended = ['exhausted', 'cancelled', 'error'].includes(item.status) || Boolean(item.researchError);
    const starting = (item.status === 'confirmed' || Boolean(item.runId)) && !ended;
    stages.push({ id: 'prove', label: t('证明'), tone: starting ? 'active' : ended ? 'skipped' : 'pending',
      rows: starting ? [{ id: 'p:starting', label: t('正在启动证明研究'), tone: 'active', details: [] }]
        : item.researchError ? [{ id: 'p:start-failed', label: t('证明研究未能启动'), tone: 'failed', outcome: { text: formalizationReasonText(item.researchError), tone: 'muted' }, details: [] }] : [] },
    { id: 'verify', label: t('独立验收'), tone: ended ? 'skipped' : 'pending', rows: [] });
  }
  const state = solveState(item, run), active = ['queued', 'formalizing', 'proving', 'verifying'].includes(state)
    || item?.status === 'queued' || item?.status === 'running';
  const names = workerNames(run?.observation?.inspection.workers ?? []);
  const compiled = [...activity].reverse().find(entry => entry.type === 'step' && entry.step.step === 'compile' && entry.step.state === 'started');
  const statement = compiled?.type === 'step' && compiled.step.step === 'compile' ? compiled.step : undefined;
  const current: SolveProcess['current'] = run?.result?.proof ? { kind: isAcceptedRun(run) ? 'proof' : 'candidate', file: 'Submission.lean', source: run.result.proof, at: run.finishedAt ?? run.updatedAt }
    : run?.artifact ? { kind: 'candidate', file: 'Submission.lean', source: run.artifact.source, at: run.artifact.capturedAt, who: names.get(run.artifact.workerId) ?? run.artifact.workerId }
      : run ? { kind: 'statement', file: 'Submission.lean', source: run.source }
        : item?.compiled ? { kind: 'statement', file: 'Formalization.lean', source: item.compiled.source }
          : statement?.source !== undefined && !item?.report ? { kind: 'statement', file: 'Formalization.lean', source: statement.source, at: compiled!.at, ...(statement.sourceClipped ? { clipped: true } : {}) }
          : item?.report ? { kind: 'statement', file: 'Formalization.lean', source: item.report.statement } : undefined;
  const tokens = (item?.progress?.tokens ?? 0) + (run ? runTokens(run) ?? 0 : 0);
  const endedAt = active ? undefined : run ? run.finishedAt ?? run.updatedAt : item?.finishedAt ?? item?.updatedAt;
  checks.sort((a, b) => a.at < b.at ? -1 : a.at > b.at ? 1 : 0);
  return { key: item?.id ?? run?.formalizationId ?? run?.id ?? '', state, label: stateLabel(state, item, run), active,
    ...(item?.createdAt ?? run?.createdAt ? { startedAt: item?.createdAt ?? run?.createdAt } : {}), ...(endedAt ? { endedAt } : {}), ...(tokens ? { tokens } : {}),
    stages, checks, counts: { checks: checks.length, attempts, agents }, ...(current ? { current } : {}),
    dropped: (input.activityDropped ?? 0) + (input.actionsDropped ?? 0), thinking: buildThinkingEntries(input, checks) };
}

