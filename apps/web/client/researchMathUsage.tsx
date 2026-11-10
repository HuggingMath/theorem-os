import type { ResearchAssetRelease, ResearchCheckedMathExample, ResearchMathUsage } from '../researchAssetTypes';
import { RichProse } from './richText';
import { stamp, tx } from './researchShared';

export function MathUsageDescription({ usage }: { usage?: Pick<ResearchMathUsage, 'conditions' | 'result'> }) {
  if (!usage?.conditions && !usage?.result) return null;
  return <section class="research-math-usage" data-math-usage>
    {usage.conditions && <><h3>{tx('适用条件', 'When this applies')}</h3><RichProse text={usage.conditions} /></>}
    {usage.result && <><h3>{tx('能够得到什么', 'What this establishes')}</h3><RichProse text={usage.result} /></>}
  </section>;
}

export function CheckedMathExamples({ release, load }: { release: ResearchAssetRelease; load?(example: ResearchCheckedMathExample): void }) {
  const examples = release.mathematics?.usage?.examples ?? [];
  if (!examples.length) return null;
  return <section class="research-math-examples" data-math-examples><h3>{tx('已检查的调用示例', 'Checked invocation examples')}</h3>
    {examples.map(example => <details key={example.id} data-math-example={example.id}>
      <summary>{example.title}<span>{tx('独立检查通过', 'Independently checked')}</span></summary>
      <p><code>{example.declaration}</code></p><pre class="research-block-code">{example.type}</pre>
      {example.argumentNotes && <RichProse text={example.argumentNotes} />}
      <pre class="research-block-code">{example.proof}</pre>
      {load && <button type="button" class="button" data-load-math-example={example.id} onClick={() => load(example)}>{tx('载入试用编辑器', 'Load into the trial editor')}</button>}
      <details class="research-example-evidence"><summary>{tx('查看这个示例的检查证据', 'View this example’s check evidence')}</summary>
        <p>{stamp(example.check.receipt.checkedAt)} · {example.check.receipt.environment}</p>
        <dl class="research-facts"><div><dt>{tx('示例源码摘要', 'Example source digest')}</dt><dd><code>{example.sourceDigest}</code></dd></div>
          <div><dt>{tx('回执', 'Receipt')}</dt><dd><code>{example.check.receiptId}</code></dd></div></dl>
        <pre class="research-block-code">{example.source}</pre><pre class="research-block-code">{JSON.stringify(example.check.receipt, null, 2)}</pre>
      </details>
    </details>)}
  </section>;
}
