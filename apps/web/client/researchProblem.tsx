import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { locale } from '../i18n';
import type { ResearchBrief, ResearchUsageLedger } from '../researchWorkspaceTypes';
import type { ResearchProblem, ResearchStageConclusion } from '../researchProblemTypes';
import type { ResearchFeedback, ResearchFeedbackTarget } from '../researchProjectTypes';
import { Rich, RichProse } from './richText';
import { SolutionRouteGraph } from './ui/SolutionRouteGraph';
import { compareProblemRoutes, problemSolutionRoute, problemOutcomeLabel } from './researchProblemModel';
import { base, enc, Empty, ErrorBox, Field, MutationState, Panel, stamp, tx, useMutation, useResource, type Item, type ResearchContext } from './researchShared';
import { webDraftOwner } from './ownedDrafts';
import { FeedbackWorkspace, type FeedbackFocus } from './researchFeedback';
import { CollaborationIssues } from './collaborationFlow';
import { Discussion } from './researchTheorems';
import { BriefPreview, evidenceStatus } from './researchWorkspace';
import { formatTokens } from '../presentation';
import { ProblemAttention, ProblemDecisionEvidence, ProblemTaskEvidence } from './researchProblemEvidenceView';
import { problemTaskOwners } from './researchProblemModel';
import { ProblemOrganization } from './researchPersonal';
import { ResearchProblemBudget } from './researchBudget';
import { ResearchJourneyView, ResearchJourneyTaskSource, ResearchChangesSinceRead } from './researchJourney';
import { ResearchInlineActions } from './researchInlineActions';
import { ProjectFromProblem } from './researchProjectStart';
import { ResearchOutcomeDelivery } from './researchOutcomeDelivery';
import { LibraryTrialHistory } from './researchLibraryTrialHistory';
import { StageProjectReference } from './researchStageReference';

const labels = { overview: ['总览', 'Overview'], route: ['证明路线', 'Proof route'], compare: ['历次尝试', 'Attempts'],
  discussion: ['讨论与决议', 'Discussion'], outcomes: ['用量与成果', 'Usage and outcomes'], stages: ['阶段结论', 'Stage conclusions'], brief: ['简报', 'Brief'] } as const;
type Tab = keyof typeof labels;
const initial = () => {
  const query = new URLSearchParams(location.search), tab = query.get('tab') ?? '';
  return { run: query.get('run') ?? '', project: query.get('project') ?? '', tab: tab in labels ? tab as Tab : 'overview' as Tab,
    task: query.get('task') ?? '', taskVersion: query.get('taskVersion') ?? '', commit: query.get('commit') ?? '', compare: query.get('compare') ?? '',
    decision: query.get('decision') ?? '', version: query.get('version') ?? '', snapshot: query.get('snapshot') ?? '', changeRecord: query.get('changeRecord') ?? '',
    feedback: query.get('feedback') ?? (location.hash.startsWith('#feedback-') ? location.hash.slice(10) : ''),
    map: query.get('map') === 'global' && !query.has('annotation') ? 'global' as const : 'attempt' as const,
    annotation: query.get('annotation') ?? '', accountDraft: query.get('accountDraft') ?? '', draftVersion: query.get('draftVersion') ?? '' };
};
type Selection = ReturnType<typeof initial>;
const problemUrl = (value: Selection) => {
  const query = new URLSearchParams({ run: value.run, tab: value.tab, lang: locale });
  for (const field of ['project', 'task', 'taskVersion', 'commit', 'compare', 'decision', 'version', 'feedback', 'snapshot', 'changeRecord', 'map', 'annotation', 'accountDraft', 'draftVersion'] as const) if (value[field]) query.set(field, value[field]);
  return `problem.html?${query}${value.tab === 'discussion' && value.feedback ? `#feedback-${encodeURIComponent(value.feedback)}` : value.tab === 'overview' && value.changeRecord ? '#research-changes' : ''}`;
};
const briefEndpoint = (run: string, project?: string) => `${base}/workspace/brief/${enc(run)}${project ? `?project=${enc(project)}` : ''}`;

