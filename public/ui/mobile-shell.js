// Standalone (installed-to-Home-Screen) shell behaviours.
//
//  - Tags <body> with `is-standalone` so CSS can adapt.
//  - Pull-to-refresh: a standalone app has no browser chrome, so it loses the
//    native pull-to-refresh. We re-add a lightweight one that runs the app's own
//    data refresh when the page is scrolled to the very top and pulled down.
//
// Viewport height is handled entirely in CSS with 100dvh (the full screen in a
// standalone app). We intentionally do NOT set a JS pixel height — measuring
// innerHeight/visualViewport read short in the installed app and pushed the
// layout up.

import { refresh } from './controller.js';

const nowMs = () => (window.performance && window.performance.now ? window.performance.now() : Date.now());
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isStandalone() {
  if (typeof window === 'undefined') return false;
  if (window.navigator && window.navigator.standalone === true) return true;
  const mm = window.matchMedia;
  return Boolean(mm && (mm('(display-mode: standalone)').matches || mm('(display-mode: fullscreen)').matches));
}

export function initMobileShell() {
  const standalone = isStandalone();
  document.body.classList.toggle('is-standalone', standalone);
  // Layout height is handled purely in CSS with 100dvh now (it's the full screen
  // in a standalone app and proved reliable here). We deliberately do NOT drive a
  // JS pixel height off innerHeight/visualViewport — that read short in the
  // installed app and pushed content up. JS only adds pull-to-refresh, which a
  // standalone app lacks (a normal browser keeps its native one).
  if (!standalone) return;
  setupPullToRefresh();
}

// The element that actually scrolls for the current view (the session thread has
// its own scroll container; everything else scrolls the document).
function activeScroller() {
  // The session chat thread scrolls inside its own container; every other view
  // scrolls the document. If the thread can scroll, it owns the gesture.
  const thread = document.querySelector('.chat-thread');
  if (thread && thread.scrollHeight > thread.clientHeight + 4) return thread;
  return document.scrollingElement || document.documentElement;
}

function scrollerAtTop() {
  const el = activeScroller();
  return (el.scrollTop || 0) <= 0;
}

function setupPullToRefresh() {
  const THRESHOLD = 72; // px the user must pull before a release triggers refresh
  const MAX = 110; // visual clamp on how far the indicator travels
  let startY = 0;
  let pulling = false;
  let armed = false;
  let busy = false;

  const indicator = document.createElement('div');
  indicator.className = 'ptr-indicator';
  // Spinner while refreshing; a checkmark + "Refreshed" pill flashes on success so
  // the pull visibly confirms it did something (the screen can otherwise look
  // unchanged when nothing new arrived).
  indicator.innerHTML =
    '<span class="ptr-spinner" aria-hidden="true"></span>'
    + '<span class="ptr-done" aria-hidden="true"><span class="ptr-check"></span><span class="ptr-done-label">Refreshed</span></span>';
  document.body.appendChild(indicator);

  const place = (y, opacity) => {
    indicator.style.transform = `translateX(-50%) translateY(${y}px)`;
    indicator.style.opacity = String(opacity);
  };
  const reset = () => {
    pulling = false;
    armed = false;
    indicator.classList.remove('armed');
    if (!busy) place(0, 0);
  };

  window.addEventListener('touchstart', (event) => {
    if (busy) return;
    // Don't compete with the drawer or multi-touch gestures.
    if (document.body.classList.contains('nav-open')) return;
    if (!event.touches || event.touches.length !== 1) { pulling = false; return; }
    if (!scrollerAtTop()) { pulling = false; return; }
    startY = event.touches[0].clientY;
    pulling = true;
    armed = false;
  }, { passive: true });

  window.addEventListener('touchmove', (event) => {
    if (!pulling || busy) return;
    const dy = event.touches[0].clientY - startY;
    if (dy <= 0 || !scrollerAtTop()) { reset(); return; }
    // Past this point it's a genuine downward pull from the top — take it over
    // from the native rubber-band so the page doesn't bounce under the indicator.
    if (event.cancelable) event.preventDefault();
    const pull = Math.min(dy * 0.6, MAX);
    armed = pull >= THRESHOLD;
    indicator.classList.toggle('armed', armed);
    place(pull, Math.min(1, pull / THRESHOLD));
  }, { passive: false });

  const finish = async () => {
    if (!pulling || busy) { reset(); return; }
    const trigger = armed;
    pulling = false;
    armed = false;
    indicator.classList.remove('armed');
    if (!trigger) { place(0, 0); return; }
    busy = true;
    indicator.classList.remove('done');
    indicator.classList.add('refreshing');
    place(56, 1);
    const startedAt = nowMs();
    try { await refresh(); } catch { /* ignore — UI already reflects state */ }
    // Keep the spinner visible briefly even on an instant refresh so the gesture
    // doesn't flash-and-vanish (reads as "nothing happened").
    const elapsed = nowMs() - startedAt;
    if (elapsed < 450) await sleep(450 - elapsed);
    indicator.classList.remove('refreshing');
    // Flash the "Refreshed" checkmark, then retract.
    indicator.classList.add('done');
    place(56, 1);
    await sleep(900);
    busy = false;
    indicator.classList.remove('done');
    place(0, 0);
  };
  window.addEventListener('touchend', finish, { passive: true });
  window.addEventListener('touchcancel', () => { if (!busy) reset(); }, { passive: true });
}
