import { useEffect, useRef, useState } from 'preact/hooks';
import type { ResearchFeedback, ResearchFeedbackTarget, ResearchProjectDetail, ResearchProjectSummary, ResearchRunBinding, ResearchStatementVersion, ResearcherProfile, ResearchDiscussionContext } from '../researchProjectTypes';
import { loginHref, researchContextHref, type WebRun } from '../shared';
import type { WebShareSnapshot } from '../shareTypes';
import type { WebObservation } from '../collaboration';
import { t } from '../i18n';
import type { WebApi } from './collaborationUi';
import { CollaborationView, type CollaborationTaskSelection } from './collaborationView';
import { FeedbackWorkspace, TaskFeedbackContext, type FeedbackFocus, type OpenFeedbackTask } from './researchFeedback';
import { taskFeedbackAnnotations } from './researchFeedbackModel';
import { ProjectPlanApproval } from './researchPlanApproval';
import { CollaborationIssues, CollaborationMembership, CollaborationTaskWorkspace } from './collaborationFlow';
import { BookmarkControl } from './researchCollections';
import { OpenAIProblems, type ProblemSort } from './researchOpenAIProblems';
import { projectProblemDraftHref } from './researchProblemDraft';
import { webDraftOwner } from './ownedDrafts';
import { useResearchProjectDraft } from './researchProjectDraft';
import { ResearchDraftStore } from './researchDraftStore';
import { readPeopleReturn, withPeopleReturn } from './researchPeopleReturn';
import { RichProse } from './richText';
import { ResearchDraftPicker, useResearchDrafts } from './researchDrafts';
import { discussionContextKey, discussionDraftMatches, type DiscussionDraft } from './researchDiscussionDraft';
import { DiscussionContext } from './researchDiscussionContext';
import { ResearchWorkImpactView } from './researchWorkImpact';
import { AnnotationAnchorSummary } from './researchAnnotations';
import { api, base, Check, enc, Empty, ErrorBox, Field, FollowButton, lines, MutationState, nameOf, Panel, personHref, Search,
  stamp, State, Tags, theoremHref, tx, useMutation, useResource, words, type Item, type Items, type ResearchContext } from './researchShared';

export function TheoremsPage({ context }: { context: ResearchContext }) {
  const parameters = new URLSearchParams(location.search), selected = parameters.get('id') ?? '';
  const requestedResearcher = parameters.get('addResearcher') ?? '', addResearcher = /^[A-Za-z0-9_-]{1,128}$/u.test(requestedResearcher) ? requestedResearcher : undefined;
  const [collection, setCollection] = useState<'solved' | 'research'>(selected || parameters.get('collection') === 'research' ? 'research' : 'solved');
  const [sort, setSort] = useState<ProblemSort>(parameters.get('sort') === 'title' ? 'title' : 'newest'), [searchReset, setSearchReset] = useState(0);
  const [query, setQuery] = useState(parameters.get('q') ?? ''), [field, setField] = useState(parameters.get('field') ?? ''),
    [offset, setOffset] = useState(() => { const value = Number(parameters.get('offset')); return Number.isSafeInteger(value) && value >= 0 ? value : 0; });
  const collectionBrowse = useRef<Partial<Record<typeof collection, { query: string; field: string; offset: number; sort: ProblemSort }>>>({});
  const changeCollection = (value: typeof collection) => {
    if (value === collection) return;
    collectionBrowse.current[collection] = { query, field, offset, sort };
    const saved = collectionBrowse.current[value] ?? { query: '', field: '', offset: 0, sort: 'newest' };
    setCollection(value); setQuery(saved.query); setField(saved.field); setOffset(saved.offset); setSort(saved.sort);
  };
  const [creating, setCreating] = useState(context.session.authenticated && parameters.get('create') === '1');
  const [creatorMounted, setCreatorMounted] = useState(creating);
  const directory = useResource<Items<ResearchProjectSummary>>(selected || collection !== 'research' ? undefined : `${base}/theorems?q=${enc(query)}&field=${enc(field)}&offset=${offset}&limit=14`);
  const detail = useResource<Item<ResearchProjectDetail>>(selected ? `${base}/theorems/${enc(selected)}` : undefined, 8000);
  const browse = new URLSearchParams({ collection });
  if (collection === 'solved' && sort !== 'newest') browse.set('sort', sort);
  if (query) browse.set('q', query); if (field) browse.set('field', field); if (offset) browse.set('offset', String(offset));
  const browseHref = researchContextHref(`theorems.html${browse.size ? `?${browse}` : ''}`, location.search);
  const peopleReturn = readPeopleReturn(location.search);
  const createHref = `${browseHref}${browse.size ? '&' : '?'}create=1${addResearcher ? `&addResearcher=${enc(addResearcher)}` : ''}`;
  useEffect(() => {
    const next = new URL(location.href);
    for (const key of ['collection', 'q', 'field', 'offset', 'sort']) { const value = browse.get(key); value ? next.searchParams.set(key, value) : next.searchParams.delete(key); }
    history.replaceState(null, '', next);
  }, [collection, query, field, offset, sort]);
  const create = (value: boolean) => {
    if (value) setCreatorMounted(true);
    setCreating(value);
    const next = new URL(location.href); value ? next.searchParams.set('create', '1') : next.searchParams.delete('create'); history.replaceState(null, '', next);
  };
  return <><div class="research-heading research-theorem-heading"><div><span class="research-eyebrow">TheoremOS / Theorems</span>
    <h1>{creating ? tx('新建定理', 'New theorem') : detail.data?.item.title ?? tx('定理', 'Theorems')}</h1>
    <p>{creating ? tx('先描述你要研究的问题，再添加原题陈述。', 'Describe your research question, then add its statement.')
      : selected ? tx('阅读原题，查看研究进展，参与讨论。', 'Read the statement, follow research progress and join the discussion.')
        : tx('从题目到证明，阅读每一步解题过程。', 'From statement to proof. Explore how each problem was solved.')}</p></div>
    <div class="research-heading-actions">{context.session.authenticated ? selected
      ? <a class="button button-primary" href={createHref}>{tx('新建定理', 'New theorem')}</a>
      : <button class="button button-primary" type="button" aria-expanded={creating} onClick={() => create(!creating)}>{creating ? tx('返回定理目录', 'Back to theorems') : tx('新建定理', 'New theorem')}</button>
      : <a class="button" href={loginHref(createHref)}>{tx('登录后创建定理', 'Sign in to create a theorem')}</a>}</div></div>
    {creatorMounted && <div hidden={!creating}><Panel title={tx('研究题目', 'Research question')}><CreateProject addResearcher={addResearcher} /></Panel></div>}
    <div hidden={creating}>{!selected && <nav class="research-section-nav research-theorem-collections" aria-label={tx('定理内容', 'Theorem collections')}>
      {(['solved', 'research'] as const).map(value => <button key={value} type="button" data-theorem-collection={value} aria-pressed={collection === value} onClick={() => changeCollection(value)}>{value === 'solved' ? tx('已解决题目', 'Solved problems') : tx('研究项目', 'Research projects')}</button>)}
    </nav>}{selected ? <><nav class="research-breadcrumb" aria-label={tx('返回目录', 'Back to directory')}>
      {peopleReturn && <><a data-research-people-return href={peopleReturn}>{peopleReturn.endsWith('#research-contributions') ? tx('返回贡献记录', 'Back to contributions') : tx('返回更新列表', 'Back to updates')}</a><span aria-hidden="true"> · </span></>}
      <a href={browseHref}>{tx('返回定理目录', 'Back to theorems')}</a></nav>
      <div class="research-content"><ErrorBox message={detail.error} />{detail.data ? <Project key={selected} project={detail.data.item} context={context} refresh={detail.refresh} /> : detail.error ?
        <Panel title={tx('无法打开此定理', 'Unable to open theorem')}><Empty>{tx('可重新读取，或从目录选择其他定理。', 'Try again or choose another theorem from the directory.')}</Empty>
          <button class="button" type="button" data-theorem-detail-retry disabled={detail.loading} aria-busy={detail.loading} onClick={detail.refresh}>{tx('重新读取', 'Try again')}</button></Panel> :
        <p class="research-status" role="status">{tx('正在读取陈述和研究记录。', 'Loading the statement and research records.')}</p>}</div></>
      : collection === 'solved' ? <section class="research-solutions-view research-page-section" aria-labelledby="solved-problems-title">
        <div class="research-solution-tools"><h2 id="solved-problems-title">{tx('已解决的 OpenAI 题目', 'Solved OpenAI problems')}</h2>
          <Search key={`${collection}:${searchReset}`} label={tx('关键词或 Lean 名称', 'Keyword or Lean name')} initial={query} onSearch={value => { setQuery(value); setOffset(0); }} />
          <label class="research-problem-sort"><span>{tx('排列方式', 'Sort problems')}</span><select value={sort} onChange={event => setSort(event.currentTarget.value as ProblemSort)}>
            <option value="newest">{tx('最近完成', 'Latest first')}</option><option value="title">{tx('题目名称', 'Problem title')}</option>
          </select></label></div>
        <OpenAIProblems query={query} area={field} sort={sort} returnHref={browseHref} onArea={setField} onReset={() => {
          setQuery(''); setField(''); setOffset(0); setSearchReset(value => value + 1);
          requestAnimationFrame(() => document.querySelector<HTMLInputElement>('.research-solutions-view input[type="search"]')?.focus());
        }} />
      </section> : <section class="research-discovery research-page-section" aria-labelledby="theorem-directory-title"><div class="research-section-head"><h2 id="theorem-directory-title">{tx('定理目录', 'Theorem directory')}</h2>
        {directory.data && <span class="research-status">{tx(`共 ${directory.data.total ?? directory.data.items.length} 个定理`, `${directory.data.total ?? directory.data.items.length} theorems`)}</span>}</div>
      <div class="research-directory-toolbar">
      <Search key={collection} label={tx('搜索定理与研究描述', 'Search theorems and descriptions')} initial={query} onSearch={value => { setQuery(value); setOffset(0); }} />
      <Field label={tx('按领域筛选', 'Filter by field')} value={field} onInput={value => { setField(value); setOffset(0); }} placeholder={tx('输入研究领域', 'Enter a research field')} /></div>
      <ErrorBox message={directory.error} />{directory.loading && <p class="research-status" role="status">{tx('正在读取…', 'Loading…')}</p>}
      <ul class="research-directory-grid">{directory.data?.items.map(project => {
        const item = new URLSearchParams(browse); item.set('id', project.id);
        const href = researchContextHref(`theorems.html?${item}`, location.search);
        return <li class="research-directory-card" key={project.id}><h3 class="research-card-heading"><a href={href}>{project.title}</a></h3>
          {project.description && <div class="research-card-description"><RichProse text={project.description} /></div>}<Tags values={project.fields} />
          <div class="research-item-meta"><a href={personHref(project.owner.id)}>{project.owner.displayName}</a><State value={project.visibility} />
            <span>{project.currentStatementVersionId ? tx('已有题目陈述', 'Statement available') : tx('待补充题目陈述', 'Statement needed')}</span></div>
          <div class="research-card-footer"><time dateTime={project.updatedAt}>{stamp(project.updatedAt)}</time><a href={href}>{tx('查看定理', 'View theorem')} →</a></div>
        </li>;
      })}</ul>
      {directory.data && !directory.data.items.length && <Empty>{query || field ? tx('暂无匹配的定理。试试其他关键词或领域。', 'No matching theorems. Try another keyword or field.')
        : tx('这里还没有定理。可以创建一个研究题目，邀请同行参与。', 'No theorems yet. Create a research question and invite others to join.')}</Empty>}
      <div class="research-actions">{offset > 0 && <button class="text-button" type="button" onClick={() => setOffset(Math.max(0, offset - 14))}>{tx('上一页', 'Previous')}</button>}
        {directory.data?.nextOffset !== undefined && <button class="text-button" type="button" onClick={() => setOffset(directory.data!.nextOffset!)}>{tx('下一页', 'Next')}</button>}</div>
    </section>}</div></>;
}

