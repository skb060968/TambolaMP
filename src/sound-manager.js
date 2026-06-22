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
  music: '/sounds/music.mp3',
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

/**
 * Initialise audio. Call once on app start. Attaches user-gesture listeners
 * that fire on every interaction (not just once) so iOS can re-warm the
 * context if it suspends mid-session.
 *
 * iOS quirk: kickSilent() and ctx.resume() MUST be invoked synchronously
 * inside the click handler — iOS counts an audio call as "in-gesture" only
 * if it happens before the call stack unwinds. Awaiting resume() before
 * kicking the silent buffer is broken (kick lands in a microtask after the
 * gesture is over).
 *
 * @param {'phone'|'display'} role
 */
export function initAudio(role) {
  // Attach (or re-attach) gesture listeners that fire on every interaction.
  getAudioContext();
  if (!initialized) preloadChimes();

  const handler = () => {
    const ctx = getAudioContext();
    // Synchronous: call resume() and kick a silent buffer in the same stack
    // as the user gesture. iOS treats this as authorised audio.
    if (ctx) {
      if (ctx.state === 'suspended') {
        try { ctx.resume(); } catch (_) {}
      }
      kickSilent();
    }
    if (!initialized) {
      initialized = true;
      preloadChimes();
      if (role === 'display') preloadNumbers();
    }
  };
  const events = ['click', 'touchstart', 'keydown'];
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
 * Plays a chime by name. On iOS the AudioContext must already be running
 * (from a recent user gesture); otherwise we fall through to HTML Audio,
 * which iPad's silent switch will mute — but for the TV/host case we expect
 * the user has tapped Start Round (which warms the ctx) before any draw.
 */
export function playSound(name, volume = 1.0) {
  if (isMuted()) return;
  const url = SOUND_FILES[name];
  if (!url) return;
  const ctx = getAudioContext();
  // Best-effort sync resume — does NOT await, so we stay in any active
  // user-gesture stack iOS might be tracking.
  if (ctx && ctx.state === 'suspended') {
    try { ctx.resume(); } catch (_) {}
  }

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
 * Speak a called number (TV/display only). Called numbers must use the
 * AudioContext path on iPad because HTML Audio respects the silent switch.
 * @param {number} n  1..90
 */
export function speakNumber(n) {
  if (isMuted()) return;
  if (n < 1 || n > 90) return;
  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') {
    try { ctx.resume(); } catch (_) {}
  }

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

/* ======= BACKGROUND MUSIC ======= */

let bgMusicAudio = null;

/**
 * Starts looping background music at specified volume (0.0 - 1.0).
 * Uses HTML Audio element for reliable looping across all platforms.
 */
export function startBackgroundMusic(volume = 0.15) {
  if (isMuted()) return;
  
  // Stop any existing music first
  stopBackgroundMusic();
  
  const url = SOUND_FILES.music;
  if (!url) return;
  
  try {
    bgMusicAudio = new Audio(url);
    bgMusicAudio.loop = true;
    bgMusicAudio.volume = volume;
    bgMusicAudio.preload = 'auto';
    
    const playPromise = bgMusicAudio.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(() => {
        // If autoplay is blocked, music will start on next user interaction
        console.log('Background music autoplay blocked - will start on next interaction');
      });
    }
  } catch (err) {
    console.error('Failed to start background music:', err);
  }
}

/**
 * Stops the background music.
 */
export function stopBackgroundMusic() {
  if (bgMusicAudio) {
    try {
      bgMusicAudio.pause();
      bgMusicAudio.currentTime = 0;
      bgMusicAudio = null;
    } catch (_) {}
  }
}

/**
 * Sets background music volume (0.0 - 1.0).
 */
export function setBackgroundMusicVolume(volume) {
  if (bgMusicAudio) {
    try {
      bgMusicAudio.volume = Math.max(0, Math.min(1, volume));
    } catch (_) {}
  }
}

/**
 * Pauses background music (can be resumed).
 */
export function pauseBackgroundMusic() {
  if (bgMusicAudio) {
    try {
      bgMusicAudio.pause();
    } catch (_) {}
  }
}

/**
 * Resumes paused background music.
 */
export function resumeBackgroundMusic() {
  if (bgMusicAudio && bgMusicAudio.paused && !isMuted()) {
    try {
      const playPromise = bgMusicAudio.play();
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(() => {});
      }
    } catch (_) {}
  }
}
