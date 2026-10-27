import { inspectScopedLeanDeclarations } from '../../src/math/leanSource';
import { getLeanTaskEnvironment } from '../../src/math/leanTaskEnvironment';
import type { WebProofOutline, WebProofOutlineDeclaration, WebRun } from './shared';

const maximumDeclarations = 128;
const maximumType = 2_000;
// Lean's three classical axioms; anything else in a target's closure deserves a reader's attention.
const standardAxioms = new Set(['propext', 'Classical.choice', 'Quot.sound']);

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
const names = (value: unknown) => Array.isArray(value)
  ? value.flatMap(item => typeof item === 'string' ? [item] : typeof object(item)?.name === 'string' ? [object(item)!.name as string] : []) : [];

function evaluatedTargets(run: WebRun) {
  const batch = object(object(object(object(run.result?.report)?.evaluator)?.verification)?.verification);
  const rows = Array.isArray(batch?.results) ? batch.results.map(object).filter(row => typeof row?.theoremName === 'string') : [];
  return new Map(rows.map(row => [row!.theoremName as string, row!]));
}

/** Declarations of a finished proof, split into the original targets and what the solver added. */
export function proofOutline(run: WebRun): WebProofOutline | undefined {
  const proof = run.result?.proof;
  if (!proof) return;
  const original = new Set(inspectScopedLeanDeclarations(run.source).map(item => item.qualifiedName));
  const declarations = inspectScopedLeanDeclarations(proof);
  const evaluated = evaluatedTargets(run);
  const targets = declarations.filter(item => item.kind === 'theorem' && original.has(item.qualifiedName));
  const added = declarations.filter(item => !original.has(item.qualifiedName));
  const addedNames = new Set(added.map(item => item.qualifiedName));
  const uses = new Map<string, string[]>();
  let recorded = targets.length > 0;
  for (const target of targets) {
    const references = object(evaluated.get(target.qualifiedName)?.declarationReferences);
    if (!references) { recorded = false; continue; }
    uses.set(target.qualifiedName, names(references.proof).filter(name => addedNames.has(name) && name !== target.qualifiedName));
  }
  const usedBy = new Map<string, string[]>();
  for (const [target, used] of uses) for (const name of used) usedBy.set(name, [...usedBy.get(name) ?? [], target]);
  const describe = (item: typeof declarations[number], role: WebProofOutlineDeclaration['role']): WebProofOutlineDeclaration => {
    const row = evaluated.get(item.qualifiedName);
    const type = (typeof row?.elaboratedDeclarationType === 'string' ? row.elaboratedDeclarationType : item.declarationType).trim();
    const axioms = role === 'target' && row ? names(row.axioms) : undefined;
    return { name: item.qualifiedName, kind: item.kind, role, type: type.slice(0, maximumType), ...(type.length > maximumType ? { typeTruncated: true } : {}),
      ...(role === 'target' && uses.has(item.qualifiedName) ? { uses: uses.get(item.qualifiedName)! } : {}),
      ...(role === 'helper' && recorded ? { usedBy: usedBy.get(item.qualifiedName) ?? [] } : {}),
      ...(axioms ? { axioms, nonstandardAxioms: axioms.filter(name => !standardAxioms.has(name)) } : {}) };
  };
  const listed = [...targets.map(item => describe(item, 'target')), ...added.map(item => describe(item, 'helper'))];
  return { references: recorded ? 'recorded' : 'unrecorded', declarations: listed.slice(0, maximumDeclarations),
    omitted: Math.max(0, listed.length - maximumDeclarations) };
}

