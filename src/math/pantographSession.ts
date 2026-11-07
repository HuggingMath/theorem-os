import fs from 'node:fs';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import { mathBuildFile } from './mathBuildManifest';
import { canonicalMathJson, mathDigest, readMathFile } from './mathRuntimeIo';
import { assertMathCanonicalPath } from './paths';
import { closeMathProcess, limitMathOutput, runLeanProcess } from './mathProcess';
import { scheduleMathTimeout } from './mathTimers';
import { acquireMathProofEnvironmentLease, MATH_PROOF_ENVIRONMENT_SANDBOX_ENV } from './mathProofEnvironment';

export const PANTOGRAPH_MANIFEST_ENV = 'DEEPSCIENTIST_MATH_PANTOGRAPH_MANIFEST';
export const PANTOGRAPH_DIGEST_ENV = 'DEEPSCIENTIST_MATH_PANTOGRAPH_SHA256';
export const PANTOGRAPH_SOURCE_COMMIT = '0ee70917fb93a5421157119362ecde806a4d881b';
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const relative = z.string().min(1).max(4096).refine(value => !path.isAbsolute(value) &&
  !value.includes('\\') && !value.includes('\0') && value.split('/').every(part => part && part !== '.' && part !== '..'));
const manifestSchema = z.object({
  schema: z.literal('theorem-os.pantograph-backend.v1'), sourceCommit: z.literal(PANTOGRAPH_SOURCE_COMMIT),
  toolchain: z.enum(['leanprover/lean4:v4.33.0', 'leanprover/lean4:v4.33.1']), executable: relative,
  libraryDirectories: z.array(relative).max(16),
  files: z.array(z.object({ path: relative, sha256: hash }).strict()).min(1).max(16384),
}).strict();

