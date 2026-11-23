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
function referenceSearchUsage(tools: MathTools, worktree?: string): string {
  if (!tools.tools.some(tool => tool.commands.includes('reference-search'))) return '';
  const runDir = path.join(worktree ?? '/ABSOLUTE_WORKER_WORKTREE', '.scratch/reference-search');
  const quotedRunDir = "'" + runDir.replaceAll("'", "'\\''") + "'";
  return `Keep reference-search state under this worker's fixed absolute directory: reference-search --run-dir ${quotedRunDir} search 'QUERY' --limit 6, then reference-search --run-dir ${quotedRunDir} read REF-0123456789ABCDEF --term 'KEYWORD' --window 650. Replace the example REF id with a returned id. Reuse the identical --run-dir prefix for every stateful command, including after cd and for subcommand help. ` +
        'Reuse saved text with find REF --term \'KEYWORD\' --offset 0 or open REF --start-line 1 --count 80; continue returned next_offset or line handles to inspect the relevant proof and its limitations. ' +
        'For independent queries, use search-batch PLAN.json --workers 2 with {"searches":[{"query":"PUBLIC_MATHEMATICAL_QUERY","reason":"specific missing inference"}]}; dependent queries follow the newly read evidence. ' +
        'For a relevant paper, follow REF --direction references --limit 4 (or --direction citations) discovers additional unread leads. Read a useful lead before citing it. ' +
        'Provider errors are failed retrievals, not evidence that no paper or theorem exists. A partial search retains useful hits; read those hits and use the same search with --retry-failed only for failed provider requests. Use --refresh when new retrieval is needed. ' +
        'Search titles/snippets, abstract and page_text reads do not establish that the complete proof was read. Inspect content_scope; use read REF --refresh to retry a saved abstract when a full-text route is available, then save the source URL, locator, assumptions and exact consumer adaptation.\n';
}

export function mathToolsUsageInstruction(tools: MathTools, worktree?: string): string {
  return (tools.tools.some(tool => tool.commands.includes('math-python'))
    ? 'Use math-python for the installed NumPy, SciPy, SymPy and PySAT dependencies; /usr/bin/python3 is suitable for standard-library-only scripts. A missing module in system Python does not mean the mathematics environment lacks it.\n' : '') +
    referenceSearchUsage(tools, worktree) +
    'For check-lean JSON, save stdout separately from stderr progress (for example, > "$TMPDIR/check.json" 2> "$TMPDIR/check.log") and parse only stdout. Its --file is relative to --workspace; do not repeat the Lean project prefix.\n';
}

function mathToolsCatalog(tools: MathTools): string {
  return `Installed mathematics tools (on PATH, manifest ${path.join(tools.root, 'manifest.json')}):\n` +
    tools.tools.map(tool => `- ${tool.name} ${tool.version} [${tool.commands.join(', ')}]: ${tool.purpose}`).join('\n') +
    '\nUse them to compute examples, test conjectures, search counterexamples, simplify expressions and find certificates or witnesses. ' +
    'Run them from a directory under $TMPDIR after mkdir -p "$TMPDIR": some write output beside their input or in the current directory. ' +
    'Bound every run with timeout SECONDS and at most 4 threads, and keep printed output small. ' +
    'Their results are advisory and never proof acceptance: restate a useful finding as a Lean statement and prove it, using the computed certificate or witness where it helps. ' +
    'Record the command, input and decisive output in RESEARCH.md.\n';
}

/** Worker guidance: tools explore and find certificates; only Lean grants acceptance. */
export function mathToolsInstruction(tools: MathTools, worktree?: string): string {
  return mathToolsCatalog(tools) + mathToolsUsageInstruction(tools, worktree);
}

/** Short choices for a native team; complete manifest and runnable examples for its worktree help. */
export function mathToolGuide(tools: MathTools, worktree: string): { summary: string; detail: string } {
  const commands = new Set(tools.tools.flatMap(tool => tool.commands));
  const routes: string[] = [], examples: string[] = [];
  const python = tools.tools.find(tool => tool.commands.includes('math-python'));
  const bin = '"$' + MATH_TOOLS_ROOT_ENV + '/bin/';
  if (python && /\bsympy\b/iu.test(python.purpose)) {
    routes.push('Exact or symbolic calculation: use math-python for SymPy; python3 is the system interpreter.');
    examples.push('# Exact prime factors (prime: exponent)\ntimeout 20 ' + bin + 'math-python" -c \'from sympy import factorint; print(factorint(84))\'');
  } else if (python) routes.push('For the Python modules listed in this profile, use math-python; python3 is the system interpreter.');
  else if (commands.has('sage')) routes.push('Exact algebra: sage.');
  else if (commands.has('gp')) routes.push('Number-theoretic computations: gp.');

  const smt = ['z3', 'cvc5'].find(command => commands.has(command));
  if (smt) {
    routes.push(`To test a constraint or find a counterexample: ${smt}.`);
    examples.push('# Is there an integer strictly between zero and one? Expected: unsat.\n' +
      "printf '%s\\n' '(set-logic QF_LIA)' '(declare-const x Int)' '(assert (and (< 0 x) (< x 1)))' '(check-sat)' | timeout 20 " +
      bin + smt + '" ' + (smt === 'z3' ? '-in' : '--lang smt2'));
  }
  if (commands.has('loogle-search')) routes.push('To look for a Lean declaration by its type: loogle-search.');
  if (commands.has('visual-python')) routes.push('If a plot can reveal a boundary case or test a geometric guess: visual-python.');
  else if (commands.has('dot')) routes.push('If a diagram can clarify graph structure: dot.');
  const exampleText = examples.length ? '\nExamples (substitute the inputs for your question):\n```sh\n' + examples.join('\n\n') + '\n```\n' : '';
  return { summary: ['Optional math tools for this run.', ...routes].join(' '),
    detail: mathToolsCatalog(tools) + referenceSearchUsage(tools, worktree) + exampleText };
}