export function ProblemPage({ context }: { context: ResearchContext }) {
  const [selection, setSelection] = useState<Selection>(initial);
  const ledger = useResource<ResearchUsageLedger>(context.session.authenticated ? `${base}/workspace/usage` : undefined);
  const endpoint = selection.run && context.session.authenticated ? `${base}/workspace/problem/${enc(selection.run)}${selection.project ? `?project=${enc(selection.project)}` : ''}` : undefined;
  useResource(endpoint ? `${base}/workspace/problem/${enc(selection.run)}/changes${selection.project ? `?project=${enc(selection.project)}` : ''}` : undefined);
  const resource = useResource<Item<ResearchProblem>>(endpoint, 15_000), problem = resource.data?.item;
  const [focus, setFocus] = useState<FeedbackFocus>(), [issue, setIssue] = useState<{ target?: ResearchFeedbackTarget; sourceFeedbackId?: string; statementVersionId?: string; serial: number }>();
  const [sourceKey, setSourceKey] = useState('');
  const [routeFocus, setRouteFocus] = useState<{ token: string; node: string }>();
  const owner = webDraftOwner(context.web), memoryKey = `theoremos.problem-view.v1:${owner}`, restored = useRef(false);
  const current = useRef(selection); current.current = selection;
  const navigate = (next: Partial<Selection>, push = true) => {
    const updated = { ...current.current, ...next }; current.current = updated; setSelection(updated);
    history[push ? 'pushState' : 'replaceState'](null, '', problemUrl(updated));
  };
  useEffect(() => { const back = () => setSelection(initial()); window.addEventListener('popstate', back); return () => window.removeEventListener('popstate', back); }, []);
  useEffect(() => {
    if (restored.current || !ledger.data) return;
    restored.current = true;
    if (selection.run) return;
    let saved: Partial<Selection> | undefined;
    try { saved = JSON.parse(localStorage.getItem(memoryKey) ?? 'null'); } catch { /* The address still keeps this selection. */ }
    const entries = ledger.data.groups.flatMap(group => group.entries).filter(entry => entry.stage === 'proof').sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    const entry = entries.find(entry => entry.id === `proof:${saved?.run}`) ?? entries.at(-1);
    if (!entry) return;
    const href = new URL(entry.href, location.href);
    navigate({ task: typeof saved?.task === 'string' ? saved.task : '', taskVersion: typeof saved?.taskVersion === 'string' ? saved.taskVersion : '',
      commit: typeof saved?.commit === 'string' ? saved.commit : '', compare: typeof saved?.compare === 'string' ? saved.compare : '',
      decision: typeof saved?.decision === 'string' ? saved.decision : '', version: typeof saved?.version === 'string' ? saved.version : '', feedback: typeof saved?.feedback === 'string' ? saved.feedback : '',
      run: entry.id.slice(6), project: href.searchParams.get('id') ?? '', tab: saved?.tab && saved.tab in labels ? saved.tab : 'overview' }, false);
  }, [ledger.data]);
  useEffect(() => { if (!problem) return; try { localStorage.setItem(memoryKey, JSON.stringify(selection)); } catch { /* The address remains shareable within the account. */ } }, [problem?.key, selection, memoryKey]);
  useEffect(() => { if (problem && selection.feedback && selection.tab === 'discussion') setFocus(previous => ({ id: selection.feedback, request: (previous?.request ?? 0) + 1 })); }, [problem?.key, selection.feedback, selection.tab]);
  const decision = problem?.brief.decisions.find(item => item.id === selection.decision);
  const selected = problem?.brief.tasks.find(task => task.id === selection.task && (!selection.taskVersion || task.version === selection.taskVersion)
    && (!selection.commit || task.commit === selection.commit));
  const savedTaskHref = problem && selection.task ? (() => { const link = new URL(problem.brief.runHref, location.href);
    link.searchParams.set('task', selection.task); link.searchParams.set('view', 'source');
    if (selection.taskVersion) link.searchParams.set('taskVersion', selection.taskVersion);
    if (selection.commit) link.searchParams.set('commit', selection.commit);
    return link.pathname + link.search;
  })() : undefined;
  const selectTask = (id: string, node = `task:${id}`) => {
    const task = problem?.brief.tasks.find(task => task.id === id);
    if (task) {
      setRouteFocus({ token: `${selection.run}:${task.id}:${task.version}`, node });
      navigate({ task: id, taskVersion: task.version, commit: task.commit ?? '', decision: '', annotation: '', feedback: '', accountDraft: '', draftVersion: '' }, false);
    }
  };
  const runChoice = (run: string) => {
    setFocus(undefined); setIssue(undefined);
    navigate({ run, task: '', taskVersion: '', commit: '', decision: '', feedback: '', annotation: '', accountDraft: '', draftVersion: '', compare: selection.compare === run ? '' : selection.compare });
  };
  const openIssue = (feedback?: ResearchFeedback) => {
    const binding = problem?.project?.runs.find(run => run.runId === selection.run);
    const target = feedback?.target ?? (selected && binding && problem?.observationRef ? { runId: selection.run, statementVersionId: binding.statementVersionId,
      observationRef: problem.observationRef, taskRef: { id: selected.id, version: selected.version } } : undefined);
    setIssue(previous => ({ target, sourceFeedbackId: feedback?.id, statementVersionId: feedback?.statementVersionId, serial: (previous?.serial ?? 0) + 1 }));
  };
  const revealFeedback = (id: string) => setFocus(previous => ({ id, request: (previous?.request ?? 0) + 1 }));
  const projectCreated = (project: string) => { navigate({ project }); resource.refresh(); ledger.refresh(); };
  if (!context.session.authenticated) return <Panel title={tx('登录后继续这道题', 'Sign in to continue this problem')}><a class="button" href={`login.html?${new URLSearchParams({ returnTo: 'problem', ...selection, lang: locale })}`}>{tx('登录', 'Sign in')}</a></Panel>;
  return <div class="problem-page" data-problem-page>
    <header class="problem-heading"><div><p class="research-eyebrow">TheoremOS</p><h1>{problem ? <Rich text={problem.brief.title} /> : tx('题目工作区', 'Problem workspace')}</h1></div>
      <a class="button" href="./">{tx('开始另一道题', 'Start another problem')}</a></header>
    <ErrorBox message={resource.error || ledger.error} />{resource.error && <button class="button" type="button" onClick={resource.refresh}>{tx('重新读取', 'Try again')}</button>}
    {resource.loading && <p role="status">{tx('正在整理这道题的研究记录…', 'Loading this problem’s research…')}</p>}
    {!selection.run && !ledger.loading && <Panel title={tx('选择一道题', 'Choose a problem')}><Empty>{tx('开始研究后，这里会将路线、讨论和成果放在一起。', 'Start a research run to bring its route, discussion and outcomes together here.')}</Empty></Panel>}
    {problem && <><section class="problem-context" aria-label={tx('当前研究上下文', 'Current research context')}>
      <label>{tx('当前尝试', 'Current attempt')}<select data-problem-run value={selection.run} onChange={event => runChoice(event.currentTarget.value)}>{problem.brief.attempts.map(attempt => <option key={attempt.id} value={attempt.id}>{attempt.title} · {stamp(attempt.createdAt)}</option>)}</select></label>
      <div><span>{tx('当前任务', 'Current task')}</span><strong>{selected ? <Rich text={selected.title} /> : selection.task ? tx('此尝试没有这一节点版本', 'This node version is absent from this attempt') : tx('整道题', 'Whole problem')}</strong>
        {selected && <code title={selected.version}>{selected.version.slice(0, 12)}</code>}</div>
      <a class="text-button" href={selected?.href ?? problem.brief.runHref}>{selected ? selected.commit ? tx('打开此版本源码', 'Open this source version') : tx('打开任务记录', 'Open task record') : tx('进入研究操作', 'Open research controls')} ↗</a>
    </section>
    <nav class="problem-tabs" aria-label={tx('题目内容', 'Problem sections')}>{Object.entries(labels).map(([id, label]) => <a key={id} href={problemUrl({ ...selection, tab: id as Tab })} aria-current={selection.tab === id ? 'page' : undefined}
      onClick={event => { if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return; event.preventDefault(); navigate({ tab: id as Tab }); }}>{tx(label[0], label[1])}</a>)}</nav>
    <div class="problem-content">
    {selection.task && !selected && <p class="research-status" role="status">{tx('选中的任务或源码版本已不在当前路线中。', 'The selected task or source version is no longer in the current route.')} {savedTaskHref && <a href={savedTaskHref}>{tx('查看所选版本', 'Open the selected version')}</a>} · <button type="button" class="text-button" onClick={() => navigate({ task: '', taskVersion: '', commit: '' }, false)}>{tx('回到当前整条路线', 'Return to the current route')}</button></p>}
    {selection.tab === 'overview' && <><ProblemOrganization problem={problem} context={context} /><ProjectFromProblem problem={problem} onCreated={projectCreated} /><ResearchOutcomeDelivery problem={problem} context={context} onBrief={() => navigate({ tab: 'brief' })} /><ResearchChangesSinceRead key={`${problem.key}:${selection.run}`} runId={selection.run} projectId={problem.project?.id} /><Panel title={tx('这道题研究到哪里了', 'Where the research stands')}>
      <RichProse text={problem.brief.statement} /><div class="problem-summary"><p>{problem.brief.accepted ? tx('Lean 陈述证明通过', 'Lean statement accepted') : tx('原题尚未通过独立验收', 'The problem has not passed independent acceptance')}</p>
      <p>{problem.brief.attempts.length} {tx('次尝试', 'attempts')} · {problem.brief.tasks.length} {tx('个任务', 'tasks')} · {formatTokens(problem.brief.usage.knownTokens)} Token</p></div>
      <div class="research-actions"><button class="button button-primary" type="button" onClick={() => navigate({ tab: 'route' })}>{tx('阅读证明路线', 'Read the proof route')}</button><a class="button" href={problem.brief.runHref}>{tx('继续研究或提供指导', 'Continue research or give guidance')}</a></div>
      </Panel>{problem.stages.length > 0 && <Panel title={tx('最近一次人工总结', 'Latest human conclusion')}><StageView stage={problem.stages.at(-1)!} problem={problem} refresh={resource.refresh} /><button class="text-button" type="button" onClick={() => navigate({ tab: 'stages' })}>{tx('查看历次阶段结论', 'View all stage conclusions')}</button></Panel>}
      <Panel title={tx('现在卡在哪里，下一步由谁处理', 'Blockers, responsibility and next steps')}><ProblemAttention key={`${problem.key}:${problem.brief.selectedRunId}`} problem={problem} selfId={context.session.researcherId ?? undefined}
        onTask={task => navigate({ tab: 'route', task: task.id, taskVersion: task.version, commit: task.commit ?? '' })}
        onFeedback={(id, task) => { navigate({ tab: 'discussion', feedback: id, task: task?.id ?? '', taskVersion: task?.version ?? '', commit: task?.commit ?? '' }); revealFeedback(id); }} /></Panel></>}
    {selection.tab === 'route' && <section class="problem-route-workspace" data-problem-route-workspace>
      <div class="problem-map-switch" role="group" aria-label={tx('路线视图', 'Route view')}>
        <button type="button" data-problem-map="attempt" aria-pressed={selection.map === 'attempt'} onClick={() => navigate({ map: 'attempt' })}>{tx('当前尝试', 'Current attempt')}</button>
        <button type="button" data-problem-map="global" aria-pressed={selection.map === 'global'} onClick={() => navigate({ map: 'global' })}>{tx('全局轨迹', 'Research journey')}</button>
      </div>
      {selection.map === 'global' ? <ResearchJourneyView runId={selection.run} projectId={problem.project?.id} focusedTask={selected}
        onAttemptSelection={run => { if (run !== selection.run) runChoice(run); }}
        onTaskSelection={({ runId, task }) => navigate({ run: runId, task: task.id, taskVersion: task.version, commit: task.commit ?? '', decision: '', annotation: '', feedback: '', accountDraft: '', draftVersion: '' }, false)} />
        : <Panel title={tx('当前尝试的证明路线', 'Proof route for the current attempt')}>

      {problem.brief.decisions.length > 0 && <div class="problem-decision-nav" data-problem-decision-nav><h3>{tx('人工决定', 'Human decisions')}</h3>{problem.brief.decisions.map(item => <button type="button" key={item.id} data-problem-select-decision={item.id} aria-pressed={selection.decision === item.id}
        onClick={() => navigate({ decision: item.id, task: '', taskVersion: '', commit: '' })}>{item.kind === 'plan-edit' ? tx('修改计划', 'Plan edit') : item.kind === 'plan-approval' ? tx('批准计划', 'Plan approval') : <Rich text={item.text} />}</button>)}</div>}
      <div data-problem-route-decision={decision?.id ?? ''}><SolutionRouteGraph model={{ ...problemSolutionRoute(problem.brief, locale), initial: selected ? `task:${selected.id}` : decision ? `decision:${decision.id}` : 'problem' }}
      selection={selected && routeFocus?.token === `${selection.run}:${selected.id}:${selected.version}` ? routeFocus.node : selected ? `task:${selected.id}` : decision ? `decision:${decision.id}` : 'problem'}
      onSelect={id => { if (id.startsWith('task:')) selectTask(id.slice(5));
        else if (id.startsWith('check:')) { const task = problem.brief.tasks.find(item => item.checks.some(check => `check:${check.id}` === id)); if (task) selectTask(task.id, id); }
        else if (id.startsWith('decision:')) navigate({ decision: id.slice(9), task: '', taskVersion: '', commit: '' }, false);
        else navigate({ task: '', taskVersion: '', commit: '' }, false); }} onOpen={id => { const task = problem.brief.tasks.find(item => item.id === id); if (task) { selectTask(id); setSourceKey(`${selection.run}:${task.id}:${task.version}`); } }} /></div>
      {selection.decision && !decision && <p role="status">{tx('当前记录中没有所选人工决定。', 'The selected human decision is absent from this record.')}</p>}
      {decision && <ProblemDecisionEvidence decision={decision} problem={problem} onTask={selectTask} />}
      {selected && <p class="problem-responsibility" data-problem-task-owners>{tx('当前负责', 'Recorded responsibility')}: {problemTaskOwners(problem, selected).map(owner => owner.name).join(' · ') || tx('尚未记录', 'Not assigned in this record')}</p>}
      {selected && <div class="research-actions">{selected.commit ? <button class="button" type="button" data-problem-open-source onClick={() => setSourceKey(`${selection.run}:${selected.id}:${selected.version}`)}>{tx('查看此版本源码', 'Open this source version')}</button> : <a class="button" href={selected.href}>{tx('打开任务记录', 'Open task record')}</a>}<button class="button" type="button" onClick={() => navigate({ tab: 'discussion' })}>{tx('讨论这一步', 'Discuss this step')}</button>
        {['lemma', 'goal'].includes(selected.kind) && selected.commit && <a class="button" href={`library.html?${new URLSearchParams({ run: selection.run, ...(problem.project ? { project: problem.project.id } : {}), task: selected.id, taskVersion: selected.version, commit: selected.commit })}`}>{tx('为这一步寻找可用引理', 'Find a lemma for this step')}</a>}</div>}
      {selected && sourceKey === `${selection.run}:${selected.id}:${selected.version}` && <ResearchJourneyTaskSource runId={selection.run} projectId={problem.project?.id} task={selected} close={() => setSourceKey('')} />}
      <ResearchInlineActions key={`${selection.run}:${selected?.id ?? ''}:${selected?.version ?? ''}`} problem={problem} task={selected} context={context} refresh={resource.refresh} focusAnnotationId={selection.annotation || undefined}
        onTask={(target, task) => navigate({ run: target.runId, tab: 'route', task: task.id, taskVersion: task.version, commit: '' })} />
    </Panel>}
    </section>}
    {selection.tab === 'compare' && <ProblemComparison problem={problem} selected={selection} choose={id => navigate({ compare: id })} onTask={selectTask} />}
    {selection.tab === 'discussion' && <><Panel title={tx('与这道题有关的对话', 'Conversations about this problem')}>
      {problem.conversations.map(conversation => <details key={conversation.id}><summary><Rich text={conversation.title} /> · {stamp(conversation.updatedAt)}</summary>{conversation.messages.map(message => <article class="problem-message" key={message.id}><p>{message.role === 'user' ? tx('你', 'You') : 'TheoremOS'} · <a href={message.href}>{tx('回到对话', 'Open conversation')}</a></p><RichProse text={message.text} /></article>)}</details>)}
      {!problem.conversations.length && <Empty>{tx('当前账号没有关联这道题的对话。', 'This account has no conversation attached to this problem.')}</Empty>}
    </Panel>{problem.project ? <Panel title={tx('协作讨论与决议', 'Collaboration and decisions')}><FeedbackWorkspace project={problem.project} selfId={context.session.researcherId ?? ''} runId={selection.run}
      task={selected ? { runId: selection.run, taskId: selected.id, taskVersion: selected.version } : undefined} refresh={resource.refresh} browseTask={0} focus={focus} focusAnnotationId={selection.annotation || undefined} onRevealFeedback={revealFeedback} onOpenIssue={openIssue}
      onOpenTask={(target, task) => navigate({ run: target.runId, tab: 'route', task: task.id, taskVersion: task.version, commit: '' })}
      onOpenStatement={() => navigate({ tab: 'overview' })}>
      {problem.project.permissions.discuss && <Discussion project={problem.project} selfId={context.session.researcherId ?? ''} version={problem.project.versions.find(version => version.id === problem.project!.runs.find(run => run.runId === selection.run)?.statementVersionId)} refresh={resource.refresh} />}
    </FeedbackWorkspace><CollaborationIssues project={problem.project} selfId={context.session.researcherId ?? ''} request={issue} refresh={resource.refresh} onRevealFeedback={revealFeedback} /></Panel>
      : <Panel title={tx('协作研究', 'Collaborative research')}><p>{tx('将这份运行关联到定理项目后，可在这里共同讨论、评审和记录决议。', 'Attach this run to a theorem project to discuss, review and record decisions here.')}</p><ProjectFromProblem problem={problem} onCreated={projectCreated} /><a class="button" href="theorems.html">{tx('选择或创建定理项目', 'Choose or create a theorem project')}</a></Panel>}</>}
    {selection.tab === 'outcomes' && <><ResearchOutcomeDelivery problem={problem} context={context} onBrief={() => navigate({ tab: 'brief' })} /><LibraryTrialHistory context={context} runId={selection.run} /><ResearchProblemBudget key={`${problem.key}:${selection.run}`} problem={problem} /><Panel title={tx('用量与研究成果', 'Usage and research outcomes')}><p>{formatTokens(problem.brief.usage.knownTokens)} {tx('已记录 Token', 'recorded tokens')} · {problem.brief.usage.missingEntries} {tx('条记录缺少用量', 'records without usage')}</p>
      <div class="problem-table-scroll"><table class="problem-table"><thead><tr>{[tx('阶段', 'Stage'), tx('模型', 'Model'), 'Token', tx('金额估算', 'Estimated cost')].map(label => <th key={label}>{label}</th>)}</tr></thead><tbody>{problem.brief.usage.entries.map(entry => <tr key={entry.id}><td><a href={entry.href}>{({ proof: tx('证明研究', 'Proof'), formalization: tx('形式化', 'Formalization'), explanation: tx('讲解', 'Explanation') })[entry.stage]}</a></td><td>{entry.model}</td><td>{entry.tokens === null ? tx('未记录', 'Not recorded') : formatTokens(entry.tokens)}</td><td>{entry.estimate ? `${entry.estimate.currency} ${entry.estimate.amount.toFixed(4)}` : '—'}</td></tr>)}</tbody></table></div>
      <p><a href={`workspace.html?tab=usage&run=${enc(selection.run)}`}>{tx('管理单价与完整账本', 'Manage rates and the complete ledger')}</a></p>
      <h3>{tx('已关联成果', 'Linked outcomes')}</h3>{problem.brief.outcomes.map(outcome => <p key={outcome.href}><a href={outcome.href}><Rich text={outcome.title} /></a><br /><code>{outcome.detail}</code></p>)}
      {!problem.brief.outcomes.length && <Empty>{tx('这次研究还没有关联成果。', 'This run has no linked outcome yet.')}</Empty>}
    </Panel></>}
    {selection.tab === 'stages' && <ProblemStages key={`${owner}:${problem.key}:${problem.brief.selectedRunId}`} problem={problem} context={context} refresh={resource.refresh} />}
    {selection.tab === 'brief' && <BriefPreview brief={problem.brief} context={context} />}
    </div></>}
  </div>;
}

