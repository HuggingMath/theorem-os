import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { temporaryDirectory } from './helpers/files';

const host = vi.hoisted(() => ({ capture: vi.fn(), readState: vi.fn(), readPool: vi.fn(), usage: vi.fn(),
  liveUsage: vi.fn(), prepare: vi.fn(), buildManifest: vi.fn() }));
vi.mock('../src/solver/autoLibraryDemand', async original => ({ ...await original<typeof import('../src/solver/autoLibraryDemand')>(),
  captureAutoLibraryDemand: host.capture }));
vi.mock('../src/solver/archive', async original => ({ ...await original<typeof import('../src/solver/archive')>(),
  readSolverRunState: host.readState }));
vi.mock('../src/math/autoLibrary', async original => ({ ...await original<typeof import('../src/math/autoLibrary')>(),
  readAutoLibraryPool: host.readPool, autoLibraryRunUsage: host.usage, autoLibraryLiveUsage: host.liveUsage }));
vi.mock('../src/solver/autoLibrary', async original => ({ ...await original<typeof import('../src/solver/autoLibrary')>(),
  prepareAutoLibraryBuild: host.prepare }));
vi.mock('../src/math/mathBuildManifest', async original => ({ ...await original<typeof import('../src/math/mathBuildManifest')>(),
  readMathBuildManifest: host.buildManifest }));
import { autoLibrary } from '../scripts/mathematics/autoLibrary';
import { readAutoLibraryDemand } from '../src/solver/autoLibraryDemand';
import { LEAN_TASK_SOURCE_MAX_BYTES } from '../src/math/leanTask';

const digest = 'a'.repeat(64), consumer = { taskId: 'goal', taskDigest: digest };
const demand = { schema: 'theorem-os.auto-library-demand.v1', runId: 'fixture', challengeDigest: digest,
  problemReceiptDigest: digest, environmentDigest: digest, deliveryId: 'gap', findingDigest: digest, commit: 'a'.repeat(40),
  consumer: { ...consumer, theoremName: 'target' }, source: { taskId: 'helper', taskDigest: digest }, dependencies: [],
  gap: { consumer, previousGap: 'No induction step', reduced: 'Base case checked', remaining: 'Need a recurrence',
    evidenceScope: 'Fixed consumer', reconsiderWhen: ['A recurrence is proved'] }, evidenceRefs: [], lemmaRequests: [] };
let directory: string;
beforeEach(() => {
  directory = temporaryDirectory('auto-library-cli-');
  host.capture.mockReset().mockReturnValue(demand);
  host.readState.mockReset().mockReturnValue({ runId: 'fixture' });
  host.readPool.mockReset().mockReturnValue([]);
  host.usage.mockReset().mockReturnValue({ checked: true, modules: [], stage: 'solution' });
  host.liveUsage.mockReset().mockReturnValue({ checked: false, modules: [], stage: 'live', proofAcceptance: 'not-assessed' });
  host.prepare.mockReset().mockImplementation((_directory: string, _root: string, input: { challengeId: string; environment: string; pool: string }) =>
    ({ buildId: 'fixture-build', challengeId: input.challengeId, environment: input.environment, pool: input.pool, basePackDigest: null }));
  host.buildManifest.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });

