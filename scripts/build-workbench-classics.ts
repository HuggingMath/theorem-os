import fs from 'node:fs';
import path from 'node:path';
import { campaignRecords } from '../docs/web/campaignCatalog';
import { siteRepository } from '../docs/web/site';
import type { ArchiveCatalog } from '../docs/web/types';
import { archiveAssetVersions, archiveCounts, buildArchive, versionArchivePage } from './site-archive';
import { researchReplay } from '../docs/web/presentation';
import { LOCAL_EXAMPLE_FAILED_PROOF, LOCAL_EXAMPLE_PROOF } from '../src/math/localExample';

/** A shared, read-only library shipped with the web image, independent of account-owned runs. */
export async function buildWorkbenchClassics(root: string, webOutput: string) {
  const campaign = campaignRecords(root);
  if (!campaign.records.length) throw new Error('No verified classic problems; import the campaign results before building the workbench.');
  const catalog: ArchiveCatalog = { schema: 'theoremos.public-archive.v1', repository: siteRepository, archiveRevision: 'main',
    snapshotAt: campaign.capturedAt!, records: campaign.records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) };
  const output = path.join(webOutput, 'classics');
  await buildArchive(root, output, catalog);
  fs.writeFileSync(path.join(output, 'process.css'), fs.readFileSync(path.join(root, 'docs/process.css'), 'utf8')
    + '\n' + fs.readFileSync(path.join(root, 'apps/web/solutionRoute.css'), 'utf8'));
  const archiveVersions = archiveAssetVersions(output);
  const replay = JSON.parse(fs.readFileSync(path.join(root, 'docs/assets/replay.json'), 'utf8'));
  for (const [locale, directory] of [['zh', ''], ['en', 'en']] as const) {
    const english = locale === 'en', workbench = english ? '../../' : '../', home = `https://theoremos.top/${english ? 'en/' : ''}`;
    let page = archiveCounts(fs.readFileSync(path.join(root, 'docs', directory, 'archive.html'), 'utf8'), catalog)
      .replace('<!-- research-replay -->', researchReplay(LOCAL_EXAMPLE_FAILED_PROOF, LOCAL_EXAMPLE_PROOF, replay, locale, 'archive'))
      .replace('<body>', '<body class="shared-classics">')
      .replaceAll('href="index.html"', `href="${workbench}"`)
      .replaceAll('href="index.html#start"', `href="${workbench}"`)
      .replaceAll('href="feedback.html"', `href="${home}feedback.html"`)
      .replaceAll('href="privacy.html"', `href="${home}privacy.html"`)
      .replace(/<p class="page-description">[\s\S]*?<\/p>/u, `<p class="page-description">${english
        ? 'Classic problems, proofs and research processes shared by all accounts. No API key needed.'
        : '所有账户共享的经典题目、证明与解题过程。无需 API Key。'}</p>`)
      .replace(/<link rel="alternate"[^>]+>/gu, '');
    page = english
      ? page.replaceAll('Proof archive', 'Classic problems').replaceAll('proof archive', 'classic problem library')
        .replace(`<a href="${workbench}"><span>Home</span>`, `<a href="${workbench}" aria-label="Back to workbench"><i data-lucide="chevron-left"></i><span>Workbench</span>`).replace('>Request access<', '>Research workbench<')
        .replace('aria-label="TheoremOS home"', 'aria-label="Back to workbench"')
      : page.replaceAll('证明档案', '经典题库').replace(`<a href="${workbench}"><span>产品首页</span>`, `<a href="${workbench}" aria-label="返回工作台"><i data-lucide="chevron-left"></i><span>工作台</span>`)
        .replace('>申请内测<', '>研究工作台<').replace('aria-label="TheoremOS 首页"', 'aria-label="返回工作台"');
    fs.mkdirSync(path.join(output, directory), { recursive: true });
    fs.writeFileSync(path.join(output, directory, 'archive.html'), versionArchivePage(page, archiveVersions));
  }
  // Zero official/snapshot counts stay in the DOM for the shared archive renderer, without empty filters in this library.
  const css = fs.readFileSync(path.join(root, 'docs/site.css'), 'utf8') + `
.shared-classics .metrics { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.shared-classics .metric:has(#accepted-count), .shared-classics .metric:has(#progress-count),
.shared-classics .status-filter label:has(input[value="accepted"]), .shared-classics .status-filter label:has(input[value="progress"]) { display: none; }
.shared-classics .metric:has(#verified-count) { padding-left: 0; }
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
