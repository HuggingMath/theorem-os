#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, type Page } from 'playwright';

// Local, read-only UI fixture. No solver, provider, business API or application account.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.env.MATH_RENDERING_TEST_OUTPUT ?? path.join(root, 'out/math-rendering'));
await fs.mkdir(output, { recursive: true });
for (const file of ['out/web/math.js', 'out/web/assets/katex/katex.min.css']) await fs.access(path.join(root, file));
const cases = [
  { id: 'raw-integral', text: '∫_{Bₙ}F≥c(5rₙ/4)⁻²·π(rₙ/4)²=cπ/25>0；故 ∫_D F≥Σₙcπ/25=∞。', tag: 'msub' },
  { id: 'raw-recurrence', text: 'M_{n+1} = M_n/(b*lam^2) + ((b-1)/b)*(2/3).', tag: 'msub' },
  { id: 'dollar', text: '勾股关系 $x^2+y^2=z^2$。', tag: 'msup' },
  { id: 'double-dollar', text: String.raw`$$\frac{1+\frac{x}{y}}{\sqrt{1+x^2}}=\frac{y+x}{y\sqrt{1+x^2}}$$`, tag: 'mfrac' },
  { id: 'parentheses', text: '内联 \\(\\left\\langle x,\\left(\\frac{A+B}{2}\\right)y\\right\\rangle\\)。', tag: 'mfrac' },
  { id: 'brackets', text: String.raw`\[\sum_{\substack{1\le i\le n\\i\ne j}}\frac{a_i}{1+a_i^2}\]`, tag: 'munder' },
  { id: 'aligned', text: String.raw`$$\begin{aligned}V_{n+1}(i)&=d\sum_jK(i,j)V_n(j)+s^{n+1}\varphi(i)^2\\&\le dCs^n+\frac49s^{n+1}\\&=[dC+\frac49s]s^n\end{aligned}$$`, tag: 'mtable' },
  { id: 'cases', text: String.raw`$f(x)=\begin{cases}\frac{1}{x},&x>0\\0,&x\le0\end{cases}$`, tag: 'mtable' },
  { id: 'matrix', text: String.raw`$A=\begin{pmatrix}a&b\\c&d\end{pmatrix},\quad\det A=ad-bc$`, tag: 'mtable' },
  { id: 'chinese', text: '$f(x)=\\frac{x}{2}\\quad\\text{其中 }x\\text{ 为正数}$', tag: 'mtext' },
  { id: 'long-inline', text: '$' + Array.from({ length: 32 }, (_, i) => `\\frac{a_{${i}}+b_{${i}}}{1+c_{${i}}^2}`).join('+') + '$', tag: 'mfrac' },
  { id: 'long-display', text: '$$\\underbrace{\\begin{pmatrix}' + Array.from({ length: 64 }, (_, i) => `x_{${i}}`).join('&') + '\\end{pmatrix}}_{\\text{完整的长向量}}$$', tag: 'mtable' },
];
const suffixSource = cases.find(item => item.id === 'long-inline')!.text.slice(1, -1);
const suffixCases = [
  ...(['rich', 'chat'] as const).flatMap(renderer => (['zh', 'en'] as const).map(locale => ({
    id: `${renderer}-${locale}`, renderer, source: suffixSource, suffix: locale === 'zh' ? '。' : '.',
    text: `$${suffixSource}$${locale === 'zh' ? '。' : '.'}`,
  }))),
  ...(['rich', 'chat'] as const).flatMap(renderer => (['zh', 'en'] as const).map(locale => ({
    id: `${renderer}-edge-${locale}`, renderer, source: 'x^2+y^2=z^2', suffix: locale === 'zh' ? '。' : '.',
    text: `$x^2+y^2=z^2$${locale === 'zh' ? '。' : '.'}`,
  }))),
  { id: 'rich-fallback', renderer: 'rich', source: '\\unknownCommand{x}', suffix: '。', text: '$\\unknownCommand{x}$。' },
  { id: 'chat-fallback', renderer: 'chat', source: '\\unknownCommand{x}', suffix: '.', text: '$\\unknownCommand{x}$.' },
];
const bundle = await build({
  stdin: { loader: 'tsx', resolveDir: root, sourcefile: 'math-rendering-fixture.tsx', contents: `
import {h,render} from 'preact';
import {Rich} from './apps/web/client/richText';
import {ChatMessageContent} from './apps/web/client/ui/ChatMessageContent';
import {configureMathAssets} from './apps/web/client/mathAssets';
import {typesetProse} from './apps/web/client/typesetProse';
import {mountSolutionRoute} from './apps/web/solutionRouteView';
const nested=location.pathname.startsWith('/classics/');
configureMathAssets(nested?{script:'../data/math.js',stylesheet:'../assets/katex/katex.min.css'}:{script:'math.js',stylesheet:'assets/katex/katex.min.css'});
const query=new URL(location.href).searchParams;
document.documentElement.dataset.theme=query.get('theme')||'light';
const records=${JSON.stringify(cases)};
const suffixRecords=${JSON.stringify(suffixCases)};
const exclusion=${JSON.stringify('价格 \\$5；代码 ``$x^2$``；源码 `\\frac{1}{x}`。')};
const unknown=String.raw\`$\\unknownCommand{x}$\`,unclosed=String.raw\`尚未完成 $\\frac{1}{x\`;
const linkText=String.raw\`👩‍🔬 目标：$\\frac{x_1}{1+x_2}$，随后接入证明。\`;
const linkStart=linkText.indexOf('$'),linkEnd=linkText.indexOf('$',linkStart+1)+1;
let events={link:0,button:0,selected:[],opened:[]},route,model;
const chatHost=document.querySelector('#chat'),linked=document.querySelector('#linked');
const inline=document.querySelector('#legacy p'),button=document.querySelector('#legacy-button');
button.addEventListener('click',()=>events.button++);
linked.addEventListener('click',event=>{if(event.target.closest('[data-fixture-link]'))events.link++;});
function start(){
 if(document.body.dataset.started)return;
 document.body.dataset.started='true';
 for(const item of records){const section=document.createElement('section');section.className='formula-case';section.dataset.formulaCase=item.id;
 const label=document.createElement('h3');label.textContent=item.id;const content=document.createElement('div');content.className='formula-content';
 section.append(label,content);document.querySelector('#cases').append(section);render(h(Rich,{text:item.text}),content);}
 for(const item of suffixRecords){const section=document.createElement('section');section.className='formula-case';section.dataset.suffixCase=item.id;
 const label=document.createElement('h3');label.textContent=item.id;const content=document.createElement('div');content.className='suffix-content';
 section.append(label,content);document.querySelector('#suffix-cases').append(section);render(h(item.renderer==='chat'?ChatMessageContent:Rich,{text:item.text}),content);}
 render(h(Rich,{text:exclusion}),document.querySelector('#excluded'));
 render(h(Rich,{text:unknown}),document.querySelector('#unknown'));
 render(h(Rich,{text:unclosed}),document.querySelector('#unclosed'));
 render(h(Rich,{text:linkText,links:[{start:linkStart,end:linkEnd,title:'Read the saved proof',attributes:{'data-fixture-link':'proof'}}],marks:[{start:linkText.indexOf('x_1'),end:linkText.indexOf('x_2')+3}]}),linked);
 render(h(ChatMessageContent,{text:String.raw\`正在接收 $\\frac{a}{\`}),chatHost);
 typesetProse(document.querySelector('#legacy'));
 const long=records.find(item=>item.id==='long-display').text;
 model={schema:'theoremos.solution-route.v1',id:'unseen-math-rendering',locale:'zh',basis:'recorded',title:'数学路线与公式',initial:'goal',
 nodes:[{id:'goal',kind:'problem',status:'recorded',title:String.raw\`目标 $S_n$\`,summary:String.raw\`局部界 $\\frac{1+\\frac{x}{y}}{\\sqrt{1+n^2}}$\`,sections:[{title:'真实积分',text:records[0].text},{title:'完整递推',text:records[1].text},{title:'复杂公式',text:records[6].text},{title:'长公式',text:long}]},
 {id:'task',kind:'task',status:'passed',title:String.raw\`证明 $M_{n+1}$ 的递推\`,summary:String.raw\`$M_{n+1}=M_n+1$\`,sections:[{title:'结论',text:records[3].text}]}],edges:[{from:'goal',to:'task',kind:'dependency'}]};
 route=mountSolutionRoute(document.querySelector('#route'),model,{onSelect:id=>events.selected.push(id),onOpen:target=>events.opened.push(target)});
}
document.querySelector('#render-fixture').addEventListener('click',start);
window.mathFixture={events,start,linkText,exclusion,unknown,unclosed,button,
 typesetAgain(){typesetProse(document.querySelector('#legacy'));},
 update(){route.update({...model,nodes:model.nodes.map(node=>({...node}))});},
 completeChat(){render(h(ChatMessageContent,{text:String.raw\`接收完成 $\\frac{a}{b}$，并且 \\(x^2\\)。\`}),chatHost);},
 destroy(){route?.destroy();}}
window.fixtureReady=true;
` },
  bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022', jsx: 'automatic', jsxImportSource: 'preact',
});
const fixtureCss = `html{height:auto;overflow:visible}body{height:auto;display:block;overflow:visible}.fixture-page{max-width:1100px;width:100%;margin:0 auto;padding:24px;color:var(--ink,var(--gray-900));font:15px/1.8 var(--sans)}.fixture-page>h1{font-size:24px}.fixture-section{margin:24px 0;border-top:1px solid var(--gray-150);padding-top:18px;min-width:0}.formula-case{min-width:0;padding:18px 0;border-bottom:1px solid var(--gray-150)}.formula-case h3{font-size:12px;color:var(--muted);margin-bottom:6px}.formula-content{min-width:0}#legacy p{margin:10px 0}#legacy button,#render-fixture{padding:8px 14px;border:1px solid var(--gray-200);background:var(--card);color:var(--ink);border-radius:4px}#linked .explain-link{cursor:pointer;text-decoration:underline;text-underline-offset:5px}#linked mark{background:var(--find-match);color:var(--find-match-ink)}#chat{min-width:0}.fixture-fallback{margin:12px 0}#legacy pre,#legacy code{white-space:pre-wrap;overflow-wrap:anywhere}@media(max-width:520px){.fixture-page{padding:14px;font-size:14px}.fixture-page>h1{font-size:21px}}`;
const styles = (await Promise.all(['apps/web/client/app.css', 'apps/web/solutionRoute.css', 'apps/web/math.css'].map(file => fs.readFile(path.join(root, file), 'utf8')))).join('\n') + '\n' + fixtureCss;
const legacy = '真实积分 ∫_{Bₙ}F≥cπ/25>0。再由 \\(x^2+y^2\\) 得到结论。';
const csp = "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; object-src 'none'";
const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><main class="fixture-page"><h1>数学公式 · 浏览器回归</h1><p>真实归档表达式、复杂公式与流式消息</p><button id="render-fixture">呈现公式</button><section id="cases" class="fixture-section"></section><section id="suffix-cases" class="fixture-section"><h2>公式尾标点</h2></section><section class="fixture-section"><h2>排除与保留</h2><div id="excluded" class="fixture-fallback"></div><div id="unknown" class="fixture-fallback"></div><div id="unclosed" class="fixture-fallback"></div></section><section class="fixture-section"><h2>链接与标注</h2><div id="linked"></div></section><section id="legacy" class="fixture-section"><h2>既有正文</h2><p>${legacy}<button id="legacy-button">保留的原始按钮</button> 按钮之后 $z^2$。</p><pre><code>$x^2$ 与 \\frac{1}{x}</code></pre></section><section class="fixture-section"><h2>流式消息</h2><div id="chat"></div></section><section class="fixture-section"><h2>共用路线图</h2><div id="route" data-solution-route></div></section></main><script src="/fixture.js"></script></body></html>`;
const requests: { path: string; status: number }[] = [];
const server = createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://fixture').pathname);
  let status = 200;
  try {
    res.setHeader('content-security-policy', csp);
    if (pathname === '/fixture.html' || pathname === '/classics/en/fixture.html') { res.setHeader('content-type', 'text/html;charset=utf-8'); res.end(html); return; }
    if (pathname === '/fixture.js') { res.setHeader('content-type', 'text/javascript'); res.end(bundle.outputFiles[0]!.contents); return; }
    if (pathname === '/fixture.css') { res.setHeader('content-type', 'text/css'); res.end(styles); return; }
    let file: string;
    if (pathname === '/math.js' || pathname === '/classics/data/math.js') file = path.join(root, 'out/web/math.js');
    else if (pathname.startsWith('/assets/') || pathname.startsWith('/classics/assets/')) file = path.resolve(root, 'out/web', pathname.replace(/^\/(?:classics\/)?/u, ''));
    else { status = 404; res.writeHead(status); res.end(); return; }
    if (!file.startsWith(path.join(root, 'out/web') + path.sep)) throw new Error('fixture_path');
    const content = await fs.readFile(file);
    res.setHeader('content-type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'font/woff2'); res.end(content);
  } catch { status = 404; res.writeHead(status); res.end(); }
  finally { requests.push({ path: pathname, status }); }
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address(); assert.ok(address && typeof address !== 'string');
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });
type Check = { name: string; pass: boolean; detail?: unknown };
const report: { cases: { width: number; theme: string; path: string; checks: Check[]; errors: string[]; csp: unknown[]; screenshots: string[] }[]; blocked: string[] } = { cases: [], blocked: [] };

const settledMath = async (page: Page) => {
  await page.waitForFunction(() => !document.querySelector('[data-math-state="loading"]'));
  await page.evaluate(() => document.fonts.ready);
};
try {
  for (const width of [1440, 390, 320]) for (const theme of ['light', 'dark']) {
    const pathname = theme === 'dark' ? '/classics/en/fixture.html' : '/fixture.html';
    const current = { width, theme, path: pathname, checks: [] as Check[], errors: [] as string[], csp: [] as unknown[], screenshots: [] as string[] }; report.cases.push(current);
    const requestStart = requests.length;
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: 'zh-CN', colorScheme: theme === 'dark' ? 'dark' : 'light', reducedMotion: 'reduce' });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (!request.url().startsWith(origin + '/') || !['GET', 'HEAD'].includes(request.method()) || url.pathname.includes('/api/')) {
        report.blocked.push(`${request.method()} ${request.url()}`); await route.abort();
      } else await route.continue();
    });
    await context.addInitScript(() => {
      (window as any).fixtureCsp = [];
      document.addEventListener('securitypolicyviolation', event => (window as any).fixtureCsp.push({ directive: event.effectiveDirective, blocked: event.blockedURI, sample: event.sample }));
    });
    const page = await context.newPage(); page.setDefaultTimeout(8000); page.on('pageerror', error => current.errors.push(error.message));
    const check = async (name: string, action: () => Promise<unknown>) => {
      try { const detail = await action(); current.checks.push({ name, pass: true, ...(detail === undefined ? {} : { detail }) }); }
      catch (error) { current.checks.push({ name, pass: false, detail: error instanceof Error ? error.message : String(error) }); }
    };
    const screenshot = async (name: string, selector: string) => {
      const file = path.join(output, `${width}-${theme}-${name}.png`);
      await page.locator(selector).scrollIntoViewIfNeeded(); await page.screenshot({ path: file }); current.screenshots.push(file);
    };
    await page.goto(`${origin}${pathname}?theme=${theme}`); await page.waitForFunction(() => (window as any).fixtureReady);
    await check('Math runtime and stylesheet stay lazy until the first formula', async () => {
      assert.equal(requests.slice(requestStart).filter(request => /(?:math\.js|katex\.min\.css)$/u.test(request.path)).length, 0);
      assert.equal(await page.locator('.katex').count(), 0);
    });
    await page.locator('#render-fixture').click(); await settledMath(page);
    await check('Real integral and recurrence become structured, readable mathematics', async () => {
      for (const id of ['raw-integral', 'raw-recurrence']) {
        const item = page.locator(`[data-formula-case="${id}"]`);
        assert.ok(await item.locator('[data-math-state="ready"] .katex-mathml math').count() > 0, `${id}: remained plain text`);
        assert.ok(await item.locator('msub').count() > 0, `${id}: subscript was not typeset`);
        const leftovers = await item.locator('.formula-content').evaluate(element => [...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join(''));
        assert.ok(!/∫_|M_\{|M_n/gu.test(leftovers), `${id}: ${leftovers}`);
      }
    });
    await check('Four delimiters, fractions, large fences, sums, environments and Chinese text have actual MathML structure', async () => {
      for (const item of cases.slice(2)) {
        const host = page.locator(`[data-formula-case="${item.id}"]`);
        assert.equal(await host.locator('.math[data-math-state="ready"]').count(), 1, item.id);
        assert.ok(await host.locator(`.katex-mathml ${item.tag}`).count() > 0, `${item.id}: missing ${item.tag}`);
        const visual = await host.locator('.katex-html').boundingBox(); assert.ok(visual && visual.width > 8 && visual.height > 8, `${item.id}: no rendered glyphs`);
      }
      const chinese = await page.locator('[data-formula-case="chinese"]').evaluate(host => ({
        source: host.querySelector('.math')?.getAttribute('title'),
        mtext: [...host.querySelectorAll('mtext')].map(node => node.textContent).join(''),
      }));
      assert.ok(chinese.mtext.includes('为正数'), JSON.stringify(chinese));
    });
    await check('Rich and chat keep Chinese and English tail punctuation on the final formula line', async () => {
      const details = [];
      for (const item of suffixCases.filter(item => !item.id.endsWith('fallback'))) {
        const content = page.locator(`[data-suffix-case="${item.id}"] .suffix-content`);
        if (item.id.includes('-edge-')) await content.evaluate((root, suffix) => {
          const walker = document.createTreeWalker(root.querySelector('.katex-html')!, NodeFilter.SHOW_TEXT);
          let node: Node | null, first: Text | undefined, last: Text | undefined;
          while ((node = walker.nextNode())) if (node.textContent?.replaceAll(suffix, '').replace(/[\s\u200b]/gu, '')) {
            first ??= node as Text; last = node as Text;
          }
          if (!first || !last) throw new Error('No formula glyphs for the wrap boundary');
          const range = document.createRange(); range.setStart(first, 0);
          range.setEnd(last, last.data.endsWith(suffix) ? last.length - suffix.length : last.length);
          (root as HTMLElement).style.width = `${Math.ceil(range.getBoundingClientRect().width) + 1}px`;
        }, item.suffix);
        const result = await content.evaluate((root, suffix) => {
          const host = root.querySelector('.math')!, visual = host.querySelector('.katex-html')!;
          const punctuation = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          let node: Node | null, suffixNode: Text | undefined;
          while ((node = punctuation.nextNode())) {
            if (!node.parentElement?.closest('.katex-mathml') && node.textContent?.includes(suffix)) suffixNode = node as Text;
          }
          const math = document.createTreeWalker(visual, NodeFilter.SHOW_TEXT);
          let glyphNode: Text | undefined;
          while ((node = math.nextNode())) if (node.textContent?.replaceAll(suffix, '').replace(/[\s\u200b]/gu, '')) glyphNode = node as Text;
          const tail = document.createRange();
          if (suffixNode) { const at = suffixNode.data.lastIndexOf(suffix); tail.setStart(suffixNode, at); tail.setEnd(suffixNode, at + suffix.length); }
          const line = glyphNode?.parentElement?.closest('.katex-base') ?? glyphNode?.parentElement;
          return {
            source: host.getAttribute('title'), annotation: host.querySelector('annotation')?.textContent,
            count: (root.textContent ?? '').split(suffix).length - 1,
            suffixInsideMath: !!suffixNode && host.contains(suffixNode),
            suffix: suffixNode ? tail.getBoundingClientRect().toJSON() : undefined,
            lastFormulaLine: line?.getBoundingClientRect().toJSON(),
          };
        }, item.suffix);
        assert.equal(result.source, item.source, item.id); assert.equal(result.annotation, item.source, item.id);
        assert.equal(result.count, 1, `${item.id}: punctuation was lost or duplicated`);
        assert.equal(result.suffixInsideMath, true, `${item.id}: punctuation escaped the formula layout`);
        assert.ok(result.suffix && result.lastFormulaLine, `${item.id}: missing visible punctuation or formula line`);
        assert.ok(result.suffix.width > 0 && result.suffix.height > 0, item.id);
        assert.ok(result.suffix.top < result.lastFormulaLine.bottom && result.suffix.bottom > result.lastFormulaLine.top,
          `${item.id}: orphaned punctuation ${JSON.stringify(result)}`);
        details.push({ id: item.id, suffix: result.suffix, lastFormulaLine: result.lastFormulaLine });
      }
      return details;
    });
    await check('Unknown formula fallbacks retain exactly one tail punctuation mark', async () => {
      for (const item of suffixCases.filter(item => item.id.endsWith('fallback'))) {
        const content = page.locator(`[data-suffix-case="${item.id}"] .suffix-content`);
        assert.equal(await content.locator('[data-math-state="source"]').count(), 1, item.id);
        assert.equal(await content.locator('.katex').count(), 0, item.id);
        assert.equal(await content.textContent(), item.renderer === 'chat' ? item.text : item.source + item.suffix, item.id);
        assert.equal(await content.locator('.math').getAttribute('title'), item.source, item.id);
      }
    });
    await check('Escaped dollars and code stay literal; incomplete and unknown formulas remain readable', async () => {
      assert.equal(await page.locator('#excluded .math').count(), 0);
      assert.ok((await page.locator('#excluded').innerText()).includes('$5'));
      assert.equal(await page.locator('#excluded code').nth(0).innerText(), '$x^2$');
      assert.equal(await page.locator('#unknown [data-math-state="source"]').count(), 1);
      assert.ok((await page.locator('#unknown').innerText()).includes('\\unknownCommand{x}'));
      assert.equal(await page.locator('#unclosed').innerText(), await page.evaluate(() => (window as any).mathFixture.unclosed));
      assert.equal(await page.locator('#unclosed [data-math-state="ready"]').count(), 0);
    });
    await check('Non-BMP offsets keep one linked formula and its whole mark clickable', async () => {
      const link = page.locator('#linked [data-fixture-link="proof"]'); assert.equal(await link.count(), 1);
      assert.equal(await link.locator('mark .math[data-math-state="ready"]').count(), 1);
      assert.equal(await page.locator('#linked').evaluate(element => element.firstChild?.textContent), '👩‍🔬 目标：');
      assert.ok(!(await link.textContent())!.includes('，'), 'Punctuation must not cross a link or mark boundary');
      assert.equal((await page.locator('#linked').textContent())!.split('，').length - 1, 1);
      await link.click(); assert.equal(await page.evaluate(() => (window as any).mathFixture.events.link), 1);
    });
    await check('Typesetting existing prose is idempotent and preserves controls and code', async () => {
      const before = await page.locator('#legacy .math').count(); assert.ok(before >= 2);
      await page.evaluate(() => { (window as any).mathFixture.typesetAgain(); (window as any).mathFixture.typesetAgain(); });
      assert.equal(await page.locator('#legacy .math').count(), before);
      assert.equal(await page.locator('#legacy [data-typeset-prose] [data-typeset-prose]').count(), 0);
      assert.equal(await page.locator('#legacy code .math').count(), 0);
      assert.equal(await page.locator('#legacy-button').evaluate(button => button === (window as any).mathFixture.button), true);
      await page.locator('#legacy-button').click(); assert.equal(await page.evaluate(() => (window as any).mathFixture.events.button), 1);
    });
    await check('An unfinished chat formula becomes complete without retaining stale content', async () => {
      assert.equal(await page.locator('#chat [data-math-state="pending"]').count(), 1);
      assert.ok((await page.locator('#chat').innerText()).includes('$\\frac{a}{'));
      await page.evaluate(() => (window as any).mathFixture.completeChat()); await settledMath(page);
      assert.equal(await page.locator('#chat [data-math-state="pending"]').count(), 0);
      assert.equal(await page.locator('#chat .math[data-math-state="ready"]').count(), 2);
      assert.equal(await page.locator('#chat mfrac').count(), 1);
      assert.ok(!(await page.locator('#chat').innerText()).includes('$\\frac'));
    });
    await check('Shared graph math survives repeated polling with selection, zoom and search focus', async () => {
      assert.ok(await page.locator('.solution-route-node > strong .katex').count() > 0);
      assert.ok(await page.locator('.solution-route-node-summary .katex').count() > 0);
      assert.ok(await page.locator('[data-solution-inspector] mtable').count() > 0);
      const rawGraphText = await page.locator('[data-solution-prose]').evaluateAll(elements => elements.flatMap(element => {
        const text = [...element.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join('');
        return /\$|\\\(|\\\[/u.test(text) ? [{ tag: element.tagName, className: element.className, text }] : [];
      }));
      assert.deepEqual(rawGraphText, []);
      await page.locator('[data-solution-zoom="in"]').click();
      await page.locator('[data-solution-search]').fill('目标');
      await page.evaluate(() => { for (let index = 0; index < 6; index++) (window as any).mathFixture.update(); });
      await settledMath(page);
      assert.equal(await page.locator('[data-solution-search]').evaluate(input => document.activeElement === input), true);
      assert.equal(await page.locator('[data-solution-search]').inputValue(), '目标');
      assert.equal(await page.locator('[data-solution-node][aria-pressed="true"]').getAttribute('data-solution-node'), 'goal');
      assert.equal(await page.locator('.solution-route output').innerText(), '110%');
      assert.equal(await page.locator('.katex .katex').count(), 0);
      await page.locator('[data-solution-search]').fill(''); await page.locator('[data-solution-zoom="reset"]').click(); await settledMath(page);
    });
    await check('Graph previews retain the full height of nested fractions', async () => {
      const clipped = await page.locator('.solution-route-node > strong .katex-html,.solution-route-node-summary .katex-html').evaluateAll(elements => elements.flatMap(element => {
        const parent = element.closest('.solution-route-node-summary,strong')!, bounds = parent.getBoundingClientRect(), glyph = element.getBoundingClientRect();
        return glyph.top < bounds.top - 2 || glyph.bottom > bounds.bottom + 2
          ? [{ text: element.closest('.math')?.getAttribute('title'), parent: bounds.toJSON(), glyph: glyph.toJSON() }] : [];
      }));
      assert.deepEqual(clipped, []);
    });
    await check('Wide formulas scroll locally and every formula stays within the document', async () => {
      const size = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, width: innerWidth }));
      assert.ok(size.document <= size.width, JSON.stringify(size));
      const wide = page.locator('[data-formula-case="long-display"] .math');
      const result = await wide.evaluate(host => {
        const before = host.scrollLeft; host.scrollLeft = host.scrollWidth;
        return { width: host.clientWidth, scroll: host.scrollWidth, before, after: host.scrollLeft, overflow: getComputedStyle(host).overflowX };
      });
      assert.ok(result.scroll > result.width + 50, JSON.stringify(result)); assert.ok(result.after > result.before); assert.equal(result.overflow, 'auto');
      const escaped = await page.locator('#cases .math[data-math-state="ready"],#chat .math[data-math-state="ready"]').evaluateAll(elements => elements.flatMap(host => {
        const bounds = host.getBoundingClientRect(), katex = host.querySelector('.katex-html')?.getBoundingClientRect();
        return bounds.left < -1 || bounds.right > innerWidth + 1 || (katex && (katex.top < bounds.top - 3 || katex.bottom > bounds.bottom + 3))
          ? [{ source: host.getAttribute('title'), box: bounds.toJSON(), visual: katex?.toJSON() }] : [];
      }));
      assert.deepEqual(escaped, []); return result;
    });
    await check('KaTeX fonts actually load and one runtime and stylesheet serve all formulas', async () => {
      const fonts = await page.evaluate(() => [...document.fonts].filter(font => /KaTeX/u.test(font.family)).map(font => ({ family: font.family, status: font.status })));
      assert.ok(fonts.some(font => font.family.includes('KaTeX_Main') && font.status === 'loaded'), JSON.stringify(fonts));
      assert.ok(fonts.some(font => font.family.includes('KaTeX_Math') && font.status === 'loaded'), JSON.stringify(fonts));
      const loads = requests.slice(requestStart);
      assert.equal(loads.filter(request => /(?:^|\/)math\.js$/u.test(request.path)).length, 1);
      assert.equal(loads.filter(request => /katex\.min\.css$/u.test(request.path)).length, 1);
      assert.ok(loads.some(request => /KaTeX_.*\.woff2$/u.test(request.path) && request.status === 200));
      assert.ok(!loads.some(request => request.status !== 200), JSON.stringify(loads.filter(request => request.status !== 200)));
      return fonts.filter(font => font.status === 'loaded');
    });
    await screenshot('complex', '[data-formula-case="aligned"]');
    await screenshot('long-formula', '[data-formula-case="long-display"]');
    await screenshot('tail-punctuation', '[data-suffix-case="chat-zh"]');
    await screenshot('shared-route', '#route');
    current.csp = await page.evaluate(() => (window as any).fixtureCsp);
    await check('Strict CSP reports no violations or runtime errors', async () => { assert.deepEqual(current.csp, []); assert.deepEqual(current.errors, []); });
    console.log(`${width}/${theme}: ${current.checks.filter(item => item.pass).length}/${current.checks.length} checks passed`);
    for (const failure of current.checks.filter(item => !item.pass)) console.log(`FAIL ${failure.name}: ${JSON.stringify(failure.detail)}`);
    await context.close(); await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  }
} finally {
  await browser.close(); await new Promise<void>(resolve => server.close(() => resolve()));
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
const failures = report.cases.flatMap(item => item.checks.filter(check => !check.pass));
assert.deepEqual(report.blocked, []); assert.equal(failures.length, 0, `${failures.length} formula rendering checks failed`);
console.log(`Report: ${path.join(output, 'report.json')}`);
