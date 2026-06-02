// Notification severity + text-redaction helpers. Extracted from registry.js.
//
// redactNotificationText is the last line of defense against secrets leaking into
// user-facing notifications/audit (lane titles, exit reasons, etc.). It caps input
// length before running the regexes (ReDoS-safe) and scrubs common provider secret
// formats plus app-named tokens.

const NOTIFICATION_SEVERITIES = new Set(['info', 'success', 'warning', 'error']);

export const NOTIFICATION_SEVERITY_RANK = {
  info: 0,
  success: 0,
  warning: 1,
  error: 2,
};

export const DEFAULT_NOTIFICATION_SETTINGS = {
  inAppEnabled: true,
  browserEnabled: false,
  minSeverity: 'info',
  muted: false,
};

export function normalizeNotificationSeverity(raw, fallback = 'info') {
  const normalized = String(raw || fallback).trim().toLowerCase();
  return NOTIFICATION_SEVERITIES.has(normalized) ? normalized : fallback;
}

// Upper bound on the raw text we run redaction regexes over. Notification text
// is later truncated to ~180 chars, but redaction must run on the raw value
// first; capping here keeps the alternation-with-wildcards patterns linear and
// removes any ReDoS exposure from attacker-influenced lane titles/exit reasons.
const MAX_REDACTION_INPUT = 2000;

function redactNotificationText(value) {
  return String(value ?? '')
    .slice(0, MAX_REDACTION_INPUT)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    // Common provider secret formats: OpenAI sk-, Slack xox[baprs]-, GitHub
    // PATs (ghp_/gho_/ghu_/ghs_/ghr_/github_pat_), AWS access key ids.
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, '[REDACTED_SECRET]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{6,}\b/gi, '[REDACTED_SECRET]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED_SECRET]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_SECRET]')
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|API[_-]?KEY|PASSWORD)[A-Z0-9_]*)\s*[:=]\s*['"]?[^'"\s,;}]+/gi, '$1=[REDACTED]')
    // App-named token references (post-"orca" rename; the legacy command-deck
    // name is kept so older persisted strings still redact).
    .replace(/\b((?:orca|command[_-]?deck)[_-]?[A-Za-z0-9_-]*token[A-Za-z0-9_-]*)\b/gi, '[REDACTED_TOKEN]');
}

export function sanitizeNotificationText(value, fallback = '', maxLength = 180) {
  const redacted = redactNotificationText(value).replace(/\s+/g, ' ').trim();
  const text = redacted || fallback;
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

export function sanitizeNotificationSettings(raw = {}, existing = DEFAULT_NOTIFICATION_SETTINGS) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const current = {
    ...DEFAULT_NOTIFICATION_SETTINGS,
    ...(existing && typeof existing === 'object' ? existing : {}),
  };
  return {
    inAppEnabled: source.inAppEnabled === undefined ? Boolean(current.inAppEnabled) : Boolean(source.inAppEnabled),
    browserEnabled: source.browserEnabled === undefined ? Boolean(current.browserEnabled) : Boolean(source.browserEnabled),
    minSeverity: normalizeNotificationSeverity(source.minSeverity, normalizeNotificationSeverity(current.minSeverity, 'info')),
    muted: source.muted === undefined ? Boolean(current.muted) : Boolean(source.muted),
  };
}
