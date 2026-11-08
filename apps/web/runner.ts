import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { WebConfig } from './config';
import type { WorkerExplanationInput, WorkerExplanationMessage, WorkerInput, WorkerMessage } from './shared';
import { webArtifactMaxBytes, webExplanationPhases, webExplanationReason, webFailureKinds, webFailureReason } from './shared';
import { isWebEventDetails } from './moduleTelemetry';
import { isWebAgentActionBody } from './agentActions';
import { isWebFormalizationActivityBody } from './formalizationActivityValidation';
import type { WebEventDetails } from './shared';
import type { WebCommand, WebCommandResult, WebObservation } from './collaboration';
import type { WebPrecheckOutput, WebPrecheckRunner } from './precheck';
import { validateTheoremKnowledge } from '../../src/solver/theoremKnowledge';
import { webFormalizationPhases, webFormalizationReason, type WorkerFormalizationInput,
  type WorkerFormalizationMessage } from './formalizationTypes';

export type WebRunner = {
  readiness(): Promise<{ ready: boolean; message: string }>;
  run(input: WorkerInput, onMessage: (message: WorkerMessage) => void, signal: AbortSignal): Promise<void>;
  command?(id: string, command: WebCommand): Promise<WebCommandResult>;
  /** Compiles a statement on its own, without a model or a workspace; absent when the service cannot. */
  check?: WebPrecheckRunner;
  /** Writes and audits a proof explanation in its own container; absent when the service cannot. */
  explain?(input: WorkerExplanationInput, onMessage: (message: WorkerExplanationMessage) => void, signal: AbortSignal): Promise<void>;
  /** Formalizes and independently reviews an original problem; confirmation belongs to the workbench. */
  formalize?(input: WorkerFormalizationInput, onMessage: (message: WorkerFormalizationMessage) => void, signal: AbortSignal): Promise<void>;
};
const execute = promisify(execFile);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
/**
 * The worker image's own code and build state. A statement check needs only Lean and the prebuilt Mathlib, and its
 * `#eval` can read any file it sees and throw the text back as an error the editor shows, so these are covered.
 */
export const webPrivateImagePaths = ['/opt/theorem-os', '/opt/runtime-state'] as const;
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
    if (object(value) && value.type === 'action')
      return Object.keys(value).length === 2 && isWebAgentActionBody(value.action) ? { type: 'action', action: value.action } : undefined;
    const message = workerMessageSchema.safeParse(value);
    return message.success ? message.data as WorkerMessage : undefined;
  } catch { return undefined; }
}

const count = z.number().int().nonnegative().max(1e12);
const explanationMessageSchema = z.union([
  z.object({ type: z.literal('progress'), progress: z.object({ phase: z.enum(webExplanationPhases), batches: count.optional(),
    approvedBatches: count.optional(), round: count.optional(), tokens: count.optional() }).strict() }).strict(),
  // The server re-derives every check from the evidence; here it only has to be an object.
  z.object({ type: z.literal('result'), status: z.literal('approved'), evidence: z.record(z.unknown()) }).strict(),
  z.object({ type: z.literal('result'), status: z.enum(['exhausted', 'error']), reason: z.string().regex(webExplanationReason) }).strict(),
]);
export function parseExplanationMessage(line: string): WorkerExplanationMessage | undefined {
  try {
    const message = explanationMessageSchema.safeParse(JSON.parse(line));
    return message.success ? message.data as WorkerExplanationMessage : undefined;
  } catch { return undefined; }
}

