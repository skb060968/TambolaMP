/** Tambola MP — schema-v2 Firebase synchronization and ownership boundary. */
import { db, auth, authReady } from './firebase-config.js';
import {
  ref, set, get, remove, push, onValue, off, onDisconnect, runTransaction,
} from 'firebase/database';
import { serializeTicket, deserializeTicket, validateTicket } from './ticket-generator.js';
import { PATTERNS } from './claim-validator.js';

const ROOM_PATH = 'tambola-mp-rooms';
const ROOM_CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const ROOM_CODE_RE = /^[A-HJ-NP-Z]{4}$/;
const PLAYER_KEY_RE = /^player_([0-9]|1[0-9])$/;
const SCHEMA_VERSION = 2;
const TRANSIENT_CODES = new Set([
  'database/disconnected', 'database/network-error', 'database/unavailable',
  'unavailable', 'network-request-failed',
]);
export const MAX_PLAYERS = 20;

const now = () => Date.now();
const roomPath = (code) => `${ROOM_PATH}/${normalizeRoomCode(code)}`;
const playerKeyFor = (index) => `player_${index}`;
const playerIndexFrom = (key) => Number.parseInt(key.replace('player_', ''), 10);

export function comparePlayerKeys(a, b) {
  return playerIndexFrom(a) - playerIndexFrom(b);
}

function normalizeRoomCode(value) {
  const code = String(value || '').trim().toUpperCase();
  if (!ROOM_CODE_RE.test(code)) throw new Error('Invalid room code');
  return code;
}

function cleanText(value, fallback, maxLength = 14) {
  const text = String(value || '').trim().slice(0, maxLength);
  return text || fallback;
}

async function requireUser() {
  const user = await authReady;
  if (!user?.uid || auth.currentUser?.uid !== user.uid) throw new Error('Authentication unavailable');
  return user;
}
function isTransient(error) {
  const code = String(error?.code || '').toLowerCase();
  return TRANSIENT_CODES.has(code) || code.includes('network') || code.includes('unavailable');
}

export async function firebaseRetry(fn, maxRetries = 2, delayMs = 500) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (error) {
      if (attempt >= maxRetries || !isTransient(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
    }
  }
}

export function generateRoomCode() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => ROOM_CODE_CHARSET[byte % ROOM_CODE_CHARSET.length]).join('');
}

function initialClaims() {
  return Object.fromEntries(Object.values(PATTERNS).map((pattern) => [pattern, { won: false }]));
}

function initialGame(roundId = 0) {
  return {
    drawnNumbers: [], currentNumber: null, drawIndex: 0, autoCallSpeed: null,
    paused: false, roundId, revision: 0, claims: initialClaims(),
  };
}

function assertSchema(room) {
  if (room?.schemaVersion !== SCHEMA_VERSION) throw new Error('Unsupported room version. Create a new room.');
}

function assertHost(room, uid) {
  assertSchema(room);
  if (room.meta?.host?.uid !== uid) throw new Error('Host authorization failed');
}

async function readRoom(code) {
  await requireUser();
  const snap = await firebaseRetry(() => get(ref(db, roomPath(code))));
  return snap.exists() ? snap.val() : null;
}

export async function createRoomAsTv(hostName, hostEmoji) {
  const user = await requireUser();
  for (let attempt = 0; attempt < 12; attempt++) {
    const roomCode = generateRoomCode();
    const createdAt = now();
    const room = {
      schemaVersion: SCHEMA_VERSION,
      meta: {
        host: {
          name: cleanText(hostName, 'TV'), emoji: cleanText(hostEmoji, '📺', 8),
          uid: user.uid, connected: true,
        },
        status: 'lobby', createdAt, updatedAt: createdAt,
      },
      game: initialGame(),
    };
    const result = await firebaseRetry(() => runTransaction(
      ref(db, roomPath(roomCode)),
      (current) => current === null ? room : undefined,
      { applyLocally: false },
    ));
    if (result.committed) return { roomCode };
  }
  throw new Error('Unable to reserve a room code. Try again.');
}

