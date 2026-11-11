import { useEffect, useRef, useState } from 'preact/hooks';
import { researchContextHref } from '../shared';
import { withPeopleReturn } from './researchPeopleReturn';
import type { ResearchCollaborationInbox, ResearchCollaborationView, ResearchHandoff, ResearchInvitation, ResearchIssue } from '../researchCollaborationTypes';
import type { ResearchFeedbackTarget, ResearchProjectDetail, ResearchRunBinding } from '../researchProjectTypes';
import type { WebObservation, WebTaskSource } from '../collaboration';
import type { WebApi } from './collaborationUi';
import { Rich, RichProse } from './richText';
import { BookmarkControl } from './researchCollections';
import { ResearchDraftPicker, useResearchDrafts } from './researchDrafts';
import { IssueExecution } from './researchIssueExecution';
import { completeIssueReply, type IssueReplyDraft } from './researchIssueReplyDraft';
import { SharedStageReference } from './researchStageReference';
import { ProjectInvitationLinks } from './researchInvite';
import { ResearchHandoffComposer } from './researchHandoffComposer';
import { api, base, enc, ErrorBox, errorText, Field, MutationState, nameOf, personHref, Search, stamp, theoremHref, tx, useMutation,
  useResource, type Item, type Items, type ResearchContext } from './researchShared';
import type { ResearcherProfile } from '../researchProjectTypes';

const projectPath = (id: string) => `${base}/theorems/${enc(id)}`;
const collaborationPath = (id: string) => `${projectPath(id)}/collaboration`;
const invitationStatus = (item: ResearchInvitation | ResearchHandoff) => item.status === 'pending' ? tx('等待回应', 'Awaiting a response')
  : item.status === 'joined' ? tx('已通过其他方式加入', 'Joined another way')
    : item.status === 'accepted' ? tx('已接受', 'Accepted') : item.status === 'declined' ? tx('已拒绝', 'Declined') : tx('已撤回', 'Cancelled');
const roleName = (role: string) => role === 'reader' ? tx('只读成员', 'Reader') : tx('协作者', 'Collaborator');
function JoinedInvitationNotice({ item }: { item: ResearchInvitation }) {
  if (item.status !== 'joined') return null;
  return <p data-invitation-already-joined>{item.currentMemberRole ? <>{tx('当前角色：', 'Current role: ')}<strong>{roleName(item.currentMemberRole)}</strong>{tx('。', '. ')}
    {item.currentMemberRole !== item.role && tx('如需调整角色，请联系发起者在成员列表中确认。', 'Contact the project owner to confirm a role change in the member list.')}</>
    : tx('这份邀请在加入项目后已关闭。当前访问权限请联系发起者确认。', 'This invitation was closed after joining. Contact the project owner to confirm current access.')}</p>;
}
const claimStatus = (status: string) => status === 'claimed' ? tx('已认领', 'Claimed') : status === 'submitted' ? tx('已提交候选', 'Candidate submitted') : tx('已释放', 'Released');
const inboxLabel = (kind: string) => ({ invitation: tx('协作邀请', 'Invitation'), application: tx('加入申请', 'Join request'),
  handoff: tx('任务交接', 'Handoff'), claim: tx('我的认领', 'My claim'), review: tx('待我评审', 'Needs my review'),
  'needs-info': tx('待我补充', 'Needs my input'), reply: tx('议题回复', 'Issue reply'), annotation: tx('片段批注', 'Passage comment'), update: tx('研究更新', 'Research update') })[kind] ?? kind;

export function CollaborationMessageSummary({ request = api }: { request?: WebApi } = {}) {
  const [data, setData] = useState<ResearchCollaborationInbox>(), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController(); setData(undefined);
    const read = async () => {
      try { const result = await request<ResearchCollaborationInbox>(`${base}/collaboration/inbox`, { signal: controller.signal }); if (live) { setData(result); setError(''); } }
      catch (cause) { if (live && !controller.signal.aborted) setError(errorText(cause)); }
      if (live) timer = setTimeout(() => void read(), 15000);
    };
    void read(); return () => { live = false; controller.abort(); clearTimeout(timer); };
  }, [request, revision]);
  return <div class="collaboration-message-summary" data-inbox-summary>
    <ErrorBox message={error} />{error && <button class="text-button" type="button" onClick={() => setRevision(value => value + 1)}>{tx('重新读取消息', 'Reload messages')}</button>}
    {!data && !error && <p role="status">{tx('正在读取待办与消息…', 'Loading decisions and messages…')}</p>}
    {data && <><div>{(['decision', 'reply', 'progress'] as const).map(category => <a key={category} href={`workspace.html?tab=inbox&inbox=${category}#collaboration-inbox`}>
      <strong>{data.counts[category]}</strong><span>{category === 'decision' ? tx('待决定', 'Decisions') : category === 'reply' ? tx('待回复', 'Replies') : tx('未读进展', 'Unread progress')}</span></a>)}</div>
      <a class="research-inline-link" href="workspace.html?tab=inbox&inbox=unread#collaboration-inbox">{tx(`查看全部消息 · ${data.unread} 条未读`, `All messages · ${data.unread} unread`)}</a></>}
  </div>;
}

