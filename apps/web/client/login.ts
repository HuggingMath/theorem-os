import { createIcons, LogIn, MailCheck, RefreshCw } from 'lucide';
import { loginReturn, type WebSession } from '../shared';
import { localizeMessage, mountLocaleSwitch, t } from '../i18n';
import { localizeSiteLinks } from './feedback';
import { forgetKey } from './keyMemory';
import { OwnedDrafts } from './ownedDrafts';
import { shareLoginDestination } from './shareContinuation';

createIcons({ icons: { LogIn, MailCheck, RefreshCw }, attrs: { 'aria-hidden': 'true' } });
const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
mountLocaleSwitch($<HTMLButtonElement>('#locale-switch'), rememberLogin);
localizeSiteLinks();
const emailStep = $<HTMLFormElement>('#email-step'), codeStep = $<HTMLFormElement>('#code-step'), passwordStep = $<HTMLFormElement>('#password-step');
const email = $<HTMLInputElement>('#login-email'), captcha = $<HTMLInputElement>('#login-captcha'), code = $<HTMLInputElement>('#login-code');
const sendCode = $<HTMLButtonElement>('#send-code'), verify = $<HTMLButtonElement>('#verify-code'), resend = $<HTMLButtonElement>('#resend-code');
const passwordEmail = $<HTMLInputElement>('#password-email'), password = $<HTMLInputElement>('#login-password');
const passwordSubmit = $<HTMLButtonElement>('#password-submit');
const termsOption = $('#terms-option'), acceptTerms = $<HTMLInputElement>('#accept-terms');
const termsStep = $<HTMLFormElement>('#terms-step');
let termsVersion: string | undefined, termsAccount: string | undefined, termsOwner: string | undefined;
let csrf = '', captchaId = '', sentTo = '', resendTimer: ReturnType<typeof setInterval> | undefined;
type LoginStep = 'email' | 'password' | 'code';
type CodeChallenge = { email: string; expiresAt: number; resendAt: number };
const progressKey = 'theorem-os.login-progress.v1';
let step: LoginStep = 'email', stepRevision = 0, progressOwner = '', challenge: CodeChallenge | undefined;
// Keep a research page's filters and intended action, or an existing workbench run/chat, through every login method.
const destination = shareLoginDestination(location.search) ?? loginReturn(location.search);

