#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web');
// Offline report pages that the server must not serve (apps/web/staticReport.ts inlines them into one file).
const reports = path.join(root, 'out/web-report');
fs.mkdirSync(output, { recursive: true });
fs.mkdirSync(reports, { recursive: true });
const bundle = (entry: string, directory: string) =>
  build({ entryPoints: [path.join(root, `apps/web/client/${entry}.ts`)], outfile: path.join(directory, `${entry}.js`),
    bundle: true, minify: true, target: 'es2023', platform: 'browser', legalComments: 'eof', logLevel: 'silent',
    jsx: 'automatic', jsxImportSource: 'preact' });
for (const entry of ['theme', 'app', 'login', 'share', 'guide', 'explain']) await bundle(entry, output);
await bundle('formalization', reports);
fs.copyFileSync(path.join(root, 'apps/web/client/formalization.html'), path.join(reports, 'formalization.html'));
for (const [source, destination] of [['index.html', 'index.html'], ['login.html', 'login.html'], ['share.html', 'share.html'], ['guide.html', 'guide.html'], ['explain.html', 'explain.html'], ['app.css', 'app.css']])
  fs.copyFileSync(path.join(root, 'apps/web/client', source), path.join(output, destination));
fs.mkdirSync(path.join(output, 'assets/fonts'), { recursive: true });
const fonts = ['InterVariable-latin.woff2', 'Inter-LICENSE.txt', 'TheoremOSSerif-latin.woff2', 'Lora-OFL.txt', 'JetBrainsMono.woff2', 'JetBrainsMono-OFL.txt',
  'NotoSerifSC-ui.woff2', 'NotoSerifSC-common.woff2', 'NotoSerifSC-OFL.txt', 'NotoSansSC-ui.woff2', 'NotoSansSC-common.woff2', 'NotoSansSC-OFL.txt'];
for (const file of ['mark.svg', ...fonts.map(font => `fonts/${font}`)])
  fs.copyFileSync(path.join(root, 'docs/assets', file), path.join(output, 'assets', file));
fs.mkdirSync(path.join(output, 'assets/licenses'), { recursive: true });
fs.copyFileSync(path.join(root, 'node_modules/diff/LICENSE'), path.join(output, 'assets/licenses/diff-LICENSE.txt'));
fs.copyFileSync(path.join(root, 'docs/assets/licenses/gsap-NOTICE.txt'), path.join(output, 'assets/licenses/gsap-NOTICE.txt'));
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(output, 'LICENSE.txt'));
console.log('Built research workbench in out/web and report pages in out/web-report');
