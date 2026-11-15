import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { campaignRecords } from '../docs/web/campaignCatalog';
import { siteRepository } from '../docs/web/site';
import type { ArchiveCatalog } from '../docs/web/types';
import { archiveAssetVersions, archiveCounts, buildArchive, versionArchivePage } from './site-archive';
import { researchReplay } from '../docs/web/presentation';
import { LOCAL_EXAMPLE_FAILED_PROOF, LOCAL_EXAMPLE_PROOF } from '../src/math/localExample';

/** The research pages' top navigation for a classic page; `定理` is current because solved problems are read from there. */
export function classicsNavigation(english: boolean, workbench: string) {
  const language = english ? '?lang=en' : '?lang=zh';
  const links = english
    ? [['workspace.html', 'My research'], ['people.html', 'Mathematicians'], ['library.html', 'Library']]
    : [['workspace.html', '我的研究'], ['people.html', '数学家'], ['library.html', '数学库']];
  const items = links.map(([page, label]) => `<a href="${workbench}${page}${language}">${label}</a>`).join('');
  const help = `<a href="${workbench}workspace.html${language}&amp;tab=help">${english ? 'Help' : '帮助'}</a>`;
  const other = english ? '<a class="lang-link" href="../archive.html" hreflang="zh-CN" lang="zh-CN" aria-label="中文版">中文</a>'
    : '<a class="lang-link" href="en/archive.html" hreflang="en" lang="en" aria-label="English version">English</a>';
  return `<nav class="classics-nav" aria-label="${english ? 'Research space' : '研究空间'}"><a href="${workbench}${language}">${english ? '← Workbench' : '← 工作台'}</a><a href="${workbench}theorems.html${language}" aria-current="page">${english ? 'Theorems' : '定理'}</a></nav>${other}<button type="button" class="theme-toggle" data-theme-toggle aria-label="${english ? 'Switch theme' : '切换明暗主题'}" title="${english ? 'Switch theme' : '切换明暗主题'}"><span aria-hidden="true">◐</span></button><details class="classics-more"><summary aria-label="${english ? 'More pages' : '更多页面'}">⋯<span>${english ? 'Menu' : '菜单'}</span></summary><nav aria-label="${english ? 'More pages' : '更多页面'}">${items}${help}</nav></details>`;
}