/** `message` is what the visitor sees; `reason` keeps the server's own text for the session check. */
class LoginError extends Error {
  constructor(readonly reason: string, readonly status: number) { super(localizeMessage(reason)); }
}
async function call<T>(url: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await fetch(url, { method, credentials: 'same-origin', cache: 'no-store',
    headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    .catch((error: unknown) => { throw error instanceof TypeError ? new Error(t('暂时无法连接服务，请稍后重试。')) : error; });
  const payload = await response.json().catch(() => undefined) as { error?: string } | undefined;
  if (!response.ok) throw new LoginError(payload?.error ?? t('请求失败 ({0})', response.status), response.status);
  return payload as T;
}
function showError(text = '') {
  $('#login-error').textContent = text;
  $('#login-error').hidden = !text;
}
function clearLogin() {
  challenge = undefined; sentTo = ''; clearInterval(resendTimer);
  try { sessionStorage.removeItem(progressKey); } catch { /* Login also works without browser storage. */ }
}
/** Keep only the address and non-secret verification state across a language reload. */
function rememberLogin() {
  if (!progressOwner) return;
  try {
    sessionStorage.setItem(progressKey, JSON.stringify({ owner: progressOwner, step, termsVersion,
      email: step === 'password' ? passwordEmail.value : email.value, challenge }));
  } catch { /* The current form remains usable when storage is unavailable. */ }
}
function setStep(next: LoginStep) {
  step = next; stepRevision++;
  emailStep.hidden = next !== 'email'; passwordStep.hidden = next !== 'password'; codeStep.hidden = next !== 'code';
  rememberLogin();
}
function drawResend() {
  const left = Math.max(0, Math.ceil(((challenge?.resendAt ?? 0) - Date.now()) / 1000));
  resend.disabled = left > 0;
  resend.textContent = left ? t('{0} 秒后可重新发送', left) : t('重新发送');
  if (!left) clearInterval(resendTimer);
}
function showCodeStep() {
  if (!challenge || challenge.expiresAt <= Date.now()) return false;
  sentTo = challenge.email;
  $('#code-sent').textContent = t('验证码已发送至 {0}，{1} 分钟内有效。', sentTo, Math.max(1, Math.ceil((challenge.expiresAt - Date.now()) / 60_000)));
  setStep('code'); code.value = ''; code.focus();
  clearInterval(resendTimer); drawResend();
  if (resend.disabled) resendTimer = setInterval(drawResend, 1000);
  return true;
}
function restoreLogin() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(progressKey) ?? 'null') as {
      owner?: unknown; step?: unknown; email?: unknown; termsVersion?: unknown; challenge?: CodeChallenge;
    } | null;
    if (!saved || saved.owner !== progressOwner || saved.termsVersion !== termsVersion) { clearLogin(); setStep('email'); return; }
    if (typeof saved.email === 'string') email.value = passwordEmail.value = saved.email.slice(0, 254);
    const pending = saved.challenge;
    if (pending && typeof pending.email === 'string' && Number.isFinite(pending.expiresAt) && Number.isFinite(pending.resendAt)
      && pending.expiresAt > Date.now()) challenge = pending;
    else { challenge = undefined; sentTo = ''; }
    if (saved.step === 'code' && showCodeStep()) return;
    setStep(saved.step === 'password' ? 'password' : 'email');
  } catch { clearLogin(); setStep('email'); }
}
async function loadCaptcha() {
  captcha.value = ''; sendCode.disabled = true;
  const next = await call<{ id: string; image: string }>('/api/auth/captcha', {});
  captchaId = next.id; $<HTMLImageElement>('#captcha-image').src = next.image;
  sendCode.disabled = false;
}
async function start() {
  const revision = stepRevision;
  const session = await call<WebSession>('/api/session');
  if (session.auth !== 'email' || (session.account && !session.termsRequired)) { clearLogin(); location.replace(destination); return; }
  $('#login-access').hidden = session.signup === 'open' || Boolean(session.termsRequired);
  csrf = session.csrfToken;
  progressOwner = session.draftOwner ?? '';
  if (termsVersion !== session.termsVersion) acceptTerms.checked = false;
  termsVersion = session.termsVersion;
  termsAccount = session.account?.email;
  termsOwner = session.draftOwner ?? (session.account ? `account:${session.account.email}` : undefined);
  termsOption.hidden = !termsVersion;
  const wasTerms = !termsStep.hidden;
  termsStep.hidden = !session.termsRequired;
  if (session.termsRequired) {
    clearLogin();
    emailStep.hidden = true; codeStep.hidden = true; passwordStep.hidden = true;
    $('#login-heading').textContent = t('请确认更新后的条款');
    $('#login-lead').textContent = t('使用条款已更新。请阅读当前版本并确认，已有记录和运行会保留。');
    acceptTerms.focus();
    return;
  }
  if (wasTerms) { emailStep.hidden = false; codeStep.hidden = true; passwordStep.hidden = true; }
  $('#login-heading').textContent = t('登录研究工作台');
  // Signed out, the workbench is not loaded at all, so the tab's remembered API Key is cleared here.
  forgetKey(() => sessionStorage);
  // An open signup admits any inbox, so the page says so and asks for consent; the allowlist keeps its beta wording.
  const openSignup = session.signup === 'open';
  $('#login-lead').textContent = openSignup
    ? t('用邮箱登录，新用户会自动创建账号。')
    : t('请使用已获准的内测邮箱。');
  // The password form waits for the session cookie and CSRF token; sent earlier, it reads as an expired page.
  passwordSubmit.disabled = false;
  if (stepRevision === revision) restoreLogin();
  else rememberLogin();
  await loadCaptcha();
}
/** An expired login-page session is replaced; the visitor only has to repeat the current step. */
async function guarded(action: () => Promise<void>) {
  showError();
  try { await action(); }
  catch (error) {
    if (error instanceof LoginError && error.status === 428) {
      if (!codeStep.hidden) { emailStep.hidden = false; codeStep.hidden = true; }
      await start().catch(() => undefined);
      showError(error.message);
    } else if (error instanceof LoginError && [401, 403].includes(error.status) && /会话/u.test(error.reason)) {
      await start().catch(() => undefined);
      showError(t('登录页面已过期，已经刷新，请重新输入。'));
    } else showError(error instanceof Error ? error.message : t('登录失败，请稍后重试。'));
  }
}
function showEmailStep(focus: HTMLInputElement) {
  setStep('email');
  clearInterval(resendTimer);
  const revision = stepRevision;
  void guarded(loadCaptcha).then(() => { if (stepRevision === revision) focus.focus(); });
}
function showPasswordStep() {
  passwordEmail.value = email.value || sentTo;
  setStep('password');
  showError(); passwordEmail.focus();
}

