/**
 * Tambola MP — Game Engine
 *
 * Pure functions for the TV-host's local game state. The TV is the only
 * device running this — phones rely on Firebase reads. No DOM, no Firebase.
 */

import { validateClaim, PATTERNS } from './claim-validator.js';
import { deserializeTicket } from './ticket-generator.js';

/**
 * Creates the TV-host's authoritative game state.
 * @param {number[][][]} tickets  one per player, in player_0..N order
 * @param {Array<{ name: string, emoji: string }>} playerInfos  parallel to tickets
 */
export function createGameState(tickets, playerInfos) {
  const remainingPool = [];
  for (let i = 1; i <= 90; i++) remainingPool.push(i);
  return {
    tickets,
    playerInfos,
    drawnNumbers: [],
    remainingPool,
    claims: {
      [PATTERNS.topLine]:    { won: false },
      [PATTERNS.middleLine]: { won: false },
      [PATTERNS.bottomLine]: { won: false },
      [PATTERNS.corners]:    { won: false },
      [PATTERNS.fullHouse]:  { won: false },
    },
    gameOver: false,
  };
}

/**
 * Draws the next number from the remaining pool.
 * Returns null if exhausted.
 */
export function drawNumber(state) {
  if (state.remainingPool.length === 0) return null;
  const idx = Math.floor(Math.random() * state.remainingPool.length);
  const number = state.remainingPool[idx];
  const newPool = [
    ...state.remainingPool.slice(0, idx),
    ...state.remainingPool.slice(idx + 1),
  ];
  const newState = {
    ...state,
    drawnNumbers: [...state.drawnNumbers, number],
    remainingPool: newPool,
  };
  return { number, newState };
}

/**
 * Convenience: returns the called numbers as a Set.
 */
export function getCalledSet(state) {
  return new Set(state.drawnNumbers);
}

/**
 * Marks a pattern as won by a given player.
 * Idempotent — if already won, returns the existing state unchanged.
 */
export function awardClaim(state, pattern, playerIndex, playerName) {
  if (!state.claims[pattern] || state.claims[pattern].won) return state;
  const newClaims = {
    ...state.claims,
    [pattern]: {
      won: true,
      winner: playerIndex,
      wonAt: Date.now(),
      playerName,
    },
  };
  // Game ends when Full House is won.
  const gameOver = pattern === PATTERNS.fullHouse;
  return { ...state, claims: newClaims, gameOver };
}

/**
 * Validates a player's claim against the host's authoritative state.
 * @param {object} state             host's game state
 * @param {number} playerIndex
 * @param {Set<number>} markedSet    numbers the player has marked (from Firebase)
 * @param {string} pattern
 * @returns {{ valid: boolean, reason?: string }}
 */
export function evaluateClaim(state, playerIndex, markedSet, pattern) {
  const ticket = state.tickets[playerIndex];
  if (!ticket) return { valid: false, reason: 'No ticket for player' };
  if (state.claims[pattern]?.won) return { valid: false, reason: 'Pattern already won' };
  const calledSet = getCalledSet(state);
  return validateClaim(ticket, markedSet, calledSet, pattern);
}

/**
 * Helper used by the TV when it boots up after a refresh: rebuild engine
 * from Firebase data so the local pool/claims match the persisted state.
 */
export function reconstructFromFirebase(firebaseRoom, playerKeysSorted) {
  const tickets = playerKeysSorted.map((k) =>
    deserializeTicket(firebaseRoom.tickets?.[k] || ',,,,,,,,;,,,,,,,,;,,,,,,,,')
  );
  const playerInfos = playerKeysSorted.map((k) => ({
    name: firebaseRoom.players?.[k]?.name || 'Player',
    emoji: firebaseRoom.players?.[k]?.emoji || '😀',
  }));
  const drawn = firebaseRoom.game?.drawnNumbers || [];
  const drawnSet = new Set(drawn);
  const remainingPool = [];
  for (let i = 1; i <= 90; i++) if (!drawnSet.has(i)) remainingPool.push(i);
  const fbClaims = firebaseRoom.game?.claims || {};
  const claims = {};
  for (const k of Object.keys(PATTERNS)) {
    claims[k] = fbClaims[k] || { won: false };
  }
  return {
    tickets,
    playerInfos,
    drawnNumbers: drawn,
    remainingPool,
    claims,
    gameOver: !!claims.fullHouse?.won,
  };
}
