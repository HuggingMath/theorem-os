import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autoLibraryPackFor, autoLibraryTheorems, parseAutoLibraryRecord, type AutoLibraryRecord } from '../src/math/autoLibrary';
import { bootstrapAutoLibraryTask, resolveAutoLibraryBase } from '../src/math/autoLibraryHost';
import { hostAutoEvidence } from '../src/math/libraryHostConfig';
import { bootstrapLeanTask, leanTaskId, readLeanTaskReceipt } from '../src/math/leanTask';
import { libraryPackDigest } from '../src/math/libraryPacks';
import { canonicalLibraryJson } from '../src/math/libraryRelease';
import { mathDigest, canonicalMathJson } from '../src/math/mathRuntimeIo';
import { prepareAutoLibraryBuild, readAutoLibraryRequest, runAutoLibraryBuild } from '../src/solver/autoLibrary';
import { autoLibrary } from '../scripts/mathematics/autoLibrary';
import { writeLibraryHostFixture } from './helpers/libraryHostFixture';
import { temporaryDirectory } from './helpers/files';
import { prepareLibraryKnowledge } from '../src/solver/theoremKnowledgeLibrary';
import { readAuthorizedKnowledgeCatalog } from '../src/solver/theoremKnowledgeAuthorization';

vi.mock('../src/math/mathBuildManifest', () => ({ readMathBuildManifest: vi.fn() }));
let directory: string, fixture: ReturnType<typeof writeLibraryHostFixture>;
const challenge = 'theorem target : True := by sorry\n';
const source = 'namespace TheoremOS.Auto.Checked\ntheorem t : True := trivial\nend TheoremOS.Auto.Checked\n';
beforeEach(() => {
  directory = temporaryDirectory('auto-library-host-');
  fixture = writeLibraryHostFixture(path.join(directory, 'host'), [
    { taskId: 'parent', selection: { mode: 'mapped', exclusionKeys: ['FixtureTask'] } },
    { taskId: 'other', selection: { mode: 'unrestricted' } },
  ]);
  fixture.config.autoLibraryDirectory = path.join(directory, 'registry');
  fs.writeFileSync(fixture.configPath, canonicalLibraryJson(fixture.config));
  vi.stubEnv('THEOREMOS_LIBRARY_HOST_CONFIG', fixture.configPath);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); fs.rmSync(directory, { recursive: true, force: true }); });
const workspace = () => path.join(directory, 'workspace');
const effective = () => resolveAutoLibraryBase('parent', 'openai-math', workspace())!;
function record(overrides: Partial<AutoLibraryRecord> = {}) {
  const base = effective();
  const visible = base.pack!.modules.map(item => ({ file: item.file, digest: mathDigest(item.source) })).sort((a, b) => a.file < b.file ? -1 : 1);
  return parseAutoLibraryRecord({ schema: 'theorem-os.auto-library-record.v1', name: 'Checked',
    file: 'Submission/Library/Auto/Checked.lean', source, sourceDigest: mathDigest(source), summary: 'fixture', sources: [],
    theorems: autoLibraryTheorems(source), requires: [], visible: visible.map(item => item.file),
    provenance: { binding: base.binding, visible }, environment: { id: 'openai-math', digest: fixture.environment.dependencyDigest },
    trigger: { challengeId: 'parent', challengeDigest: mathDigest(challenge), taskDigest: mathDigest('') },
    cost: { plannerTokens: 0, proverTokens: 0, wallMs: 0, rounds: 1 }, planner: { model: 'preset', effort: 'low' },
    prover: { runId: 'preset', commit: '1'.repeat(40), model: 'preset', dropped: [] },
    buildId: '0f2d05e8-5d78-402b-b74e-3f0936f8e8b2', buildDigest: '2'.repeat(64), publishedAt: '2026-11-09T12:00:00.000Z', ...overrides });
}
function select(records: AutoLibraryRecord[]) {
  return autoLibraryPackFor({ effective: effective(), records, environmentDigest: fixture.environment.dependencyDigest,
    challengeSource: challenge, authenticated: item => hostAutoEvidence('records', mathDigest(canonicalLibraryJson(item)), item, workspace()) });
}
function approve(item: AutoLibraryRecord) {
  hostAutoEvidence('records', mathDigest(canonicalLibraryJson(item)), item, workspace(), true);
  return item;
}
function prepare() {
  const manifest = path.join(directory, 'manifest.json'); fs.writeFileSync(manifest, '{}');
  const build = path.join(directory, 'build'), root = path.join(directory, 'runtime');
  const input = { challengeId: 'parent', challengeSource: challenge, task: 'Prove target.', environment: 'openai-math',
    pool: path.join(directory, 'pool'), buildManifestRef: manifest,
    planner: { model: 'preset', effort: 'low', executable: 'unused', profile: 'unused' },
    prover: { model: 'preset', effort: 'low', executable: 'unused', workers: 1, coordination: 'independent' as const,
      maxRunSeconds: 1, maxTurns: 1, maxTurnSeconds: 1, maxTotalTokens: 0, prepareTimeoutSeconds: 1 },
    maxModules: 1, maxRounds: 1, maxRunSeconds: 60, maxTotalTokens: 0, plannerTurnSeconds: 1 };
  const request = prepareAutoLibraryBuild(build, root, input);
  return { build, root, input, request };
}

