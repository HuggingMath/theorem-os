import { useMemo, useState } from 'preact/hooks';
import { locale, t } from '../i18n';
import type { WebShareSnapshot } from '../shareTypes';
import { Rich } from './richText';
import { explanationSolutionRoute } from './explainSolutionRoute';
import { sharedSolutionRoute } from './shareSolutionRoute';
import { SolutionRouteGraph } from './ui/SolutionRouteGraph';

const tx = (zh: string, en: string) => locale === 'en' ? en : zh;
export function ShareReadingView({ share, shareId }: { share: WebShareSnapshot; shareId: string }) {
  const reading = share.reading, documents = reading?.explanations ?? [];
  const [selected, setSelected] = useState(Math.max(0, documents.findIndex(document => document.language === locale)));
  const [view, setView] = useState<'reading' | 'route'>('reading');
  const document = documents[selected];
  const model = useMemo(() => document ? explanationSolutionRoute(document, share.proof,
    `share:${shareId}:${document.language}:${document.target}`) : sharedSolutionRoute(share, locale, `share:${shareId}:recorded`), [share, document, shareId]);
  const jump = (id: string) => {
    const node = globalThis.document.getElementById(id);
    if (node) { node.scrollIntoView({ block: 'start', behavior: 'instant' }); node.focus({ preventScroll: true }); }
  };
  const openReading = (target: string) => {
    const section = /^section:(\d+)$/u.exec(target), step = /^step:(\d+):(\d+)$/u.exec(target);
    const id = section ? `share-declaration-${section[1]}` : step ? `share-derivation-${step[1]}-${step[2]}` : undefined;
    if (!id) return;
    setView('reading');
    requestAnimationFrame(() => jump(id));
  };
  const excerpt = (start: number, end: number) => share.proof.split('\n').slice(start - 1, end).join('\n');
  return <section class="share-reading" aria-labelledby="share-reading-heading" data-share-reading>
    <div class="share-reading-heading"><h2 id="share-reading-heading" tabIndex={-1}>{tx('证明思路', 'Read the proof')}</h2>
      <div class="source-switch" role="group" aria-label={tx('阅读方式', 'Reading view')}>
        <button type="button" data-share-reading-view="reading" aria-pressed={view === 'reading'} onClick={() => setView('reading')}>{tx('逐步阅读', 'Step by step')}</button>
        <button type="button" data-share-reading-view="route" aria-pressed={view === 'route'} onClick={() => setView('route')}>{tx('路线图', 'Route map')}</button>
      </div>
    </div>
    {!!reading?.conditions.length && <div class="share-reading-conditions"><h3>{tx('适用条件', 'Assumptions')}</h3><ul>{reading.conditions.map((condition, index) => <li key={index}><Rich text={condition} /></li>)}</ul></div>}
    {documents.length > 1 && <label class="share-reading-select">{tx('选择已有讲解', 'Recorded explanation')}
      <select value={selected} data-share-explanation onChange={event => setSelected(Number(event.currentTarget.value))}>{documents.map((item, index) => <option key={`${item.target}:${item.language}`} value={index}>{item.target} · {item.language === 'zh' ? t('中文') : 'English'}</option>)}</select>
    </label>}
    {view === 'route' ? <SolutionRouteGraph model={model} onOpen={openReading} /> : document ? <div class="share-reading-prose" lang={document.language} translate={false}>
      <div class="share-reading-overview"><Rich text={document.overview} /></div>
      <nav class="share-reading-contents" aria-label={tx('证明中的结论', 'Proof contents')}>{document.sections.map((section, index) => <button type="button" key={section.name} onClick={() => jump(`share-declaration-${index}`)}>{section.title || section.name}</button>)}</nav>
      {document.sections.map((section, sectionIndex) => <section class="share-reading-declaration" key={section.name}>
        <h3 id={`share-declaration-${sectionIndex}`} tabIndex={-1}><Rich text={section.title || section.name} /></h3>
        <div class="share-reading-statement"><Rich text={section.statement} /></div>
        {section.steps.length ? <ol class="share-derivations">{section.steps.map((step, stepIndex) => <li key={stepIndex} id={`share-derivation-${sectionIndex}-${stepIndex}`} tabIndex={-1} data-share-derivation={`${sectionIndex}:${stepIndex}`}>
          <h4>{tx(`第${stepIndex + 1}步`, `Step ${stepIndex + 1}`)}</h4><Rich text={step.text} />
          {!!step.uses.length && <p class="share-step-uses">{tx('使用的结论：', 'Uses: ')}{step.uses.map((use, index) => {
            const target = document.sections.findIndex(item => item.name === use.name);
            return <span key={index}>{index > 0 && ' · '}{target >= 0 ? <button type="button" class="text-button" onClick={() => jump(`share-declaration-${target}`)}>{use.name}</button> : <code>{use.name}</code>}</span>;
          })}</p>}
          <details class="share-step-evidence"><summary>{tx('看目标变化与对应源码', 'Goal changes and source')}</summary>
            {step.goals && <div class="share-goal-changes"><div><h5>{tx('这一步之前', 'Before this step')}</h5><pre>{step.goals.before.join('\n\n')}</pre></div><div><h5>{tx('这一步之后', 'After this step')}</h5>
              {step.goals.afterCount === 0 ? <p>{tx('这个目标已证完。', 'This goal is closed.')}</p> : <pre>{step.goals.after.join('\n\n')}{step.goals.afterCount > step.goals.after.length ? `\n… ${step.goals.afterCount - step.goals.after.length} ${tx('个其余目标', 'additional goals')}` : ''}</pre>}</div></div>}
            <pre tabIndex={0}><code>{step.lines.map(lines => excerpt(lines.start, lines.end)).join('\n\n')}</code></pre>
            {!!step.reviews.length && <div class="share-step-reviews">{step.reviews.map((text, index) => <Rich key={index} text={text} />)}</div>}
          </details>
        </li>)}</ol> : section.kind === 'theorem' ? <p>{tx('这条声明未附逐步讲解。', 'No step-by-step explanation was recorded for this declaration.')}</p> : null}
      </section>)}
      {!!document.axioms.length && <details class="share-step-evidence"><summary>{tx('证明使用的公理', 'Axioms used by the proof')}</summary><ul>{document.axioms.map(axiom => <li key={axiom}><code>{axiom}</code></li>)}</ul></details>}
      {document.metrics.explainedLines < document.metrics.proofLines && <p class="share-reading-coverage">{tx('讲解覆盖 ', 'The explanation covers ')}{document.metrics.explainedLines}/{document.metrics.proofLines}{tx(' 行证明；其余部分可对照源码。', ' proof lines. Consult the source for the remaining lines.')}</p>}
    </div> : <div class="share-reading-prose">
      <p class="share-reading-coverage">{reading?.tasks.length ? tx('下面是这次研究保存的任务与推导思路。', 'These tasks and reasoning notes were recorded during the research.')
        : tx('这份快照未附逐步讲解，可从路线图阅读源码中的声明，再对照验收证明。', 'This snapshot has no recorded step-by-step explanation. The route map shows source declarations alongside the accepted proof.')}</p>
      {!!reading?.tasks.length && <ol class="share-recorded-tasks">{reading.tasks.map((task, index) => <li key={task.id}>
        <h3 id={`share-task-${index}`} tabIndex={-1}><Rich text={task.title} /></h3>
        {task.statement && <Rich text={task.statement} />}
        {!!task.premises.length && <div><h4>{tx('这一步的前提', 'Assumptions for this step')}</h4><ul>{task.premises.map((text, index) => <li key={index}><Rich text={text} /></li>)}</ul></div>}
        {task.reasoning && <div><h4>{tx('推导思路', 'Reasoning')}</h4><Rich text={task.reasoning} /></div>}
        {!!task.conditions.length && <p class="share-step-uses">{tx('条件对应的任务版本：', 'Condition versions: ')}{task.conditions.map(condition => <span key={`${condition.taskId}:${condition.version}`}><code>{condition.taskId} · {condition.version}</code>{' '}</span>)}</p>}
        {task.finding && task.finding !== task.reasoning && <div><h4>{tx('研究发现', 'Recorded finding')}</h4><Rich text={task.finding} /></div>}
        {!!task.dependencies.length && <p class="share-step-uses">{tx('依赖前面的结论：', 'Depends on: ')}{task.dependencies.map((id, index) => {
          const dependency = reading.tasks.findIndex(item => item.id === id);
          return <span key={id}>{index > 0 && ' · '}{dependency >= 0 ? <button class="text-button" type="button" onClick={() => jump(`share-task-${dependency}`)}>{reading.tasks[dependency]!.title}</button> : id}</span>;
        })}</p>}
        {(task.leanStatement || task.source) && <details class="share-step-evidence"><summary>{tx('对应 Lean 与版本', 'Lean and recorded version')}</summary>
          <pre tabIndex={0}><code>{task.source?.code ?? task.leanStatement}</code></pre><p>{tx('任务版本 ', 'Task version ')}<code>{task.version}</code></p>
          {task.source && <p>commit <code>{task.source.commit}</code> · SHA-256 <code>{task.source.sha256}</code></p>}
        </details>}
      </li>)}</ol>}
    </div>}
  </section>;
}
