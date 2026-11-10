import path from 'node:path';
import { canonicalMathJson, mathDigest } from '../math/mathRuntimeIo';
import { limitMathOutput } from '../math/mathProcess';
import { qualifiedLeanReferences } from '../math/leanSyntax';
import type { ContextSection } from './contextCompiler';
import { indexKnowledgeContextSnapshot, knowledgeContextSections, searchKnowledgeContextSnapshot, taskKnowledgeSearchTarget,
  type KnowledgeContextSnapshot, type KnowledgeRetrieval } from './knowledgeContext';
import { committedSource, type SolverProblem } from './problem';
import { buildTheoremKnowledge } from './theoremKnowledge';
import { libraryKnowledgeCandidates } from './theoremKnowledgeLibrary';
import { knowledgeApplicationRelevant, knowledgeTypeExpression } from './theoremKnowledgeSearch';
import { splitIffConclusion, splitStatement, withStatementConclusion } from './theoremKnowledgeGoal';

/** Prepared once after startup library checks, using only this problem's pinned frozen modules. */
export function readInstalledLibrarySnapshot(problem: SolverProblem, environmentDigest: string): KnowledgeContextSnapshot | undefined {
  const frozen = problem.frozenFiles ?? {};
  if (!Object.keys(frozen).length) return undefined;
  const files = Object.fromEntries(Object.keys(frozen).sort().map(file => {
    const source = committedSource(problem.workspace, problem.baseCommit, path.join(problem.projectRelative, file));
    if (mathDigest(source) !== frozen[file]) throw new Error(`math_library_module_changed:${file}`);
    return [file, source];
  }));
  const { candidates } = libraryKnowledgeCandidates(files, {
    kind: 'frozen-library-pack', problemId: problem.contract.problemId, source: problem.activeProblemPath,
    sourceDigest: problem.receiptDigest, sourceCommit: problem.baseCommit, environmentDigest,
    problemReceiptDigest: problem.receiptDigest, receiptIds: [],
  }, { publicOnly: true });
  const { entries, evidence, contexts } = buildTheoremKnowledge(candidates);
  const base = { entries, evidence, contexts };
  return indexKnowledgeContextSnapshot({ digest: mathDigest(canonicalMathJson({ files: frozen, commit: problem.baseCommit,
    problemReceiptDigest: problem.receiptDigest, environmentDigest })), base });
}

type InstalledLibraryRetrievalInput = Omit<Parameters<typeof knowledgeContextSections>[0], 'knowledge'> & {
  library: KnowledgeContextSnapshot; taskText?: string; forApplication?: boolean;
};
const applicationSnapshots = new WeakMap<KnowledgeContextSnapshot, KnowledgeContextSnapshot>();

/** Filter before ranking and truncation; a definition cannot consume a theorem application slot. */
function applicationSnapshot(library: KnowledgeContextSnapshot): KnowledgeContextSnapshot {
  let snapshot = applicationSnapshots.get(library);
  if (!snapshot) {
    const entries = library.base.entries.filter(entry => entry.kind === 'lemma');
    snapshot = entries.length === library.base.entries.length ? library :
      indexKnowledgeContextSnapshot({ ...library, base: { ...library.base, entries } });
    applicationSnapshots.set(library, snapshot);
  }
  return snapshot;
}

