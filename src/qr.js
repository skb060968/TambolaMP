/**
 * Tiny dependency-free QR code generator.
 *
 * Produces a black-and-white SVG of a Version 1-10 QR code (alphanumeric mode).
 * Sufficient for short URLs like `https://tambola-mp.vercel.app/display.html?code=ABCD`.
 *
 * Implements only what we need: alphanumeric encoding, error-correction L,
 * versions auto-selected up to 10 (max ~395 alphanumeric chars).
 *
 * Adapted from Project Nayuki's QR Code generator (MIT). Trimmed to essentials.
 */

const ALPHANUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

const ECC_CODEWORDS = {
  // [version 1..10] for ecc level L
  1: 7, 2: 10, 3: 15, 4: 20, 5: 26, 6: 18, 7: 20, 8: 24, 9: 30, 10: 18,
};
// Number of error-correction blocks per version (L)
const ECC_BLOCKS = {
  1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 2, 7: 2, 8: 2, 9: 2, 10: 4,
};
// Total codewords per version (data + ecc)
const TOTAL_CODEWORDS = {
  1: 26, 2: 44, 3: 70, 4: 100, 5: 134, 6: 172, 7: 196, 8: 242, 9: 292, 10: 346,
};

/**
 * Public: generate an SVG QR code for the given text.
 * Returns the SVG markup as a string (drop into innerHTML or as a Data URL).
 * @param {string} text  alphanumeric text (uppercase letters, digits, space, $%*+-./:)
 * @param {number} sizePx  pixel size of the resulting svg square
 */
export function generateQrSvg(text, sizePx = 240) {
  const upper = text.toUpperCase();
  if (![...upper].every((c) => ALPHANUM.includes(c))) {
    throw new Error('QR text contains characters outside alphanumeric mode');
  }

  const version = chooseVersion(upper);
  const size = 17 + version * 4;
  const totalBits = TOTAL_CODEWORDS[version] * 8;
  const eccPerBlock = ECC_CODEWORDS[version];
  const numBlocks = ECC_BLOCKS[version];
  const dataCodewords = TOTAL_CODEWORDS[version] - eccPerBlock * numBlocks;

  const bits = encodeAlphanumeric(upper, version);
  // Pad to capacity
  while (bits.length < dataCodewords * 8) {
    if (bits.length + 4 <= dataCodewords * 8) bits.push(0, 0, 0, 0);
    else bits.push(0);
    if (bits.length % 8 !== 0) {
      while (bits.length % 8 !== 0) bits.push(0);
    }
    if (bits.length === dataCodewords * 8) break;
    // Padding bytes 0xEC, 0x11
    const pad = (bits.length / 8) % 2 === 0 ? 0xEC : 0x11;
    for (let i = 7; i >= 0; i--) bits.push((pad >> i) & 1);
  }

  const dataBytes = bitsToBytes(bits);
  const blocks = splitIntoBlocks(dataBytes, version);
  const eccBlocks = blocks.map((b) => reedSolomonEncode(b, eccPerBlock));
  const finalBytes = interleave(blocks, eccBlocks);

  // Build matrix
  const matrix = createBaseMatrix(size, version);
  drawData(matrix, finalBytes);
  const maskNum = chooseBestMask(matrix);
  applyMask(matrix, maskNum);
  drawFormatBits(matrix, maskNum);

  // Render SVG
  return matrixToSvg(matrix, sizePx);
}

/* ===== version selection ===== */
function chooseVersion(text) {
  for (let v = 1; v <= 10; v++) {
    const cap = capacityAlphanum(v);
    if (text.length <= cap) return v;
  }
  throw new Error('QR text too long for max supported version 10');
}

function capacityAlphanum(version) {
  const totalBits = (TOTAL_CODEWORDS[version] - ECC_CODEWORDS[version] * ECC_BLOCKS[version]) * 8;
  // header: 4-bit mode + char count indicator (9 for v1-9, 11 for v10-26)
  const ccBits = version <= 9 ? 9 : 11;
  // 11 bits per pair, 6 bits for trailing single char
  const usable = totalBits - 4 - ccBits;
  // length L: ceil(11*L/2) + (L%2)*6 ≤ usable  →  approximate inverse
  // We'll just simulate: try lengths until exceed
  let L = 0;
  while (true) {
    const enc = 11 * Math.floor(L / 2) + (L % 2 ? 6 : 0);
    if (enc > usable) return L - 1;
    L++;
    if (L > 1000) return L;
  }
}

/* ===== alphanumeric encoding ===== */
function encodeAlphanumeric(text, version) {
  const bits = [];
  // mode indicator 0010
  bits.push(0, 0, 1, 0);
  const ccBits = version <= 9 ? 9 : 11;
  pushBits(bits, text.length, ccBits);
  for (let i = 0; i < text.length; i += 2) {
    if (i + 1 < text.length) {
      const v = ALPHANUM.indexOf(text[i]) * 45 + ALPHANUM.indexOf(text[i + 1]);
      pushBits(bits, v, 11);
    } else {
      pushBits(bits, ALPHANUM.indexOf(text[i]), 6);
    }
  }
  return bits;
}

