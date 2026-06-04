// Standalone (installed-to-Home-Screen) shell behaviours. Two jobs:
//
//  1. Accurate viewport height. iOS WebKit's `dvh` is unreliable in a standalone
//     app — it can stay sized for the smaller in-browser viewport, leaving the
//     layout "shifted up" with dead space at the bottom (no toolbar to hide it).
//     We drive --app-height off visualViewport.height instead, which is always
//     the true visible height. In a normal browser we DON'T touch it (the CSS
//     default of 100dvh already tracks the toolbars correctly there).
//
//  2. Pull-to-refresh. A standalone app has no browser chrome, so it loses the
//     native pull-to-refresh. We re-add a lightweight one that runs the app's own
//     data refresh when the page is scrolled to the very top and pulled down.

import { refresh } from './controller.js';

function isStandalone() {
  if (typeof window === 'undefined') return false;
  if (window.navigator && window.navigator.standalone === true) return true;
  const mm = window.matchMedia;
  return Boolean(mm && (mm('(display-mode: standalone)').matches || mm('(display-mode: fullscreen)').matches));
}

export function initMobileShell() {
  const standalone = isStandalone();
  document.body.classList.toggle('is-standalone', standalone);
  // Height + pull-to-refresh only matter in the installed app. A normal browser
  // keeps native dvh + native pull-to-refresh.
  if (!standalone) return;
  setupAppHeight();
  setupPullToRefresh();
}

function setupAppHeight() {
  const apply = () => {
    const vv = window.visualViewport;
    const h = Math.round((vv && vv.height) || window.innerHeight || 0);
    if (h > 0) document.documentElement.style.setProperty('--app-height', `${h}px`);
  };
  apply();
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', apply);
  }
  window.addEventListener('resize', apply);
  window.addEventListener('orientationchange', () => {
    apply();
    // iOS reports a stale height for a frame or two after rotation.
    window.setTimeout(apply, 200);
    window.setTimeout(apply, 500);
  });
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
  indicator.innerHTML = '<span class="ptr-spinner" aria-hidden="true"></span>';
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
    indicator.classList.add('refreshing');
    place(56, 1);
    try { await refresh(); } catch { /* ignore — UI already reflects state */ }
    busy = false;
    indicator.classList.remove('refreshing');
    place(0, 0);
  };
  window.addEventListener('touchend', finish, { passive: true });
  window.addEventListener('touchcancel', () => { if (!busy) reset(); }, { passive: true });
}
