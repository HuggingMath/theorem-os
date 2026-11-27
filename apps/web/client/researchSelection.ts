import type { FrozenResearchConfiguration, ResearchAssetRelease, ResearchConfigurationSelection, ResearchReleaseRef } from '../researchAssetTypes';
import type { WebEnvironment } from '../shared';
import { researchEnvironmentStorageKey, researchSelectionStorageKey, type OwnedDrafts } from './ownedDrafts';
import { localizeMessage, t } from '../i18n';
import { takeLibraryEntry } from './libraryEntry';

type Api = <T>(url: string, init?: RequestInit) => Promise<T>;
type PreparedSelection = { refs: ResearchReleaseRef[]; releases: ResearchAssetRelease[]; configuration: FrozenResearchConfiguration; imports: string[] };
const validRef = (value: unknown): value is ResearchReleaseRef => Boolean(value && typeof value === 'object'
  && 'assetId' in value && typeof value.assetId === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value.assetId)
  && 'version' in value && typeof value.version === 'string' && /^[A-Za-z0-9._-]{1,64}$/u.test(value.version));

export function configurationRefs(config?: FrozenResearchConfiguration): ResearchReleaseRef[] {
  if (!config) return [];
  const chosen = config.personalExpertSelection;
  return chosen ? [...(chosen.agent ? [chosen.agent] : []), ...(chosen.skills ?? []), ...(chosen.libraries ?? [])]
    : [config.agent?.ref, ...config.skills.map(s => s.ref), ...config.libraries.map(l => l.ref)].filter(r => r !== undefined);
}

