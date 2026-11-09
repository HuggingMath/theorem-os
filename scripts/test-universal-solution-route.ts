#!/usr/bin/env bun
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Page } from 'playwright';
import type { SolutionRouteInput, SolutionRouteNode } from '../apps/web/solutionRoute';
import type { ArchiveCatalog } from '../docs/web/types';

// An unseen problem: no walkthrough, model calls, solver, Lean or application API.
// Exercise the public shared renderer under the actual archive stylesheet.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.env.SOLUTION_ROUTE_TEST_OUTPUT ?? path.join(root, 'out/universal-solution-route'));
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'theoremos-universal-route-'));
await fs.mkdir(output, { recursive: true });
const choose = (locale: 'zh' | 'en', zh: string, en: string) => locale === 'zh' ? zh : en;

function fixture(locale: 'zh' | 'en'): SolutionRouteInput {
  const t = (zh: string, en: string) => choose(locale, zh, en);
  const node = (id: string, kind: SolutionRouteNode['kind'], zh: string, en: string,
    extra: Partial<SolutionRouteNode> = {}): SolutionRouteNode => ({ id, kind, title: t(zh, en), status: 'passed', ...extra });
  const longResearch = Array.from({ length: 28 }, (_, i) => t(
    `推导 ${i + 1}：由非负性和归一化条件，先固定有限指标集，再对每个项应用局部估计。必须保留分母严格为正这一条件，才能把当前不等式交给下一个求和步骤。`,
    `Derivation ${i + 1}: Fix a finite index set using nonnegativity and normalization, then apply the local estimate term by term. Keep the denominator strictly positive so the next summation step can use this inequality.`)).join('\n\n')
    + '\n\nresearch-marker-terminus: bound-body-only.\n\n' + t('因此得到 $a_n \\le \\frac{1}{n+1}$，将它代入有限和即可接到合并任务。', 'Thus $a_n \\le \\frac{1}{n+1}$, which feeds directly into the finite-sum assembly task.');
  const normalized = t('把原变量化成可逐项估计的形式。', 'Put the variables in a form suitable for a termwise bound.');
  const fixedSource = 'theorem local_bound (hpos : 0 < denominator) : term ≤ bound := by\n  exact reciprocal_bound hpos';
  const longSource = Array.from({ length: 64 }, (_, index) => `-- saved source line ${index + 1}: $literal$ remains code`).join('\n');
  return {
    id: `unseen-finite-estimate-${locale}`, title: t('有限和估计：完整研究路线', 'Finite sum estimate: complete research route'), locale,
    goal: node('goal', 'problem', '从约束推出有限和上界', 'Derive the finite-sum bound', {
      summary: t('给定 $a_n \\ge 0$，说明每条支路怎样共同推出目标。', 'Given $a_n \\ge 0$, show how both branches establish the goal.'),
      sections: [{ title: t('已知条件与待证结论', 'Assumptions and goal'), text: t('先分别归一化和证明局部界，再合并得到有限和估计。所有过程均保留原始记录。', 'Normalize and prove the local bound separately, then assemble the finite-sum estimate. Every original record remains available.') }],
    }),
    tasks: [
      { ...node('normalize', 'task', '归一化并检查正性', 'Normalize and establish positivity', { summary: `  ${normalized}\n`,
        sections: [{ title: t('归一化目标', 'Normalization goal'), text: normalized }] }), dependencies: [] },
      { ...node('bound', 'task', '证明每一项的局部界', 'Prove the termwise local bound', { summary: t('先处理分母，再应用单调性；失败尝试已修订。', 'Handle the denominator before monotonicity; the failed attempt was revised.'),
        sections: [{ title: t('完整推导与下一步接口', 'Full derivation and what the next step uses'), text: longResearch },
          { title: t('局部结论', 'Local conclusion'), text: t('得到 $a_n \\le \\frac{1}{n+1}$。', 'Obtain $a_n \\le \\frac{1}{n+1}$.') },
          { title: t('送给下一步的条件', 'Conditions supplied to the next step'), text: t('逐项界和正性均已保留。\n\n下一步对有限指标集求和。', 'The pointwise bound and positivity are retained.\n\nThe next step sums over the finite index set.') },
          { title: t('保存的代码', 'Saved code'), text: longSource, code: true }] }), dependencies: [] },
      { ...node('assemble', 'task', '把两条支路合并为有限和', 'Combine both branches into the finite sum', { summary: t('同时使用归一化条件和局部界，不省略求和条件。', 'Use normalization and the local bound together, retaining the summation conditions.'),
        sections: [{ title: t('怎样连接前后两步', 'How this connects the preceding and following steps'), text: t('归一化任务提供正性，局部界任务提供逐项不等式。应用有限和单调性，得到主定理，随后送交独立验收。', 'Normalization supplies positivity; the bound task supplies the pointwise inequality. Finite-sum monotonicity yields the theorem for independent acceptance.') }],
      }), dependencies: ['normalize', 'bound'] },
    ],
    records: [
      node('plan', 'plan', '拆成两条可并行检查的支路', 'Split the work into two independently checked branches', { parentId: 'goal', status: 'recorded', at: '2026-11-09T01:00:00Z' }),
      node('normalization-finding', 'finding', '归一化变量保持严格正性', 'Normalized variables remain strictly positive', { parentId: 'normalize', at: '2026-11-09T01:01:00Z', sections: [{ title: t('推导', 'Derivation'), text: t('由原假设 $x>0$ 与 $c>0$，得到 $x/c>0$。这正是后续取倒数所需的前提。', 'From $x>0$ and $c>0$, obtain $x/c>0$. This supplies the hypothesis needed before taking reciprocals.') }] }),
      node('attempt-failed', 'attempt', '直接取倒数的第一次尝试', 'First attempt: take reciprocals directly', { parentId: 'bound', status: 'failed', at: '2026-11-09T01:02:00Z', summary: t('未显式给出分母的正性。', 'Strict positivity of the denominator was missing.') }),
      node('check-failed', 'check', '检查指出缺少正性前提', 'Check identifies the missing positivity hypothesis', { parentId: 'bound', status: 'failed', at: '2026-11-09T01:03:00Z', sections: [{ title: t('检查诊断', 'Check diagnosis'), text: 'unsolved goals\n⊢ 0 < denominator', code: true }] }),
      node('human-choice', 'decision', '选择补充正性引理后继续', 'Choose to add a positivity lemma before continuing', { parentId: 'bound', status: 'human', at: '2026-11-09T01:04:00Z', sections: [{ title: t('人的决定及其影响', 'Human decision and its effect'), text: t('审核者选择保留当前路线，要求先复用归一化支路的正性结论；后续证明依照这一决定修订。', 'The reviewer kept this approach and required reuse of positivity from the normalization branch; the next proof was revised accordingly.') }] }),
      node('attempt-fixed', 'attempt', '加入正性前提并修订证明', 'Revise the proof with explicit positivity', { parentId: 'bound', at: '2026-11-09T01:05:00Z', summary: fixedSource, source: { name: 'Submission.lean', sha256: 'e'.repeat(64), commit: 'fixture-immutable-source', line: 12, endLine: 18 }, action: { label: t('查看该次源码', 'Read this source revision'), target: 'source:immutable:attempt-fixed' }, sections: [{ title: t('修订后的源码', 'Revised source'), text: fixedSource, code: true }] }),
      node('check-passed', 'check', '修订版本通过局部检查', 'Revised version passes the local check', { parentId: 'bound', at: '2026-11-09T01:06:00Z', summary: 'kernel_verified: fixture receipt' }),
      node('proof-step', 'derivation', '证明块：先把正性送入取倒数引理', 'Proof block: supply positivity to the reciprocal lemma', { parentId: 'attempt-fixed', sections: [{ title: t('对应证明块', 'Corresponding proof block'), text: 'have hreciprocal := reciprocal_bound hpos\nexact hreciprocal', code: true }] }),
      node('proof-step-explanation', 'finding', '这段代码为什么能够接到下一步', 'Why this block supplies the next step', { parentId: 'proof-step', summary: 'nested-body-search-marker', sections: [{ title: t('代码与推导的联系', 'Connection between the code and the derivation'), text: t('前一步给出严格正性，取倒数引理将它转为所需局部界 $u \\le v$；主任务随后对这一界逐项求和。', 'The preceding step gives strict positivity. The reciprocal lemma turns it into the local bound $u \\le v$, which the main task sums term by term.') }] }),
      node('proof', 'proof', '接入主定理的完整证明', 'Complete proof integrated into the theorem', { at: '2026-11-09T01:07:00Z', sections: [{ title: t('整合结果', 'Integrated result'), text: t('两条任务结论均已接入同一主定理版本。', 'Both task results are integrated into the same theorem revision.') }] }),
      node('review', 'review', '审阅确认条件全部保留', 'Review confirms that every hypothesis is retained', { at: '2026-11-09T01:08:00Z' }),
      node('acceptance', 'acceptance', '固定版本的独立验收', 'Independent acceptance of the fixed revision', { at: '2026-11-09T01:09:00Z', sections: [{ title: t('独立验收记录', 'Independent acceptance receipt'), text: 'evaluated_passed\nsource sha256: ' + 'e'.repeat(64), code: true }] }),
    ],
    outcome: node('outcome', 'outcome', '有限和上界已通过本地验收', 'Finite-sum bound passes local acceptance', { summary: t('记录失败、人的选择、修订和最终验收之间的完整联系。', 'Keep the full connection between failure, human choice, revision and final acceptance.') }),
  };
}

