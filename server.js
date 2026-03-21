#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const PACKAGE_ROOT = __dirname;
const LOCAL_PACKAGE_PATH = path.join(PACKAGE_ROOT, 'package.json');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const REPO_PACKAGE_PATH = path.join(REPO_ROOT, 'package.json');
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
  '2025-11-05',
  '2025-11-25'
]);

loadEnvironmentFiles();

const PACKAGE_METADATA = safeReadJson(LOCAL_PACKAGE_PATH) || safeReadJson(REPO_PACKAGE_PATH) || {};
const SERVER_VERSION = PACKAGE_METADATA.version || '0.0.0';
const DEFAULT_API_BASE_URL = firstNonEmpty(
  process.env.TIME_API_BASE_URL,
  process.env.FINDTIME_TIME_API_BASE_URL
) || 'https://time-api.findtime.io';
const DEFAULT_TIMEOUT_MS = parseInteger(process.env.TIME_API_TIMEOUT_MS, 15000);
const DEFAULT_API_KEY = firstNonEmpty(
  process.env.FINDTIME_API_KEY,
  process.env.TIME_API_KEY,
  process.env.FINDTIME_MCP_API_KEY,
  process.env.FINDTIME_TIME_API_KEY
);

const TOOL_DEFINITIONS = [
  {
    name: 'time_snapshot',
    description: 'Return the production time snapshot payload for one location or a list of locations.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Single location query such as "Tokyo" or "Europe/London".'
        },
        locations: stringOrStringArraySchema(
          'One or more locations. Arrays are joined with "|" before calling the API.'
        ),
        countryCode: {
          type: 'string',
          description: 'Optional ISO country hint for a single query.'
        },
        countryCodes: stringOrStringArraySchema(
          'Optional ISO country hints aligned to the locations list.'
        ),
        includeTransitions: {
          type: 'boolean',
          description: 'Include last and next timezone transition details.'
        }
      },
      additionalProperties: false
    },
    buildRequest(args) {
      ensureAtLeastOne(args, ['query', 'locations'], 'time_snapshot requires query or locations.');
      const params = new URLSearchParams();
      setParam(params, 'query', args.query);
      setParam(params, 'locations', args.locations, { joinArraysWith: '|' });
      setParam(params, 'countryCode', args.countryCode);
      setParam(params, 'countryCodes', args.countryCodes, { joinArraysWith: '|' });
      setParam(params, 'includeTransitions', args.includeTransitions);
      return { path: '/time/snapshot', params };
    }
  },
  {
    name: 'get_current_time',
    description: 'Return the production current time payload for a single city, query, or timezone.',
    inputSchema: {
      type: 'object',
      properties: {
        city: {
          type: 'string',
          description: 'City name such as "Tokyo".'
        },
        query: {
          type: 'string',
          description: 'Free-form location query or timezone abbreviation.'
        },
        timezone: {
          type: 'string',
          description: 'Direct IANA timezone, such as "Europe/London".'
        },
        countryCode: {
          type: 'string',
          description: 'Optional ISO country hint for ambiguous city names.'
        }
      },
      additionalProperties: false
    },
    buildRequest(args) {
      ensureAtLeastOne(args, ['city', 'query', 'timezone'], 'get_current_time requires city, query, or timezone.');
      const params = new URLSearchParams();
      setParam(params, 'city', args.city);
      setParam(params, 'query', args.query);
      setParam(params, 'timezone', args.timezone);
      setParam(params, 'countryCode', args.countryCode);
      return { path: '/time/current', params };
    }
  },
  {
    name: 'get_dst_schedule',
    description: 'Return the production DST schedule payload, including current abbreviation and transition details.',
    inputSchema: {
      type: 'object',
      properties: {
        city: {
          type: 'string',
          description: 'City name such as "Reykjavik".'
        },
        query: {
          type: 'string',
          description: 'Free-form location query.'
        },
        timezone: {
          type: 'string',
          description: 'Direct IANA timezone, such as "America/New_York".'
        },
        countryCode: {
          type: 'string',
          description: 'Optional ISO country hint for ambiguous city names.'
        },
        at: {
          type: 'string',
          description: 'Optional ISO timestamp used as the reference instant.'
        }
      },
      additionalProperties: false
    },
    buildRequest(args) {
      ensureAtLeastOne(args, ['city', 'query', 'timezone'], 'get_dst_schedule requires city, query, or timezone.');
      const params = new URLSearchParams();
      setParam(params, 'city', args.city);
      setParam(params, 'query', args.query);
      setParam(params, 'timezone', args.timezone);
      setParam(params, 'countryCode', args.countryCode);
      setParam(params, 'at', args.at);
      return { path: '/timezone/dst', params };
    }
  },
  {
    name: 'convert_time',
    description: 'Convert a source local time into one or more target locations using the production conversion endpoint.',
    inputSchema: {
      type: 'object',
      required: ['from', 'to', 'time'],
      properties: {
        from: {
          type: 'string',
          description: 'Source location or timezone.'
        },
        fromCountryCode: {
          type: 'string',
          description: 'Optional ISO country hint for the source location.'
        },
        to: stringOrStringArraySchema(
          'One target or a list of targets. Arrays are joined with "|" before calling the API.'
        ),
        toCountryCodes: stringOrStringArraySchema(
          'Optional ISO country hints aligned to the target list.'
        ),
        time: {
          type: 'string',
          description: 'Source local time, such as "9:00 AM".'
        },
        date: {
          type: 'string',
          description: 'Optional ISO date used as the conversion context.'
        }
      },
      additionalProperties: false
    },
    buildRequest(args) {
      ensureRequired(args, ['from', 'to', 'time'], 'convert_time requires from, to, and time.');
      const params = new URLSearchParams();
      setParam(params, 'from', args.from);
      setParam(params, 'fromCountryCode', args.fromCountryCode);
      setParam(params, 'to', args.to, { joinArraysWith: '|' });
      setParam(params, 'toCountryCodes', args.toCountryCodes, { joinArraysWith: '|' });
      setParam(params, 'time', args.time);
      setParam(params, 'date', args.date);
      return { path: '/time/convert', params };
    }
  },
  {
    name: 'get_overlap_hours',
    description: 'Return shared business-hours overlap across multiple locations using the production overlap endpoint.',
    inputSchema: {
      type: 'object',
      required: ['locations'],
      properties: {
        locations: stringOrStringArraySchema(
          'Two or more locations. Arrays are joined with "|" before calling the API.'
        ),
        countryCodes: stringOrStringArraySchema(
          'Optional ISO country hints aligned to the locations list.'
        ),
        date: {
          type: 'string',
          description: 'Optional ISO date used to compute overlap.'
        }
      },
      additionalProperties: false
    },
    buildRequest(args) {
      ensureRequired(args, ['locations'], 'get_overlap_hours requires locations.');
      const params = new URLSearchParams();
      setParam(params, 'locations', args.locations, { joinArraysWith: '|' });
      setParam(params, 'countryCodes', args.countryCodes, { joinArraysWith: '|' });
      setParam(params, 'date', args.date);
      return { path: '/time/overlap', params };
    }
  },
  {
    name: 'find_meeting_time',
    description: 'Return ranked meeting suggestions from the production meeting search endpoint.',
    inputSchema: {
      type: 'object',
      required: ['locations'],
      properties: {
        locations: stringOrStringArraySchema(
          'Two or more locations. Arrays are joined with "|" before calling the API.'
        ),
        countryCodes: stringOrStringArraySchema(
          'Optional ISO country hints aligned to the locations list.'
        ),
        date: {
          type: 'string',
          description: 'Optional ISO date to anchor the meeting search.'
        }
      },
      additionalProperties: false
    },
    buildRequest(args) {
      ensureRequired(args, ['locations'], 'find_meeting_time requires locations.');
      const params = new URLSearchParams();
      setParam(params, 'locations', args.locations, { joinArraysWith: '|' });
      setParam(params, 'countryCodes', args.countryCodes, { joinArraysWith: '|' });
      setParam(params, 'date', args.date);
      return { path: '/meeting/find', params };
    }
  },
  {
    name: 'search_timezones',
    description: 'Search production location records by city, country, or timezone-related query.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description: 'Search term such as "Victoria", "Sao Paulo", or "Tokyo".'
        },
        countryCode: {
          type: 'string',
          description: 'Optional ISO country hint.'
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 25,
          description: 'Maximum number of results to return.'
        }
      },
      additionalProperties: false
    },
    buildRequest(args) {
      ensureRequired(args, ['query'], 'search_timezones requires query.');
      const params = new URLSearchParams();
      setParam(params, 'query', args.query);
      setParam(params, 'countryCode', args.countryCode);
      setParam(params, 'limit', args.limit);
      return { path: '/locations/search', params };
    }
  },
  {
    name: 'get_location_by_id',
    description: 'Hydrate an exact production location record by stable findtime id.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: {
          type: 'string',
          description: 'Stable location id such as "findtime:victoria|CA|America/Vancouver".'
        }
      },
      additionalProperties: false
    },
    buildRequest(args) {
      ensureRequired(args, ['id'], 'get_location_by_id requires id.');
      return {
        path: `/locations/${encodeURIComponent(String(args.id).trim())}`,
        params: new URLSearchParams()
      };
    }
  }
];

