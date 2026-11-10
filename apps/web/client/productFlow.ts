import type { WebRun, WebSession, WebContinuation } from '../shared';
import type { NextStep } from '../report';
import { summarizeGoals, summarizeStuck } from '../report';
import { formatTokens, isAcceptedRun, readableDuration, resultDescription, runProgress, runTokens } from '../presentation';
import { locale } from '../i18n';

const tx = (zh: string, en: string) => locale === 'en' ? en : zh;
export const statementTemplate = () => tx('假设与对象：\n\n需要证明：\n\n符号说明：\n\n已有思路（可选）：', 'Objects and assumptions:\n\nClaim to prove:\n\nNotation:\n\nExisting approach (optional):');

/** Describe the actual recovery action; none of these actions starts a paid run. */
export function recoveryDescription(run: WebRun, step: NextStep, limits?: WebSession['limits']): string {
  const names = (ids: readonly string[]) => ids.map(id => run.observation?.inspection.tasks.find(task => task.id === id)?.theorem || id).join(', ');
  if (step.id === 'continue-checked') return tx(`选择已通过本次 Lean 检查的保存版本，带入 ${names(step.tasks)} 的代码作为参考；新研究仍会重新检查。`, `Choose a saved version that passed this run's Lean check and carry the code for ${names(step.tasks)} as reference. The new run will check it again.`);
  if (step.id === 'ask-failed') return tx(`打开 ${names(step.tasks)} 的失败步骤和检查反馈，不启动新研究。`, `Open the failed steps and check feedback for ${names(step.tasks)} without starting a new run.`);
  const next = (value: number, maximum?: number) => Math.min(maximum ?? value, Math.max(1, value) * 2);
  if (step.id === 'budget') return tx(`保留原题与配置，将证明时间从 ${readableDuration(run.maxRunSeconds * 1000)} 预填为 ${readableDuration(next(run.maxRunSeconds, limits?.maxRunSeconds) * 1000)}，提交前可修改。`, `Keep the original problem and settings; prepare a proof time limit of ${readableDuration(next(run.maxRunSeconds, limits?.maxRunSeconds) * 1000)} instead of ${readableDuration(run.maxRunSeconds * 1000)}. Review it before submitting.`);
  if (step.id === 'turns') return tx(`保留原题与配置，将轮次从 ${run.maxTurns} 预填为 ${next(run.maxTurns, limits?.maxTurns)}，提交前可修改。`, `Keep the problem and settings; prepare ${next(run.maxTurns, limits?.maxTurns)} turns instead of ${run.maxTurns}. Review before submitting.`);
  if (step.id === 'key') return tx('保留原题和模型配置，先修正连接凭据，再由你提交新研究。', 'Keep the problem and model settings. Correct the connection credentials before submitting a new run.');
  if (step.id === 'tokens') return tx('保留原题和本次配置，打开 Token 上限供你调整；核对后再提交新研究。', 'Keep the original problem and settings, then review the token limit before submitting a new run.');
  if (step.id === 'workers') return tx('保留原题，打开 Agent 数量设置；调整协作配置后再提交新研究。', 'Keep the original problem and review the number of agents and collaboration settings before submitting a new run.');
  if (step.id === 'task') return tx('保留原题，在新草稿中修改研究方向；已检查代码需另选保存版本带入。', 'Keep the original problem and revise the approach in a new draft. Select a saved version separately to carry checked code.');
  if (step.id === 'source') return tx('打开原始 Lean 陈述供你修改。修改后的陈述需要重新核对与验收。', 'Open the original Lean statement for editing. A changed statement needs a new review and acceptance check.');
  return tx('载入原始题目和本次配置供你核对；候选代码不会自动带入，发送后才启动新研究。', 'Load the original problem and settings for review. Candidate code is not carried automatically; a new run starts only when you submit.');
}