const bundle = await build({
  stdin: { contents: `import {buildSolutionRoute} from './apps/web/solutionRoute';
    import {mountSolutionRoute} from './apps/web/solutionRouteView';
    const locale = new URL(location.href).searchParams.get('locale') === 'en' ? 'en' : 'zh';
    const fixtures = ${JSON.stringify({ zh: fixture('zh'), en: fixture('en') })};
    let model = buildSolutionRoute(fixtures[locale]);
    const events = { selected: [], opened: [] };
    const root = document.querySelector('#route');
    const controller = mountSolutionRoute(root, model, {onSelect:id=>events.selected.push(id), onOpen:target=>events.opened.push(target)});
    window.routeFixture = {model, events, controller, update() { model = {...model, nodes:model.nodes.map(node=>({...node}))}; controller.update(model); },
      destroy() { window.detachedRouteButton = root.querySelector('[data-solution-node]'); controller.destroy(); }};
    window.fixtureReady = true;`, resolveDir: root, sourcefile: 'universal-route-fixture.ts', loader: 'ts' },
  bundle: true, format: 'iife', target: 'es2022', platform: 'browser', jsx: 'automatic', jsxImportSource: 'preact', write: false,
});
await fs.writeFile(path.join(temporary, 'fixture.js'), bundle.outputFiles[0]!.contents);

