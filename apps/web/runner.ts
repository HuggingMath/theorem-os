import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { WebConfig } from './config';
import type { WorkerInput, WorkerMessage } from './shared';
import { webArtifactMaxBytes, webFailureKinds, webFailureReason } from './shared';
import { isWebEventDetails } from './moduleTelemetry';
import type { WebEventDetails } from './shared';
import type { WebCommand, WebCommandResult, WebObservation } from './collaboration';
import type { WebPrecheckOutput, WebPrecheckRunner } from './precheck';
import { validateTheoremKnowledge } from '../../src/solver/theoremKnowledge';

export type WebRunner = {
  readiness(): Promise<{ ready: boolean; message: string }>;
  run(input: WorkerInput, onMessage: (message: WorkerMessage) => void, signal: AbortSignal): Promise<void>;
  command?(id: string, command: WebCommand): Promise<WebCommandResult>;
  /** Compiles a statement on its own, without a model or a workspace; absent when the service cannot. */
  check?: WebPrecheckRunner;
};
const execute = promisify(execFile);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
/** Inspect only a projection emitted by the worker, never accept arbitrary checkpoint objects. */
export function isWebObservation(value: unknown): value is WebObservation {
  if (!object(value) || value.schema !== 'theorem-os.web-observation.v1' ||
      value.evidence !== 'recorded-not-replayed' || value.acceptance !== 'not-assessed' ||
      typeof value.webRunId !== 'string' || typeof value.solverRunId !== 'string' ||
      typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt)) ||
      !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1 ||
      !object(value.inspection) || !object(value.snapshot) ||
      value.snapshot.runId !== value.solverRunId || value.inspection.runId !== value.solverRunId ||
      !/^[a-f0-9]{64}$/u.test(String(value.snapshot.stateDigest)) ||
      !Array.isArray(value.inspection.tasks) || !Array.isArray(value.inspection.workers) ||
      !Array.isArray(value.sources) || !Array.isArray(value.checks) || !Array.isArray(value.guidance) ||
      !object(value.coverage)) return false;
  return value.sources.every(source => object(source) && source.scope === 'owned-file' &&
    ['taskId', 'taskVersion', 'commit', 'sourceDigest', 'environmentDigest', 'file', 'source'].every(field => typeof source[field] === 'string')) &&
    value.checks.every(check => object(check) && object(check.record) &&
      ['id', 'taskId', 'taskVersion', 'commit', 'sourceDigest', 'environmentDigest'].every(field => typeof check[field] === 'string'));
}
const workerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('progress'), event: z.string().min(1).max(100), message: z.string().max(2_000),
    details: z.custom<WebEventDetails>(isWebEventDetails).optional() }).strict(),
  z.object({ type: z.literal('error'), message: z.string().min(1).max(2_000),
    failure: z.object({ kind: z.enum(webFailureKinds), reason: z.string().regex(webFailureReason).optional() }).strict().optional() }).strict(),
  z.object({ type: z.literal('artifact'), artifact: z.object({
    source: z.string().min(1).max(webArtifactMaxBytes).refine(value => Buffer.byteLength(value) <= webArtifactMaxBytes),
    workerId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    capturedAt: z.string().datetime(), status: z.literal('candidate'),
  }).strict() }).strict(),
  z.object({ type: z.literal('result'), result: z.object({ status: z.string().min(1).max(100),
    proof: z.string().max(128 * 1024), report: z.record(z.unknown()) }).strict() }).strict(),
]);

export function parseWorkerMessage(line: string): WorkerMessage | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (object(value) && value.type === 'observation' && Object.keys(value).length === 2 && isWebObservation(value.observation))
      return { type: 'observation', observation: value.observation };
    if (object(value) && value.type === 'catalog' && Object.keys(value).length === 2)
      return { type: 'catalog', catalog: validateTheoremKnowledge(value.catalog) };
    const message = workerMessageSchema.safeParse(value);
    return message.success ? message.data as WorkerMessage : undefined;
  } catch { return undefined; }
}

export class DockerWebRunner implements WebRunner {
  private cached?: { at: number; result: { ready: boolean; message: string } };
  private active = new Set<string>();
  constructor(private readonly config: Pick<WebConfig, 'workerImage'>) {}

