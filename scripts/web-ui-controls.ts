import assert from 'node:assert/strict';
import type { Page } from 'playwright';

export async function closeDialog(page: Page, selector: string, action: () => Promise<unknown>) {
  await page.locator(`${selector}[open]`).waitFor();
  await page.evaluate(selector => {
    const dialog = document.querySelector<HTMLDialogElement>(selector)!;
    dialog.dataset.controlCloseCompleted = 'false';
    dialog.addEventListener('close', () => { dialog.dataset.controlCloseCompleted = 'true'; }, { once: true });
  }, selector);
  await action();
  await page.waitForFunction(selector => {
    const dialog = document.querySelector<HTMLDialogElement>(selector)!;
    return !dialog.open && dialog.dataset.controlCloseCompleted === 'true';
  }, selector);
  await page.locator(selector).evaluate(dialog => { delete (dialog as HTMLElement).dataset.controlCloseCompleted; });
}

export async function discardSourceEditor(page: Page, action: () => Promise<unknown> = () => page.locator('#cancel-editor').click()) {
  await closeDialog(page, '#source-editor', async () => {
    await action();
    await page.locator('#editor-discard-dialog[open]').waitFor();
    await closeDialog(page, '#editor-discard-dialog', () => page.locator('#discard-editor-changes').click());
  });
}

export async function closeSettings(page: Page) {
  if (await page.locator('#run-settings[open]').count()) {
    await closeDialog(page, '#run-settings', () => page.locator('#close-settings').click());
  }
}

/** Wider than 850px the history is docked beside the workspace; narrower it opens as a dialog. */
export const historyDocked = (page: Page) => (page.viewportSize()?.width ?? 1440) > 850;

export async function closeHistory(page: Page) {
  if (await page.locator('#history-dialog[open]').count()) {
    await closeDialog(page, '#history-dialog', () => page.locator('#close-history').click());
  }
}

/** The workbench opens on the natural-language chat. Its Lean link lives in the chat composer on the new-research page and in
 * the input-mode switch above a shown run; the switch is hidden on the new-research page. */
export async function enterLean(page: Page) {
  if (!await page.locator('body[data-entry="natural"]').count()) return;
  const toggle = page.locator('#entry-lean');
  await (await toggle.isVisible() ? toggle : page.locator('.chat-lean-entry')).click();
  await page.locator('body[data-entry="lean"]').waitFor({ state: 'attached' });
  // The suites type proof instructions directly; the product keeps them in a collapsed section.
  await page.locator('#proof-instructions').evaluate(node => { (node as HTMLDetailsElement).open = true; });
}

/** The new-research page: the composer, and on phones its 编写 tab. A selected run is left through 新建研究. */
export async function showChat(page: Page) {
  await closeSettings(page);
  if (await page.locator('body[data-view="run"]').count()) {
    await openHistory(page);
    await page.locator('#open-draft').click();
    await page.locator('body[data-view="draft"]').waitFor({ state: 'attached' });
  }
  await closeHistory(page);
  // These helpers exercise the optional Lean editor; natural-language onboarding has its own suite.
  await enterLean(page);
  if (await page.locator('#mobile-compose').isVisible()) await page.locator('#mobile-compose').click();
  if (await page.locator('#close-draft-preview').isVisible()) await page.locator('#close-draft-preview').click();
  await page.locator('.lean-input-options').evaluate(node => { (node as HTMLDetailsElement).open = true; });
  await page.locator('#proof-instructions').evaluate(node => { (node as HTMLDetailsElement).open = true; });
}

/** The Lean editor's 研究例题 panel: research examples, template suggestions and the sample run. */
export async function showExamples(page: Page) {
  await showChat(page);
  if (await page.locator('#research-examples-panel[hidden]').count()) await page.locator('#open-research-examples').click();
  await page.locator('#research-examples-panel:not([hidden])').waitFor({ state: 'attached' });
}

/** Opens the read-only sample from the 研究例题 panel and shows its run panel, where the sample badge and tabs live. */
export async function openSample(page: Page) {
  await showExamples(page);
  await page.locator('.welcome-sample').click();
  await page.locator('body[data-view="run"]').waitFor({ state: 'attached' });
  await showArtifacts(page);
  await page.locator('[data-sample-badge]').waitFor();
}

