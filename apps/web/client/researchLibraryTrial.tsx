import { useEffect, useRef, useState } from 'preact/hooks';
import type { ResearchAssetRelease, ResearchCheckedMathExample } from '../researchAssetTypes';
import type { ResearchLibraryTrial, ResearchLibraryTrialTarget } from '../researchLibraryTrialTypes';
import { localizeMessage } from '../i18n';
import { Rich, RichProse } from './richText';
import { LibraryTrialProposal, PersonalTrialAttempt } from './researchLibraryProposal';
import { CheckedMathExamples } from './researchMathUsage';
import { base, enc, ErrorBox, Field, MutationState, tx, useMutation, useResource, type Item, type Items, type ResearchContext } from './researchShared';

const targetKey = ({ ref }: ResearchLibraryTrialTarget) => JSON.stringify([ref.runId, ref.projectId ?? '', ref.taskId, ref.taskVersion,
  ref.commit, ref.sourceDigest, ref.environmentDigest, ref.file]);
const draftInput = (item: ResearchLibraryTrial) => JSON.stringify([targetKey(item.target), item.declaration.name, item.proof, item.argumentNotes, item.missingPremises]);
export function LibraryTrial({ release, context }: { release: ResearchAssetRelease; context: ResearchContext }) {
  if (release.type !== 'mathematics' || !release.mathematics) return null;
  const signIn = new URLSearchParams({ returnTo: 'library', entry: release.assetId, version: release.version });
  const parameters = new URLSearchParams(location.search);
  for (const name of ['trial', 'run', 'project', 'task', 'taskVersion', 'commit']) if (parameters.has(name)) signIn.set(name, parameters.get(name)!);
  return context.session.authenticated ? <TrialForm key={`${release.assetId}:${release.digest}`} release={release} />
    : <><CheckedMathExamples release={release} /><a class="button" href={`login.html?${signIn}`}>{tx('登录后在研究目标中试用', 'Sign in to try this on a research goal')}</a></>;
}
function TrialForm({ release }: { release: ResearchAssetRelease }) {
  const parameters = new URLSearchParams(location.search), linkedRun = parameters.get('run'), linkedTask = parameters.get('task');
  const [trialId, setTrialId] = useState(parameters.get('trial') ?? '');
  const [open, setOpen] = useState(Boolean(linkedRun || trialId)), [selected, setSelected] = useState(''), [name, setName] = useState(release.mathematics!.declarations[0]?.name ?? '');
  const [proof, setProof] = useState(''), [argumentsNote, setArgumentsNote] = useState(''), [missing, setMissing] = useState('');
  const [prepared, setPrepared] = useState<{ input: string; item: ResearchLibraryTrial }>(), [confirmed, setConfirmed] = useState('');
  const [loadedExample, setLoadedExample] = useState('');
  const restored = useRef('');
  const saved = useResource<Item<ResearchLibraryTrial>>(trialId ? `${base}/library-trials/${enc(trialId)}` : undefined, prepared?.item.status === 'checking' ? 1000 : 0);
  const targets = useResource<Items<ResearchLibraryTrialTarget>>(open ? `${base}/library/${enc(release.assetId)}/releases/${enc(release.version)}/trial-targets` : undefined);
  const prepare = useMutation(), check = useMutation();
  const recovery = saved.data?.item, matchingRecovery = recovery?.release.assetId === release.assetId && recovery.release.digest === release.digest;
  useEffect(() => {
    if (!recovery || !matchingRecovery) return;
    if (restored.current !== recovery.id) {
      restored.current = recovery.id;
      setSelected(targetKey(recovery.target)); setName(recovery.declaration.name); setProof(recovery.proof);
      setArgumentsNote(recovery.argumentNotes); setMissing(recovery.missingPremises); setConfirmed('');
      setPrepared({ input: draftInput(recovery), item: recovery });
    } else setPrepared(previous => previous?.item.id === recovery.id && !(previous.item.check && !recovery.check) ? { ...previous, item: recovery } : previous);
  }, [recovery, matchingRecovery]);
  const available = targets.data?.items ?? [], requested = available.find(item => item.ref.runId === linkedRun && (!linkedTask || item.ref.taskId === linkedTask)
    && (!parameters.get('project') || !item.ref.projectId || item.ref.projectId === parameters.get('project'))
    && (!parameters.get('taskVersion') || item.ref.taskVersion === parameters.get('taskVersion')) && (!parameters.get('commit') || item.ref.commit === parameters.get('commit')));
  const target = selected ? available.find(item => targetKey(item) === selected) : linkedRun ? requested : available.find(item => item.compatible);
  const declaration = release.mathematics!.declarations.find(item => item.name === name);
  const input = JSON.stringify([target ? targetKey(target) : undefined, name, proof, argumentsNote, missing]);
  const draft = prepared?.input === input ? prepared.item : undefined;
  const busy = prepare.busy || check.busy || draft?.status === 'checking';
  const loadExample = (example: ResearchCheckedMathExample) => {
    setName(example.declaration); setProof(example.proof); setArgumentsNote(example.argumentNotes); setMissing('');
    setConfirmed(''); setPrepared(undefined); setTrialId(''); setLoadedExample(example.title); setOpen(true); prepare.reset(); check.reset();
    const next = new URL(location.href); next.searchParams.delete('trial'); history.replaceState(null, '', next);
  };
  return <><CheckedMathExamples release={release} load={loadExample} /><details class="research-library-trial" open={open} onToggle={event => setOpen(event.currentTarget.open)} data-library-trial>
    <summary>{tx('在研究目标中试用', 'Try on a research goal')}</summary>
    <p><a class="research-inline-link" href={`workspace.html?${new URLSearchParams({ tab: 'trials', asset: release.assetId })}`}>{tx('查看这个成果的试用记录', 'View your trials with this release')}</a></p>
    <p>{tx('选定任务和声明，写出参数与前提，再填写 Lean 候选调用。审阅完整候选后，由你确认独立检查。', 'Choose a task and declaration, identify its arguments and premises, then write a Lean candidate. Review the complete candidate before confirming an independent check.')}</p>
    {loadedExample && <p role="status" data-math-example-loaded>{tx('已载入示例：', 'Loaded example: ')}{loadedExample} · {tx('请按当前任务调整参数和证明体，再准备检查。', 'Adapt the arguments and proof to the current task, then prepare a check.')}</p>}
    <ErrorBox message={targets.error} />{targets.error && <button class="text-button" type="button" onClick={targets.refresh}>{tx('重新读取目标', 'Reload goals')}</button>}
    <ErrorBox message={saved.error} />{saved.error && <button class="text-button" type="button" onClick={saved.refresh}>{tx('重新读取试用候选', 'Reload trial candidate')}</button>}
    {saved.loading && <p role="status">{tx('正在恢复已保存的候选与检查回执…', 'Restoring the saved candidate and check receipt…')}</p>}
    {recovery && !matchingRecovery && <ErrorBox message={tx('保存的试用属于另一个成果版本。请选择对应版本，或重新准备候选。', 'The saved trial belongs to another release. Choose that release or prepare a new candidate.')} />}
    {targets.loading && <p role="status">{tx('正在读取可访问的精确任务版本…', 'Loading accessible task versions…')}</p>}
    {targets.data && !available.length && <p class="research-status">{tx('当前没有保存了定理源码的可试用任务。先打开一次研究；项目任务需要候选证明权限。', 'No eligible task with saved theorem source is available. Open a research run first; project tasks require proof submission permission.')}</p>}
    {targets.data && Boolean(available.length) && <form class="research-form" onSubmit={event => {
      event.preventDefault(); if (!target || !target.compatible || !declaration) return;
      const submitted = input;
      void prepare.run<Item<ResearchLibraryTrial>>('POST', `${base}/library/${enc(release.assetId)}/releases/${enc(release.version)}/trials`, {
        releaseDigest: release.digest, target: target.ref, declaration: name, proof, argumentNotes: argumentsNote, missingPremises: missing,
      }, result => {
        restored.current = result.item.id; setTrialId(result.item.id);
        const next = new URL(location.href); next.searchParams.set('trial', result.item.id); history.replaceState(null, '', next);
        setPrepared({ input: submitted, item: result.item }); setConfirmed(''); check.reset();
      });
    }}>
      <label>{tx('研究 / 精确任务版本', 'Research / exact task version')}<select value={target ? targetKey(target) : ''} disabled={busy} onChange={event => { setSelected(event.currentTarget.value); setConfirmed(''); }}>
        <option value="">{tx('选择一个当前目标', 'Choose a current goal')}</option>{available.map(item => <option key={targetKey(item)} value={targetKey(item)} disabled={!item.compatible}>
          {item.runTitle} · {item.taskTitle} · {item.ref.taskVersion.slice(0, 10)} · {item.ref.commit.slice(0, 10)}{item.compatible ? '' : ` · ${tx('环境不同', 'Different environment')}`}</option>)}</select></label>
      {linkedRun && !requested && !selected && <ErrorBox message={tx('入口对应的任务版本或源码提交已改变。请明确选择当前目标后重新准备。', 'The linked task version or source commit has changed. Select the current goal explicitly to prepare a new candidate.')} />}
      {target && <section class="research-trial-target"><h4><Rich text={target.taskTitle} /></h4><pre class="research-block-code">{target.type}</pre>
        {target.premises.length > 0 && <><h4>{tx('任务记录的前提', 'Recorded task premises')}</h4><ul>{target.premises.map((premise, index) => <li key={index}><Rich text={premise} /></li>)}</ul></>}
        <p class="research-status">{target.environment} · {target.ref.file} · {target.ref.commit.slice(0, 12)}</p><ErrorBox message={target.incompatibility && localizeMessage(target.incompatibility)} /></section>}
      <label>{tx('要试用的数学声明', 'Declaration to try')}<select value={name} disabled={busy} onChange={event => { setName(event.currentTarget.value); setConfirmed(''); }}>
        {release.mathematics!.declarations.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
      {declaration && <pre class="research-block-code">{declaration.type}</pre>}
      <Field label={tx('参数如何对应（可选）', 'Argument mapping (optional)')} value={argumentsNote} onInput={value => { setArgumentsNote(value); setConfirmed(''); }} multiline rows={2} maxLength={4000}
        placeholder={tx('例如：n 对应当前目标中的 k；h 对应已知的非负条件。', 'For example: n is k in this goal; h is the established nonnegativity premise.')} />
      <Field label={tx('仍需补充的前提（可选）', 'Premises still needed (optional)')} value={missing} onInput={value => { setMissing(value); setConfirmed(''); }} multiline rows={2} maxLength={4000} />
      <Field label={tx('候选 Lean 证明体', 'Candidate Lean proof body')} value={proof} onInput={value => { setProof(value); setConfirmed(''); }} multiline code rows={6} required maxLength={24000}
        placeholder={`by\n  exact ${name || 'Library.theorem_name'} ...`}
        note={tx('填写目标声明 := 后面的证明。可写多行 tactic 或完整证明项；参数和缺失前提是否成立以独立检查为准。', 'Write the proof after the target declaration’s :=. Use multiline tactics or a proof term. The independent check determines whether arguments and premises are satisfied.')} />
      <MutationState action={prepare} />{prepare.error && <button class="text-button" type="button" onClick={targets.refresh}>{tx('刷新目标后重新准备', 'Refresh goals and prepare again')}</button>}
      <button class="button" type="submit" disabled={busy || !target?.compatible || !proof.trim()}>{prepare.busy ? tx('正在准备…', 'Preparing…') : tx('准备并审阅候选', 'Prepare candidate for review')}</button>
    </form>}
    {draft && <section class="research-trial-review" data-library-trial-review><h4>{tx('审阅这份独立试用候选', 'Review this isolated trial candidate')}</h4>
      <p>{draft.release.version} · <code>{draft.release.digest}</code></p><p>{draft.target.declaration} · {draft.target.ref.taskVersion.slice(0, 12)} · {draft.target.ref.commit.slice(0, 12)}</p>
      {draft.argumentNotes && <RichProse text={draft.argumentNotes} />}{draft.missingPremises && <RichProse text={draft.missingPremises} />}
      <details open><summary>{tx('完整候选源码与成果导入', 'Complete candidate source and imports')}</summary><pre class="research-block-code">{draft.source}</pre></details>
      {draft.status === 'checking' && <p role="status">{tx('这份候选正在独立检查，完成后会显示回执。', 'This candidate is being checked. The receipt will appear when it completes.')}</p>}
      {!draft.check && <><label class="research-check"><input type="checkbox" checked={confirmed === draft.digest} disabled={busy} onChange={event => setConfirmed(event.currentTarget.checked ? draft.digest : '')} />
        {tx('我已核对目标、固定成果版本和候选源码', 'I reviewed the goal, fixed release and candidate source')}</label>
        <button class="button" type="button" disabled={busy || confirmed !== draft.digest} onClick={() => void check.run<Item<ResearchLibraryTrial>>('POST', `${base}/library-trials/${enc(draft.id)}/check`, {
          expectedDigest: draft.digest, confirmed: true,
        }, result => setPrepared({ input, item: result.item }))}>{check.busy ? tx('正在独立检查…', 'Checking independently…') : tx('确认并独立检查', 'Confirm and check independently')}</button></>}
      <MutationState action={check} />{draft.check && <TrialReceipt trial={draft} />}
      {draft.status === 'passed' && <><PersonalTrialAttempt key={`personal:${draft.digest}`} trial={draft} /><LibraryTrialProposal key={draft.digest} trial={draft} /></>}
      <p class="research-field-note">{tx('试用只检查这份候选目标。原研究的题目、源码、任务状态和完整验收结果均保留原记录。', 'This trial checks the candidate goal. The original problem, source, task status and full acceptance records remain as recorded.')}</p>
    </section>}
  </details></>;
}
function TrialReceipt({ trial }: { trial: ResearchLibraryTrial }) {
  const { receipt, receiptId } = trial.check!;
  return <section class="research-trial-receipt" role="status" data-library-trial-receipt><h4>{receipt.passed ? tx('试用候选通过独立检查', 'Trial candidate passed the independent check') : tx('试用候选未通过检查', 'Trial candidate did not pass')}</h4>
    {receipt.reason && <ErrorBox message={localizeMessage(receipt.reason)} />}{receipt.diagnostics.map((item, index) => <p key={index}>{item.line}:{item.column} · {item.message ?? item.code}</p>)}
    <dl class="research-facts"><div><dt>{tx('检查目标', 'Checked goal')}</dt><dd>{receipt.checkedDeclaration}</dd></div>
      <div><dt>{tx('回执', 'Receipt')}</dt><dd><code>{receiptId}</code></dd></div><div><dt>{tx('候选源码摘要', 'Candidate digest')}</dt><dd><code>{receipt.sourceDigest}</code></dd></div>
      <div><dt>{tx('检查时间', 'Checked at')}</dt><dd>{receipt.checkedAt}</dd></div></dl>
    <details><summary>{tx('查看完整检查回执', 'View complete check receipt')}</summary><pre class="research-block-code">{JSON.stringify(receipt, null, 2)}</pre></details>
  </section>;
}
