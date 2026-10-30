import type { WebRun } from './shared';
import { stopCause, type StopCause } from './presentation';

/** Runs that end on their own get a mail; a run the user stopped or a restart interrupted does not. */
export const mailsCompletion = (run: WebRun) => run.status === 'completed' || (run.status === 'error' && run.phase !== 'interrupted');

type Outcome = { zh: string; en: string; detailZh: string; detailEn: string };
// A run that stopped on a limit says which one, as its badge in the workbench does.
const stopped: Record<StopCause, Outcome> = {
  preparation: { zh: '证明环境准备超时', en: 'timed out preparing its proof environment',
    detailZh: '证明环境没有在准备时限内就绪，解题没有开始。准备时限和解题预算无关，可以直接重新运行。',
    detailEn: 'The proof environment was not ready within its preparation limit, so solving never started. That limit is separate from the solve budget; you can simply run again.' },
  time: { zh: '解题时间用完', en: 'used up its solve time', detailZh: '在解题预算内没有得到通过验收的完整证明，已检查的成果保存在报告中。',
    detailEn: 'No accepted full proof within the solve budget; the checked results are saved in the report.' },
  budget: { zh: '用量到达上限', en: 'reached its usage limit', detailZh: '模型用量到达上限，后续调用已停止；已检查的成果保存在报告中。',
    detailEn: 'Model usage reached the limit and further calls stopped; the checked results are saved in the report.' },
  turns: { zh: '研究轮次用完', en: 'used up its turns', detailZh: 'Agent 用完了全部研究轮次，还没有得到完整证明；已检查的成果保存在报告中。',
    detailEn: 'The Agents used all their turns without a full proof; the checked results are saved in the report.' },
  routes: { zh: '研究路线用尽', en: 'ran out of research routes', detailZh: '计划中的研究路线都已停滞或用尽，还没有得到完整证明；已检查的成果保存在报告中。',
    detailEn: 'Every planned research route stalled or ran out before a full proof; the checked results are saved in the report.' },
};
// One stop has a more exact cause than its limit, as the result page's failure guide also says.
const stoppedReasons: Record<string, Pick<Outcome, 'detailZh' | 'detailEn'>> = {
  math_model_usage_unavailable: { detailZh: '服务商没有返回完整的用量回执，为避免超出用量上限，后续调用已停止。已检查的成果保存在报告中。',
    detailEn: 'The provider did not return a complete usage receipt, so further calls stopped to avoid exceeding the usage cap. Checked results are saved in the report.' },
};
const outcome = (run: WebRun): Outcome => {
  if (run.status === 'completed' && run.result?.status === 'evaluated_passed')
    return { zh: '已通过验收', en: 'accepted', detailZh: '完整原题通过独立 Lean 验收。', detailEn: 'The full statement passed independent Lean verification.' };
  if (run.status === 'error')
    return { zh: '运行出错', en: 'stopped with an error', detailZh: '运行环境或模型会话发生错误，详情见运行页面。', detailEn: 'The run environment or model session failed; see the run page.' };
  if (run.result?.status === 'evaluated_failed')
    return { zh: '未通过验收', en: 'not accepted', detailZh: '候选证明未通过独立 Lean 验收。', detailEn: 'The candidate proof did not pass independent Lean verification.' };
  if (run.result?.status === 'evaluated_rejected')
    return { zh: '未通过验收', en: 'not accepted', detailZh: '候选未满足验收约束，详情见报告。', detailEn: 'The candidate did not meet the verification constraints; see the report.' };
  const cause = stopCause(run);
  // The owner was mailed when the plan was ready; a budget that ran out on that wait is theirs to know about.
  if (cause === 'time' && run.observation?.inspection.planApproval?.status === 'pending')
    return { ...stopped.time, detailZh: '研究计划直到解题时间用完都没有批准，Agent 没有开始工作。',
      detailEn: 'The research plan was not approved before the solve time ran out, so the Agents never started.' };
  if (cause) return { ...stopped[cause], ...stoppedReasons[run.failure?.reason ?? ''] };
  return { zh: '已结束', en: 'finished', detailZh: '本次研究尚未得到通过完整原题验收的证明。', detailEn: 'This run did not produce a proof that passed verification.' };
};

const minutes = (run: WebRun) => {
  const span = Date.parse(run.finishedAt ?? run.updatedAt) - Date.parse(run.createdAt);
  return Number.isFinite(span) && span >= 0 ? Math.max(1, Math.round(span / 60_000)) : undefined;
};

/**
 * The mail sent to the account when a run ends: the run title, the outcome and a link back to the run.
 * It carries no source, proof, report or key; those stay behind the login.
 */
export function completionMail(run: WebRun, publicUrl: string): { subject: string; text: string } {
  const result = outcome(run), took = minutes(run);
  const title = run.title.replace(/\s+/gu, ' ').trim().slice(0, 80) || 'TheoremOS';
  const link = new URL(`/?run=${encodeURIComponent(run.id)}`, publicUrl).href;
  return {
    subject: `TheoremOS · ${result.zh}：${title}`,
    text: [
      `你的研究「${title}」${result.zh}。`, result.detailZh, ...(took ? [`用时约 ${took} 分钟。`] : []), '', `查看结果：${link}`, '',
      `Your research "${title}" ${result.en}. ${result.detailEn}${took ? ` It took about ${took} min.` : ''}`, `View the result: ${link}`, '',
      '不想收到这类邮件，可以在工作台的账号菜单里关闭「研究结束时发邮件」。',
      'To stop these emails, turn off "Email me when research ends" in the account menu.',
    ].join('\n'),
  };
}

/**
 * The one mail of a run started with 先审计划: its plan is ready and nothing runs until the owner approves it.
 * Like the completion mail it names only the run; the plan itself stays behind the login.
 */
export function planApprovalMail(run: WebRun, publicUrl: string): { subject: string; text: string } {
  const title = run.title.replace(/\s+/gu, ' ').trim().slice(0, 80) || 'TheoremOS';
  const link = new URL(`/?run=${encodeURIComponent(run.id)}`, publicUrl).href;
  return {
    subject: `TheoremOS · 研究计划等你批准：${title}`,
    text: [
      `你的研究「${title}」的研究计划已经拟好。批准之前 Agent 不会开始工作，等待的时间也计入解题预算。`, '', `查看并批准：${link}`, '',
      `The research plan for "${title}" is ready. The Agents start only after you approve it, and the wait counts toward the solve budget.`,
      `Review and approve: ${link}`, '',
      '不想收到这类邮件，可以在工作台的账号菜单里关闭「研究结束时发邮件」。',
      'To stop these emails, turn off "Email me when research ends" in the account menu.',
    ].join('\n'),
  };
}
