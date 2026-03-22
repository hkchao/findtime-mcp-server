const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  ContentLengthMessageBuffer,
  TOOL_DEFINITIONS,
  createFindtimeMcpServer,
  encodeMessage
} = require('./server.js');

test('tools/list exposes the production parity tool surface', async () => {
  const server = createFindtimeMcpServer({
    apiBaseUrl: 'https://time-api.findtime.io',
    fetchImpl: async () => {
      throw new Error('fetch should not run for tools/list');
    }
  });

  const response = await server.handleMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list'
  });

  assert.equal(response.result.tools.length, TOOL_DEFINITIONS.length);
  assert.deepEqual(
    response.result.tools.map((tool) => tool.name),
    TOOL_DEFINITIONS.map((tool) => tool.name)
  );
});

test('initialize negotiates protocol version and advertises tools capability', async () => {
  const server = createFindtimeMcpServer({
    fetchImpl: async () => {
      throw new Error('fetch should not run for initialize');
    }
  });

  const response = await server.handleMessage({
    jsonrpc: '2.0',
    id: 2,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'test-client',
        version: '1.0.0'
      }
    }
  });

  assert.equal(response.result.protocolVersion, '2024-11-05');
  assert.deepEqual(response.result.capabilities, { tools: {} });
  assert.equal(response.result.serverInfo.name, 'findtime');
});

test('get_api_diagnostics reports MCP version, latest published MCP version, API base URL, auth configuration, and health payload', async () => {
  const calls = [];
  const server = createFindtimeMcpServer({
    apiBaseUrl: 'https://time-api.findtime.io',
    apiKey: 'test-key',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url === 'https://registry.npmjs.org/%40findtime%2Fmcp-server/latest') {
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              version: '3.25.8'
            });
          }
        };
      }

      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            ok: true,
            service: 'time-api'
          });
        }
      };
    }
  });

  const response = await server.handleMessage({
    jsonrpc: '2.0',
    id: 22,
    method: 'tools/call',
    params: {
      name: 'get_api_diagnostics',
      arguments: {}
    }
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://time-api.findtime.io/health');
  assert.equal(calls[1].url, 'https://registry.npmjs.org/%40findtime%2Fmcp-server/latest');
  assert.match(response.result.structuredContent.mcpVersion, /^\d+\.\d+\.\d+/);
  assert.equal(response.result.structuredContent.mcpLatestVersion, '3.25.8');
  assert.equal(response.result.structuredContent.mcpLatestVersionCheck, 'ok');
  assert.equal(response.result.structuredContent.mcpUpToDate, response.result.structuredContent.mcpVersion === '3.25.8');
  assert.equal(response.result.structuredContent.mcpInstallMode, 'npm_package');
  assert.match(response.result.structuredContent.mcpExecutablePath, /server\.js$/);
  assert.equal(response.result.structuredContent.apiBaseUrl, 'https://time-api.findtime.io');
  assert.equal(response.result.structuredContent.apiAuthConfigured, true);
  assert.equal(response.result.structuredContent.apiReachable, true);
  assert.equal(response.result.structuredContent.apiHealth.service, 'time-api');
  assert.equal(response.result.structuredContent._meta.endpoint, '/health');
});

test('get_api_diagnostics returns manual verification hints when the latest MCP version lookup fails', async () => {
  const server = createFindtimeMcpServer({
    apiBaseUrl: 'https://time-api.findtime.io',
    fetchImpl: async (url) => {
      if (url === 'https://registry.npmjs.org/%40findtime%2Fmcp-server/latest') {
        throw new Error('lookup failed');
      }

      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            ok: true,
            service: 'time-api'
          });
        }
      };
    }
  });

  const response = await server.handleMessage({
    jsonrpc: '2.0',
    id: 222,
    method: 'tools/call',
    params: {
      name: 'get_api_diagnostics',
      arguments: {}
    }
  });

  assert.equal(response.result.structuredContent.mcpLatestVersion, null);
  assert.equal(response.result.structuredContent.mcpLatestVersionCheck, 'failed');
  assert.equal(response.result.structuredContent.mcpLatestVersionSource, 'unavailable');
  assert.match(
    response.result.structuredContent.mcpLatestVersionHint,
    /Check the npm package page or Official MCP Registry listing directly/
  );
  assert.equal(
    response.result.structuredContent.mcpNpmUrl,
    'https://www.npmjs.com/package/@findtime/mcp-server'
  );
  assert.match(
    response.result.structuredContent.mcpRegistryUrl,
    /registry\.modelcontextprotocol\.io/
  );
  assert.equal(response.result.structuredContent.mcpInstallMode, 'npm_package');
});