function CreateProject({ addResearcher }: { addResearcher?: string }) {
  const [title, setTitle] = useState(''), [description, setDescription] = useState(''), [fields, setFields] = useState(''), [visibility, setVisibility] = useState('private'), action = useMutation();
  return <form class="research-form" onSubmit={event => { event.preventDefault(); void action.run<Item<ResearchProjectSummary>>('POST', `${base}/theorems`,
    { title: title.trim(), description, fields: words(fields), visibility }, result => {
      const member = addResearcher && addResearcher !== result.item.owner.id;
      location.assign(`${theoremHref(result.item.id)}${member ? `&addResearcher=${enc(addResearcher)}#research-members` : '#statement-versions'}`);
    }); }}>
    {addResearcher && <p class="research-field-note">{tx('创建后会打开预填的成员表单，确认保存成员后才会添加。', 'After creation, review the prefilled member form and save it to add the collaborator.')}</p>}
    <Field label={tx('定理名称', 'Theorem title')} value={title} onInput={setTitle} required maxLength={200} />
    <Field label={tx('研究描述', 'Research description')} value={description} onInput={setDescription} multiline rows={3} />
    <Field label={tx('领域，用逗号分隔', 'Fields, separated by commas')} value={fields} onInput={setFields} />
    <Visibility value={visibility} onChange={setVisibility} /><MutationState action={action} />
    <button class="button button-primary" type="submit" disabled={action.busy}>{action.busy ? tx('正在创建…', 'Creating…') : tx('创建定理', 'Create theorem')}</button>
  </form>;
}

function Visibility({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return <label class="research-field">{tx('可见范围', 'Visibility')}<select value={value} onChange={event => onChange(event.currentTarget.value)}>
    <option value="private">{tx('仅自己', 'Private')}</option><option value="members">{tx('项目成员', 'Project members')}</option><option value="public">{tx('公开', 'Public')}</option></select></label>;
}

function Project({ project, context, refresh }: { project: ResearchProjectDetail; context: ResearchContext; refresh: () => void }) {
  const draftOwner = webDraftOwner(context.web);
  const parameters = new URLSearchParams(location.search), initialRun = parameters.get('run') ?? '';
  const [versionChoice, setVersionChoice] = useState(parameters.get('version') ?? project.runs.find(run => run.runId === initialRun)?.statementVersionId ?? project.currentStatementVersionId ?? ''),
    [runChoice, setRunChoice] = useState(initialRun);
  const [taskSelection, setTaskSelection] = useState<CollaborationTaskSelection>(), [taskRequest, setTaskRequest] = useState<(CollaborationTaskSelection & { request: number })>(),
    [feedbackFocus, setFeedbackFocus] = useState<FeedbackFocus>(), [browseTask, setBrowseTask] = useState(0);
  const [issueRequest, setIssueRequest] = useState<{ target?: ResearchFeedbackTarget; sourceFeedbackId?: string; statementVersionId?: string; serial: number }>();
  const openIssue = (target?: ResearchFeedbackTarget, sourceFeedbackId?: string, statementVersionId?: string) => setIssueRequest(previous => ({ target, sourceFeedbackId, statementVersionId, serial: (previous?.serial ?? 0) + 1 }));
  const version = versionChoice ? project.versions.find(item => item.id === versionChoice) : project.versions.at(-1);
  const runs = project.runs.filter(run => run.statementVersionId === version?.id);
  const run = runChoice ? runs.find(item => item.runId === runChoice) : runs[0];
  useEffect(() => {
    if (project.versions.length || !project.permissions.edit || location.hash !== '#statement-versions') return;
    const frame = requestAnimationFrame(() => {
      const statement = document.querySelector<HTMLTextAreaElement>('[data-project-statement-editor] textarea');
      statement?.focus({ preventScroll: true }); statement?.scrollIntoView({ block: 'center' });
    });
    return () => cancelAnimationFrame(frame);
  }, [project.id]);
  useEffect(() => {
    if (location.hash !== '#research-discussion') return;
    const frame = requestAnimationFrame(() => {
      const discussion = document.getElementById('research-discussion');
      discussion?.scrollIntoView({ block: 'start' });
      discussion?.querySelector<HTMLElement>('textarea, [data-discussion-login]')?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [project.id, context.session.authenticated]);
  const remember = (versionId: string, runId?: string) => {
    const next = new URL(location.href); next.searchParams.set('version', versionId); runId ? next.searchParams.set('run', runId) : next.searchParams.delete('run');
    next.searchParams.delete('task'); next.searchParams.delete('taskVersion'); next.searchParams.delete('commit'); next.hash = ''; history.replaceState(null, '', next);
    setTaskRequest(undefined); setTaskSelection(undefined);
  };
  const openTask: OpenFeedbackTask = (target, task) => {
    setVersionChoice(target.statementVersionId); setRunChoice(target.runId);
    setTaskRequest({ runId: target.runId, taskId: task.id, taskVersion: task.version, request: (taskRequest?.request ?? 0) + 1 });
    history.replaceState(null, '', withPeopleReturn(theoremHref(project.id, target.runId, { statementVersionId: target.statementVersionId, taskRef: task }), readPeopleReturn(location.search)));
  };
  const revealFeedback = (id: string) => {
    setFeedbackFocus({ id, request: (feedbackFocus?.request ?? 0) + 1 });
    const next = new URL(location.href); next.hash = `feedback-${enc(id)}`; history.replaceState(null, '', next);
  };
  const openStatement = (versionId: string) => {
    setVersionChoice(versionId); setRunChoice(''); remember(versionId);
    requestAnimationFrame(() => {
      const panel = document.getElementById('statement-versions');
      panel?.scrollIntoView({ block: 'start' }); panel?.querySelector('select')?.focus({ preventScroll: true });
    });
  };
  const selectedTask = taskSelection?.runId === run?.runId ? taskSelection : undefined;
  return <><nav class="research-section-nav" aria-label={tx('定理内容', 'Theorem sections')}>
    <a href="#statement-versions">{tx('题目与陈述', 'Statement')}</a><a href="#research-progress">{tx('研究进展', 'Progress')}</a>
    <a href="#research-discussion">{tx('讨论', 'Discussion')}</a><a href="#research-members">{tx('参与者', 'Participants')}</a><a href="#research-timeline">{tx('活动', 'Activity')}</a></nav>
    <Panel title={tx('研究概况', 'Research overview')} actions={<div class="research-actions">{context.session.authenticated ? <FollowButton kind="theorem" id={project.id} initial={project.following} /> : <a class="button" href={loginHref(location.pathname + location.search + location.hash)}>{tx('登录后关注', 'Sign in to follow')}</a>}<BookmarkControl target={{ kind: 'theorem', projectId: project.id, statementVersionId: version?.id }} context={context} /></div>}>
    <p data-project-candidate-policy>{project.candidateDeliveryPolicy === 'reviewed' ? tx('候选检查通过后，等待人工批准投递。', 'Candidates wait for human approval after passing their check.') : tx('候选检查通过后，直接投递到运行。', 'Candidates are sent to the run after passing their check.')}</p>
    {run && <a class="button" data-open-problem-workspace href={`problem.html?${new URLSearchParams({ run: run.runId, project: project.id, ...(version ? { version: version.id } : {}), ...(selectedTask ? { task: selectedTask.taskId, taskVersion: selectedTask.taskVersion } : {}), ...(parameters.get('commit') ? { commit: parameters.get('commit')! } : {}) })}`}>{tx('在题目工作区继续', 'Continue in the problem workspace')}</a>}
    <div class="research-item-meta"><a href={personHref(project.owner.id)}>{project.owner.displayName}</a><State value={project.visibility} /><span>{stamp(project.updatedAt)}</span></div>
    {project.description && <div class="research-description"><RichProse text={project.description} /></div>}<Tags values={project.fields} />
    <dl class="research-overview-facts"><div><dt>{tx('当前陈述', 'Current statement')}</dt><dd>{version ? `v${project.versions.indexOf(version) + 1}` : tx('待补充', 'Not added yet')}</dd></div>
      <div><dt>{tx('研究运行', 'Research run')}</dt><dd>{run ? <State value={run.status} /> : tx('尚未关联', 'Not attached yet')}</dd></div>
      <div><dt>{tx('参与者', 'Participants')}</dt><dd>{new Set([project.owner.id, ...project.members.map(member => member.researcherId)]).size}</dd></div></dl>
    <div class="research-actions">{run?.permissions.manage ? <a class="button button-primary" href={`./?run=${enc(run.runId)}`}>{tx('继续研究', 'Continue research')}</a>
      : version ? <a class="button button-primary" data-project-start-research href={context.session.authenticated ? projectProblemDraftHref(project.id, version) : loginHref(projectProblemDraftHref(project.id, version))}>{tx('以此陈述开始研究', 'Research this statement')}</a>
        : <a class="button" href="#statement-versions">{tx('查看题目陈述', 'View statement')}</a>}
      {version && !run?.permissions.manage && <a class="text-button" href="#research-progress">{tx('查看研究进展', 'View research progress')}</a>}
      {project.permissions.discuss && <a class="text-button" href="#research-discussion">{tx('参与讨论', 'Join discussion')}</a>}</div>
  </Panel><Panel id="statement-versions" title={tx('题目与陈述', 'Theorem statement')} note={tx('每次研究使用一个明确的陈述版本。', 'Each research run uses a specific statement version.')}>
    {project.versions.length > 0 && <label class="research-field">{tx('当前查看的陈述', 'Statement being viewed')}<select value={version?.id} onChange={event => {
      setVersionChoice(event.currentTarget.value); setRunChoice(''); remember(event.currentTarget.value);
    }}>{project.versions.map((item, index) => <option key={item.id} value={item.id}>{`v${index + 1} · ${item.author.displayName} · ${stamp(item.createdAt)}`}</option>)}</select></label>}
    {version ? <><div class="research-description"><RichProse text={version.statement} /></div><div class="research-item-meta"><span>{version.environment}</span>
      <span>{version.confirmation?.confirmed ? tx('提交者已确认题意', 'Statement confirmed by contributor') : tx('尚未记录题意确认', 'No statement confirmation recorded')}</span></div>
      {version.assumptions?.length ? <><h3>{tx('前提与假设', 'Assumptions')}</h3><ul>{version.assumptions.map((assumption, index) => <li key={index}><RichProse text={assumption} /></li>)}</ul></> : null}
      <details><summary>{tx('Lean 陈述与来源', 'Lean statement and source')}</summary><pre class="research-block-code">{version.source}</pre><dl class="research-facts"><div><dt>{tx('版本 ID', 'Version ID')}</dt><dd>{version.id}</dd></div>
        <div><dt>{tx('源码摘要', 'Source digest')}</dt><dd>{version.sourceDigest}</dd></div>{version.environmentDigest && <div><dt>{tx('环境摘要', 'Environment digest')}</dt><dd>{version.environmentDigest}</dd></div>}</dl></details></>
      : <Empty>{project.versions.length ? tx('所选陈述版本不可用。请从版本列表重新选择。', 'The selected statement version is unavailable. Choose a version from the list.')
        : tx('尚无陈述版本。请先保存自然语言原题和对应 Lean 源码。', 'No statement version yet. Save the original statement and its Lean source first.')}</Empty>}
    {project.permissions.edit && <details data-project-statement-editor open={!project.versions.length || undefined}><summary>{project.versions.length ? tx('添加陈述版本', 'Add a statement version') : tx('添加第一个陈述', 'Add the first statement')}</summary>
      {!project.versions.length && <p class="research-field-note">{tx('题目已创建。下一步填写自然语言原题和 Lean 陈述，保存后即可开始研究。', 'The project is ready. Add the original problem and Lean statement, then save to begin research.')}</p>}
      <StatementEditor draftOwner={draftOwner} project={project} onSaved={item => { setVersionChoice(item.id); setRunChoice(''); remember(item.id); refresh(); }} /></details>}
  </Panel><Panel id="research-progress" title={tx('研究进展与路线', 'Research progress and routes')} note={tx('查看当前版本的研究运行、任务与检查结果。', 'Explore runs, tasks and check results for this statement version.')}>
    {runs.length > 0 ? <><div class="research-run-tools"><label>{tx('选择研究运行', 'Select research run')}<select value={run?.runId} onChange={event => {
      setRunChoice(event.currentTarget.value); if (version) remember(version.id, event.currentTarget.value);
    }}>{!run && <option value="">{tx('请选择可用的运行', 'Choose an available run')}</option>}{runs.map(item => <option key={item.runId} value={item.runId}>{item.title} · {nameOf(item.status)} · {item.owner.displayName}</option>)}</select></label>
      {run && <State value={run.status} />}{run?.permissions.manage && <a class="button" href={`./?run=${enc(run.runId)}`}>{tx('在工作台打开此运行', 'Open this run in the workbench')}</a>}
      {run?.permissions.read && (project.permissions.member || run.permissions.manage) && <><a class="button" href={`workspace.html?tab=brief&run=${enc(run.runId)}&project=${enc(project.id)}`}>{tx('研究简报', 'Research brief')}</a><a class="button" href={`workspace.html?tab=usage&run=${enc(run.runId)}&project=${enc(project.id)}`}>{tx('用量', 'Usage')}</a></>}</div>{run && (run.permissions.read || run.exposure === 'public' ? <RunResearch key={`${run.runId}:${run.permissions.read}`} project={project} selfId={context.session.researcherId ?? ''} binding={run} refreshProject={refresh}
        task={selectedTask} requestedTask={taskRequest} onTaskSelection={setTaskSelection} onBrowseTask={() => setBrowseTask(value => value + 1)} onOpenIssue={target => openIssue(target)} onRevealFeedback={revealFeedback} context={context} />
      : <Empty>{tx('你可以参与题目讨论；此运行尚未授权给你查看。', 'You can join the theorem discussion. This run has not been shared with you.')}</Empty>)}
      {!run && <Empty>{tx('所选运行不可用。请重新选择有权查看的运行。', 'The selected run is unavailable. Choose a run you can access.')}</Empty>}</>
      : <Empty>{runChoice ? tx('所选运行不可用。请重新选择有权查看的运行。', 'The selected run is unavailable. Choose a run you can access.')
        : project.permissions.edit ? tx('当前陈述尚未关联运行。可先以此陈述创建自己的研究，再关联源码和环境一致的运行。', 'No run is attached to this statement. Start your own research from it, then attach a run with matching source and environment.')
          : tx('此版本尚未关联运行。项目维护者关联后，你可以在这里查看进展。', 'No run is attached to this version. Its progress will appear here after a project maintainer attaches one.')}</Empty>}
    {!runs.length && version && <div class="research-actions"><a class="button" data-project-start-research href={context.session.authenticated ? projectProblemDraftHref(project.id, version) : loginHref(projectProblemDraftHref(project.id, version))}>{tx('以此陈述开始研究', 'Research this statement')}</a></div>}
    {project.permissions.edit && version && <details><summary>{tx('关联我的研究运行', 'Attach one of my runs')}</summary><BindRun project={project} version={version} refresh={refresh} onBound={id => { setRunChoice(id); remember(version.id, id); }} /></details>}
  </Panel><Panel id="research-discussion" title={tx('讨论与人工反馈', 'Discussion and human feedback')} note={tx('按运行和节点查看投递、采纳及执行结果。有权限的成员可将讨论转为运行指导，保留原始建议与投递人。', 'Track delivery, decisions and execution by run and node. Authorized members can forward discussions as run guidance, retaining the original suggestion and sender.')}>
    <FeedbackWorkspace project={project} selfId={context.session.researcherId ?? ''} runId={run?.runId} task={selectedTask} refresh={refresh} onOpenTask={openTask} onOpenStatement={openStatement} focus={feedbackFocus} browseTask={browseTask} onRevealFeedback={revealFeedback} focusAnnotationId={new URLSearchParams(location.search).get('annotation') ?? undefined} onOpenIssue={feedback => openIssue(feedback.target, feedback.id, feedback.statementVersionId)}>
      {project.permissions.discuss ? <Discussion project={project} selfId={context.session.researcherId ?? ''} version={version} refresh={refresh} />
        : context.session.authenticated ? <Empty>{tx('当前账号只有查看权限。', 'This account has read access.')}</Empty>
          : <Empty>{tx('登录后可以提出问题、补充思路并查看回复。', 'Sign in to ask questions, share ideas and follow replies.')} {' '}
            <a class="button" data-discussion-login href={loginHref(location.pathname + location.search + '#research-discussion')}>{tx('登录后参与讨论', 'Sign in to join the discussion')}</a></Empty>}
    </FeedbackWorkspace>
    {project.permissions.member && <CollaborationIssues project={project} selfId={context.session.researcherId ?? ''} request={issueRequest} refresh={refresh} onRevealFeedback={revealFeedback} />}
  </Panel><Panel id="research-members" title={tx('参与者', 'Participants')}><CollaborationMembership project={project} selfId={context.session.researcherId ?? ''} refresh={refresh} /><Members project={project} selfId={context.session.researcherId ?? ''} refresh={refresh} /></Panel>
    <Panel id="research-timeline" title={tx('研究时间线', 'Research timeline')}>
      {project.activity.slice().reverse().map(activity => {
        const statementId = activity.statementVersionId ?? project.feedback.find(item => item.id === activity.feedbackId)?.statementVersionId;
        return <article class="research-event" key={activity.id}><div class="research-item-meta"><a href={personHref(activity.actor.id)}>{activity.actor.displayName}</a><time dateTime={activity.createdAt}>{stamp(activity.createdAt)}</time></div>
        <p>{activity.summary}</p><div class="research-actions">{activity.feedbackId && project.feedback.some(item => item.id === activity.feedbackId) && <a class="research-inline-link" href={`#feedback-${enc(activity.feedbackId)}`}
          onClick={event => { event.preventDefault(); revealFeedback(activity.feedbackId!); }}>{tx('查看相关反馈', 'View related feedback')}</a>}
        {activity.runId && <a class="research-inline-link" href={theoremHref(project.id, activity.runId, { statementVersionId: activity.statementVersionId })}>{tx('打开对应运行', 'Open related run')}</a>}
        {statementId && !activity.runId && <a class="research-inline-link" href={`${theoremHref(project.id, undefined, { statementVersionId: statementId })}#statement-versions`}
          onClick={event => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); openStatement(statementId); }}>{tx('查看陈述版本', 'View statement version')} · {project.versions.some(item => item.id === statementId) ? `v${project.versions.findIndex(item => item.id === statementId) + 1}` : statementId}</a>}</div></article>;
      })}
      {!project.activity.length && <Empty>{tx('暂无研究活动。', 'No research activity yet.')}</Empty>}
    </Panel>{project.permissions.manage && <Panel title={tx('题目设置', 'Project settings')}><details><summary>{tx('编辑题目信息', 'Edit project information')}</summary><ProjectEditor project={project} refresh={refresh} /></details></Panel>}</>;
}

function ProjectEditor({ project, refresh }: { project: ResearchProjectDetail; refresh: () => void }) {
  const [title, setTitle] = useState(project.title), [description, setDescription] = useState(project.description), [fields, setFields] = useState(project.fields.join(', ')),
    [visibility, setVisibility] = useState(project.visibility as string), [policy, setPolicy] = useState(project.candidateDeliveryPolicy ?? 'direct'), [revision, setRevision] = useState(project.revision), action = useMutation();
  return <form class="research-form" onSubmit={event => { event.preventDefault(); void action.run<Item<ResearchProjectSummary>>('PATCH', `${base}/theorems/${enc(project.id)}`,
    { title, description, fields: words(fields), visibility, candidateDeliveryPolicy: policy, expectedRevision: revision }, result => { setRevision(result.item.revision); refresh(); }); }}>
    <Field label={tx('名称', 'Title')} value={title} onInput={setTitle} required maxLength={200} /><Field label={tx('描述', 'Description')} value={description} onInput={setDescription} multiline />
    <Field label={tx('领域', 'Fields')} value={fields} onInput={setFields} /><Visibility value={visibility} onChange={setVisibility} />
    <label>{tx('候选投递方式', 'Candidate delivery')}<select data-candidate-policy value={policy} onChange={event => setPolicy(event.currentTarget.value as typeof policy)}><option value="direct">{tx('检查通过后直接投递', 'Send after passing the check')}</option><option value="reviewed">{tx('检查通过后由另一位成员批准', 'Require another member’s approval after the check')}</option></select></label>
    {revision !== project.revision && <p class="research-status">{tx('项目已有更新；载入最新资料后再保存。', 'The project has changed. Load its latest values before saving.')} <button class="text-button" type="button" onClick={() => {
      setTitle(project.title); setDescription(project.description); setFields(project.fields.join(', ')); setVisibility(project.visibility); setPolicy(project.candidateDeliveryPolicy ?? 'direct'); setRevision(project.revision);
    }}>{tx('载入最新', 'Load latest')}</button></p>}
    <MutationState action={action} /><button type="submit" class="button" disabled={action.busy}>{tx('保存题目信息', 'Save project information')}</button>
  </form>;
}

function StatementEditor({ project, onSaved, draftOwner }: { project: ResearchProjectDetail; onSaved: (item: ResearchStatementVersion) => void; draftOwner: string }) {
  const draft = useResearchProjectDraft({ owner: draftOwner, projectId: project.id }, 'statement');
  const { statement, source, environment, assumptions, targets, confirmed, formalizationId, environmentDigest, importedRun } = draft.value;
  const setStatement = (statement: string) => draft.update({ statement }), setSource = (source: string) => draft.update({ source }),
    setEnvironment = (environment: string) => draft.update({ environment: environment as 'standard' | 'mathlib' }),
    setAssumptions = (assumptions: string) => draft.update({ assumptions }), setTargets = (targets: string) => draft.update({ targets }),
    setConfirmed = (confirmed: boolean) => draft.update({ confirmed }), setFormalizationId = (formalizationId?: string) => draft.update({ formalizationId }),
    setEnvironmentDigest = (environmentDigest?: string) => draft.update({ environmentDigest }), setImportedRun = (importedRun: string) => draft.update({ importedRun });
  const action = useMutation();
  const ownRuns = useResource<{ runs: WebRun[] }>('/api/runs');
  const clearOrigin = () => { setImportedRun(''); setFormalizationId(undefined); setEnvironmentDigest(undefined); setConfirmed(false); };
  const importRun = (id: string) => {
    if (!id) { clearOrigin(); return; }
    const run = ownRuns.data?.runs.find(item => item.id === id); if (!run) return;
    setImportedRun(id); setStatement(run.formalization?.original ?? run.task); setSource(run.source); setEnvironment(run.environment);
    setFormalizationId(run.formalizationId); setEnvironmentDigest(run.observation?.inspection.configuration.environmentDigest);
    setAssumptions(run.observation?.inspection.problem.assumptions.join('\n') ?? '');
    setTargets(run.observation?.inspection.problem.targets.map(target => `${target.theoremName} | ${target.proofPath}`).join('\n') ?? ''); setConfirmed(false);
  };
  return <form class="research-form" data-project-statement-draft onSubmit={event => { event.preventDefault();
    const submittedDraftRevision = draft.revision;
    const parsedTargets = lines(targets).map(value => { const [theoremName = '', proofPath = 'Main.lean'] = value.split('|').map(item => item.trim()); return { theoremName, proofPath }; });
    void action.run<Item<ResearchProjectDetail>>('POST', `${base}/theorems/${enc(project.id)}/versions`,
      { statement, source, environment, assumptions: lines(assumptions), ...(parsedTargets.length ? { targets: parsedTargets } : {}), ...(formalizationId ? { formalizationId } : {}),
        ...(environmentDigest ? { environmentDigest } : {}), confirmation: { confirmed }, expectedRevision: project.revision },
      result => { const added = result.item.versions.find(item => item.id === result.item.currentStatementVersionId); if (!added) return;
        if (!draft.clearSubmitted(submittedDraftRevision)) action.setMessage(tx('陈述版本已保存，期间的新编辑已保留。', 'Statement version saved. Your newer edits are preserved.'));
        onSaved(added); });
  }}><label>{tx('从我的已有运行导入原题（可选）', 'Import the statement from one of my runs (optional)')}<select value={importedRun} onChange={event => importRun(event.currentTarget.value)}>
    <option value="">{tx('直接填写新陈述', 'Write a new statement')}</option>{ownRuns.data?.runs.map(run => <option key={run.id} value={run.id}>{run.title} · {nameOf(run.status)}</option>)}</select></label><ErrorBox message={ownRuns.error} />
    <p class="research-field-note" data-project-draft-note>{draft.restored ? tx('已恢复此题目的未发送陈述。', 'Restored your unsent statement for this project.') : tx('未发送内容会在此标签页自动保存。', 'Unsent input is saved automatically in this tab.')}</p>
    <Field label={tx('自然语言 / TeX 原题', 'Original statement / TeX')} value={statement} onInput={value => { setStatement(value); setConfirmed(false); }} multiline required rows={4} />
    <Field label={tx('完整 Lean 源码', 'Complete Lean source')} value={source} onInput={value => { setSource(value); clearOrigin(); }} multiline code required rows={9} />
    <label>{tx('证明环境', 'Proof environment')}<select value={environment} onChange={event => { setEnvironment(event.currentTarget.value); clearOrigin(); }}><option value="mathlib">mathlib</option><option value="standard">Lean standard</option></select></label>
    {formalizationId && <p class="research-field-note">{tx('保留的形式化来源：', 'Preserved formalization source: ')}{formalizationId}</p>}
    <Field label={tx('前提，每行一条', 'Assumptions, one per line')} value={assumptions} onInput={setAssumptions} multiline rows={2} />
    <Field label={tx('目标声明，每行：限定名 | 文件', 'Target declarations, one per line: qualified name | file')} value={targets} onInput={setTargets} multiline code rows={2} placeholder="Main.theorem | Main.lean" />
    <Check label={tx('我已核对自然语言题意与 Lean 陈述一致', 'I have checked that the Lean statement matches the intended problem')} checked={confirmed} onChange={setConfirmed} />
    <MutationState action={action} /><button type="submit" class="button" disabled={action.busy}>{action.busy ? tx('正在保存…', 'Saving…') : tx('保存新版本', 'Save new version')}</button>
  </form>;
}

function BindRun({ project, version, refresh, onBound }: { project: ResearchProjectDetail; version: ResearchStatementVersion; refresh: () => void; onBound: (id: string) => void }) {
  const ownRuns = useResource<{ runs: WebRun[] }>('/api/runs');
  const [selected, setSelected] = useState(''), [exposure, setExposure] = useState('members'),
    [grants, setGrants] = useState({ guidance: false, edit: false, approve: false, proof: false }), action = useMutation();
  const compatible = ownRuns.data?.runs.filter(run => run.source === version.source && run.environment === version.environment && !project.runs.some(binding => binding.runId === run.id)) ?? [];
  return <form class="research-form" onSubmit={event => { event.preventDefault(); if (!selected) return; void action.run('POST', `${base}/theorems/${enc(project.id)}/runs`,
    { runId: selected, statementVersionId: version.id, exposure, grants, expectedRevision: project.revision }, () => { refresh(); onBound(selected); }); }}>
    <ErrorBox message={ownRuns.error} /><label>{tx('与当前陈述源码、环境一致的运行', 'Runs matching this statement source and environment')}<select required value={selected} onChange={event => setSelected(event.currentTarget.value)}>
      <option value="">{tx('选择运行', 'Choose a run')}</option>{compatible.map(run => <option key={run.id} value={run.id}>{run.title} · {nameOf(run.status)}</option>)}</select></label>
    {ownRuns.data && !compatible.length && <p class="research-field-note">{tx('没有匹配的未绑定运行。请在工作台使用此版本的完整源码和环境创建研究。', 'No matching unbound run. Create research in the workbench using this exact source and environment.')}</p>}
    <label>{tx('运行可见范围', 'Run visibility')}<select value={exposure} onChange={event => setExposure(event.currentTarget.value)}><option value="members">{tx('项目成员', 'Project members')}</option><option value="public">{tx('公开', 'Public')}</option></select></label>
    <p class="research-field-note">{tx('协作者可以执行哪些操作：', 'Operations available to collaborators:')}</p>
    {(Object.keys(grants) as (keyof typeof grants)[]).map(key => <Check key={key} label={nameOf(({ guidance: 'guidance', edit: 'plan-edit', approve: 'plan-approval', proof: 'proof-submission' })[key])}
      checked={grants[key]} onChange={value => setGrants(previous => ({ ...previous, [key]: value }))} />)}
    <MutationState action={action} /><button class="button" type="submit" disabled={action.busy || !selected}>{tx('关联运行', 'Attach run')}</button>
  </form>;
}

function RunResearch({ project, selfId, binding, refreshProject, task, requestedTask, onTaskSelection, onBrowseTask, onOpenIssue, onRevealFeedback, context }: {
  project: ResearchProjectDetail; selfId: string; binding: ResearchRunBinding; refreshProject: () => void; task?: CollaborationTaskSelection;
  requestedTask?: CollaborationTaskSelection & { request: number }; onTaskSelection: (task: CollaborationTaskSelection | undefined) => void; onBrowseTask: () => void;
  onOpenIssue(target: ResearchFeedbackTarget): void; onRevealFeedback(id: string): void;
  context: ResearchContext;
}) {
  const projectId = project.id;
  const pinnedCommit = new URLSearchParams(location.search).get('commit') ?? undefined;
  const restoringAccountDraft = new URLSearchParams(location.search).has('accountDraft');
  const root = useRef<HTMLDivElement>(null), view = useRef<CollaborationView>(), taskShown = useRef('');
  const [observed, setObserved] = useState<WebObservation>();
  const [candidateRequest, setCandidateRequest] = useState<{ target: ResearchFeedbackTarget; serial: number }>();
  const observation = useResource<{ run?: WebRun; observation: WebObservation | null; share?: WebShareSnapshot | null; summary?: Pick<WebRun, 'id' | 'title' | 'status'> }>(`${base}/theorems/${enc(projectId)}/runs/${enc(binding.runId)}/observation`, 5000);
  const permissions = useRef({ ...binding.permissions, archive: false }); permissions.current = { ...binding.permissions, archive: false };
  const onChanged = useRef(refreshProject); onChanged.current = refreshProject;
  useEffect(() => {
    const proxy: WebApi = async <T,>(url: string, init?: RequestInit) => {
      const scoped = url.replace(/^\/api\/runs\/([^/]+)(.*)$/u, `${base}/theorems/${enc(projectId)}/runs/$1$2`);
      const result = await api<T>(scoped, init);
      if (init?.method && init.method !== 'GET') onChanged.current();
      return result;
    };
    view.current = new CollaborationView(proxy, next => { setObserved(next); onChanged.current(); });
    const stopSelection = view.current.onTaskSelection(onTaskSelection);
    return () => { stopSelection(); view.current?.dispose(); };
  }, [projectId, binding.runId]);
  const latest = observed && (!observation.data?.observation || observed.sequence > observation.data.observation.sequence) ? observed : observation.data?.observation;
  useEffect(() => {
    if (!view.current || !observation.data?.run || !root.current) return;
    const run = { ...observation.data.run, archives: [], ...(latest ? { observation: latest } : {}) };
    view.current.update(root.current, run, !observation.error, Boolean(pinnedCommit), permissions.current);
    view.current.setTaskFeedback(binding.runId, taskFeedbackAnnotations(project.feedback, binding.runId));
    const parameters = new URLSearchParams(location.search), requested = requestedTask?.runId === binding.runId ? requestedTask : undefined;
    const matchesUrl = parameters.get('run') === binding.runId && (!parameters.has('version') || parameters.get('version') === binding.statementVersionId);
    const taskId = requested?.taskId ?? (matchesUrl ? parameters.get('task') : null), taskVersion = requested?.taskVersion ?? (matchesUrl ? parameters.get('taskVersion') ?? undefined : undefined);
    const commit = requested ? undefined : matchesUrl ? parameters.get('commit') ?? undefined : undefined;
    const key = JSON.stringify([taskId, taskVersion, commit, requested?.request]);
    if (taskId && latest && taskShown.current !== key && view.current.showTask(binding.runId, taskId, taskVersion, commit, !parameters.has('reviewComment'))) taskShown.current = key;
  }, [observation.data, observation.error, latest, binding.permissions, project.feedback, requestedTask]);
  return <><ErrorBox message={observation.error} />{observation.error && observation.data?.run && latest && <p class="research-status">{tx('当前展示上一次成功读取的观测；恢复连接后会继续更新。', 'Showing the last successful observation. Updates resume after reconnection.')}</p>}
    {pinnedCommit && <p class="research-status">{tx('正在查看收藏的固定源码快照。', 'Viewing a saved source snapshot.')} <code>{pinnedCommit}</code> <a class="research-inline-link" href={theoremHref(project.id, binding.runId, { statementVersionId: binding.statementVersionId, ...(task ? { taskRef: { id: task.taskId, version: task.taskVersion } } : {}) })}>{tx('返回当前运行参与研究', 'Return to the current run to participate')}</a></p>}
    {observation.data?.run && latest && <TaskFeedbackContext project={project} runId={binding.runId} task={task} onBrowse={onBrowseTask} />}
    <div class="research-collaboration" ref={root} tabIndex={0} role="region" hidden={!observation.data?.run} aria-label={tx('运行路线与协作', 'Research routes and collaboration')} />
    {!observation.data && !observation.error && <p class="research-status" role="status">{tx('正在读取路线…', 'Loading research routes…')}</p>}
    {observation.data && !observation.data.run && <><p class="research-status">{observation.data.summary?.title} · <State value={observation.data.summary?.status ?? binding.status} /></p>
      {observation.data.share ? <PublicProof share={observation.data.share} /> : <Empty>{tx('当前只展示公开运行概况，尚无已公开的验收证明。', 'The public run summary is available. No accepted proof has been shared yet.')}</Empty>}</>}
    {observation.data?.run && latest && <>{!pinnedCommit && binding.permissions.approve && <ProjectPlanApproval project={project} selfId={selfId} binding={binding} observation={latest} refresh={refreshProject} />}
      <CollaborationTaskWorkspace project={project} selfId={selfId} binding={binding} observation={latest} selectedTask={task} pinnedCommit={pinnedCommit} context={context} refresh={refreshProject} onSubmitCandidate={target => setCandidateRequest(previous => ({ target, serial: (previous?.serial ?? 0) + 1 }))} onSelectTask={(taskId, version) => { view.current?.showTask(binding.runId, taskId, version, pinnedCommit, false); }} onOpenIssue={onOpenIssue} onRevealFeedback={onRevealFeedback} />
      {!pinnedCommit && <HumanParticipation project={project} selfId={selfId} binding={binding} observation={latest} refresh={refreshProject} />}
      {!pinnedCommit && <ResearchWorkImpactView project={project} selfId={selfId} binding={binding} refresh={refreshProject} onRevealFeedback={onRevealFeedback} />}
      {(!pinnedCommit || restoringAccountDraft) && binding.permissions.proof && <ProofSubmission project={project} projectId={projectId} selfId={selfId} binding={binding} observation={latest} refresh={refreshProject} requested={candidateRequest} onSaved={onRevealFeedback} />}</>}
    {binding.permissions.manage && project.permissions.edit && <RunSharing project={project} binding={binding} refresh={refreshProject} />}
  </>;
}

function HumanParticipation({ project, selfId, binding, observation, refresh }: { project: ResearchProjectDetail; selfId: string; binding: ResearchRunBinding; observation: WebObservation; refresh: () => void }) {
  const [target, setTarget] = useState<ResearchFeedbackTarget>(), [status, setStatus] = useState('claimed'), [feedbackId, setFeedbackId] = useState(''), action = useMutation();
  const assignments = project.assignments.filter(item => item.target.runId === binding.runId);
  const targetAvailable = Boolean(target?.taskRef && observation.inspection.tasks.some(task => task.id === target.taskRef!.id && task.version === target.taskRef!.version));
  return <details><summary>{tx('人类参与者与任务认领', 'Human participation and task claims')}</summary>
    {assignments.map(item => <div class="research-event" key={item.id} data-human-assignment-id={item.id}><a href={personHref(item.author.id)}>{item.author.displayName}</a><p>{item.target.taskRef?.id} · {item.target.taskRef?.version.slice(0, 12)} · {item.status === 'claimed' ? tx('已认领', 'Claimed') : item.status === 'released' ? tx('已释放', 'Released') : tx('已提交', 'Submitted')}</p>
      {project.permissions.edit && item.author.id === selfId && item.status === 'claimed' && <button type="button" class="text-button" disabled={action.busy} onClick={() => void action.run('POST', `${base}/theorems/${enc(project.id)}/assignments`,
        { target: item.target, status: 'released', ...(item.feedbackId ? { feedbackId: item.feedbackId } : {}), expectedRevision: project.revision }, refresh)}>{tx('释放此认领', 'Release this claim')}</button>}</div>)}
    {!assignments.length && <Empty>{tx('尚无人认领此运行的任务。', 'No human task claims for this run yet.')}</Empty>}
    {project.permissions.edit && <form class="research-form" onSubmit={event => { event.preventDefault(); if (!target || !targetAvailable) return; void action.run('POST', `${base}/theorems/${enc(project.id)}/assignments`,
      { target, status, ...(feedbackId ? { feedbackId } : {}), expectedRevision: project.revision }, refresh); }}>
      <label>{tx('任务与版本', 'Task and version')}<select required value={target?.taskRef ? `${target.taskRef.id}@${target.taskRef.version}` : ''} onChange={event => {
        const selected = observation.inspection.tasks.find(task => `${task.id}@${task.version}` === event.currentTarget.value);
        setFeedbackId('');
        setTarget(selected ? { runId: binding.runId, statementVersionId: binding.statementVersionId, taskRef: { id: selected.id, version: selected.version }, observationRef: { sequence: observation.sequence, stateDigest: observation.snapshot.stateDigest } } : undefined);
      }}><option value="">{tx('选择精确任务版本', 'Choose an exact task version')}</option>{observation.inspection.tasks.map(task => <option key={`${task.id}@${task.version}`} value={`${task.id}@${task.version}`}>{task.theorem ?? task.id} · {task.version.slice(0, 12)}</option>)}</select></label>
      <label>{tx('参与状态', 'Participation status')}<select value={status} onChange={event => setStatus(event.currentTarget.value)}><option value="claimed">{tx('认领', 'Claim')}</option><option value="released">{tx('释放认领', 'Release claim')}</option><option value="submitted">{tx('记录提交', 'Record submission')}</option></select></label>
      <label>{tx('关联本人反馈（可选）', 'Link my feedback (optional)')}<select value={feedbackId} onChange={event => setFeedbackId(event.currentTarget.value)}><option value="">{tx('不关联', 'No link')}</option>
        {project.feedback.filter(item => item.author.id === selfId && item.target?.runId === binding.runId && item.target?.taskRef?.id === target?.taskRef?.id && item.target?.taskRef?.version === target?.taskRef?.version).map(item => <option key={item.id} value={item.id}>{nameOf(item.kind)} · {item.text.slice(0, 60)}</option>)}</select></label>
      {target && !targetAvailable && <p class="research-status">{tx('任务版本已更新，请重新选择。已有认领可在上方直接释放。', 'The task version changed. Choose again, or release an existing claim above.')}</p>}
      <MutationState action={action} /><button class="button" type="submit" disabled={action.busy || !targetAvailable}>{tx('保存参与状态', 'Save participation')}</button>
    </form>}</details>;
}

function RunSharing({ project, binding, refresh }: { project: ResearchProjectDetail; binding: ResearchRunBinding; refresh: () => void }) {
  const [exposure, setExposure] = useState(binding.exposure), [grants, setGrants] = useState(binding.grants),
    [revision, setRevision] = useState(project.revision), action = useMutation();
  const stale = revision < project.revision;
  return <details><summary>{tx('调整此运行的共享与授权', 'Edit run sharing and permissions')}</summary><form class="research-form" onSubmit={event => {
    event.preventDefault(); if (stale) return; void action.run<Item<ResearchProjectDetail>>('POST', `${base}/theorems/${enc(project.id)}/runs`,
      { runId: binding.runId, statementVersionId: binding.statementVersionId, exposure, grants, expectedRevision: revision }, result => {
        setRevision(result.item.revision); refresh();
      }); }}>
    <label>{tx('可见范围', 'Visibility')}<select value={exposure} onChange={event => setExposure(event.currentTarget.value as 'members' | 'public')}><option value="members">{tx('项目成员', 'Project members')}</option><option value="public">{tx('公开概况与分享结果', 'Public summary and shared results')}</option></select></label>
    {(Object.keys(grants) as (keyof typeof grants)[]).map(key => <Check key={key} label={nameOf(({ guidance: 'guidance', edit: 'plan-edit', approve: 'plan-approval', proof: 'proof-submission' })[key])}
      checked={grants[key]} onChange={value => setGrants(previous => ({ ...previous, [key]: value }))} />)}
    {stale && <p class="research-status" role="status">{tx('项目已有更新。当前输入已保留，请载入最新授权并核对后保存。', 'The project has changed. Your input is preserved. Load and review the latest permissions before saving.')} <button class="text-button" type="button" disabled={action.busy} onClick={() => {
      setExposure(binding.exposure); setGrants(binding.grants); setRevision(project.revision); action.setError(''); action.setMessage('');
    }}>{tx('载入最新授权', 'Load latest permissions')}</button></p>}
    <MutationState action={action} />
    <button class="button" type="submit" disabled={action.busy || stale}>{tx('保存运行授权', 'Save run permissions')}</button></form></details>;
}

function PublicProof({ share }: { share: WebShareSnapshot }) {
  return <><h3>{tx('公开证明与检查', 'Shared proof and checks')}</h3>{share.formalization?.original && <div class="research-description"><RichProse text={share.formalization.original} /></div>}
    {share.checks.map((check, index) => <article class="research-event" key={index}><span class="research-item-title">{check.label} · {check.status}</span>
      {check.method && <p class="research-status">{check.method}</p>}<ul>{check.targets.map(target => <li key={target.name}>{target.name} · {target.status}</li>)}</ul></article>)}
    <details><summary>{tx('已公开的 Lean 证明', 'Shared Lean proof')}</summary><pre class="research-block-code">{share.proof}</pre></details>
    <dl class="research-facts">{share.identity.map(identity => <div key={identity.label}><dt>{identity.label}</dt><dd>{identity.value}</dd></div>)}</dl></>;
}

type CandidateDraft = { source: string; text: string; edited: boolean; needsReview: boolean; baseSource: WebObservation['sources'][number]; baseObservation: { sequence: number; stateDigest: string };
  revisionOf?: { feedbackId: string; expectedRevision: number; responses: { commentId: string; text: string }[] } };
export function ProofSubmission({ project, projectId, selfId, binding, observation, refresh, requested, onSaved }: { project: ResearchProjectDetail; projectId: string; selfId: string; binding: ResearchRunBinding; observation: WebObservation; refresh: () => void;
  requested?: { target: ResearchFeedbackTarget; serial: number }; onSaved(id: string): void }) {
  const parentId = new URLSearchParams(location.search).get('revise'), parent = project.feedback.find(item => item.id === parentId && item.kind === 'proof-submission' && item.author.id === selfId && item.target?.runId === binding.runId);
  const completionKey = `theoremos:candidate-draft-completed:${encodeURIComponent(JSON.stringify([selfId, projectId, binding.runId, binding.statementVersionId, parent?.id ?? '']))}`;
  const [initialDraft] = useState(() => {
    try { const completedThrough = localStorage.getItem(completionKey) ?? '';
      return new ResearchDraftStore(localStorage).list<CandidateDraft>(selfId, projectId, 'candidate').find(item =>
      !item.scope.localRevision && item.updatedAt > completedThrough && item.scope.runId === binding.runId && item.scope.statementVersionId === binding.statementVersionId
      && (item.value.revisionOf?.feedbackId ?? '') === (parent?.id ?? '')); } catch { return; }
  });
  const [source, setSource] = useState(initialDraft?.value.source ?? ''), [text, setText] = useState(initialDraft?.value.text ?? ''),
    [edited, setEdited] = useState(initialDraft?.value.edited ?? false), action = useMutation();
  const [baseSource, setBaseSource] = useState<WebObservation['sources'][number] | undefined>(initialDraft?.value.baseSource),
    [baseObservation, setBaseObservation] = useState<{ sequence: number; stateDigest: string } | undefined>(initialDraft?.value.baseObservation);
  const drafts = useResearchDrafts<CandidateDraft>(selfId, projectId, 'candidate'), [needsReview, setNeedsReview] = useState(initialDraft?.value.needsReview ?? false);
  const [revisionOf, setRevisionOf] = useState<CandidateDraft['revisionOf']>(initialDraft?.value.revisionOf), generation = useRef(0);
  useEffect(() => { if (initialDraft) drafts.restore(initialDraft); }, []);
  const revisionStale = Boolean(parent && revisionOf && revisionOf.expectedRevision !== parent.revision);
  const saveDraft = (next: Partial<CandidateDraft> = {}) => {
    generation.current++;
    const value = { source, text, edited, needsReview, baseSource, baseObservation, ...(revisionOf ? { revisionOf } : {}), ...next };
    if (value.baseSource && value.baseObservation && (value.edited || value.text.trim())) drafts.save({ runId: binding.runId, statementVersionId: binding.statementVersionId,
      taskId: value.baseSource.taskId, taskVersion: value.baseSource.taskVersion, commit: value.baseSource.commit }, value as CandidateDraft, value.text.slice(0, 80) || value.baseSource.taskId);
  };
  const identity = (item: WebObservation['sources'][number]) => JSON.stringify([item.taskId, item.taskVersion, item.file, item.commit, item.sourceDigest, item.environmentDigest]);
  const sources = observation.sources.filter(item => observation.inspection.tasks.some(task => task.id === item.taskId && task.version === item.taskVersion));
  const choice = baseSource ? identity(baseSource) : '', stale = Boolean(baseSource && !sources.some(item => identity(item) === choice));
  const latest = baseSource && sources.find(item => item.taskId === baseSource.taskId && item.file === baseSource.file);
  const pick = (value: string) => {
    const selected = sources.find(item => identity(item) === value); setBaseSource(selected);
    const review = Boolean(edited && selected && (!baseSource || identity(selected) !== identity(baseSource))); setNeedsReview(review);
    if (!edited) setSource(selected?.source ?? '');
    const ref = selected ? { sequence: observation.sequence, stateDigest: observation.snapshot.stateDigest } : undefined; setBaseObservation(ref);
    if (selected) saveDraft({ baseSource: selected, baseObservation: ref, source: edited ? source : selected.source, needsReview: review });
    action.setError(''); action.setMessage('');
  };
  const root = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (!parent || !parent.payload || !('source' in parent.payload) || initialDraft?.value.revisionOf?.feedbackId === parent.id) return;
    const selected = sources.find(item => item.taskId === parent.target?.taskRef?.id);
    if (!selected) return;
    setBaseSource(selected); setBaseObservation({ sequence: observation.sequence, stateDigest: observation.snapshot.stateDigest });
    setSource(parent.payload.source); setText(parent.text); setEdited(true);
    setNeedsReview(selected.commit !== parent.payload.base.commit || selected.taskVersion !== parent.target?.taskRef?.version);
    setRevisionOf({ feedbackId: parent.id, expectedRevision: parent.revision, responses: [] });
    if (root.current) { root.current.open = true; root.current.scrollIntoView({ block: 'start' }); }
  }, [parent?.id]);
  useEffect(() => { if (!requested) return;
    const selected = sources.find(item => item.taskId === requested.target.taskRef?.id && item.taskVersion === requested.target.taskRef?.version);
    if (selected) pick(identity(selected));
    else { setBaseSource(undefined); setBaseObservation(undefined); action.setError(tx('此任务的源码版本已更新，请重新核对候选基准。', 'This task’s source version changed. Review the candidate baseline again.')); }
    if (root.current) { root.current.open = true; root.current.scrollIntoView({ block: 'start' }); root.current.querySelector('select')?.focus({ preventScroll: true }); }
  }, [requested?.serial]);
  return <details ref={root} id="candidate-composer" data-candidate-composer><summary>{parent ? tx('修改候选并重新送审', 'Revise the candidate for another review') : tx('提交候选证明', 'Submit a candidate proof')}</summary>
    <ResearchDraftPicker drafts={drafts} filter={item => item.scope.runId === binding.runId && item.scope.statementVersionId === binding.statementVersionId && (item.value.revisionOf?.feedbackId ?? '') === (parent?.id ?? '')} onRestore={item => {
      const value = item.value; setSource(value.source); setText(value.text); setEdited(value.edited); setBaseSource(value.baseSource); setBaseObservation(value.baseObservation);
      setRevisionOf(value.revisionOf);
      const review = value.needsReview || !sources.some(source => identity(source) === identity(value.baseSource));
      saveDraft({ ...value, needsReview: review });
      setNeedsReview(review); action.reset();
    }} /><form class="research-form" data-project-proof-draft onSubmit={event => {
    event.preventDefault(); if (!baseSource || !baseObservation || stale || needsReview || revisionStale) return;
    const submittedDraft = drafts.current(), submittedGeneration = generation.current;
    void action.run<Item<ResearchFeedback>>('POST', `${base}/theorems/${enc(projectId)}/feedback`, { kind: 'proof-submission', text,
      target: { runId: binding.runId, statementVersionId: binding.statementVersionId, observationRef: baseObservation, taskRef: { id: baseSource.taskId, version: baseSource.taskVersion } },
      source, base: { commit: baseSource.commit, sourceDigest: baseSource.sourceDigest, environmentDigest: baseSource.environmentDigest, file: baseSource.file }, ...(revisionOf ? { revisionOf } : {}) }, result => {
        if (submittedDraft) {
          // Older baselines stay available in the picker, but completing the active
          // editor must not make one of those histories reappear on reload.
          try { if ((localStorage.getItem(completionKey) ?? '') < submittedDraft.updatedAt) localStorage.setItem(completionKey, submittedDraft.updatedAt); } catch { /* Local draft storage reports its own availability. */ }
          void drafts.complete(submittedDraft, { kind: 'feedback', id: result.item.id });
        }
        if (generation.current === submittedGeneration) { setSource(''); setText(''); setEdited(false); setBaseSource(undefined); setBaseObservation(undefined); setNeedsReview(false); setRevisionOf(undefined); generation.current++; }
        refresh(); onSaved(result.item.id);
      });
  }}><label>{tx('选择带有源码快照的任务', 'Select a task with a source snapshot')}<select required value={choice} disabled={action.busy} onChange={event => pick(event.currentTarget.value)}>
    <option value="">{tx('选择任务', 'Choose a task')}</option>{stale && baseSource && <option value={choice}>{baseSource.taskId} · {baseSource.file} · {baseSource.taskVersion} · {t('草稿基准已过期')}</option>}
    {sources.map(item => <option key={identity(item)} value={identity(item)}>{item.taskId} · {item.file} · {item.taskVersion}</option>)}</select></label>
    <p class="research-field-note" data-project-draft-note>{initialDraft ? tx('已恢复此运行的候选草稿和原基准。', 'Restored your candidate draft and original base for this run.') : tx('候选草稿会在此标签页自动保存。', 'Candidate drafts are saved automatically in this tab.')}</p>
    {baseSource && <p class="research-field-note">{t('草稿基准：')}{baseSource.taskId} · {baseSource.taskVersion} · {baseSource.file} · {baseSource.commit.slice(0, 12)}</p>}
    {stale && <div class="research-status" role="status"><p>{t('任务或源码已有更新。旧基准和你的编辑已保留，请先核对最新基准。')}</p>
      {latest ? <button class="button" type="button" disabled={action.busy} onClick={() => pick(identity(latest))}>{t('更新到最新基准，保留编辑')}</button>
        : <p>{t('此任务暂时没有当前版本的源码快照。')}</p>}</div>}
    {needsReview && !stale && <p role="status">{tx('已保留原编辑，请核对源码是否适用于这个基准。', 'Your edits were retained. Review whether the source applies to this baseline.')} <button class="button" type="button" data-confirm-draft-baseline onClick={() => { setNeedsReview(false); saveDraft({ needsReview: false }); }}>{tx('已核对此基准，继续编辑', 'I reviewed this baseline; continue')}</button></p>}
    <Field label={tx('修改后的候选源码', 'Edited candidate source')} value={source} onInput={value => { setEdited(true); setSource(value); saveDraft({ source: value, edited: true }); }} multiline code rows={10} required />
    {edited && <p class="research-field-note">{t('切换基准会保留你编辑的源码，请核对其是否适用于所选任务版本。')}</p>}
    <Field label={tx('修改说明', 'Change description')} value={text} onInput={value => { setText(value); saveDraft({ text: value }); }} multiline rows={2} required />
    {parent && revisionOf && <div data-candidate-revision-responses><p>{tx('逐条回应上一版评审意见', 'Respond to each review comment on the previous version')}</p>{parent.reviewComments?.map(comment => <label key={comment.id}><AnnotationAnchorSummary anchor={comment.anchor} /><RichProse text={comment.text} /><textarea data-revision-response={comment.id} value={revisionOf.responses.find(item => item.commentId === comment.id)?.text ?? ''} required rows={2} maxLength={4000} onInput={event => {
      const next = { ...revisionOf, responses: [...revisionOf.responses.filter(item => item.commentId !== comment.id), { commentId: comment.id, text: event.currentTarget.value }] }; setRevisionOf(next); saveDraft({ revisionOf: next });
    }} /></label>)}</div>}
    {revisionStale && <p role="status">{tx('原候选或评审已有更新，请查看新意见后继续。', 'The previous candidate or review changed. Read the new comments before continuing.')} <button class="button" type="button" onClick={() => { if (parent && revisionOf) { const next = { ...revisionOf, expectedRevision: parent.revision }; setRevisionOf(next); saveDraft({ revisionOf: next }); } }}>{tx('已核对最新评审意见', 'I reviewed the latest comments')}</button></p>}
    <p class="research-field-note">{tx('候选将在隔离环境检查；检查结果和采纳记录分别展示。', 'The candidate is checked in isolation. Check results and adoption records are shown separately.')}</p>
    <MutationState action={action} /><button class="button" type="submit" data-submit-revision={parent ? '' : undefined} disabled={action.busy || !baseSource || stale || needsReview || revisionStale || Boolean(parent?.supersededBy)}>{parent ? tx('提交新修订并检查', 'Submit and check the new revision') : tx('提交检查', 'Submit for checking')}</button>
  </form></details>;
}

export function Discussion({ project, selfId, version, context, refresh }: { project: ResearchProjectDetail; selfId: string; version?: ResearchStatementVersion; context?: ResearchDiscussionContext; refresh: () => void }) {
  const [initialDraft] = useState(() => {
    try { return new ResearchDraftStore(localStorage).list<DiscussionDraft>(selfId, project.id, 'discussion').find(item =>
      !item.scope.localRevision && item.scope.statementVersionId === version?.id && discussionContextKey(item.value.baseline.context) === discussionContextKey(context)); } catch { return; }
  });
  const [text, setText] = useState(initialDraft?.value.text ?? ''), [visibility, setVisibility] = useState<DiscussionDraft['visibility']>(initialDraft?.value.visibility ?? 'members'), action = useMutation();
  const currentBaseline = { statementVersionId: version?.id, sourceDigest: version?.sourceDigest, ...(context ? { context } : {}) };
  const [baseline, setBaseline] = useState<DiscussionDraft['baseline']>(initialDraft?.value.baseline ?? currentBaseline), drafts = useResearchDrafts<DiscussionDraft>(selfId, project.id, 'discussion');
  useEffect(() => { if (initialDraft) drafts.restore(initialDraft); }, []);
  const generation = useRef(0), stale = !discussionDraftMatches({ text, visibility, baseline }, currentBaseline);
  useEffect(() => { if (!text) setBaseline(currentBaseline); }, [version?.id, version?.sourceDigest, discussionContextKey(context)]);
  const canPublishContext = !baseline.context || project.runs.find(run => run.runId === baseline.context!.runId)?.exposure === 'public';
  const saveDraft = (next: Partial<DiscussionDraft>) => {
    generation.current++;
    const value: DiscussionDraft = { text, visibility, baseline, ...next };
    const cited = value.baseline.context;
    if (value.text.trim() || drafts.current()) drafts.save({ statementVersionId: value.baseline.statementVersionId, ...(cited ? { runId: cited.runId,
      taskId: cited.taskRef.id, taskVersion: cited.taskRef.version, ...(cited.commit ? { commit: cited.commit } : {}) } : {}) }, value, value.text.slice(0, 80) || tx('讨论内容', 'Discussion'));
  };
  const versionLabel = (id?: string) => {
    const index = project.versions.findIndex(item => item.id === id);
    return id ? index < 0 ? id : `v${index + 1}` : tx('整个定理', 'Entire theorem');
  };
  return <form class="research-form" data-discussion-composer onSubmit={event => { event.preventDefault();
    if (stale || visibility === 'public' && !canPublishContext) return;
    if (text.length > 4000) { action.setError(t('讨论最多 4000 字符，请缩短后保存。')); return; }
    const submittedDraft = drafts.current(), submittedGeneration = generation.current;
    void action.run<Item<ResearchFeedback>>('POST', `${base}/theorems/${enc(project.id)}/feedback`,
    { kind: 'discussion', text, visibility, ...(baseline.statementVersionId ? { statementVersionId: baseline.statementVersionId } : {}), ...(baseline.context ? { context: baseline.context } : {}) }, result => {
      if (submittedDraft) void drafts.complete(submittedDraft, { kind: 'feedback', id: result.item.id });
      if (generation.current === submittedGeneration) { setText(''); generation.current++; }
      refresh();
    }); }}>
    <ResearchDraftPicker drafts={drafts} onRestore={item => { setText(item.value.text); setVisibility(item.value.visibility); setBaseline(item.value.baseline); generation.current++; action.reset(); }} />
    <p class="research-field-note" data-project-draft-note>{initialDraft ? tx('已恢复未发送的讨论。', 'Restored your unsent discussion.') : tx('讨论草稿会在此标签页自动保存。', 'Discussion drafts are saved automatically in this tab.')}</p>
    {baseline.context && <DiscussionContext projectId={project.id} value={baseline.context} />}
    {stale && <div role="status" data-discussion-draft-baseline><p>{tx('草稿基于其他陈述或源码版本，请先核对。', 'This draft uses another statement or source version. Review it before continuing.')}</p>
      <p>{tx('草稿：', 'Draft: ')}{versionLabel(baseline.statementVersionId)} · {tx('当前：', 'Current: ')}{versionLabel(currentBaseline.statementVersionId)}</p>
      <button class="button" type="button" data-confirm-discussion-baseline disabled={action.busy} onClick={() => { setBaseline(currentBaseline); saveDraft({ baseline: currentBaseline }); action.reset(); }}>{context || baseline.context ? tx('已核对，改为当前讨论范围', 'Reviewed; use the current discussion scope') : tx('已核对，使用当前陈述', 'Reviewed; use the current statement')}</button></div>}
    <Field label={tx('讨论内容', 'Discussion')} value={text} onInput={value => { setText(value); saveDraft({ text: value }); }} multiline required rows={3} maxLength={4000}
      note={`${t('最多 4000 字符。')} ${text.length} / 4000`} />
    <div class="research-actions"><label>{tx('可见范围', 'Visibility')}<select value={visibility} onChange={event => { const value = event.currentTarget.value as DiscussionDraft['visibility']; setVisibility(value); saveDraft({ visibility: value }); }}><option value="members">{project.permissions.member ? tx('项目成员', 'Members') : tx('项目成员和我', 'Project members and me')}</option>
      {(project.visibility === 'public' || visibility === 'public') && <option value="public" disabled={!canPublishContext}>{tx('公开', 'Public')}</option>}</select></label><button class="button" type="submit" disabled={action.busy || stale || visibility === 'public' && !canPublishContext}>{tx('保存讨论', 'Save discussion')}</button></div><MutationState action={action} />
    {!canPublishContext && <p>{tx('引用的运行仅向项目成员开放，这条步骤讨论也保留在项目内。', 'The referenced run is available to project members, so this step discussion stays within the project.')}</p>}
    {!project.permissions.member && <p class="research-field-note">{tx('选择“项目成员和我”时，你可以回看自己的讨论和处理结果，其他访客不可见。', 'With “Project members and me”, you can revisit your discussion and its handling. Other visitors cannot see it.')}</p>}
  </form>;
}

function Members({ project, selfId, refresh }: { project: ResearchProjectDetail; selfId: string; refresh: () => void }) {
  const directory = useResource<Items<ResearcherProfile>>(project.permissions.manage ? `${base}/people?limit=100` : undefined);
  const requested = new URLSearchParams(location.search).get('addResearcher') ?? '';
  const [person, setPerson] = useState(project.permissions.manage && /^[A-Za-z0-9_-]{1,128}$/u.test(requested) && requested !== project.owner.id ? requested : ''),
    [role, setRole] = useState('collaborator'), [shareConfirmed, setShareConfirmed] = useState(false), action = useMutation();
  const memberInput = useRef<HTMLInputElement>(null);
  const needsVisibilityConfirmation = project.visibility === 'private';
  useEffect(() => setShareConfirmed(false), [project.id, project.revision, project.visibility]);
  useEffect(() => {
    if (!project.permissions.manage || !requested || !person) return;
    const frame = requestAnimationFrame(() => { memberInput.current?.focus({ preventScroll: true }); memberInput.current?.scrollIntoView({ block: 'center' }); });
    return () => cancelAnimationFrame(frame);
  }, []);
  const write = (id: string, memberRole: string | null) => {
    if (memberRole && needsVisibilityConfirmation && !shareConfirmed) {
      action.setError(tx('请先确认将题目改为项目成员可见。', 'Confirm that the project may become visible to its members.')); return;
    }
    void action.run('PUT', `${base}/theorems/${enc(project.id)}/members/${enc(id)}`,
    { role: memberRole, expectedRevision: project.revision, ...(memberRole && needsVisibilityConfirmation ? { confirmMembersVisibility: true } : {}) }, () => {
      if (memberRole !== null && id === person) {
        const next = new URL(location.href); next.searchParams.delete('addResearcher'); history.replaceState(null, '', next); setPerson('');
      }
      refresh();
    });
  };
  return <>{project.permissions.manage && needsVisibilityConfirmation && <div data-member-visibility-confirmation>
    <p>{tx('添加成员时，需要将题目从“仅自己”改为“项目成员”可见。', 'Adding a member will change this project from Private to Members.')}</p>
    <label class="research-check"><input type="checkbox" data-confirm-member-visibility checked={shareConfirmed} onChange={event => setShareConfirmed(event.currentTarget.checked)} />
      {tx('我同意让项目成员阅读题目及已向成员共享的内容。', 'I agree that project members may read the project and content shared with members.')}</label>
  </div>}<ul class="research-list"><li class="research-list-item"><span class="research-item-title"><a href={personHref(project.owner.id)}>{project.owner.displayName}</a></span><span class="research-item-meta">{tx('发起者', 'Owner')}</span></li>
    {project.members.map(member => <li class="research-list-item" key={member.researcherId} data-project-member={member.researcherId}><span class="research-item-title">{member.profileVisible ? <a href={personHref(member.researcherId)}>{member.displayName ?? member.researcherId}</a> : <span>{member.displayName ?? member.researcherId}</span>}{member.researcherId === selfId ? ` · ${tx('我', 'Me')}` : ''}</span>
      <div class="research-item-meta">{project.permissions.manage ? <label>{tx('角色', 'Role')}<select data-member-role={member.researcherId} value={member.role} disabled={action.busy || needsVisibilityConfirmation && !shareConfirmed} onChange={event => write(member.researcherId, event.currentTarget.value)}><option value="collaborator">{tx('协作者', 'Collaborator')}</option><option value="reader">{tx('只读成员', 'Reader')}</option></select></label> : <span>{member.role === 'reader' ? tx('只读成员', 'Reader') : tx('协作者', 'Collaborator')}</span>}{project.permissions.manage && <button class="text-button" type="button" disabled={action.busy} onClick={() => write(member.researcherId, null)}>{tx('移除成员', 'Remove member')}</button>}</div></li>)}</ul>
    {requested && !project.permissions.manage && <p class="research-status" role="status">{tx('当前账号不能添加成员，请联系项目发起者。', 'This account cannot add members. Contact the project owner.')}</p>}
    {project.permissions.manage && <form class="research-form" data-project-member-form onSubmit={event => { event.preventDefault(); if (person) write(person, role); }}><h3>{tx('添加或调整成员', 'Add or update a member')}</h3>
      <label>{tx('数学家', 'Mathematician')}<input ref={memberInput} data-project-member-person value={person} list="research-people" onInput={event => setPerson(event.currentTarget.value)} required placeholder={tx('选择或填写数学家 ID', 'Choose or enter researcher ID')} /></label>
      <datalist id="research-people">{directory.data?.items.filter(item => item.id !== project.owner.id).map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}</datalist>
      <label>{tx('角色', 'Role')}<select value={role} onChange={event => setRole(event.currentTarget.value)}><option value="collaborator">{tx('协作者', 'Collaborator')}</option><option value="reader">{tx('只读成员', 'Reader')}</option></select></label>
      <ErrorBox message={directory.error} /><MutationState action={action} /><button class="button" type="submit" disabled={action.busy || needsVisibilityConfirmation && !shareConfirmed}>{tx('保存成员', 'Save member')}</button>
    </form>}</>;
}
