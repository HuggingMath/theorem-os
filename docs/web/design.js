import { initializeHumanDecision } from './designHumanDecision';
import { keepHashOnLanguageSwitch } from './site';

// These pages only demonstrate existing records and prepare local text drafts.
// Research and email are always started by the visitor in their own application.
function focusVisible(element) {
  element.focus({ preventScroll: true });
  element.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
}

function initializeMenu() {
  const button = document.querySelector('.menu-toggle');
  const navigation = document.getElementById('mobile-nav');
  if (!button || !navigation) return;

  function setOpen(open) {
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-label', open ? '关闭导航菜单' : '打开导航菜单');
    navigation.hidden = !open;
  }

  button.addEventListener('click', () => setOpen(navigation.hidden));
  navigation.addEventListener('click', event => {
    const link = event.target.closest('a');
    if (!link) return;
    setOpen(false);
    const destination = new URL(link.href, location.href);
    if (destination.origin === location.origin && destination.pathname === location.pathname && destination.hash) {
      const target = document.getElementById(decodeURIComponent(destination.hash.slice(1)));
      if (target) {
        if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
        target.focus({ preventScroll: true });
      }
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !navigation.hidden) {
      event.preventDefault();
      setOpen(false);
      button.focus();
    }
  });
  window.addEventListener('resize', () => {
    if (getComputedStyle(button).display === 'none') setOpen(false);
  });
  setOpen(false);
}

// All three tab groups use automatic activation and one keyboard stop.
function initializeTabs(buttons, onSelect) {
  if (!buttons.length) return;
  function select(button, moveFocus = false) {
    for (const item of buttons) {
      const selected = item === button;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
      item.classList.toggle('is-active', selected);
    }
    onSelect(button);
    if (moveFocus) button.focus();
  }
  for (const button of buttons) {
    button.addEventListener('click', () => select(button));
    button.addEventListener('keydown', event => {
      let index = buttons.indexOf(button);
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') index = (index - 1 + buttons.length) % buttons.length;
      else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') index = (index + 1) % buttons.length;
      else if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = buttons.length - 1;
      else return;
      event.preventDefault();
      select(buttons[index], true);
    });
  }
  select(buttons.find(button => button.getAttribute('aria-selected') === 'true') || buttons[0]);
}

function initializeReplay() {
  for (const root of document.querySelectorAll('[data-replay-root]')) {
    const buttons = [...root.querySelectorAll('[data-replay-stage]')];
    const panels = [...root.querySelectorAll('[role="tabpanel"]')];
    initializeTabs(buttons, button => {
      const panelId = button.getAttribute('aria-controls');
      for (const panel of panels) panel.hidden = panel.id !== panelId;
      root.dataset.replayCurrent = button.dataset.replayStage;
      root.querySelector('#replay-step-number').textContent = button.dataset.stepIndex;
      root.querySelector('#replay-step-label').textContent = button.dataset.stepName;
    });
  }
}

function initializeComponents() {
  const root = document.querySelector('[data-components-root]');
  if (!root) return;
  const buttons = [...root.querySelectorAll('[data-component]')];
  const detail = root.querySelector('[data-component-detail]');
  for (const button of buttons) {
    button.id ||= `component-${button.dataset.component}`;
    button.setAttribute('aria-controls', detail.id);
  }
  initializeTabs(buttons, button => {
    for (const key of ['title', 'desc', 'input', 'output', 'tag']) {
      detail.querySelector(`[data-comp-detail-${key}]`).textContent = button.dataset[key];
    }
    detail.setAttribute('aria-labelledby', button.id);
    for (const node of root.querySelectorAll('[data-diagram-node]')) {
      node.classList.toggle('is-highlighted', node.dataset.diagramNode === button.dataset.component);
    }
    root.querySelector('[data-diagram-caption]').textContent = `${button.dataset.tag} · ${button.dataset.title}`;
    root.dataset.selectedComponent = button.dataset.component;
  });

  const viewButtons = [...root.querySelectorAll('[data-comp-view]')];
  const viewPanels = [...root.querySelectorAll('[data-comp-panel]')];
  for (const button of viewButtons) {
    const panel = viewPanels.find(panel => panel.dataset.compPanel === button.dataset.compView);
    button.id ||= `component-view-${button.dataset.compView}`;
    panel.id ||= `component-panel-${button.dataset.compView}`;
    button.setAttribute('aria-controls', panel.id);
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', button.id);
    panel.tabIndex = 0;
  }
  initializeTabs(viewButtons, button => {
    for (const panel of viewPanels) panel.hidden = panel.dataset.compPanel !== button.dataset.compView;
  });
}

function initializeImageDialogs() {
  const openers = new Map();
  for (const trigger of document.querySelectorAll('[data-open-dialog]')) {
    trigger.addEventListener('click', event => {
      const dialog = document.getElementById(trigger.dataset.openDialog);
      if (!dialog || typeof dialog.showModal !== 'function') return;
      event.preventDefault();
      openers.set(dialog, trigger);
      dialog.showModal();
    });
  }
  for (const trigger of document.querySelectorAll('[data-close-dialog]')) {
    trigger.addEventListener('click', () => document.getElementById(trigger.dataset.closeDialog).close());
  }
  for (const dialog of document.querySelectorAll('dialog.image-dialog')) {
    dialog.addEventListener('close', () => openers.get(dialog)?.focus({ preventScroll: true }));
    dialog.addEventListener('click', event => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
    });
  }
}

