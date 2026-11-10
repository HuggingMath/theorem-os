import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ResearchJourney, ResearchJourneyAttempt, ResearchJourneyRecord, ResearchJourneySource, ResearchJourneySourceRef, ResearchChangeRecordLink, ResearchUnreadChanges } from '../researchJourneyTypes';
import type { SolutionRoute, SolutionRouteNode, SolutionRouteStatus } from '../solutionRoute';
import type { ResearchBriefTask } from '../researchWorkspaceTypes';
import { locale, localizeMessage } from '../i18n';
import { Rich, RichProse } from './richText';
import { SolutionRouteGraph } from './ui/SolutionRouteGraph';
import { base, enc, Empty, ErrorBox, MutationState, Panel, stamp, tx, useMutation, useResource, type Item } from './researchShared';
import './researchJourney.css';

type Props = { runId: string; projectId?: string };
const endpoint = (run: string, project: string | undefined, section: string) =>
  `${base}/workspace/problem/${enc(run)}/${section}${project ? `?project=${enc(project)}` : ''}`;
const sourceEndpoint = (ref: ResearchJourneySourceRef) => `${endpoint(ref.runId, ref.projectId, 'journey/source')}${ref.projectId ? '&' : '?'}${new URLSearchParams({
  task: ref.taskId, taskVersion: ref.taskVersion, commit: ref.commit, sourceDigest: ref.sourceDigest, environmentDigest: ref.environmentDigest, file: ref.file })}`;
const attemptId = (run: string) => `journey-attempt:${enc(run)}`;
const taskId = (run: string, task: string) => `journey-task:${enc(run)}:${enc(task)}`;
const sourceId = (ref: ResearchJourneySourceRef) => `journey-source:${enc(ref.runId)}:${enc(ref.taskId)}:${enc(ref.taskVersion)}:${ref.commit}:${ref.sourceDigest}:${ref.environmentDigest}`;
const taskState = (task: ResearchBriefTask): SolutionRouteStatus => task.checks.some(check => check.passed) ? 'passed'
  : task.proofStatus === 'conditional' ? 'conditional' : task.proofStatus === 'failed' || task.checks.some(check => !check.passed) ? 'failed'
    : ['working', 'running'].includes(task.status) ? 'running' : 'recorded';
const journeyStatus = (value: string, language = locale) => {
  const tx = (zh: string, en: string) => language === 'en' ? en : zh;
  return ({ queued: tx('排队中', 'Queued'), running: tx('研究中', 'Researching'), completed: tx('已结束', 'Finished'),
    failed: tx('未能完成', 'Failed to finish'), error: tx('运行出错', 'Run error'), cancelled: tx('已取消', 'Cancelled'),
    limit_reached: tx('用完本次预算', 'Attempt budget used'), incomplete: tx('仍有待证步骤', 'Proof steps remain'),
    evaluated_passed: tx('独立验收通过', 'Independently accepted'), evaluated_failed: tx('独立验收未通过', 'Independent acceptance failed'),
    evaluated_rejected: tx('独立验收未通过', 'Independent acceptance failed'), 'not-started': tx('尚未提交证明', 'No proof submitted'),
    pending: tx('等待检查', 'Awaiting a check'), verified: tx('检查通过', 'Check passed'), passed: tx('检查通过', 'Check passed'),
    conditional: tx('还有未解除的前提', 'Conditions remain'), authentication: tx('模型认证未通过', 'Model authentication failed'),
    integrated: tx('已整合', 'Integrated'), checked: tx('检查通过', 'Check passed'), recorded: tx('已记录', 'Recorded'),
    applied: tx('已执行', 'Applied'), delivered: tx('已送达', 'Delivered'), accepted: tx('已采纳', 'Accepted'),
    declined: tx('未采纳', 'Declined'), 'not-recorded': tx('尚无决定记录', 'No decision recorded'),
    rate_limit: tx('模型服务限流', 'Model rate limit reached'), network: tx('模型连接中断', 'Model connection interrupted'),
    budget: tx('模型额度不足', 'Model credit unavailable'), time_limit: tx('用完本次时间预算', 'Time budget used'),
    environment: tx('证明环境未就绪', 'Proof environment unavailable'), source: tx('原题源码未通过检查', 'Original source failed its check'),
    protocol: tx('模型响应未能解析', 'Model response could not be read'), interrupted: tx('运行已中断', 'Run interrupted'),
    unknown: tx('未记录具体原因', 'No specific reason recorded'),
  } as Record<string, string>)[value] ?? localizeMessage(value);
};

