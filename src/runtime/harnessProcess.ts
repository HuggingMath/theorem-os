import fs from 'node:fs';
import path from 'node:path';
import { assertMathCanonicalPath, isMathPathWithin } from '../math/paths';
import type { MathAgentOptions } from './agentSession';
import type { MathProcessStopReceipt } from '../math/mathProcess';

export type HarnessProcessIdentity = Readonly<{
  schema: 'theorem-os.harness-process-identity.v1';
  pid: number;
  startTime: string;
  bootId: string;
  pidNamespace: string;
}>;

function processStat(pid: number): { startTime: string; state: string } {
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
  if (!/^\d+$/u.test(fields[19] ?? '') || !/^[A-Za-z]$/u.test(fields[0] ?? ''))
    throw new Error('math_harness_process_identity_invalid');
  return { state: fields[0], startTime: fields[19] };
}

const processGone = (error: unknown) => ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code);

/** bwrap writes host PID and namespace metadata through a private parent pipe before exec. */
export function readHarnessProcessIdentity(info: Record<string, unknown>): HarnessProcessIdentity {
  const pid = info['child-pid'], namespace = info['pid-namespace'];
  if (!Number.isSafeInteger(pid) || Number(pid) <= 0 || !Number.isSafeInteger(namespace) || Number(namespace) <= 0)
    throw new Error('math_harness_process_identity_invalid');
  const pidNamespace = `pid:[${namespace}]`;
  if (fs.readlinkSync(`/proc/${pid}/ns/pid`) !== pidNamespace ||
      fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/^NSpid:\s+(.+)$/mu)?.[1].trim().split(/\s+/u).at(-1) !== '1')
    throw new Error('math_harness_process_identity_invalid');
  return { schema: 'theorem-os.harness-process-identity.v1', pid: Number(pid), startTime: processStat(Number(pid)).startTime,
    bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), pidNamespace };
}

/** Namespace init death kills its descendants before it exits, including detached background writers. */
export function confirmHarnessProcessStopped(identity: HarnessProcessIdentity): MathProcessStopReceipt {
  if (process.platform !== 'linux') return { status: 'unconfirmed', reason: 'unsupported-platform' };
  if (!identity || identity.schema !== 'theorem-os.harness-process-identity.v1' || !Number.isSafeInteger(identity.pid) ||
      identity.pid <= 0 || !/^\d+$/u.test(identity.startTime) || !/^[a-f0-9-]{36}$/u.test(identity.bootId) ||
      !/^pid:\[\d+\]$/u.test(identity.pidNamespace))
    return { status: 'unconfirmed', reason: 'process-identity-unavailable' };
  try {
    if (fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() !== identity.bootId) return { status: 'stopped' };
    let current: ReturnType<typeof processStat>;
    try { current = processStat(identity.pid); }
    catch (error) {
      if (processGone(error)) return { status: 'stopped' };
      throw error;
    }
    if (current.startTime !== identity.startTime || ['Z', 'X', 'x'].includes(current.state)) return { status: 'stopped' };
    let namespace: string;
    try { namespace = fs.readlinkSync(`/proc/${identity.pid}/ns/pid`); }
    catch (error) {
      if (processGone(error)) {
        // The process can exit after stat but before its namespace link is read.
        try { current = processStat(identity.pid); }
        catch (error) {
          if (processGone(error)) return { status: 'stopped' };
          throw error;
        }
        if (current.startTime !== identity.startTime || ['Z', 'X', 'x'].includes(current.state)) return { status: 'stopped' };
      }
      throw error;
    }
    if (namespace !== identity.pidNamespace)
      return { status: 'unconfirmed', reason: 'process-identity-unavailable' };
    return { status: 'unconfirmed', reason: 'process-group-active' };
  } catch { return { status: 'unconfirmed', reason: 'process-group-unavailable' }; }
}

/** Native tool permissions do not constrain arbitrary shell children. Both CLI harnesses use this OS contract. */
export function prepareHarnessProcess(options: Pick<MathAgentOptions, 'workspace' | 'profile' | 'environment' | 'hiddenRoots'>,
  executable: string, arguments_: readonly string[], infoDescriptor?: number) {
  if (process.platform !== 'linux' || !fs.existsSync('/usr/bin/bwrap'))
    throw new Error('math_harness_process_isolation_unavailable');
  for (const directory of [options.workspace, options.profile]) {
    assertMathCanonicalPath(directory);
    if (!fs.statSync(directory).isDirectory()) throw new Error('math_harness_directory_invalid');
  }
  if (isMathPathWithin(options.workspace, options.profile) || isMathPathWithin(options.profile, options.workspace))
    throw new Error('math_harness_profile_must_be_separate');
  const temporary = path.join(options.workspace, '.scratch', 'tmp');
  assertMathCanonicalPath(temporary);
  fs.mkdirSync(temporary, { recursive: true, mode: 0o700 });
  const env: NodeJS.ProcessEnv = { ...(options.environment ?? process.env), TMPDIR: temporary };
  for (const [key, name] of Object.entries({ XDG_CONFIG_HOME: 'config', XDG_DATA_HOME: 'data',
    XDG_STATE_HOME: 'state', XDG_CACHE_HOME: 'cache' })) {
    const directory = path.join(options.profile, 'xdg', name);
    assertMathCanonicalPath(directory);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    env[key] = directory;
  }
  const hidden: string[] = [];
  const socketRoots = ['/run', '/tmp'].filter(root =>
    ![options.workspace, options.profile].some(directory => isMathPathWithin(root, directory)));
  for (const root of [...socketRoots, ...(options.hiddenRoots ?? [])]) {
    assertMathCanonicalPath(root);
    // Mask the existing parent when the protected path has not been created yet.
    // The mount namespace can then never expose a later host-side creation there.
    let mask = root;
    while (!fs.existsSync(mask)) mask = path.dirname(mask);
    if (mask === '/' || [options.workspace, options.profile].some(directory => isMathPathWithin(mask, directory)))
      throw new Error('math_harness_hidden_root_conflict');
    if (!hidden.some(parent => isMathPathWithin(parent, mask))) hidden.push(mask);
  }
  const masks = hidden.filter(root => !hidden.some(parent => parent !== root && isMathPathWithin(parent, root)));
  const args = ['--die-with-parent', '--unshare-pid', '--unshare-ipc', '--new-session', '--cap-drop', 'ALL',
    '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev',
    '--bind', options.workspace, options.workspace, '--bind', options.profile, options.profile];
  if (infoDescriptor !== undefined) {
    if (!Number.isSafeInteger(infoDescriptor) || infoDescriptor < 3) throw new Error('math_harness_info_descriptor_invalid');
    args.push('--info-fd', String(infoDescriptor));
  }
  const lock = env.DEEPSCIENTIST_MATH_LEAN_LOCK;
  if (lock) {
    assertMathCanonicalPath(lock);
    if (!fs.statSync(lock).isFile() || masks.some(root => isMathPathWithin(root, lock)))
      throw new Error('math_harness_lean_lock_invalid');
    args.push('--bind', lock, lock);
  }
  for (const root of masks) args.push(...(fs.statSync(root).isDirectory() ? ['--tmpfs', root] : ['--ro-bind', '/dev/null', root]));
  args.push('--chdir', options.workspace, '--', executable, ...arguments_);
  return { command: '/usr/bin/bwrap', args, env,
    isolationReceipt: { schema: 'theorem-os.harness-process.v1', backend: 'bwrap',
      writableDirectories: [options.workspace, options.profile], hiddenRoots: masks,
      pidNamespace: true, network: 'inherited' } as Record<string, unknown> };
}
