/**
 * Tambola MP — Claim Validator
 *
 * Validates claims for the 5 supported patterns:
 *   - topLine     (row 0 fully marked)
 *   - middleLine  (row 1 fully marked)
 *   - bottomLine  (row 2 fully marked)
 *   - corners     (first and last numbered cells of rows 0 and 2 — 4 cells)
 *   - fullHouse   (all 15 numbers marked)
 *
 * Early Five is intentionally dropped — the TV+phones format keeps the
 * round friendly and Early Five tends to dominate the early game.
 */

import { validateTicket } from './ticket-generator.js';

export const PATTERNS = {
  topLine: 'topLine',
  middleLine: 'middleLine',
  bottomLine: 'bottomLine',
  corners: 'corners',
  fullHouse: 'fullHouse',
};

export const PATTERN_LABELS = {
  topLine: 'Top Line',
  middleLine: 'Middle Line',
  bottomLine: 'Bottom Line',
  corners: '4 Corners',
  fullHouse: 'Full House',
};

function getRowNumbers(ticket, rowIndex) {
  return ticket[rowIndex].filter((v) => v > 0);
}

function getCornerNumbers(ticket) {
  const row0 = ticket[0].filter((v) => v > 0);
  const row2 = ticket[2].filter((v) => v > 0);
  return [row0[0], row0[row0.length - 1], row2[0], row2[row2.length - 1]];
}

function getAllNumbers(ticket) {
  return ticket.flat().filter((v) => v > 0);
}

export function validateClaim(ticket, markedNumbers, calledNumbers, pattern) {
  if (!validateTicket(ticket)) return { valid: false, reason: 'Invalid ticket' };
  if (!(markedNumbers instanceof Set) || !(calledNumbers instanceof Set)) {
    return { valid: false, reason: 'Invalid claim data' };
  }
  const ticketNumbers = new Set(getAllNumbers(ticket));
  for (const number of markedNumbers) {
    if (!Number.isSafeInteger(number) || !ticketNumbers.has(number)) {
      return { valid: false, reason: 'Invalid marked numbers' };
    }
  }
  for (const number of calledNumbers) {
    if (!Number.isSafeInteger(number) || number < 1 || number > 90) {
      return { valid: false, reason: 'Invalid called numbers' };
    }
  }

  switch (pattern) {
    case PATTERNS.topLine:
      return validateLine(ticket, markedNumbers, calledNumbers, 0);
    case PATTERNS.middleLine:
      return validateLine(ticket, markedNumbers, calledNumbers, 1);
    case PATTERNS.bottomLine:
      return validateLine(ticket, markedNumbers, calledNumbers, 2);
    case PATTERNS.corners:
      return validateCorners(ticket, markedNumbers, calledNumbers);
    case PATTERNS.fullHouse:
      return validateFullHouse(ticket, markedNumbers, calledNumbers);
    default:
      return { valid: false, reason: `Unknown pattern: ${pattern}` };
  }
}

function validateLine(ticket, markedNumbers, calledNumbers, rowIndex) {
  const missing = getRowNumbers(ticket, rowIndex).filter(
    (n) => !markedNumbers.has(n) || !calledNumbers.has(n)
  );
  return missing.length > 0
    ? { valid: false, reason: `Row ${rowIndex + 1} missing: ${missing.join(', ')}` }
    : { valid: true };
}

function validateCorners(ticket, markedNumbers, calledNumbers) {
  const missing = getCornerNumbers(ticket).filter(
    (n) => !markedNumbers.has(n) || !calledNumbers.has(n)
  );
  return missing.length > 0
    ? { valid: false, reason: `Corners missing: ${missing.join(', ')}` }
    : { valid: true };
}

function validateFullHouse(ticket, markedNumbers, calledNumbers) {
  const markedCount = getAllNumbers(ticket).filter(
    (n) => markedNumbers.has(n) && calledNumbers.has(n)
  ).length;
  return markedCount < 15
    ? { valid: false, reason: `${markedCount}/15 marked` }
    : { valid: true };
}