const TOOL_DEFINITIONS_BY_NAME = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

function loadEnvironmentFiles() {
  const searchRoots = uniquePaths([
    process.cwd(),
    PACKAGE_ROOT,
    REPO_ROOT
  ]);
  const dotenvPaths = searchRoots.flatMap((root) => ([
    path.join(root, '.env.development.local'),
    path.join(root, '.env.development'),
    path.join(root, '.env.local'),
    path.join(root, '.env')
  ]));

  try {
    const dotenv = require('dotenv');
    for (const dotenvPath of dotenvPaths) {
      if (fs.existsSync(dotenvPath)) {
        dotenv.config({ path: dotenvPath, override: false, quiet: true });
      }
    }
  } catch (_error) {
    // The server can still run when dotenv is unavailable.
  }
}

function uniquePaths(paths) {
  const seen = new Set();
  const values = [];

  for (const candidate of paths) {
    const normalized = typeof candidate === 'string' && candidate.trim()
      ? path.resolve(candidate)
      : null;
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    values.push(normalized);
  }

  return values;
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringOrStringArraySchema(description) {
  return {
    anyOf: [
      {
        type: 'string',
        description
      },
      {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        description
      }
    ]
  };
}

function ensureRequired(args, keys, message) {
  for (const key of keys) {
    if (args[key] === undefined || args[key] === null || String(args[key]).trim() === '') {
      throw invalidParamsError(message);
    }
  }
}

function ensureAtLeastOne(args, keys, message) {
  const present = keys.some((key) => {
    const value = args[key];
    if (Array.isArray(value)) return value.some((item) => typeof item === 'string' && item.trim());
    if (typeof value === 'boolean') return true;
    return typeof value === 'string' && value.trim();
  });

  if (!present) {
    throw invalidParamsError(message);
  }
}

function invalidParamsError(message) {
  const error = new Error(message);
  error.code = -32602;
  return error;
}

function methodNotFoundError(method) {
  const error = new Error(`Method not found: ${method}`);
  error.code = -32601;
  return error;
}

function setParam(searchParams, key, value, options = {}) {
  const { joinArraysWith = ',' } = options;
  if (value === undefined || value === null) return;

  if (Array.isArray(value)) {
    const cleaned = value
      .map((item) => (typeof item === 'string' ? item.trim() : String(item || '').trim()))
      .filter(Boolean);
    if (cleaned.length > 0) {
      searchParams.set(key, cleaned.join(joinArraysWith));
    }
    return;
  }

  if (typeof value === 'boolean') {
    searchParams.set(key, String(value));
    return;
  }

  if (typeof value === 'number') {
    if (Number.isFinite(value)) {
      searchParams.set(key, String(value));
    }
    return;
  }

  const text = String(value).trim();
  if (text) {
    searchParams.set(key, text);
  }
}

function negotiateProtocolVersion(requestedVersion) {
  if (typeof requestedVersion === 'string' && SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)) {
    return requestedVersion;
  }
  return DEFAULT_PROTOCOL_VERSION;
}

