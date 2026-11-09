import { useEffect, useRef, useState } from 'preact/hooks';
import type { ResearchFeedbackTarget, ResearchProjectDetail, ResearchProjectSummary, ResearchRunBinding, ResearchStatementVersion, ResearcherProfile } from '../researchProjectTypes';
import type { WebRun } from '../shared';
import type { WebShareSnapshot } from '../share';
import type { WebObservation } from '../collaboration';
import type { WebApi } from './collaborationUi';
import { CollaborationView, type CollaborationTaskSelection } from './collaborationView';
import { FeedbackWorkspace, TaskFeedbackContext, type FeedbackFocus, type OpenFeedbackTask } from './researchFeedback';
import { taskFeedbackAnnotations } from './researchFeedbackModel';
import { RichProse } from './richText';
import { api, base, Check, enc, Empty, ErrorBox, Field, FollowButton, lines, MutationState, nameOf, Panel, personHref, Search,
  stamp, State, Tags, theoremHref, tx, useMutation, useResource, words, type Item, type Items, type ResearchContext } from './researchShared';

export function TheoremsPage({ context }: { context: ResearchContext }) {
  const selected = new URLSearchParams(location.search).get('id') ?? '';
  const [query, setQuery] = useState(''), [field, setField] = useState(''), [offset, setOffset] = useState(0);
  const directory = useResource<Items<ResearchProjectSummary>>(`${base}/theorems?q=${enc(query)}&field=${enc(field)}&offset=${offset}&limit=14`);
  const detail = useResource<Item<ResearchProjectDetail>>(selected ? `${base}/theorems/${enc(selected)}` : undefined, 8000);
  return <><div class="research-heading"><div><span class="research-eyebrow">TheoremOS / Theorems</span><h1>{tx('围绕同一个定理协作', 'Work together on a theorem')}</h1>
    <p>{tx('陈述、研究路线与每次反馈都保留明确的版本和来源。', 'Statements, research routes and feedback retain their versions and sources.')}</p></div>
    <div class="research-heading-actions"><a class="button" href="./">{tx('打开研究工作台', 'Open research workbench')}</a></div></div>
    <div class="research-layout" data-selected={Boolean(selected)}><aside class="research-sidebar"><Panel title={tx('定理目录', 'Theorem directory')}><div class="research-form">
      <Search label={tx('搜索定理与研究描述', 'Search theorems and descriptions')} onSearch={value => { setQuery(value); setOffset(0); }} />
      <Field label={tx('按领域筛选', 'Filter by field')} value={field} onInput={value => { setField(value); setOffset(0); }} /></div><ErrorBox message={directory.error} />
      <ul class="research-list">{directory.data?.items.map(project => <li key={project.id}><a class="research-list-item" href={theoremHref(project.id)} aria-current={project.id === selected ? 'true' : undefined}>
        <span class="research-item-title">{project.title}</span><span class="research-item-meta"><span>{project.owner.displayName}</span><span>{nameOf(project.visibility)}</span></span></a></li>)}</ul>
      {directory.data && !directory.data.items.length && <Empty>{tx('暂无匹配的定理。', 'No matching theorems.')}</Empty>}
      <div class="research-actions">{offset > 0 && <button class="text-button" type="button" onClick={() => setOffset(Math.max(0, offset - 14))}>{tx('上一页', 'Previous')}</button>}
        {directory.data?.nextOffset !== undefined && <button class="text-button" type="button" onClick={() => setOffset(directory.data!.nextOffset!)}>{tx('下一页', 'Next')}</button>}</div>
    </Panel><Panel title={tx('建立研究题目', 'Create a research project')}>{context.session.authenticated ? <details open={!selected}><summary>{tx('新建定理', 'New theorem')}</summary><CreateProject /></details>
      : <a class="button" href="login.html">{tx('登录后创建定理', 'Sign in to create a theorem')}</a>}</Panel></aside>
      <div class="research-content"><ErrorBox message={detail.error} />{detail.data ? <Project key={selected} project={detail.data.item} context={context} refresh={detail.refresh} /> :
        <Panel title={selected ? tx('正在读取定理…', 'Loading theorem…') : tx('选择一道定理', 'Choose a theorem')}><Empty>{selected ? tx('正在读取陈述和研究记录。', 'Loading the statement and research records.') : tx('从目录打开研究，或创建一个定理并添加首个陈述版本。', 'Open a project from the directory, or create a theorem and add its first statement version.')}</Empty></Panel>}</div></div></>;
}

