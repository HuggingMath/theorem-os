import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { mathDigest } from './mathRuntimeIo';

/** Host-installed computation tools (CAS, SAT/SMT, ATP, optimisation) offered to solver shells. */
export const MATH_TOOLS_ROOT_ENV = 'DEEPSCIENTIST_MATH_TOOLS_ROOT';
export const MATH_TOOLS_SHA256_ENV = 'DEEPSCIENTIST_MATH_TOOLS_SHA256';
const MAX_MANIFEST_BYTES = 64_000;
// Pinned Lean, Git and shell entry points must never resolve to an optional tool wrapper.
const RESERVED = new Set(['lean', 'lake', 'elan', 'leanc', 'git', 'sh', 'bash', 'env', 'python', 'python3', 'node', 'bun', 'codex']);
const command = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/u).refine(value => !RESERVED.has(value));
const manifestSchema = z.object({
  schema: z.literal('theorem-os.math-tools.v1'),
  tools: z.array(z.object({
    name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,47}$/u),
    version: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,47}$/u),
    purpose: z.string().min(1).max(240).refine(value => !/[\r\n]/u.test(value)),
    commands: z.array(command).min(1).max(24),
  }).strict()).min(1).max(48),
}).strict();
export type MathTools = Readonly<{ root: string; digest: string; tools: z.infer<typeof manifestSchema>['tools'] }>;

/** `root/manifest.json` must name exactly the executables in `root/bin`; its digest binds the offered set. */
export function readMathTools(root: string): MathTools {
  if (!path.isAbsolute(root) || path.resolve(root) !== root) throw new Error('math_tools_root_invalid');
  const file = path.join(root, 'manifest.json');
  let bytes: Buffer;
  try { bytes = fs.readFileSync(file); } catch { throw new Error('math_tools_manifest_missing'); }
  if (bytes.length > MAX_MANIFEST_BYTES) throw new Error('math_tools_manifest_invalid');
  let parsed: z.infer<typeof manifestSchema>;
  try { parsed = manifestSchema.parse(JSON.parse(bytes.toString('utf8'))); } catch { throw new Error('math_tools_manifest_invalid'); }
  const commands = parsed.tools.flatMap(tool => tool.commands);
  if (new Set(commands).size !== commands.length || new Set(parsed.tools.map(tool => tool.name)).size !== parsed.tools.length)
    throw new Error('math_tools_manifest_invalid');
  const bin = path.join(root, 'bin');
  let present: string[];
  try { present = fs.readdirSync(bin); } catch { throw new Error('math_tools_bin_missing'); }
  const missing = commands.filter(name => {
    try { fs.accessSync(path.join(bin, name), fs.constants.X_OK); return !fs.statSync(path.join(bin, name)).isFile(); } catch { return true; }
  });
  if (missing.length) throw new Error(`math_tools_command_missing:${missing.slice(0, 8).join(',')}`);
  const unlisted = present.filter(name => !commands.includes(name));
  if (unlisted.length) throw new Error(`math_tools_command_unlisted:${unlisted.slice(0, 8).join(',')}`);
  return Object.freeze({ root, digest: mathDigest(bytes), tools: parsed.tools });
}

/** Per-worker tool state must keep the same anchor even when the shell changes directories. */
export function mathToolsUsageInstruction(tools: MathTools, worktree?: string): string {
  const commands = new Set(tools.tools.flatMap(tool => tool.commands));
  const runDir = path.join(worktree ?? '/ABSOLUTE_WORKER_WORKTREE', '.scratch/reference-search');
  const quotedRunDir = "'" + runDir.replaceAll("'", "'\\''") + "'";
  return (commands.has('math-python')
    ? 'Use math-python for the installed NumPy, SciPy, SymPy and PySAT dependencies; /usr/bin/python3 is suitable for standard-library-only scripts. A missing module in system Python does not mean the mathematics environment lacks it.\n' : '') +
    (commands.has('reference-search')
      ? `Keep reference-search state under this worker's fixed absolute directory: reference-search --run-dir ${quotedRunDir} search 'QUERY' --limit 6, then reference-search --run-dir ${quotedRunDir} read REF-0123456789ABCDEF --term 'KEYWORD' --window 650. Replace the example REF id with a returned id. Reuse the identical --run-dir for every stateful command, including after cd; follow the returned read handles and command help for arguments.\n` : '') +
    'For check-lean JSON, save stdout separately from stderr progress (for example, > "$TMPDIR/check.json" 2> "$TMPDIR/check.log") and parse only stdout. Its --file is relative to --workspace; do not repeat the Lean project prefix.\n';
}

/** Worker guidance: tools explore and find certificates; only Lean grants acceptance. */
export function mathToolsInstruction(tools: MathTools, worktree?: string): string {
  return `Installed mathematics tools (on PATH, manifest ${path.join(tools.root, 'manifest.json')}):\n` +
    tools.tools.map(tool => `- ${tool.name} ${tool.version} [${tool.commands.join(', ')}]: ${tool.purpose}`).join('\n') +
    '\nUse them to compute examples, test conjectures, search counterexamples, simplify expressions and find certificates or witnesses. ' +
    'Run them from a directory under $TMPDIR after mkdir -p "$TMPDIR": some write output beside their input or in the current directory. ' +
    'Bound every run with timeout SECONDS and at most 4 threads, and keep printed output small. ' +
    'Their results are advisory and never proof acceptance: restate a useful finding as a Lean statement and prove it, using the computed certificate or witness where it helps. ' +
    'Record the command, input and decisive output in RESEARCH.md.\n' + mathToolsUsageInstruction(tools, worktree);
}
