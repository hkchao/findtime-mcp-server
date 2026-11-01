'use strict';

// The stdio package's tool surface: the hosted core tools that work with an API key, and nothing that needs Google sign-in.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.FINDTIME_MCP_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'findtime-mcp-test-'));
process.env.FINDTIME_MCP_INSTRUMENTATION_ENABLED = 'false';

const { createFindtimeMcpServer } = require('../server.js');

const EXPECTED_TOOLS = [
  'answer_time_question',
  'get_api_diagnostics',
  'send_feedback',
  'get_findtime_help',
  'time_snapshot',
  'get_current_time',
  'get_dst_schedule',
  'convert_time',
  'get_overlap_hours',
  'find_meeting_time',
  'check_proposed_time',
  'are_they_awake',
  'rank_recurring_slot',
  'search_timezones',
  'get_location_by_id'
];

const HOSTED_ONLY_TOOLS = [
  'save_team', 'get_team', 'list_teams', 'rename_team', 'delete_team',
  'get_host_booking_profile', 'find_host_slots', 'request_booking', 'get_booking_status',
  'list_my_booking_requests', 'cancel_booking', 'reschedule_booking', 'get_my_booking_page',
  'list_booking_requests', 'approve_booking_request', 'decline_booking_request',
  'cancel_booking_as_host', 'update_booking_page', 'create_invite_link', 'revoke_invite_link'
];

function recordingFetch(calls, { status = 200, body = { ok: true, shareText: 'ok' } } = {}) {
  return async (url, init) => {
    calls.push({ url: new URL(url), init });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      async text() { return JSON.stringify(body); }
    };
  };
}

function makeServer(calls, overrides = {}) {
  return createFindtimeMcpServer({
    apiBaseUrl: 'https://time-api.findtime.io',
    apiKey: 'test-key',
    scheduleTracking: () => {},
    fetchImpl: recordingFetch(calls),
    ...overrides
  });
}

async function listTools(server) {
  const response = await server.handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  return response.result.tools;
}

async function callTool(server, name, args) {
  const response = await server.handleMessage({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name, arguments: args }
  });
  return response.result;
}

// The calls that reach the Time API for the tool itself (not telemetry side requests).
function toolCalls(calls, toolName) {
  return calls.filter((call) => call.init.headers['X-Findtime-MCP-Tool'] === toolName);
}

test('tools/list is the hosted core set without team or booking tools', async () => {
  const previous = process.env.FINDTIME_MCP_BOOKING_TOOLS;
  process.env.FINDTIME_MCP_BOOKING_TOOLS = '1';
  try {
    const names = (await listTools(makeServer([]))).map((tool) => tool.name);
    assert.deepEqual(names, EXPECTED_TOOLS);
    for (const hostedOnly of HOSTED_ONLY_TOOLS) assert.equal(names.includes(hostedOnly), false, hostedOnly);
  } finally {
    if (previous === undefined) delete process.env.FINDTIME_MCP_BOOKING_TOOLS;
    else process.env.FINDTIME_MCP_BOOKING_TOOLS = previous;
  }
});

test('a hosted-only tool name is answered as an unknown tool', async () => {
  const calls = [];
  const result = await callTool(makeServer(calls), 'request_booking', { handle: 'someone' });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.errorClass, 'unknown_tool');
  assert.equal(toolCalls(calls, 'request_booking').length, 0);
});

test('annotations: send_feedback writes, every other tool is read-only and non-destructive', async () => {
  for (const tool of await listTools(makeServer([]))) {
    assert.equal(tool.annotations.destructiveHint, false, tool.name);
    assert.equal(tool.annotations.readOnlyHint, tool.name !== 'send_feedback', tool.name);
  }
});

test('check_proposed_time sends GET /meeting/check with the API key', async () => {
  const calls = [];
  await callTool(makeServer(calls), 'check_proposed_time', {
    locations: ['London', 'Tokyo'],
    start: '2026-11-03T09:00',
    home: 'America/Los_Angeles'
  });
  const [call] = toolCalls(calls, 'check_proposed_time');
  assert.equal(call.init.method, 'GET');
  assert.equal(call.url.pathname, '/meeting/check');
  assert.equal(call.url.searchParams.get('locations'), 'London|Tokyo');
  assert.equal(call.url.searchParams.get('start'), '2026-11-03T09:00');
  assert.equal(call.url.searchParams.get('home'), 'America/Los_Angeles');
  assert.equal(call.init.headers.Authorization, 'Bearer test-key');
});

