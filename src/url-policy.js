import net from 'node:net';

const MAX_URL_LENGTH = 2048;
const CONTRACT_VERSION = 'command-deck.url-policy.v1';
const FORBIDDEN_HOSTNAMES = new Set([
  'metadata',
  'metadata.google.internal',
  'instance-data',
  '169.254.169.254',
]);
const SENSITIVE_PATH_PATTERNS = [
  /^\/api\/auth(?:\/|$)/i,
  /^\/api\/providers(?:\/|$)/i,
  /^\/api\/streams(?:\/|$)/i,
  /^\/api\/agent-tools(?:\/|$)/i,
  /^\/api\/mcp(?:\/|$)/i,
  /^\/api\/settings(?:\/|$)/i,
  /^\/api\/executors(?:\/|$)/i,
  /^\/artifacts(?:\/|$)/i,
  /(?:secret|token|pairing|logout|credential)/i,
];

function normalizeText(value) {
  return String(value ?? '').trim();
}

function throwPolicy(message) {
  throw { status: 422, message };
}

function normalizedHostname(hostname) {
  return String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.$/, '');
}

function parseIpv4(hostname) {
  const host = normalizedHostname(hostname);
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return null;
  const parts = host.split('.').map((item) => Number.parseInt(item, 10));
  if (parts.some((part) => !Number.isFinite(part) || part < 0 || part > 255)) return null;
  return parts;
}

function ipv4InRange(parts, start, maskBits) {
  const toInt = (bytes) => bytes.reduce((acc, byte) => ((acc << 8) + byte) >>> 0, 0);
  const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
  return (toInt(parts) & mask) === (toInt(start) & mask);
}

function isLoopbackHost(hostname) {
  const host = normalizedHostname(hostname);
  if (host === 'localhost' || host === '::1') return true;
  const ipv4 = parseIpv4(host);
  return Boolean(ipv4 && ipv4[0] === 127);
}

function isTailnetHost(hostname) {
  const host = normalizedHostname(hostname);
  if (host.endsWith('.ts.net')) return true;
  const ipv4 = parseIpv4(host);
  return Boolean(ipv4 && ipv4InRange(ipv4, [100, 64, 0, 0], 10));
}

function isForbiddenHost(hostname) {
  const host = normalizedHostname(hostname);
  if (!host) return true;
  if (FORBIDDEN_HOSTNAMES.has(host)) return true;
  const ipv4 = parseIpv4(host);
  if (!ipv4) return false;
  return (
    ipv4InRange(ipv4, [0, 0, 0, 0], 8) ||
    ipv4InRange(ipv4, [10, 0, 0, 0], 8) ||
    ipv4InRange(ipv4, [169, 254, 0, 0], 16) ||
    ipv4InRange(ipv4, [172, 16, 0, 0], 12) ||
    ipv4InRange(ipv4, [192, 168, 0, 0], 16) ||
    ipv4InRange(ipv4, [224, 0, 0, 0], 4) ||
    ipv4InRange(ipv4, [240, 0, 0, 0], 4)
  );
}

function classifyHost(hostname) {
  const host = normalizedHostname(hostname);
  if (isLoopbackHost(host)) return 'loopback';
  if (isTailnetHost(host)) return 'tailnet';
  if (net.isIP(host) === 6) return 'blocked';
  if (isForbiddenHost(host)) return 'blocked';
  return 'public';
}

function classifySensitivity(parsed) {
  const pathAndSearch = `${parsed.pathname || '/'}${parsed.search || ''}`;
  if (parsed.searchParams.has('token') || parsed.searchParams.has('apiToken')) {
    return {
      sensitive: true,
      reason: 'URL contains token-like query parameters.',
    };
  }
  const matched = SENSITIVE_PATH_PATTERNS.find((pattern) => pattern.test(pathAndSearch));
  if (matched) {
    return {
      sensitive: true,
      reason: 'URL targets a sensitive Command Deck control surface.',
    };
  }
  return {
    sensitive: false,
    reason: 'URL is not classified as sensitive.',
  };
}

