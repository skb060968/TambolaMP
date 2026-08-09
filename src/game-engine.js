/**
 * Tambola MP — Game Engine
 * Pure functions used by the TV host.
 */

import { validateClaim, PATTERNS } from './claim-validator.js';
import { deserializeTicket, validateTicket } from './ticket-generator.js';

export function createGameState(tickets, playerInfos, playerKeys = []) {
  if (!Array.isArray(tickets) || tickets.some((ticket) => !validateTicket(ticket))) {
    throw new Error('Cannot start with invalid tickets');
  }
  if (tickets.length !== playerInfos.length ||
      (playerKeys.length > 0 && playerKeys.length !== tickets.length)) {
    throw new Error('Player and ticket mappings do not match');
  }
  const remainingPool = Array.from({ length: 90 }, (_, index) => index + 1);
  return {
    tickets,
    playerInfos,
    playerKeys: playerKeys.length ? [...playerKeys] : tickets.map((_, index) => `player_${index}`),
    drawnNumbers: [],
    remainingPool,
    claims: {
      [PATTERNS.topLine]: { won: false },
      [PATTERNS.middleLine]: { won: false },
      [PATTERNS.bottomLine]: { won: false },
      [PATTERNS.corners]: { won: false },
      [PATTERNS.fullHouse]: { won: false },
    },
    gameOver: false,
  };
}

export function drawNumber(state) {
  if (!state?.remainingPool?.length) return null;
  const index = Math.floor(Math.random() * state.remainingPool.length);
  const number = state.remainingPool[index];
  return {
    number,
    newState: {
      ...state,
      drawnNumbers: [...state.drawnNumbers, number],
      remainingPool: state.remainingPool.filter((_, poolIndex) => poolIndex !== index),
    },
  };
}

export function getCalledSet(state) {
  return new Set(state.drawnNumbers);
}

export function awardClaim(state, pattern, playerIndex, playerName, playerKey = null) {
  if (!state.claims[pattern] || state.claims[pattern].won) return state;
  const winnerPlayerKey = playerKey || state.playerKeys?.[playerIndex] || `player_${playerIndex}`;
  const winner = Number.parseInt(winnerPlayerKey.replace('player_', ''), 10);
  const claims = {
    ...state.claims,
    [pattern]: {
      won: true,
      winner,
      winnerPlayerKey,
      wonAt: Date.now(),
      playerName,
    },
  };
  return { ...state, claims, gameOver: pattern === PATTERNS.fullHouse };
}

export function evaluateClaim(state, playerIndex, markedSet, pattern) {
  const ticket = state?.tickets?.[playerIndex];
  if (!validateTicket(ticket)) return { valid: false, reason: 'No valid ticket for player' };
  if (!Object.values(PATTERNS).includes(pattern)) return { valid: false, reason: 'Unknown pattern' };
  if (state.claims[pattern]?.won) return { valid: false, reason: 'Pattern already won' };
  return validateClaim(ticket, markedSet, getCalledSet(state), pattern);
}

export function reconstructFromFirebase(firebaseRoom, playerKeysSorted) {
  const keys = [...playerKeysSorted].sort(
    (a, b) => Number(a.replace('player_', '')) - Number(b.replace('player_', '')),
  );
  const tickets = keys.map((key) => deserializeTicket(firebaseRoom.tickets?.[key]));
  const playerInfos = keys.map((key) => ({
    name: firebaseRoom.players?.[key]?.name || 'Player',
    emoji: firebaseRoom.players?.[key]?.emoji || '😀',
  }));
  const drawn = firebaseRoom.game?.drawnNumbers || [];
  if (!Array.isArray(drawn) || new Set(drawn).size !== drawn.length ||
      drawn.some((number) => !Number.isSafeInteger(number) || number < 1 || number > 90)) {
    throw new Error('Invalid persisted draw state');
  }
  const drawnSet = new Set(drawn);
  const claims = {};
  for (const pattern of Object.values(PATTERNS)) {
    claims[pattern] = firebaseRoom.game?.claims?.[pattern] || { won: false };
  }
  return {
    tickets,
    playerInfos,
    playerKeys: keys,
    drawnNumbers: [...drawn],
    remainingPool: Array.from({ length: 90 }, (_, index) => index + 1)
      .filter((number) => !drawnSet.has(number)),
    claims,
    gameOver: !!claims.fullHouse?.won,
  };
}
