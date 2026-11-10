import type { ArchiveIndexRecord } from './types';
import type { Locale } from './site';

const html = (value: string) => value.replace(/[&<>"']/gu, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));

/** Describe the original-target acceptance before its technical receipts. */
export function renderAcceptedTargets(record: ArchiveIndexRecord, locale: Locale): string {
  const campaign = record.campaign;
  if (!campaign) return '';
  const text = (zh: string, en: string) => locale === 'en' ? en : zh;
  const summary = locale === 'en' ? record.en?.summary ?? record.summary : record.summary;
  return `<section class="acceptance-mathematics" data-acceptance-mathematics data-accepted-proof="${campaign.proofSha256}">
    <h4>${text('原题与验收结论', 'Original problem and accepted conclusions')}</h4><p class="workflow-prose">${html(summary)}</p>
    <div class="process-detail-actions"><button type="button" class="button" data-action="view-statement">${text('查看完整原题', 'View the complete problem')}</button><button type="button" class="button" data-tab="reading">${text('阅读已验收证明', 'Read the accepted proof')}</button></div>
    <p class="acceptance-target-note">${text(`以下 ${campaign.targets.length} 个原题目标一并通过 Lean 内核检查和原题 comparator 验收。`, `All ${campaign.targets.length} original targets below passed the Lean kernel checks and the original comparator together.`)}</p>
    <ol class="acceptance-targets">${campaign.targets.map(target => `<li data-accepted-target="${html(target)}"><code>${html(target)}</code><span>${text('原题验收通过', 'Original-target acceptance passed')}</span></li>`).join('')}</ol>
  </section>`;
}