/** A personal view; injected WebApi retains the workbench's existing owner/CSRF boundary. */
export function CollaborationInbox({ context, request = api }: { context: ResearchContext; request?: WebApi }) {
  const [data, setData] = useState<ResearchCollaborationInbox>(), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  const [filter, setFilter] = useState(() => { const selected = new URLSearchParams(location.search).get('inbox') ?? ''; return ['decision', 'reply', 'progress', 'unread', 'claim', 'processed', 'all'].includes(selected) ? selected : 'pending'; }), [busy, setBusy] = useState('');
  const pending = useRef<{ signature: string; requestId: string }>(), locked = useRef(false), generation = useRef(0), owner = useRef(context.session.researcherId);
  owner.current = context.session.researcherId;
  useEffect(() => { generation.current++; pending.current = undefined; setData(undefined); setBusy(''); return () => { generation.current++; }; }, [context.session.researcherId]);
  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const read = async () => {
      try { const result = await request<ResearchCollaborationInbox>(`${base}/collaboration/inbox`, { signal: controller.signal }); if (live) { setData(result); setError(''); } }
      catch (cause) { if (live && !controller.signal.aborted) setError(errorText(cause)); }
      if (live) timer = setTimeout(() => void read(), 15000);
    };
    void read();
    return () => { live = false; controller.abort(); clearTimeout(timer); };
  }, [context.session.researcherId, request, revision]);
  async function write(url: string, input: Record<string, unknown>, key: string) {
    if (locked.current) return false;
    locked.current = true;
    const current = generation.current, researcher = owner.current;
    const signature = JSON.stringify([url, input]);
    if (pending.current?.signature !== signature) pending.current = { signature, requestId: crypto.randomUUID() };
    setBusy(key); setError('');
    try { const result = await request<ResearchCollaborationInbox | Item<ResearchInvitation | ResearchHandoff>>(url, { method: 'POST', body: JSON.stringify({ ...input, requestId: pending.current.requestId }) });
      if (current !== generation.current || researcher !== owner.current) return false;
      pending.current = undefined; if ('items' in result) setData(result); setRevision(value => value + 1); return true; }
    catch (cause) { if (current === generation.current && researcher === owner.current) setError(errorText(cause)); return false; }
    finally { locked.current = false; if (current === generation.current && researcher === owner.current) setBusy(''); }
  }
  const self = context.session.researcherId;
  const items = data?.items.filter(item => filter === 'all' || filter === 'unread' && !item.read || filter === 'processed' && (item.processed || item.resolved)
    || filter === 'pending' && item.category !== 'progress' && !item.processed && !item.resolved
    || filter === 'progress' && item.category === 'progress'
    || ['decision', 'reply'].includes(filter) && item.category === filter && !item.processed && !item.resolved
    || filter === 'claim' && item.kind === 'claim') ?? [];
  const label = (value: string) => value === 'pending' ? tx('待我处理', 'Needs me') : value === 'decision' ? tx('待决定', 'Decisions')
    : value === 'reply' ? tx('待回复', 'Replies') : value === 'progress' ? tx('研究进展', 'Progress') : value === 'unread' ? tx('未读', 'Unread')
    : value === 'claim' ? tx('我的认领', 'My claims') : value === 'processed' ? tx('已收起或完成', 'Dismissed or completed') : tx('全部', 'All');
  return <section class="collaboration-inbox" id="collaboration-inbox" data-collaboration-inbox aria-label={tx('个人处理中心', 'Personal inbox')}>
    <header><div><h2>{tx('个人处理中心', 'Personal inbox')}</h2><p>{tx('需要你决定或回应的事项，与研究进展分开查看。', 'Find decisions and replies here, with research progress in its own view.')}</p></div>
      {data && <span>{tx(`${data.pending} 项待处理 · ${data.unread} 条未读`, `${data.pending} pending · ${data.unread} unread`)}
        {data.unread > 0 && <button type="button" class="text-button" data-inbox-read-all disabled={Boolean(busy)} onClick={() => void write(`${base}/collaboration/inbox/read-all`, {}, 'read-all')}>{tx('全部标已读', 'Mark all as read')}</button>}</span>}</header>
    <div class="collaboration-filter" role="group" aria-label={tx('筛选消息', 'Filter messages')}>{['pending', 'decision', 'reply', 'progress'].map(value => <button type="button" class="button" key={value} data-inbox-filter={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>
      {label(value)}{value !== 'pending' && data?.counts && <> · {data.counts[value as keyof typeof data.counts]}</>}</button>)}
      <label class="collaboration-more-filter"><span class="sr-only">{tx('其他范围', 'Other views')}</span><select aria-label={tx('其他消息范围', 'Other message views')} value={['unread', 'claim', 'processed', 'all'].includes(filter) ? filter : ''} onChange={event => { if (event.currentTarget.value) setFilter(event.currentTarget.value); }}>
        <option value="">{tx('其他范围', 'Other views')}</option>{['unread', 'claim', 'processed', 'all'].map(value => <option key={value} value={value}>{label(value)}</option>)}</select></label></div>
    <ErrorBox message={error} />{error && <button type="button" class="text-button" onClick={() => setRevision(value => value + 1)}>{tx('重新读取', 'Try again')}</button>}
    {!data && !error && <p role="status">{tx('正在读取协作事项…', 'Loading collaboration items…')}</p>}
    {items.map(item => {
      const source = new URL(location.href); source.searchParams.set('inbox', filter); source.hash = 'collaboration-inbox';
      const href = withPeopleReturn(researchContextHref(item.href, location.search), source.pathname + source.search + source.hash);
      const record = item.invitation ?? item.handoff, respond = record && (record.recipient.id === self || record.author.id === self);
      return <article class="collaboration-inbox-item" key={item.id} data-inbox-item={item.id}>
        <div class="collaboration-meta"><span>{inboxLabel(item.kind)}</span><span>{item.projectTitle}</span><time dateTime={item.createdAt}>{stamp(item.createdAt)}</time>
          {item.annotationAction && <span>{item.annotationAction === 'resolve' ? tx('已解决批注', 'Comment resolved') : item.annotationAction === 'reopen' ? tx('重新打开批注', 'Comment reopened') : item.annotationAction === 'reply' ? tx('有新回应', 'New reply') : tx('有新批注', 'New comment')}</span>}
          {item.issueAction && <span>{item.issueAction === 'resolve' ? tx('议题已有决议', 'Issue resolved') : tx('议题重新讨论', 'Issue reopened')}</span>}
          {!item.read && <strong>{tx('未读', 'Unread')}</strong>}{(item.processed || item.resolved) && <span>{tx('已处理', 'Processed')}</span>}</div>
        <div class="collaboration-inbox-copy"><RichProse text={item.title} />{item.reviewReassignment && <p>{tx('原评审人已无权限，请重新指定评审人。', 'The previous reviewer no longer has permission. Assign a new reviewer.')}</p>}{item.text && <RichProse text={item.kind === 'claim' ? claimStatus(item.text) : item.text} />}</div>
        {record && <p>{record.author.displayName} → {record.recipient.displayName} · {invitationStatus(record)}{'role' in record && <> · {record.status === 'joined' && tx('原邀请角色：', 'Original role: ')}{roleName(record.role)}</>}</p>}
        {item.invitation && <JoinedInvitationNotice item={item.invitation} />}
        <div class="research-actions">{item.href && <a class="button" href={href} onClick={event => { if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return; event.preventDefault();
          void write(`${base}/collaboration/inbox/${enc(item.id)}`, { action: 'read' }, item.id).then(saved => { if (saved) location.assign(href); }); }}>{tx('打开并继续', 'Open and continue')}</a>}
          {respond && record.status === 'pending' && (record.recipient.id === self ? <>
            <button type="button" class="button" disabled={Boolean(busy)} onClick={() => void write(`${projectPath(item.projectId)}/${item.handoff ? 'handoffs' : 'invitations'}/${record.id}/respond`, { action: 'accept', expectedRevision: record.revision }, item.id)}>{item.handoff ? tx('确认接手', 'Accept handoff') : tx('接受', 'Accept')}</button>
            <button type="button" class="text-button" disabled={Boolean(busy)} onClick={() => void write(`${projectPath(item.projectId)}/${item.handoff ? 'handoffs' : 'invitations'}/${record.id}/respond`, { action: 'decline', expectedRevision: record.revision }, item.id)}>{tx('拒绝', 'Decline')}</button></>
            : <button type="button" class="text-button" disabled={Boolean(busy)} onClick={() => void write(`${projectPath(item.projectId)}/${item.handoff ? 'handoffs' : 'invitations'}/${record.id}/respond`, { action: 'cancel', expectedRevision: record.revision }, item.id)}>{tx('撤回请求', 'Cancel request')}</button>)}
          <button type="button" class="text-button" disabled={Boolean(busy)} onClick={() => void write(`${base}/collaboration/inbox/${enc(item.id)}`, { action: item.read ? 'unread' : 'read' }, item.id)}>{item.read ? tx('标为未读', 'Mark unread') : tx('标为已读', 'Mark read')}</button>
          {!item.resolved && item.category !== 'progress' && <button type="button" class="text-button" disabled={Boolean(busy)} onClick={() => void write(`${base}/collaboration/inbox/${enc(item.id)}`, { action: item.processed ? 'reopen' : 'done' }, item.id)}>{item.processed ? tx('重新放回待办', 'Reopen item') : tx('从我的待办收起', 'Dismiss from my inbox')}</button>}
        </div>
      </article>;
    })}
    {data && !items.length && <p class="research-empty">{tx('当前范围内没有协作事项。', 'No collaboration items in this view.')}</p>}
  </section>;
}

