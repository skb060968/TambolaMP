/**
 * Sound Manager — Tambola MP
 *
 * Two roles:
 *   - phone: plays soft chimes for draw/mark/claim/win/error. Does NOT speak numbers.
 *   - display (TV): same chimes plus speakNumber for the called value.
 *
 * Uses AudioContext where available, falls back to HTML Audio.
 * Mute toggle persisted to localStorage (per-device).
 *
 * iPad / iOS Safari notes:
 *   - AudioContext.state stays 'suspended' until a user gesture, and Safari
 *     can re-suspend it during inactivity. We resume aggressively before each
 *     play attempt and use a silent warm-up buffer on every interaction to
 *     keep the ctx awake.
 *   - resumeContext is awaited inside speakNumber/playSound so the ctx is
 *     actually 'running' before we try to start a buffer source. Without the
 *     await, on iPad the play call happens while ctx is still resuming and
 *     drops silently.
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
/** Cached silent buffer used to "kick" iOS audio on every interaction. */
let silentBuffer = null;

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

/**
 * Plays a 1-sample silent buffer through the AudioContext. iOS uses this as
 * a "still alive" signal — without it, the context can suspend mid-game and
 * subsequent plays drop silently.
 */
function kickSilent() {
  const ctx = getAudioContext();
  if (!ctx) return;
  try {
    if (!silentBuffer) silentBuffer = ctx.createBuffer(1, 1, 22050);
    const src = ctx.createBufferSource();
    src.buffer = silentBuffer;
    src.connect(ctx.destination);
    src.start(0);
  } catch (_) {}
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
  kickSilent();
  preloadChimes();
  if (role === 'display') preloadNumbers();
  initialized = true;
}

/**
 * Initialise audio. Call once on app start. Attaches user-gesture listeners
 * that fire on every interaction (not just once) so iOS can re-warm the
 * context if it suspends mid-session.
 * @param {'phone'|'display'} role
 */
export function initAudio(role) {
  // Always (re-)attach; subsequent calls are cheap and idempotent.
  getAudioContext();
  if (!initialized) preloadChimes();
  const events = ['click', 'touchstart', 'keydown'];
  const handler = () => {
    // resume + kick on every interaction so iOS keeps the ctx alive.
    resumeContext().then(() => kickSilent());
    if (!initialized) {
      unlockHandler(role);
    }
  };
  for (const event of events) {
    document.addEventListener(event, handler, { passive: true });
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

/**
 * Plays a chime by name. Awaits resume on iPad so the ctx is ready when we
 * actually start the buffer source.
 */
export async function playSound(name, volume = 1.0) {
  if (isMuted()) return;
  const url = SOUND_FILES[name];
  if (!url) return;
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') await resumeContext();

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
 * Speak a called number (TV/display only). Awaits resume on iPad so the
 * spoken number actually plays out loud during auto-call.
 * @param {number} n  1..90
 */
export async function speakNumber(n) {
  if (isMuted()) return;
  if (n < 1 || n > 90) return;
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') await resumeContext();

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