function initializeChapterLinks() {
  const links = [...document.querySelectorAll('.initiative-toc a[href^="#"]')];
  function sync() {
    for (const link of links) {
      if (link.hash === location.hash) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    }
  }
  window.addEventListener('hashchange', sync);
  sync();
}

function initializeEmailDraft() {
  const form = document.querySelector('[data-initiative-form]');
  if (!form) return;
  // The preview is a sibling of the form, so hiding the form leaves it available.
  const preview = document.querySelector('[data-initiative-preview]');
  const output = preview.querySelector('[data-email-text]');
  const mailLink = preview.querySelector('[data-open-email]');
  const longNote = preview.querySelector('[data-long-email]');
  const status = preview.querySelector('[data-copy-status]');
  const fields = Object.fromEntries(['name', 'email', 'institution', 'role', 'message'].map(name => [name, form.elements.namedItem(name)]));
  const directions = [...form.querySelectorAll('input[name="directions"]')];
  const messages = {
    name: '请填写姓名，不能只输入空格。',
    email: '请填写有效的联系邮箱。',
    directions: '请至少选择一个参与方向。',
    message: '请介绍你的想法，不能只输入空格。',
  };
  function inputs(name) {
    return name === 'directions' ? directions : [fields[name]];
  }
  function validate(name) {
    const valid = name === 'directions' ? directions.some(input => input.checked)
      : fields[name].value.trim().length > 0 && fields[name].validity.valid;
    const error = document.getElementById(`initiative-${name}-error`);
    error.textContent = valid ? '' : messages[name];
    error.hidden = valid;
    for (const input of inputs(name)) {
      if (valid) input.removeAttribute('aria-invalid');
      else input.setAttribute('aria-invalid', 'true');
    }
    return valid;
  }
  for (const name of ['name', 'email', 'message']) {
    fields[name].addEventListener('input', () => {
      if (fields[name].hasAttribute('aria-invalid')) validate(name);
    });
  }
  for (const input of directions) {
    input.addEventListener('change', () => {
      if (directions.some(item => item.hasAttribute('aria-invalid'))) validate('directions');
    });
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    for (const field of Object.values(fields)) field.value = field.value.trim();
    const invalid = ['name', 'email', 'directions', 'message'].filter(name => !validate(name));
    if (invalid.length) {
      focusVisible(inputs(invalid[0])[0]);
      return;
    }
    const areas = directions.filter(input => input.checked).map(input => input.value);
    const recipient = 'liuzhenhao@westlake.edu.cn';
    const subject = `TheoremOS 共建交流 · ${fields.name.value}`;
    const body = [
      '你好，TheoremOS：', '',
      `姓名：${fields.name.value}`, `联系邮箱：${fields.email.value}`,
      `所在机构：${fields.institution.value || '未填写'}`, `身份或研究方向：${fields.role.value || '未填写'}`,
      `参与方向：${areas.join(' / ')}`, '', '我的想法：', fields.message.value,
    ].join('\n');
    const subjectLink = `mailto:${recipient}?subject=${encodeURIComponent(subject)}`;
    const fullLink = `${subjectLink}&body=${encodeURIComponent(body)}`;
    const isLong = fullLink.length >= 7500;
    mailLink.href = isLong ? subjectLink : fullLink;
    longNote.hidden = !isLong;
    document.getElementById('mail-preview-subject').textContent = subject;
    output.value = `收件人：${recipient}\n主题：${subject}\n\n${body}`;
    status.textContent = '';
    form.hidden = true;
    preview.hidden = false;
    focusVisible(preview.querySelector('h3'));
  });
  preview.querySelector('[data-edit-email]').addEventListener('click', () => {
    preview.hidden = true;
    form.hidden = false;
    focusVisible(fields.name);
  });
  const copy = preview.querySelector('[data-copy-email]');
  copy.addEventListener('click', async () => {
    const text = output.value;
    copy.disabled = true;
    try {
      await navigator.clipboard.writeText(text);
      if (!preview.hidden && output.value === text) status.textContent = '邮件全文已复制，可粘贴到邮件客户端。邮件还未发送。';
    } catch {
      if (!preview.hidden && output.value === text) {
        status.textContent = '自动复制失败，邮件全文已选中。请手动复制，或下载文本。';
        focusVisible(output);
        output.select();
      }
    } finally {
      copy.disabled = false;
    }
  });
  preview.querySelector('[data-download-email]').addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([output.value], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'theoremos-initiative-zh.txt';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  form.hidden = false;
  preview.hidden = true;
  document.documentElement.dataset.initiativeReady = 'true';
}

function initialize() {
  document.documentElement.classList.add('js');
  initializeMenu();
  keepHashOnLanguageSwitch();
  initializeHumanDecision('zh');
  initializeReplay();
  initializeComponents();
  initializeImageDialogs();
  initializeChapterLinks();
  initializeEmailDraft();
  document.documentElement.dataset.designReady = 'true';
  if (document.querySelector('[data-human-decision]')) document.documentElement.dataset.landingReady = 'true';
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initialize, { once: true });
else initialize();