  async command(id: string, command: WebCommand): Promise<WebCommandResult> {
    if (!this.active.has(id)) throw new Error('运行环境尚未就绪或已结束。');
    return new Promise((resolve, reject) => {
      const child = spawn('docker', ['exec', '--interactive', `theoremos-web-${id}`,
        'bun', 'apps/web/worker-command.ts'], { stdio: ['pipe', 'pipe', 'ignore'] });
      let output = '', settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) { child.kill('SIGKILL'); reject(error); return; }
        try {
          const value: unknown = JSON.parse(output);
          if (!object(value) || typeof value.id !== 'string' || typeof value.status !== 'string') throw new Error();
          if (value.observation && !isWebObservation(value.observation)) throw new Error();
          if (value.catalog) validateTheoremKnowledge(value.catalog);
          resolve(value as WebCommandResult);
        } catch { reject(new Error('运行环境未返回有效命令回执。')); }
      };
      const timer = setTimeout(() => finish(new Error('命令回执超时，请先查询当前回执再重试。')), 15_000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        output += chunk;
        if (Buffer.byteLength(output) > 32 * 1024 * 1024) finish(new Error('命令回执超出传输限制。'));
      });
      child.once('error', () => finish(new Error('无法向运行环境投递命令。')));
      child.once('close', code => finish(code ? new Error('运行环境拒绝了命令。') : undefined));
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(command) + '\n');
    });
  }

  /**
   * Compiles the statement as one file in a throwaway container: no network, no workspace, read-only image, a few
   * seconds of CPU. The source travels over stdin. Mathlib checks read the image's prebuilt packages directly.
   */
  check: WebPrecheckRunner = async ({ environment, source }, signal) => {
    signal.throwIfAborted();
    const name = `theoremos-check-${crypto.randomUUID()}`;
    const mathlib = environment === 'mathlib';
    const memory = mathlib ? '6g' : '2g';
    const script = 'cat > /tmp/Submission.lean && ' + (mathlib
      ? 'LP=; for d in /opt/theoremos-mathlib/.lake/packages/*/.lake/build/lib/lean; do LP="$LP:$d"; done; LEAN_PATH="${LP#:}" '
      : '') + 'exec lean --json /tmp/Submission.lean';
    const remove = () => execute('docker', ['rm', '--force', name], { timeout: 15_000 }).then(() => {}, () => {});
    try {
      await execute('docker', ['create', '--interactive', '--pull=never', '--name', name, '--network=none', '--log-driver=none',
        '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--cpus=2', `--memory=${memory}`, `--memory-swap=${memory}`,
        '--pids-limit=128', '--ulimit', 'nofile=1024:1024', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16777216,mode=1777',
        '--entrypoint', 'sh', this.config.workerImage, '-c', script], { timeout: 30_000, maxBuffer: 8_192 });
    } catch (error) { await remove(); throw error; }
    try {
      return await new Promise<WebPrecheckOutput>((resolve, reject) => {
        const child = spawn('docker', ['start', '--attach', '--interactive', name], { stdio: ['pipe', 'pipe', 'ignore'] });
        let output = '', timedOut = false, settled = false;
        const finish = (result?: WebPrecheckOutput, error?: unknown) => {
          if (settled) return;
          settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
          if (result) resolve(result); else reject(error);
        };
        const abort = () => { child.kill('SIGKILL'); finish(undefined, signal.reason); };
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, (mathlib ? 90 : 30) * 1_000);
        signal.addEventListener('abort', abort, { once: true });
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => {
          output += chunk;
          // `#eval` can print without bound; what came before the limit still describes the statement.
          if (output.length > 1024 * 1024) child.kill('SIGKILL');
        });
        child.stdin.on('error', () => {});
        child.once('error', error => finish(undefined, error));
        child.once('close', code => finish({ output, exitCode: code, timedOut }));
        child.stdin.end(source);
      });
    } finally { await remove(); }
  };

  async readiness() {
    if (this.cached && Date.now() - this.cached.at < 10_000) return this.cached.result;
    const ready = await new Promise<boolean>(resolve => {
      const child = spawn('docker', ['image', 'inspect', this.config.workerImage], { stdio: 'ignore' });
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(false); }, 5_000);
      child.once('error', () => { clearTimeout(timer); resolve(false); });
      child.once('close', code => { clearTimeout(timer); resolve(code === 0); });
    });
    const result = { ready, message: ready ? '运行环境就绪' : '运行镜像尚未就绪，请先构建 theorem-os-worker 镜像。' };
    this.cached = { at: Date.now(), result };
    return result;
  }

  async run(input: WorkerInput, onMessage: (message: WorkerMessage) => void, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const name = `theoremos-web-${input.id}`;
    const environment = input.input.environment ?? 'standard';
    const mathlib = environment === 'mathlib';
    const memory = mathlib ? '8g' : '4g';
    const args = ['create', '--interactive', '--pull=never', '--name', name,
      '--add-host=host.docker.internal:host-gateway',
      '--log-driver=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--security-opt=seccomp=unconfined', '--security-opt=apparmor=unconfined',
      '--security-opt=systempaths=unconfined',
      '--cpus=2', `--memory=${memory}`, `--memory-swap=${memory}`, '--pids-limit=256',
      '--tmpfs', '/work:rw,nosuid,nodev,size=536870912,uid=10001,gid=10001,mode=0700',
      '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=134217728,mode=1777',
      '--ulimit', 'nofile=1024:1024',
      ...(mathlib ? ['--device=/dev/fuse:/dev/fuse:rw', '--mount', 'type=volume,destination=/var/tmp'] : []),
      this.config.workerImage, environment];
    // Create first so cancellation always has a known container to remove.
    try {
      await execute('docker', args, { timeout: 30_000, maxBuffer: 8_192 });
    } catch {
      await execute('docker', ['rm', '--force', '--volumes', name], { timeout: 15_000 }).catch(() => {});
      throw new Error('无法创建隔离运行环境，请检查 Docker 与 worker 镜像。');
    }
    if (signal.aborted) {
      await execute('docker', ['rm', '--force', '--volumes', name], { timeout: 15_000 }).catch(() => {});
      signal.throwIfAborted();
    }
    try { await new Promise<void>((resolve, reject) => {
      const child = spawn('docker', ['start', '--attach', '--interactive', name], { stdio: ['pipe', 'pipe', 'ignore'] });
      this.active.add(input.id);
      let buffer = '', finished = false, receivedResult = false;
      let stopping: Promise<void> | undefined;
      const stop = () => stopping ??= (async () => {
        // Capture the actual saved checkpoint and source evidence before deleting the container.
        try {
          const captured = await this.command(input.id, { type: 'capture' });
          if (captured.observation) onMessage({ type: 'observation', observation: captured.observation });
          if (captured.catalog) onMessage({ type: 'catalog', catalog: captured.catalog });
        } catch { /* A run cancelled during bootstrap may not have a checkpoint yet. */ }
        await new Promise<void>(done => {
        const cleanup = spawn('docker', ['rm', '--force', '--volumes', name], { stdio: 'ignore' });
        const timer = setTimeout(() => { cleanup.kill('SIGKILL'); child.kill('SIGKILL'); done(); }, 15_000);
        const complete = () => { clearTimeout(timer); child.kill('SIGTERM'); done(); };
        cleanup.once('error', complete); cleanup.once('close', complete);
        });
      })();
      const abort = () => { void stop(); };
      const timer = setTimeout(abort, (input.input.maxRunSeconds + (mathlib ? 600 : 0) + 240) * 1_000);
      signal.addEventListener('abort', abort, { once: true });
      const finish = async (error?: Error) => {
        if (finished) return;
        finished = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
        if (error || signal.aborted) await stop();
        await stopping;
        if (error) reject(error); else resolve();
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) { void finish(new Error('运行输出超出限制。')); return; }
        for (;;) {
          const newline = buffer.indexOf('\n');
          if (newline < 0) break;
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          const message = parseWorkerMessage(line);
          if (message) {
            if (message.type === 'result') receivedResult = true;
            onMessage(message);
          }
        }
      });
      child.stdin.on('error', () => {});
      child.once('error', () => { void finish(new Error('无法启动隔离运行环境。')); });
      child.once('close', () => { void finish(!signal.aborted && !receivedResult ? new Error('运行环境已退出，未返回验收结果。') : undefined); });
      // Credentials travel over the private input pipe, never Docker args, env or logs.
      child.stdin.end(JSON.stringify(input) + '\n');
      if (signal.aborted) abort();
    }); } finally {
      this.active.delete(input.id);
      await execute('docker', ['rm', '--force', '--volumes', name], { timeout: 15_000 }).catch(() => {});
    }
  }
}
