import type { ResearchModulePlan } from '../../../src/solver/modules/policy';
import { createElement, errorText, type WebApi } from './collaborationUi';
import type { KnowledgeCatalog } from './knowledgeView';
import { renderSection } from './ui/Section';
import { localizeText, t } from '../i18n';

type SavedPlan = { id: string; name: string; plan: ResearchModulePlan; updatedAt: string; configuration: { methodDigest?: string } };
type Registry = { entries: Array<{ id: string; slot: string; name: string; version: string; fixed: boolean; inputs: string[]; outputs: string[] }> };

/** Server plans and registered code selections apply to the next run. */
export class ServerModulePlans {
  private root = createElement('div', 'server-module-plans');
  private plans: SavedPlan[] = [];
  private selected = '';
  private name = '';
  private loading = false;
  private pendingDelete?: SavedPlan;
  private notice = '';
  private registry?: Registry;
  private digest = '';
  private catalogs?: KnowledgeCatalog[];
  constructor(host: HTMLElement, private api: WebApi, private getPlan: () => ResearchModulePlan, private setPlan: (plan: ResearchModulePlan) => void, private changed: () => void) {
    const heading = host.querySelector('.module-plan-heading');
    if (heading) heading.after(this.root); else host.prepend(this.root);
    this.render();
  }
  knowledgeDigest() { return this.digest || undefined; }
  setKnowledgeDigest(digest?: string) {
    this.digest = digest ?? ''; this.render();
  }
  async refresh() {
    if (this.loading) return; this.pendingDelete = undefined; this.loading = true; this.render();
    try {
      const results = await Promise.allSettled([
        this.api<{ plans: SavedPlan[] }>('/api/module-plans'), this.api<Registry>('/api/modules'), this.api<{ catalogs: KnowledgeCatalog[] }>('/api/knowledge/catalogs'),
      ]);
      const [plans, registry, catalogs] = results;
      if (plans.status === 'fulfilled') this.setPlans(plans.value.plans); else throw plans.reason;
      if (registry.status === 'fulfilled') this.registry = registry.value; else this.notice = errorText(registry.reason);
      if (catalogs.status === 'fulfilled') this.catalogs = catalogs.value.catalogs; else this.notice = errorText(catalogs.reason);
      if (results.every(result => result.status === 'fulfilled')) this.notice = t('方案列表已刷新');
    } catch (error) { this.notice = errorText(error); }
    finally { this.loading = false; this.render(); }
  }
  private setPlans(plans: SavedPlan[]) {
    this.plans = plans;
    if (!plans.some(plan => plan.id === this.selected)) this.selected = '';
  }
  private focus(selector: string) { this.root.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true }); }
  private readonly choose = (id: string) => {
    this.selected = id; this.pendingDelete = undefined;
    const selected = this.plans.find(plan => plan.id === id);
    if (selected) this.name = selected.name;
    this.render();
  };
  private readonly load = () => {
    const plan = this.plans.find(plan => plan.id === this.selected); if (!plan) return;
    this.setPlan(plan.plan); this.notice = t('已载入 {0}，用于下一次运行', plan.name); this.render(); this.changed();
  };
  private readonly askDelete = () => {
    if (this.loading) return;
    this.pendingDelete = this.plans.find(plan => plan.id === this.selected);
    if (!this.pendingDelete) return;
    this.render(); this.focus('[data-server-plan-delete-cancel]');
  };
  private readonly cancelDelete = () => { this.pendingDelete = undefined; this.render(); this.focus('[data-server-plan-delete]'); };
  private readonly chooseCatalog = (digest: string) => { this.digest = digest; this.render(); this.changed(); };
  private async remove() {
    const selected = this.pendingDelete;
    if (this.loading || !selected) return;
    this.loading = true; this.render();
    const confirmed = () => {
      this.setPlans(this.plans.filter(plan => plan.id !== selected.id)); this.selected = '';
      this.notice = t('已删除「{0}」；当前模块草稿已保留', selected.name);
    };
    try {
      await this.api(`/api/module-plans/${encodeURIComponent(selected.id)}?updatedAt=${encodeURIComponent(selected.updatedAt)}`, { method: 'DELETE' });
      confirmed();
    } catch (error) {
      // A lost response can still mean deletion succeeded. Read before another explicit attempt.
      try {
        const { plans } = await this.api<{ plans: SavedPlan[] }>('/api/module-plans');
        this.setPlans(plans);
        if (!plans.some(plan => plan.id === selected.id)) confirmed();
        else this.notice = t('{0}；方案仍在服务器，已刷新列表，请核对后重新操作。当前模块草稿已保留', errorText(error));
      } catch {
        this.notice = t('{0}；暂时无法确认删除结果，请刷新方案列表核对。当前模块草稿已保留', errorText(error));
      }
    } finally {
      this.pendingDelete = undefined; this.loading = false; this.render();
      this.focus('[data-server-plan-select]');
    }
  }
  private async save(copy: boolean) {
    if (this.loading) return;
    const name = this.name.trim();
    if (!name) { this.notice = t('请填写方案名称'); this.render(); return; }
    const existing = copy ? undefined : this.plans.find(plan => plan.id === this.selected);
    this.pendingDelete = undefined; this.loading = true; this.render();
    try {
      const { plan } = await this.api<{ plan: SavedPlan }>('/api/module-plans', { method: 'POST', body: JSON.stringify({ name, plan: this.getPlan(), ...(existing ? { id: existing.id, baseUpdatedAt: existing.updatedAt } : {}) }) });
      this.setPlans([plan, ...this.plans.filter(item => item.id !== plan.id)]); this.selected = plan.id;
      this.notice = t('已保存 {0} · {1}', plan.name, plan.updatedAt);
    } catch (error) { this.notice = t('{0}；当前模块草稿已保留', errorText(error)); }
    finally { this.loading = false; this.render(); }
  }
  private catalogOptions() {
    const options = (this.catalogs ?? []).map(catalog => <option key={catalog.digest} value={catalog.digest}>{t('{0} · {1} 定理', catalog.digest.slice(0, 16), catalog.entries)}</option>);
    if (this.digest && !this.catalogs?.some(catalog => catalog.digest === this.digest)) options.push(<option key={this.digest} value={this.digest}>{t('{0} · 待核对目录', this.digest)}</option>);
    return options;
  }
  private render() {
    const busy = this.loading, chosen = this.plans.some(plan => plan.id === this.selected);
    this.root.setAttribute('aria-busy', String(busy));
    const registry = this.registry;
    renderSection(this.root, <>
      <details class="collab-detail" data-server-module-library><summary>{t('服务器方案与已注册实现')}</summary><div class="server-plan-content">
        <p class="collab-help">{t('方案保存到服务器。搜索策略和上下文策略选用下方已注册的实现；自定义内容作为模块建议。配置在新运行中固定。')}</p>
        <div class="server-plan-selection">
          <label>{t('已保存方案')}<select data-server-plan-select disabled={busy} value={this.selected} onChange={event => this.choose(event.currentTarget.value)}>
            <option value="">{t('新建方案')}</option>{this.plans.map(plan => <option key={plan.id} value={plan.id}>{plan.name}</option>)}
          </select></label>
          <button type="button" class="button" data-server-plan-refresh disabled={busy} onClick={() => void this.refresh()}>{t('刷新')}</button>
          <button type="button" class="button" data-server-plan-load disabled={busy || !chosen} onClick={this.load}>{t('载入')}</button>
        </div>
        <label>{t('方案名称')}<input data-server-plan-name maxLength={40} placeholder={t('为当前模块组合命名')} disabled={busy} value={this.name} onInput={event => { this.name = event.currentTarget.value; }} /></label>
        <div class="server-plan-actions">
          <button type="button" class="button" data-server-plan-save disabled={busy} onClick={() => void this.save(false)}>{t('保存到服务器')}</button>
          <button type="button" class="button" data-server-plan-copy disabled={busy} onClick={() => void this.save(true)}>{t('另存为新方案')}</button>
          <button type="button" class="button button-danger" data-server-plan-delete disabled={busy || !chosen} onClick={this.askDelete}>{t('删除方案')}</button>
        </div>
        <div class="server-plan-deletion collab-notice" data-server-plan-deletion hidden={!this.pendingDelete}>
          <p data-server-plan-delete-description>{this.pendingDelete && t('删除「{0}」？当前模块草稿会保留。', this.pendingDelete.name)}</p>
          <div class="server-plan-actions">
            <button type="button" class="button" data-server-plan-delete-cancel disabled={busy} onClick={this.cancelDelete}>{t('保留方案')}</button>
            <button type="button" class="button button-danger" data-server-plan-delete-confirm disabled={busy} onClick={() => void this.remove()}>{t('确认删除')}</button>
          </div>
        </div>
        <p data-server-plan-notice class="collab-help" role="status">{this.notice}</p>
        <div data-module-registry>{registry && <details class="collab-detail"><summary>{t('已注册代码实现 · {0}', registry.entries.length)}</summary>
          {registry.entries.map(entry => <div key={`${entry.id}@${entry.version}`} class="collab-registry-entry"><strong>{entry.slot} · {localizeText(entry.name)}{entry.fixed ? t(' · 固定') : ''}</strong>
            <code>{entry.id} @ {entry.version}</code><small>{t('输入 {0} → 输出 {1}', entry.inputs.join(', '), entry.outputs.join(', '))}</small></div>)}
        </details>}</div>
      </div></details>
      <label class="collab-catalog-label" for="knowledge-catalog">{t('新运行的知识目录')}<select id="knowledge-catalog" value={this.digest} onChange={event => this.chooseCatalog(event.currentTarget.value)}>
        <option value="">{t('不使用历史知识')}</option>{this.catalogOptions()}
      </select></label>
      <p class="collab-help">{t('选中的目录随运行身份保存，历史证据需要重新检查。')}</p>
    </>);
  }
}
