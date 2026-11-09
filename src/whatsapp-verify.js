// A two-step WhatsApp number check (number, then 6-digit code), shared by sign-in, the username
// dialog, the post-quest prompt and settings. purpose: 'verify_phone' | 'login'.
import { requestWhatsAppOtp, verifyWhatsAppOtp } from './firebase.js';
import { trackEvent, EVENTS } from './events.js';
import { CONSENT_COPY, DEFAULT_COUNTRY, countryOptions, formatCountdown, maskPhone, normalizePhone, otpErrorMessage, otpErrorReason } from './whatsapp.js';

let instances = 0;
let cachedOptions = null;

export function createWhatsAppVerify(container, { purpose, source, requireConsent = false, submitLabel, onVerified }) {
  const id = `wa${++instances}`;
  cachedOptions ||= countryOptions();
  const options = cachedOptions.map(option =>
    `<option value="${option.code}"${option.code === DEFAULT_COUNTRY ? ' selected' : ''}>+${option.callingCode} ${option.name}</option>`).join('');
  container.classList.add('wa-verify');
  container.innerHTML = `
    <div class="wa-step" data-step="phone">
      <label for="${id}-number">WhatsApp number</label>
      <div class="wa-phone-row">
        <select id="${id}-country" class="wa-country" aria-label="Country code">${options}</select>
        <input id="${id}-number" class="wa-number" type="tel" inputmode="tel" autocomplete="tel-national" placeholder="98765 43210" maxlength="24" />
      </div>
      ${requireConsent ? `<label class="wa-consent"><input id="${id}-consent" type="checkbox" /><span>${CONSENT_COPY}</span></label>` : ''}
      <button class="secondary-button wa-send" type="button">${submitLabel || 'Send code on WhatsApp'} <span aria-hidden="true">↗</span></button>
    </div>
    <div class="wa-step hidden" data-step="code">
      <p class="wa-sent"></p>
      <label for="${id}-code">6-digit code</label>
      <input id="${id}-code" class="wa-code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="6" placeholder="••••••" />
      <button class="primary-button wa-confirm" type="button">Verify <span aria-hidden="true">↗</span></button>
      <div class="wa-code-actions">
        <button class="text-button wa-resend" type="button" disabled>Resend code</button>
        <button class="text-button wa-change" type="button">Change number</button>
      </div>
    </div>
    <p class="friend-status wa-status" role="status" aria-live="polite"></p>`;

  const $ = selector => container.querySelector(selector);
  const country = $(`#${id}-country`), number = $(`#${id}-number`), consent = $(`#${id}-consent`);
  const send = $('.wa-send'), code = $('.wa-code'), confirm = $('.wa-confirm'), resend = $('.wa-resend'), status = $('.wa-status');
  let phone = '';
  let busy = false;
  let resendAt = 0;
  let countdown = null;

  const setStatus = (message, state = 'error') => { status.textContent = message; status.dataset.state = message ? state : ''; };
  const showStep = step => container.querySelectorAll('.wa-step').forEach(element => element.classList.toggle('hidden', element.dataset.step !== step));
  const syncSend = () => { send.disabled = busy || (requireConsent && !consent.checked); };

  function tick() {
    const left = (resendAt - Date.now()) / 1000;
    resend.disabled = busy || left > 0;
    resend.textContent = left > 0 ? `Resend code in ${formatCountdown(left)}` : 'Resend code';
    if (left <= 0) { clearInterval(countdown); countdown = null; }
  }
  function startCountdown(seconds) {
    resendAt = Date.now() + Math.max(0, seconds) * 1000;
    clearInterval(countdown);
    countdown = setInterval(() => { if (!container.isConnected) clearInterval(countdown); else tick(); }, 1000);
    tick();
  }

  async function requestCode(isResend = false) {
    if (busy) return;
    const next = isResend ? phone : normalizePhone(number.value, country.value);
    if (!next) { setStatus('Enter a valid WhatsApp number, including the country code.'); number.focus(); return; }
    if (requireConsent && !consent.checked) { setStatus('Tick the box to get the daily quest on WhatsApp.'); return; }
    busy = true; syncSend(); tick();
    setStatus(isResend ? 'Sending a new code…' : 'Sending your code…', 'pending');
    try {
      const result = await requestWhatsAppOtp(next, purpose);
      phone = next;
      trackEvent(EVENTS.WHATSAPP_CODE_REQUESTED, { source, purpose, step: isResend ? 'resend' : 'request' });
      $('.wa-sent').textContent = `We sent a code to ${maskPhone(phone)} on WhatsApp. It expires in 10 minutes.`;
      showStep('code');
      setStatus('');
      startCountdown(Number.isFinite(result?.resendAfter) ? result.resendAfter : 60);
      code.value = '';
      setTimeout(() => code.focus(), 0);
    } catch (error) {
      console.warn('WhatsApp code request failed:', error.code || error);
      trackEvent(EVENTS.WHATSAPP_VERIFY_FAILED, { source, purpose, step: 'request', reason: otpErrorReason(error, 'request') });
      setStatus(otpErrorMessage(error, 'request'));
      if (Number.isFinite(error?.details?.resendAfter) && phone === next) startCountdown(error.details.resendAfter);
    } finally {
      busy = false; syncSend(); tick();
    }
  }

  async function verifyCode() {
    if (busy) return;
    const value = code.value.replace(/\D/g, '');
    if (value.length !== 6) { setStatus('Enter the 6-digit code from WhatsApp.'); code.focus(); return; }
    busy = true; confirm.disabled = true; tick();
    setStatus('Checking your code…', 'pending');
    try {
      const result = await verifyWhatsAppOtp(phone, purpose, value);
      trackEvent(EVENTS.WHATSAPP_VERIFIED, { source, purpose });
      setStatus('');
      clearInterval(countdown);
      await onVerified?.({ phone, ...result, consent: requireConsent ? consent.checked : false });
    } catch (error) {
      console.warn('WhatsApp code check failed:', error.code || error);
      const reason = otpErrorReason(error, 'verify');
      trackEvent(EVENTS.WHATSAPP_VERIFY_FAILED, { source, purpose, step: 'verify', reason });
      setStatus(otpErrorMessage(error, 'verify'));
      if (reason === 'number_taken') showStep('phone');
      code.select();
    } finally {
      busy = false; confirm.disabled = false; tick();
    }
  }

  send.addEventListener('click', () => requestCode(false));
  number.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); requestCode(false); } });
  consent?.addEventListener('change', () => { syncSend(); if (consent.checked && status.dataset.state === 'error') setStatus(''); });
  confirm.addEventListener('click', verifyCode);
  code.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); verifyCode(); } });
  code.addEventListener('input', () => {
    code.value = code.value.replace(/\D/g, '').slice(0, 6);
    if (code.value.length === 6) verifyCode();
  });
  resend.addEventListener('click', () => requestCode(true));
  $('.wa-change').addEventListener('click', () => { clearInterval(countdown); showStep('phone'); setStatus(''); number.focus(); });
  syncSend();

  return {
    focus: () => setTimeout(() => number.focus(), 0),
    destroy: () => { clearInterval(countdown); container.replaceChildren(); },
  };
}