describe('host-authorized Auto composition', () => {
  it('indexes an authorized Auto composition without promoting its declarations to release replay evidence', () => {
    const item = approve(record()), base = effective(), selected = select([item]);
    bootstrapAutoLibraryTask(workspace(), { source: challenge, task: 'Prove target.', environment: 'openai-math', libraryPack: selected.pack! },
      { binding: base.binding, provenance: { records: [item] } });
    const file = path.join(directory, 'auto-knowledge.json');
    expect(prepareLibraryKnowledge(workspace(), file)).toMatchObject({ entries: 3, libraryModules: 3 });
    const catalog = readAuthorizedKnowledgeCatalog(file, workspace());
    expect(catalog.base.entries.find(entry => entry.name === 'TheoremOS.Auto.Checked.t')!.libraryMetadata).toBeUndefined();
    expect(catalog.base.entries.filter(entry => entry.libraryMetadata)).toHaveLength(2);
    expect(catalog.base.libraryAuthorization!.binding.autoComposition).toBeDefined();
  });
  it('installs authenticated additions with the effective base and rejects a raw base override', () => {
    const item = approve(record());
    const selected = select([item]);
    expect(selected.included).toEqual(['Checked']);
    expect(selected.pack!.modules.map(item => item.file).sort()).toEqual([...effective().pack!.modules.map(item => item.file), item.file].sort());
    expect(() => autoLibraryPackFor({ effective: effective(), base: effective().pack!, records: [],
      environmentDigest: fixture.environment.dependencyDigest, challengeSource: challenge })).toThrow('sources_conflict');
  });
  it('refuses legacy, unauthenticated and modified pool provenance', () => {
    const original = approve(record());
    expect(select([record({ provenance: undefined })]).skipped[0].reason).toBe('provenance');
    expect(select([record({ summary: 'tampered metadata' })]).skipped[0].reason).toBe('provenance');
    const changed = record({ source: source.replace('trivial', 'by trivial'), sourceDigest: mathDigest(source.replace('trivial', 'by trivial')) });
    expect(select([changed]).included).toEqual([]);
    expect(select([original]).included).toEqual(['Checked']);
  });
  it('rejects records which saw excluded content even if they import none of it', () => {
    const unrestricted = resolveAutoLibraryBase('other', 'openai-math', workspace())!;
    const item = record({ provenance: { binding: unrestricted.binding, visible: [] }, visible: [] });
    expect(select([approve(item)]).skipped[0].reason).toBe('provenance');
    const hidden = 'Submission/Library/TheoremOS/Fixture/C.lean';
    const forged = record({ visible: [hidden], provenance: { binding: effective().binding, visible: [{ file: hidden, digest: '0'.repeat(64) }] } });
    expect(select([approve(forged)]).skipped[0].reason).toBe('visibility');
  });
  it('checks hashes for all visible sources, including unused ones', () => {
    const item = record(); item.provenance!.visible[0].digest = '0'.repeat(64);
    expect(select([approve(item)]).skipped[0].reason).toBe('visibility');
  });
  it('rechecks source restrictions, import authorization and declared theorem names', () => {
    for (const invalid of [source.replace('TheoremOS.Auto.Checked', 'Outside'), 'import Submission.Library.TheoremOS.Fixture.C\n' + source,
      source.replace('trivial', 'by sorry')]) {
      const item = record({ source: invalid, sourceDigest: mathDigest(invalid), theorems: autoLibraryTheorems(invalid) });
      expect(select([approve(item)]).skipped[0].reason).toBe('source');
    }
    expect(select([approve(record({ theorems: ['fake'] }))]).skipped[0].reason).toBe('source');
  });
  it('binds child installs and resumes to external authorization and current parent policy', () => {
    const base = effective(), pack = select([approve(record())]).pack!;
    const receipt = bootstrapAutoLibraryTask(workspace(), { source: challenge, task: 'Prove target.', environment: 'openai-math', libraryPack: pack },
      { binding: base.binding, provenance: { build: 'fixture' } });
    expect(receipt.libraryBinding!.autoComposition!.parentTaskId).toBe('parent');
    expect(receipt.libraryPack!.digest).toBe(libraryPackDigest(pack));
    expect(readLeanTaskReceipt(receipt.activeProblemPath)).toEqual(receipt);
    expect(() => bootstrapLeanTask(path.join(directory, 'raw'), { source: challenge, task: 'Prove target.', environment: 'openai-math', libraryPack: pack }))
      .toThrow('library_host_sources_conflict');
    fs.appendFileSync(fixture.configPath, '\n');
    expect(() => readLeanTaskReceipt(receipt.activeProblemPath)).toThrow('library_host_binding_changed');
  });
  it('rejects removed host configuration and changed authorization for the same workspace', () => {
    const base = effective(), input = { source: challenge, task: 'Prove target.', environment: 'openai-math' as const, libraryPack: base.pack! };
    const receipt = bootstrapAutoLibraryTask(workspace(), input, { binding: base.binding, provenance: {} });
    expect(() => bootstrapAutoLibraryTask(workspace(), { ...input, libraryPack: undefined }, { binding: base.binding, provenance: {} }))
      .toThrow('library_auto_authorization_changed');
    vi.stubEnv('THEOREMOS_LIBRARY_HOST_CONFIG', undefined);
    expect(() => readLeanTaskReceipt(receipt.activeProblemPath)).toThrow('library_host_binding_changed');
  });
  it('supports empty child closures and a destination sharing its parent formal task ID', () => {
    fixture.config.tasks.push({ taskId: leanTaskId(challenge), selection: { mode: 'mapped', exclusionKeys: ['FixtureTask'] } });
    fs.writeFileSync(fixture.configPath, canonicalLibraryJson(fixture.config));
    const base = resolveAutoLibraryBase(leanTaskId(challenge), 'openai-math', workspace())!;
    const receipt = bootstrapAutoLibraryTask(workspace(), { source: challenge, task: 'Prove target.', environment: 'openai-math' },
      { binding: base.binding, provenance: {} });
    expect(receipt.libraryPack).toBeUndefined();
    expect(receipt.libraryBinding!.effectivePackDigest).toBe(mathDigest('null'));
    expect(readLeanTaskReceipt(receipt.activeProblemPath)).toEqual(receipt);
  });
  it('exports a CLI selection and authorizes only its designated destination', async () => {
    const pool = path.join(directory, 'pool'), output = path.join(directory, 'selection.json'), challengeFile = path.join(directory, 'Challenge.lean');
    fs.writeFileSync(challengeFile, challenge);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await autoLibrary(['--phase', 'pack', '--pool', pool, '--challenge-file', challengeFile,
      '--challenge-id', 'parent', '--environment', 'openai-math', '--workspace', workspace(), '--output', output])).toBe(0);
    const selection = JSON.parse(fs.readFileSync(output, 'utf8'));
    expect(selection.schema).toBe('theorem-os.auto-library-selection.v1');
    const receipt = bootstrapLeanTask(workspace(), { source: challenge, task: 'Prove target.', environment: 'openai-math' });
    expect(receipt.libraryBinding).toEqual(selection.libraryBinding);
    await expect(autoLibrary(['--phase', 'pack', '--pool', pool, '--challenge-file', challengeFile,
      '--challenge-id', 'parent', '--environment', 'openai-math', '--workspace', workspace(), '--output', path.join(directory, 'replacement.json')]))
      .rejects.toThrow('--workspace exists');
    expect(readLeanTaskReceipt(receipt.activeProblemPath)).toEqual(receipt);
    expect(() => bootstrapLeanTask(path.join(directory, 'other-destination'), { source: challenge, task: 'Prove target.', environment: 'openai-math' }))
      .toThrow('library_host_task_unmapped');
    await expect(autoLibrary(['--phase', 'pack', '--pool', pool, '--challenge-file', challengeFile,
      '--challenge-id', 'parent', '--environment', 'openai-math', '--output', path.join(directory, 'missing-workspace.json')]))
      .rejects.toThrow('--workspace is required');
  });
  it('recovers publication after interrupted writes and never replaces a different authorization', () => {
    const original = fs.writeFileSync;
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: any, data: any, ...args: any[]) => {
      if (typeof file === 'number') {
        original(file, String(data).slice(0, 8));
        throw Object.assign(new Error('injected short write'), { code: 'ENOSPC' });
      }
      return (original as any)(file, data, ...args);
    }) as any);
    expect(() => hostAutoEvidence('records', 'fault', { complete: true }, workspace(), true)).toThrow('injected');
    write.mockRestore();
    expect(hostAutoEvidence('records', 'fault', { complete: true }, workspace())).toBe(false);
    expect(hostAutoEvidence('records', 'fault', { complete: true }, workspace(), true)).toBe(true);
    expect(() => hostAutoEvidence('records', 'fault', { complete: false }, workspace(), true)).toThrow('authorization_changed');
    expect(hostAutoEvidence('records', 'fault', { complete: true }, workspace())).toBe(true);
  });
  it('keeps an identical concurrent publication and rejects a different winner', () => {
    const rename = fs.renameSync;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      fs.cpSync(from.toString(), to.toString(), { recursive: true });
      return rename(from, to);
    });
    expect(hostAutoEvidence('records', 'race', { complete: true }, workspace(), true)).toBe(true);
    spy.mockRestore();
    const changed = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      fs.mkdirSync(to.toString());
      fs.writeFileSync(path.join(to.toString(), 'entry.json'), canonicalLibraryJson({ complete: false }));
      return rename(from, to);
    });
    expect(() => hostAutoEvidence('records', 'race-other', { complete: true }, workspace(), true)).toThrow('authorization_changed');
    changed.mockRestore();
  });
  it('reads pre-atomic authorizations and detects conflicts between both storage layouts', () => {
    const kind = path.join(fixture.config.autoLibraryDirectory!, 'records'); fs.mkdirSync(kind, { recursive: true });
    const legacy = path.join(kind, mathDigest('legacy') + '.json');
    fs.writeFileSync(legacy, canonicalLibraryJson({ complete: true }), { mode: 0o400 });
    expect(hostAutoEvidence('records', 'legacy', { complete: true }, workspace())).toBe(true);
    expect(hostAutoEvidence('records', 'legacy', { complete: true }, workspace(), true)).toBe(true);
    expect(() => hostAutoEvidence('records', 'legacy', { complete: false }, workspace(), true)).toThrow('authorization_changed');
    fs.mkdirSync(path.join(kind, mathDigest('legacy')));
    fs.writeFileSync(path.join(kind, mathDigest('legacy'), 'entry.json'), canonicalLibraryJson({ complete: false }));
    expect(() => hostAutoEvidence('records', 'legacy', { complete: true }, workspace())).toThrow('authorization_changed');
  });
  it('resumes a child whose authorization uses the original registry layout', () => {
    const base = effective();
    const receipt = bootstrapAutoLibraryTask(workspace(), { source: challenge, task: 'Prove target.', environment: 'openai-math', libraryPack: base.pack! },
      { binding: base.binding, provenance: {} });
    const entry = path.join(fixture.config.autoLibraryDirectory!, 'tasks', mathDigest(workspace()));
    fs.renameSync(path.join(entry, 'entry.json'), entry + '.json'); fs.rmdirSync(entry);
    expect(readLeanTaskReceipt(receipt.activeProblemPath)).toEqual(receipt);
  });
  it('does not allow a registry inside the task tree or a task inside the registry', () => {
    fixture.config.autoLibraryDirectory = path.join(workspace(), 'registry');
    fs.writeFileSync(fixture.configPath, canonicalLibraryJson(fixture.config));
    expect(() => hostAutoEvidence('builds', 'x', {}, workspace(), true)).toThrow('overlap');
    fixture.config.autoLibraryDirectory = directory;
    fs.writeFileSync(fixture.configPath, canonicalLibraryJson(fixture.config));
    expect(() => hostAutoEvidence('builds', 'x', {}, workspace(), true)).toThrow('overlap');
  });
});

