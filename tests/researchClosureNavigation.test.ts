import { describe, expect, it } from 'vitest';
import { workbenchDestination } from '../apps/web/shared';

describe('research closure login navigation', () => {
  const run = '12345678-1234-4321-8888-123456789abc';
  it('keeps only supported recovery actions tied to a run', () => {
    expect(workbenchDestination(`?run=${run}&recovery=tokens&source=private`)).toBe(`./?run=${run}&recovery=tokens`);
    expect(workbenchDestination(`?run=${run}&recovery=approve`)).toBe(`./?run=${run}`);
    expect(workbenchDestination('?recovery=retry')).toBe('./');
  });
  it('preserves the frozen historical observation and Library discovery filters', () => {
    const history = new URL(workbenchDestination(`?returnTo=problem&run=${run}&map=global&at=12&atState=${'a'.repeat(64)}`), 'https://fixture.invalid');
    expect(history.searchParams.get('at')).toBe('12'); expect(history.searchParams.get('atState')).toBe('a'.repeat(64));
    const query = { returnTo: 'library', run, task: 'lemma', taskVersion: 'v1', commit: 'b'.repeat(40),
      q: 'add_zero', type: 'mathematics', area: 'Number theory', environment: 'all', author: 'researcher-1', mine: '1' };
    const target = new URL(workbenchDestination(`?${new URLSearchParams(query)}`), 'https://fixture.invalid');
    expect(Object.fromEntries(target.searchParams)).toEqual(Object.fromEntries(Object.entries(query).filter(([key]) => key !== 'returnTo')));
    expect(workbenchDestination('?returnTo=problem&at=-1&atState=invalid')).toBe('problem.html');
  });
  it('returns to invitations and private prepared drafts without accepting source URLs', () => {
    const token = 'X'.repeat(43);
    expect(workbenchDestination(`?returnTo=invite&invite=${token}&lang=en&redirect=https://evil.invalid`)).toBe(`invite.html?invite=${token}&lang=en`);
    expect(workbenchDestination('?returnTo=invite&invite=invalid')).toBe('invite.html');
    expect(workbenchDestination('?sharedDraft=prepared-one&lang=en&token=secret')).toBe('./?sharedDraft=prepared-one&lang=en');
    expect(workbenchDestination('?sharedDraft=../../private')).toBe('./');
  });
  it('retains classic attribution and a non-secret share return nonce', () => {
    expect(workbenchDestination('?fromClassic=imo-2024-p1&lang=en')).toBe('./?fromClassic=imo-2024-p1&lang=en');
    expect(workbenchDestination(`?shareReturn=${run}&token=secret`)).toBe(`./?shareReturn=${run}`);
    expect(workbenchDestination('?fromClassic=https://evil.invalid&shareReturn=invalid')).toBe('./');
  });
});
