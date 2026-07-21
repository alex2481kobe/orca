// Private-access mode resolution + quick-link/phone URL preference helpers.
// Depends only on clientUrl (dom) + each other. Extracted from app.js.

import { clientUrl, isLocalHostName } from './dom.js';

export function effectiveAccessMode(privateSettings = {}, tailnet = {}) {
  const preferredMode = String(privateSettings.preferredMode || 'auto').toLowerCase();
  if (preferredMode === 'local' || preferredMode === 'tailnet-http' || preferredMode === 'tailnet-https-serve') {
    return preferredMode;
  }
  if (tailnet.serveMode === 'tailnet-https-serve') return 'tailnet-https-serve';
  if (tailnet.serveMode === 'tailnet-http') return 'tailnet-http';
  return 'tailnet-http';
}

export function exactUrlForAccessMode(target, mode) {
  if (!target) return '';
  if (mode === 'local') return target.localUrl || '';
  if (mode === 'tailnet-https-serve') return target.httpsServeUrl || '';
  if (mode === 'tailnet-http') return target.tailnetHttpUrl || '';
  return target.tailnetHttpUrl || target.httpsServeUrl || target.localUrl || '';
}

export function fallbackUrlForAccessMode(target, mode) {
  if (!target) return '';
  if (mode === 'local') return target.localUrl || '';
  if (mode === 'tailnet-https-serve') return target.httpsServeUrl || target.tailnetHttpUrl || target.localUrl || '';
  if (mode === 'tailnet-http') return target.tailnetHttpUrl || target.httpsServeUrl || target.localUrl || '';
  return target.tailnetHttpUrl || target.httpsServeUrl || target.localUrl || '';
}

export function effectiveProjectQuickLinkUrl(quick, mode = 'auto') {
  if (!quick) return '';
  if (mode === 'local') return quick.localUrl || quick.url || '';
  if (mode === 'tailnet-http') return quick.tailnetHttpUrl || quick.httpsServeUrl || quick.localUrl || quick.url || '';
  if (mode === 'tailnet-https-serve') return quick.httpsServeUrl || quick.tailnetHttpUrl || quick.localUrl || quick.url || '';
  return quick.url || quick.tailnetHttpUrl || quick.httpsServeUrl || quick.localUrl || '';
}

export function quickLinkHealthLabel(status) {
  if (status === 'reachable') return 'Reachable';
  if (status === 'unreachable') return 'Unreachable';
  if (status === 'not_checkable') return 'Dashboard link';
  return 'Unchecked';
}

// The detected Tailscale device URL (MagicDNS), e.g. http://mac.tailnet.ts.net:3000.
// This is the URL another device on the same tailnet actually uses — localhost
// never works off-machine. Returns '' when Tailscale isn't set up.
export function tailnetDeviceUrl(tailnet = {}, mode = 'tailnet-http') {
  // The exact URL Tailscale Serve actually proxies to Orca is the only one a
  // remote device can open (Serve listens on port 80/443 and forwards to
  // localhost:3000 — there is no :3000 on the tailnet name). Prefer it.
  if (tailnet.servedUrl) return tailnet.servedUrl;
  const host = String(tailnet.hostname || '').replace(/\.$/, '').trim();
  if (!host) return '';
  // No Serve configured: a bare host:port only works if Orca binds the tailnet
  // interface. We surface it as a best-effort, but the UI nudges to enable Serve.
  const port = (typeof window !== 'undefined' && window.location.port) ? window.location.port : '3000';
  if (mode === 'tailnet-https-serve') return `https://${host}`;
  return `http://${host}:${port}`;
}

export function preferredPhoneUrl(privateTargets = [], privateSettings = {}, tailnet = {}) {
  if (!isLocalHostName(window.location.hostname)) return window.location.origin;
  const targets = privateTargets.filter((item) => !item.hidden);
  const mode = effectiveAccessMode(privateSettings, tailnet);
  const target = targets.find((item) => item.favorite && exactUrlForAccessMode(item, mode)) ||
    targets.find((item) => item.mode === mode && exactUrlForAccessMode(item, mode)) ||
    targets.find((item) => exactUrlForAccessMode(item, mode)) ||
    targets.find((item) => item.favorite && fallbackUrlForAccessMode(item, mode)) ||
    targets.find((item) => fallbackUrlForAccessMode(item, mode));
  const url = exactUrlForAccessMode(target, mode) || fallbackUrlForAccessMode(target, mode);
  if (url) return clientUrl(url);
  // No configured target: use the real Tailscale device URL so "open on another
  // device" actually works. Empty (no Tailscale) -> the UI prompts to set it up
  // rather than showing a useless localhost URL.
  return tailnetDeviceUrl(tailnet, mode);
}
