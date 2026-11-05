import { createIcons, LogIn, MailCheck, RefreshCw } from 'lucide';
import type { WebSession } from '../shared';
import { localizeMessage, mountLocaleSwitch, t } from '../i18n';
import { localizeSiteLinks } from './feedback';
import { forgetKey } from './keyMemory';

createIcons({ icons: { LogIn, MailCheck, RefreshCw }, attrs: { 'aria-hidden': 'true' } });
const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
mountLocaleSwitch($<HTMLButtonElement>('#locale-switch'));
localizeSiteLinks();
const emailStep = $<HTMLFormElement>('#email-step'), codeStep = $<HTMLFormElement>('#code-step'), passwordStep = $<HTMLFormElement>('#password-step');
const email = $<HTMLInputElement>('#login-email'), captcha = $<HTMLInputElement>('#login-captcha'), code = $<HTMLInputElement>('#login-code');
const sendCode = $<HTMLButtonElement>('#send-code'), verify = $<HTMLButtonElement>('#verify-code'), resend = $<HTMLButtonElement>('#resend-code');
const passwordEmail = $<HTMLInputElement>('#password-email'), password = $<HTMLInputElement>('#login-password');
const passwordSubmit = $<HTMLButtonElement>('#password-submit');
let csrf = '', captchaId = '', sentTo = '', resendTimer: ReturnType<typeof setInterval> | undefined;
// A run link opened while signed out arrives as login.html?run=<id>; signing in returns to that run.
const linkedRun = new URLSearchParams(location.search).get('run');
const workbench = linkedRun && /^[a-f0-9-]{1,36}$/u.test(linkedRun) ? `./?run=${linkedRun}` : './';

/** `message` is what the visitor sees; `reason` keeps the server's own text for the session check. */
class LoginError extends Error {
  constructor(readonly reason: string, readonly status: number) { super(localizeMessage(reason)); }
}
async function call<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
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
  if (session.auth !== 'email' || session.account) { location.replace(workbench); return; }
  // Signed out, the workbench is not loaded at all, so the tab's remembered API Key is cleared here.
  forgetKey(() => sessionStorage);
  csrf = session.csrfToken;
  await loadCaptcha();
}
/** An expired login-page session is replaced; the visitor only has to repeat the current step. */
async function guarded(action: () => Promise<void>) {
  showError();
  try { await action(); }
  catch (error) {
    if (error instanceof LoginError && [401, 403].includes(error.status) && /会话/u.test(error.reason)) {
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
      await call('/api/auth/verify', { email: sentTo, code: code.value.trim() });
      location.replace(workbench);
    } finally { verify.disabled = false; }
  });
});
passwordStep.addEventListener('submit', event => {
  event.preventDefault();
  if (passwordSubmit.disabled) return;
  if (!passwordEmail.checkValidity() || !passwordEmail.value.trim()) { showError(t('请输入有效的邮箱地址。')); passwordEmail.focus(); return; }
  if (!password.value) { showError(t('请输入密码。')); password.focus(); return; }
  passwordSubmit.disabled = true;
  void guarded(async () => {
    try {
      await call('/api/auth/password/login', { email: passwordEmail.value, password: password.value });
      password.value = '';
      location.replace(workbench);
    } finally { passwordSubmit.disabled = false; }
  });
});
code.addEventListener('input', () => { code.value = code.value.replace(/\D/gu, '').slice(0, 6); });
captcha.addEventListener('input', () => { captcha.value = captcha.value.replace(/\D/gu, '').slice(0, 5); });
$('#refresh-captcha').addEventListener('click', () => void guarded(loadCaptcha).then(() => captcha.focus()));
$('#change-email').addEventListener('click', () => showEmailStep(email));
resend.addEventListener('click', () => showEmailStep(captcha));
$('#use-password').addEventListener('click', showPasswordStep);
$('#use-code').addEventListener('click', () => { email.value = passwordEmail.value; showEmailStep(email); });
void guarded(start);
