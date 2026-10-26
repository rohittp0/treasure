import * as maplibregl from 'maplibre-gl';
import { canRevealFriendCountry, canUnlockFriendClue, friendSecondsLeft, makeHuntCode, normaliseHuntCode, validHuntCode } from './friend.js';
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
  let animatedWinCode = '';
  let pendingInvite = normaliseHuntCode(new URLSearchParams(location.search).get('hunt'));
  let inviteHandled = false;

  function showScreen(selector) {
    const openingGame = selector === '#game-panel' && $('#game-panel').classList.contains('hidden');
    $('#home-screen').classList.toggle('hidden', selector !== '#home-screen');
    $('#result-screen').classList.add('hidden');
    $('#game-panel').classList.toggle('hidden', selector !== '#game-panel');
    $('#game-hud').classList.toggle('hidden', selector !== '#game-panel');
    for (const screen of friendScreens) $(screen).classList.toggle('hidden', selector !== screen);
    document.body.classList.toggle('in-game', selector === '#game-panel');
    document.body.classList.remove('solo-game');
    $('#end-level-button').classList.add('hidden');
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
    clearVictory();
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
    $('#friend-lobby-status').textContent = '';
    showScreen('#friend-lobby');
  }

  function openHide() {
    if (!getUser()) return openLobby();
    if (!getUsername()) return openLobby();
    if (!getMap()?.getLayer('land')) { showToast('The map is still loading. One moment!'); return; }
    clearActive();
    mode = 'hiding';
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
    if (feature) {
      const { labelX, labelY } = feature.properties;
      setHiddenPlace({ id: feature.properties.id, country: feature.properties.name, lng: labelX, lat: labelY });
      getMap().flyTo({ center: [labelX, labelY], zoom: Math.max(getMap().getZoom(), 3) });
    }
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

  async function join(rawCode) {
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
    history.replaceState({}, '', `?hunt=${code}`);
    if (role === 'hider') loadFriendAnswer(code).then(value => { answer = value; }).catch(error => console.error(error));
    subscribe();
  }

  function subscribe() {
    unsubscribe?.();
    unsubscribe = watchFriendHunt(code, value => {
      if (!value) { showToast('This friend hunt is no longer available.'); home(); return; }
      match = value;
      if (value.status === 'won' || value.status === 'lost') {
        renderResult();
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
      $('#timer-progress').style.width = `${(remaining / 120) * 100}%`;
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
    $('#friend-result-copy').textContent = spectator ? 'This challenge has already been played.' : 'Uncovering the treasure location…';
    let place = spectator ? null : answer;
    if (!spectator && !place) {
      try { place = await loadFriendAnswer(code); answer = place; }
      catch (error) { console.error(error); }
    }
    if (code !== resultCode || !match || !['won', 'lost'].includes(match.status)) return;
    const won = match.status === 'won';
    if (won && animatedWinCode !== code) {
      animatedWinCode = code;
      playVictory($('#friend-result'));
    }
    if (!won) $('#friend-result').classList.remove('victory');
    $('#friend-result-art').textContent = won ? '✦' : '⌛';
    $('#friend-result-eyebrow').textContent = won ? 'TREASURE FOUND' : 'THE TRAIL WENT COLD';
    $('#friend-result-title').textContent = spectator ? won ? 'Treasure found.' : 'The trail went cold.' : hider
      ? won ? 'Your friend found it.' : 'Your treasure stayed hidden.'
      : won ? 'Beautifully found.' : 'The world is still waiting.';
    $('#friend-result-copy').textContent = spectator
      ? `This challenge has already been played. ${won ? `${match.seekerName || 'The seeker'} found the treasure.` : 'The seeker ran out of time.'}`
      : place
      ? `The treasure was in ${place.country}. ${won ? `${match.seekerName || 'The seeker'} followed the trail.` : 'A new hunt is ready whenever you are.'}`
      : 'The hunt is over. The treasure location could not be loaded.';
    $('#friend-result-stats').innerHTML = `<div><strong>${friendSecondsLeft(match)}s</strong><span>ON THE CLOCK</span></div><div><strong>${match.cluesVisible}/3</strong><span>CLUES OPENED</span></div><div><strong>${match.wrongGuesses}</strong><span>WRONG GUESSES</span></div>`;
    $('#friend-challenge-back-button').classList.toggle('hidden', hider || spectator);
    $('#friend-challenge-back-button').innerHTML = `Challenge ${match.hiderUsername ? `@${escapeHTML(match.hiderUsername)}` : 'back'} <span aria-hidden="true">↗</span>`;
  }

  function challengeBack() {
    if (mode !== 'seeker-result' || !match || !['won', 'lost'].includes(match.status)) return;
    const targetUsername = match.hiderUsername || '';
    openHide();
    $('#friend-target-username').value = targetUsername;
    $('#friend-hide-status').textContent = targetUsername
      ? `Your new hunt will challenge @${targetUsername}.`
      : 'Enter your friend’s username to notify them, or share the new link.';
  }

  async function unlock() {
    if (mode !== 'seeker' || !canUnlockFriendClue(match) || busy) return;
    busy = true;
    try { await unlockFriendClue(code); }
    catch (error) { console.error(error); showToast('That clue could not be opened. Try again.'); }
    finally { busy = false; }
  }

  async function reveal() {
    if (mode !== 'seeker' || !canRevealFriendCountry(match) || busy) return;
    busy = true;
    try { await revealFriendCountry(code); }
    catch (error) { console.error(error); showToast('The country name could not be revealed. Try again.'); }
    finally { busy = false; }
  }

  async function guess() {
    if (mode !== 'seeker' || !selected || busy || friendSecondsLeft(match) <= 0) return;
    busy = true;
    $('#guess-button').disabled = true;
    const country = selected;
    try {
      const outcome = await submitFriendGuess(code, country.id);
      if (outcome === 'wrong') {
        clearSelection();
        showToast(`${country.country} isn't the one. −5 seconds.`);
      }
    } catch (error) {
      console.error(error);
      showToast('That guess could not be sent. Try again.');
    } finally {
      busy = false;
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
  $('#friend-hide-close').addEventListener('click', home);
  $('#friend-country-search').addEventListener('input', searchCountries);
  $('#friend-search-results').addEventListener('click', event => {
    const button = event.target.closest('button[data-id]');
    if (!button) return;
    const feature = getCountries()?.features.find(item => item.properties.id === button.dataset.id);
    if (!feature) return;
    const { labelX, labelY } = feature.properties;
    setHiddenPlace({ id: feature.properties.id, country: feature.properties.name, lng: labelX, lat: labelY });
    getMap().flyTo({ center: [labelX, labelY], zoom: Math.max(getMap().getZoom(), 3) });
  });
  $('#friend-hide-form').addEventListener('submit', create);
  $('#friend-join-form').addEventListener('submit', async event => {
    event.preventDefault();
    $('#friend-lobby-status').textContent = 'Opening the hunt…';
    try { await join($('#friend-code-input').value); }
    catch (error) { console.error(error); $('#friend-lobby-status').textContent = error.message || 'Could not join that hunt.'; }
  });
  async function copyInvite() {
    try { await navigator.clipboard.writeText($('#friend-share-link').value); showToast('Invite link copied.'); }
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
    } catch (error) {
      if (error.name !== 'AbortError') await copyInvite();
    }
  });
  $('#friend-again-button').addEventListener('click', openLobby);
  $('#friend-challenge-back-button').addEventListener('click', challengeBack);
  document.querySelectorAll('.friend-back').forEach(button => button.addEventListener('click', home));

  return {
    get mode() { return mode; },
    mapCountry,
    openLobby,
    challengeFriend,
    joinCode: join,
    onAuth,
    home,
    unlock,
    reveal,
    guess,
    cancelSelection: clearSelection,
    collapseOnMap: () => {
      if (mode === 'seeker') setSheetCollapsed(true);
      if (mode === 'hiding') setHideCollapsed(true);
    },
  };
}