function CreateProject() {
  const [title, setTitle] = useState(''), [description, setDescription] = useState(''), [fields, setFields] = useState(''), [visibility, setVisibility] = useState('private'), action = useMutation();
  return <form class="research-form" onSubmit={event => { event.preventDefault(); void action.run<Item<ResearchProjectSummary>>('POST', `${base}/theorems`,
    { title: title.trim(), description, fields: words(fields), visibility }, result => location.assign(theoremHref(result.item.id))); }}>
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
  const parameters = new URLSearchParams(location.search), initialRun = parameters.get('run') ?? '';
  const [versionChoice, setVersionChoice] = useState(parameters.get('version') ?? project.runs.find(run => run.runId === initialRun)?.statementVersionId ?? project.currentStatementVersionId ?? ''),
    [runChoice, setRunChoice] = useState(initialRun);
  const [taskSelection, setTaskSelection] = useState<CollaborationTaskSelection>(), [taskRequest, setTaskRequest] = useState<(CollaborationTaskSelection & { request: number })>(),
    [feedbackFocus, setFeedbackFocus] = useState<FeedbackFocus>(), [browseTask, setBrowseTask] = useState(0);
  const version = versionChoice ? project.versions.find(item => item.id === versionChoice) : project.versions.at(-1);
  const runs = project.runs.filter(run => run.statementVersionId === version?.id);
  const run = runChoice ? runs.find(item => item.runId === runChoice) : runs[0];
  const remember = (versionId: string, runId?: string) => {
    const next = new URL(location.href); next.searchParams.set('version', versionId); runId ? next.searchParams.set('run', runId) : next.searchParams.delete('run');
    next.searchParams.delete('task'); next.searchParams.delete('taskVersion'); next.hash = ''; history.replaceState(null, '', next);
    setTaskRequest(undefined); setTaskSelection(undefined);
  };
  const openTask: OpenFeedbackTask = (target, task) => {
    setVersionChoice(target.statementVersionId); setRunChoice(target.runId);
    setTaskRequest({ runId: target.runId, taskId: task.id, taskVersion: task.version, request: (taskRequest?.request ?? 0) + 1 });
    history.replaceState(null, '', theoremHref(project.id, target.runId, { statementVersionId: target.statementVersionId, taskRef: task }));
  };
  const revealFeedback = (id: string) => {
    setFeedbackFocus({ id, request: (feedbackFocus?.request ?? 0) + 1 });
    const next = new URL(location.href); next.hash = `feedback-${enc(id)}`; history.replaceState(null, '', next);
  };
  const selectedTask = taskSelection?.runId === run?.runId ? taskSelection : undefined;
  return <><Panel title={project.title} actions={context.session.authenticated ? <FollowButton kind="theorem" id={project.id} initial={project.following} /> : <a class="button" href="login.html">{tx('登录后关注', 'Sign in to follow')}</a>}>
    <div class="research-item-meta"><a href={personHref(project.owner.id)}>{project.owner.displayName}</a><State value={project.visibility} /><span>{stamp(project.updatedAt)}</span></div>
    {project.description && <div class="research-description"><RichProse text={project.description} /></div>}<Tags values={project.fields} />
    {project.permissions.manage && <details><summary>{tx('编辑题目信息', 'Edit project information')}</summary><ProjectEditor project={project} refresh={refresh} /></details>}
  </Panel><Panel title={tx('陈述版本', 'Statement versions')} note={tx('陈述保存后不可覆盖，每次运行绑定具体版本。', 'Saved statements are immutable. Every run is bound to one version.')}>
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
    {project.permissions.edit && <details><summary>{tx('添加陈述版本', 'Add a statement version')}</summary><StatementEditor project={project} onSaved={item => { setVersionChoice(item.id); setRunChoice(''); remember(item.id); refresh(); }} /></details>}
  </Panel><Panel title={tx('研究运行与路线', 'Research runs and routes')} note={tx('每次运行保留自己的任务图、检查证据和干预记录。', 'Each run retains its task graph, check evidence and intervention records.')}>
    {runs.length > 0 ? <><div class="research-run-tools"><label>{tx('选择研究运行', 'Select research run')}<select value={run?.runId} onChange={event => {
      setRunChoice(event.currentTarget.value); if (version) remember(version.id, event.currentTarget.value);
    }}>{!run && <option value="">{tx('请选择可用的运行', 'Choose an available run')}</option>}{runs.map(item => <option key={item.runId} value={item.runId}>{item.title} · {nameOf(item.status)} · {item.owner.displayName}</option>)}</select></label>
      {run && <State value={run.status} />}{run?.permissions.manage && <a class="button" href={`./?run=${enc(run.runId)}`}>{tx('在工作台打开此运行', 'Open this run in the workbench')}</a>}</div>{run && (run.permissions.read || run.exposure === 'public' ? <RunResearch key={`${run.runId}:${run.permissions.read}`} project={project} selfId={context.session.researcherId ?? ''} binding={run} refreshProject={refresh}
        task={selectedTask} requestedTask={taskRequest} onTaskSelection={setTaskSelection} onBrowseTask={() => setBrowseTask(value => value + 1)} />
      : <Empty>{tx('你可以参与题目讨论；此运行尚未授权给你查看。', 'You can join the theorem discussion. This run has not been shared with you.')}</Empty>)}
      {!run && <Empty>{tx('所选运行不可用。请重新选择有权查看的运行。', 'The selected run is unavailable. Choose a run you can access.')}</Empty>}</>
      : <Empty>{runChoice ? tx('所选运行不可用。请重新选择有权查看的运行。', 'The selected run is unavailable. Choose a run you can access.')
        : tx('当前陈述尚未关联运行。在工作台创建研究后，选择绑定到此版本。', 'No run is attached to this statement. Create a run in the workbench, then bind it to this version.')}</Empty>}
    {project.permissions.edit && version && <details><summary>{tx('关联我的研究运行', 'Attach one of my runs')}</summary><BindRun project={project} version={version} refresh={refresh} onBound={id => { setRunChoice(id); remember(version.id, id); }} /></details>}
  </Panel><Panel title={tx('讨论与人工反馈', 'Discussion and human feedback')} note={tx('按运行和节点查看投递、采纳及执行结果。有权限的成员可将讨论转为运行指导，保留原始建议与投递人。', 'Track delivery, decisions and execution by run and node. Authorized members can forward discussions as run guidance, retaining the original suggestion and sender.')}>
    <FeedbackWorkspace project={project} selfId={context.session.researcherId ?? ''} runId={run?.runId} task={selectedTask} refresh={refresh} onOpenTask={openTask} focus={feedbackFocus} browseTask={browseTask} onRevealFeedback={revealFeedback}>
      {project.permissions.discuss ? <Discussion project={project} version={version} refresh={refresh} /> : <Empty>{tx('当前账号只有查看权限。', 'This account has read access.')}</Empty>}
    </FeedbackWorkspace>
  </Panel><Panel title={tx('参与者', 'Participants')}><Members project={project} selfId={context.session.researcherId ?? ''} refresh={refresh} /></Panel>
    <Panel title={tx('研究时间线', 'Research timeline')}>
      {project.activity.slice().reverse().map(activity => <article class="research-event" key={activity.id}><div class="research-item-meta"><a href={personHref(activity.actor.id)}>{activity.actor.displayName}</a><time dateTime={activity.createdAt}>{stamp(activity.createdAt)}</time></div>
        <p>{activity.summary}</p><div class="research-actions">{activity.feedbackId && project.feedback.some(item => item.id === activity.feedbackId) && <a class="research-inline-link" href={`#feedback-${enc(activity.feedbackId)}`}
          onClick={event => { event.preventDefault(); revealFeedback(activity.feedbackId!); }}>{tx('查看相关反馈', 'View related feedback')}</a>}
        {activity.runId && <a class="research-inline-link" href={theoremHref(project.id, activity.runId, { statementVersionId: activity.statementVersionId })}>{tx('打开对应运行', 'Open related run')}</a>}</div></article>)}
      {!project.activity.length && <Empty>{tx('暂无研究活动。', 'No research activity yet.')}</Empty>}
    </Panel></>;
}

