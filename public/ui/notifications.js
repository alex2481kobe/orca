// Browser (system) notifications feature: capability/permission checks and
// surfacing unread dashboard notifications as native notifications. Extracted
// from app.js.

import { shell } from './state.js';
import { NOTIFICATION_SEEN_STORAGE_KEY } from './constants.js';
import { renderAlert, safeNavigate } from './dom.js';

export function browserNotificationsSupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function browserNotificationPermission() {
  if (!browserNotificationsSupported()) return 'unsupported';
  return window.Notification.permission || 'default';
}

export function readSeenBrowserNotifications() {
  try {
    return new Set(JSON.parse(window.sessionStorage.getItem(NOTIFICATION_SEEN_STORAGE_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

export function writeSeenBrowserNotifications(seen) {
  window.sessionStorage.setItem(NOTIFICATION_SEEN_STORAGE_KEY, JSON.stringify([...seen].slice(-200)));
}

export async function requestBrowserNotificationPermission() {
  if (!browserNotificationsSupported()) {
    renderAlert('Browser notifications are not supported here.', 'bad');
    return 'unsupported';
  }
  try {
    const permission = await window.Notification.requestPermission();
    renderAlert(permission === 'granted' ? 'Browser notifications enabled.' : `Browser notification permission: ${permission}.`);
    return permission;
  } catch {
    renderAlert('Browser notification permission request failed.', 'bad');
    return browserNotificationPermission();
  }
}

export function maybeShowBrowserNotifications() {
  const notificationState = shell.notifications || {};
  const settings = notificationState.settings || {};
  if (!settings.browserEnabled || browserNotificationPermission() !== 'granted') return;
  const seen = readSeenBrowserNotifications();
  const items = Array.isArray(notificationState.notifications) ? notificationState.notifications : [];
  for (const item of items.filter((notification) => !notification.readAt).slice(0, 5)) {
    if (!item.id || seen.has(item.id)) continue;
    seen.add(item.id);
    const notice = new window.Notification(item.title || 'Orca update', {
      body: item.body || item.severity || 'Status changed',
      tag: item.id,
      renotify: false,
    });
    if (item.href) {
      notice.onclick = () => {
        window.focus();
        safeNavigate(item.href);
      };
    }
  }
  writeSeenBrowserNotifications(seen);
}
