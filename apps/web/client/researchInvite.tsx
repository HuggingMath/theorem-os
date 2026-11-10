import { useEffect, useState } from 'preact/hooks';
import type { ResearchInvitationLink, ResearchInvitationLinkPreview } from '../researchCollaborationTypes';
import type { ResearchProjectDetail } from '../researchProjectTypes';
import { locale } from '../i18n';
import { Rich, RichProse } from './richText';
import { base, enc, ErrorBox, Field, MutationState, Panel, stamp, tx, useMutation, useResource, type Item, type ResearchContext } from './researchShared';

const roleName = (role: string) => role === 'reader' ? tx('只读成员', 'Reader') : tx('协作者', 'Collaborator');
const linkStatus = (status: ResearchInvitationLink['status']) => status === 'pending' ? tx('等待接受', 'Awaiting acceptance')
  : status === 'accepted' ? tx('已接受', 'Accepted') : tx('已撤销', 'Revoked');
export const invitationHref = (token: string) => `invite.html?${new URLSearchParams({ invite: token })}`;

export function ProjectInvitationLinks({ project, links, refresh }: { project: ResearchProjectDetail; links: ResearchInvitationLink[]; refresh(): void }) {
  const [role, setRole] = useState('reader'), [note, setNote] = useState(''), [confirmed, setConfirmed] = useState(false);
  const [created, setCreated] = useState<ResearchInvitationLink>(), [copied, setCopied] = useState(''), [copyError, setCopyError] = useState('');
  const create = useMutation(), revoke = useMutation();
  const shown = created && !links.some(link => link.id === created.id) ? [created, ...links] : links;
  const copy = async (link: ResearchInvitationLink) => {
    setCopied(''); setCopyError('');
    try { await navigator.clipboard.writeText(new URL(invitationHref(link.token), location.href).href); setCopied(link.id); }
    catch { setCopyError(tx('未能复制，请选中下面的邀请地址复制。', 'Copy was unavailable. Select and copy the invitation address below.')); }
  };
  return <section class="research-invitation-links" data-invitation-links>
    <details><summary>{tx('用链接邀请同事', 'Invite a colleague with a link')}</summary>
      <p>{tx('每个链接可由一位登录后的同事接受，无需公开个人主页。你可以在接受前撤销链接。', 'Each link can be accepted by one signed-in colleague. A public profile is not required. You can revoke it before acceptance.')}</p>
      <form class="research-form" onSubmit={event => { event.preventDefault(); if (!confirmed) return;
        void create.run<Item<ResearchInvitationLink>>('POST', `${base}/theorems/${enc(project.id)}/invitation-links`, {
          role, note, confirmed: true, expectedRevision: project.revision,
        }, result => { setCreated(result.item); setConfirmed(false); refresh(); }); }}>
        <label>{tx('加入后的角色', 'Role after joining')}<select data-invitation-link-role value={role} onChange={event => { setRole(event.currentTarget.value); setConfirmed(false); }}>
          <option value="reader">{roleName('reader')}</option><option value="collaborator">{roleName('collaborator')}</option></select></label>
        <Field label={tx('给同事的说明（可选）', 'Message to your colleague (optional)')} value={note} onInput={value => { setNote(value); setConfirmed(false); }} multiline maxLength={4000} />
        <label class="research-check"><input type="checkbox" data-confirm-invitation-link checked={confirmed} onChange={event => setConfirmed(event.currentTarget.checked)} />
          {tx('同意持链接的人登录后以所选角色加入；我会将链接发送给预期的同事。', 'A signed-in holder of this link may join in the selected role. I will send it to my intended colleague.')}</label>
        <button class="button" type="submit" data-create-invitation-link disabled={!confirmed || create.busy}>{tx('创建单人邀请链接', 'Create an invitation link')}</button>
        <MutationState action={create} />
      </form>
    </details>
    {shown.map(link => <article key={link.id} class="collaboration-request" data-invitation-link={link.id}>
      <p>{roleName(link.role)} · {linkStatus(link.status)} · {stamp(link.createdAt)}{link.acceptedBy && <> · {link.acceptedBy.displayName}</>}</p>
      {link.note && <RichProse text={link.note} />}
      {link.status === 'pending' && <><label>{tx('邀请地址', 'Invitation address')}<input class="research-invitation-address" readOnly value={new URL(invitationHref(link.token), location.href).href} onFocus={event => event.currentTarget.select()} /></label>
        <div class="research-actions"><button class="button" type="button" data-copy-invitation-link onClick={() => void copy(link)}>{copied === link.id ? tx('已复制', 'Copied') : tx('复制邀请链接', 'Copy invitation link')}</button>
          <button class="text-button" type="button" data-revoke-invitation-link disabled={revoke.busy} onClick={() => void revoke.run<Item<ResearchInvitationLink>>('POST', `${base}/theorems/${enc(project.id)}/invitation-links/${enc(link.id)}/revoke`,
            { expectedRevision: link.revision }, result => { if (created?.id === result.item.id) setCreated(result.item); refresh(); })}>{tx('撤销链接', 'Revoke link')}</button></div></>}
      {link.status === 'accepted' && <p>{tx('已加入的成员可在成员列表中管理。', 'Manage the colleague’s access in the member list.')}</p>}
    </article>)}
    <ErrorBox message={copyError} /><MutationState action={revoke} />
    {(create.error || revoke.error) && <button class="text-button" type="button" onClick={refresh}>{tx('重新读取邀请与成员状态', 'Reload invitation and membership status')}</button>}
  </section>;
}