function ProjectEditor({ project, refresh }: { project: ResearchProjectDetail; refresh: () => void }) {
  const [title, setTitle] = useState(project.title), [description, setDescription] = useState(project.description), [fields, setFields] = useState(project.fields.join(', ')),
    [visibility, setVisibility] = useState(project.visibility as string), [revision, setRevision] = useState(project.revision), action = useMutation();
  return <form class="research-form" onSubmit={event => { event.preventDefault(); void action.run<Item<ResearchProjectSummary>>('PATCH', `${base}/theorems/${enc(project.id)}`,
    { title, description, fields: words(fields), visibility, expectedRevision: revision }, result => { setRevision(result.item.revision); refresh(); }); }}>
    <Field label={tx('名称', 'Title')} value={title} onInput={setTitle} required maxLength={200} /><Field label={tx('描述', 'Description')} value={description} onInput={setDescription} multiline />
    <Field label={tx('领域', 'Fields')} value={fields} onInput={setFields} /><Visibility value={visibility} onChange={setVisibility} />
    {revision !== project.revision && <p class="research-status">{tx('项目已有更新；载入最新资料后再保存。', 'The project has changed. Load its latest values before saving.')} <button class="text-button" type="button" onClick={() => {
      setTitle(project.title); setDescription(project.description); setFields(project.fields.join(', ')); setVisibility(project.visibility); setRevision(project.revision);
    }}>{tx('载入最新', 'Load latest')}</button></p>}
    <MutationState action={action} /><button type="submit" class="button" disabled={action.busy}>{tx('保存题目信息', 'Save project information')}</button>
  </form>;
}

