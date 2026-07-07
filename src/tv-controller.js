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
  removePlayer,
  MAX_PLAYERS,
} from './firebase-sync.js';
import { generateTickets, deserializeTicket } from './ticket-generator.js';
import {
  createGameState, drawNumber, awardClaim, evaluateClaim, getCalledSet, reconstructFromFirebase,
} from './game-engine.js';
import { PATTERNS, PATTERN_LABELS } from './claim-validator.js';

import {
  initAudio, playSound, speakNumber, isMuted, toggleMute,
  startBackgroundMusic, stopBackgroundMusic,
} from './sound-manager.js';
import { showScreen, showToast, confirmModal } from './platform-ui.js';
import { createShareHandler, showQRCode } from './deep-link-handler.js';
import { db } from './firebase-config.js';
import { ref, get } from 'firebase/database';

/* Prize values per pattern. Awarded to the first valid claimer. */
const PATTERN_PRIZES = {
  [PATTERNS.topLine]:    25,
  [PATTERNS.middleLine]: 25,
  [PATTERNS.bottomLine]: 25,
  [PATTERNS.corners]:    25,
  [PATTERNS.fullHouse]:  100,
};

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
 * If the room was 'active' when refreshed, rebuild the local engine state
 * from Firebase so doDraw and claim resolution keep working.
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

  // Pull a fresh snapshot of the room and seed firebaseSnapshot before
  // attaching the listener — otherwise the first listener fire would race
  // with our reconstruct.
  let snapshot = null;
  try {
    const snap = await firebaseRetry(() => get(ref(db, `tambola-mp-rooms/${savedRoomCode}`)));
    if (snap.exists()) snapshot = snap.val();
  } catch (_) {}

  if (snapshot) {
    firebaseSnapshot = {
      meta: snapshot.meta,
      players: snapshot.players || {},
      tickets: snapshot.tickets || {},
      game: snapshot.game || {},
      marks: snapshot.marks || {},
      claimRequests: snapshot.claimRequests || {},
    };
    if (snapshot.players) {
      playerKeysSorted = Object.keys(snapshot.players).sort();
    }
  }

  attachRoomListener();

  if (result.status === 'lobby') {
    showScreen('tv-lobby');
    setupLobbyUi();
  } else if (result.status === 'active' && snapshot) {
    // Rebuild authoritative state from Firebase data so the TV can
    // continue drawing, validating claims, and rendering after a refresh.
    state = reconstructFromFirebase(snapshot, playerKeysSorted);
    // Also rebuild the processed-requests set with already-resolved ones
    // so we don't double-handle any pending claim requests.
    _processedRequests = new Set();
    _resultsShown = false;
    showScreen('tv-game');
    setupGameUi();
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

  if (submit) submit.addEventListener('click', async () => {
    // TV-host has no name/avatar — it's the display, not a player.
    // Pass placeholder values to keep firebase-sync signature stable.
    try {
      const result = await createRoomAsTv('TV', '📺');
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
      // Re-render player side panels so uncut counts update live.
      if (firebaseSnapshot.meta?.status === 'active') {
        renderPlayersSides();
      }
    },
    onClaimRequests: (requests) => {
      firebaseSnapshot.claimRequests = requests;
      processClaimRequests(requests);
    },
    onReadyChange: (ready) => {
      firebaseSnapshot.ready = ready;
      // If we're showing the results screen, refresh the dots so the host
      // can see live who's clicked Play Again vs Home.
      const resultsEl = document.getElementById('tv-results');
      if (resultsEl && !resultsEl.hasAttribute('hidden')) {
        renderTvReadyIndicators();
      }
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
  renderLobbyUi();
}

function renderLobbyUi() {
  const list = document.getElementById('tv-lobby-players');
  if (!list) return;
  const players = firebaseSnapshot.players || {};
  // Skip ghost slots (no name) — leftover from a stale onDisconnect after
  // a player tapped Leave; cleaned up on next join, but we filter here so
  // they don't render in the meantime.
  const keys = Object.keys(players).filter((k) => players[k] && players[k].name).sort();
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
      
      const emojiSpan = document.createElement('span');
      emojiSpan.className = 'emoji';
      emojiSpan.textContent = p.emoji || '😀';
      
      const nameSpan = document.createElement('span');
      nameSpan.className = 'name';
      nameSpan.textContent = p.name || 'Player';
      
      li.appendChild(emojiSpan);
      li.appendChild(nameSpan);
      
      // Add remove button for TV host
      const removeBtn = document.createElement('button');
      removeBtn.className = 'remove-player-btn';
      removeBtn.textContent = '✕';
      removeBtn.title = 'Remove player';
      removeBtn.addEventListener('click', async () => {
        if (!roomCode) return;
        const playerIndex = parseInt(k.replace('player_', ''), 10);
        if (isNaN(playerIndex)) return;
        
        removeBtn.disabled = true;
        try {
          await removePlayer(roomCode, playerIndex);
          showToast(`${p.name} removed from room`);
        } catch (err) {
          console.error('Failed to remove player:', err);
          showToast('Failed to remove player');
          removeBtn.disabled = false;
        }
      });
      li.appendChild(removeBtn);
      
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

  const shareBtn = document.getElementById('btn-tv-share-code');
  if (shareBtn) {
    shareBtn.addEventListener('click', createShareHandler(roomCode, 'Tambola MP'));
  }
  
  const qrBtn = document.getElementById('btn-tv-qr-code');
  if (qrBtn) {
    qrBtn.addEventListener('click', () => {
      if (roomCode) showQRCode(roomCode, 'Tambola MP');
    });
  }

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
  // Get all player keys (including temporarily disconnected ones)
  // We generate tickets for ALL players who joined, regardless of current connection status
  const playerKeys = Object.keys(firebaseSnapshot.players)
    .filter((k) => firebaseSnapshot.players[k] && firebaseSnapshot.players[k].name)
    .sort();
  
  if (playerKeys.length === 0) {
    showToast('Need at least one player to start.');
    return;
  }
  
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
  renderPlayersSides();
  // Reset banner area
  const banner = document.getElementById('tv-winner-banner');
  if (banner) banner.classList.remove('show');
  // Start background music at 15% volume
  startBackgroundMusic(0.15);
}

/**
 * Renders the player columns flanking the caller ball.
 * Players are split half-and-half across the two sides; if more than 10
 * per side they switch to a 2-column inner layout.
 */
function renderPlayersSides() {
  const left = document.getElementById('tv-players-left');
  const right = document.getElementById('tv-players-right');
  if (!left || !right || !state) return;
  const marks = firebaseSnapshot.marks || {};
  const total = state.tickets.length;
  const half = Math.ceil(total / 2);

  const renderInto = (el, fromIdx, toIdx) => {
    const slice = state.playerInfos.slice(fromIdx, toIdx);
    el.innerHTML = '';
    el.classList.toggle('cols-2', slice.length > 10);
    
    // BUGFIX: Get current player keys from Firebase snapshot
    const currentPlayerKeys = Object.keys(firebaseSnapshot.players || {}).sort();
    
    slice.forEach((info, localI) => {
      const idx = fromIdx + localI;
      const ticket = state.tickets[idx];
      const total15 = ticket.flat().filter((v) => v > 0).length;
      
      // Try to find matching player key by index
      const key = currentPlayerKeys.find(k => {
        const keyIdx = parseInt(k.replace('player_', ''), 10);
        return keyIdx === idx;
      }) || `player_${idx}`;
      
      const struck = (marks[key] || []).filter((n) => state.drawnNumbers.includes(n)).length;
      const uncut = total15 - struck;
      const card = document.createElement('div');
      card.className = 'tv-player-card';
      card.innerHTML = `
        <span class="pc-emoji">${escapeHtml(info.emoji || '😀')}</span>
        <span class="pc-name">${escapeHtml(info.name || 'Player')}</span>
        <span class="pc-uncut" title="Numbers remaining">${uncut}</span>`;
      el.appendChild(card);
    });
  };
  renderInto(left, 0, half);
  renderInto(right, half, total);
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

  // Sequence the announcement so it feels like a real lottery:
  //   t=0     ball pops / spins (number hidden), soft chime
  //   t=700   ball settles, number reveals, speech plays, Firebase write
  //           goes out → phones update grid + last-3 + auto-cut at the same
  //           moment the TV reveals.
  // Without this gating, phones strike the number on their tickets before
  // the ball has even finished animating, which makes the ticket feel like
  // it knows the next number ahead of time.
  playSound('draw', 0.5);
  animateBall(result.number);

  setTimeout(async () => {
    speakNumber(result.number);
    renderCallerUi();
    renderCalledGrid();
    renderPlayersSides();
    try {
      await broadcastDraw(roomCode, state.drawnNumbers, result.number);
    } catch (err) {
      console.warn('broadcastDraw failed:', err.message);
    }
  }, 700);
}

function toggleAutoCall() {
  if (_autoCallTimer != null) {
    stopAutoCall();
  } else {
    const speedSel = document.getElementById('tv-auto-speed');
    const speed = speedSel ? parseInt(speedSel.value, 10) : 3;
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
  if (!numEl) return;
  if (state && state.drawnNumbers.length > 0) {
    numEl.textContent = state.drawnNumbers[state.drawnNumbers.length - 1];
  } else {
    numEl.textContent = '—';
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

function animateBall(number) {
  const ball = document.getElementById('tv-caller-ball');
  if (!ball) return;
  // Two-phase: spinning (drop+bounce, hides number), then settled (number reveal).
  ball.classList.remove('spinning', 'settled');
  void ball.offsetWidth;
  ball.classList.add('spinning');
  setTimeout(() => {
    ball.classList.remove('spinning');
    void ball.offsetWidth;
    ball.classList.add('settled');
  }, 700);
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
    
    // BUGFIX: Rebuild playerKeysSorted from current Firebase snapshot
    // to handle removed/rejoined players correctly
    const currentPlayerKeys = Object.keys(firebaseSnapshot.players || {}).sort();
    
    // Find the actual playerKey by matching the playerIndex
    // playerIndex comes from phone which knows its own slot
    const playerKey = currentPlayerKeys.find(k => {
      const idx = parseInt(k.replace('player_', ''), 10);
      return idx === playerIndex;
    });
    
    if (!playerKey) {
      console.warn(`No playerKey found for playerIndex ${playerIndex}`);
      await writeClaimRejected(roomCode, id, 'Player not found');
      await clearClaimRequest(roomCode, id);
      continue;
    }
    
    const marksArr = (firebaseSnapshot.marks || {})[playerKey] || [];
    const markedSet = new Set(marksArr);
    
    // Find the array index in playerKeysSorted (where the ticket is stored)
    const stateArrayIndex = playerKeysSorted.indexOf(playerKey);
    
    if (stateArrayIndex === -1) {
      console.warn(`PlayerKey ${playerKey} not found in playerKeysSorted`);
      await writeClaimRejected(roomCode, id, 'Player ticket not found');
      await clearClaimRequest(roomCode, id);
      continue;
    }
    
    const result = evaluateClaim(state, stateArrayIndex, markedSet, pattern);
    if (result.valid) {
      const playerInfo = state.playerInfos[stateArrayIndex] || { name: 'Player', emoji: '😀' };
      state = awardClaim(state, pattern, stateArrayIndex, playerInfo.name);
      await writeClaimWin(roomCode, pattern, {
        winner: stateArrayIndex,
        wonAt: Date.now(),
        playerName: playerInfo.name,
        patternLabel: PATTERN_LABELS[pattern],
      });
      showWinnerBanner(playerInfo, pattern);
      playSound('win');
      renderPlayersSides();
      if (state.gameOver) {
        // Full House won — host should auto-end so phones see the
        // results screen without anyone having to press "End".
        stopAutoCall();
        try { await fbEndGame(roomCode); } catch (_) {}
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
  renderTvReadyIndicators();
  showScreen('tv-results');
}

/**
 * Renders the per-player ready dots on the TV results screen.
 * Green = player clicked Play Again, Red = player clicked Home,
 * hollow = waiting. The host uses this to decide when to start a new round.
 */
function renderTvReadyIndicators() {
  const container = document.getElementById('tv-ready-indicators');
  if (!container) return;
  const ready = firebaseSnapshot.ready || {};
  const players = firebaseSnapshot.players || {};
  const keys = Object.keys(players).filter((k) => players[k] && players[k].name).sort();
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

function renderResultsUi() {
  const list = document.getElementById('tv-results-list');
  if (!list || !state) return;
  list.innerHTML = '';
  // Track totals per player for the prize summary.
  const totals = {};
  Object.keys(PATTERNS).forEach((p) => {
    const c = state.claims[p];
    const prize = PATTERN_PRIZES[p] || 0;
    const li = document.createElement('li');
    if (c?.won) {
      const name = c.playerName || (state.playerInfos[c.winner]?.name) || 'Player';
      totals[c.winner] = (totals[c.winner] || 0) + prize;
      li.innerHTML = `<span class="rl-pat">${PATTERN_LABELS[p]}</span> <span class="rl-winner">🏆 ${escapeHtml(name)}</span> <span class="rl-prize">🪙 ${prize}</span>`;
    } else {
      li.innerHTML = `<span class="rl-pat">${PATTERN_LABELS[p]}</span> <span class="rl-winner muted">Unclaimed</span> <span class="rl-prize muted">🪙 ${prize}</span>`;
    }
    list.appendChild(li);
  });
  // Prize summary section
  const summary = document.getElementById('tv-results-summary');
  if (summary) {
    summary.innerHTML = '';
    const entries = Object.entries(totals).sort((a, b) => b[1] - a[1]);
    if (entries.length > 0) {
      const heading = document.createElement('h3');
      heading.className = 'tv-results-summary-heading';
      heading.textContent = '🏆 Prize Summary';
      summary.appendChild(heading);
      entries.forEach(([idx, coins]) => {
        const info = state.playerInfos[idx] || { name: 'Player', emoji: '😀' };
        const row = document.createElement('div');
        row.className = 'tv-results-total-row';
        row.innerHTML = `<span class="rl-emoji">${escapeHtml(info.emoji)}</span><span class="rl-name">${escapeHtml(info.name)}</span><span class="rl-total">🪙 ${coins}</span>`;
        summary.appendChild(row);
      });
    }
  }
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
  stopBackgroundMusic();
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
