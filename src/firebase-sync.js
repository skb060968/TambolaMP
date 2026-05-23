/**
 * Tambola MP — Firebase Sync
 *
 * Rooms stored under `tambola-mp-rooms/{roomCode}`.
 *
 * Roles:
 *   - TV-host: only writer for game/* and claims/*. Reads claimRequests/* and resolves them.
 *   - Player: writes own marks/player_N and submits claimRequests/*. Reads everything else.
 *
 * Up to 20 players per room. Letters-only 4-char codes.
 */

import { db, auth } from './firebase-config.js';
import {
  ref, set, get, update, remove, push, onValue, off, onDisconnect,
} from 'firebase/database';
import { serializeTicket } from './ticket-generator.js';

const ROOM_PATH = 'tambola-mp-rooms';
const ROOM_CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const MAX_PLAYERS = 20;

/* ======= RETRY ======= */
export async function firebaseRetry(fn, maxRetries = 2, delayMs = 500) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { return await fn(); }
    catch (err) {
      if (attempt === maxRetries) throw err;
      console.warn(`Firebase retry ${attempt + 1}/${maxRetries}:`, err.message);
      await new Promise((r) => setTimeout(r, delayMs * (attempt + 1)));
    }
  }
}

/* ======= ROOM CODE ======= */
export function generateRoomCode() {
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += ROOM_CODE_CHARSET[Math.floor(Math.random() * ROOM_CODE_CHARSET.length)];
  }
  return code;
}

/* ======= TV: CREATE ======= */
/**
 * Creates a new room with TV-host metadata. The TV holds no ticket.
 * @returns {Promise<{ roomCode: string }>}
 */
