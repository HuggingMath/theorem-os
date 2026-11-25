#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { compressible, precompressed, versionedEntryFile } from '../apps/web/staticFiles';
import { buildWorkbenchClassics } from './build-workbench-classics';
import { bundleSources, scanBundle } from './web-i18n';
import { en } from '../apps/web/i18n/en';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web');
// Offline report pages that the server must not serve (apps/web/staticReport.ts inlines them into one file).
const reports = path.join(root, 'out/web-report');
fs.mkdirSync(output, { recursive: true });
fs.rmSync(path.join(output, 'chunks'), { recursive: true, force: true });
for (const name of fs.readdirSync(output)) {
  if (versionedEntryFile.test(name.replace(/\.br$/u, ''))) fs.rmSync(path.join(output, name));
}
fs.mkdirSync(reports, { recursive: true });
// Saved mathematical content can choose English independently of the interface. Keep those callers' keys available
// in Chinese pages too; the rest of the English interface is loaded only when the page itself needs it.
const contentKeys = scanBundle(bundleSources().filter(file => /\btranslator\s*\(/u.test(fs.readFileSync(file, 'utf8')))).keys;
const contentEnglish = Object.fromEntries([...contentKeys.keys()].filter(key => en[key]).map(key => [key, en[key]]));
const bundle = (entries: string[], directory: string, englishOnDemand = false) =>
  build({ entryPoints: entries.map(entry => path.join(root, `apps/web/client/${entry}.ts`)),
    outdir: directory, chunkNames: 'chunks/[name]-[hash]', splitting: englishOnDemand,
    format: englishOnDemand ? 'esm' : 'iife',
    bundle: true, minify: true, target: 'es2023', platform: 'browser', legalComments: 'eof', logLevel: 'silent',
    plugins: englishOnDemand ? [{ name: 'workbench-english-on-demand', setup(builder) {
      builder.onResolve({ filter: /^\.\/i18n\/en$/ }, () => ({ path: 'workbench-english', namespace: 'workbench-english' }));
      builder.onLoad({ filter: /.*/, namespace: 'workbench-english' }, () => ({ loader: 'ts', resolveDir: root,
        contents: `import { locale } from ${JSON.stringify(path.join(root, 'apps/web/i18nLocale.ts'))};
          export const en = locale === 'en' ? (await import(${JSON.stringify(path.join(root, 'apps/web/i18n/en.ts'))})).en : ${JSON.stringify(contentEnglish)};` }));
    } }] : [],
    jsx: 'automatic', jsxImportSource: 'preact' });
// Bundle each online entry individually so dynamic imports stay lazy without creating dozens of shared chunk requests.
for (const entry of ['app', 'login', 'share', 'guide', 'legal', 'formalize', 'research', 'practice']) await bundle([entry], output, true);
// Theme runs before CSS. Theme, explain and math are also inlined in standalone reports.
await bundle(['theme', 'explain', 'math'], output);
await bundle(['formalization'], reports);
for (const page of ['formalization.html', 'explain.html'])
  fs.copyFileSync(path.join(root, 'apps/web/client', page), path.join(reports, page));
for (const [source, destination] of [['index.html', 'index.html'], ['login.html', 'login.html'], ['share.html', 'share.html'], ['guide.html', 'guide.html'], ['terms.html', 'terms.html'], ['privacy.html', 'privacy.html'], ['explain.html', 'explain.html'], ['app.css', 'app.css'], ['formalize.html', 'formalize.html'], ['formalize.css', 'formalize.css'], ['research-conversation.css', 'research-conversation.css']])
  if (source === 'app.css') fs.writeFileSync(path.join(output, destination), fs.readFileSync(path.join(root, 'apps/web/client', source), 'utf8')
    + '\n' + fs.readFileSync(path.join(root, 'apps/web/solutionRoute.css'), 'utf8')
    + '\n' + fs.readFileSync(path.join(root, 'apps/web/client/productFlow.css'), 'utf8')
    + '\n' + fs.readFileSync(path.join(root, 'apps/web/client/research-overview.css'), 'utf8')
    + '\n' + fs.readFileSync(path.join(root, 'apps/web/client/decisionFlow.css'), 'utf8')
    + '\n' + fs.readFileSync(path.join(root, 'apps/web/client/researchBudget.css'), 'utf8')
    + '\n' + fs.readFileSync(path.join(root, 'apps/web/client/researchPersonal.css'), 'utf8')
    + '\n' + fs.readFileSync(path.join(root, 'apps/web/client/proofMap.css'), 'utf8')
    + '\n' + fs.readFileSync(path.join(root, 'apps/web/math.css'), 'utf8'));
  else fs.copyFileSync(path.join(root, 'apps/web/client', source), path.join(output, destination));
fs.mkdirSync(path.join(output, 'assets/fonts'), { recursive: true });
for (const file of ['people.html', 'theorems.html', 'library.html', 'workspace.html', 'problem.html', 'invite.html', 'practice.html', 'researchPractice.css'])
  fs.copyFileSync(path.join(root, 'apps/web/client', file), path.join(output, file));
fs.writeFileSync(path.join(output, 'research.css'), ['research.css', 'collaborationFlow.css', 'researchCollections.css', 'researchWorkspace.css', 'researchProblem.css', 'researchLibraryTrials.css', 'researchCandidateContinuity.css', 'researchJourney.css', 'researchInlineActions.css', 'researchPersonal.css', 'researchBudget.css']
  .map(file => fs.readFileSync(path.join(root, 'apps/web/client', file), 'utf8')).join('\n'));
const fonts = ['Geist-latin.woff2', 'Geist-OFL.txt', 'TheoremOSSerif-latin.woff2', 'Lora-OFL.txt', 'JetBrainsMono.woff2', 'JetBrainsMono-OFL.txt',
  'TheoremOSWorkbenchHeading.woff2',
  'NotoSerifSC-ui.woff2', 'NotoSerifSC-ui-extra.woff2', 'NotoSerifSC-common.woff2', 'NotoSerifSC-OFL.txt', 'NotoSansSC-ui.woff2', 'NotoSansSC-ui-extra.woff2', 'NotoSansSC-common.woff2', 'NotoSansSC-OFL.txt'];
for (const name of fs.readdirSync(path.join(output, 'assets'))) {
  if (/^(?:mark|favicon)\.[a-f0-9]{12}\.svg(?:\.br)?$/u.test(name)) fs.rmSync(path.join(output, 'assets', name));
}
const hashedBrandAssets = new Map<string, string>();
for (const file of ['mark.svg', 'favicon.svg', ...fonts.map(font => `fonts/${font}`)]) {
  const target = path.join(output, 'assets', file);
  fs.copyFileSync(path.join(root, 'docs/assets', file), target);
  if (file === 'mark.svg' || file === 'favicon.svg') {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex').slice(0, 12);
    const versionedName = `assets/${path.basename(file, '.svg')}.${hash}.svg`;
    fs.copyFileSync(target, path.join(output, versionedName));
    hashedBrandAssets.set(`assets/${file}`, versionedName);
  }
}
const versionBrandRefs = (text: string) => {
  let out = text;
  for (const [source, versioned] of hashedBrandAssets) out = out.replaceAll(source, versioned);
  return out;
};
for (const file of fs.readdirSync(output, { recursive: true, encoding: 'utf8' })) {
  if (!file.endsWith('.js')) continue;
  const full = path.join(output, file);
  fs.writeFileSync(full, versionBrandRefs(fs.readFileSync(full, 'utf8')));
}
fs.mkdirSync(path.join(output, 'assets/licenses'), { recursive: true });
fs.cpSync(path.join(root, 'node_modules/katex/dist/fonts'), path.join(output, 'assets/katex/fonts'), { recursive: true });
fs.copyFileSync(path.join(root, 'node_modules/katex/dist/katex.min.css'), path.join(output, 'assets/katex/katex.min.css'));
for (const name of ['marked', 'katex'])
  fs.copyFileSync(path.join(root, 'node_modules', name, 'LICENSE'), path.join(output, 'assets/licenses', `${name}-LICENSE.txt`));
fs.copyFileSync(path.join(root, 'node_modules/diff/LICENSE'), path.join(output, 'assets/licenses/diff-LICENSE.txt'));
fs.copyFileSync(path.join(root, 'docs/assets/licenses/gsap-NOTICE.txt'), path.join(output, 'assets/licenses/gsap-NOTICE.txt'));
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(output, 'LICENSE.txt'));
const classics = await buildWorkbenchClassics(root, output);
// Every page opening from a new deployment gets its matching scripts and styles, even through a browser cache.
const pages = fs.readdirSync(output).filter(name => name.endsWith('.html'));
const versioned = new Map<string, string>();
for (const page of pages) {
  const file = path.join(output, page);
  const html = fs.readFileSync(file, 'utf8').replace(
    /(<(?:script\b[^>]*?\bsrc|link\b[^>]*?\bhref)=")([a-z][a-z0-9-]*\.(?:js|css))"/gu,
    (_match, attribute: string, name: string) => {
      let asset = versioned.get(name);
      if (!asset) {
        const bytes = fs.readFileSync(path.join(output, name));
        const hash = crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16);
        const extension = path.extname(name);
        asset = `${path.basename(name, extension)}.${hash}${extension}`;
        fs.writeFileSync(path.join(output, asset), bytes);
        versioned.set(name, asset);
      }
      return `${attribute}${asset}"`;
    });
  fs.writeFileSync(file, page === 'explain.html' || page === 'formalization.html' ? html : versionBrandRefs(html));
}
const buildDigest = crypto.createHash('sha256');
// Identify the complete shipped frontend, including page text, fonts and classic records.
// Compression and the derived identity file do not change the content identity.
for (const name of fs.readdirSync(output, { recursive: true, encoding: 'utf8' }).sort()) {
  const file = path.join(output, name);
  if (name === 'build-info.json' || name.endsWith('.br') || !fs.statSync(file).isFile()) continue;
  buildDigest.update(name).update('\0').update(fs.readFileSync(file)).update('\0');
}
const digest = buildDigest.digest('hex');
const buildCommit = process.env.THEOREMOS_SOURCE_COMMIT ?? '';
let commit = /^[a-f0-9]{40}$/u.test(buildCommit) ? buildCommit : undefined;
let modified = false;
try {
  const value = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (/^[a-f0-9]{40}$/u.test(value)) commit = value;
  modified = Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=normal', '--', 'apps/web', 'scripts/build-web.ts'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
} catch { /* Container builds may omit Git and supply the commit as a build argument. */ }
fs.writeFileSync(path.join(output, 'build-info.json'), JSON.stringify({ schema: 'theorem-os.web-build.v1', builtAt: new Date().toISOString(), digest, ...(commit ? { commit } : {}), ...(modified ? { modified: true } : {}) }));
for (const name of pages) {
  const file = path.join(output, name), html = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, html.replace('</head>', `<meta name="theoremos-build" content="${digest}"></head>`));
}
// Brotli at the maximum quality once here, so the server sends the smaller form without paying for it per request.
for (const file of fs.readdirSync(output, { recursive: true, encoding: 'utf8' }).map(name => path.join(output, name))) {
  if (file.endsWith('.br') || !fs.statSync(file).isFile()) continue;
  const content = fs.readFileSync(file);
  if (compressible.has(path.extname(file)) && content.length > 1024) fs.writeFileSync(`${file}.br`, zlib.brotliCompressSync(content, precompressed));
  else fs.rmSync(`${file}.br`, { force: true });
}
console.log(`Built research workbench in out/web, ${classics} shared classic solutions, and report pages in out/web-report`);
