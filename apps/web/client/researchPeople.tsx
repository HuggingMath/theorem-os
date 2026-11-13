import { useEffect, useState } from 'preact/hooks';
import type { ResearchActivity, ResearchContribution, ResearcherDirectory, ResearcherProfile, ResearchProjectSummary, ResearchPage } from '../researchProjectTypes';
import { t } from '../i18n';
import { loginHref, researchContextHref } from '../shared';
import { RichProse } from './richText';
import { CollaborationInbox } from './collaborationFlow';
import { withPeopleReturn } from './researchPeopleReturn';
import { api, base, enc, Empty, ErrorBox, errorText, Field, FollowButton, libraryHref, MutationState, nameOf, Panel, personHref,
  Search, stamp, Tags, theoremHref, tx, useMutation, useResource, words, lines, type Item, type Items, type ResearchContext } from './researchShared';

type ProfileView = ResearcherProfile & { following?: boolean; projects: ResearchProjectSummary[]; contributions: ResearchContribution[] };
type FeedEvent = Omit<ResearchActivity, 'projectId'> & { projectId?: string; assetId?: string; assetVersion?: string; read?: boolean };
function eventHref(event: FeedEvent | ResearchContribution, section: string, search = location.search) {
  if (event.assetId) return libraryHref(event.assetId, event.assetVersion);
  if (!event.projectId) return;
  const href = theoremHref(event.projectId, event.runId, { feedbackId: event.feedbackId, statementVersionId: event.statementVersionId });
  return withPeopleReturn(`${href}${event.statementVersionId && !event.feedbackId ? '#statement-versions' : ''}`, `${location.pathname}${search}#${section}`);
}
function peoplePageHref(query: string, field: string, offset: number, id?: string) {
  const parameters = new URLSearchParams();
  if (id) parameters.set('id', id);
  if (query) parameters.set('q', query);
  if (field) parameters.set('field', field);
  if (offset) parameters.set('offset', String(offset));
  const search = parameters.toString();
  return researchContextHref(`people.html${search ? `?${search}` : ''}`, location.search);
}

function revealProfileEditor() {
  const panel = document.getElementById('profile-management'), details = panel?.querySelector('details');
  if (details) details.open = true;
  requestAnimationFrame(() => { panel?.scrollIntoView({ block: 'start' }); panel?.querySelector('input')?.focus({ preventScroll: true }); });
}