export async function createRoomAsTv(hostName, hostEmoji) {
  const uid = auth.currentUser?.uid || 'anonymous';
  const roomCode = generateRoomCode();
  const roomRef = ref(db, `${ROOM_PATH}/${roomCode}`);
  const data = {
    meta: {
      host: { name: hostName, emoji: hostEmoji, uid, connected: true },
      status: 'lobby',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    players: {},
    tickets: {},
    game: {
      drawnNumbers: [],
      currentNumber: null,
      drawIndex: 0,
      autoCallSpeed: null,
      paused: false,
      claims: {
        topLine:    { won: false },
        middleLine: { won: false },
        bottomLine: { won: false },
        corners:    { won: false },
        fullHouse:  { won: false },
      },
    },
    marks: {},
    claimRequests: {},
    claimResults: {},
    ready: {},
  };
  await firebaseRetry(() => set(roomRef, data));
  return { roomCode };
}

/* ======= PHONE: JOIN ======= */
/**
 * Joins a room as a player. Returns assigned playerIndex (0..19) on success.
 */
export async function joinRoomAsPlayer(roomCode, playerName, playerEmoji) {
  const roomRef = ref(db, `${ROOM_PATH}/${roomCode}`);
  const snap = await firebaseRetry(() => get(roomRef));
  if (!snap.exists()) return { success: false, reason: 'Room not found' };
  const data = snap.val();
  if (data.meta?.status === 'active') return { success: false, reason: 'Game already in progress' };
  if (data.meta?.status === 'ended') return { success: false, reason: 'Room has ended' };

  const players = data.players || {};
  const existingIndices = Object.keys(players)
    .map((k) => parseInt(k.replace('player_', ''), 10))
    .filter((n) => !isNaN(n));
  if (existingIndices.length >= MAX_PLAYERS) {
    return { success: false, reason: `Room is full (${MAX_PLAYERS})` };
  }
  const nextIndex = existingIndices.length > 0 ? Math.max(...existingIndices) + 1 : 0;
  const uid = auth.currentUser?.uid || 'anonymous';
  await firebaseRetry(() =>
    update(ref(db, `${ROOM_PATH}/${roomCode}`), {
      [`players/player_${nextIndex}`]: { name: playerName, emoji: playerEmoji, uid, connected: true },
      'meta/updatedAt': Date.now(),
    })
  );
  return { success: true, playerIndex: nextIndex };
}

/* ======= REJOIN (after refresh) ======= */
export async function rejoinRoom(roomCode, playerIndex, role) {
  const roomRef = ref(db, `${ROOM_PATH}/${roomCode}`);
  const snap = await firebaseRetry(() => get(roomRef));
  if (!snap.exists()) return { success: false, reason: 'Room no longer exists' };
  const data = snap.val();

  if (role === 'tv') {
    // TV refresh: re-flag host connected
    await firebaseRetry(() =>
      update(ref(db, `${ROOM_PATH}/${roomCode}/meta/host`), { connected: true })
    );
    return { success: true, status: data.meta.status };
  }

  // Player refresh
  const playerKey = `player_${playerIndex}`;
  if (!data.players || !data.players[playerKey]) {
    return { success: false, reason: 'Player slot not found' };
  }
  await firebaseRetry(() =>
    update(ref(db, `${ROOM_PATH}/${roomCode}/players/${playerKey}`), { connected: true })
  );
  return { success: true, status: data.meta.status };
}

/* ======= LISTEN ======= */
/**
 * Subscribe to a whole room. Returns an unsubscribe function.
 * Callbacks receive only the relevant slice on each change.
 */
export function listenRoom(roomCode, callbacks) {
  const roomRef = ref(db, `${ROOM_PATH}/${roomCode}`);
  const handler = (snap) => {
    if (!snap.exists()) {
      if (callbacks.onRoomDeleted) callbacks.onRoomDeleted();
      return;
    }
    const data = snap.val();
    if (callbacks.onMetaChange && data.meta) callbacks.onMetaChange(data.meta);
    if (callbacks.onPlayersChange && data.players !== undefined) callbacks.onPlayersChange(data.players || {});
    if (callbacks.onGameUpdate && data.game) callbacks.onGameUpdate(data.game);
    if (callbacks.onMarksChange) callbacks.onMarksChange(data.marks || {});
    if (callbacks.onTicketsChange) callbacks.onTicketsChange(data.tickets || {});
    if (callbacks.onClaimRequests) callbacks.onClaimRequests(data.claimRequests || {});
    if (callbacks.onClaimResults) callbacks.onClaimResults(data.claimResults || {});
    if (callbacks.onReadyChange) callbacks.onReadyChange(data.ready || {});
  };
  onValue(roomRef, handler);
  return () => off(roomRef, 'value', handler);
}

/* ======= TV: WRITES ======= */
export async function broadcastDraw(roomCode, drawnNumbers, currentNumber) {
  await firebaseRetry(() =>
    update(ref(db, `${ROOM_PATH}/${roomCode}/game`), {
      drawnNumbers,
      currentNumber,
      drawIndex: drawnNumbers.length,
    })
  );
}

export async function startGame(roomCode, tickets) {
  // Map tickets onto the actual sorted player keys.
  const playersRef = ref(db, `${ROOM_PATH}/${roomCode}/players`);
  const snap = await firebaseRetry(() => get(playersRef));
  const players = snap.val() || {};
  const playerKeys = Object.keys(players).sort();
  const serialized = {};
  playerKeys.forEach((key, i) => {
    if (i < tickets.length) serialized[key] = serializeTicket(tickets[i]);
  });
  await firebaseRetry(() =>
    update(ref(db, `${ROOM_PATH}/${roomCode}`), {
      'meta/status': 'active',
      'meta/updatedAt': Date.now(),
      tickets: serialized,
    })
  );
}

export async function setPaused(roomCode, paused) {
  await firebaseRetry(() =>
    update(ref(db, `${ROOM_PATH}/${roomCode}/game`), { paused })
  );
}

export async function setAutoCallSpeed(roomCode, speedSeconds) {
  await firebaseRetry(() =>
    update(ref(db, `${ROOM_PATH}/${roomCode}/game`), { autoCallSpeed: speedSeconds })
  );
}

export async function endGame(roomCode) {
  await firebaseRetry(() =>
    update(ref(db, `${ROOM_PATH}/${roomCode}/meta`), { status: 'ended', updatedAt: Date.now() })
  );
}

export async function resetRoom(roomCode) {
  await firebaseRetry(() =>
    update(ref(db, `${ROOM_PATH}/${roomCode}`), {
      'meta/status': 'lobby',
      'meta/updatedAt': Date.now(),
      tickets: {},
      game: {
        drawnNumbers: [],
        currentNumber: null,
        drawIndex: 0,
        autoCallSpeed: null,
        paused: false,
        claims: {
          topLine:    { won: false },
          middleLine: { won: false },
          bottomLine: { won: false },
          corners:    { won: false },
          fullHouse:  { won: false },
        },
      },
      marks: {},
      claimRequests: {},
      claimResults: {},
      ready: {},
    })
  );
}

export async function deleteRoom(roomCode) {
  await firebaseRetry(() => remove(ref(db, `${ROOM_PATH}/${roomCode}`)));
}

/* ======= TV: CLAIM RESOLUTION ======= */
export async function writeClaimWin(roomCode, pattern, payload) {
  await firebaseRetry(() =>
    update(ref(db, `${ROOM_PATH}/${roomCode}/game/claims/${pattern}`), {
      won: true,
      ...payload,
    })
  );
}

export async function writeClaimRejected(roomCode, requestId, reason) {
  await firebaseRetry(() =>
    update(ref(db, `${ROOM_PATH}/${roomCode}/claimResults/${requestId}`), {
      valid: false,
      reason,
    })
  );
}

export async function clearClaimRequest(roomCode, requestId) {
  await firebaseRetry(() => remove(ref(db, `${ROOM_PATH}/${roomCode}/claimRequests/${requestId}`)));
}

/* ======= PHONE: WRITES ======= */
export async function writePlayerMarks(roomCode, playerIndex, marksArray) {
  await firebaseRetry(() =>
    update(ref(db, `${ROOM_PATH}/${roomCode}/marks`), {
      [`player_${playerIndex}`]: marksArray,
    })
  );
}

/**
 * Submit a claim request. Returns the requestId so the phone can watch claimResults/{requestId}.
 */
export async function submitClaimRequest(roomCode, playerIndex, pattern) {
  const reqRef = push(ref(db, `${ROOM_PATH}/${roomCode}/claimRequests`));
  await firebaseRetry(() =>
    set(reqRef, { pattern, playerIndex, ts: Date.now() })
  );
  return reqRef.key;
}

export async function leaveRoom(roomCode, playerIndex) {
  await firebaseRetry(() =>
    remove(ref(db, `${ROOM_PATH}/${roomCode}/players/player_${playerIndex}`))
  );
}

/* ======= READY (PLAY AGAIN) ======= */
export async function setReady(roomCode, playerIndex, value) {
  await firebaseRetry(() =>
    update(ref(db, `${ROOM_PATH}/${roomCode}/ready`), {
      [`player_${playerIndex}`]: value,
    })
  );
}

/* ======= DISCONNECT HOOKS ======= */
export function setupTvDisconnectHandler(roomCode) {
  const r = ref(db, `${ROOM_PATH}/${roomCode}/meta/host/connected`);
  onDisconnect(r).set(false).catch((err) => console.warn('TV onDisconnect failed:', err.message));
}

export function setupPlayerDisconnectHandler(roomCode, playerIndex) {
  const r = ref(db, `${ROOM_PATH}/${roomCode}/players/player_${playerIndex}/connected`);
  onDisconnect(r).set(false).catch((err) => console.warn('Player onDisconnect failed:', err.message));
}
