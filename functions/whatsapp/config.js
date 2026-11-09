// Parameters, secrets and the Twilio client factory shared by every WhatsApp function.
const { defineSecret, defineString } = require('firebase-functions/params');

const twilioAccountSid = defineSecret('TWILIO_ACCOUNT_SID');
const twilioAuthToken = defineSecret('TWILIO_AUTH_TOKEN');
const otpHmacKey = defineSecret('OTP_HMAC_KEY');
const whatsappFrom = defineString('WHATSAPP_FROM');
const whatsappDailyContentSid = defineString('WHATSAPP_DAILY_CONTENT_SID');
const whatsappOtpContentSid = defineString('WHATSAPP_OTP_CONTENT_SID');

const REGION = 'us-central1';
const projectId = () => process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || 'treasurehunch';
// Twilio signs the exact URL it calls, so webhooks are always configured and validated with this form.
const functionUrl = name => `https://${REGION}-${projectId()}.cloudfunctions.net/${name}`;

function twilioClient() {
  const twilio = require('twilio');
  return twilio(twilioAccountSid.value(), twilioAuthToken.value());
}

function whatsappParams() {
  return {
    from: whatsappFrom.value(),
    dailyContentSid: whatsappDailyContentSid.value(),
    otpContentSid: whatsappOtpContentSid.value(),
  };
}

module.exports = {
  REGION, twilioAccountSid, twilioAuthToken, otpHmacKey,
  whatsappFrom, whatsappDailyContentSid, whatsappOtpContentSid,
  functionUrl, twilioClient, whatsappParams,
};
