import { createIcons, ArrowRight, ArrowUpRight, Bug, Copy, Download, GitFork, Lightbulb, MessageCircle, X } from 'lucide';
import { issueDestination, keepHashOnLanguageSwitch, localeOf } from './site';

createIcons({ icons: { ArrowRight, ArrowUpRight, Bug, Copy, Download, GitFork, Lightbulb, MessageCircle, X }, attrs: { 'aria-hidden': 'true' } });

const element = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const result = document.getElementById(id);
  if (!result) throw new Error(`Missing feedback element: ${id}`);
  return result as T;
};
const locale = localeOf(document.documentElement.lang);
const text = {
  zh: {
    kinds: {
  bug: { name: '问题反馈', prefix: '[Bug]', hint: '附上复现步骤、错误信息和预期结果，方便排查。', placeholder: '请描述遇到的问题' },
  feature: { name: '功能建议', prefix: '[Feature]', hint: '说明使用场景，以及这项改进能解决的问题。', placeholder: '你希望增加或改进什么？' },
  question: { name: '使用咨询', prefix: '[Question]', hint: '附上已经查阅的资料或尝试过的方法。', placeholder: '你想了解什么？' },
    },
    missingSubject: '请填写反馈标题。', missingDescription: '请填写详细描述。',
    headings: { kind: '反馈类型', area: '相关位置', description: '详细描述', environment: '环境与版本' },
    footer: '来自 TheoremOS 反馈页。',
    longNote: '内容较长，请先复制或下载全文，再到 GitHub 粘贴发布。',
    note: '将在 GitHub 打开草稿，提交后公开。',
    copied: '已复制反馈全文。', copyFailed: '未能自动复制，已选中全文，可手动复制。', downloaded: '已准备反馈 Markdown 下载。',
  },
  en: {
    kinds: {
      bug: { name: 'Bug report', prefix: '[Bug]', hint: 'Add steps to reproduce, error messages and the expected result.', placeholder: 'Describe the problem' },
      feature: { name: 'Feature request', prefix: '[Feature]', hint: 'Explain when you would use this and the problem it would solve.', placeholder: 'What would you like added or improved?' },
      question: { name: 'Question', prefix: '[Question]', hint: 'Add what you have read or tried so far.', placeholder: 'What would you like to know?' },
    },
    missingSubject: 'Enter a title for your feedback.', missingDescription: 'Enter a description.',
    headings: { kind: 'Type', area: 'Area', description: 'Description', environment: 'Environment' },
    footer: 'Sent from the TheoremOS feedback page.',
    longNote: 'This is too long for a link. Copy or download the full text, then paste it on GitHub.',
    note: 'A draft opens on GitHub. It becomes public when you submit it there.',
    copied: 'Copied the full text.', copyFailed: 'Could not copy automatically. The full text is selected so you can copy it.', downloaded: 'The Markdown download is ready.',
  },
}[locale];
const kinds = text.kinds;
type Kind = keyof typeof kinds;
const form = element<HTMLFormElement>('feedback-form');
const area = element<HTMLSelectElement>('feedback-area');
const subject = element<HTMLInputElement>('feedback-subject');
const description = element<HTMLTextAreaElement>('feedback-description');
const environment = element<HTMLInputElement>('feedback-environment');
const review = element<HTMLDialogElement>('feedback-review');
const markdown = element<HTMLTextAreaElement>('feedback-markdown');
const github = element<HTMLAnchorElement>('feedback-github');
const status = element('feedback-export-status');
const kindInputs = Array.from(form.querySelectorAll<HTMLInputElement>('input[name="feedback-kind"]'));
const selectedKind = (): Kind => {
  const value = kindInputs.find(input => input.checked)?.value;
  return value && Object.hasOwn(kinds, value) ? value as Kind : 'bug';
};

function updateFields() {
  const kind = kinds[selectedKind()];
  element('feedback-description-hint').textContent = kind.hint;
  description.placeholder = kind.placeholder;
  subject.setCustomValidity(subject.value.trim() ? '' : text.missingSubject);
  description.setCustomValidity(description.value.trim() ? '' : text.missingDescription);
  element('feedback-count').textContent = `${description.value.length} / ${description.maxLength}`;
}
form.addEventListener('input', updateFields);
form.addEventListener('change', updateFields);

form.addEventListener('submit', event => {
  event.preventDefault();
  updateFields();
  if (!form.reportValidity()) return;
  const kind = kinds[selectedKind()];
  const title = `${kind.prefix} ${subject.value.trim()}`;
  const body = [
    `### ${text.headings.kind}\n${kind.name}`,
    `### ${text.headings.area}\n${area.selectedOptions[0]?.textContent ?? area.value}`,
    `### ${text.headings.description}\n${description.value.trim()}`,
    ...(environment.value.trim() ? [`### ${text.headings.environment}\n${environment.value.trim()}`] : []),
    `---\n${text.footer}`,
  ].join('\n\n');
  const destination = new URL(issueDestination);
  destination.searchParams.set('title', title);
  destination.searchParams.set('body', body);
  // Keep the full text available when encoded Unicode or logs exceed a practical URL limit.
  const needsPaste = destination.href.length > 7500;
  if (needsPaste) destination.searchParams.delete('body');
  markdown.value = `# ${title}\n\n${body}\n`;
  element('feedback-review-summary').textContent = title;
  element('feedback-review-note').textContent = needsPaste
    ? text.longNote
    : text.note;
  github.href = destination.href;
  status.textContent = '';
  review.showModal();
  markdown.setSelectionRange(0, 0);
  markdown.scrollTop = 0;
  markdown.scrollLeft = 0;
});

element('feedback-review-close').addEventListener('click', () => review.close());

element('feedback-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(markdown.value);
    status.textContent = text.copied;
  } catch {
    markdown.focus();
    markdown.select();
    status.textContent = text.copyFailed;
  }
});
element('feedback-download').addEventListener('click', () => {
  const objectUrl = URL.createObjectURL(new Blob([markdown.value], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = 'theoremos-feedback.md';
  link.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  status.textContent = text.downloaded;
});

/**
 * The workbench links here with ?kind=…&area=…&environment=… so a report starts with where it happened. Only known
 * kinds and areas are taken; the environment fills an empty field and stays editable before anything is published.
 */
function prefill(params: URLSearchParams) {
  const kind = params.get('kind'), where = params.get('area'), env = params.get('environment');
  const input = kindInputs.find(item => item.value === kind);
  if (input) input.checked = true;
  if (where && [...area.options].some(option => option.value === where && !option.disabled)) area.value = where;
  if (env && !environment.value) environment.value = env.replace(/\s+/gu, ' ').trim().slice(0, environment.maxLength);
}
prefill(new URLSearchParams(location.search));

updateFields();
form.hidden = false;
element('feedback-fallback').hidden = true;
keepHashOnLanguageSwitch();
document.documentElement.dataset.feedbackReady = 'true';
