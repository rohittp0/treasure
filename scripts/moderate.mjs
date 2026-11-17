// Moderation from a developer machine, with the Admin SDK and your Google Cloud credentials.
// See README, Moderation. Needs `gcloud auth application-default login` with an account that can
// manage Firebase Auth and Firestore on the project.
//
//   node scripts/moderate.mjs ban <uid> "<reason>"   bans an explorer (the same steps as the banExplorer function)
//   node scripts/moderate.mjs admin <uid>             gives an account the admin claim, so it can call banExplorer
//
// Add --project <id> to use another project than treasurehunch.
import { createRequire } from 'node:module';

const require = createRequire(new URL('../functions/package.json', import.meta.url));
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const { banExplorerData } = require('./moderation.js');

const args = process.argv.slice(2);
const projectFlag = args.indexOf('--project');
const projectId = projectFlag >= 0 ? args.splice(projectFlag, 2)[1] : 'treasurehunch';
const [command, uid, ...rest] = args;
if (!['ban', 'admin'].includes(command) || !uid) {
  console.error('Usage: node scripts/moderate.mjs ban <uid> "<reason>" | admin <uid> [--project <id>]');
  process.exit(1);
}

initializeApp({ projectId });
if (command === 'admin') {
  const user = await getAuth().getUser(uid);
  await getAuth().setCustomUserClaims(uid, { ...user.customClaims, admin: true });
  console.log(`${uid} is now an admin on ${projectId}. It takes effect when that account next signs in or refreshes its token.`);
} else {
  const result = await banExplorerData(getFirestore(), getAuth(), uid, { reason: rest.join(' '), bannedBy: 'scripts/moderate.mjs' });
  console.log(`Banned ${uid}${result.username ? ` (@${result.username})` : ''} on ${projectId}; settled ${result.hunts} friend hunts.`);
}
