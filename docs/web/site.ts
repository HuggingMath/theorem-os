import type { ArchiveRecord } from './types';

export type Locale = 'zh' | 'en';

/** The public repository that hosts the site, the proof archive and feedback issues. */
export const siteRepository = 'https://github.com/LikC1606/theorem-os-site';
export const issueDestination = `${siteRepository}/issues/new`;
export const earlyAccessIssue = `${issueDestination}?template=early-access.yml`;

/** Where the site is served. The pages are written for the Pages default; the build rewrites them for a custom domain. */
export const pagesOrigin = 'https://likc1606.github.io/theorem-os-site';
/** A custom domain such as 'theoremos.org'. Empty keeps GitHub Pages; set it together with the DNS records in docs/website.md. */
export const customDomain = '';
/** Umami Cloud website ID. Empty means the build adds no analytics script and drops the analytics note from the privacy page. */
export const analyticsWebsiteId = '';

/** English pages live in en/ and share the root assets and scripts. */
export const localeOf = (lang: string): Locale => lang.toLowerCase().startsWith('en') ? 'en' : 'zh';
export const rootOf = (locale: Locale) => locale === 'en' ? '../' : '';

export function localizeRecord<T extends Pick<ArchiveRecord, 'en'>>(record: T, locale: Locale): T {
  return locale === 'en' && record.en ? { ...record, ...record.en } : record;
}
/** Keep the current section or archive record when a reader switches language. */
export function keepHashOnLanguageSwitch() {
  for (const link of document.querySelectorAll<HTMLAnchorElement>('a.lang-link')) {
    const sync = () => { link.hash = location.hash; };
    for (const type of ['click', 'auxclick', 'contextmenu']) link.addEventListener(type, sync);
  }
}
