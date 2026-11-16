import type { ArchiveCatalog } from './types';
import { localizeRecord, rootOf, type Locale } from './site';

const escape = (value: string) => value.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]!));

const rowText = {
  zh: { pass: '官方通过', source: 'Lean 源码', resultLabel: (title: string) => `${title} 官方验收记录` },
  en: { pass: 'Official pass', source: 'Lean source', resultLabel: (title: string) => `Official result for ${title}` },
};

export function acceptedProofRows(catalog: ArchiveCatalog, locale: Locale = 'zh') {
  const text = rowText[locale];
  return catalog.records.filter(record => record.status === 'official_accepted').map(entry => localizeRecord(entry, locale)).map(record => `
    <tr class="proof-row" data-accepted-proof="${record.id}">
      <th scope="row"><h3><a href="archive.html#proof=${record.id}">${escape(record.title)}</a></h3><p class="proof-subtitle">${escape(record.subtitle)}<span class="proof-area"> · ${escape(record.area)}</span></p><p class="proof-credit">${escape(record.model)}</p></th>
      <td><div class="proof-links"><a data-proof-source href="archive.html#proof=${record.id}&tab=source">${text.source}<i data-lucide="arrow-right"></i></a><a class="official-link proof-pass" href="${escape(record.official!.resultUrl)}" target="_blank" rel="noreferrer" aria-label="${escape(text.resultLabel(record.title))}"><i data-lucide="check"></i>${text.pass}<i data-lucide="arrow-up-right"></i></a></div></td>
    </tr>`).join('');
}

/** Show the archived proof body and its official result without reconstructing a model run. */
export function featuredProof(catalog: ArchiveCatalog, locale: Locale = 'zh') {
  const record = catalog.records.find(record => record.id === 'dimitrov');
  const source = record?.sources.find(source => source.name === 'Submission.lean');
  const proofStart = source?.code.indexOf(':= by\n') ?? -1;
  if (record?.status !== 'official_accepted' || !record.official || !source || proofStart < 0) {
    throw new Error('The featured proof needs the archived Dimitrov source and its official result.');
  }
  const proof = source.code.slice(proofStart + 3).replace(/\nend Submission\s*$/, '').trimEnd();
  const text = {
    zh: {
      title: '共轭最大模的下界',
      problem: '对非零且非单位根的代数整数，证明其所有代数共轭的最大绝对值（house）的下界。',
      statement: 'Dimitrov · 历史验收案例', proof: 'Lean 证明体节选', verified: 'Lean-Eval 官方通过',
      source: '查看完整题目与源码', result: '核对官方结果', attribution: '历史成果 · 原始归属：',
    },
    en: {
      title: 'A bound on conjugate size',
      problem: 'For a nonzero algebraic integer that is not a root of unity, prove a lower bound for the largest absolute value among its algebraic conjugates (its house).',
      statement: 'Dimitrov · Archived proof', proof: 'Lean proof body excerpt', verified: 'Official Lean-Eval pass',
      source: 'Read the statement and source', result: 'Check the official result', attribution: 'Archived result · Original attribution: ',
    },
  }[locale];
  return `<figure class="featured-proof" id="featured-proof" data-featured-proof="${record.id}" aria-labelledby="featured-proof-title">
    <div class="featured-proof-sheet">
      <div class="featured-problem"><h2 id="featured-proof-title">${text.title}</h2><p class="featured-statement">${text.statement}</p><p class="featured-question">${text.problem}</p><a class="text-link" href="archive.html#proof=${record.id}&tab=source">${text.source}<i data-lucide="arrow-up-right"></i></a></div>
      <div class="featured-answer"><div class="featured-receipt"><p><i data-lucide="shield-check"></i>${text.verified}</p><a class="text-link" href="${escape(record.official.resultUrl)}" target="_blank" rel="noreferrer">${text.result}<i data-lucide="arrow-up-right"></i></a></div><details class="featured-source" data-mobile-disclosure open><summary class="featured-code-heading"><span>${text.proof}</span><span class="featured-file"><code>${source.name}</code><i data-lucide="chevron-down"></i></span></summary><pre class="featured-code"><code>${escape(proof)}</code></pre></details></div>
    </div>
    <figcaption>${text.attribution}${escape(record.model)}</figcaption>
  </figure>`;
}

