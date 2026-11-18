import path from 'node:path';
import { mathDigest } from '../math/mathRuntimeIo';
import { leanDeclarationKeys } from '../math/leanSource';
import type { SolverRunState } from './archive';
import { readAgentTeamProofDelivery, type AgentTeamProofDelivery } from './agentTeamProof';
import { git, committedSource } from './problem';
import { locateKnowledgeDeclaration } from './theoremKnowledge';

export function deliveredDeclarationChange(delivery: AgentTeamProofDelivery, file: string, name: string) {
  const changes = delivery.changes.filter(c => c.file === file && c.before !== c.after && (c.name === name || name.endsWith('.' + c.name)));
  return changes.length === 1 ? changes[0] : undefined;
}

/** Direct, recorded transfers of identical declarations. A missing source never establishes authorship. */
export function teamDeclarationForwarding(state: SolverRunState, proofsRoot: string) {
  const team = state.agentTeam!, archive = path.join(proofsRoot, 'sources.git');
  const deliveries = new Map<string, AgentTeamProofDelivery>(), sources = new Map<string, string>();
  function read(id: string) {
    if (deliveries.has(id)) return deliveries.get(id)!;
    const ref = team.deliveries.find(r => r.id === id);
    const expected = path.join(proofsRoot, 'deliveries', id + '.json');
    if (!/^[0-9a-f]{64}$/u.test(id) || ref?.path !== expected) throw new Error('math_knowledge_run_team_delivery_not_found');
    const d = readAgentTeamProofDelivery(expected, state);
    if (d.id !== id || d.agentId !== ref.agentId || d.provenance?.taskId && d.provenance.taskId !== ref.taskId)
      throw new Error('math_knowledge_run_team_delivery_changed');
    deliveries.set(id, d);
    return d;
  }
  function version(at: string, file: string, name: string) {
    const key = at + '\0' + file, source = sources.get(key) ?? committedSource(archive, at, path.posix.join(state.problem.projectRelative, file));
    sources.set(key, source);
    try {
      const loc = locateKnowledgeDeclaration(source, name);
      if (loc.qualifiedName !== name) return;
      const body = source.slice(source.lastIndexOf('\n', loc.startOffset - 1) + 1, loc.endOffset).trimEnd() + '\n';
      return { key: leanDeclarationKeys(source).get(loc.startOffset), digest: mathDigest(body) };
    } catch (error) {
      if (error instanceof Error && error.message === 'math_knowledge_declaration_missing_or_ambiguous') return;
      throw error;
    }
  }
  function origins(d: AgentTeamProofDelivery, file: string, name: string) {
    const result = new Map<string, {deliveryId: string; producerId: string; taskId: string}>();
    const change = deliveredDeclarationChange(d, file, name);
    if (!change) return [];
    for (const e of d.provenance?.exposures ?? []) {
      if (e.kind !== 'adopted' || result.has(e.deliveryId)) continue;
      try {
        const origin = read(e.deliveryId), ref = team.deliveries.find(r => r.id === e.deliveryId)!;
        if (origin.agentId !== e.agentId || origin.id === d.id || ref.taskId !== e.taskId || origin.commit !== e.commit ||
            !origin.declarations.some(decl => decl.file === file && decl.name.replace(/^_root_\./u, '') === name)) continue;
        const before = deliveredDeclarationChange(origin, file, name);
        if (!before || before.after !== change.after) continue;
        const digest = mathDigest(change.after);
        const same = (at: string) => {
          const v = version(at, file, name);
          return v?.key === change.name && v.digest === digest;
        };
        if (!same(origin.commit) || !same(d.commit)) continue;
        for (const a of team.adoptions) {
          if (a.deliveryId !== e.deliveryId || a.targetId !== d.agentId || a.status !== 'completed' ||
              !a.expectedCommit || !a.commit || a.expectedCommit === a.commit) continue;
          git(archive, ['merge-base', '--is-ancestor', a.commit, d.commit]);
          if (same(a.commit) && !same(a.expectedCommit)) {
            result.set(origin.id, { deliveryId: origin.id, producerId: origin.agentId, taskId: ref.taskId });
            break;
          }
        }
      } catch { /* Keep verified deliveries usable even if optional historical transfer evidence is missing. */ }
    }
    return [...result.values()];
  }
  return { read, origins };
}