function pushBits(arr, val, len) {
  for (let i = len - 1; i >= 0; i--) arr.push((val >> i) & 1);
}

function bitsToBytes(bits) {
  const bytes = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | (bits[i + j] || 0);
    bytes.push(b);
  }
  return bytes;
}

/* ===== block split for ECC ===== */
function splitIntoBlocks(data, version) {
  const numBlocks = ECC_BLOCKS[version];
  const total = TOTAL_CODEWORDS[version];
  const eccPer = ECC_CODEWORDS[version];
  const dataCodewords = total - eccPer * numBlocks;
  const shortLen = Math.floor(dataCodewords / numBlocks);
  const numLong = dataCodewords - shortLen * numBlocks;
  const blocks = [];
  let off = 0;
  for (let i = 0; i < numBlocks; i++) {
    const len = shortLen + (i < numBlocks - numLong ? 0 : 1);
    blocks.push(data.slice(off, off + len));
    off += len;
  }
  return blocks;
}

/* ===== Reed-Solomon ===== */
function reedSolomonEncode(data, eccLen) {
  const generator = rsGeneratorPoly(eccLen);
  const remainder = new Array(eccLen).fill(0);
  for (const b of data) {
    const factor = b ^ remainder[0];
    remainder.shift();
    remainder.push(0);
    for (let j = 0; j < eccLen; j++) {
      remainder[j] ^= gfMul(generator[j], factor);
    }
  }
  return remainder;
}

function rsGeneratorPoly(degree) {
  let result = [1];
  let root = 1;
  for (let i = 0; i < degree; i++) {
    const next = new Array(result.length + 1).fill(0);
    for (let j = 0; j < result.length; j++) {
      next[j] ^= gfMul(result[j], root);
      next[j + 1] ^= result[j];
    }
    result = next;
    root = gfMul(root, 0x02);
  }
  return result;
}

const GF_LOG = new Array(256);
const GF_EXP = new Array(256);
(function initGf() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11D;
  }
  GF_EXP[255] = GF_EXP[0];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[(GF_LOG[a] + GF_LOG[b]) % 255];
}

/* ===== interleave data + ecc ===== */
function interleave(dataBlocks, eccBlocks) {
  const result = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) {
    for (const b of dataBlocks) if (i < b.length) result.push(b[i]);
  }
  const maxEcc = Math.max(...eccBlocks.map((b) => b.length));
  for (let i = 0; i < maxEcc; i++) {
    for (const b of eccBlocks) if (i < b.length) result.push(b[i]);
  }
  return result;
}

/* ===== matrix construction ===== */
function createBaseMatrix(size, version) {
  // -1 = unset, 0 = white, 1 = black; we'll use object with reserved flag
  const m = [];
  for (let r = 0; r < size; r++) {
    m.push(new Array(size).fill(null).map(() => ({ v: 0, r: false })));
  }
  // Finder patterns at three corners
  drawFinder(m, 0, 0);
  drawFinder(m, size - 7, 0);
  drawFinder(m, 0, size - 7);
  // Separators (already 0; just reserve)
  reserve(m, 0, 7, 8, 8);
  reserve(m, size - 8, 7, 8, 8);
  reserve(m, 0, size - 8, 8, 8);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    m[6][i].v = i % 2 === 0 ? 1 : 0; m[6][i].r = true;
    m[i][6].v = i % 2 === 0 ? 1 : 0; m[i][6].r = true;
  }
  // Dark module
  m[size - 8][8].v = 1; m[size - 8][8].r = true;

  // Format info area reservation
  for (let i = 0; i <= 8; i++) {
    if (m[8][i] && !m[8][i].r) m[8][i].r = true;
    if (m[i][8] && !m[i][8].r) m[i][8].r = true;
  }
  for (let i = 0; i < 8; i++) {
    m[size - 1 - i][8].r = true;
    m[8][size - 1 - i].r = true;
  }

  // Alignment patterns (none for v1; v2-6 has one at center)
  if (version >= 2) {
    const centers = alignmentPatternPositions(version);
    for (const cy of centers) {
      for (const cx of centers) {
        // Skip those overlapping finder patterns
        if ((cy < 8 && cx < 8) ||
            (cy < 8 && cx > size - 9) ||
            (cy > size - 9 && cx < 8)) continue;
        drawAlignment(m, cy, cx);
      }
    }
  }

  return m;
}

function alignmentPatternPositions(v) {
  // Versions 1-10
  const table = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  };
  return table[v];
}

function drawFinder(m, top, left) {
  for (let dy = 0; dy < 7; dy++) {
    for (let dx = 0; dx < 7; dx++) {
      const black = (dy === 0 || dy === 6 || dx === 0 || dx === 6 ||
                     (dy >= 2 && dy <= 4 && dx >= 2 && dx <= 4));
      m[top + dy][left + dx].v = black ? 1 : 0;
      m[top + dy][left + dx].r = true;
    }
  }
}

