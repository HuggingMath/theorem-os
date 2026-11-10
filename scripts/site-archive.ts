import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { archiveIndex, archiveSourceScript, archiveProcessScript } from '../docs/web/catalog';
import type { ArchiveCatalog } from '../docs/web/types';

/** The website and the account workbench publish the same checked proof files and lazy research records. */
export async function buildArchive(root: string, output: string, catalog: ArchiveCatalog) {
  fs.mkdirSync(output, { recursive: true });
  const data = path.join(output, 'data');
  fs.rmSync(data, { recursive: true, force: true });
  for (const directory of ['sources', 'process', 'proofs']) fs.mkdirSync(path.join(data, directory), { recursive: true });
  const math = path.join(data, 'math.js');
  await build({ entryPoints: [path.join(root, 'apps/web/client/math.ts')], outfile: math,
    bundle: true, platform: 'browser', format: 'iife', target: ['es2022'], minify: true, legalComments: 'eof' });
  const mathVersion = createHash('sha256').update(fs.readFileSync(math)).digest('hex').slice(0, 16);
  fs.mkdirSync(path.join(output, 'assets/katex'), { recursive: true });
  fs.cpSync(path.join(root, 'node_modules/katex/dist/fonts'), path.join(output, 'assets/katex/fonts'), { recursive: true });
  fs.copyFileSync(path.join(root, 'node_modules/katex/dist/katex.min.css'), path.join(output, 'assets/katex/katex.min.css'));
  fs.mkdirSync(path.join(output, 'assets/licenses'), { recursive: true });
  fs.copyFileSync(path.join(root, 'node_modules/katex/LICENSE'), path.join(output, 'assets/licenses/katex-LICENSE.txt'));
  const figures = path.join(data, 'proof-figures.js');
  await build({
    entryPoints: [path.join(root, 'docs/web/proofFigureRuntime.ts')], outfile: figures,
    bundle: true, platform: 'browser', format: 'iife', target: ['es2022'], minify: true, charset: 'utf8', legalComments: 'eof',
  });
  const figuresVersion = createHash('sha256').update(fs.readFileSync(figures)).digest('hex').slice(0, 16);
  const routes = path.join(data, 'solution-route.js');
  await build({
    entryPoints: [path.join(root, 'docs/web/solutionRouteRuntime.ts')], outfile: routes,
    bundle: true, platform: 'browser', format: 'iife', target: ['es2022'], minify: true, charset: 'utf8', legalComments: 'eof',
  });
  const routesVersion = createHash('sha256').update(fs.readFileSync(routes)).digest('hex').slice(0, 16);
  await build({
    entryPoints: [path.join(root, 'docs/web/app.ts')], outfile: path.join(output, 'site.js'),
    bundle: true, platform: 'browser', format: 'iife', target: ['es2022'], minify: true, charset: 'utf8', legalComments: 'eof',
    plugins: [{ name: 'public-archive', setup(builder) {
      builder.onResolve({ filter: /^virtual:(archive|proof-figures|solution-route|math)$/ }, args => ({ path: args.path, namespace: 'public-archive' }));
      builder.onLoad({ filter: /.*/, namespace: 'public-archive' }, args => ({
        contents: JSON.stringify(args.path === 'virtual:archive' ? archiveIndex(catalog) : args.path === 'virtual:proof-figures' ? figuresVersion : args.path === 'virtual:math' ? mathVersion : routesVersion), loader: 'json',
      }));
    } }],
  });
  // The complete original records remain portable. Derived route indexes load per problem instead of
  // duplicating every historical source index in the aggregate catalog (and exceeding static asset limits).
  const portable = { ...catalog, records: catalog.records.map(record => {
    if (!record.process) return record;
    const { sourceRoute: _sourceRoute, ...process } = record.process;
    return { ...record, process };
  }) };
  fs.writeFileSync(path.join(data, 'catalog.json'), JSON.stringify(portable, null, 2) + '\n');
  // Library browsing needs only metadata; sources and recorded processes continue to load per problem.
  fs.writeFileSync(path.join(data, 'index.json'), JSON.stringify(archiveIndex(catalog)) + '\n');
  for (const record of catalog.records) {
    fs.writeFileSync(path.join(data, 'sources', `${record.id}.js`), archiveSourceScript(record));
    if (record.process) fs.writeFileSync(path.join(data, 'process', `${record.id}.js`), archiveProcessScript(record));
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
  }
}

type ArchiveAssetVersions = Record<'site.js' | 'process.css', string>;

export function archiveAssetVersions(output: string): ArchiveAssetVersions {
  const digest = (file: string) => createHash('sha256').update(fs.readFileSync(path.join(output, file))).digest('hex').slice(0, 16);
  return { 'site.js': digest('site.js'), 'process.css': digest('process.css') };
}

export function versionArchivePage(page: string, versions: ArchiveAssetVersions): string {
  return page.replace(/(\s(?:src|href)\s*=\s*)(["'])((?:\.\.?\/)*(site\.js|process\.css))(\?[^"'#]*)?(#[^"']*)?\2/gu,
    (_match, attribute: string, quote: string, assetPath: string, asset: keyof ArchiveAssetVersions, query = '', fragment = '') => {
      const parameters = new URLSearchParams(query.slice(1).replaceAll('&amp;', '&'));
      parameters.set('v', versions[asset]);
      return `${attribute}${quote}${assetPath}?${parameters.toString().replaceAll('&', '&amp;')}${fragment}${quote}`;
    });
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
