import type { ResearchLibraryCandidateAttachment } from '../researchLibraryTrialTypes';
import { RichProse } from './richText';
import { tx } from './researchShared';

/** Frozen evidence stays readable by reviewers even if the author's private scratch trial is inaccessible. */
export function LibraryCandidateEvidence({ attachment }: { attachment: ResearchLibraryCandidateAttachment }) {
  const { trial } = attachment;
  return <details class="research-library-candidate" data-library-candidate-evidence>
    <summary>{tx('参数、前提与固定 Library 证据', 'Arguments, premises and fixed Library evidence')}</summary>
    <p><code>{trial.declaration.name}</code> · {trial.release.version}</p>
    {trial.argumentNotes && <><h4>{tx('试用时的参数对应', 'Argument mapping from the trial')}</h4><RichProse text={trial.argumentNotes} /></>}
    {trial.missingPremises && <><h4>{tx('试用时记录的待补前提', 'Premises recorded as missing in the trial')}</h4><RichProse text={trial.missingPremises} /></>}
    <dl class="research-facts"><div><dt>{tx('固定数学成果', 'Fixed mathematics release')}</dt><dd><code>{trial.release.assetId}@{trial.release.version}</code></dd></div>
      <div><dt>{tx('成果摘要', 'Release digest')}</dt><dd><code>{trial.release.digest}</code></dd></div>
      <div><dt>{tx('固定库摘要', 'Fixed library digest')}</dt><dd><code>{trial.libraryPackDigest}</code></dd></div>
      <div><dt>{tx('试用回执', 'Trial receipt')}</dt><dd><code>{trial.check?.receiptId}</code></dd></div></dl>
    <p class="research-field-note">{tx('以下保留最初试用的证据；当前候选的独立检查见「检查回执」。', 'The evidence below records the original trial. The current candidate’s independent check is under Check receipt.')}</p>
    <details><summary>{tx('最初试用的完整源码与回执', 'Complete source and receipt from the original trial')}</summary>
      <pre class="research-block-code">{trial.source}</pre><pre class="research-block-code">{JSON.stringify(trial.check?.receipt, null, 2)}</pre></details>
    <h4>{tx('这份候选的固定数学库', 'Fixed mathematics library for this candidate')}</h4>
    {attachment.libraryPack.modules.map(module => <details key={module.file} data-library-candidate-module={module.file}>
      <summary>{module.file}</summary><pre class="research-block-code">{module.source}</pre></details>)}
    {attachment.dependencySources.length > 0 && <details><summary>{tx('候选依赖源码', 'Candidate dependency source')}</summary>
      {attachment.dependencySources.map(file => <div key={file.file}><h4>{file.file}</h4><pre class="research-block-code">{file.source}</pre></div>)}</details>}
  </details>;
}
