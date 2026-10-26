import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { mathDigest, syncMathDirectory } from './mathRuntimeIo';
import { assertMathCanonicalPath, isMathPathWithin } from './paths';

export const KERNEL_CERTIFICATE_SCHEMA = 'theorem-os.kernel-certificate.v1';
export const KERNEL_CERTIFICATE_LIMITS = Object.freeze({ inputBytes: 64_000_000, variables: 8, witnesses: 8,
  pointsPerChunk: 250_000, rowsPerChunk: 1000, chunks: 8192, modules: 64, imports: 32, checkBytes: 16_000,
  definitionsBytes: 64_000, moduleBytes: 16_000_000, totalBytes: 128_000_000 });
/** Measured kernel cost is about 20 KB of memory per checked point; 500-row list literals stay below maxRecDepth. */
export const KERNEL_CERTIFICATE_DEFAULTS = Object.freeze({ pointsPerChunk: 40_000, rowsPerChunk: 500 });

const invalid = (detail: string) => new Error(`math_kernel_certificate_invalid: ${detail}`);
const identifier = /^[A-Za-z_][A-Za-z0-9_']*$/u;
const decimal = /^-?(?:0|[1-9][0-9]{0,99})$/u;
const reserved = new Set(['at', 'by', 'do', 'else', 'end', 'fun', 'have', 'if', 'in', 'let', 'match', 'show', 'then',
  'with', 'from', 'where', 'deriving', 'theorem', 'lemma', 'def', 'abbrev', 'instance', 'axiom', 'opaque', 'example',
  'namespace', 'section', 'open', 'import', 'variable', 'universe', 'mutual', 'structure', 'inductive', 'class', 'calc',
  'suffices', 'return', 'for', 'unless', 'try', 'catch', 'finally', 'break', 'continue', 'mut', 'Type', 'Prop', 'Sort']);
// Generated text must stay inside declaration regions and must not add trust, commands or comments.
const forbidden = /\b(?:sorry|admit|native_decide|axiom|opaque|unsafe|implemented_by|extern|trustCompiler|ofReduceBool|ofReduceNat|reduceBool|reduceNat|import|macro|macro_rules|syntax|elab|elab_rules|notation|infix|infixl|infixr|prefix|postfix|initialize|builtin_initialize|set_option|namespace|section|open|end|variable|universe|mutual|attribute|export|private|protected|instance|local|scoped)\b|--|\/-|#/u;

const parseInteger = (value: unknown): bigint | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value)
    : typeof value === 'string' && decimal.test(value) && value !== '-0' ? BigInt(value) : undefined;
