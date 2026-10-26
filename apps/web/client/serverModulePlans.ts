import type { ResearchModulePlan } from '../../../src/solver/modules/policy';
import { createElement, errorText, escapeHtml as h, patchSection, type WebApi } from './collaborationUi';
import type { KnowledgeCatalog } from './knowledgeView';
import { t } from '../i18n';

type SavedPlan = { id: string; name: string; plan: ResearchModulePlan; updatedAt: string; configuration: { methodDigest?: string } };
type Registry = { entries: Array<{ id: string; slot: string; name: string; version: string; fixed: boolean; inputs: string[]; outputs: string[] }> };

/** Server plans and registered code selections apply to the next run. */
export class ServerModulePlans {
  private root = createElement('div', 'server-module-plans');
  private plans: SavedPlan[] = [];
  private selected = '';
  private loading = false;
  private pendingDelete?: SavedPlan;
  private notice: HTMLElement;
  private digest = '';
  private catalogs?: KnowledgeCatalog[];
  constructor(host: HTMLElement, private api: WebApi, private getPlan: () => ResearchModulePlan, private setPlan: (plan: ResearchModulePlan) => void, private changed: () => void) {
    this.root.innerHTML = `<details class="collab-detail" data-server-module-library><summary>${t('服务器方案与已注册实现')}</summary><div class="server-plan-content"><p class="collab-help">${t('方案保存到服务器。M3 / M4 选择下方已注册实现；自定义内容作为模块建议。配置在新运行中固定。')}</p>
      <div class="server-plan-selection"><label>${t('已保存方案')}<select data-server-plan-select><option value="">${t('新建方案')}</option></select></label><button type="button" class="button" data-server-plan-refresh>${t('刷新')}</button><button type="button" class="button" data-server-plan-load disabled>${t('载入')}</button></div><label>${t('方案名称')}<input data-server-plan-name maxlength="40" placeholder="${t('为当前模块组合命名')}"></label><div class="server-plan-actions"><button type="button" class="button" data-server-plan-save>${t('保存到服务器')}</button><button type="button" class="button" data-server-plan-copy>${t('另存为新方案')}</button><button type="button" class="button button-danger" data-server-plan-delete disabled>${t('删除方案')}</button></div><div class="server-plan-deletion collab-notice" data-server-plan-deletion hidden><p data-server-plan-delete-description></p><div class="server-plan-actions"><button type="button" class="button" data-server-plan-delete-cancel>${t('保留方案')}</button><button type="button" class="button button-danger" data-server-plan-delete-confirm>${t('确认删除')}</button></div></div><p data-server-plan-notice class="collab-help" role="status"></p><div data-module-registry></div></div></details>
      <label class="collab-catalog-label" for="knowledge-catalog">${t('新运行的知识目录')}<select id="knowledge-catalog"><option value="">${t('不使用历史知识')}</option></select></label><p class="collab-help">${t('选中的目录随运行身份保存，历史证据需要重新检查。')}</p>`;
    const heading = host.querySelector('.module-plan-heading');
    if (heading) heading.after(this.root); else host.prepend(this.root);
    this.notice = this.root.querySelector('[data-server-plan-notice]')!;
    this.root.querySelector('[data-server-plan-refresh]')!.addEventListener('click', () => void this.refresh());
    this.root.querySelector('[data-server-plan-select]')!.addEventListener('change', event => {
      this.selected = (event.target as HTMLSelectElement).value;
      this.closeDeletion();
      const selected = this.plans.find(plan => plan.id === this.selected);
      if (selected) this.root.querySelector<HTMLInputElement>('[data-server-plan-name]')!.value = selected.name;
      this.syncControls();
    });
    this.root.querySelector('[data-server-plan-load]')!.addEventListener('click', () => {
      const plan = this.plans.find(plan => plan.id === this.selected); if (!plan) return;
      this.setPlan(plan.plan); this.notice.textContent = t('已载入 {0}，用于下一次运行', plan.name); this.changed();
    });
    this.root.querySelector('[data-server-plan-save]')!.addEventListener('click', () => void this.save(false));
    this.root.querySelector('[data-server-plan-copy]')!.addEventListener('click', () => void this.save(true));
    this.root.querySelector('[data-server-plan-delete]')!.addEventListener('click', () => {
      if (this.loading) return;
      this.pendingDelete = this.plans.find(plan => plan.id === this.selected);
      if (!this.pendingDelete) return;
      this.root.querySelector('[data-server-plan-delete-description]')!.textContent = t('删除「{0}」？当前模块草稿会保留。', this.pendingDelete.name);
      this.root.querySelector<HTMLElement>('[data-server-plan-deletion]')!.hidden = false;
      this.root.querySelector<HTMLButtonElement>('[data-server-plan-delete-cancel]')!.focus();
    });
    this.root.querySelector('[data-server-plan-delete-cancel]')!.addEventListener('click', () => {
      this.closeDeletion(); this.root.querySelector<HTMLButtonElement>('[data-server-plan-delete]')!.focus();
    });
    this.root.querySelector('[data-server-plan-delete-confirm]')!.addEventListener('click', () => void this.remove());
    this.root.querySelector('#knowledge-catalog')!.addEventListener('change', event => { this.digest = (event.target as HTMLSelectElement).value; this.changed(); });
  }
  knowledgeDigest() { return this.digest || undefined; }
  setKnowledgeDigest(digest?: string) {
    this.digest = digest ?? ''; this.renderCatalogs();
  }
  private renderCatalogs() {
    const select = this.root.querySelector<HTMLSelectElement>('#knowledge-catalog')!;
    select.innerHTML = `<option value="">${t('不使用历史知识')}</option>` + (this.catalogs ?? []).map(catalog => `<option value="${h(catalog.digest)}">${t('{0} · {1} 定理', h(catalog.digest.slice(0, 16)), catalog.entries)}</option>`).join('');
    if (this.digest && ![...select.options].some(option => option.value === this.digest)) select.add(new Option(t('{0} · 待核对目录', this.digest), this.digest));
    select.value = this.digest;
  }
  async refresh() {
    if (this.loading) return; this.closeDeletion(); this.loading = true; this.syncControls();
    try {
      const results = await Promise.allSettled([
        this.api<{ plans: SavedPlan[] }>('/api/module-plans'), this.api<Registry>('/api/modules'), this.api<{ catalogs: KnowledgeCatalog[] }>('/api/knowledge/catalogs'),
      ]);
      const [plans, registry, catalogs] = results;
      if (plans.status === 'fulfilled') { this.plans = plans.value.plans; this.renderPlans(); } else throw plans.reason;
      if (registry.status === 'fulfilled') patchSection(this.root.querySelector('[data-module-registry]')!, `<details class="collab-detail"><summary>${t('已注册代码实现 · {0}', registry.value.entries.length)}</summary>${registry.value.entries.map(entry => `<div class="collab-registry-entry"><strong>${h(entry.slot)} · ${h(entry.name)}${entry.fixed ? t(' · 固定') : ''}</strong><code>${h(entry.id)} @ ${h(entry.version)}</code><small>${t('输入 {0} → 输出 {1}', h(entry.inputs.join(', ')), h(entry.outputs.join(', ')))}</small></div>`).join('')}</details>`); else this.notice.textContent = errorText(registry.reason);
      if (catalogs.status === 'fulfilled') { this.catalogs = catalogs.value.catalogs; this.renderCatalogs(); } else this.notice.textContent = errorText(catalogs.reason);
      if (results.every(result => result.status === 'fulfilled')) this.notice.textContent = t('方案列表已刷新');
    } catch (error) { this.notice.textContent = errorText(error); }
    finally { this.loading = false; this.syncControls(); }
  }
  private renderPlans() {
    if (!this.plans.some(plan => plan.id === this.selected)) this.selected = '';
    const select = this.root.querySelector<HTMLSelectElement>('[data-server-plan-select]')!;
    select.innerHTML = `<option value="">${t('新建方案')}</option>` + this.plans.map(plan => `<option value="${h(plan.id)}">${h(plan.name)}</option>`).join(''); select.value = this.selected;
    this.syncControls();
  }
  private syncControls() {
    for (const control of this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('[data-server-plan-select],[data-server-plan-name],[data-server-plan-refresh],[data-server-plan-save],[data-server-plan-copy],[data-server-plan-delete-cancel],[data-server-plan-delete-confirm]')) control.disabled = this.loading;
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-server-plan-load],[data-server-plan-delete]')) button.disabled = this.loading || !this.plans.some(plan => plan.id === this.selected);
    this.root.setAttribute('aria-busy', String(this.loading));
  }
  private closeDeletion() {
    this.pendingDelete = undefined;
    this.root.querySelector<HTMLElement>('[data-server-plan-deletion]')!.hidden = true;
  }
  private async remove() {
    const selected = this.pendingDelete;
    if (this.loading || !selected) return;
    this.loading = true; this.syncControls();
    const confirmed = () => {
      this.plans = this.plans.filter(plan => plan.id !== selected.id);
      this.selected = ''; this.renderPlans();
      this.notice.textContent = t('已删除「{0}」；当前模块草稿已保留', selected.name);
    };
    try {
      await this.api(`/api/module-plans/${encodeURIComponent(selected.id)}?updatedAt=${encodeURIComponent(selected.updatedAt)}`, { method: 'DELETE' });
      confirmed();
    } catch (error) {
      // A lost response can still mean deletion succeeded. Read before another explicit attempt.
      try {
        const { plans } = await this.api<{ plans: SavedPlan[] }>('/api/module-plans');
        this.plans = plans; this.renderPlans();
        if (!plans.some(plan => plan.id === selected.id)) confirmed();
        else this.notice.textContent = t('{0}；方案仍在服务器，已刷新列表，请核对后重新操作。当前模块草稿已保留', errorText(error));
      } catch {
        this.notice.textContent = t('{0}；暂时无法确认删除结果，请刷新方案列表核对。当前模块草稿已保留', errorText(error));
      }
    } finally {
      this.closeDeletion(); this.loading = false; this.syncControls();
      this.root.querySelector<HTMLSelectElement>('[data-server-plan-select]')!.focus({ preventScroll: true });
    }
  }
  private async save(copy: boolean) {
    if (this.loading) return;
    const name = this.root.querySelector<HTMLInputElement>('[data-server-plan-name]')!.value.trim();
    if (!name) { this.notice.textContent = t('请填写方案名称'); return; }
    const existing = copy ? undefined : this.plans.find(plan => plan.id === this.selected);
    this.closeDeletion(); this.loading = true; this.syncControls();
    try {
      const { plan } = await this.api<{ plan: SavedPlan }>('/api/module-plans', { method: 'POST', body: JSON.stringify({ name, plan: this.getPlan(), ...(existing ? { id: existing.id, baseUpdatedAt: existing.updatedAt } : {}) }) });
      this.plans = [plan, ...this.plans.filter(item => item.id !== plan.id)]; this.selected = plan.id; this.renderPlans();
      this.notice.textContent = t('已保存 {0} · {1}', plan.name, plan.updatedAt);
    } catch (error) { this.notice.textContent = t('{0}；当前模块草稿已保留', errorText(error)); }
    finally { this.loading = false; this.syncControls(); }
  }
}
