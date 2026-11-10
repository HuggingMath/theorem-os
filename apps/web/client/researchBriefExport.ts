import { statementConfirmation } from '../presentation';
import type { ResearchBrief } from '../researchWorkspaceTypes';

/** An export uses saved evidence only. It does not request another explanation or model response. */
export function researchBriefMarkdown(brief: ResearchBrief, language: 'zh' | 'en', origin: string): string {
  const tx = (zh: string, en: string) => language === 'en' ? en : zh;
  const link = (href: string) => new URL(href, `${origin}/`).href;
  const code = (value: string) => {
    const fence = '`'.repeat(Math.max(3, ...[...value.matchAll(/`+/gu)].map(match => match[0].length + 1)));
    return `${fence}\n${value}\n${fence}`;
  };
  const paragraphs = [
    `# ${brief.title}`, `${tx('生成时间', 'Generated')}: ${brief.generatedAt}`,
    `## ${tx('问题与结论', 'Problem and result')}`, brief.statement,
    `${tx('当前验收', 'Current acceptance')}: ${brief.status}`,
    `[${tx('打开研究', 'Open research')}](${link(brief.runHref)})`,
    `${tx('冻结的 Lean 陈述', 'Frozen Lean statement')}\n\n${code(brief.leanStatement)}`,
    `${tx('环境', 'Environment')}: ${brief.environment}\n\n${tx('原题源码摘要', 'Original source digest')}: ${brief.sourceDigest}`,
    brief.environmentDigest ? `${tx('环境摘要', 'Environment digest')}: ${brief.environmentDigest}` : '',
    brief.formalization ? `${statementConfirmation(brief.formalization.confirmation, false, brief.formalization.reviewMode, language)}\n\n${tx('形式化证据', 'Formalization evidence')}: ${brief.formalization.evidenceDigest}` : '',
    `## ${tx('历次尝试', 'Research attempts')}`,
    ...brief.attempts.map((attempt, index) => `${index + 1}. [${attempt.title}](${link(attempt.href)}) · ${attempt.status}\n   ${attempt.createdAt}${attempt.failure ? ` · ${attempt.failure}` : ''}\n   ${tx('源码摘要', 'Source digest')}: ${attempt.sourceDigest}`),
    `## ${tx('证明路线', 'Proof routes')}`,
    ...brief.routes.map(route => `${route.id}: ${route.prerequisites.join(' + ') || '∅'} → ${route.closingTaskId} → ${route.targetTaskId}`),
    ...brief.tasks.map((task, index) => [
      `### ${index + 1}. ${task.title}`, `${task.kind} · ${task.status} · ${task.proofStatus}`,
      `[${tx('打开这一步', 'Open this step')}](${link(task.href)})`,
      task.objective, task.statement ?? '',
      `${tx('依赖', 'Dependencies')}: ${task.dependsOn.join(', ') || '∅'}`,
      task.premises.length ? `${tx('前提', 'Premises')}: ${task.premises.join('; ')}` : '',
      task.derivation ? `${tx('推导', 'Derivation')}:\n\n${task.derivation}` : '',
      task.finding ? `${tx('研究结论', 'Finding')}:\n\n${task.finding}` : '',
      task.feedback ? `${tx('反馈', 'Feedback')}:\n\n${task.feedback}` : '',
      `${tx('任务版本', 'Task version')}: ${task.version}`,
      task.commit ? `${tx('提交', 'Commit')}: ${task.commit}` : '',
      ...task.checks.map(check => `${tx('任务检查', 'Task check')}: ${check.id} · ${check.passed ? tx('通过', 'Passed') : tx('未通过', 'Failed')}`),
    ].filter(Boolean).join('\n\n')),
    `## ${tx('人工决定与处理', 'Human decisions and responses')}`,
    ...brief.decisions.map(item => [item.kind === 'plan-edit' ? tx('计划修改', 'Plan edit') : item.kind === 'plan-approval' ? tx('批准研究计划', 'Plan approval') : item.text, `${tx('投递', 'Delivery')}: ${item.delivery} · ${tx('决定', 'Decision')}: ${item.decision}`,
      item.reason ?? '', item.execution ? `${tx('执行', 'Execution')}: ${item.execution}` : '',
      item.evidenceRefs.length ? `${tx('依据', 'Evidence')}: ${item.evidenceRefs.join(', ')}` : ''].filter(Boolean).join('\n\n')),
    brief.decisions.length ? '' : tx('本次研究没有保存人工决定。', 'No human decision was recorded for this run.'),
    `## ${tx('验收与检查', 'Acceptance and checks')}`,
    `${brief.formalization ? tx('Lean 陈述验收', 'Lean statement acceptance') : tx('完整原题验收', 'Full problem acceptance')}: ${brief.acceptance.status}`,
    tx('以下是保存的任务检查，不替代完整原题的独立验收。', 'The task checks below do not replace independent acceptance of the full problem.'),
    ...brief.acceptance.checks.map(check => `${check.taskId} @ ${check.version}: ${check.passed ? tx('通过', 'Passed') : tx('未通过', 'Failed')} · ${check.id}`),
    `## ${tx('用量', 'Usage')}`, `${tx('已记录 Token', 'Recorded tokens')}: ${brief.usage.knownTokens}`,
    `${tx('用量缺失的记录', 'Records without usage')}: ${brief.usage.missingEntries}`,
    ...brief.usage.entries.map(entry => `${entry.stage} · ${entry.model}: ${entry.tokens ?? tx('未记录', 'Not recorded')}${entry.estimate ? ` · ≈ ${entry.estimate.currency} ${entry.estimate.amount.toFixed(4)}` : ''}`),
    `## ${tx('成果链接', 'Outcomes')}`,
    ...brief.outcomes.map(outcome => `[${outcome.title}](${link(outcome.href)})\n\n${code(outcome.detail)}`),
  ];
  return paragraphs.filter(Boolean).join('\n\n') + '\n';
}

export function downloadResearchFile(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type })), anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