test('search_timezones calls the production search endpoint with normalized params', async () => {
  const calls = [];
  const server = createFindtimeMcpServer({
    apiBaseUrl: 'https://time-api.findtime.io',
    apiKey: 'test-key',
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            shape: 'locations_search.v2',
            results: [
              {
                id: 'findtime:victoria|CA|America/Vancouver',
                name: 'Victoria'
              }
            ]
          });
        }
      };
    }
  });

  const response = await server.handleMessage({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'search_timezones',
      arguments: {
        query: 'Victoria',
        countryCode: 'CA',
        limit: 3
      }
    }
  });

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    'https://time-api.findtime.io/locations/search?query=Victoria&countryCode=CA&limit=3'
  );
  assert.equal(calls[0].init.headers.Authorization, 'Bearer test-key');
  assert.equal(response.result.isError, undefined);
  assert.equal(response.result.structuredContent.shape, 'locations_search.v2');
  assert.equal(response.result.structuredContent._meta.countryCodeBehavior, 'ranking_hint');
  assert.equal(response.result.structuredContent._meta.countryHint, 'CA');
});

test('search_timezones exposes primaryMatch and countryFilteredResults when a country hint is supplied', async () => {
  const server = createFindtimeMcpServer({
    apiBaseUrl: 'https://time-api.findtime.io',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({
          shape: 'locations_search.v2',
          results: [
            {
              id: 'findtime:victoria|CA|America/Vancouver',
              name: 'Victoria',
              countryCode: 'CA'
            },
            {
              id: 'findtime:victoria|SC|Indian/Mahe',
              name: 'Victoria',
              countryCode: 'SC'
            }
          ]
        });
      }
    })
  });

  const response = await server.handleMessage({
    jsonrpc: '2.0',
    id: 33,
    method: 'tools/call',
    params: {
      name: 'search_timezones',
      arguments: {
        query: 'Victoria',
        countryCode: 'CA'
      }
    }
  });

  assert.equal(response.result.structuredContent.primaryMatch.countryCode, 'CA');
  assert.equal(response.result.structuredContent.countryFilteredResults.length, 1);
  assert.equal(response.result.structuredContent.countryFilteredResults[0].countryCode, 'CA');
});

test('find_meeting_time forwards pipe-delimited arrays to the meeting endpoint', async () => {
  const calls = [];
  const server = createFindtimeMcpServer({
    apiBaseUrl: 'https://time-api.findtime.io',
    fetchImpl: async (url) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            shape: 'find_meeting_time.v2',
            resolved: true,
            options: []
          });
        }
      };
    }
  });

  const response = await server.handleMessage({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'find_meeting_time',
      arguments: {
        locations: ['Tokyo', 'Cairo', 'New York'],
        countryCodes: ['JP', 'EG', 'US'],
        date: '2026-03-10'
      }
    }
  });

  assert.equal(
    calls[0],
    'https://time-api.findtime.io/meeting/find?locations=Tokyo%7CCairo%7CNew+York&countryCodes=JP%7CEG%7CUS&date=2026-03-10'
  );
  assert.equal(response.result.structuredContent.shape, 'find_meeting_time.v2');
});

test('get_dst_schedule forwards both at and year to the DST endpoint', async () => {
  const calls = [];
  const server = createFindtimeMcpServer({
    apiBaseUrl: 'https://time-api.findtime.io',
    fetchImpl: async (url) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            shape: 'dst_schedule.v2',
            resolved: true,
            dst: {
              observesDST: true,
              year: 2025,
              transitions: []
            }
          });
        }
      };
    }
  });

  const response = await server.handleMessage({
    jsonrpc: '2.0',
    id: 35,
    method: 'tools/call',
    params: {
      name: 'get_dst_schedule',
      arguments: {
        timezone: 'Europe/London',
        at: '2025-03-22T12:00:00Z',
        year: 2025
      }
    }
  });

  assert.equal(
    calls[0],
    'https://time-api.findtime.io/timezone/dst?timezone=Europe%2FLondon&at=2025-03-22T12%3A00%3A00Z&year=2025'
  );
  assert.equal(response.result.structuredContent.dst.year, 2025);
});

test('tool errors are returned as MCP tool errors instead of JSON-RPC failures', async () => {
  const server = createFindtimeMcpServer({
    apiBaseUrl: 'https://time-api.findtime.io',
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      async text() {
        return JSON.stringify({ error: 'Missing API key' });
      }
    })
  });

  const response = await server.handleMessage({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'get_current_time',
      arguments: {
        city: 'Tokyo'
      }
    }
  });

  assert.equal(response.error, undefined);
  assert.equal(response.result.isError, true);
  assert.equal(response.result.structuredContent.status, 401);
});

