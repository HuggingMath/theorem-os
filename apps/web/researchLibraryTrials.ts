import { z } from 'zod';
import { canonicalMathJson, mathDigest } from '../../src/math/mathRuntimeIo';
import { inspectLeanDeclarationRegions, inspectScopedLeanDeclarations } from '../../src/math/leanSource';
import { mathConstructionImports } from '../../src/math/mathConstructionSources';
import { LIBRARY_PACK_SCHEMA, libraryPackDigest, parseLibraryPack, type LibraryPack } from '../../src/math/libraryPacks';
import type { WebResearchAssets } from './researchAssets';
import type { WebResearchProjects } from './researchProjects';
import type { WebJobs } from './jobs';
import type { WebRunner } from './runner';
import type { WebRun } from './shared';
import type { WebInspectedTask, WebTaskSource } from './collaboration';
import type { ResearchAssetRelease, ResearchConfigurationSelection, ResearchLibraryPack } from './researchAssetTypes';
import type { ResearchLibraryTrial, ResearchLibraryTrialTarget, ResearchLibraryTrialTargetRef, ResearchLibraryTrialReceipt,
  ResearchLibraryCandidateAttachment, ResearchLibraryProposalTarget, ResearchLibraryAttemptPreparation } from './researchLibraryTrialTypes';
import { WebStorage, WebStorageError } from './storage';
import { selectWebLibraryPack } from './frozenLibrary';
import { researchCandidateScopeReason } from './researchCandidateScope';
import { leanDiagnostics } from './precheck';

const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u), version = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u);
const hash = z.string().regex(/^[a-f0-9]{64}$/u), text = (max: number, min = 0) => z.string().min(min).max(max).refine(value => !value.includes('\0'));
const targetSchema = z.object({ runId: key, projectId: key.optional(), taskId: z.string().min(1).max(200), taskVersion: z.string().min(1).max(200),
  commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u), sourceDigest: hash, environmentDigest: hash, file: text(512, 1) }).strict();
const fail = (status: number, message: string): never => { throw new WebStorageError(status, message); };
const parse = <T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> => {
  const result = schema.safeParse(value); if (!result.success) fail(400, '成果试用请求格式无效。'); return result.data!;
};
type Dependencies = { storage: WebStorage; projects: WebResearchProjects; assets: WebResearchAssets; jobs: WebJobs; runner: WebRunner };
type Stored = { intent: string; draft: ResearchLibraryTrial; libraryPack: LibraryPack; dependencySources: { file: string; source: string }[];
  candidateTarget: { name: string; expectedType?: string } };
type Resolved = { run: WebRun; runOwner: string; source: WebTaskSource; task: WebInspectedTask; target: ResearchLibraryTrialTarget };
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const identity = (value: unknown) => mathDigest(canonicalMathJson(value));

