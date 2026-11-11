import { useEffect, useState } from 'preact/hooks';
import type { ResearchBudgetView } from '../researchBudgetTypes';
import type { ResearchProblem } from '../researchProblemTypes';
import { formatTokens } from '../presentation';
import { base, enc, ErrorBox, MutationState, Panel, tx, useMutation, useResource, type Item } from './researchShared';
import { ResearchBudgetContinuity } from './researchBudgetContinuity';
import { budgetEditorState, completeBudgetSave, readBudgetIntoEditor } from './researchBudgetEditor';

export function ResearchBudgetFacts({ value }: { value: ResearchBudgetView }) {
  const { plan, forecast } = value;
  const unresolved = value.continuity?.status === 'conflict';
  const otherCurrencies = (['CNY', 'USD'] as const).filter(currency => currency !== plan.currency && value.spent[currency] > 0);
  const spentCurrencies = [plan.currency, ...otherCurrencies];
  return <div data-problem-budget-facts>
    <dl class="problem-budget-facts"><div><dt>{tx('整道题已记录用量', 'Recorded usage across this problem')}</dt><dd>{formatTokens(value.knownTokens)} Token</dd></div>
      <div><dt>{tx('按单价估算已投入', 'Estimated spend at your rates')}</dt><dd class="problem-budget-spent">{spentCurrencies.map(currency => <span key={currency} data-budget-spent={currency}>{currency} {value.spent[currency].toFixed(4)}</span>)}</dd></div>
      <div><dt>{tx('按已记录用量剩余', 'Remaining against recorded usage')}</dt><dd>{unresolved ? tx('待选择项目预算', 'Choose a project budget first') : value.remainingTokens === null ? tx('未设 Token 预算', 'No token budget') : `${formatTokens(value.remainingTokens)} Token`}</dd></div>
      <div><dt>{tx('按已计价记录剩余', 'Remaining against priced records')}</dt><dd>{unresolved ? tx('待选择项目预算', 'Choose a project budget first') : value.remainingAmount === null ? tx('未设金额预算', 'No cost budget') : `${plan.currency} ${value.remainingAmount.toFixed(4)}`}</dd></div></dl>
    {otherCurrencies.length > 0 && value.remainingAmount !== null && <p class="research-status" data-budget-currency-scope>{tx(`预算余额只扣除 ${plan.currency} 支出，其他币种单独列示。`, `The budget balance deducts ${plan.currency} spending only. Other currencies are listed separately.`)}</p>}
    {(value.missingUsage > 0 || value.unpricedEntries > 0) && <p class="research-status">{tx(`有 ${value.missingUsage} 条记录缺少用量，${value.unpricedEntries} 条未计价；余额仅依据已记录部分。`,
      `${value.missingUsage} records lack usage and ${value.unpricedEntries} are unpriced. Remaining amounts use the recorded portion only.`)}</p>}
    {forecast.tokens > 0 && <p data-budget-forecast>{tx('本次 Token 上限对应的估算', 'Estimate at this attempt’s token limit')}: {formatTokens(forecast.tokens)} Token
      {forecast.amount === null ? ` · ${tx('请先填写所选模型单价', 'Set a rate for the selected model first')}` : ` · ≈ ${forecast.currency} ${forecast.amount.toFixed(4)}`} · {forecast.model}</p>}
    {forecast.currency && forecast.currency !== plan.currency && <p class="research-status">{tx('模型单价与题目预算的币种不同，金额分别显示。', 'The model rate and problem budget use different currencies. Amounts are shown separately.')}</p>}
    {(forecast.overTokens || forecast.overAmount || value.remainingTokens !== null && value.remainingTokens < 0 || value.remainingAmount !== null && value.remainingAmount < 0)
      && <p class="research-status" role="status" data-budget-exceeded>{tx('本次规划已超出题目预算，请调整预算或本次上限后再决定是否开始。', 'This plan exceeds the problem budget. Adjust the budget or this attempt’s limits before deciding whether to start.')}</p>}
  </div>;
}

