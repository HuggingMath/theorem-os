import type { WebShareSnapshot } from '../shareTypes';
import { buildSolutionRoute, type SolutionRoute, type SolutionRouteNode, type SolutionRouteSection } from '../solutionRoute';
import { translator } from '../i18n';
import { leanOutline } from './leanOutline';

export function sharedSolutionRoute(share: WebShareSnapshot, language: 'zh' | 'en', id: string): SolutionRoute {
  const t = translator(language), reading = share.reading;
  const part = (title: string, text: string | undefined, code = false): SolutionRouteSection[] => text?.trim()
    ? [{ title, text, ...(code ? { code: true } : {}) }] : [];
  const goal: SolutionRouteNode = { id: 'problem', kind: 'problem', title: share.title, status: 'recorded',
    summary: share.formalization?.original ?? share.task,
    sections: [...part(t('原题'), share.formalization?.original ?? share.task), ...part(t('前提'), reading?.conditions.join('\n\n'))] };
  const tasks = (reading?.tasks ?? []).map(task => ({ id: `task:${task.id}`, kind: 'task' as const, title: task.title,
    status: (['verified', 'accepted', 'passed', 'kernel_verified'].includes(task.status) ? 'passed'
      : task.status === 'conditional' ? 'conditional' : task.status === 'failed' ? 'failed' : 'recorded') as SolutionRouteNode['status'],
    summary: task.statement ?? task.reasoning, dependencies: task.dependencies.map(id => `task:${id}`),
    sections: [...part(t('数学陈述'), task.statement), ...part(t('Lean 声明'), task.leanStatement, true),
      ...part(t('前提'), task.premises.join('\n\n')),
      ...part(t('输入版本'), task.conditions.map(condition => `${condition.taskId} · ${condition.version}`).join('\n'), true),
      ...part(t('推导思路'), task.reasoning), ...part(t('研究发现'), task.finding),
      ...part(t('任务版本'), task.version, true), ...part(t('检查回执'), task.proof?.receiptIds.join('\n'), true),
      ...part(t('对应源码'), task.source?.code, true)],
    ...(task.source ? { source: { name: task.source.file, commit: task.source.commit, sha256: task.source.sha256 } } : {}),
  }));
  const model = buildSolutionRoute({ id, title: t('证明路线'), locale: language, goal, tasks, records: [],
    outcome: { id: 'acceptance', kind: 'acceptance', title: t('独立验收完整原题'), status: 'passed',
      sections: share.checks.map(check => ({ title: check.label, text: [check.status, ...check.targets.map(target => `${target.name}: ${target.status}`)].join('\n') })) } });
  if (!tasks.length) {
    const headings = leanOutline(share.proof), lines = share.proof.split('\n');
    const nodes = headings.map((heading, index): SolutionRouteNode => ({ id: `declaration:${heading.qualifiedName}`, kind: 'declaration',
      title: heading.qualifiedName, status: 'recorded',
      sections: part(t('对应源码'), lines.slice(heading.line - 1, headings[index + 1] ? headings[index + 1]!.line - 1 : lines.length).join('\n'), true),
      source: { name: 'Submission.lean', line: heading.line, endLine: headings[index + 1] ? headings[index + 1]!.line - 1 : lines.length } }));
    model.nodes.splice(1, 0, ...nodes);
    for (const node of nodes) model.edges.push({ from: goal.id, to: node.id, kind: 'reference' }, { from: node.id, to: 'acceptance', kind: 'evidence' });
    model.basis = 'source'; model.partial = true;
  }
  return model;
}