/** Private scratch checks reuse the target checker; they never dispatch a command or update run evidence. */
export class WebResearchLibraryTrials {
  private readonly controller = new AbortController();
  private readonly pending = new Map<string, Promise<ResearchLibraryTrial>>();
  constructor(private readonly deps: Dependencies) {}
  private path(viewer: string, id: string) {
    if (!viewer || viewer === 'public') fail(401, '请先登录后试用数学成果。');
    parse(key, id); return ['owners', mathDigest(viewer), 'library-trials', `${id}.json`];
  }
  private release(viewer: string, assetId: string, releaseVersion: string, digest?: string) {
    parse(key, assetId); parse(version, releaseVersion);
    const asset = this.deps.assets.get(viewer, assetId), release = this.deps.assets.release(viewer, assetId, releaseVersion);
    if (asset.releases.find(item => item.version === releaseVersion)?.withdrawn) fail(409, '这个成果版本已经撤回，请选择其他版本。');
    if (release.type !== 'mathematics' || !release.mathematics) fail(400, '只有已发布的数学成果可以在目标中试用。');
    if (digest && release.digest !== digest) fail(409, '成果版本的固定身份已改变，请重新选择。');
    return release;
  }
  private resolve(viewer: string, ref: Pick<ResearchLibraryTrialTargetRef, 'runId' | 'projectId' | 'taskId'>, release: ResearchAssetRelease): Resolved {
    if (!viewer || viewer === 'public') fail(401, '请先登录后试用数学成果。');
    const binding = ref.projectId ? this.deps.projects.resolveBinding(viewer, ref.projectId, ref.runId, 'proof') : undefined;
    const runOwner = binding?.runOwner ?? viewer;
    if (binding && !binding.binding.permissions.manage && !this.deps.projects.detail(viewer, ref.projectId!).permissions.member)
      fail(403, '只有有候选证明权限的项目成员可以试用任务。');
    const run = binding?.run ?? this.deps.jobs.get(viewer, ref.runId) ?? fail(404, '研究不存在或不可访问。');
    const task = run.observation?.inspection.tasks.find(item => item.id === ref.taskId && ['goal', 'lemma'].includes(item.kind))
      ?? fail(409, '目标任务已改变，请重新选择当前任务。');
    const source = this.deps.storage.listObservations(runOwner, run.id).reverse().flatMap(item => item.sources)
      .find(item => item.taskId === task.id && item.taskVersion === task.version)
      ?? fail(409, '当前任务尚未保存可试用的精确源码，请稍后刷新。');
    if (source.environmentDigest !== run.observation!.inspection.configuration.environmentDigest)
      fail(409, '任务源码与当前证明环境记录不一致，请刷新目标后重新准备。');
    const planned = run.observation?.plan?.tasks.find(item => item.id === task.id);
    const name = (task.theorem ?? planned?.theoremName)?.replace(/^_root_\./u, '');
    const declarations = inspectScopedLeanDeclarations(source.source).filter(item => item.qualifiedName === name || name && !name.includes('.') && item.name === name);
    const declaration = declarations.length === 1 ? declarations[0] : undefined;
    if (!declaration || declaration.kind !== 'theorem' || planned?.declaration === 'definition' || planned?.proofPath && planned.proofPath !== source.file)
      fail(409, '任务的精确目标声明不可用；请选择保存了目标定理源码的任务。');
    const compatible = release.mathematics!.environment === run.environment;
    return { run, runOwner, source, task, target: {
      ref: { ...ref, taskVersion: task.version, commit: source.commit, sourceDigest: source.sourceDigest, environmentDigest: source.environmentDigest, file: source.file },
      runTitle: run.title, taskTitle: task.theorem ?? task.objective, declaration: declaration!.qualifiedName, type: task.type ?? planned?.type ?? declaration!.declarationType,
      environment: run.environment, premises: [...task.premises], compatible,
      ...(!compatible ? { incompatibility: '这个任务与成果使用不同的证明环境。' } : {}),
    } };
  }
  private exact(viewer: string, ref: ResearchLibraryTrialTargetRef, release: ResearchAssetRelease) {
    const result = this.resolve(viewer, ref, release);
    if (canonicalMathJson(result.target.ref) !== canonicalMathJson(ref)) fail(409, '任务版本或源码提交已经改变，请刷新目标并重新准备候选。');
    if (!result.target.compatible) fail(409, '任务与成果的证明环境不一致。');
    return result;
  }
  targets(viewer: string, assetId: string, releaseVersion: string): ResearchLibraryTrialTarget[] {
    this.path(viewer, 'targets');
    const release = this.release(viewer, assetId, releaseVersion), runs = new Map<string, { run: WebRun; projectId?: string }>();
    for (const run of this.deps.jobs.list(viewer)) runs.set(run.id, { run });
    for (let offset = 0;; offset += 100) {
      const page = this.deps.projects.list(viewer, { limit: 100, offset });
      for (const info of page.items) {
        const project = this.deps.projects.detail(viewer, info.id);
        if (!project.permissions.member) continue;
        for (const binding of project.runs) if (binding.permissions.proof && !runs.has(binding.runId)) {
          const resolved = this.deps.projects.resolveBinding(viewer, project.id, binding.runId, 'proof');
          runs.set(binding.runId, { run: resolved.run, projectId: project.id });
        }
      }
      if (page.items.length < 100) break;
    }
    return [...runs.values()].flatMap(({ run, projectId }) => (run.observation?.inspection.tasks ?? []).flatMap(task => {
      if (!['goal', 'lemma'].includes(task.kind)) return [];
      try { return [this.resolve(viewer, { runId: run.id, ...(projectId ? { projectId } : {}), taskId: task.id }, release).target]; }
      catch (error) { if (error instanceof WebStorageError && [403, 404, 409].includes(error.status)) return []; throw error; }
    }));
  }
  prepare(viewer: string, assetId: string, releaseVersion: string, raw: unknown): ResearchLibraryTrial {
    const input = parse(z.object({ requestId: key, releaseDigest: hash, target: targetSchema, declaration: text(1000, 1),
      proof: text(24_000, 1), argumentNotes: text(4000).default(''), missingPremises: text(4000).default('') }).strict(), raw);
    const id = `trial_${mathDigest(`${viewer}\0${input.requestId}`).slice(0, 32)}`, path = this.path(viewer, id);
    const intent = identity({ assetId, releaseVersion, input }), previous = this.deps.storage.getRecord<Stored>(path);
    if (previous) { if (previous.intent !== intent) fail(409, '请求 ID 已用于另一份试用候选。'); return this.get(viewer, id); }
    const release = this.release(viewer, assetId, releaseVersion, input.releaseDigest), target = input.target as ResearchLibraryTrialTargetRef;
    const resolved = this.exact(viewer, target, release);
    const declaration = release.mathematics!.declarations.find(item => item.name === input.declaration) ?? fail(400, '所选声明不在这个固定成果版本中。');
    const configuration = this.deps.assets.freeze(viewer, { libraries: [{ assetId, version: releaseVersion, digest: release.digest }] }, resolved.run.environment);
    const basePack = resolved.run.researchConfiguration?.libraryPack ?? selectWebLibraryPack(resolved.run);
    const modules = new Map<string, LibraryPack['modules'][number]>();
    for (const module of [...(basePack?.modules ?? []), ...configuration.libraryPack!.modules]) {
      const before = modules.get(module.file);
      if (before && before.source !== module.source) fail(409, `成果与任务的固定库存在模块冲突：${module.file}`);
      modules.set(module.file, module);
    }
    if (basePack?.requires?.length || release.mathematics!.pack.requires?.length) fail(409, '这个成果需要当前独立检查环境尚未提供的外部源码。');
    let libraryPack: LibraryPack;
    try { libraryPack = parseLibraryPack({ schema: LIBRARY_PACK_SCHEMA, modules: [...modules.values()] }); }
    catch { return fail(409, '成果与现有数学库无法组成一致的检查环境。'); }
    const baseline = resolved.source.source, regions = inspectLeanDeclarationRegions(baseline);
    const start = inspectScopedLeanDeclarations(baseline).find(item => item.qualifiedName === resolved.target.declaration)!.startOffset;
    const region = regions.find(item => item.startOffset === start)!;
    if (baseline.slice(region.bodyOffset - 2, region.bodyOffset) !== ':=') fail(409, '这个目标使用方程式声明，请从完整源码候选入口检查。');
    const imports = [...new Set(release.mathematics!.pack.modules.map(item => item.file.slice(0, -5).replaceAll('/', '.')))]
      .filter(name => !mathConstructionImports(baseline).includes(name));
    const prefix = imports.map(name => `import ${name}\n`).join('');
    const proof = input.proof.trim(), indent = baseline.slice(baseline.lastIndexOf('\n', start - 1) + 1, start).match(/^\s*/u)?.[0] ?? '';
    const source = prefix + baseline.slice(0, region.bodyOffset) + ' ' + proof.split('\n').map((line, index) => index ? indent + line : line).join('\n') + '\n' + baseline.slice(region.endOffset);
    const beforeDeclarations = inspectScopedLeanDeclarations(prefix + baseline), afterDeclarations = inspectScopedLeanDeclarations(source);
    if (beforeDeclarations.length !== afterDeclarations.length || beforeDeclarations.some((before, index) => {
      const after = afterDeclarations[index];
      return !after || before.kind !== after.kind || before.qualifiedName !== after.qualifiedName || before.declarationType !== after.declarationType;
    })) fail(400, '请只填写目标的证明体，不要添加、删除或重写其他声明。');
    const reason = researchCandidateScopeReason({ originalSource: prefix + resolved.run.source, baselineSource: prefix + baseline,
      candidateSource: source, targetName: resolved.target.declaration });
    if (reason) fail(400, reason);
    const planned = resolved.run.observation?.plan?.tasks.find(item => item.id === resolved.task.id);
    const expectedType = resolved.task.kind === 'lemma' ? resolved.task.type ?? planned?.type : undefined;
    if (resolved.task.kind === 'lemma' && !expectedType) fail(409, '当前引理任务缺少固定的完整类型，请刷新后重新选择。');
    const content = { id, release: { assetId, version: releaseVersion, digest: release.digest }, target: resolved.target, declaration, proof,
      argumentNotes: input.argumentNotes, missingPremises: input.missingPremises, source, sourceDigest: mathDigest(source), imports,
      libraryPackDigest: libraryPackDigest(libraryPack), createdAt: new Date().toISOString() };
    const draft: ResearchLibraryTrial = { ...content, digest: identity(content), status: 'prepared' };
    const stored: Stored = { intent, draft, libraryPack, dependencySources: copy(resolved.source.dependencySources ?? []),
      candidateTarget: { name: resolved.target.declaration, ...(expectedType ? { expectedType } : {}) } };
    this.deps.storage.saveRecord(path, stored); return copy(draft);
  }
  get(viewer: string, id: string): ResearchLibraryTrial {
    const stored = this.deps.storage.getRecord<Stored>(this.path(viewer, id)) ?? fail(404, '试用候选不存在或不属于当前账号。');
    const release = this.release(viewer, stored.draft.release.assetId, stored.draft.release.version, stored.draft.release.digest);
    this.exact(viewer, stored.draft.target.ref, release);
    return { ...copy(stored.draft), ...(this.pending.has(`${viewer}:${id}`) ? { status: 'checking' as const } : {}) };
  }
  resolveCandidateAttachment(viewer: string, projectId: string, id: string, expectedDigest: string, shared: true): ResearchLibraryCandidateAttachment {
    if (shared !== true) fail(400, '请明确同意将试用源码、参数、成果版本和检查回执共享给项目成员。');
    parse(key, projectId); parse(hash, expectedDigest);
    const trial = this.get(viewer, id);
    const check = trial.check ?? fail(409, '只有这份已通过独立检查的固定候选可以转为任务提案。');
    if (trial.digest !== expectedDigest || !check.receipt.passed || trial.status !== 'passed')
      fail(409, '只有这份已通过独立检查的固定候选可以转为任务提案。');
    const stored = this.deps.storage.getRecord<Stored>(this.path(viewer, id))!;
    const release = this.release(viewer, trial.release.assetId, trial.release.version, trial.release.digest);
    const resolved = this.exact(viewer, { ...trial.target.ref, projectId }, release);
    if (identity(check.receipt) !== check.receiptId || check.receipt.draftDigest !== trial.digest
      || check.receipt.sourceDigest !== mathDigest(trial.source) || check.receipt.libraryPackDigest !== libraryPackDigest(stored.libraryPack))
      fail(409, '试用源码、固定库与检查回执不一致，请重新检查候选。');
    const installed = resolved.run.researchConfiguration?.libraryPack ?? selectWebLibraryPack(resolved.run);
    const requiresNewAttempt = resolved.run.status !== 'running'
      || stored.libraryPack.modules.some(module => !installed?.modules.some(item => item.file === module.file && item.source === module.source));
    return copy({ schema: 'theorem-os.research-library-candidate.v1', trial, projectId, imports: trial.imports,
      libraryPack: stored.libraryPack as ResearchLibraryPack, dependencySources: stored.dependencySources, candidateTarget: stored.candidateTarget, requiresNewAttempt });
  }
  proposalTargets(viewer: string, id: string): ResearchLibraryProposalTarget[] {
    const trial = this.get(viewer, id);
    if (!trial.check?.receipt.passed) return [];
    const items: ResearchLibraryProposalTarget[] = [];
    for (let offset = 0;; offset += 100) {
      const page = this.deps.projects.list(viewer, { limit: 100, offset });
      for (const project of page.items) {
        try {
          const attachment = this.resolveCandidateAttachment(viewer, project.id, id, trial.digest, true);
          const binding = this.deps.projects.resolveBinding(viewer, project.id, trial.target.ref.runId, 'proof');
          const observation = binding.run.observation!;
          items.push({ projectId: project.id, title: project.title, requiresNewAttempt: attachment.requiresNewAttempt,
            target: { runId: binding.run.id, statementVersionId: binding.binding.statementVersionId,
              observationRef: { sequence: observation.sequence, stateDigest: observation.snapshot.stateDigest },
              taskRef: { id: trial.target.ref.taskId, version: trial.target.ref.taskVersion } } });
        } catch (error) { if (!(error instanceof WebStorageError && [403, 404, 409].includes(error.status))) throw error; }
      }
      if (page.items.length < 100) break;
    }
    return items;
  }
  prepareAttempt(viewer: string, projectId: string, feedbackId: string): ResearchLibraryAttemptPreparation {
    const feedback = this.deps.projects.feedback(viewer, projectId, feedbackId), payload = feedback.payload;
    const attachment = payload && 'libraryTrial' in payload ? payload.libraryTrial as ResearchLibraryCandidateAttachment | undefined : undefined;
    if (!attachment || attachment.projectId !== projectId || feedback.kind !== 'proof-submission' || !feedback.target)
      fail(404, '此任务提案没有固定的 Library 候选。');
    const target = feedback.target ?? fail(404, '此任务提案没有固定的 Library 候选。');
    const humanApproved = feedback.candidateDelivery?.approvedAt && feedback.candidateDelivery.approvedBy
      && ['approved', 'dispatched'].includes(feedback.candidateDelivery.status)
      || feedback.decision.status === 'accepted' && feedback.decision.actor?.kind === 'human';
    if (feedback.proofCheck?.status !== 'checked' || !humanApproved || feedback.supersededBy || feedback.continuation?.action === 'end'
      || feedback.candidateDelivery?.status === 'withdrawn' || ['declined', 'needs-info'].includes(feedback.decision.status))
      fail(409, '请先完成这份任务候选的独立检查与评审采纳，再准备新尝试。');
    const binding = this.deps.projects.resolveBinding(viewer, projectId, target.runId, 'proof');
    if (!binding.binding.permissions.manage && !this.deps.projects.detail(viewer, projectId).permissions.member)
      fail(403, '只有有候选证明权限的项目成员可以准备这个新尝试。');
    const trial = attachment!.trial, run = binding.run, source = payload && 'source' in payload ? payload.source : '';
    if (!source || feedback.proofCheck?.sourceDigest !== mathDigest(source)) fail(409, '任务提案的最新源码尚未通过独立候选检查。');
    if (!trial.check?.receipt.passed || mathDigest(trial.source) !== trial.sourceDigest || identity(trial.check.receipt) !== trial.check.receiptId)
      fail(409, '提案的候选源码与固定检查回执不一致。');
    const release = this.release(viewer, trial.release.assetId, trial.release.version, trial.release.digest);
    this.exact(viewer, { ...trial.target.ref, projectId }, release);
    const declarations = inspectScopedLeanDeclarations(source);
    if (inspectScopedLeanDeclarations(run.source).some(original => !declarations.some(item => item.kind === original.kind
      && item.qualifiedName === original.qualifiedName && item.declarationType === original.declarationType)))
      fail(409, '这份候选只包含辅助文件，尚未包含原题的全部声明；请先整合为完整源码再准备新尝试。');
    const dependencies = new Set(attachment!.dependencySources.filter(item => !attachment!.libraryPack.modules.some(module => module.file === item.file && module.source === item.source))
      .map(item => item.file.slice(0, -5).replaceAll('/', '.')));
    if (mathConstructionImports(source).some(name => dependencies.has(name)))
      fail(409, '这份候选仍依赖尚未发布的多文件源码，请先将必要依赖保存为固定数学库。');
    const prior = run.researchConfiguration;
    const libraries = [...(prior?.libraries.map(item => item.ref) ?? []), trial.release];
    const selection: ResearchConfigurationSelection = { ...(prior?.agent ? { agent: prior.agent.ref } : {}),
      skills: prior?.skills.map(item => item.ref) ?? [], libraries: [...new Map(libraries.map(ref => [`${ref.assetId}:${ref.version}`, ref])).values()] };
    // Runs retain the applied plan. Remove the exact generated Skill entries before reapplying fixed refs.
    const basePlan = !prior?.agent && (run.modulePlan ?? prior?.modulePlan) ? copy((run.modulePlan ?? prior!.modulePlan)!) : undefined;
    if (basePlan && prior?.skills.length) {
      const generatedIds = new Set(prior.skills.flatMap(skill => skill.content.slots.map(slot =>
        `skill_${mathDigest(`${skill.ref.assetId}\0${skill.ref.version}\0${slot}`).slice(0, 24)}`)));
      basePlan.custom = basePlan.custom.filter(module => !generatedIds.has(module.id));
    }
    const configuration = this.deps.assets.freeze(viewer, selection, run.environment, basePlan);
    if (prior && canonicalMathJson(configuration.modulePlan) !== canonicalMathJson(prior.modulePlan))
      fail(409, '原任务的固定 Agent 和 Skill 方案无法完整复原，请先核对研究配置。');
    const modules = new Map<string, LibraryPack['modules'][number]>();
    for (const module of [...(selectWebLibraryPack({ source, task: run.task, environment: run.environment })?.modules ?? []), ...(configuration.libraryPack?.modules ?? [])]) {
      const old = modules.get(module.file);
      if (old && old.source !== module.source) fail(409, '新尝试的固定模块发生冲突，请重新选择成果。');
      modules.set(module.file, module);
    }
    if (attachment!.libraryPack.modules.some(module => modules.get(module.file)?.source !== module.source))
      fail(409, '原任务的固定依赖无法由选定成果完整复原，尚不能准备这个新尝试。');
    const pack = parseLibraryPack({ schema: LIBRARY_PACK_SCHEMA, modules: [...modules.values()] });
    configuration.libraryPack = pack as ResearchLibraryPack;
    const { digest: _digest, ...content } = configuration;
    return { projectId, feedbackId, source, task: run.task, environment: run.environment, selection,
      refs: [...(selection.agent ? [selection.agent] : []), ...(selection.skills ?? []), ...(selection.libraries ?? [])],
      ...(basePlan ? { modulePlan: basePlan } : {}),
      configurationDigest: identity(content), libraryPackDigest: libraryPackDigest(pack), target: trial.target.ref, trialDigest: trial.digest };
  }
  async check(viewer: string, id: string, raw: unknown): Promise<ResearchLibraryTrial> {
    const input = parse(z.object({ requestId: key, expectedDigest: hash, confirmed: z.literal(true) }).strict(), raw);
    const draft = this.get(viewer, id);
    if (input.expectedDigest !== draft.digest) fail(409, '确认的候选与已准备内容不一致，请重新审阅。');
    if (draft.check) return draft;
    if (!this.deps.runner.check) fail(503, '当前服务暂不提供独立候选检查。');
    if (this.controller.signal.aborted) fail(503, '检查服务正在停止，请稍后重试。');
    const pendingKey = `${viewer}:${id}`, pending = this.pending.get(pendingKey); if (pending) return pending;
    const promise = this.perform(viewer, id).finally(() => this.pending.delete(pendingKey));
    this.pending.set(pendingKey, promise); return promise;
  }
  private async perform(viewer: string, id: string): Promise<ResearchLibraryTrial> {
    const path = this.path(viewer, id), stored = this.deps.storage.getRecord<Stored>(path)!, draft = stored.draft;
    let result;
    try { result = await this.deps.runner.check!({ environment: draft.target.environment, source: draft.source, sourceFile: draft.target.ref.file,
      dependencySources: stored.dependencySources, libraryPack: stored.libraryPack, candidateTarget: stored.candidateTarget }, this.controller.signal); }
    catch { return fail(503, '独立检查未完成，候选已保留；可以重新确认后重试。'); }
    // Revocation and changing task contracts take effect even while the isolated compiler is running.
    this.get(viewer, id);
    const diagnostics = leanDiagnostics(result.output), passed = result.exitCode === 0 && !result.timedOut && !diagnostics.errors
      && result.checkedTarget === stored.candidateTarget.name;
    const reason = passed ? undefined : result.timedOut ? '本次试用检查超时。' : diagnostics.diagnostics.find(item => item.severity === 'error')?.message
      ?? '候选未通过目标声明及其证明依赖的独立检查。';
    const receipt: ResearchLibraryTrialReceipt = { schema: 'theorem-os.research-library-trial-check.v1', trialId: id, draftDigest: draft.digest,
      release: draft.release, target: draft.target.ref, declaration: draft.declaration, checkedDeclaration: stored.candidateTarget.name,
      environment: draft.target.environment, sourceDigest: draft.sourceDigest, libraryPackDigest: draft.libraryPackDigest,
      dependencies: stored.dependencySources.map(item => ({ file: item.file, digest: mathDigest(item.source) })), passed,
      exitCode: result.exitCode, timedOut: result.timedOut, diagnostics: diagnostics.diagnostics, remainingOriginalSorries: diagnostics.sorries,
      scope: 'isolated-task-trial', acceptance: 'not-assessed', checkedAt: new Date().toISOString(), ...(reason ? { reason } : {}) };
    const receiptId = identity(receipt);
    this.deps.storage.saveRecord(['owners', mathDigest(viewer), 'library-trial-checks', `${receiptId}.json`], receipt, true);
    draft.check = { receiptId, receipt }; draft.status = passed ? 'passed' : 'failed';
    this.deps.storage.saveRecord(path, stored); return copy(draft);
  }
  async close() { this.controller.abort(); await Promise.allSettled(this.pending.values()); }
}

