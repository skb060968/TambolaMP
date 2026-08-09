/**
 * Tambola MP — entry point
 *
 * - Boots the home screen.
 * - Restores a saved session if present (TV or phone).
 * - Otherwise wires the home buttons to dispatch into the appropriate controller.
 */

import { authReady } from './firebase-config.js';
import { showScreen, showToast } from './platform-ui.js';
import { startTvFlow, resumeTvSession } from './tv-controller.js';
import { startPhoneFlow, resumePhoneSession } from './phone-controller.js';
import { initDeepLinkHandler } from './deep-link-handler.js';

const SESSION_KEY = 'tambola_mp_session';

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}

function getQueryParam(name) {
  const m = new URL(location.href).searchParams.get(name);
  return m || null;
}

async function init() {
  showScreen('home');
  try {
    await authReady;
  } catch (error) {
    console.error('Startup authentication failed:', error);
    showToast('Unable to connect securely. Check your internet connection and reload.');
    return;
  }

  // Check for deep link with room code
  const deepLinkRoomCode = initDeepLinkHandler({
    roomInputId: 'phone-join-code',
    joinScreenId: 'phone-join',
    gameName: 'Tambola MP'
  });
  
  // If deep link present, start phone flow and return
  if (deepLinkRoomCode) {
    startPhoneFlow(deepLinkRoomCode);
    return;
  }
  
  // Wire the home screen buttons.
  const btnTv = document.getElementById('btn-home-tv');
  const btnPlayer = document.getElementById('btn-home-player');
  if (btnTv) btnTv.addEventListener('click', () => startTvFlow());
  if (btnPlayer) btnPlayer.addEventListener('click', () => {
    const code = getQueryParam('code');
    startPhoneFlow(code);
  });

  // Legacy support: If a code is present in the URL with action=join
  const queryCode = getQueryParam('code');
  const action = getQueryParam('action');
  if (queryCode && action === 'join') {
    startPhoneFlow(queryCode);
    return;
  }

  // Resume session if any.
  const session = loadSession();
  if (session && session.roomCode) {
    if (session.role === 'tv') {
      try { await resumeTvSession(session.roomCode); return; } catch (_) {}
    } else if (session.role === 'phone' && session.playerIndex != null) {
      try { await resumePhoneSession(session.roomCode, session.playerIndex); return; } catch (_) {}
    }
  }

  showScreen('home');
}

/* ======= SERVICE WORKER ======= */
let waitingWorker = null;
let updateAccepted = false;

window.reloadForUpdate = function() {
  if (!waitingWorker) {
    window.location.reload();
    return;
  }
  updateAccepted = true;
  waitingWorker.postMessage({ type: 'SKIP_WAITING' });
};

window.dismissUpdate = function() {
  const toast = document.getElementById('updateToast');
  if (toast) toast.style.display = 'none';
};

function showUpdateToast(worker) {
  waitingWorker = worker;
  const toast = document.getElementById('updateToast');
  if (!toast) return;
  toast.style.display = 'block';
  toast.style.animation = 'slideUp 0.4s ease-out';
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (updateAccepted) window.location.reload();
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((registration) => {
      if (registration.waiting && navigator.serviceWorker.controller) {
        showUpdateToast(registration.waiting);
      }
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateToast(worker);
          }
        });
      });
      setInterval(() => registration.update().catch(() => {}), 5 * 60 * 1000);
    }).catch((error) => console.warn('Service Worker registration failed:', error));
  });
}

init();