/** The selected run, or the draft preview on the new-research page (its 预览 tab on phones). */
export async function showArtifacts(page: Page) {
  await closeSettings(page);
  await closeHistory(page);
  if (await page.locator('body[data-view="run"]').count() && !await page.locator('#runs-panel').isVisible()) {
    // The chat's 路线图 link opens the run panel on its trajectory; the tab the run had selected is selected again.
    const tab = await page.evaluate(() => document.querySelector<HTMLElement>('[data-detail-tab][aria-selected="true"]')?.dataset.detailTab);
    await page.locator('[data-research-artifact="roadmap"]').click();
    await page.locator('#runs-panel').waitFor();
    if (tab && tab !== 'trajectory') {
      await page.locator(`#detail-tab-${tab}`).click();
      await page.locator(`#detail-panel[data-tab="${tab}"]`).waitFor({ state: 'attached' });
    }
  } else if (await page.locator('body[data-view="draft"]').count() && await page.locator('#open-draft-preview').isVisible())
    await page.locator('#open-draft-preview').click();
}

export async function openSettings(page: Page) {
  if (await page.locator('#run-settings[open]').count()) return;
  await showChat(page);
  if (await page.locator('#run-settings[open]').count()) return;
  await page.locator('#open-settings').click();
  await page.locator('#run-settings[open]').waitFor();
}

export async function withSettings<T>(page: Page, action: () => Promise<T>): Promise<T> {
  await openSettings(page);
  try { return await action(); }
  finally { await closeSettings(page); }
}

export async function fillConfig(page: Page, id: string, value: string) {
  if (['source', 'environment', 'template'].includes(id)) {
    await showChat(page);
    await page.locator(`#${id}`).fill(value);
    return;
  }
  await withSettings(page, () => page.locator(`#${id}`).fill(value));
}

export async function selectConfig(page: Page, id: string, value: string) {
  if (['source', 'environment', 'template'].includes(id)) {
    await showChat(page);
    await page.locator(`#${id}`).selectOption(value);
    return;
  }
  await withSettings(page, () => page.locator(`#${id}`).selectOption(value));
}

/** Expands the docked sidebar, or opens the history dialog on narrow screens. */
export async function openHistory(page: Page) {
  await closeSettings(page);
  if (historyDocked(page)) {
    if (await page.locator('body[data-history-collapsed="true"]').count()) await page.locator('#open-history').click();
    await page.locator('#history-sidebar .run-history').waitFor();
  } else if (!await page.locator('#history-dialog[open]').count()) {
    await page.locator('#open-history').click();
    await page.locator('#history-dialog[open]').waitFor();
  }
  // Historical proof tasks live below conversation history in a collapsed disclosure.
  const tasks = page.locator('.chat-task-history:not([open]) > summary');
  if (await tasks.count()) await tasks.click();
}

export async function refreshHistory(page: Page) {
  await openHistory(page);
  await page.locator('#refresh-runs').click();
  await closeHistory(page);
}

/** Opens a run from the history; it lands on 结果 unless `tab` names another run tab. */
export async function selectHistoryRun(page: Page, id: string, tab?: string) {
  await openHistory(page);
  if (historyDocked(page)) await page.locator(`[data-run-id="${id}"]`).click();
  else await closeDialog(page, '#history-dialog', () => page.locator(`[data-run-id="${id}"]`).click());
  await page.locator(`[data-run-id="${id}"][aria-pressed="true"]`).waitFor({ state: 'attached' });
  await showArtifacts(page);
  if (tab) await openTab(page, tab);
}

export async function openTab(page: Page, tab: string) {
  await showArtifacts(page);
  if (await page.locator(`#detail-tab-${tab}[aria-selected="true"]`).count()) return;
  await page.locator(`#detail-tab-${tab}`).click();
  await page.locator(`#detail-panel[data-tab="${tab}"]`).waitFor({ state: 'attached' });
}

/** 清空草稿 on the new-research page, opening that page first when a run is shown. */
export async function newResearch(page: Page) {
  await showChat(page);
  await page.locator('#new-research').click();
  await enterLean(page);
  await page.locator('#proof-instructions').evaluate(node => { (node as HTMLDetailsElement).open = true; });
}

/** Opens the ⋯ menu in the run header, where the identifier, modules, download and deletion live. */
export async function openRunMenu(page: Page) {
  if (!await page.locator('[data-run-menu][open]').count()) await page.locator('[data-run-menu] > summary').click();
}

/** Runs an entry of the run header's ⋯ menu (copy-id, show-modules, delete-run); the menu closes behind it. */
export async function runMenu(page: Page, action: string) {
  await openRunMenu(page);
  await page.locator(`[data-run-menu][open] [data-action="${action}"]`).click();
}