/** Only saved continuation sources draw an edge between attempts. */
export function researchJourneyModel(journey: ResearchJourney, language: 'zh' | 'en', expanded: ReadonlySet<string>): SolutionRoute {
  const tx = (zh: string, en: string) => language === 'en' ? en : zh;
  const nodes: SolutionRouteNode[] = [{ id: 'journey-root', kind: 'problem', title: journey.title, status: 'recorded',
    summary: tx('整道题的尝试、分支与续跑来源', 'Attempts, branches and recorded continuation sources') }];
  const edges: SolutionRoute['edges'] = [];
  for (const attempt of journey.attempts) {
    const inherited = journey.lineage.filter(edge => edge.toRunId === attempt.id);
    nodes.push({ id: attemptId(attempt.id), kind: 'attempt', title: attempt.title,
      status: attempt.accepted ? 'passed' : attempt.failure || attempt.status === 'failed' ? 'failed' : ['running', 'queued'].includes(attempt.status) ? 'running' : 'recorded',
      at: attempt.createdAt, summary: `${attempt.tasks.length} ${tx('个步骤', 'steps')} · ${journeyStatus(attempt.status, language)}`,
      sections: [{ title: tx('这次尝试的原题', 'Problem for this attempt'), text: attempt.statement },
        { title: tx('独立验收', 'Independent acceptance'), text: attempt.accepted ? tx('Lean 陈述证明通过', 'Lean statement accepted') : tx('尚未通过独立验收', 'Not independently accepted') },
        ...(attempt.failure ? [{ title: tx('尝试结束原因', 'Attempt failure'), text: journeyStatus(attempt.failure, language) }] : []),
        ...inherited.map(edge => ({ title: tx('保存的续跑来源', 'Saved continuation source'), text: `${edge.taskId} · ${edge.commit}\n${edge.status === 'recorded'
          ? tx('来源任务与源码版本已定位', 'Source task and source version located') : edge.status === 'ambiguous' ? tx('这个引用对应多个保存版本，无法确定', 'The reference matches multiple saved versions') : tx('来源记录未保存或已不可访问', 'The source was not saved or is no longer accessible')}` }))],
      action: { label: tx('展开这次尝试', 'Expand this attempt'), target: attemptId(attempt.id) } });
    edges.push({ from: 'journey-root', to: attemptId(attempt.id), kind: 'reference' });
    if (!expanded.has(attempt.id)) continue;
    for (const item of attempt.tasks) {
      const task = item.task;
      nodes.push({ id: taskId(attempt.id, task.id), kind: 'task', title: task.title, status: taskState(task),
        summary: task.statement ?? task.objective,
        sections: [{ title: tx('目标', 'Objective'), text: task.objective },
          { title: tx('前提', 'Premises'), text: task.premises.join('\n') || tx('未另行记录', 'No separate premises recorded') },
          { title: tx('怎样推出', 'Derivation'), text: task.derivation ?? tx('这个版本未保存逐步推导', 'No step-by-step derivation was saved for this version') },
          ...(task.finding ? [{ title: tx('得到的结论', 'Finding'), text: task.finding }] : []),
          ...(task.feedback ? [{ title: tx('反馈与阻碍', 'Feedback and blockers'), text: task.feedback }] : []),
          { title: tx('任务版本', 'Task version'), text: task.version, code: true }],
        ...(item.source ? { source: { name: item.source.file, sha256: item.source.sourceDigest, commit: item.source.commit },
          action: { label: tx('查看这一版本源码', 'Read this source version'), target: sourceId(item.source) } } : {}) });
      edges.push({ from: attemptId(attempt.id), to: taskId(attempt.id, task.id), kind: 'reference' });
      for (const dependency of task.dependsOn) if (attempt.tasks.some(other => other.task.id === dependency))
        edges.push({ from: taskId(attempt.id, dependency), to: taskId(attempt.id, task.id), kind: 'dependency' });
    }
  }
  for (const edge of journey.lineage) {
    if (!edge.source) {
      if (journey.attempts.some(attempt => attempt.id === edge.fromRunId)) edges.push({ from: attemptId(edge.fromRunId), to: attemptId(edge.toRunId), kind: 'reference' });
      continue;
    }
    const id = sourceId(edge.source);
    if (!nodes.some(node => node.id === id)) nodes.push({ id, kind: 'proof', status: 'recorded',
      title: edge.task?.title ?? edge.taskId, summary: tx('续跑引用的固定源码版本', 'Frozen source version referenced by continuation'),
      sections: [{ title: tx('任务版本', 'Task version'), text: edge.source.taskVersion, code: true },
        { title: 'Commit', text: edge.source.commit, code: true }, { title: tx('前提', 'Premises'), text: edge.task?.premises.join('\n') ?? '' },
        { title: tx('当时的推导', 'Derivation in this version'), text: edge.task?.derivation ?? '' }],
      source: { name: edge.source.file, sha256: edge.source.sourceDigest, commit: edge.source.commit },
      action: { label: tx('查看所继承的源码版本', 'Read inherited source version'), target: id } });
    edges.push({ from: attemptId(edge.fromRunId), to: id, kind: 'reference' }, { from: id, to: attemptId(edge.toRunId), kind: 'reference' });
    const current = journey.attempts.find(attempt => attempt.id === edge.fromRunId)?.tasks.find(item => item.source && sourceId(item.source) === id);
    if (current && expanded.has(edge.fromRunId)) edges.push({ from: taskId(edge.fromRunId, current.task.id), to: id, kind: 'evidence' });
  }
  return { schema: 'theoremos.solution-route.v1', id: `research-journey:${journey.key}:${journey.selectedRunId}`, title: journey.title,
    locale: language, basis: 'recorded', nodes, edges, initial: attemptId(journey.selectedRunId), partial: journey.attempts.some(attempt => !attempt.tasks.length) };
}

