import { createIcons, LogIn, MailCheck, RefreshCw } from 'lucide';
import { workbenchReturn, type WebSession } from '../shared';
import { localizeMessage, mountLocaleSwitch, t } from '../i18n';
import { localizeSiteLinks } from './feedback';
import { forgetKey } from './keyMemory';
import { OwnedDrafts } from './ownedDrafts';

createIcons({ icons: { LogIn, MailCheck, RefreshCw }, attrs: { 'aria-hidden': 'true' } });
const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
mountLocaleSwitch($<HTMLButtonElement>('#locale-switch'));
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
// A run or conversation link opened while signed out, or open when the session ended, arrives as login.html?run=<id> or
// ?chat=<id>; signing in returns to that record.
const workbench = `./${workbenchReturn(location.search)}`;

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
async function loadCaptcha() {
  captcha.value = ''; sendCode.disabled = true;
  const next = await call<{ id: string; image: string }>('/api/auth/captcha', {});
  captchaId = next.id; $<HTMLImageElement>('#captcha-image').src = next.image;
  sendCode.disabled = false;
}
async function start() {
  const session = await call<WebSession>('/api/session');
  if (session.auth !== 'email' || (session.account && !session.termsRequired)) { location.replace(workbench); return; }
  $('#login-access').hidden = session.signup === 'open' || Boolean(session.termsRequired);
  csrf = session.csrfToken;
  if (termsVersion !== session.termsVersion) acceptTerms.checked = false;
  termsVersion = session.termsVersion;
  termsAccount = session.account?.email;
  termsOwner = session.draftOwner ?? (session.account ? `account:${session.account.email}` : undefined);
  termsOption.hidden = !termsVersion;
  const wasTerms = !termsStep.hidden;
  termsStep.hidden = !session.termsRequired;
  if (session.termsRequired) {
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
    ? t('用邮箱注册或登录：输入邮箱，收到 6 位验证码即可开始。第一次登录会自动创建账号。')
    : t('内测期间仅限已通过申请的邮箱。可用邮箱验证码或已设置的密码登录。');
  // The password form waits for the session cookie and CSRF token; sent earlier, it reads as an expired page.
  passwordSubmit.disabled = false;
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
  codeStep.hidden = true; passwordStep.hidden = true; emailStep.hidden = false;
  clearInterval(resendTimer);
  void guarded(loadCaptcha).then(() => focus.focus());
}
function showPasswordStep() {
  emailStep.hidden = true; codeStep.hidden = true; passwordStep.hidden = false;
  passwordEmail.value = email.value || sentTo;
  showError(); passwordEmail.focus();
}

emailStep.addEventListener('submit', event => {
  event.preventDefault();
  if (sendCode.disabled) return;
  if (!email.checkValidity() || !email.value.trim()) { showError(t('请输入有效的邮箱地址。')); email.focus(); return; }
  if (!/^\d{5}$/u.test(captcha.value.trim())) { showError(t('请输入图中的 5 位数字。')); captcha.focus(); return; }
  if (termsVersion && !acceptTerms.checked) { showError(t('请先阅读并同意使用条款与隐私说明。')); acceptTerms.focus(); return; }
  sendCode.disabled = true;
  void guarded(async () => {
    try {
      const sent = await call<{ email: string; resendAfterSeconds: number; expiresInSeconds: number }>('/api/auth/code',
        { email: email.value, captchaId, captcha: captcha.value.trim() });
      sentTo = sent.email;
      $('#code-sent').textContent = t('验证码已发送至 {0}，{1} 分钟内有效。', sent.email, Math.round(sent.expiresInSeconds / 60));
      emailStep.hidden = true; codeStep.hidden = false; code.value = ''; code.focus();
      let left = sent.resendAfterSeconds;
      resend.disabled = true; resend.textContent = t('{0} 秒后可重新发送', left);
      clearInterval(resendTimer);
      resendTimer = setInterval(() => {
        left--;
        if (left > 0) { resend.textContent = t('{0} 秒后可重新发送', left); return; }
        clearInterval(resendTimer); resend.disabled = false; resend.textContent = t('重新发送');
      }, 1000);
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
      location.replace(workbench);
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
      location.replace(workbench);
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
    try { await call('/api/auth/terms', { terms: true, termsVersion }); location.replace(workbench); }
    finally { button.disabled = false; }
  });
});
function forgetAccountDrafts() {
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
$('#use-code').addEventListener('click', () => { email.value = passwordEmail.value; showEmailStep(email); });
void guarded(start);
