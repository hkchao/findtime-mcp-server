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
      cwd: __dirname,
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