export function CollaborationMembership({ project, selfId, refresh }: { project: ResearchProjectDetail; selfId: string; refresh(): void }) {
  const resource = useResource<Item<ResearchCollaborationView>>(collaborationPath(project.id), 10000);
  const [query, setQuery] = useState(''), [offset, setOffset] = useState(0);
  const directory = useResource<Items<ResearcherProfile>>(project.permissions.manage ? `${base}/people?limit=20&offset=${offset}&q=${enc(query)}` : undefined);
  const [recipientId, setRecipient] = useState(''), [role, setRole] = useState('collaborator'), [note, setNote] = useState('');
  const action = useMutation(), changed = () => { resource.refresh(); refresh(); };
  const invitations = resource.data?.item.invitations ?? [];
  const reviewFeedback = project.feedback.find(item => item.id === new URLSearchParams(location.search).get('reviewFeedback') && item.kind === 'proof-submission');
  const memberPanel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (location.hash !== '#collaboration-members') return;
    const frame = requestAnimationFrame(() => { memberPanel.current?.scrollIntoView({ block: 'start' }); memberPanel.current?.focus({ preventScroll: true }); });
    return () => cancelAnimationFrame(frame);
  }, [project.id]);
  return <section ref={memberPanel} tabIndex={-1} id="collaboration-members" class="collaboration-members">
    {reviewFeedback && <p data-reviewer-return><a class="button" href={theoremHref(project.id, reviewFeedback.target?.runId, { ...reviewFeedback.target, feedbackId: reviewFeedback.id })}>{tx('回到原候选并指定评审人', 'Return to the candidate and assign a reviewer')}</a></p>}

    {project.permissions.manage && <ProjectInvitationLinks project={project} links={resource.data?.item.invitationLinks ?? []} refresh={changed} />}
    {project.permissions.manage ? <details><summary>{tx('邀请同行参与', 'Invite a colleague')}</summary><form class="research-form" onSubmit={event => { event.preventDefault(); void action.run('POST', `${projectPath(project.id)}/invitations`,
      { recipientId, role, note, expectedRevision: project.revision }, changed); }}>
      <Search label={tx('搜索同事的姓名、简介或领域', 'Search a colleague’s name, biography or field')} onSearch={value => { setQuery(value); setOffset(0); setRecipient(''); }} />
      <label>{tx('选择数学家', 'Choose a mathematician')}<select value={recipientId} required onChange={event => setRecipient(event.currentTarget.value)}><option value="">{tx('从公开数学家目录中选择', 'Choose from public researcher profiles')}</option>
        {directory.data?.items.filter(person => person.id !== project.owner.id && !project.members.some(member => member.researcherId === person.id)).map(person => <option key={person.id} value={person.id}>{person.displayName} · {person.fields.join(' / ')}</option>)}</select></label>
      <div class="research-actions">{offset > 0 && <button class="text-button" type="button" onClick={() => { setOffset(Math.max(0, offset - 20)); setRecipient(''); }}>{tx('上一页', 'Previous')}</button>}
        {directory.data?.nextOffset !== undefined && <button class="text-button" type="button" onClick={() => { setOffset(directory.data!.nextOffset!); setRecipient(''); }}>{tx('下一页', 'Next')}</button>}</div>
      {directory.data && !directory.data.items.length && <p>{tx('没有匹配的公开资料。也可以用邀请链接让同事直接加入。', 'No public profile matches. You can invite your colleague with a link instead.')}</p>}
      <label>{tx('邀请角色', 'Invited role')}<select value={role} onChange={event => setRole(event.currentTarget.value)}><option value="collaborator">{roleName('collaborator')}</option><option value="reader">{roleName('reader')}</option></select></label>
      <Field label={tx('希望共同推进什么', 'What would you like to work on together?')} value={note} onInput={setNote} multiline required maxLength={4000} />
      {project.visibility === 'private' && <p>{tx('对方接受后，此题仅向项目成员开放。', 'After acceptance, this project becomes visible to its members.')}</p>}
      <ErrorBox message={directory.error} /><button class="button" type="submit" disabled={action.busy}>{tx('发送站内邀请', 'Send invitation')}</button>
    </form></details> : !project.permissions.member && selfId && project.visibility === 'public' && <details><summary>{tx('申请加入研究', 'Request to join')}</summary><form class="research-form" onSubmit={event => { event.preventDefault(); void action.run('POST', `${projectPath(project.id)}/join-requests`, { role, note }, changed); }}>
      <Field label={tx('想参与的方向与可提供的帮助', 'Your research interest and what you can contribute')} value={note} onInput={setNote} required multiline maxLength={4000} />
      <label>{tx('希望以何种方式参与', 'How would you like to participate?')}<select value={role} onChange={event => setRole(event.currentTarget.value)}><option value="collaborator">{roleName('collaborator')}</option><option value="reader">{roleName('reader')}</option></select></label>
      <button class="button" disabled={action.busy}>{tx('提交加入申请', 'Send join request')}</button></form></details>}
    {invitations.map(item => <div class="collaboration-request" key={item.id}><div>{item.author.displayName} → {item.recipient.displayName} · {item.status === 'joined' && tx('原邀请角色：', 'Original role: ')}{roleName(item.role)} · {invitationStatus(item)}</div><RichProse text={item.note} /><JoinedInvitationNotice item={item} />
      {item.status === 'pending' && <div class="research-actions">{item.recipient.id === selfId ? <>{['accept', 'decline'].map(choice => <button class="button" type="button" key={choice} disabled={action.busy} onClick={() => void action.run('POST', `${projectPath(project.id)}/invitations/${item.id}/respond`, { action: choice, expectedRevision: item.revision }, changed)}>{choice === 'accept' ? tx('接受', 'Accept') : tx('拒绝', 'Decline')}</button>)}</>
        : item.author.id === selfId && <button type="button" class="text-button" disabled={action.busy} onClick={() => void action.run('POST', `${projectPath(project.id)}/invitations/${item.id}/respond`, { action: 'cancel', expectedRevision: item.revision }, changed)}>{tx('撤回请求', 'Cancel request')}</button>}</div>}</div>)}
    <ErrorBox message={resource.error} /><MutationState action={action} />
  </section>;
}