function ProblemComparison({ problem, selected, choose, onTask }: { problem: ResearchProblem; selected: Selection; choose(id: string): void; onTask(id: string): void }) {
  const beforeId = selected.compare || problem.brief.attempts.filter(attempt => attempt.id !== selected.run).at(-1)?.id;
  const before = useResource<Item<ResearchBrief>>(beforeId ? briefEndpoint(beforeId, problem.project?.id) : undefined);
  const comparison = useMemo(() => before.data ? compareProblemRoutes(before.data.item, problem.brief) : undefined, [before.data, problem.brief]);
  const [task, setTask] = useState(selected.task);
  const [routeFocus, setRouteFocus] = useState<Record<string, string>>({});
  const focusTask = (id: string) => { setTask(id); setRouteFocus({ ...(beforeId ? { [beforeId]: `task:${id}` } : {}), [selected.run]: `task:${id}` }); };
  const comparedTask = task || comparison?.tasks.find(change => change.kind !== 'unchanged')?.id || comparison?.after.tasks[0]?.id || '';
  const changedLabels = { statement: tx('陈述或前提', 'Statement or premises'), dependencies: tx('依赖', 'Dependencies'), derivation: tx('推导', 'Derivation'), proof: tx('证明版本或状态', 'Proof version or state'), checks: tx('检查证据', 'Check evidence'), feedback: tx('反馈与阻碍', 'Feedback and blockers') };
  return <Panel title={tx('比较两次研究的路线与证据', 'Compare routes and evidence')}>
    <label class="research-field">{tx('对照尝试', 'Compare with')}<select data-problem-compare value={beforeId ?? ''} onChange={event => choose(event.currentTarget.value)}><option value="">{tx('选择一次尝试', 'Choose an attempt')}</option>{problem.brief.attempts.filter(attempt => attempt.id !== selected.run).map(attempt => <option key={attempt.id} value={attempt.id}>{attempt.title} · {stamp(attempt.createdAt)}</option>)}</select></label>
    <ErrorBox message={before.error} />{!beforeId && <Empty>{tx('同一道题有两次尝试后，可以并排比较路线。', 'Two attempts of this problem are needed to compare routes.')}</Empty>}
    {comparison && <><p>{comparison.comparable ? tx('标记说明任务、依赖和检查记录的变化；检查只属于各自保存的版本。', 'Changes refer to recorded tasks, dependencies and checks. Each check belongs to its own saved version.')
      : tx('两次尝试的陈述、题意或环境不同，或缺少完整环境身份，以下分别展示，不计算进展增量。', 'The statement, meaning or environment differs, or a complete environment identity is missing. The attempts are shown separately without progress deltas.')}</p>
      {comparison.comparable && <div class="problem-changes">{comparison.tasks.map(change => { const current = comparison.after.tasks.find(item => item.id === change.id) ?? comparison.before.tasks.find(item => item.id === change.id)!;
        return <button class="problem-change" data-change={change.kind} aria-pressed={comparedTask === change.id} key={change.id} type="button" onClick={() => { focusTask(change.id); onTask(change.id); }}><span>{({ added: tx('新增', 'Added'), removed: tx('撤回', 'Removed'), changed: tx('调整', 'Changed'), unchanged: tx('未变', 'Unchanged') })[change.kind]}</span><strong><Rich text={current.title} /></strong><small>{change.changes.map(kind => changedLabels[kind]).join(' · ')}</small></button>; })}
      {comparison.edges.filter(edge => edge.kind !== 'unchanged').map(edge => <p key={`${edge.from}:${edge.to}`}>{edge.kind === 'added' ? tx('新增依赖', 'Added dependency') : tx('撤回依赖', 'Removed dependency')}: <code>{edge.from} → {edge.to}</code></p>)}</div>}
      {comparison.comparable && comparedTask && <div class="problem-evidence-comparison" data-problem-attempt-task-comparison>{[comparison.before, comparison.after].map((brief, index) => <section key={brief.selectedRunId}><h3>{index === 0 ? tx('对照尝试的这一步', 'This step in the earlier attempt') : tx('当前尝试的这一步', 'This step in the current attempt')}</h3><ProblemTaskEvidence task={brief.tasks.find(item => item.id === comparedTask)} tasks={brief.tasks} /></section>)}</div>}
      <div class="problem-comparison">{[comparison.before, comparison.after].map((brief, index) => { const route = problemSolutionRoute(brief, locale);
        const requested = routeFocus[brief.selectedRunId] ?? (comparedTask ? `task:${comparedTask}` : 'problem');
        const selectedNode = route.nodes.some(node => node.id === requested) ? requested : 'problem';
        return <section key={brief.selectedRunId}><h3>{index === 0 ? tx('对照尝试', 'Earlier attempt') : tx('当前尝试', 'Current attempt')}</h3><p><Rich text={brief.title} /> · {brief.accepted ? tx('Lean 陈述证明通过', 'Lean statement accepted') : evidenceStatus(brief.status)}</p>
        {comparedTask && !brief.tasks.some(item => item.id === comparedTask) && <p role="status">{tx('这次尝试没有该节点，显示整道题。', 'This attempt has no matching node. Showing the whole problem.')}</p>}
        <SolutionRouteGraph model={{ ...route, id: `problem-comparison:${comparison.before.selectedRunId}:${comparison.after.selectedRunId}:${brief.selectedRunId}`, initial: selectedNode }} selection={selectedNode}
          onSelect={id => { if (id.startsWith('task:')) focusTask(id.slice(5)); else setRouteFocus(previous => ({ ...previous, [brief.selectedRunId]: id })); }}
          onOpen={id => { const match = brief.tasks.find(item => item.id === id); if (match) location.assign(match.href); }} /></section>; })}</div>
    </>}
  </Panel>;
}

