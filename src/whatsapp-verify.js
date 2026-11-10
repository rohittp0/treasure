// A two-step WhatsApp number check (number, then 6-digit code), shared by sign-in, the username
// dialog, the post-quest prompt and settings. purpose: 'verify_phone' | 'login'.
// consent: 'none' | 'required' (the box must be ticked to send a code) | 'optional' (an unticked offer).
import { requestWhatsAppOtp, verifyWhatsAppOtp } from './firebase.js';
import { trackEvent, EVENTS } from './events.js';
import { CONSENT_COPY, countryFromNumber, countryOptions, detectCountry, formatCountdown, loadStoredCountry, maskPhone, normalizePhone, otpErrorMessage, otpErrorReason, storeCountry } from './whatsapp.js';

// The chat that the code arrives in. Must match WHATSAPP_FROM in functions/.env.treasurehunch.
const SENDER_CHAT_URL = 'https://wa.me/12296143014';

let instances = 0;
const optionsByFirst = new Map();

// The hunch_otp "Copy code" button copies the bare digits; anything else on the clipboard is ignored.
const clipboardCode = text => {
  const digits = String(text ?? '').replace(/\s+/g, '');
  return /^\d{6}$/.test(digits) ? digits : '';
};
const canReadClipboard = () => typeof navigator !== 'undefined' && typeof navigator.clipboard?.readText === 'function';

