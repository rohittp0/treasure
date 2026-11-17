// The Report and Block sheet, opened from a received challenge, a friend-hunt result or another explorer's map.
// Blocking also files a report, so the developer sees every block too (spec decision 22).
import { trackEvent, EVENTS } from './events.js';
import { escapeHTML } from './friend-result.js';
import { blockExplorer, reportExplorer } from './firebase.js';
import { BLOCK_REASON, REPORT_OPTIONS, reportReason } from './moderation.js';

const $ = selector => document.querySelector(selector);
// The report kind a block files, by where the block was made.
const BLOCK_KIND = { challenge: 'clue', hunt: 'hunt', map: 'profile' };

// target: { uid, name (shown, e.g. '@scout'), context: 'challenge' | 'hunt' | 'map', code?, kind? (files every report
// as this kind), source: 'inbox' | 'result' | 'clues' | 'map' }
export function createModerationDialog({ getUser, requestSignIn, showToast, onBlocked = () => {} }) {
  const dialog = $('#moderation-dialog');
  let target = null;

  const setStatus = message => { const status = $('#moderation-status'); if (status) status.textContent = message; };
  const setBusy = busy => dialog.querySelectorAll('#moderation-content button, #moderation-content input, #moderation-content textarea')
    .forEach(element => { element.disabled = busy; });

  function open(action, next) {
    const player = getUser();
    if (!player) { requestSignIn(); return; }
    if (!next?.uid || next.uid === player.uid) return;
    target = next;
    const who = escapeHTML(next.name || 'this explorer');
    if (action === 'block') renderBlock(who);
    else renderReport(who);
    if (!dialog.open) dialog.showModal();
  }

  function renderReport(who) {
    const options = REPORT_OPTIONS[target.context] || REPORT_OPTIONS.hunt;
    $('#moderation-kicker').textContent = '✦   REPORT';
    $('#moderation-content').innerHTML = `<h2>Report <em>${who}.</em></h2>
      <p>Tell us what's wrong. We review every report within 24 hours and remove anything that breaks the <a href="/terms.html" target="_blank" rel="noopener">Terms of Use</a>.</p>
      <form id="moderation-form">
        <fieldset class="moderation-options"><legend>What's wrong?</legend>${options.map((option, index) =>
          `<label class="wa-consent"><input type="radio" name="moderation-reason" value="${option.id}"${index === 0 ? ' checked' : ''} /><span>${escapeHTML(option.label)}</span></label>`).join('')}</fieldset>
        <label class="moderation-label" for="moderation-details">Details <small>optional</small></label>
        <textarea id="moderation-details" maxlength="150" placeholder="Anything that helps us find it"></textarea>
        <label class="wa-consent"><input id="moderation-also-block" type="checkbox" /><span>Also block ${who}</span></label>
        <p id="moderation-status" class="friend-status" role="status" aria-live="polite"></p>
        <button class="primary-button" type="submit">Send report <span aria-hidden="true">↗</span></button>
      </form>`;
    $('#moderation-form').addEventListener('submit', async event => {
      event.preventDefault();
      const chosen = $('#moderation-form').querySelector('input[name="moderation-reason"]:checked')?.value;
      const option = options.find(item => item.id === chosen) || options[0];
      const alsoBlock = $('#moderation-also-block').checked;
      const reason = reportReason(option, $('#moderation-details').value);
      await submit(async (player, current) => {
        if (alsoBlock) await block(player, current);
        await reportExplorer(player, { targetUid: current.uid, kind: current.kind || option.kind, code: current.code, reason });
        trackEvent(EVENTS.REPORT_SENT, { source: current.source, reason: option.id });
      }, alsoBlock ? `Thanks. ${target.name || 'This explorer'} is blocked, and we'll review your report within 24 hours.`
        : "Thanks. We'll review your report within 24 hours.", alsoBlock);
    });
  }

  function renderBlock(who) {
    $('#moderation-kicker').textContent = '✦   BLOCK';
    $('#moderation-content').innerHTML = `<h2>Block <em>${who}?</em></h2>
      <p>Their challenges and your friend hunts with them disappear from your log, and their challenges won't reach you. We'll also review their content.</p>
      <p id="moderation-status" class="friend-status" role="status" aria-live="polite"></p>
      <button id="moderation-block" class="primary-button" type="button">Block <span aria-hidden="true">↗</span></button>
      <button id="moderation-cancel" class="secondary-button" type="button">Cancel</button>`;
    $('#moderation-cancel').addEventListener('click', () => dialog.close());
    $('#moderation-block').addEventListener('click', () => submit(async (player, current) => {
      await block(player, current);
      // The block already hides them; the report only lets the developer look, so a failure is not the explorer's problem.
      await reportExplorer(player, { targetUid: current.uid, kind: current.kind || BLOCK_KIND[current.context] || 'profile', code: current.code, reason: BLOCK_REASON })
        .catch(error => console.warn('The report for this block was not sent:', error));
    }, `${target.name || 'This explorer'} is blocked.`, true));
  }

  async function block(player, current) {
    await blockExplorer(player, current.uid);
    trackEvent(EVENTS.EXPLORER_BLOCKED, { source: current.source });
  }

  async function submit(action, done, blocked) {
    const player = getUser();
    if (!player) { dialog.close(); requestSignIn(); return; }
    // Kept apart from `target`, which closing the sheet clears while the request is still running.
    const current = target;
    if (!current) return;
    setBusy(true);
    setStatus('Sending…');
    try {
      await action(player, current);
    } catch (error) {
      console.error(error);
      setBusy(false);
      setStatus(blocked ? 'That did not go through. Try again.' : 'Your report could not be sent. Try again.');
      return;
    }
    dialog.close();
    showToast(done);
    if (blocked) onBlocked(current);
  }

  $('#close-moderation').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { target = null; $('#moderation-content').replaceChildren(); });
  return { open };
}