export async function joinRoomAsPlayer(roomCode, playerName, playerEmoji) {
  const user = await requireUser();
  const code = normalizeRoomCode(roomCode);
  let room = await readRoom(code);
  if (!room) return { success: false, reason: 'Room not found' };
  try { assertSchema(room); } catch (error) { return { success: false, reason: error.message }; }
  if (room.meta?.status !== 'lobby') {
    return { success: false, reason: room.meta?.status === 'active' ? 'Game already in progress' : 'Room has ended' };
  }

  const existing = Object.keys(room.players || {}).find((key) => room.players[key]?.uid === user.uid);
  if (existing) {
    const index = playerIndexFrom(existing);
    const result = await runTransaction(ref(db, `${roomPath(code)}/players/${existing}`), (player) => {
      if (!player || player.uid !== user.uid) return undefined;
      return { ...player, connected: true };
    }, { applyLocally: false });
    if (result.committed) return { success: true, playerIndex: index };
  }

  for (let index = 0; index < MAX_PLAYERS; index++) {
    const key = playerKeyFor(index);
    const result = await firebaseRetry(() => runTransaction(
      ref(db, `${roomPath(code)}/players/${key}`),
      (current) => current === null ? {
        name: cleanText(playerName, 'Player'), emoji: cleanText(playerEmoji, '😀', 8),
        uid: user.uid, connected: true, joinedAt: now(),
      } : undefined,
      { applyLocally: false },
    ));
    if (result.committed) return { success: true, playerIndex: index };
    room = await readRoom(code);
    const owned = Object.keys(room?.players || {}).find((candidate) => room.players[candidate]?.uid === user.uid);
    if (owned) return { success: true, playerIndex: playerIndexFrom(owned) };
  }
  return { success: false, reason: `Room is full (${MAX_PLAYERS})` };
}

export async function rejoinRoom(roomCode, playerIndex, role) {
  const user = await requireUser();
  const code = normalizeRoomCode(roomCode);
  const room = await readRoom(code);
  if (!room) return { success: false, reason: 'Room no longer exists' };
  try { assertSchema(room); } catch (error) { return { success: false, reason: error.message }; }

  if (role === 'tv') {
    if (room.meta?.host?.uid !== user.uid) return { success: false, reason: 'This device does not own the room' };
    await set(ref(db, `${roomPath(code)}/meta/host/connected`), true);
  } else {
    const key = playerKeyFor(playerIndex);
    if (!PLAYER_KEY_RE.test(key) || room.players?.[key]?.uid !== user.uid) {
      return { success: false, reason: 'Player session is no longer valid' };
    }
    await set(ref(db, `${roomPath(code)}/players/${key}/connected`), true);
  }
  const freshRoom = await readRoom(code);
  return { success: true, status: freshRoom.meta.status, room: freshRoom };
}

export function listenRoom(roomCode, callbacks) {
  let cancelled = false;
  let roomRef = null;
  let handler = null;
  requireUser().then(() => {
    if (cancelled) return;
    roomRef = ref(db, roomPath(roomCode));
    handler = (snap) => {
      if (!snap.exists()) { callbacks.onRoomDeleted?.(); return; }
      const data = snap.val();
      if (data.schemaVersion !== SCHEMA_VERSION) { callbacks.onError?.(new Error('Unsupported room version')); return; }
      callbacks.onMetaChange?.(data.meta);
      callbacks.onPlayersChange?.(data.players || {});
      callbacks.onGameUpdate?.(data.game);
      callbacks.onMarksChange?.(data.marks || {});
      callbacks.onTicketsChange?.(data.tickets || {});
      callbacks.onClaimRequests?.(data.claimRequests || {});
      callbacks.onClaimResults?.(data.claimResults || {});
      callbacks.onReadyChange?.(data.ready || {});
    };
    onValue(roomRef, handler, (error) => callbacks.onError?.(error));
  }).catch((error) => callbacks.onError?.(error));
  return () => {
    cancelled = true;
    if (roomRef && handler) off(roomRef, 'value', handler);
  };
}
async function hostTransaction(roomCode, mutate) {
  const user = await requireUser();
  const code = normalizeRoomCode(roomCode);
  const result = await firebaseRetry(() => runTransaction(ref(db, roomPath(code)), (room) => {
    if (!room) return undefined;
    assertHost(room, user.uid);
    const previousRevision = room.game?.revision || 0;
    const changed = mutate(room);
    if (!changed) return undefined;
    changed.meta.updatedAt = now();
    changed.game.revision = previousRevision + 1;
    return changed;
  }, { applyLocally: false }));
  if (!result.committed) throw new Error('Room changed. Please retry.');
  return result.snapshot.val();
}

export async function broadcastDraw(roomCode, drawnNumbers, currentNumber) {
  if (!Array.isArray(drawnNumbers) || !Number.isSafeInteger(currentNumber)) {
    throw new Error('Invalid draw');
  }
  const room = await hostTransaction(roomCode, (current) => {
    if (current.meta.status !== 'active') return undefined;
    const previous = current.game.drawnNumbers || [];
    const isOneAppend = drawnNumbers.length === previous.length + 1 &&
      previous.every((number, index) => drawnNumbers[index] === number) &&
      drawnNumbers[drawnNumbers.length - 1] === currentNumber;
    if (!isOneAppend || currentNumber < 1 || currentNumber > 90 || previous.includes(currentNumber)) {
      return undefined;
    }
    current.game.drawnNumbers = [...drawnNumbers];
    current.game.currentNumber = currentNumber;
    current.game.drawIndex = drawnNumbers.length;
    return current;
  });
  return room.game;
}

