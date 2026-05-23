/**
 * Tambola MP — TV controller
 *
 * Wires the TV-host's full flow:
 *   home → tv-create → tv-lobby → tv-game → tv-results
 *
 * The TV is the single authoritative writer for game state. Phones write only
 * marks/* and claimRequests/*. The TV resolves claim requests and writes
 * winners to game/claims/*.
 */

import {
  createRoomAsTv,
  listenRoom,
  setupTvDisconnectHandler,
  startGame as fbStartGame,
  broadcastDraw,
  setPaused as fbSetPaused,
  setAutoCallSpeed as fbSetAutoCallSpeed,
  endGame as fbEndGame,
  resetRoom as fbResetRoom,
  deleteRoom as fbDeleteRoom,
  writeClaimWin,
  writeClaimRejected,
  clearClaimRequest,
  rejoinRoom,
  firebaseRetry,
  MAX_PLAYERS,
} from './firebase-sync.js';
import { generateTickets, deserializeTicket } from './ticket-generator.js';
import {
  createGameState, drawNumber, awardClaim, evaluateClaim, getCalledSet,
} from './game-engine.js';
import { PATTERNS, PATTERN_LABELS } from './claim-validator.js';
import {
  initAudio, playSound, speakNumber, isMuted, toggleMute,
} from './sound-manager.js';
import { showScreen, showToast, confirmModal } from './platform-ui.js';
import { generateQrSvg } from './qr.js';
import { db } from './firebase-config.js';
import { ref, get } from 'firebase/database';

const SESSION_KEY = 'tambola_mp_session';

let roomCode = null;
let unsubscribe = null;
let state = null;                // TV's local authoritative game state
let playerKeysSorted = [];       // ['player_0', 'player_1', ...]
let firebaseSnapshot = {};       // most recent room snapshot for cross-references
let _autoCallTimer = null;
let _processedRequests = new Set();
let _resultsShown = false;

/* ======= SESSION ======= */
function saveSession() {
  if (roomCode) {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ role: 'tv', roomCode }));
    } catch (_) {}
  }
}
function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch (_) {}
}

/* ======= ENTRY ======= */
export async function startTvFlow() {
  document.body.dataset.mode = 'tv';
  initAudio('display');
  showScreen('tv-create');
  wireTvCreate();
  wireTvLobby();
  wireTvGame();
  wireTvResults();
}

/**
 * Resume a TV session (browser refresh on the TV).
 */
export async function resumeTvSession(savedRoomCode) {
  document.body.dataset.mode = 'tv';
  initAudio('display');
  roomCode = savedRoomCode;
  const result = await rejoinRoom(savedRoomCode, null, 'tv');
  if (!result.success) {
    clearSession();
    showScreen('home');
    return;
  }
  setupTvDisconnectHandler(roomCode);
  attachRoomListener();
  // Show appropriate screen based on status
  if (result.status === 'lobby') {
    showScreen('tv-lobby');
    setupLobbyUi();
  } else if (result.status === 'active') {
    // Reconstruct state from snapshot when listener fires
    showScreen('tv-game');
  } else {
    clearSession();
    showScreen('home');
  }
  wireTvCreate();
  wireTvLobby();
  wireTvGame();
  wireTvResults();
}

/* ======= TV CREATE FORM ======= */
function wireTvCreate() {
  const form = document.getElementById('tv-create');
  if (!form || form.dataset._wired) return;
  form.dataset._wired = '1';

  const submit = document.getElementById('btn-tv-create-submit');
  const back = document.getElementById('btn-tv-create-back');
  const emojiPicker = document.querySelector('.tv-emoji-picker');

  if (emojiPicker) {
    emojiPicker.querySelectorAll('.emoji-btn').forEach((b) => {
      b.addEventListener('click', () => {
        emojiPicker.querySelectorAll('.emoji-btn').forEach((x) => x.classList.remove('selected'));
        b.classList.add('selected');
      });
    });
  }

  if (submit) submit.addEventListener('click', async () => {
    const name = document.getElementById('tv-create-name')?.value.trim() || 'Host';
    const sel = document.querySelector('.tv-emoji-picker .emoji-btn.selected');
    const emoji = sel?.dataset.emoji || '📺';
    try {
      const result = await createRoomAsTv(name, emoji);
      roomCode = result.roomCode;
      saveSession();
      setupTvDisconnectHandler(roomCode);
      attachRoomListener();
      setupLobbyUi();
      showScreen('tv-lobby');
    } catch (err) {
      console.error(err);
      showToast('Failed to create room.');
    }
  });
  if (back) back.addEventListener('click', () => showScreen('home'));
}

