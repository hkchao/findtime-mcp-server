import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
process.env.MCP_MISS_HASH_SECRET = 'mcp-test-hash-secret';
const { createFindtimeMcpServer } = require('../server.js');
const { createMemoryMissLog } = require('../miss-log.cjs');

function jsonFetch(routes) {
  return async (url, init = {}) => {
    const parsed = new URL(url);
    const handler = routes[parsed.pathname];
    if (!handler) {
      return { ok: false, status: 404, async text() { return JSON.stringify({ error: 'not found' }); } };
    }
    const result = await handler({
      method: init.method || 'GET',
      query: Object.fromEntries(parsed.searchParams.entries()),
      body: init.body ? JSON.parse(init.body) : undefined,
      headers: init.headers || {}
    });
    const status = result.statusCode ?? (result.ok === false ? 400 : 200);
    return {
      ok: status < 400,
      status,
      async text() {
        return JSON.stringify(result.body ?? result);
      }
    };
  };
}

test('unknown city tool errors list candidates from search_timezones', async () => {
  const missLog = createMemoryMissLog();
  const server = createFindtimeMcpServer({
    apiBaseUrl: 'https://time-api.example',
    apiKey: 'test',
    missLog,
    fetchImpl: jsonFetch({
      '/time/current': () => ({
        statusCode: 404,
        body: { resolved: false, ambiguous: false, notFound: true, query: 'Springfeld' }
      }),
      '/locations/search': () => ({
        statusCode: 200,
        body: {
          results: [
            { name: 'Springfield', countryName: 'United States', timezoneIana: 'America/Chicago', id: 'a', suggestedQuery: 'Springfield, United States' },
            { name: 'Springfield', countryName: 'United States', timezoneIana: 'America/New_York', id: 'b', suggestedQuery: 'Springfield, United States (NY)' },
            { name: 'Springfield', countryName: 'Australia', timezoneIana: 'Australia/Sydney', id: 'c', suggestedQuery: 'Springfield, Australia' }
          ]
        }
      })
    })
  });

  const response = await server.handleMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'get_current_time', arguments: { query: 'Springfeld' } }
  });

  assert.equal(response.result.isError, true);
  assert.equal(response.result.structuredContent.errorClass, 'unresolved_location');
  assert.equal(response.result.structuredContent.candidates.length, 3);
  assert.equal(response.result.structuredContent.nextAction.tool, 'search_timezones');
  assert.match(response.result.content[0].text, /search_timezones/);
  const stored = missLog.getEvents().find((event) => event.errorClass === 'unresolved_location');
  assert.ok(stored);
  assert.equal(JSON.stringify(stored).includes('Springfeld'), false);
  assert.equal(stored.candidateCount, 3);
});

test('tools/list tightens search_timezones and includes send_feedback', async () => {
  const server = createFindtimeMcpServer({
    apiBaseUrl: 'https://time-api.example',
    apiKey: '',
    fetchImpl: async () => ({ ok: true, status: 200, async text() { return '{}'; } })
  });
  const response = await server.handleMessage({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {}
  });
  const tools = Object.fromEntries(response.result.tools.map((tool) => [tool.name, tool]));
  assert.match(tools.search_timezones.description, /Disambiguate/);
  assert.match(tools.search_timezones.description, /does not return the current time/);
  assert.match(tools.get_current_time.description, /Do not use this for conversions/);
  assert.match(tools.convert_time.description, /answer_time_question for vague prompts/);
  assert.match(tools.convert_time.description, /source timezone/);
  assert.match(tools.get_location_by_id.description, /Do not invent ids/);
  assert.ok(tools.send_feedback);
  assert.deepEqual(tools.send_feedback.inputSchema.required, ['tool', 'query', 'whatWasWrong']);
  assert.match(tools.send_feedback.description, /discarded/);
  assert.match(tools.get_api_diagnostics.description, /TIME_API_MCP_MISS_ADMIN_KEY/);
});

test('missing convert_time arguments return an actionable invalid_params error', async () => {
  const server = createFindtimeMcpServer({
    apiBaseUrl: 'https://time-api.example',
    apiKey: '',
    fetchImpl: async () => {
      throw new Error('should not fetch');
    }
  });
  const response = await server.handleMessage({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'convert_time', arguments: { from: 'Tokyo' } }
  });
  assert.equal(response.error, undefined);
  assert.equal(response.result.isError, true);
  assert.equal(response.result.structuredContent.errorClass, 'invalid_params');
  assert.match(response.result.structuredContent.nextAction.hint, /answer_time_question/);
});