const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/site.css"><link rel="stylesheet" href="/route.css"><link rel="stylesheet" href="/math.css"><style>.fixture-shell{max-width:1240px;margin:0 auto;padding:24px}.fixture-shell>p{margin-bottom:12px;color:#777568}@media(max-width:520px){.fixture-shell{padding:12px}}</style></head><body><div class="fixture-shell"><p>TheoremOS · Universal route interaction fixture</p><div id="route"></div></div><script src="/fixture.js"></script></body></html>`;
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://fixture').pathname);
    if (pathname === '/' || pathname === '/fixture.html') { res.writeHead(200, { 'content-type': 'text/html;charset=utf-8' }); res.end(html); return; }
    const archivePrefix = ['/site/', '/classics/'].find(prefix => pathname.startsWith(prefix));
    if (archivePrefix) {
      const base = path.join(root, archivePrefix === '/site/' ? 'out/site' : 'out/web/classics');
      const file = path.resolve(base, pathname.slice(archivePrefix.length));
      if (!file.startsWith(base + path.sep)) { res.writeHead(404); res.end(); return; }
      const data = await fs.readFile(file);
      const mime: Record<string, string> = { '.html': 'text/html;charset=utf-8', '.js': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };
      res.writeHead(200, { 'content-type': mime[path.extname(file)] ?? 'text/plain' }); res.end(data); return;
    }
    const mappings: Record<string, string> = { '/fixture.js': path.join(temporary, 'fixture.js'), '/site.css': path.join(root, 'docs/site.css'), '/route.css': path.join(root, 'apps/web/solutionRoute.css'), '/math.css': path.join(root, 'apps/web/math.css'), '/math.js': path.join(root, 'out/web/math.js') };
    const file = mappings[pathname] ?? (pathname.startsWith('/assets/fonts/') ? path.join(root, 'docs', pathname)
      : pathname.startsWith('/assets/katex/') ? path.join(root, 'out/web', pathname) : undefined);
    if (!file || (pathname.includes('..'))) { res.writeHead(404); res.end(); return; }
    const data = await fs.readFile(file);
    res.writeHead(200, { 'content-type': file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'font/woff2' }); res.end(data);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address(); assert.ok(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });
type Result = { name: string; pass: boolean; detail?: unknown };
const report: { cases: { locale: string; width: number; checks: Result[]; screenshots: string[] }[]; archives: unknown[]; errors: string[]; blockedRequests: string[] } = { cases: [], archives: [], errors: [], blockedRequests: [] };
const selected = (page: Page) => page.locator('[data-solution-node][aria-pressed="true"]').getAttribute('data-solution-node');
const search = (page: Page) => page.locator('[data-solution-search]');
const viewport = (page: Page) => page.locator('.solution-route-viewport');

async function readBuiltArchive(directory: string): Promise<ArchiveCatalog> {
  const catalog = JSON.parse(await fs.readFile(path.join(root, directory, 'data/catalog.json'), 'utf8')) as ArchiveCatalog;
  for (const record of catalog.records) {
    const source = await fs.readFile(path.join(root, directory, 'data/process', `${record.id}.js`), 'utf8');
    const prefix = `(window.theoremosProcesses??={})[${JSON.stringify(record.id)}]=`;
    assert.ok(source.startsWith(prefix) && source.endsWith(';\n'), `Unexpected static process assignment for ${record.id}`);
    record.process = JSON.parse(source.slice(prefix.length, -2));
    assert.ok(record.process?.sourceRoute, `Missing lazy source route for ${record.id}`);
  }
  return catalog;
}

