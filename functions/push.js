// Builds one FCM message that every client can open. `link` must be an absolute https://hunch.rohittp.com/... URL.
// Native apps read data.link on tap; browsers use webpush.fcmOptions.link. Fields for other platforms are ignored
// by FCM, so every token gets the full message and `platform` ('web', 'android' or 'ios'; missing means web)
// does not change the payload today.
const channelFor = link => (new URL(link).searchParams.has('daily') ? 'daily_quest' : 'friend_challenge');

function pushMessage({ token, platform, title, body, link, tag }) {
  void platform;
  const androidNotification = { channelId: channelFor(link) };
  if (tag) androidNotification.tag = tag;
  const aps = { sound: 'default' };
  if (tag) aps['thread-id'] = tag;
  const webpush = { fcmOptions: { link } };
  if (tag) webpush.notification = { tag };
  return {
    token,
    notification: { title, body },
    data: { link },
    android: { priority: 'high', notification: androidNotification },
    apns: { payload: { aps } },
    webpush,
  };
}

module.exports = { pushMessage };
