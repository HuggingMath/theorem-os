import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { planKernelCertificate, writeKernelCertificate } from '../src/math/kernelCertificate';
import { inspectLeanDeclarationRegions } from '../src/math/leanSource';

const library = fs.readFileSync(path.join(__dirname, '../resources/lean/KernelCompute.lean'), 'utf8');
const toolchains = path.join(os.homedir(), '.elan', 'toolchains');
const lean = fs.existsSync(toolchains) ? fs.readdirSync(toolchains).toSorted().reverse()
  .map(name => path.join(toolchains, name, 'bin', 'lean')).find(file => fs.existsSync(file)) : undefined;
const schema = 'theorem-os.kernel-certificate.v1';
const box = (extra: Record<string, unknown> = {}) => ({ schema, claim: 'box', name: 'Cert.Box',
  check: 'KernelCompute.intLe 0 (x*x - 2*x*y + 2*y*y)', pointsPerChunk: 400, kernelModule: 'Cert/Kernel.lean',
  variables: [{ name: 'x', lo: -20, hi: 20 }, { name: 'y', lo: -20, hi: 20 }],
  modules: ['Cert/Box/P1.lean', 'Cert/Box/P2.lean', 'Cert/Box/P3.lean'], ...extra });
const threeSquares = [[0, 0, 0], [1, 0, 0], [1, -1, 0], [1, 1, 1], [2, 0, 0], [2, 1, 0], [2, -1, 1]];
const witnesses = (extra: Record<string, unknown> = {}) => ({ schema, claim: 'witnesses', name: 'Cert.Three',
  check: 'KernelCompute.intEq (a*a + b*b + c*c) n', variable: { name: 'n', lo: 0, hi: 6 }, witnesses: ['a', 'b', 'c'],
  rows: threeSquares, rowsPerChunk: 3, kernelModule: 'Cert/Kernel.lean', modules: ['Cert/Three/A.lean', 'Cert/Three/B.lean'],
  ...extra });