export function ResearchInvitePage({ context }: { context: ResearchContext }) {
  const token = new URLSearchParams(location.search).get('invite') ?? '', valid = /^[A-Za-z0-9_-]{43}$/u.test(token);
  const data = useResource<Item<ResearchInvitationLinkPreview>>(valid ? `${base}/invitation-links/${enc(token)}` : undefined, 15000);
  const preview = data.data?.item, action = useMutation(), [confirmed, setConfirmed] = useState(false);
  useEffect(() => setConfirmed(false), [preview?.revision, preview?.status, context.session.researcherId]);
  const login = `login.html?${new URLSearchParams({ returnTo: 'invite', invite: token, lang: locale })}`;
  return <div class="research-invite-page" data-research-invite><header class="research-heading"><div><p class="research-eyebrow">TheoremOS</p>
    <h1>{tx('共同研究的邀请', 'An invitation to research together')}</h1></div></header>
    {!valid ? <Panel title={tx('邀请地址不完整', 'The invitation address is incomplete')}><p>{tx('请向邀请人获取完整链接。', 'Ask the inviter for the complete link.')}</p></Panel>
      : <Panel title={tx('项目邀请', 'Project invitation')}>
        {data.loading && !preview && <p role="status">{tx('正在读取邀请…', 'Loading the invitation…')}</p>}
        <ErrorBox message={data.error} />{data.error && <button class="button" type="button" onClick={data.refresh}>{tx('重新读取邀请', 'Reload invitation')}</button>}
        {preview && !preview.available && <p data-invitation-unavailable>{preview.status === 'revoked' ? tx('邀请人已撤销这个链接。请联系对方获取新的邀请。', 'The inviter revoked this link. Contact them for a new invitation.')
          : tx('这个单人链接已经被接受。请联系邀请人获取自己的邀请。', 'This single-person link has already been accepted. Ask the inviter for your own invitation.')}</p>}
        {preview?.available && <>{preview.project && <h3><Rich text={preview.project.title} /></h3>}<p>{tx('邀请人：', 'Invited by: ')}{preview.author?.displayName}</p>
          <p>{tx('加入角色：', 'Your role: ')}<strong>{roleName(preview.role!)}</strong></p>
          {preview.note && <RichProse text={preview.note} />}
          {preview.member ? <div class="research-actions"><p role="status" data-invitation-member>{tx('你已是这个项目的成员。', 'You are a member of this project.')}</p>
            <a class="button button-primary" data-open-invited-project href={`theorems.html?id=${enc(preview.project!.id)}`}>{tx('打开共同研究', 'Open the project')}</a></div>
            : <><p>{preview.role === 'reader' ? tx('可阅读项目内容和已向成员共享的研究；运行操作仍按单独授权开放。', 'Read the project and research shared with its members. Runtime actions still require their separate permissions.')
              : tx('可编辑项目并参与讨论；运行操作仍按单独授权开放。', 'Edit the project and join its discussions. Runtime actions still require their separate permissions.')}</p>
              {!context.session.authenticated ? <a class="button button-primary" data-invitation-login href={login}>{tx('登录 / 注册后核对并接受', 'Sign in or register to review and accept')}</a>
                : preview.canAccept && <form onSubmit={event => { event.preventDefault(); if (!confirmed) return;
                  void action.run<Item<ResearchInvitationLinkPreview>>('POST', `${base}/invitation-links/${enc(token)}/accept`, { confirmed: true, expectedRevision: preview.revision }, () => { setConfirmed(false); data.refresh(); }); }}>
                  <label class="research-check"><input type="checkbox" data-confirm-invitation-accept checked={confirmed} onChange={event => setConfirmed(event.currentTarget.checked)} />
                    {tx('我已核对项目、邀请人和角色，愿意加入。', 'I reviewed the project, inviter and role, and want to join.')}</label>
                  <button class="button button-primary" type="submit" data-accept-invitation-link disabled={!confirmed || action.busy}>{tx('接受邀请并加入', 'Accept and join')}</button>
                  <MutationState action={action} />{action.error && <button class="text-button" type="button" onClick={data.refresh}>{tx('重新核对邀请状态', 'Check invitation status again')}</button>}
                </form>}</>}
        </>}
      </Panel>}
  </div>;
}
