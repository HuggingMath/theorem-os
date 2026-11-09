import { useState } from 'preact/hooks';
import type { ResearchActivity, ResearchContribution, ResearcherProfile, ResearchProjectSummary } from '../researchProjectTypes';
import { t } from '../i18n';
import { RichProse } from './richText';
import { base, enc, Empty, ErrorBox, Field, FollowButton, libraryHref, MutationState, nameOf, Panel, personHref,
  Search, stamp, Tags, theoremHref, tx, useMutation, useResource, words, lines, type Item, type Items, type ResearchContext } from './researchShared';

type ProfileView = ResearcherProfile & { following?: boolean; projects: ResearchProjectSummary[]; contributions: ResearchContribution[] };
type FeedEvent = Omit<ResearchActivity, 'projectId'> & { projectId?: string; assetId?: string; assetVersion?: string; read?: boolean };
const eventHref = (event: FeedEvent) => event.assetId ? libraryHref(event.assetId, event.assetVersion) : event.projectId ? theoremHref(event.projectId, event.runId) : undefined;

export function PeoplePage({ context }: { context: ResearchContext }) {
  const selected = new URLSearchParams(location.search).get('id') ?? context.session.researcherId ?? '';
  const [query, setQuery] = useState(''), [field, setField] = useState(''), [offset, setOffset] = useState(0);
  const directory = useResource<Items<ResearcherProfile>>(`${base}/people?q=${enc(query)}&field=${enc(field)}&offset=${offset}&limit=12`);
  const profile = useResource<Item<ProfileView>>(selected ? `${base}/people/${enc(selected)}` : undefined);
  const own = Boolean(selected && selected === context.session.researcherId);
  return <><div class="research-heading"><div><span class="research-eyebrow">TheoremOS / People</span><h1>{tx('数学家与他们的研究', 'Mathematicians and their research')}</h1>
    <p>{tx('从具体贡献找到同行，继续共同推进的定理。', 'Discover colleagues through their contributions and continue shared research.')}</p></div>
    <div class="research-heading-actions"><a class="button" href={context.session.authenticated ? 'people.html' : 'login.html'}>{context.session.authenticated ? tx('我的主页', 'My profile') : tx('登录参与研究', 'Sign in to collaborate')}</a><a class="button" href="library.html?mine=1">{tx('我的 Agent 与 Skill', 'My agents and skills')}</a></div></div>
    <div class="research-layout" data-selected={Boolean(selected)}><aside class="research-sidebar"><Panel title={tx('发现同行', 'Find colleagues')}>
      <div class="research-form"><Search label={tx('姓名、简介或领域', 'Name, biography or field')} onSearch={value => { setQuery(value); setOffset(0); }} />
        <Field label={tx('按研究领域筛选', 'Filter by research field')} value={field} onInput={value => { setField(value); setOffset(0); }} /></div>
      <ErrorBox message={directory.error} />{directory.loading && <p class="research-status" role="status">{tx('正在读取…', 'Loading…')}</p>}
      <ul class="research-list">{directory.data?.items.map(person => <li key={person.id}><a class="research-list-item" href={personHref(person.id)} aria-current={selected === person.id ? 'true' : undefined}>
        <span class="research-item-title">{person.displayName}</span><span class="research-item-meta">{person.fields.join(' · ') || tx('尚未填写研究领域', 'No fields listed')}</span></a></li>)}</ul>
      {directory.data && !directory.data.items.length && <Empty>{tx('暂无匹配的公开资料。', 'No matching public profiles.')}</Empty>}
      <div class="research-actions">{offset > 0 && <button type="button" class="text-button" onClick={() => setOffset(Math.max(0, offset - 12))}>{tx('上一页', 'Previous')}</button>}
        {directory.data?.nextOffset !== undefined && <button type="button" class="text-button" onClick={() => setOffset(directory.data!.nextOffset!)}>{tx('下一页', 'Next')}</button>}</div>
    </Panel><Panel title={tx('从一道题开始', 'Start with a theorem')}><p class="research-description">{tx('建立研究题目、保留陈述版本，再把研究运行关联到定理。', 'Create a project, preserve statement versions and attach research runs.')}</p>
      <a class="button" href="theorems.html">{tx('浏览与创建定理', 'Explore and create theorems')}</a></Panel></aside>
    <div class="research-content"><ErrorBox message={profile.error} />{profile.data ? <Profile key={selected} profile={profile.data.item} own={own} canFollow={context.session.authenticated} refresh={profile.refresh} />
      : !profile.error && <Panel title={selected ? tx('数学家主页', 'Researcher profile') : tx('发现数学家', 'Discover mathematicians')}><Empty>{selected ? tx('正在读取资料…', 'Loading profile…') : tx('从目录查看公开资料，登录后可以保存自己的研究主页。', 'Browse public profiles in the directory. Sign in to create your research profile.')}</Empty></Panel>}
      {own && <><Notifications /><Feed /></>}
    </div></div></>;
}

