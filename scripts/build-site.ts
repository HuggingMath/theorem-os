#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { buildSiteCatalog } from '../docs/web/catalog';
import { acceptedProofRows, featuredProof, researchReplay } from '../docs/web/presentation';
import { LOCAL_EXAMPLE_FAILED_PROOF, LOCAL_EXAMPLE_PROOF } from '../src/math/localExample';
import { analyticsWebsiteId, customDomain, pagesOrigin } from '../docs/web/site';
import { archiveAssetVersions, archiveCounts, buildArchive, versionArchivePage } from './site-archive';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const output = path.join(root, 'out/site');
// Presentation releases reuse the published archive instead of a partial local catalog.
const presentationOnly = process.argv.includes('--presentation-only');
const catalog = presentationOnly
  ? JSON.parse(fs.readFileSync(path.join(output, 'data/catalog.json'), 'utf8')) as ReturnType<typeof buildSiteCatalog>
  : buildSiteCatalog(root, revision);
fs.mkdirSync(output, { recursive: true });
if (!presentationOnly) {
  await buildArchive(root, output, catalog);
  fs.writeFileSync(path.join(output, 'process.css'), fs.readFileSync(path.join(root, 'docs/process.css'), 'utf8')
    + '\n' + fs.readFileSync(path.join(root, 'apps/web/solutionRoute.css'), 'utf8')
    + '\n' + fs.readFileSync(path.join(root, 'apps/web/math.css'), 'utf8'));
}
const archiveVersions = archiveAssetVersions(output);
if (!presentationOnly) await build({
  entryPoints: [path.join(root, 'docs/web/landing.ts')], outfile: path.join(output, 'landing.js'),
  bundle: true, platform: 'browser', format: 'iife', target: ['es2022'], minify: true,
  legalComments: 'eof',
});
for (const page of presentationOnly ? [] : ['feedback', 'legal', 'initiative']) await build({
  entryPoints: [path.join(root, `docs/web/${page}.ts`)], outfile: path.join(output, `${page}.js`),
  bundle: true, platform: 'browser', format: 'iife', target: ['es2022'], minify: true,
  legalComments: 'eof',
});
await build({
  entryPoints: [path.join(root, 'docs/web/design.js')], outfile: path.join(output, 'design.js'),
  bundle: true, platform: 'browser', format: 'iife', target: ['es2022'], minify: true,
  legalComments: 'eof',
});
const replay = JSON.parse(fs.readFileSync(path.join(root, 'docs/assets/replay.json'), 'utf8'));
for (const [locale, directory] of [['zh', ''], ['en', 'en']] as const) {
  if (presentationOnly && locale === 'en') continue;
  fs.mkdirSync(path.join(output, directory), { recursive: true });
  const homepage = fs.readFileSync(path.join(root, 'docs', directory, 'index.html'), 'utf8')
    .replace('<!-- featured-proof -->', featuredProof(catalog, locale))
    .replace('<!-- accepted-count -->', String(catalog.records.filter(record => record.status === 'official_accepted').length))
    .replace('<!-- local-count -->', String(catalog.records.filter(record => record.status === 'locally_verified').length))
    .replace('<!-- accepted-proofs -->', acceptedProofRows(catalog, locale));
  fs.writeFileSync(path.join(output, directory, 'index.html'), homepage);
  for (const file of presentationOnly ? ['initiative.html'] : ['archive.html', 'feedback.html', 'privacy.html', 'initiative.html']) {
    let page = fs.readFileSync(path.join(root, 'docs', directory, file), 'utf8');
    if (file === 'archive.html') page = versionArchivePage(archiveCounts(page, catalog)
      .replace('<!-- research-replay -->', researchReplay(LOCAL_EXAMPLE_FAILED_PROOF, LOCAL_EXAMPLE_PROOF, replay, locale, 'archive')), archiveVersions);
    fs.writeFileSync(path.join(output, directory, file), page);
  }
}
for (const file of presentationOnly ? ['design.css'] : ['site.css', 'replay.css', 'feedback.css', 'legal.css', 'initiative.css', 'design.css']) {
  fs.copyFileSync(path.join(root, 'docs', file), path.join(output, file));
}
// Embed the Latin fonts so the same typography works for file:// previews without font CORS errors.
// The CJK subsets are too large to inline; file:// previews fall back to system CJK fonts for them.
const landingCss = fs.readFileSync(path.join(root, 'docs/landing.css'), 'utf8')
  .replace(/url\("assets\/fonts\/([^"/]+\.woff2)"\)/g, (url, file: string) => /^Noto(Serif|Sans)SC-/.test(file) ? url
    : `url("data:font/woff2;base64,${fs.readFileSync(path.join(root, 'docs/assets/fonts', file)).toString('base64')}")`);
if (!presentationOnly) fs.writeFileSync(path.join(output, 'landing.css'), landingCss);
for (const [source, target] of [['design-fonts.css', 'fonts.css'], ['design-initiative-fonts.css', 'initiative-fonts.css']]) {
  const css = fs.readFileSync(path.join(root, 'docs', source), 'utf8')
    .replace(/url\("assets\/fonts\/([^"/]+\.woff2)"\)/g, (url, file: string) => /^Noto(Serif|Sans)SC-/.test(file) ? url
      : `url("data:font/woff2;base64,${fs.readFileSync(path.join(root, 'docs/assets/fonts', file)).toString('base64')}")`);
  fs.writeFileSync(path.join(output, target), css);
}
fs.copyFileSync(path.join(root, 'node_modules/lucide/LICENSE'), path.join(output, 'lucide-LICENSE.txt'));
if (fs.existsSync(path.join(root, 'docs/assets'))) {
  if (presentationOnly) {
    for (const file of fs.readdirSync(path.join(root, 'docs/assets/fonts')).filter(name => /-design-(home|initiative)-/.test(name))) {
      fs.copyFileSync(path.join(root, 'docs/assets/fonts', file), path.join(output, 'assets/fonts', file));
    }
  } else fs.cpSync(path.join(root, 'docs/assets'), path.join(output, 'assets'), { recursive: true });
}
fs.writeFileSync(path.join(output, '.nojekyll'), '');
// Site address and analytics are set in docs/web/site.ts and applied to every page here.
const origin = customDomain ? `https://${customDomain}` : pagesOrigin;
const analytics = analyticsWebsiteId ? `  <script defer src="https://cloud.umami.is/script.js" data-website-id="${analyticsWebsiteId}" data-domains="${new URL(origin).hostname}"></script>\n</head>` : '';
const htmlFiles = presentationOnly ? ['index.html', 'initiative.html']
  : fs.readdirSync(output, { recursive: true, encoding: 'utf8' }).filter(name => name.endsWith('.html'));
for (const file of htmlFiles) {
  let page = fs.readFileSync(path.join(output, file), 'utf8').replaceAll(pagesOrigin, origin);
  page = analytics ? page.replace('</head>', analytics).replace(/<!-- \/?analytics -->/g, '') : page.replace(/<!-- analytics -->[\s\S]*?<!-- \/analytics -->/g, '');
  fs.writeFileSync(path.join(output, file), page);
}
if (customDomain) fs.writeFileSync(path.join(output, 'CNAME'), `${customDomain}\n`);
else fs.rmSync(path.join(output, 'CNAME'), { force: true });
console.log(`Built ${catalog.records.length} archive records in ${path.relative(root, output)} (${revision.slice(0, 7)})`);
