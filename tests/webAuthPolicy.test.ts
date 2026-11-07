import { describe, expect, it } from 'vitest';
import { WebAuth, type WebAuthConfig } from '../apps/web/auth';
import { WebStorage } from '../apps/web/storage';

function fixture() {
  const config: WebAuthConfig = { smtpUrl: 'log:', from: 'test@localhost', allowlist: [], admins: ['admin@example.org'], signup: 'open', termsVersion: 'v1' };
  const storage = new WebStorage();
  let code = '';
  const auth = new WebAuth(config, storage, async message => { code = message.text.match(/\b\d{6}\b/u)![0]; }, () => '12345');
  async function login(email = 'alice@example.org', terms = true, termsVersion = config.termsVersion) {
    const captcha = auth.captcha('local-fixture');
    await auth.requestCode('local-fixture', { email, captchaId: captcha.id, captcha: '12345' });
    return auth.verifyCode({ email, code, terms, termsVersion });
  }
  return { auth, config, storage, login };
}

describe('account suspension and terms changes', () => {
  it('does not authenticate a recreated account using the previous account password', async () => {
    const { auth, login } = fixture();
    const original = await login();
    const password = 'test-password-long-enough';
    await auth.setPassword(original.email, password, undefined, true);
    const pending = auth.loginPassword('local-fixture', { email: original.email, password });
    const rejected = expect(pending).rejects.toMatchObject({ status: 401 });
    auth.deleteAccount(original.email);
    const recreated = await login();
    expect(recreated.id).not.toBe(original.id);
    await rejected;
    expect(auth.hasPassword(recreated.email)).toBe(false);
  });

  it.each(['deletion', 'recreation', 'suspension'] as const)('does not write a password after %s during derivation', async change => {
    const { auth, login } = fixture();
    const account = await login();
    const pending = auth.setPassword(account.email, 'test-password-long-enough', undefined, true);
    const rejected = expect(pending).rejects.toMatchObject({ status: change === 'suspension' ? 403 : 404 });
    // scrypt returns asynchronously, so these changes happen before the pending password can be stored.
    if (change === 'suspension') auth.setSuspended(account.email, true);
    else {
      auth.deleteAccount(account.email);
      if (change === 'recreation') expect((await login()).id).not.toBe(account.id);
    }
    await rejected;
    expect(auth.hasPassword(account.email)).toBe(false);
  });

  it('suspends both login methods in open signup and restores the same records', async () => {
    const { auth, config, storage, login } = fixture();
    const account = await login();
    await auth.setPassword(account.email, 'test-password-long-enough', undefined, true);
    auth.setSuspended(account.email, true);
    expect(auth.allowed(account.email)).toBe(false);
    expect(new WebAuth(config, storage).allowed(account.email)).toBe(false);
    await expect(login()).rejects.toMatchObject({ status: 403 });
    await expect(auth.loginPassword('local-fixture', { email: account.email, password: 'test-password-long-enough' })).rejects.toMatchObject({ status: 401 });
    auth.setSuspended(account.email, false);
    expect(auth.allowed(account.email)).toBe(true);
    expect((await auth.loginPassword('local-fixture', { email: account.email, password: 'test-password-long-enough' })).id).toBe(account.id);
    expect(auth.getAccount(account.email)?.suspendedAt).toBeUndefined();
    const admin = await login('admin@example.org');
    expect(() => auth.setSuspended(admin.email, true)).toThrow(/管理员/u);
    expect(() => auth.setSuspended('missing@example.org', true)).toThrow(/账号不存在/u);
  });

  it('requires the current version for a password login after a terms change', async () => {
    const { auth, config, login } = fixture();
    const account = await login();
    await auth.setPassword(account.email, 'test-password-long-enough', undefined, true);
    config.termsVersion = 'v2';
    const body = { email: account.email, password: 'test-password-long-enough' };
    await expect(auth.loginPassword('local-fixture', body)).rejects.toMatchObject({ status: 400 });
    await expect(auth.loginPassword('local-fixture', { ...body, terms: true, termsVersion: 'v1' })).rejects.toMatchObject({ status: 428 });
    expect(auth.getAccount(account.email)?.termsVersion).toBe('v1');
    expect((await auth.loginPassword('local-fixture', { ...body, terms: true, termsVersion: 'v2' })).termsVersion).toBe('v2');
    expect(auth.needsTerms(account.email)).toBe(false);
  });

  it('allows an existing session to accept a new version without changing its identity', async () => {
    const { auth, config, login } = fixture();
    const account = await login();
    config.termsVersion = 'v2';
    expect(auth.needsTerms(account.email)).toBe(true);
    expect(() => auth.acceptTerms(account.email, { terms: true, termsVersion: 'v1' })).toThrow(/条款已更新/u);
    const updated = auth.acceptTerms(account.email, { terms: true, termsVersion: 'v2' });
    expect(updated).toMatchObject({ id: account.id, termsVersion: 'v2' });
    expect(auth.needsTerms(account.email)).toBe(false);
    expect((await login(account.email, false)).id).toBe(account.id);
  });
});
