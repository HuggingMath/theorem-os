import type { ResearchMathUsage } from '../researchAssetTypes';
import { RichProse } from './richText';
import { Field, tx } from './researchShared';

export function MathUsageEditor({ value, change, declarations }: { value: ResearchMathUsage; change(value: ResearchMathUsage): void; declarations: string[] }) {
  const update = (index: number, patch: Partial<ResearchMathUsage['examples'][number]>) => change({ ...value,
    examples: value.examples.map((example, at) => at === index ? { ...example, ...patch } : example) });
  return <section class="research-math-usage-editor" data-math-usage-editor>
    <h3>{tx('帮助读者使用这个成果', 'Help readers use this result')}</h3>
    <Field label={tx('适用条件', 'When this applies')} value={value.conditions} onInput={conditions => change({ ...value, conditions })} multiline rows={3} maxLength={4000}
      placeholder={tx('写清对象、已知条件和适用范围，可以使用 LaTeX。', 'Describe the objects, assumptions and scope. LaTeX is supported.')} />
    <Field label={tx('能够得到什么', 'What this establishes')} value={value.result} onInput={result => change({ ...value, result })} multiline rows={3} maxLength={4000} />
    {(value.conditions || value.result) && <details><summary>{tx('预览数学说明', 'Preview the mathematical description')}</summary>
      {value.conditions && <RichProse text={value.conditions} />}{value.result && <RichProse text={value.result} />}</details>}
    {value.examples.map((example, index) => <fieldset class="research-rules" key={example.id} data-math-example-editor={example.id}>
      <legend>{tx('调用示例', 'Invocation example')} {index + 1}</legend>
      <Field label={tx('示例名称', 'Example title')} value={example.title} onInput={title => update(index, { title })} required maxLength={160} />
      {declarations.length ? <label>{tx('示例使用的声明', 'Declaration used by the example')}<select value={example.declaration} onChange={event => update(index, { declaration: event.currentTarget.value })} required>
        <option value="">{tx('选择一个声明', 'Choose a declaration')}</option>{[...new Set([...declarations, ...(example.declaration ? [example.declaration] : [])])].map(name => <option key={name} value={name}>{name}</option>)}</select></label>
        : <Field label={tx('示例使用的完整 Lean 名称', 'Full Lean name used by the example')} value={example.declaration} onInput={declaration => update(index, { declaration })} required maxLength={1000} />}
      <Field label={tx('示例目标的完整 Lean 类型', 'Complete Lean type of the example goal')} value={example.type} onInput={type => update(index, { type })} multiline code rows={3} required maxLength={4000}
        placeholder="∀ n : Nat, n + 0 = n" />
      <Field label={tx('示例 Lean 证明体', 'Example Lean proof body')} value={example.proof} onInput={proof => update(index, { proof })} multiline code rows={5} required maxLength={12000}
        placeholder={'by\n  intro n\n  exact Shared.zero n'} />
      <Field label={tx('示例的参数与前提', 'Example arguments and premises')} value={example.argumentNotes} onInput={argumentNotes => update(index, { argumentNotes })} multiline rows={2} maxLength={4000} />
      <button type="button" class="text-button" onClick={() => change({ ...value, examples: value.examples.filter((_, at) => at !== index) })}>{tx('移除示例', 'Remove example')}</button>
    </fieldset>)}
    <button type="button" class="button" disabled={value.examples.length >= 6} onClick={() => change({ ...value, examples: [...value.examples,
      { id: `example_${crypto.randomUUID().replaceAll('-', '')}`, title: '', declaration: declarations[0] ?? '', type: '', proof: '', argumentNotes: '' }] })}>{tx('添加调用示例', 'Add an invocation example')}</button>
    <p class="research-field-note">{tx('保存草稿不会运行示例。发布时会在该成果的固定库和环境中逐一独立检查，通过后随版本保存。', 'Saving a draft does not run the examples. Publication checks each example independently against the fixed library and environment, then saves passing examples with the release.')}</p>
  </section>;
}
