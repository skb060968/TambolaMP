/**
 * Tambola MP — Phone controller
 *
 * Wires the player's full flow:
 *   home → phone-join → phone-lobby → phone-game → phone-results
 *
 * Phones write only marks/* and claimRequests/*. The TV-host validates and
 * resolves all claims; phones watch claimResults/* to see invalid responses.
 */

import {
  joinRoomAsPlayer, listenRoom, setupPlayerDisconnectHandler,
  writePlayerMarks, submitClaimRequest, leaveRoom, setReady,
  rejoinRoom, MAX_PLAYERS,
} from './firebase-sync.js';
import { deserializeTicket } from './ticket-generator.js';
import { PATTERNS, PATTERN_LABELS } from './claim-validator.js';
import {
  initAudio, playSound, isMuted, toggleMute,
} from './sound-manager.js';
import { showScreen, showToast } from './platform-ui.js';

const SESSION_KEY = 'tambola_mp_session';
const AUTOCUT_KEY = 'tambola_mp_autocut';

let roomCode = null;
let playerIndex = null;
let unsubscribe = null;
let myTicket = null;        // 3×9 array
let myMarks = new Set();    // numbers I've marked
let calledSet = new Set();  // numbers actually called by host
let lastCalled = null;
let firebaseSnapshot = {};
let _resultsShown = false;
let _claimRequestsAwaiting = new Map(); // requestId -> pattern, for invalid-toast lookup

/* ======= SESSION ======= */
function saveSession() {
  if (roomCode != null && playerIndex != null) {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({
        role: 'phone', roomCode, playerIndex,
      }));
    } catch (_) {}
  }
}
function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch (_) {}
}

function getAutoCut() {
  try { return localStorage.getItem(AUTOCUT_KEY) === '1'; }
  catch (_) { return false; }
}
function setAutoCut(v) {
  try { localStorage.setItem(AUTOCUT_KEY, v ? '1' : '0'); } catch (_) {}
}

/* ======= ENTRY ======= */
export function startPhoneFlow(prefilledCode) {
  document.body.dataset.mode = 'phone';
  initAudio('phone');
  if (prefilledCode) {
    const input = document.getElementById('phone-join-code');
    if (input) input.value = prefilledCode.toUpperCase();
  }
  showScreen('phone-join');
  wirePhoneJoin();
  wirePhoneLobby();
  wirePhoneGame();
  wirePhoneResults();
}

export async function resumePhoneSession(savedRoomCode, savedPlayerIndex) {
  document.body.dataset.mode = 'phone';
  initAudio('phone');
  roomCode = savedRoomCode;
  playerIndex = savedPlayerIndex;
  const result = await rejoinRoom(savedRoomCode, savedPlayerIndex, 'phone');
  if (!result.success) {
    clearSession();
    showScreen('home');
    return;
  }
  setupPlayerDisconnectHandler(roomCode, playerIndex);
  attachRoomListener();
  if (result.status === 'lobby') showScreen('phone-lobby');
  else if (result.status === 'active') showScreen('phone-game');
  else { clearSession(); showScreen('home'); return; }
  wirePhoneJoin();
  wirePhoneLobby();
  wirePhoneGame();
  wirePhoneResults();
}

/* ======= JOIN FORM ======= */
function wirePhoneJoin() {
  const screen = document.getElementById('phone-join');
  if (!screen || screen.dataset._wired) return;
  screen.dataset._wired = '1';

  const emojiPicker = document.querySelector('.phone-emoji-picker');
  if (emojiPicker) {
    emojiPicker.querySelectorAll('.emoji-btn').forEach((b) => {
      b.addEventListener('click', () => {
        emojiPicker.querySelectorAll('.emoji-btn').forEach((x) => x.classList.remove('selected'));
        b.classList.add('selected');
      });
    });
  }

  const submit = document.getElementById('btn-phone-join-submit');
  const back = document.getElementById('btn-phone-join-back');
  if (submit) submit.addEventListener('click', async () => {
    const code = (document.getElementById('phone-join-code')?.value || '').trim().toUpperCase();
    const name = (document.getElementById('phone-join-name')?.value || '').trim();
    if (!code || code.length !== 4) { showToast('Enter a 4-letter room code'); return; }
    if (!name) { showToast('Enter your name'); return; }
    const sel = document.querySelector('.phone-emoji-picker .emoji-btn.selected');
    const emoji = sel?.dataset.emoji || '😀';
    try {
      const result = await joinRoomAsPlayer(code, name, emoji);
      if (!result.success) { showToast(result.reason || 'Failed to join'); return; }
      roomCode = code;
      playerIndex = result.playerIndex;
      saveSession();
      setupPlayerDisconnectHandler(roomCode, playerIndex);
      attachRoomListener();
      showScreen('phone-lobby');
      renderPhoneLobby();
    } catch (err) {
      console.error(err);
      showToast('Failed to join.');
    }
  });
  if (back) back.addEventListener('click', () => {
    showScreen('home');
    delete document.body.dataset.mode;
  });
}