/* ======= ROOM LISTENER ======= */
function attachRoomListener() {
  if (unsubscribe) unsubscribe();
  unsubscribe = listenRoom(roomCode, {
    onMetaChange: (meta) => {
      firebaseSnapshot.meta = meta;
      if (meta.status === 'lobby') renderLobbyUi();
    },
    onPlayersChange: (players) => {
      firebaseSnapshot.players = players;
      renderLobbyUi();
      if (firebaseSnapshot.meta?.status === 'active') {
        // Player joined/left mid-game — only relevant if ticket exists; no-op here for v1.
      }
    },
    onTicketsChange: (tickets) => {
      firebaseSnapshot.tickets = tickets;
    },
    onGameUpdate: (game) => {
      firebaseSnapshot.game = game;
      // The TV is authoritative — its writes echo back. We don't react to
      // game updates as remote events; we only ever read here for display
      // refresh after a refresh-restore.
      if (state && state.drawnNumbers && game.drawnNumbers &&
          game.drawnNumbers.length > state.drawnNumbers.length &&
          firebaseSnapshot.meta?.status === 'active') {
        // External write (shouldn't happen in normal flow). Sync local state.
        state = {
          ...state,
          drawnNumbers: [...game.drawnNumbers],
          remainingPool: state.remainingPool.filter((n) => !game.drawnNumbers.includes(n)),
        };
      }
    },
    onMarksChange: (marks) => {
      firebaseSnapshot.marks = marks;
      // Re-render mini-tickets with updated strikes
      if (firebaseSnapshot.meta?.status === 'active') {
        renderMiniTickets();
      }
    },
    onClaimRequests: (requests) => {
      firebaseSnapshot.claimRequests = requests;
      processClaimRequests(requests);
    },
    onRoomDeleted: () => {
      cleanupAndGoHome();
    },
  });
}

/* ======= LOBBY ======= */
function setupLobbyUi() {
  const codeEl = document.getElementById('tv-lobby-code');
  if (codeEl) codeEl.textContent = roomCode;
  const qrEl = document.getElementById('tv-lobby-qr');
  if (qrEl) {
    try {
      const url = `${location.origin}/?code=${roomCode}&action=join`.toUpperCase();
      // Note: QR encoder is alphanumeric only. The URL must uppercase.
      qrEl.innerHTML = generateQrSvg(url, 220);
    } catch (e) {
      qrEl.textContent = roomCode;
    }
  }
  renderLobbyUi();
}

function renderLobbyUi() {
  const list = document.getElementById('tv-lobby-players');
  if (!list) return;
  const players = firebaseSnapshot.players || {};
  const keys = Object.keys(players).sort();
  list.innerHTML = '';
  if (keys.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'tv-empty';
    empty.textContent = 'Waiting for players to join…';
    list.appendChild(empty);
  } else {
    keys.forEach((k) => {
      const p = players[k] || {};
      const li = document.createElement('li');
      li.className = 'tv-lobby-player';
      li.innerHTML = `<span class="emoji">${escapeHtml(p.emoji || '😀')}</span><span class="name">${escapeHtml(p.name || 'Player')}</span>`;
      if (!p.connected) li.classList.add('disconnected');
      list.appendChild(li);
    });
  }
  const startBtn = document.getElementById('btn-tv-start-round');
  if (startBtn) startBtn.disabled = keys.length === 0;
  const countEl = document.getElementById('tv-lobby-count');
  if (countEl) countEl.textContent = `${keys.length} / ${MAX_PLAYERS}`;
}

