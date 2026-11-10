import type { Locale } from './site';

export function initializeHumanDecision(locale: Locale) {
  const example = document.querySelector<HTMLElement>('[data-human-decision]');
  if (!example) return;
  const element = <T extends HTMLElement>(selector: string) => example.querySelector<T>(selector)!;
  const labels = {
    zh: {
      review: ['等待你的确认', '两个目标尚未确认，证明阶段还未开放。'],
      revise: ['继续审核陈述', '先修改原题，再重新核对。确认前，证明阶段保持关闭。'],
      confirm: ['证明阶段已开放', '两个目标已确认。现在可以查看这道题已有的证明回放。'],
    },
    en: {
      review: ['Waiting for your confirmation', 'The two goals are still under review. The proof stage is locked.'],
      revise: ['Statement review continues', 'Revise the question, then review it again. The proof stage stays locked until you confirm.'],
      confirm: ['The proof stage is unlocked', 'Both goals are confirmed. You can now explore this problem’s recorded proof replay.'],
    },
  }[locale];
  const confirm = element<HTMLButtonElement>('[data-decision="confirm"]');
  const revise = element<HTMLButtonElement>('[data-decision="revise"]');
  const reset = element<HTMLButtonElement>('[data-decision="reset"]');
  function render(state: keyof typeof labels) {
    const confirmed = state === 'confirm';
    example!.dataset.decisionState = state;
    element('[data-decision-status]').textContent = labels[state][0];
    element('[data-decision-description]').textContent = labels[state][1];
    confirm.setAttribute('aria-pressed', String(confirmed));
    revise.setAttribute('aria-pressed', String(state === 'revise'));
    element('[data-decision-continue]').hidden = !confirmed;
    element('[data-decision-locked]').hidden = confirmed;
    reset.hidden = state === 'review';
  }
  confirm.addEventListener('click', () => render('confirm'));
  revise.addEventListener('click', () => render('revise'));
  reset.addEventListener('click', () => {
    render('review');
    confirm.focus({ preventScroll: true });
  });
  element('[data-decision-controls]').hidden = false;
  element('[data-decision-feedback]').hidden = false;
  element('[data-decision-next]').hidden = false;
  render('review');
}
