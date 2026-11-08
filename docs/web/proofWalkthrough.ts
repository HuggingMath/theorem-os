import type { ArchiveIndexRecord, ArchiveProcess } from './types';
import type { Locale } from './site';
import type { Localized, ProofWalkthrough } from './proofWalkthroughTypes';
import { archiveRoadmapTaskLabel } from './roadmapLabels';

type Run = ArchiveProcess['runs'][number];
const html = (value: unknown) => String(value ?? '').replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const label = (value: Localized, locale: Locale) => locale === 'en' ? value.en : value.zh;
const text = (locale: Locale, zh: string, en: string) => locale === 'en' ? en : zh;
const stepId = (id: string) => `proof-derivation-${id}`;

export function selectedProofWalkthrough(record: ArchiveIndexRecord, process: ArchiveProcess, run: Run): ProofWalkthrough | undefined {
  const walkthrough = process.walkthrough;
  return walkthrough?.recordId === record.id && walkthrough.runId === run.runId && walkthrough.runId === record.campaign?.runId
    && walkthrough.proofSha256 === record.campaign.proofSha256 && process.sources?.[walkthrough.proofSha256] ? walkthrough : undefined;
}

export function renderProofWalkthrough(walkthrough: ProofWalkthrough, process: ArchiveProcess, run: Run, locale: Locale): string {
  const source = process.sources![walkthrough.proofSha256];
  const lines = source.code.split('\n');
  const original = run.checks!.find(check => check.scope === 'original' && check.status === 'kernel_verified' && check.sourceDigest === walkthrough.proofSha256)!;
  const destination = (node: string, step?: string) => `data-global-run="${html(run.runId)}" data-global-node="${html(node)}"${step ? ` data-global-step="${html(step)}"` : ''}`;
  return `<div class="proof-walkthrough" data-proof-walkthrough="${html(walkthrough.recordId)}" data-proof-sha="${walkthrough.proofSha256}">
    <header class="proof-walkthrough-intro"><h6>${html(label(walkthrough.title, locale))}</h6><p class="proof-walkthrough-goal">${html(label(walkthrough.goal, locale))}</p>${walkthrough.notation ? `<p class="proof-walkthrough-notation">${html(label(walkthrough.notation, locale))}</p>` : ''}</header>
    <nav class="proof-walkthrough-route" aria-label="${text(locale, '逐步阅读证明', 'Read the proof step by step')}"><ol>${walkthrough.steps.map((step, index) => `<li><button data-global-scroll="${stepId(step.id)}"><span>${String(index + 1).padStart(2, '0')}</span>${html(label(step.title, locale))}</button></li>`).join('')}</ol></nav>
    <ol class="proof-walkthrough-steps">${walkthrough.steps.map((step, index) => {
      const next = walkthrough.steps[index + 1];
      const excerpt = step.evidence.source;
      const checkLinks = (step.evidence.checkIds ?? []).filter(id => id !== original.id).map(id => {
        const check = run.checks!.find(check => check.id === id)!;
        const node = check.scope === 'original' ? 'original' : check.taskId ? `task:${check.taskId}` : 'problem';
        return `<button ${destination(node, `check:${id}`)}>${text(locale, '相关检查', 'Related check')}</button>`;
      }).join('');
      return `<li class="proof-walkthrough-step" id="${stepId(step.id)}" data-proof-derivation="${html(step.id)}"><header><span>${String(index + 1).padStart(2, '0')}</span><h5 tabindex="-1">${html(label(step.title, locale))}</h5></header>
        <p class="proof-walkthrough-given"><span>${text(locale, '已知', 'Given')}</span>${html(label(step.given, locale))}</p>
        <div class="proof-walkthrough-claim"><span>${text(locale, '这一步推出', 'This step establishes')}</span><p>${html(label(step.claim, locale))}</p></div>
        <div class="proof-walkthrough-reason"><h6>${text(locale, '怎样推出', 'Derivation')}</h6><p>${html(label(step.because, locale))}</p></div>
        <div class="proof-walkthrough-next"><span aria-hidden="true">↓</span><p>${html(label(step.next, locale))}</p>${next ? `<button data-global-scroll="${stepId(next.id)}">${text(locale, '接着读', 'Continue')} ${String(index + 2).padStart(2, '0')} →</button>` : `<button data-global-scroll="global-review">${text(locale, '原题验收', 'Original-problem acceptance')} →</button>`}</div>
        <details class="proof-walkthrough-source" data-proof-source-lines="${excerpt.line}:${excerpt.endLine}"><summary>${text(locale, '对应的 Lean 证明', 'Corresponding Lean proof')}<span>${html(excerpt.name)}:${excerpt.line}–${excerpt.endLine}</span></summary><div class="proof-walkthrough-declarations">${step.evidence.theorems.map(theorem => `<code>${html(theorem)}</code>`).join('')}</div><ol start="${excerpt.line}">${lines.slice(excerpt.line - 1, excerpt.endLine).map(line => `<li><code>${html(line || ' ')}</code></li>`).join('')}</ol></details>
        <footer class="proof-walkthrough-links"><button class="proof-walkthrough-source-open" ${destination('original', `check:${original.id}`)} data-global-code="source" data-walkthrough-source-check="${html(original.id)}">${text(locale, '打开已检查的完整源码', 'Open the complete checked source')} ↗</button>${(step.evidence.taskIds ?? []).map(id => `<button ${destination(`task:${id}`)}>${html(archiveRoadmapTaskLabel(run.tasks.find(task => task.id === id)!, locale))} ↗</button>`).join('')}${(step.evidence.deliveryIds ?? []).map((id, i) => {
          const delivery = run.deliveries!.find(delivery => delivery.id === id)!;
          return `<button ${destination(delivery.taskId ? `task:${delivery.taskId}` : delivery.kind === 'review' ? 'review' : 'problem', `delivery:${id}`)}>${text(locale, '研究记录', 'Research record')}${(step.evidence.deliveryIds?.length ?? 0) > 1 ? ` ${i + 1}` : ''} ↗</button>`;
        }).join('')}${checkLinks}</footer>
      </li>`;
    }).join('')}</ol>
  </div>`;
}
