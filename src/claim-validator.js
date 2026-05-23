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
  // First and last numbered cells of row 0 and row 2.
  const row0 = ticket[0].filter((v) => v > 0);
  const row2 = ticket[2].filter((v) => v > 0);
  return [row0[0], row0[row0.length - 1], row2[0], row2[row2.length - 1]];
}

function getAllNumbers(ticket) {
  return ticket.flat().filter((v) => v > 0);
}

/**
 * @param {number[][]} ticket
 * @param {Set<number>} markedNumbers   — numbers the player has marked
 * @param {Set<number>} calledNumbers   — numbers actually called by the host
 * @param {string} pattern              — one of PATTERNS
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateClaim(ticket, markedNumbers, calledNumbers, pattern) {
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
  const rowNums = getRowNumbers(ticket, rowIndex);
  const missing = rowNums.filter(
    (n) => !markedNumbers.has(n) || !calledNumbers.has(n)
  );
  if (missing.length > 0) {
    return { valid: false, reason: `Row ${rowIndex + 1} missing: ${missing.join(', ')}` };
  }
  return { valid: true };
}

function validateCorners(ticket, markedNumbers, calledNumbers) {
  const corners = getCornerNumbers(ticket);
  const missing = corners.filter(
    (n) => !markedNumbers.has(n) || !calledNumbers.has(n)
  );
  if (missing.length > 0) {
    return { valid: false, reason: `Corners missing: ${missing.join(', ')}` };
  }
  return { valid: true };
}

function validateFullHouse(ticket, markedNumbers, calledNumbers) {
  const allNums = getAllNumbers(ticket);
  const markedCount = allNums.filter(
    (n) => markedNumbers.has(n) && calledNumbers.has(n)
  ).length;
  if (markedCount < 15) {
    return { valid: false, reason: `${markedCount}/15 marked` };
  }
  return { valid: true };
}
