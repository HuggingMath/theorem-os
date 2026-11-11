import { describe, expect, it } from 'vitest';
import { WebStorage, WebStorageError } from '../apps/web/storage';
import { WebResearchProjects } from '../apps/web/researchProjects';

const owner = 'account:team-owner', colleague = 'account:team-colleague', outsider = 'account:team-outsider';
function fixture(visibility: 'private' | 'members' | 'public' = 'private') {
  const storage = new WebStorage(), projects = new WebResearchProjects(storage);
  for (const [account, displayName] of [[owner, 'Owner'], [colleague, 'Colleague'], [outsider, 'Other']]) projects.saveProfile(account,
    { requestId: `profile-${displayName}`, expectedRevision: 0, displayName, visibility: 'public' });
  const project = projects.create(owner, { requestId: 'project', title: 'Team research', visibility });
  return { storage, projects, project, colleagueId: projects.identity(colleague) };
}
function denied(action: () => unknown, status: number) {
  try { action(); throw new Error('Expected a storage error'); }
  catch (cause) { expect(cause).toBeInstanceOf(WebStorageError); expect((cause as WebStorageError).status).toBe(status); }
}

describe('member visibility confirmation', () => {
  it('keeps an owner-only project unchanged until the visibility change is explicitly confirmed', () => {
    const { projects, project, colleagueId } = fixture();
    const input = { requestId: 'add-colleague', expectedRevision: project.revision, role: 'collaborator' };
    denied(() => projects.setMember(owner, project.id, colleagueId, input), 409);
    expect(projects.detail(owner, project.id)).toMatchObject({ visibility: 'private', revision: project.revision, members: [] });
    denied(() => projects.detail(colleague, project.id), 404);
    const confirmed = { ...input, confirmMembersVisibility: true };
    const saved = projects.setMember(owner, project.id, colleagueId, confirmed);
    expect(saved).toMatchObject({ visibility: 'members', members: [{ researcherId: colleagueId, role: 'collaborator' }] });
    expect(projects.detail(colleague, project.id).permissions).toMatchObject({ member: true, edit: true });
    denied(() => projects.detail(outsider, project.id), 404);
    expect(projects.setMember(owner, project.id, colleagueId, confirmed).revision).toBe(saved.revision);
  });
  it('requires the reviewed project revision before changing visibility and does not require consent for already shared projects', () => {
    const { projects, project, colleagueId } = fixture();
    projects.update(owner, project.id, { requestId: 'new-project-details', expectedRevision: project.revision, description: 'New context' });
    denied(() => projects.setMember(owner, project.id, colleagueId, { requestId: 'stale-consent', expectedRevision: project.revision,
      role: 'reader', confirmMembersVisibility: true }), 409);
    const latest = projects.detail(owner, project.id); expect(latest.visibility).toBe('private'); expect(latest.members).toHaveLength(0);
    const shared = projects.update(owner, project.id, { requestId: 'share-first', expectedRevision: latest.revision, visibility: 'members' });
    projects.setMember(owner, project.id, colleagueId, { requestId: 'shared-member', expectedRevision: shared.revision, role: 'reader' });
    expect(projects.detail(colleague, project.id).permissions).toMatchObject({ member: true, edit: false });
  });
  it('does not change private visibility when removing an old inconsistent membership', () => {
    const { storage, projects, project, colleagueId } = fixture();
    const stored = storage.getRecord<any>(['research', 'projects', `${project.id}.json`])!;
    stored.project.members = [{ researcherId: colleagueId, role: 'collaborator' }];
    storage.saveRecord(['research', 'projects', `${project.id}.json`], stored);
    const removed = projects.setMember(owner, project.id, colleagueId, { requestId: 'remove-old-member', expectedRevision: project.revision, role: null });
    expect(removed).toMatchObject({ visibility: 'private', members: [] });
  });
});

