import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindWebWorkerProfile, prepareWebNativeProfile, publicWebProvider, webHarnessEnvironment,
  webHarnessModel, webProviderExecutionDigest } from '../apps/web/harness';
import { webSolverModules } from '../apps/web/worker';
import { readWebConfig } from '../apps/web/config';
import { WebJobs } from '../apps/web/jobs';
import { WebStorage } from '../apps/web/storage';
import { loadWebSample } from '../apps/web/sample';
import { temporaryDirectory } from './helpers/files';
import { cliConfigurationSchema } from '../src/runtime/cliConfiguration';
import type { MathAgentOptions, MathAgentSession } from '../src/runtime/agentSession';
import type { WebRunner } from '../apps/web/runner';
import type { WebObservation } from '../apps/web/collaboration';
import type { WebRunInput, WebWorkerProvider, WorkerInput } from '../apps/web/shared';
import { mathDigest } from '../src/math/mathRuntimeIo';

const roots: string[] = [], sessions: MathAgentSession[] = [], queues: WebJobs[] = [];
afterEach(async () => {
  await Promise.allSettled(sessions.splice(0).map(session => session.close()));
  await Promise.all(queues.splice(0).map(queue => queue.close()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const input = (changes: Partial<WebRunInput> = {}): WebRunInput => ({ providerId: 'native', apiKey: 'sk-disposable-web-key',
  model: 'fixture-model', effort: 'high', environment: 'standard', source: 'theorem goal : True := by sorry',
  task: 'Prove goal.', maxTurns: 1, maxRunSeconds: 30, workers: 3, coordination: 'cooperative', researchMode: 'skill',
  skillLoading: 'file', ...changes });

function fixture(harness: 'claude-code' | 'opencode' | 'cli') {
  const root = temporaryDirectory('web-native-harness-'); roots.push(root);
  const workspace = path.join(root, 'workspace'), other = path.join(root, 'other'), profile = path.join(root, 'profile');
  fs.mkdirSync(workspace); fs.mkdirSync(other);
  const executable = path.join(root, 'native-peer'), name = harness === 'claude-code' ? 'claudeCodeProtocolPeer.cjs'
    : harness === 'opencode' ? 'openCodeNativePeer.mjs' : 'cliProtocolPeer.cjs';
  fs.copyFileSync(path.resolve('tests/fixtures', name), executable); fs.chmodSync(executable, 0o700);
  const provider: WebWorkerProvider = { id: 'native', name: 'Offline native peer', baseUrl: 'https://models.example.test/v1',
    harness, execution: { executable, ...(harness === 'cli' ? { cli: cliConfigurationSchema.parse({
      schema: 'theorem-os.cli-harness.v1', executable,
      args: ['--model', '{model}', '--effort', '{effort}', '--profile', '{profile}', '--format', 'jsonl'],
      inheritEnvironment: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'], efforts: ['high'], output: { format: 'jsonl',
        text: { field: '/result/text', when: { field: '/kind', value: 'final' } },
        usage: { when: { field: '/kind', value: 'final' }, inputTokens: '/stats/input', outputTokens: '/stats/output',
          cachedInputTokens: '/stats/cached', reasoningOutputTokens: '/stats/reasoning', completeness: 'complete' },
      },
    }) } : {}) } };
  prepareWebNativeProfile(profile, provider, input());
  const options: MathAgentOptions = { executable, workspace, profile, model: webHarnessModel(provider, input().model),
    effort: 'high', instructions: 'Frozen host contract.', environment: { PATH: process.env.PATH,
      ...webHarnessEnvironment(provider, input().apiKey), DEEPSCIENTIST_MATH_WORKER_ID: 'worker-1' },
    onUsage: vi.fn(), onUsageIncomplete: vi.fn() };
  return { root, workspace, other, profile, provider, options };
}

describe('Web server-selected harnesses', () => {
  it.each(['claude-code', 'opencode', 'cli'] as const)('executes %s through the same BYOK wrapper with independent native worker state', async harness => {
    const f = fixture(harness), request: WorkerInput = { id: 'web-native-fixture', input: input(), provider: f.provider };
    const modules = webSolverModules(request), first = await modules.M1.open(f.options); sessions.push(first);
    expect(await first.run('Continue frozen research.', 'turn-one', f.workspace, vi.fn())).toBe('completed');
    expect(f.options.onUsage).toHaveBeenCalledOnce(); expect(f.options.onUsageIncomplete).not.toHaveBeenCalled();
    const identity = first.isolationReceipt?.harnessIdentity as { id: string; profile: string };
    expect(identity.id).toBe(harness); expect(identity.profile).not.toBe(f.profile);
    expect(await first.stopForFreeze!()).toEqual({ status: 'stopped' }); await first.close();
    const resumed = await modules.M1.open({ ...f.options, threadId: first.threadId }); sessions.push(resumed);
    expect(await resumed.run('Continue saved work.', 'turn-two', f.workspace, vi.fn())).toBe('completed');
    if (harness !== 'cli') expect(resumed.threadId).toBe(first.threadId);
    expect(resumed.isolationReceipt?.harnessIdentity).toEqual(identity);
    const second = bindWebWorkerProfile({ ...f.options, workspace: f.other }, f.provider);
    expect(second.profile).not.toBe(identity.profile);
    const settings = harness === 'claude-code' ? 'settings.json' : harness === 'opencode' ? 'opencode.json' : 'cli.json';
    expect(fs.readFileSync(path.join(second.profile, settings), 'utf8')).toBe(fs.readFileSync(path.join(f.profile, settings), 'utf8'));
    expect(fs.readFileSync(path.join(f.profile, settings), 'utf8')).not.toContain(input().apiKey);
  });

  it('recovers a worker profile left behind by an interrupted first binding', () => {
    const f = fixture('cli'), directory = path.join(path.dirname(fs.realpathSync(f.profile)), 'native-sessions');
    const leftover = path.join(directory, mathDigest(f.workspace).slice(0, 32));
    fs.mkdirSync(leftover, { recursive: true }); fs.writeFileSync(path.join(leftover, 'cli.json'), 'partial');
    const binding = bindWebWorkerProfile(f.options, f.provider);
    expect(binding.profile).toBe(leftover);
    expect(fs.readFileSync(path.join(leftover, 'cli.json'), 'utf8')).toBe(fs.readFileSync(path.join(f.profile, 'cli.json'), 'utf8'));
    expect(() => binding.assertCurrent()).not.toThrow();
    expect(bindWebWorkerProfile(f.options, f.provider).identity).toEqual(binding.identity);
  });

  it('rejects changed native settings at dispatch and after stopping a writer', async () => {
    const f = fixture('cli'), session = await webSolverModules({ id: 'fixture', input: input(), provider: f.provider }).M1.open(f.options);
    sessions.push(session);
    const binding = bindWebWorkerProfile(f.options, f.provider), settings = path.join(binding.profile, 'cli.json');
    fs.appendFileSync(settings, '\n');
    await expect(session.run('must not dispatch', 'never', f.workspace, vi.fn())).rejects.toThrow('math_harness_identity_changed');
    await expect(session.stopForFreeze!()).rejects.toThrow('math_harness_identity_changed');
    expect(f.options.onUsage).not.toHaveBeenCalled();
  });

  it('freezes the server-selected launch configuration and never returns it as a public provider', async () => {
    const f = fixture('cli'), root = temporaryDirectory('web-harness-jobs-'); roots.push(root);
    let received: WorkerInput | undefined;
    const runner: WebRunner = { async readiness() { return { ready: true, message: 'Offline fixture' }; },
      async run(value, _emit, signal) { received = value;
        await new Promise<void>(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }); }); } };
    const jobs = new WebJobs(runner, { concurrency: 1, queueLimit: 4 }, { storage: new WebStorage(root) }); queues.push(jobs);
    const request = input({ researchMode: undefined, skillLoading: undefined }), mutable = structuredClone(f.provider);
    const run = jobs.create('owner', request, mutable, undefined, 'native-request');
    mutable.execution!.executable = '/changed/after-enqueue';
    (mutable.execution!.cli!.args as string[]).push('--changed-after-enqueue');
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(received?.input).toMatchObject({ researchMode: 'skill', skillLoading: 'file', workers: 3, coordination: 'cooperative' });
    expect(received?.provider).toEqual(f.provider);
    expect(run).toMatchObject({ harness: 'cli', harnessConfigurationDigest: webProviderExecutionDigest(f.provider) });
    expect(jobs.replay('owner', request, f.provider, 'native-request')?.id).toBe(run.id);
    expect(() => jobs.replay('owner', request, { ...f.provider, execution: { ...f.provider.execution,
      executable: '/changed/native' } }, 'native-request')).toThrow(/不同/);
    expect(publicWebProvider(f.provider)).toEqual({ id: f.provider.id, name: f.provider.name, baseUrl: f.provider.baseUrl,
      harness: 'cli', efforts: ['high'] });
    const saved = new WebStorage(root).loadRuns()[0]!.run;
    expect(saved.harnessConfigurationDigest).toBe(run.harnessConfigurationDigest);
    expect(JSON.stringify(saved)).not.toContain(input().apiKey); expect(JSON.stringify(saved)).not.toContain(f.options.executable);
  });

  it('freezes an actual native harness only after accepting the complete observation identity', async () => {
    const f = fixture('cli'), root = temporaryDirectory('web-harness-observation-'); roots.push(root);
    let emit!: Parameters<WebRunner['run']>[1];
    const runner: WebRunner = { async readiness() { return { ready: true, message: 'Offline fixture' }; },
      async run(_value, send, signal) { emit = send;
        await new Promise<void>(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }); }); } };
    const jobs = new WebJobs(runner, { concurrency: 1, queueLimit: 4 }, { storage: new WebStorage(root) }); queues.push(jobs);
    const run = jobs.create('owner', input(), f.provider);
    await new Promise<void>(resolve => setImmediate(resolve));
    const harness = { id: 'cli' as const, executableDigest: mathDigest('offline executable'), configurationDigest: mathDigest('offline configuration') };
    const observation = (sequence: number): WebObservation => {
      const value = structuredClone(loadWebSample().observations[0]); value.webRunId = run.id; value.sequence = sequence;
      Object.assign(value.inspection.configuration, { researchMode: 'skill', agentHarness: harness,
        researchSkill: { name: 'mathematical-research', digest: mathDigest('frozen skill'), loading: 'file' } });
      return value;
    };
    for (const change of [
      { agentHarness: undefined },
      { agentHarness: { ...harness, id: 'codex' as const } },
      { researchMode: 'legacy' as const },
      { researchSkill: undefined },
      { researchSkill: { name: 'mathematical-research', digest: mathDigest('wrong loading'), loading: 'native' as const } },
    ]) {
      const rejected = observation(1); Object.assign(rejected.inspection.configuration, change);
      emit({ type: 'observation', observation: rejected });
      expect(run.agentHarness).toBeUndefined(); expect(run.researchSkill).toBeUndefined(); expect(run.observation).toBeUndefined();
    }
    emit({ type: 'observation', observation: observation(1) });
    expect(run.agentHarness).toEqual(harness); expect(run.observation?.sequence).toBe(1);
    for (const change of [{ ...harness, executableDigest: mathDigest('changed executable') },
      { ...harness, configurationDigest: mathDigest('changed configuration') }, undefined]) {
      const rejected = observation(2); rejected.inspection.configuration.agentHarness = change;
      emit({ type: 'observation', observation: rejected });
      expect(run.agentHarness).toEqual(harness); expect(run.observation?.sequence).toBe(1);
    }
    emit({ type: 'observation', observation: observation(2) });
    expect(run.observation?.sequence).toBe(2);
    expect(new WebStorage(root).loadRuns()[0]!.run.agentHarness).toEqual(harness);
    expect(run.result).toBeUndefined();
  });

  it('accepts operator CLI declarations while rejecting unbound credentials, unsafe paths and runtime environment replacement', () => {
    const f = fixture('cli'), configure = (provider: WebWorkerProvider) => readWebConfig({ THEOREMOS_WEB_PROVIDERS: JSON.stringify([provider]) });
    expect(configure(f.provider).providers[0]).toMatchObject({ harness: 'cli', execution: { executable: f.options.executable } });
    for (const execution of [{ ...f.provider.execution, files: { '../outside': 'forbidden' } },
      { ...f.provider.execution, apiKeyEnvironment: 'HOME' }, { ...f.provider.execution, cli: undefined }])
      expect(() => configure({ ...f.provider, execution })).toThrow();
    const bad = { ...f.provider, execution: { ...f.provider.execution, cli: { ...f.provider.execution!.cli!, inheritEnvironment: [] } } };
    expect(() => prepareWebNativeProfile(path.join(f.root, 'bad-profile'), bad, input())).toThrow('web_cli_provider_environment_unbound');
  });
});