function Profile({ profile, own, canFollow, refresh }: { profile: ProfileView; own: boolean; canFollow: boolean; refresh: () => void }) {
  const safeLinks = profile.links.filter(link => /^https?:\/\//iu.test(link));
  return <><Panel title={profile.displayName} actions={!own && (canFollow ? <FollowButton kind="person" id={profile.id} initial={profile.following} /> : <a class="button" href="login.html">{tx('登录后关注', 'Sign in to follow')}</a>)}>
    <div class="research-person"><div class="research-avatar" aria-hidden="true">{profile.displayName.slice(0, 1)}</div><div><Tags values={profile.fields} />
      <p class="research-status">{nameOf(profile.visibility)} · {tx('更新于 ', 'Updated ')}{stamp(profile.updatedAt)}</p></div></div>
    {profile.bio ? <div class="research-description"><RichProse text={profile.bio} /></div> : <Empty>{tx('尚未填写简介。', 'No biography yet.')}</Empty>}
    {safeLinks.length > 0 && <div class="research-actions">{safeLinks.map(link => <a key={link} class="research-inline-link" href={link} target="_blank" rel="noopener noreferrer">{link}</a>)}</div>}
    <div class="research-counter-row"><div><span class="research-count">{profile.projects.length}</span><span>{tx('可见参与项目', 'Visible projects')}</span></div>
      <div><span class="research-count">{profile.contributions.length}</span><span>{tx('贡献记录', 'Contributions')}</span></div><div><span class="research-count">{profile.fields.length}</span><span>{tx('研究领域', 'Fields')}</span></div></div>
    {own && <details><summary>{tx('编辑我的资料', 'Edit my profile')}</summary><ProfileEditor profile={profile} refresh={refresh} /></details>}
  </Panel><Panel title={own ? tx('我的研究', 'My research') : tx('参与的研究', 'Research projects')}>
    <ul class="research-list">{profile.projects.map(project => <li key={project.id}><a class="research-list-item" href={theoremHref(project.id)}>
      <span class="research-item-title">{project.title}</span><span class="research-item-meta"><span>{project.owner.displayName}</span><span>{nameOf(project.visibility)}</span><span>{stamp(project.updatedAt)}</span></span></a></li>)}</ul>
    {!profile.projects.length && <Empty>{tx('还没有可展示的研究。', 'No research projects to display yet.')}</Empty>}
  </Panel><Panel title={tx('贡献与来源', 'Contributions and sources')} note={tx('每条记录都对应实际提交的版本、反馈或产物。', 'Each record points to a submitted version, feedback or artifact.')}>
    {profile.contributions.map(contribution => <article class="research-event" key={contribution.id}><div class="research-item-meta"><span>{nameOf(contribution.kind)}</span><time dateTime={contribution.createdAt}>{stamp(contribution.createdAt)}</time></div>
      <p>{contribution.assetId ? <a href={libraryHref(contribution.assetId, contribution.assetVersion)}>{contribution.summary}</a>
        : contribution.projectId ? <a href={theoremHref(contribution.projectId, contribution.runId)}>{contribution.summary}</a> : contribution.summary}</p>{contribution.evidenceRefs.length > 0 && <Tags values={contribution.evidenceRefs} />}</article>)}
    {!profile.contributions.length && <Empty>{tx('尚无贡献记录。你可以在定理页发起题目、修订陈述或提出建议。', 'No contributions recorded yet. Create a theorem, revise its statement or contribute a suggestion.')}</Empty>}
  </Panel></>;
}

function ProfileEditor({ profile, refresh }: { profile: ProfileView; refresh: () => void }) {
  const [draft, setDraft] = useState<ResearcherProfile>(profile), action = useMutation();
  const [fields, setFields] = useState(profile.fields.join(', ')), [links, setLinks] = useState(profile.links.join('\n'));
  const update = <K extends keyof ResearcherProfile>(key: K, value: ResearcherProfile[K]) => setDraft(previous => ({ ...previous, [key]: value }));
  const newer = profile.revision > draft.revision;
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
      <div class="research-actions"><button class="button" type="button" disabled={action.busy} onClick={() => { setDraft(current => ({ ...current, revision: profile.revision })); action.setError(''); }}>
        {t('已核对，保留我的编辑')}</button>
        <button class="button" type="button" disabled={action.busy} onClick={() => { setDraft(profile); setFields(profile.fields.join(', ')); setLinks(profile.links.join('\n')); action.setError(''); }}>
          {t('使用最新资料替换当前编辑')}</button></div>
      <p class="research-field-note">{t('保留编辑后仍需点击保存，确认提交你的资料。')}</p></section>}
    {action.error && !newer && <button class="text-button" type="button" onClick={refresh}>{t('读取最新资料，保留编辑')}</button>}
    <MutationState action={action} /><button class="button button-primary" type="submit" disabled={action.busy || newer}>{action.busy ? tx('正在保存…', 'Saving…') : tx('保存资料', 'Save profile')}</button>
  </form>;
}

