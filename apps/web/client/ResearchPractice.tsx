import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon } from './ui/Icon';
import { MathFormula } from './ui/MathFormula';
import { researchEntryQuery, type ResearchEntry } from './researchEntry';
import { approvePracticePlan, changePracticePlan, currentPracticeGuidance, exportPracticeRecord, initialPracticeState,
  practiceAcceptedSource, practiceFailedSource, practiceHasRepair, practiceStorageKey, recordedPracticeEvidence,
  restorePracticeState, savePracticeReceipt, sendPracticeGuidance, type PracticeInstruction, type PracticePlan, type PracticeState } from './researchPracticeModel';

export type ResearchPracticeProps = { language?: 'zh' | 'en'; onExit?(): void; onPrepare?(entry: ResearchEntry): void };
type Panel = 'plan' | 'right' | 'left' | 'evidence';

export function ResearchPractice({ language = 'zh', onExit, onPrepare }: ResearchPracticeProps) {
  const tx = (zh: string, en: string) => language === 'en' ? en : zh;
  const [persisted, setPersisted] = useState<{ state: PracticeState; storageError: boolean }>(() => {
    let state = initialPracticeState();
    try { state = restorePracticeState(localStorage.getItem(practiceStorageKey)); localStorage.setItem(practiceStorageKey, JSON.stringify(state)); return { state, storageError: false }; }
    catch { return { state, storageError: true }; }
  });
  const { state, storageError } = persisted;
  const [draft, setDraft] = useState<PracticePlan>({ ...state.plan });
  const [panel, setPanel] = useState<Panel>(state.savedReceipt ? 'evidence' : state.approvedRevision ? 'left' : 'plan');
  const [instruction, setInstruction] = useState<PracticeInstruction>('use-lemma'), [note, setNote] = useState('');
  const [message, setMessage] = useState('');
  const content = useRef<HTMLDivElement>(null), previousPanel = useRef(panel);
  const approved = state.approvedRevision === state.revision, repaired = practiceHasRepair(state);
  const guidance = currentPracticeGuidance(state);
  const dirty = draft.route !== state.plan.route || draft.note.trim() !== state.plan.note;
  const date = (at: string) => new Date(at).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN');
  const entry: ResearchEntry = { kind: 'statement', template: 'add-zero', environment: 'standard', language };
  function setState(next: PracticeState) {
    try { localStorage.setItem(practiceStorageKey, JSON.stringify(next)); setPersisted({ state: next, storageError: false }); }
    catch { setPersisted({ state: next, storageError: true }); }
  }
  useEffect(() => {
    if (previousPanel.current === panel) return;
    previousPanel.current = panel;
    const heading = content.current?.querySelector('h2');
    if (heading) { heading.tabIndex = -1; heading.focus(); }
  }, [panel]);

  function updatePlan() {
    const next = changePracticePlan(state, draft);
    setState(next); setDraft({ ...next.plan }); setPanel('plan');
    setMessage(tx(`计划已保存为 v${next.revision}，请核对后批准。`, `Plan v${next.revision} is saved. Review it before approving.`));
  }
  function reset() {
    const next = initialPracticeState(); setState(next); setDraft({ ...next.plan }); setPanel('plan');
    setInstruction('use-lemma'); setNote(''); setMessage(tx('练习已重置。', 'The exercise has been reset.'));
  }
  function download() {
    const objectUrl = URL.createObjectURL(new Blob([JSON.stringify(exportPracticeRecord(state), null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = objectUrl; link.download = 'theoremos-recorded-practice.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    setMessage(tx('已准备练习记录下载。', 'The exercise record is ready to download.'));
  }
  const nodes: { id: Panel; title: string; detail: string; disabled: boolean }[] = [
    { id: 'plan', title: tx('确认研究计划', 'Review the plan'), detail: `v${state.revision}`, disabled: false },
    { id: 'right', title: state.plan.route === 'direct' ? tx('查看首次尝试', 'Inspect the first attempt') : tx('先证明右加零', 'Prove right addition first'),
      detail: state.plan.route === 'direct' ? tx('两个目标尝试 rfl', 'Try rfl on both goals') : 'n + 0 = n', disabled: !approved },
    { id: 'left', title: tx('指导左加零修复', 'Guide the left-addition repair'), detail: repaired ? 'exact Nat.zero_add n' : '0 + n = n', disabled: !approved },
    { id: 'evidence', title: tx('查看原录制回执', 'Read the original receipts'), detail: tx('完整原题 · 两个目标', 'Whole problem · Both goals'), disabled: !repaired },
  ];

  return <article class="research-practice" data-research-practice data-practice-revision={state.revision}>
    <div class="practice-heading"><div><h1>{tx('亲手走完一次研究', 'Make the research decisions')}</h1>
      <p>{tx('改计划、给指导，再对照证明路线和检查依据。', 'Change a plan, give guidance, then connect the proof route to its evidence.')}</p></div>
      {onExit && <button type="button" class="text-button" onClick={onExit}><Icon name="arrow-left" />{tx('返回', 'Back')}</button>}
    </div>
    <div class="practice-notice"><Icon name="play" /><p><strong>{tx('录制演练，无需 Key。', 'Recorded exercise. No API key needed.')}</strong>{' '}
      {tx('选择会切换预设路线，回执沿用原录制，不调用模型或 Lean。', 'Choices explore prepared routes. Receipts come from the original recording; no model or Lean is called.')}</p></div>
    <section class="practice-problem" aria-labelledby="practice-problem-title"><h2 id="practice-problem-title">{tx('自然数加零', 'Adding zero to a natural number')}</h2>
      <p>{tx('对任意自然数 n，左右加零都不改变结果。两个目标都属于原题。', 'For every natural number n, adding zero on either side leaves n unchanged. Both goals belong to the original problem.')}</p>
      <div class="practice-targets"><div><code>Tutorial.add_zero</code><MathFormula source="n + 0 = n" /></div><div><code>Tutorial.zero_add</code><MathFormula source="0 + n = n" /></div></div>
    </section>
    <nav class="practice-roadmap" aria-label={tx('交互研究路线', 'Interactive research route')}>
      <ol>{nodes.map(node => <li key={node.id}><button type="button" data-practice-node={node.id} disabled={node.disabled} aria-current={panel === node.id ? 'step' : undefined}
        onClick={() => setPanel(node.id)}><span>{node.title}</span><small>{node.detail}</small></button></li>)}</ol>
      <p>{state.plan.route === 'split' ? tx('当前路线：先保留右加零的结果，再修复左加零，最后核对完整原题。', 'Current route: keep the right-addition result, repair left addition, then inspect whole-problem verification.')
        : tx('当前路线：检查两个 rfl 候选，保留已通过部分，再依据诊断修复。', 'Current route: inspect both rfl candidates, keep the valid part, then repair the failed goal.')}</p>
    </nav>
    <div class="practice-content" ref={content} data-practice-panel={panel}>
      {panel === 'plan' && <section aria-labelledby="practice-plan-title"><h2 id="practice-plan-title">{tx('这条路线怎样推进', 'Choose how to approach the problem')}</h2>
        <form onSubmit={event => { event.preventDefault(); updatePlan(); }}>
          <fieldset class="practice-options"><legend>{tx('选择计划', 'Choose a plan')}</legend>
            <label><input type="radio" name="practice-route" value="direct" checked={draft.route === 'direct'} onChange={() => setDraft({ ...draft, route: 'direct' })} />
              <span><strong>{tx('先看直接尝试', 'Inspect a direct attempt')}</strong><span>{tx('对两个目标先尝试 rfl，根据保存的诊断决定修复。', 'Try rfl on both goals, then use the recorded diagnostic to decide on a repair.')}</span></span></label>
            <label><input type="radio" name="practice-route" value="split" checked={draft.route === 'split'} onChange={() => setDraft({ ...draft, route: 'split' })} />
              <span><strong>{tx('分开处理两个目标', 'Handle the goals separately')}</strong><span>{tx('先检查 n + 0 = n，再把注意力放到 0 + n = n。', 'Check n + 0 = n first, then focus on 0 + n = n.')}</span></span></label>
          </fieldset>
          <label class="practice-field" htmlFor="practice-plan-note">{tx('计划备注（随练习保存）', 'Plan note (saved with the exercise)')}
            <textarea id="practice-plan-note" rows={2} maxLength={600} value={draft.note} onInput={event => setDraft({ ...draft, note: event.currentTarget.value })}
              placeholder={tx('例如：保留已经检查的右加零，左加零优先查标准库。', 'For example: keep the right-addition result and look for a standard-library lemma for left addition.')} /></label>
          <div class="practice-actions"><button type="submit" class="button" data-practice-save-plan disabled={!dirty}>{tx('保存计划修改', 'Save plan changes')}</button>
            <button type="button" class="button primary" data-practice-approve disabled={dirty || approved} onClick={() => {
              setState(approvePracticePlan(state)); setPanel('right'); setMessage(tx(`已批准计划 v${state.revision}。`, `Plan v${state.revision} is approved.`));
            }}>{approved ? tx(`已批准 v${state.revision}`, `v${state.revision} approved`) : tx(`批准计划 v${state.revision}`, `Approve plan v${state.revision}`)}</button></div>
          {dirty && <p class="practice-hint">{tx('请先保存修改，再批准这一版计划。', 'Save your changes before approving this version.')}</p>}
        </form>
        <p class="practice-hint">{tx('修改已批准的计划后，需要重新批准；后续指导与回执会绑定到新版本。', 'Changing an approved plan requires a new approval. Subsequent guidance and receipt references belong to that version.')}</p>
      </section>}
      {panel === 'right' && <section aria-labelledby="practice-right-title"><h2 id="practice-right-title">{tx('同一种写法，两个结果', 'One tactic, two different results')}</h2>
        <div class="practice-deductions"><div><h3><code>n + 0 = n</code></h3><p>{tx('自然数加法对第二个参数递归定义；第二项是零时，表达式按定义化简为 n，因此 rfl 可以完成目标。', 'Natural-number addition recurses on its second argument. With zero as that argument, the expression reduces to n, so rfl closes the goal.')}</p></div>
          <div><h3><code>0 + n = n</code></h3><p>{tx('这里第二项是任意 n，不能直接按定义化简。原录制中 rfl 失败，下一步需要已有引理或归纳证明。', 'Here the second argument is an arbitrary n, so definition reduction alone does not close the goal. The recorded rfl attempt fails; a lemma or induction is needed.')}</p></div></div>
        <details class="practice-source"><summary>{tx('查看原录制的失败候选', 'Inspect the recorded failed candidate')}</summary><pre><code>{practiceFailedSource}</code></pre></details>
        <button type="button" class="button primary" data-practice-next onClick={() => setPanel('left')}>{tx('给出修复指导', 'Give repair guidance')}<Icon name="arrow-right" /></button>
      </section>}
      {panel === 'left' && <section aria-labelledby="practice-left-title"><h2 id="practice-left-title">{tx('你的指导会改变哪一步', 'See what your guidance changes')}</h2>
        <p>{tx(`计划 v${state.revision} 保留原题的两个目标。右加零已有可用证明；左加零仍需要修复。`, `Plan v${state.revision} keeps both original goals. Right addition already has a valid proof; left addition still needs a repair.`)}</p>
        {guidance.map(item => <div class={`practice-outcome${item.accepted ? ' is-accepted' : ''}`} key={item.id} data-practice-guidance={item.accepted ? 'accepted' : 'declined'}>
          <h3>{tx('演练指导回执', 'Exercise guidance receipt')} {item.id} · {item.accepted ? tx('已采纳', 'Accepted') : tx('未采纳', 'Declined')}</h3>
          <p>{item.accepted ? tx('保留 add_zero，用 Nat.zero_add n 补全左加零。后续路线改为“修复左加零 → 核对两个目标的原录制回执”。', 'Keep add_zero and complete left addition with Nat.zero_add n. The route now continues through the left-addition repair to the original receipts for both goals.')
            : tx('只提交 add_zero 会漏掉原题中的 zero_add。不能用删去目标的方式完成原题；路线保留在左加零修复，等待新的指导。', 'Submitting only add_zero would omit the original zero_add goal. Dropping a goal does not solve the original problem. The route stays at the repair and awaits further guidance.')}</p>
          {item.note && <blockquote>{item.note}</blockquote>}<p class="practice-meta">{tx(`计划 v${item.revision}`, `Plan v${item.revision}`)} · {date(item.at)}</p>
        </div>)}
        {!repaired && <form onSubmit={event => {
          event.preventDefault(); setState(sendPracticeGuidance(state, instruction, note, new Date().toISOString())); setNote('');
          setMessage(instruction === 'use-lemma' ? tx('演练指导已采纳，路线已更新。', 'The exercise guidance was accepted and the route changed.') : tx('演练指导未采纳，请查看理由并重新选择。', 'The exercise guidance was declined. Read the reason and choose again.'));
        }}>
          <fieldset class="practice-options"><legend>{tx('选择一条指导，查看预设处理结果', 'Choose guidance to explore its prepared outcome')}</legend>
            <label><input type="radio" name="practice-guidance" value="use-lemma" checked={instruction === 'use-lemma'} onChange={() => setInstruction('use-lemma')} /><span>{tx('保留右加零，用 Nat.zero_add 修复左加零。', 'Keep right addition and repair left addition with Nat.zero_add.')}</span></label>
            <label><input type="radio" name="practice-guidance" value="drop-goal" checked={instruction === 'drop-goal'} onChange={() => setInstruction('drop-goal')} /><span>{tx('只提交已通过的右加零，略去左加零。', 'Submit only the proved right-addition goal and omit left addition.')}</span></label>
          </fieldset>
          <label class="practice-field" htmlFor="practice-guidance-note">{tx('补充备注（随练习保存）', 'Additional note (saved with the exercise)')}
            <textarea id="practice-guidance-note" rows={2} maxLength={600} value={note} onInput={event => setNote(event.currentTarget.value)} /></label>
          <button type="submit" class="button primary" data-practice-send-guidance>{tx('发送演练指导', 'Send exercise guidance')}<Icon name="send" /></button>
        </form>}
        {repaired && <><details class="practice-source" open><summary>{tx('对照原录制的修复源码', 'Compare the original repaired source')}</summary><pre><code>{practiceAcceptedSource}</code></pre></details>
          <button type="button" class="button primary" data-practice-open-evidence onClick={() => setPanel('evidence')}>{tx('核对原录制回执', 'Inspect the original receipts')}<Icon name="arrow-right" /></button></>}
      </section>}
      {panel === 'evidence' && <section aria-labelledby="practice-evidence-title"><h2 id="practice-evidence-title">{tx('核对原录制回执', 'Read the original receipts')}</h2>
        <p>{tx('原录制对两个目标分别完成了 Lean 内核检查。它证明保存的源码通过过检查，不代表本次练习的计划或备注经过验收。', 'The original recording contains a Lean kernel check for each goal. It verifies the saved source, not the plan or notes entered in this exercise.')}</p>
        <dl class="practice-evidence-meta"><div><dt>{tx('原录制检查时间', 'Original check time')}</dt><dd>{date(recordedPracticeEvidence.checkedAt)}</dd></div>
          <div><dt>{tx('检查方式', 'Check method')}</dt><dd>{recordedPracticeEvidence.method}</dd></div><div><dt>{tx('记录性质', 'Record type')}</dt><dd>{tx('本地教程，非官方榜单', 'Local tutorial, not an official benchmark')}</dd></div></dl>
        <ul class="practice-receipts">{recordedPracticeEvidence.targets.map(target => <li key={target.receiptId}><div><Icon name="shield-check" /><strong>{target.theorem}</strong><span>{tx('原录制通过', 'Passed in original recording')}</span></div>
          <p><code>{target.receiptId}</code></p><p><code>{target.declaration}</code></p><p>{tx('未完成证明占位符', 'Unfinished proof placeholders')}: {target.sorryCount}</p></li>)}</ul>
        <div class="practice-actions"><button type="button" class="button primary" data-practice-save-receipt disabled={state.savedReceipt?.revision === state.revision} onClick={() => {
          setState(savePracticeReceipt(state, new Date().toISOString())); setMessage(tx('回执引用已加入练习记录。', 'The receipt references were added to the exercise record.'));
        }}>{state.savedReceipt?.revision === state.revision ? tx('已加入练习记录', 'Added to the exercise record') : tx('保存回执引用', 'Save receipt references')}</button>
          <a class="text-button" href={`https://theoremos.top/${language === 'en' ? 'en/' : ''}archive.html#view=quickstart`} target="_blank" rel="noreferrer">{tx('打开原录制', 'Open the original recording')}<Icon name="arrow-up-right" /></a></div>
        {state.savedReceipt && <p class="practice-saved" data-practice-saved>{tx(`关联练习计划 v${state.savedReceipt.revision}`, `Linked to exercise plan v${state.savedReceipt.revision}`)} · {date(state.savedReceipt.at)}</p>}
        <div class="practice-real-task"><h3>{tx('准备自己的题目', 'Prepare your own problem')}</h3><p>{tx('带入自然数加零模板后，可以改成自己的题目。真实提交前再配置模型和预算。', 'Start from the addition-by-zero template and replace it with your own problem. Configure a model and budget before making a real submission.')}</p>
          {onPrepare ? <button type="button" class="button" onClick={() => onPrepare(entry)}>{tx('准备研究草稿', 'Prepare a research draft')}</button>
            : <a class="button" href={`./${researchEntryQuery(entry)}`}>{tx('准备研究草稿', 'Prepare a research draft')}</a>}</div>
      </section>}
    </div>
    <section class="practice-history" aria-labelledby="practice-history-title"><h2 id="practice-history-title">{tx('我的练习记录', 'My exercise record')}</h2>
      <p>{tx('练习仅保存在此浏览器；不会进入真实研究、Library 或账号通知。', 'The exercise stays in this browser. It does not create a real research run, a Library asset or an account notification.')}</p>
      <dl><div><dt>{tx('当前计划', 'Current plan')}</dt><dd>v{state.revision} · {approved ? tx('已批准', 'Approved') : tx('待批准', 'Awaiting approval')}</dd></div>
        <div><dt>{tx('指导回执', 'Guidance receipts')}</dt><dd>{state.guidance.length}</dd></div><div><dt>{tx('原录制回执引用', 'Original receipt references')}</dt><dd>{state.savedReceipt ? recordedPracticeEvidence.targets.length : 0}</dd></div></dl>
      {!!state.guidance.length && <details><summary>{tx('查看历次指导与计划版本', 'Read guidance across plan versions')}</summary><ul>{state.guidance.map(item => <li key={item.id}>
        v{item.revision} · {item.instruction === 'use-lemma' ? tx('引用 Nat.zero_add', 'Use Nat.zero_add') : tx('略去左加零', 'Omit left addition')} · {item.accepted ? tx('已采纳', 'Accepted') : tx('未采纳', 'Declined')}
        {item.note && <blockquote>{item.note}</blockquote>}</li>)}</ul></details>}
      <div class="practice-actions"><button type="button" class="button" data-practice-download onClick={download}><Icon name="download" />{tx('下载练习记录', 'Download exercise record')}</button>
        <button type="button" class="text-button" data-practice-reset onClick={reset}><Icon name="rotate-ccw" />{tx('重新练习', 'Start again')}</button></div>
      {storageError && <p role="alert">{tx('浏览器未允许保存，当前练习仍可继续。离开前可下载记录。', 'Browser storage is unavailable. You can continue and download the record before leaving.')}</p>}
    </section>
    <p class="practice-announcement" role="status" aria-live="polite">{message}</p>
  </article>;
}