type ReplayEvidence = {
  schema: string; status: string; source: string; modelInvoked: boolean; official: boolean; checkedAt: string;
  targets: { theorem: string; declaration: string; status: string; sorryCount: number }[];
};

function leanCode(source: string) {
  return source.trimEnd().split('\n').map((line, index) => {
    let cursor = 0;
    let markup = '';
    for (const match of line.matchAll(/\b(namespace|theorem|by|end|exact|rfl|Nat)\b/g)) {
      markup += escape(line.slice(cursor, match.index)) + `<span class="syntax-${match[0] === 'Nat' ? 'type' : 'keyword'}">${match[0]}</span>`;
      cursor = match.index! + match[0].length;
    }
    markup += escape(line.slice(cursor));
    return `<span class="code-line${line.includes('exact Nat.zero_add') ? ' is-change' : ''}" data-line="${index + 1}">${markup || '&#8203;'}</span>`;
  }).join('');
}

const replayText = {
  zh: {
    stages: [['候选证明', '初次候选'], ['Lean 反馈', '检查结果'], ['修复候选', '修复后的候选'], ['完整原题验收', '验收源码']],
    feedback: '<h3>还需证明左侧加零</h3><p><code>add_zero</code> 可由 <code>rfl</code> 完成；<br><code>zero_add</code> 需要已有引理。</p>',
    hint: '下一份候选使用 <code>Nat.zero_add n</code>。',
    badge: '证明回放', steps: '回放的四个步骤',
    play: '播放回放', previous: '回放上一步', next: '回放下一步', restart: '重新播放', archived: '已归档',
    progress: '回放步骤', progressText: (label: string) => `第 4 步，共 4 步：${label}`,
    receipt: '已归档回放的最终验收', receiptTitle: '查看验收详情', passed: '完整原题，通过。',
    method: '验收方式', methodValue: '独立 Lean 内核检查', checked: '检查日期',
    record: '查看完整回放记录', raw: '原始回执', rawTitle: '打开原始 JSON 回执',
    caption: '已保存的验收回执', captionLink: '回放记录',
  },
  en: {
    stages: [['Candidate', 'First candidate'], ['Lean feedback', 'Check result'], ['Repair', 'Repaired candidate'], ['Full verification', 'Verified source']],
    feedback: '<h3>Left addition still needs a proof</h3><p><code>add_zero</code> closes with <code>rfl</code>;<br><code>zero_add</code> needs an existing lemma.</p>',
    hint: 'The next candidate uses <code>Nat.zero_add n</code>.',
    badge: 'Proof replay', steps: 'The four steps of the replay',
    play: 'Play the replay', previous: 'Previous step', next: 'Next step', restart: 'Replay from the start', archived: 'Archived',
    progress: 'Replay step', progressText: (label: string) => `Step 4 of 4: ${label}`,
    receipt: 'Final verification of the archived replay', receiptTitle: 'Verification details', passed: 'Full statement passed.',
    method: 'Method', methodValue: 'Independent Lean kernel check', checked: 'Checked',
    record: 'Full replay record', raw: 'Raw receipt', rawTitle: 'Open the raw JSON receipt',
    caption: 'Saved verification receipt', captionLink: 'Replay record',
  },
};

