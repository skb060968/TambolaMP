/**
 * Sound Manager — Tambola MP
 *
 * Two roles:
 *   - phone: plays soft chimes for draw/mark/claim/win/error. Does NOT speak numbers.
 *   - display (TV): same chimes plus speakNumber for the called value.
 *
 * Uses AudioContext where available, falls back to HTML Audio.
 * Mute toggle persisted to localStorage (per-device).
 */

const SOUND_FILES = {
  draw: '/sounds/draw.mp3',
  mark: '/sounds/mark.mp3',
  win: '/sounds/win.mp3',
  error: '/sounds/error.mp3',
  claim: '/sounds/claim.mp3',
};

const MUTE_KEY = 'tambola_mp_muted';

let audioCtx = null;
const soundBuffers = {};
const numberBuffers = {};
let initialized = false;

function getAudioContext() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  }
  return audioCtx;
}

async function resumeContext() {
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') {
    try { await ctx.resume(); } catch (_) {}
  }
}

async function loadBuffer(url) {
  const ctx = getAudioContext();
  if (!ctx) return null;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const ab = await r.arrayBuffer();
    return await ctx.decodeAudioData(ab);
  } catch (_) {
    return null;
  }
}

function preloadChimes() {
  Object.entries(SOUND_FILES).forEach(([name, url]) => {
    loadBuffer(url).then((buf) => { if (buf) soundBuffers[name] = buf; });
  });
}

function preloadNumbers() {
  for (let n = 1; n <= 90; n++) {
    loadBuffer(`/sounds/numbers/${n}.mp3`).then((buf) => {
      if (buf) numberBuffers[n] = buf;
    });
  }
}

async function unlockHandler(role) {
  await resumeContext();
  preloadChimes();
  if (role === 'display') preloadNumbers();
  initialized = true;
}

/**
 * Initialise audio. Call once on app start.
 * @param {'phone'|'display'} role
 */
export function initAudio(role) {
  if (initialized) return;
  getAudioContext();
  preloadChimes();
  const events = ['click', 'touchstart', 'keydown'];
  for (const ev of events) {
    document.addEventListener(ev, () => unlockHandler(role), { once: true });
  }
}

export function isMuted() {
  try {
    const v = localStorage.getItem(MUTE_KEY);
    return v === '1' || v === 'true';
  } catch (_) { return false; }
}

export function setMuted(muted) {
  try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch (_) {}
}

export function toggleMute() {
  const next = !isMuted();
  setMuted(next);
  return next;
}

export function playSound(name, volume = 1.0) {
  if (isMuted()) return;
  const url = SOUND_FILES[name];
  if (!url) return;
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') resumeContext();

  if (ctx && ctx.state === 'running' && soundBuffers[name]) {
    try {
      const src = ctx.createBufferSource();
      src.buffer = soundBuffers[name];
      const gain = ctx.createGain();
      gain.gain.value = volume;
      src.connect(gain);
      gain.connect(ctx.destination);
      src.start(0);
      return;
    } catch (_) {}
  }
  try {
    const a = new Audio(url);
    a.volume = volume;
    a.play().catch(() => {});
  } catch (_) {}
}

/**
 * Speak a called number (TV/display only).
 * @param {number} n  1..90
 */
export function speakNumber(n) {
  if (isMuted()) return;
  if (n < 1 || n > 90) return;
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') resumeContext();

  if (ctx && ctx.state === 'running' && numberBuffers[n]) {
    try {
      const src = ctx.createBufferSource();
      src.buffer = numberBuffers[n];
      src.connect(ctx.destination);
      src.start(0);
      return;
    } catch (_) {}
  }
  try {
    const a = new Audio(`/sounds/numbers/${n}.mp3`);
    a.volume = 1;
    a.play().catch(() => {});
  } catch (_) {}
}