/** The modules tab is not one of the default tabs; it opens from the run menu. */
export async function openModulesTab(page: Page) {
  if (!await page.locator('#detail-tab-modules').count()) await runMenu(page, 'show-modules');
  else await page.locator('#detail-tab-modules').click();
  await page.locator('#detail-panel[data-tab="modules"]').waitFor();
}

export type EditorSnapshot = { value: string; start: number; end: number; direction: string; top: number; left: number };
export async function snapshot(page: Page): Promise<EditorSnapshot> {
  return page.locator('#expanded-source').evaluate(node => {
    const editor = node as HTMLTextAreaElement;
    return { value: editor.value, start: editor.selectionStart, end: editor.selectionEnd, direction: editor.selectionDirection,
      top: editor.scrollTop, left: editor.scrollLeft };
  });
}
export async function value(page: Page, expected: string) {
  await page.waitForFunction(expected => (document.querySelector('#expanded-source') as HTMLTextAreaElement).value === expected, expected);
}
export async function text(page: Page, selector: string, expected: string) {
  await page.waitForFunction(({ selector, expected }) => document.querySelector(selector)?.textContent === expected, { selector, expected });
}
export async function focused(page: Page, selector: string) {
  assert.equal(await page.locator(selector).evaluate(node => node === document.activeElement), true, `${selector} must have focus`);
}
/** Assert `selector` lies inside the viewport (1px tolerance) and the document is no wider; `widen` is that overflow's message. */
export async function fitViewport(page: Page, selector: string, widen: string, nonEmpty = false) {
  const box = await page.locator(selector).boundingBox(), viewport = page.viewportSize()!;
  assert.ok(box && (!nonEmpty || box.width > 0 && box.height > 0) && box.x >= -1 && box.y >= -1
    && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1,
    `${selector} must fit ${viewport.width}px: ${JSON.stringify(box)}`);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, widen);
}
/** Assert an ended run's header names every stage: each label shown whole, inside the viewport and clear of the next one. */
export async function stageLabelsReadable(page: Page, context: string) {
  const labels = await page.locator('.artifact-stages .stage-label').evaluateAll(items => items.map(label => {
    const box = label.getBoundingClientRect();
    return { text: label.textContent, left: box.left, right: box.right, width: box.width, cut: label.scrollWidth > label.clientWidth + 1 };
  }));
  assert.equal(labels.length, 4, `${context}: the header shows four stages`);
  for (const [index, label] of labels.entries()) {
    assert.ok(label.width > 2 && !label.cut && label.left >= -1 && label.right <= page.viewportSize()!.width + 1,
      `${context}: stage label ${JSON.stringify(label.text)} must be shown whole: ${JSON.stringify(label)}`);
    if (index) assert.ok(label.left >= labels[index - 1]!.right, `${context}: stage labels overlap`);
  }
}
export async function selectEditorRange(page: Page, start: number, end = start, direction: 'forward' | 'backward' | 'none' = 'none') {
  await page.locator('#expanded-source').evaluate((node, selection) => {
    const editor = node as HTMLTextAreaElement; editor.focus({ preventScroll: true });
    editor.setSelectionRange(selection.start, selection.end, selection.direction);
  }, { start, end, direction });
}
/** Like `refreshHistory`, but waits for and requires a successful `/api/runs` response before closing history. */
export async function refresh(h: { page: Page }) {
  await openHistory(h.page);
  await h.page.locator('#refresh-runs:enabled').waitFor();
  const response = h.page.waitForResponse(response => new URL(response.url()).pathname === '/api/runs' && response.request().method() === 'GET');
  await h.page.locator('#refresh-runs').click();
  assert.equal((await response).status(), 200);
  await h.page.locator('#refresh-runs:enabled').waitFor();
  await closeHistory(h.page);
}
export async function selectModules(h: { page: Page }, id: string) {
  await openHistory(h.page); await h.page.locator('#refresh-runs:enabled').waitFor();
  const refreshed = h.page.waitForResponse(response => new URL(response.url()).pathname === '/api/runs' && response.request().method() === 'GET');
  await h.page.locator('#refresh-runs').click(); await refreshed;
  await h.page.locator('#refresh-runs:enabled').waitFor(); await closeHistory(h.page);
  await selectHistoryRun(h.page, id); await showArtifacts(h.page);
  await openModulesTab(h.page); await h.page.locator('.module-workspace').waitFor();
}
