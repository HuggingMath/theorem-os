import type { FrozenResearchConfiguration, ResearchAssetRelease, ResearchConfigurationSelection, ResearchReleaseRef } from '../researchAssetTypes';
import type { WebEnvironment } from '../shared';
import { researchEnvironmentStorageKey, researchSelectionStorageKey, type OwnedDrafts } from './ownedDrafts';
import { localizeMessage, t } from '../i18n';

type Api = <T>(url: string, init?: RequestInit) => Promise<T>;
const validRef = (value: unknown): value is ResearchReleaseRef => Boolean(value && typeof value === 'object'
  && 'assetId' in value && typeof value.assetId === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value.assetId)
  && 'version' in value && typeof value.version === 'string' && /^[A-Za-z0-9._-]{1,64}$/u.test(value.version));

/** A Library choice stays explicit in the composer and reaches the server as fixed references. */
export class ResearchSelection {
  private refs: ResearchReleaseRef[] = [];
  private releases: ResearchAssetRelease[] = [];
  private panel = document.createElement('aside');
  private loaded = false;
  constructor(private api: Api, private changed: () => void, private drafts: OwnedDrafts) {
    this.panel.className = 'composer-research-selection'; this.panel.hidden = true;
    this.panel.setAttribute('aria-label', t('Library 研究配置'));
    document.getElementById('run-form')!.prepend(this.panel);
  }
  async load(apply: (configuration: FrozenResearchConfiguration, imports: string[]) => void, environment: WebEnvironment, onSelected?: () => void) {
    if (this.loaded) return;
    this.loaded = true;
    let savedEnvironment: WebEnvironment | undefined;
    try {
      const stored: unknown = JSON.parse(this.drafts.getItem(researchSelectionStorageKey) ?? '[]');
      if (Array.isArray(stored)) this.refs = stored.filter(validRef).slice(0, 32);
      const saved = this.drafts.getItem(researchEnvironmentStorageKey);
      if (saved === 'standard' || saved === 'mathlib') savedEnvironment = saved;
    } catch { /* No saved selection. */ }
    const search = new URLSearchParams(location.search), assetId = search.get('researchAsset'), version = search.get('researchVersion');
    const linked = { assetId, version };
    if (validRef(linked) && !this.refs.some(ref => ref.assetId === linked.assetId && ref.version === linked.version)) this.refs.push(linked);
    if (!this.refs.length) return;
    onSelected?.();
    this.panel.hidden = false; this.panel.textContent = t('正在读取选定的 Library 版本…');
    try {
      this.releases = await Promise.all(this.refs.map(async ref => (await this.api<{ item: ResearchAssetRelease }>(
        `/api/research/library/${encodeURIComponent(ref.assetId)}/releases/${encodeURIComponent(ref.version)}`)).item));
      if (this.releases.filter(release => release.type === 'agent').length > 1) throw new Error(t('每次研究只能选择一个 Agent，请在 Library 调整选择。'));
      const agent = this.releases.find(release => release.type === 'agent')?.content as { environment?: WebEnvironment } | undefined;
      const selectedEnvironment = savedEnvironment ?? this.releases.find(release => release.mathematics)?.mathematics?.environment ?? agent?.environment ?? environment;
      const { item } = await this.api<{ item: FrozenResearchConfiguration }>('/api/research/configuration', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ environment: selectedEnvironment, selection: this.value() }) });
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
  reset() { this.loaded = false; this.refs = []; this.releases = []; this.panel.hidden = true; this.panel.replaceChildren(); }
  clear() {
    this.reset();
    try { this.drafts.removeItem(researchSelectionStorageKey); this.drafts.removeItem(researchEnvironmentStorageKey); } catch { /* Current page state is sufficient. */ }
    const url = new URL(location.href); url.searchParams.delete('researchAsset'); url.searchParams.delete('researchVersion'); history.replaceState(null, '', url);
    this.changed();
  }
  private render() {
    this.panel.replaceChildren(); const title = document.createElement('strong'); title.textContent = t('本次研究使用的 Library 版本');
    const list = document.createElement('p'); list.textContent = this.releases.length ? this.releases.map(release => `${release.name} · ${release.version}`).join('；') : this.refs.map(ref => `${ref.assetId} · ${ref.version}`).join('；');
    const link = document.createElement('a'); link.href = 'library.html'; link.textContent = t('查看 Library');
    const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'text-button'; clear.textContent = t('清除选择'); clear.addEventListener('click', () => this.clear());
    this.panel.append(title, list, link, clear);
  }
}