/** Display and host applications share named requests, current targets and residuals from the same frozen library. */
export function installedLibraryRetrievals(input: InstalledLibraryRetrievalInput): KnowledgeRetrieval[] {
  const { problem } = input, library = input.forApplication ? applicationSnapshot(input.library) : input.library;
  let retrievals = knowledgeContextSections({ ...input, knowledge: library }).map(section => section.knowledge);
  if (!retrievals.length) return [];
  const handoffIds = new Set(retrievals.filter(retrieval => retrieval.sectionId.startsWith('knowledge-application-hints:'))
    .flatMap(retrieval => retrieval.candidateIds));
  const text = [input.action?.kind === 'task' ? input.action.task.objective : '', input.taskText ?? '',
    problem.contract.informalStatement].join('\n');
  const names = qualifiedLeanReferences(text), requested = new Set(names);
  const byName = new Map(library.base.entries.filter(entry => requested.has(entry.name) && problem.frozenFiles?.[entry.file] &&
    problem.frozenFiles[entry.file] === library.base.contexts[entry.contextDigest]?.[entry.file]).map(entry => [entry.name, entry]));
  const namedIds = names.flatMap(name => byName.has(name) ? [byName.get(name)!.id] : []).slice(0, 12);
  if (namedIds.length) retrievals = retrievals.map(retrieval => {
    const searchInputDigest = mathDigest(canonicalMathJson({ searchInputDigest: retrieval.searchInputDigest, namedIds }));
    return { ...retrieval, sectionId: `installed-library:${searchInputDigest}`, searchInputDigest,
      searchCandidateIds: [...new Set([...namedIds, ...(retrieval.searchCandidateIds ?? []), ...retrieval.candidateIds])].slice(0, 12),
      candidateIds: [...new Set([...namedIds, ...retrieval.candidateIds])].slice(0, 3) };
  });
  const target = input.forApplication && input.action?.kind === 'task'
    ? taskKnowledgeSearchTarget(problem, input.action.task)?.goal : undefined;
  if (!target) return retrievals;
  const entries = new Map(library.base.entries.map(entry => [entry.id, entry]));
  retrievals = retrievals.map(retrieval => {
    // Explicit requests and exact saved application handoffs remain usable without lexical overlap.
    const pool = [...new Set([...(retrieval.searchCandidateIds ?? []), ...retrieval.candidateIds])];
    const selected = pool.filter(id => {
      const entry = entries.get(id);
      return entry && (namedIds.includes(id) || handoffIds.has(id) || knowledgeApplicationRelevant(entry, target));
    });
    if (selected.length === pool.length) return retrieval;
    const searchInputDigest = mathDigest(canonicalMathJson({ searchInputDigest: retrieval.searchInputDigest,
      applicationCandidates: selected }));
    return { ...retrieval, sectionId: `installed-library:${searchInputDigest}`, searchInputDigest,
      searchCandidateIds: selected, candidateIds: selected.slice(0, 3) };
  });
  const targetShape = splitStatement(target);
  const localPremises = new Set(targetShape?.parts.filter(part => !part.binder).map(part => part.key));
  // Source headers can omit section parameters. Number only the binders used in the conclusion.
  const conclusionKey = (conclusion: string) => {
    const names = new Map<string, string>();
    return conclusion.replace(/\b_b\d+\b/gu, name => {
      if (!names.has(name)) names.set(name, `_b${names.size}`);
      return names.get(name)!;
    });
  };
  const targetConclusion = targetShape && conclusionKey(targetShape.conclusion);
  // Keep the same binder map for both propositions; independent maps could confuse different locals.
  const localConclusionPairs = new Set(targetShape && [...localPremises].map(premise =>
    conclusionKey(`${targetShape.conclusion}\n${premise}`)));
  return retrievals.map(retrieval => {
    const primary = [...new Set([...(retrieval.searchCandidateIds ?? []), ...retrieval.candidateIds])].slice(0, 12);
    const capacity = Math.min(3, 12 - Math.max(3, namedIds.length));
    if (capacity <= 0) return retrieval;
    const seeds = primary.flatMap(id => {
      const entry = entries.get(id);
      if (!entry || !problem.frozenFiles?.[entry.file] ||
          problem.frozenFiles[entry.file] !== library.base.contexts[entry.contextDigest]?.[entry.file]) return [];
      const shape = splitStatement(knowledgeTypeExpression(entry));
      const goals = new Set<string>();
      for (const premise of shape?.parts ?? []) {
        if (goals.size === 8) break;
        if (premise.binder) continue;
        // Reuse the current consumer's assumptions as ranking context; this does not instantiate the premise.
        const goal = withStatementConclusion(target, premise.key.replace(/\b_b\d+\b/gu, '_'));
        if (goal?.trim() && Buffer.byteLength(goal) <= 16000) goals.add(goal);
      }
      const localPremisesOnly = Boolean(shape && shape.parts.every(part => part.binder || localPremises.has(part.key)));
      const iff = shape && localPremisesOnly && splitIffConclusion(shape.conclusion);
      const localIffApplication = Boolean(iff && [iff, [iff[1], iff[0]]].some(([goal, premise]) =>
        localConclusionPairs.has(conclusionKey(`${goal}\n${premise}`))));
      return [{ id, goals: [...goals], sameConclusion: Boolean(shape && targetConclusion &&
        conclusionKey(shape.conclusion) === targetConclusion) || localIffApplication, localPremisesOnly }];
    });
    // Similar early candidates or a long premise list cannot monopolize the eight-query budget.
    const byGoal = new Map<string, string>();
    for (let rank = 0; rank < Math.max(0, ...seeds.map(seed => seed.goals.length)); rank++) {
      for (const seed of seeds) {
        const goal = seed.goals[rank];
        if (goal && !byGoal.has(goal) && byGoal.size < 8) byGoal.set(goal, seed.id);
      }
    }
    if (!byGoal.size) return retrieval;
    const requests = [...byGoal.keys()].map(goal => ({ query: '', goal }));
    const searches = searchKnowledgeContextSnapshot(library, requests, { limit: 3,
      environmentDigest: input.environmentDigest, problemReceiptDigest: problem.receiptDigest });
    const available = searches.map((search, index) => search.hits.map(hit => hit.id).filter(id => {
      const entry = entries.get(id);
      return !primary.includes(id) && entry && problem.frozenFiles?.[entry.file] &&
        problem.frozenFiles[entry.file] === library.base.contexts[entry.contextDigest]?.[entry.file] &&
        knowledgeApplicationRelevant(entry, requests[index]!.goal);
    }));
    const selected = new Set([...namedIds, ...primary.slice(0, 3)]), auxiliary: string[] = [];
    // Keep matching conclusions (including an iff applied to a local premise) and a local-premise alternative.
    for (const direct of [seeds.find(seed => seed.sameConclusion), seeds.find(seed => seed.localPremisesOnly)])
      if (direct && selected.size < 12) selected.add(direct.id);
    // Interleave query order and hit rank: later queries cannot crowd out every alternative of an earlier one.
    for (let diagonal = 0; diagonal < available.length + 2; diagonal++) for (let rank = 0; rank < 3; rank++) {
      const index = diagonal - rank, id = available[index]?.[rank];
      if (!id || selected.has(id) || auxiliary.length >= capacity) continue;
      const main = byGoal.get(requests[index]!.goal)!;
      const pair = [main, id].filter(candidate => !selected.has(candidate));
      if (selected.size + pair.length > 12) continue;
      for (const candidate of pair) selected.add(candidate);
      auxiliary.push(id);
    }
    if (!auxiliary.length) return retrieval;
    const pool = [...new Set([...selected, ...primary])].slice(0, 12);
    const searchInputDigest = mathDigest(canonicalMathJson({ searchInputDigest: retrieval.searchInputDigest, requests, pool }));
    return { ...retrieval, sectionId: `installed-library:${searchInputDigest}`, searchInputDigest,
      searchCandidateIds: pool, candidateIds: pool.slice(0, 3) };
  });
}

