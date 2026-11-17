import type { Locale } from './site';

export function initializeHumanDecision(locale: Locale) {
  const example = document.querySelector<HTMLElement>('[data-human-decision]');
  if (!example) return;
  const element = <T extends HTMLElement>(selector: string) => example.querySelector<T>(selector)!;
  type State = 'review' | 'revise' | 'saved' | 'confirm';
  const labels = {
    zh: {
      review: ['等待你的确认', '这是浏览器本地演练。核对原题和两个目标，不会调用模型或启动工作台研究。'],
      revise: ['正在修改陈述', '修改原题或目标，保存后再重新核对。'],
      saved: ['修改已保存', '请确认更新后的原题和两个目标。'],
      confirm: ['已在本地确认两个目标', '本页演练已确认。可以查看原始示例已有的证明回放，也可以继续修改陈述。'],
      confirmEdited: ['已在本地确认修改稿', '修改稿仅保存在本页。复制后可自行粘贴到工作台，不会自动提交或启动研究。'],
      goalNames: ['目标一', '目标二'], questionName: '原题',
      copyPrompt: '复制原题和两个目标，再粘贴到工作台。',
      copied: '修改稿已复制。打开工作台后，粘贴到原题输入框。',
      copyFallback: '浏览器未能复制，请复制下方已选中的修改稿，再粘贴到工作台。',
    },
    en: {
      review: ['Waiting for your confirmation', 'The two goals are still under review. The proof stage is locked.'],
      revise: ['Editing the statement', 'Change the question or either goal, then save it to review again.'],
      saved: ['Changes saved', 'Review the updated question and both goals before confirming.'],
      confirm: ['The proof stage is unlocked', 'Both goals are confirmed. You can now explore this problem’s recorded proof replay.'],
      confirmEdited: ['Revised statement confirmed', 'Copy this revision, then paste it into the workbench question field to continue.'],
      goalNames: ['Goal one', 'Goal two'], questionName: 'Question',
      copyPrompt: 'Copy the question and both goals, then paste them into the workbench.',
      copied: 'Revision copied. Open the workbench and paste it into the question field.',
      copyFallback: 'The browser could not copy. Copy the selected revision below, then paste it into the workbench.',
    },
  }[locale];
  const confirm = element<HTMLButtonElement>('[data-decision="confirm"]');
  const revise = element<HTMLButtonElement>('[data-decision="revise"]');
  const reset = element<HTMLButtonElement>('[data-decision="reset"]');
  const cancelEdit = element<HTMLButtonElement>('[data-decision="cancel-edit"]');
  const edit = element<HTMLFormElement>('[data-decision-edit]');
  const field = (name: string) => element<HTMLInputElement | HTMLTextAreaElement>(`[data-decision-field="${name}"]`);
  const question = element('[data-decision-question]');
  const goals = [element('[data-decision-goal="0"]'), element('[data-decision-goal="1"]')];
  const theorems = [element('[data-decision-theorem="0"]'), element('[data-decision-theorem="1"]')];
  const continueReplay = element('[data-decision-continue]');
  const continueWorkbench = element('[data-decision-workbench]');
  const copy = element<HTMLButtonElement>('[data-decision-copy]');
  const copyStatus = element('[data-decision-copy-status]');
  const exported = element<HTMLTextAreaElement>('[data-decision-export]');
  const original = { question: question.textContent ?? '', goals: goals.map(goal => goal.textContent ?? ''),
    theorems: theorems.map(theorem => theorem.textContent ?? '') };
  const fields = ['question', 'goal-0', 'goal-1'] as const;
  let state: State = 'review';
  let beforeEditing: State = 'review';
  let edited = false;
  function focusVisible(target: HTMLElement) {
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
  }
  function render(next: State) {
    state = next;
    const confirmed = state === 'confirm';
    const editing = state === 'revise';
    example!.dataset.decisionState = state;
    const label = state === 'confirm' && edited ? labels.confirmEdited : labels[state];
    element('[data-decision-status]').textContent = label[0];
    element('[data-decision-description]').textContent = label[1];
    confirm.setAttribute('aria-pressed', String(confirmed));
    revise.setAttribute('aria-pressed', String(editing));
    revise.setAttribute('aria-expanded', String(editing));
    confirm.disabled = editing;
    revise.disabled = editing;
    question.hidden = editing;
    element('.decision-targets').hidden = editing;
    element('[data-decision-controls]').hidden = editing;
    element('[data-decision-feedback]').hidden = editing;
    element('[data-decision-next]').hidden = editing;
    edit.hidden = !editing;
    continueReplay.hidden = !confirmed || edited;
    continueWorkbench.hidden = !confirmed || !edited;
    element('[data-decision-locked]').hidden = confirmed;
    reset.hidden = state === 'review';
    element('[data-decision-handoff]').hidden = !confirmed || !edited;
    theorems.forEach((theorem, index) => { theorem.textContent = edited ? labels.goalNames[index] : original.theorems[index]; });
    exported.hidden = true;
    exported.value = `${labels.questionName}\n${question.textContent}\n\n${labels.goalNames[0]}\n${goals[0].textContent}\n\n${labels.goalNames[1]}\n${goals[1].textContent}`;
    copyStatus.textContent = labels.copyPrompt;
  }
  function validate(name: typeof fields[number]) {
    const invalid = !field(name).value.trim();
    field(name).setAttribute('aria-invalid', String(invalid));
    element(`[data-decision-error="${name}"]`).hidden = !invalid;
    return !invalid;
  }
  function cancel() {
    render(beforeEditing);
    focusVisible(revise);
  }
  confirm.addEventListener('click', () => render('confirm'));
  revise.addEventListener('click', () => {
    beforeEditing = state;
    for (const [name, value] of [['question', question.textContent ?? ''], ['goal-0', goals[0].textContent ?? ''], ['goal-1', goals[1].textContent ?? '']] as const)
      field(name).value = value;
    for (const name of fields) {
      field(name).removeAttribute('aria-invalid');
      element(`[data-decision-error="${name}"]`).hidden = true;
    }
    render('revise');
    focusVisible(field('question'));
  });
  cancelEdit.addEventListener('click', cancel);
  edit.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    cancel();
  });
  for (const name of fields) field(name).addEventListener('input', () => {
    if (field(name).hasAttribute('aria-invalid')) validate(name);
  });
  edit.addEventListener('submit', event => {
    event.preventDefault();
    const invalid = fields.filter(name => !validate(name));
    if (invalid.length) { focusVisible(field(invalid[0])); return; }
    const values = { question: field('question').value.trim(), goals: [field('goal-0').value.trim(), field('goal-1').value.trim()] };
    question.textContent = values.question;
    values.goals.forEach((value, index) => { goals[index].textContent = value; });
    edited = values.question !== original.question || values.goals.some((value, index) => value !== original.goals[index]);
    render('saved');
    focusVisible(confirm);
  });
  reset.addEventListener('click', () => {
    question.textContent = original.question;
    original.goals.forEach((value, index) => { goals[index].textContent = value; });
    edited = false;
    render('review');
    focusVisible(confirm);
  });
  copy.addEventListener('click', async () => {
    const revision = exported.value;
    copy.disabled = true;
    try {
      await navigator.clipboard.writeText(revision);
      if (state === 'confirm' && revision === exported.value) {
        exported.hidden = true;
        copyStatus.textContent = labels.copied;
      }
    } catch {
      if (state === 'confirm' && revision === exported.value) {
        exported.hidden = false;
        exported.classList.remove('sr-only');
        copyStatus.textContent = labels.copyFallback;
        focusVisible(exported);
        exported.select();
      }
    } finally {
      copy.disabled = false;
    }
  });
  render('review');
}
