import type { WebRun } from './shared';
import { isStatementReviewed, stopCause, type StopCause } from './presentation';

/** Runs that end on their own get a mail; a run the user stopped or a restart interrupted does not. */
export const mailsCompletion = (run: WebRun) => isStatementReviewed(run) &&
  (run.status === 'completed' || (run.status === 'error' && run.phase !== 'interrupted'));

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
const meaningConfirmations = {
  manual: { zh: '原题含义：你已确认 Lean 陈述。', en: 'Problem meaning: you confirmed the Lean statement.' },
  automatic: { zh: '原题含义：模型审核通过，未经人工确认。', en: 'Problem meaning: model review passed; not confirmed by a person.' },
  pending: { zh: '原题含义：仍在后台审核，候选 Lean 陈述的证明尚不能代表原题已解决。',
    en: 'Problem meaning: review is still running; proving the candidate Lean statement does not yet establish that the original problem is solved.' },
  rejected: { zh: '原题含义：审核要求修改候选陈述，这份证明对应修改前的陈述。',
    en: 'Problem meaning: review requested statement changes; this proof is for the earlier candidate.' },
  interrupted: { zh: '原题含义：审核已中断，尚未确认候选陈述与原题一致。',
    en: 'Problem meaning: review was interrupted; correspondence with the original problem is unconfirmed.' },
  superseded: { zh: '原题含义：候选陈述已更新，这份证明保留的是旧版本。',
    en: 'Problem meaning: the candidate statement has changed; this proof is for the previous version.' },
} satisfies Record<NonNullable<NonNullable<WebRun['formalization']>['confirmation']>, { zh: string; en: string }>;
const outcome = (run: WebRun): Outcome => {
  if (run.status === 'completed' && run.result?.status === 'evaluated_passed')
    return run.formalization
      ? { zh: 'Lean 陈述已通过验收', en: 'has an accepted Lean statement', detailZh: '冻结的 Lean 陈述通过独立 Lean 验收。',
        detailEn: 'The frozen Lean statement passed independent Lean verification.' }
      : { zh: '已通过验收', en: 'accepted', detailZh: '完整原题通过独立 Lean 验收。', detailEn: 'The full statement passed independent Lean verification.' };
  if (run.status === 'error')
    return { zh: '运行出错', en: 'stopped with an error', detailZh: '运行环境或模型会话发生错误，详情见运行页面。', detailEn: 'The run environment or model session failed; see the run page.' };
  if (run.result?.status === 'evaluated_failed')
    return { zh: run.formalization ? 'Lean 陈述未通过验收' : '未通过验收', en: 'not accepted', detailZh: '候选证明未通过独立 Lean 验收。', detailEn: 'The candidate proof did not pass independent Lean verification.' };
  if (run.result?.status === 'evaluated_rejected')
    return { zh: run.formalization ? 'Lean 陈述未通过验收' : '未通过验收', en: 'not accepted', detailZh: '候选未满足验收约束，详情见报告。', detailEn: 'The candidate did not meet the verification constraints; see the report.' };
  const cause = stopCause(run);
  // Planning or a revision can exhaust execution time before approval; historical runs may include old wait timing.
  if (cause === 'time' && run.observation?.inspection.planApproval?.status === 'pending')
    return { ...stopped.time, detailZh: '这次运行在计划批准前结束，已保存的计划与研究材料仍可查看。',
      detailEn: 'This run ended before its plan was approved. The saved plan and research materials remain available.' };
  if (cause) return { ...stopped[cause], ...stoppedReasons[run.failure?.reason ?? ''] };
  return { zh: '已结束', en: 'finished', detailZh: run.formalization ? '本次研究尚未得到通过 Lean 陈述验收的证明。' : '本次研究尚未得到通过完整原题验收的证明。',
    detailEn: 'This run did not produce a proof that passed verification.' };
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
  const meaning = run.formalization && (run.formalization.confirmation !== 'manual' && run.formalization.reviewMode === 'direct' ? {
    zh: 'Lean 陈述编译通过；原题含义及审核结论请查看形式化记录。',
    en: 'The Lean statement compiled; see the formalization record for its meaning and review results.',
  } : run.formalization.confirmation ? meaningConfirmations[run.formalization.confirmation] : {
    zh: '原题含义：未记录确认方式，请核对 Lean 陈述。',
    en: 'Problem meaning: the confirmation method was not recorded; please check the Lean statement.',
  });
  const title = run.title.replace(/\s+/gu, ' ').trim().slice(0, 80) || 'TheoremOS';
  const link = new URL(`/?run=${encodeURIComponent(run.id)}`, publicUrl).href;
  return {
    subject: `TheoremOS · ${result.zh}：${title}`,
    text: [
      `你的研究「${title}」${run.formalization ? '：' : ''}${result.zh}。`, result.detailZh,
      ...(meaning ? [meaning.zh, 'Lean 验收不能替代对自然语言原意的核对。'] : []),
      ...(took ? [`用时约 ${took} 分钟。`] : []), '', `查看结果：${link}`, '',
      `Your research "${title}" ${result.en}. ${result.detailEn}`
        + (meaning ? ` ${meaning.en} Lean verification does not replace checking the original natural-language meaning.` : '')
        + (took ? ` It took about ${took} min.` : ''), `View the result: ${link}`, '',
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
      `你的研究「${title}」的研究计划已经拟好。等待确认不计入证明预算；返回工作台批准后，继续本次研究。`, '', `查看并批准：${link}`, '',
      `The research plan for "${title}" is ready. Waiting for approval pauses the proof budget. Return to approve it and continue this run.`,
      `Review and approve: ${link}`, '',
      '不想收到这类邮件，可以在工作台的账号菜单里关闭「研究结束时发邮件」。',
      'To stop these emails, turn off "Email me when research ends" in the account menu.',
    ].join('\n'),
  };
}