export function CollaborationIssues({ project, selfId, request, refresh, onRevealFeedback }: { project: ResearchProjectDetail; selfId: string;
  request?: { target?: ResearchFeedbackTarget; sourceFeedbackId?: string; statementVersionId?: string; serial: number }; refresh(): void; onRevealFeedback(id: string): void }) {
  const resource = useResource<Item<ResearchCollaborationView>>(collaborationPath(project.id), 10000), action = useMutation();
  const [title, setTitle] = useState(''), [text, setText] = useState('');
  type IssueDraft = { title: string; text: string; target?: ResearchFeedbackTarget; sourceFeedbackId?: string; statementVersionId?: string };
  const drafts = useResearchDrafts<IssueDraft>(selfId, project.id, 'issue'), [draftContext, setDraftContext] = useState<Omit<IssueDraft, 'title' | 'text'>>();
  const activeContext = draftContext ?? request, composer = useRef<HTMLDetailsElement>(null), target = activeContext?.target, sourceFeedbackId = activeContext?.sourceFeedbackId;
  const saveDraft = (next: Partial<IssueDraft>) => {
    const value = { title, text, target, sourceFeedbackId, statementVersionId: activeContext?.statementVersionId ?? target?.statementVersionId ?? project.currentStatementVersionId, ...next };
    if (value.title.trim() || value.text.trim()) drafts.save({ statementVersionId: value.statementVersionId, runId: value.target?.runId, taskId: value.target?.taskRef?.id,
      taskVersion: value.target?.taskRef?.version, sourceFeedbackId: value.sourceFeedbackId }, value, value.title || tx('未命名议题', 'Untitled issue'));
  };
  const changed = () => { resource.refresh(); refresh(); };
  useEffect(() => { if (location.hash.startsWith('#issue-')) requestAnimationFrame(() => document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: 'start' })); }, [resource.data]);
  useEffect(() => { if (request && composer.current) { setDraftContext(request); setTitle(''); setText(''); composer.current.open = true; composer.current.scrollIntoView({ block: 'start' }); composer.current.querySelector('input')?.focus({ preventScroll: true }); } }, [request?.serial]);
  return <section class="collaboration-issues" id="collaboration-issues"><h3>{tx('议题与方案', 'Issues and proposals')}</h3>
    {resource.data?.item.issues.map(issue => <IssueThread key={issue.id} issue={issue} project={project} selfId={selfId} refresh={changed} onRevealFeedback={onRevealFeedback} />)}
    {project.permissions.edit && <details ref={composer}><summary>{sourceFeedbackId ? tx('从这条反馈发起议题', 'Open an issue from this feedback') : tx('发起议题', 'Open an issue')}</summary>
      <ResearchDraftPicker drafts={drafts} onRestore={item => { setTitle(item.value.title); setText(item.value.text); setDraftContext(item.value); action.reset(); }} />
      <form class="research-form" onSubmit={event => { event.preventDefault(); const submittedDraft = drafts.current(), sentTitle = title, sentText = text; void action.run<Item<ResearchIssue>>('POST', `${projectPath(project.id)}/issues`,
      { title, text, ...(target ? { target } : { statementVersionId: activeContext?.statementVersionId ?? project.currentStatementVersionId }), ...(sourceFeedbackId ? { sourceFeedbackId } : {}), expectedRevision: project.revision }, result => { if (submittedDraft) void drafts.complete(submittedDraft, { kind: 'issue', id: result.item.id }); setTitle(value => value === sentTitle ? '' : value); setText(value => value === sentText ? '' : value); changed(); }); }}>
      <Field label={tx('需要共同决定的问题', 'Question to decide together')} value={title} onInput={value => { setTitle(value); saveDraft({ title: value }); }} required maxLength={200} />
      <Field label={tx('背景、分歧与已有证据', 'Context, alternatives and existing evidence')} value={text} onInput={value => { setText(value); saveDraft({ text: value }); }} required multiline maxLength={4000} />
      {target?.taskRef && <p>{target.taskRef.id} · <code>{target.taskRef.version}</code></p>}
      {sourceFeedbackId && <p><a href={`#feedback-${enc(sourceFeedbackId)}`} onClick={event => { event.preventDefault(); onRevealFeedback(sourceFeedbackId); }}>{tx('查看来源反馈', 'View source feedback')}</a></p>}
      <button type="submit" class="button" disabled={action.busy}>{tx('保存议题', 'Save issue')}</button></form></details>}
    <ErrorBox message={resource.error} /><MutationState action={action} />
  </section>;
}