function wireTvLobby() {
  const screen = document.getElementById('tv-lobby');
  if (!screen || screen.dataset._wired) return;
  screen.dataset._wired = '1';

  const startBtn = document.getElementById('btn-tv-start-round');
  if (startBtn) startBtn.addEventListener('click', startRound);

  const closeBtn = document.getElementById('btn-tv-lobby-close');
  if (closeBtn) closeBtn.addEventListener('click', async () => {
    const ok = await confirmModal('Close room?', 'All players will be disconnected.', 'Close', 'Cancel');
    if (!ok) return;
    if (roomCode) { try { await fbDeleteRoom(roomCode); } catch (_) {} }
    cleanupAndGoHome();
  });

  const muteBtn = document.getElementById('btn-tv-mute');
  if (muteBtn) {
    syncMuteUi();
    muteBtn.addEventListener('click', () => { toggleMute(); syncMuteUi(); });
  }
}

function syncMuteUi() {
  const muteBtn = document.getElementById('btn-tv-mute');
  if (!muteBtn) return;
  muteBtn.textContent = isMuted() ? '🔇' : '🔊';
  muteBtn.title = isMuted() ? 'Unmute' : 'Mute';
}

/* ======= START ROUND ======= */
async function startRound() {
  if (!firebaseSnapshot.players || Object.keys(firebaseSnapshot.players).length === 0) {
    showToast('Need at least one player to start.');
    return;
  }
  const playerKeys = Object.keys(firebaseSnapshot.players).sort();
  playerKeysSorted = playerKeys;
  const tickets = generateTickets(playerKeys.length);
  // Build local engine state.
  const playerInfos = playerKeys.map((k) => ({
    name: firebaseSnapshot.players[k].name,
    emoji: firebaseSnapshot.players[k].emoji,
  }));
  state = createGameState(tickets, playerInfos);
  _resultsShown = false;
  _processedRequests = new Set();
  await fbStartGame(roomCode, tickets);
  showScreen('tv-game');
  setupGameUi();
}

/* ======= GAME UI ======= */
function setupGameUi() {
  renderCallerUi();
  renderCalledGrid();
  renderMiniTickets();
  // Reset banner area
  const banner = document.getElementById('tv-winner-banner');
  if (banner) banner.classList.remove('show');
}

function wireTvGame() {
  const screen = document.getElementById('tv-game');
  if (!screen || screen.dataset._wired) return;
  screen.dataset._wired = '1';

  const nextBtn = document.getElementById('btn-tv-next');
  if (nextBtn) nextBtn.addEventListener('click', () => doDraw());

  const autoBtn = document.getElementById('btn-tv-auto');
  if (autoBtn) autoBtn.addEventListener('click', toggleAutoCall);

  const speedSel = document.getElementById('tv-auto-speed');
  if (speedSel) speedSel.addEventListener('change', () => {
    if (_autoCallTimer != null) {
      stopAutoCall();
      startAutoCall(parseInt(speedSel.value, 10));
    }
    fbSetAutoCallSpeed(roomCode, parseInt(speedSel.value, 10));
  });

  const endBtn = document.getElementById('btn-tv-end');
  if (endBtn) endBtn.addEventListener('click', async () => {
    const ok = await confirmModal('End round?', 'Show final results.', 'End', 'Cancel');
    if (!ok) return;
    stopAutoCall();
    await fbEndGame(roomCode);
    handleRoundEnd();
  });

  const muteBtn = document.getElementById('btn-tv-game-mute');
  if (muteBtn) {
    muteBtn.textContent = isMuted() ? '🔇' : '🔊';
    muteBtn.addEventListener('click', () => {
      toggleMute();
      muteBtn.textContent = isMuted() ? '🔇' : '🔊';
    });
  }
}

async function doDraw() {
  if (!state || state.gameOver) return;
  if (state.remainingPool.length === 0) {
    showToast('All numbers drawn.');
    stopAutoCall();
    return;
  }
  const result = drawNumber(state);
  if (!result) return;
  state = result.newState;
  await broadcastDraw(roomCode, state.drawnNumbers, result.number);
  playSound('draw', 0.5);
  speakNumber(result.number);
  animateBall(result.number);
  renderCallerUi();
  renderCalledGrid();
  renderMiniTickets();
}

function toggleAutoCall() {
  if (_autoCallTimer != null) {
    stopAutoCall();
  } else {
    const speedSel = document.getElementById('tv-auto-speed');
    const speed = speedSel ? parseInt(speedSel.value, 10) : 5;
    startAutoCall(speed);
  }
}

