import type { ArchiveIndex, ArchiveIndexRecord } from '../../../docs/web/types';
import { useEffect } from 'preact/hooks';
import { classicLibraryUrl } from './classicLibrary';
import { LeanName, RichProse } from './richText';
import { Empty, ErrorBox, stamp, tx, useResource } from './researchShared';

export type ProblemSort = 'newest' | 'title';

function archiveHref(id: string, tab: 'reading' | 'source' | 'evidence', returnHref: string) {
  const parameters = new URLSearchParams({ proof: id, tab, status: 'verified' });
  const directory = new URL(returnHref, location.href);
  directory.hash = `problem-${id}`;
  parameters.set('return', `${directory.pathname}${directory.search}${directory.hash}`);
  return `${classicLibraryUrl.split('#')[0]}#${parameters}`;
}

export function OpenAIProblems({ query, area, sort, returnHref, onArea, onReset }: {
  query: string; area: string; sort: ProblemSort; returnHref: string; onArea: (value: string) => void; onReset: () => void;
}) {
  const result = useResource<ArchiveIndex>('/classics/data/index.json'), index = result.data;
  useEffect(() => {
    if (!index || !location.hash.startsWith('#problem-')) return;
    const selected = document.getElementById(location.hash.slice(1));
    if (!selected?.hasAttribute('data-openai-problem')) return;
    const frame = requestAnimationFrame(() => { selected.focus({ preventScroll: true }); selected.scrollIntoView({ block: 'center' }); });
    return () => cancelAnimationFrame(frame);
  }, [index]);
  const records = index?.records.filter(record => record.campaign && record.status === 'locally_verified')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)) ?? [];
  const tokens = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean), selectedArea = area.trim().toLocaleLowerCase();
  const matches = records.filter(record => {
    const text = [record.title, record.subtitle, record.en?.subtitle, record.summary, record.en?.summary, record.id, record.area, record.en?.area,
      record.campaign?.target, ...(record.campaign?.targets ?? [])].filter(Boolean).join(' ').toLocaleLowerCase();
    return tokens.every(token => text.includes(token));
  });
  const shown = matches.filter(record => !selectedArea || `${record.area} ${record.en?.area ?? ''}`.toLocaleLowerCase().includes(selectedArea));
  if (sort === 'title') shown.sort((a, b) => tx(a.subtitle || a.title, a.en?.subtitle || a.title)
    .localeCompare(tx(b.subtitle || b.title, b.en?.subtitle || b.title), tx('zh-CN', 'en')) || a.id.localeCompare(b.id));
  const fields = [...new Map(records.map(record => [record.area, { value: record.area, label: tx(record.area, record.en?.area ?? record.area),
    count: matches.filter(candidate => `${candidate.area} ${candidate.en?.area ?? ''}`.toLocaleLowerCase().includes(record.area.toLocaleLowerCase())).length }])).values()]
    .sort((a, b) => a.label.localeCompare(b.label));
  return <section class="research-openai-directory" data-openai-problems-directory aria-label={tx('已解决的 OpenAI 题目', 'Solved OpenAI problems')}>
    <ErrorBox message={result.error} />{result.error && <button class="button" type="button" onClick={result.refresh}>{tx('重新读取题目', 'Reload problems')}</button>}
    {result.loading && <p class="research-status" role="status">{tx('正在读取已解决题目…', 'Loading solved problems…')}</p>}
    {index && <><div class="research-problem-browser">
      <aside class="research-problem-fields"><h3>{tx('数学领域', 'Fields of mathematics')}</h3>
        <label class="research-mobile-field-picker"><span>{tx('数学领域', 'Fields of mathematics')}</span><select data-problem-field-select value={area} onChange={event => onArea(event.currentTarget.value)}>
          <option value="">{tx('全部领域', 'All fields')} · {matches.length}</option>
          {area && !fields.some(field => field.value === area) && <option value={area}>{area} · {shown.length}</option>}
          {fields.map(field => <option key={field.value} value={field.value} disabled={!field.count && area !== field.value}>{field.label} · {field.count}</option>)}
        </select></label>
        <div class="research-openai-areas" role="group" aria-label={tx('OpenAI 题目领域', 'OpenAI problem fields')}>
          <button type="button" aria-label={tx('全部领域', 'All fields')} aria-pressed={!area} onClick={() => onArea('')}><span>{tx('全部领域', 'All fields')}</span><small>{matches.length}</small></button>
          {fields.map(field => <button key={field.value} type="button" aria-label={field.label} aria-pressed={area === field.value} disabled={!field.count && area !== field.value} onClick={() => onArea(field.value)}><span>{field.label}</span><small>{field.count}</small></button>)}
        </div>
      </aside>
      <div class="research-problem-results"><div class="research-openai-summary">
        <p class="research-status" role="status"><strong>{shown.length}</strong> {tx('道题目', 'problems')}{query || area ? ` · ${tx(`共 ${records.length} 道`, `of ${records.length}`)}` : ` · ${tx('全部已通过本地验收', 'All locally verified')}`}</p>
        {(query || area) && <button class="text-button" type="button" data-problem-reset onClick={onReset}>{tx('清除筛选', 'Clear filters')}</button>}
      </div>
        <div class="research-openai-list">{shown.map((record, index) => <Problem key={record.id} record={record} number={index + 1} returnHref={returnHref} />)}</div>
        {!shown.length && <Empty>{records.length ? tx('没有匹配的题目，请调整关键词或领域。', 'No matching problems. Try another keyword or field.')
          : tx('当前快照尚无本地验收通过的 OpenAI 题目。', 'This snapshot contains no locally verified OpenAI problems.')}</Empty>}
        <p class="research-problem-snapshot">{tx('题库更新于 ', 'Archive updated ')}<time data-openai-problems-snapshot dateTime={index.snapshotAt}>{stamp(index.snapshotAt)}</time></p>
      </div>
    </div>
    </>}
  </section>;
}

