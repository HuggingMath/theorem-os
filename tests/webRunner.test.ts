import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readWebConfig, webDefaults } from '../apps/web/config';
import { DockerWebRunner, parseWorkerMessage, webPrivateImagePaths } from '../apps/web/runner';
import type { WorkerInput, WorkerMessage } from '../apps/web/shared';

describe('Docker web runner', () => {
  it.each(['approve', 'cancel'] as const)('keeps the same container beyond the outer deadline while awaiting a person, then handles %s', async decision => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-docker-approval-'));
    fs.writeFileSync(path.join(root, 'docker'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), root = __dirname;
fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify(args) + '\\n');
async function main() {
  if (args[0] === 'create') fs.writeFileSync(path.join(root, 'container'), 'waiting');
  else if (args[0] === 'start') {
    for await (const _chunk of process.stdin) {}
    process.stdout.write(JSON.stringify({ type: 'progress', event: 'plan_approval_wait_started', message: 'Waiting' }) + '\\n');
    while (!fs.existsSync(path.join(root, 'approve'))) await new Promise(resolve => setTimeout(resolve, 10));
    process.stdout.write(JSON.stringify({ type: 'progress', event: 'plan_approval_wait_ended', message: 'Approved' }) + '\\n');
    process.stdout.write(JSON.stringify({ type: 'result', result: { status: 'incomplete', proof: '', report: {} } }) + '\\n');
  } else if (args[0] === 'rm') fs.rmSync(path.join(root, 'container'), { force: true });
  else process.exit(1);
}
main().catch(() => process.exit(1));
`, { mode: 0o700 });
    vi.stubEnv('PATH', root);
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    let complete: Promise<void> | undefined;
    const controller = new AbortController();
    try {
      const config = readWebConfig({}), request: WorkerInput = {
        id: 'approval-wait-fixture', provider: config.providers[0], input: { ...webDefaults,
          providerId: config.providers[0].id, apiKey: 'sk-offline-fixture', source: 'theorem goal : True := by sorry',
          task: 'Offline human review fixture', maxRunSeconds: 1, workers: 2, planApproval: true },
      };
      let waiting!: () => void;
      const ready = new Promise<void>(resolve => { waiting = resolve; }), messages: WorkerMessage[] = [];
      complete = new DockerWebRunner(config).run(request, message => {
        messages.push(message);
        if (message.type === 'progress' && message.event === 'plan_approval_wait_started') waiting();
      }, controller.signal);
      await Promise.race([ready, complete.then(() => { throw new Error('fixture_stopped_before_wait'); })]);
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(fs.existsSync(path.join(root, 'container'))).toBe(true);
      expect(fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8')).not.toContain('"rm"');
      if (decision === 'approve') fs.writeFileSync(path.join(root, 'approve'), 'approved');
      else controller.abort(new Error('owner_cancelled'));
      await complete;
      const calls = fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(calls.filter(args => args[0] === 'create')).toHaveLength(1);
      expect(calls.filter(args => args[0] === 'start')).toHaveLength(1);
      expect(fs.existsSync(path.join(root, 'container'))).toBe(false);
      expect(messages.map(message => message.type === 'progress' ? message.event : message.type)).toEqual(decision === 'approve'
        ? ['plan_approval_wait_started', 'plan_approval_wait_ended', 'result'] : ['plan_approval_wait_started']);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      fs.writeFileSync(path.join(root, 'approve'), 'cleanup');
      controller.abort(); await complete?.catch(() => {});
      vi.useRealTimers(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('routes the default sub2api request through private stdin and removes its container', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-docker-runner-'));
    fs.writeFileSync(path.join(root, 'docker'), `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify(args) + '\\n');
const container = path.join(root, 'container');
async function main() {
  if (args[0] === 'create') {
    fs.writeFileSync(container, 'created');
  } else if (args[0] === 'start') {
    if (!fs.existsSync(container)) process.exit(1);
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const request = JSON.parse(input);
    fs.writeFileSync(path.join(root, 'private-input.json'), input, { mode: 0o600 });
    fs.writeFileSync(path.join(root, 'metadata.json'), JSON.stringify({
      apiKeyInEnvironment: Object.values(process.env).some(value => value.includes(request.input.apiKey)),
    }));
    process.stdout.write(JSON.stringify({ type: 'result', result: {
      status: 'incomplete', proof: '', report: { fixture: true },
    } }) + '\\n');
  } else if (args[0] === 'rm') {
    fs.rmSync(container, { force: true });
  } else process.exit(1);
}
main().catch(() => process.exit(1));
`, { mode: 0o700 });
    // Only this executable can resolve as docker; the fixture uses an absolute Node shebang.
    vi.stubEnv('PATH', root);
    try {
      const config = readWebConfig({});
      const request: WorkerInput = {
        id: 'sub2api-fixture', provider: config.providers[0], input: {
          ...webDefaults, providerId: config.providers[0].id, apiKey: 'sk-private-runner-fixture',
          source: 'theorem example : True := by sorry', task: 'Offline fixture',
        },
      };
      const messages: WorkerMessage[] = [];
      await new DockerWebRunner(config).run(request, message => messages.push(message), new AbortController().signal);

      const calls = fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n')
        .map(line => JSON.parse(line) as string[]);
      expect(calls.map(args => args[0])).toEqual(['create', 'start', 'rm']);
      expect(calls[0]).toContain('--add-host=host.docker.internal:host-gateway');
      const name = `theoremos-web-${request.id}`;
      expect(calls[1]).toEqual(['start', '--attach', '--interactive', name]);
      expect(calls[2]).toEqual(['rm', '--force', '--volumes', name]);
      expect(fs.existsSync(path.join(root, 'container'))).toBe(false);

      const received = JSON.parse(fs.readFileSync(path.join(root, 'private-input.json'), 'utf8'));
      expect(received).toEqual(request);
      expect(received).toMatchObject({
        provider: { id: 'sub2api', baseUrl: 'http://host.docker.internal:8080/v1' },
        input: { model: 'deepseek-flash', effort: 'max' },
      });
      const metadata = JSON.parse(fs.readFileSync(path.join(root, 'metadata.json'), 'utf8'));
      expect(metadata).toEqual({ apiKeyInEnvironment: false });
      expect(messages).toEqual([{ type: 'result', result: {
        status: 'incomplete', proof: '', report: { fixture: true },
      } }]);
      expect(JSON.stringify({ calls, metadata, messages })).not.toContain(request.input.apiKey);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('statement check container', () => {
  const leak = '#eval show IO Unit from do\n  let text ← IO.FS.readFile "/opt/theorem-os/LICENSE"\n  throw (IO.userError (text.take 200).toString)\n' +
    'theorem t : True := trivial\n';

  it('compiles only reachable host-selected dependencies in their original module paths', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-candidate-context-'));
    fs.writeFileSync(path.join(root, 'docker'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify(args) + '\\n');
if (args[0] === 'start') {
  let input = ''; process.stdin.on('data', chunk => input += chunk).on('end', () => fs.writeFileSync(path.join(__dirname, 'input.json'), input));
}
`, { mode: 0o700 });
    vi.stubEnv('PATH', root);
    try {
      const runner = new DockerWebRunner(readWebConfig({}));
      const input = { environment: 'standard' as const, sourceFile: 'Tasks/Target.lean',
        source: 'import Local.Middle\ntheorem target : True := by exact helper\n', dependencySources: [
          { file: 'Local/Middle.lean', source: 'import Local.Base\nlemma helper : True := by exact base\n' },
          { file: 'Local/Base.lean', source: 'lemma base : True := by trivial\n' },
          { file: 'Unrelated.lean', source: 'theorem unrelated : False := by sorry\n' },
        ] };
      await runner.check(input, new AbortController().signal);
      const received = JSON.parse(fs.readFileSync(path.join(root, 'input.json'), 'utf8'));
      expect(received.sourceFile).toBe(input.sourceFile); expect(received.source).toBe(input.source);
      expect(received.modules).toEqual([input.dependencySources[1], input.dependencySources[0]]);
      await expect(runner.check({ ...input, dependencySources: [{ file: '../outside.lean', source: '' }] },
        new AbortController().signal)).rejects.toThrow('web_check_dependency_path_invalid');
      const calls = fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
      expect(calls.map(args => args[0])).toEqual(['create', 'start', 'rm']);
      expect(calls[0]).toContain('--network=none'); expect(calls[0]).toContain('--read-only');
    } finally { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['standard', 'mathlib'] as const)('covers the image\'s own code and build state (%s)', async environment => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-docker-check-'));
    fs.writeFileSync(path.join(root, 'docker'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(require('node:path').join(__dirname, 'calls.jsonl'), JSON.stringify(args) + '\\n');
if (args[0] === 'start') process.stdin.on('data', () => {}).on('end', () => process.stdout.write('{}\\n'));
`, { mode: 0o700 });
    vi.stubEnv('PATH', root);
    try {
      await new DockerWebRunner(readWebConfig({})).check!({ environment, source: leak }, new AbortController().signal);
      const create = fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[])
        .find(args => args[0] === 'create')!;
      const mounts = create.flatMap((arg, index) => arg === '--tmpfs' ? [create[index + 1]!.split(':')[0]] : []);
      expect(mounts).toEqual(['/tmp', ...webPrivateImagePaths]);
      expect(create).toContain('--network=none');
      expect(create.at(-1)!.includes('/opt/theoremos-library/.lake/build/lib/lean')).toBe(environment === 'mathlib');
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['standard', 'mathlib'] as const)('removes an abandoned %s check without starting it after Docker creation finishes', async environment => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-abandoned-check-'));
    fs.writeFileSync(path.join(root, 'docker'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const root = __dirname, args = process.argv.slice(2), container = path.join(root, 'container');
fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify(args) + '\\n');
if (args[0] === 'create') {
  fs.writeFileSync(container, 'created');
  const timer = setInterval(() => { if (fs.existsSync(path.join(root, 'release'))) clearInterval(timer); }, 5);
} else if (args[0] === 'start') {
  process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('{}\\n'));
} else if (args[0] === 'rm') fs.rmSync(container, { force: true });
`, { mode: 0o700 });
    vi.stubEnv('PATH', root);
    const controller = new AbortController(), reason = new Error('fixture superseded during create');
    const pending = new DockerWebRunner(readWebConfig({})).check!({ environment,
      source: 'theorem abandoned : True := by sorry' }, controller.signal);
    void pending.catch(() => {});
    try {
      await expect.poll(() => fs.existsSync(path.join(root, 'container'))).toBe(true);
      controller.abort(reason);
      fs.writeFileSync(path.join(root, 'release'), 'release');
      await expect(pending).rejects.toBe(reason);
      const calls = fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
      expect(calls.map(args => args[0])).toEqual(['create', 'rm']);
      expect(fs.existsSync(path.join(root, 'container'))).toBe(false);
    } finally {
      fs.writeFileSync(path.join(root, 'release'), 'release');
      controller.abort(reason); await pending.catch(() => {});
      vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // THEOREMOS_TEST_WORKER_IMAGE=theorem-os-worker:local runs it against a built image.
  it.skipIf(!process.env.THEOREMOS_TEST_WORKER_IMAGE)('cannot read the application from a statement', async () => {
    const runner = new DockerWebRunner({ workerImage: process.env.THEOREMOS_TEST_WORKER_IMAGE! });
    const { output } = await runner.check!({ environment: 'standard', source: leak }, new AbortController().signal);
    expect(output).toContain('/opt/theorem-os/LICENSE');
    expect(output).toContain('no such file');
    expect(output).not.toContain('proprietary');
  }, 120_000);
});

describe('web worker protocol boundary', () => {
  it('accepts a host-declared library restart with both solver identities and a positive round', () => {
    const message = { type: 'library_restart', previousSolverRunId: 'solver-first', solverRunId: 'solver-next', round: 1 };
    expect(parseWorkerMessage(JSON.stringify(message))).toEqual(message);
  });

  it.each([
    {}, { previousSolverRunId: '' }, { solverRunId: '' }, { solverRunId: 'x'.repeat(129) },
    { round: 0 }, { round: -1 }, { round: 1.5 }, { round: Number.MAX_SAFE_INTEGER + 1 },
    { round: '1' }, { extra: 'unexpected' },
  ])('rejects malformed library restart metadata (%#)', overrides => {
    const message = Object.keys(overrides).length ? { type: 'library_restart', previousSolverRunId: 'solver-first',
      solverRunId: 'solver-next', round: 1, ...overrides } : { type: 'library_restart' };
    expect(parseWorkerMessage(JSON.stringify(message))).toBeUndefined();
  });

  it('accepts progress and a structured acceptance result', () => {
    expect(parseWorkerMessage('{"type":"progress","event":"ready","message":"Ready"}'))
      .toEqual({ type: 'progress', event: 'ready', message: 'Ready' });
    const result = { type: 'result', result: { status: 'evaluated_passed', proof: 'by rfl', report: { evaluator: { status: 'passed' } } } };
    expect(parseWorkerMessage(JSON.stringify(result))).toEqual(result);
  });

  it('accepts a bounded Lean candidate without granting acceptance', () => {
    const artifact = { type: 'artifact', artifact: { source: 'theorem example : True := by trivial',
      workerId: 'engineer', capturedAt: '2026-10-17T00:00:00.000Z', status: 'candidate' } };
    expect(parseWorkerMessage(JSON.stringify(artifact))).toEqual(artifact);
  });

  it('accepts bounded optional structured progress without changing legacy messages', () => {
    const message = { type: 'progress', event: 'proof_checked', message: 'Checked',
      details: { workerId: 'solver', turn: 1, passed: false, conditional: false, reused: true } };
    expect(parseWorkerMessage(JSON.stringify(message))).toEqual(message);
    const legacy = { type: 'progress', event: 'proof_checked', message: 'Checked' };
    expect(parseWorkerMessage(JSON.stringify(legacy))).toEqual(legacy);
  });

  it.each([
    null, [], 'private', { workerId: '/work/private' }, { workerId: 'x'.repeat(65) },
    { turn: -1 }, { usedBytes: 1.5 }, { maxBytes: Number.MAX_SAFE_INTEGER + 1 },
    { passed: 'true' }, { status: 'private log' }, { operation: 'run-shell' }, { role: 'admin' },
    { workerId: 'solver', threadId: 'private-thread' }, { context: { apiKey: 'sk-private' } },
  ])('rejects malformed or non-allowlisted progress metadata (%#)', details => {
    expect(parseWorkerMessage(JSON.stringify({ type: 'progress', event: 'worker_activity', message: 'Working', details }))).toBeUndefined();
  });

  it.each([
    { source: '', workerId: 'solver', capturedAt: '2026-10-17T00:00:00.000Z', status: 'candidate' },
    { source: 'by trivial', workerId: '../secret', capturedAt: '2026-10-17T00:00:00.000Z', status: 'candidate' },
    { source: 'by trivial', workerId: 'solver', capturedAt: 'yesterday', status: 'candidate' },
    { source: 'by trivial', workerId: 'solver', capturedAt: '2026-10-17T00:00:00.000Z', status: 'evaluated_passed' },
    { source: 'by trivial', workerId: 'solver', capturedAt: '2026-10-17T00:00:00.000Z', status: 'candidate', path: '/etc/passwd' },
    { source: '\u8bc1'.repeat(50_000), workerId: 'solver', capturedAt: '2026-10-17T00:00:00.000Z', status: 'candidate' },
  ])('rejects invalid candidate metadata or oversized UTF-8 (%#)', artifact => {
    expect(parseWorkerMessage(JSON.stringify({ type: 'artifact', artifact }))).toBeUndefined();
  });

  it.each([
    'runtime console output', 'null', '[]', '{}', '{"type":"result"}',
    '{"type":"result","result":{"status":"evaluated_passed","proof":"","report":[]}}',
    '{"type":"progress","event":{},"message":"Ready"}',
    '{"type":"error","message":null}',
    JSON.stringify({ type: 'result', result: { status: 'incomplete', proof: 'x'.repeat(128 * 1024 + 1), report: {} } }),
  ])('ignores malformed or oversized protocol data (%#)', line => {
    expect(parseWorkerMessage(line)).toBeUndefined();
  });
});