function startAutoCall(seconds) {
  stopAutoCall();
  _autoCallTimer = setInterval(() => {
    doDraw();
  }, seconds * 1000);
  const btn = document.getElementById('btn-tv-auto');
  if (btn) { btn.textContent = '⏸ Pause Auto'; btn.classList.add('active'); }
  fbSetPaused(roomCode, false);
}

function stopAutoCall() {
  if (_autoCallTimer != null) {
    clearInterval(_autoCallTimer);
    _autoCallTimer = null;
  }
  const btn = document.getElementById('btn-tv-auto');
  if (btn) { btn.textContent = '▶ Auto Call'; btn.classList.remove('active'); }
}

/* ======= RENDER ======= */
function renderCallerUi() {
  const numEl = document.getElementById('tv-current-number');
  if (numEl) {
    if (state && state.drawnNumbers.length > 0) {
      numEl.textContent = state.drawnNumbers[state.drawnNumbers.length - 1];
    } else {
      numEl.textContent = '—';
    }
  }
  const lastEl = document.getElementById('tv-last-five');
  if (lastEl && state) {
    const last5 = state.drawnNumbers.slice(-6, -1).reverse();
    lastEl.innerHTML = last5.length === 0 ? '<span class="empty">—</span>' : last5.map((n) => `<span class="last-num">${n}</span>`).join('');
  }
}

function renderCalledGrid() {
  const grid = document.getElementById('tv-called-grid');
  if (!grid) return;
  if (!grid.dataset._built) {
    grid.dataset._built = '1';
    let html = '';
    for (let n = 1; n <= 90; n++) {
      html += `<div class="called-cell" data-num="${n}">${n}</div>`;
    }
    grid.innerHTML = html;
  }
  const drawnSet = state ? new Set(state.drawnNumbers) : new Set();
  const latest = state && state.drawnNumbers.length ? state.drawnNumbers[state.drawnNumbers.length - 1] : null;
  grid.querySelectorAll('.called-cell').forEach((c) => {
    const n = parseInt(c.dataset.num, 10);
    c.classList.toggle('called', drawnSet.has(n));
    c.classList.toggle('latest', n === latest);
  });
}

function renderMiniTickets() {
  const strip = document.getElementById('tv-mini-tickets');
  if (!strip || !state) return;
  strip.className = `tv-mini-tickets count-${state.tickets.length <= 10 ? 'few' : 'many'}`;
  strip.innerHTML = '';
  const marks = firebaseSnapshot.marks || {};
  state.tickets.forEach((ticket, idx) => {
    const key = playerKeysSorted[idx] || `player_${idx}`;
    const playerInfo = state.playerInfos[idx] || { name: 'Player', emoji: '😀' };
    const card = document.createElement('div');
    card.className = 'mini-ticket';
    const calledSet = new Set(state.drawnNumbers);
    const playerMarks = new Set(marks[key] || []);
    let body = '';
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 9; c++) {
        const v = ticket[r][c];
        if (v === 0) {
          body += '<span class="mt-cell empty"></span>';
        } else {
          const struck = playerMarks.has(v) && calledSet.has(v);
          body += `<span class="mt-cell${struck ? ' struck' : ''}">${v}</span>`;
        }
      }
    }
    // Pattern badges this player has won
    const badges = [];
    Object.keys(state.claims).forEach((p) => {
      const c = state.claims[p];
      if (c?.won && c.winner === idx) badges.push(`<span class="mt-badge">${PATTERN_LABELS[p]}</span>`);
    });
    card.innerHTML = `
      <div class="mt-head"><span class="mt-emoji">${escapeHtml(playerInfo.emoji)}</span><span class="mt-name">${escapeHtml(playerInfo.name)}</span></div>
      <div class="mt-body">${body}</div>
      <div class="mt-badges">${badges.join('')}</div>`;
    strip.appendChild(card);
  });
}

function animateBall(number) {
  const ball = document.getElementById('tv-caller-ball');
  if (!ball) return;
  ball.classList.remove('pop');
  void ball.offsetWidth;
  ball.classList.add('pop');
}