function StatementEditor({ project, onSaved }: { project: ResearchProjectDetail; onSaved: (item: ResearchStatementVersion) => void }) {
  const [statement, setStatement] = useState(''), [source, setSource] = useState(''), [environment, setEnvironment] = useState('mathlib'),
    [assumptions, setAssumptions] = useState(''), [targets, setTargets] = useState(''), [confirmed, setConfirmed] = useState(false),
    [formalizationId, setFormalizationId] = useState<string>(), [environmentDigest, setEnvironmentDigest] = useState<string>(), [importedRun, setImportedRun] = useState(''), action = useMutation();
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
  return <form class="research-form" onSubmit={event => { event.preventDefault();
    const parsedTargets = lines(targets).map(value => { const [theoremName = '', proofPath = 'Main.lean'] = value.split('|').map(item => item.trim()); return { theoremName, proofPath }; });
    void action.run<Item<ResearchProjectDetail>>('POST', `${base}/theorems/${enc(project.id)}/versions`,
      { statement, source, environment, assumptions: lines(assumptions), ...(parsedTargets.length ? { targets: parsedTargets } : {}), ...(formalizationId ? { formalizationId } : {}),
        ...(environmentDigest ? { environmentDigest } : {}), confirmation: { confirmed }, expectedRevision: project.revision },
      result => { const added = result.item.versions.find(item => item.id === result.item.currentStatementVersionId); if (!added) return;
        setStatement(''); setSource(''); setAssumptions(''); setTargets(''); clearOrigin(); onSaved(added); });
  }}><label>{tx('从我的已有运行导入原题（可选）', 'Import the statement from one of my runs (optional)')}<select value={importedRun} onChange={event => importRun(event.currentTarget.value)}>
    <option value="">{tx('直接填写新陈述', 'Write a new statement')}</option>{ownRuns.data?.runs.map(run => <option key={run.id} value={run.id}>{run.title} · {nameOf(run.status)}</option>)}</select></label><ErrorBox message={ownRuns.error} />
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

function RunResearch({ project, selfId, binding, refreshProject, task, requestedTask, onTaskSelection, onBrowseTask }: {
  project: ResearchProjectDetail; selfId: string; binding: ResearchRunBinding; refreshProject: () => void; task?: CollaborationTaskSelection;
  requestedTask?: CollaborationTaskSelection & { request: number }; onTaskSelection: (task: CollaborationTaskSelection | undefined) => void; onBrowseTask: () => void;
}) {
  const projectId = project.id;
  const root = useRef<HTMLDivElement>(null), view = useRef<CollaborationView>(), taskShown = useRef('');
  const [observed, setObserved] = useState<WebObservation>();
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
    view.current.update(root.current, run, !observation.error, false, permissions.current);
    view.current.setTaskFeedback(binding.runId, taskFeedbackAnnotations(project.feedback, binding.runId));
    const parameters = new URLSearchParams(location.search), requested = requestedTask?.runId === binding.runId ? requestedTask : undefined;
    const matchesUrl = parameters.get('run') === binding.runId && (!parameters.has('version') || parameters.get('version') === binding.statementVersionId);
    const taskId = requested?.taskId ?? (matchesUrl ? parameters.get('task') : null), taskVersion = requested?.taskVersion ?? (matchesUrl ? parameters.get('taskVersion') ?? undefined : undefined);
    const key = JSON.stringify([taskId, taskVersion, requested?.request]);
    if (taskId && latest && taskShown.current !== key && view.current.showTask(binding.runId, taskId, taskVersion)) taskShown.current = key;
  }, [observation.data, observation.error, latest, binding.permissions, project.feedback, requestedTask]);
  return <><ErrorBox message={observation.error} />{observation.error && <p class="research-status">{tx('当前展示上一次成功读取的观测；恢复连接后会继续更新。', 'Showing the last successful observation. Updates resume after reconnection.')}</p>}
    {observation.data?.run && latest && <TaskFeedbackContext project={project} runId={binding.runId} task={task} onBrowse={onBrowseTask} />}
    <div class="research-collaboration" ref={root} tabIndex={0} role="region" hidden={Boolean(observation.data && !observation.data.run)} aria-label={tx('运行路线与协作', 'Research routes and collaboration')} />
    {!observation.data && !observation.error && <p class="research-status" role="status">{tx('正在读取路线…', 'Loading research routes…')}</p>}
    {observation.data && !observation.data.run && <><p class="research-status">{observation.data.summary?.title} · <State value={observation.data.summary?.status ?? binding.status} /></p>
      {observation.data.share ? <PublicProof share={observation.data.share} /> : <Empty>{tx('当前只展示公开运行概况，尚无已公开的验收证明。', 'The public run summary is available. No accepted proof has been shared yet.')}</Empty>}</>}
    {observation.data?.run && latest && <>{binding.permissions.approve && <PlanApproval projectId={projectId} binding={binding} observation={latest} refresh={refreshProject} />}
      <HumanParticipation project={project} selfId={selfId} binding={binding} observation={latest} refresh={refreshProject} />
      {binding.permissions.proof && <ProofSubmission projectId={projectId} binding={binding} observation={latest} refresh={refreshProject} />}</>}
    {binding.permissions.manage && project.permissions.edit && <RunSharing project={project} binding={binding} refresh={refreshProject} />}
  </>;
}

