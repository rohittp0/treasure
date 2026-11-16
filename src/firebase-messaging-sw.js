import { initializeApp } from 'firebase/app';
import { getMessaging, onBackgroundMessage } from 'firebase/messaging/sw';

const app = initializeApp({
  apiKey: 'AIzaSyCDEJwlHrSfeSzfLwehsTFhCjOJOFayEc4',
  authDomain: 'treasurehunch.firebaseapp.com',
  projectId: 'treasurehunch',
  messagingSenderId: '555455406222',
  appId: '1:555455406222:web:f8b265135bd4bfa327a9df',
});

// Firebase shows the notification itself. An installed app also gets a mark on its icon, which the page
// clears once today's quest has been played (iOS and desktop; Android has no icon badges for web apps).
onBackgroundMessage(getMessaging(app), () => {
  try { self.navigator.setAppBadge?.(1)?.catch(() => {}); } catch { /* Badges are decoration. */ }
});
