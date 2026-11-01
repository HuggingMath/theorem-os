import { en } from './i18n/en';
import { errors } from './i18n/errors';

/**
 * Interface language for the workbench, login and share pages. Chinese strings are the keys and the default;
 * English comes from the dictionary in ./i18n. The locale is fixed once per page load, so module-level labels are safe.
 * On the server there is no browser, so everything stays Chinese.
 */
export type Locale = 'zh' | 'en';
export const localeStorageKey = 'theorem-os.web-locale.v1';
const browser = typeof window !== 'undefined' && typeof document !== 'undefined';

function detect(): Locale {
  if (!browser) return 'zh';
  try {
    const saved = localStorage.getItem(localeStorageKey);
    if (saved === 'zh' || saved === 'en') return saved;
  } catch { /* Storage may be blocked; fall back to the browser language. */ }
  return (navigator.languages?.[0] ?? navigator.language ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export const locale: Locale = detect();
/** The tag Intl formatters and the html lang attribute use. */
export const localeTag = locale === 'en' ? 'en-US' : 'zh-CN';

/** English counts in the dictionary are written plural; a count of exactly 1 takes the singular noun. */
const singulars: Record<string, string> = { agents: 'agent', lines: 'line', theorems: 'theorem', tasks: 'task', tokens: 'token',
  findings: 'finding', strategies: 'strategy', runs: 'run', records: 'record', minutes: 'minute', entries: 'entry', bytes: 'byte',
  times: 'time', matches: 'match', characters: 'character', goals: 'goal', declarations: 'declaration', auditors: 'auditor',
  reviewers: 'reviewer' };
const countedPlural = new RegExp(`(^|[^\\d.,])1 ((?:more |research )?)(${Object.keys(singulars).join('|')})\\b`, 'gu');
const singular = (text: string) => text.replace(countedPlural, (_match, before: string, middle: string, noun: string) => `${before}1 ${middle}${singulars[noun]}`)
  // "Lines {0}" names one line unless a range or a list follows.
  .replace(/\bLines (\d+)(?![\d–,-])/gu, 'Line $1');

/** Translates a Chinese key; {0}, {1}… are replaced by the arguments in order. A key without an entry stays Chinese. */
export function t(key: string, ...values: unknown[]): string {
  const text = locale === 'en' ? en[key] ?? key : key;
  if (!values.length) return text;
  const filled = text.replace(/\{(\d+)\}/gu, (match, index: string) => index in values ? String(values[Number(index)]) : match);
  return locale === 'en' ? singular(filled) : filled;
}

const detail = /^(.*?)( · [^·]+)$/u;
/**
 * Translates text produced elsewhere in Chinese, such as stored event messages and share labels, when it matches a key
 * exactly, optionally followed by a " · worker" suffix. Anything else, including Agent output, is returned unchanged.
 */
export function localizeText(text: string): string {
  if (locale === 'zh' || !text) return text;
  if (en[text]) return en[text];
  const match = detail.exec(text);
  return match && en[match[1]] ? `${en[match[1]]}${match[2]}` : text;
}

let templates: Array<[RegExp, string]> | undefined;
/**
 * Translates an error message the server sent. Besides exact keys, an error key with {0}, {1}… matches the message with
 * those parts filled in, and the English keeps the filled values. Anything else is returned unchanged.
 */
export function localizeMessage(text: string): string {
  if (locale === 'zh' || !text || en[text]) return localizeText(text);
  templates ??= Object.keys(errors).filter(key => /\{\d+\}/u.test(key)).map(key => [new RegExp(`^${key.split(/\{\d+\}/u)
    .map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('(.+?)')}$`, 'u'), key]);
  // Error keys come from template literals, so their slots are numbered in order (scripts/web-i18n.ts errorKeys).
  for (const [pattern, key] of templates) {
    const match = pattern.exec(text);
    if (match) return t(key, ...match.slice(1));
  }
  return text;
}

/** Saves the choice and reloads; callers save drafts first. */
export function switchLocale(next: Locale) {
  try { localStorage.setItem(localeStorageKey, next); } catch { /* The choice then lasts for this load only. */ }
  location.reload();
}

/**
 * The language switch names the other language in that language, so the visible label is also its accessible name;
 * the title explains it in the current language.
 */
export const otherLocale = {
  locale: (locale === 'en' ? 'zh' : 'en') as Locale,
  label: locale === 'en' ? '中文' : 'English',
  lang: locale === 'en' ? 'zh-CN' : 'en',
  title: locale === 'en' ? 'Switch the interface to Chinese' : '将界面切换为英文',
};
/** Wires a static switch button on the login and share pages. */
export function mountLocaleSwitch(button: HTMLButtonElement, beforeSwitch?: () => void) {
  button.textContent = otherLocale.label; button.lang = otherLocale.lang; button.title = otherLocale.title;
  button.setAttribute('translate', 'no'); button.hidden = false;
  button.addEventListener('click', () => { beforeSwitch?.(); switchLocale(otherLocale.locale); });
}

const attributes = ['aria-label', 'title', 'placeholder', 'alt', 'content', 'aria-description', 'data-label'];
/** Translates the static markup of a page: text nodes and the readable attributes whose whole value is a key. */
export function localizeDocument(root: ParentNode = document) {
  if (locale === 'zh') return;
  const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue ?? '', key = value.trim().replace(/\s+/gu, ' ');
    if (key && en[key]) node.nodeValue = `${/^\s*/u.exec(value)![0]}${en[key]}${/\s*$/u.exec(value)![0]}`;
  }
  root.querySelectorAll<HTMLElement>(attributes.map(name => `[${name}]`).join(',')).forEach(element => {
    for (const name of attributes) {
      const value = element.getAttribute(name);
      if (value && en[value]) element.setAttribute(name, en[value]);
    }
  });
}

if (browser) {
  document.documentElement.lang = localeTag;
  if (locale === 'en') {
    document.title = en[document.title] ?? document.title;
    localizeDocument();
  }
}