const integer = z.unknown().transform((value, context) => {
  const parsed = parseInteger(value);
  if (parsed === undefined) context.addIssue({ code: 'custom', message: 'expected a safe integer or decimal string' });
  return parsed ?? 0n;
});
const variableName = z.string().regex(/^[a-z][A-Za-z0-9_']{0,31}$/u)
  .refine(name => !reserved.has(name) && !name.startsWith('kc_'), 'reserved variable name');
const certificateName = z.string().max(160).refine(name => {
  const parts = name.split('.');
  return parts.length <= 8 && parts[0] !== 'KernelCompute' && parts.every(part => identifier.test(part) && !reserved.has(part));
}, 'expected a dotted Lean name outside KernelCompute');
const modulePath = z.string().max(240).regex(/^(?:[A-Z][A-Za-z0-9_]*\/)*[A-Z][A-Za-z0-9_]*\.lean$/u);
const importName = z.string().max(240).regex(/^[A-Za-z_][A-Za-z0-9_']*(?:\.[A-Za-z_][A-Za-z0-9_']*)*$/u);
const range = z.object({ name: variableName, lo: integer, hi: integer }).strict();
const common = { schema: z.literal(KERNEL_CERTIFICATE_SCHEMA), name: certificateName,
  imports: z.array(importName).max(KERNEL_CERTIFICATE_LIMITS.imports).default([]),
  definitions: z.string().max(KERNEL_CERTIFICATE_LIMITS.definitionsBytes).default(''),
  check: z.string().min(1).max(KERNEL_CERTIFICATE_LIMITS.checkBytes),
  modules: z.array(modulePath).min(1).max(KERNEL_CERTIFICATE_LIMITS.modules), kernelModule: modulePath.optional() };
const specSchema = z.discriminatedUnion('claim', [
  z.object({ ...common, claim: z.literal('box'), variables: z.array(range).min(1).max(KERNEL_CERTIFICATE_LIMITS.variables),
    pointsPerChunk: z.number().int().min(1).max(KERNEL_CERTIFICATE_LIMITS.pointsPerChunk)
      .default(KERNEL_CERTIFICATE_DEFAULTS.pointsPerChunk) }).strict(),
  z.object({ ...common, claim: z.literal('witnesses'), variable: range,
    witnesses: z.array(variableName).min(1).max(KERNEL_CERTIFICATE_LIMITS.witnesses),
    // Rows are validated below without per-element schema overhead.
    rows: z.custom<unknown[]>(value => Array.isArray(value), 'expected an array of rows'),
    rowsPerChunk: z.number().int().min(1).max(KERNEL_CERTIFICATE_LIMITS.rowsPerChunk)
      .default(KERNEL_CERTIFICATE_DEFAULTS.rowsPerChunk) }).strict(),
]);
export type KernelCertificateSpec = z.input<typeof specSchema>;

export type KernelCertificateModule = Readonly<{
  path: string; module: string; role: 'library' | 'shared' | 'chunks' | 'final' | 'complete';
  imports: readonly string[]; chunks?: Readonly<{ first: number; last: number; lo: string; hi: string }>;
  points: number; bytes: number; sha256: string; source: string;
}>;
export type KernelCertificatePlan = Readonly<{
  schema: 'theorem-os.kernel-certificate-plan.v1'; trust: 'unchecked-generated-source'; claim: 'box' | 'witnesses';
  name: string; theorem: string; statement: string; check: string; finalModule: string; importModule: string;
  chunkCount: number; points: number; modules: readonly KernelCertificateModule[]; unusedModules: readonly string[];
  usage: string;
}>;

const moduleName = (relative: string) => relative.slice(0, -'.lean'.length).replaceAll('/', '.');
const intLiteral = (value: bigint) => value < 0n ? `(Int.negSucc ${-value - 1n})` : `(Int.ofNat ${value})`;
const intNumeral = (value: bigint) => `(${value} : Int)`;

function assertDefinitions(name: string, definitions: string): void {
  if (forbidden.test(definitions)) throw invalid('definitions contain a forbidden command, attribute, comment or trust escape');
  let declared = false;
  for (const line of definitions.split('\n')) {
    if (!line.trim()) continue;
    if (/^\s/u.test(line)) {
      if (!declared) throw invalid('definitions must start with a declaration');
      continue;
    }
    const match = /^(?:noncomputable[ \t]+)?(?:def|theorem|lemma|abbrev)[ \t]+([^ \t:({[]+)/u.exec(line);
    const local = match?.[1]?.startsWith(`${name}.`) ? match[1].slice(name.length + 1) : undefined;
    if (!local || local.split('.').some(part => !identifier.test(part) || reserved.has(part)) ||
        ['check', 'holds'].includes(local.split('.')[0]!) || local.startsWith('kc_'))
      throw invalid(`definition lines must declare ${name}.LOCAL (not check, holds or kc_*), continuation lines must be indented`);
    declared = true;
  }
}

function parseSpec(value: unknown) {
  const parsed = specSchema.safeParse(value);
  if (!parsed.success) throw invalid(parsed.error.issues.slice(0, 8)
    .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '));
  const spec = parsed.data;
  if (/[\r\n]/u.test(spec.check) || forbidden.test(spec.check))
    throw invalid('check must be one line without comments, commands or trust escapes');
  assertDefinitions(spec.name, spec.definitions);
  const ranges = spec.claim === 'box' ? spec.variables : [spec.variable];
  const names = [...ranges.map(item => item.name), ...(spec.claim === 'witnesses' ? spec.witnesses : [])];
  if (new Set(names).size !== names.length) throw invalid('variable and witness names must be distinct');
  const paths = [...spec.modules, ...(spec.kernelModule ? [spec.kernelModule] : [])];
  if (new Set(paths).size !== paths.length) throw invalid('module paths must be distinct');
  for (const item of ranges) if (item.lo > item.hi) throw invalid(`empty range for ${item.name}`);
  return spec;
}
type Chunk = Readonly<{ lo: bigint; hi: bigint; points: number }>;

/** Emit Lean sources whose kernel-checked `NAME.holds` covers the claim; generation itself is not evidence. */
export function planKernelCertificate(value: unknown, library: string): KernelCertificatePlan {
  const spec = parseSpec(value), limits = KERNEL_CERTIFICATE_LIMITS;
  if (/^\s*import\b/mu.test(library)) throw new Error('math_kernel_certificate_library_invalid');
  const q = (local: string) => `${spec.name}.${local}`;
  const outer = spec.claim === 'box' ? spec.variables[0]! : spec.variable;
  const size = outer.hi - outer.lo + 1n;
  const innerRanges = spec.claim === 'box' ? spec.variables.slice(1) : [];
  const inner = innerRanges.reduce((product, item) => product * (item.hi - item.lo + 1n), 1n);
  const perChunk = BigInt(spec.claim === 'box' ? spec.pointsPerChunk : spec.rowsPerChunk);
  if (inner > perChunk) throw invalid(`inner box has ${inner} points, above pointsPerChunk ${perChunk}; put the largest range first`);
  if (spec.claim === 'witnesses' && BigInt(spec.rows.length) !== size)
    throw invalid(`rows has ${spec.rows.length} entries but ${outer.name} ranges over ${size} values`);
  const width = perChunk / inner, chunkCount = (size + width - 1n) / width;
  if (chunkCount > BigInt(limits.chunks)) throw invalid(`${chunkCount} chunks exceed ${limits.chunks}; raise the chunk size or split the claim`);
  const chunks: Chunk[] = Array.from({ length: Number(chunkCount) }, (_, index) => {
    const lo = outer.lo + BigInt(index) * width, hi = lo + width - 1n < outer.hi ? lo + width - 1n : outer.hi;
    return { lo, hi, points: Number((hi - lo + 1n) * inner) };
  });

  const binders = spec.claim === 'box' ? spec.variables.map(item => item.name) : [outer.name, ...spec.witnesses];
  const shared: string[] = [];
  if (spec.definitions.trim()) shared.push(spec.definitions.trim().replace(/[ \t]+$/gmu, ''));
  shared.push(`noncomputable def ${q('check')} (${binders.join(' ')} : Int) : Bool :=\n  ${spec.check.trim()}`);
  const x = outer.name, quantified = (lo: bigint, hi: bigint) => `∀ ${x} : Int, ${intNumeral(lo)} ≤ ${x} → ${x} ≤ ${intNumeral(hi)} → `;
  const m = spec.claim === 'witnesses' ? spec.witnesses.length : 0;
  const rowType = m === 1 ? 'Int' : `(${Array(m).fill('Int').join(' × ')})`;
  let predicate: string;
  if (spec.claim === 'witnesses') {
    const projections = spec.witnesses.map((_, index) => m === 1 ? 'kc_r' : index < m - 1 ? `kc_r${'.2'.repeat(index)}.1` : `kc_r${'.2'.repeat(index)}`);
    shared.push(`noncomputable def ${q('kc_row')} (${x} : Int) (kc_r : ${rowType}) : Bool :=\n  ${q('check')} ${x} ${projections.join(' ')}`);
    predicate = `∃ kc_r, ${q('kc_row')} ${x} kc_r = true`;
  } else if (innerRanges.length) {
    const nested = innerRanges.map(item => `KernelCompute.intIccAll ${intNumeral(item.lo)} ${intNumeral(item.hi)} fun ${item.name} => `).join('');
    shared.push(`noncomputable def ${q('kc_inner')} (${x} : Int) : Bool :=\n  ${nested}${q('check')} ${binders.join(' ')}`);
    predicate = `${q('kc_inner')} ${x} = true`;
  } else predicate = `${q('check')} ${x} = true`;

  let total = 0;
  const account = (text: string) => {
    total += Buffer.byteLength(text) + 2;
    if (total > limits.totalBytes) throw invalid(`generated sources exceed ${limits.totalBytes} bytes`);
    return text;
  };
  const kernel = `(by set_option maxHeartbeats 0 in decide +kernel)`;
  const chunkText = chunks.map((chunk, index) => {
    const statement = `theorem ${q(`kc_chunk_${index}`)} : ${quantified(chunk.lo, chunk.hi)}${predicate} :=\n  `;
    if (spec.claim === 'box') return account(`${statement}KernelCompute.intIccAll_eq_true.mp ${kernel}`);
    const rows = spec.rows.slice(Number(chunk.lo - outer.lo), Number(chunk.hi - outer.lo) + 1).map((row, offset) => {
      const position = Number(chunk.lo - outer.lo) + offset, literals = Array.isArray(row) && row.length === m
        ? row.map(item => parseInteger(item)) : [];
      if (literals.length !== m || literals.some(item => item === undefined)) throw invalid(`rows[${position}] must list ${m} integers`);
      return m === 1 ? intLiteral(literals[0]!) : `(${literals.map(item => intLiteral(item!)).join(', ')})`;
    });
    return account(`noncomputable def ${q(`kc_rows_${index}`)} : List ${rowType} := [\n  ${rows.join(',\n  ')}]\n\n` +
      `${statement}KernelCompute.listFromTo_icc (l := ${q(`kc_rows_${index}`)}) (stop := ${intNumeral(chunk.hi + 1n)}) (by decide) ${kernel}`);
  });
  const upto = (index: number) => q(index ? `kc_upto_${index}` : 'kc_chunk_0');
  const final = chunks.slice(1).map((chunk, offset) =>
    `theorem ${upto(offset + 1)} : ${quantified(outer.lo, chunk.hi)}${predicate} :=\n  ` +
    `KernelCompute.icc_split (by decide) ${upto(offset)} ${q(`kc_chunk_${offset + 1}`)}`);
  const last = upto(chunks.length - 1);
  let statement: string, proof: string;
  if (spec.claim === 'witnesses') {
    const names = spec.witnesses.join(' '), pattern = m === 1 ? spec.witnesses[0] : `⟨${spec.witnesses.join(', ')}⟩`;
    statement = `${quantified(outer.lo, outer.hi)}∃ ${names} : Int, ${q('check')} ${binders.join(' ')} = true`;
    proof = `by\n  intro ${x} kc_h kc_g\n  obtain ⟨${pattern}, kc_w⟩ := ${last} ${x} kc_h kc_g\n  exact ⟨${spec.witnesses.join(', ')}, kc_w⟩`;
  } else {
    statement = spec.variables.map(item => `∀ ${item.name} : Int, ${intNumeral(item.lo)} ≤ ${item.name} → ${item.name} ≤ ${intNumeral(item.hi)} → `).join('') +
      `${q('check')} ${binders.join(' ')} = true`;
    const steps = innerRanges.map((item, index) => {
      const previous = `kc_v${index}`, binder = `${item.name} kc_h${index + 1} kc_g${index + 1}`;
      return index === innerRanges.length - 1 ? `  exact KernelCompute.intIccAll_eq_true.mp ${previous} ${binder}`
        : `  have kc_v${index + 1} := KernelCompute.intIccAll_eq_true.mp ${previous} ${binder}`;
    });
    proof = innerRanges.length ? `by\n  intro ${spec.variables.map((item, index) => `${item.name} kc_h${index} kc_g${index}`).join(' ')}\n` +
      `  have kc_v0 := ${last} ${x} kc_h0 kc_g0\n${steps.join('\n')}` : last;
  }
  final.push(`theorem ${q('holds')} : ${statement} :=${proof.startsWith('by\n') ? ' ' : '\n  '}${proof}`);
  final.forEach(account);
  const used = Math.min(spec.modules.length, chunks.length + 1);
  const groups = used <= 1 ? 0 : used - 1;
  const owner = (index: number) => groups ? 1 + Math.floor(index * groups / chunks.length) : 0;
  const bodies: string[][] = Array.from({ length: used }, () => []);
  bodies[0]!.push(...(spec.kernelModule ? [] : [library.trim()]), ...shared);
  chunkText.forEach((text, index) => bodies[owner(index)]!.push(text));
  bodies[used - 1]!.push(...final);
  const names = spec.modules.slice(0, used).map(moduleName);
  const headImports = [...(spec.kernelModule ? [moduleName(spec.kernelModule)] : []), ...spec.imports];
  const importsOf = (index: number) => [...new Set(index === 0 ? headImports
    : index === used - 1 ? names.slice(0, used - 1) : [names[0]!])];
  const render = (imports: readonly string[], body: readonly string[]) =>
    `${imports.map(item => `import ${item}\n`).join('')}${imports.length ? '\n' : ''}${body.join('\n\n')}\n`;
  const describe = (relative: string, role: KernelCertificateModule['role'], imports: readonly string[], source: string,
    covered?: readonly number[]): KernelCertificateModule => {
    const bytes = Buffer.byteLength(source);
    if (bytes > limits.moduleBytes) throw invalid(`${relative} would have ${bytes} bytes, above ${limits.moduleBytes}; list more modules`);
    return { path: relative, module: moduleName(relative), role, imports, bytes, sha256: mathDigest(source), source,
      points: covered?.reduce((sum, index) => sum + chunks[index]!.points, 0) ?? 0,
      ...(covered?.length ? { chunks: { first: covered[0]!, last: covered.at(-1)!,
        lo: String(chunks[covered[0]!]!.lo), hi: String(chunks[covered.at(-1)!]!.hi) } } : {}) };
  };
  const modules: KernelCertificateModule[] = [];
  if (spec.kernelModule) modules.push(describe(spec.kernelModule, 'library', [], render([], [library.trim()])));
  for (let index = 0; index < used; index++) {
    const covered = chunks.map((_, chunk) => chunk).filter(chunk => owner(chunk) === index);
    const role = used === 1 ? 'complete' : index === 0 ? 'shared' : index === used - 1 ? 'final' : 'chunks';
    modules.push(describe(spec.modules[index]!, role, importsOf(index), render(importsOf(index), bodies[index]!), covered));
  }
  const finalModule = spec.modules[used - 1]!;
  return { schema: 'theorem-os.kernel-certificate-plan.v1', trust: 'unchecked-generated-source', claim: spec.claim,
    name: spec.name, theorem: q('holds'), statement, check: q('check'), finalModule, importModule: moduleName(finalModule),
    chunkCount: chunks.length, points: chunks.reduce((sum, chunk) => sum + chunk.points, 0), modules,
    unusedModules: spec.modules.slice(used),
    usage: `Import ${moduleName(finalModule)} and apply ${q('holds')}. Bridge ${q('check')} to the theorem with ` +
      'KernelCompute.intLe_eq_true, intLt_eq_true, intEq_eq_true and Bool.and_eq_true; only Lean acceptance of every module is evidence. ' +
      'Check the first chunk module before relying on the others; kernel memory grows with points per chunk.' };
}
export type KernelCertificateWrite = Readonly<{ written: readonly string[]; unchanged: readonly string[] }>;

/** Write planned modules below one canonical project root; nonempty different files need `replace`. */
export function writeKernelCertificate(project: string, plan: KernelCertificatePlan, replace = false): KernelCertificateWrite {
  if (!path.isAbsolute(project) || fs.realpathSync(project) !== project || !fs.statSync(project).isDirectory())
    throw new Error('math_kernel_certificate_workspace_invalid');
  const targets = plan.modules.map(item => {
    const file = path.resolve(project, item.path);
    if (!isMathPathWithin(project, file) || file === project) throw new Error('math_kernel_certificate_path_invalid');
    try { assertMathCanonicalPath(file); } catch { throw new Error(`math_kernel_certificate_path_invalid: ${item.path}`); }
    let current: string | undefined;
    if (fs.existsSync(file)) {
      if (!fs.lstatSync(file).isFile()) throw new Error(`math_kernel_certificate_path_invalid: ${item.path}`);
      current = fs.readFileSync(file, 'utf8');
    }
    if (current !== undefined && current !== item.source && current.trim() && !replace)
      throw new Error(`math_kernel_certificate_target_exists: ${item.path}`);
    return { item, file, unchanged: current === item.source };
  });
  const written: string[] = [], unchanged: string[] = [];
  for (const { item, file, unchanged: same } of targets) {
    if (same) { unchanged.push(item.path); continue; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    assertMathCanonicalPath(file);
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomUUID()}.tmp`);
    const descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o644);
    try { fs.writeFileSync(descriptor, item.source, 'utf8'); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, file);
    syncMathDirectory(path.dirname(file));
    written.push(item.path);
  }
  return { written, unchanged };
}