function createSuccessResponse(id, result) {
  return {
    jsonrpc: '2.0',
    id,
    result
  };
}

function createErrorResponse(id, code, message, data) {
  const payload = {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message
    }
  };
  if (data !== undefined) {
    payload.error.data = data;
  }
  return payload;
}

function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8'),
    body
  ]);
}

class ContentLengthMessageBuffer {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this.lineBuffer = '';
    this.lastMode = null;
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const framedMessages = this.extractFramedMessages();
    if (framedMessages.length > 0) {
      this.lastMode = 'content-length';
      return framedMessages;
    }

    const lineMessages = this.extractLineDelimitedMessages(chunk);
    if (lineMessages.length > 0) {
      this.lastMode = 'json-line';
    }
    return lineMessages;
  }

  extractFramedMessages() {
    const messages = [];

    while (true) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const headerText = this.buffer.slice(0, headerEnd).toString('utf8');
      const contentLengthMatch = headerText.match(/Content-Length:\s*(\d+)/i);

      if (!contentLengthMatch) {
        throw new Error('Missing Content-Length header.');
      }

      const contentLength = Number.parseInt(contentLengthMatch[1], 10);
      const messageEnd = headerEnd + 4 + contentLength;

      if (this.buffer.length < messageEnd) break;

      const bodyBuffer = this.buffer.slice(headerEnd + 4, messageEnd);
      this.buffer = this.buffer.slice(messageEnd);
      messages.push(JSON.parse(bodyBuffer.toString('utf8')));
    }

    return messages;
  }

  extractLineDelimitedMessages(chunk) {
    const messages = [];
    const text = Buffer.from(chunk).toString('utf8');
    this.lineBuffer += text;

    const lines = this.lineBuffer.split(/\r?\n/);
    this.lineBuffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        messages.push(JSON.parse(trimmed));
      } catch (_error) {
        this.lineBuffer = `${trimmed}\n${this.lineBuffer}`;
      }
    }

    return messages;
  }
}