function SourceReader({ reference, close }: { reference: ResearchJourneySourceRef; close(): void }) {
  const resource = useResource<Item<ResearchJourneySource>>(sourceEndpoint(reference)), item = resource.data?.item;
  const heading = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
  useEffect(() => { heading.current?.focus(); }, [reference]);
  useEffect(() => () => { if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true }); }, []);
  return <section class="journey-source-reader" data-journey-source-reader>
    <header><h3 ref={heading} tabIndex={-1}>{tx('固定版本源码', 'Frozen source version')}</h3><button class="button" type="button" onClick={close}>{tx('关闭源码', 'Close source')}</button></header>
    <ErrorBox message={resource.error} />{resource.error && <button class="button" type="button" onClick={resource.refresh}>{tx('重新读取', 'Try again')}</button>}
    {!item && !resource.error && <p role="status">{tx('正在读取所选版本…', 'Loading the selected version…')}</p>}
    {item && <><SourceIdentity reference={item.ref} />{item.task?.statement && <RichProse text={item.task.statement} />}
      {item.task?.premises.length ? <section><h4>{tx('这个版本的前提', 'Premises in this version')}</h4><RichProse text={item.task.premises.join('\n')} /></section> : null}
      {item.task?.derivation && <section><h4>{tx('这个版本的推导', 'Derivation in this version')}</h4><RichProse text={item.task.derivation} /></section>}
      <p>{item.source.file}</p><pre tabIndex={0} aria-label={tx('固定版本 Lean 源码', 'Frozen Lean source')}><code>{item.source.source}</code></pre>
      {(item.source.dependencySources ?? []).length > 0 && <details><summary>{tx('同一快照的依赖文件', 'Dependency files from the same snapshot')}</summary>
        {item.source.dependencySources!.map(file => <section key={file.file}><h4>{file.file}</h4><pre tabIndex={0}><code>{file.source}</code></pre></section>)}</details>}</>}
  </section>;
}
function SourceIdentity({ reference }: { reference: ResearchJourneySourceRef }) {
  return <dl class="journey-identity"><dt>{tx('任务版本', 'Task version')}</dt><dd><code>{reference.taskVersion}</code></dd>
    <dt>Commit</dt><dd><code>{reference.commit}</code></dd><dt>{tx('源码摘要', 'Source digest')}</dt><dd><code>{reference.sourceDigest}</code></dd>
    <dt>{tx('环境摘要', 'Environment digest')}</dt><dd><code>{reference.environmentDigest}</code></dd></dl>;
}
function TaskDetail({ attempt, selected, select, open }: { attempt: ResearchJourneyAttempt; selected: string; select(id: string): void; open(ref: ResearchJourneySourceRef): void }) {
  const item = attempt.tasks.find(item => item.task.id === selected);
  if (!item) return null;
  const { task } = item, related = (ids: string[]) => ids.map(id => {
    const next = attempt.tasks.find(item => item.task.id === id)?.task;
    return next ? <button type="button" class="text-button" key={id} onClick={() => select(id)}><Rich text={next.title} /> →</button>
      : <span key={id}>{id} · {tx('这个版本中未保存', 'Not saved in this version')}</span>;
  });
  return <article class="journey-task-detail" data-journey-task-detail={task.id} data-task-version={task.version}>
    <h3><Rich text={task.title} /></h3><RichProse text={task.statement ?? task.objective} />
    <div class="journey-connections"><section><h4>{tx('从哪里来', 'Prerequisites')}</h4>{task.dependsOn.length ? related(task.dependsOn) : <p>{tx('从原题与所列前提出发', 'Starts from the problem and the premises below')}</p>}</section>
      <section><h4>{tx('接到哪一步', 'Used by')}</h4>{item.dependents.length ? related(item.dependents) : <p>{tx('当前计划未记录后续依赖', 'No later dependency is recorded in this plan')}</p>}</section></div>
    {task.premises.length > 0 && <section><h4>{tx('所用前提', 'Premises')}</h4>{task.premises.map((premise, index) => <RichProse key={index} text={premise} />)}</section>}
    <section><h4>{tx('这一步怎样推出', 'Derivation')}</h4><RichProse text={task.derivation ?? tx('这个任务版本未保存逐步推导。', 'No step-by-step derivation was saved for this task version.')} /></section>
    {task.finding && <section><h4>{tx('得到的结论', 'Finding')}</h4><RichProse text={task.finding} /></section>}
    {task.feedback && <section><h4>{tx('反馈与阻碍', 'Feedback and blockers')}</h4><RichProse text={task.feedback} /></section>}
    <section><h4>{tx('这一版本的检查', 'Checks for this version')}</h4>{task.checks.length ? task.checks.map(check => {
      const receipt = attempt.checks.find(item => item.id === check.id);
      return <details key={check.id} data-journey-check={check.id}><summary>{check.passed ? tx('检查通过', 'Check passed') : tx('检查未通过', 'Check failed')} · {check.id}</summary>
        {receipt && <pre tabIndex={0}><code>{JSON.stringify(receipt.record, null, 2)}</code></pre>}</details>;
    }) : <p>{tx('没有匹配此任务、源码和环境的检查回执。', 'No check receipt matches this task, source and environment.')}</p>}</section>
    <div class="research-actions"><a class="button button-primary" data-journey-participate href={`problem.html?${new URLSearchParams({ run: attempt.id,
      ...(attempt.projectId ? { project: attempt.projectId } : {}), tab: 'route', task: task.id, taskVersion: task.version, ...(task.commit ? { commit: task.commit } : {}) })}`}>
      {tx('进入这一步参与研究', 'Participate in this step')} →</a>
    {item.source ? <button class="button" type="button" data-journey-open-source onClick={() => open(item.source!)}>{tx('查看这一版本源码', 'Read this source version')} →</button>
      : <p class="research-status">{item.sourceStatus === 'ambiguous' ? tx('保存了多个源码身份，无法唯一定位。', 'Multiple source identities were saved; this version cannot be uniquely located.') : tx('这个任务版本没有可读取的源码记录。', 'This task version has no readable source record.')}</p>}
    </div>
  </article>;
}