test('get_current_time retries exact country queries through a canonical city when the resolver can do so deterministically', async () => {
  const calls = [];
  const server = createFindtimeMcpServer({
    apiBaseUrl: 'https://time-api.findtime.io',
    resolveLocationImpl: (input) => (
      String(input).trim() === 'Japan'
        ? {
            city: 'Tokyo',
            timezone: 'Asia/Tokyo',
            countryCode: 'JP',
            type: 'country-capital'
          }
        : null
    ),
    fetchImpl: async (url) => {
      calls.push(url);
      if (calls.length === 1) {
        return {
          ok: false,
          status: 404,
          async text() {
            return JSON.stringify({ notFound: true });
          }
        };
      }

      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({
            shape: 'current_time.v2',
            resolved: true,
            location: {
              name: 'Tokyo',
              countryCode: 'JP',
              timezoneIana: 'Asia/Tokyo'
            }
          });
        }
      };
    }
  });

  const response = await server.handleMessage({
    jsonrpc: '2.0',
    id: 34,
    method: 'tools/call',
    params: {
      name: 'get_current_time',
      arguments: {
        query: 'Japan'
      }
    }
  });

  assert.deepEqual(calls, [
    'https://time-api.findtime.io/time/current?query=Japan',
    'https://time-api.findtime.io/time/current?city=Tokyo&countryCode=JP'
  ]);
  assert.equal(response.result.structuredContent.location.name, 'Tokyo');
  assert.equal(response.result.structuredContent._meta.fallbackResolution.input, 'Japan');
  assert.equal(response.result.structuredContent._meta.fallbackResolution.strategy, 'country-capital');
});

test('content-length framing parses multiple messages from one chunk', () => {
  const buffer = new ContentLengthMessageBuffer();
  const first = { jsonrpc: '2.0', id: 10, method: 'ping' };
  const second = { jsonrpc: '2.0', id: 11, method: 'tools/list' };
  const combined = Buffer.concat([encodeMessage(first), encodeMessage(second)]);

  const messages = buffer.push(combined);

  assert.deepEqual(messages, [first, second]);
});

test('line-delimited JSON parsing works for Cursor-style stdio input', () => {
  const buffer = new ContentLengthMessageBuffer();
  const first = { jsonrpc: '2.0', id: 20, method: 'ping' };
  const second = { jsonrpc: '2.0', id: 21, method: 'tools/list' };
  const combined = Buffer.from(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`, 'utf8');

  const messages = buffer.push(combined);

  assert.deepEqual(messages, [first, second]);
});

test('stdio server mirrors json-line framing when initialize arrives as a json line', async () => {
  const serverPath = path.join(__dirname, 'server.js');
  const response = await invokeServerOverStdio({
    env: {
      FINDTIME_MCP_CLIENT_TYPE: 'codex'
    },
    input: `${JSON.stringify({
      jsonrpc: '2.0',
      id: 30,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' }
      }
    })}\n`,
    serverPath
  });

  assert.match(response, /^\{"jsonrpc":"2\.0","id":30,"result":/);
  assert.doesNotMatch(response, /^Content-Length:/);
});

test('stdio server mirrors content-length framing when initialize arrives with content-length headers', async () => {
  const serverPath = path.join(__dirname, 'server.js');
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 31,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' }
    }
  });
  const input = `Content-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`;

  const response = await invokeServerOverStdio({
    env: {
      FINDTIME_MCP_CLIENT_TYPE: 'codex'
    },
    input,
    serverPath
  });

  assert.match(response, /^Content-Length:\s+\d+\r\n\r\n\{/);
});

function invokeServerOverStdio({ serverPath, input, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      cwd: path.join(__dirname, '..', '..'),
      env: {
        ...process.env,
        ...env
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      child.kill();
      callback(value);
    };

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.includes('\n') || stdout.includes('\r\n\r\n')) {
        finish(resolve, stdout);
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (error) => {
      finish(reject, error);
    });

    child.on('exit', (code) => {
      if (settled) return;
      if (code === 0 && stdout) {
        finish(resolve, stdout);
        return;
      }
      finish(reject, new Error(`server exited before responding (code ${code}): ${stderr || stdout}`));
    });

    child.stdin.write(input);

    setTimeout(() => {
      if (!settled) {
        finish(reject, new Error(`timed out waiting for server response: ${stderr || stdout}`));
      }
    }, 2000);
  });
}