function PlanApproval({ projectId, binding, observation, refresh }: { projectId: string; binding: ResearchRunBinding; observation: WebObservation; refresh: () => void }) {
  const approval = observation.inspection.planApproval, action = useMutation();
  const [pending, setPending] = useState<Record<string, unknown>>();
  if (approval?.status !== 'pending' && !pending) return null;
  const submit = () => {
    const input = pending ?? { kind: 'plan-approval', text: tx('批准已核对的研究计划', 'Approve the reviewed research plan'), planVersion: approval?.planVersion,
      target: { runId: binding.runId, statementVersionId: binding.statementVersionId, observationRef: { sequence: observation.sequence, stateDigest: observation.snapshot.stateDigest } } };
    setPending(input); void action.run('POST', `${base}/theorems/${enc(projectId)}/feedback`, input, () => { setPending(undefined); refresh(); });
  };
  return <div class="research-publication"><p class="research-status">{tx('等待批准计划：', 'Plan awaiting approval: ')}{approval?.planVersion}</p>
    <button class="button" type="button" disabled={action.busy} onClick={submit}>{action.error ? tx('重试原计划批准', 'Retry the original approval') : tx('批准此版本并继续研究', 'Approve this version and continue')}</button><MutationState action={action} /></div>;
}

function HumanParticipation({ project, selfId, binding, observation, refresh }: { project: ResearchProjectDetail; selfId: string; binding: ResearchRunBinding; observation: WebObservation; refresh: () => void }) {
  const [target, setTarget] = useState<ResearchFeedbackTarget>(), [status, setStatus] = useState('claimed'), [feedbackId, setFeedbackId] = useState(''), action = useMutation();
  const assignments = project.assignments.filter(item => item.target.runId === binding.runId);
  return <details><summary>{tx('人类参与者与任务认领', 'Human participation and task claims')}</summary>
    {assignments.map(item => <div class="research-event" key={item.id}><a href={personHref(item.author.id)}>{item.author.displayName}</a><p>{item.target.taskRef?.id} · {item.target.taskRef?.version.slice(0, 12)} · {item.status === 'claimed' ? tx('已认领', 'Claimed') : item.status === 'released' ? tx('已释放', 'Released') : tx('已提交', 'Submitted')}</p></div>)}
    {!assignments.length && <Empty>{tx('尚无人认领此运行的任务。', 'No human task claims for this run yet.')}</Empty>}
    {project.permissions.edit && <form class="research-form" onSubmit={event => { event.preventDefault(); if (!target) return; void action.run('POST', `${base}/theorems/${enc(project.id)}/assignments`,
      { target, status, ...(feedbackId ? { feedbackId } : {}), expectedRevision: project.revision }, refresh); }}>
      <label>{tx('任务与版本', 'Task and version')}<select required value={target?.taskRef ? `${target.taskRef.id}@${target.taskRef.version}` : ''} onChange={event => {
        const selected = observation.inspection.tasks.find(task => `${task.id}@${task.version}` === event.currentTarget.value);
        setTarget(selected ? { runId: binding.runId, statementVersionId: binding.statementVersionId, taskRef: { id: selected.id, version: selected.version }, observationRef: { sequence: observation.sequence, stateDigest: observation.snapshot.stateDigest } } : undefined);
      }}><option value="">{tx('选择精确任务版本', 'Choose an exact task version')}</option>{observation.inspection.tasks.map(task => <option key={`${task.id}@${task.version}`} value={`${task.id}@${task.version}`}>{task.theorem ?? task.id} · {task.version.slice(0, 12)}</option>)}</select></label>
      <label>{tx('参与状态', 'Participation status')}<select value={status} onChange={event => setStatus(event.currentTarget.value)}><option value="claimed">{tx('认领', 'Claim')}</option><option value="released">{tx('释放认领', 'Release claim')}</option><option value="submitted">{tx('记录提交', 'Record submission')}</option></select></label>
      <label>{tx('关联本人反馈（可选）', 'Link my feedback (optional)')}<select value={feedbackId} onChange={event => setFeedbackId(event.currentTarget.value)}><option value="">{tx('不关联', 'No link')}</option>
        {project.feedback.filter(item => item.author.id === selfId && item.target?.runId === binding.runId && item.target?.taskRef?.id === target?.taskRef?.id && item.target?.taskRef?.version === target?.taskRef?.version).map(item => <option key={item.id} value={item.id}>{nameOf(item.kind)} · {item.text.slice(0, 60)}</option>)}</select></label>
      <MutationState action={action} /><button class="button" type="submit" disabled={action.busy || !target}>{tx('保存参与状态', 'Save participation')}</button>
    </form>}</details>;
}