emailStep.addEventListener('submit', event => {
  event.preventDefault();
  if (sendCode.disabled) return;
  if (!email.checkValidity() || !email.value.trim()) { showError(t('请输入有效的邮箱地址。')); email.focus(); return; }
  if (!/^\d{5}$/u.test(captcha.value.trim())) { showError(t('请输入图中的 5 位数字。')); captcha.focus(); return; }
  if (termsVersion && !acceptTerms.checked) { showError(t('请先阅读并同意使用条款与隐私说明。')); acceptTerms.focus(); return; }
  sendCode.disabled = true;
  const revision = stepRevision, requestedEmail = email.value.trim().toLowerCase();
  void guarded(async () => {
    try {
      const sent = await call<{ email: string; resendAfterSeconds: number; expiresInSeconds: number }>('/api/auth/code',
        { email: requestedEmail, captchaId, captcha: captcha.value.trim() });
      sentTo = sent.email;
      challenge = { email: sent.email, expiresAt: Date.now() + sent.expiresInSeconds * 1000, resendAt: Date.now() + sent.resendAfterSeconds * 1000 };
      if (step === 'email' && stepRevision === revision && email.value.trim().toLowerCase() === requestedEmail) showCodeStep();
      else rememberLogin();
    } catch (error) {
      // Every code request spends its captcha, so a failed attempt always needs a new image.
      await loadCaptcha().catch(() => undefined);
      throw error;
    } finally { sendCode.disabled = !captchaId; }
  });
});
codeStep.addEventListener('submit', event => {
  event.preventDefault();
  if (verify.disabled) return;
  if (!/^\d{6}$/u.test(code.value.trim())) { showError(t('请输入邮件中的 6 位验证码。')); code.focus(); return; }
  verify.disabled = true;
  void guarded(async () => {
    try {
      await call('/api/auth/verify', { email: sentTo, code: code.value.trim(), ...(termsVersion ? { terms: acceptTerms.checked, termsVersion } : {}) });
      clearLogin();
      location.replace(destination);
    } finally { verify.disabled = false; }
  });
});
passwordStep.addEventListener('submit', event => {
  event.preventDefault();
  if (passwordSubmit.disabled) return;
  if (!passwordEmail.checkValidity() || !passwordEmail.value.trim()) { showError(t('请输入有效的邮箱地址。')); passwordEmail.focus(); return; }
  if (!password.value) { showError(t('请输入密码。')); password.focus(); return; }
  if (termsVersion && !acceptTerms.checked) { showError(t('请先阅读并同意使用条款与隐私说明。')); acceptTerms.focus(); return; }
  passwordSubmit.disabled = true;
  void guarded(async () => {
    try {
      await call('/api/auth/password/login', { email: passwordEmail.value, password: password.value,
        ...(termsVersion ? { terms: acceptTerms.checked, termsVersion } : {}) });
      password.value = '';
      clearLogin();
      location.replace(destination);
    } finally { passwordSubmit.disabled = false; }
  });
});
termsStep.addEventListener('submit', event => {
  event.preventDefault();
  if (!acceptTerms.checked) { showError(t('请先阅读并同意使用条款与隐私说明。')); acceptTerms.focus(); return; }
  const button = $<HTMLButtonElement>('#confirm-terms');
  if (button.disabled) return;
  button.disabled = true;
  void guarded(async () => {
    try { await call('/api/auth/terms', { terms: true, termsVersion }); location.replace(destination); }
    finally { button.disabled = false; }
  });
});
function forgetAccountDrafts() {
  clearLogin();
  try { localStorage.setItem('theorem-os.web-account-left.v1', JSON.stringify({ owner: termsOwner, nonce: crypto.randomUUID() })); }
  catch { /* Other tabs also check their session on the next request. */ }
  new OwnedDrafts(() => sessionStorage).clear();
  forgetKey(() => sessionStorage);
  try {
    for (const key of Object.keys(sessionStorage))
      if (key.startsWith('theorem-os.natural-research-draft.v1:') || key.startsWith('theorem-os.chat-draft.') || key === 'theorem-os.research-entry.v1') sessionStorage.removeItem(key);
  } catch { /* Browser storage is optional. */ }
}
$('#terms-logout').addEventListener('click', () => void guarded(async () => {
  await call('/api/auth/logout', {}); forgetAccountDrafts(); acceptTerms.checked = false; await start();
}));
$('#terms-delete-account').addEventListener('click', () => void guarded(async () => {
  const confirmation = $<HTMLInputElement>('#terms-delete-email');
  if (!termsAccount || confirmation.value.trim().toLowerCase() !== termsAccount) {
    showError(t('请输入当前账号的邮箱以确认删除。')); confirmation.focus(); return;
  }
  const button = $<HTMLButtonElement>('#terms-delete-account');
  if (button.disabled) return;
  button.disabled = true;
  try {
    await call('/api/auth/account', { email: termsAccount }, 'DELETE');
    forgetAccountDrafts(); confirmation.value = ''; acceptTerms.checked = false; await start();
  } finally { button.disabled = false; }
}));
code.addEventListener('input', () => { code.value = code.value.replace(/\D/gu, '').slice(0, 6); });
captcha.addEventListener('input', () => { captcha.value = captcha.value.replace(/\D/gu, '').slice(0, 5); });
$('#refresh-captcha').addEventListener('click', () => void guarded(loadCaptcha).then(() => captcha.focus()));
$('#change-email').addEventListener('click', () => showEmailStep(email));
resend.addEventListener('click', () => showEmailStep(captcha));
$('#use-password').addEventListener('click', showPasswordStep);
$('#use-code').addEventListener('click', () => {
  email.value = passwordEmail.value;
  showError();
  if (challenge?.email === email.value.trim().toLowerCase() && showCodeStep()) return;
  showEmailStep(email);
});
void guarded(start);
