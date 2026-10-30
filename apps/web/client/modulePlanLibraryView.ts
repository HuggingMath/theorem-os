import type { ResearchModulePlan } from '../../../src/solver/modules/policy';
import { ModulePlanLibrary, modulePlanLibraryLimit, type SavedModulePlan } from './modulePlanLibrary';
import { t } from '../i18n';

const samePlan = (left: ResearchModulePlan, right: ResearchModulePlan) => JSON.stringify(left) === JSON.stringify(right);
type Undo = { type: 'load'; before: ResearchModulePlan; applied: ResearchModulePlan } | { type: 'delete'; saved: SavedModulePlan };

export class ModulePlanLibraryView {
  private entries: SavedModulePlan[] = [];
  private selected?: SavedModulePlan;
  private undo?: Undo;
  private busy = false;
  private selectionRevision = 0;
  private readonly select: HTMLSelectElement;
  private readonly name: HTMLInputElement;
  private readonly save: HTMLButtonElement;
  private readonly copy: HTMLButtonElement;
  private readonly load: HTMLButtonElement;
  private readonly remove: HTMLButtonElement;
  private readonly restore: HTMLButtonElement;

  constructor(private readonly root: HTMLElement, private readonly library: ModulePlanLibrary,
    private readonly current: () => ResearchModulePlan, private readonly apply: (plan: ResearchModulePlan) => void) {
    this.select = this.control('#module-library-select');
    this.name = this.control('#module-library-name');
    this.save = this.control('[data-module-library-save]');
    this.copy = this.control('[data-module-library-copy]');
    this.load = this.control('[data-module-library-load]');
    this.remove = this.control('[data-module-library-delete]');
    this.restore = this.control('[data-module-library-undo]');
    this.select.addEventListener('change', () => {
      if (!this.refresh()) { this.select.value = this.selected?.id ?? ''; return; }
      this.selectionRevision++;
      this.selected = this.entries.find(entry => entry.id === this.select.value);
      this.name.value = this.selected?.name ?? '';
      this.notice(); this.sync();
    });
    this.name.addEventListener('input', () => { this.name.removeAttribute('aria-invalid'); this.notice(); this.sync(); });
    this.name.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault(); if (!this.save.disabled) this.save.click();
    });
    this.save.addEventListener('click', () => this.persist(false));
    this.copy.addEventListener('click', () => this.persist(true));
    this.load.addEventListener('click', () => this.loadSelected());
    this.remove.addEventListener('click', () => void this.perform(async () => {
      if (!this.selected) return;
      const selected = this.selected, revision = this.selectionRevision;
      await this.library.remove(selected);
      if (revision !== this.selectionRevision) { this.refresh(); return; }
      this.undo = { type: 'delete', saved: selected };
      this.selected = undefined; this.name.value = '';
      this.refresh(); this.notice(t('已删除「{0}」', selected.name));
    }, this.select));
    this.restore.addEventListener('click', () => this.undoLast());
    this.refresh();
  }

  refresh(): boolean {
    try {
      this.entries = this.library.list();
      const selection = this.select.value;
      const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = t('新建方案');
      this.select.replaceChildren(placeholder, ...this.entries.map(entry => {
        const option = document.createElement('option'); option.value = entry.id; option.textContent = entry.name; return option;
      }));
      this.select.value = this.entries.some(entry => entry.id === selection) ? selection : '';
      if (this.selected && !this.entries.some(entry => entry.id === this.selected!.id)) this.selected = undefined;
      this.sync(); return true;
    } catch (error) { this.fail(error); return false; }
  }

  sync(): void {
    const plan = this.current();
    if (this.undo?.type === 'load' && !samePlan(plan, this.undo.applied)) this.undo = undefined;
    this.control('[data-module-library-count]').textContent = this.entries.length ? `${this.entries.length} / ${modulePlanLibraryLimit}` : '';
    const selected = this.selected;
    const different = Boolean(selected && !samePlan(plan, selected.plan));
    this.select.disabled = this.busy; this.name.disabled = this.busy;
    this.load.disabled = this.busy || !selected || !different;
    this.remove.disabled = this.busy || !selected;
    this.save.disabled = this.busy || !this.name.value.trim() || Boolean(selected && !different && this.name.value.trim() === selected.name);
    this.control('[data-module-library-save-label]').textContent = selected ? t('更新方案') : t('保存新方案');
    this.copy.disabled = this.busy || !selected || this.entries.length >= modulePlanLibraryLimit;
    this.copy.title = this.entries.length >= modulePlanLibraryLimit ? t('方案库已达 12 项上限') : t('另存为新方案');
    this.copy.setAttribute('aria-label', this.copy.title);
    const summary = this.control('[data-module-library-summary]');
    summary.hidden = !selected;
    summary.textContent = selected ? t('{0} / {1} 项策略启用 · {2}', selected.plan.custom.filter(rule => rule.enabled).length, selected.plan.custom.length, different ? t('与当前配置不同') : t('与当前配置一致')) : '';
    this.restore.hidden = !this.undo;
    this.restore.disabled = this.busy || this.undo?.type === 'delete' && this.entries.length >= modulePlanLibraryLimit;
    this.restore.title = this.undo?.type === 'load' ? t('撤销载入方案') : t('恢复删除的方案');
    this.restore.setAttribute('aria-label', this.restore.title);
  }

  clearUndo(): void { this.selectionRevision++; this.undo = undefined; this.sync(); }

  resetSelection(): void {
    this.selectionRevision++;
    this.selected = undefined; this.undo = undefined;
    this.select.value = ''; this.name.value = '';
    this.notice(); this.sync();
  }

  private persist(copy: boolean) {
    if (this.busy) return;
    let name = this.name.value;
    if (copy && this.selected && name.trim() === this.selected.name) {
      let number = 1;
      do {
        const suffix = number === 1 ? t(' 副本') : t(' 副本 {0}', number);
        let prefix = '';
        for (const character of this.selected.name) {
          if (prefix.length + character.length + suffix.length > 40) break;
          prefix += character;
        }
        name = `${prefix}${suffix}`; number++;
      } while (this.entries.some(entry => entry.name.toLowerCase() === name.toLowerCase()));
    }
    const plan = this.current(), previous = copy ? undefined : this.selected, revision = this.selectionRevision;
    void this.perform(async () => {
      const saved = await this.library.save(name, plan, previous);
      if (revision !== this.selectionRevision) { this.refresh(); return; }
      this.selected = saved; this.name.value = saved.name; this.undo = undefined;
      this.refresh(); this.select.value = saved.id;
      this.notice(t('已保存「{0}」', saved.name)); this.sync();
    }, this.name);
  }

  private loadSelected() {
    if (!this.selected) return;
    try {
      const latest = this.library.list().find(entry => entry.id === this.selected!.id);
      if (!latest || JSON.stringify(latest) !== JSON.stringify(this.selected)) throw new Error(t('此方案已被其他页面修改或删除，请重新选择后载入。'));
      const before = this.current(), applied = structuredClone(latest.plan);
      if (samePlan(before, applied)) return;
      this.undo = { type: 'load', before, applied };
      this.apply(applied); this.notice(t('已载入「{0}」', latest.name)); this.sync();
      this.name.focus({ preventScroll: true });
    } catch (error) { this.fail(error); }
  }

  private undoLast() {
    const undo = this.undo, revision = this.selectionRevision;
    if (!undo) return;
    void this.perform(async () => {
      if (undo.type === 'delete') {
        const saved = await this.library.restore(undo.saved);
        if (revision !== this.selectionRevision) { this.refresh(); return; }
        this.selected = saved; this.name.value = saved.name;
        this.refresh(); this.select.value = saved.id;
      } else this.apply(undo.before);
      this.undo = undefined; this.notice(undo.type === 'delete' ? t('已恢复删除的方案') : t('已恢复载入前的模块配置'));
      this.sync();
    }, this.select);
  }

  private async perform(action: () => Promise<void>, focus?: HTMLElement) {
    if (this.busy) return;
    const revision = this.selectionRevision;
    this.busy = true; this.root.setAttribute('aria-busy', 'true'); this.sync();
    try { await action(); }
    catch (error) { this.fail(error); }
    finally {
      this.busy = false; this.root.setAttribute('aria-busy', 'false'); this.sync();
      if (revision === this.selectionRevision && this.root.getClientRects().length) focus?.focus({ preventScroll: true });
    }
  }

  private notice(message = '', error = false) {
    const notice = this.control('[data-module-library-notice]');
    notice.textContent = message; notice.hidden = !message; notice.dataset.error = String(error);
  }

  private fail(error: unknown) { this.notice(error instanceof Error ? error.message : t('方案操作未完成，请重试。'), true); }

  private control<T extends HTMLElement>(selector: string): T {
    const control = this.root.querySelector<T>(selector);
    if (!control) throw new Error(`Missing module library control: ${selector}`);
    return control;
  }
}