/* ======= CLAIMS ======= */
async function processClaimRequests(requests) {
  if (!state || !roomCode) return;
  const ids = Object.keys(requests || {});
  for (const id of ids) {
    if (_processedRequests.has(id)) continue;
    _processedRequests.add(id);
    const req = requests[id];
    if (!req) continue;
    const { pattern, playerIndex } = req;
    const playerKey = playerKeysSorted[playerIndex];
    const marksArr = (firebaseSnapshot.marks || {})[playerKey] || [];
    const markedSet = new Set(marksArr);
    const result = evaluateClaim(state, playerIndex, markedSet, pattern);
    if (result.valid) {
      const playerInfo = state.playerInfos[playerIndex] || { name: 'Player', emoji: '😀' };
      state = awardClaim(state, pattern, playerIndex, playerInfo.name);
      await writeClaimWin(roomCode, pattern, {
        winner: playerIndex,
        wonAt: Date.now(),
        playerName: playerInfo.name,
        patternLabel: PATTERN_LABELS[pattern],
      });
      showWinnerBanner(playerInfo, pattern);
      playSound('win');
      renderMiniTickets();
      if (state.gameOver) {
        stopAutoCall();
        setTimeout(() => handleRoundEnd(), 3500);
      }
    } else {
      await writeClaimRejected(roomCode, id, result.reason || 'Invalid claim');
    }
    await clearClaimRequest(roomCode, id);
  }
}

function showWinnerBanner(playerInfo, pattern) {
  const banner = document.getElementById('tv-winner-banner');
  if (!banner) return;
  banner.innerHTML = `🏆 <strong>${escapeHtml(playerInfo.name)}</strong> won <em>${PATTERN_LABELS[pattern]}</em>!`;
  banner.classList.add('show');
  burstConfetti();
  setTimeout(() => banner.classList.remove('show'), 3000);
}

function burstConfetti() {
  if (typeof window.confetti === 'function') {
    try {
      window.confetti({
        particleCount: 200,
        spread: 90,
        origin: { y: 0.5 },
        colors: ['#ffd700', '#ff6b6b', '#51cf66', '#2b6ef6'],
      });
    } catch (_) {}
  }
}

/* ======= ROUND END / RESULTS ======= */
function handleRoundEnd() {
  if (_resultsShown) return;
  _resultsShown = true;
  stopAutoCall();
  renderResultsUi();
  showScreen('tv-results');
}

function renderResultsUi() {
  const list = document.getElementById('tv-results-list');
  if (!list || !state) return;
  list.innerHTML = '';
  Object.keys(PATTERNS).forEach((p) => {
    const c = state.claims[p];
    const li = document.createElement('li');
    if (c?.won) {
      li.innerHTML = `<span class="rl-pat">${PATTERN_LABELS[p]}</span> <span class="rl-winner">🏆 ${escapeHtml(c.playerName || 'Player')}</span>`;
    } else {
      li.innerHTML = `<span class="rl-pat">${PATTERN_LABELS[p]}</span> <span class="rl-winner muted">—</span>`;
    }
    list.appendChild(li);
  });
}

function wireTvResults() {
  const screen = document.getElementById('tv-results');
  if (!screen || screen.dataset._wired) return;
  screen.dataset._wired = '1';
  const again = document.getElementById('btn-tv-play-again');
  const close = document.getElementById('btn-tv-close-room');
  if (again) again.addEventListener('click', async () => {
    if (!roomCode) return;
    await fbResetRoom(roomCode);
    state = null;
    _resultsShown = false;
    _processedRequests = new Set();
    setupLobbyUi();
    showScreen('tv-lobby');
  });
  if (close) close.addEventListener('click', async () => {
    const ok = await confirmModal('Close room?', 'Players will be disconnected.', 'Close', 'Cancel');
    if (!ok) return;
    if (roomCode) { try { await fbDeleteRoom(roomCode); } catch (_) {} }
    cleanupAndGoHome();
  });
}

/* ======= CLEANUP ======= */
function cleanupAndGoHome() {
  stopAutoCall();
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  clearSession();
  roomCode = null;
  state = null;
  firebaseSnapshot = {};
  playerKeysSorted = [];
  _processedRequests = new Set();
  _resultsShown = false;
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