function Feed() {
  const [field, setField] = useState('');
  const feed = useResource<Items<FeedEvent>>(`${base}/feed?field=${enc(field)}&limit=30`, 15000);
  return <Panel title={tx('同行动态', 'Following feed')} note={tx('你关注的数学家和定理的可见更新。', 'Visible updates from mathematicians and theorems you follow.')}>
    <Field label={tx('按领域筛选', 'Filter by field')} value={field} onInput={setField} /><ErrorBox message={feed.error} />
    {feed.data?.items.map(event => <FeedRow key={event.id} event={event} />)}
    {feed.data && !feed.data.items.length && <Empty>{tx('暂时没有动态。关注数学家或定理后，相关进展会出现在这里。', 'No updates yet. Follow researchers or theorems to see their progress here.')}</Empty>}
  </Panel>;
}
function FeedRow({ event }: { event: FeedEvent }) {
  const href = eventHref(event);
  return <article class="research-event"><div class="research-item-meta"><a href={personHref(event.actor.id)}>{event.actor.displayName}</a><time dateTime={event.createdAt}>{stamp(event.createdAt)}</time>
    {event.read === false && <span class="research-chip">{tx('未读', 'Unread')}</span>}</div><p>{href ? <a href={href}>{event.summary}</a> : event.summary}</p></article>;
}
function Notifications() {
  const notifications = useResource<Items<FeedEvent>>(`${base}/notifications?limit=20`, 15000), action = useMutation();
  const unread = notifications.data?.items.filter(item => !item.read).length ?? 0;
  return <Panel title={tx('需要关注的更新', 'Updates for you')} actions={unread > 0 && <button class="text-button" type="button" disabled={action.busy}
    onClick={() => void action.run('POST', `${base}/notifications/read`, { through: new Date().toISOString() }, notifications.refresh)}>{tx('全部标为已读', 'Mark all as read')}</button>}>
    <ErrorBox message={notifications.error} /><MutationState action={action} />{notifications.data?.items.map(event => <FeedRow key={event.id} event={event} />)}
    {notifications.data && !notifications.data.items.length && <Empty>{tx('当前没有需要处理的更新。', 'You are up to date.')}</Empty>}
  </Panel>;
}