describe('Auto request and recovery', () => {
  it('freezes the effective base and authenticates request bytes independently', () => {
    const { build, request } = prepare();
    expect(readAutoLibraryRequest(build).request).toEqual(request);
    expect(request.libraryBinding).toEqual(effective().binding);
    const file = path.join(build, 'request.json'); fs.chmodSync(file, 0o600);
    fs.writeFileSync(file, canonicalMathJson({ ...request, challengeSource: challenge + '-- changed\n' }));
    expect(() => readAutoLibraryRequest(build)).toThrow('auto_library_host_binding_changed');
  });
  it('rejects missing provenance, a replaced base, raw overrides and changed host settings', () => {
    const { build, root, input } = prepare();
    expect(() => prepareAutoLibraryBuild(path.join(directory, 'override'), root, { ...input, basePack: effective().pack! }))
      .toThrow('library_host_sources_conflict');
    const file = path.join(build, 'base-pack.json'); fs.chmodSync(file, 0o600); fs.writeFileSync(file, JSON.stringify({ ...effective().pack!,
      modules: effective().pack!.modules.slice(-1) }));
    expect(() => readAutoLibraryRequest(build)).toThrow('auto_library_base_pack_changed');
    vi.stubEnv('THEOREMOS_LIBRARY_HOST_CONFIG', undefined);
    expect(() => readAutoLibraryRequest(build)).toThrow('auto_library_host_binding_changed');
  });
  it('supports a no-model planner run, frozen pool digests and completed recovery', async () => {
    const { build, root } = prepare();
    const openSession = vi.fn(async (options: any) => ({ threadId: 'preset', close: async () => {}, interrupt: async () => {},
      run: async (_message: string, _id: string, workspace: string, started: (id: string) => void) => {
        started('preset-turn');
        const input = JSON.parse(fs.readFileSync(path.join(workspace, 'INPUT.json'), 'utf8'));
        options.onUsage({ totalTokens: 0 });
        fs.writeFileSync(path.join(workspace, 'OUTPUT.json'), JSON.stringify({ inputDigest: input.inputDigest,
          decision: 'none', reason: 'No dependency needed', name: null, summary: null, sources: null, lean: null,
          target: null, application: null, remaining: null }));
        return 'completed';
      } }));
    expect((await runAutoLibraryBuild(build, root, { openSession })).status).toBe('none');
    const state = JSON.parse(fs.readFileSync(path.join(build, 'state.json'), 'utf8'));
    expect(state.modules[0].rounds[0].poolDigests).toEqual({});
    expect((await runAutoLibraryBuild(build, root, { openSession })).status).toBe('none');
    expect(openSession).toHaveBeenCalledTimes(1);
    fs.appendFileSync(fixture.configPath, '\n');
    await expect(runAutoLibraryBuild(build, root, { openSession })).rejects.toThrow('auto_library_host_binding_changed');
  });
  it('stops resumed phases if an existing pool record is rewritten under the same name', async () => {
    const { build, root, request } = prepare(), item = approve(record());
    fs.mkdirSync(path.join(request.pool, 'modules'), { recursive: true });
    fs.writeFileSync(path.join(request.pool, 'modules/Checked.json'), canonicalMathJson({ ...item, summary: 'rewritten' }));
    fs.writeFileSync(path.join(build, 'state.json'), canonicalMathJson({ schema: 'theorem-os.auto-library-state.v1',
      requestDigest: mathDigest(canonicalMathJson(request)), status: 'stopped', elapsedMs: 0, sessions: [], modules: [{
        index: 0, status: 'open', openedAtMs: 0, rounds: [{ round: 1, phase: 'plan', pool: ['Checked'], taken: [],
          poolDigests: { Checked: mathDigest(canonicalLibraryJson(item)) } }] }] }));
    const openSession = vi.fn();
    const result = await runAutoLibraryBuild(build, root, { openSession });
    expect(result.status).toBe('stopped');
    expect(JSON.parse(fs.readFileSync(path.join(build, 'state.json'), 'utf8')).error).toBe('auto_library_pool_changed');
    expect(openSession).not.toHaveBeenCalled();
  });
});