test('are_they_awake sends GET /meeting/awake with the API key', async () => {
  const calls = [];
  await callTool(makeServer(calls), 'are_they_awake', {
    theirCities: ['Bengaluru'],
    myTime: '15:00',
    myTimezone: 'America/Los_Angeles'
  });
  const [call] = toolCalls(calls, 'are_they_awake');
  assert.equal(call.init.method, 'GET');
  assert.equal(call.url.pathname, '/meeting/awake');
  assert.equal(call.url.searchParams.get('theirCities'), 'Bengaluru');
  assert.equal(call.url.searchParams.get('myTime'), '15:00');
  assert.equal(call.url.searchParams.get('myTimezone'), 'America/Los_Angeles');
  assert.equal(call.init.headers.Authorization, 'Bearer test-key');
});

test('rank_recurring_slot sends GET /meeting/recurring with the API key', async () => {
  const calls = [];
  await callTool(makeServer(calls), 'rank_recurring_slot', {
    locations: ['San Francisco', 'London', 'Bengaluru'],
    weekday: 'Monday',
    time: '9am',
    home: 'America/Los_Angeles'
  });
  const [call] = toolCalls(calls, 'rank_recurring_slot');
  assert.equal(call.init.method, 'GET');
  assert.equal(call.url.pathname, '/meeting/recurring');
  assert.equal(call.url.searchParams.get('locations'), 'San Francisco|London|Bengaluru');
  assert.equal(call.url.searchParams.get('weekday'), 'Monday');
  assert.equal(call.url.searchParams.get('time'), '9am');
  assert.equal(call.url.searchParams.get('home'), 'America/Los_Angeles');
  assert.equal(call.init.headers.Authorization, 'Bearer test-key');
});

test('send_feedback posts the tool name to /mcp/feedback and never the query text', async () => {
  const calls = [];
  const result = await callTool(makeServer(calls), 'send_feedback', {
    tool: 'convert_time',
    query: '3pm Paris to London',
    whatWasWrong: 'wrong offset'
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.recorded, true);
  const [call] = toolCalls(calls, 'send_feedback');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.url.pathname, '/mcp/feedback');
  assert.equal(call.init.headers.Authorization, 'Bearer test-key');
  const body = JSON.parse(call.init.body);
  assert.deepEqual(body, { tool: 'convert_time' });
  assert.equal(JSON.stringify(body).includes('Paris'), false);
  assert.equal(JSON.stringify(body).includes('wrong offset'), false);
});

test('send_feedback without its required fields is an error and sends nothing', async () => {
  const calls = [];
  const result = await callTool(makeServer(calls), 'send_feedback', { tool: 'convert_time' });
  assert.equal(result.isError, true);
  assert.equal(calls.length, 0);
});

const NEW_TOOL_CALLS = {
  check_proposed_time: { locations: ['London', 'Tokyo'], start: '2026-11-03T09:00', home: 'America/Los_Angeles' },
  are_they_awake: { theirCities: ['Bengaluru'], myTimezone: 'America/Los_Angeles' },
  rank_recurring_slot: { locations: ['London', 'Tokyo'], weekday: 'Monday', time: '9am', home: 'America/Los_Angeles' },
  send_feedback: { tool: 'convert_time', query: '3pm Paris to London', whatWasWrong: 'wrong offset' }
};

for (const [name, args] of Object.entries(NEW_TOOL_CALLS)) {
  test(`${name} without an API key sends no Authorization header and returns auth_failed`, async () => {
    const calls = [];
    const server = makeServer(calls, {
      apiKey: '',
      fetchImpl: recordingFetch(calls, { status: 401, body: { error: 'missing api key' } })
    });
    const result = await callTool(server, name, args);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.errorClass, 'auth_failed');
    const [call] = toolCalls(calls, name);
    assert.ok(call, 'the request still reaches the Time API, which owns key validation');
    assert.equal(call.init.headers.Authorization, undefined);
  });
}

test('meeting tools without locations fail before any request', async () => {
  const calls = [];
  const server = makeServer(calls);
  const check = await callTool(server, 'check_proposed_time', { start: '2026-11-03T09:00', home: 'Europe/London' });
  const recurring = await callTool(server, 'rank_recurring_slot', { weekday: 'Monday', time: '9am', home: 'Europe/London' });
  assert.equal(check.isError, true);
  assert.equal(recurring.isError, true);
  assert.equal(toolCalls(calls, 'check_proposed_time').length, 0);
  assert.equal(toolCalls(calls, 'rank_recurring_slot').length, 0);
});

test('a saved-group teamId without locations points to the hosted connector', async () => {
  const calls = [];
  const result = await callTool(makeServer(calls), 'find_meeting_time', { teamId: 'Marketing' });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.errorClass, 'teams_not_persisted');
  assert.match(result.content[0].text, /mcp\.findtime\.io\/mcp/);
  assert.equal(toolCalls(calls, 'find_meeting_time').length, 0);
});