const roots: string[] = [];
const temporary = () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-certificate-')));
  roots.push(root);
  return root;
};
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('kernel certificate generation', () => {
  it('splits the first box range into chunk modules and proves holds in the last module', () => {
    const plan = planKernelCertificate(box(), library);
    expect(plan).toMatchObject({ claim: 'box', theorem: 'Cert.Box.holds', check: 'Cert.Box.check', chunkCount: 5,
      points: 1681, finalModule: 'Cert/Box/P3.lean', importModule: 'Cert.Box.P3', unusedModules: [],
      trust: 'unchecked-generated-source' });
    expect(plan.modules.map(item => [item.path, item.role, item.imports, item.chunks, item.points])).toEqual([
      ['Cert/Kernel.lean', 'library', [], undefined, 0],
      ['Cert/Box/P1.lean', 'shared', ['Cert.Kernel'], undefined, 0],
      ['Cert/Box/P2.lean', 'chunks', ['Cert.Box.P1'], { first: 0, last: 2, lo: '-20', hi: '6' }, 1107],
      ['Cert/Box/P3.lean', 'final', ['Cert.Box.P1', 'Cert.Box.P2'], { first: 3, last: 4, lo: '7', hi: '20' }, 574],
    ]);
    const [, shared, chunks, final] = plan.modules.map(item => item.source);
    expect(shared).toContain('noncomputable def Cert.Box.kc_inner (x : Int) : Bool :=\n  ' +
      'KernelCompute.intIccAll (-20 : Int) (20 : Int) fun y => Cert.Box.check x y');
    expect(chunks).toContain('theorem Cert.Box.kc_chunk_1 : ∀ x : Int, (-11 : Int) ≤ x → x ≤ (-3 : Int) → ' +
      'Cert.Box.kc_inner x = true :=\n  KernelCompute.intIccAll_eq_true.mp (by set_option maxHeartbeats 0 in decide +kernel)');
    expect(final).toContain('KernelCompute.icc_split (by decide) Cert.Box.kc_upto_3 Cert.Box.kc_chunk_4');
    expect(final).toContain('theorem Cert.Box.holds : ∀ x : Int, (-20 : Int) ≤ x → x ≤ (20 : Int) → ∀ y : Int, ' +
      '(-20 : Int) ≤ y → y ≤ (20 : Int) → Cert.Box.check x y = true := by\n  intro x kc_h0 kc_g0 y kc_h1 kc_g1\n' +
      '  have kc_v0 := Cert.Box.kc_upto_4 x kc_h0 kc_g0\n  exact KernelCompute.intIccAll_eq_true.mp kc_v0 y kc_h1 kc_g1\n');
    expect(planKernelCertificate(box(), library)).toEqual(plan);
  });

  it('inlines the library into one complete module and uses at most one module per chunk plus shared', () => {
    const spec = { schema, claim: 'box', name: 'Cert.One', check: 'KernelCompute.intLe 0 (sq x - x)',
      definitions: 'noncomputable def Cert.One.sq (x : Int) : Int :=\n  x * x\n', variables: [{ name: 'x', lo: '-50', hi: 30 }],
      modules: ['Cert/One.lean'] };
    const plan = planKernelCertificate(spec, library);
    expect(plan.modules.map(item => [item.path, item.role, item.imports])).toEqual([['Cert/One.lean', 'complete', []]]);
    expect(plan.unusedModules).toEqual([]);
    expect(plan.modules[0]!.source.startsWith(library.trim())).toBe(true);
    expect(plan.modules[0]!.source).toContain('theorem Cert.One.holds : ∀ x : Int, (-50 : Int) ≤ x → x ≤ (30 : Int) → ' +
      'Cert.One.check x = true :=\n  Cert.One.kc_chunk_0\n');
    const spread = planKernelCertificate({ ...spec, modules: ['Cert/One.lean', 'Cert/Two.lean', 'Cert/Three.lean'] }, library);
    expect(spread.modules.map(item => [item.path, item.role, item.imports])).toEqual([
      ['Cert/One.lean', 'shared', []], ['Cert/Two.lean', 'final', ['Cert.One']]]);
    expect(spread.unusedModules).toEqual(['Cert/Three.lean']);
  });

  it('emits witness tables as constructor literals and destructures them in holds', () => {
    const plan = planKernelCertificate(witnesses(), library);
    expect(plan).toMatchObject({ claim: 'witnesses', chunkCount: 3, points: 7, finalModule: 'Cert/Three/B.lean' });
    expect(plan.modules.map(item => [item.path, item.role, item.imports, item.chunks])).toEqual([
      ['Cert/Kernel.lean', 'library', [], undefined], ['Cert/Three/A.lean', 'shared', ['Cert.Kernel'], undefined],
      ['Cert/Three/B.lean', 'final', ['Cert.Three.A'], { first: 0, last: 2, lo: '0', hi: '6' }]]);
    const final = plan.modules[2]!.source;
    expect(plan.modules[1]!.source).toContain('noncomputable def Cert.Three.kc_row (n : Int) (kc_r : (Int × Int × Int)) : Bool :=\n' +
      '  Cert.Three.check n kc_r.1 kc_r.2.1 kc_r.2.2');
    expect(final).toContain('noncomputable def Cert.Three.kc_rows_1 : List (Int × Int × Int) := [\n' +
      '  ((Int.ofNat 1), (Int.ofNat 1), (Int.ofNat 1)),\n  ((Int.ofNat 2), (Int.ofNat 0), (Int.ofNat 0)),\n' +
      '  ((Int.ofNat 2), (Int.ofNat 1), (Int.ofNat 0))]');
    expect(final).toContain('KernelCompute.listFromTo_icc (l := Cert.Three.kc_rows_2) (stop := (7 : Int)) (by decide)');
    expect(final).toContain('theorem Cert.Three.holds : ∀ n : Int, (0 : Int) ≤ n → n ≤ (6 : Int) → ∃ a b c : Int, ' +
      'Cert.Three.check n a b c = true := by\n  intro n kc_h kc_g\n  obtain ⟨⟨a, b, c⟩, kc_w⟩ := Cert.Three.kc_upto_2 n kc_h kc_g\n' +
      '  exact ⟨a, b, c, kc_w⟩\n');
    const single = planKernelCertificate(witnesses({ witnesses: ['k'], check: 'KernelCompute.intEq k n',
      variable: { name: 'n', lo: '-12345678901234567890', hi: '-12345678901234567889' },
      rows: [['-12345678901234567890'], ['-12345678901234567889']] }), library);
    expect(single.modules.at(-1)!.source).toContain('[\n  (Int.negSucc 12345678901234567889),\n  (Int.negSucc 12345678901234567888)]');
    expect(single.modules.at(-1)!.source).toContain('obtain ⟨k, kc_w⟩');
  });
  it.each([
    ['sorry in check', box({ check: 'sorry' }), 'check must be one line'],
    ['multi-line check', box({ check: 'true &&\n  true' }), 'check must be one line'],
    ['comment in check', box({ check: 'true -- x' }), 'check must be one line'],
    ['native_decide in check', box({ check: 'by native_decide' }), 'check must be one line'],
    ['command in definitions', box({ definitions: 'set_option maxRecDepth 100000' }), 'forbidden command'],
    ['axiom in definitions', box({ definitions: 'axiom Cert.Box.bad : False' }), 'forbidden command'],
    ['foreign definition name', box({ definitions: 'def Other.q : Int := 0' }), 'definition lines must declare Cert.Box.LOCAL'],
    ['generated definition name', box({ definitions: 'def Cert.Box.kc_inner : Int := 0' }), 'definition lines must declare'],
    ['unindented continuation', box({ definitions: 'def Cert.Box.q : Int :=\n0' }), 'definition lines must declare'],
    ['leading continuation', box({ definitions: '  def Cert.Box.q : Int := 0' }), 'definitions must start with a declaration'],
    ['reserved variable', box({ variables: [{ name: 'fun', lo: 0, hi: 1 }] }), 'reserved variable name'],
    ['generated variable prefix', box({ variables: [{ name: 'kc_x', lo: 0, hi: 1 }] }), 'reserved variable name'],
    ['duplicate variables', box({ variables: [{ name: 'x', lo: 0, hi: 1 }, { name: 'x', lo: 0, hi: 1 }] }), 'distinct'],
    ['duplicate modules', box({ modules: ['Cert/Kernel.lean'] }), 'module paths must be distinct'],
    ['lowercase module path', box({ modules: ['cert/P1.lean'] }), 'modules.0'],
    ['KernelCompute name', box({ name: 'KernelCompute.Mine' }), 'outside KernelCompute'],
    ['unsafe number', box({ variables: [{ name: 'x', lo: 0, hi: 2 ** 60 }] }), 'safe integer'],
    ['negative zero string', box({ variables: [{ name: 'x', lo: '-0', hi: 1 }] }), 'safe integer'],
    ['empty range', box({ variables: [{ name: 'x', lo: 2, hi: 1 }] }), 'empty range for x'],
    ['inner box too large', box({ variables: [{ name: 'x', lo: 0, hi: 1 }, { name: 'y', lo: 0, hi: 999 }] }), 'put the largest range first'],
    ['too many chunks', box({ pointsPerChunk: 1, variables: [{ name: 'x', lo: 0, hi: 9000 }] }), 'chunks exceed 8192'],
    ['unknown field', box({ extra: true }), 'Unrecognized key'],
    ['missing row', witnesses({ rows: threeSquares.slice(1) }), 'rows has 6 entries but n ranges over 7 values'],
    ['short row', witnesses({ rows: [...threeSquares.slice(0, 6), [2, -1]] }), 'rows[6] must list 3 integers'],
    ['fractional row', witnesses({ rows: [[0.5, 0, 0], ...threeSquares.slice(1)] }), 'rows[0] must list 3 integers'],
    ['witness name clash', witnesses({ witnesses: ['a', 'n', 'c'] }), 'distinct'],
  ])('rejects %s', (_label, spec, message) => {
    expect(() => planKernelCertificate(spec, library)).toThrow(message);
  });

  it('adds only declaration regions and imports to owned module text', () => {
    for (const plan of [planKernelCertificate(box({ definitions: 'noncomputable def Cert.Box.q (x : Int) : Int :=\n  x * x' }), library),
      planKernelCertificate(witnesses({ kernelModule: undefined }), library)]) {
      for (const item of plan.modules) {
        let residue = '', cursor = 0;
        const regions = inspectLeanDeclarationRegions(item.source);
        for (const region of regions) {
          residue += item.source.slice(cursor, region.startOffset).replace(/\bnoncomputable[ \t]+$/u, '');
          cursor = region.endOffset;
        }
        residue += item.source.slice(cursor);
        expect(residue.split('\n').filter(line => line.trim()).every(line => /^import [A-Za-z0-9_.]+$/u.test(line))).toBe(true);
        expect(regions.every(region => region.name.startsWith(`${plan.name}.`) || region.name.startsWith('KernelCompute.'))).toBe(true);
      }
    }
    expect(library).not.toMatch(/\b(?:sorry|admit|native_decide|axiom)\b|^\s*(?:import|open|namespace|set_option)\b/mu);
  });
  it('writes all modules atomically, keeps identical files and refuses different nonempty files', () => {
    const project = temporary(), plan = planKernelCertificate(box(), library);
    expect(writeKernelCertificate(project, plan)).toEqual({ written: plan.modules.map(item => item.path), unchanged: [] });
    for (const item of plan.modules) expect(fs.readFileSync(path.join(project, item.path), 'utf8')).toBe(item.source);
    expect(writeKernelCertificate(project, plan)).toEqual({ written: [], unchanged: plan.modules.map(item => item.path) });
    const changed = planKernelCertificate(box({ check: 'KernelCompute.intLe 0 (x*x + y*y)' }), library);
    expect(() => writeKernelCertificate(project, changed)).toThrow('math_kernel_certificate_target_exists: Cert/Box/P1.lean');
    expect(fs.readFileSync(path.join(project, 'Cert/Box/P1.lean'), 'utf8')).toBe(plan.modules[1]!.source);
    expect(writeKernelCertificate(project, changed, true).written).toEqual(['Cert/Box/P1.lean']);
    fs.writeFileSync(path.join(project, 'Cert/Box/P2.lean'), '\n');
    expect(writeKernelCertificate(project, changed).written).toEqual(['Cert/Box/P2.lean']);
    expect(fs.readdirSync(path.join(project, 'Cert/Box')).toSorted()).toEqual(['P1.lean', 'P2.lean', 'P3.lean']);
  });

  it('refuses linked targets, linked directories and non-canonical projects before writing', () => {
    const project = temporary(), outside = temporary(), plan = planKernelCertificate(box(), library);
    fs.symlinkSync(outside, path.join(project, 'Cert'));
    expect(() => writeKernelCertificate(project, plan)).toThrow('math_kernel_certificate_path_invalid: Cert/Kernel.lean');
    expect(fs.readdirSync(outside)).toEqual([]);
    fs.unlinkSync(path.join(project, 'Cert'));
    fs.mkdirSync(path.join(project, 'Cert/Box'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'target.lean'), '');
    fs.symlinkSync(path.join(outside, 'target.lean'), path.join(project, 'Cert/Box/P3.lean'));
    expect(() => writeKernelCertificate(project, plan)).toThrow('math_kernel_certificate_path_invalid: Cert/Box/P3.lean');
    expect(fs.existsSync(path.join(project, 'Cert/Kernel.lean'))).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'target.lean'), 'utf8')).toBe('');
    fs.symlinkSync(project, path.join(outside, 'link'));
    expect(() => writeKernelCertificate(path.join(outside, 'link'), plan)).toThrow('math_kernel_certificate_workspace_invalid');
    expect(() => writeKernelCertificate('relative', plan)).toThrow('math_kernel_certificate_workspace_invalid');
  });
});

