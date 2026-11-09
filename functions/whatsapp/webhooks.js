// Twilio webhooks: incoming WhatsApp messages (STOP replies) and delivery status callbacks.
const { normalizePhone, maskPhone } = require('./phone');
const { OPT_OUT_ERRORS, optOut } = require('./send');

const STOP_KEYWORDS = new Set(['stop', 'unsubscribe', 'cancel', 'stop promotions']);
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

const isStopMessage = text => STOP_KEYWORDS.has(String(text ?? '').trim().replace(/\s+/g, ' ').toLowerCase());

// Twilio signs the full URL it called plus the POST fields. The canonical URL is the one set in the
// Twilio Console and passed as statusCallback; the request's own host is a fallback for other routes.
function validSignature({ validateRequest, authToken, request, canonicalUrl }) {
  const signature = request.get?.('x-twilio-signature') || request.headers?.['x-twilio-signature'];
  if (!signature || !authToken) return false;
  const params = request.body && typeof request.body === 'object' ? request.body : {};
  const host = request.get?.('x-forwarded-host') || request.get?.('host');
  const candidates = [canonicalUrl];
  if (host) candidates.push(`https://${host}${request.originalUrl || request.url || ''}`);
  return candidates.some(url => url && validateRequest(authToken, signature, url, params));
}

async function ownerOf(db, phone) {
  const owner = await db.doc(`whatsappPhones/${phone}`).get();
  if (owner.exists) return owner.data().uid;
  const users = await db.collection('users').where('whatsapp.phone', '==', phone).limit(1).get();
  return users.empty ? null : users.docs[0].id;
}

function createWebhookHandlers({ db, validateRequest, authToken, urls, clock = () => new Date(), log = console }) {
  async function inbound(request, response) {
    if (request.method !== 'POST') { response.status(405).send(''); return; }
    if (!validSignature({ validateRequest, authToken, request, canonicalUrl: urls.inbound })) {
      response.status(403).send('Invalid signature');
      return;
    }
    const body = request.body || {};
    if (isStopMessage(body.Body) || isStopMessage(body.ButtonText) || isStopMessage(body.ButtonPayload)) {
      const phone = normalizePhone(body.From);
      const uid = phone ? await ownerOf(db, phone) : null;
      if (uid) {
        await optOut(db, uid, clock());
        log.log(`WhatsApp opt-out by reply from ${maskPhone(phone)}.`);
      }
    }
    response.type('text/xml').send(EMPTY_TWIML);
  }

  async function status(request, response) {
    if (request.method !== 'POST') { response.status(405).send(''); return; }
    if (!validSignature({ validateRequest, authToken, request, canonicalUrl: urls.status })) {
      response.status(403).send('Invalid signature');
      return;
    }
    const { MessageSid, MessageStatus, ErrorCode } = request.body || {};
    if (typeof MessageSid === 'string' && /^[A-Za-z0-9]{10,64}$/.test(MessageSid)) {
      const lookup = (await db.doc(`whatsappMessages/${MessageSid}`).get()).data();
      if (lookup?.marker) {
        const code = Number(ErrorCode) || null;
        await db.doc(lookup.marker).update({ status: String(MessageStatus || '').slice(0, 32), errorCode: code, updatedAt: clock() })
          .catch(() => {});
        if (OPT_OUT_ERRORS.has(code) && lookup.uid) await optOut(db, lookup.uid, clock()).catch(() => {});
      }
    }
    response.status(200).send('');
  }

  return { inbound, status };
}

module.exports = { STOP_KEYWORDS, EMPTY_TWIML, isStopMessage, validSignature, createWebhookHandlers };
