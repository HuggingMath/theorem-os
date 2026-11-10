import type { ResearchProjectDetail } from '../researchProjectTypes';
import { tx } from './researchShared';

/** Project responses expose only the names and roles visible in this collaboration. */
export function projectPeople(project: ResearchProjectDetail) {
  return [{ id: project.owner.id, displayName: project.owner.displayName, role: 'owner' as const },
    ...project.members.map(member => ({ id: member.researcherId, displayName: member.displayName ?? member.researcherId, role: member.role }))];
}
export const projectRoleName = (role: string) => role === 'owner' ? tx('发起者', 'Owner') : role === 'reader' ? tx('只读成员', 'Reader') : tx('协作者', 'Collaborator');
export const projectPersonLabel = (person: ReturnType<typeof projectPeople>[number]) => `${person.displayName} · ${projectRoleName(person.role)}`;