function IssueThread({ issue, project, selfId, refresh, onRevealFeedback }: { issue: ResearchIssue; project: ResearchProjectDetail; selfId: string; refresh(): void; onRevealFeedback(id: string): void }) {
  const [text, setText] = useState(''), [kind, setKind] = useState('comment'), [replyTo, setReplyTo] = useState(''), [proposalId, setProposal] = useState(''), [feedbackId, setFeedback] = useState(''), action = useMutation();
  const [revision, setRevision] = useState(issue.revision), stale = revision !== issue.revision;
  const currentReply = useRef<IssueReplyDraft>({ text, kind, replyTo, proposalId, feedbackId, revision });
  currentReply.current = { text, kind, replyTo, proposalId, feedbackId, revision };
  const drafts = useResearchDrafts<IssueReplyDraft>(selfId, project.id, 'issue-reply');
  const saveDraft = (next: Partial<IssueReplyDraft>) => {
    const value = { text, kind, replyTo, proposalId, feedbackId, revision, ...next };
    currentReply.current = value;
    if (value.text.trim()) drafts.save({ issueId: issue.id, issueRevision: value.revision, statementVersionId: issue.statementVersionId,
      runId: issue.target?.runId, taskId: issue.target?.taskRef?.id, taskVersion: issue.target?.taskRef?.version }, value, issue.title);
  };
  const completeReply = (submitted: IssueReplyDraft, submittedDraft: ReturnType<typeof drafts.current>, result: ResearchIssue) => {
    const before = currentReply.current, next = completeIssueReply(before, submitted, result.revision);
    if (submittedDraft) { drafts.remove(submittedDraft, true); void drafts.complete(submittedDraft, { kind: 'issue-reply', id: result.id }); }
    if (JSON.stringify(before) !== JSON.stringify(submitted)) {
      const newer = drafts.current(), nextScope = { issueId: issue.id, issueRevision: next.revision, statementVersionId: issue.statementVersionId,
        runId: issue.target?.runId, taskId: issue.target?.taskRef?.id, taskVersion: issue.target?.taskRef?.version };
      if (next.text.trim()) {
        drafts.save(nextScope, next, issue.title);
        if (newer && JSON.stringify(drafts.read(nextScope)?.value) === JSON.stringify(next)) drafts.remove(newer, true);
      }
    }
    currentReply.current = next; setText(next.text); setReplyTo(next.replyTo); setRevision(next.revision); refresh();
  };
  const links = project.feedback.filter(item => !issue.target || item.target?.runId === issue.target.runId && item.target.statementVersionId === issue.target.statementVersionId);
  return <article class="collaboration-issue" id={`issue-${issue.id}`} tabIndex={-1} data-collaboration-issue={issue.id}>
    <div class="collaboration-meta"><span>{issue.author.displayName}</span><span>{issue.status === 'open' ? tx('讨论中', 'Open') : tx('已形成决议', 'Resolved')}</span></div><h4><Rich text={issue.title} /></h4><RichProse text={issue.text} />
    {issue.stageReference && <SharedStageReference reference={issue.stageReference} />}
    {issue.target && <a href={theoremHref(project.id, issue.target.runId, { statementVersionId: issue.target.statementVersionId, taskRef: issue.target.taskRef })}>{tx('查看议题对应任务', 'View the issue’s task')}</a>}
    {issue.sourceFeedbackId && <a class="research-inline-link" href={`#feedback-${enc(issue.sourceFeedbackId)}`} onClick={event => { event.preventDefault(); onRevealFeedback(issue.sourceFeedbackId!); }}>{tx('查看来源反馈', 'View source feedback')}</a>}
    <ol class="collaboration-replies">{issue.replies.map(reply => <li key={reply.id} id={`reply-${reply.id}`}><div class="collaboration-meta"><a href={personHref(reply.author.id)}>{reply.author.displayName}</a><span>{reply.kind === 'proposal' ? tx('方案', 'Proposal') : tx('回复', 'Reply')}</span><time dateTime={reply.createdAt}>{stamp(reply.createdAt)}</time></div>
      {reply.replyTo && <a href={`#reply-${reply.replyTo}`}>{tx('回应上一条', 'In reply to')}</a>}<RichProse text={reply.text} />
      {reply.feedbackIds.map(id => <a class="research-inline-link" key={id} href={`#feedback-${enc(id)}`} onClick={event => { event.preventDefault(); onRevealFeedback(id); }}>{tx('关联反馈', 'Linked feedback')}</a>)}
      {project.permissions.member && issue.status === 'open' && <button class="text-button" type="button" onClick={() => { setReplyTo(reply.id); saveDraft({ replyTo: reply.id }); const input = document.getElementById(`issue-input-${issue.id}`); const details = input?.closest('details'); if (details) details.open = true; input?.focus(); }}>{tx('回复此条', 'Reply')}</button>}</li>)}</ol>
    {issue.resolution && <div class="collaboration-resolution"><strong>{issue.resolution.author.displayName} · {issue.resolution.action === 'reopen' ? tx('重新讨论的原因', 'Reason for reopening') : tx('决议', 'Resolution')}</strong><RichProse text={issue.resolution.text} />
      {issue.resolution.proposalId && <a href={`#reply-${issue.resolution.proposalId}`}>{tx('采用的方案', 'Selected proposal')}</a>}{issue.resolution.feedbackIds.map(id => <a class="research-inline-link" key={id} href={`#feedback-${enc(id)}`} onClick={event => { event.preventDefault(); onRevealFeedback(id); }}>{tx('查看决议关联的指导或调整', 'View linked guidance or changes')}</a>)}</div>}
    {issue.status === 'resolved' && issue.resolution && project.permissions.edit && <IssueExecution key={`${selfId}:${project.id}:${issue.id}`} issue={issue} project={project} selfId={selfId} refresh={refresh} onRevealFeedback={onRevealFeedback} />}
    {Boolean(issue.resolutionHistory?.length) && <details><summary>{tx('历次决议与重新讨论', 'Previous resolutions and reopenings')}</summary>{issue.resolutionHistory!.map((record, index) => <div class="collaboration-resolution" key={index}><div class="collaboration-meta">{record.author.displayName} · {stamp(record.createdAt)}</div><RichProse text={record.text} />{record.proposalId && <a href={`#reply-${record.proposalId}`}>{tx('采用的方案', 'Selected proposal')}</a>}</div>)}</details>}
    {selfId && project.permissions.member && (issue.status === 'open' || project.permissions.edit) && <details onToggle={event => { if (event.currentTarget.open && !text.trim()) setRevision(issue.revision); }}><summary>{issue.status === 'open' ? tx('补充意见或记录决议', 'Reply or record a resolution') : tx('重新讨论', 'Reopen discussion')}</summary>
      <ResearchDraftPicker drafts={drafts} filter={item => item.scope.issueId === issue.id} onRestore={item => { const value = item.value; setText(value.text); setKind(value.kind); setReplyTo(value.replyTo); setProposal(value.proposalId); setFeedback(value.feedbackId); setRevision(value.revision); action.reset(); }} />
      <form class="research-form" onSubmit={event => { event.preventDefault(); if (stale || issue.status !== 'open') return; const submittedDraft = drafts.current(), snapshot = currentReply.current; void action.run<Item<ResearchIssue>>('POST', `${projectPath(project.id)}/issues/${issue.id}/replies`,
      { kind, text, ...(replyTo ? { replyTo } : {}), feedbackIds: feedbackId ? [feedbackId] : [], expectedRevision: revision }, result => completeReply(snapshot, submittedDraft, result.item)); }}>
      {issue.status === 'open' && <label>{tx('内容类型', 'Type')}<select value={kind} onChange={event => { setKind(event.currentTarget.value); saveDraft({ kind: event.currentTarget.value }); }}><option value="comment">{tx('意见或疑问', 'Comment or question')}</option><option value="proposal">{tx('提出方案', 'Proposal')}</option></select></label>}
      {replyTo && <p>{tx('正在回复：', 'Replying to: ')}{issue.replies.find(item => item.id === replyTo)?.author.displayName}<button type="button" class="text-button" onClick={() => { setReplyTo(''); saveDraft({ replyTo: '' }); }}>{tx('取消回复关联', 'Clear reply target')}</button></p>}
      <label>{tx('补充内容', 'Your contribution')}<textarea id={`issue-input-${issue.id}`} value={text} required maxLength={4000} rows={3} onInput={event => { setText(event.currentTarget.value); saveDraft({ text: event.currentTarget.value }); }} /></label>
      <label>{tx('关联现有反馈（可选）', 'Link existing feedback (optional)')}<select value={feedbackId} onChange={event => { setFeedback(event.currentTarget.value); saveDraft({ feedbackId: event.currentTarget.value }); }}><option value="">{tx('不关联', 'No link')}</option>{links.map(item => <option key={item.id} value={item.id}>{item.text.slice(0, 80)}</option>)}</select></label>
      {stale && <p class="research-status" role="status">{tx('议题已有更新，草稿已保留。请先查看新回复或决议。', 'The issue changed. Your draft is preserved. Review the new replies or resolution first.')} <button class="text-button" type="button" disabled={action.busy} onClick={() => { setRevision(issue.revision); saveDraft({ revision: issue.revision }); action.reset(); }}>{tx('已核对，基于最新议题继续', 'Reviewed; continue with the latest issue')}</button></p>}
      {issue.status === 'open' && <button class="button" type="submit" disabled={action.busy || stale}>{tx('提交意见', 'Post reply')}</button>}
      {project.permissions.edit && <><label>{tx('采用的方案（可选）', 'Selected proposal (optional)')}<select value={proposalId} onChange={event => { setProposal(event.currentTarget.value); saveDraft({ proposalId: event.currentTarget.value }); }}><option value="">{tx('另行记录结论', 'Record a separate conclusion')}</option>{issue.replies.filter(item => item.kind === 'proposal').map(item => <option key={item.id} value={item.id}>{item.text.slice(0, 80)}</option>)}</select></label>
        <button type="button" class="button" disabled={action.busy || stale || !text.trim()} onClick={() => { if (stale) return; const submittedDraft = drafts.current(), sentText = text; void action.run<Item<ResearchIssue>>('POST', `${projectPath(project.id)}/issues/${issue.id}/resolution`,
          { action: issue.status === 'open' ? 'resolve' : 'reopen', text, ...(proposalId ? { proposalId } : {}), feedbackIds: feedbackId ? [feedbackId] : [], expectedRevision: revision }, result => { if (submittedDraft) void drafts.complete(submittedDraft, { kind: 'issue-reply', id: result.item.id }); setText(value => value === sentText ? '' : value); setRevision(result.item.revision); refresh(); }); }}>{issue.status === 'open' ? tx('记录决议', 'Record resolution') : tx('重新打开议题', 'Reopen issue')}</button></>}
      <MutationState action={action} /></form></details>}
  </article>;
}

