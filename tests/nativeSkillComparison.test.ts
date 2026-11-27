import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify as stringifyToml } from 'smol-toml';
import * as build from '../src/math/mathBuildManifest';
import * as adapter from '../src/runtime/codexSession';
import { prepareNativeSkillComparison } from '../scripts/mathematics/prepareNativeSkillComparison';
import { runNativeSkillBaseline } from '../scripts/mathematics/runNativeSkillBaseline';
import { nativeComparisonAccepted, readNativeSkillJob, runtimeSkillArguments } from '../scripts/mathematics/nativeSkillComparison';
import { DEFAULT_TACTIC_BATTERY_FAILURE_CACHE_ROOT } from '../src/solver/tacticBatteryFailureCache';
import { reportNativeSkillComparison } from '../scripts/mathematics/reportNativeSkillComparison';

describe('isolated native single-task and Skill runtime comparison', () => {
  let root: string, directory: string, plan: any;
  const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));
  beforeEach(() => {
    const temp = process.env.TMPDIR || '/data/lzh/default-storage/tmp';
    fs.mkdirSync(temp, { recursive: true }); root = fs.realpathSync(fs.mkdtempSync(path.join(temp, 'native-skill-')));
    directory = path.join(root, 'prepared');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(build, 'readMathBuildManifest').mockReturnValue({} as any);
    for (const key of Object.keys(process.env).filter(key => /^(?:DEEPSCIENTIST_|THEOREMOS_LIBRARY_HOST_)/u.test(key))) vi.stubEnv(key, '');
    vi.stubEnv('DEEPSCIENTIST_MATH_ENV_FILE', path.join(root, 'absent.env'));
    vi.stubEnv('PATH', path.join(os.homedir(), '.elan/toolchains/leanprover--lean4---v4.33.0/bin') + ':/usr/bin:/bin');
    vi.stubEnv('ELAN_HOME', path.join(os.homedir(), '.elan'));
    vi.stubEnv('LEAN_PATH', ''); vi.stubEnv('LEAN_SYSROOT', '');
    vi.stubEnv('DEEPSCIENTIST_MATH_SANDBOX_BACKEND', 'bwrap');
    vi.stubEnv('THEOREMOS_COMPARISON_FIXTURE_ROOT', root);
    vi.stubEnv('THEOREMOS_COMPARISON_FIXTURE_VARIANT', 'complete');
    fs.writeFileSync(path.join(root, 'peer'), '#!' + process.execPath + '\n' + fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/nativeSkillComparisonPeer.cjs'), 'utf8'), { mode: 0o700 });
    const profile = path.join(root, 'profile'); fs.mkdirSync(profile);
    fs.writeFileSync(path.join(profile, 'config.toml'), stringifyToml({ model: 'deepseek-flash', model_provider: 'sub2api',
      model_providers: { sub2api: { base_url: 'http://127.0.0.1:8080/v1', wire_api: 'responses',
        auth: { command: '/usr/bin/printf', args: ['fixture-credential-not-a-key'] } } } }));
    fs.writeFileSync(path.join(profile, 'models.json'), '{}\n');
    const manifest = path.join(root, 'build.json'); fs.writeFileSync(manifest, '{}\n');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url !== 'http://127.0.0.1:8080/v1/responses') throw new Error('fixture_external_network_forbidden');
      return new Response('data: {"type":"response.completed","response":{"id":"fixture-response","usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } });
    }));
    prepareNativeSkillComparison(['--directory', directory, '--build-manifest', manifest, '--profile', profile, '--codex', path.join(root, 'peer')]);
    plan = read(path.join(directory, 'comparison.json'));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });
  const job = (plan: any, arm = 'native-skill') => plan.jobs.find((value: any) => value.arm === arm);
  const launch = (plan: any, arm = 'native-skill') => {
    const item = job(plan, arm); return read(item.launch).args.slice(2) as string[];
  };

  it('prepares both cold starts without opening sessions, using the same pinned allowances and identity', () => {
    expect(fs.existsSync(path.join(root, 'protocol.jsonl'))).toBe(false);
    expect(plan).toMatchObject({ status: 'prepared', invokesModel: false, modelBenefitMeasured: false, scope: 'cold-start-only',
      model: 'deepseek-flash', effort: 'high', maxTotalTokens: 10000, runSeconds: 0, writers: 1, nativeChildren: false });
    const contracts = plan.jobs.map((entry: any) => read(entry.contract));
    expect(contracts[0].workspace).not.toBe(contracts[1].workspace);
    for (const key of ['taskDigest', 'sourceDigest', 'buildDigest', 'environmentDigest', 'harness', 'providerProfileDigest', 'skill'])
      expect(contracts[0][key]).toEqual(contracts[1][key]);
    const args = runtimeSkillArguments(contracts[1]);
    for (const flag of ['--max-turns', '--max-run-seconds', '--max-turn-seconds', '--proof-timeout-seconds', '--evaluator-timeout-seconds'])
      expect(args[args.indexOf(flag) + 1]).toBe('0');
    expect(args).not.toContain('--resume'); expect(args).not.toContain('--native-children');
    expect(reportNativeSkillComparison(directory).rows).toMatchObject([
      { arm: 'native-skill', outcome: 'not-started', totalTokens: null, mathematicallyAccepted: null },
      { arm: 'runtime-skill', outcome: 'not-started', totalTokens: null, mathematicallyAccepted: null }]);
  });

  it.each(['contract', 'launch', 'task', 'environment', 'build', 'profile', 'source'] as const)(
    'rejects changed %s before opening the native session', async field => {
      const entry = job(plan), contract = read(entry.contract);
      const file = field === 'contract' ? entry.contract : field === 'launch' ? entry.launch : field === 'task' ? contract.taskFile :
        field === 'environment' ? contract.environmentFile : field === 'build' ? contract.build : field === 'profile'
          ? path.join(contract.harness.profile, 'config.toml') : path.join(contract.workspace, 'generated/problem/Submission.lean');
      fs.chmodSync(file, 0o600); fs.appendFileSync(file, field === 'profile' ? '\n# changed\n' : '\n ');
      await expect(runNativeSkillBaseline(launch(plan))).rejects.toThrow();
      expect(fs.existsSync(path.join(root, 'protocol.jsonl'))).toBe(false);
      expect(fs.existsSync(entry.output)).toBe(false);
      expect(reportNativeSkillComparison(directory).rows[0]).toMatchObject({ outcome: 'invalid', outcomeComparable: false, costComparable: false, totalTokens: null });
    });

  it('executes exactly one real app-server task, charges relay receipts and independently checks both original Lean targets', async () => {
    const open = vi.spyOn(adapter, 'createCodexMathSession');
    const code = await runNativeSkillBaseline(launch(plan));
    const entry = job(plan), result = read(entry.output), options = open.mock.calls[0][0];
    expect(code, JSON.stringify(result)).toBe(0);
    expect(open).toHaveBeenCalledOnce();
    expect(options).toMatchObject({ proofProjectRoot: path.join(options.workspace, 'generated/problem'),
      hiddenRoots: [DEFAULT_TACTIC_BATTERY_FAILURE_CACHE_ROOT], environment: { DEEPSCIENTIST_MATH_WORKER_ID: 'solver',
        DEEPSCIENTIST_MATH_WORKER_WORKTREE: options.workspace } });
    expect(options.turnTimeoutMs).toBeUndefined();
    expect(result).toMatchObject({ accepted: true, status: 'evaluated_passed', writerStopped: true, turns: 1, totalTokens: 7,
      requestUsageAccounting: { startedRequests: 1, reportedRequests: 1, pendingRequests: 0, incomplete: false },
      evaluator: { status: 'passed', method: 'host-lean-kernel-all-targets', official: false } });
    expect(result.evaluator.verification.verification.results).toHaveLength(2);
    const { problem } = readNativeSkillJob(entry.contract, entry.contractDigest, entry.workspace, entry.output, 'report');
    expect(nativeComparisonAccepted(problem, result.check, result.evaluator)).toBe(true);
    expect(nativeComparisonAccepted(problem, result.check, { ...result.evaluator, verification: { ...result.evaluator.verification,
      verification: { ...result.evaluator.verification.verification, results: result.evaluator.verification.verification.results.slice(0, 1) } } })).toBe(false);
    const calls = fs.readFileSync(path.join(root, 'protocol.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line).method);
    expect(calls.filter(method => method === 'turn/start')).toHaveLength(1);
    expect(calls.some(method => /steer|compact|resume/u.test(method))).toBe(false);
    expect(read(`${entry.output}.comparison.json`)).toMatchObject({ status: 'finished', exitCode: 0, contractDigest: entry.contractDigest,
      launchDigest: entry.launchDigest, resultDigest: expect.any(String) });
    expect(reportNativeSkillComparison(directory).rows).toMatchObject([
      { arm: 'native-skill', mathematicallyAccepted: true, totalTokens: 7, turns: 1, outcomeComparable: true, costComparable: true },
      { arm: 'runtime-skill', outcome: 'not-started', totalTokens: null }]);
    const evidence = process.env.THEOREMOS_COMPARISON_EVIDENCE_DIR;
    if (evidence) {
      fs.mkdirSync(evidence, { recursive: true });
      for (const [source, name] of [[entry.output, 'result.json'], [`${entry.output}.runtime/state.json`, 'state.json'],
        [path.join(root, 'protocol.jsonl'), 'peer-protocol.jsonl'],
        [path.join(options.workspace, 'generated/problem/Submission.lean'), 'Submission.lean']]) fs.copyFileSync(source, path.join(evidence, name));
    }
    fs.appendFileSync(path.join(options.workspace, 'generated/problem/Submission.lean'), '\n-- changed after observation\n');
    expect(reportNativeSkillComparison(directory).rows[0]).toMatchObject({ outcome: 'invalid', costComparable: false, mathematicallyAccepted: null });
  }, 60000);

  it.each(['partial', 'changed-type', 'done-only'])('does not accept a %s delivery', async variant => {
    vi.stubEnv('THEOREMOS_COMPARISON_FIXTURE_VARIANT', variant);
    expect(await runNativeSkillBaseline(launch(plan))).not.toBe(0);
    const result = read(job(plan).output);
    expect(result.accepted).toBe(false); expect(result.turns).toBe(1); expect(result.totalTokens).toBe(7);
    expect(result.evaluator?.status).not.toBe('passed');
  }, 60000);

  it('retains missing provider usage as unknown even when native counters claim tokens and Lean passes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('data: {"type":"response.completed","response":{"id":"missing-usage"}}\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } })));
    await runNativeSkillBaseline(launch(plan));
    const result = read(job(plan).output);
    expect(result.totalTokens).toBeNull(); expect(result.requestUsageAccounting.incomplete).toBe(true);
    expect(result.tokenBudget.usageComplete).toBe(false);
    expect(reportNativeSkillComparison(directory).rows[0]).toMatchObject({ totalTokens: null, costComparable: false });
  }, 60000);

  it('keeps transport failure as a result with its observed request usage', async () => {
    vi.stubEnv('THEOREMOS_COMPARISON_FIXTURE_VARIANT', 'crash');
    expect(await runNativeSkillBaseline(launch(plan))).toBe(1);
    expect(read(job(plan).output)).toMatchObject({ accepted: false, status: 'runtime_error', totalTokens: 7, turns: 1 });
  }, 60000);

  it('retains a transport failure separately when saved original proofs independently pass', async () => {
    vi.stubEnv('THEOREMOS_COMPARISON_FIXTURE_VARIANT', 'crash-after-write');
    expect(await runNativeSkillBaseline(launch(plan))).toBe(1);
    expect(read(job(plan).output)).toMatchObject({ accepted: true, status: 'runtime_error', executionStatus: 'failed',
      totalTokens: 7, error: expect.any(String), evaluator: { status: 'passed', method: 'host-lean-kernel-all-targets' } });
  }, 60000);

  it('preserves shutdown exceptions and does not check a writer whose stop is unconfirmed', async () => {
    const close = vi.fn(async () => { throw new Error('fixture-close'); }), stop = vi.fn(async () => ({ status: 'unconfirmed' as const, reason: 'shutdown-failed' as const }));
    vi.spyOn(adapter, 'createCodexMathSession').mockResolvedValue({ threadId: 'mock-unconfirmed', usageSource: 'upstream-requests',
      run: async () => 'completed', close, stopForFreeze: stop, interrupt: async () => {} });
    expect(await runNativeSkillBaseline(launch(plan))).toBe(1);
    expect(stop).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
    expect(read(job(plan).output)).toMatchObject({ accepted: false, writerStopped: false, status: 'runtime_error', totalTokens: null,
      writerStopUnconfirmed: { reason: 'shutdown-failed' } });
    expect(read(job(plan).output).check).toBeUndefined();
  });
});
