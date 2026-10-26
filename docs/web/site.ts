import type { ArchiveRecord } from './types';

export type Locale = 'zh' | 'en';

/** The public repository that hosts the site, the proof archive and feedback issues. */
export const siteRepository = 'https://github.com/LikC1606/theorem-os-site';
export const issueDestination = `${siteRepository}/issues/new`;
export const earlyAccessIssue = `${issueDestination}?template=early-access.yml`;
/** An optional private sign-up form (https only). Leave empty until a form exists; the site then hides the link. */
export const earlyAccessForm: string = '';

/** English pages live in en/ and share the root assets and scripts. */
export const localeOf = (lang: string): Locale => lang.toLowerCase().startsWith('en') ? 'en' : 'zh';
export const rootOf = (locale: Locale) => locale === 'en' ? '../' : '';

export function localizeRecord(record: ArchiveRecord, locale: Locale): ArchiveRecord {
  return locale === 'en' && record.en ? { ...record, ...record.en } : record;
}
/** Keep the current section or archive record when a reader switches language. */
export function keepHashOnLanguageSwitch() {
  for (const link of document.querySelectorAll<HTMLAnchorElement>('a.lang-link')) {
    const sync = () => { link.hash = location.hash; };
    for (const type of ['click', 'auxclick', 'contextmenu']) link.addEventListener(type, sync);
  }
}
