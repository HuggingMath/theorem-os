import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { getLeanTaskEnvironment, type LeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { LIBRARY_PACK_SCHEMA } from '../src/math/libraryPacks';
import { canonicalMathJson, mathDigest, writeMathJsonDurable } from '../src/math/mathRuntimeIo';
import { writeSolverRunState } from '../src/solver/archive';
import { prepareCampaignLibraryCatalog, prepareCampaignLibraryContinuation } from '../src/solver/campaignLibrary';
import { agentLibrary, writeLibraryAccess } from '../src/solver/libraryAccess';
import { readLibraryCatalog } from '../src/solver/libraryCatalog';
import { git, readSolverProblem } from '../src/solver/problem';
import { temporaryDirectory } from './helpers/files';
import { solverState } from './helpers/solver';
import { main } from '../scripts/mathematics/prepareCampaignLibrary';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
const initial = 'Submission/Library/Campaign/Initial.lean', base = 'Submission/Library/Campaign/Base.lean';
const feature = 'Submission/Library/Campaign/Feature.lean', unused = 'Submission/Library/Campaign/Unused.lean';
const sources = {
  [initial]: 'namespace Campaign\ntheorem retained : True := True.intro\nend Campaign\n',
  [base]: 'namespace Campaign\ndef useful : Prop := True\nend Campaign\n',
  [feature]: 'import Submission.Library.Campaign.Base\nnamespace Campaign\ntheorem wanted : useful := True.intro\nend Campaign\n',
  [unused]: 'namespace Campaign\ntheorem unused : True := True.intro\nend Campaign\n',
};
const source = 'namespace Original\nabbrev E := Nat\ntheorem goal (n : E) : n = n := by sorry\nend Original\n';
const pack = { schema: LIBRARY_PACK_SCHEMA, modules: Object.entries(sources).map(([file, source]) => ({ file, source,
  origin: { kind: 'upstream', repository: 'fixture-campaign-library', commit: 'a'.repeat(40), file: path.basename(file) } })) };
function fixture(environment: LeanTaskEnvironment = 'standard') {
  const root = temporaryDirectory('campaign-library-'); roots.push(root);
  const release = path.join(root, 'release'); fs.mkdirSync(release);
  const env = getLeanTaskEnvironment(environment);
  writeMathJsonDurable(path.join(release, 'library.json'), { schema: 'theorem-os.library-release.v1',
    repository: 'fixture-campaign-library', commit: 'a'.repeat(40), toolchain: env.toolchain,
    ...(env.mathlibRevision ? { mathlib: env.mathlibRevision } : {}),
    modules: Object.entries(sources).map(([file, source]) => ({ file, sha256: mathDigest(source) })) });
  writeMathJsonDurable(path.join(release, 'pack.json'), pack);
  const receipt = bootstrapLeanTask(path.join(root, 'workspace'), { source, task: 'Preserve the exact original target.',
    environment, definitionTargets: ['Original.E'], libraryPack: { ...pack, modules: [pack.modules[0]] } });
  const catalogInput = { workspace: receipt.workspaceRoot, releaseDirectories: [release], directory: path.join(root, 'catalog') };
  return { root, receipt, catalogInput, release };
}
function requestFixture() {
  const f = fixture(), catalog = prepareCampaignLibraryCatalog(f.catalogInput);
  const run = path.join(f.root, 'attempt/result.json'), runtime = run + '.runtime';
  fs.mkdirSync(runtime, { recursive: true });
  const worktree = path.join(runtime, 'worktree');
  git(f.receipt.workspaceRoot, ['worktree', 'add', '--quiet', '--detach', worktree, f.receipt.baseCommit]);
  const problem = readSolverProblem(f.receipt.workspaceRoot, f.receipt.activeProblemPath);
  const access = { file: catalog.file, digest: catalog.digest };
  writeLibraryAccess(problem, worktree, access); agentLibrary(worktree).request(['Campaign.wanted'], 'Use the missing public lemma.');
  const request = JSON.parse(fs.readFileSync(path.join(worktree, 'LIBRARY_REQUEST.json'), 'utf8'));
  const taskFile = path.join(f.root, 'task.md'); fs.writeFileSync(taskFile, 'Exact campaign task text\n');
  const state = solverState(problem, worktree, { runId: 'source-run', phase: 'finished', turns: 2,
    taskDigest: mathDigest(fs.readFileSync(taskFile)), libraryCatalogDigest: catalog.digest,
    solveStartedAt: 1000, solveFinishedAt: 2000, coordination: 'cooperative', workerCount: 1,
    workers: [{ id: 'solver', role: 'lead', worktree, turns: 2, phase: 'finished' }],
    cooperation: { tasks: [], canonicalCommit: problem.baseCommit } });
  const stateFile = path.join(runtime, 'state.json'); writeSolverRunState(stateFile, state);
  const result = { status: 'library_requested', runId: state.runId, turns: 2, libraryRequest: { worktree, request } };
  writeMathJsonDurable(run, result);
  const input = { run, taskFile, catalog: access, directory: path.join(f.root, 'continued') };
  return { ...f, input, catalog, problem, state, stateFile, result, worktree };
}

describe('campaign library preparation without model calls', () => {
  it('builds a complete same-environment catalog, not only installed modules, and reads it back idempotently', () => {
    const f = fixture('openai-math');
    const built = prepareCampaignLibraryCatalog(f.catalogInput), library = readLibraryCatalog(built.file, built.digest);
    expect(library.identity.environmentDigest).toBe(getLeanTaskEnvironment('openai-math').dependencyDigest);
    expect(built.toolchain).toBe('leanprover/lean4:v4.34.1');
    expect(library.moduleFiles).toHaveLength(4);
    expect(library.declaration('Campaign.wanted').file).toBe(feature);
    expect(prepareCampaignLibraryCatalog(f.catalogInput)).toEqual(built);
  });
  it('preserves current frozen module bytes if a release offers a newer version', () => {
    const f = fixture();
    const changed = structuredClone(pack); changed.modules[0].source += '\n-- new release bytes\n';
    writeMathJsonDurable(path.join(f.release, 'pack.json'), changed);
    const metadata = JSON.parse(fs.readFileSync(path.join(f.release, 'library.json'), 'utf8'));
    metadata.modules[0].sha256 = mathDigest(changed.modules[0].source); writeMathJsonDurable(path.join(f.release, 'library.json'), metadata);
    const built = prepareCampaignLibraryCatalog(f.catalogInput);
    expect(readLibraryCatalog(built.file, built.digest).readModule(initial).source).toBe(sources[initial]);
  });
  it('rejects release requirements before exposing a catalog', () => {
    const f = fixture();
    writeMathJsonDurable(path.join(f.release, 'pack.json'), { ...pack, requires: [{ file: 'Trusted.lean', digest: 'a'.repeat(64) }] });
    expect(() => prepareCampaignLibraryCatalog(f.catalogInput)).toThrow('math_library_catalog_external_requirement');
    expect(fs.existsSync(f.catalogInput.directory)).toBe(false);
  });
  it('keeps a complete multi-release catalog larger than one installation pack', () => {
    const f = fixture(), second = path.join(f.root, 'second-release'); fs.mkdirSync(second);
    const modules = Array.from({ length: 256 }, (_, index) => ({
      file: `Submission/Library/Bulk/Module${index}.lean`, source: `theorem bulk${index} : True := True.intro\n`,
      origin: { kind: 'upstream' as const, repository: 'fixture-campaign-library', commit: 'a'.repeat(40), file: `Module${index}.lean` },
    }));
    writeMathJsonDurable(path.join(second, 'pack.json'), { schema: LIBRARY_PACK_SCHEMA, modules });
    writeMathJsonDurable(path.join(second, 'library.json'), { schema: 'theorem-os.library-release.v1',
      repository: 'fixture-campaign-library', commit: 'a'.repeat(40), toolchain: getLeanTaskEnvironment('standard').toolchain,
      modules: modules.map(module => ({ file: module.file, sha256: mathDigest(module.source) })) });
    const input = { ...f.catalogInput, releaseDirectories: [f.release, second] };
    const built = prepareCampaignLibraryCatalog(input), catalog = readLibraryCatalog(built.file, built.digest);
    expect(catalog.moduleCount).toBe(260);
    expect(catalog.declaration('bulk255').file).toBe(modules[255].file);
    expect(prepareCampaignLibraryCatalog(input)).toEqual(built);
  });
  it('retains a frozen module dependency that a newer release removed', () => {
    const f = fixture();
    const old = bootstrapLeanTask(path.join(f.root, 'retained-workspace'), { source, task: 'Keep the old frozen closure.',
      libraryPack: { schema: LIBRARY_PACK_SCHEMA, modules: pack.modules.filter(module => [base, feature].includes(module.file)) } });
    const changed = { ...pack, modules: pack.modules.filter(module => module.file !== base).map(module =>
      module.file === feature ? { ...module, source: 'namespace Campaign\ntheorem wanted : True := True.intro\nend Campaign\n' } : module) };
    writeMathJsonDurable(path.join(f.release, 'pack.json'), changed);
    writeMathJsonDurable(path.join(f.release, 'library.json'), { schema: 'theorem-os.library-release.v1',
      repository: 'fixture-campaign-library', commit: 'a'.repeat(40), toolchain: getLeanTaskEnvironment('standard').toolchain,
      modules: changed.modules.map(module => ({ file: module.file, sha256: mathDigest(module.source) })) });
    const built = prepareCampaignLibraryCatalog({ ...f.catalogInput, workspace: old.workspaceRoot });
    const catalog = readLibraryCatalog(built.file, built.digest);
    expect(catalog.readModule(feature).source).toBe(sources[feature]);
    expect(catalog.readModule(base).source).toBe(sources[base]);
    expect(catalog.moduleMetadata(feature).imports).toEqual([base]);
  });
  it.each(['environment', 'hash', 'origin'])('rejects a release with a changed %s before exposing a catalog', kind => {
    const f = fixture('openai-math'), metadataPath = path.join(f.release, 'library.json');
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    if (kind === 'environment') metadata.toolchain = 'leanprover/lean4:v4.33.0';
    if (kind === 'hash') metadata.modules[0].sha256 = 'b'.repeat(64);
    if (kind === 'origin') metadata.commit = 'b'.repeat(40);
    writeMathJsonDurable(metadataPath, metadata);
    expect(() => prepareCampaignLibraryCatalog(f.catalogInput)).toThrow(/math_campaign_library_release_(environment|content)_changed/);
    expect(fs.existsSync(path.join(f.catalogInput.directory, 'campaign-catalog.json'))).toBe(false);
  });
  it('recovers an interrupted catalog publication with its unchanged claim', () => {
    const f = fixture(), first = prepareCampaignLibraryCatalog(f.catalogInput);
    fs.rmSync(path.join(f.catalogInput.directory, 'campaign-catalog.json'));
    fs.rmSync(path.join(f.catalogInput.directory, 'release/catalog.json'));
    const second = prepareCampaignLibraryCatalog(f.catalogInput);
    expect(second.digest).toBe(first.digest);
    expect(fs.readdirSync(f.catalogInput.directory).some(name => name.startsWith('release.incomplete.'))).toBe(true);
  });
  it.each(['file', 'digest', 'environment', 'modules'])('rejects altered published catalog %s metadata', field => {
    const f = fixture(), report = prepareCampaignLibraryCatalog(f.catalogInput);
    const changed = { ...report, [field]: field === 'modules' ? 999 : 'altered' };
    writeMathJsonDurable(path.join(f.catalogInput.directory, 'campaign-catalog.json'), changed, 0o400);
    expect(() => prepareCampaignLibraryCatalog(f.catalogInput)).toThrow('math_campaign_library_catalog_input_changed');
  });
  it('prepares a new receipt with requested closure and preserves original definitions, task text and source run', async () => {
    const f = requestFixture(), stateBytes = fs.readFileSync(f.stateFile), originalReceipt = fs.readFileSync(f.receipt.activeProblemPath);
    const first = await prepareCampaignLibraryContinuation(f.input), continued = readSolverProblem(first.workspace, first.activeProblemPath);
    expect(first).toMatchObject({ schema: 'theorem-os.campaign-library-continuation.v1', sourceRunId: f.state.runId,
      sourceOutput: f.input.run, originalWorkspace: f.problem.workspace, originalTaskDigest: f.state.taskDigest,
      originalTargetsDigest: mathDigest(canonicalMathJson(f.problem.targets)), continuationSourceRun: f.input.run,
      catalog: f.input.catalog, proofAcceptance: 'not-assessed' });
    expect(continued.contract).toEqual(f.problem.contract); expect(continued.targets).toEqual(f.problem.targets);
    expect(continued.frozenFiles).toEqual(Object.fromEntries([initial, base, feature].map(file => [file, mathDigest(sources[file])])));
    expect(fs.readFileSync(first.taskFile)).toEqual(fs.readFileSync(f.input.taskFile));
    expect(fs.readFileSync(f.receipt.activeProblemPath)).toEqual(originalReceipt); expect(fs.readFileSync(f.stateFile)).toEqual(stateBytes);
    expect(await prepareCampaignLibraryContinuation(f.input)).toEqual(first);
  });
  it('recovers bootstrap-complete and half-bootstrap interruptions without losing existing old work', async () => {
    const f = requestFixture(), first = await prepareCampaignLibraryContinuation(f.input);
    fs.rmSync(first.transitionFile);
    expect(await prepareCampaignLibraryContinuation(f.input)).toEqual(first);
    fs.rmSync(first.transitionFile);
    fs.rmSync(first.workspace, { recursive: true }); fs.mkdirSync(first.workspace); fs.writeFileSync(path.join(first.workspace, 'partial'), 'unfinished bootstrap');
    const recovered = await prepareCampaignLibraryContinuation(f.input);
    expect(readSolverProblem(recovered.workspace, recovered.activeProblemPath).targets).toEqual(f.problem.targets);
    expect(fs.readdirSync(f.input.directory).some(name => name.startsWith('workspace.incomplete.'))).toBe(true);
  });
  it.each(['run', 'task', 'worker', 'catalog', 'writer', 'phase', 'problem'])('rejects a changed %s before preparing a destination', async kind => {
    const f = requestFixture();
    if (kind === 'run') f.result.runId = 'another-run';
    if (kind === 'task') fs.writeFileSync(f.input.taskFile, 'changed task');
    if (kind === 'worker') f.result.libraryRequest.worktree = f.problem.workspace;
    if (kind === 'catalog') f.result.libraryRequest.request.catalogDigest = 'c'.repeat(64);
    if (kind === 'writer') f.state.writerStopUnconfirmed = { at: 1000, reason: 'fixture' };
    if (kind === 'phase') f.state.phase = 'running';
    if (kind === 'problem') f.result.libraryRequest.request.problemReceiptDigest = 'c'.repeat(64);
    writeMathJsonDurable(f.input.run, f.result); writeSolverRunState(f.stateFile, f.state);
    await expect(prepareCampaignLibraryContinuation(f.input)).rejects.toThrow();
    expect(fs.existsSync(f.input.directory)).toBe(false);
  });
  it.each(['originalTargetsDigest', 'originalProblemReceiptDigest', 'sourceStateDigest', 'sourceResultDigest', 'requestDigest', 'sourceState'])
  ('rejects altered prepared transition %s metadata', async field => {
    const f = requestFixture(), first = await prepareCampaignLibraryContinuation(f.input);
    writeMathJsonDurable(first.transitionFile, { ...first, [field]: 'b'.repeat(64) }, 0o400);
    await expect(prepareCampaignLibraryContinuation(f.input)).rejects.toThrow('math_campaign_library_continuation_changed');
  });
  it('exposes both CLI phases with the controller contract', async () => {
    const f = requestFixture();
    const result = await main(['--phase', 'continue', '--run', f.input.run, '--task-file', f.input.taskFile,
      '--catalog', f.input.catalog.file, '--catalog-sha256', f.input.catalog.digest, '--directory', f.input.directory]);
    expect(result).toMatchObject({ continuationSourceRun: f.input.run, proofAcceptance: 'not-assessed' });
    await expect(main(['--phase', 'invalid'])).rejects.toThrow('--phase must be');
  });
});