function summarizeToolPayload(toolName, payload) {
  return `${toolName} response\n${JSON.stringify(payload, null, 2)}`;
}

function buildToolErrorResult(toolName, apiResponse) {
  const summary = {
    ok: false,
    tool: toolName,
    status: apiResponse.status,
    url: apiResponse.url,
    error: apiResponse.parsedBody !== undefined ? apiResponse.parsedBody : apiResponse.rawBody
  };

  if (apiResponse.networkError) {
    summary.networkError = apiResponse.networkError;
  }

  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: summarizeToolPayload(toolName, summary)
      }
    ],
    structuredContent: summary
  };
}

function buildToolSuccessResult(toolName, payload, apiMeta) {
  const structuredContent = {
    ...payload,
    _meta: {
      endpoint: apiMeta.endpoint,
      url: apiMeta.url
    }
  };

  return {
    content: [
      {
        type: 'text',
        text: summarizeToolPayload(toolName, structuredContent)
      }
    ],
    structuredContent
  };
}

function createFindtimeMcpServer(options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  const apiBaseUrl = options.apiBaseUrl || DEFAULT_API_BASE_URL;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const apiKey = options.apiKey === undefined ? DEFAULT_API_KEY : options.apiKey;
  const serverName = options.serverName || 'findtime';
  const serverTitle = options.serverTitle || 'findtime Time API MCP';

  if (typeof fetchImpl !== 'function') {
    throw new Error('Fetch implementation is required to run the MCP server.');
  }

  const state = {
    initialized: false,
    protocolVersion: DEFAULT_PROTOCOL_VERSION
  };

  async function fetchJson(toolName, request) {
    const url = new URL(request.path, apiBaseUrl);
    if (request.params && request.params.size > 0) {
      url.search = request.params.toString();
    }

    const headers = {
      Accept: 'application/json',
      'User-Agent': `findtime-mcp/${SERVER_VERSION}`,
      'X-Findtime-MCP-Tool': toolName
    };

    if (typeof apiKey === 'string' && apiKey.trim()) {
      headers.Authorization = `Bearer ${apiKey.trim()}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(url.toString(), {
        method: 'GET',
        headers,
        signal: controller.signal
      });

      const rawBody = await response.text();
      const parsedBody = tryParseJson(rawBody);

      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          url: url.toString(),
          rawBody,
          parsedBody
        };
      }

      return {
        ok: true,
        status: response.status,
        url: url.toString(),
        parsedBody: parsedBody === undefined ? { rawBody } : parsedBody
      };
    } catch (error) {
      return {
        ok: false,
        status: null,
        url: url.toString(),
        rawBody: null,
        parsedBody: undefined,
        networkError: error && error.name === 'AbortError'
          ? `Request timed out after ${timeoutMs}ms`
          : String(error && error.message ? error.message : error)
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function callTool(name, args = {}) {
    const tool = TOOL_DEFINITIONS_BY_NAME.get(name);
    if (!tool) {
      throw invalidParamsError(`Unknown tool: ${name}`);
    }

    const request = tool.buildRequest(args || {});
    const apiResponse = await fetchJson(name, request);

    if (!apiResponse.ok) {
      return buildToolErrorResult(name, apiResponse);
    }

    return buildToolSuccessResult(name, apiResponse.parsedBody, {
      endpoint: request.path,
      url: apiResponse.url
    });
  }

  async function handleMessage(message) {
    const isRequest = message && typeof message === 'object' && Object.prototype.hasOwnProperty.call(message, 'id');
    const method = message && typeof message === 'object' ? message.method : null;

    if (!method) {
      if (isRequest) {
        return createErrorResponse(message.id, -32600, 'Invalid request');
      }
      return null;
    }

    try {
      if (method === 'initialize') {
        state.initialized = true;
        state.protocolVersion = negotiateProtocolVersion(message.params && message.params.protocolVersion);

        return createSuccessResponse(message.id, {
          protocolVersion: state.protocolVersion,
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: serverName,
            title: serverTitle,
            version: SERVER_VERSION
          }
        });
      }

      if (method === 'notifications/initialized') {
        state.initialized = true;
        return null;
      }

      if (method === 'ping') {
        return createSuccessResponse(message.id, {});
      }

      if (method === 'tools/list') {
        return createSuccessResponse(message.id, {
          tools: TOOL_DEFINITIONS.map(({ name, description, inputSchema }) => ({
            name,
            description,
            inputSchema
          }))
        });
      }

      if (method === 'tools/call') {
        const toolName = message.params && message.params.name;
        const toolArgs = (message.params && message.params.arguments) || {};
        const result = await callTool(toolName, toolArgs);
        return createSuccessResponse(message.id, result);
      }

      throw methodNotFoundError(method);
    } catch (error) {
      const code = Number.isFinite(error.code) ? error.code : -32603;
      const data = code === -32603
        ? { message: String(error && error.message ? error.message : error) }
        : undefined;
      return isRequest
        ? createErrorResponse(message.id, code, error.message || 'Internal error', data)
        : null;
    }
  }

  return {
    state,
    callTool,
    handleMessage
  };
}

function tryParseJson(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }

  try {
    return JSON.parse(value);
  } catch (_error) {
    return undefined;
  }
}

function startStdioServer(options = {}) {
  const server = createFindtimeMcpServer(options);
  const messageBuffer = new ContentLengthMessageBuffer();
  let outputMode = detectOutputMode(options.outputMode);
  let queue = Promise.resolve();

  process.stdin.on('data', (chunk) => {
    let messages;
    try {
      messages = messageBuffer.push(chunk);
    } catch (error) {
      console.error(`[findtime-mcp] Failed to parse incoming message: ${error.message}`);
      return;
    }

    if (!outputMode && messageBuffer.lastMode) {
      outputMode = messageBuffer.lastMode;
    }

    for (const message of messages) {
      queue = queue
        .then(async () => {
          const response = await server.handleMessage(message);
          if (response) {
            writeResponse(process.stdout, response, outputMode);
          }
        })
        .catch((error) => {
          const requestId = message && Object.prototype.hasOwnProperty.call(message, 'id')
            ? message.id
            : null;

          if (requestId !== null) {
            writeResponse(
              process.stdout,
              createErrorResponse(
                requestId,
                -32603,
                'Internal error',
                { message: String(error && error.message ? error.message : error) }
              ),
              outputMode
            );
          }
        });
    }
  });

  process.stdin.resume();
  return server;
}

function detectOutputMode(explicitMode) {
  if (explicitMode === 'content-length' || explicitMode === 'json-line') {
    return explicitMode;
  }

  const clientType = String(process.env.FINDTIME_MCP_CLIENT_TYPE || '').trim().toLowerCase();
  if (clientType === 'cursor') {
    return 'json-line';
  }

  if (clientType === 'codex') {
    return null;
  }

  return null;
}

function writeResponse(stream, message, outputMode) {
  if (outputMode === 'json-line') {
    stream.write(`${JSON.stringify(message)}\n`);
    return;
  }

  stream.write(encodeMessage(message));
}

if (require.main === module) {
  startStdioServer();
}

module.exports = {
  ContentLengthMessageBuffer,
  TOOL_DEFINITIONS,
  createErrorResponse,
  createFindtimeMcpServer,
  createSuccessResponse,
  encodeMessage,
  startStdioServer
};