/* ======= ROOM LISTENER ======= */
function attachRoomListener() {
  if (unsubscribe) unsubscribe();
  unsubscribe = listenRoom(roomCode, {
    onMetaChange: (meta) => {
      firebaseSnapshot.meta = meta;
      if (meta.status === 'lobby') {
        // Returned to lobby (e.g. after Play Again)
        if (document.getElementById('phone-results') && !document.getElementById('phone-results').hasAttribute('hidden')) {
          // From results, show lobby
        }
        // Reset round-local state
        myTicket = null;
        myMarks = new Set();
        calledSet = new Set();
        lastCalled = null;
        _resultsShown = false;
        showScreen('phone-lobby');
        renderPhoneLobby();
      } else if (meta.status === 'active') {
        if (myTicket) showScreen('phone-game');
      } else if (meta.status === 'ended') {
        if (!_resultsShown) {
          _resultsShown = true;
          renderPhoneResults();
          showScreen('phone-results');
        }
      }
    },
    onPlayersChange: (players) => {
      firebaseSnapshot.players = players;
      renderPhoneLobby();
      // If our slot disappeared (host kicked us / left), go home.
      const myKey = `player_${playerIndex}`;
      if (firebaseSnapshot.meta?.status !== 'ended' && players && Object.keys(players).length > 0 && !players[myKey]) {
        showToast('Removed from room.');
        cleanupAndGoHome();
      }
    },
    onTicketsChange: (tickets) => {
      firebaseSnapshot.tickets = tickets;
      const myKey = `player_${playerIndex}`;
      if (tickets && tickets[myKey]) {
        myTicket = deserializeTicket(tickets[myKey]);
        renderPhoneTicket();
        if (firebaseSnapshot.meta?.status === 'active') {
          showScreen('phone-game');
        }
      }
    },
    onGameUpdate: (game) => {
      firebaseSnapshot.game = game;
      const newDrawn = game.drawnNumbers || [];
      const previousLast = lastCalled;
      calledSet = new Set(newDrawn);
      const drawnNum = game.currentNumber;
      lastCalled = drawnNum;
      if (drawnNum != null && drawnNum !== previousLast) {
        // A new draw arrived — chime + maybe auto-strike
        playSound('draw', 0.4);
        if (getAutoCut() && myTicket) {
          const flat = myTicket.flat();
          if (flat.includes(drawnNum)) {
            myMarks.add(drawnNum);
            persistMarks();
            renderPhoneTicket();
            playSound('mark', 0.4);
          }
        }
      }
      renderCalledBadge();
      renderPhoneTicket();
      // Handle win/banner from claims
      if (game.claims) {
        Object.keys(game.claims).forEach((p) => {
          const c = game.claims[p];
          if (c?.won) showWinBannerOnce(p, c);
        });
      }
    },
    onClaimResults: (results) => {
      firebaseSnapshot.claimResults = results;
      // Look for any of OUR pending requests
      _claimRequestsAwaiting.forEach((pattern, reqId) => {
        const r = results && results[reqId];
        if (r && r.valid === false) {
          showToast(`Invalid claim: ${r.reason || 'try again'}`);
          playSound('error');
          _claimRequestsAwaiting.delete(reqId);
        }
      });
    },
    onMarksChange: (marks) => {
      firebaseSnapshot.marks = marks;
    },
    onRoomDeleted: () => {
      showToast('Host closed the room.', 2400);
      cleanupAndGoHome();
    },
  });
}