describe('invitations after joining through another route', () => {
  it('closes a collaborator invitation after joining with a reader link without promoting the role', () => {
    const { storage, projects, project, colleagueId } = fixture();
    const invitation = projects.invite(owner, project.id, { requestId: 'invite-colleague', expectedRevision: project.revision,
      recipientId: colleagueId, role: 'collaborator', note: 'Work on the proof.' });
    const link = projects.createInvitationLink(owner, project.id, { requestId: 'reader-link', expectedRevision: projects.detail(owner, project.id).revision, role: 'reader', confirmed: true });
    projects.acceptInvitationLink(colleague, link.token, { requestId: 'join-via-link', expectedRevision: 0, confirmed: true });
    const item = projects.collaborationInbox(colleague).items.find(item => item.invitation?.id === invitation.id)!;
    expect(item).toMatchObject({ category: 'progress', resolved: true,
      invitation: { status: 'joined', role: 'collaborator', currentMemberRole: 'reader' } });
    expect(item.href).toContain(`id=${project.id}`); expect(item.href).toContain('#collaboration-members');
    expect(projects.collaborationInbox(colleague).counts.decision).toBe(0);
    expect(projects.collaboration(colleague, project.id).invitations[0]).toMatchObject({ status: 'joined', currentMemberRole: 'reader' });
    const oldButton = { requestId: 'stale-accept-button', expectedRevision: invitation.revision, action: 'accept' };
    expect(projects.respondInvitation(colleague, project.id, invitation.id, oldButton)).toMatchObject({ status: 'joined', currentMemberRole: 'reader' });
    expect(projects.respondInvitation(colleague, project.id, invitation.id, oldButton)).toMatchObject({ status: 'joined', currentMemberRole: 'reader' });
    expect(projects.detail(owner, project.id).members.map(({ researcherId, role }) => ({ researcherId, role }))).toEqual([{ researcherId: colleagueId, role: 'reader' }]);
    const stored = storage.getRecord<any>(['research', 'projects', `${project.id}.json`])!;
    expect(stored.collaboration.invitations[0]).toMatchObject({ status: 'joined', role: 'collaborator' });
    expect(stored.collaboration.invitations[0].currentMemberRole).toBeUndefined();
    denied(() => projects.respondInvitation(outsider, project.id, invitation.id, { requestId: 'other-accept', expectedRevision: 0, action: 'accept' }), 404);
    denied(() => projects.respondInvitation(owner, project.id, invitation.id, { requestId: 'author-accept', expectedRevision: 0, action: 'accept' }), 403);
  });
  it('also closes a public join application when the owner directly adds the applicant with another role', () => {
    const { projects, project, colleagueId } = fixture('public');
    const application = projects.requestJoin(colleague, project.id, { requestId: 'apply', role: 'collaborator', note: 'Let me contribute.' });
    projects.setMember(owner, project.id, colleagueId, { requestId: 'owner-adds-reader', expectedRevision: projects.detail(owner, project.id).revision, role: 'reader' });
    for (const account of [owner, colleague]) {
      const item = projects.collaborationInbox(account).items.find(item => item.invitation?.id === application.id)!;
      expect(item).toMatchObject({ category: 'progress', resolved: true, invitation: { status: 'joined', currentMemberRole: 'reader', role: 'collaborator' } });
    }
    expect(projects.respondInvitation(owner, project.id, application.id, { requestId: 'old-application-accept', expectedRevision: 0, action: 'accept' }).status).toBe('joined');
    const promoted = projects.setMember(owner, project.id, colleagueId, { requestId: 'explicit-role-change', expectedRevision: projects.detail(owner, project.id).revision, role: 'collaborator' });
    expect(promoted.members[0].role).toBe('collaborator');
    expect(projects.collaborationInbox(colleague).items.find(item => item.invitation?.id === application.id)?.invitation?.currentMemberRole).toBe('collaborator');
  });
  it('derives a closed view for legacy duplicates and never revives their invitation after removal', () => {
    const { storage, projects, project, colleagueId } = fixture('members');
    const invitation = projects.invite(owner, project.id, { requestId: 'legacy-invite', expectedRevision: project.revision,
      recipientId: colleagueId, role: 'collaborator', note: 'A pending invitation from the old build.' });
    const stored = storage.getRecord<any>(['research', 'projects', `${project.id}.json`])!;
    stored.project.members = [{ researcherId: colleagueId, role: 'reader' }];
    storage.saveRecord(['research', 'projects', `${project.id}.json`], stored);
    expect(projects.collaborationInbox(colleague).items.find(item => item.invitation?.id === invitation.id)).toMatchObject({ resolved: true, invitation: { status: 'joined', currentMemberRole: 'reader' } });
    expect(storage.getRecord<any>(['research', 'projects', `${project.id}.json`])!.collaboration.invitations[0].status).toBe('pending');
    projects.setMember(owner, project.id, colleagueId, { requestId: 'remove-reader', expectedRevision: projects.detail(owner, project.id).revision, role: null });
    const removed = projects.collaborationInbox(colleague).items.find(item => item.invitation?.id === invitation.id)!;
    expect(removed).toMatchObject({ resolved: true, href: '', invitation: { status: 'joined' } });
    expect(removed.invitation?.currentMemberRole).toBeUndefined();
    expect(projects.respondInvitation(colleague, project.id, invitation.id, { requestId: 'stale-button-after-removal', expectedRevision: 0, action: 'accept' }).status).toBe('joined');
    expect(projects.detail(owner, project.id).members).toHaveLength(0); denied(() => projects.detail(colleague, project.id), 404);
  });
  it('handles a legacy duplicate accept without forcing another membership or role change', () => {
    const { storage, projects, project, colleagueId } = fixture('members');
    const invitation = projects.invite(owner, project.id, { requestId: 'old-invite', expectedRevision: project.revision,
      recipientId: colleagueId, role: 'collaborator', note: 'Legacy invitation.' });
    const stored = storage.getRecord<any>(['research', 'projects', `${project.id}.json`])!;
    stored.project.members = [{ researcherId: colleagueId, role: 'reader' }]; storage.saveRecord(['research', 'projects', `${project.id}.json`], stored);
    const result = projects.respondInvitation(colleague, project.id, invitation.id, { requestId: 'accept-legacy', expectedRevision: 0, action: 'accept' });
    expect(result).toMatchObject({ status: 'joined', currentMemberRole: 'reader' });
    expect(projects.detail(owner, project.id).members.map(({ researcherId, role }) => ({ researcherId, role }))).toEqual([{ researcherId: colleagueId, role: 'reader' }]);
  });
  it('preserves a normal single-channel acceptance and current runtime permissions', () => {
    const { projects, project, colleagueId } = fixture();
    const invitation = projects.invite(owner, project.id, { requestId: 'ordinary-invite', expectedRevision: project.revision,
      recipientId: colleagueId, role: 'collaborator', note: 'Normal collaboration.' });
    const accepted = projects.respondInvitation(colleague, project.id, invitation.id, { requestId: 'accept-ordinary', expectedRevision: 0, action: 'accept' });
    expect(accepted).toMatchObject({ status: 'accepted', role: 'collaborator', currentMemberRole: 'collaborator' });
    expect(projects.detail(colleague, project.id)).toMatchObject({ visibility: 'members', permissions: { member: true, edit: true }, runs: [] });
    expect(projects.collaborationInbox(colleague).items.find(item => item.invitation?.id === invitation.id)).toMatchObject({ resolved: true, category: 'progress' });
  });
});