export async function startGame(roomCode, tickets, expectedPlayerKeys = null) {
  if (!Array.isArray(tickets) || tickets.length < 1 || tickets.some((ticket) => !validateTicket(ticket))) {
    throw new Error('Invalid tickets');
  }
  const room = await hostTransaction(roomCode, (current) => {
    if (current.meta.status !== 'lobby') return undefined;
    const keys = Object.keys(current.players || {}).filter((key) => PLAYER_KEY_RE.test(key)).sort(comparePlayerKeys);
    const expected = expectedPlayerKeys ? [...expectedPlayerKeys].sort(comparePlayerKeys) : keys;
    if (keys.length !== tickets.length || keys.length !== expected.length ||
        keys.some((key, index) => key !== expected[index])) return undefined;
    current.tickets = Object.fromEntries(keys.map((key, index) => [key, serializeTicket(tickets[index])]));
    current.marks = {};
    current.claimRequests = {};
    current.claimResults = {};
    current.ready = {};
    current.game = initialGame((current.game?.roundId || 0) + 1);
    current.meta.status = 'active';
    return current;
  });
  return room.game;
}

export async function setPaused(roomCode, paused) {
  if (typeof paused !== 'boolean') throw new Error('Invalid pause state');
  return hostTransaction(roomCode, (room) => {
    if (room.meta.status !== 'active') return undefined;
    room.game.paused = paused;
    return room;
  });
}

export async function setAutoCallSpeed(roomCode, speedSeconds) {
  if (!Number.isSafeInteger(speedSeconds) || speedSeconds < 1 || speedSeconds > 30) {
    throw new Error('Invalid auto-call speed');
  }
  return hostTransaction(roomCode, (room) => {
    if (room.meta.status !== 'active') return undefined;
    room.game.autoCallSpeed = speedSeconds;
    return room;
  });
}

export async function endGame(roomCode) {
  return hostTransaction(roomCode, (room) => {
    if (room.meta.status !== 'active') return undefined;
    room.meta.status = 'ended';
    room.game.paused = true;
    return room;
  });
}

export async function resetRoom(roomCode) {
  return hostTransaction(roomCode, (room) => {
    if (room.meta.status !== 'ended') return undefined;
    room.meta.status = 'lobby';
    room.tickets = {};
    room.marks = {};
    room.claimRequests = {};
    room.claimResults = {};
    room.ready = {};
    room.game = initialGame(room.game?.roundId || 0);
    return room;
  });
}

export async function deleteRoom(roomCode) {
  const user = await requireUser();
  const code = normalizeRoomCode(roomCode);
  const room = await readRoom(code);
  if (!room) return;
  assertHost(room, user.uid);
  await firebaseRetry(() => remove(ref(db, roomPath(code))));
}

export async function writeClaimWin(roomCode, pattern, payload) {
  if (!Object.values(PATTERNS).includes(pattern)) throw new Error('Invalid claim pattern');
  return hostTransaction(roomCode, (room) => {
    if (room.meta.status !== 'active' || room.game.claims?.[pattern]?.won) return undefined;
    room.game.claims[pattern] = { won: true, ...payload };
    return room;
  });
}

export async function writeClaimRejected(roomCode, requestId, reason) {
  return hostTransaction(roomCode, (room) => {
    room.claimResults ||= {};
    room.claimResults[requestId] = {
      valid: false, reason: cleanText(reason, 'Invalid claim', 120), resolvedAt: now(),
    };
    return room;
  });
}

export async function clearClaimRequest(roomCode, requestId) {
  return hostTransaction(roomCode, (room) => {
    if (!room.claimRequests?.[requestId]) return undefined;
    delete room.claimRequests[requestId];
    return room;
  });
}

export async function resolveClaimRequest(roomCode, requestId, resolution) {
  return hostTransaction(roomCode, (room) => {
    const request = room.claimRequests?.[requestId];
    if (!request || room.meta.status !== 'active') return undefined;
    room.claimResults ||= {};
    if (resolution.valid) {
      const pattern = request.pattern;
      if (!Object.values(PATTERNS).includes(pattern) || room.game.claims?.[pattern]?.won) return undefined;
      room.game.claims[pattern] = {
        won: true,
        winner: resolution.winner,
        winnerPlayerKey: resolution.winnerPlayerKey,
        wonAt: resolution.wonAt,
        playerName: resolution.playerName,
        patternLabel: resolution.patternLabel,
      };
      room.claimResults[requestId] = { valid: true, resolvedAt: now() };
    } else {
      room.claimResults[requestId] = {
        valid: false, reason: cleanText(resolution.reason, 'Invalid claim', 120), resolvedAt: now(),
      };
    }
    delete room.claimRequests[requestId];
    return room;
  });
}
async function ownedPlayer(roomCode, playerIndex) {
  const user = await requireUser();
  const code = normalizeRoomCode(roomCode);
  const key = playerKeyFor(playerIndex);
  if (!PLAYER_KEY_RE.test(key)) throw new Error('Invalid player slot');
  const room = await readRoom(code);
  assertSchema(room);
  if (room.players?.[key]?.uid !== user.uid) throw new Error('Player authorization failed');
  return { user, code, key, room };
}

