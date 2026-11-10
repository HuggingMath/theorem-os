import type { ResearchBudgetView } from '../researchBudgetTypes';
import { api, MutationState, tx, useMutation } from './researchShared';

export function ResearchBudgetContinuity({ value, endpoint, onResolved, request }: { value: ResearchBudgetView; endpoint: string; onResolved(): void; request?: typeof api }) {
  const action = useMutation(request), continuity = value.continuity;
  if (!continuity) return null;
  if (continuity.status === 'inherited') return <p class="research-status" data-budget-inherited>{tx('已接续你在个人研究中设置的预算。', 'Your budget from personal research continues here.')}</p>;
  const inherit = (sourceKey: string | null, sourceRevision: number | null) => {
    const target = endpoint.replace('/budget', '/budget/inherit');
    void action.run('POST', target, { expectedRevision: value.plan.revision, sourceKey, sourceRevision, sourcesDigest: continuity.digest }, onResolved);
  };
  return <section class="research-trial-review" data-budget-continuity><h4>{tx('选择这个项目接续的个人预算', 'Choose the personal budget to continue in this project')}</h4>
    <p>{tx('关联的研究使用过不同预算。核对后选择一份，原预算和各项用量记录都会保留。', 'The linked research had different budgets. Review and choose one. Original budgets and usage records are preserved.')}</p>
    {continuity.sources.map(source => <article class="research-event" key={source.key}><strong>{source.title}</strong><p>
      {source.plan.tokenLimit === null ? tx('未设 Token 预算', 'No token budget') : `${source.plan.tokenLimit} Token`} · {source.plan.currency} {source.plan.amountLimit ?? tx('未设金额预算', 'No cost budget')}</p>
      <button class="button" type="button" data-inherit-budget={source.key} disabled={action.busy} onClick={() => inherit(source.key, source.plan.revision)}>{tx('接续这份预算', 'Continue with this budget')}</button></article>)}
    <button class="text-button" type="button" data-new-project-budget disabled={action.busy} onClick={() => inherit(null, null)}>{tx('另设这个项目的预算', 'Set a separate budget for this project')}</button>
    <MutationState action={action} />
  </section>;
}