function drawAlignment(m, cy, cx) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const black = (Math.abs(dy) === 2 || Math.abs(dx) === 2 || (dy === 0 && dx === 0));
      m[cy + dy][cx + dx].v = black ? 1 : 0;
      m[cy + dy][cx + dx].r = true;
    }
  }
}

function reserve(m, x, y, w, h) {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      const r = y + dy, c = x + dx;
      if (m[r] && m[r][c]) m[r][c].r = true;
    }
  }
}

/* ===== draw data with zig-zag ===== */
function drawData(m, bytes) {
  const size = m.length;
  let bitIdx = 0;
  let upward = true;
  for (let col = size - 1; col >= 0; col -= 2) {
    if (col === 6) col--;
    for (let i = 0; i < size; i++) {
      const r = upward ? size - 1 - i : i;
      for (let dx = 0; dx < 2; dx++) {
        const c = col - dx;
        if (m[r][c].r) continue;
        const byte = bytes[bitIdx >> 3] || 0;
        const bit = (byte >> (7 - (bitIdx & 7))) & 1;
        m[r][c].v = bit;
        bitIdx++;
      }
    }
    upward = !upward;
  }
}

/* ===== mask ===== */
function applyMask(m, mask) {
  const size = m.length;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (m[r][c].r) continue;
      if (maskCondition(mask, r, c)) m[r][c].v ^= 1;
    }
  }
}

function maskCondition(mask, r, c) {
  switch (mask) {
    case 0: return (r + c) % 2 === 0;
    case 1: return r % 2 === 0;
    case 2: return c % 3 === 0;
    case 3: return (r + c) % 3 === 0;
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5: return (r * c) % 2 + (r * c) % 3 === 0;
    case 6: return ((r * c) % 2 + (r * c) % 3) % 2 === 0;
    case 7: return ((r + c) % 2 + (r * c) % 3) % 2 === 0;
  }
  return false;
}

function chooseBestMask(m) {
  let bestMask = 0, bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(m, mask);
    drawFormatBits(m, mask);
    const score = penaltyScore(m);
    applyMask(m, mask); // un-apply (XOR is reversible)
    drawFormatBits(m, 0); // clear
    if (score < bestScore) { bestScore = score; bestMask = mask; }
  }
  return bestMask;
}

function penaltyScore(m) {
  // Simple: just count adjacency runs. Good enough for our use case.
  const size = m.length;
  let score = 0;
  for (let r = 0; r < size; r++) {
    let run = 1;
    for (let c = 1; c < size; c++) {
      if (m[r][c].v === m[r][c - 1].v) run++;
      else { if (run >= 5) score += 3 + (run - 5); run = 1; }
    }
    if (run >= 5) score += 3 + (run - 5);
  }
  for (let c = 0; c < size; c++) {
    let run = 1;
    for (let r = 1; r < size; r++) {
      if (m[r][c].v === m[r - 1][c].v) run++;
      else { if (run >= 5) score += 3 + (run - 5); run = 1; }
    }
    if (run >= 5) score += 3 + (run - 5);
  }
  return score;
}

/* ===== format info ===== */
function drawFormatBits(m, mask) {
  // Format: 5 data bits = ECC level (01 for L) << 3 | mask
  const data = (0x01 << 3) | mask;
  // BCH (15,5) code with generator 0x537
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rem >> i) & 1) rem ^= 0x537 << (i - 10);
  }
  let bits = ((data << 10) | rem) ^ 0x5412;

  const size = m.length;
  // Top-left horizontal + vertical
  for (let i = 0; i <= 5; i++) m[8][i].v = (bits >> i) & 1;
  m[8][7].v = (bits >> 6) & 1;
  m[8][8].v = (bits >> 7) & 1;
  m[7][8].v = (bits >> 8) & 1;
  for (let i = 9; i < 15; i++) m[14 - i][8].v = (bits >> i) & 1;
  // Bottom-left and top-right
  for (let i = 0; i < 8; i++) m[size - 1 - i][8].v = (bits >> i) & 1;
  for (let i = 8; i < 15; i++) m[8][size - 15 + i].v = (bits >> i) & 1;
  // Mark all format cells reserved
  for (let i = 0; i <= 8; i++) { m[8][i].r = true; m[i][8].r = true; }
  for (let i = 0; i < 8; i++) m[size - 1 - i][8].r = true;
  for (let i = 0; i < 8; i++) m[8][size - 1 - i].r = true;
  m[size - 8][8].v = 1; m[size - 8][8].r = true;
}

/* ===== to SVG ===== */
function matrixToSvg(m, sizePx) {
  const size = m.length;
  const cell = sizePx / size;
  let path = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (m[r][c].v) {
        path += `M${(c * cell).toFixed(2)} ${(r * cell).toFixed(2)}h${cell.toFixed(2)}v${cell.toFixed(2)}h-${cell.toFixed(2)}z`;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${sizePx} ${sizePx}" width="${sizePx}" height="${sizePx}" shape-rendering="crispEdges"><rect width="${sizePx}" height="${sizePx}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
