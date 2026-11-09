// The only two WhatsApp messages TreasureHunch sends, both approved Content templates.
// Template bodies are fixed in Twilio; only {{1}} is filled in here.

// The daily template's {{1}}: newlines and tabs stripped, spaces collapsed, at most 60 characters.
function safeName(username) {
  const name = String(username ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 60).trim();
  return name || 'explorer';
}

function dailyMessage({ from, contentSid, phone, username, statusCallback }) {
  const message = {
    from,
    to: `whatsapp:${phone}`,
    contentSid,
    contentVariables: JSON.stringify({ 1: safeName(username) }),
  };
  if (statusCallback) message.statusCallback = statusCallback;
  return message;
}

function otpMessage({ from, contentSid, phone, code }) {
  if (!/^\d{4,15}$/.test(code)) throw new Error('OTP codes are digits only.');
  return { from, to: `whatsapp:${phone}`, contentSid, contentVariables: JSON.stringify({ 1: code }) };
}

module.exports = { safeName, dailyMessage, otpMessage };
