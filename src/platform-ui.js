/* Shared UI helpers: screen switcher, toast, modal prompt/confirm. */

export function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach((s) => s.setAttribute('hidden', ''));
  const target = document.getElementById(screenId);
  if (target) target.removeAttribute('hidden');
}

let _toastTimer = null;
export function showToast(message, durationMs = 1800) {
  let t = document.getElementById('app-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'app-toast';
    t.className = 'app-toast';
    document.body.appendChild(t);
  }
  t.textContent = message;
  t.classList.remove('fade-out');
  void t.offsetWidth;
  t.classList.add('fade-out');
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => {
    if (t.parentNode) t.parentNode.removeChild(t);
  }, durationMs);
}

/**
 * Custom modal confirm. Resolves true on OK, false on Cancel.
 * Optional `signal` (AbortSignal): aborting closes the modal and resolves false.
 */
export function confirmModal(title, message, okLabel = 'OK', cancelLabel = 'Cancel', { signal } = {}) {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(false); return; }
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal-box">
        <h3>${escapeHtml(title)}</h3>
        ${message ? `<p>${escapeHtml(message)}</p>` : ''}
        <div class="modal-actions">
          <button class="btn primary" data-act="ok">${escapeHtml(okLabel)}</button>
          <button class="btn secondary" data-act="cancel">${escapeHtml(cancelLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = (value) => {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      resolve(value);
    };
    signal?.addEventListener('abort', () => close(false), { once: true });
    overlay.addEventListener('click', (e) => {
      const act = e.target.dataset?.act;
      if (act === 'ok') close(true);
      if (act === 'cancel' || e.target === overlay) close(false);
    });
  });
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
