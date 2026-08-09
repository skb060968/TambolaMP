/**
 * Tambola Ticket Generator (lifted unchanged from existing Tambola project).
 *
 * Generates valid Tambola (Housie) tickets:
 * - 3 rows × 9 columns, 15 numbers per ticket, 5 numbers per row.
 * - Column ranges: col 0 = 1–9, cols 1–7 = c×10..c×10+9, col 8 = 80–90.
 * - Numbers within each column sorted ascending top to bottom.
 */

function getColumnRange(col) {
  if (col === 0) return range(1, 9);
  if (col === 8) return range(80, 90);
  return range(col * 10, col * 10 + 9);
}

function range(min, max) {
  const arr = [];
  for (let i = min; i <= max; i++) arr.push(i);
  return arr;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function generateTicket() {
  const colCounts = distributeColumnCounts();
  const colNumbers = [];
  for (let c = 0; c < 9; c++) {
    const pool = getColumnRange(c);
    shuffle(pool);
    const picked = pool.slice(0, colCounts[c]).sort((a, b) => a - b);
    colNumbers.push(picked);
  }
  const ticket = [
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0],
  ];
  distributeToRows(ticket, colNumbers, colCounts);
  return ticket;
}

function distributeColumnCounts() {
  let attempts = 0;
  while (attempts < 1000) {
    attempts++;
    const counts = new Array(9).fill(1);
    let remaining = 6;
    const indices = shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    for (const idx of indices) {
      if (remaining <= 0) break;
      const canAdd = Math.min(2, remaining);
      const add = canAdd === 1 ? 1 : (Math.random() < 0.5 ? 1 : 2);
      counts[idx] += add;
      remaining -= add;
    }
    if (remaining > 0) {
      for (let c = 0; c < 9 && remaining > 0; c++) {
        const canAdd = 3 - counts[c];
        if (canAdd > 0) {
          const add = Math.min(canAdd, remaining);
          counts[c] += add;
          remaining -= add;
        }
      }
    }
    if (remaining !== 0) continue;
    if (canDistributeToRows(counts)) return counts;
  }
  return [1, 2, 2, 2, 2, 2, 2, 1, 1];
}

function canDistributeToRows(colCounts) {
  return findRowAssignment(colCounts) !== null;
}

function findRowAssignment(colCounts) {
  const rowFill = [0, 0, 0];
  const assignment = new Array(9).fill(null).map(() => []);
  const order = [];
  for (let c = 0; c < 9; c++) if (colCounts[c] === 3) order.push(c);
  for (let c = 0; c < 9; c++) if (colCounts[c] === 1) order.push(c);
  for (let c = 0; c < 9; c++) if (colCounts[c] === 2) order.push(c);

  for (const c of order) {
    const count = colCounts[c];
    if (count === 3) {
      assignment[c] = [0, 1, 2];
      rowFill[0]++; rowFill[1]++; rowFill[2]++;
    } else if (count === 1) {
      const available = [0, 1, 2]
        .filter((r) => rowFill[r] < 5)
        .sort((a, b) => rowFill[a] - rowFill[b]);
      if (available.length === 0) return null;
      assignment[c] = [available[0]];
      rowFill[available[0]]++;
    } else {
      const available = [0, 1, 2]
        .filter((r) => rowFill[r] < 5)
        .sort((a, b) => rowFill[a] - rowFill[b]);
      if (available.length < 2) return null;
      assignment[c] = [available[0], available[1]];
      rowFill[available[0]]++;
      rowFill[available[1]]++;
    }
  }
  if (rowFill[0] !== 5 || rowFill[1] !== 5 || rowFill[2] !== 5) return null;
  return assignment;
}

function distributeToRows(ticket, colNumbers, colCounts) {
  const assignment = findRowAssignment(colCounts);
  for (let c = 0; c < 9; c++) {
    const rows = assignment[c].sort((a, b) => a - b);
    const nums = colNumbers[c];
    for (let i = 0; i < rows.length; i++) {
      ticket[rows[i]][c] = nums[i];
    }
  }
}

export function validateTicket(ticket) {
  if (!Array.isArray(ticket) || ticket.length !== 3) return false;
  const seen = new Set();
  let total = 0;

  for (const row of ticket) {
    if (!Array.isArray(row) || row.length !== 9) return false;
    let rowCount = 0;
    for (const value of row) {
      if (!Number.isSafeInteger(value) || value < 0 || value > 90) return false;
      if (value > 0) {
        rowCount++;
        total++;
        if (seen.has(value)) return false;
        seen.add(value);
      }
    }
    if (rowCount !== 5) return false;
  }
  if (total !== 15) return false;

  for (let col = 0; col < 9; col++) {
    const values = ticket.map((row) => row[col]).filter((value) => value > 0);
    if (values.length < 1 || values.length > 3) return false;
    const min = col === 0 ? 1 : col * 10;
    const max = col === 8 ? 90 : (col * 10) + 9;
    if (values.some((value) => value < min || value > max)) return false;
    if (values.some((value, index) => index > 0 && value <= values[index - 1])) return false;
  }
  return true;
}

export function generateTickets(count) {
  if (!Number.isSafeInteger(count) || count < 0 || count > 20) {
    throw new Error('Ticket count must be between 0 and 20');
  }
  const tickets = [];
  const seen = new Set();
  let attempts = 0;
  const maxAttempts = Math.max(100, count * 100);
  while (tickets.length < count && attempts < maxAttempts) {
    attempts++;
    const ticket = generateTicket();
    if (!validateTicket(ticket)) continue;
    const key = serializeTicket(ticket);
    if (!seen.has(key)) {
      seen.add(key);
      tickets.push(ticket);
    }
  }
  if (tickets.length !== count) throw new Error('Unable to generate enough unique tickets');
  return tickets;
}

export function serializeTicket(ticket) {
  if (!validateTicket(ticket)) throw new Error('Invalid Tambola ticket');
  return ticket.map((row) => row.join(',')).join(';');
}

export function deserializeTicket(str) {
  if (typeof str !== 'string' || str.length < 53 || str.length > 120) {
    throw new Error('Invalid serialized Tambola ticket');
  }
  const ticket = str.split(';').map((row) => row.split(',').map((value) => Number(value)));
  if (!validateTicket(ticket)) throw new Error('Invalid serialized Tambola ticket');
  return ticket;
}