export function ResearchProblemBudget({ problem }: { problem: Pick<ResearchProblem, 'brief' | 'project'> }) {
  const runId = problem.brief.selectedRunId, projectId = problem.project?.id;
  const endpoint = `${base}/workspace/problem/${enc(runId)}/budget${projectId ? `?project=${enc(projectId)}` : ''}`;
  const [next, setNext] = useState('100000'), tokens = Number(next), valid = Number.isSafeInteger(tokens) && tokens >= 10_000 && tokens <= 1e12;
  const data = useResource<Item<ResearchBudgetView>>(`${endpoint}${projectId ? '&' : '?'}tokens=${valid ? tokens : 0}`, 15_000), value = data.data?.item;
  const [editor, setEditor] = useState(budgetEditorState), action = useMutation();
  const { tokenLimit, amount, currency, editing, expectedRevision: expected } = editor;
  useEffect(() => { if (value) setEditor(current => readBudgetIntoEditor(current, value.plan)); }, [value?.plan.revision, editing]);
  const ready = (tokenLimit === '' || Number.isSafeInteger(Number(tokenLimit)) && Number(tokenLimit) >= 0)
    && (amount === '' || Number.isFinite(Number(amount)) && Number(amount) >= 0);
  return <Panel title={tx('整道题的预算', 'Budget for the whole problem')}>
    <ErrorBox message={data.error} />{data.error && <button class="button" type="button" onClick={data.refresh}>{tx('重新读取', 'Try again')}</button>}
    {value && <><ResearchBudgetFacts value={value} /><ResearchBudgetContinuity value={value} endpoint={endpoint} onResolved={data.refresh} /><details data-budget-editor hidden={value.continuity?.status === 'conflict'}><summary>{tx('设置题目预算', 'Set a problem budget')}</summary>
      <form class="research-form" onSubmit={event => { event.preventDefault(); if (!ready || action.busy || expected !== value.plan.revision) return;
        const submitted = editor;
        void action.run<Item<ResearchBudgetView>>('PUT', endpoint,
          { expectedRevision: expected, tokenLimit: tokenLimit === '' ? null : Number(tokenLimit), amountLimit: amount === '' ? null : Number(amount), currency }).then(result => {
          if (result) setEditor(current => completeBudgetSave(current, submitted, result.item.plan));
          data.refresh();
        }); }}>
        <div class="research-form-row"><label>{tx('整题 Token 预算（可留空）', 'Problem token budget (optional)')}<input type="number" data-budget-token-limit value={tokenLimit} min="0" max="1000000000000" step="1" onInput={event => { const tokenLimit = event.currentTarget.value; setEditor(current => ({ ...current, editing: true, tokenLimit })); }} /></label>
          <label>{tx('整题金额预算（可留空）', 'Problem cost budget (optional)')}<input type="number" data-budget-amount value={amount} min="0" max="1000000000" step="any" onInput={event => { const amount = event.currentTarget.value; setEditor(current => ({ ...current, editing: true, amount })); }} /></label>
          <label>{tx('币种', 'Currency')}<select value={currency} onChange={event => { const currency = event.currentTarget.value as 'CNY' | 'USD'; setEditor(current => ({ ...current, editing: true, currency })); }}><option>CNY</option><option>USD</option></select></label></div>
        {editing && !action.busy && <p role="status" data-budget-unsaved>{tx('当前预算修改尚未保存。', 'Your budget edits have not been saved yet.')}</p>}
        {editing && expected < value.plan.revision && <div role="status" data-budget-revision-conflict><p>{tx('预算已在其他设备更新，输入已保留。', 'The budget changed on another device. Your inputs are preserved.')}</p>
          <p data-budget-latest-plan>{tx('最新已保存预算', 'Latest saved budget')}: {value.plan.tokenLimit === null ? tx('未设 Token 预算', 'No token budget') : `${formatTokens(value.plan.tokenLimit)} Token`} · {value.plan.amountLimit === null ? tx('未设金额预算', 'No cost budget') : `${value.plan.currency} ${value.plan.amountLimit}`}</p>
          <button class="text-button" type="button" data-review-budget-revision disabled={action.busy} onClick={() => { action.reset(); setEditor(current => ({ ...current, expectedRevision: value.plan.revision })); }}>{tx('核对后使用最新版本', 'Use the latest version after review')}</button></div>}
        <button class="button" type="submit" data-save-problem-budget disabled={!ready || action.busy || expected !== value.plan.revision}>{tx('保存题目预算', 'Save problem budget')}</button><MutationState action={{ ...action, message: editing ? '' : action.message }} />
      </form></details>
      <form class="research-form" onSubmit={event => { event.preventDefault(); }}><label>{tx('规划下一次尝试的 Token 上限', 'Plan the next attempt’s token limit')}<input type="number" data-budget-next-tokens value={next} min="10000" step="1" max="1000000000000" onInput={event => setNext(event.currentTarget.value)} /></label>
        <div class="research-actions">{valid && <a class="button" data-prepare-budget-attempt href={`./?${new URLSearchParams({ budgetRun: runId, budgetTokens: String(tokens), ...(projectId ? { project: projectId } : {}) })}`}>{tx('按此预算准备新尝试', 'Prepare a new attempt with this budget')}</a>}
          <a href={`workspace.html?tab=usage&run=${enc(runId)}`}>{tx('查看账本与模型单价', 'View usage and model rates')}</a></div>
      </form><p class="research-field-note">{tx('这是个人研究规划。估算采用所填单价；实际费用以服务商账单为准，执行仍使用本次运行的时间和 Token 上限。',
        'This is your personal research plan. Estimates use your rates; the provider’s bill is authoritative. Execution uses this run’s time and token limits.')}</p>
    </>}
  </Panel>;
}
