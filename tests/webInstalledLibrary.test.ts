import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readWebConfig } from '../apps/web/config';
import { webLibraryCatalog } from '../apps/web/frozenLibrary';
import { createWebService } from '../apps/web/server';
import { installedLibraryDetail, installedLibraryDirectory, installedLibrarySource } from '../apps/web/installedLibrary';
import { installedLibraryLabels } from '../apps/web/installedLibraryLabels';
import { installedLibraryQuerySuggestions, matchesInstalledLibraryModuleAlias } from '../apps/web/installedLibrarySearch';
import { installedLibraryMathematics } from '../apps/web/installedLibraryMathematics';
import { matchesInstalledLibraryInterface } from '../apps/web/installedLibraryInterfaceSearch';
import { WebStorageError } from '../apps/web/storage';
import type { WebRunner } from '../apps/web/runner';
import type { InstalledLibraryDetail, InstalledLibraryDirectory, InstalledLibrarySource } from '../apps/web/installedLibraryTypes';
import { LIBRARY_PACK_SCHEMA } from '../src/math/libraryPacks';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { writeLibraryCatalog } from '../src/solver/libraryCatalog';

describe('browsing the installed Lean release without publishing research assets', () => {
  let root: string, base: string, service: ReturnType<typeof createWebService>;
  const run = vi.fn(() => { throw new Error('Browsing must not start a worker or model.'); });
  const check = vi.fn(() => { throw new Error('Browsing must not spawn Lean.'); });
  beforeEach(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-installed-library-')));
    run.mockClear(); check.mockClear();
    const reservation = net.createServer();
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
    const port = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>(resolve => reservation.close(() => resolve()));
    base = `http://127.0.0.1:${port}`;
    const runner: WebRunner = { readiness: async () => ({ ready: false, message: 'Read-only fixture' }), run, check };
    const config = { ...readWebConfig({ THEOREMOS_WEB_PUBLIC_URL: base, THEOREMOS_WEB_PORT: String(port) }),
      staticRoot: root, dataRoot: path.join(root, 'data') };
    service = createWebService(config, runner);
    await new Promise<void>(resolve => service.server.listen(port, '127.0.0.1', resolve));
  });
  afterEach(async () => {
    await service?.close();
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
    expect(run).not.toHaveBeenCalled(); expect(check).not.toHaveBeenCalled();
  });
  async function get<T>(route: string): Promise<T> {
    const response = await fetch(base + route);
    expect(response.status, await response.clone().text()).toBe(200);
    return response.json();
  }
  const route = '/api/research/library/installed';
  const moduleRoute = (file: string, digest: string) => `${route}/module?${new URLSearchParams({ file, catalogDigest: digest })}`;

  it('lists the actual release publicly when the research asset directory is empty', async () => {
    expect(await get('/api/research/library?type=mathematics')).toEqual({ items: [] });
    const catalog = webLibraryCatalog(), first = await get<InstalledLibraryDirectory>(route);
    expect(first.library).toMatchObject({ ...catalog.identity, moduleCount: 53, declarationCount: 1964 });
    expect(first.total).toBe(catalog.moduleCount);
    expect(first.items).toHaveLength(24);
    expect(first.nextOffset).toBe(24);
    const seen = [...first.items];
    let page = first;
    while (page.nextOffset !== undefined) {
      page = await get<InstalledLibraryDirectory>(`${route}?offset=${page.nextOffset}`);
      seen.push(...page.items);
    }
    expect(seen.map(item => item.file)).toEqual(catalog.moduleFiles);
    expect(new Set(seen.map(item => item.file)).size).toBe(53);
    expect(seen.reduce((sum, item) => sum + item.entryCount, 0)).toBe(1964);
    expect(seen.every(item => !('source' in item) && !('entries' in item))).toBe(true);
  });

  it('searches real declaration names and types, filters modules, and returns exact metadata and source', async () => {
    const name = 'TheoremOS.Algebra.FiniteSums.sum_forward_differences';
    const result = await get<InstalledLibraryDirectory>(`${route}?q=${name}&area=Algebra&environment=mathlib`);
    expect(result.total).toBe(1);
    const summary = result.items[0];
    expect(summary.preview.some(entry => entry.name === name)).toBe(true);
    const detailRoute = moduleRoute(summary.file, result.library.catalogDigest);
    const { item: detail } = await get<{ item: InstalledLibraryDetail }>(detailRoute);
    const module = webLibraryCatalog().readModule(summary.file);
    expect(detail.module.entries.some(entry => entry.name === name)).toBe(true);
    expect(detail.module.origin).toEqual(module.origin);
    expect(detail.module.import).toBe('import Submission.Library.TheoremOS.Algebra.FiniteSums');
    expect('source' in detail.module).toBe(false);
    const { item: source } = await get<{ item: InstalledLibrarySource }>(detailRoute + '&view=source');
    expect(source.source).toBe(module.source);
    expect(source.sourceDigest).toBe(mathDigest(module.source));
    expect(source.library.catalogDigest).toBe(result.library.catalogDigest);
    expect((await get<InstalledLibraryDirectory>(`${route}?area=Probability`)).items.every(item => item.area === 'Probability')).toBe(true);
    expect((await get<InstalledLibraryDirectory>(`${route}?environment=standard`)).total).toBe(0);
    expect((await get<InstalledLibraryDirectory>(`${route}?q=DefinitelyMissingModule`)).total).toBe(0);
  });

  it('finds modules by bilingual mathematical descriptions and keeps real interface previews', async () => {
    const catalog = webLibraryCatalog(), before = { ...catalog.identity };
    for (const file of catalog.moduleFiles) {
      const name = file.slice('Submission/Library/'.length, -'.lean'.length).replaceAll('/', '.');
      const labels = installedLibraryLabels(name);
      expect(labels, name).toBeDefined();
      expect(labels!.zh.title.trim()).not.toBe(''); expect(labels!.en.title.trim()).not.toBe('');
      expect(labels!.zh.description.trim()).not.toBe(''); expect(labels!.en.description.trim()).not.toBe('');
    }
    const result = await get<InstalledLibraryDirectory>(`${route}?${new URLSearchParams({ q: '有限和与差分' })}`);
    const summary = result.items.find(item => item.name === 'TheoremOS.Algebra.FiniteSums');
    expect(summary).toBeDefined(); expect(summary!.preview.length).toBeGreaterThan(0);
    const metadata = catalog.moduleMetadata(summary!.file);
    expect(summary!.preview).toEqual(metadata.entries.slice(0, 3));
    const englishTitle = installedLibraryLabels(summary!.name)!.en.title;
    const english = await get<InstalledLibraryDirectory>(`${route}?${new URLSearchParams({ q: englishTitle })}`);
    expect(english.items.some(item => item.file === summary!.file)).toBe(true);
    const { item: detail } = await get<{ item: InstalledLibraryDetail }>(moduleRoute(summary!.file, result.library.catalogDigest));
    expect(detail.module.entries).toEqual(metadata.entries);
    expect(detail.module.sha256).toBe(metadata.sha256); expect(catalog.identity).toEqual(before);
    expect(installedLibraryLabels('Demo.Identity')).toBeUndefined();
  });

  it('finds supported mathematical aliases and keeps real previews and frozen identities', async () => {
    const catalog = webLibraryCatalog(), before = { ...catalog.identity };
    const initial = await get<InstalledLibraryDirectory>(route);
    const examples: [string, string][] = [
      ['尾概率', 'TheoremOS.Probability.Concentration'],
      ['tail probability', 'TheoremOS.Probability.Concentration'],
      ['  TAIL   PROBABILITY  ', 'TheoremOS.Probability.Concentration'],
      ['如何估计随机变量的尾概率', 'TheoremOS.Probability.Concentration'],
      ['递推数列求和', 'TheoremOS.Algebra.FiniteSums'],
      ['求递推数列的和', 'TheoremOS.Algebra.FiniteSums'],
      ['如何 求 数列 递推 的 和', 'TheoremOS.Algebra.FiniteSums'],
      ['数列 求和 递推', 'TheoremOS.Algebra.FiniteSums'],
      ['尾概率 独立', 'TheoremOS.Probability.Concentration'],
      ['独立随机变量的尾部概率', 'TheoremOS.Probability.Concentration'],
      ['independent tail bounds', 'TheoremOS.Probability.Concentration'],
      ['sums of recurrences', 'TheoremOS.Algebra.FiniteSums'],
      ['recurrence sums', 'TheoremOS.Algebra.FiniteSums'],
      ['拉格朗日插值', 'TheoremOS.Algebra.PolynomialRoots'],
      ['詹森不等式', 'TheoremOS.Analysis.FiniteConvexity'],
      ['柯西-施瓦茨不等式', 'TheoremOS.Analysis.FiniteInequalities'],
      ['Cauchy-Schwarz inequality', 'TheoremOS.Analysis.FiniteInequalities'],
      ['鸽巢原理', 'TheoremOS.Combinatorics.FiniteCounting'],
      ['Levenshtein distance', 'TheoremOS.Combinatorics.EditDistance'],
      ['KL divergence', 'TheoremOS.InformationTheory.Divergence'],
      ['CRT', 'TheoremOS.NumberTheory.Congruences'],
      ['切比雪夫不等式', 'TheoremOS.Probability.FiniteProbability'],
    ];
    for (const [q, name] of examples) {
      expect(matchesInstalledLibraryModuleAlias(name, q), q).toBe(true);
      const result = await get<InstalledLibraryDirectory>(`${route}?${new URLSearchParams({ q })}`);
      if (q.trim().toLowerCase().replace(/\s+/gu, ' ') === 'tail probability') expect(result.items[0].name, q).toBe('TheoremOS.Probability.Concentration');
      const summary = result.items.find(item => item.name === name);
      expect(summary, q).toBeDefined(); expect(summary!.preview.length, q).toBeGreaterThan(0);
      const metadata = catalog.moduleMetadata(summary!.file);
      for (const entry of summary!.preview) expect(metadata.entries, q).toContainEqual(entry);
      expect(result.library, q).toEqual(initial.library);
      if (['尾概率', 'tail probability', '如何估计随机变量的尾概率', '递推数列求和'].includes(q)) {
        // English tokens may also match existing declaration substrings such as detailedBalance.
        if (q !== 'tail probability') expect(result.total, q).toBe(1);
        expect(summary!.preview, q).toEqual(metadata.entries.slice(0, 3));
        const { item: detail } = await get<{ item: InstalledLibraryDetail }>(moduleRoute(summary!.file, result.library.catalogDigest));
        expect(detail.module.entries, q).toEqual(metadata.entries);
        const { item: source } = await get<{ item: InstalledLibrarySource }>(moduleRoute(summary!.file, result.library.catalogDigest) + '&view=source');
        expect(source.source, q).toBe(catalog.readModule(summary!.file).source);
        expect(source.sourceDigest, q).toBe(metadata.sha256);
      }
    }
    expect(initial.library).toMatchObject({ moduleCount: 53, declarationCount: 1964 });
    expect(catalog.identity).toEqual(before);
    expect((await get<InstalledLibraryDirectory>(`${route}?${new URLSearchParams({ q: '尾概率', area: 'Algebra' })}`)).total).toBe(0);
    expect((await get<InstalledLibraryDirectory>(`${route}?${new URLSearchParams({ q: '尾概率', environment: 'standard' })}`)).total).toBe(0);
  });

  it('keeps all literal tokens and does not treat arbitrary questions or unknown modules as aliases', async () => {
    for (const q of ['tail probability DefinitelyMissingDeclaration', '递推数列求和 DefinitelyMissingDeclaration', '尾概率 独立 缺失词',
      '求递推数列的和 缺失词', 'independent tail bounds DefinitelyMissingDeclaration', '请为我证明所有数学问题']) {
      expect(matchesInstalledLibraryModuleAlias('TheoremOS.Probability.Concentration', q), q).toBe(false);
      expect(matchesInstalledLibraryModuleAlias('TheoremOS.Algebra.FiniteSums', q), q).toBe(false);
      expect((await get<InstalledLibraryDirectory>(`${route}?${new URLSearchParams({ q })}`)).total, q).toBe(0);
    }
    expect(matchesInstalledLibraryModuleAlias('Demo.Identity', '尾概率')).toBe(false);
    expect(matchesInstalledLibraryModuleAlias('constructor', 'tail probability')).toBe(false);
    expect(matchesInstalledLibraryModuleAlias('TheoremOS.Probability.Concentration', '')).toBe(false);
    const name = 'TheoremOS.Algebra.FiniteSums.sum_forward_differences';
    const exact = await get<InstalledLibraryDirectory>(`${route}?${new URLSearchParams({ q: `${name} AddCommGroup` })}`);
    expect(exact.total).toBe(1);
    expect(exact.items[0].preview.some(entry => entry.name === name && entry.type.includes('AddCommGroup'))).toBe(true);
    expect((await get<InstalledLibraryDirectory>(`${route}?${new URLSearchParams({ q: `${name} DefinitelyMissingDeclaration` })}`)).total).toBe(0);
    expect(matchesInstalledLibraryModuleAlias('TheoremOS.Algebra.FiniteSums', '尾概率 递推')).toBe(false);
    expect(matchesInstalledLibraryModuleAlias('TheoremOS.Probability.Concentration', '尾概率 递推')).toBe(false);
    const suggestions = installedLibraryQuerySuggestions('求递推数列的和 缺失词');
    expect(suggestions[0].zh).toBe('递推数列求和');
    for (const suggestion of [...suggestions, ...installedLibraryQuerySuggestions('unknown query')]) {
      expect(installedLibraryDirectory({ q: suggestion.zh }).total).toBeGreaterThan(0);
      expect(installedLibraryDirectory({ q: suggestion.en }).total).toBeGreaterThan(0);
    }
  });

  it('explains every real interface from its header and gives exact minimal Lean usage', () => {
    const catalog = webLibraryCatalog(), before = { ...catalog.identity };
    let count = 0;
    for (const file of catalog.moduleFiles) {
      const module = installedLibraryDetail(file, catalog.identity.catalogDigest).module;
      for (const entry of module.entries) {
        const explanation = installedLibraryMathematics(entry, module.import);
        expect(explanation.summary.zh.trim(), entry.name).not.toBe('');
        expect(explanation.summary.en.trim(), entry.name).not.toBe('');
        expect(explanation.expression.trim(), entry.name).not.toBe('');
        expect(explanation.context.zh, entry.name).toContain('模块');
        expect(explanation.context.en, entry.name).toContain('module context');
        expect(explanation.usage, entry.name).toBe(`${module.import}\n\n#check ${entry.name}\n#check @${entry.name}`);
        for (const condition of explanation.conditions) {
          expect(condition.expression.trim(), entry.name).not.toBe('');
          expect(condition.meaning.zh.trim(), entry.name).not.toBe('');
          expect(condition.meaning.en.trim(), entry.name).not.toBe('');
        }
        count++;
      }
    }
    expect(count).toBe(1964); expect(catalog.identity).toEqual(before);
    const sums = installedLibraryDetail('Submission/Library/TheoremOS/Algebra/FiniteSums.lean', catalog.identity.catalogDigest).module;
    const telescoping = installedLibraryMathematics(sums.entries.find(entry => entry.name.endsWith('.sum_forward_differences'))!, sums.import);
    expect(telescoping.summary.zh).toContain('望远镜求和');
    expect(telescoping.conditions.map(condition => condition.expression)).toEqual(['Type*', 'AddCommGroup A', 'ℕ → A', 'ℕ']);
    expect(telescoping.expression).toBe('(∑ k ∈ range n, (f (k + 1) - f k)) = f n - f 0');
    const recurrence = installedLibraryMathematics(sums.entries.find(entry => entry.name.endsWith('.affine_recurrence_closed'))!, sums.import);
    expect(recurrence.conditions.some(condition => condition.expression === 'a ≠ 1')).toBe(true);
    expect(recurrence.conditions.some(condition => condition.expression === '∀ k < n, f (k + 1) = a * f k + b')).toBe(true);
    expect(recurrence.summary.zh).toContain('不等于 1');
    const all = catalog.moduleFiles.flatMap(file => catalog.moduleMetadata(file).entries);
    const matching = installedLibraryMathematics(all.find(entry => entry.name === 'TheoremOS.Combinatorics.LooplessMultigraph.Matching')!, 'import Submission.Library.TheoremOS.Combinatorics.PerfectMatching');
    expect(matching.expression).toBe('{M : Finset E // G.IsPerfectMatching M}');
    expect(matching.summary.zh).toContain('每个顶点恰好');
    const subgaussian = installedLibraryMathematics(all.find(entry => entry.name === 'TheoremOS.Probability.sum_filter_le_of_subgaussian')!, 'import Submission.Library.TheoremOS.Probability.Concentration');
    expect(subgaussian.conditions.some(condition => condition.expression.startsWith('∀ t, 0 ≤ t →'))).toBe(true);
    expect(subgaussian.expression).toBe('∑ i with u ≤ Y i, w i ≤ exp (-(u ^ 2 / (2 * c)))');
  });

  it('searches the displayed mathematics locally while preserving precise original interface queries', () => {
    const catalog = webLibraryCatalog();
    const sums = installedLibraryDetail('Submission/Library/TheoremOS/Algebra/FiniteSums.lean', catalog.identity.catalogDigest).module;
    const telescoping = sums.entries.find(entry => entry.name.endsWith('.sum_forward_differences'))!;
    for (const query of ['望远镜', 'telescoping', '加法交换群', 'additive commutative group', '首项',
      'sum_forward_differences AddCommGroup', '前 n 个相邻差']) {
      expect(matchesInstalledLibraryInterface(telescoping, sums.import, query), query).toBe(true);
    }
    expect(matchesInstalledLibraryInterface(telescoping, sums.import, '不相等')).toBe(false);
    expect(matchesInstalledLibraryInterface(telescoping, sums.import, '望远镜 DefinitelyMissingToken')).toBe(false);
    expect(matchesInstalledLibraryInterface(telescoping, sums.import, telescoping.description)).toBe(true);
    const concentration = installedLibraryDetail('Submission/Library/TheoremOS/Probability/Concentration.lean', catalog.identity.catalogDigest).module;
    const hoeffding = concentration.entries.find(entry => entry.name === 'TheoremOS.Probability.sum_biasedMass_hoeffding')!;
    for (const query of ['独立 随机子集', 'Hoeffding upper-tail', '非严格界', '0 ≤ p', 'sum_biasedMass_hoeffding biasedMass'])
      expect(matchesInstalledLibraryInterface(hoeffding, concentration.import, query), query).toBe(true);
    expect(matchesInstalledLibraryInterface(hoeffding, concentration.import, '独立 DefinitelyMissingToken')).toBe(false);
  });

  it('rejects changed or missing identities and invalid requests instead of silently displaying an empty library', async () => {
    const directory = await get<InstalledLibraryDirectory>(route), file = directory.items[0].file;
    expect((await fetch(base + moduleRoute(file, 'a'.repeat(64)))).status).toBe(409);
    expect((await fetch(base + `${route}/module?file=${encodeURIComponent(file)}`)).status).toBe(400);
    expect((await fetch(base + moduleRoute('../outside.lean', directory.library.catalogDigest))).status).toBe(404);
    expect((await fetch(base + `${route}?offset=-1`)).status).toBe(400);
    expect((await fetch(base + `${route}?limit=0`)).status).toBe(400);
    vi.stubEnv('THEOREMOS_LIBRARY_CATALOG', path.join(root, 'not-present.json'));
    vi.stubEnv('THEOREMOS_LIBRARY_CATALOG_SHA256', 'a'.repeat(64));
    const response = await fetch(base + route);
    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain('目录读取失败');
  });

  it('browses a configured pinned release without opening its missing source objects', () => {
    const file = 'Submission/Library/Demo/Identity.lean', source = 'namespace Demo\nlemma identity (n : Nat) : n = n := by rfl\nend Demo\n';
    const built = writeLibraryCatalog(path.join(root, 'release'), { id: 'example/installed', revision: 'v1', environment: 'mathlib',
      packs: [{ schema: LIBRARY_PACK_SCHEMA, modules: [{ file, source,
        origin: { kind: 'upstream', repository: 'offline-fixture', commit: 'a'.repeat(40), file: 'Identity.lean' } }] }] });
    fs.rmSync(path.join(root, 'release', 'objects'), { recursive: true });
    vi.stubEnv('THEOREMOS_LIBRARY_CATALOG', built.file);
    vi.stubEnv('THEOREMOS_LIBRARY_CATALOG_SHA256', built.digest);
    const directory = installedLibraryDirectory();
    expect(directory.library.id).toBe('example/installed');
    expect(directory.items[0].preview[0].name).toBe('Demo.identity');
    expect(installedLibraryDirectory({ q: '尾概率' }).total).toBe(0);
    expect(installedLibraryDirectory({ q: 'Demo.identity' }).items[0].preview[0].name).toBe('Demo.identity');
    expect(installedLibraryDetail(file, built.digest).module.entries).toHaveLength(1);
    let error: unknown;
    try { installedLibrarySource(file, built.digest); } catch (cause) { error = cause; }
    expect(error).toBeInstanceOf(WebStorageError);
    expect((error as WebStorageError).status).toBe(503);
  });
});