/** Add actionable imports to bounded recommendations, including definition interfaces for the worker. */
export function installedLibraryContextSections(input: InstalledLibraryRetrievalInput): ContextSection[] {
  const { problem, library } = input;
  const entries = new Map(library.base.entries.map(entry => [entry.id, entry]));
  return installedLibraryRetrievals(input).flatMap(retrieval => {
    const candidates = retrieval.candidateIds.flatMap(id => {
      const entry = entries.get(id)!;
      if (problem.frozenFiles?.[entry.file] !== library.base.contexts[entry.contextDigest]?.[entry.file]) return [];
      const module = entry.file.slice(0, -5).replaceAll('/', '.');
      return [{ name: entry.name, kind: entry.kind, typeKind: entry.typeKind,
        typePreview: limitMathOutput(entry.type, 800, 'head'), typeTruncated: Buffer.byteLength(entry.type) > 800,
        import: `import ${module}`, check: `#check ${entry.name}`,
        description: limitMathOutput(entry.description, 240, 'head'),
        source: { file: path.join(problem.projectRelative, entry.file), declaration: entry.name,
          commit: problem.baseCommit, sha256: problem.frozenFiles[entry.file] } }];
    });
    const packet = { schema: 'theorem-os.installed-library-context.v1', libraryDigest: library.digest,
      evidence: 'current-frozen-source', requiresFreshApplicationCheck: true,
      consumer: retrieval.consumer, searchSource: retrieval.searchSource,
      ...(retrieval.diagnostic ? { diagnostic: retrieval.diagnostic } : {}),
      nextStep: 'Inspect the full source header and section assumptions, import the relevant module, and test a concrete application before reproving the same fact. Use definitions by name; do not copy or redeclare frozen declarations. If a candidate does not fit, record the precise type or premise gap and continue.',
      omittedForBytes: 0, candidates };
    const title = 'Installed library candidates (available in this project; check the actual application):\n';
    let text = title + JSON.stringify(packet);
    while (Buffer.byteLength(text) > 4096 && candidates.length) {
      candidates.pop(); packet.omittedForBytes++;
      text = title + JSON.stringify(packet);
    }
    return candidates.length ? [{ id: `installed-library:${retrieval.searchInputDigest}`, kind: 'sources' as const,
      text, priority: 2 }] : [];
  });
}
