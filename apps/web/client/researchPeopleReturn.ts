import { safeAppReturn } from '../shared';

function peoplePath(value: string | null | undefined): string | undefined {
  const target = safeAppReturn(value);
  return target?.split(/[?#]/u, 1)[0] === '/people.html' ? target : undefined;
}

export const readPeopleReturn = (search: string) => peoplePath(new URLSearchParams(search).get('peopleReturn'));

/** Keep a visible way back when a research update is opened in a new tab or reloaded. */
export function withPeopleReturn(href: string, source: string | undefined): string {
  const target = peoplePath(source);
  if (!target) return href;
  const hashAt = href.indexOf('#'), address = hashAt < 0 ? href : href.slice(0, hashAt), fragment = hashAt < 0 ? '' : href.slice(hashAt);
  const queryAt = address.indexOf('?'), pathname = queryAt < 0 ? address : address.slice(0, queryAt);
  const parameters = new URLSearchParams(queryAt < 0 ? '' : address.slice(queryAt + 1));
  parameters.set('peopleReturn', target);
  return `${pathname}?${parameters}${fragment}`;
}
