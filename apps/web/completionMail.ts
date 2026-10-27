import type { WebRun } from './shared';

/** Runs that end on their own get a mail; a run the user stopped or a restart interrupted does not. */
export const mailsCompletion = (run: WebRun) => run.status === 'completed' || (run.status === 'error' && run.phase !== 'interrupted');

const outcome = (run: WebRun): { zh: string; en: string; detailZh: string; detailEn: string } => {
  if (run.status === 'completed' && run.result?.status === 'evaluated_passed')
    return { zh: '已通过验收', en: 'accepted', detailZh: '完整原题通过独立 Lean 验收。', detailEn: 'The full statement passed independent Lean verification.' };
  if (run.status === 'error')
    return { zh: '运行出错', en: 'stopped with an error', detailZh: '运行环境或模型会话发生错误，详情见运行页面。', detailEn: 'The run environment or model session failed; see the run page.' };
  if (run.result?.status === 'evaluated_failed')
    return { zh: '未通过验收', en: 'not accepted', detailZh: '候选证明未通过独立 Lean 验收。', detailEn: 'The candidate proof did not pass independent Lean verification.' };
  if (run.result?.status === 'evaluated_rejected')
    return { zh: '未通过验收', en: 'not accepted', detailZh: '候选未满足验收约束，详情见报告。', detailEn: 'The candidate did not meet the verification constraints; see the report.' };
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
