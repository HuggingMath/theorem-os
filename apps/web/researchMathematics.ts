import { canonicalMathJson, mathDigest } from '../../src/math/mathRuntimeIo';
import { getLeanTaskEnvironment } from '../../src/math/leanTaskEnvironment';
import { inspectScopedLeanDeclarations } from '../../src/math/leanSource';
import { mathConstructionImports, mathConstructionImportSpans } from '../../src/math/mathConstructionSources';
import { LIBRARY_PACK_SCHEMA, libraryPackDigest, parseLibraryPack, selectLibraryDeclarations, type LibraryPack } from '../../src/math/libraryPacks';
import type { ResearchLibraryPack, ResearchMathSource } from './researchAssetTypes';
import type { ResolvedResearchMathematics } from './researchAssets';
import type { WebJobs } from './jobs';
import type { WebKnowledgeService } from './knowledgeService';
import type { WebRunner } from './runner';
import { leanDiagnostics } from './precheck';
import { WebStorage, WebStorageError } from './storage';

const fail = (status: number, message: string): never => { throw new WebStorageError(status, message); };
const moduleName = (file: string) => file.slice(0, -5).replaceAll('/', '.');

/** Source objects are read from owned server records. Publication never accepts a client-supplied pack or receipt. */
export function researchMathematics(storage: WebStorage, knowledge: WebKnowledgeService, jobs: WebJobs, runner: WebRunner) {
  async function resolve(owner: string, reference: ResearchMathSource): Promise<ResolvedResearchMathematics> {
    const files: Record<string, string> = {}, roots: string[] = [];
    const origins: Record<string, ResearchLibraryPack['modules'][number]['origin']> = {};
    let environment: 'standard' | 'mathlib' | undefined, runId: string | undefined, commit: string | undefined;
    let declarations: ResolvedResearchMathematics['declarations'] = [];
    if (reference.kind === 'knowledge') {
      const catalog = knowledge.getCatalog(owner, reference.catalogDigest) ?? fail(404, '知识目录不存在。');
      for (const id of reference.entryIds) {
        const entry = catalog.entries.find(item => item.id === id) ?? fail(404, '所选声明不在此知识目录。');
        const solverIds = new Set(entry.provenance.flatMap(item => item.runId ? [item.runId] : []));
        const matchingRun = jobs.list(owner).find(run => solverIds.has(run.id) || Boolean(run.observation && solverIds.has(run.observation.solverRunId))
          || Boolean(run.solverAttempt && solverIds.has(run.solverAttempt.solverRunId)));
        const entryEnvironment = matchingRun?.environment ?? (['standard', 'mathlib'] as const)
          .find(value => entry.environmentDigest === getLeanTaskEnvironment(value).dependencyDigest);
        if (!entryEnvironment) fail(409, '无法确认该知识来源的固定证明环境，请从原运行发布。');
        if (environment && environment !== entryEnvironment) fail(409, '不能合并不同环境的数学成果。');
        environment = entryEnvironment;
        const origin = entry.provenance.find(item => item.sourceCommit) ?? entry.provenance[0];
        const sourceCommit = origin.sourceCommit && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(origin.sourceCommit)
          ? origin.sourceCommit : fail(409, '知识来源缺少精确源码提交，请从完整运行快照发布。');
        const provenance = (file: string): ResearchLibraryPack['modules'][number]['origin'] => ({ kind: 'run',
          runId: origin.runId ?? `knowledge-${entry.contextDigest.slice(0, 24)}`, commit: sourceCommit, file,
          environmentDigest: getLeanTaskEnvironment(entryEnvironment).dependencyDigest });
        for (const [file, digest] of Object.entries(catalog.contexts[entry.contextDigest] ?? {})) {
          if (!file.endsWith('.lean')) continue;
          const source = catalog.sources[digest] ?? fail(409, '知识源码依赖缺失。');
          if (files[file] !== undefined && files[file] !== source) fail(409, `源码版本冲突：${file}`);
          files[file] = source;
          origins[file] ??= provenance(file);
        }
        origins[entry.file] = provenance(entry.file);
        roots.push(entry.file);
        declarations.push({ name: entry.name, type: entry.type, file: entry.file });
      }
    } else {
      const run = jobs.get(owner, reference.runId) ?? fail(404, '运行不存在或不属于你。');
      environment = run.environment; runId = run.id;
      const observations = storage.listObservations(owner, run.id).reverse();
      const saved = observations.flatMap(item => item.sources).find(item => (!reference.taskId || item.taskId === reference.taskId)
        && (!reference.commit || item.commit === reference.commit));
      if (saved) {
        commit = saved.commit;
        const catalog = run.knowledgeCatalogDigest && knowledge.getCatalog(owner, run.knowledgeCatalogDigest);
        const entry = catalog && catalog.entries.find(item => item.file === saved.file && item.provenance.some(origin =>
          origin.sourceCommit === saved.commit && (!reference.taskId || origin.taskId === reference.taskId)));
        if (entry && catalog) for (const [file, digest] of Object.entries(catalog.contexts[entry.contextDigest] ?? {}))
          if (file.endsWith('.lean') && catalog.sources[digest] !== undefined) files[file] = catalog.sources[digest];
        for (const source of observations.flatMap(item => item.sources).filter(item => item.commit === commit)) {
          // sourceDigest identifies the complete owned-file set, not this single projected file.
          for (const item of [{ file: source.file, source: source.source }, ...(source.dependencySources ?? [])]) {
            if (files[item.file] !== undefined && files[item.file] !== item.source) fail(409, '目录与运行观测的精确源码不一致。');
            files[item.file] = item.source;
          }
        }
        roots.push(saved.file);
        // Dependencies already frozen into this run remain byte-for-byte identical in the publication.
        for (const module of run.researchConfiguration?.libraryPack?.modules ?? []) {
          if (files[module.file] !== undefined && files[module.file] !== module.source) fail(409, '冻结数学库与记录的源码不一致。');
          files[module.file] = module.source; origins[module.file] = module.origin;
        }
      } else fail(404, '这个精确版本的源码没有保存，请选择已记录的任务和提交。');
      if (reference.taskId) {
        // A task ID identifies a declaration, not every theorem sharing its owned source file.
        // Resolve the name from the saved task version rather than a later plan for the same ID.
        const snapshot = observations.find(item => item.sources.some(source => source.taskId === saved!.taskId
          && source.taskVersion === saved!.taskVersion && source.commit === saved!.commit && source.file === saved!.file)
          && [...item.inspection.tasks, ...(item.history ?? [])].some(task => task.id === saved!.taskId && task.version === saved!.taskVersion));
        const task = snapshot && [...snapshot.inspection.tasks, ...(snapshot.history ?? [])]
          .find(item => item.id === saved!.taskId && item.version === saved!.taskVersion);
        const planned = snapshot?.inspection.tasks.some(item => item.id === task?.id && item.version === saved!.taskVersion)
          ? snapshot.plan?.tasks.find(item => item.id === task?.id) : undefined;
        const available = inspectScopedLeanDeclarations(files[roots[0]]!).filter(item => item.kind === 'theorem');
        const name = (task?.theorem ?? planned?.theoremName ?? (available.length === 1 ? available[0].qualifiedName : undefined))
          ?? fail(409, '无法确认这个任务版本的精确数学声明，请选择有完整任务记录的来源。');
        if (planned?.proofPath && planned.proofPath !== saved!.file)
          fail(409, '无法确认这个任务版本的精确数学声明，请选择有完整任务记录的来源。');
        try { files[roots[0]] = selectLibraryDeclarations(files[roots[0]], [name]); }
        catch { fail(409, '无法唯一确定所选任务的数学声明，请核对任务版本与 Lean 名称。'); }
      }
      declarations = inspectScopedLeanDeclarations(files[roots[0]]!).filter(item => item.kind === 'theorem')
        .map(item => ({ name: item.qualifiedName, type: item.declarationType, file: roots[0] }));
    }
    if (!environment || !roots.length || !declarations.length) fail(400, '发布物需要至少一个具名数学声明。');
    // Only reachable local files are shared; unrelated research files and account data stay outside the pack.
    const byModule = new Map(Object.keys(files).map(file => [moduleName(file), file]));
    const closure = new Set<string>();
    const visit = (file: string) => {
      if (closure.has(file)) return;
      if (files[file] === undefined) fail(409, `数学成果的源码不完整：${file}`);
      closure.add(file);
      for (const name of mathConstructionImports(files[file])) {
        const dependency = byModule.get(name);
        if (dependency) visit(dependency);
        else if (name === 'Submission' || name.startsWith('Submission.')) fail(409, `缺少本地依赖：${name}`);
      }
    };
    roots.forEach(visit);
    const identity = mathDigest(canonicalMathJson([...closure].sort().map(file => [file, files[file]])));
    const mapping = new Map([...closure].sort().map((file, index) => [file,
      file.startsWith('Submission/Library/') ? file : `Submission/Library/Shared_${identity.slice(0, 20)}/Part${index}.lean`]));
    const modules = [...closure].sort().map(file => {
      let source = files[file];
      for (const span of mathConstructionImportSpans(source).reverse()) {
        const local = byModule.get(span.name), renamed = local && mapping.get(local);
        if (renamed) source = source.slice(0, span.start) + moduleName(renamed) + source.slice(span.end);
      }
      return { file: mapping.get(file)!, source, origin: origins[file] ?? { kind: 'run' as const, runId: runId ?? `knowledge-${identity.slice(0, 24)}`,
        commit: commit && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit) ? commit : identity,
        file, environmentDigest: getLeanTaskEnvironment(environment).dependencyDigest } };
    });
    let pack: LibraryPack;
    try { pack = parseLibraryPack({ schema: LIBRARY_PACK_SCHEMA, modules }); }
    catch (error) { fail(400, error instanceof Error ? error.message : '数学库无法完整打包。'); }
    return { pack: pack!, environment: environment!, environmentDigest: getLeanTaskEnvironment(environment).dependencyDigest,
      declarations: declarations.map(item => ({ ...item, file: mapping.get(item.file)! })) };
  }
  async function validate(material: ResolvedResearchMathematics, signal: AbortSignal) {
    if (!runner.check) fail(503, '当前运行器不能独立检查数学库。');
    const pack = parseLibraryPack(material.pack), digest = libraryPackDigest(pack);
    const source = pack.modules.map(item => `import ${moduleName(item.file)}`).join('\n') + '\n';
    const result = await runner.check!({ environment: material.environment, source, libraryPack: pack }, signal);
    const diagnostics = leanDiagnostics(result.output);
    const passed = result.exitCode === 0 && !result.timedOut && !diagnostics.errors && !diagnostics.sorries;
    const receipt = { schema: 'theorem-os.research-library-check.v1', packDigest: digest,
      environment: material.environment, environmentDigest: material.environmentDigest, passed,
      exitCode: result.exitCode, timedOut: result.timedOut, diagnostics: diagnostics.diagnostics,
      checkedAt: new Date().toISOString() };
    const id = mathDigest(canonicalMathJson(receipt));
    storage.saveRecord(['research', 'checks', `${id}.json`], receipt, true);
    return { passed, receiptRefs: [id], ...(!passed ? { reason: result.timedOut ? '数学库检查超时。'
      : diagnostics.diagnostics.find(item => item.severity === 'error')?.message ?? '数学库未通过独立编译，请补全源码和依赖。' } : {}) };
  }
  return { resolve, validate };
}
