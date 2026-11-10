import type { ResearchLibraryDiscovery } from '../researchLibraryDiscoveryTypes';
import { Rich, RichProse } from './richText';
import { discoverySuggestedTerms } from './researchLibraryDiscoveryModel';
import { Panel, tx } from './researchShared';

export function LibraryDiscoveryContext({ target, query, chooseQuery }: { target: ResearchLibraryDiscovery; query: string; chooseQuery(value: string): void }) {
  const selected = query.trim().split(/\s+/u).filter(Boolean);
  const toggle = (term: string) => chooseQuery(selected.includes(term) ? selected.filter(item => item !== term).join(' ') : [...selected, term].join(' '));
  return <div class="research-library-discovery" data-library-discovery>
    <Panel title={tx('为这个步骤寻找引理', 'Find a lemma for this step')} actions={<a class="button" data-return-library-target href={target.returnHref}>{tx('回到这个步骤', 'Back to this step')}</a>}>
      <p class="research-item-meta"><Rich text={target.runTitle} /> · {target.environment === 'standard' ? 'Lean standard' : 'Mathlib'}</p>
      <h3><Rich text={target.title} /></h3><RichProse text={target.statement} />
      {target.objective !== target.statement && target.objective !== target.title && <RichProse text={target.objective} />}
      {!!target.premises.length && <><h4>{tx('这一步已有的前提', 'Premises recorded for this step')}</h4><ul>{target.premises.map((premise, index) => <li key={index}><RichProse text={premise} /></li>)}</ul></>}
      <details><summary>{tx('来源与固定版本', 'Source and fixed version')}</summary><dl class="research-facts">
        <div><dt>{tx('任务版本', 'Task version')}</dt><dd><code>{target.ref.taskVersion}</code></dd></div>
        <div><dt>{tx('源码提交', 'Source commit')}</dt><dd><code>{target.ref.commit}</code></dd></div>
        <div><dt>{tx('源码文件', 'Source file')}</dt><dd>{target.ref.file}</dd></div></dl></details>
      {!target.current && <p class="research-status" data-discovery-historical>{tx('正在参考此前保存的步骤。试用时需要重新核对当前任务版本。', 'You are reading a previously saved step. Recheck the current task version before a trial.')}</p>}
      <div class="research-library-keywords"><span>{tx('从目标提取的检索词', 'Search terms from the goal')}</span><div role="group" aria-label={tx('调整检索词', 'Adjust search terms')}>
        {discoverySuggestedTerms(target).map(term => <button class="button" type="button" key={term} aria-pressed={selected.includes(term)} onClick={() => toggle(term)}>{term}</button>)}</div></div>
      <p class="research-field-note">{tx('按目标词与声明的文字重合排序，默认只看同一证明环境。是否适用仍需核对参数、前提并检查候选。', 'Results are ordered by shared terms in the goal and declarations, initially within the same proof environment. Review arguments and premises, then check a candidate to establish applicability.')}</p>
    </Panel>
  </div>;
}
