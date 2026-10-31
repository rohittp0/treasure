import { trackEvent, EVENTS } from './events.js';
import { friendResult, resultContent } from './friend-result.js';
import { renderVictoryPoster, sharePosterFile } from './friend-poster.js';
import * as maplibregl from 'maplibre-gl';
import { canRevealFriendCountry, canUnlockFriendClue, friendRoundSeconds, friendSecondsLeft, makeHuntCode, normaliseHuntCode, validHuntCode } from './friend.js';
import { createFriendHunt, findUsername, getFriendHunt, joinFriendHunt, loadFriendAnswer, revealFriendCountry, submitFriendGuess, timeOutFriendHunt, unlockFriendClue, watchFriendHunt } from './firebase.js';

const $ = selector => document.querySelector(selector);
const friendScreens = ['#friend-lobby', '#friend-hide', '#friend-wait', '#friend-result'];
const escapeHTML = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

export function createFriendController({ getUser, getUsername, getMap, getCountries, showToast, playVictory, clearVictory, requestSignIn, requestUsername, clearMapSelection, setSheetCollapsed }) {
  let mode = 'idle';
  let code = '';
  let match = null;
  let answer = null;
  let hiddenPlace = null;
  let selected = null;
  let unsubscribe = null;
  let ticker = null;
  let marker = null;
  let busy = false;
  let timeoutPending = false;
  let pendingLobby = false;
  let pendingHidePlace = null;
  let suppressSearchZoom = false;
  let searchZoomTimeout;
  let animatedWinCode = '';
  let posterPromise = null;
  let resultSource = 'live';
  let observedPlayingCode = '';
  let pendingResult = false;
  let pendingInvite = normaliseHuntCode(new URLSearchParams(location.search).get('hunt'));
  let inviteHandled = false;

  function eventParameters(value = match) {
    if (!value) return { mode: 'multiplayer' };
    const role = getUser()?.uid === value.hiderUid ? 'hider' : getUser()?.uid === value.seekerUid ? 'seeker' : 'spectator';
    return { mode: 'multiplayer', role, round_seconds: friendRoundSeconds(value),
      time_remaining: friendSecondsLeft(value), clues_opened: value.cluesVisible,
      wrong_guesses: value.wrongGuesses, revealed: value.revealed };
  }

  function showScreen(selector) {
    const openingGame = selector === '#game-panel' && $('#game-panel').classList.contains('hidden');
    $('#home-screen').classList.toggle('hidden', selector !== '#home-screen');
    $('#result-screen').classList.add('hidden');
    $('#leaderboard-screen').classList.add('hidden');
    $('#game-panel').classList.toggle('hidden', selector !== '#game-panel');
    $('#game-hud').classList.toggle('hidden', selector !== '#game-panel');
    for (const screen of friendScreens) $(screen).classList.toggle('hidden', selector !== screen);
    document.body.classList.toggle('in-game', selector === '#game-panel');
    document.body.classList.remove('solo-game');
    $('#end-level-button').classList.add('hidden');
    $('#cancel-setup-button').classList.toggle('hidden', selector !== '#friend-hide');
    document.body.classList.toggle('in-hide', selector === '#friend-hide');
    if (selector !== '#friend-hide') document.body.classList.remove('hide-collapsed');
    if (openingGame) {
      setSheetCollapsed(false);
      getMap()?.resize();
    }
  }

  function setHideCollapsed(collapsed) {
    document.body.classList.toggle('hide-collapsed', collapsed);
    $('#friend-hide-toggle').setAttribute('aria-expanded', String(!collapsed));
    $('#friend-hide-toggle').setAttribute('aria-label', collapsed ? 'Show hunt setup' : 'Minimise hunt setup');
    $('#friend-hide-toggle-action').textContent = collapsed ? 'Add clues ↑' : 'Minimise ↓';
  }

  function setMapCountry(id) {
    const map = getMap();
    if (map?.getLayer('selected-country')) map.setFilter('selected-country', ['==', ['get', 'id'], id || '']);
  }

  function clearPin() {
    marker?.remove();
    marker = null;
    clearMapSelection();
  }

  function setHiddenPlace(place) {
    hiddenPlace = place;
    $('#friend-place').innerHTML = `<span>✦ Pin dropped in</span><strong>${escapeHTML(place.country)}</strong>`;
    $('#friend-hide-peek').textContent = `Pin in ${place.country} · add your three clues.`;
    $('#friend-country-search').value = place.country;
    $('#friend-search-results').classList.add('hidden');
    setMapCountry(place.id);
    marker?.remove();
    marker = new maplibregl.Marker({ color: '#c87948' }).setLngLat([place.lng, place.lat]).addTo(getMap());
  }

  function focusSearchPlace(feature) {
    const { labelX, labelY } = feature.properties;
    setHiddenPlace({ id: feature.properties.id, country: feature.properties.name, lng: labelX, lat: labelY });
    const map = getMap();
    map.stop();
    suppressSearchZoom = true;
    clearTimeout(searchZoomTimeout);
    map.once('moveend', () => { suppressSearchZoom = false; clearTimeout(searchZoomTimeout); });
    searchZoomTimeout = setTimeout(() => { suppressSearchZoom = false; }, 1500);
    map.flyTo({ center: [labelX, labelY], zoom: Math.max(map.getZoom(), 3) });
  }

  function mapCountry(feature, lngLat) {
    if (mode === 'hiding') {
      setHiddenPlace({ id: feature.properties.id, country: feature.properties.name, lng: lngLat.lng, lat: lngLat.lat });
      return true;
    }
    if (mode !== 'seeker' || match?.status !== 'playing') return false;
    const id = feature.properties.id;
    if (match.triedIds.includes(id)) {
      showToast('You already ruled that country out.');
      return true;
    }
    trackEvent(EVENTS.COUNTRY_SELECTED, { ...eventParameters(), method: 'map' });
    selected = { id, country: feature.properties.name };
    setMapCountry(id);
    $('#selection-name').textContent = selected.country;
    $('#selection-card').classList.remove('hidden');
    return true;
  }

  function searchCountries() {
    const query = $('#friend-country-search').value.trim().toLocaleLowerCase();
    const results = $('#friend-search-results');
    if (hiddenPlace && $('#friend-country-search').value !== hiddenPlace.country) {
      hiddenPlace = null;
      clearPin();
      $('#friend-place').textContent = 'Tap the map or choose a search result.';
      $('#friend-hide-peek').textContent = 'Tap the map or search for a country.';
    }
    if (!query || !getCountries()) { results.classList.add('hidden'); return; }
    const matches = getCountries().features
      .filter(feature => feature.properties.name.toLocaleLowerCase().includes(query))
      .slice(0, 6);
    results.innerHTML = matches.length
      ? matches.map(feature => `<button type="button" data-id="${feature.properties.id}">${escapeHTML(feature.properties.name)}</button>`).join('')
      : '<span>No matching countries on this map.</span>';
    results.classList.remove('hidden');
  }

  function clearActive() {
    if (mode === 'seeker' && match?.status === 'playing') trackEvent(EVENTS.HUNT_ABANDONED, eventParameters());
    clearVictory();
    posterPromise = null;
    observedPlayingCode = '';
    pendingResult = false;
    unsubscribe?.();
    unsubscribe = null;
    clearInterval(ticker);
    ticker = null;
    clearPin();
    selected = null;
    $('#selection-card').classList.add('hidden');
    match = null;
    answer = null;
    code = '';
    busy = false;
    timeoutPending = false;
    suppressSearchZoom = false;
    clearTimeout(searchZoomTimeout);
  }

  function home() {
    clearActive();
    mode = 'idle';
    pendingLobby = false;
    pendingInvite = '';
    pendingHidePlace = null;
    history.replaceState({}, '', location.pathname);
    showScreen('#home-screen');
  }

  function openLobby() {
    if (!getUser()) {
      pendingLobby = true;
      requestSignIn();
      return;
    }
    if (!getUsername()) { pendingLobby = true; requestUsername(); return; }
    clearActive();
    mode = 'lobby';
    trackEvent(EVENTS.MULTIPLAYER_OPENED);
    $('#friend-lobby-status').textContent = '';
    showScreen('#friend-lobby');
  }

  function openHide() {
    if (!getUser()) return openLobby();
    if (!getUsername()) return openLobby();
    if (!getMap()?.getLayer('land')) { showToast('The map is still loading. One moment!'); return; }
    clearActive();
    mode = 'hiding';
    trackEvent(EVENTS.CHALLENGE_SETUP, { mode: 'multiplayer', role: 'hider' });
    $('#friend-hide-form').reset();
    $('#friend-place').textContent = 'Tap the map or choose a search result.';
    $('#friend-hide-status').textContent = '';
    $('#friend-search-results').classList.add('hidden');
    $('#friend-hide-peek').textContent = 'Tap the map or search for a country.';
    setHideCollapsed(false);
    history.replaceState({}, '', location.pathname);
    showScreen('#friend-hide');
  }

  function challengeFriend(place) {
    pendingHidePlace = place || null;
    if (!getUser()) { requestSignIn(); return; }
    if (!getUsername()) { requestUsername(); return; }
    openHide();
    const feature = getCountries()?.features.find(item => item.properties.id === pendingHidePlace?.id);
    if (feature) focusSearchPlace(feature);
    pendingHidePlace = null;
  }

  async function create(event) {
    event.preventDefault();
    if (busy) return;
    if (!hiddenPlace) { $('#friend-hide-status').textContent = 'Choose a country on the map first.'; return; }
    const clues = [1, 2, 3].map(index => $(`#friend-clue-${index}`).value.trim());
    if (clues.some(clue => clue.length < 5 || clue.length > 180)) {
      $('#friend-hide-status').textContent = 'Each clue needs 5 to 180 characters.';
      return;
    }
    busy = true;
    $('#friend-create-button').disabled = true;
    $('#friend-hide-status').textContent = 'Hiding your treasure…';
    try {
      const typedUsername = $('#friend-target-username').value.trim();
      const target = typedUsername ? await findUsername(typedUsername) : null;
      if (target?.uid === getUser().uid) throw new Error('Challenge a friend, not yourself.');
      const nextCode = makeHuntCode();
      await createFriendHunt(getUser(), nextCode, hiddenPlace, clues, target, getUsername());
      answer = hiddenPlace;
      code = nextCode;
      mode = 'hider';
      resultSource = 'live';
      trackEvent(EVENTS.CHALLENGE_CREATED, { mode: 'multiplayer', role: 'hider', targeted: !!target, round_seconds: 180 });
      history.replaceState({}, '', `?hunt=${code}`);
      subscribe();
    } catch (error) {
      console.error(error);
      $('#friend-hide-status').textContent = error.message || 'The hunt could not be created. Try again.';
    } finally {
      busy = false;
      $('#friend-create-button').disabled = false;
    }
  }

  async function join(rawCode, source = 'invite') {
    const nextCode = normaliseHuntCode(rawCode);
    if (!validHuntCode(nextCode)) throw new Error('Enter a valid 10-character invite code.');
    if (!getUser()) {
      pendingInvite = nextCode;
      requestSignIn();
      return;
    }
    const existing = await getFriendHunt(nextCode);
    if (!existing) throw new Error('That hunt code was not found.');
    if (existing.status === 'playing' && friendSecondsLeft(existing) <= 0 &&
        [existing.hiderUid, existing.seekerUid].includes(getUser().uid)) {
      try { await timeOutFriendHunt(nextCode); }
      catch (error) { if (error.code !== 'permission-denied') throw error; }
    }
    const completed = ['won', 'lost'].includes(existing.status);
    const participant = existing.hiderUid === getUser().uid || existing.seekerUid === getUser().uid;
    const role = completed && !participant ? 'spectator-result' : await joinFriendHunt(getUser(), nextCode);
    clearActive();
    code = nextCode;
    mode = role;
    resultSource = source;
    if (role === 'seeker' && existing.status === 'waiting') {
      trackEvent(EVENTS.CHALLENGE_ACCEPTED, { mode: 'multiplayer', role, source }, nextCode);
      trackEvent(EVENTS.HUNT_STARTED, { mode: 'multiplayer', role, round_seconds: friendRoundSeconds(existing), source }, nextCode);
      resultSource = 'live';
    }
    history.replaceState({}, '', `?hunt=${code}`);
    if (role === 'hider') loadFriendAnswer(nextCode).then(value => { if (code === nextCode) answer = value; }).catch(error => console.error(error));
    subscribe();
  }

  function subscribe() {
    unsubscribe?.();
    unsubscribe = watchFriendHunt(code, (value, metadata) => {
      // Do not count optimistic local writes as successful actions/results.
      if (metadata?.hasPendingWrites) return;
      if (!value) { showToast('This friend hunt is no longer available.'); home(); return; }
      match = value;
      if (value.status === 'playing' && value.seekerUid === getUser()?.uid) observedPlayingCode = code;
      if (value.status === 'won' || value.status === 'lost') {
        if (busy && value.seekerUid === getUser()?.uid) pendingResult = true;
        else showCompletedResult();
      } else if (mode === 'hider') {
        renderHider();
      } else {
        renderSeeker();
      }
    }, error => {
      console.error(error);
      showToast('Lost the live hunt connection. Reopen the invite link to retry.');
    });
  }

  function showCompletedResult() {
    if (observedPlayingCode === code && match?.seekerUid === getUser()?.uid) {
      trackEvent(EVENTS.HUNT_COMPLETED, { ...eventParameters(), outcome: match.status,
        winner_role: match.status === 'won' ? 'seeker' : 'hider',
        time_used: friendRoundSeconds(match) - friendSecondsLeft(match) }, code);
      resultSource = 'live';
    }
    renderResult();
  }

  function finishAction() {
    busy = false;
    if (pendingResult) { pendingResult = false; showCompletedResult(); }
  }

  function renderHider() {
    showScreen('#friend-wait');
    $('#friend-share-code').textContent = code;
    $('#friend-share-link').value = `${location.origin}${location.pathname}?hunt=${code}`;
    $('#friend-share-options').classList.toggle('hidden', match.status !== 'waiting');
    $('#friend-wait-copy').textContent = match.status === 'waiting'
      ? match.targetUsername
        ? `Challenge sent to @${match.targetUsername}. Share the link with them too.`
        : 'Your treasure is hidden. Send this code or link to your friend.'
      : `${match.seekerName || 'Your friend'} is following your clues. Keep this page open to watch the hunt.`;
    const country = getCountries()?.features.find(feature => feature.properties.id === match.lastGuessId)?.properties.name;
    $('#friend-wait-status').textContent = match.status === 'waiting'
      ? 'Waiting for your friend to join…'
      : match.lastGuessOutcome === 'wrong'
        ? `${match.seekerName || 'Your friend'} tried ${country || 'another country'}. ${match.wrongGuesses} wrong ${match.wrongGuesses === 1 ? 'guess' : 'guesses'} so far.`
        : `${friendSecondsLeft(match)} seconds remain. ${match.cluesVisible} of 3 clues opened.`;
    startTicker();
  }

  function renderSeeker() {
    mode = 'seeker';
    showScreen('#game-panel');
    $('#level-label').textContent = `FRIEND HUNT · ${escapeHTML(match.hiderName).toUpperCase()} HID THE TREASURE`;
    $('#clue-count').textContent = `${String(match.cluesVisible).padStart(2, '0')} / 03`;
    $('#sheet-peek-count').textContent = $('#clue-count').textContent;
    $('#sheet-peek-clue').textContent = match.clues[match.cluesVisible - 1];
    $('#clue-list').innerHTML = match.clues.map((clue, index) => {
      const open = index < match.cluesVisible;
      return `<div class="clue-card ${open ? 'clue-open' : 'clue-locked'}"><span class="clue-index">${String(index + 1).padStart(2, '0')}</span><div class="clue-body"><small>${index === 0 ? 'THE FIRST WHISPER' : index === 1 ? 'A CLOSER LOOK' : 'THE FINAL PIECE'}</small><p>${open ? escapeHTML(clue) : 'This clue is still waiting to be uncovered.'}</p></div><span class="clue-state">${open ? '✦' : '⌁'}</span></div>`;
    }).join('');
    $('#unlock-button').classList.toggle('hidden', match.cluesVisible === 3);
    $('#reveal-button').classList.toggle('hidden', match.cluesVisible !== 3 || match.revealed);
    $('#reveal-note').classList.toggle('hidden', !match.revealed);
    if (match.revealed) {
      $('#reveal-note').textContent = 'Uncovering the country name…';
      loadFriendAnswer(code).then(value => {
        answer = value;
        if (mode === 'seeker') $('#reveal-note').innerHTML = `The treasure is in <strong>${escapeHTML(value.country)}</strong>. Find it on the map to finish.`;
      }).catch(error => console.error(error));
    }
    if (selected && match.triedIds.includes(selected.id)) clearSelection();
    if (getMap()?.getLayer('tried-country')) getMap().setFilter('tried-country', ['in', ['get', 'id'], ['literal', match.triedIds]]);
    startTicker();
  }

  function clearSelection() {
    selected = null;
    clearMapSelection();
    $('#selection-card').classList.add('hidden');
  }

  function startTicker() {
    clearInterval(ticker);
    ticker = setInterval(renderTime, 200);
    renderTime();
  }

  function renderTime() {
    if (!match || match.status !== 'playing') return;
    const remaining = friendSecondsLeft(match);
    if (mode === 'seeker') {
      $('#timer-value').textContent = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, '0')}`;
      $('#timer-progress').style.width = `${(remaining / friendRoundSeconds(match)) * 100}%`;
      $('#game-hud').classList.toggle('timer-urgent', remaining <= 30);
      $('#unlock-button').disabled = !canUnlockFriendClue(match) || busy;
      $('#reveal-button').disabled = !canRevealFriendCountry(match) || busy;
    } else if (mode === 'hider' && match.lastGuessOutcome !== 'wrong') {
      $('#friend-wait-status').textContent = `${remaining} seconds remain. ${match.cluesVisible} of 3 clues opened.`;
    }
    if (remaining <= 0 && !timeoutPending) {
      timeoutPending = true;
      timeOutFriendHunt(code).catch(error => {
        if (error.code !== 'permission-denied') console.error(error);
      }).finally(() => { setTimeout(() => { timeoutPending = false; }, 2000); });
    }
  }

  async function renderResult() {
    clearInterval(ticker);
    clearSelection();
    clearPin();
    const spectator = mode === 'spectator-result';
    const hider = mode === 'hider' || mode === 'hider-result';
    mode = spectator ? 'spectator-result' : hider ? 'hider-result' : 'seeker-result';
    showScreen('#friend-result');
    const resultCode = code;
    $('#friend-result-content').textContent = spectator ? 'Opening this challenge…' : 'Uncovering the treasure location…';
    $('#friend-poster-button').classList.add('hidden');
    $('#friend-challenge-back-button').classList.add('hidden');
    let place = spectator ? null : answer;
    if (!spectator && !place) {
      try { place = await loadFriendAnswer(resultCode); if (code === resultCode) answer = place; }
      catch (error) { console.error(error); }
    }
    if (code !== resultCode || !match || !['won', 'lost'].includes(match.status)) return;
    const model = friendResult(match, getUser()?.uid, place, code);
    trackEvent(EVENTS.RESULT_VIEWED, { ...eventParameters(), source: resultSource, outcome: match.status, winner_role: model.winnerRole, personal_win: model.personalWin }, `${code}:${model.role}`);
    $('#friend-result-content').innerHTML = resultContent(model);
    $('#friend-result').dataset.outcome = model.personalWin ? 'win' : 'loss';
    $('#friend-result').dataset.theme = !model.seekerWon && model.role === 'seeker' ? 'teal' : 'parchment';
    $('#friend-challenge-back-button').classList.toggle('primary-button', !model.personalWin);
    $('#friend-challenge-back-button').classList.toggle('secondary-button', model.personalWin);
    $('#friend-poster-button').classList.toggle('primary-button', model.personalWin);
    $('#friend-poster-button').classList.toggle('secondary-button', !model.personalWin);
    $('#friend-result').classList.remove('victory');
    if (model.personalWin && animatedWinCode !== code) {
      animatedWinCode = code;
      playVictory($('#friend-result'));
    }
    $('#friend-challenge-back-button').classList.toggle('hidden', model.role !== 'seeker');
    $('#friend-challenge-back-button').textContent = model.action;
    $('#friend-again-button').classList.toggle('hidden', model.role === 'seeker');
    $('#friend-again-button').textContent = model.role === 'spectator' ? 'Start a friend hunt' : model.action;
    const share = $('#friend-poster-button');
    share.classList.toggle('hidden', !model.canShare);
    share.textContent = model.personalWin ? 'Share victory poster ↗' : 'Share result poster ↗';
    share.disabled = true;
    // Prepare before the click so native file sharing keeps its user activation.
    posterPromise = model.canShare ? renderVictoryPoster(model, document.querySelector('link[rel=canonical]')?.href || `${location.origin}${location.pathname}`) : null;
    posterPromise?.then(() => { if (code === resultCode) share.disabled = false; }).catch(error => {
      console.warn('Poster preparation failed:', error);
      if (code === resultCode) $('#friend-poster-status').textContent = 'The poster could not be prepared. Reopen this result to retry.';
    });
    $('#friend-poster-status').textContent = '';
  }

  function challengeBack() {
    if (mode !== 'seeker-result' || !match || !['won', 'lost'].includes(match.status)) return;
    const targetUsername = match.hiderUsername || '';
    trackEvent(EVENTS.REMATCH_STARTED, { ...eventParameters(), outcome: match.status });
    openHide();
    $('#friend-target-username').value = targetUsername;
    $('#friend-hide-status').textContent = targetUsername
      ? `Your new hunt will challenge @${targetUsername}.`
      : 'Enter your friend’s username to notify them, or share the new link.';
  }

  async function unlock() {
    if (mode !== 'seeker' || !canUnlockFriendClue(match) || busy) return;
    busy = true;
    try {
      const clueNumber = match.cluesVisible + 1;
      const parameters = eventParameters();
      await unlockFriendClue(code);
      trackEvent(EVENTS.CLUE_OPENED, { ...parameters, clues_opened: clueNumber, clue_number: clueNumber, time_remaining: Math.max(0, parameters.time_remaining - 20), cost_seconds: 20 });
    }
    catch (error) { console.error(error); showToast('That clue could not be opened. Try again.'); }
    finally { finishAction(); }
  }

  async function reveal() {
    if (mode !== 'seeker' || !canRevealFriendCountry(match) || busy) return;
    busy = true;
    try {
      const parameters = eventParameters();
      await revealFriendCountry(code);
      trackEvent(EVENTS.COUNTRY_REVEALED, { ...parameters, revealed: true, time_remaining: Math.max(0, parameters.time_remaining - 30), cost_seconds: 30 });
    }
    catch (error) { console.error(error); showToast('The country name could not be revealed. Try again.'); }
    finally { finishAction(); }
  }

  async function guess() {
    if (mode !== 'seeker' || !selected || busy || friendSecondsLeft(match) <= 0) return;
    busy = true;
    $('#guess-button').disabled = true;
    const country = selected;
    try {
      const parameters = eventParameters();
      const outcome = await submitFriendGuess(code, country.id);
      trackEvent(EVENTS.GUESS_SUBMITTED, { ...parameters, outcome, wrong_guesses: parameters.wrong_guesses + (outcome === 'wrong' ? 1 : 0), cost_seconds: outcome === 'wrong' ? 5 : 0 });
      if (outcome === 'wrong') {
        clearSelection();
        showToast(`${country.country} isn't the one. −5 seconds.`);
      }
    } catch (error) {
      console.error(error);
      showToast('That guess could not be sent. Try again.');
    } finally {
      finishAction();
      $('#guess-button').disabled = false;
    }
  }

  function onAuth(nextUser) {
    if (!nextUser) {
      if (mode !== 'idle') home();
      if (pendingInvite && !inviteHandled) {
        inviteHandled = true;
        requestSignIn();
      }
      return;
    }
    if (pendingInvite) {
      const invite = pendingInvite;
      pendingInvite = '';
      inviteHandled = true;
      join(invite).catch(error => { console.error(error); openLobby(); $('#friend-lobby-status').textContent = error.message || 'Could not open that invite.'; });
    } else if (pendingHidePlace) {
      challengeFriend(pendingHidePlace);
    } else if (pendingLobby) {
      pendingLobby = false;
      openLobby();
    }
  }

  $('#friend-hide-button').addEventListener('click', openHide);
  $('#friend-hide-toggle').addEventListener('click', () => setHideCollapsed(!document.body.classList.contains('hide-collapsed')));
  $('#cancel-setup-button').addEventListener('click', home);
  $('#friend-country-search').addEventListener('input', searchCountries);
  $('#friend-search-results').addEventListener('click', event => {
    const button = event.target.closest('button[data-id]');
    if (!button) return;
    const feature = getCountries()?.features.find(item => item.properties.id === button.dataset.id);
    if (!feature) return;
    focusSearchPlace(feature);
  });
  $('#friend-hide-form').addEventListener('submit', create);
  $('#friend-join-form').addEventListener('submit', async event => {
    event.preventDefault();
    $('#friend-lobby-status').textContent = 'Opening the hunt…';
    try { await join($('#friend-code-input').value, 'code'); }
    catch (error) { console.error(error); $('#friend-lobby-status').textContent = error.message || 'Could not join that hunt.'; }
  });
  async function copyInvite() {
    try { await navigator.clipboard.writeText($('#friend-share-link').value); trackEvent(EVENTS.INVITE_SHARED, { mode: 'multiplayer', role: 'hider', method: 'clipboard' }); showToast('Invite link copied.'); }
    catch { showToast('Copy unavailable. Share the code shown here.'); }
  }
  $('#friend-copy-button').addEventListener('click', copyInvite);
  $('#friend-share-button').addEventListener('click', async () => {
    if (!navigator.share) { await copyInvite(); return; }
    try {
      await navigator.share({
        title: 'TreasureHunch challenge',
        text: 'I hid a treasure for you. Follow the clues and find it!',
        url: $('#friend-share-link').value,
      });
      trackEvent(EVENTS.INVITE_SHARED, { mode: 'multiplayer', role: 'hider', method: 'native' });
    } catch (error) {
      if (error.name !== 'AbortError') await copyInvite();
    }
  });
  $('#friend-poster-button').addEventListener('click', async () => {
    if (!posterPromise || !match || !friendResult(match, getUser()?.uid).canShare) return;
    const button = $('#friend-poster-button');
    button.disabled = true;
    try {
      const parameters = eventParameters();
      const result = await sharePosterFile(await posterPromise, code);
      if (result !== 'cancelled') trackEvent(EVENTS.POSTER_EXPORTED, { ...parameters, method: result === 'shared' ? 'native' : 'download' });
      $('#friend-poster-status').textContent = result === 'downloaded' ? 'Your result poster was downloaded.' : result === 'shared' ? 'Result shared.' : '';
    } catch (error) {
      console.error(error);
      $('#friend-poster-status').textContent = 'The poster could not be created. Please reopen this result to retry.';
    } finally { button.disabled = false; }
  });
  $('#friend-again-button').addEventListener('click', () => mode === 'spectator-result' ? openLobby() : openHide());
  $('#friend-challenge-back-button').addEventListener('click', challengeBack);
  document.querySelectorAll('.friend-back').forEach(button => button.addEventListener('click', home));

  return {
    get mode() { return mode; },
    get suppressSearchZoom() { return suppressSearchZoom; },
    mapCountry,
    openLobby,
    challengeFriend,
    joinCode: join,
    onAuth,
    home,
    unlock,
    reveal,
    guess,
    cancelSelection: () => {
      if (selected) trackEvent(EVENTS.SELECTION_CANCELLED, eventParameters());
      clearSelection();
    },
    collapseOnMap: () => {
      if (mode === 'seeker') setSheetCollapsed(true);
      if (mode === 'hiding') setHideCollapsed(true);
    },
  };
}