try {
  if (!process.argv.includes('--archives-only')) for (const locale of ['zh', 'en'] as const) for (const width of [1440, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: locale === 'zh' ? 'zh-CN' : 'en-US', reducedMotion: 'reduce' });
    await context.route('**/*', async route => {
      const request = route.request();
      if (!request.url().startsWith(origin + '/') || !['GET', 'HEAD'].includes(request.method()) || new URL(request.url()).pathname.startsWith('/api/')) {
        report.blockedRequests.push(`${request.method()} ${request.url()}`); await route.abort();
      } else await route.continue();
    });
    const page = await context.newPage(); page.setDefaultTimeout(4000);
    page.on('pageerror', error => report.errors.push(`${locale}/${width}: ${error.message}`));
    const current = { locale, width, checks: [] as Result[], screenshots: [] as string[] }; report.cases.push(current);
    const check = async (name: string, action: () => Promise<unknown>) => {
      try { const detail = await action(); current.checks.push({ name, pass: true, ...(detail === undefined ? {} : { detail }) }); }
      catch (error) {
        current.checks.push({ name, pass: false, detail: error instanceof Error ? error.message : String(error) });
        const file = path.join(output, `${locale}-${width}-failure-${current.checks.length}.png`);
        await page.screenshot({ path: file, fullPage: true }); current.screenshots.push(file);
      }
    };
    const screenshot = async (name: string) => {
      const file = path.join(output, `${locale}-${width}-${name}.png`);
      await page.screenshot({ path: file, fullPage: true }); current.screenshots.push(file);
    };
    await page.goto(`${origin}/fixture.html?locale=${locale}`); await page.waitForFunction(() => (window as any).fixtureReady);
    await page.evaluate(() => document.fonts.ready);
    await check('Unseen problem has every main task and acceptance without a walkthrough', async () => {
      const ids = await page.locator('[data-solution-node]').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.solutionNode));
      assert.deepEqual(new Set(ids), new Set(['goal', 'normalize', 'bound', 'assemble', 'proof', 'review', 'acceptance', 'outcome']));
      const data = await page.evaluate(() => (window as any).routeFixture.model);
      assert.ok(!JSON.stringify(data).includes('walkthrough'));
      assert.ok(data.edges.some((edge: any) => edge.from === 'normalize' && edge.to === 'assemble' && edge.kind === 'dependency'));
      assert.ok(data.edges.some((edge: any) => edge.from === 'bound' && edge.to === 'assemble' && edge.kind === 'dependency'));
      return { nodes: data.nodes.length, visible: ids.length, edges: data.edges.length };
    });
    await check('Archive stylesheet leaves the full SVG canvas and visible connections intact', async () => {
      const size = await page.locator('.solution-route-lines').evaluate(svg => ({ width: svg.getBoundingClientRect().width, height: svg.getBoundingClientRect().height, declaredWidth: Number(svg.getAttribute('width')), declaredHeight: Number(svg.getAttribute('height')), paths: svg.querySelectorAll(':scope > path').length }));
      assert.equal(size.width, size.declaredWidth, JSON.stringify(size)); assert.equal(size.height, size.declaredHeight, JSON.stringify(size)); assert.ok(size.paths > 5); return size;
    });
    await screenshot('initial');
    await check('Clicking a task opens its full reasoning, rendered mathematics and both connections', async () => {
      await page.locator('[data-solution-node="bound"]').click();
      assert.equal(await selected(page), 'bound');
      const detail = await page.locator('[data-solution-inspector]').innerText();
      assert.ok(detail.includes('research-marker-terminus')); assert.ok(detail.length > 1500);
      assert.ok(await page.locator('[data-solution-inspector] .math').count() > 0);
      assert.ok(await page.locator('[data-solution-select="goal"]').count() > 0);
      assert.ok(await page.locator('[data-solution-select="assemble"]').count() > 0);
      return { detailCharacters: detail.length };
    });
    await check('Dependency and next-step buttons navigate to the actual connected steps', async () => {
      await page.locator('[data-solution-select="assemble"]').click(); assert.equal(await selected(page), 'assemble');
      await page.locator('[data-solution-select="normalize"]').click(); assert.equal(await selected(page), 'normalize');
    });
    await check('Reading mode keeps every section, removes only duplicate summaries and returns to the map', async () => {
      await page.locator('[data-solution-node="bound"]').click();
      await page.locator('.solution-route-read').click();
      assert.equal(await page.locator('.solution-route').getAttribute('data-solution-reading'), 'true');
      assert.equal(await page.locator('.solution-route-viewport').isVisible(), false);
      assert.equal(await page.locator('[data-solution-section]').count(), 4);
      assert.equal(await page.locator('[data-solution-inspector] .solution-route-section').count(), 4);
      assert.ok(await page.locator('[data-solution-inspector] .solution-route-prose > p').count() > 20);
      assert.equal(await page.locator('[data-solution-inspector] pre').count(), 1);
      await page.locator('[data-solution-section="2"]').click();
      assert.equal(await page.locator('[data-solution-section-heading="2"]').evaluate(element => document.activeElement === element), true);
      await page.locator('[data-solution-reader-select]').selectOption('normalize');
      assert.equal(await selected(page), 'normalize');
      assert.equal(await page.locator('.solution-route-summary').count(), 0);
      assert.equal(await page.locator('.solution-route-section').count(), 1);
      await page.locator('[data-solution-reader-select]').selectOption('attempt-fixed');
      assert.equal(await page.locator('.solution-route-summary').count(), 1, 'code section must remain distinct from its summary');
      assert.equal(await page.locator('.solution-route-section pre').count(), 1);
      await page.locator('[data-solution-reader-select]').selectOption('bound');
      await page.locator('[data-solution-expand]').click();
      assert.equal(await page.locator('#route').getAttribute('role'), 'dialog');
      const scroll = await page.locator('.solution-route-workspace').evaluate(workspace => {
        workspace.scrollTop = 500;
        return { client: workspace.clientHeight, scroll: workspace.scrollHeight, top: workspace.scrollTop };
      });
      assert.ok(scroll.scroll > scroll.client && scroll.top > 0, JSON.stringify(scroll));
      await page.evaluate(() => (window as any).routeFixture.update());
      assert.equal(await page.locator('.solution-route').getAttribute('data-solution-reading'), 'true');
      assert.ok(await page.locator('.solution-route-workspace').evaluate(workspace => workspace.scrollTop > 0));
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('[data-solution-expanded="false"]').count(), 1);
      await page.locator('[data-solution-view="map"]').click();
      assert.equal(await page.locator('.solution-route').getAttribute('data-solution-reading'), 'false');
      assert.equal(await selected(page), 'bound');
      if (await page.locator('[data-solution-all]').getAttribute('aria-pressed') === 'true') await page.locator('[data-solution-all]').click();
    });
    await check('Expand and collapse expose failed attempts, revision, checks and human decision', async () => {
      await page.locator('[data-solution-all]').click(); assert.equal(await page.locator('[data-solution-node]').count(), 17);
      for (const id of ['attempt-failed', 'check-failed', 'human-choice', 'attempt-fixed', 'check-passed']) assert.equal(await page.locator(`[data-solution-node="${id}"]`).count(), 1);
      await page.locator('[data-solution-node="human-choice"]').click();
      assert.ok((await page.locator('[data-solution-inspector]').innerText()).includes(choose(locale, '人的决定及其影响', 'Human decision and its effect')));
      await page.locator('[data-solution-all]').click(); assert.equal(await page.locator('[data-solution-node]').count(), 8);
    });
    await check('Local expansion and collapse retain nested proof context without opening unrelated branches', async () => {
      await page.locator('[data-solution-node="bound"]').click();
      await page.locator('[data-solution-children="bound"]').click();
      assert.equal(await page.locator('[data-solution-node="attempt-fixed"]').count(), 1);
      assert.equal(await page.locator('[data-solution-node="proof-step"]').count(), 0);
      assert.equal(await page.locator('[data-solution-node="normalization-finding"]').count(), 0);
      await page.locator('[data-solution-node="attempt-fixed"]').click();
      await page.locator('[data-solution-children="attempt-fixed"]').click();
      assert.equal(await page.locator('[data-solution-node="proof-step"]').count(), 1);
      assert.equal(await page.locator('[data-solution-node="proof-step-explanation"]').count(), 0);
      await page.locator('[data-solution-node="proof-step"]').click();
      await page.locator('[data-solution-children="proof-step"]').click();
      const nesting = await page.locator('[data-solution-node="proof-step-explanation"]').boundingBox();
      const owner = await page.locator('[data-solution-node="proof-step"]').boundingBox();
      assert.ok(nesting && owner && nesting.y >= owner.y + owner.height, JSON.stringify({ nesting, owner }));
      assert.ok(await page.locator('[data-solution-node]').count() < 17);
      await page.locator('[data-solution-node="attempt-fixed"]').click();
      await page.locator('[data-solution-children="attempt-fixed"]').click();
      assert.equal(await page.locator('[data-solution-node="proof-step"]').count(), 0);
      assert.equal(await page.locator('[data-solution-node="proof-step-explanation"]').count(), 0);
      await search(page).fill('nested-body-search-marker');
      for (const id of ['bound', 'attempt-fixed', 'proof-step', 'proof-step-explanation']) assert.equal(await page.locator(`[data-solution-node="${id}"]`).count(), 1);
      assert.equal(await page.locator('[data-solution-node]').count(), 4);
      await page.locator('[data-solution-node="proof-step-explanation"]').click();
      assert.ok((await page.locator('[data-solution-inspector]').innerText()).includes('nested-body-search-marker'));
      await search(page).fill('');
      assert.equal(await page.locator('[data-solution-node="proof-step-explanation"]').count(), 1);
      assert.equal(await page.locator('[data-solution-node="normalization-finding"]').count(), 0);
      await page.locator('[data-solution-all]').click(); assert.equal(await page.locator('[data-solution-node]').count(), 8);
    });
    await check('Search finds long research text and keeps focus while characters are typed', async () => {
      await search(page).click(); await page.keyboard.type('bound-body-only', { delay: 8 });
      assert.equal(await search(page).inputValue(), 'bound-body-only');
      assert.deepEqual(await page.locator('[data-solution-node]').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.solutionNode)), ['bound']);
      assert.equal(await search(page).evaluate(input => document.activeElement === input), true);
    });
    await check('Empty search results explain recovery and clearing restores the route', async () => {
      await search(page).fill('no-such-proof-xyz'); assert.equal(await page.locator('[data-solution-node]').count(), 0);
      assert.ok((await page.locator('.solution-route-empty').innerText()).length > 20);
      await search(page).fill(''); assert.equal(await page.locator('[data-solution-node]').count(), 8);
    });
    await check('Searching a child record exposes its owner and opens the exact diagnostic', async () => {
      await search(page).fill('unsolved goals');
      assert.deepEqual(await page.locator('[data-solution-node]').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.solutionNode)), ['bound', 'check-failed']);
      await page.locator('[data-solution-node="check-failed"]').click();
      assert.equal(await selected(page), 'check-failed');
      assert.ok((await page.locator('[data-solution-inspector] pre').innerText()).includes('0 < denominator'));
      await search(page).fill('');
      // Selecting a child expands its owner records; restore the collapsed graph for the following controls.
      await page.locator('[data-solution-all]').click();
    });
    await check('Zoom in, out, reset and fit all change the actual canvas scale', async () => {
      await page.locator('[data-solution-zoom="in"]').click(); assert.equal(await page.locator('output').innerText(), '110%');
      await page.locator('[data-solution-zoom="out"]').click(); assert.equal(await page.locator('output').innerText(), '100%');
      await page.locator('[data-solution-zoom="out"]').click(); assert.equal(await page.locator('output').innerText(), '90%');
      await page.locator('[data-solution-zoom="reset"]').click(); assert.equal(await page.locator('output').innerText(), '100%');
      await page.locator('[data-solution-zoom="fit"]').click();
      const size = await viewport(page).evaluate(view => ({ client: view.clientWidth, scroll: view.scrollWidth, output: document.querySelector('output')!.textContent }));
      assert.ok(size.scroll <= size.client + 1, JSON.stringify(size)); assert.notEqual(size.output, '100%'); return size;
    });
    await screenshot('fit');
    await check('Expanded canvas fits the phone screen, traps Tab, closes with Escape and restores focus', async () => {
      await page.locator('[data-solution-node="bound"]').click();
      const previousOverflow = await page.evaluate(() => document.body.style.overflow);
      await page.locator('[data-solution-expand]').click();
      assert.equal(await page.locator('#route').getAttribute('role'), 'dialog');
      assert.equal(await page.locator('#route').getAttribute('aria-modal'), 'true');
      assert.equal(await page.locator('[data-solution-expand]').getAttribute('aria-expanded'), 'true');
      const bounds = await page.locator('#route').evaluate(route => {
        const box = route.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: innerWidth, height: innerHeight };
      });
      assert.ok(bounds.left >= 0 && bounds.right <= bounds.width && bounds.top >= 0 && bounds.bottom <= bounds.height, JSON.stringify(bounds));
      await page.locator('[data-solution-step="next"]').focus();
      await page.keyboard.press('Tab'); assert.equal(await search(page).evaluate(input => document.activeElement === input), true);
      await page.keyboard.press('Shift+Tab');
      assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.solutionStep), 'next');
      await screenshot('expanded-canvas');
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('[data-solution-expand]').getAttribute('aria-expanded'), 'false');
      assert.equal(await page.locator('[data-solution-expand]').evaluate(button => document.activeElement === button), true);
      assert.equal(await page.evaluate(() => document.body.style.overflow), previousOverflow);
      return bounds;
    });
    await check('Polling keeps keyboard focus inside the expanded canvas controls', async () => {
      await page.locator('[data-solution-select="attempt-fixed"]').click();
      await page.locator('[data-solution-expand]').click();
      try {
        const controls = ['[data-solution-step="next"]', '[data-solution-zoom="in"]', '[data-solution-all]', '[data-solution-open="attempt-fixed"]'];
        for (const [index, selector] of controls.entries()) {
          if (!await page.locator('.solution-route-source').evaluate(details => (details as HTMLDetailsElement).open)) await page.locator('.solution-route-source summary').click();
          await page.locator(selector).focus();
          await page.evaluate(() => (window as any).routeFixture.update());
          assert.equal(await page.locator(selector).evaluate(control => document.activeElement === control), true, selector);
          assert.equal(await page.locator('.solution-route-source').evaluate(details => (details as HTMLDetailsElement).open), true);
          if (index === 0) { await page.keyboard.press('Tab'); assert.equal(await search(page).evaluate(input => document.activeElement === input), true); }
          await page.keyboard.press('Escape');
          assert.equal(await page.locator('[data-solution-expand]').getAttribute('aria-expanded'), 'false');
          if (index < controls.length - 1) await page.locator('[data-solution-expand]').click();
        }
      } finally {
        if (await page.locator('[data-solution-expand]').getAttribute('aria-expanded') === 'true') await page.locator('[data-solution-expand]').click();
        if (await page.locator('[data-solution-all]').getAttribute('aria-pressed') === 'true') await page.locator('[data-solution-all]').click();
      }
    });
    await check('Dragging the graph background pans it horizontally', async () => {
      await page.locator('[data-solution-zoom="reset"]').click();
      await viewport(page).evaluate(view => { view.scrollLeft = 0; view.scrollTop = 0; });
      const box = await viewport(page).boundingBox(); assert.ok(box);
      const x = box.x + Math.min(box.width - 10, 280), y = box.y + box.height - 25;
      await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x - 120, y, { steps: 8 }); await page.mouse.up();
      const pan = await viewport(page).evaluate(view => view.scrollLeft); assert.ok(pan >= 100, `pan=${pan}`); return { scrollLeft: pan };
    });
    await check('Home, End and arrow keys move selection and keyboard focus', async () => {
      await page.locator('[data-solution-node="goal"]').click(); await page.keyboard.press('ArrowRight'); assert.equal(await selected(page), 'normalize');
      await page.keyboard.press('ArrowRight'); assert.equal(await selected(page), 'assemble');
      await page.keyboard.press('ArrowUp'); assert.equal(await selected(page), 'normalize');
      await page.keyboard.press('ArrowDown'); assert.equal(await selected(page), 'assemble');
      await page.keyboard.press('ArrowLeft'); assert.equal(await selected(page), 'normalize');
      await page.keyboard.press('End'); assert.equal(await selected(page), 'outcome');
      await page.keyboard.press('Home'); assert.equal(await selected(page), 'goal');
      assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.solutionNode), 'goal');
    });
    await check('Exact source revision button only invokes the read-only open callback', async () => {
      await page.locator('[data-solution-all]').click(); await page.locator('[data-solution-node="attempt-fixed"]').click();
      await page.locator('.solution-route-source summary').click();
      assert.ok((await page.locator('.solution-route-source').innerText()).includes('e'.repeat(64)));
      await page.locator('[data-solution-open="attempt-fixed"]').click();
      assert.deepEqual(await page.evaluate(() => (window as any).routeFixture.events.opened), ['source:immutable:attempt-fixed']);
      assert.equal(new URL(page.url()).pathname, '/fixture.html');
    });
    await check('Polling update preserves selection, expanded state, zoom, pan and node focus', async () => {
      await page.locator('[data-solution-node="bound"]').click(); await page.locator('[data-solution-zoom="in"]').click();
      await page.locator('[data-solution-node="bound"]').focus();
      await viewport(page).evaluate(view => { view.scrollLeft = 137; view.scrollTop = 91; });
      await page.waitForTimeout(80);
      const before = await viewport(page).evaluate(view => ({ left: view.scrollLeft, top: view.scrollTop }));
      await page.evaluate(() => { for (let i = 0; i < 8; i++) (window as any).routeFixture.update(); });
      const after = await viewport(page).evaluate(view => ({ left: view.scrollLeft, top: view.scrollTop }));
      assert.deepEqual(after, before); assert.equal(await selected(page), 'bound'); assert.equal(await page.locator('output').innerText(), '110%');
      assert.equal(await page.locator('[data-solution-all]').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.solutionNode), 'bound'); return { before, after };
    });
    await check('Polling preserves search value/focus and the full-research inspector scroll', async () => {
      await search(page).fill('bound-body-only');
      await page.locator('[data-solution-inspector]').evaluate(view => { view.scrollTop = 430; });
      const before = await page.locator('[data-solution-inspector]').evaluate(view => view.scrollTop);
      assert.ok(before > 300);
      await search(page).evaluate(input => (input as HTMLInputElement).setSelectionRange(5, 9));
      await page.evaluate(() => (window as any).routeFixture.update());
      assert.equal(await search(page).inputValue(), 'bound-body-only');
      assert.equal(await search(page).evaluate(input => document.activeElement === input), true);
      assert.deepEqual(await search(page).evaluate(input => ({ start: (input as HTMLInputElement).selectionStart, end: (input as HTMLInputElement).selectionEnd })), { start: 5, end: 9 });
      assert.equal(await page.locator('[data-solution-inspector]').evaluate(view => view.scrollTop), before);
      await search(page).fill('');
    });
    await check('No horizontal document overflow at this viewport', async () => {
      const widths = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: innerWidth }));
      assert.ok(widths.document <= widths.viewport, JSON.stringify(widths)); return widths;
    });
    await page.locator('[data-solution-zoom="fit"]').click(); await screenshot('expanded-research');
    await check('Destroy removes the UI and its event handlers', async () => {
      const before = await page.evaluate(() => JSON.stringify((window as any).routeFixture.events));
      const overflow = await page.evaluate(() => document.body.style.overflow);
      await page.locator('[data-solution-expand]').click();
      await page.evaluate(() => { (window as any).routeFixture.destroy(); (window as any).detachedRouteButton.click(); });
      assert.equal(await page.locator('#route').innerHTML(), '');
      assert.equal(await page.evaluate(() => JSON.stringify((window as any).routeFixture.events)), before);
      assert.equal(await page.evaluate(() => document.body.style.overflow), overflow);
    });
    console.log(`${locale}/${width}: ${current.checks.filter(check => check.pass).length}/${current.checks.length} checks passed`);
    for (const failure of current.checks.filter(check => !check.pass)) console.log(`FAIL ${failure.name}: ${failure.detail}`);
    await context.close();
  }
  if (process.argv.includes('--archives') || process.argv.includes('--archives-only')) {
    for (const [directory, prefix] of [['out/site', 'site'], ['out/web/classics', 'classics']] as const) {
      const catalog = await readBuiltArchive(directory);
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', reducedMotion: 'reduce' });
      const blocked: string[] = [], errors: string[] = [];
      await context.route('**/*', async route => {
        const request = route.request();
        if (!request.url().startsWith(origin + '/') || !['GET', 'HEAD'].includes(request.method()) || new URL(request.url()).pathname.startsWith('/api/')) {
          blocked.push(`${request.method()} ${request.url()}`); await route.abort();
        } else await route.continue();
      });
      const page = await context.newPage(); page.setDefaultTimeout(10_000);
      page.on('pageerror', error => errors.push(error.message));
      const records: unknown[] = [];
      report.archives.push({ prefix, records, errors, blocked });
      for (const record of catalog.records) {
        const started = Date.now();
        const process = record.process!;
        const hash = new URLSearchParams({ proof: record.id, tab: 'process', mode: 'global' });
        await page.goto(`${origin}/${prefix}/archive.html#${hash}`);
        await page.locator(`[data-solution-route-record="${record.id}"][data-solution-route-state="ready"]`).waitFor();
        if (await page.locator('.solution-route').getAttribute('data-solution-route-basis') !== 'source') await page.locator('[data-solution-mode="source"]').click();
        assert.equal(await page.locator('.solution-route').getAttribute('data-solution-route-basis'), 'source');
        const sourceFiles = process.sourceRoute!.files.filter(file => file.recordSource);
        const allDeclarations = sourceFiles.flatMap(file => file.declarations.map(declaration => ({ declaration, file })));
        const declarations = allDeclarations.length;
        const sourceSteps = allDeclarations.reduce((sum, item) => sum + item.declaration.steps.length, 0);
        const sourceGroups = sourceFiles.reduce((sum, file) => sum + (file.declarations.length > 80 ? Math.ceil(file.declarations.length / 80) : 0), 0);
        assert.ok(declarations > 0, `${prefix}/${record.id}: no source declarations`);
        const count = (await page.locator('[data-solution-count]').innerText()).match(/(\d+)\s*\/\s*(\d+)/u);
        assert.ok(count); assert.equal(Number(count[2]), declarations + sourceSteps + sourceGroups + sourceFiles.length + 1, `${prefix}/${record.id}: source nodes were lost`);
        const initialNodes = Number(count[1]);
        await page.locator('[data-solution-zoom="fit"]').click();
        const sourceLayout = await viewport(page).evaluate(view => ({ width: view.clientWidth, height: view.clientHeight,
          scrollWidth: view.scrollWidth, scrollHeight: view.scrollHeight, zoom: view.closest('.solution-route')!.querySelector('output')!.textContent }));
        const sourceOpenMs = Date.now() - started;
        assert.ok(sourceLayout.scrollWidth <= sourceLayout.width + 1 && sourceLayout.scrollHeight <= sourceLayout.height + 1,
          `${prefix}/${record.id}: fit leaves part of the graph outside the viewport: ${JSON.stringify(sourceLayout)}`);
        if (records.length === 0) await page.screenshot({ path: path.join(output, `${prefix}-source-large.png`), fullPage: true });
        const last = allDeclarations.at(-1)!;
        await search(page).fill(last.declaration.name);
        await page.locator(`[data-solution-node="${last.declaration.id}"]`).click();
        assert.ok((await page.locator('[data-solution-inspector] pre').last().innerText()).length > 0);
        await page.locator('.solution-route-source summary').click();
        assert.ok((await page.locator('.solution-route-source').innerText()).includes(last.file.sha256));
        assert.equal(await page.locator('[data-solution-open]').count(), 1);
        await search(page).fill('');
        const stepOwner = allDeclarations.findLast(item => item.declaration.steps.length);
        if (stepOwner) {
          await search(page).fill(stepOwner.declaration.name);
          await page.locator(`[data-solution-node="${stepOwner.declaration.id}"]`).click();
          await search(page).fill('');
          const expand = page.locator(`[data-solution-children="${stepOwner.declaration.id}"]`);
          if (await expand.getAttribute('aria-expanded') !== 'true') await expand.click();
          const step = stepOwner.declaration.steps.at(-1)!;
          await page.locator(`[data-solution-node="${step.id}"]`).click();
          assert.equal(await page.locator('[data-solution-inspector] pre').innerText(), step.code);
          assert.ok((await page.locator('.solution-route-source summary').innerText()).includes(String(step.line)));
        }
        const runs: unknown[] = [];
        for (const run of process.runs) {
          // Use the same global-run selection control as a person opening the history panel.
          const panel = page.locator('.global-history-panel');
          if (!await panel.evaluate(element => (element as HTMLDetailsElement).open)) await panel.locator('summary').click();
          await page.locator(`[data-global-select="${run.runId}"]`).click();
          await page.locator(`[data-solution-route-run="${run.runId}"][data-solution-route-state="ready"]`).waitFor();
          await page.locator('[data-solution-mode="recorded"]').click();
          assert.equal(await page.locator('.solution-route').getAttribute('data-solution-route-basis'), 'recorded');
          const taskIds = await page.locator('[data-solution-node^="task:"]').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.solutionNode));
          assert.deepEqual(new Set(taskIds), new Set(run.tasks.map(task => `task:${task.id}`)), `${prefix}/${record.id}/${run.runId}: missing task`);
          const expand = page.locator('[data-solution-all]');
          if (await expand.count() && await expand.getAttribute('aria-pressed') !== 'true') await expand.click();
          const nodes = await page.locator('[data-solution-node]').count();
          assert.ok(nodes >= run.tasks.length + 1);
          const child = page.locator('[data-solution-node^="delivery:"]');
          if (await child.count()) {
            await child.first().click();
            assert.ok((await page.locator('[data-solution-inspector]').innerText()).length > 50);
          }
          const size = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth }));
          assert.ok(size.width <= size.viewport, `${prefix}/${record.id}/${run.runId}: document overflow`);
          runs.push({ runId: run.runId, tasks: taskIds.length, nodes });
        }
        records.push({ id: record.id, declarations, sourceSteps, sourceGroups, initialNodes, totalNodes: Number(count[2]), lastDeclaration: last.declaration.name, sourceOpenMs, sourceLayout, runs });
        console.log(`${prefix}/${record.id}: ${declarations} source declarations, ${runs.length} historical routes`);
      }
      assert.equal(errors.length, 0, JSON.stringify(errors));
      assert.equal(blocked.filter(request => !request.startsWith('GET https://cloud.umami.is/')).length, 0, JSON.stringify(blocked));
      await context.close();
      const largest = [...catalog.records].sort((a, b) =>
        b.process!.sourceRoute!.files.filter(file => file.recordSource).reduce((sum, file) => sum + file.declarations.length, 0)
        - a.process!.sourceRoute!.files.filter(file => file.recordSource).reduce((sum, file) => sum + file.declarations.length, 0))[0]!;
      const mobile = await browser.newContext({ viewport: { width: 320, height: 1000 }, locale: 'en-US', reducedMotion: 'reduce' });
      await mobile.route('**/*', async route => {
        const request = route.request();
        if (!request.url().startsWith(origin + '/') || !['GET', 'HEAD'].includes(request.method()) || new URL(request.url()).pathname.startsWith('/api/')) await route.abort();
        else await route.continue();
      });
      const mobilePage = await mobile.newPage(); mobilePage.setDefaultTimeout(10_000);
      await mobilePage.goto(`${origin}/${prefix}/en/archive.html#${new URLSearchParams({ proof: largest.id, tab: 'process', mode: 'global' })}`);
      await mobilePage.locator(`[data-solution-route-record="${largest.id}"][data-solution-route-state="ready"]`).waitFor();
      if (await mobilePage.locator('.solution-route').getAttribute('data-solution-route-basis') !== 'source') await mobilePage.locator('[data-solution-mode="source"]').click();
      await mobilePage.locator('[data-solution-expand]').click(); await mobilePage.locator('[data-solution-zoom="fit"]').click();
      const mobileSize = await mobilePage.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth }));
      assert.ok(mobileSize.width <= mobileSize.viewport, `${prefix}/${largest.id}: mobile source route overflows`);
      const last = largest.process!.sourceRoute!.files.filter(file => file.recordSource).flatMap(file => file.declarations).at(-1)!;
      await search(mobilePage).fill(last.name); await mobilePage.locator(`[data-solution-node="${last.id}"]`).click();
      assert.ok((await mobilePage.locator('[data-solution-inspector] pre').last().innerText()).length > 0);
      await mobilePage.screenshot({ path: path.join(output, `${prefix}-en-320-large-source.png`) });
      await mobilePage.keyboard.press('Escape'); assert.equal(await mobilePage.locator('[data-solution-expand]').getAttribute('aria-expanded'), 'false');
      report.archives.push({ prefix, mobile: { locale: 'en', width: 320, record: largest.id, lastDeclaration: last.name, ...mobileSize } });
      await mobile.close();
    }
  }
} finally {
  await browser.close(); await new Promise<void>(resolve => server.close(() => resolve()));
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await fs.rm(temporary, { recursive: true, force: true });
}
const failed = report.cases.flatMap(test => test.checks.filter(check => !check.pass));
console.log(`Report: ${path.join(output, 'report.json')}`);
assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
assert.equal(report.blockedRequests.length, 0, JSON.stringify(report.blockedRequests));
assert.equal(failed.length, 0, `${failed.length} interaction or rendering checks failed`);