// Store-only ZIP: every unzip tool reads it, and there is nothing worth compressing.
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
  return value >>> 0;
});
function crc32(data: Buffer) {
  let value = 0xffffffff;
  for (const byte of data) value = crcTable[(value ^ byte) & 0xff] ^ value >>> 8;
  return (value ^ 0xffffffff) >>> 0;
}
export function zip(files: readonly { name: string; content: string }[], date = new Date()): Buffer {
  const time = date.getHours() << 11 | date.getMinutes() << 5 | Math.floor(date.getSeconds() / 2);
  const day = Math.max(0, date.getFullYear() - 1980) << 9 | date.getMonth() + 1 << 5 | date.getDate();
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8'), data = Buffer.from(file.content, 'utf8'), crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(0, 8); header.writeUInt16LE(time, 10); header.writeUInt16LE(day, 12);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26); header.writeUInt16LE(0, 28);
    local.push(header, name, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(0x0314, 4); entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8); entry.writeUInt16LE(0, 10); entry.writeUInt16LE(time, 12); entry.writeUInt16LE(day, 14);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE((0o100644 << 16) >>> 0, 38); entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += header.length + name.length + data.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

const identifier = (name: string) => name.split('.').map(part => /^[\p{L}_][\p{L}\p{N}_'!?]*$/u.test(part) ? part : `«${part}»`).join('.');

/** Everything a reader needs to replay the kernel check offline from the pinned toolchain. */
export function verificationKit(run: WebRun, now = new Date()): { filename: string; content: Buffer } | undefined {
  const outline = proofOutline(run);
  const targets = outline?.declarations.filter(item => item.role === 'target').map(item => item.name) ?? [];
  if (!outline || !targets.length) return;
  const environment = getLeanTaskEnvironment(run.environment);
  const directory = `theoremos-${run.id.slice(0, 8)}`;
  const mathlib = Boolean(environment.mathlibRevision);
  const check = ['import Submission', '', ...targets.map(name => `#print axioms ${identifier(name)}`), ''].join('\n');
  const readme = [
    `TheoremOS local verification · run ${run.id}`,
    `Lean ${environment.toolchain}${mathlib ? ` · Mathlib ${environment.mathlibRevision}` : ' · core library only'}`,
    '',
    '中文',
    '1. 安装 elan（Lean 版本管理器）：https://github.com/leanprover/elan ；lean-toolchain 会自动选用上面的 Lean 版本。',
    ...(mathlib ? ['2. 在本目录运行 `lake exe cache get` 下载预编译的 Mathlib（首次约数 GB）。'] : ['2. 标准库环境无需下载依赖。']),
    '3. 运行 `lake build Submission`：没有 error 即 Lean 内核接受了 Submission.lean 中的全部证明。',
    '4. 运行 `lake env lean Check.lean`：每个目标只应依赖 propext、Classical.choice、Quot.sound；出现 sorryAx 表示证明不完整，其他公理需逐一核对。',
    '5. 比较 Original.lean 与 Submission.lean（如 `diff Original.lean Submission.lean`）：目标定理的陈述应保持不变，只有证明和新增的辅助声明不同。',
    'report.json 是平台的验收记录，供对照，不参与上述检查。',
    '',
    'English',
    '1. Install elan (the Lean version manager): https://github.com/leanprover/elan . lean-toolchain selects the Lean version above.',
    ...(mathlib ? ['2. Run `lake exe cache get` here to download prebuilt Mathlib (several GB the first time).'] : ['2. The core-library environment needs no downloads.']),
    '3. Run `lake build Submission`. No errors means the Lean kernel accepted every proof in Submission.lean.',
    '4. Run `lake env lean Check.lean`. Each target should depend only on propext, Classical.choice and Quot.sound; sorryAx means an incomplete proof, and any other axiom needs review.',
    '5. Compare Original.lean with Submission.lean (for example `diff Original.lean Submission.lean`). Target statements should be unchanged; only proofs and added helper declarations differ.',
    'report.json is the platform\'s acceptance record, kept for comparison; the steps above do not use it.',
    '',
  ].join('\n');
  const files = [
    ...Object.entries(environment.files).map(([name, content]) => ({ name, content })),
    { name: 'Submission.lean', content: run.result!.proof },
    { name: 'Original.lean', content: run.source },
    { name: 'Check.lean', content: check },
    { name: 'README.txt', content: readme },
    { name: 'report.json', content: JSON.stringify(run.result!.report, null, 2) + '\n' },
  ].map(file => ({ name: `${directory}/${file.name}`, content: file.content }));
  return { filename: `${directory}-verify.zip`, content: zip(files, now) };
}