function StageView({ stage, problem, refresh }: { stage: ResearchStageConclusion; problem: ResearchProblem; refresh(): void }) {
  return <article class="problem-stage" data-stage-id={stage.id}><header><h3><Rich text={stage.title} /></h3><time>{stamp(stage.createdAt)}</time></header>
    {[ [tx('已确认的结论', 'Confirmed conclusion'), stage.conclusion], [tx('适用条件与边界', 'Conditions and boundaries'), stage.boundaries], [tx('未解决的问题', 'Unresolved questions'), stage.unresolved], [tx('下一步', 'Next step'), stage.next] ].map(([label, text]) => text && <section key={label}><h4>{label}</h4><RichProse text={text} /></section>)}
    <details><summary>{tx('定稿时的路线与证据', 'Frozen route and evidence')}</summary><p><code>{stage.evidenceDigest}</code></p><RichProse text={stage.snapshot.statement} /><p>{tx('独立验收记录', 'Recorded acceptance')}: {problemOutcomeLabel(stage.snapshot.acceptance.status, locale)}</p>
      <SolutionRouteGraph model={{ ...problemSolutionRoute(stage.snapshot, locale), id: `stage:${stage.id}` }} onOpen={id => { const task = stage.snapshot.tasks.find(item => item.id === id); if (task) location.assign(task.href); }} />
      {stage.snapshot.tasks.map(task => <p key={task.id}><Rich text={task.title} /> · <code>{task.version}</code>{task.commit && <> · <code>{task.commit}</code></>}{task.checks.map(check => <span key={check.id}> · {check.passed ? tx('检查通过', 'Check passed') : tx('检查未过', 'Check failed')} <code>{check.id}</code></span>)}</p>)}</details>
    <StageProjectReference stage={stage} project={problem.project} references={problem.collaboration?.issues} refresh={refresh} /><a href={`problem.html?${new URLSearchParams({ run: stage.snapshot.selectedRunId, tab: 'route', ...(stage.projectId ? { project: stage.projectId } : {}) })}`}>{tx('查看所引用的运行', 'Open the referenced run')}</a>
  </article>;
}