function RunSharing({ project, binding, refresh }: { project: ResearchProjectDetail; binding: ResearchRunBinding; refresh: () => void }) {
  const [exposure, setExposure] = useState(binding.exposure), [grants, setGrants] = useState(binding.grants), action = useMutation();
  return <details><summary>{tx('调整此运行的共享与授权', 'Edit run sharing and permissions')}</summary><form class="research-form" onSubmit={event => { event.preventDefault(); void action.run('POST', `${base}/theorems/${enc(project.id)}/runs`,
    { runId: binding.runId, statementVersionId: binding.statementVersionId, exposure, grants, expectedRevision: project.revision }, refresh); }}>
    <label>{tx('可见范围', 'Visibility')}<select value={exposure} onChange={event => setExposure(event.currentTarget.value as 'members' | 'public')}><option value="members">{tx('项目成员', 'Project members')}</option><option value="public">{tx('公开概况与分享结果', 'Public summary and shared results')}</option></select></label>
    {(Object.keys(grants) as (keyof typeof grants)[]).map(key => <Check key={key} label={nameOf(({ guidance: 'guidance', edit: 'plan-edit', approve: 'plan-approval', proof: 'proof-submission' })[key])}
      checked={grants[key]} onChange={value => setGrants(previous => ({ ...previous, [key]: value }))} />)}<MutationState action={action} />
    <button class="button" type="submit" disabled={action.busy}>{tx('保存运行授权', 'Save run permissions')}</button></form></details>;
}