/** The explicit artifact manifest joins the frozen run identity; no backend is downloaded or upgraded here. */
export function readPantographBackend(env: NodeJS.ProcessEnv) {
  const file = env[PANTOGRAPH_MANIFEST_ENV];
  if (!file) return undefined;
  if (!path.isAbsolute(file)) throw new Error('proof_search_backend_manifest_absolute_path_required');
  assertMathCanonicalPath(file);
  const bytes = readMathFile(file, 4_000_000).bytes;
  const manifest = manifestSchema.parse(JSON.parse(bytes.toString('utf8'))), root = path.dirname(file);
  const names = new Set(manifest.files.map(item => item.path));
  if (names.size !== manifest.files.length || !names.has(manifest.executable)) throw new Error('proof_search_backend_files_invalid');
  // Hash every packaged artifact, including shared libraries and oleans. Paths cannot escape the bundle.
  const verify = () => {
    if (mathDigest(readMathFile(file, 4_000_000).bytes) !== mathDigest(bytes)) throw new Error('proof_search_backend_changed');
    for (const entry of manifest.files)
      if (mathBuildFile(path.join(root, entry.path)).sha256 !== entry.sha256) throw new Error('proof_search_backend_changed');
    for (const directory of manifest.libraryDirectories) {
      const pending = [directory];
      while (pending.length) {
        const relativeDirectory = pending.pop()!, absolute = path.join(root, relativeDirectory);
        assertMathCanonicalPath(absolute);
        for (const child of fs.readdirSync(absolute, { withFileTypes: true })) {
          const name = `${relativeDirectory}/${child.name}`;
          if (child.isDirectory()) pending.push(name);
          else if (!child.isFile() || !names.has(name)) throw new Error('proof_search_backend_unlisted_artifact');
        }
      }
    }
  };
  verify();
  const digest = mathDigest(canonicalMathJson({ manifestDigest: mathDigest(bytes), manifest }));
  if (env[PANTOGRAPH_DIGEST_ENV] && env[PANTOGRAPH_DIGEST_ENV] !== digest) throw new Error('proof_search_backend_identity_changed');
  return { digest, toolchain: manifest.toolchain, executable: path.join(root, manifest.executable),
    libraryDirectories: manifest.libraryDirectories.map(directory => path.join(root, directory)), verify };
}
export type PantographBackend = NonNullable<ReturnType<typeof readPantographBackend>>;
export type ProofStateView = { root?: unknown; goals: unknown[]; rootHasSorry: boolean; rootHasUnsafe: boolean; rootHasMVar: boolean };
export interface ProofSearchSession {
  request(command: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

/** One newline-delimited request at a time. Process IDs and Lean state IDs never leave this session. */
export async function openPantographSession(input: {
  project: string; backend: PantographBackend; env: NodeJS.ProcessEnv; signal: AbortSignal; deadlineAt: number;
}): Promise<ProofSearchSession> {
  if (!input.env[MATH_PROOF_ENVIRONMENT_SANDBOX_ENV]) throw new Error('proof_search_requires_isolated_worker');
  const lease = await acquireMathProofEnvironmentLease(input.project, input.env, input.signal, input.deadlineAt);
  if (!lease) throw new Error('proof_search_worker_environment_missing');
  const controller = new AbortController(), signal = AbortSignal.any([input.signal, controller.signal]);
  const cancelDeadline = scheduleMathTimeout(() => controller.abort(new Error('proof_search_deadline')),
    Math.max(0, input.deadlineAt - Date.now()));
  let child: ChildProcess | undefined;
  let processDone: Promise<unknown> | undefined, closing: Promise<void> | undefined;
  let failure: Error | undefined, ready = false, closed = false, pending: {
    resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void;
  } | undefined;
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  const started = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const fail = (error: Error) => { failure ??= error; readyReject(error); pending?.reject(error); pending = undefined; };
  const close = (): Promise<void> => {
    if (closing) return closing;
    closed = true;
    fail(new Error('proof_search_session_closed'));
    cancelDeadline();
    signal.removeEventListener('abort', abort);
    closing = (async () => {
      // Duplex processes have no runMathProcess timer; abort also installs its finite kill fallback.
      controller.abort();
      try { if (child) await closeMathProcess(child, false, 100); if (processDone) await processDone; }
      finally { await lease.release(); }
    })();
    return closing;
  };
  const abort = () => {
    fail(signal.reason instanceof Error ? signal.reason : new Error('proof_search_cancelled'));
    if (!closed) void close().catch(() => {});
  };
  try {
    signal.throwIfAborted();
    signal.addEventListener('abort', abort, { once: true });
    input.backend.verify();
    const libraries = [path.join(input.project, '.lake/build/lib/lean'), ...input.backend.libraryDirectories,
      ...fs.readdirSync(lease.packagesRoot).map(name => path.join(lease.packagesRoot, name, '.lake/build/lib/lean'))]
      .filter(directory => fs.existsSync(directory));
    if (Date.now() >= input.deadlineAt) throw new Error('proof_search_deadline');
    signal.throwIfAborted();
    processDone = runLeanProcess(input.backend.executable, [], {
      cwd: input.project, env: { ...input.env, LEAN_PATH: libraries.join(path.delimiter), LEAN_NUM_THREADS: '1' },
      signal, timeoutMs: Math.max(0, input.deadlineAt - Date.now()), stopGraceMs: 0,
      onDuplexSpawn(process) {
        child = process;
        process.once('error', error => fail(error));
        process.once('close', () => fail(new Error('proof_search_backend_closed')));
        process.stdout!.on('data', (bytes: Buffer) => {
          if (failure) return;
          buffer += decoder.write(bytes);
          if (Buffer.byteLength(buffer) > 4_000_000) {
            fail(new Error('proof_search_protocol_output_limit')); void close().catch(() => {}); return;
          }
          for (;;) {
            const newline = buffer.indexOf('\n'); if (newline < 0) break;
            const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
            if (!ready && line === 'ready.') { ready = true; readyResolve(); continue; }
            try {
              const value = JSON.parse(line);
              if (!ready || !pending || !value || typeof value !== 'object' || Array.isArray(value))
                throw new Error('proof_search_protocol_unexpected_response');
              const waiter = pending; pending = undefined;
              if (value.error) waiter.reject(new Error(`proof_search_backend_error: ${limitMathOutput(String(value.desc ?? value.error), 2000, 'head')}`));
              else waiter.resolve(value);
            } catch (error) {
              fail(error instanceof Error ? error : new Error('proof_search_protocol_invalid'));
              void close().catch(() => {}); return;
            }
          }
        });
      },
    });
    void processDone.then(() => fail(new Error('proof_search_backend_closed')), error => fail(error));
    await started;
    if (failure) throw failure;
    return { close, request(command, payload) {
      if (failure || closed || signal.aborted) return Promise.reject(failure ?? new Error('proof_search_session_closed'));
      if (pending) return Promise.reject(new Error('proof_search_concurrent_request'));
      let request: string;
      try { request = JSON.stringify({ cmd: command, payload }) + '\n'; }
      catch (error) { return Promise.reject(error); }
      return new Promise((resolve, reject) => {
        pending = { resolve, reject };
        try { child!.stdin!.write(request, error => { if (error) { fail(error); void close().catch(() => {}); } }); }
        catch (error) {
          fail(error instanceof Error ? error : new Error('proof_search_protocol_write_failed'));
          void close().catch(() => {});
        }
      });
    } };
  } catch (error) {
    // Preparation can fail before the readiness promise is awaited.
    void started.catch(() => {});
    await close(); throw error;
  }
}
