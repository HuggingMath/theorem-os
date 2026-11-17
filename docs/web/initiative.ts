import { createIcons, ArrowUpRight, ArrowDownRight, Menu, X, Copy, Download, Mail } from 'lucide';
import { keepHashOnLanguageSwitch, localeOf } from './site';

document.documentElement.classList.add('js');
const en = localeOf(document.documentElement.lang) === 'en';
const t = en ? {
  open: 'Open navigation', close: 'Close navigation', name: 'Enter your name.',
  email: 'Enter a valid email address.', choices: 'Choose at least one area.',
  message: 'Tell us a little about your idea; spaces alone do not count.',
  copied: 'Email text copied. You can paste it into your email app.',
  copyFailed: 'Copy was unavailable. The email text is selected; copy it manually or download it.',
  subject: 'TheoremOS collaboration', to: 'To', subjectLabel: 'Subject',
  greeting: 'Hello TheoremOS,', nameLabel: 'Name', emailLabel: 'Contact email',
  institution: 'Institution', role: 'Role', areas: 'Areas of interest', idea: 'My idea',
  optionalMissing: 'Not provided',
} : {
  open: '打开导航', close: '关闭导航', name: '请填写姓名。',
  email: '请填写有效的邮箱地址。', choices: '请至少选择一个参与方向。',
  message: '请简要介绍你的想法或建议。',
  copied: '邮件全文已复制，可粘贴到邮件客户端。',
  copyFailed: '自动复制失败。邮件全文已选中，你可以手动复制或下载文本。',
  subject: 'TheoremOS 共建交流', to: '收件人', subjectLabel: '主题',
  greeting: '你好，TheoremOS：', nameLabel: '姓名', emailLabel: '联系邮箱',
  institution: '所在机构', role: '身份或研究方向', areas: '参与方向', idea: '想法或建议',
  optionalMissing: '未填写',
};
createIcons({ icons: { ArrowUpRight, ArrowDownRight, Menu, X, Copy, Download, Mail } });
keepHashOnLanguageSwitch();

const menu = document.querySelector<HTMLButtonElement>('.menu-toggle')!;
const mobileNav = document.getElementById('mobile-nav')!;
const setMenu = (open: boolean) => {
  menu.setAttribute('aria-expanded', String(open));
  menu.setAttribute('aria-label', open ? t.close : t.open);
  mobileNav.hidden = !open;
};
menu.addEventListener('click', () => setMenu(menu.getAttribute('aria-expanded') !== 'true'));
mobileNav.addEventListener('click', event => {
  if ((event.target as Element).closest('a')) setMenu(false);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !mobileNav.hidden) { setMenu(false); menu.focus(); }
});
matchMedia('(max-width: 900px)').addEventListener('change', event => {
  if (!event.matches) setMenu(false);
});
const syncChapter = () => {
  for (const link of document.querySelectorAll<HTMLAnchorElement>('.initiative-toc a')) {
    if (link.hash === location.hash) link.setAttribute('aria-current', 'location');
    else link.removeAttribute('aria-current');
  }
};
window.addEventListener('hashchange', syncChapter);
syncChapter();

const form = document.querySelector<HTMLFormElement>('[data-initiative-form]')!;
const preview = document.querySelector<HTMLElement>('[data-initiative-preview]')!;
const previewHeading = preview.querySelector<HTMLElement>('h3')!;
const output = preview.querySelector<HTMLTextAreaElement>('[data-email-text]')!;
const mailLink = preview.querySelector<HTMLAnchorElement>('[data-open-email]')!;
const longNote = preview.querySelector<HTMLElement>('[data-long-email]')!;
const copyStatus = preview.querySelector<HTMLElement>('[data-copy-status]')!;
const choices = [...form.querySelectorAll<HTMLInputElement>('input[name="area"]')];
const fields = {
  name: form.querySelector<HTMLInputElement>('[name="name"]')!,
  email: form.querySelector<HTMLInputElement>('[name="email"]')!,
  message: form.querySelector<HTMLTextAreaElement>('[name="message"]')!,
};
type Field = keyof typeof fields | 'choices';
const setError = (field: Field, message = '') => {
  const error = document.getElementById(`initiative-${field}-error`)!;
  error.textContent = message;
  error.hidden = !message;
  for (const input of field === 'choices' ? choices : [fields[field]]) {
    if (message) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  }
};
const validate = (field: Field) => {
  let message = '';
  if (field === 'choices') message = choices.some(input => input.checked) ? '' : t.choices;
  else if (!fields[field].value.trim()) message = t[field];
  else if (field === 'email' && !fields.email.validity.valid) message = t.email;
  setError(field, message);
  return !message;
};
for (const key of ['name', 'email', 'message'] as const) {
  fields[key].addEventListener('input', () => {
    if (fields[key].hasAttribute('aria-invalid')) validate(key);
  });
}
for (const input of choices) input.addEventListener('change', () => {
  if (input.hasAttribute('aria-invalid')) validate('choices');
});

const recipient = 'liuzhenhao@westlake.edu.cn';
form.addEventListener('submit', event => {
  event.preventDefault();
  fields.email.value = fields.email.value.trim();
  const invalid = (['name', 'email', 'choices', 'message'] as const).filter(key => !validate(key));
  if (invalid.length) {
    (invalid[0] === 'choices' ? choices[0] : fields[invalid[0]]).focus();
    return;
  }
  const value = (name: string) => (form.elements.namedItem(name) as HTMLInputElement).value.trim();
  const areas = choices.filter(input => input.checked).map(input => input.labels![0].textContent!.trim());
  const subject = `${t.subject} · ${value('name')}`;
  const body = [t.greeting, '', `${t.nameLabel}: ${value('name')}`, `${t.emailLabel}: ${value('email')}`,
    `${t.institution}: ${value('institution') || t.optionalMissing}`, `${t.role}: ${value('role') || t.optionalMissing}`,
    `${t.areas}: ${areas.join(' / ')}`, '', `${t.idea}:`, value('message')].join('\n');
  const fullLink = `mailto:${recipient}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  const isLong = fullLink.length > 7500;
  mailLink.href = isLong ? `mailto:${recipient}?subject=${encodeURIComponent(subject)}` : fullLink;
  longNote.hidden = !isLong;
  output.value = `${t.to}: ${recipient}\n${t.subjectLabel}: ${subject}\n\n${body}`;
  copyStatus.textContent = '';
  form.hidden = true;
  preview.hidden = false;
  previewHeading.focus();
});
preview.querySelector('[data-edit-email]')!.addEventListener('click', () => {
  preview.hidden = true;
  form.hidden = false;
  fields.name.focus();
});
preview.querySelector('[data-copy-email]')!.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(output.value);
    copyStatus.textContent = t.copied;
  } catch {
    output.focus();
    output.select();
    copyStatus.textContent = t.copyFailed;
  }
});
preview.querySelector('[data-download-email]')!.addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([output.value], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `theoremos-initiative-${en ? 'en' : 'zh'}.txt`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
form.hidden = false;
document.documentElement.dataset.initiativeReady = 'true';