export function createResearchLibraryTrialsHandler(deps: Dependencies) {
  const service = new WebResearchLibraryTrials(deps);
  return {
    async handle(url: URL, method: string, viewer: string, readBody: () => Promise<unknown>): Promise<{ status: number; body: unknown } | undefined> {
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent), item = (value: unknown, status = 200) => ({ status, body: { item: value } });
      if (parts[0] !== 'api' || parts[1] !== 'research') return;
      if (parts[2] === 'library' && parts[3] && parts[4] === 'releases' && parts[5] && parts.length === 7) {
        if (parts[6] === 'trial-targets' && method === 'GET') return { status: 200, body: { items: service.targets(viewer, parts[3], parts[5]) } };
        if (parts[6] === 'trials' && method === 'POST') return item(service.prepare(viewer, parts[3], parts[5], await readBody()), 201);
      }
      if (parts[2] !== 'library-trials') return;
      if (parts.length === 4 && method === 'GET') return item(service.get(viewer, parts[3]!));
      if (parts.length === 5 && parts[4] === 'proposal-targets' && method === 'GET') return { status: 200, body: { items: service.proposalTargets(viewer, parts[3]!) } };
      if (parts.length === 5 && parts[4] === 'check' && method === 'POST') return item(await service.check(viewer, parts[3]!, await readBody()));
      return { status: 405, body: { error: '此试用操作不支持该请求方式。' } };
    },
    resolveCandidateAttachment: (viewer: string, projectId: string, id: string, digest: string, shared: true) => service.resolveCandidateAttachment(viewer, projectId, id, digest, shared),
    prepareAttempt: (viewer: string, projectId: string, feedbackId: string) => service.prepareAttempt(viewer, projectId, feedbackId),
    close: () => service.close(),
  };
}
