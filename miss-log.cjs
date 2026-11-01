'use strict';

const crypto = require('node:crypto');

const RETENTION_DAYS = 90;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
const RETRY_WINDOW_MS = 60 * 1000;
const HASH_SECRET_ENV = 'MCP_MISS_HASH_SECRET';
// SHA-256 of lowercased internal QA account emails; only the hashes ship in this package.
const INTERNAL_QA_EMAIL_HASH_LIST = Object.freeze([
  '0338a74c9845ede10ee33eb2d55c0af53f0759f180dfb758ed9c2c9e9c4ec138',
  '250da09fb3c524519a5407ed948bc42287ef180bdebabca639853f88c6f12211',
  'a31c89fa9d1dd33a8338f1ce329ef79e30a45a78dc03817a092b99b47b7d187b',
  '1c7c90655a4c0e7d6ca26119c189e89aa75e0deb88c911e300f902c4482afbec'
]);
const INTERNAL_CLIENT_TYPES = Object.freeze([
  'conkerbot',
  'conkerbot-agent',
  'cursor-cloud-agent',
  'findtime-agent',
  'findtime-internal',
  'internal-agent',
  'internal_qa',
  'qa',
  'qa-agent',
  'test',
  'test-agent'
]);
const ERROR_CLASS_ALLOWLIST = Object.freeze([
  'failed_call',
  'unresolved_location',
  'ambiguous_location',
  'low_confidence',
  'quick_retry',
  'agent_feedback',
  'invalid_params',
  'time_api_unavailable',
  'auth_failed',
  'teams_not_persisted',
  'unknown_tool'
]);

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

const INTERNAL_QA_EMAIL_HASHES = new Set(INTERNAL_QA_EMAIL_HASH_LIST);

function compactText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

let missingHashSecretWarned = false;

function getHashSecret() {
  const secret = compactText(process.env[HASH_SECRET_ENV]);
  if (!secret && !missingHashSecretWarned) {
    missingHashSecretWarned = true;
    console.warn(`[findtime-mcp] ${HASH_SECRET_ENV} is not set; miss-log client ids hash as anonymous`);
  }
  return secret;
}

function hmacHex(value, secret = getHashSecret()) {
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update(String(value || ''), 'utf8').digest('hex');
}

function hashClientId(value, secret = getHashSecret()) {
  const text = compactText(value);
  if (!text || !secret) return 'anonymous';
  return hmacHex(text, secret).slice(0, 32);
}

function inputFingerprint(args = {}, payload = {}, secret = getHashSecret()) {
  const parts = [
    compactText(args.query),
    compactText(args.city),
    compactText(args.timezone),
    compactText(args.from),
    compactText(Array.isArray(args.to) ? args.to.join('|') : args.to),
    compactText(Array.isArray(args.locations) ? args.locations.join('|') : args.locations),
    compactText(payload.query)
  ].filter(Boolean);
  const material = parts.join('\n').toLowerCase();
  if (!material) return null;
  return hmacHex(material, secret || 'local-fingerprint')?.slice(0, 32) || null;
}

function truthyFlag(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on', 'internal_qa'].includes(normalized);
}

function isInternalClientType(value) {
  const normalized = compactText(value).toLowerCase();
  if (!normalized) return false;
  if (INTERNAL_CLIENT_TYPES.includes(normalized)) return true;
  return normalized.includes('internal') && (normalized.includes('agent') || normalized.includes('qa'));
}

function collectEmailHashes(input = {}) {
  const hashes = [];
  const directHash = compactText(input.accountEmailHash || input.emailHash);
  if (directHash) hashes.push(directHash.toLowerCase());
  const email = compactText(input.accountEmail || input.email);
  if (email) hashes.push(sha256Hex(email.toLowerCase()));
  return hashes;
}

function isDroppedMissTraffic(input = {}) {
  if (truthyFlag(input.internalQa) || truthyFlag(input.internal_qa)) return true;
  if (String(input.trafficType || '').trim().toLowerCase() === 'internal_qa') return true;
  if (String(input.trafficType || '').trim().toLowerCase() === 'test') return true;
  if (isInternalClientType(input.clientType)) return true;
  const userAgent = compactText(input.userAgent).toLowerCase();
  if (userAgent.includes('cursor cloud agent') || userAgent.includes('conkerbot')) return true;
  if (collectEmailHashes(input).some((hash) => INTERNAL_QA_EMAIL_HASHES.has(hash))) return true;
  return false;
}

function classifyMcpMiss({ result = null, error = null, payload = null } = {}) {
  const body = payload
    || (result && result.structuredContent)
    || {};
  if (body && body.errorClass === 'agent_feedback') return 'agent_feedback';
  if (error) return 'failed_call';
  if (body && (body.confidence === 'low' || body.errorClass === 'low_confidence')) {
    return body.ambiguous || body.needsClarification ? 'ambiguous_location' : 'low_confidence';
  }
  if (
    body?.ambiguous === true
    || body?.needsClarification === true
    || body?.status === 'ambiguous_location'
    || body?.status === 'multiple_ambiguous_locations'
    || body?.errorClass === 'ambiguous_location'
  ) {
    return 'ambiguous_location';
  }
  if (
    body?.notFound === true
    || body?.result?.notFound === true
    || body?.status === 'unresolved_location'
    || body?.errorClass === 'unresolved_location'
  ) {
    return 'unresolved_location';
  }
  if (ERROR_CLASS_ALLOWLIST.includes(body?.errorClass)) return body.errorClass;
  if (result?.isError === true || (typeof body?.status === 'number' && body.status >= 400)) {
    return 'failed_call';
  }
  return null;
}

