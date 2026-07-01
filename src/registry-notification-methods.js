// In-app notification queue methods, as a prototype mixin for OrcaRegistry.
// Extracted from registry.js. Pure severity/redaction helpers live in
// registry-notifications.js; these methods own the queue + read state.

import { randomUUID } from 'node:crypto';
import { nowIso, clonePayload } from './registry-utils.js';
import {
  NOTIFICATION_SEVERITY_RANK,
  normalizeNotificationSeverity,
  sanitizeNotificationText,
  sanitizeNotificationSettings,
} from './registry-notifications.js';

export const notificationMethods = {
  notificationAllowedBySettings(severity) {
    const settings = sanitizeNotificationSettings(this.notificationSettings);
    if (settings.muted || !settings.inAppEnabled) return false;
    const current = normalizeNotificationSeverity(severity, 'info');
    const minimum = normalizeNotificationSeverity(settings.minSeverity, 'info');
    return NOTIFICATION_SEVERITY_RANK[current] >= NOTIFICATION_SEVERITY_RANK[minimum];
  },

  enqueueNotification({
    type = 'system',
    title = 'Orca update',
    body = '',
    severity = 'info',
    actor = 'system',
    projectId = null,
    sessionId = null,
    laneId = null,
    href = null,
    dedupeKey = null,
    metadata = {},
  } = {}) {
    const normalizedSeverity = normalizeNotificationSeverity(severity, 'info');
    if (!this.notificationAllowedBySettings(normalizedSeverity)) {
      return null;
    }

    const safeHref = typeof href === 'string' && href.startsWith('/') && !href.startsWith('//')
      ? href
      : null;
    const safeMetadata = metadata && typeof metadata === 'object'
      ? JSON.parse(JSON.stringify(metadata))
      : {};
    const normalizedDedupeKey = dedupeKey ? sanitizeNotificationText(dedupeKey, '', 180) : null;
    if (normalizedDedupeKey) {
      const existing = (this.notifications || []).find((notification) =>
        notification.dedupeKey === normalizedDedupeKey
        && notification.projectId === (projectId || null)
        && notification.sessionId === (sessionId || null)
        && notification.laneId === (laneId || null));
      if (existing) {
        const now = nowIso();
        existing.updatedAt = now;
        existing.occurrences = Math.min(10_000, (Number.parseInt(existing.occurrences, 10) || 1) + 1);
        existing.readAt = null;
        delete existing.readBy;
        existing.type = sanitizeNotificationText(type, 'system', 80);
        existing.severity = normalizedSeverity;
        existing.title = sanitizeNotificationText(title, 'Orca update', 120);
        existing.body = sanitizeNotificationText(body, '', 220);
        existing.actor = sanitizeNotificationText(actor, 'system', 80);
        existing.lastActor = sanitizeNotificationText(actor, 'system', 80);
        existing.href = safeHref;
        existing.metadata = safeMetadata;
        this.recordAudit({
          type: 'notification_deduped',
          actor: existing.actor,
          projectId: existing.projectId,
          sessionId: existing.sessionId,
          laneId: existing.laneId,
          summary: `${existing.severity} notification recurred: ${existing.title}`,
          evidence: {
            notificationId: existing.id,
            notificationType: existing.type,
            severity: existing.severity,
            occurrences: existing.occurrences,
            href: existing.href,
          },
          status: 'passed',
        });
        return clonePayload(existing);
      }
    }

    const notification = {
      id: randomUUID(),
      createdAt: nowIso(),
      readAt: null,
      type: sanitizeNotificationText(type, 'system', 80),
      severity: normalizedSeverity,
      title: sanitizeNotificationText(title, 'Orca update', 120),
      body: sanitizeNotificationText(body, '', 220),
      actor: sanitizeNotificationText(actor, 'system', 80),
      projectId: projectId || null,
      sessionId: sessionId || null,
      laneId: laneId || null,
      href: safeHref,
      dedupeKey: normalizedDedupeKey,
      occurrences: 1,
      metadata: safeMetadata,
    };

    this.notifications.unshift(notification);
    if (this.notifications.length > 200) {
      this.notifications.length = 200;
    }
    this.recordAudit({
      type: 'notification_enqueued',
      actor: notification.actor,
      projectId: notification.projectId,
      sessionId: notification.sessionId,
      laneId: notification.laneId,
      summary: `${notification.severity} notification: ${notification.title}`,
      evidence: {
        notificationId: notification.id,
        notificationType: notification.type,
        severity: notification.severity,
        href: notification.href,
      },
      status: 'passed',
    });
    return clonePayload(notification);
  },

  notifyLaneTerminal(lane, severity, title, body) {
    if (!lane) return null;
    const route = lane.route
      || `/projects/${lane.projectSlug || lane.projectId || 'project'}/sessions/${lane.sessionId}/lanes/${lane.id}`;
    return this.enqueueNotification({
      type: 'lane_terminal',
      severity,
      title,
      body,
      actor: 'system',
      projectId: lane.projectId,
      sessionId: lane.sessionId,
      laneId: lane.id,
      href: route,
      metadata: {
        laneState: lane.state,
        executorType: lane.executorType || null,
      },
    });
  },

  getNotifications({ unreadOnly = false, limit = 50 } = {}) {
    const max = Math.max(1, Math.min(200, Number.parseInt(limit, 10) || 50));
    const source = Array.isArray(this.notifications) ? this.notifications : [];
    const unreadCount = source.filter((notification) => !notification.readAt).length;
    const notifications = source
      .filter((notification) => !unreadOnly || !notification.readAt)
      .slice(0, max)
      .map((notification) => clonePayload(notification));
    return {
      settings: clonePayload(sanitizeNotificationSettings(this.notificationSettings)),
      unreadCount,
      notifications,
    };
  },

  updateNotificationSettings(settings = {}, context = {}) {
    const actor = context.actor || settings.actor || 'dashboard';
    const policyCheck = this.evaluateActionPolicy('manageNotifications', {
      actor,
      approved: context.approved === true || settings.approved === true,
    });
    if (!policyCheck.allowed) {
      throw {
        status: 409,
        message: policyCheck.message,
        requiresApproval: true,
        risk: policyCheck.policy.risk,
      };
    }

    this.notificationSettings = sanitizeNotificationSettings(settings, this.notificationSettings);
    this.recordAudit({
      type: 'notification_settings_updated',
      actor,
      projectId: null,
      sessionId: null,
      laneId: null,
      summary: 'Notification settings updated',
      evidence: {
        settings: this.notificationSettings,
      },
      status: 'passed',
    });
    this.persistState();
    return this.getNotifications();
  },

  markNotificationRead(notificationId, { actor = 'dashboard' } = {}) {
    const notification = this.notifications.find((item) => item.id === notificationId);
    if (!notification) {
      throw { status: 404, message: 'Notification not found.' };
    }
    if (!notification.readAt) {
      notification.readAt = nowIso();
      notification.readBy = sanitizeNotificationText(actor, 'dashboard', 80);
      this.persistState();
    }
    return clonePayload(notification);
  },

  markAllNotificationsRead({ actor = 'dashboard' } = {}) {
    const readAt = nowIso();
    let updated = 0;
    for (const notification of this.notifications) {
      if (notification.readAt) continue;
      notification.readAt = readAt;
      notification.readBy = sanitizeNotificationText(actor, 'dashboard', 80);
      updated += 1;
    }
    if (updated) {
      this.persistState();
    }
    return {
      updated,
      unreadCount: this.notifications.filter((notification) => !notification.readAt).length,
    };
  },
};