describe('auto-library CLI entry points', () => {
  it('accepts --delivery and writes a frozen demand in a new parent directory', async () => {
    const run = path.join(directory, 'result.json'), output = path.join(directory, 'new', 'nested', 'demand.json');
    expect(await autoLibrary(['--phase', 'demand', '--run', run, '--delivery', 'gap', '--output', output])).toBe(0);
    expect(host.readState).toHaveBeenCalledWith(path.join(`${run}.runtime`, 'state.json'));
    expect(host.capture).toHaveBeenCalledWith({ runId: 'fixture' }, 'gap');
    expect(readAutoLibraryDemand(output)).toEqual(demand);
    expect(fs.statSync(output).mode & 0o222).toBe(0);
    const original = fs.readFileSync(output);
    await expect(autoLibrary(['--phase', 'demand', '--run', run, '--delivery', 'gap', '--output', output]))
      .rejects.toThrow('auto_library_demand_output_exists');
    expect(fs.readFileSync(output)).toEqual(original);
  });

  it.each([undefined, 'false', 'true'])('selects the requested usage source (live=%s)', async live => {
    const run = path.join(directory, 'state.json'), pool = path.join(directory, 'pool');
    const args = ['--phase', 'usage', '--run', run, '--pool', pool, ...(live === undefined ? [] : ['--live', live])];
    expect(await autoLibrary(args)).toBe(0);
    expect(host.readPool).toHaveBeenCalledWith(pool);
    const selected = live === 'true' ? host.liveUsage : host.usage;
    const other = live === 'true' ? host.usage : host.liveUsage;
    expect(selected).toHaveBeenCalledExactlyOnceWith({ records: [], stateFile: run });
    expect(other).not.toHaveBeenCalled();
  });

  it('rejects an invalid live selector before inspecting a run', async () => {
    await expect(autoLibrary(['--phase', 'usage', '--run', 'result.json', '--pool', path.join(directory, 'pool'), '--live', 'yes']))
      .rejects.toThrow('--live must be true or false');
    expect(host.readPool).not.toHaveBeenCalled();
  });

  it('passes exact comma-separated definition targets to the prepare host', async () => {
    const challenge = path.join(directory, 'Challenge.lean');
    fs.writeFileSync(challenge, 'def User.witness : Nat := by sorry\n');
    expect(await autoLibrary(['--phase', 'prepare', '--directory', path.join(directory, 'build'), '--challenge-id', 'fixture',
      '--challenge-file', challenge, '--pool', path.join(directory, 'pool'), '--build-manifest', path.join(directory, 'manifest.json'),
      '--definition-targets', 'User.witness, Other.witness'])).toBe(0);
    expect(host.prepare).toHaveBeenCalledWith(path.join(directory, 'build'), expect.any(String), expect.objectContaining({
      definitionTargets: ['User.witness', 'Other.witness'], challengeSource: 'def User.witness : Nat := by sorry\n' }));
  });

  it('preserves a challenge larger than one MiB through prepare and pack', async () => {
    const challenge = path.join(directory, 'Challenge.lean');
    const source = `theorem target : True := by sorry\n/-${'x'.repeat(1_426_542 - 36)}-/\n`;
    expect(Buffer.byteLength(source)).toBeGreaterThan(1024 * 1024);
    fs.writeFileSync(challenge, source);
    expect(await autoLibrary(['--phase', 'prepare', '--directory', path.join(directory, 'build'), '--challenge-id', 'large',
      '--challenge-file', challenge, '--pool', path.join(directory, 'pool'), '--build-manifest', path.join(directory, 'manifest.json')])).toBe(0);
    expect(host.prepare).toHaveBeenCalledWith(path.join(directory, 'build'), expect.any(String), expect.objectContaining({ challengeSource: source }));
    expect(await autoLibrary(['--phase', 'pack', '--challenge-file', challenge, '--pool', path.join(directory, 'pool'),
      '--output', path.join(directory, 'pack.json')])).toBe(0);
    expect(fs.readFileSync(challenge, 'utf8')).toBe(source);
  });

  it.each(['prepare', 'pack'])('rejects challenge files beyond the finite source limit in %s', async phase => {
    const challenge = path.join(directory, 'Challenge.lean');
    fs.writeFileSync(challenge, ' '.repeat(LEAN_TASK_SOURCE_MAX_BYTES + 1));
    const args = ['--phase', phase, '--challenge-file', challenge, '--pool', path.join(directory, 'pool'),
      ...(phase === 'prepare' ? ['--directory', path.join(directory, 'build'), '--challenge-id', 'large',
        '--build-manifest', path.join(directory, 'manifest.json')] : ['--output', path.join(directory, 'pack.json')])];
    await expect(autoLibrary(args)).rejects.toThrow('math_runtime_file_too_large');
    expect(host.prepare).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(directory, 'build'))).toBe(false);
    expect(fs.existsSync(path.join(directory, 'pack.json'))).toBe(false);
  });

  it('documents demand, definition targets and live usage in help', async () => {
    expect(await autoLibrary(['--help'])).toBe(0);
    const text = vi.mocked(console.log).mock.calls.map(call => call[0]).join('\n');
    for (const term of ['prepare|demand|run', '--delivery ID', '--demand-file FILE', '--definition-targets Qualified.name,Other.name', '--live true'])
      expect(text).toContain(term);
  });
});