test('send_feedback writes agent_feedback into the miss log without query text', async () => {
  const missLog = createMemoryMissLog();
  const server = createFindtimeMcpServer({
    apiBaseUrl: 'https://time-api.example',
    apiKey: '',
    missLog,
    fetchImpl: async () => ({ ok: true, status: 202, async text() { return '{}'; } })
  });
  const response = await server.handleMessage({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'send_feedback',
      arguments: {
        tool: 'convert_time',
        query: '3pm Paris to London for jane.doe@example.com',
        whatWasWrong: 'Picked Paris Texas',
        expectedAnswer: 'Paris, France'
      }
    }
  });
  assert.equal(response.result.structuredContent.recorded, true);
  const events = missLog.getEvents().filter((event) => event.errorClass === 'agent_feedback');
  assert.equal(events.length, 1);
  assert.equal(events[0].tool, 'convert_time');
  const serialized = JSON.stringify(events[0]);
  assert.equal(serialized.includes('jane.doe@example.com'), false);
  assert.equal(serialized.includes('Paris'), false);
  assert.equal(serialized.includes('Picked'), false);
  assert.ok(!('normalizedInput' in events[0]));
  assert.ok(!('query' in events[0]));
  assert.match(events[0].hashedClientId, /^(anonymous|[a-f0-9]{32})$/);
});

test('get_api_diagnostics degrades when TIME_API_MCP_MISS_ADMIN_KEY is missing', async () => {
  const previous = process.env.TIME_API_MCP_MISS_ADMIN_KEY;
  delete process.env.TIME_API_MCP_MISS_ADMIN_KEY;
  try {
    const server = createFindtimeMcpServer({
      apiBaseUrl: 'https://time-api.example',
      apiKey: '',
      fetchImpl: jsonFetch({
        '/health': () => ({ statusCode: 200, body: { ok: true, service: 'time-api' } })
      })
    });
    const response = await server.handleMessage({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'get_api_diagnostics', arguments: {} }
    });
    assert.equal(response.result.structuredContent.missLog.available, false);
    assert.equal(response.result.structuredContent.missLog.reason, 'admin_key_required');
    assert.equal(response.result.structuredContent.missLog.adminKeyEnv, 'TIME_API_MCP_MISS_ADMIN_KEY');
  } finally {
    if (previous === undefined) delete process.env.TIME_API_MCP_MISS_ADMIN_KEY;
    else process.env.TIME_API_MCP_MISS_ADMIN_KEY = previous;
  }
});

test('get_api_diagnostics includes aggregate miss-log counts when the admin key env is set', async () => {
  const previous = process.env.TIME_API_MCP_MISS_ADMIN_KEY;
  process.env.TIME_API_MCP_MISS_ADMIN_KEY = 'test-admin-key';
  const missLog = createMemoryMissLog();
  await missLog.record({
    tool: 'get_current_time',
    args: { query: 'Atlantis' },
    result: { isError: true, structuredContent: { notFound: true, query: 'Atlantis' } },
    clientId: 'diag-client'
  });
  try {
    const server = createFindtimeMcpServer({
      apiBaseUrl: 'https://time-api.example',
      apiKey: '',
      missLog,
      fetchImpl: jsonFetch({
        '/health': () => ({ statusCode: 200, body: { ok: true, service: 'time-api' } }),
        '/mcp/miss-summary': async () => ({ statusCode: 200, body: await missLog.summarize() })
      })
    });
    const response = await server.handleMessage({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'get_api_diagnostics', arguments: {} }
    });
    assert.equal(response.result.structuredContent.missLog.eventCount, 1);
    assert.equal(response.result.structuredContent.missLog.byErrorClass.unresolved_location, 1);
    assert.equal(response.result.structuredContent.missLog.retentionDays, 90);
    assert.equal(response.result.structuredContent.missLog.available, true);
    assert.equal('recent' in response.result.structuredContent.missLog, false);
  } finally {
    if (previous === undefined) delete process.env.TIME_API_MCP_MISS_ADMIN_KEY;
    else process.env.TIME_API_MCP_MISS_ADMIN_KEY = previous;
  }
});

test('internal_qa traffic is not written to the miss log', async () => {
  const missLog = createMemoryMissLog();
  const server = createFindtimeMcpServer({
    apiBaseUrl: 'https://time-api.example',
    apiKey: '',
    missLog,
    internalQa: true,
    fetchImpl: jsonFetch({
      '/time/current': () => ({
        statusCode: 404,
        body: { notFound: true, query: 'Atlantis' }
      }),
      '/locations/search': () => ({ statusCode: 200, body: { results: [] } })
    })
  });
  await server.handleMessage({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'get_current_time', arguments: { query: 'Atlantis' } }
  });
  assert.equal(missLog.getEvents().length, 0);
});
