import type { ResearchJourneyEvolution, ResearchObservationRef } from '../researchJourneyTypes';
import { ErrorBox, stamp, tx } from './researchShared';

export const observationKey = (value: ResearchObservationRef) => `${value.sequence}:${value.stateDigest}`;
export function ResearchEvolutionPicker({ data, error, loading, selected, choose, refresh }: {
  data?: ResearchJourneyEvolution; error?: string; loading: boolean; selected?: ResearchObservationRef;
  choose(value?: ResearchObservationRef): void; refresh(): void;
}) {
  const current = selected && data?.moments.find(item => observationKey(item) === observationKey(selected));
  return <section class="research-evolution" data-research-evolution>
    <div class="research-evolution-heading"><h3>{tx('这次尝试如何演变', 'How this attempt evolved')}</h3>
      <button type="button" class="text-button" onClick={refresh}>{tx('刷新保存记录', 'Refresh saved records')}</button></div>
    <ErrorBox message={error} />
    {loading && !data && <p role="status">{tx('正在读取计划、任务与检查的保存时点…', 'Loading saved moments of the plan, tasks and checks…')}</p>}
    {data && <><label>{tx('阅读时点', 'Reading moment')}<select data-evolution-moment value={selected ? observationKey(selected) : 'current'} onChange={event => {
      const choice = data.moments.find(item => observationKey(item) === event.currentTarget.value); choose(choice && { sequence: choice.sequence, stateDigest: choice.stateDigest });
    }}><option value="current">{tx('当前记录 · 持续更新', 'Current record · live updates')}</option>
      {data.moments.map(item => <option key={observationKey(item)} value={observationKey(item)}>{`#${item.sequence} · ${stamp(item.observedAt)} · ${item.tasks} ${tx('步骤', 'steps')}`}</option>)}</select></label>
      {!data.moments.length && <p>{tx('这次尝试还没有保存路线快照。', 'No route snapshot has been saved for this attempt yet.')}</p>}
      {current && <div data-evolution-selected={current.sequence}><p>{tx('正在阅读保存时点，路线、推导和检查来自同一份记录。完整原题的最终验收请查看当前记录。', 'The route, derivations and checks below come from this saved moment. Return to the current record for final acceptance of the complete problem.')}</p>
        <p class="research-evolution-changes">{tx(`相邻保存记录：新增 ${current.changes.added} 步，调整 ${current.changes.changed} 步，移出 ${current.changes.removed} 步；新增 ${current.changes.checks} 份检查，${current.changes.human} 项人工记录变化。`,
          `Since the preceding record: ${current.changes.added} steps added, ${current.changes.changed} changed, ${current.changes.removed} removed; ${current.changes.checks} new checks and ${current.changes.human} human record changes.`)}</p>
        <button type="button" class="button" data-evolution-live onClick={() => choose()}>{tx('回到当前记录', 'Return to the current record')}</button>
      </div>}
    </>}
  </section>;
}
