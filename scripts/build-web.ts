#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { compressible, precompressed } from '../apps/web/staticFiles';
import { buildWorkbenchClassics } from './build-workbench-classics';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web');
// Offline report pages that the server must not serve (apps/web/staticReport.ts inlines them into one file).
const reports = path.join(root, 'out/web-report');
fs.mkdirSync(output, { recursive: true });
fs.mkdirSync(reports, { recursive: true });
const bundle = (entry: string, directory: string) =>
  build({ entryPoints: [path.join(root, `apps/web/client/${entry}.ts`)], outfile: path.join(directory, `${entry}.js`),
    bundle: true, minify: true, target: 'es2023', platform: 'browser', legalComments: 'eof', logLevel: 'silent',
    jsx: 'automatic', jsxImportSource: 'preact', format: 'iife' });
for (const entry of ['theme', 'app', 'login', 'share', 'guide', 'legal', 'explain', 'formalize', 'research', 'practice']) await bundle(entry, output);
// One classic script supports lazy formulas in online pages and self-contained offline reports.
await bundle('math', output);
await bundle('formalization', reports);
fs.copyFileSync(path.join(root, 'apps/web/client/formalization.html'), path.join(reports, 'formalization.html'));
for (const [source, destination] of [['index.html', 'index.html'], ['login.html', 'login.html'], ['share.html', 'share.html'], ['guide.html', 'guide.html'], ['terms.html', 'terms.html'], ['privacy.html', 'privacy.html'], ['explain.html', 'explain.html'], ['app.css', 'app.css'], ['formalize.html', 'formalize.html'], ['formalize.css', 'formalize.css'], ['research-conversation.css', 'research-conversation.css']])
  if (source === 'app.css') fs.writeFileSync(path.join(output, destination), fs.readFileSync(path.join(root, 'apps/web/client', source), 'utf8')
    + '\n' + fs.readFileSync(path.join(root, 'apps/web/solutionRoute.css'), 'utf8')
    + '\n' + fs.readFileSync(path.join(root, 'apps/web/client/productFlow.css'), 'utf8')
    + '\n' + fs.readFileSync(path.join(root, 'apps/web/client/research-overview.css'), 'utf8')
    + '\n' + fs.readFileSync(path.join(root, 'apps/web/client/decisionFlow.css'), 'utf8')
    + '\n' + fs.readFileSync(path.join(root, 'apps/web/client/researchBudget.css'), 'utf8')
    + '\n' + fs.readFileSync(path.join(root, 'apps/web/client/researchPersonal.css'), 'utf8')
    + '\n' + fs.readFileSync(path.join(root, 'apps/web/math.css'), 'utf8'));
  else fs.copyFileSync(path.join(root, 'apps/web/client', source), path.join(output, destination));
fs.mkdirSync(path.join(output, 'assets/fonts'), { recursive: true });
for (const file of ['people.html', 'theorems.html', 'library.html', 'workspace.html', 'problem.html', 'invite.html', 'practice.html', 'researchPractice.css'])
  fs.copyFileSync(path.join(root, 'apps/web/client', file), path.join(output, file));
fs.writeFileSync(path.join(output, 'research.css'), ['research.css', 'collaborationFlow.css', 'researchCollections.css', 'researchWorkspace.css', 'researchProblem.css', 'researchLibraryTrials.css', 'researchCandidateContinuity.css', 'researchJourney.css', 'researchInlineActions.css', 'researchPersonal.css', 'researchBudget.css']
  .map(file => fs.readFileSync(path.join(root, 'apps/web/client', file), 'utf8')).join('\n'));
const fonts = ['InterVariable-latin.woff2', 'Inter-LICENSE.txt', 'TheoremOSSerif-latin.woff2', 'Lora-OFL.txt', 'JetBrainsMono.woff2', 'JetBrainsMono-OFL.txt',
  'NotoSerifSC-ui.woff2', 'NotoSerifSC-ui-extra.woff2', 'NotoSerifSC-common.woff2', 'NotoSerifSC-OFL.txt', 'NotoSansSC-ui.woff2', 'NotoSansSC-ui-extra.woff2', 'NotoSansSC-common.woff2', 'NotoSansSC-OFL.txt'];
for (const file of ['mark.svg', ...fonts.map(font => `fonts/${font}`)])
  fs.copyFileSync(path.join(root, 'docs/assets', file), path.join(output, 'assets', file));
fs.mkdirSync(path.join(output, 'assets/licenses'), { recursive: true });
fs.cpSync(path.join(root, 'node_modules/katex/dist/fonts'), path.join(output, 'assets/katex/fonts'), { recursive: true });
fs.copyFileSync(path.join(root, 'node_modules/katex/dist/katex.min.css'), path.join(output, 'assets/katex/katex.min.css'));
for (const name of ['marked', 'katex'])
  fs.copyFileSync(path.join(root, 'node_modules', name, 'LICENSE'), path.join(output, 'assets/licenses', `${name}-LICENSE.txt`));
fs.copyFileSync(path.join(root, 'node_modules/diff/LICENSE'), path.join(output, 'assets/licenses/diff-LICENSE.txt'));
fs.copyFileSync(path.join(root, 'docs/assets/licenses/gsap-NOTICE.txt'), path.join(output, 'assets/licenses/gsap-NOTICE.txt'));
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(output, 'LICENSE.txt'));
const classics = await buildWorkbenchClassics(root, output);
const buildDigest = crypto.createHash('sha256');
// Identify the complete shipped frontend, including page text, fonts and classic records.
// Compression and the derived identity file do not change the content identity.
for (const name of fs.readdirSync(output, { recursive: true, encoding: 'utf8' }).sort()) {
  const file = path.join(output, name);
  if (name === 'build-info.json' || name.endsWith('.br') || !fs.statSync(file).isFile()) continue;
  buildDigest.update(name).update('\0').update(fs.readFileSync(file)).update('\0');
}
const digest = buildDigest.digest('hex');
let commit: string | undefined, modified = false;
try {
  const value = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (/^[a-f0-9]{40}$/u.test(value)) commit = value;
  modified = Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=normal', '--', 'apps/web', 'scripts/build-web.ts'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
} catch { /* Container builds may omit Git; the frontend digest still identifies the built bytes. */ }
fs.writeFileSync(path.join(output, 'build-info.json'), JSON.stringify({ schema: 'theorem-os.web-build.v1', builtAt: new Date().toISOString(), digest, ...(commit ? { commit } : {}), ...(modified ? { modified: true } : {}) }));
for (const name of fs.readdirSync(output).filter(name => name.endsWith('.html'))) {
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
