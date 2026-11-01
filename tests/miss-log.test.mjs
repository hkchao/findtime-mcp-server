import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.MCP_MISS_HASH_SECRET = 'mcp-test-hash-secret';

const {
  HASH_SECRET_ENV,
  INTERNAL_QA_EMAIL_HASH_LIST,
  RETENTION_MS,
  buildMcpMissEvent,
  createMemoryMissLog,
  detectQuickRetry,
  hashClientId,
  hmacHex,
  isDroppedMissTraffic,
  isExpiredMissEvent,
  sha256Hex,
  summarizeMissEvents
} = require('../miss-log.cjs');

const STORED_KEYS = [
  'candidateCount',
  'errorClass',
  'expiresAt',
  'flags',
  'hashedClientId',
  'timestamp',
  'tool'
];

test('miss events store flags and counts, not query or free text', () => {
  const event = buildMcpMissEvent({
    tool: 'get_current_time',
    args: { query: 'Paris for jane.doe@example.com at +1 (415) 555-0100 from 203.0.113.44' },
    result: { isError: true, structuredContent: { notFound: true, query: 'Paris', candidates: [{ name: 'Paris' }] } },
    clientId: 'mcp-install-abc',
    now: new Date('2026-10-13T00:00:00.000Z')
  });
  assert.equal(event.hashedClientId, hashClientId('mcp-install-abc'));
  assert.equal(event.hashedClientId.length, 32);
  assert.equal(event.hashedClientId.includes('mcp-install-abc'), false);
  assert.notEqual(event.hashedClientId, sha256Hex('mcp-install-abc').slice(0, 32));
  assert.equal(event.hashedClientId, hmacHex('mcp-install-abc').slice(0, 32));
  assert.equal(JSON.stringify(event).includes('jane.doe@example.com'), false);
  assert.equal(JSON.stringify(event).includes('Paris'), false);
  assert.equal(JSON.stringify(event).includes('555-0100'), false);
  assert.ok(!('normalizedInput' in event));
  assert.ok(!('returnedSummary' in event));
  assert.ok(!('query' in event));
  assert.ok(!('inputFingerprint' in event));
  assert.equal(event.candidateCount, 1);
  assert.equal(event.flags.notFound, true);
  assert.deepEqual(Object.keys(event).sort(), STORED_KEYS);
  assert.equal(HASH_SECRET_ENV, 'MCP_MISS_HASH_SECRET');
});

test('classifies failed, unresolved, ambiguous, and low-confidence misses', () => {
  assert.equal(buildMcpMissEvent({
    tool: 'convert_time',
    args: { from: 'X', to: 'Y', time: '9am' },
    error: new Error('boom'),
    clientId: 'a'
  }).errorClass, 'failed_call');
  assert.equal(buildMcpMissEvent({
    tool: 'get_current_time',
    args: { query: 'Atlantis' },
    result: { isError: true, structuredContent: { notFound: true, query: 'Atlantis' } },
    clientId: 'a'
  }).errorClass, 'unresolved_location');
  assert.equal(buildMcpMissEvent({
    tool: 'get_current_time',
    args: { query: 'Springfield' },
    result: { structuredContent: { ambiguous: true, query: 'Springfield', candidates: [{ name: 'A' }] } },
    clientId: 'a'
  }).errorClass, 'ambiguous_location');
  assert.equal(buildMcpMissEvent({
    tool: 'answer_time_question',
    args: { query: 'CST' },
    result: { structuredContent: { confidence: 'low', query: 'CST' } },
    clientId: 'a'
  }).errorClass, 'low_confidence');
});

test('drops internal_qa, founder emails, and identifiable agent clients at write time', async () => {
  const log = createMemoryMissLog();
  const sample = {
    tool: 'get_current_time',
    args: { query: 'Tokyo' },
    result: { isError: true, structuredContent: { notFound: true, query: 'Tokyo' } },
    clientId: 'client-1'
  };

  assert.equal((await log.record({ ...sample, internalQa: true })).dropped, true);
  assert.equal((await log.record({ ...sample, trafficType: 'internal_qa' })).dropped, true);
  assert.equal((await log.record({ ...sample, trafficType: 'test' })).dropped, true);
  assert.equal((await log.record({ ...sample, clientType: 'cursor-cloud-agent' })).dropped, true);
  assert.equal((await log.record({ ...sample, userAgent: 'Cursor Cloud Agent/1.0' })).dropped, true);

  for (const emailHash of INTERNAL_QA_EMAIL_HASH_LIST) {
    assert.equal((await log.record({ ...sample, accountEmailHash: emailHash })).dropped, true);
  }

  assert.equal(isDroppedMissTraffic({ clientType: 'cursor' }), false);
  const kept = await log.record({ ...sample, clientType: 'stdio' });
  assert.equal(kept.dropped, false);
  assert.equal(kept.events[0].errorClass, 'unresolved_location');
  assert.equal(log.getEvents().length, 1);
});

test('records a quick_retry when the same hashed client re-asks with different wording within 60s', async () => {
  const now = { value: new Date('2026-10-13T12:00:00.000Z') };
  const log = createMemoryMissLog({ nowFn: () => now.value });
  await log.record({
    tool: 'get_current_time',
    args: { query: 'time in vic' },
    result: { isError: true, structuredContent: { notFound: true, query: 'vic' } },
    clientId: 'same-client'
  });
  now.value = new Date('2026-10-13T12:00:45.000Z');
  const retry = await log.record({
    tool: 'search_timezones',
    args: { query: 'Victoria Australia' },
    result: { structuredContent: { ambiguous: true, query: 'Victoria Australia' } },
    clientId: 'same-client'
  });
  assert.equal(retry.events.some((event) => event.errorClass === 'quick_retry'), true);
  assert.equal(retry.events.some((event) => event.errorClass === 'ambiguous_location'), true);
  assert.equal(retry.events.every((event) => !('query' in event) && !('normalizedInput' in event)), true);
  assert.equal(detectQuickRetry(
    { hashedClientId: 'abc', inputFingerprint: 'aaa', timestamp: '2026-10-13T12:00:00.000Z' },
    { hashedClientId: 'abc', inputFingerprint: 'bbb', timestamp: '2026-10-13T12:00:59.000Z' }
  ), true);
  assert.equal(detectQuickRetry(
    { hashedClientId: 'abc', inputFingerprint: 'aaa', timestamp: '2026-10-13T12:00:00.000Z' },
    { hashedClientId: 'abc', inputFingerprint: 'bbb', timestamp: '2026-10-13T12:01:01.000Z' }
  ), false);
});

test('expires miss events after 90 days', async () => {
  const now = { value: new Date('2026-10-13T00:00:00.000Z') };
  const log = createMemoryMissLog({ nowFn: () => now.value });
  await log.record({
    tool: 'get_current_time',
    args: { query: 'Atlantis' },
    result: { isError: true, structuredContent: { notFound: true } },
    clientId: 'aging'
  });
  const [event] = log.getEvents();
  assert.equal(Date.parse(event.expiresAt) - Date.parse(event.timestamp), RETENTION_MS);
  now.value = new Date(now.value.getTime() + RETENTION_MS + 1000);
  assert.equal(isExpiredMissEvent(event, now.value), true);
  const summary = await log.summarize();
  assert.equal(summary.eventCount, 0);
  assert.equal(summarizeMissEvents([event], now.value).eventCount, 0);
  assert.deepEqual(Object.keys(summary).sort(), ['byErrorClass', 'byTool', 'eventCount', 'retentionDays']);
});