export function ResearchJourneyView({ runId, projectId }: Props) {
  const resource = useResource<Item<ResearchJourney>>(endpoint(runId, projectId, 'journey'), 15_000), journey = resource.data?.item;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([runId])), [selection, setSelection] = useState(attemptId(runId));
  const [source, setSource] = useState<ResearchJourneySourceRef>();
  useEffect(() => { setExpanded(new Set([runId])); setSelection(attemptId(runId)); setSource(undefined); }, [runId, projectId]);
  const model = useMemo(() => journey ? researchJourneyModel(journey, locale, expanded) : undefined, [journey, expanded]);
  const chosen = journey?.attempts.find(attempt => selection === attemptId(attempt.id) || attempt.tasks.some(item => taskId(attempt.id, item.task.id) === selection))
    ?? journey?.attempts.find(attempt => attempt.id === runId);
  const selectedTask = chosen?.tasks.find(item => taskId(chosen.id, item.task.id) === selection)?.task.id;
  const chooseAttempt = (id: string) => { setSelection(attemptId(id)); setExpanded(previous => new Set([...previous, id])); };
  const open = (target: string) => {
    const attempt = journey?.attempts.find(attempt => attemptId(attempt.id) === target);
    if (attempt) { chooseAttempt(attempt.id); return; }
    const source = [...(journey?.attempts.flatMap(attempt => attempt.tasks.flatMap(item => item.source ? [item.source] : [])) ?? []),
      ...(journey?.lineage.flatMap(edge => edge.source ? [edge.source] : []) ?? [])].find(ref => sourceId(ref) === target);
    if (source) setSource(source);
  };
  return <Panel title={tx('全局研究图', 'Research journey')} id="research-journey">
    <div data-research-journey><ErrorBox message={resource.error} />{resource.error && <button class="button" type="button" onClick={resource.refresh}>{tx('重新读取', 'Try again')}</button>}
    {!journey && !resource.error && <p role="status">{tx('正在读取历次尝试与续跑来源…', 'Loading attempts and continuation sources…')}</p>}
    {journey && model && <><p>{journey.attempts.length} {tx('次尝试', 'attempts')} · {journey.lineage.filter(edge => edge.status === 'recorded').length} {tx('条已定位的续跑关系', 'resolved continuation links')}</p>
      <div class="journey-attempt-picker" role="group" aria-label={tx('选择并展开尝试', 'Select and expand an attempt')}>{journey.attempts.map((attempt, index) => <button class="journey-attempt-button" type="button" key={attempt.id}
        data-journey-attempt={attempt.id} aria-pressed={chosen?.id === attempt.id} onClick={() => chooseAttempt(attempt.id)}><span>{String(index + 1).padStart(2, '0')}</span><strong><Rich text={attempt.title} /></strong>
        <small>{attempt.accepted ? tx('独立验收通过', 'Independently accepted') : journeyStatus(attempt.status)} · {attempt.tasks.length} {tx('步', 'steps')}</small></button>)}</div>
      <div class="research-actions"><button type="button" class="text-button" data-journey-expand-all onClick={() => setExpanded(new Set(journey.attempts.map(attempt => attempt.id)))}>{tx('展开所有尝试的步骤', 'Expand steps in every attempt')}</button>
        <button type="button" class="text-button" onClick={() => { setExpanded(new Set()); setSelection(attemptId(chosen?.id ?? runId)); }}>{tx('只看尝试关系', 'Show attempts only')}</button></div>
      <SolutionRouteGraph model={model} selection={selection} onSelect={id => { setSelection(id); const attempt = journey.attempts.find(attempt => attemptId(attempt.id) === id); if (attempt) setExpanded(previous => new Set([...previous, attempt.id])); }} onOpen={open} />
      {chosen && <section class="journey-attempt-detail" data-journey-attempt-detail={chosen.id}><header><div><h3><Rich text={chosen.title} /></h3><p>{stamp(chosen.createdAt)} · {chosen.accepted ? tx('Lean 陈述证明通过', 'Lean statement accepted') : tx('原题尚未通过独立验收', 'The original statement has not passed independent acceptance')}</p></div><a class="text-button" href={chosen.href}>{tx('进入这次尝试', 'Open this attempt')} ↗</a></header>
        {chosen.failure && <RichProse text={journeyStatus(chosen.failure)} />}
        {journey.lineage.filter(edge => edge.toRunId === chosen.id).map(edge => <div class="journey-lineage" key={edge.id} data-journey-lineage={edge.status}>
          <h4>{tx('这次尝试从哪里继续', 'Where this attempt continues from')}</h4><p>{edge.task?.title ?? edge.taskId} · <code>{edge.commit.slice(0, 12)}</code></p>
          {edge.source ? <><p>{tx('引用的是保存的固定版本；本次尝试的结果需另行验收。', 'This continuation references a saved version. This attempt has its own acceptance result.')}</p><button type="button" class="button" onClick={() => setSource(edge.source)}>{tx('查看继承的前提、推导与源码', 'Read inherited premises, derivation and source')} →</button></>
            : <p>{edge.status === 'ambiguous' ? tx('此续跑引用匹配多个版本，无法确定当时使用哪一个。', 'This continuation matches multiple versions; the exact source is undetermined.') : tx('来源记录未保存或已不可访问。', 'The source was not saved or is no longer accessible.')}</p>}</div>)}
        {!chosen.tasks.length && <Empty>{tx('这次尝试尚未保存任务路线。', 'No task route was saved for this attempt.')}</Empty>}
        {chosen.tasks.length > 0 && <div class="journey-task-picker" role="group" aria-label={tx('选择解题步骤', 'Select a proof step')}>{chosen.tasks.map(item => <button class="journey-task-button" type="button" key={item.task.id}
          data-journey-task={item.task.id} aria-pressed={selectedTask === item.task.id} onClick={() => { setSelection(taskId(chosen.id, item.task.id)); setExpanded(previous => new Set([...previous, chosen.id])); }}><Rich text={item.task.title} /><span>{item.task.checks.some(check => check.passed) ? tx('检查通过', 'Checked') : journeyStatus(item.task.proofStatus)}</span></button>)}</div>}
        {selectedTask && <TaskDetail attempt={chosen} selected={selectedTask} select={id => setSelection(taskId(chosen.id, id))} open={setSource} />}
      </section>}
      {source && <SourceReader reference={source} close={() => setSource(undefined)} />}</>}
    </div>
  </Panel>;
}

