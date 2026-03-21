const test = require('node:test');
const assert = require('node:assert/strict');

const { createFindtimeMcpServer } = require('./server.js');

const HAS_API_KEY = Boolean(
  process.env.FINDTIME_API_KEY ||
  process.env.TIME_API_KEY ||
  process.env.FINDTIME_MCP_API_KEY ||
  process.env.FINDTIME_TIME_API_KEY
);

const LIVE_SERVER = createFindtimeMcpServer();

async function callTool(name, args) {
  const response = await LIVE_SERVER.handleMessage({
    jsonrpc: '2.0',
    id: Math.floor(Math.random() * 100000),
    method: 'tools/call',
    params: {
      name,
      arguments: args
    }
  });

  assert.ok(response, `expected MCP response for tool ${name}`);
  assert.equal(response.error, undefined, `unexpected JSON-RPC error for ${name}: ${JSON.stringify(response.error)}`);
  assert.ok(response.result, `missing tool result for ${name}`);
  assert.notEqual(response.result.isError, true, `tool ${name} returned error payload: ${JSON.stringify(response.result.structuredContent)}`);
  assert.ok(response.result.structuredContent, `missing structuredContent for ${name}`);
  return response.result.structuredContent;
}

const LIVE_TEST_OPTIONS = HAS_API_KEY
  ? {}
  : {
      skip: 'Set FINDTIME_API_KEY, TIME_API_KEY, FINDTIME_MCP_API_KEY, or FINDTIME_TIME_API_KEY to run live MCP smoke tests.'
    };

test('search_timezones smoke: Victoria CA resolves against production API', LIVE_TEST_OPTIONS, async () => {
  const payload = await callTool('search_timezones', {
    query: 'Victoria',
    countryCode: 'CA',
    limit: 3
  });

  assert.equal(payload.shape, 'locations_search.v2');
  assert.ok(Array.isArray(payload.results), 'expected results array');
  assert.ok(payload.results.length > 0, 'expected at least one search result');
  assert.equal(payload.results[0].name, 'Victoria');
  assert.equal(payload.results[0].countryName, 'Canada');
  assert.ok(String(payload.results[0].id || '').startsWith('findtime:'), 'expected stable findtime location id');
});

test('get_current_time smoke: Tokyo returns current time payload', LIVE_TEST_OPTIONS, async () => {
  const payload = await callTool('get_current_time', {
    city: 'Tokyo',
    countryCode: 'JP'
  });

  assert.equal(payload.shape, 'current_time.v2');
  assert.equal(payload.resolved, true);
  assert.equal(payload.location.name, 'Tokyo');
  assert.equal(payload.location.countryCode, 'JP');
  assert.equal(payload.location.timezoneIana, 'Asia/Tokyo');
  assert.ok(payload.currentTime.time24h, 'expected currentTime.time24h');
  assert.ok(payload.timezone.abbreviation, 'expected timezone abbreviation');
});

test('get_dst_schedule smoke: America/New_York returns DST context', LIVE_TEST_OPTIONS, async () => {
  const payload = await callTool('get_dst_schedule', {
    timezone: 'America/New_York'
  });

  assert.equal(payload.shape, 'dst_schedule.v2');
  assert.equal(payload.resolved, true);
  assert.equal(payload.match.iana, 'America/New_York');
  assert.equal(payload.timezone.iana, 'America/New_York');
  assert.equal(typeof payload.dst.observesDST, 'boolean');
  assert.ok(payload.dst.currentAbbreviation, 'expected current abbreviation');
  assert.ok(payload.timezone.utcOffset, 'expected utc offset');
});

test('convert_time smoke: New York to London and Tokyo returns target conversions', LIVE_TEST_OPTIONS, async () => {
  const payload = await callTool('convert_time', {
    from: 'New York',
    to: ['London', 'Tokyo'],
    toCountryCodes: ['GB', 'JP'],
    time: '9:00 AM',
    date: '2026-03-10'
  });

  assert.equal(payload.shape, 'convert_time.v2');
  assert.ok(payload.from, 'expected from payload');
  assert.ok(Array.isArray(payload.targets), 'expected targets array');
  assert.equal(payload.targets.length, 2);
  assert.deepEqual(
    payload.targets.map((target) => target.location.displayName),
    ['London', 'Tokyo']
  );
});

test('get_overlap_hours smoke: New York and London returns overlap window', LIVE_TEST_OPTIONS, async () => {
  const payload = await callTool('get_overlap_hours', {
    locations: ['New York', 'London'],
    countryCodes: ['US', 'GB'],
    date: '2026-03-10'
  });

  assert.equal(payload.resolved, true);
  assert.ok(Array.isArray(payload.locations), 'expected resolved locations');
  assert.equal(payload.locations.length, 2);
  assert.equal(typeof payload.hasOverlap, 'boolean');
  assert.ok(payload.overlapUtc, 'expected overlap UTC window');
  assert.ok(payload.overlapUtc.startIso, 'expected overlap UTC start');
  assert.ok(payload.overlapUtc.endIso, 'expected overlap UTC end');
  assert.equal(typeof payload.overlapMinutes, 'number');
});

test('find_meeting_time smoke: Tokyo, Cairo, and New York returns ranked options', LIVE_TEST_OPTIONS, async () => {
  const payload = await callTool('find_meeting_time', {
    locations: ['Tokyo', 'Cairo', 'New York'],
    countryCodes: ['JP', 'EG', 'US']
  });

  assert.equal(payload.resolved, true);
  assert.ok(Array.isArray(payload.options), 'expected options array');
  assert.ok(payload.options.length > 0, 'expected at least one ranked meeting option');
  assert.equal(payload.options[0].rank, 1);
  assert.ok(payload.plannerUrl, 'expected plannerUrl');
});

test('get_location_by_id smoke: hydrate exact result from search_timezones', LIVE_TEST_OPTIONS, async () => {
  const search = await callTool('search_timezones', {
    query: 'Victoria',
    countryCode: 'CA',
    limit: 1
  });

  assert.ok(search.results.length > 0, 'expected a searchable location id');

  const payload = await callTool('get_location_by_id', {
    id: search.results[0].id
  });

  assert.ok(payload.id, 'expected hydrated location id');
  assert.equal(payload.shape, 'location.v2');
  assert.equal(payload.id, search.results[0].id);
  assert.equal(payload.location.name, 'Victoria');
  assert.equal(payload.location.countryCode, 'CA');
});
