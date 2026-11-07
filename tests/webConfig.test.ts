import { describe, expect, it } from 'vitest';
import { readWebConfig } from '../apps/web/config';

const configure = (baseUrl: string) => readWebConfig({ THEOREMOS_WEB_PROVIDERS: JSON.stringify([
  { id: 'custom', name: 'Custom gateway', baseUrl },
]) });

describe('web provider deployment addresses', () => {
  it('accepts a host gateway reached by Docker workers and normalizes its trailing slash', () => {
    expect(configure('http://host.docker.internal:8080/v1/').providers[0].baseUrl)
      .toBe('http://host.docker.internal:8080/v1');
  });

  it('preserves configured HTTPS providers', () => {
    expect(configure('https://api.example.com/v1').providers[0].baseUrl).toBe('https://api.example.com/v1');
  });

  it.each([
    'http://api.example.com/v1', 'http://host.docker.internal.example.com:8080/v1',
    'http://host.docker.internal:8080/v1?key=private', 'http://host.docker.internal:8080/v1#private',
    'http://user:private@host.docker.internal:8080/v1', 'ftp://host.docker.internal:8080/v1',
  ])('rejects unsupported or credential-bearing provider addresses (%s)', baseUrl => {
    expect(() => configure(baseUrl)).toThrow('Provider base URLs');
  });
});

describe('signup, terms and the per-account allowance', () => {
  const site = { THEOREMOS_WEB_PUBLIC_URL: 'https://workbench.example', THEOREMOS_WEB_AUTH: 'email',
    THEOREMOS_WEB_SMTP_URL: 'smtps://u:p@smtp.example', THEOREMOS_WEB_MAIL_FROM: 'TheoremOS <login@example.org>' };

  it('keeps an allowlist and no terms requirement by default', () => {
    const config = readWebConfig({ ...site, THEOREMOS_WEB_ALLOWLIST: 'alice@example.org' });
    expect(config.auth?.signup).toBe('allowlist');
    expect(config.auth?.termsVersion).toBeUndefined();
    expect(config.quota).toEqual({ windowHours: 24, runs: 30, formalizations: 8, explanations: 4 });
  });

  it('opens signup only together with email login, and then dates the terms', () => {
    expect(readWebConfig({ ...site, THEOREMOS_WEB_SIGNUP: 'open' }).auth?.termsVersion).toBe('2026-11-07');
    expect(() => readWebConfig({ ...site, THEOREMOS_WEB_SIGNUP: 'closed' })).toThrow('THEOREMOS_WEB_SIGNUP must be allowlist or open.');
    expect(() => readWebConfig({ THEOREMOS_WEB_SIGNUP: 'open' })).toThrow(/THEOREMOS_WEB_AUTH=email/u);
    expect(readWebConfig({ ...site, THEOREMOS_WEB_SIGNUP: 'open', THEOREMOS_WEB_TERMS_VERSION: 'v2' }).auth?.termsVersion).toBe('v2');
    expect(() => readWebConfig({ ...site, THEOREMOS_WEB_TERMS_VERSION: 'v 2' })).toThrow('THEOREMOS_WEB_TERMS_VERSION');
  });

  it('reads the allowance numbers, bounds them, and has none without accounts', () => {
    const config = readWebConfig({ ...site, THEOREMOS_WEB_QUOTA_WINDOW_HOURS: '6', THEOREMOS_WEB_QUOTA_RUNS: '3',
      THEOREMOS_WEB_QUOTA_FORMALIZATIONS: '0', THEOREMOS_WEB_QUOTA_EXPLANATIONS: '5' });
    expect(config.quota).toEqual({ windowHours: 6, runs: 3, formalizations: 0, explanations: 5 });
    expect(readWebConfig({}).quota).toBeUndefined();
    for (const env of [{ THEOREMOS_WEB_QUOTA_RUNS: '-1' }, { THEOREMOS_WEB_QUOTA_WINDOW_HOURS: '0' }, { THEOREMOS_WEB_QUOTA_EXPLANATIONS: 'many' },
      { THEOREMOS_WEB_QUOTA_RUNS: '10001' }])
      expect(() => readWebConfig({ ...site, ...env })).toThrow(/THEOREMOS_WEB_QUOTA/u);
  });
});