export function PeoplePage({ context }: { context: ResearchContext }) {
  const parameters = new URLSearchParams(location.search), selected = parameters.get('id')
    ?? (parameters.get('editProfile') === '1' && context.session.authenticated ? context.session.researcherId ?? '' : '');
  const [query, setQuery] = useState(parameters.get('q') ?? ''), [field, setField] = useState(parameters.get('field') ?? ''), [offset, setOffset] = useState(() => {
    const value = Number(parameters.get('offset'));
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  });
  const [queryDraft, setQueryDraft] = useState(query);
  const directory = useResource<ResearcherDirectory>(selected ? undefined : `${base}/people?q=${enc(query)}&field=${enc(field)}&offset=${offset}&limit=12`);
  const profile = useResource<Item<ProfileView>>(selected ? `${base}/people/${enc(selected)}` : undefined);
  const own = Boolean(selected && selected === context.session.researcherId);
  const directoryHref = peoplePageHref(query, field, offset), ownId = context.session.researcherId;
  const updateDirectory = (nextQuery: string, nextField: string, nextOffset: number) => {
    const nextPage = nextQuery !== query || nextField !== field ? 0 : nextOffset;
    setQuery(nextQuery); setQueryDraft(nextQuery); setField(nextField); setOffset(nextPage);
    history.replaceState(null, '', peoplePageHref(nextQuery, nextField, nextPage));
  };
  const editProfileHref = ownId ? `${peoplePageHref(query, field, offset, ownId)}#profile-management`
    : loginHref(`${directoryHref}${directoryHref.includes('?') ? '&' : '?'}editProfile=1#profile-management`);
  return <><div class="research-heading"><div><span class="research-eyebrow">TheoremOS / People</span><h1>{selected ? profile.data?.item.displayName.trim() || (own ? tx('我的主页', 'My profile') : tx('数学家主页', 'Researcher profile')) : tx('发现同行', 'Discover mathematicians')}</h1>
    <p>{selected ? tx('了解研究方向、参与的定理与贡献来源。', 'Explore research interests, theorem projects and contributions.') : tx('按姓名、简介或研究领域寻找数学家，再从主页了解他们的研究。', 'Find mathematicians by name, biography or field, then explore their research.')}</p></div>
    <div class="research-heading-actions">{selected && <a class="button" href={directoryHref}>{tx('发现同行', 'Discover mathematicians')}</a>}
      <a class="button" href={context.session.authenticated && ownId ? peoplePageHref(query, field, offset, ownId) : loginHref(location.pathname + location.search + location.hash)} aria-current={own ? 'page' : undefined}>{context.session.authenticated && ownId ? tx('我的主页', 'My profile') : tx('登录参与研究', 'Sign in to collaborate')}</a>
      {own && <a class="button" href="#profile-management" onClick={revealProfileEditor}>{tx('完善我的资料', 'Complete my profile')}</a>}
      {context.session.authenticated && <a class="button" href={researchContextHref('library.html?mine=1&type=agent', location.search)}>{tx('我的 Agent 与 Skill', 'My agents and skills')}</a>}</div></div>
    {!selected ? <section class="research-discovery research-page-section" aria-label={tx('数学家目录', 'Mathematician directory')}>
      <div class="research-directory-toolbar" hidden={Boolean(directory.data && !directory.data.items.length && !query && !field && offset === 0)}><Search label={tx('姓名、简介或领域', 'Name, biography or field')} value={queryDraft} onInput={setQueryDraft} onSearch={value => updateDirectory(value, field, 0)} />
        <label class="research-field research-people-field-input"><span>{tx('按研究领域筛选', 'Filter by research field')}</span>
          <input value={field} list="research-directory-fields" onInput={event => updateDirectory(queryDraft.trim(), event.currentTarget.value, 0)} placeholder={tx('选择或输入研究领域', 'Choose or enter a research field')} />
          <datalist id="research-directory-fields">{directory.data?.fields?.map(value => <option key={value} value={value} />)}</datalist></label></div>
      <ErrorBox message={directory.error} />{directory.loading && <p class="research-status" role="status">{tx('正在读取…', 'Loading…')}</p>}
      <ul class="research-directory-grid">{directory.data?.items.map(person => {
        const href = peoplePageHref(query, field, offset, person.id);
        return <li class="research-directory-card" key={person.id}>
          <div class="research-person"><div class="research-avatar" aria-hidden="true">{person.displayName.slice(0, 1)}</div><h2 class="research-card-heading"><a href={href}>{person.displayName}</a></h2></div>
          {person.fields.length ? <PeopleFields fields={person.fields} onSelect={value => updateDirectory(queryDraft.trim(), value, 0)} /> : <p class="research-status">{tx('尚未填写研究领域', 'No fields listed')}</p>}
          <div class="research-card-description"><RichProse text={person.bio || tx('尚未填写简介。', 'No biography yet.')} /></div>
          {person.research && <div class="research-person-work" data-person-research={person.id}>
            <p class="research-status">{tx(`${person.research.projectCount} 项研究 · ${person.research.contributionCount} 项贡献`, `${person.research.projectCount} projects · ${person.research.contributionCount} contributions`)}</p>
            {person.research.latestProject && <a href={theoremHref(person.research.latestProject.id)}>{tx('最近研究：', 'Latest project: ')}{person.research.latestProject.title}</a>}
            {person.research.latestContribution && <p>{tx('最近贡献：', 'Latest contribution: ')}{person.research.latestContribution.summary}</p>}
            {!person.research.projectCount && !person.research.contributionCount && <p class="research-status">{tx('暂无可见研究或贡献记录。', 'No visible projects or contributions yet.')}</p>}
          </div>}
          <a class="research-inline-link" href={href}>{tx('查看主页', 'View profile')} →</a>
        </li>;
      })}</ul>
      {directory.data && !directory.data.items.length && <div data-people-empty>
        <Empty>{query || field || offset > 0 ? tx('没有匹配的数学家。可以清除筛选后重新寻找。', 'No matching mathematicians. Clear the filters to try again.')
          : tx('还没有公开的数学家资料。完善并公开你的资料，让同行找到你。', 'No public profiles yet. Complete and publish your profile so others can find you.')}</Empty>
        <div class="research-actions">{(query || field || offset > 0) && <button class="button" type="button" data-people-reset onClick={() => updateDirectory('', '', 0)}>{tx('清除筛选', 'Clear filters')}</button>}
          <a class="button" href={editProfileHref}>{context.session.authenticated ? tx('完善我的资料', 'Complete my profile') : tx('登录完善资料', 'Sign in to complete your profile')}</a></div>
      </div>}
      <div class="research-actions">{offset > 0 && <button type="button" class="text-button" onClick={() => updateDirectory(queryDraft.trim(), field, Math.max(0, offset - 12))}>{tx('上一页', 'Previous')}</button>}
        {directory.data?.nextOffset !== undefined && <button type="button" class="text-button" onClick={() => updateDirectory(queryDraft.trim(), field, directory.data!.nextOffset!)}>{tx('下一页', 'Next')}</button>}</div>
    </section> : <div class="research-content"><nav class="research-breadcrumb" aria-label={tx('返回目录', 'Back to directory')}><a href={directoryHref}>← {tx('返回数学家目录', 'Back to mathematicians')}</a></nav>
      <ErrorBox message={profile.error} />{own && profile.data && <section id="profile-updates" class="research-own-overview" data-own-research-overview>
        <CollaborationInbox context={context} />
      </section>}{profile.data ? <Profile key={selected} profile={profile.data.item} own={own} selfId={ownId ?? ''} canFollow={context.session.authenticated} refresh={profile.refresh} />
        : !profile.error && <Panel title={tx('数学家主页', 'Researcher profile')}><Empty>{tx('正在读取资料…', 'Loading profile…')}</Empty></Panel>}
      {own && <Feed />}
    </div>}</>;
}

