import { describe, expect, it } from 'vitest';
import { loginHref, loginReturn } from '../apps/web/shared';
import { readPeopleReturn, withPeopleReturn } from '../apps/web/client/researchPeopleReturn';

const origin = 'https://workbench.example';

describe('research update return links', () => {
  it('keeps the precise theorem target and the original filtered People list through refresh and login', () => {
    const source = '/people.html?id=researcher&q=Galois&field=Algebra&offset=12&workbenchChat=source-chat#profile-updates';
    const target = 'theorems.html?id=project&run=run-1&version=version-2&task=goal&taskVersion=goal-v3&workbenchChat=source-chat#feedback-suggestion';
    const href = new URL(withPeopleReturn(target, source), origin);
    expect(href.pathname).toBe('/theorems.html'); expect(href.hash).toBe('#feedback-suggestion');
    expect([...href.searchParams].filter(([key]) => key !== 'peopleReturn')).toEqual([...new URL(target, origin).searchParams]);
    expect(readPeopleReturn(href.search)).toBe(source);
    const login = new URL(loginHref(href.pathname + href.search + href.hash), origin);
    const reopened = new URL(loginReturn(login.search), origin);
    expect(readPeopleReturn(reopened.search)).toBe(source); expect(reopened.hash).toBe(href.hash);
  });

  it('supports updates, feed and contributions while accepting only local People page returns', () => {
    for (const section of ['profile-updates', 'research-feed', 'research-contributions']) {
      const source = `people.html?id=researcher&feedField=Algebra#${section}`;
      expect(readPeopleReturn(new URL(withPeopleReturn('theorems.html?id=project', source), origin).search)).toBe('/' + source);
    }
    for (const source of [undefined, '', '//evil.example/people.html', 'https://workbench.example/people.html',
      '/theorems.html?id=project', '/api/auth/logout', '/people.html\n', '/./people.html']) {
      expect(withPeopleReturn('theorems.html?id=project#feedback-1', source)).toBe('theorems.html?id=project#feedback-1');
      expect(readPeopleReturn('?' + new URLSearchParams({ peopleReturn: source ?? '' }))).toBeUndefined();
    }
  });
});