/* ======= LOBBY ======= */
function wirePhoneLobby() {
  const screen = document.getElementById('phone-lobby');
  if (!screen || screen.dataset._wired) return;
  screen.dataset._wired = '1';
  const leave = document.getElementById('btn-phone-leave-lobby');
  if (leave) leave.addEventListener('click', async () => {
    if (roomCode != null && playerIndex != null) {
      try { await leaveRoom(roomCode, playerIndex); } catch (_) {}
    }
    cleanupAndGoHome();
  });
  const muteBtn = document.getElementById('btn-phone-lobby-mute');
  if (muteBtn) {
    muteBtn.textContent = isMuted() ? '🔇' : '🔊';
    muteBtn.addEventListener('click', () => {
      toggleMute();
      muteBtn.textContent = isMuted() ? '🔇' : '🔊';
    });
  }
}

function renderPhoneLobby() {
  const codeEl = document.getElementById('phone-lobby-code');
  if (codeEl) codeEl.textContent = roomCode || '----';
  const list = document.getElementById('phone-lobby-players');
  if (!list) return;
  const players = firebaseSnapshot.players || {};
  const keys = Object.keys(players).sort();
  list.innerHTML = '';
  keys.forEach((k) => {
    const p = players[k] || {};
    const li = document.createElement('li');
    li.className = 'phone-lobby-player';
    const isMe = k === `player_${playerIndex}`;
    li.innerHTML = `<span class="emoji">${escapeHtml(p.emoji || '😀')}</span><span class="name">${escapeHtml(p.name || 'Player')}${isMe ? ' (you)' : ''}</span>`;
    if (!p.connected) li.classList.add('disconnected');
    list.appendChild(li);
  });
  const countEl = document.getElementById('phone-lobby-count');
  if (countEl) countEl.textContent = `${keys.length} / ${MAX_PLAYERS}`;
}

/* ======= GAME ======= */
function wirePhoneGame() {
  const screen = document.getElementById('phone-game');
  if (!screen || screen.dataset._wired) return;
  screen.dataset._wired = '1';

  const muteBtn = document.getElementById('btn-phone-game-mute');
  if (muteBtn) {
    muteBtn.textContent = isMuted() ? '🔇' : '🔊';
    muteBtn.addEventListener('click', () => {
      toggleMute();
      muteBtn.textContent = isMuted() ? '🔇' : '🔊';
    });
  }
  const autocutChk = document.getElementById('phone-autocut');
  if (autocutChk) {
    autocutChk.checked = getAutoCut();
    autocutChk.addEventListener('change', () => setAutoCut(autocutChk.checked));
  }
  // Claim buttons (5)
  document.querySelectorAll('.claim-btn').forEach((btn) => {
    btn.addEventListener('click', () => handleClaim(btn.dataset.pattern));
  });
}

function renderPhoneTicket() {
  if (!myTicket) return;
  const grid = document.getElementById('phone-ticket-grid');
  if (!grid) return;
  grid.innerHTML = '';
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 9; c++) {
      const v = myTicket[r][c];
      const cell = document.createElement('div');
      if (v === 0) {
        cell.className = 'pt-cell empty';
      } else {
        cell.className = 'pt-cell';
        cell.dataset.num = String(v);
        cell.textContent = String(v);
        const struck = myMarks.has(v);
        if (struck) cell.classList.add('struck');
        cell.addEventListener('click', () => handleTicketTap(v, cell));
      }
      grid.appendChild(cell);
    }
  }
}

function handleTicketTap(value, cell) {
  if (!calledSet.has(value)) {
    cell.classList.remove('shake');
    void cell.offsetWidth;
    cell.classList.add('shake');
    return;
  }
  if (myMarks.has(value)) return;
  myMarks.add(value);
  cell.classList.add('struck');
  playSound('mark', 0.4);
  persistMarks();
}

function persistMarks() {
  if (roomCode == null || playerIndex == null) return;
  writePlayerMarks(roomCode, playerIndex, [...myMarks]).catch((err) => {
    console.warn('writePlayerMarks failed:', err.message);
  });
}