function parseNetworkUrl(raw, { field = 'url', allowBlank = false } = {}) {
  const text = normalizeText(raw);
  if (!text) {
    if (allowBlank) return null;
    throwPolicy(`${field} is required.`);
  }
  if (text.length > MAX_URL_LENGTH) throwPolicy(`${field} is too long.`);
  if (/[\x00-\x1f\x7f]/.test(text)) throwPolicy(`${field} contains unsafe control characters.`);
  if (/funnel/i.test(text)) throwPolicy('Tailscale Funnel URLs/configuration are forbidden for v1.');
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throwPolicy(`${field} must be a valid absolute URL.`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throwPolicy(`${field} must use http or https.`);
  if (parsed.username || parsed.password) throwPolicy(`${field} must not include credentials.`);
  if (!parsed.hostname || parsed.hostname.length > 253) throwPolicy(`${field} has an invalid host.`);
  return parsed;
}

function validateNetworkUrl(raw, {
  field = 'url',
  allowBlank = false,
  allowedHosts = ['loopback', 'tailnet'],
  allowPublic = false,
  requireProtocol = null,
  allowSensitive = false,
} = {}) {
  const parsed = parseNetworkUrl(raw, { field, allowBlank });
  if (!parsed) return null;
  if (requireProtocol && parsed.protocol !== requireProtocol) {
    throwPolicy(`${field} must use ${requireProtocol.replace(':', '')}.`);
  }
  const hostClass = classifyHost(parsed.hostname);
  const allowed = new Set(allowedHosts);
  if (hostClass === 'blocked') {
    throwPolicy(`${field} targets a blocked private, metadata, multicast, or link-local host.`);
  }
  if (hostClass === 'public' && !allowPublic && !allowed.has('public')) {
    throwPolicy(`${field} must target localhost, loopback, or a configured tailnet host.`);
  }
  if (hostClass !== 'public' && !allowed.has(hostClass)) {
    throwPolicy(`${field} targets ${hostClass}, which is not allowed for this operation.`);
  }
  const sensitivity = classifySensitivity(parsed);
  if (sensitivity.sensitive && !allowSensitive) {
    throwPolicy(`${field} targets a sensitive route and requires explicit sensitive-capture approval.`);
  }
  return {
    contractVersion: CONTRACT_VERSION,
    url: parsed.toString(),
    protocol: parsed.protocol,
    hostname: normalizedHostname(parsed.hostname),
    hostClass,
    sensitive: sensitivity.sensitive,
    sensitivityReason: sensitivity.reason,
    allowedHosts: [...allowed],
  };
}

function urlsMatch(a, b) {
  try {
    return new URL(a).toString() === new URL(b).toString();
  } catch {
    return false;
  }
}

function validateEvidenceUrl(raw, {
  field = 'url',
  allowedUrls = [],
  oneTimeApproved = false,
  allowSensitive = false,
} = {}) {
  const policy = validateNetworkUrl(raw, {
    field,
    allowedHosts: ['loopback', 'tailnet'],
    allowSensitive,
  });
  const normalizedAllowed = allowedUrls
    .map((item) => normalizeText(item))
    .filter(Boolean);
  const matchesAllowed = normalizedAllowed.some((item) => urlsMatch(item, policy.url));
  if (!matchesAllowed && !oneTimeApproved) {
    throwPolicy(`${field} is not a saved project/lane URL. Set oneTimeUrlApproved=true for a one-time capture.`);
  }
  return {
    ...policy,
    savedUrl: matchesAllowed,
    oneTimeApproved: Boolean(oneTimeApproved),
  };
}

export {
  CONTRACT_VERSION,
  classifyHost,
  classifySensitivity,
  isLoopbackHost,
  isTailnetHost,
  validateEvidenceUrl,
  validateNetworkUrl,
};