function buildMissFlags(payload = {}, result = null) {
  return {
    ambiguous: payload.ambiguous === true || payload.needsClarification === true,
    notFound: payload.notFound === true || payload.result?.notFound === true,
    lowConfidence: payload.confidence === 'low',
    isError: result?.isError === true
  };
}

function buildMcpMissEvent({
  tool,
  args = {},
  result = null,
  error = null,
  payload = null,
  clientId = '',
  now = new Date(),
  errorClass = null
} = {}) {
  const resolvedPayload = payload || result?.structuredContent || {};
  const resolvedClass = errorClass || classifyMcpMiss({ result, error, payload: resolvedPayload });
  if (!resolvedClass || !ERROR_CLASS_ALLOWLIST.includes(resolvedClass)) return null;

  const timestampMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const timestamp = new Date(timestampMs);
  const candidateCount = Array.isArray(resolvedPayload.candidates)
    ? Math.min(3, resolvedPayload.candidates.length)
    : 0;

  return {
    tool: compactText(tool).slice(0, 80) || 'unknown',
    errorClass: resolvedClass,
    flags: buildMissFlags(resolvedPayload, result),
    candidateCount,
    hashedClientId: hashClientId(clientId),
    timestamp: timestamp.toISOString(),
    expiresAt: new Date(timestampMs + RETENTION_MS).toISOString()
  };
}

function expiresAtMs(value) {
  if (!value) return NaN;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (typeof value === 'object' && Number.isFinite(value.seconds)) {
    return (value.seconds * 1000) + Math.floor((value.nanoseconds || 0) / 1e6);
  }
  return Date.parse(value);
}

function isExpiredMissEvent(event, now = new Date()) {
  const expiresAt = expiresAtMs(event?.expiresAt);
  if (!Number.isFinite(expiresAt)) return true;
  return expiresAt <= now.getTime();
}

function detectQuickRetry(previous, next, windowMs = RETRY_WINDOW_MS) {
  if (!previous || !next) return false;
  if (previous.hashedClientId !== next.hashedClientId) return false;
  if (!previous.inputFingerprint || !next.inputFingerprint) return false;
  if (previous.inputFingerprint === next.inputFingerprint) return false;
  const previousTs = Date.parse(previous.timestamp);
  const nextTs = Date.parse(next.timestamp);
  if (!Number.isFinite(previousTs) || !Number.isFinite(nextTs)) return false;
  const delta = nextTs - previousTs;
  return delta >= 0 && delta <= windowMs;
}

function summarizeMissEvents(events = [], now = new Date()) {
  const live = events.filter((event) => !isExpiredMissEvent(event, now));
  const byErrorClass = {};
  const byTool = {};
  for (const event of live) {
    const errorClass = event.errorClass || 'unknown';
    const tool = event.tool || 'unknown';
    byErrorClass[errorClass] = (byErrorClass[errorClass] || 0) + 1;
    byTool[tool] = (byTool[tool] || 0) + 1;
  }
  return {
    retentionDays: RETENTION_DAYS,
    eventCount: live.length,
    byErrorClass,
    byTool
  };
}

function toRemoteMissEvent(event, clientId) {
  return {
    tool: event.tool,
    errorClass: event.errorClass,
    flags: event.flags,
    candidateCount: event.candidateCount,
    clientId
  };
}

function createMemoryMissLog({ nowFn = () => new Date() } = {}) {
  const events = [];
  const lastByClient = new Map();

  function purge(now) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (isExpiredMissEvent(events[index], now)) events.splice(index, 1);
    }
    for (const [key, previous] of lastByClient.entries()) {
      if (now.getTime() - Date.parse(previous.timestamp) > RETRY_WINDOW_MS) {
        lastByClient.delete(key);
      }
    }
  }

  async function record(input = {}) {
    if (isDroppedMissTraffic(input)) {
      return { dropped: true, events: [] };
    }
    const now = input.now || nowFn();
    purge(now);
    const event = buildMcpMissEvent({ ...input, now });
    const recorded = [];
    const hashedClientId = event?.hashedClientId || hashClientId(input.clientId);
    const fingerprint = inputFingerprint(input.args || {}, input.payload || {});
    const previous = lastByClient.get(hashedClientId);
    if (event) {
      events.push(event);
      recorded.push(event);
    }
    const retryProbe = {
      hashedClientId,
      inputFingerprint: fingerprint,
      timestamp: (event && event.timestamp) || now.toISOString()
    };
    if (detectQuickRetry(previous, retryProbe)) {
      const retryEvent = {
        tool: (event && event.tool) || compactText(input.tool) || 'unknown',
        errorClass: 'quick_retry',
        flags: { ambiguous: false, notFound: false, lowConfidence: false, isError: false },
        candidateCount: 0,
        hashedClientId,
        timestamp: now.toISOString(),
        expiresAt: new Date(now.getTime() + RETENTION_MS).toISOString()
      };
      events.push(retryEvent);
      recorded.push(retryEvent);
    }
    lastByClient.set(hashedClientId, retryProbe);
    return { dropped: false, events: recorded };
  }

  async function summarize() {
    const now = nowFn();
    purge(now);
    return summarizeMissEvents(events, now);
  }

  return {
    record,
    summarize,
    getEvents: () => events.slice()
  };
}

module.exports = {
  ERROR_CLASS_ALLOWLIST,
  HASH_SECRET_ENV,
  INTERNAL_CLIENT_TYPES,
  INTERNAL_QA_EMAIL_HASH_LIST,
  RETENTION_DAYS,
  RETENTION_MS,
  RETRY_WINDOW_MS,
  buildMcpMissEvent,
  classifyMcpMiss,
  createMemoryMissLog,
  detectQuickRetry,
  hashClientId,
  hmacHex,
  isDroppedMissTraffic,
  isExpiredMissEvent,
  sha256Hex,
  summarizeMissEvents,
  toRemoteMissEvent
};