const formalizationMessageSchema = z.union([
  z.object({ type: z.literal('progress'), progress: z.object({ phase: z.enum(webFormalizationPhases),
    round: count.optional(), tokens: count.optional() }).strict() }).strict(),
  z.object({ type: z.literal('activity'), activity: z.custom(isWebFormalizationActivityBody) }).strict(),
  z.object({ type: z.literal('result'), status: z.literal('approved'), evidence: z.record(z.unknown()) }).strict(),
  z.object({ type: z.literal('result'), status: z.enum(['exhausted', 'error']), reason: z.string().regex(webFormalizationReason) }).strict(),
]);
export function parseFormalizationMessage(line: string): WorkerFormalizationMessage | undefined {
  try {
    const message = formalizationMessageSchema.safeParse(JSON.parse(line));
    return message.success ? message.data as WorkerFormalizationMessage : undefined;
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
      ? 'LP=/opt/theoremos-library/.lake/build/lib/lean; for d in /opt/theoremos-mathlib/.lake/packages/*/.lake/build/lib/lean; do LP="$LP:$d"; done; LEAN_PATH="$LP" '
      : '') + 'exec lean --json /tmp/Submission.lean';
    const remove = () => execute('docker', ['rm', '--force', name], { timeout: 15_000 }).then(() => {}, () => {});
    try {
      await execute('docker', ['create', '--interactive', '--pull=never', '--name', name, '--network=none', '--log-driver=none',
        '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--cpus=2', `--memory=${memory}`, `--memory-swap=${memory}`,
        '--pids-limit=128', '--ulimit', 'nofile=1024:1024', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16777216,mode=1777',
        ...webPrivateImagePaths.flatMap(hidden => ['--tmpfs', `${hidden}:ro,noexec,nosuid,nodev,size=4096,mode=0555`]),
        '--entrypoint', 'sh', this.config.workerImage, '-c', script], { timeout: 30_000, maxBuffer: 8_192 });
    } catch (error) { await remove(); throw error; }
    try {
      signal.throwIfAborted();
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

  /**
   * One container per explanation, built like a run: the proof and key travel over stdin, model calls go to the host
   * gateway, and the disk volume holds the pinned environment while roles compile. Errors are reason codes only.
   */
  async explain(input: WorkerExplanationInput, onMessage: (message: WorkerExplanationMessage) => void, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const name = `theoremos-explain-${input.id}`, mathlib = input.environment === 'mathlib';
    const memory = mathlib ? '12g' : '4g';
    const remove = () => execute('docker', ['rm', '--force', '--volumes', name], { timeout: 15_000 }).then(() => {}, () => {});
    try {
      await execute('docker', ['create', '--interactive', '--pull=never', '--name', name,
        '--add-host=host.docker.internal:host-gateway',
        '--log-driver=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
        '--security-opt=seccomp=unconfined', '--security-opt=apparmor=unconfined', '--security-opt=systempaths=unconfined',
        '--cpus=2', `--memory=${memory}`, `--memory-swap=${memory}`, '--pids-limit=512',
        '--tmpfs', '/work:rw,nosuid,nodev,size=67108864,uid=10001,gid=10001,mode=0700',
        '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=134217728,mode=1777',
        '--ulimit', 'nofile=4096:4096', '--mount', 'type=volume,destination=/var/tmp',
        ...(mathlib ? ['--device=/dev/fuse:/dev/fuse:rw'] : []),
        this.config.workerImage, input.environment, 'explain'], { timeout: 30_000, maxBuffer: 8_192 });
    } catch { await remove(); throw new Error('explanation_container_failed'); }
    try {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const child = spawn('docker', ['start', '--attach', '--interactive', name], { stdio: ['pipe', 'pipe', 'ignore'] });
        let buffer = '', finished = false, received = false;
        const finish = (error?: Error) => {
          if (finished) return;
          finished = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
          if (error) { child.kill('SIGKILL'); reject(error); } else resolve();
        };
        const abort = () => finish(new Error('explanation_cancelled'));
        const timer = setTimeout(() => finish(new Error('explanation_timeout')), (input.maxRunSeconds + (mathlib ? 1_200 : 600)) * 1_000);
        signal.addEventListener('abort', abort, { once: true });
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => {
          buffer += chunk;
          for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
            const message = parseExplanationMessage(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
            if (message?.type === 'result') received = true;
            if (message && !finished) onMessage(message);
          }
          if (buffer.length > 32 * 1024 * 1024) finish(new Error('explanation_output_too_large'));
        });
        child.stdin.on('error', () => {});
        child.once('error', () => finish(new Error('explanation_container_failed')));
        child.once('close', () => finish(received ? undefined : new Error('explanation_worker_exited')));
        // Credentials travel over the private input pipe, never Docker args, env or logs.
        child.stdin.end(JSON.stringify(input) + '\n');
      });
    } finally { await remove(); }
  }

  /** A private container for planning, Lean compilation, blind backtranslation and unanimous review. */
  async formalize(input: WorkerFormalizationInput, onMessage: (message: WorkerFormalizationMessage) => void, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const name = `theoremos-formalize-${input.id}`, mathlib = input.environment === 'mathlib';
    const memory = mathlib ? '12g' : '4g';
    const remove = () => execute('docker', ['rm', '--force', '--volumes', name], { timeout: 15_000 }).then(() => {}, () => {});
    try {
      await execute('docker', ['create', '--interactive', '--pull=never', '--name', name,
        '--add-host=host.docker.internal:host-gateway',
        '--log-driver=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
        '--security-opt=seccomp=unconfined', '--security-opt=apparmor=unconfined', '--security-opt=systempaths=unconfined',
        '--cpus=2', `--memory=${memory}`, `--memory-swap=${memory}`, '--pids-limit=512',
        '--tmpfs', '/work:rw,nosuid,nodev,size=67108864,uid=10001,gid=10001,mode=0700',
        '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=134217728,mode=1777',
        '--ulimit', 'nofile=4096:4096', '--mount', 'type=volume,destination=/var/tmp',
        ...(mathlib ? ['--device=/dev/fuse:/dev/fuse:rw'] : []),
        this.config.workerImage, input.environment, 'formalize'], { timeout: 30_000, maxBuffer: 8_192 });
    } catch { await remove(); throw new Error('formalization_container_failed'); }
    try {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const child = spawn('docker', ['start', '--attach', '--interactive', name], { stdio: ['pipe', 'pipe', 'ignore'] });
        let buffer = '', finished = false, received = false;
        const finish = (error?: Error) => {
          if (finished) return;
          finished = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
          if (error) { child.kill('SIGKILL'); reject(error); } else resolve();
        };
        const abort = () => finish(new Error('formalization_cancelled'));
        const timer = setTimeout(() => finish(new Error('formalization_timeout')), (input.maxRunSeconds + (mathlib ? 1_200 : 600)) * 1_000);
        signal.addEventListener('abort', abort, { once: true });
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => {
          buffer += chunk;
          for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
            const message = parseFormalizationMessage(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
            if (message?.type === 'result') received = true;
            if (message && !finished) onMessage(message);
          }
          if (buffer.length > 32 * 1024 * 1024) finish(new Error('formalization_output_too_large'));
        });
        child.stdin.on('error', () => {});
        child.once('error', () => finish(new Error('formalization_container_failed')));
        child.once('close', () => finish(received ? undefined : new Error('formalization_worker_exited')));
        // Credentials travel over the private input pipe, never Docker args, env or logs.
        child.stdin.end(JSON.stringify(input) + '\n');
      });
    } finally { await remove(); }
  }
}