export async function writePlayerMarks(roomCode, playerIndex, marksArray) {
  const { code, key, room } = await ownedPlayer(roomCode, playerIndex);
  if (room.meta.status !== 'active') throw new Error('Round is not active');
  const ticket = deserializeTicket(room.tickets?.[key]);
  const ticketNumbers = new Set(ticket.flat().filter((number) => number > 0));
  const called = new Set(room.game?.drawnNumbers || []);
  const marks = [...new Set(marksArray)].sort((a, b) => a - b);
  if (marks.length > 15 || marks.some((number) =>
    !Number.isSafeInteger(number) || !ticketNumbers.has(number) || !called.has(number))) {
    throw new Error('Invalid marks');
  }
  await firebaseRetry(() => set(ref(db, `${roomPath(code)}/marks/${key}`), marks));
}

export async function submitClaimRequest(roomCode, playerIndex, pattern) {
  if (!Object.values(PATTERNS).includes(pattern)) throw new Error('Invalid claim pattern');
  const { user, code, key, room } = await ownedPlayer(roomCode, playerIndex);
  if (room.meta.status !== 'active') throw new Error('Round is not active');
  if (room.game?.claims?.[pattern]?.won) throw new Error('Pattern already won');
  const duplicate = Object.values(room.claimRequests || {}).some(
    (request) => request?.uid === user.uid && request?.pattern === pattern &&
      request?.roundId === room.game.roundId,
  );
  if (duplicate) throw new Error('Claim already pending');
  const requestRef = push(ref(db, `${roomPath(code)}/claimRequests`));
  await firebaseRetry(() => set(requestRef, {
    pattern, playerIndex, playerKey: key, uid: user.uid,
    roundId: room.game.roundId, ts: now(),
  }));
  return requestRef.key;
}

export async function leaveRoom(roomCode, playerIndex) {
  const { code, key, room } = await ownedPlayer(roomCode, playerIndex);
  if (room.meta.status === 'active') throw new Error('Cannot leave during an active round');
  const connectedRef = ref(db, `${roomPath(code)}/players/${key}/connected`);
  try { await onDisconnect(connectedRef).cancel(); } catch (_) {}
  await firebaseRetry(() => remove(ref(db, `${roomPath(code)}/players/${key}`)));
}

export async function removePlayer(roomCode, playerIndex) {
  const key = playerKeyFor(playerIndex);
  if (!PLAYER_KEY_RE.test(key)) throw new Error('Invalid player slot');
  return hostTransaction(roomCode, (room) => {
    if (room.meta.status !== 'lobby' || !room.players?.[key]) return undefined;
    delete room.players[key];
    return room;
  });
}

export async function setReady(roomCode, playerIndex, value) {
  if (value !== true && value !== 'left') throw new Error('Invalid ready state');
  const { code, key, room } = await ownedPlayer(roomCode, playerIndex);
  if (room.meta.status !== 'ended') throw new Error('Round has not ended');
  await firebaseRetry(() => set(ref(db, `${roomPath(code)}/ready/${key}`), value));
}

export async function setupTvDisconnectHandler(roomCode) {
  const user = await requireUser();
  const code = normalizeRoomCode(roomCode);
  const room = await readRoom(code);
  assertHost(room, user.uid);
  const connectedRef = ref(db, `${roomPath(code)}/meta/host/connected`);
  const registration = onDisconnect(connectedRef);
  await registration.set(false);
  return () => registration.cancel();
}

export async function setupPlayerDisconnectHandler(roomCode, playerIndex) {
  const { code, key } = await ownedPlayer(roomCode, playerIndex);
  const connectedRef = ref(db, `${roomPath(code)}/players/${key}/connected`);
  const connectionRef = ref(db, '.info/connected');
  let registration = null;
  let disposed = false;

  const handleConnection = async (snapshot) => {
    if (disposed || snapshot.val() !== true) return;
    try {
      registration = onDisconnect(connectedRef);
      // Register the offline write before announcing that this player is online.
      await registration.set(false);
      if (!disposed) await set(connectedRef, true);
    } catch (error) {
      if (!disposed) console.warn('Unable to update player presence:', error.message);
    }
  };

  onValue(connectionRef, handleConnection);
  return async () => {
    disposed = true;
    off(connectionRef, 'value', handleConnection);
    if (registration) {
      try { await registration.cancel(); } catch (_) {}
    }
  };
}