function Problem({ record, number, returnHref }: { record: ArchiveIndexRecord; number: number; returnHref: string }) {
  const title = tx(record.subtitle || record.title, record.en?.subtitle || record.title), alternateTitle = tx(record.title, record.subtitle);
  const targets = record.campaign?.targets ?? [];
  const statement = record.sources.find(source => source.name === 'Challenge.lean');
  return <article class="research-directory-card research-openai-card" id={`problem-${record.id}`} tabIndex={-1} data-openai-problem={record.id} data-openai-problem-status={record.status}>
    <span class="research-problem-number" aria-hidden="true">{String(number).padStart(2, '0')}</span>
    <div class="research-problem-content"><div class="research-item-meta"><span>{tx(record.area, record.en?.area ?? record.area)}</span><span class="research-state" data-state="accepted">{tx('本地验收通过', 'Locally verified')}</span></div>
      <h3 class="research-card-heading"><a href={archiveHref(record.id, 'reading', returnHref)}>{title}</a></h3>
      {alternateTitle !== title && <p class="research-openai-alternate-title" lang={tx('en', 'zh')}>{alternateTitle}</p>}
      <div class="research-card-description"><RichProse text={tx(record.summary, record.en?.summary ?? record.summary)} /></div>
      <time class="research-problem-date" data-openai-problem-updated dateTime={record.updatedAt}>{stamp(record.updatedAt)}</time>
      {record.readingMode && <span class="research-solution-kind" data-openai-problem-reading-mode={record.readingMode}>{record.readingMode === 'derivation'
        ? tx('逐步数学讲解', 'Step-by-step explanation') : tx('Lean 源码阅读', 'Lean source reading')}</span>}
    </div>
    <div class="research-problem-actions"><a class="research-solution-read" data-openai-problem-link="reading" href={archiveHref(record.id, 'reading', returnHref)}>{tx('阅读解答', 'Read solution')} <span aria-hidden="true">↗</span></a>
      <div><a data-openai-problem-link="source" href={archiveHref(record.id, 'source', returnHref)}>{tx('Lean 证明', 'Lean proof')}</a>
        <a data-openai-problem-link="evidence" href={archiveHref(record.id, 'evidence', returnHref)}>{tx('验收记录', 'Acceptance')}</a></div></div>
    <details class="research-problem-overview" data-openai-problem-overview>
      <summary>{tx('题目概览', 'Problem overview')}{targets.length > 0 && <span>{tx(`${targets.length} 个证明目标`, `${targets.length} proof targets`)}</span>}</summary>
      <div class="research-problem-overview-body"><h4>{tx('问题与结论', 'Problem and result')}</h4>
        <RichProse text={tx(record.summary, record.en?.summary ?? record.summary)} />
        {targets.length > 0 && <><h4>{tx('形式化证明目标', 'Formal proof targets')}</h4><ul>{targets.map(target => <li key={target}><code data-openai-problem-target={target}><LeanName name={target} /></code></li>)}</ul></>}
        {statement && <a data-openai-problem-statement href={`/classics/${statement.url}`} target="_blank" rel="noreferrer">{tx('打开 Lean 原题', 'Open Lean statement')} <span aria-hidden="true">↗</span><span class="sr-only">{tx('（新标签页）', ' (new tab)')}</span></a>}
      </div>
    </details>
  </article>;
}
