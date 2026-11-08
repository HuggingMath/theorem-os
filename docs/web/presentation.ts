import type { ArchiveCatalog } from './types';
import { localizeRecord, rootOf, type Locale } from './site';

const escape = (value: string) => value.replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]!));

const rowText = {
  zh: { pass: '官方通过', source: 'Lean 源码', result: '官方结果', resultLabel: (title: string) => `${title} 官方验收记录` },
  en: { pass: 'Official pass', source: 'Lean source', result: 'Official result', resultLabel: (title: string) => `Official result for ${title}` },
};

export function acceptedProofRows(catalog: ArchiveCatalog, locale: Locale = 'zh') {
  const text = rowText[locale];
  return catalog.records.filter(record => record.status === 'official_accepted').map(entry => localizeRecord(entry, locale)).map(record => `
    <tr class="proof-row" data-accepted-proof="${record.id}">
      <th scope="row"><h3><a href="archive.html#proof=${record.id}">${escape(record.title)}</a></h3><p class="proof-subtitle">${escape(record.subtitle)}</p><p class="proof-credit">${escape(record.model)}</p></th>
      <td class="proof-area">${escape(record.area)}</td>
      <td><span class="proof-pass"><i data-lucide="check"></i>${text.pass}</span><div class="proof-links"><a data-proof-source href="archive.html#proof=${record.id}&tab=source">${text.source}<i data-lucide="arrow-right"></i></a><a class="official-link" href="${escape(record.official!.resultUrl)}" target="_blank" rel="noreferrer" aria-label="${escape(text.resultLabel(record.title))}">${text.result}<i data-lucide="arrow-up-right"></i></a></div></td>
    </tr>`).join('');
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
    stages: [['候选证明', '预设候选 01'], ['Lean 反馈', '检查过程讲解'], ['修复候选', '预设候选 02'], ['完整原题验收', '验收源码']],
    feedback: '<span class="diagnostic-label"><i data-lucide="info"></i>对预设候选的检查说明</span><h3>一处通过，<br>一处还需继续。</h3><p><code>add_zero</code> 可由 <code>rfl</code> 完成；<br><code>zero_add</code> 需要已有引理。</p>',
    hint: '下一份候选使用 <code>Nat.zero_add n</code>。',
    badge: '预设回放 · 不调用模型', steps: '预设回放的四个步骤',
    play: '播放预设回放', previous: '回放上一步', next: '回放下一步', restart: '重新播放', archived: '已归档',
    progress: '预设回放步骤', progressText: (label: string) => `第 4 步，共 4 步：${label}`,
    receipt: '已归档回放的最终验收', receiptTitle: '已归档的最终验收', passed: '完整原题，通过。',
    method: '验收方式', methodValue: '独立 Lean 内核检查', checked: '检查日期',
    record: '查看完整回放记录', raw: '原始回执', rawTitle: '打开原始 JSON 回执',
    caption: '已保存的验收回执', captionLink: '回放记录',
  },
  en: {
    stages: [['Candidate', 'Preset candidate 01'], ['Lean feedback', 'What the check found'], ['Repair', 'Preset candidate 02'], ['Full verification', 'Verified source']],
    feedback: '<span class="diagnostic-label"><i data-lucide="info"></i>What the check found in the preset candidate</span><h3>One goal passes,<br>one needs more work.</h3><p><code>add_zero</code> closes with <code>rfl</code>;<br><code>zero_add</code> needs an existing lemma.</p>',
    hint: 'The next candidate uses <code>Nat.zero_add n</code>.',
    badge: 'Preset replay · no model calls', steps: 'The four steps of the preset replay',
    play: 'Play the preset replay', previous: 'Previous step', next: 'Next step', restart: 'Replay from the start', archived: 'Archived',
    progress: 'Preset replay step', progressText: (label: string) => `Step 4 of 4: ${label}`,
    receipt: 'Final verification of the archived replay', receiptTitle: 'Archived final verification', passed: 'Full statement passed.',
    method: 'Method', methodValue: 'Independent Lean kernel check', checked: 'Checked',
    record: 'Full replay record', raw: 'Raw receipt', rawTitle: 'Open the raw JSON receipt',
    caption: 'Saved verification receipt', captionLink: 'Replay record',
  },
};