const sectionLabel = (value: string) => ({ Status: tx('记录状态', 'Recorded status'), Statement: tx('陈述', 'Statement'), Premises: tx('前提', 'Premises'),
  Derivation: tx('推导', 'Derivation'), Dependencies: tx('依赖步骤', 'Dependencies'), Finding: tx('结论', 'Finding'), Feedback: tx('反馈', 'Feedback'),
  'Check receipt': tx('检查回执', 'Check receipt'), 'Recorded result': tx('检查结果', 'Recorded result'), 'Human action': tx('人工操作', 'Human action'),
  Delivery: tx('投递', 'Delivery'), Decision: tx('采纳决定', 'Decision'), Reason: tx('理由', 'Reason'), Execution: tx('执行', 'Execution'),
  Evidence: tx('引用证据', 'Evidence'), 'Recorded action': tx('完整操作记录', 'Full action record') }[value] ?? value);
function ReadingRecord({ runId, projectId, selected, close }: Props & { selected: Pick<ResearchChangeRecordLink, 'snapshotDigest' | 'id'>; close(): void }) {
  const url = `${endpoint(runId, projectId, 'journey/record')}${projectId ? '&' : '?'}${new URLSearchParams({ snapshot: selected.snapshotDigest, record: selected.id })}`;
  const resource = useResource<Item<ResearchJourneyRecord>>(url), record = resource.data?.item, [source, setSource] = useState<ResearchJourneySourceRef>();
  const heading = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
  useEffect(() => { setSource(undefined); heading.current?.focus(); }, [url]);
  useEffect(() => () => { if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true }); }, []);
  return <section class="journey-reading-record" data-research-change-record><header><h3 tabIndex={-1} ref={heading}>{tx('变化对应的保存记录', 'Saved record for this change')}</h3><button type="button" class="button" onClick={close}>{tx('关闭记录', 'Close record')}</button></header>
    <ErrorBox message={resource.error} />{resource.error && <button type="button" class="button" onClick={resource.refresh}>{tx('重新读取', 'Try again')}</button>}
    {!record && !resource.error && <p role="status">{tx('正在读取对应版本…', 'Loading the corresponding version…')}</p>}
    {record && <><h4><Rich text={record.title} /></h4><p>{tx('版本', 'Version')}: <code>{record.version}</code></p>
      {record.sections.filter(section => section.text).map(section => ['Recorded result', 'Recorded action'].includes(section.title)
        ? <details key={section.title}><summary>{sectionLabel(section.title)}</summary><pre tabIndex={0}><code>{section.text}</code></pre></details>
        : <section key={section.title}><h5>{sectionLabel(section.title)}</h5><RichProse text={['Status', 'Delivery', 'Decision', 'Execution'].includes(section.title)
          ? section.text.split(' · ').map(value => journeyStatus(value)).join(' · ') : section.text} /></section>)}
      {record.source && <button type="button" class="button" onClick={() => setSource(record.source)}>{tx('打开对应源码版本', 'Open corresponding source version')} →</button>}
      {source && <SourceReader reference={source} close={() => setSource(undefined)} />}</>}
  </section>;
}

