import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readWebConfig, webDefaults } from '../apps/web/config';
import { DockerWebRunner, parseWorkerMessage, webPrivateImagePaths } from '../apps/web/runner';
import type { WorkerExplanationInput, WorkerExplanationMessage, WorkerInput, WorkerMessage } from '../apps/web/shared';

function candidateCheckDocker(reply: { severity?: string; wrongMarker?: boolean; plain?: boolean; exitCode: number }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-target-query-'));
  fs.writeFileSync(path.join(root, 'reply.json'), JSON.stringify(reply));
  fs.writeFileSync(path.join(root, 'docker'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), root = __dirname, args = process.argv.slice(2);
fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify(args) + '\\n');
async function main() {
  if (args[0] === 'create') fs.writeFileSync(path.join(root, 'script.txt'), args.at(-1));
  if (args[0] !== 'start') return;
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  const payload = JSON.parse(input), reply = JSON.parse(fs.readFileSync(path.join(root, 'reply.json'), 'utf8'));
  fs.appendFileSync(path.join(root, 'inputs.jsonl'), input + '\\n');
  const directory = path.join(root, 'check'); fs.mkdirSync(directory, { recursive: true });
  const script = fs.readFileSync(path.join(root, 'script.txt'), 'utf8'), prefix = "exec bun -e '";
  const start = script.indexOf(prefix);
  if (start < 0 || !script.endsWith("'")) throw new Error('fixture_compile_script_missing');
  const program = script.slice(start + prefix.length, -1);
  const bun = { stdin: { text: async () => input }, spawnSync(command) {
    fs.appendFileSync(path.join(root, 'lean-calls.jsonl'), JSON.stringify(command) + '\\n');
    if (command.at(-1) !== payload.queryFile) return { exitCode: 0 };
    const query = fs.readFileSync(payload.queryFile, 'utf8');
    const marker = query.match(/THEOREMOS_CANDIDATE_TARGET_[a-f0-9]{32}/u)?.[0];
    if (!marker) throw new Error('fixture_target_marker_missing');
    const reported = reply.wrongMarker ? marker + '_wrong' : marker;
    process.stdout.write((reply.plain ? reported : JSON.stringify({ severity: reply.severity, data: reported,
      pos: { line: 1, column: 0 } })) + '\\n');
    return { exitCode: reply.exitCode };
  } };
  const fakeProcess = { chdir: () => process.chdir(directory), exit: code => { throw { fixtureExit: true, code }; } };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction('require', 'Bun', 'process', program)(require, bun, fakeProcess);
}
main().catch(error => { if (error?.fixtureExit) process.exitCode = error.code; else { process.stderr.write(String(error)); process.exitCode = 97; } });
`, { mode: 0o700 });
  return root;
}

describe('Docker web runner', () => {
  it.each(['standard', 'mathlib'] as const)('keeps an unlimited %s explanation running until the user cancels', async environment => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-docker-explanation-'));
    fs.writeFileSync(path.join(root, 'docker'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), root = __dirname, args = process.argv.slice(2);
fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify(args) + '\\n');
async function main() {
  if (args[0] === 'create') fs.writeFileSync(path.join(root, 'container'), 'running');
  else if (args[0] === 'start') {
    for await (const _chunk of process.stdin) {}
    process.stdout.write(JSON.stringify({ type: 'progress', progress: { phase: 'writing' } }) + '\\n');
    setInterval(() => {}, 10);
  } else if (args[0] === 'rm') fs.rmSync(path.join(root, 'container'), { force: true });
  else process.exit(1);
}
main().catch(() => process.exit(1));
`, { mode: 0o700 });
    vi.stubEnv('PATH', root);
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const controller = new AbortController();
    let outcome: Promise<Error | undefined> | undefined;
    try {
      const config = readWebConfig({}), request: WorkerExplanationInput = {
        id: 'unlimited-explanation-fixture', proof: 'theorem goal : True := by trivial', target: 'goal', language: 'zh', environment,
        model: 'deepseek-flash', effort: 'max', apiKey: 'sk-offline-fixture', provider: config.providers[0],
        maxRunSeconds: 0, maxTotalTokens: 0, maxRoundsPerBatch: 0, auditors: 2,
      };
      let writing!: () => void;
      const ready = new Promise<void>(resolve => { writing = resolve; }), messages: WorkerExplanationMessage[] = [];
      outcome = new DockerWebRunner(config).explain(request, message => {
        messages.push(message); if (message.type === 'progress') writing();
      }, controller.signal).then(() => undefined, error => error as Error);
      await Promise.race([ready, outcome.then(() => { throw new Error('fixture_stopped_before_writing'); })]);
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
      expect(fs.existsSync(path.join(root, 'container'))).toBe(true);
      expect(fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8')).not.toContain('"rm"');
      controller.abort();
      expect((await outcome)?.message).toBe('explanation_cancelled');
      expect(messages).toEqual([{ type: 'progress', progress: { phase: 'writing' } }]);
      expect(fs.existsSync(path.join(root, 'container'))).toBe(false);
      const calls = fs.readFileSync(path.join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
      expect(calls.map(args => args[0])).toEqual(['create', 'start', 'rm']);
      expect(calls[0]!.slice(-3)).toEqual([config.workerImage, environment, 'explain']);
      expect(calls[0]).toContain(`--memory=${environment === 'mathlib' ? '12g' : '4g'}`);
      expect(calls[0]!.includes('--device=/dev/fuse:/dev/fuse:rw')).toBe(environment === 'mathlib');
      expect(calls[2]).toEqual(['rm', '--force', '--volumes', `theoremos-explain-${request.id}`]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      controller.abort(); await outcome;
      vi.useRealTimers(); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    { decision: 'approve', maxRunSeconds: 1, planApproval: true },
    { decision: 'cancel', maxRunSeconds: 1, planApproval: true },
    { decision: 'cancel', maxRunSeconds: 0, planApproval: false },
  ] as const)('keeps its container during human waits or unlimited execution ($maxRunSeconds seconds, $decision)', async ({ decision, maxRunSeconds, planApproval }) => {
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
          task: 'Offline human review fixture', maxRunSeconds, workers: 2, planApproval },
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
        input: { model: 'deepseek-flash', effort: 'high' },
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

  it.each([
    ['matching information', { severity: 'information', exitCode: 0 }, true],
    ['a different marker', { severity: 'information', wrongMarker: true, exitCode: 0 }, false],
    ['ordinary stdout', { plain: true, exitCode: 0 }, false],
    ['a warning', { severity: 'warning', exitCode: 0 }, false],
    ['a nonzero query exit', { severity: 'information', exitCode: 1 }, false],
  ] as const)('grants checkedTarget only for the host marker in successful Lean information: %s', async (_label, reply, checked) => {
    const root = candidateCheckDocker(reply); vi.stubEnv('PATH', root);
    try {
      const result = await new DockerWebRunner(readWebConfig({})).check({ environment: 'standard',
        source: 'theorem helper : True := by trivial\n', candidateTarget: { name: 'helper', expectedType: 'True' } }, new AbortController().signal);
      expect(result.exitCode).toBe(reply.exitCode); expect(result.timedOut).toBe(false);
      expect(result.checkedTarget).toBe(checked ? 'helper' : undefined);
    } finally { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['source', 'dependency'] as const)('checks the target in a fresh independent module without overwriting a fixed user %s path', async fixedPath => {
    const root = candidateCheckDocker({ severity: 'information', exitCode: 0 }); vi.stubEnv('PATH', root);
    try {
      const dependency = { file: fixedPath === 'source' ? 'Support/Context.lean' : 'TheoremOSCandidateCheck.lean',
        source: 'lemma premise : True := by trivial\n' };
      const input = { environment: 'standard' as const, sourceFile: fixedPath === 'source' ? 'TheoremOSCandidateCheck.lean' : 'Tasks/Target.lean',
        source: `import ${dependency.file.slice(0, -5).replaceAll('/', '.')}\nlemma helper : True := by exact premise\n`,
        dependencySources: [dependency], candidateTarget: { name: 'helper', expectedType: 'True' } };
      const runner = new DockerWebRunner(readWebConfig({}));
      for (let attempt = 0; attempt < 2; attempt++)
        expect((await runner.check(input, new AbortController().signal)).checkedTarget).toBe('helper');
      const payloads = fs.readFileSync(path.join(root, 'inputs.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const leanCalls = fs.readFileSync(path.join(root, 'lean-calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(payloads).toHaveLength(2);
      expect(new Set(payloads.map(item => item.queryFile)).size).toBe(2);
      expect(new Set(payloads.map(item => item.query.match(/THEOREMOS_CANDIDATE_TARGET_[a-f0-9]{32}/u)[0])).size).toBe(2);
      for (const payload of payloads) {
        expect(payload.source).toBe(input.source); expect(payload.modules).toEqual([dependency]);
        expect(payload.queryFile).toMatch(/^TheoremOSCandidateCheck[a-f0-9]{32}\.lean$/u);
        expect([input.sourceFile, dependency.file]).not.toContain(payload.queryFile);
        expect(payload.query).toContain(`import ${input.sourceFile.slice(0, -5).replaceAll('/', '.')}`);
        expect(payload.query).not.toContain(input.source);
        expect(fs.readFileSync(path.join(root, 'check', payload.queryFile), 'utf8')).toBe(payload.query);
        expect(leanCalls).toContainEqual(['lean', '--json', payload.queryFile]);
      }
      expect(fs.readFileSync(path.join(root, 'check', input.sourceFile), 'utf8')).toBe(input.source);
      expect(fs.readFileSync(path.join(root, 'check', dependency.file), 'utf8')).toBe(dependency.source);
      expect(leanCalls).toContainEqual(['lean', '--json', '-o', input.sourceFile.slice(0, -5) + '.olean', input.sourceFile]);
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

  it.skipIf(!process.env.THEOREMOS_TEST_WORKER_IMAGE).each([
    { label: 'preserves an unrelated original sorry while checking the helper',
      source: 'theorem odd_sum : True := by sorry\ntheorem helper : True := by trivial\n', expectedType: 'True', checked: true },
    { label: 'rejects a helper indirectly using sorry through another theorem',
      source: 'theorem unresolved : False := by sorry\ntheorem bridge : False := by exact unresolved\n' +
        'theorem helper : True := by exact False.elim bridge\n', expectedType: 'True', checked: false, error: 'sorryAx' },
    { label: 'rejects a different closed expected type', source: 'theorem helper : True := by trivial\n',
      expectedType: 'False', checked: false, error: 'different type or additional assumptions' },
    { label: 'rejects indirect sorry in the imported dependencySources closure',
      source: 'import Inputs.Middle\ntheorem helper : True := by exact False.elim bridge\n', expectedType: 'True', checked: false, error: 'sorryAx',
      dependencySources: [
        { file: 'Inputs/Open.lean', source: 'theorem unresolved : False := by sorry\n' },
        { file: 'Inputs/Middle.lean', source: 'import Inputs.Open\ntheorem bridge : False := by exact unresolved\n' },
      ] },
    { label: 'checks a qualified helper against its closed type in its namespace', name: 'Scoped.helper',
      source: 'namespace Scoped\nabbrev Index := Nat\ntheorem odd_sum : True := by sorry\n' +
        'theorem helper : ∀ n : Index, n = n := by intro n; rfl\nend Scoped\n',
      expectedType: '∀ n : Index, n = n', checked: true },
    { label: 'checks a definition helper with an explicit Nat type',
      source: 'theorem odd_sum : True := by sorry\ndef helper : Nat := 7\n', expectedType: 'Nat', checked: true },
  ])('independently checks candidate target proofs: $label', async ({ source, expectedType, dependencySources, checked, error, name = 'helper' }) => {
    const runner = new DockerWebRunner({ workerImage: process.env.THEOREMOS_TEST_WORKER_IMAGE! });
    const result = await runner.check({ environment: 'standard', source, dependencySources,
      candidateTarget: { name, expectedType } }, new AbortController().signal);
    expect(result.timedOut).toBe(false);
    expect(result.checkedTarget).toBe(checked ? name : undefined);
    if (checked) { expect(result.exitCode).toBe(0); expect(result.output).toContain('sorry'); }
    else { expect(result.exitCode).not.toBe(0); expect(result.output).toContain(error!); }
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