/** A Library choice stays explicit in the composer and reaches the server as fixed references. */
export class ResearchSelection {
  private refs: ResearchReleaseRef[] = [];
  private releases: ResearchAssetRelease[] = [];
  private selectedEnvironment?: WebEnvironment;
  private panel = document.createElement('aside');
  private loaded = false;
  // The workbench normalizes its address while loading runs, before it prepares Library choices.
  private entrySearch = location.search;
  constructor(private api: Api, private changed: () => void, private drafts: OwnedDrafts) {
    this.panel.className = 'composer-research-selection'; this.panel.hidden = true;
    this.panel.setAttribute('aria-label', t('Library 研究配置'));
    document.getElementById('run-form')!.prepend(this.panel);
  }
  /** Validate a proposal before replacing the current draft or its Library choices. */
  async prepare(refs: ResearchReleaseRef[], environment: WebEnvironment, nativeTeam = false): Promise<PreparedSelection> {
    if (!refs.length || refs.length > 32 || refs.some(ref => !validRef(ref))) throw new Error(t('所选 Library 版本不可用，请重新选择。'));
    const releases = await Promise.all(refs.map(async ref => {
      const release = (await this.api<{ item: ResearchAssetRelease }>(`/api/research/library/${encodeURIComponent(ref.assetId)}/releases/${encodeURIComponent(ref.version)}`)).item;
      if (ref.digest && ref.digest !== release.digest) throw new Error(t('所选 Library 版本不可用，请重新选择。'));
      return release;
    }));
    if (releases.filter(release => release.type === 'agent').length > 1) throw new Error(t('每次研究只能选择一个 Agent，请在 Library 调整选择。'));
    const fixed = releases.map(release => ({ assetId: release.assetId, version: release.version, digest: release.digest }));
    const selection: ResearchConfigurationSelection = {
      agent: fixed.find((_, index) => releases[index].type === 'agent'),
      skills: fixed.filter((_, index) => releases[index].type === 'skill'),
      libraries: fixed.filter((_, index) => releases[index].type === 'mathematics'),
    };
    const { item: configuration } = await this.api<{ item: FrozenResearchConfiguration }>('/api/research/configuration', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ environment, selection, ...(nativeTeam ? { nativeTeam: true } : {}) }) });
    return { refs: fixed, releases, configuration, imports: configuration.libraries.flatMap(library => library.mathematics.pack.modules.map(module => module.file.slice(0, -5).replaceAll('/', '.'))) };
  }
  adopt(prepared: PreparedSelection) {
    this.refs = prepared.refs; this.releases = prepared.releases; this.loaded = true;
    this.selectedEnvironment = prepared.configuration.environment;
    try { this.drafts.setItem(researchSelectionStorageKey, JSON.stringify(this.refs)); this.drafts.setItem(researchEnvironmentStorageKey, prepared.configuration.environment); }
    catch { /* The explicit selection remains available in this page without browser storage. */ }
    this.panel.hidden = false; this.render(); this.changed();
  }
  async load(apply: (configuration: FrozenResearchConfiguration, imports: string[]) => void, environment: WebEnvironment, onSelected?: () => void, nativeTeam = false) {
    if (this.loaded) return;
    this.loaded = true;
    const entrySearch = this.entrySearch; this.entrySearch = '';
    let savedEnvironment: WebEnvironment | undefined;
    try {
      const stored: unknown = JSON.parse(this.drafts.getItem(researchSelectionStorageKey) ?? '[]');
      if (Array.isArray(stored)) this.refs = stored.filter(validRef).slice(0, 32);
      const saved = this.drafts.getItem(researchEnvironmentStorageKey);
      if (saved === 'standard' || saved === 'mathlib') savedEnvironment = saved;
    } catch { /* No saved selection. */ }
    try {
      const pending = takeLibraryEntry(entrySearch);
      if (pending) {
        this.refs = pending.refs; savedEnvironment = pending.environment;
        this.drafts.setItem(researchSelectionStorageKey, JSON.stringify(this.refs));
        if (savedEnvironment) this.drafts.setItem(researchEnvironmentStorageKey, savedEnvironment);
        else this.drafts.removeItem(researchEnvironmentStorageKey);
        const address = new URL(location.href); address.searchParams.delete('libraryReturn'); history.replaceState(null, '', address);
      }
    } catch { /* The explicit single-version URL remains available when tab storage is blocked. */ }
    const search = new URLSearchParams(entrySearch), assetId = search.get('researchAsset'), version = search.get('researchVersion');
    const linked = { assetId, version };
    if (validRef(linked) && !this.refs.some(ref => ref.assetId === linked.assetId && ref.version === linked.version)) this.refs.push(linked);
    if (!this.refs.length) return;
    onSelected?.();
    this.panel.hidden = false; this.panel.textContent = t('正在读取选定的 Library 版本…');
    try {
      this.releases = await Promise.all(this.refs.map(async ref => {
        const release = (await this.api<{ item: ResearchAssetRelease }>(
          `/api/research/library/${encodeURIComponent(ref.assetId)}/releases/${encodeURIComponent(ref.version)}`)).item;
        if (ref.digest && ref.digest !== release.digest) throw new Error(t('所选 Library 版本不可用，请重新选择。'));
        return release;
      }));
      if (this.releases.filter(release => release.type === 'agent').length > 1) throw new Error(t('每次研究只能选择一个 Agent，请在 Library 调整选择。'));
      const agent = this.releases.find(release => release.type === 'agent')?.content as { environment?: WebEnvironment } | undefined;
      const libraryEnvironment = this.releases.find(release => release.mathematics)?.mathematics?.environment;
      const selectedEnvironment = savedEnvironment ?? libraryEnvironment ?? (nativeTeam ? undefined : agent?.environment) ?? environment;
      const { item } = await this.api<{ item: FrozenResearchConfiguration }>('/api/research/configuration', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ environment: selectedEnvironment, selection: this.value(), ...(nativeTeam ? { nativeTeam: true } : {}) }) });
      this.selectedEnvironment = item.environment;
      apply(item, item.libraries.flatMap(library => library.mathematics.pack.modules.map(module => module.file.slice(0, -5).replaceAll('/', '.'))));
      this.render(); this.changed();
    } catch (error) {
      this.render(); const message = document.createElement('p'); message.className = 'field-error'; message.setAttribute('role', 'alert');
      message.textContent = error instanceof Error ? localizeMessage(error.message) : t('所选 Library 版本不可用，请重新选择。'); this.panel.append(message);
    }
  }
  value(): ResearchConfigurationSelection | undefined {
    if (!this.refs.length) return undefined;
    const references = this.releases.map(release => ({ assetId: release.assetId, version: release.version, digest: release.digest }));
    // Invalid or unavailable refs remain part of the request, so the server rejects them without silently dropping a choice.
    if (references.length !== this.refs.length) return { skills: this.refs };
    return { agent: references.find((_, index) => this.releases[index].type === 'agent'),
      skills: references.filter((_, index) => this.releases[index].type === 'skill'),
      libraries: references.filter((_, index) => this.releases[index].type === 'mathematics') };
  }
  environment(): WebEnvironment | undefined { return this.selectedEnvironment; }
  reset() { this.loaded = false; this.refs = []; this.releases = []; this.selectedEnvironment = undefined; this.panel.hidden = true; this.panel.replaceChildren(); }
  clear() {
    this.reset();
    try { this.drafts.removeItem(researchSelectionStorageKey); this.drafts.removeItem(researchEnvironmentStorageKey); } catch { /* Current page state is sufficient. */ }
    const url = new URL(location.href); url.searchParams.delete('researchAsset'); url.searchParams.delete('researchVersion'); history.replaceState(null, '', url);
    this.changed();
  }
  private render() {
    this.panel.replaceChildren(); const title = document.createElement('strong'); title.textContent = t('本次研究使用的 Library 版本');
    const list = document.createElement('p'); list.textContent = (this.releases.length ? this.releases.map(release => `${release.name} · ${release.version}`) : this.refs.map(ref => `${ref.assetId} · ${ref.version}`)).join(t('；'));
    const link = document.createElement('a'); link.href = 'library.html'; link.textContent = t('查看 Library');
    const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'text-button'; clear.textContent = t('清除选择'); clear.addEventListener('click', () => this.clear());
    this.panel.append(title, list, link, clear);
  }
}