export type ResearchComparison = {
  comparable: boolean;
  rows: { label: string; before: string; after: string }[];
  changedTasks: { id: string; label: string; kind: 'added' | 'removed' | 'changed' }[];
};
export function relatedResearchRuns(runs: readonly WebRun[], run: WebRun): WebRun[] {
  return runs.filter(other => other.id !== run.id && (other.continueFrom?.runId === run.id || run.continueFrom?.runId === other.id
    || other.source === run.source && other.environment === run.environment && (other.formalization?.original ?? '') === (run.formalization?.original ?? '')))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
/** Results are comparable only for the same statement, environment and original natural-language meaning. */
export function compareResearchRuns(before: WebRun, after: WebRun): ResearchComparison {
  const comparable = before.source.replace(/\r\n?/gu, '\n') === after.source.replace(/\r\n?/gu, '\n')
    && before.environment === after.environment
    && (before.formalization?.original ?? '') === (after.formalization?.original ?? '');
  const unknown = tx('未记录', 'Not recorded');
  const goals = (run: WebRun) => {
    const summary = summarizeGoals(run);
    return summary ? summary.goals.map(goal => `${goal.name}: ${goal.status}`).join('\n') : unknown;
  };
  const blockers = (run: WebRun) => {
    if (isAcceptedRun(run)) return tx('完整原题已验收', 'Original problem accepted');
    const stuck = summarizeStuck(run);
    return stuck?.tasks.length ? stuck.tasks.map(task => `${task.theorem || task.id}${task.failure ? ': ' + task.failure : task.blockers.length ? ': ' + task.blockers.join(', ') : ''}`).join('\n') : unknown;
  };
  const tokens = (run: WebRun) => { const value = runTokens(run); return value == null ? unknown : `${formatTokens(value)} Token`; };
  const duration = (run: WebRun) => { const value = runProgress(run).solvingElapsed; return value === null ? unknown : readableDuration(value); };
  const checkedLemmas = (run: WebRun) => run.observation ? run.observation.inspection.tasks.filter(task => task.kind === 'lemma' && task.proof.status === 'checked' && task.control !== 'stopped').map(task => task.theorem || task.id).join('\n') || tx('暂无已检查引理', 'No checked lemmas recorded') : unknown;
  const routes = (run: WebRun) => {
    const plan = run.observation?.plan;
    if (!plan) return unknown;
    const name = (id: string) => plan.tasks.find(task => task.id === id)?.theoremName || id;
    return plan.proofRoutes?.length ? plan.proofRoutes.map(route => `${route.prerequisiteTaskIds.map(name).join(' + ')} → ${name(route.closingTaskId)} → ${name(route.targetTaskId)}`).join('\n')
      : plan.tasks.map(task => `${task.theoremName || task.id}${task.dependsOn.length ? ' ← ' + task.dependsOn.map(name).join(' + ') : ''}`).join('\n');
  };
  const currentPlan = before.observation?.plan, nextPlan = after.observation?.plan;
  const previous = new Map((currentPlan?.tasks ?? []).map(task => [task.id, task]));
  const nextTasks = new Map((nextPlan?.tasks ?? []).map(task => [task.id, task]));
  const changedTasks: ResearchComparison['changedTasks'] = [];
  if (currentPlan && nextPlan) {
    for (const [id, task] of previous) {
      const newer = nextTasks.get(id);
      if (!newer) changedTasks.push({ id, label: task.theoremName || id, kind: 'removed' });
      else if (JSON.stringify([task.kind, task.objective, task.informalStatement, task.type, [...task.dependsOn].sort()]) !== JSON.stringify([newer.kind, newer.objective, newer.informalStatement, newer.type, [...newer.dependsOn].sort()]))
        changedTasks.push({ id, label: newer.theoremName || id, kind: 'changed' });
    }
    for (const [id, task] of nextTasks) if (!previous.has(id)) changedTasks.push({ id, label: task.theoremName || id, kind: 'added' });
  }
  return { comparable, changedTasks, rows: [
    { label: tx('陈述版本', 'Statement version'), before: before.formalization?.evidenceSha256 ?? tx('原始 Lean 陈述（见源码）', 'Original Lean statement (see source)'), after: after.formalization?.evidenceSha256 ?? tx('原始 Lean 陈述（见源码）', 'Original Lean statement (see source)') },
    { label: tx('结果', 'Result'), before: resultDescription(before), after: resultDescription(after) },
    { label: tx('目标进展', 'Goal progress'), before: goals(before), after: goals(after) },
    { label: tx('已检查引理', 'Checked lemmas'), before: checkedLemmas(before), after: checkedLemmas(after) },
    { label: tx('剩余阻碍', 'Remaining blockers'), before: blockers(before), after: blockers(after) },
    { label: tx('证明路线', 'Proof routes'), before: routes(before), after: routes(after) },
    { label: tx('模型', 'Model'), before: before.model, after: after.model },
    { label: tx('证明用量', 'Proof usage'), before: tokens(before), after: tokens(after) },
    { label: tx('研究用时', 'Research time'), before: duration(before), after: duration(after) },
  ] };
}

export type ContinuationPreview = { title: string; runId: string; from?: WebContinuation; originalSeconds: number; originalTurns: number; originalTokens?: number };