function renderCalledBadge() {
  const badge = document.getElementById('phone-called-badge');
  if (!badge) return;
  if (lastCalled != null) {
    badge.textContent = lastCalled;
    badge.classList.add('lit');
  } else {
    badge.textContent = '—';
    badge.classList.remove('lit');
  }
  const last3 = document.getElementById('phone-last-three');
  if (last3 && firebaseSnapshot.game) {
    const arr = (firebaseSnapshot.game.drawnNumbers || []).slice(-4, -1).reverse();
    last3.innerHTML = arr.length ? arr.map((n) => `<span class="ln">${n}</span>`).join('') : '<span class="empty">—</span>';
  }
}

async function handleClaim(pattern) {
  if (roomCode == null || playerIndex == null) return;
  if (!myTicket) return;
  try {
    const reqId = await submitClaimRequest(roomCode, playerIndex, pattern);
    _claimRequestsAwaiting.set(reqId, pattern);
    showToast(`Claiming ${PATTERN_LABELS[pattern]}…`, 1200);
    playSound('claim', 0.6);
  } catch (err) {
    console.warn('submitClaimRequest failed:', err.message);
    showToast('Claim failed, try again.');
  }
}

const _bannersShown = new Set();
function showWinBannerOnce(pattern, c) {
  const key = `${pattern}-${c.winner}-${c.wonAt}`;
  if (_bannersShown.has(key)) return;
  _bannersShown.add(key);
  const banner = document.getElementById('phone-winner-banner');
  if (!banner) return;
  banner.innerHTML = `🏆 <strong>${escapeHtml(c.playerName || 'Player')}</strong> won <em>${PATTERN_LABELS[pattern]}</em>!`;
  banner.classList.add('show');
  if (c.winner === playerIndex) playSound('win');
  setTimeout(() => banner.classList.remove('show'), 2400);
}

/* ======= RESULTS ======= */
function wirePhoneResults() {
  const screen = document.getElementById('phone-results');
  if (!screen || screen.dataset._wired) return;
  screen.dataset._wired = '1';
  const home = document.getElementById('btn-phone-home');
  const again = document.getElementById('btn-phone-play-again');
  if (home) home.addEventListener('click', async () => {
    if (roomCode != null && playerIndex != null) {
      try { await leaveRoom(roomCode, playerIndex); } catch (_) {}
    }
    cleanupAndGoHome();
  });
  if (again) again.addEventListener('click', async () => {
    // Phone clicks "play again" → mark ready and wait
    if (roomCode != null && playerIndex != null) {
      try { await setReady(roomCode, playerIndex, true); } catch (_) {}
    }
    again.disabled = true;
    again.textContent = '✓ Ready';
    showToast('Waiting for host to start new round...', 2400);
  });
}

function renderPhoneResults() {
  const list = document.getElementById('phone-results-list');
  if (!list) return;
  const game = firebaseSnapshot.game || {};
  const claims = game.claims || {};
  list.innerHTML = '';
  Object.keys(PATTERNS).forEach((p) => {
    const c = claims[p];
    const li = document.createElement('li');
    if (c?.won) {
      li.innerHTML = `<span class="rl-pat">${PATTERN_LABELS[p]}</span> <span class="rl-winner">🏆 ${escapeHtml(c.playerName || 'Player')}</span>`;
    } else {
      li.innerHTML = `<span class="rl-pat">${PATTERN_LABELS[p]}</span> <span class="rl-winner muted">—</span>`;
    }
    list.appendChild(li);
  });
}

/* ======= CLEANUP ======= */
function cleanupAndGoHome() {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  clearSession();
  roomCode = null;
  playerIndex = null;
  myTicket = null;
  myMarks = new Set();
  calledSet = new Set();
  lastCalled = null;
  firebaseSnapshot = {};
  _resultsShown = false;
  _claimRequestsAwaiting = new Map();
  _bannersShown.clear();
  delete document.body.dataset.mode;
  showScreen('home');
}

window.addEventListener('beforeunload', () => {
  if (unsubscribe) unsubscribe();
});

/* ======= UTIL ======= */
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
