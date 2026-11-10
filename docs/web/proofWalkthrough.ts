import type { ArchiveIndexRecord, ArchiveProcess } from './types';
import type { Locale } from './site';
import type { Localized, ProofWalkthrough } from './proofWalkthroughTypes';
import { archiveRoadmapTaskLabel } from './roadmapLabels';
import { renderProofRoute } from './proofRoute';

type Run = ArchiveProcess['runs'][number];
const html = (value: unknown) => String(value ?? '').replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const label = (value: Localized, locale: Locale) => locale === 'en' ? value.en : value.zh;
const text = (locale: Locale, zh: string, en: string) => locale === 'en' ? en : zh;
const stepId = (id: string) => `proof-derivation-${id}`;

export function selectedProofWalkthrough(record: Pick<ArchiveIndexRecord, 'id' | 'campaign'>, process: ArchiveProcess, run: Run): ProofWalkthrough | undefined {
  const walkthrough = process.walkthrough;
  return walkthrough?.recordId === record.id && walkthrough.runId === run.runId && walkthrough.runId === record.campaign?.runId
    && walkthrough.proofSha256 === record.campaign.proofSha256 && process.sources?.[walkthrough.proofSha256] ? walkthrough : undefined;
}

export function renderProofWalkthrough(walkthrough: ProofWalkthrough, process: ArchiveProcess, run: Run, locale: Locale, options: { linear?: boolean } = {}): string {
  const source = process.sources![walkthrough.proofSha256];
  const lines = source.code.split('\n');
  const original = run.checks!.find(check => check.scope === 'original' && check.status === 'kernel_verified' && check.sourceDigest === walkthrough.proofSha256)!;
  const destination = (node: string, step?: string) => `data-global-run="${html(run.runId)}" data-global-node="${html(node)}"${step ? ` data-global-step="${html(step)}"` : ''}`;
  const positions = new Map(walkthrough.steps.map((step, index) => [step.id, { step, number: String(index + 1).padStart(2, '0') }]));
  const stages = new Map(walkthrough.stages.flatMap((stage, index) => stage.stepIds.map(id => [id, { stage, index }] as const)));
  return `<div class="proof-walkthrough" data-proof-walkthrough="${html(walkthrough.recordId)}" data-proof-sha="${walkthrough.proofSha256}"${options.linear ? ' data-proof-reading="linear"' : ''}>
    ${options.linear ? `<details class="proof-reading-intro"><summary>${text(locale, '证明思路与完整题目', 'Strategy and full problem')}<span>${text(locale, `${walkthrough.steps.length} 步`, `${walkthrough.steps.length} steps`)}</span></summary>` : ''}
    <header class="proof-walkthrough-intro"><div class="proof-walkthrough-heading workflow-section-heading"><h5 tabindex="-1">${html(label(walkthrough.title, locale))}</h5></div>
      <p class="proof-walkthrough-strategy">${html(label(walkthrough.strategy, locale))}</p>
      <div class="proof-walkthrough-meta"><span>${text(locale, `${walkthrough.steps.length} 步 · ${walkthrough.steps.reduce((sum, step) => sum + step.derivation.length, 0)} 行推导`, `${walkthrough.steps.length} steps · ${walkthrough.steps.reduce((sum, step) => sum + step.derivation.length, 0)} lines`)}</span><details class="proof-walkthrough-problem"><summary>${text(locale, '题目与符号', 'Problem and notation')}</summary><p class="proof-walkthrough-goal">${html(label(walkthrough.goal, locale))}</p>${walkthrough.notation ? `<p class="proof-walkthrough-notation">${html(label(walkthrough.notation, locale))}</p>` : ''}</details></div>
      ${options.linear ? `<details class="workflow-full-text"><summary>${text(locale, '证明主线', 'Proof outline')}</summary>` : ''}<ol class="proof-overview" aria-label="${text(locale, '证明主线', 'Proof outline')}">${walkthrough.stages.map((stage, index) => {
        const first = stage.stepIds[0], last = stage.stepIds.at(-1)!;
        const range = [positions.get(first)!.number, positions.get(last)!.number].filter((value, i, values) => i === 0 || value !== values[0]).join('–');
        return `<li><button type="button" data-proof-overview-stage="${index}" data-proof-overview-steps="${stage.stepIds.join(' ')}" data-global-scroll="${stepId(first)}" aria-controls="${stepId(first)}"${index === 0 ? ' aria-current="step"' : ''}><span class="proof-overview-range">${range}</span><span class="proof-overview-copy"><strong>${html(label(stage.title, locale))}</strong><span>${html(label(stage.summary, locale))}</span></span><span class="proof-overview-link" aria-hidden="true">↗</span></button></li>`;
      }).join('')}</ol>${options.linear ? '</details>' : ''}
    </header>${options.linear ? '</details>' : ''}
    ${options.linear ? `<div class="proof-reading-content">${renderProofRoute(walkthrough, locale, false)}` : `<div class="proof-reading-layout"><aside class="proof-route-sidebar">${renderProofRoute(walkthrough, locale)}</aside><div class="proof-reading-content">`}
    <nav class="proof-reading-bar" aria-label="${text(locale, '阅读位置', 'Reading position')}"><button type="button" data-proof-reader="previous" data-global-scroll="" aria-label="${text(locale, '上一步', 'Previous step')}" disabled>←</button><span data-proof-reading-count>01 / ${String(walkthrough.steps.length).padStart(2, '0')}</span><span data-proof-reading-title>${html(label(walkthrough.steps[0].title, locale))}</span><button type="button" data-proof-reader="next" data-global-scroll="${stepId(walkthrough.steps[1]?.id ?? walkthrough.steps[0].id)}" data-next-label="${text(locale, '下一步', 'Next step')}" data-acceptance-label="${text(locale, '查看原题验收', 'Inspect original-problem acceptance')}" aria-label="${text(locale, '下一步', 'Next step')}">→</button></nav>
    <ol class="proof-walkthrough-steps">${walkthrough.steps.map((step, index) => {
      const next = walkthrough.steps[index + 1];
      const readingStage = stages.get(step.id)!;
      const consumers = walkthrough.steps.filter(candidate => candidate.dependsOn.includes(step.id));
      const excerpt = step.evidence.source;
      const checkLinks = (step.evidence.checkIds ?? []).filter(id => id !== original.id).map(id => {
        const check = run.checks!.find(check => check.id === id)!;
        const node = check.scope === 'original' ? 'original' : check.taskId ? `task:${check.taskId}` : 'problem';
        return `<button ${destination(node, `check:${id}`)}>${text(locale, '相关检查', 'Related check')}</button>`;
      }).join('');
      return `<li class="proof-walkthrough-step" id="${stepId(step.id)}" data-proof-derivation="${html(step.id)}" data-proof-reading-stage="${readingStage.index}">${readingStage.stage.stepIds[0] === step.id ? `<p class="proof-walkthrough-stage-label">${text(locale, `阶段 ${readingStage.index + 1}`, `Part ${readingStage.index + 1}`)} · ${html(label(readingStage.stage.title, locale))}</p>` : ''}<header><span>${String(index + 1).padStart(2, '0')}</span><h5 tabindex="-1">${html(label(step.title, locale))}</h5></header>
        ${step.dependsOn.length ? `<nav class="proof-walkthrough-inputs" aria-label="${text(locale, '这一步用到的结论', 'Earlier results used in this step')}"><span>${text(locale, '用到', 'Uses')}</span>${step.dependsOn.map(id => {
          const previous = positions.get(id)!;
          return `<button data-proof-dependency="${html(id)}" data-global-scroll="${stepId(id)}"><span>${previous.number}</span>${html(label(previous.step.title, locale))} ↑</button>`;
        }).join('')}</nav>` : ''}
        <p class="proof-walkthrough-given"><span>${text(locale, '已知', 'Given')}</span>${html(label(step.given, locale))}</p>
        <div class="proof-walkthrough-claim"><span>${text(locale, '这一步推出', 'This step establishes')}</span><p>${html(label(step.claim, locale))}</p></div>
        ${step.figureHtml ? options.linear ? `<details class="workflow-full-text"><summary>${text(locale, '查看图示', 'View figure')}</summary>${label(step.figureHtml, locale)}</details>` : label(step.figureHtml, locale) : ''}
        <div class="proof-walkthrough-reason"><h6>${text(locale, '怎样推出', 'Derivation')}</h6><ol class="proof-walkthrough-calculation" aria-label="${text(locale, '逐行推导', 'Derivation line by line')}">${step.derivation.map((line, lineIndex) => `<li data-proof-calculation="${html(step.id)}:${lineIndex + 1}"><span aria-hidden="true">${index + 1}.${lineIndex + 1}</span><div><p class="proof-walkthrough-statement">${html(label(line.statement, locale))}</p><p class="proof-walkthrough-justification">${html(label(line.reason, locale))}</p></div></li>`).join('')}</ol><details class="proof-walkthrough-explanation"><summary>${text(locale, '连起来看', 'How these lines fit together')}</summary><p>${html(label(step.because, locale))}</p></details></div>
        <div class="proof-walkthrough-next"><span aria-hidden="true">↓</span><p>${html(label(step.next, locale))}</p>${next ? `<button data-global-scroll="${stepId(next.id)}">${text(locale, '接着读', 'Continue')} ${String(index + 2).padStart(2, '0')} →</button>` : `<button data-global-scroll="global-review">${text(locale, '原题验收', 'Original-problem acceptance')} →</button>`}</div>
        ${consumers.length ? `<nav class="proof-walkthrough-outputs" aria-label="${text(locale, '使用本步结论的后续步骤', 'Later steps that use this result')}"><span>${text(locale, '此结论用于', 'This result is used in')}</span>${consumers.map(consumer => `<button data-proof-consumer="${html(consumer.id)}" data-global-scroll="${stepId(consumer.id)}"><span>${positions.get(consumer.id)!.number}</span>${html(label(consumer.title, locale))} ↗</button>`).join('')}</nav>` : ''}
        <details class="proof-walkthrough-source" data-proof-source-lines="${excerpt.line}:${excerpt.endLine}"><summary>${text(locale, '对应的 Lean 证明', 'Corresponding Lean proof')}<span>${html(excerpt.name)}:${excerpt.line}–${excerpt.endLine}</span></summary><div class="proof-walkthrough-declarations">${step.evidence.theorems.map(theorem => `<code>${html(theorem)}</code>`).join('')}</div><ol start="${excerpt.line}">${lines.slice(excerpt.line - 1, excerpt.endLine).map(line => `<li><code>${html(line || ' ')}</code></li>`).join('')}</ol></details>
        <footer class="proof-walkthrough-links"><button class="proof-walkthrough-source-open" ${destination('original', `check:${original.id}`)} data-global-code="source" data-walkthrough-source-check="${html(original.id)}">${text(locale, '打开已检查的完整源码', 'Open the complete checked source')} ↗</button>${(step.evidence.taskIds ?? []).map(id => `<button ${destination(`task:${id}`)}>${html(archiveRoadmapTaskLabel(run.tasks.find(task => task.id === id)!, locale))} ↗</button>`).join('')}${(step.evidence.deliveryIds ?? []).map((id, i) => {
          const delivery = run.deliveries!.find(delivery => delivery.id === id)!;
          return `<button ${destination(delivery.taskId ? `task:${delivery.taskId}` : delivery.kind === 'review' ? 'review' : 'problem', `delivery:${id}`)}>${text(locale, '研究记录', 'Research record')}${(step.evidence.deliveryIds?.length ?? 0) > 1 ? ` ${i + 1}` : ''} ↗</button>`;
        }).join('')}${checkLinks}</footer>
      </li>`;
    }).join('')}</ol></div>${options.linear ? '' : '</div>'}
  </div>`;
}