export function CollaborationTaskWorkspace({ project, selfId, binding, observation, selectedTask, pinnedCommit, context, refresh, onSubmitCandidate, onSelectTask, onOpenIssue, onRevealFeedback }: {
  project: ResearchProjectDetail; selfId: string; binding: ResearchRunBinding; observation: WebObservation;
  selectedTask?: { taskId: string; taskVersion: string }; refresh(): void; onSubmitCandidate(target: ResearchFeedbackTarget): void; onOpenIssue(target: ResearchFeedbackTarget): void; onRevealFeedback(id: string): void;
  pinnedCommit?: string; context: ResearchContext;
  onSelectTask(taskId: string, taskVersion: string): void;
}) {
  const resource = useResource<Item<ResearchCollaborationView>>(collaborationPath(project.id), 10000), action = useMutation();
  const taskKey = (item: { id: string; version: string }) => JSON.stringify([item.id, item.version]);
  const [choice, setTask] = useState(selectedTask ? JSON.stringify([selectedTask.taskId, selectedTask.taskVersion]) : '');
  useEffect(() => { if (selectedTask) setTask(JSON.stringify([selectedTask.taskId, selectedTask.taskVersion])); }, [selectedTask?.taskId, selectedTask?.taskVersion]);
  const current = observation.inspection.tasks.find(item => taskKey(item) === choice);
  const task = current ?? observation.history?.find(item => taskKey(item) === choice), target: ResearchFeedbackTarget | undefined = task && {
    runId: binding.runId, statementVersionId: binding.statementVersionId, observationRef: { sequence: observation.sequence, stateDigest: observation.snapshot.stateDigest }, taskRef: { id: task.id, version: task.version } };
  const claims = task ? project.assignments.filter(item => item.target.runId === binding.runId && item.target.taskRef?.id === task.id && item.target.taskRef?.version === task.version) : [];
  const sourceResource = useResource<{ source: WebTaskSource }>(task && pinnedCommit ? `${projectPath(project.id)}/runs/${enc(binding.runId)}/tasks/${enc(task.id)}/source?version=${enc(task.version)}&commit=${enc(pinnedCommit)}` : undefined);
  const own = claims.find(item => item.author.id === selfId), source = pinnedCommit ? sourceResource.data?.source : task && observation.sources.find(item => item.taskId === task.id && item.taskVersion === task.version);
  const feedback = task ? project.feedback.filter(item => item.target?.runId === binding.runId && item.target.taskRef?.id === task.id && item.target.taskRef?.version === task.version) : [];
  const handoffs = task ? resource.data?.item.handoffs.filter(item => item.target.runId === binding.runId && item.target.taskRef?.id === task.id && item.target.taskRef?.version === task.version) ?? [] : [];
  const changed = () => { refresh(); resource.refresh(); };
  return <section class="collaboration-task-workspace" id="collaboration-task-workspace" data-task-workspace><h3>{tx('人类任务工作区', 'Human task workspace')}</h3>
    <label>{tx('正在处理的任务', 'Task to work on')}<select value={choice} onChange={event => { setTask(event.currentTarget.value); const selected = observation.inspection.tasks.find(item => taskKey(item) === event.currentTarget.value); if (selected) onSelectTask(selected.id, selected.version); }}><option value="">{tx('选择任务或点击路线节点', 'Choose a task or select a route node')}</option>{choice && !current && <option value={choice}>{task?.id ?? selectedTask?.taskId} · {tx('历史版本', 'Historical version')}</option>}{observation.inspection.tasks.map(item => <option value={taskKey(item)} key={taskKey(item)}>{item.theorem || item.id} · {item.version.slice(0, 12)}</option>)}</select></label>
    {choice && !task && <p role="status">{tx('此任务版本暂未包含在当前观测中，请从路线历史打开对应版本。', 'This task version is absent from the current observation. Open its version in route history.')}</p>}
    {task && target && <><div class="collaboration-context"><RichProse text={task.informalStatement || task.objective} /><p><code>{task.version}</code> · {nameOf(task.status)}</p>
      {!current && <p role="status">{tx('正在查看历史任务版本；认领、候选提交与交接请切换到当前版本。', 'Viewing a historical task version. Select the current version to claim, submit a candidate or hand off.')}</p>}
      {task.feedback && <RichProse text={task.feedback} />}{task.finding && <RichProse text={task.finding} />}
      {task.plannedDependencies.length > 0 && <p>{tx('前置任务：', 'Prerequisites: ')}{task.plannedDependencies.join(' · ')}</p>}
      {source && <details><summary>{tx('接手时的源码与检查上下文', 'Source and check context')}</summary><pre class="research-block-code">{source.source}</pre><p><code>{source.commit}</code></p>{observation.checks.filter(check => check.taskId === task.id && check.taskVersion === task.version).map(check => <code key={check.id}>{check.id}</code>)}</details>}
      <ErrorBox message={sourceResource.error} />{sourceResource.error && <button class="text-button" type="button" onClick={sourceResource.refresh}>{tx('重新读取固定源码', 'Reload the saved source')}</button>}
      {source && <BookmarkControl context={context} target={{ kind: 'task', projectId: project.id, runId: binding.runId, taskId: source.taskId, taskVersion: source.taskVersion, commit: source.commit }} />}
      {claims.length > 0 && <p>{claims.map(item => <span key={item.id}>{item.author.displayName} · {claimStatus(item.status)}　</span>)}</p>}</div>
      {!pinnedCommit && project.permissions.edit && <div class="research-actions"><button type="button" class="button" disabled={action.busy || !current || own?.status === 'claimed'} onClick={() => { if (current) void action.run('POST', `${projectPath(project.id)}/assignments`, { target, status: 'claimed', expectedRevision: project.revision }, changed); }}>{own?.status === 'claimed' ? tx('由我认领', 'Claimed by me') : tx('认领此任务', 'Claim task')}</button>
        {own?.status === 'claimed' && <button type="button" class="text-button" disabled={action.busy} onClick={() => void action.run('POST', `${projectPath(project.id)}/assignments`, { target: own.target, status: 'released', expectedRevision: project.revision }, changed)}>{tx('释放认领', 'Release claim')}</button>}
        {binding.permissions.proof && <button type="button" class="button" disabled={!current || !source || binding.status !== 'running'} onClick={() => { if (current && source && binding.status === 'running') onSubmitCandidate(target); }}>{tx('编写候选并送评审', 'Write a candidate for review')}</button>}
        <button type="button" class="text-button" onClick={() => onOpenIssue(target)}>{tx('就此任务发起议题', 'Open an issue for this task')}</button></div>}
      {feedback.length > 0 && <div class="collaboration-linked-feedback"><strong>{tx('提交物与评审进展', 'Submissions and review')}</strong>{feedback.map(item => <p key={item.id}><a href={`#feedback-${enc(item.id)}`} onClick={event => { event.preventDefault(); onRevealFeedback(item.id); }}>{item.text}</a> · {nameOf(item.proofCheck?.status ?? item.decision.status)}</p>)}</div>}
      {handoffs.map(item => <div class="collaboration-request" key={item.id}><strong>{item.author.displayName} → {item.recipient.displayName} · {invitationStatus(item)}</strong><RichProse text={item.note} />
        {!pinnedCommit && item.status === 'pending' && (item.recipient.id === selfId || item.author.id === selfId) && <div class="research-actions">{(item.recipient.id === selfId ? ['accept', 'decline'] : ['cancel']).map(choice => <button type="button" class="button" key={choice} disabled={action.busy || choice === 'accept' && !current} onClick={() => { if (choice !== 'accept' || current) void action.run('POST', `${projectPath(project.id)}/handoffs/${item.id}/respond`, { action: choice, expectedRevision: item.revision }, changed); }}>{choice === 'accept' ? tx('确认接手', 'Accept handoff') : choice === 'decline' ? tx('拒绝交接', 'Decline handoff') : tx('撤回交接', 'Cancel handoff')}</button>)}</div>}</div>)}
      {!pinnedCommit && current && project.permissions.edit && (own?.status === 'claimed' || project.permissions.manage) && <ResearchHandoffComposer key={`${selfId}:${project.id}:${binding.runId}:${task.id}`} project={project} selfId={selfId} target={target} feedbackIds={feedback.map(item => item.id)} refresh={changed} />}
    </>}
    <ErrorBox message={resource.error} /><MutationState action={action} />
  </section>;
}
