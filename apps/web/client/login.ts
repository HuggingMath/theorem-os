import { createIcons, LogIn, MailCheck, RefreshCw } from 'lucide';
import type { WebSession } from '../shared';
import { mountLocaleSwitch, t } from '../i18n';

createIcons({ icons: { LogIn, MailCheck, RefreshCw }, attrs: { 'aria-hidden': 'true' } });
const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
mountLocaleSwitch($<HTMLButtonElement>('#locale-switch'));
const emailStep = $<HTMLFormElement>('#email-step'), codeStep = $<HTMLFormElement>('#code-step');
const email = $<HTMLInputElement>('#login-email'), captcha = $<HTMLInputElement>('#login-captcha'), code = $<HTMLInputElement>('#login-code');
const sendCode = $<HTMLButtonElement>('#send-code'), verify = $<HTMLButtonElement>('#verify-code'), resend = $<HTMLButtonElement>('#resend-code');
let csrf = '', captchaId = '', sentTo = '', resendTimer: ReturnType<typeof setInterval> | undefined;

class LoginError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
async function call<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
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
  if (session.auth !== 'email' || session.account) { location.replace('./'); return; }
  csrf = session.csrfToken;
  await loadCaptcha();
}
/** An expired login-page session is replaced; the visitor only has to repeat the current step. */
async function guarded(action: () => Promise<void>) {
  showError();
  try { await action(); }
  catch (error) {
    if (error instanceof LoginError && [401, 403].includes(error.status) && /会话/u.test(error.message)) {
      await start().catch(() => undefined);
      showError(t('登录页面已过期，已经刷新，请重新输入。'));
    } else showError(error instanceof Error ? error.message : t('登录失败，请稍后重试。'));
  }
}
function showEmailStep(focus: HTMLInputElement) {
  codeStep.hidden = true; emailStep.hidden = false;
  clearInterval(resendTimer);
  void guarded(loadCaptcha).then(() => focus.focus());
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
      location.replace('./');
    } finally { verify.disabled = false; }
  });
});
code.addEventListener('input', () => { code.value = code.value.replace(/\D/gu, '').slice(0, 6); });
captcha.addEventListener('input', () => { captcha.value = captcha.value.replace(/\D/gu, '').slice(0, 5); });
$('#refresh-captcha').addEventListener('click', () => void guarded(loadCaptcha).then(() => captcha.focus()));
$('#change-email').addEventListener('click', () => showEmailStep(email));
resend.addEventListener('click', () => showEmailStep(captcha));
void guarded(start);
