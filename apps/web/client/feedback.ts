import { locale } from '../i18n';

/** The public product site: home page, early-access request, privacy page and feedback form. */
export const siteUrl = 'https://theoremos.top/';
const sitePage = (page: string) => new URL(locale === 'en' ? `en/${page}` : page, siteUrl).href;
export const siteHome = sitePage('');

/** Points static links marked `data-site="page#anchor"` at the site page in the interface language. */
export function localizeSiteLinks(root: ParentNode = document) {
  root.querySelectorAll<HTMLAnchorElement>('a[data-site]').forEach(link => { link.href = sitePage(link.dataset.site!); });
  root.querySelectorAll<HTMLAnchorElement>('a[data-feedback]').forEach(link => {
    link.href = feedbackUrl();
    // The viewport may have changed since load.
    link.addEventListener('click', () => { link.href = feedbackUrl(); });
  });
}

/** Browser, system, viewport and language, so a report says where it happened. The page has no version to add. */
export function environmentSummary(agent = navigator.userAgent, width = innerWidth, height = innerHeight) {
  const browser = /Edg\/(\d+)/u.exec(agent) ? `Edge ${/Edg\/(\d+)/u.exec(agent)![1]}`
    : /Firefox\/(\d+)/u.exec(agent) ? `Firefox ${/Firefox\/(\d+)/u.exec(agent)![1]}`
    : /Chrome\/(\d+)/u.exec(agent) ? `Chrome ${/Chrome\/(\d+)/u.exec(agent)![1]}`
    : /Version\/(\d+)[\d.]* .*Safari/u.exec(agent) ? `Safari ${/Version\/(\d+)/u.exec(agent)![1]}` : 'Browser';
  const system = /iPhone|iPad/u.test(agent) ? 'iOS' : /Android/u.test(agent) ? 'Android' : /Mac OS X/u.test(agent) ? 'macOS'
    : /Windows/u.test(agent) ? 'Windows' : /Linux/u.test(agent) ? 'Linux' : 'Other';
  return `TheoremOS workbench · ${system} · ${browser} · ${width}×${height} · ${locale}`;
}

/**
 * The site's feedback form, opened with the workbench area, the environment and, after a failed run, its failure kind.
 * The form posts a public GitHub issue only after the visitor reviews it, so no run ID, email or task text is added.
 */
export function feedbackUrl(options: { kind?: 'bug' | 'feature' | 'question'; failure?: string } = {}) {
  const url = new URL(sitePage('feedback.html'));
  url.searchParams.set('area', 'workbench');
  url.searchParams.set('kind', options.kind ?? 'bug');
  url.searchParams.set('environment', environmentSummary() + (options.failure ? ` · failure: ${options.failure}` : ''));
  return url.href;
}