function PeopleFields({ fields, onSelect }: { fields: string[]; onSelect?: (field: string) => void }) {
  return <div class="research-chips">{fields.map(value => onSelect
    ? <button key={value} type="button" class="research-chip research-field-choice" data-people-field={value} onClick={() => onSelect(value)}>{value}</button>
    : <a key={value} class="research-chip research-field-choice" data-people-field={value} href={peoplePageHref('', value, 0)}>{value}</a>)}</div>;
}

function Profile({ profile, own, selfId, canFollow, refresh }: { profile: ProfileView; own: boolean; selfId: string; canFollow: boolean; refresh: () => void }) {
  const [adding, setAdding] = useState(false);
  useEffect(() => { if (own && location.hash === '#profile-management') revealProfileEditor(); }, [own, profile.id]);
  const safeLinks = profile.links.filter(link => /^https?:\/\//iu.test(link));
  const projects = own ? [...profile.projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) : profile.projects;
  const signIn = loginHref(location.pathname + location.search + location.hash);
  return <><Panel title={tx('研究方向与简介', 'Research interests and biography')} actions={!own && <div class="research-profile-actions">
    {canFollow ? <FollowButton kind="person" id={profile.id} initial={profile.following} /> : <a class="button" href={signIn}>{tx('登录后关注', 'Sign in to follow')}</a>}
    {canFollow && selfId ? <button class="button" type="button" data-add-researcher={profile.id} aria-expanded={adding} onClick={() => setAdding(value => !value)}>{tx('添加到我的题目', 'Add to my theorem')}</button>
      : <a class="button" href={signIn}>{tx('登录后添加到题目', 'Sign in to add to a theorem')}</a>}
  </div>}>
    <div class="research-person"><div class="research-avatar" aria-hidden="true">{profile.displayName.slice(0, 1)}</div><div><PeopleFields fields={profile.fields} />
      <p class="research-status">{nameOf(profile.visibility)}{profile.updatedAt && <> · {tx('更新于 ', 'Updated ')}{stamp(profile.updatedAt)}</>}</p></div></div>
    {profile.bio ? <div class="research-description"><RichProse text={profile.bio} /></div> : <Empty>{tx('尚未填写简介。', 'No biography yet.')}</Empty>}
    {safeLinks.length > 0 && <div class="research-actions">{safeLinks.map(link => <a key={link} class="research-inline-link" href={link} target="_blank" rel="noopener noreferrer">{link}</a>)}</div>}
    {adding && canFollow && selfId && <ProjectPicker selfId={selfId} researcherId={profile.id} />}
  </Panel><nav class="research-section-nav" aria-label={tx('主页内容', 'Profile sections')}><a href="#research-projects">{tx('参与的研究', 'Research projects')}</a><a href="#research-contributions">{tx('贡献与来源', 'Contributions and sources')}</a>
    {own && <><a href="#profile-management">{tx('资料设置', 'Profile settings')}</a><a href="#profile-updates">{tx('我的更新', 'My updates')}</a></>}</nav>
    <Panel id="research-projects" title={own ? tx('我的研究', 'My research') : tx('参与的研究', 'Research projects')}>
    <ul class="research-list">{projects.map(project => <li key={project.id}><a class="research-list-item" href={theoremHref(project.id)}>
      <span class="research-item-title">{project.title}</span><span class="research-item-meta"><span>{project.owner.displayName}</span><span>{nameOf(project.visibility)}</span><span>{stamp(project.updatedAt)}</span></span></a></li>)}</ul>
    {!profile.projects.length && <Empty>{tx('还没有可展示的研究。', 'No research projects to display yet.')}</Empty>}
  </Panel><Panel id="research-contributions" title={tx('贡献与来源', 'Contributions and sources')} note={tx('每条记录都对应实际提交的版本、反馈或产物。', 'Each record points to a submitted version, feedback or artifact.')}>
    {profile.contributions.map(contribution => <article class="research-event" key={contribution.id}><div class="research-item-meta"><span>{nameOf(contribution.kind)}</span><time dateTime={contribution.createdAt}>{stamp(contribution.createdAt)}</time></div>
      <p>{eventHref(contribution, 'research-contributions') ? <a data-research-contribution={contribution.id} href={eventHref(contribution, 'research-contributions')}>{contribution.summary}</a>
        : contribution.summary}</p>{contribution.evidenceRefs.length > 0 && <Tags values={contribution.evidenceRefs} />}</article>)}
    {!profile.contributions.length && <Empty>{tx('尚无贡献记录。你可以在定理页发起题目、修订陈述或提出建议。', 'No contributions recorded yet. Create a theorem, revise its statement or contribute a suggestion.')}</Empty>}
  </Panel>{own && <Panel id="profile-management" title={tx('资料设置', 'Profile settings')}><details><summary>{tx('编辑我的资料', 'Edit my profile')}</summary><ProfileEditor profile={profile} refresh={refresh} /></details></Panel>}</>;
}

function ProjectPicker({ selfId, researcherId }: { selfId: string; researcherId: string }) {
  const [projects, setProjects] = useState<ResearchProjectSummary[]>([]), [loading, setLoading] = useState(true),
    [error, setError] = useState(''), [selected, setSelected] = useState(''), [revision, setRevision] = useState(0);
  useEffect(() => {
    let live = true;
    setLoading(true); setError('');
    void (async () => {
      const found: ResearchProjectSummary[] = [];
      let offset: number | undefined = 0;
      while (offset !== undefined) {
        const page: ResearchPage<ResearchProjectSummary> = await api(`${base}/theorems?author=${enc(selfId)}&offset=${offset}&limit=100`);
        if (!live) return;
        found.push(...page.items.filter(project => project.permissions.manage));
        offset = page.nextOffset;
      }
      if (live) { setProjects(found); setLoading(false); }
    })().catch(cause => { if (live) { setError(errorText(cause)); setLoading(false); } });
    return () => { live = false; };
  }, [selfId, revision]);
  return <form class="research-project-picker" data-researcher-project-picker onSubmit={event => {
    event.preventDefault();
    if (projects.some(project => project.id === selected)) location.assign(`${theoremHref(selected)}&addResearcher=${enc(researcherId)}#research-members`);
  }}>
    <ErrorBox message={error} />{error && <button class="text-button" type="button" onClick={() => setRevision(value => value + 1)}>{tx('重新读取我的题目', 'Reload my theorems')}</button>}
    {loading && <p class="research-status" role="status">{tx('正在读取我管理的题目…', 'Loading theorems I manage…')}</p>}
    {!loading && !error && (projects.length ? <><label class="research-field"><span>{tx('选择我管理的题目', 'Choose a theorem I manage')}</span>
      <select value={selected} onChange={event => setSelected(event.currentTarget.value)} required><option value="">{tx('选择题目', 'Select a theorem')}</option>
        {projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}</select></label>
      <p class="research-field-note">{tx('这里只预填成员，保存后才会加入题目。', 'This only prefills the member form. Save there to add the collaborator.')}</p>
      <button class="button" type="submit" disabled={!selected}>{tx('前往成员表单', 'Open member form')}</button></>
      : <p class="research-status">{tx('还没有可管理的题目。', 'You have no theorems to manage yet.')} <a href={researchContextHref(`theorems.html?${new URLSearchParams({ collection: 'research', create: '1', addResearcher: researcherId })}`, location.search)}>{tx('创建题目', 'Create a theorem')} →</a></p>)}
  </form>;
}

function ProfileEditor({ profile, refresh }: { profile: ProfileView; refresh: () => void }) {
  const [draft, setDraft] = useState<ResearcherProfile>(profile), action = useMutation();
  const [fields, setFields] = useState(profile.fields.join(', ')), [links, setLinks] = useState(profile.links.join('\n'));
  const update = <K extends keyof ResearcherProfile>(key: K, value: ResearcherProfile[K]) => setDraft(previous => ({ ...previous, [key]: value }));
  const newer = profile.revision > draft.revision;
  const keepEditing = () => {
    const alreadySaved = profile.displayName === draft.displayName.trim() && profile.bio === draft.bio && profile.visibility === draft.visibility &&
      JSON.stringify(profile.fields) === JSON.stringify(words(fields)) && JSON.stringify(profile.links) === JSON.stringify(lines(links));
    // The unchanged saved intent can recover its original receipt; replacing a reviewed newer edit is a new submission.
    if (alreadySaved) action.setError(''); else action.reset();
    setDraft(current => ({ ...current, revision: profile.revision }));
  };
  const save = async () => {
    if (newer) return;
    await action.run<Item<ResearcherProfile>>('PUT', `${base}/profile`,
      { displayName: draft.displayName.trim(), fields: words(fields), bio: draft.bio, links: lines(links), visibility: draft.visibility, expectedRevision: draft.revision },
      result => setDraft(current => ({ ...current, revision: result.item.revision, updatedAt: result.item.updatedAt })));
    refresh();
  };
  return <form class="research-form" onSubmit={event => { event.preventDefault(); void save(); }}>
    <Field label={tx('显示名', 'Display name')} value={draft.displayName} onInput={value => update('displayName', value)} required maxLength={80} />
    <Field label={tx('研究领域，用逗号分隔', 'Research fields, separated by commas')} value={fields} onInput={setFields} />
    <Field label={tx('简介', 'Biography')} value={draft.bio} onInput={value => update('bio', value)} multiline rows={4} maxLength={4000} />
    <Field label={tx('公开链接，每行一个', 'Public links, one per line')} value={links} onInput={setLinks} multiline rows={2} />
    <label>{tx('资料可见范围', 'Profile visibility')}<select value={draft.visibility} onChange={event => update('visibility', event.currentTarget.value as ResearcherProfile['visibility'])}>
      <option value="private">{tx('仅自己', 'Private')}</option><option value="public">{tx('公开', 'Public')}</option></select></label>
    {newer && <section class="research-publication" aria-label={t('核对最新资料')}><p class="research-status">{t('资料已在其他页面更新。你的编辑仍保留，请核对后选择如何继续。')}</p>
      <dl class="research-facts"><div><dt>{t('最新显示名')}</dt><dd>{profile.displayName}</dd></div>
        <div><dt>{t('最新研究领域')}</dt><dd>{profile.fields.join(', ') || '—'}</dd></div>
        <div><dt>{t('最新简介')}</dt><dd>{profile.bio || '—'}</dd></div>
        <div><dt>{t('最新公开链接')}</dt><dd>{profile.links.join('\n') || '—'}</dd></div>
        <div><dt>{t('最新可见范围')}</dt><dd>{nameOf(profile.visibility)}</dd></div></dl>
      <div class="research-actions"><button class="button" type="button" disabled={action.busy} onClick={keepEditing}>
        {t('已核对，保留我的编辑')}</button>
        <button class="button" type="button" disabled={action.busy} onClick={() => { setDraft(profile); setFields(profile.fields.join(', ')); setLinks(profile.links.join('\n')); action.reset(); }}>
          {t('使用最新资料替换当前编辑')}</button></div>
      <p class="research-field-note">{t('保留编辑后仍需点击保存，确认提交你的资料。')}</p></section>}
    {action.error && !newer && <button class="text-button" type="button" onClick={refresh}>{t('读取最新资料，保留编辑')}</button>}
    <MutationState action={action} /><button class="button button-primary" type="submit" disabled={action.busy || newer}>{action.busy ? tx('正在保存…', 'Saving…') : tx('保存资料', 'Save profile')}</button>
  </form>;
}

function Feed() {
  const [field, setField] = useState(new URLSearchParams(location.search).get('feedField') ?? '');
  const feed = useResource<Items<FeedEvent>>(`${base}/feed?field=${enc(field)}&limit=30`, 15000);
  const source = new URLSearchParams(location.search); field ? source.set('feedField', field) : source.delete('feedField');
  return <Panel id="research-feed" title={tx('同行动态', 'Following feed')} note={tx('你关注的数学家和定理的可见更新。', 'Visible updates from mathematicians and theorems you follow.')}>
    <Field label={tx('按领域筛选', 'Filter by field')} value={field} onInput={setField} placeholder={tx('输入研究领域', 'Enter a research field')} /><ErrorBox message={feed.error} />
    {feed.data?.items.map(event => <FeedRow key={event.id} event={event} section="research-feed" search={`?${source}`} />)}
    {feed.data && !feed.data.items.length && <Empty>{tx('暂时没有动态。关注数学家或定理后，相关进展会出现在这里。', 'No updates yet. Follow researchers or theorems to see their progress here.')}</Empty>}
  </Panel>;
}
function FeedRow({ event, section, search }: { event: FeedEvent; section: string; search?: string }) {
  const href = eventHref(event, section, search);
  return <article class="research-event" data-research-feed-event={event.id}><div class="research-item-meta"><a href={personHref(event.actor.id)}>{event.actor.displayName}</a><time dateTime={event.createdAt}>{stamp(event.createdAt)}</time>
    {event.read === false && <span class="research-chip">{tx('未读', 'Unread')}</span>}</div><p>{href ? <a href={href}>{event.summary}</a> : event.summary}</p></article>;
}