/** Sources come from the bundled tutorial; the final receipt comes from the recorded local replay. */
export function researchReplay(failedSource: string, proofSource: string, evidence: ReplayEvidence, locale: Locale = 'zh', view: 'homepage' | 'archive' = 'homepage') {
  const text = replayText[locale];
  const root = rootOf(locale);
  if (evidence.schema !== 'theoremos.site-replay-evidence.v1' || evidence.source !== 'preset-replay' ||
      evidence.modelInvoked !== false || evidence.official !== false || evidence.status !== 'evaluated_passed' ||
      evidence.targets.length !== 2 || !evidence.targets.every(target => target.status === 'kernel_verified' && target.sorryCount === 0)) {
    throw new Error('The website replay needs a recorded, model-free local verification.');
  }
  const stages = [
    { id: 'candidate', file: 'Submission.lean', code: failedSource },
    { id: 'feedback', file: 'Lean feedback', code: '' },
    { id: 'repair', file: 'Submission.lean', code: proofSource },
    { id: 'verified', file: 'Submission.lean', code: proofSource },
  ].map((stage, index) => ({ ...stage, label: text.stages[index][0], note: text.stages[index][1] }));
  const feedback = `<div class="demo-diagnostic">${text.feedback}<pre><code>n : Nat\n⊢ 0 + n = n</code></pre><p class="diagnostic-hint">${text.hint}</p></div>`;
  return `<div class="replay-window" data-ui data-replay-playing="false" data-replay-current="verified" data-replay-state="paused">
    <div class="replay-chrome"><span class="replay-badge"><span class="status-dot"></span>${text.badge}</span></div>
    <div class="replay-tabs" role="tablist" aria-label="${text.steps}">${stages.map(stage => `<button type="button" role="tab" id="demo-${stage.id}" aria-controls="stage-${stage.id}" aria-selected="${stage.id === 'verified'}" tabindex="${stage.id === 'verified' ? '0' : '-1'}" data-replay-stage="${stage.id}" data-step-state="${stage.id === 'verified' ? 'current' : 'complete'}" disabled><span>${stage.label}</span><i data-lucide="${stage.id === 'verified' ? 'shield-check' : 'arrow-right'}"></i></button>`).join('')}</div>
    <div class="replay-toolbar"><div class="replay-playback" hidden><button type="button" id="replay-play" aria-label="${text.play}" title="${text.play}" aria-pressed="false"><i data-lucide="play"></i><i data-lucide="pause"></i></button><button type="button" id="replay-prev" aria-label="${text.previous}" title="${text.previous}"><i data-lucide="chevron-left"></i></button><button type="button" id="replay-next" aria-label="${text.next}" title="${text.next}" disabled><i data-lucide="chevron-right"></i></button><button type="button" id="replay-restart" aria-label="${text.restart}" title="${text.restart}"><i data-lucide="rotate-ccw"></i></button></div><span class="replay-position"><span class="mono" id="replay-step-number">04 / 04</span><span id="replay-step-label">${text.stages[3][0]}</span></span><span class="replay-state" id="replay-status" role="status" aria-live="polite" aria-atomic="true">${text.archived}</span></div>
    <div class="replay-progress" id="replay-progress" role="progressbar" aria-label="${text.progress}" aria-valuemin="1" aria-valuemax="4" aria-valuenow="4" aria-valuetext="${text.progressText(text.stages[3][0])}"><span class="replay-progress-fill"></span></div>
    <div class="replay-layout"><div class="replay-editor">${stages.map(stage => `<div class="replay-panel" id="stage-${stage.id}" role="tabpanel" aria-labelledby="demo-${stage.id}" tabindex="0"${stage.id === 'verified' ? '' : ' hidden'}><div class="editor-heading"><span><i data-lucide="file-code-2"></i>${stage.file}</span><span>${stage.note}</span></div>${stage.code ? `<pre class="demo-code"><code>${leanCode(stage.code)}</code></pre>` : feedback}</div>`).join('')}</div>
    <aside class="replay-receipt" aria-label="${text.receipt}"><div class="receipt-summary"><div class="receipt-status"><span class="receipt-check"><i data-lucide="check"></i></span><div><strong>${text.passed}</strong><code>${escape(evidence.status)}</code></div></div><div class="receipt-links">${view === 'homepage' ? `<a href="archive.html#view=quickstart" class="receipt-link">${text.record}<i data-lucide="arrow-up-right"></i></a>` : ''}<a href="${root}assets/replay.json" class="receipt-link receipt-evidence" target="_blank" rel="noreferrer" title="${text.rawTitle}">${text.raw}<i data-lucide="file-json-2"></i></a></div></div><details class="receipt-details"><summary class="receipt-title"><i data-lucide="shield-check"></i><span>${text.receiptTitle}</span><i data-lucide="chevron-down"></i></summary><div class="receipt-targets">${evidence.targets.map(target => `<div><i data-lucide="check"></i><span><strong>${escape(target.theorem)}</strong><code>${escape(target.declaration.replace(target.theorem + ' ', ''))}</code></span></div>`).join('')}</div><dl class="receipt-facts"><div><dt>${text.method}</dt><dd>${text.methodValue}</dd></div><div><dt>sorryCount</dt><dd>${evidence.targets.reduce((sum, target) => sum + target.sorryCount, 0)}</dd></div><div><dt>${text.checked}</dt><dd>${escape(evidence.checkedAt.slice(0, 10))} UTC</dd></div></dl></details></aside></div>
  </div>`;
}