describe.skipIf(!lean)('kernel certificate Lean acceptance', () => {
  it('compiles generated box and witness certificates that bridge to arithmetic statements', () => {
    const project = temporary(), build = path.join(project, 'build');
    const plans = [planKernelCertificate(box(), library), planKernelCertificate(witnesses(), library)];
    for (const plan of plans) writeKernelCertificate(project, plan);
    const compile = (relative: string) => {
      const output = path.join(build, relative.replace(/\.lean$/u, '.olean'));
      fs.mkdirSync(path.dirname(output), { recursive: true });
      const result = spawnSync(lean!, ['-R', project, '-o', output, path.join(project, relative)],
        { cwd: project, env: { ...process.env, LEAN_PATH: build }, encoding: 'utf8', timeout: 120_000 });
      expect(`${result.stdout}${result.stderr}`).toBe('');
      expect(result.status).toBe(0);
    };
    for (const relative of [...new Set(plans.flatMap(plan => plan.modules.map(item => item.path)))]) compile(relative);
    fs.writeFileSync(path.join(project, 'Probe.lean'), `import Cert.Box.P3
import Cert.Three.B

theorem box_psd : ∀ x y : Int, -20 ≤ x → x ≤ 20 → -20 ≤ y → y ≤ 20 → 0 ≤ x*x - 2*x*y + 2*y*y := by
  intro x y hx hx' hy hy'
  exact KernelCompute.intLe_eq_true.mp (Cert.Box.holds x hx hx' y hy hy')

theorem three_sq : ∀ n : Int, 0 ≤ n → n ≤ 6 → ∃ a b c : Int, a*a + b*b + c*c = n := by
  intro n h h'
  obtain ⟨a, b, c, w⟩ := Cert.Three.holds n h h'
  exact ⟨a, b, c, KernelCompute.intEq_eq_true.mp w⟩

#print axioms box_psd
#print axioms three_sq
`);
    const probe = spawnSync(lean!, [path.join(project, 'Probe.lean')],
      { cwd: project, env: { ...process.env, LEAN_PATH: build }, encoding: 'utf8', timeout: 120_000 });
    expect(probe.stderr).toBe('');
    expect(probe.stdout).toBe("'box_psd' depends on axioms: [propext, Quot.sound]\n'three_sq' depends on axioms: [propext, Quot.sound]\n");
    expect(probe.status).toBe(0);
  }, 300_000);
});
