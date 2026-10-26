import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mathLocalModuleGraph, type MathLocalModule } from '../src/math/mathConstructionSources';
import { createLeanModuleBuilder, leanModuleClosure, type LeanModuleHostCache } from '../src/math/leanModuleBuild';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { newestLeanBinary } from './helpers/lean';

const lean = newestLeanBinary();

const roots: string[] = [];
const temporary = (prefix: string) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.push(root);
  return root;
};
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

// D imports B and C, which both import A; E is independent.
const SOURCES: Record<string, string> = {
  'A.lean': 'def a := 1\n', 'B.lean': 'import A\ndef b := a\n', 'C.lean': 'import A\ndef c := a\n',
  'D.lean': 'import B\nimport C\ndef d := b + c\n', 'E.lean': 'def e := 2\n',
};
const project = (sources = SOURCES) => {
  const root = temporary('lean-module-project-');
  for (const [file, source] of Object.entries(sources)) fs.writeFileSync(path.join(root, file), source);
  return root;
};
const graph = (root: string) => mathLocalModuleGraph(root, ['D.lean', 'E.lean']);
const names = (modules: readonly { module: MathLocalModule }[]) => modules.map(built => built.module.module);
type Hooks = { fail?: string; tamper?: (module: string, project: string) => void; noOutput?: boolean };
/** A test compiler: records what each module could see, then writes an olean naming that view. */
function makeBuilder(root: string, cache?: LeanModuleHostCache, hooks: Hooks = {}) {
  const compiled: string[] = [], seen: Record<string, string[]> = {}, spans: Record<string, [number, number]> = {};
  const builder = createLeanModuleBuilder<string>({
    sourceProjectRoot: root, scratchRoot: temporary('lean-module-scratch-'), relativeProjectRoot: 'work',
    prepareProject: projectRoot => fs.writeFileSync(path.join(projectRoot, 'lean-toolchain'), 'test\n'),
    invalid: message => `invalid:${message}`,
    hostCache: () => cache,
    compile: async (module, buildRoot) => {
      const projectRoot = path.join(buildRoot, 'work'), started = performance.now();
      compiled.push(module.module);
      await new Promise(resolve => setTimeout(resolve, 20));
      const lib = path.join(projectRoot, '.lake', 'build', 'lib', 'lean');
      const visible = fs.existsSync(lib) ? fs.readdirSync(lib).toSorted() : [];
      seen[module.module] = [...fs.readdirSync(projectRoot).filter(file => file.endsWith('.lean')), ...visible].toSorted();
      spans[module.module] = [started, performance.now()];
      if (hooks.fail === module.module) return { ok: false as const, failure: `failed:${module.module}` };
      if (hooks.noOutput) return { ok: true as const };
      fs.mkdirSync(lib, { recursive: true });
      const source = fs.readFileSync(path.join(projectRoot, module.file), 'utf8');
      fs.writeFileSync(path.join(lib, `${module.module}.olean`), `${module.module}:${mathDigest(source)}:${visible.join(',')}`);
      hooks.tamper?.(module.module, projectRoot);
      return { ok: true as const };
    },
  });
  return { builder, compiled, seen, spans };
}

