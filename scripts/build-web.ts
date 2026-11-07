#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { build } from 'esbuild';
import { compressible, precompressed } from '../apps/web/staticFiles';
import { buildWorkbenchClassics } from './build-workbench-classics';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web');
// Offline report pages that the server must not serve (apps/web/staticReport.ts inlines them into one file).
const reports = path.join(root, 'out/web-report');
fs.mkdirSync(output, { recursive: true });
fs.mkdirSync(reports, { recursive: true });
const bundle = (entry: string, directory: string, format?: 'esm') =>
  build({ entryPoints: [path.join(root, `apps/web/client/${entry}.ts`)], outfile: path.join(directory, `${entry}.js`),
    bundle: true, minify: true, target: 'es2023', platform: 'browser', legalComments: 'eof', logLevel: 'silent',
    jsx: 'automatic', jsxImportSource: 'preact', external: ['/math.js'], ...format ? { format } : {} });
for (const entry of ['theme', 'app', 'login', 'share', 'guide', 'legal', 'explain', 'formalize']) await bundle(entry, output);
// KaTeX, imported by the chat when a formula first appears.
await bundle('math', output, 'esm');
await bundle('formalization', reports);
fs.copyFileSync(path.join(root, 'apps/web/client/formalization.html'), path.join(reports, 'formalization.html'));
for (const [source, destination] of [['index.html', 'index.html'], ['login.html', 'login.html'], ['share.html', 'share.html'], ['guide.html', 'guide.html'], ['terms.html', 'terms.html'], ['privacy.html', 'privacy.html'], ['explain.html', 'explain.html'], ['app.css', 'app.css'], ['formalize.html', 'formalize.html'], ['formalize.css', 'formalize.css'], ['research-conversation.css', 'research-conversation.css']])
  fs.copyFileSync(path.join(root, 'apps/web/client', source), path.join(output, destination));
fs.mkdirSync(path.join(output, 'assets/fonts'), { recursive: true });
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
// Brotli at the maximum quality once here, so the server sends the smaller form without paying for it per request.
for (const file of fs.readdirSync(output, { recursive: true, encoding: 'utf8' }).map(name => path.join(output, name))) {
  if (file.endsWith('.br') || !fs.statSync(file).isFile()) continue;
  const content = fs.readFileSync(file);
  if (compressible.has(path.extname(file)) && content.length > 1024) fs.writeFileSync(`${file}.br`, zlib.brotliCompressSync(content, precompressed));
  else fs.rmSync(`${file}.br`, { force: true });
}
console.log(`Built research workbench in out/web, ${classics} shared classic solutions, and report pages in out/web-report`);