/** A shared, read-only library shipped with the web image, independent of account-owned runs. */
export async function buildWorkbenchClassics(root: string, webOutput: string) {
  const campaign = campaignRecords(root);
  if (!campaign.records.length) throw new Error('No verified classic problems; import the campaign results before building the workbench.');
  const catalog: ArchiveCatalog = { schema: 'theoremos.public-archive.v1', repository: siteRepository, archiveRevision: 'main',
    snapshotAt: campaign.capturedAt!, records: campaign.records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) };
  const output = path.join(webOutput, 'classics');
  await buildArchive(root, output, catalog);
  const themeBundle = path.join(output, 'theme.js');
  if (fs.existsSync(path.join(webOutput, 'theme.js'))) {
    fs.copyFileSync(path.join(webOutput, 'theme.js'), themeBundle);
  } else {
    await build({
      entryPoints: [path.join(root, 'apps/web/client/theme.ts')],
      outfile: themeBundle,
      bundle: true,
      minify: true,
      format: 'iife',
      platform: 'browser',
      target: ['es2022'],
    });
  }
  fs.appendFileSync(path.join(output, 'site.js'), `
document.addEventListener('click', event => {
  const menu = document.querySelector('.classics-more[open]');
  if (menu && !menu.contains(event.target)) menu.removeAttribute('open');
});
document.addEventListener('keydown', event => {
  const menu = document.querySelector('.classics-more[open]');
  if (event.key === 'Escape' && menu) {
    event.preventDefault();
    menu.removeAttribute('open');
    menu.querySelector('summary').focus({ preventScroll: true });
  }
});
const themeToggle = document.querySelector('[data-theme-toggle]');
if (themeToggle) {
  const syncThemeToggle = () => {
    const dark = document.documentElement.dataset.theme === 'dark';
    themeToggle.setAttribute('aria-pressed', String(dark));
  };
  syncThemeToggle();
  themeToggle.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    document.documentElement.dataset.themePreference = next;
    try { localStorage.setItem('theorem-os.web-theme.v1', next); } catch {}
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', next === 'dark' ? '#1b1a18' : '#f5f4ee');
    syncThemeToggle();
  });
}
`);
  fs.writeFileSync(path.join(output, 'process.css'), fs.readFileSync(path.join(root, 'docs/process.css'), 'utf8')
    + '\n' + fs.readFileSync(path.join(root, 'apps/web/solutionRoute.css'), 'utf8')
    + '\n' + fs.readFileSync(path.join(root, 'apps/web/math.css'), 'utf8'));
  const archiveVersions = archiveAssetVersions(output);
  const replay = JSON.parse(fs.readFileSync(path.join(root, 'docs/assets/replay.json'), 'utf8'));
  for (const [locale, directory] of [['zh', ''], ['en', 'en']] as const) {
    const english = locale === 'en', workbench = english ? '../../' : '../', home = `https://theoremos.top/${english ? 'en/' : ''}`;
    let page = archiveCounts(fs.readFileSync(path.join(root, 'docs', directory, 'archive.html'), 'utf8'), catalog)
      .replace('<meta name="theme-color" content="#fafbfc">', '<meta name="theme-color" content="#f5f4ee">')
      .replace(`<link rel="stylesheet" href="${english ? '../' : ''}site.css">`, `<script src="${english ? '../' : ''}theme.js"></script>\n  <link rel="stylesheet" href="${english ? '../' : ''}site.css">`)
      .replace('<!-- research-replay -->', researchReplay(LOCAL_EXAMPLE_FAILED_PROOF, LOCAL_EXAMPLE_PROOF, replay, locale, 'archive'))
      .replace('<body>', `<body class="shared-classics" data-workbench-root="${workbench}">`)
      .replaceAll('href="index.html"', `href="${workbench}"`)
      .replaceAll('href="index.html#start"', `href="${workbench}"`)
      .replaceAll('href="feedback.html"', `href="${home}feedback.html"`)
      .replaceAll('href="privacy.html"', `href="${home}privacy.html"`)
      .replace(/<p class="page-description">[\s\S]*?<\/p>/u, `<p class="page-description">${english
        ? 'Classic problems, proofs and research processes shared by all accounts. No API key needed.'
        : '所有账户共享的经典题目、证明与解题过程。无需 API Key。'}</p>`)
      .replace(/<link rel="alternate"[^>]+>/gu, '')
      // Proofs belong to the theorem pages, so the reader keeps the same research navigation instead of the landing site's links.
      .replace(/<span class="preview-tag">[^<]*<\/span>/u, '')
      .replace(/<nav class="header-links"[\s\S]*?<\/nav>/u, classicsNavigation(english, workbench));
    page = english
      ? page.replaceAll('Proof archive', 'Classic problems').replaceAll('proof archive', 'classic problem library')
        .replace('>Request access<', '>Research workbench<').replace('aria-label="TheoremOS home"', 'aria-label="Back to workbench"')
      : page.replaceAll('证明档案', '经典题库').replace('>申请内测<', '>研究工作台<').replace('aria-label="TheoremOS 首页"', 'aria-label="返回工作台"');
    fs.mkdirSync(path.join(output, directory), { recursive: true });
    fs.writeFileSync(path.join(output, directory, 'archive.html'), versionArchivePage(page, archiveVersions));
  }
  // Zero official/snapshot counts stay in the DOM for the shared archive renderer, without empty filters in this library.
  const css = fs.readFileSync(path.join(root, 'docs/site.css'), 'utf8') + `
.shared-classics .metrics { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.shared-classics .metric:has(#accepted-count), .shared-classics .metric:has(#progress-count),
.shared-classics .status-filter label:has(input[value="accepted"]), .shared-classics .status-filter label:has(input[value="progress"]) { display: none; }
.shared-classics .metric:has(#verified-count) { padding-left: 0; }
/* Inside the workbench a primary action is ink, as on every other page; green stays the verified-status colour. */
.shared-classics .button-primary { background: var(--ink); border-color: var(--ink); color: var(--paper); }
.shared-classics .button-primary:hover { background: var(--ink-soft); border-color: var(--ink-soft); color: var(--paper); }
.shared-classics .button:not(.button-primary):hover, .shared-classics .icon-button:hover { color: var(--ink); }
.shared-classics .topbar { height: 56px; justify-content: flex-start; flex-wrap: nowrap; gap: 16px; }
.shared-classics .brand { flex-shrink: 0; }
.shared-classics .classics-nav { display: flex; align-items: center; gap: 6px; min-width: 0; }
.shared-classics .classics-nav a { padding: 6px 12px; border-radius: 6px; color: var(--muted); font-size: 13px; white-space: nowrap; }
.shared-classics .classics-nav a[aria-current=page] { color: var(--ink); background: var(--surface); }
.shared-classics .classics-nav a:hover { color: var(--ink); background: var(--surface); }
.shared-classics .topbar > .lang-link, .shared-classics .classics-more > summary { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; min-height: 34px; padding: 6px 12px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: var(--ink); font-size: 12px; font-weight: 500; white-space: nowrap; text-decoration: none; }
.shared-classics .topbar > .lang-link { margin-left: auto; }
.shared-classics .topbar > .lang-link:hover, .shared-classics .classics-more > summary:hover, .shared-classics .theme-toggle:hover { background: var(--surface); }
.shared-classics .theme-toggle { display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; width: 34px; height: 34px; padding: 0; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: var(--ink); font-size: 14px; line-height: 1; }
.shared-classics .classics-more { position: relative; flex-shrink: 0; }
.shared-classics .classics-more > summary { gap: 7px; cursor: pointer; list-style: none; }
.shared-classics .classics-more > summary::-webkit-details-marker { display: none; }
.shared-classics .classics-more > nav { position: absolute; right: 0; top: calc(100% + 8px); z-index: 20; display: grid; width: 190px; max-width: calc(100vw - 24px); padding: 6px; border: 1px solid var(--line); border-radius: 8px; background: var(--paper, #faf9f5); box-shadow: 0 8px 24px var(--shadow, #26252118); }
.shared-classics .classics-more > nav a { padding: 8px 10px; border-radius: 5px; font-size: 13px; }
.shared-classics .classics-more > nav a:hover { color: var(--ink); background: var(--surface); }
@media (max-width: 740px) { .shared-classics .topbar { padding-inline: 16px; gap: 10px; } .shared-classics .classics-nav { gap: 2px; } .shared-classics .classics-nav a { padding-inline: 8px; } }
@media (max-width: 420px) {
  .shared-classics .topbar { padding-inline: 10px; gap: 4px; }
  .shared-classics .brand-mark { width: 26px; height: 26px; }
  .shared-classics .classics-nav { overflow-x: auto; scrollbar-width: none; }
  .shared-classics .classics-nav a { padding-inline: 4px; font-size: 12px; }
  .shared-classics .brand > span { display: none; }
  .shared-classics .topbar > .lang-link { padding: 4px 7px; min-height: 30px; }
  .shared-classics .theme-toggle { width: 30px; height: 30px; }
  .shared-classics .classics-more > summary { width: 30px; min-height: 30px; padding-inline: 0; }
  .shared-classics .classics-more > summary > span { display: none; }
}
@media (forced-colors: active) { .shared-classics .classics-nav a[aria-current=page] { outline: 2px solid Highlight; } }
@media (max-width: 600px) {
  .shared-classics .metrics { grid-template-columns: 1fr 1fr; }
  .shared-classics .metric:has(#line-count) { padding-left: 22px; border-right: 0; }
}
`;
  fs.writeFileSync(path.join(output, 'site.css'), css);
  fs.copyFileSync(path.join(root, 'docs/replay.css'), path.join(output, 'replay.css'));
  fs.mkdirSync(path.join(output, 'assets'), { recursive: true });
  fs.cpSync(path.join(root, 'docs/assets/fonts'), path.join(output, 'assets/fonts'), { recursive: true });
  for (const file of ['mark.svg', 'replay.png', 'replay.json']) fs.copyFileSync(path.join(root, 'docs/assets', file), path.join(output, 'assets', file));
  fs.copyFileSync(path.join(root, 'node_modules/lucide/LICENSE'), path.join(output, 'lucide-LICENSE.txt'));
  return catalog.records.length;
}
