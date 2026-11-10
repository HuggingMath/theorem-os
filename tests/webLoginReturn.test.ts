import { describe, expect, it } from 'vitest';
import { loginHref, loginReturn, researchNavigation, safeAppReturn, workbenchReturn } from '../apps/web/shared';

const chat = '0123abcd-0123-4abc-8def-0123456789ab', run = 'abcdef01-0123-4abc-8def-0123456789ab';
describe('same-site app login returns', () => {
  it.each([
    '/theorems.html?q=%E7%BE%A4&field=algebra&sort=updated&offset=20&create=1#new-theorem',
    './people.html?id=mathematician&q=Galois&field=algebra&offset=20#follow',
    'library.html?create=1&type=skill&person=researcher&version=v2#draft',
    `/?chat=${chat}#message-42`, '/index.html?run=' + run,
    '/workspace.html?tab=collections&lang=en', '/problem.html?run=' + run + '&task=target&taskVersion=v1#route',
    '/formalize.html?id=' + chat, '/practice.html?lang=en',
    '/formalization.html?original=Natural%20language#statement', '/explain.html?run=' + run,
  ])('round trips the original query and fragment through login: %s', value => {
    const expected = value.startsWith('./') ? value.slice(1) : value.startsWith('/') ? value : '/' + value;
    expect(safeAppReturn(value)).toBe(expected);
    const href = new URL(loginHref(value), 'https://app.example.test');
    expect(href.origin).toBe('https://app.example.test'); expect(href.pathname).toBe('/login.html');
    expect(href.searchParams.get('returnTo')).toBe(expected);
    expect(loginReturn(href.search)).toBe(expected);
  });

  it.each([
    '', 'https://evil.example/theorems.html', 'https://app.example.test/theorems.html', '//evil.example/theorems.html',
    'javascript:alert(1)', 'data:text/html,test', 'file:///theorems.html', '\\evil.example\\theorems.html',
    '/\\evil.example/theorems.html', ' /people.html', '/people.html\n', '/theorems.html\u0000?q=x',
    '/./people.html', '/../people.html', '/library.html/../people.html', '/%2e%2e/people.html',
    '/%2f%2fevil.example/people.html', '/%252f%252fevil.example/people.html', '%2Fpeople.html',
    '/login.html?returnTo=/library.html', '/api/auth/logout', '/assets/app.js', '/guide.html', '/People.html',
  ])('rejects a protocol, external host, unknown app path or path bypass: %s', value => {
    expect(safeAppReturn(value)).toBeUndefined();
    expect(loginHref(value)).toBe('/login.html');
    expect(loginReturn('?' + new URLSearchParams({ returnTo: value }))).toBe('./');
  });

  it('retains legacy mail/session run and conversation returns and gives a safe explicit page precedence', () => {
    expect(loginReturn('?run=' + run)).toBe('./?run=' + run);
    expect(loginReturn('?chat=' + chat)).toBe('./?chat=' + chat);
    expect(loginReturn('?run=../x&chat=invalid')).toBe('./');
    expect(loginReturn('?' + new URLSearchParams({ returnTo: '//evil.example', chat }))).toBe('./?chat=' + chat);
    expect(loginReturn('?' + new URLSearchParams({ returnTo: '/people.html?q=algebra#follow', run })))
      .toBe('/people.html?q=algebra#follow');
    expect(loginReturn('?returnTo=workspace&tab=collections&lang=en')).toBe('workspace.html?tab=collections&lang=en');
    expect(loginReturn('?returnTo=problem&run=' + run + '&task=target&taskVersion=v1')).toBe('problem.html?run=' + run + '&task=target&taskVersion=v1');
    expect(workbenchReturn('?run=0123abcd-ef')).toBe('?run=0123abcd-ef');
  });
});

describe('navigation retaining the current workbench', () => {
  it.each([`?chat=${chat}`, `?workbenchChat=${chat}&q=algebra&field=groups`])('propagates conversations on all research pages: %s', search => {
    const links = researchNavigation(search);
    expect(links.workbench).toBe('./?chat=' + chat);
    for (const page of ['workspace', 'people', 'theorems', 'library'] as const) expect(links[page]).toBe(`${page}.html?workbenchChat=${chat}`);
  });
  it.each([`?run=${run}`, `?workbenchRun=${run}`])('propagates runs on all research pages: %s', search => {
    const links = researchNavigation(search);
    expect(links.workbench).toBe('./?run=' + run);
    for (const page of ['workspace', 'people', 'theorems', 'library'] as const) expect(links[page]).toBe(`${page}.html?workbenchRun=${run}`);
  });
  it('keeps both contexts and returns to the conversation when both are provided', () => {
    const links = researchNavigation(`?chat=${chat}&run=${run}`);
    expect(links.workbench).toBe('./?chat=' + chat);
    expect(links.people).toBe(`people.html?workbenchChat=${chat}&workbenchRun=${run}`);
  });
  it('drops malformed contexts instead of treating them as destinations', () => {
    expect(researchNavigation('?workbenchChat=//evil.test&workbenchRun=../private'))
      .toEqual({ workbench: './', workspace: 'workspace.html', people: 'people.html', theorems: 'theorems.html', library: 'library.html' });
  });
});