function PublicProof({ share }: { share: WebShareSnapshot }) {
  return <><h3>{tx('公开证明与检查', 'Shared proof and checks')}</h3>{share.formalization?.original && <div class="research-description"><RichProse text={share.formalization.original} /></div>}
    {share.checks.map((check, index) => <article class="research-event" key={index}><span class="research-item-title">{check.label} · {check.status}</span>
      {check.method && <p class="research-status">{check.method}</p>}<ul>{check.targets.map(target => <li key={target.name}>{target.name} · {target.status}</li>)}</ul></article>)}
    <details><summary>{tx('已公开的 Lean 证明', 'Shared Lean proof')}</summary><pre class="research-block-code">{share.proof}</pre></details>
    <dl class="research-facts">{share.identity.map(identity => <div key={identity.label}><dt>{identity.label}</dt><dd>{identity.value}</dd></div>)}</dl></>;
}

function ProofSubmission({ projectId, binding, observation, refresh }: { projectId: string; binding: ResearchRunBinding; observation: WebObservation; refresh: () => void }) {
  const [choice, setChoice] = useState(''), [source, setSource] = useState(''), [text, setText] = useState(''), action = useMutation();
  const [baseSource, setBaseSource] = useState<WebObservation['sources'][number]>(), [baseObservation, setBaseObservation] = useState<{ sequence: number; stateDigest: string }>();
  const pick = (index: string) => {
    setChoice(index); const selected = index === '' ? undefined : observation.sources[Number(index)]; setBaseSource(selected); setSource(selected?.source ?? '');
    setBaseObservation({ sequence: observation.sequence, stateDigest: observation.snapshot.stateDigest });
  };
  return <details><summary>{tx('提交候选证明', 'Submit a candidate proof')}</summary><form class="research-form" onSubmit={event => {
    event.preventDefault(); if (!baseSource || !baseObservation) return;
    void action.run('POST', `${base}/theorems/${enc(projectId)}/feedback`, { kind: 'proof-submission', text,
      target: { runId: binding.runId, statementVersionId: binding.statementVersionId, observationRef: baseObservation, taskRef: { id: baseSource.taskId, version: baseSource.taskVersion } },
      source, base: { commit: baseSource.commit, sourceDigest: baseSource.sourceDigest, environmentDigest: baseSource.environmentDigest, file: baseSource.file } }, refresh);
  }}><label>{tx('选择带有源码快照的任务', 'Select a task with a source snapshot')}<select required value={choice} onChange={event => pick(event.currentTarget.value)}>
    <option value="">{tx('选择任务', 'Choose a task')}</option>{observation.sources.map((item, index) => <option key={`${item.taskId}:${item.taskVersion}:${index}`} value={index}>{item.taskId} · {item.file} · {item.taskVersion.slice(0, 12)}</option>)}</select></label>
    <Field label={tx('修改后的候选源码', 'Edited candidate source')} value={source} onInput={setSource} multiline code rows={10} required />
    <Field label={tx('修改说明', 'Change description')} value={text} onInput={setText} multiline rows={2} required />
    <p class="research-field-note">{tx('候选将在隔离环境检查；检查结果和采纳记录分别展示。', 'The candidate is checked in isolation. Check results and adoption records are shown separately.')}</p>
    <MutationState action={action} /><button class="button" type="submit" disabled={action.busy || !baseSource}>{tx('提交检查', 'Submit for checking')}</button>
  </form></details>;
}