export function createWhatsAppVerify(container, { purpose, source, consent: consentMode = 'none', requireConsent = false, submitLabel, onVerified }) {
  if (requireConsent) consentMode = 'required';
  const id = `wa${++instances}`;
  const initialCountry = detectCountry({ stored: loadStoredCountry() });
  if (!optionsByFirst.has(initialCountry)) optionsByFirst.set(initialCountry, countryOptions(undefined, initialCountry));
  const options = optionsByFirst.get(initialCountry).map(option =>
    `<option value="${option.code}"${option.code === initialCountry ? ' selected' : ''}>+${option.callingCode} ${option.name}</option>`).join('');
  container.classList.add('wa-verify');
  container.innerHTML = `
    <div class="wa-step" data-step="phone">
      <label for="${id}-number">WhatsApp number</label>
      <div class="wa-phone-row">
        <select id="${id}-country" class="wa-country" aria-label="Country code">${options}</select>
        <input id="${id}-number" class="wa-number" type="tel" inputmode="tel" autocomplete="tel" placeholder="Your number" maxlength="24" />
      </div>
      ${consentMode !== 'none' ? `<label class="wa-consent"><input id="${id}-consent" type="checkbox" /><span>${CONSENT_COPY}</span></label>` : ''}
      <button class="${consentMode === 'optional' ? 'primary-button' : 'secondary-button'} wa-send" type="button">${submitLabel || 'Send code on WhatsApp'} <span aria-hidden="true">↗</span></button>
    </div>
    <div class="wa-step hidden" data-step="code">
      <p class="wa-sent"></p>
      <div class="wa-code-shortcuts">
        <a class="secondary-button wa-open" href="${SENDER_CHAT_URL}" target="_blank" rel="noopener">Open WhatsApp</a>
        ${canReadClipboard() ? '<button class="secondary-button wa-paste" type="button">Paste code</button>' : ''}
      </div>
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
  const paste = $('.wa-paste');
  let phone = '';
  let busy = false;
  let resendAt = 0;
  let countdown = null;
  let step = 'phone';
  // Codes already checked in this flow, so a stale clipboard never burns another attempt.
  const triedCodes = new Set();

  const setStatus = (message, state = 'error') => { status.textContent = message; status.dataset.state = message ? state : ''; };
  const showStep = next => {
    step = next;
    container.querySelectorAll('.wa-step').forEach(element => element.classList.toggle('hidden', element.dataset.step !== next));
  };
  const syncSend = () => { send.disabled = busy || (consentMode === 'required' && !consent.checked); };

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
    if (consentMode === 'required' && !consent.checked) { setStatus('Tick the box to get the daily quest on WhatsApp.'); return; }
    busy = true; syncSend(); tick();
    setStatus(isResend ? 'Sending a new code…' : 'Sending your code…', 'pending');
    try {
      const result = await requestWhatsAppOtp(next, purpose);
      phone = next;
      storeCountry(country.value);
      triedCodes.clear();
      trackEvent(EVENTS.WHATSAPP_CODE_REQUESTED, { source, purpose, step: isResend ? 'resend' : 'request' });
      $('.wa-sent').textContent = `We sent a code to ${maskPhone(phone)} on WhatsApp. Tap Copy code there and come back: we'll fill it in.`;
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
    triedCodes.add(value);
    setStatus('Checking your code…', 'pending');
    try {
      const result = await verifyWhatsAppOtp(phone, purpose, value);
      trackEvent(EVENTS.WHATSAPP_VERIFIED, { source, purpose });
      setStatus('');
      clearInterval(countdown);
      step = 'done';
      await onVerified?.({ phone, ...result, consent: consent ? consent.checked : false });
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

  function useCode(value) {
    if (!value || busy || step !== 'code' || triedCodes.has(value)) return false;
    code.value = value;
    verifyCode();
    return true;
  }

  // Coming back from WhatsApp after tapping "Copy code": read the clipboard and verify straight away.
  // Chrome asks once for clipboard access; browsers that only allow it from a tap fail quietly here
  // and the Paste code button covers them.
  let reading = false;
  async function readClipboardOnReturn() {
    if (!container.isConnected) { stopListening(); return; }
    if (step !== 'code' || busy || reading || document.visibilityState !== 'visible' || !canReadClipboard()) return;
    reading = true;
    try {
      const value = clipboardCode(await navigator.clipboard.readText());
      if (value && useCode(value)) trackEvent(EVENTS.WHATSAPP_CODE_PASTED, { source, purpose, method: 'auto' });
    } catch { /* Not focused yet, denied, or needs a tap. */ }
    finally { reading = false; }
  }
  const onReturn = () => { readClipboardOnReturn(); };
  const stopListening = () => {
    document.removeEventListener('visibilitychange', onReturn);
    window.removeEventListener('focus', onReturn);
  };
  document.addEventListener('visibilitychange', onReturn);
  window.addEventListener('focus', onReturn);

  paste?.addEventListener('click', async () => {
    let value = '';
    try { value = clipboardCode(await navigator.clipboard.readText()); } catch { /* Denied or dismissed. */ }
    if (!value) { setStatus('Tap Copy code in the WhatsApp message first, then tap Paste code.'); return; }
    if (triedCodes.has(value)) { setStatus('That code was already tried. Copy the newest code from WhatsApp.'); return; }
    trackEvent(EVENTS.WHATSAPP_CODE_PASTED, { source, purpose, method: 'button' });
    useCode(value);
  });

  // A number typed, pasted or autofilled with its country code moves the picker to that country.
  number.addEventListener('input', () => {
    const detected = countryFromNumber(number.value, country.value);
    if (detected && detected !== country.value && country.querySelector(`option[value="${detected}"]`)) country.value = detected;
  });
  country.addEventListener('change', () => storeCountry(country.value));
  send.addEventListener('click', () => requestCode(false));
  number.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); requestCode(false); } });
  consent?.addEventListener('change', () => { syncSend(); if (consent.checked && status.dataset.state === 'error') setStatus(''); });
  confirm.addEventListener('click', verifyCode);
  code.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); verifyCode(); } });
  code.addEventListener('input', () => {
    code.value = code.value.replace(/\D/g, '').slice(0, 6);
    if (code.value.length === 6 && !triedCodes.has(code.value)) verifyCode();
  });
  resend.addEventListener('click', () => requestCode(true));
  $('.wa-change').addEventListener('click', () => { clearInterval(countdown); showStep('phone'); setStatus(''); number.focus(); });
  syncSend();

  return {
    focus: () => setTimeout(() => number.focus(), 0),
    destroy: () => { stopListening(); clearInterval(countdown); container.replaceChildren(); },
  };
}
