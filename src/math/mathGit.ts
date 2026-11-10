import { spawnSync } from 'node:child_process';

type GitOptions = { maxBuffer: number; timeout?: number; errorMessage?: string };

export type MathGitFailureDiagnostic = Readonly<{ command: string; exitCode: number | null;
  signal: NodeJS.Signals | null; code?: string; commit?: string; file?: string; stderr?: string }>;

/** Keep the public failure reason stable while retaining how the local Git read failed. */
export class MathGitError extends Error {
  constructor(message: string, readonly diagnostic: MathGitFailureDiagnostic, cause?: Error) {
    super(message, cause ? { cause } : undefined);
  }
}

/** Keep source bytes intact; callers own Git identity and tree-mode checks. */
export const mathGitResult = (root: string, args: readonly string[], options: GitOptions) =>
  spawnSync('git', ['-C', root, ...args], {
    maxBuffer: options.maxBuffer, timeout: options.timeout ?? 30_000,
  });

export function mathGitBytes(root: string, args: readonly string[], options: GitOptions): Buffer {
  const result = mathGitResult(root, args, options);
  if (result.error || result.status !== 0) {
    const command = args[0]?.startsWith('-') ? 'git' : args[0] ?? 'git';
    const object = command === 'show' ? /^([0-9a-f]{40,64}|HEAD):(.+)$/u.exec(args[1] ?? '') : undefined;
    // Only a source-object read names its argument. Other Git arguments and output can contain
    // user configuration or remote credentials, so they are not copied into structured events.
    const source = object ? { commit: object[1], file: object[2] } : undefined;
    const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
    const diagnostic: MathGitFailureDiagnostic = { command, exitCode: result.status, signal: result.signal,
      ...(code ? { code } : {}),
      ...(source ? { ...source, stderr: result.stderr?.subarray(0, 4096).toString('utf8').trim() ?? '' } : {}) };
    throw new MathGitError(options.errorMessage ?? (result.stderr?.toString('utf8').trim() || `git ${args.join(' ')} failed`),
      diagnostic, result.error);
  }
  return result.stdout;
}

export const mathGitText = (root: string, args: readonly string[], options: GitOptions): string =>
  mathGitBytes(root, args, options).toString('utf8').trim();
