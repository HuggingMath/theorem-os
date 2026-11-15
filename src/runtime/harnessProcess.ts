import fs from 'node:fs';
import path from 'node:path';
import { assertMathCanonicalPath, isMathPathWithin } from '../math/paths';
import type { MathAgentOptions } from './agentSession';

/** Native tool permissions do not constrain arbitrary shell children. Both CLI harnesses use this OS contract. */
export function prepareHarnessProcess(options: Pick<MathAgentOptions, 'workspace' | 'profile' | 'environment' | 'hiddenRoots'>,
  executable: string, arguments_: readonly string[]) {
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