const initialRecord = () => {
  const parameters = new URLSearchParams(location.search), snapshotDigest = parameters.get('snapshot'), id = parameters.get('changeRecord');
  return snapshotDigest && id ? { snapshotDigest, id } : undefined;
};
export function ResearchChangesSinceRead({ runId, projectId }: Props) {
  const resource = useResource<Item<ResearchUnreadChanges>>(endpoint(runId, projectId, 'changes'), 15_000), data = resource.data?.item;
  const action = useMutation(), [all, setAll] = useState(false), [selected, setSelected] = useState<Pick<ResearchChangeRecordLink, 'id' | 'snapshotDigest'> | undefined>(initialRecord);
  useEffect(() => { setSelected(initialRecord()); setAll(false); action.reset(); }, [runId, projectId]);
  const select = (record: ResearchChangeRecordLink) => setSelected({ id: record.id, snapshotDigest: record.snapshotDigest });
  return <Panel title={tx('离开后发生了什么', 'Changes since you last read')} id="research-changes">
    <div data-research-changes><ErrorBox message={resource.error} />{resource.error && <button type="button" class="button" onClick={resource.refresh}>{tx('重新读取', 'Try again')}</button>}
    {!data && !resource.error && <p role="status">{tx('正在对照已阅记录…', 'Comparing with your read position…')}</p>}
    {data && <>{!data.changes.length ? <Empty>{data.baselineCreated ? tx('已从本次访问建立已阅基准，后续的任务、检查和人工操作变化会显示在这里。', 'Your read baseline starts with this visit. Later task, check and human action changes will appear here.')
      : tx('自上次已阅以来，没有新的任务、检查或人工操作变化。', 'No task, check or human action has changed since your last read position.')}</Empty>
      : <><p class="journey-change-count" role="status">{data.counts.task} {tx('项任务变化', 'task changes')} · {data.counts.check} {tx('项检查变化', 'check changes')} · {data.counts.human} {tx('项人工操作变化', 'human action changes')}</p>
        <p>{tx('对照已阅位置', 'Compared with your read position')}: {stamp(data.readAt)}</p>
        <div class="journey-changes-list">{(all ? data.changes : data.changes.slice(0, 6)).map(change => <article key={change.id} data-research-change={change.kind} data-change={change.change}>
          <div><span>{change.change === 'added' ? tx('新增', 'Added') : change.change === 'removed' ? tx('移出当前路线', 'Removed from current route') : tx('已更新', 'Updated')}</span><h3><Rich text={change.title} /></h3></div>
          <div class="research-actions">{[change.before, change.after].map((record, index) => record && <a key={index} class="text-button" data-research-change-link href={record.href} onClick={event => {
            if (event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
            event.preventDefault(); select(record);
          }}>{index === 0 ? tx('查看原记录', 'Read previous record') : tx('查看这次变化', 'Read changed record')} →</a>)}</div></article>)}</div>
        {data.changes.length > 6 && <button class="text-button" type="button" aria-expanded={all} onClick={() => setAll(value => !value)}>{all ? tx('收起', 'Show fewer') : tx(`查看全部 ${data.changes.length} 项变化`, `Read all ${data.changes.length} changes`)}</button>}
        <div class="research-actions"><button class="button" data-research-mark-read type="button" disabled={action.busy} onClick={() => void action.run('POST', endpoint(runId, projectId, 'changes/read'),
          { expectedRevision: data.revision, snapshotDigest: data.snapshotDigest }, () => { action.setMessage(tx('已标记本次看到的变化。', 'Marked the changes you saw as read.')); resource.refresh(); })}>{action.busy ? tx('正在保存…', 'Saving…') : tx('将本次变化标记已阅', 'Mark these changes as read')}</button>
          <button type="button" class="text-button" onClick={resource.refresh}>{tx('刷新摘要', 'Refresh changes')}</button></div></>}
      <MutationState action={action} />{action.error && <button type="button" class="button" onClick={resource.refresh}>{tx('读取最新已阅位置', 'Load latest read position')}</button>}
    </>}
    {selected && <ReadingRecord runId={runId} projectId={projectId} selected={selected} close={() => setSelected(undefined)} />}
    </div>
  </Panel>;
}
