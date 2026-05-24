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
        // Reset round-local state
        myTicket = null;
        myMarks = new Set();
        calledSet = new Set();
        lastCalled = null;
        _resultsShown = false;
        _bannersShown.clear();
        // Reset Play Again + claim buttons
        const again = document.getElementById('btn-phone-play-again');
        if (again) { again.disabled = false; again.textContent = '▶ Play Again'; }
        document.querySelectorAll('.claim-btn').forEach((b) => b.classList.remove('won', 'mine-won'));
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
      renderPhonePlayerTag();
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
        renderPhonePlayerTag();
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
      renderClaimButtons();
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
      // Hydrate myMarks from Firebase if my own slot is present (e.g. after
      // a refresh) so we don't overwrite our struck numbers with an empty set.
      const myKey = `player_${playerIndex}`;
      const myFromFb = (marks && marks[myKey]) || null;
      if (myFromFb && Array.isArray(myFromFb)) {
        const remoteSet = new Set(myFromFb);
        // Only hydrate if remote has more than local (avoid wiping unsaved local taps).
        if (remoteSet.size > myMarks.size) {
          myMarks = remoteSet;
          renderPhoneTicket();
        }
      }
    },
    onReadyChange: (ready) => {
      firebaseSnapshot.ready = ready;
      // Refresh the ready dots on the results screen if we're showing it.
      const resultsEl = document.getElementById('phone-results');
      if (resultsEl && !resultsEl.hasAttribute('hidden')) {
        renderPhoneReadyIndicators();
      }
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

function renderPhonePlayerTag() {
  if (playerIndex == null) return;
  const me = (firebaseSnapshot.players || {})[`player_${playerIndex}`];
  if (!me) return;
  const emojiEl = document.getElementById('phone-player-emoji');
  const nameEl = document.getElementById('phone-player-name');
  if (emojiEl) emojiEl.textContent = me.emoji || '😀';
  if (nameEl) nameEl.textContent = me.name || 'Player';
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
  renderPhoneCalledGrid();
}

/**
 * Renders the 1-90 grid on the phone, mirroring the TV's bottom strip.
 * Built once, then per-update we toggle .called and .latest classes on cells.
 */
function renderPhoneCalledGrid() {
  const grid = document.getElementById('phone-called-grid');
  if (!grid) return;
  if (!grid.dataset._built) {
    grid.dataset._built = '1';
    let html = '';
    for (let n = 1; n <= 90; n++) {
      html += `<div class="called-cell" data-num="${n}">${n}</div>`;
    }
    grid.innerHTML = html;
  }
  const drawn = (firebaseSnapshot.game && firebaseSnapshot.game.drawnNumbers) || [];
  const drawnSet = new Set(drawn);
  const latest = drawn.length ? drawn[drawn.length - 1] : null;
  grid.querySelectorAll('.called-cell').forEach((c) => {
    const n = parseInt(c.dataset.num, 10);
    c.classList.toggle('called', drawnSet.has(n));
    c.classList.toggle('latest', n === latest);
  });
}

/**
 * Reflects each pattern's won state on the claim buttons:
 *   - won by anyone → 'won' class (greyed-out, ✓ tick)
 *   - won by ME → additional 'mine-won' class (gold gradient)
 */
function renderClaimButtons() {
  const claims = (firebaseSnapshot.game && firebaseSnapshot.game.claims) || {};
  document.querySelectorAll('.claim-btn').forEach((btn) => {
    const pattern = btn.dataset.pattern;
    const c = claims[pattern];
    if (c?.won) {
      btn.classList.add('won');
      btn.classList.toggle('mine-won', c.winner === playerIndex);
    } else {
      btn.classList.remove('won', 'mine-won');
    }
  });
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
  // Win sound and confetti fire on EVERY phone, not just the winner's,
  // so all players see/hear that someone has claimed the pattern.
  playSound('win');
  burstConfetti();
  setTimeout(() => banner.classList.remove('show'), 2400);
}

function burstConfetti() {
  if (typeof window.confetti === 'function') {
    try {
      window.confetti({
        particleCount: 140,
        spread: 80,
        origin: { y: 0.5 },
        colors: ['#ffd700', '#ff6b6b', '#51cf66', '#2b6ef6'],
      });
    } catch (_) {}
  }
}

/* ======= RESULTS ======= */
function wirePhoneResults() {
  const screen = document.getElementById('phone-results');
  if (!screen || screen.dataset._wired) return;
  screen.dataset._wired = '1';
  const home = document.getElementById('btn-phone-home');
  const again = document.getElementById('btn-phone-play-again');
  if (home) home.addEventListener('click', async () => {
    // Write 'left' so other players see a red dot on the results screen,
    // matching the original Tambola feel. Then leave the room and go home.
    if (roomCode != null && playerIndex != null) {
      try { await setReady(roomCode, playerIndex, 'left'); } catch (_) {}
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

  // Same prize map the TV uses (kept in sync — change one, change the other).
  const PHONE_PRIZES = {
    topLine: 20, middleLine: 20, bottomLine: 20, corners: 15, fullHouse: 50,
  };

  // Track totals for the prize summary.
  const totals = {};

  Object.keys(PATTERNS).forEach((p) => {
    const c = claims[p];
    const prize = PHONE_PRIZES[p] || 0;
    const li = document.createElement('li');
    if (c?.won) {
      const name = c.playerName || 'Player';
      totals[c.winner] = (totals[c.winner] || 0) + prize;
      li.innerHTML = `<span class="rl-pat">${PATTERN_LABELS[p]}</span> <span class="rl-winner">🏆 ${escapeHtml(name)}</span> <span class="rl-prize">🪙 ${prize}</span>`;
    } else {
      li.innerHTML = `<span class="rl-pat">${PATTERN_LABELS[p]}</span> <span class="rl-winner muted">Unclaimed</span> <span class="rl-prize muted">🪙 ${prize}</span>`;
    }
    list.appendChild(li);
  });

  // Prize summary
  const summary = document.getElementById('phone-results-summary');
  if (summary) {
    summary.innerHTML = '';
    const players = firebaseSnapshot.players || {};
    const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);
    if (entries.length > 0) {
      const heading = document.createElement('h3');
      heading.className = 'phone-results-summary-heading';
      heading.textContent = '🏆 Prize Summary';
      summary.appendChild(heading);
      entries.forEach(([idx, coins]) => {
        const p = players[`player_${idx}`] || { name: 'Player', emoji: '😀' };
        const row = document.createElement('div');
        row.className = 'phone-results-total-row';
        row.innerHTML = `<span class="rl-emoji">${escapeHtml(p.emoji)}</span><span class="rl-name">${escapeHtml(p.name)}</span><span class="rl-total">🪙 ${coins}</span>`;
        summary.appendChild(row);
      });
    }
  }

  // Reset Play Again button state for this round.
  const again = document.getElementById('btn-phone-play-again');
  if (again) {
    again.disabled = false;
    again.textContent = '▶ Play Again';
  }

  renderPhoneReadyIndicators();
}

/**
 * Renders the per-player circles below the results — green if the player
 * has clicked Play Again, red if they've clicked Home, hollow otherwise.
 * Mirrors the original Tambola behaviour so the host can see at a glance
 * who's still around for another round.
 */
function renderPhoneReadyIndicators() {
  const container = document.getElementById('phone-ready-indicators');
  if (!container) return;
  const ready = firebaseSnapshot.ready || {};
  const players = firebaseSnapshot.players || {};
  // Use the player keys as they were at game-start order, falling back to
  // current players map if those aren't available.
  const keys = Object.keys(players).sort();
  if (keys.length === 0) {
    container.hidden = true;
    container.innerHTML = '';
    return;
  }
  container.hidden = false;
  container.innerHTML = '';
  keys.forEach((k) => {
    const p = players[k] || {};
    const idx = parseInt(k.replace('player_', ''), 10);
    const r = ready[k];
    const dotEl = document.createElement('div');
    dotEl.className = 'ready-dot';
    if (r === true) dotEl.classList.add('ready');
    else if (r === 'left') dotEl.classList.add('left');
    const circle = document.createElement('div');
    circle.className = 'dot';
    const label = document.createElement('span');
    label.className = 'dot-name';
    label.textContent = `${p.emoji || ''} ${p.name || `P${idx + 1}`}`.trim();
    dotEl.appendChild(circle);
    dotEl.appendChild(label);
    container.appendChild(dotEl);
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
