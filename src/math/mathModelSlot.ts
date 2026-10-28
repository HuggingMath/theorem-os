import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';

/**
 * Host-side admission control for model sessions.
 *
 * A gateway account pool serves a fixed number of concurrent model turns, and
 * formalization cases run as separate processes, so an in-process limiter
 * cannot coordinate them. Slots are therefore exclusive flocks on per-slot
 * files, using the same inherited-descriptor technique as
 * `withMathRuntimeLease`: the lock belongs to this process's open file
 * description, so it is released by the explicit `release()` and, on an
 * abnormal exit, by the kernel.
 *
 * Both keys are host configuration read directly from process.env, like
 * DEEPSCIENTIST_MATH_VERIFIER_CONCURRENCY, and stay outside every frozen
 * environment projection. Admission control is disabled unless
 * DEEPSCIENTIST_MATH_MODEL_SLOTS names a positive capacity.
 */
export const MODEL_SLOTS_KEY = 'DEEPSCIENTIST_MATH_MODEL_SLOTS';
export const MODEL_SLOT_DIRECTORY_KEY = 'DEEPSCIENTIST_MATH_MODEL_SLOT_DIRECTORY';
const SLOT_FLOCK = '/usr/bin/flock';
const SLOT_POLL_MS = 250;

export type MathModelSlotConfiguration = Readonly<{ capacity: number; directory: string }>;
export type MathModelSlot = Readonly<{ index: number; release: () => Promise<void> }>;

/** Undefined when admission control is unconfigured; malformed host settings fail closed. */
export function configuredMathModelSlots(env: NodeJS.ProcessEnv = process.env): MathModelSlotConfiguration | undefined {
  const raw = (env[MODEL_SLOTS_KEY] ?? '').trim();
  if (!raw) return undefined;
  if (!/^\d+$/u.test(raw)) throw new Error('math_model_slots_invalid');
  const capacity = Number.parseInt(raw, 10);
  if (capacity === 0) return undefined;
  const directory = (env[MODEL_SLOT_DIRECTORY_KEY] ?? '').trim();
  if (!directory || !path.isAbsolute(directory) || path.resolve(directory) !== directory)
    throw new Error('math_model_slot_directory_invalid');
  return { capacity, directory };
}

/** Take one slot without waiting: undefined means another holder has it. */
async function tryTakeSlot(directory: string, index: number, signal?: AbortSignal): Promise<MathModelSlot | undefined> {
  const file = path.join(directory, 'slot-' + index + '.lock');
  const descriptor = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
  const close = () => { try { fs.closeSync(descriptor); } catch { /* already closed */ } };
  const stat = fs.fstatSync(descriptor);
  if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) {
    close(); throw new Error('math_model_slot_integrity');
  }
  const held = await new Promise<boolean>((resolve, reject) => {
    const child = spawn(SLOT_FLOCK, ['--exclusive', '--nonblock', '--conflict-exit-code', '73', '3'],
      { stdio: ['ignore', 'ignore', 'ignore', descriptor], windowsHide: true });
    let failed = false;
    const abort = () => { child.kill('SIGKILL'); };
    signal?.addEventListener('abort', abort, { once: true });
    child.once('error', () => { failed = true; });
    child.once('close', code => {
      signal?.removeEventListener('abort', abort);
      if (failed) reject(new Error('math_model_slot_unavailable'));
      else if (signal?.aborted) resolve(false);
      else if (code === 0) resolve(true);
      else if (code === 73) resolve(false);
      else reject(new Error('math_model_slot_unavailable'));
    });
  }).catch(error => { close(); throw error; });
  if (!held) { close(); return undefined; }
  let released = false;
  return { index, release: async () => { if (!released) { released = true; close(); } } };
}

/**
 * Wait for any free host slot and hold it until `release()`. Polling is used
 * because flock exposes no "wait for any of n"; the probe interval is short
 * relative to a role session, so a freed slot is reused promptly.
 */
export async function acquireMathModelSlot(configuration: MathModelSlotConfiguration,
  options: Readonly<{ signal?: AbortSignal; wait?: (delayMs: number, signal?: AbortSignal) => Promise<void> }> = {}): Promise<MathModelSlot> {
  if (process.platform !== 'linux') throw new Error('math_model_slots_require_linux');
  const { signal } = options, waitFor = options.wait ?? ((delayMs: number, signal?: AbortSignal) => wait(delayMs, undefined, { signal }));
  fs.mkdirSync(configuration.directory, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(configuration.directory).isDirectory() || fs.realpathSync(configuration.directory) !== configuration.directory)
    throw new Error('math_model_slot_directory_invalid');
  const start = Math.floor(Math.random() * configuration.capacity);
  for (let round = 0; ; round++) {
    signal?.throwIfAborted();
    for (let step = 0; step < configuration.capacity; step++) {
      const slot = await tryTakeSlot(configuration.directory, (start + round + step) % configuration.capacity, signal);
      if (slot) return slot;
    }
    await waitFor(SLOT_POLL_MS + Math.floor(Math.random() * SLOT_POLL_MS), signal);
  }
}
