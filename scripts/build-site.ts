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
const catalog = buildSiteCatalog(root, revision);
const output = path.join(root, 'out/site');
fs.mkdirSync(output, { recursive: true });
await buildArchive(root, output, catalog);
fs.writeFileSync(path.join(output, 'process.css'), fs.readFileSync(path.join(root, 'docs/process.css'), 'utf8')
  + '\n' + fs.readFileSync(path.join(root, 'apps/web/solutionRoute.css'), 'utf8'));
const archiveVersions = archiveAssetVersions(output);
await build({
  entryPoints: [path.join(root, 'docs/web/landing.ts')], outfile: path.join(output, 'landing.js'),
  bundle: true, platform: 'browser', format: 'iife', target: ['es2022'], minify: true,
  legalComments: 'eof',
});
for (const page of ['feedback', 'legal']) await build({
  entryPoints: [path.join(root, `docs/web/${page}.ts`)], outfile: path.join(output, `${page}.js`),
  bundle: true, platform: 'browser', format: 'iife', target: ['es2022'], minify: true,
  legalComments: 'eof',
});
const replay = JSON.parse(fs.readFileSync(path.join(root, 'docs/assets/replay.json'), 'utf8'));
for (const [locale, directory] of [['zh', ''], ['en', 'en']] as const) {
  fs.mkdirSync(path.join(output, directory), { recursive: true });
  const homepage = fs.readFileSync(path.join(root, 'docs', directory, 'index.html'), 'utf8')
    .replace('<!-- featured-proof -->', featuredProof(catalog, locale))
    .replace('<!-- research-replay -->', researchReplay(LOCAL_EXAMPLE_FAILED_PROOF, LOCAL_EXAMPLE_PROOF, replay, locale))
    .replace('<!-- accepted-count -->', String(catalog.records.filter(record => record.status === 'official_accepted').length))
    .replace('<!-- local-count -->', String(catalog.records.filter(record => record.status === 'locally_verified').length))
    .replace('<!-- accepted-proofs -->', acceptedProofRows(catalog, locale));
  fs.writeFileSync(path.join(output, directory, 'index.html'), homepage);
  for (const file of ['archive.html', 'feedback.html', 'privacy.html']) {
    let page = fs.readFileSync(path.join(root, 'docs', directory, file), 'utf8');
    if (file === 'archive.html') page = versionArchivePage(archiveCounts(page, catalog)
      .replace('<!-- research-replay -->', researchReplay(LOCAL_EXAMPLE_FAILED_PROOF, LOCAL_EXAMPLE_PROOF, replay, locale, 'archive')), archiveVersions);
    fs.writeFileSync(path.join(output, directory, file), page);
  }
}
for (const file of ['site.css', 'replay.css', 'feedback.css', 'legal.css']) fs.copyFileSync(path.join(root, 'docs', file), path.join(output, file));
// Embed the Latin fonts so the same typography works for file:// previews without font CORS errors.
// The CJK subsets are too large to inline; file:// previews fall back to system CJK fonts for them.
const landingCss = fs.readFileSync(path.join(root, 'docs/landing.css'), 'utf8')
  .replace(/url\("assets\/fonts\/([^"/]+\.woff2)"\)/g, (url, file: string) => /^Noto(Serif|Sans)SC-/.test(file) ? url
    : `url("data:font/woff2;base64,${fs.readFileSync(path.join(root, 'docs/assets/fonts', file)).toString('base64')}")`);
fs.writeFileSync(path.join(output, 'landing.css'), landingCss);
fs.copyFileSync(path.join(root, 'node_modules/lucide/LICENSE'), path.join(output, 'lucide-LICENSE.txt'));
if (fs.existsSync(path.join(root, 'docs/assets'))) {
  fs.cpSync(path.join(root, 'docs/assets'), path.join(output, 'assets'), { recursive: true });
}
fs.writeFileSync(path.join(output, '.nojekyll'), '');
// Site address and analytics are set in docs/web/site.ts and applied to every page here.
const origin = customDomain ? `https://${customDomain}` : pagesOrigin;
const analytics = analyticsWebsiteId ? `  <script defer src="https://cloud.umami.is/script.js" data-website-id="${analyticsWebsiteId}" data-domains="${new URL(origin).hostname}"></script>\n</head>` : '';
for (const file of fs.readdirSync(output, { recursive: true, encoding: 'utf8' }).filter(name => name.endsWith('.html'))) {
  let page = fs.readFileSync(path.join(output, file), 'utf8').replaceAll(pagesOrigin, origin);
  page = analytics ? page.replace('</head>', analytics).replace(/<!-- \/?analytics -->/g, '') : page.replace(/<!-- analytics -->[\s\S]*?<!-- \/analytics -->/g, '');
  fs.writeFileSync(path.join(output, file), page);
}
if (customDomain) fs.writeFileSync(path.join(output, 'CNAME'), `${customDomain}\n`);
else fs.rmSync(path.join(output, 'CNAME'), { force: true });
console.log(`Built ${catalog.records.length} archive records in ${path.relative(root, output)} (${revision.slice(0, 7)})`);