/** Sources come from the bundled tutorial; the final receipt comes from the recorded local replay. */
export function researchReplay(failedSource: string, proofSource: string, evidence: ReplayEvidence, locale: Locale = 'zh') {
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
    <div class="replay-chrome"><span class="window-dots" aria-hidden="true"><i></i><i></i><i></i></span><span class="mono">theoremos / local-replay</span><span class="replay-badge"><span class="status-dot"></span>${text.badge}</span></div>
    <div class="replay-tabs" role="tablist" aria-label="${text.steps}">${stages.map((stage, index) => `<button type="button" role="tab" id="demo-${stage.id}" aria-controls="stage-${stage.id}" aria-selected="${stage.id === 'verified'}" tabindex="${stage.id === 'verified' ? '0' : '-1'}" data-replay-stage="${stage.id}" data-step-state="${stage.id === 'verified' ? 'current' : 'complete'}"><span class="replay-step-number mono">0${index + 1}</span><span>${stage.label}</span><i data-lucide="${stage.id === 'verified' ? 'shield-check' : 'arrow-right'}"></i></button>`).join('')}</div>
    <div class="replay-toolbar"><div class="replay-playback" hidden><button type="button" id="replay-play" aria-label="${text.play}" title="${text.play}" aria-pressed="false"><i data-lucide="play"></i><i data-lucide="pause"></i></button><button type="button" id="replay-prev" aria-label="${text.previous}" title="${text.previous}"><i data-lucide="chevron-left"></i></button><button type="button" id="replay-next" aria-label="${text.next}" title="${text.next}" disabled><i data-lucide="chevron-right"></i></button><button type="button" id="replay-restart" aria-label="${text.restart}" title="${text.restart}"><i data-lucide="rotate-ccw"></i></button></div><span class="replay-position"><span class="mono" id="replay-step-number">04 / 04</span><span id="replay-step-label">${text.stages[3][0]}</span></span><span class="replay-state" id="replay-status" role="status" aria-live="polite" aria-atomic="true">${text.archived}</span></div>
    <div class="replay-progress" id="replay-progress" role="progressbar" aria-label="${text.progress}" aria-valuemin="1" aria-valuemax="4" aria-valuenow="4" aria-valuetext="${text.progressText(text.stages[3][0])}"><span class="replay-progress-fill"></span></div>
    <div class="replay-layout"><div class="replay-editor">${stages.map(stage => `<div class="replay-panel" id="stage-${stage.id}" role="tabpanel" aria-labelledby="demo-${stage.id}" tabindex="0"${stage.id === 'verified' ? '' : ' hidden'}><div class="editor-heading"><span><i data-lucide="file-code-2"></i>${stage.file}</span><span>${stage.note}</span></div>${stage.code ? `<pre class="demo-code"><code>${leanCode(stage.code)}</code></pre>` : feedback}</div>`).join('')}</div>
    <aside class="replay-receipt" aria-label="${text.receipt}"><div class="receipt-title"><i data-lucide="shield-check"></i><span>${text.receiptTitle}</span><span class="receipt-local">LOCAL</span></div><div class="receipt-status"><span class="receipt-check"><i data-lucide="check"></i></span><div><strong>${text.passed}</strong><code>${escape(evidence.status)}</code></div></div><div class="receipt-targets">${evidence.targets.map(target => `<div><i data-lucide="check"></i><span><strong>${escape(target.theorem)}</strong><code>${escape(target.declaration.replace(target.theorem + ' ', ''))}</code></span></div>`).join('')}</div><dl class="receipt-facts"><div><dt>${text.method}</dt><dd>${text.methodValue}</dd></div><div><dt>sorryCount</dt><dd>${evidence.targets.reduce((sum, target) => sum + target.sorryCount, 0)}</dd></div><div><dt>${text.checked}</dt><dd>${escape(evidence.checkedAt.slice(0, 10))} UTC</dd></div></dl><div class="receipt-links"><a href="archive.html#view=quickstart" class="receipt-link">${text.record}<i data-lucide="arrow-up-right"></i></a><a href="${root}assets/replay.json" class="receipt-link receipt-evidence" target="_blank" rel="noreferrer" title="${text.rawTitle}">${text.raw}<i data-lucide="file-json-2"></i></a></div></aside></div>
    <div class="replay-caption"><span>${text.caption}</span><a href="archive.html#view=quickstart">${text.captionLink}<i data-lucide="arrow-up-right"></i></a></div>
  </div>`;
}
