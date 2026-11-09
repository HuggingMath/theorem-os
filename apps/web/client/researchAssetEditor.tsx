import { useState } from 'preact/hooks';
import type { ResearchAgentDraft, ResearchAsset, ResearchAssetContent, ResearchAssetKind, ResearchMathDraft, ResearchMathSource, ResearchReleaseRef, ResearchSkillDraft } from '../researchAssetTypes';
import type { ResearchModulePlan, ResearchModuleSlot } from '../../../src/solver/modules/policy';
import type { WebRun } from '../shared';
import { base, Check, enc, Empty, ErrorBox, Field, lines, MutationState, nameOf, Search, tx, useMutation, useResource, type Item, type ResearchContext } from './researchShared';

const blankAgent = (): ResearchAgentDraft => ({ environment: 'mathlib', modulePlan: { scheduler: 'plan', context: 'full', custom: [] }, skills: [], libraries: [] });
const blankSkill = (): ResearchSkillDraft => ({ instructions: '', steps: [], inputs: [], outputs: [], slots: ['M1'], roles: [], mode: 'append', dependencies: [], examples: [] });
const refText = (refs: ResearchReleaseRef[]) => refs.map(ref => `${ref.assetId}@${ref.version}`).join('\n');
function parseRefs(text: string): ResearchReleaseRef[] {
  return lines(text).map(line => {
    const divider = line.lastIndexOf('@');
    if (divider <= 0 || divider === line.length - 1) throw new Error(tx('依赖请按「资产 ID@固定版本」填写，每行一项。', 'Use asset ID@fixed-version for dependencies, one per line.'));
    return { assetId: line.slice(0, divider).trim(), version: line.slice(divider + 1).trim() };
  });
}
export function AssetEditor({ asset, context, onSaved, disabled = false }: { asset?: ResearchAsset; context: ResearchContext; onSaved: (asset: ResearchAsset) => void; disabled?: boolean }) {
  const initial = asset?.draft ?? asset?.release?.content;
  const [kind, setKind] = useState<ResearchAssetKind>(asset?.type ?? 'mathematics'), [name, setName] = useState(asset?.name ?? ''),
    [description, setDescription] = useState(asset?.description ?? ''), [area, setArea] = useState(asset?.area ?? ''), [visibility, setVisibility] = useState(asset?.visibility ?? 'private'),
    [revision, setRevision] = useState(asset?.revision ?? 0);
  const [math, setMath] = useState<ResearchMathSource>(initial && 'source' in initial ? initial.source : { kind: 'run', runId: '' });
  const [entryIds, setEntryIds] = useState(initial && 'source' in initial && initial.source.kind === 'knowledge' ? initial.source.entryIds.join('\n') : '');
  const [agent, setAgent] = useState<ResearchAgentDraft>(initial && 'modulePlan' in initial ? initial : blankAgent());
  const [agentSkills, setAgentSkills] = useState(initial && 'modulePlan' in initial ? refText(initial.skills) : ''),
    [agentLibraries, setAgentLibraries] = useState(initial && 'modulePlan' in initial ? refText(initial.libraries) : '');
  const [skill, setSkill] = useState<ResearchSkillDraft>(initial && 'instructions' in initial ? initial : blankSkill());
  const [steps, setSteps] = useState(initial && 'instructions' in initial ? initial.steps.join('\n') : ''),
    [inputs, setInputs] = useState(initial && 'instructions' in initial ? initial.inputs.join('\n') : ''),
    [outputs, setOutputs] = useState(initial && 'instructions' in initial ? initial.outputs.join('\n') : ''),
    [examples, setExamples] = useState(initial && 'instructions' in initial ? initial.examples.join('\n') : ''),
    [dependencies, setDependencies] = useState(initial && 'instructions' in initial ? refText(initial.dependencies) : '');
  const action = useMutation();
  const changeAgent = (patch: Partial<ResearchAgentDraft>) => setAgent(previous => ({ ...previous, ...patch }));
  const changePlan = (patch: Partial<ResearchModulePlan>) => changeAgent({ modulePlan: { ...agent.modulePlan, ...patch } });
  const changeSkill = (patch: Partial<ResearchSkillDraft>) => setSkill(previous => ({ ...previous, ...patch }));
  const content = (): ResearchAssetContent => kind === 'mathematics' ? { source: math.kind === 'knowledge' ? { ...math, entryIds: lines(entryIds) } : math } satisfies ResearchMathDraft
    : kind === 'agent' ? { ...agent, skills: parseRefs(agentSkills), libraries: parseRefs(agentLibraries) }
    : { ...skill, steps: lines(steps), inputs: lines(inputs), outputs: lines(outputs), examples: lines(examples), dependencies: parseRefs(dependencies) };
  const save = () => {
    if (disabled) return;
    let draft: ResearchAssetContent;
    try { draft = content(); } catch (cause) { action.setError(cause instanceof Error ? cause.message : String(cause)); return; }
    void action.run<Item<ResearchAsset>>(asset ? 'PATCH' : 'POST', `${base}/library${asset ? `/${enc(asset.id)}` : ''}`,
      { ...(asset ? { expectedRevision: revision } : { type: kind }), name: name.trim(), description, area, visibility, content: draft }, result => {
        setRevision(result.item.revision); onSaved(result.item);
      });
  };
  return <form class="research-form" onSubmit={event => { event.preventDefault(); save(); }}>
    {!asset && <label>{tx('内容类型', 'Content type')}<select value={kind} onChange={event => setKind(event.currentTarget.value as ResearchAssetKind)}>
      <option value="mathematics">{tx('数学成果', 'Mathematics')}</option><option value="agent">Agent</option><option value="skill">Skill</option></select></label>}
    <Field label={tx('名称', 'Name')} value={name} onInput={setName} required maxLength={160} />
    <Field label={tx('用途与说明', 'Purpose and description')} value={description} onInput={setDescription} multiline rows={3} />
    <div class="research-form-row"><Field label={tx('研究领域', 'Research field')} value={area} onInput={setArea} />
      <label>{tx('草稿可见范围', 'Draft visibility')}<select value={visibility} onChange={event => setVisibility(event.currentTarget.value as 'private' | 'public')}>
        <option value="private">{tx('仅自己', 'Private')}</option><option value="public">{tx('发布后公开', 'Public when published')}</option></select></label></div>
    {kind === 'mathematics' ? <><h3>{tx('选择可检查的成果来源', 'Choose a verifiable source')}</h3><MathSourceEditor source={math} onChange={setMath} entryIds={entryIds} setEntryIds={setEntryIds} /></>
      : kind === 'agent' ? <><h3>{tx('研究配置', 'Research configuration')}</h3><div class="research-form-row"><label>{tx('证明环境', 'Environment')}<select value={agent.environment ?? 'mathlib'} onChange={event => changeAgent({ environment: event.currentTarget.value as 'standard' | 'mathlib' })}>
        <option value="mathlib">mathlib</option><option value="standard">Lean standard</option></select></label><label>{tx('模型服务商（可选）', 'Provider (optional)')}<select value={agent.providerId ?? ''} onChange={event => changeAgent({ providerId: event.currentTarget.value || undefined })}>
        <option value="">{tx('使用研究工作台设置', 'Use workbench setting')}</option>{context.web.providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label></div>
        <Field label={tx('模型名称（可选）', 'Model name (optional)')} value={agent.model ?? ''} onInput={value => changeAgent({ model: value || undefined })} />
        <div class="research-form-row"><label>{tx('推理强度', 'Reasoning effort')}<select value={agent.effort ?? ''} onChange={event => changeAgent({ effort: event.currentTarget.value as ResearchAgentDraft['effort'] || undefined })}>
          <option value="">{tx('使用工作台设置', 'Use workbench setting')}</option>{['low', 'medium', 'high', 'xhigh', 'max'].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
          <label>{tx('Agent 数量', 'Workers')}<input type="number" min="1" max={context.web.limits.maxWorkers} value={agent.workers ?? ''} placeholder={tx('使用工作台设置', 'Use workbench setting')} onInput={event => changeAgent({ workers: event.currentTarget.value ? Number(event.currentTarget.value) : undefined })} /></label></div>
        <label>{tx('协作方式', 'Coordination')}<select value={agent.coordination ?? 'cooperative'} onChange={event => changeAgent({ coordination: event.currentTarget.value as 'cooperative' | 'independent' })}>
          <option value="cooperative">{tx('协作研究', 'Cooperative')}</option><option value="independent">{tx('独立研究', 'Independent')}</option></select></label>
        <div class="research-form-row"><label>{tx('任务调度', 'Scheduling')}<select value={agent.modulePlan.scheduler} onChange={event => changePlan({ scheduler: event.currentTarget.value as ResearchModulePlan['scheduler'] })}>
          <option value="plan">{tx('按研究计划', 'Research plan')}</option><option value="critical-path">{tx('关键路径优先', 'Critical path')}</option><option value="continuation">{tx('延续现有尝试', 'Continuation')}</option></select></label>
          <label>{tx('上下文范围', 'Context')}<select value={agent.modulePlan.context} onChange={event => changePlan({ context: event.currentTarget.value as 'full' | 'essential' })}>
            <option value="full">{tx('完整上下文', 'Full')}</option><option value="essential">{tx('必要上下文', 'Essential')}</option></select></label></div>
        <h3>{tx('自定义研究规则', 'Custom research rules')}</h3>{agent.modulePlan.custom.map((module, index) => {
          const update = (patch: Partial<typeof module>) => changePlan({ custom: agent.modulePlan.custom.map((item, at) => at === index ? { ...item, ...patch } : item) });
          return <fieldset class="research-rules" key={module.id}><legend>{module.name || tx('自定义规则', 'Custom rule')}</legend><Field label={tx('规则名称', 'Rule name')} value={module.name} onInput={value => update({ name: value })} maxLength={40} />
            <div class="research-form-row"><label>{tx('适用组件', 'Component')}<select value={module.slot} onChange={event => update({ slot: event.currentTarget.value as ResearchModuleSlot })}>{['M1', 'M3', 'M4', 'M5'].map(slot => <option key={slot}>{slot}</option>)}</select></label>
              <label>{tx('应用方式', 'Mode')}<select value={module.mode} onChange={event => update({ mode: event.currentTarget.value as 'append' | 'replace' })}><option value="append">{tx('追加规则', 'Append')}</option><option value="replace">{tx('替换该组件规则', 'Replace')}</option></select></label></div>
            <Field label={tx('规则正文', 'Instructions')} value={module.instructions} onInput={value => update({ instructions: value })} multiline rows={4} maxLength={4000} />
            <div class="research-actions"><Check label={tx('启用', 'Enabled')} checked={module.enabled} onChange={value => update({ enabled: value })} />
              <button type="button" class="text-button" onClick={() => changePlan({ custom: agent.modulePlan.custom.filter((_, at) => at !== index) })}>{tx('移除规则', 'Remove rule')}</button></div></fieldset>;
        })}<button class="button" type="button" disabled={agent.modulePlan.custom.length >= 8} onClick={() => changePlan({ custom: [...agent.modulePlan.custom, {
          id: `module-${crypto.randomUUID().slice(0, 8)}`, name: '', slot: 'M1', mode: 'append', enabled: true, instructions: '',
        }] })}>{tx('添加规则', 'Add rule')}</button>
        <Field label={tx('依赖 Skill，每行：资产 ID@版本', 'Skills, one per line: asset ID@version')} value={agentSkills} onInput={setAgentSkills} multiline code rows={2} />
        <Field label={tx('依赖数学库，每行：资产 ID@版本', 'Libraries, one per line: asset ID@version')} value={agentLibraries} onInput={setAgentLibraries} multiline code rows={2} />
      </> : <><h3>{tx('流程型 Skill', 'Workflow skill')}</h3><Field label={tx('适用情境与执行要求', 'When to use and instructions')} value={skill.instructions} onInput={value => changeSkill({ instructions: value })} multiline required rows={6} />
        <Field label={tx('执行步骤，每行一步', 'Steps, one per line')} value={steps} onInput={setSteps} multiline rows={5} />
        <div class="research-form-row"><Field label={tx('输入，每行一项', 'Inputs, one per line')} value={inputs} onInput={setInputs} multiline rows={3} /><Field label={tx('产物，每行一项', 'Outputs, one per line')} value={outputs} onInput={setOutputs} multiline rows={3} /></div>
        <fieldset class="research-rules"><legend>{tx('适用组件', 'Applicable components')}</legend><div class="research-actions">{(['M1', 'M3', 'M4', 'M5'] as const).map(slot => <Check key={slot} label={slot} checked={skill.slots.includes(slot)} onChange={checked => changeSkill({ slots: checked ? [...skill.slots, slot] : skill.slots.filter(item => item !== slot) })} />)}</div></fieldset>
        <fieldset class="research-rules"><legend>{tx('适用角色（不选择表示不限制）', 'Roles (leave empty for all)')}</legend><div class="research-actions">{(['lead', 'researcher', 'engineer', 'reviewer'] as const).map(role => <Check key={role} label={role} checked={skill.roles.includes(role)} onChange={checked => changeSkill({ roles: checked ? [...skill.roles, role] : skill.roles.filter(item => item !== role) })} />)}</div></fieldset>
        <label>{tx('应用方式', 'Mode')}<select value={skill.mode} onChange={event => changeSkill({ mode: event.currentTarget.value as 'append' | 'replace' })}><option value="append">{tx('追加规则', 'Append')}</option><option value="replace">{tx('替换组件规则', 'Replace')}</option></select></label>
        <Field label={tx('依赖，每行：资产 ID@版本', 'Dependencies, one per line: asset ID@version')} value={dependencies} onInput={setDependencies} multiline code rows={2} />
        <Field label={tx('示例，每行一个', 'Examples, one per line')} value={examples} onInput={setExamples} multiline rows={3} />
      </>}
    {asset && asset.revision !== revision && <p class="research-status">{tx('服务器上的草稿已更新。当前输入仍保留；点击「载入最新草稿」可更新。', 'The saved draft has changed. Your input is preserved; choose “Load latest draft” to update it.')}</p>}
    <MutationState action={action} /><button type="submit" class="button button-primary" disabled={disabled || action.busy}>{action.busy ? tx('正在保存…', 'Saving…') : asset ? tx('保存草稿', 'Save draft') : tx('创建私有草稿', 'Create draft')}</button>
  </form>;
}

function MathSourceEditor({ source, onChange, entryIds, setEntryIds }: { source: ResearchMathSource; onChange: (source: ResearchMathSource) => void; entryIds: string; setEntryIds: (value: string) => void }) {
  const runs = useResource<{ runs: WebRun[] }>('/api/runs');
  const catalogs = useResource<{ catalogs: { digest: string; entries: number; createdAt: string }[] }>('/api/knowledge/catalogs');
  const [query, setQuery] = useState('');
  const matches = useResource<{ results: { hits: { id: string; name: string; typePreview: string; description: string }[] } }>(source.kind === 'knowledge' && source.catalogDigest && query
    ? `/api/knowledge/search?q=${enc(query)}&catalogDigest=${enc(source.catalogDigest)}&limit=12` : undefined);
  return <><label>{tx('来源', 'Source')}<select value={source.kind} onChange={event => onChange(event.currentTarget.value === 'knowledge'
    ? { kind: 'knowledge', catalogDigest: '', entryIds: [] } : { kind: 'run', runId: '' })}><option value="run">{tx('我的研究运行', 'My research run')}</option><option value="knowledge">{tx('我的知识目录', 'My knowledge catalog')}</option></select></label>
    {source.kind === 'run' ? <><label>{tx('来源运行', 'Source run')}<select required value={source.runId} onChange={event => onChange({ ...source, runId: event.currentTarget.value })}>
      <option value="">{tx('选择运行', 'Choose a run')}</option>{runs.data?.runs.map(run => <option key={run.id} value={run.id}>{run.title} · {nameOf(run.status)}</option>)}</select></label><ErrorBox message={runs.error} />
      <div class="research-form-row"><Field label={tx('任务 ID（可选，限定辅助引理）', 'Task ID (optional, limits to a lemma)')} value={source.taskId ?? ''} onInput={value => onChange({ ...source, taskId: value || undefined })} />
        <Field label={tx('源码提交（可选）', 'Source commit (optional)')} value={source.commit ?? ''} onInput={value => onChange({ ...source, commit: value || undefined })} /></div></>
      : <><label>{tx('固定知识目录版本', 'Fixed knowledge catalog')}<select required value={source.catalogDigest} onChange={event => { onChange({ ...source, catalogDigest: event.currentTarget.value }); setEntryIds(''); }}>
        <option value="">{tx('选择目录', 'Choose a catalog')}</option>{catalogs.data?.catalogs.map(catalog => <option key={catalog.digest} value={catalog.digest}>{catalog.digest.slice(0, 16)} · {catalog.entries} {tx('条目', 'entries')}</option>)}</select></label><ErrorBox message={catalogs.error} />
        <Search label={tx('搜索目录中的 Lean 名称或陈述', 'Search Lean names or statements in the catalog')} onSearch={setQuery} /><ErrorBox message={matches.error} />
        {matches.data?.results.hits.map(hit => <div class="research-event" key={hit.id}><Check label={`${hit.name} · ${hit.description}`} checked={lines(entryIds).includes(hit.id)} onChange={checked => setEntryIds((checked ? [...lines(entryIds), hit.id] : lines(entryIds).filter(id => id !== hit.id)).join('\n'))} />
          <pre class="research-block-code">{hit.typePreview}</pre></div>)}
        {matches.data && !matches.data.results.hits.length && <Empty>{tx('没有匹配的数学条目。', 'No matching mathematics entries.')}</Empty>}
        <Field label={tx('选中的条目 ID，每行一项', 'Selected entry IDs, one per line')} value={entryIds} onInput={setEntryIds} multiline code rows={3} required /></>}
    <p class="research-field-note">{tx('发布时会打包必要依赖并在声明环境中检查。历史检查记录会随来源保留。', 'Publishing packages the required dependencies and checks them in the declared environment. Historical evidence stays attached to the source.')}</p>
  </>;
}
