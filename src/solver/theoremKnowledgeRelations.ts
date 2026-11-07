import type { TheoremKnowledgeBase, TheoremKnowledgeEntry } from './theoremKnowledge';

export type KnowledgeRelation = Readonly<{
  seedId: string; entryId: string; direction: 'dependency' | 'consumer'; kind: 'statement' | 'proof';
  coverage: TheoremKnowledgeEntry['dependencies']['coverage'];
  referenceSemantics: 'local-transitive-closure';
}>;
type Resolution = 'ambiguous' | 'source-available' | 'missing-source' | 'unknown-environment';
type UnresolvedRelation = { seedId: string; file: string; name: string; resolution: Resolution };
type RelationBase = Pick<TheoremKnowledgeBase, 'entries'> & Partial<Pick<TheoremKnowledgeBase, 'contexts'>>;
const maxReferences = 256, maxDiagnostics = 8;

/** Index recorded metadata, never source text. A relation is not a direct proof dependency. */
export function createKnowledgeRelationIndex(base: RelationBase) {
  const entries = new Map(base.entries.map(item => [item.id, item]));
  const endpoints = new Map<string, TheoremKnowledgeEntry[]>();
  const incoming = new Map<string, { entry: TheoremKnowledgeEntry; kind: 'statement' | 'proof' }[]>();
  const key = (item: TheoremKnowledgeEntry, file = item.file, name = item.name) =>
    JSON.stringify([item.contextDigest, item.environmentDigest, file, name]);
  const knownEnvironment = (item: TheoremKnowledgeEntry) => Boolean(item.environmentDigest?.trim());
  let indexTruncated = false;
  for (const entry of base.entries) {
    if (!knownEnvironment(entry)) continue;
    const identity = key(entry), versions = endpoints.get(identity) ?? [];
    versions.push(entry); endpoints.set(identity, versions);
  }
  for (const entry of [...base.entries].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!knownEnvironment(entry) || !base.contexts?.[entry.contextDigest]?.[entry.file]) continue;
    for (const kind of ['statement', 'proof'] as const) {
      const references = entry.dependencies[kind];
      indexTruncated ||= references.length > maxReferences;
      for (const reference of references.slice(0, maxReferences)) {
        const identity = key(entry, reference.file, reference.name), consumers = incoming.get(identity) ?? [];
        consumers.push({ entry, kind }); incoming.set(identity, consumers);
      }
    }
  }
  return {
    /** All endpoints use the complete context, a known equal environment and a unique file/name. */
    expand(seedIds: readonly string[], limit: number) {
      const relations: KnowledgeRelation[] = [], unresolved: UnresolvedRelation[] = [], seen = new Set(seedIds);
      let truncated = indexTruncated;
      const diagnose = (seed: TheoremKnowledgeEntry, file: string, name: string, resolution: Resolution) => {
        if (unresolved.length < maxDiagnostics) unresolved.push({ seedId: seed.id, file, name, resolution });
        else truncated = true;
      };
      const add = (seed: TheoremKnowledgeEntry, entry: TheoremKnowledgeEntry, direction: KnowledgeRelation['direction'],
        kind: KnowledgeRelation['kind'], coverage: KnowledgeRelation['coverage']) => {
        if (seen.has(entry.id)) return;
        if (relations.length >= limit) { truncated = true; return; }
        seen.add(entry.id); relations.push({ seedId: seed.id, entryId: entry.id, direction, kind, coverage,
          referenceSemantics: 'local-transitive-closure' });
      };
      for (const seedId of seedIds) {
        const seed = entries.get(seedId);
        if (!seed || !base.contexts) continue;
        if (!knownEnvironment(seed)) { diagnose(seed, seed.file, seed.name, 'unknown-environment'); continue; }
        const files = base.contexts[seed.contextDigest];
        if (!files?.[seed.file]) { diagnose(seed, seed.file, seed.name, 'missing-source'); continue; }
        if (endpoints.get(key(seed))?.length !== 1) { diagnose(seed, seed.file, seed.name, 'ambiguous'); continue; }
        for (const kind of ['statement', 'proof'] as const) {
          for (const reference of seed.dependencies[kind].slice(0, maxReferences)) {
            const targets = files[reference.file] ? endpoints.get(key(seed, reference.file, reference.name)) ?? [] : [];
            const resolution = !files[reference.file] ? 'missing-source' : targets.length === 1 ? undefined
              : targets.length ? 'ambiguous' : 'source-available';
            if (resolution) diagnose(seed, reference.file, reference.name, resolution);
            else add(seed, targets[0]!, 'dependency', kind, seed.dependencies.coverage);
          }
        }
        const consumers = incoming.get(key(seed)) ?? [];
        truncated ||= consumers.length > maxReferences;
        for (const { entry, kind } of consumers.slice(0, maxReferences)) {
          if (endpoints.get(key(entry))?.length !== 1) { diagnose(seed, entry.file, entry.name, 'ambiguous'); continue; }
          add(seed, entry, 'consumer', kind, entry.dependencies.coverage);
        }
      }
      return { relations, unresolved, truncated };
    },
  };
}