function ProblemStages({ problem, context, refresh }: { problem: ResearchProblem; context: ResearchContext; refresh(): void }) {
  const empty = { title: '', conclusion: '', boundaries: '', unresolved: '', next: '', evidenceDigest: problem.evidenceDigest };
  const key = `theoremos.stage-draft.v1:${webDraftOwner(context.web)}:${problem.key}:${problem.brief.selectedRunId}`;
  const [draft, setDraft] = useState(() => { try { const saved = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (saved && Object.keys(empty).every(field => typeof saved[field] === 'string')) return saved as typeof empty;
  } catch { /* Saving below reports unavailable storage. */ } return empty; });
  const [storageNotice, setStorageNotice] = useState(''), action = useMutation();
  useEffect(() => { try { if (draft.title || draft.conclusion || draft.boundaries || draft.unresolved || draft.next) localStorage.setItem(key, JSON.stringify(draft)); else localStorage.removeItem(key); } catch { setStorageNotice(tx('此浏览器无法保存草稿，请在离开前定稿。', 'This browser cannot save drafts. Save the conclusion before leaving.')); } }, [draft, key]);
  const changed = draft.evidenceDigest !== problem.evidenceDigest;
  return <><Panel title={tx('写下这一阶段的判断', 'Record your judgement at this stage')}><p>{tx('由你定稿，保存当前引用的路线与检查版本。它记录研究判断，证明结果仍读取独立验收。', 'Your conclusion saves the route and check versions you reviewed. Proof status continues to come from independent acceptance.')}</p>
    <form class="research-form" onSubmit={event => { event.preventDefault(); if (changed) return; const submitted = draft;
      void action.run<Item<ResearchStageConclusion>>('POST', `${base}/workspace/problem/${enc(problem.brief.selectedRunId)}/stages${problem.project ? `?project=${enc(problem.project.id)}` : ''}`, submitted,
      () => { setDraft(previous => previous === submitted ? { ...empty, evidenceDigest: problem.evidenceDigest } : previous); refresh(); }); }}>
      <Field label={tx('阶段名称', 'Stage title')} value={draft.title} required maxLength={200} onInput={title => setDraft(previous => ({ ...previous, title }))} />
      {(['conclusion', 'boundaries', 'unresolved', 'next'] as const).map(field => <Field key={field} label={({ conclusion: tx('已确认的结论', 'Confirmed conclusion'), boundaries: tx('适用条件与边界', 'Conditions and boundaries'), unresolved: tx('未解决的问题', 'Unresolved questions'), next: tx('下一步', 'Next step') })[field]} value={draft[field]} required={field === 'conclusion'} multiline maxLength={8000} onInput={value => setDraft(previous => ({ ...previous, [field]: value }))} />)}
      <p class="research-status" role="status">{storageNotice || (draft.title || draft.conclusion ? tx('草稿已保存在此浏览器', 'Draft saved in this browser') : tx('定稿后保存在你的账号中', 'Saved to your account when finalized'))}</p>
      {changed && <p role="status">{tx('研究证据已有更新，文字草稿已保留。请核对路线与检查后继续。', 'Research evidence changed. Your text is preserved. Review the route and checks before continuing.')} <button type="button" class="text-button" onClick={() => setDraft(previous => ({ ...previous, evidenceDigest: problem.evidenceDigest }))}>{tx('已核对最新证据', 'I reviewed the latest evidence')}</button></p>}
      <MutationState action={action} /><button type="submit" class="button button-primary" disabled={action.busy || changed}>{tx('保存阶段结论', 'Save stage conclusion')}</button>
    </form></Panel><Panel title={tx('历次阶段结论', 'Stage conclusion history')}>{problem.stages.slice().reverse().map(stage => <StageView key={stage.id} stage={stage} problem={problem} refresh={refresh} />)}{!problem.stages.length && <Empty>{tx('还没有人工定稿的阶段结论。', 'No human stage conclusion has been saved yet.')}</Empty>}</Panel></>;
}