function Discussion({ project, version, refresh }: { project: ResearchProjectDetail; version?: ResearchStatementVersion; refresh: () => void }) {
  const [text, setText] = useState(''), [visibility, setVisibility] = useState('members'), action = useMutation();
  return <form class="research-form" onSubmit={event => { event.preventDefault(); void action.run('POST', `${base}/theorems/${enc(project.id)}/feedback`,
    { kind: 'discussion', text, visibility, ...(version ? { statementVersionId: version.id } : {}) }, () => { setText(''); refresh(); }); }}>
    <Field label={tx('讨论内容', 'Discussion')} value={text} onInput={setText} multiline required rows={3} maxLength={16000} />
    <div class="research-actions"><label>{tx('可见范围', 'Visibility')}<select value={visibility} onChange={event => setVisibility(event.currentTarget.value)}><option value="members">{tx('项目成员', 'Members')}</option>
      {project.visibility === 'public' && <option value="public">{tx('公开', 'Public')}</option>}</select></label><button class="button" type="submit" disabled={action.busy}>{tx('保存讨论', 'Save discussion')}</button></div><MutationState action={action} />
  </form>;
}

function Members({ project, selfId, refresh }: { project: ResearchProjectDetail; selfId: string; refresh: () => void }) {
  const directory = useResource<Items<ResearcherProfile>>(project.permissions.manage ? `${base}/people?limit=100` : undefined);
  const [person, setPerson] = useState(''), [role, setRole] = useState('collaborator'), action = useMutation();
  const displayName = (id: string) => directory.data?.items.find(item => item.id === id)?.displayName ?? id;
  const write = (id: string, memberRole: string | null) => void action.run('PUT', `${base}/theorems/${enc(project.id)}/members/${enc(id)}`,
    { role: memberRole, expectedRevision: project.revision }, refresh);
  return <><ul class="research-list"><li class="research-list-item"><span class="research-item-title"><a href={personHref(project.owner.id)}>{project.owner.displayName}</a></span><span class="research-item-meta">{tx('发起者', 'Owner')}</span></li>
    {project.members.map(member => <li class="research-list-item" key={member.researcherId}><span class="research-item-title"><a href={personHref(member.researcherId)}>{displayName(member.researcherId)}</a>{member.researcherId === selfId ? ` · ${tx('我', 'Me')}` : ''}</span>
      <div class="research-item-meta"><span>{member.role === 'reader' ? tx('只读成员', 'Reader') : tx('协作者', 'Collaborator')}</span>{project.permissions.manage && <button class="text-button" type="button" disabled={action.busy} onClick={() => write(member.researcherId, null)}>{tx('移除成员', 'Remove member')}</button>}</div></li>)}</ul>
    {project.permissions.manage && <form class="research-form" onSubmit={event => { event.preventDefault(); if (person) write(person, role); }}><h3>{tx('添加或调整成员', 'Add or update a member')}</h3>
      <label>{tx('数学家', 'Mathematician')}<input value={person} list="research-people" onInput={event => setPerson(event.currentTarget.value)} required placeholder={tx('选择或填写数学家 ID', 'Choose or enter researcher ID')} /></label>
      <datalist id="research-people">{directory.data?.items.filter(item => item.id !== project.owner.id).map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}</datalist>
      <label>{tx('角色', 'Role')}<select value={role} onChange={event => setRole(event.currentTarget.value)}><option value="collaborator">{tx('协作者', 'Collaborator')}</option><option value="reader">{tx('只读成员', 'Reader')}</option></select></label>
      <ErrorBox message={directory.error} /><MutationState action={action} /><button class="button" type="submit" disabled={action.busy}>{tx('保存成员', 'Save member')}</button>
    </form>}</>;
}
