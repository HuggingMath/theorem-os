import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { WebTeamProfile } from '../shared';
import type { ResearchAsset, ResearchReleaseRef } from '../researchAssetTypes';
import { locale, t } from '../i18n';

type Props = { value: string[]; change(value: string[]): void; load(): Promise<WebTeamProfile[]> };

type ExpertChoice = ResearchReleaseRef & { type: 'agent' | 'skill'; name: string };
type ExpertProps = { owner: string; selected: ResearchReleaseRef[]; load(): Promise<ResearchAsset[]>;
  choose(choice: ExpertChoice): Promise<void> };

function PersonalExperts({ selected, load, choose }: ExpertProps) {
  const [open, setOpen] = useState(false), [items, setItems] = useState<ExpertChoice[]>(),
    [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    let active = true; setError('');
    load().then(assets => { if (active) setItems(assets.flatMap(({ type, id, name, releases }) =>
      type === 'mathematics' ? [] : releases.filter(r => !r.withdrawn || selected.some(s => s.assetId === id && s.version === r.version))
        .map(({ version, digest }) => ({ assetId: id, version, digest, type, name })))); },
    cause => { if (active) setError(String(cause.message ?? cause)); });
    return () => { active = false; };
  }, [open, load]);
  return <details onToggle={e => setOpen(e.currentTarget.open)}>
    <summary>{t('个人专家资料（可选）')}{selected.length > 0 && <small>{selected.length}</small>}</summary>
    <p class="field-note">{t('Lead 可按题选用资料中的专业知识。模型和人数沿用本次设置。')}</p>
    {items?.length ? <div class="profile-options"><fieldset disabled={busy}>
      <legend>{t('Library 中的 Agent 与 Skill 版本')}</legend>
      {items.map(choice => <label key={`${choice.assetId}@${choice.version}`}><input type="checkbox"
        checked={selected.some(s => s.assetId === choice.assetId && s.version === choice.version)}
        onChange={async () => { if (busy) return; setBusy(true); setError('');
          try { await choose(choice); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
          finally { setBusy(false); } }} />{choice.name} <small>{choice.type} · {choice.version}</small></label>)}
    </fieldset></div> : !error && open && <p class="field-note" role="status">{items ? t('没有可选择的已发布资料。') : t('正在读取角色目录…')}</p>}
    {error && <p class="field-error" role="alert">{error}</p>}
    <a href="library.html?type=skill">{t('查看 Library')}</a>
  </details>;
}

export function renderPersonalExpertPicker(host: HTMLElement, props: ExpertProps) {
  render(<PersonalExperts key={props.owner} {...props} />, host);
}

function TeamProfilePicker({ value, change, load }: Props) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState('');
  const [profiles, setProfiles] = useState<WebTeamProfile[]>(), [error, setError] = useState('');
  useEffect(() => {
    if (!open || profiles) return;
    let active = true;
    setError('');
    load().then(rows => { if (active) setProfiles(rows); }, reason => { if (active) setError(String(reason.message ?? reason)); });
    return () => { active = false; };
  }, [open, profiles, load]);
  const name = (p: WebTeamProfile) => locale === 'zh' ? p.nameZh ?? p.name : p.name;
  const filter = query.trim().toLowerCase();
  const rows = (profiles ?? []).filter(p => [p.id, p.name, p.nameZh, p.alias].some(s => s?.toLowerCase().includes(filter)));
  const toggle = (id: string) => change(value.includes(id) ? value.filter(x => x !== id) : [...value, id].sort());
  const unknown = value.filter(id => !profiles?.some(row => row.id === id));
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{t('角色偏好（可选）')}{value.length > 0 && <small>{value.map(id => {
      const profile = profiles?.find(row => row.id === id); return profile ? name(profile) : id;
    }).join(' · ')}</small>}</summary>
    <p class="field-note">{t('可同时选择工作角色和领域专家。Lead 根据题目决定实际分工。')}</p>
    <label for="native-team-profile-search">{t('搜索名称或编号')}</label>
    <input type="search" id="native-team-profile-search" value={query} onInput={event => setQuery(event.currentTarget.value)}
      onKeyDown={event => { if (event.key === 'Enter') event.preventDefault(); }} autoComplete="off" />
    <div class="profile-options">
      {unknown.length > 0 && <fieldset><legend>{t('已选角色')}</legend>{unknown.map(id => <label key={id}>
        <input type="checkbox" checked value={id} onChange={() => toggle(id)} />{id}</label>)}</fieldset>}
      {(['work', 'domain'] as const).map(kind => {
        const group = rows.filter(row => row.kind === kind);
        return group.length > 0 && <fieldset key={kind}><legend>{kind === 'work' ? t('工作角色') : t('领域专家')}</legend>
          {group.map(p => <label key={p.id}><input type="checkbox" value={p.id} checked={value.includes(p.id)}
            onChange={() => toggle(p.id)} />{name(p)} <small>{p.id}</small></label>)}</fieldset>;
      })}
    </div>
    {(!profiles || !rows.length) && <p class="field-note" role="status">{error || (profiles ? t('没有匹配的角色') : t('正在读取角色目录…'))}</p>}
  </details>;
}

export function renderTeamProfilePicker(host: HTMLElement, props: Props) { render(<TeamProfilePicker {...props} />, host); }
