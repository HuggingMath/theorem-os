import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { archiveIndex, archiveSourceScript } from '../docs/web/catalog';
import type { ArchiveCatalog } from '../docs/web/types';

/** The website and the account workbench publish the same checked proof files and lazy research records. */
export async function buildArchive(root: string, output: string, catalog: ArchiveCatalog) {
  fs.mkdirSync(output, { recursive: true });
  await build({
    entryPoints: [path.join(root, 'docs/web/app.ts')], outfile: path.join(output, 'site.js'),
    bundle: true, platform: 'browser', format: 'iife', target: ['es2022'], minify: true, charset: 'utf8', legalComments: 'eof',
    plugins: [{ name: 'public-archive', setup(builder) {
      builder.onResolve({ filter: /^virtual:archive$/ }, () => ({ path: 'archive', namespace: 'public-archive' }));
      builder.onLoad({ filter: /.*/, namespace: 'public-archive' }, () => ({ contents: JSON.stringify(archiveIndex(catalog)), loader: 'json' }));
    } }],
  });
  const data = path.join(output, 'data');
  fs.rmSync(data, { recursive: true, force: true });
  for (const directory of ['sources', 'process', 'proofs']) fs.mkdirSync(path.join(data, directory), { recursive: true });
  fs.writeFileSync(path.join(data, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
  for (const record of catalog.records) {
    fs.writeFileSync(path.join(data, 'sources', `${record.id}.js`), archiveSourceScript(record));
    if (!record.campaign) continue;
    const proofs = path.join(data, 'proofs', record.id);
    fs.mkdirSync(proofs, { recursive: true });
    for (const source of record.sources) {
      const filename = path.join(proofs, source.name);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, source.code);
    }
    for (const name of ['process.json', 'verification.json']) fs.copyFileSync(
      path.join(root, 'research/openai-math', record.campaign.target, name), path.join(proofs, name));
    fs.writeFileSync(path.join(data, 'process', `${record.id}.js`),
      `(window.theoremosProcesses??={})[${JSON.stringify(record.id)}]=${JSON.stringify(record.process)};\n`);
  }
}

export function archiveCounts(page: string, catalog: ArchiveCatalog): string {
  const official = catalog.records.filter(record => record.status === 'official_accepted').length;
  const local = catalog.records.filter(record => record.status === 'locally_verified').length;
  const progress = catalog.records.length - official - local;
  const counts: Record<string, number> = { 'nav-count': catalog.records.length, 'all-filter-count': catalog.records.length,
    'accepted-count': official, 'accepted-filter-count': official, 'verified-count': local, 'verified-filter-count': local,
    'progress-count': progress, 'progress-filter-count': progress };
  for (const [id, value] of Object.entries(counts)) page = page.replace(new RegExp(`(id="${id}">)[^<]*`, 'u'), `$1${value}`);
  return page;
}
