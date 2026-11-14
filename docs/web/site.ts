import type { ArchiveRecord } from './types';

export type Locale = 'zh' | 'en';

/** The public repository that hosts the site, the proof archive and feedback issues. */
export const siteRepository = 'https://github.com/LikC1606/TheoremOS';
export const issueDestination = `${siteRepository}/issues/new`;
export const earlyAccessIssue = `${issueDestination}?template=early-access.yml`;

/** The GitHub Pages address of the public repository. The pages are written for it; the build rewrites them for the custom domain. */
export const pagesOrigin = 'https://likc1606.github.io/TheoremOS';
/** The domain the site is served from (Cloudflare Workers, see docs/website.md). Empty writes the pages for GitHub Pages. */
export const customDomain = 'theoremos.top';
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
    for (const type of ['pointerdown', 'mousedown', 'focus', 'click', 'auxclick', 'contextmenu']) link.addEventListener(type, sync);
  }
}
