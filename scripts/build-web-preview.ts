#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/** Builds the component preview into out/web-preview. It is a development page and never ships with the workbench. */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'out/web-preview');
fs.mkdirSync(path.join(output, 'assets/fonts'), { recursive: true });
await build({ entryPoints: [path.join(root, 'apps/web/preview/preview.tsx')], outfile: path.join(output, 'preview.js'),
  bundle: true, minify: true, target: 'es2023', platform: 'browser', legalComments: 'eof', logLevel: 'silent',
  jsx: 'automatic', jsxImportSource: 'preact' });
fs.copyFileSync(path.join(root, 'apps/web/client/app.css'), path.join(output, 'app.css'));
for (const file of ['index.html', 'preview.css']) fs.copyFileSync(path.join(root, 'apps/web/preview', file), path.join(output, file));
for (const file of ['mark.svg', 'favicon.svg', ...fs.readdirSync(path.join(root, 'docs/assets/fonts')).filter(name => name.endsWith('.woff2')).map(font => `fonts/${font}`)])
  fs.copyFileSync(path.join(root, 'docs/assets', file), path.join(output, 'assets', file));
console.log('Built component preview in out/web-preview');