describe('Lean module builder', () => {
  it('compiles a closed graph dependency-first and concurrently, exposing only each import closure', async () => {
    const root = project(), { builder, compiled, seen, spans } = makeBuilder(root);
    const modules = graph(root);
    expect(names(modules.map(module => ({ module })))).toEqual(['A', 'B', 'C', 'D', 'E']);
    const result = await builder.build(modules);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(compiled.indexOf('A')).toBeLessThan(compiled.indexOf('B'));
    expect(compiled.indexOf('C')).toBeLessThan(compiled.indexOf('D'));
    expect(spans.B[0]).toBeLessThan(spans.C[1]);
    expect(spans.C[0]).toBeLessThan(spans.B[1]);
    expect(seen).toEqual({ A: ['A.lean'], B: ['A.olean', 'B.lean'], C: ['A.olean', 'C.lean'],
      D: ['A.olean', 'B.olean', 'C.olean', 'D.lean'], E: ['E.lean'] });
    expect(result.modules.every(built => built.origin === 'compiled')).toBe(true);
    const d = result.modules.find(built => built.module.module === 'D')!;
    expect(names(d.closure)).toEqual(['A', 'B', 'C']);
    expect(names(leanModuleClosure([d, result.modules.at(-1)!]))).toEqual(['A', 'B', 'C', 'D', 'E']);
    const again = await builder.build(modules);
    expect(compiled).toHaveLength(5);
    expect(again.ok && again.modules.map(built => built.key)).toEqual(result.modules.map(built => built.key));
    const installed = await builder.withProject([d], new Map([['Query.lean', Buffer.from('import D\n')]]), async buildRoot => {
      const projectRoot = path.join(buildRoot, 'work');
      return [fs.readFileSync(path.join(projectRoot, 'Query.lean'), 'utf8'), fs.readFileSync(path.join(projectRoot, 'lean-toolchain'), 'utf8'),
        ...fs.readdirSync(path.join(projectRoot, '.lake', 'build', 'lib', 'lean')).toSorted()];
    });
    expect(installed).toEqual(['import D\n', 'test\n', 'A.olean', 'B.olean', 'C.olean', 'D.olean']);
  });
  it('reuses attested modules across builders and recompiles only a changed module and its dependents', async () => {
    const root = project(), directory = temporary('lean-module-cache-');
    const cache = { directory, secret: 'secret-a', environmentDigest: 'environment-a' };
    const first = makeBuilder(root, cache);
    const built = await first.builder.build(graph(root));
    expect(first.compiled.toSorted()).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(fs.readdirSync(directory)).toHaveLength(5);
    const second = makeBuilder(root, cache);
    const restored = await second.builder.build(graph(root));
    expect(second.compiled).toEqual([]);
    expect(restored.ok && restored.modules.map(module => [module.key, module.origin, module.artifacts]))
      .toEqual(built.ok && built.modules.map(module => [module.key, 'cache', module.artifacts]));
    fs.writeFileSync(path.join(root, 'B.lean'), 'import A\ndef b := a + 0\n');
    const changed = makeBuilder(root, cache);
    await changed.builder.build(graph(root));
    expect(changed.compiled.toSorted()).toEqual(['B', 'D']);
    for (const other of [{ ...cache, secret: 'secret-b' }, { ...cache, environmentDigest: 'environment-b' }]) {
      const isolated = makeBuilder(root, other);
      await isolated.builder.build(graph(root));
      expect(isolated.compiled).toHaveLength(5);
    }
  });

  it('treats damaged, re-attested or linked cache entries as misses and replaces them', async () => {
    const root = project(), directory = temporary('lean-module-cache-');
    const cache = { directory, secret: 'secret', environmentDigest: 'environment' };
    const built = await makeBuilder(root, cache).builder.build(graph(root));
    if (!built.ok) throw new Error('fixture build failed');
    const entryOf = (name: string) => {
      const key = built.modules.find(module => module.module.module === name)!.key;
      return path.join(directory, fs.readdirSync(directory).find(entry =>
        JSON.parse(fs.readFileSync(path.join(directory, entry, 'manifest.json'), 'utf8')).key === key)!);
    };
    const [a, c, e] = ['A', 'C', 'E'].map(entryOf);
    fs.appendFileSync(path.join(a, 'artifact.olean'), 'x');
    const manifest = JSON.parse(fs.readFileSync(path.join(c, 'manifest.json'), 'utf8'));
    fs.writeFileSync(path.join(c, 'manifest.json'), JSON.stringify({ ...manifest, attestation: '0'.repeat(64) }));
    const outside = path.join(temporary('lean-module-outside-'), 'E.olean');
    fs.copyFileSync(path.join(e, 'artifact.olean'), outside);
    fs.rmSync(path.join(e, 'artifact.olean'));
    fs.symlinkSync(outside, path.join(e, 'artifact.olean'));
    const repaired = makeBuilder(root, cache);
    const result = await repaired.builder.build(graph(root));
    expect(result.ok).toBe(true);
    expect(repaired.compiled.toSorted()).toEqual(['A', 'C', 'E']);
    const reused = makeBuilder(root, cache);
    await reused.builder.build(graph(root));
    expect(reused.compiled).toEqual([]);
  });

  it('reports the first failing module, skips its dependents and caches only what succeeded', async () => {
    const root = project(), directory = temporary('lean-module-cache-');
    const { builder, compiled } = makeBuilder(root, { directory, secret: 'secret', environmentDigest: 'environment' }, { fail: 'B' });
    const result = await builder.build(graph(root));
    expect(result).toMatchObject({ ok: false, module: { module: 'B' }, failure: 'failed:B' });
    expect(compiled.toSorted()).toEqual(['A', 'B', 'C', 'E']);
    expect(fs.readdirSync(directory)).toHaveLength(3);
  });
  it('rejects outputs Lean does not write and sources that change after the graph was read', async () => {
    const outsideRoot = temporary('lean-module-outside-');
    const cases: [string, Hooks['tamper']][] = [
      ['symlinked olean', (module, projectRoot) => {
        if (module !== 'C') return;
        const olean = path.join(projectRoot, '.lake', 'build', 'lib', 'lean', 'C.olean');
        fs.renameSync(olean, path.join(outsideRoot, 'C-link.olean'));
        fs.symlinkSync(path.join(outsideRoot, 'C-link.olean'), olean);
      }],
      ['hard-linked olean', (module, projectRoot) => {
        if (module === 'C') fs.linkSync(path.join(projectRoot, '.lake', 'build', 'lib', 'lean', 'C.olean'), path.join(outsideRoot, 'C-hard.olean'));
      }],
      ['linked build directory', (module, projectRoot) => {
        if (module !== 'C') return;
        const lib = path.join(projectRoot, '.lake', 'build', 'lib');
        fs.cpSync(lib, path.join(outsideRoot, 'lib'), { recursive: true });
        fs.rmSync(lib, { recursive: true });
        fs.symlinkSync(path.join(outsideRoot, 'lib'), lib);
      }],
    ];
    for (const [label, tamper] of cases) {
      const root = project(), { builder, compiled } = makeBuilder(root, undefined, { tamper });
      const result = await builder.build(graph(root));
      expect(result, label).toMatchObject({ ok: false, module: { module: 'C' }, failure: 'invalid:Lean outputs for C.lean are not regular files.' });
      expect(compiled, label).not.toContain('D');
    }
    const root = project(), modules = graph(root), { builder, compiled } = makeBuilder(root);
    fs.writeFileSync(path.join(root, 'B.lean'), 'import A\ndef b := a + 1\n');
    const result = await builder.build(modules);
    expect(result).toMatchObject({ ok: false, module: { module: 'B' }, failure: 'invalid:Local module B.lean changed during verification.' });
    expect(compiled).not.toContain('B');
    await expect(builder.build(modules.slice(1))).rejects.toThrow('math_local_module_graph_incomplete');
  });

  it('succeeds without artifacts when the launcher writes no olean, and caches nothing', async () => {
    const root = project(), directory = path.join(temporary('lean-module-cache-'), 'cache');
    const { builder, compiled } = makeBuilder(root, { directory, secret: 'secret', environmentDigest: 'environment' }, { noOutput: true });
    const result = await builder.build(graph(root));
    expect(result.ok && result.modules.map(module => module.artifacts)).toEqual([[], [], [], [], []]);
    expect(compiled).toHaveLength(5);
    expect(fs.existsSync(directory)).toBe(false);
  });

  it('bounds the cache by recency and removes abandoned temporaries', async () => {
    const root = project(), directory = temporary('lean-module-cache-'), old = Date.now() / 1000 - 7200;
    for (let index = 0; index < 1030; index++) {
      const entry = path.join(directory, mathDigest(`fixture-${index}`));
      fs.mkdirSync(entry);
      fs.writeFileSync(path.join(entry, 'manifest.json'), '{}');
      fs.utimesSync(entry, old - index, old - index);
    }
    const stale = path.join(directory, `${mathDigest('stale')}.tmp-stale`), fresh = path.join(directory, `${mathDigest('fresh')}.tmp-fresh`);
    fs.mkdirSync(stale);
    fs.mkdirSync(fresh);
    fs.utimesSync(stale, old, old);
    await makeBuilder(root, { directory, secret: 'secret', environmentDigest: 'environment' }).builder.build(graph(root));
    const entries = fs.readdirSync(directory);
    expect(entries.filter(entry => /^[0-9a-f]{64}$/u.test(entry))).toHaveLength(1024);
    expect(entries).toContain(mathDigest('fixture-0'));
    expect(entries).not.toContain(mathDigest('fixture-1029'));
    expect(entries).not.toContain(path.basename(stale));
    expect(entries).toContain(path.basename(fresh));
  });
});
it.skipIf(!lean)('reuses real Lean artifacts across disposable roots', async () => {
  const root = project({ 'A.lean': 'def Fixture.a : Nat := 2\n',
    'B.lean': 'import A\ntheorem Fixture.b : Fixture.a + Fixture.a = 4 := rfl\n' });
  const modules = mathLocalModuleGraph(root, 'B.lean'), output: string[] = [];
  const run = (projectRoot: string, args: string[]) => {
    const result = spawnSync(lean!, args, { cwd: projectRoot, encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, LEAN_PATH: path.join(projectRoot, '.lake', 'build', 'lib', 'lean') } });
    output.push(result.stdout + result.stderr);
    return result;
  };
  const make = (cache?: LeanModuleHostCache) => createLeanModuleBuilder<string>({
    sourceProjectRoot: root, scratchRoot: temporary('lean-module-scratch-'), relativeProjectRoot: '',
    prepareProject: () => {}, invalid: message => message, hostCache: () => cache,
    compile: async (module, buildRoot) => {
      const stem = path.posix.join('.lake/build/lib/lean', module.module);
      fs.mkdirSync(path.join(buildRoot, '.lake', 'build', 'lib', 'lean'), { recursive: true });
      const result = run(buildRoot, ['-R', module.sourceRoot, '-o', `${stem}.olean`, module.file]);
      return result.status === 0 ? { ok: true as const } : { ok: false as const, failure: result.stderr };
    },
  });
  const cache = { directory: temporary('lean-module-cache-'), secret: 'secret', environmentDigest: lean! };
  const first = await make(cache).build(modules);
  expect(first.ok, output.join('\n')).toBe(true);
  const second = make(cache), restored = await second.build(modules);
  expect(restored.ok && restored.modules.map(module => module.origin)).toEqual(['cache', 'cache']);
  if (!restored.ok) return;
  const checked = await second.withProject([restored.modules[1]!],
    new Map([['Query.lean', Buffer.from('import B\n#print axioms Fixture.b\n')]]), async buildRoot => run(buildRoot, ['Query.lean']));
  expect(checked.status, output.join('\n')).toBe(0);
  expect(checked.stdout).toContain("'Fixture.b' does not depend on any axioms");
  const fresh = await make().build(modules);
  expect(fresh.ok && fresh.modules.map(module => module.artifacts)).toEqual(first.ok && first.modules.map(module => module.artifacts));
}, 120_000);
