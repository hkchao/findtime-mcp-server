#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const PACKAGE_ROOT = __dirname;
const LOCAL_PACKAGE_PATH = path.join(PACKAGE_ROOT, 'package.json');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const REPO_PACKAGE_PATH = path.join(REPO_ROOT, 'package.json');
const DEFAULT_PROTOCOL_VERSION = '2025-11-25';
const END_USER_ID_ARGUMENT = '_endUserId';
const END_USER_ID_HEADER = 'X-Findtime-End-User-ID';
const END_USER_ID_MAX_LENGTH = 256;
const END_USER_ID_SCHEMA = {
  type: 'string',
  description: 'Optional opaque per-call end-user attribution token populated by the MCP host, not the LLM. Use a non-PII hash or token; never send raw email, name, or platform user ID.'
};
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
  '2025-11-25'
]);

loadEnvironmentFiles();

const LOCAL_PACKAGE_METADATA = safeReadJson(LOCAL_PACKAGE_PATH) || null;
const REPO_PACKAGE_METADATA = safeReadJson(REPO_PACKAGE_PATH) || null;
const PACKAGE_METADATA = LOCAL_PACKAGE_METADATA || REPO_PACKAGE_METADATA || {};
const SERVER_VERSION = PACKAGE_METADATA.version || '0.0.0';
const MCP_PACKAGE_NAME = PACKAGE_METADATA.name || '@findtime/mcp-server';
const MCP_NPM_REGISTRY_LATEST_URL = `https://registry.npmjs.org/${encodeURIComponent(MCP_PACKAGE_NAME)}/latest`;
const MCP_NPM_URL = `https://www.npmjs.com/package/${MCP_PACKAGE_NAME}`;
const MCP_REGISTRY_URL = 'https://registry.modelcontextprotocol.io/?q=io.github.hkchao%2Ffindtime-mcp-server';
const MCP_INSTALL_MODE = determineInstallMode({
  packageRoot: PACKAGE_ROOT,
  localPackageMetadata: LOCAL_PACKAGE_METADATA,
  repoPackageMetadata: REPO_PACKAGE_METADATA
});
const DEFAULT_API_BASE_URL = firstNonEmpty(
  process.env.TIME_API_BASE_URL,
  process.env.FINDTIME_TIME_API_BASE_URL
) || 'https://time-api.findtime.io';
const DEFAULT_TIMEOUT_MS = parseInteger(process.env.TIME_API_TIMEOUT_MS, 15000);
const MCP_USAGE_TELEMETRY_URL = firstNonEmpty(
  process.env.FINDTIME_MCP_USAGE_TELEMETRY_URL,
  process.env.FINDTIME_USAGE_TELEMETRY_URL
) || 'https://slack.findtime.io/telemetry/usage';
const MCP_USAGE_TELEMETRY_TIMEOUT_MS = parseInteger(process.env.FINDTIME_MCP_USAGE_TELEMETRY_TIMEOUT_MS, 1200);
const DEFAULT_API_KEY = firstNonEmpty(
  process.env.FINDTIME_API_KEY,
  process.env.TIME_API_KEY,
  process.env.FINDTIME_MCP_API_KEY,
  process.env.FINDTIME_TIME_API_KEY
);
const DEFAULT_BINDING_TYPE = firstNonEmpty(
  process.env.FINDTIME_BINDING_TYPE,
  process.env.FINDTIME_MCP_BINDING_TYPE
) || '';
const DEFAULT_BINDING_VALUE = firstNonEmpty(
  process.env.FINDTIME_BINDING_VALUE,
  process.env.FINDTIME_MCP_BINDING_VALUE
) || '';
const DEFAULT_BINDING_HEADER = firstNonEmpty(
  process.env.FINDTIME_BINDING_HEADER,
  process.env.FINDTIME_MCP_BINDING_HEADER
) || '';
const TIMEZONE_HELPERS_PATH = path.join(REPO_ROOT, 'slack-bot', 'timezone-helpers.js');
const ANSWER_ONLY_TOOL_NAMES = new Set([
  'answer_time_question',
  'get_findtime_help',
  'get_api_diagnostics',
  'send_feedback'
]);
const {
  buildActionableErrorResult,
  enrichResolvedPayload
} = require('./actionable-errors.cjs');
const TOOL_DEFINITIONS = [
  {
    name: 'answer_time_question',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: 'PREFERRED entry point for vague, messy, or mixed time/timezone/scheduling questions. findtime.io classifies intent and dispatches internally. Use this when the user gives a raw natural-language prompt with a day or date qualifier, such as "Tuesday", "next Friday", "tomorrow", "tonight", "this weekend", "in 3 weeks", or "last Monday". Do not use this to dump structured from/to/time fields; call convert_time, get_current_time, or find_meeting_time when those arguments are already known. If a city is unknown or ambiguous, read candidates and call search_timezones rather than guessing.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description: 'The raw user time-related question or prompt.'
        },
        userTimezone: {
          type: 'string',
          description: 'Optional IANA timezone for the user, used for relative questions like "my time" or "tomorrow".'
        },
        locale: {
          type: 'string',
          description: 'Optional user locale hint, such as en-US.'
        },
        now: {
          type: 'string',
          description: 'Optional ISO timestamp for deterministic relative-date handling.'
        },
        date: {
          type: 'string',
          description: 'Optional YYYY-MM-DD date context.'
        }
      },
      additionalProperties: false
    },
    buildRequest(args) {
      ensureRequired(args, ['query'], 'answer_time_question requires query.');
      const params = new URLSearchParams();
      setParam(params, 'query', args.query);
      setParam(params, 'userTimezone', args.userTimezone);
      setParam(params, 'locale', args.locale);
      setParam(params, 'now', args.now);
      setParam(params, 'date', args.date);
      return { path: '/time/answer', params };
    }
  },
  {
    name: 'get_api_diagnostics',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: 'Return MCP and findtime Time API diagnostics: running MCP version, latest published version, API base URL, auth configuration, and live health. Call this after auth or connectivity failures. It does not answer time questions.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    },
    buildRequest() {
      return { path: '/health', params: new URLSearchParams() };
    }
  },
  {
    name: 'send_feedback',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: 'Report a wrong, incomplete, or unhelpful findtime.io MCP answer. Call this after a tool result that you or the user judged incorrect. Required: tool, query, and whatWasWrong. Optional: expectedAnswer. Only the tool name is sent to findtime.io; the query, expected answer, and other free text stay local and are discarded. Never send names, emails, phone numbers, IP addresses, or raw user ids.',
    inputSchema: {
      type: 'object',
      required: ['tool', 'query', 'whatWasWrong'],
      properties: {
        tool: {
          type: 'string',
          description: 'MCP tool that produced the unhelpful result, such as answer_time_question, convert_time, or get_current_time.'
        },
        query: {
          type: 'string',
          description: 'Original time query or lookup text. Strip names, emails, and other personal data first.'
        },
        whatWasWrong: {
          type: 'string',
          description: 'Short description of the mistake or why the answer was unhelpful.'
        },
        expectedAnswer: {
          type: 'string',
          description: 'Optional correct time, timezone, or location the tool should have returned.'
        }
      },
      additionalProperties: false
    },
    buildRequest() {
      return { path: '/mcp/feedback', params: new URLSearchParams() };
    }
  },
  {
    name: 'get_findtime_help',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: 'Return enterprise-friendly findtime.io MCP usage help, including supported time-intelligence intents, answer API examples, ambiguity handling examples, and recommended answer-only deployment guidance.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    },
    buildRequest() {
      return null;
    }
  },
  {
    name: 'time_snapshot',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: 'Return the production current time payload for a single already-identified city, query, or IANA timezone. Do not use this for conversions, overlaps, or meeting search. If the city is unknown or could be more than one place, call search_timezones and retry with suggestedQuery or countryCode; do not guess. Exact country-name queries may be retried through a canonical city when the resolver can do so deterministically. For relative-date inputs ("Tuesday", "next Friday", "tomorrow", "tonight"), route to answer_time_question.',
    inputSchema: {
      type: 'object',
      properties: {
        city: {
          type: 'string',
          description: 'City name such as "Tokyo".'
        },
        query: {
          type: 'string',
          description: 'Free-form location query, country name, or timezone abbreviation.'
        },
        timezone: {
          type: 'string',
          description: 'Direct IANA timezone, such as "Europe/London".'
        },
        countryCode: {
          type: 'string',
          description: 'Optional ISO country hint for ambiguous city names.'
        },
        candidateLimit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Page size for namesake candidates. Default 6. Follow moreCandidates.resolve or moreCandidates.search for the rest.'
        },
        candidateOffset: {
          type: 'integer',
          minimum: 0,
          description: 'Skip this many namesake candidates. Copy from moreCandidates.candidateOffset.'
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
      setParam(params, 'candidateLimit', args.candidateLimit);
      setParam(params, 'candidateOffset', args.candidateOffset);
      return { path: '/time/current', params };
    }
  },
  {
    name: 'get_dst_schedule',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: 'Return the production DST schedule payload, including current abbreviation and transition details. For relative-date inputs ("this week", "next Friday", "tomorrow"), route to answer_time_question, which resolves the relative date and dispatches internally.',
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
        },
        year: {
          type: 'integer',
          description: 'Optional calendar year used to return DST transitions for that civil year.'
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
      setParam(params, 'year', args.year);
      return { path: '/timezone/dst', params };
    }
  },
  {
    name: 'convert_time',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: 'Convert a source timezone local time into one or more target locations. Requires structured from, to, and time. Do not pass a whole sentence as from or to; use answer_time_question for vague prompts. If a city is unknown or ambiguous, call search_timezones and retry with a candidate suggestedQuery or countryCode instead of guessing. date may be ISO YYYY-MM-DD, or time may include a simple human date phrase such as "3pm Tuesday". When presenting results, copy localTime.weekday, localTime.date, localTime.time12h/time24h, timezone abbreviation, and UTC offset exactly from the tool output; do not recompute or shift day names during synthesis. Route vague or mixed-intent raw prompts to answer_time_question.',
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
          description: 'Source local time, such as "9:00 AM"; may include a simple human date phrase such as "3pm Tuesday".'
        },
        date: {
          type: 'string',
          description: 'Optional date context. Prefer ISO YYYY-MM-DD, but simple human values such as "Thursday", "tomorrow", or "next Friday" are accepted.'
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
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: 'Return shared business-hours overlap across multiple locations using the production overlap endpoint. Use when you have structured locations and, optionally, a date. date may be ISO YYYY-MM-DD or a simple human day/date value such as "Thursday", "tomorrow", or "next Friday"; findtime.io resolves it relative to the first location timezone. Route vague or mixed-intent raw prompts to answer_time_question.',
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
          description: 'Optional date used to compute overlap. Prefer ISO YYYY-MM-DD, but simple human values such as "Thursday", "tomorrow", or "next Friday" are accepted.'
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
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: 'Return ranked meeting suggestions from the production meeting search endpoint. Use when you have structured locations and, optionally, a date. date may be ISO YYYY-MM-DD or a simple human day/date value such as "Thursday", "tomorrow", or "next Friday"; findtime.io resolves it relative to the first location timezone. Paste shareText to the user. plannerUrl carries aiCities, up to three UTC aiSlots, legacy aiTime, and ref=mcp-bot. Do not invent wall-clock times. Route vague or mixed-intent raw prompts to answer_time_question.',
    inputSchema: {
      type: 'object',
      properties: {
        locations: stringOrStringArraySchema(
          'Two or more locations. Arrays are joined with "|" before calling the API.'
        ),
        countryCodes: stringOrStringArraySchema(
          'Optional ISO country hints aligned to the locations list.'
        ),
        date: {
          type: 'string',
          description: 'Optional date to anchor the meeting search. Prefer ISO YYYY-MM-DD, but simple human values such as "Thursday", "tomorrow", or "next Friday" are accepted.'
        },
        durationMinutes: {
          type: 'integer',
          description: 'Optional meeting length. Only 30, 45, or 60 are written onto the planner link as aiDuration.'
        }
      },
      additionalProperties: false
    },
    buildRequest(args) {
      requireMeetingLocations(args, 'find_meeting_time');
      const params = new URLSearchParams();
      setParam(params, 'locations', args.locations, { joinArraysWith: '|' });
      setParam(params, 'countryCodes', args.countryCodes, { joinArraysWith: '|' });
      setParam(params, 'date', args.date);
      setParam(params, 'durationMinutes', args.durationMinutes);
      setParam(params, 'ref', 'mcp-bot');
      return { path: '/meeting/find', params };
    }
  },
  {
    name: 'check_proposed_time',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: 'Judge a proposed meeting instant for each city. Use when the user already has a clock time, such as "Tuesday 9am PT with London and Tokyo — is that bad?". Pass start as an ISO instant, or as a floating local time with home set to an IANA timezone. Paste shareText. Time API computes the UTC instant, local lines, verdicts, and up to three better aiSlots. Do not invent wall-clock times. If context is set, tell the user that sentence. It says whether daylight saving skipped the local time or made it happen twice.',
    inputSchema: {
      type: 'object',
      required: ['start'],
      properties: {
        locations: stringOrStringArraySchema('Two or more cities or timezones.'),
        countryCodes: stringOrStringArraySchema('Optional ISO country hints aligned to locations.'),
        start: {
          type: 'string',
          description: 'ISO instant with a UTC offset, or a floating local time such as 2026-09-29T09:00 or 9:00am.'
        },
        home: {
          type: 'string',
          description: 'IANA timezone for a floating start, such as America/Los_Angeles.'
        },
        date: {
          type: 'string',
          description: 'YYYY-MM-DD when start is only a clock time.'
        },
        durationMinutes: { type: 'integer', description: 'Optional. Only 30, 45, or 60 are written onto the planner link.' },
        workStart: { type: 'integer', description: 'First in-hours local hour. Default 9.' },
        workEnd: { type: 'integer', description: 'Last in-hours local hour, inclusive. Default 18.' }
      },
      additionalProperties: false
    },
    buildRequest(args) {
      ensureRequired(args, ['start'], 'check_proposed_time requires start.');
      requireMeetingLocations(args, 'check_proposed_time');
      const params = new URLSearchParams();
      setParam(params, 'locations', args.locations, { joinArraysWith: '|' });
      setParam(params, 'countryCodes', args.countryCodes, { joinArraysWith: '|' });
      setParam(params, 'start', args.start);
      setParam(params, 'home', args.home);
      setParam(params, 'date', args.date);
      setParam(params, 'durationMinutes', args.durationMinutes);
      setParam(params, 'workStart', args.workStart);
      setParam(params, 'workEnd', args.workEnd);
      return { path: '/meeting/check', params };
    }
  },
  {
    name: 'are_they_awake',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: 'Say whether people in other cities are in work, awake, or sleep at a moment. Use for "3pm for me — can I ping Bangalore?". myTime defaults to now. Pass myTimezone as an IANA id or myCity as a place. Paste shareText. A rough window includes a plannerUrl with better aiSlots.',
    inputSchema: {
      type: 'object',
      required: [],
      properties: {
        theirCity: { type: 'string', description: 'One city or timezone to judge.' },
        theirCities: stringOrStringArraySchema('One or more cities or timezones to judge.'),
        locations: stringOrStringArraySchema('Alias for theirCities.'),
        myTime: { type: 'string', description: 'ISO instant, or a floating local time in myTimezone. Defaults to now.' },
        myTimezone: { type: 'string', description: 'IANA timezone for the caller, such as America/Los_Angeles.' },
        myCity: { type: 'string', description: 'Caller city, used when myTimezone is omitted.' },
        date: { type: 'string', description: 'YYYY-MM-DD when myTime is only a clock time.' },
        durationMinutes: { type: 'integer', description: 'Optional. Only 30, 45, or 60 are written onto the planner link.' },
        workStart: { type: 'integer', description: 'First in-hours local hour. Default 9.' },
        workEnd: { type: 'integer', description: 'Last in-hours local hour, inclusive. Default 18.' }
      },
      additionalProperties: false
    },
    buildRequest(args) {
      const params = new URLSearchParams();
      setParam(params, 'theirCity', args.theirCity);
      setParam(params, 'theirCities', args.theirCities, { joinArraysWith: '|' });
      setParam(params, 'locations', args.locations, { joinArraysWith: '|' });
      setParam(params, 'myTime', args.myTime);
      setParam(params, 'myTimezone', args.myTimezone);
      setParam(params, 'myCity', args.myCity);
      setParam(params, 'date', args.date);
      setParam(params, 'durationMinutes', args.durationMinutes);
      setParam(params, 'workStart', args.workStart);
      setParam(params, 'workEnd', args.workEnd);
      return { path: '/meeting/awake', params };
    }
  },
  {
    name: 'rank_recurring_slot',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: 'Score who a weekly wall-clock time punishes, including a daylight-saving week when one falls in the next 26 weeks. Use for "Monday 9am PT standup for San Francisco, London, and Bangalore". weekday is a day name. time is a clock such as 9am. home is the IANA timezone of that clock. Paste shareText. The kinder slot and plannerUrl come from the meeting engine. If a week has context, tell the user that sentence. It says whether daylight saving skipped that local time or made it happen twice.',
    inputSchema: {
      type: 'object',
      required: ['weekday', 'time', 'home'],
      properties: {
        locations: stringOrStringArraySchema('Two or more cities or timezones.'),
        countryCodes: stringOrStringArraySchema('Optional ISO country hints aligned to locations.'),
        weekday: { type: 'string', description: 'Day name such as Mon or Monday. 1 is Monday and 7 is Sunday.' },
        time: { type: 'string', description: 'Clock time such as 9am or 09:00 in the home timezone.' },
        home: { type: 'string', description: 'IANA timezone of the recurring clock, such as America/Los_Angeles.' },
        occurrences: { type: 'integer', description: 'How many weeks to score before adding a DST week. Default 4. Max 8.' },
        now: { type: 'string', description: 'Optional ISO instant used as "today" when choosing the next weekday. Defaults to the current time.' },
        durationMinutes: { type: 'integer', description: 'Optional. Only 30, 45, or 60 are written onto the planner link.' },
        workStart: { type: 'integer', description: 'First in-hours local hour. Default 9.' },
        workEnd: { type: 'integer', description: 'Last in-hours local hour, inclusive. Default 18.' }
      },
      additionalProperties: false
    },
    buildRequest(args) {
      ensureRequired(args, ['weekday', 'time', 'home'], 'rank_recurring_slot requires weekday, time, and home.');
      requireMeetingLocations(args, 'rank_recurring_slot');
      const params = new URLSearchParams();
      setParam(params, 'locations', args.locations, { joinArraysWith: '|' });
      setParam(params, 'countryCodes', args.countryCodes, { joinArraysWith: '|' });
      setParam(params, 'weekday', args.weekday);
      setParam(params, 'time', args.time);
      setParam(params, 'home', args.home);
      setParam(params, 'occurrences', args.occurrences);
      setParam(params, 'now', args.now);
      setParam(params, 'durationMinutes', args.durationMinutes);
      setParam(params, 'workStart', args.workStart);
      setParam(params, 'workEnd', args.workEnd);
      return { path: '/meeting/recurring', params };
    }
  },
  {
    name: 'search_timezones',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: 'Disambiguate a city, country, abbreviation, or timezone before calling other tools. Use this when a lookup is unknown or ambiguous, then retry get_current_time, convert_time, or find_meeting_time with candidate.suggestedQuery, candidate.suggestedId, or countryCode. This does not return the current time.',
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
          description: 'Optional ISO country hint used for ranking and disambiguation. This is not a strict filter.'
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 25,
          description: 'Maximum number of search results to return.'
        },
        candidateLimit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Page size for namesake candidates. Default 6. Follow moreCandidates.resolve or moreCandidates.search for the rest.'
        },
        candidateOffset: {
          type: 'integer',
          minimum: 0,
          description: 'Skip this many namesake candidates. Copy from moreCandidates.candidateOffset.'
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
      setParam(params, 'candidateLimit', args.candidateLimit);
      setParam(params, 'candidateOffset', args.candidateOffset);
      return { path: '/locations/search', params };
    }
  },
  {
    name: 'get_location_by_id',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: 'Hydrate an exact production location record by stable findtime id returned from search_timezones. Do not invent ids. If search_timezones has not been called, call it first.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: {
          type: 'string',
          description: 'Stable location id. Current records use findtime:slug|CC|geonameId-or-state|TZ. Older findtime:slug|CC|TZ ids still resolve to the original city.'
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
for (const tool of TOOL_DEFINITIONS) {
  addEndUserIdSchemaProperty(tool);
}
let cachedResolveLocation;

function getMcpToolMode() {
  const mode = String(firstNonEmpty(
    process.env.FINDTIME_MCP_TOOL_MODE,
    process.env.FINDTIME_MCP_TOOLS
  ) || 'full').trim().toLowerCase();

  return ['answer-only', 'answer_only', 'answer'].includes(mode)
    ? 'answer-only'
    : 'full';
}

function getVisibleToolDefinitions() {
  if (getMcpToolMode() !== 'answer-only') {
    return TOOL_DEFINITIONS;
  }

  return TOOL_DEFINITIONS.filter((tool) => ANSWER_ONLY_TOOL_NAMES.has(tool.name));
}

function loadHelpCatalog() {
  const candidatePaths = [
    path.join(PACKAGE_ROOT, 'help-catalog.cjs'),
    path.join(REPO_ROOT, 'src', 'shared', 'findtimeHelpCatalog.cjs')
  ];
  for (const catalogPath of candidatePaths) {
    try {
      return require(catalogPath);
    } catch (_error) {
      // Try the next candidate. Published MCP packages use PACKAGE_ROOT.
    }
  }
  return {
    buildHelpPayload: () => ({
      version: 'answer-help.v1',
      surface: 'mcp',
      title: 'findtime.io Time Help',
      summary: 'Use findtime.io MCP for accurate timezone, DST, conversion, overlap-hours, and cross-timezone meeting-time intelligence.',
      suggestions: [
        'What time is it now in Tokyo?',
        'What timezone is Auckland in?',
        'If it is 3:30pm in London, what time is it in Sydney?',
        'What working hours overlap for San Francisco, Berlin, and Tokyo?',
        'Find a good meeting time for San Francisco, Berlin, and Sydney.'
      ],
      intents: [],
      ambiguityExamples: [],
      failurePolicy: []
    })
  };
}

function buildFindtimeHelpPayload() {
  const help = loadHelpCatalog().buildHelpPayload({ surface: 'mcp', includeAllIntents: true });
  return {
    ...help,
    ok: true,
    tool: 'get_findtime_help',
    recommendedTool: 'answer_time_question',
    recommendedMode: 'FINDTIME_MCP_TOOL_MODE=answer-only',
    summary: `${help.summary} In enterprise bots, route natural-language questions through answer_time_question.`,
    install: {
      command: 'npx',
      args: ['-y', '@findtime/mcp-server'],
      requiredEnv: ['FINDTIME_TIME_API_KEY'],
      recommendedEnterpriseEnv: {
        FINDTIME_TIME_API_BASE_URL: 'https://time-api.findtime.io',
        FINDTIME_MCP_CLIENT_TYPE: 'company-bot',
        FINDTIME_MCP_TOOL_MODE: 'answer-only'
      }
    },
    answerApiPattern: {
      tool: 'answer_time_question',
      arguments: {
        query: 'Best meeting time for San Francisco, Berlin, and Sydney next week',
        userTimezone: 'America/Los_Angeles',
        locale: 'en-US'
      }
    }
  };
}

function formatFindtimeHelpText(help) {
  const lines = [
    'findtime.io Time Help',
    '',
    'Try asking:',
    ...help.intents.map((entry) => `- ${entry.example}`),
    '',
    'If a place or timezone is ambiguous, findtime.io will ask for clarification. For example:',
    ...help.ambiguityExamples.map((entry) => `- ${entry.query} -> ${entry.expectedBehavior}`),
  ];

  return lines.join('\n');
}

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

function truthyEnv(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isMcpUsageTelemetryEnabled() {
  const explicit = firstNonEmpty(
    process.env.FINDTIME_MCP_USAGE_TELEMETRY_ENABLED,
    process.env.FINDTIME_MCP_INSTRUMENTATION_ENABLED
  );
  const normalized = String(explicit || '').trim().toLowerCase();
  return !['false', '0', 'off', 'no'].includes(normalized);
}

let cachedMcpClientId = null;

function getMcpClientIdPath() {
  const explicitDir = firstNonEmpty(process.env.FINDTIME_MCP_STATE_DIR);
  if (explicitDir) {
    return path.join(explicitDir, 'mcp-client-id');
  }

  const xdgStateHome = firstNonEmpty(process.env.XDG_STATE_HOME);
  const baseDir = xdgStateHome
    ? path.join(xdgStateHome, 'findtime')
    : path.join(os.homedir(), '.findtime');
  return path.join(baseDir, 'mcp-client-id');
}

function getMcpClientId() {
  const explicit = firstNonEmpty(
    process.env.FINDTIME_MCP_CLIENT_ID,
    process.env.FINDTIME_MCP_INSTALL_ID
  );
  if (explicit) return explicit.slice(0, 128);

  if (cachedMcpClientId) return cachedMcpClientId;

  const idPath = getMcpClientIdPath();
  try {
    const existing = fs.readFileSync(idPath, 'utf8').trim();
    if (existing) {
      cachedMcpClientId = existing.slice(0, 128);
      return cachedMcpClientId;
    }
  } catch (_error) {
    // First run or unreadable state file. Generate below.
  }

  cachedMcpClientId = `mcp-${crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex')}`;

  try {
    fs.mkdirSync(path.dirname(idPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(idPath, `${cachedMcpClientId}\n`, { mode: 0o600 });
  } catch (_error) {
    // Telemetry remains best-effort; an unwritable home directory should not break MCP.
  }

  return cachedMcpClientId;
}

function getMcpClientType() {
  return firstNonEmpty(
    process.env.FINDTIME_MCP_CLIENT_TYPE,
    process.env.TIME_API_CLIENT_TYPE
  ) || 'stdio';
}

function getRuntimeLocale() {
  return firstNonEmpty(
    process.env.LC_ALL,
    process.env.LC_MESSAGES,
    process.env.LANG
  );
}

function getRuntimeTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch (_error) {
    return null;
  }
}

function getMcpQueryText(args = {}) {
  if (!args || typeof args !== 'object') return '';
  return firstNonEmpty(
    args.query,
    args.city,
    args.timezone,
    args.from,
    Array.isArray(args.locations) ? args.locations.join('|') : null
  ) || '';
}

function buildMcpUsageTelemetryEvent({ toolName, args = {}, result = null, error = null, latencyMs = 0 } = {}) {
  const queryText = getMcpQueryText(args);
  const status = error
    ? 'exception'
    : result && result.isError
      ? 'error'
      : 'ok';

  return {
    platform: 'mcp-server',
    route: String(toolName || 'unknown').slice(0, 80),
    status,
    source: getMcpClientType().slice(0, 80),
    textLength: Math.min(2000, queryText.length),
    userId: getMcpClientId(),
    appVersion: SERVER_VERSION,
    browser: 'mcp',
    browserVersion: MCP_INSTALL_MODE,
    os: `${os.platform()} ${os.release()}`.slice(0, 80),
    locale: getRuntimeLocale(),
    timezone: getRuntimeTimezone(),
    latencyMs: Math.max(0, Math.round(Number(latencyMs || 0)))
  };
}

function recordMcpUsageTelemetry(input) {
  if (!isMcpUsageTelemetryEnabled() || !MCP_USAGE_TELEMETRY_URL || typeof fetch !== 'function') {
    return;
  }

  const event = buildMcpUsageTelemetryEvent(input);
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timeout = controller
    ? setTimeout(() => controller.abort(), MCP_USAGE_TELEMETRY_TIMEOUT_MS)
    : null;

  return fetch(MCP_USAGE_TELEMETRY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
    signal: controller ? controller.signal : undefined
  }).catch((error) => {
    if (String(process.env.FINDTIME_MCP_DEBUG || '').trim().toLowerCase() === '1') {
      console.error('[findtime-mcp telemetry] failed:', error && error.message ? error.message : error);
    }
  }).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
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

function parseRetryAfterSeconds(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Number(text);
  const at = Date.parse(text);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

// send_feedback failures tell the calling agent the status, a reason code,
// whether to retry, and one sentence on what to do next.
function feedbackFailureResult(tool, response, status) {
  const res = response || {};
  const retryAfterSeconds = parseRetryAfterSeconds(res.retryAfter);
  let reason;
  let retryable;
  let nextStep;
  if (status === 401 || status === 403) {
    reason = 'auth_failed';
    retryable = false;
    nextStep = 'Do not retry: ask the user to set a valid FINDTIME_TIME_API_KEY, then call get_api_diagnostics to confirm apiAuthConfigured is true.';
  } else if (status === 429) {
    reason = 'rate_limited';
    retryable = true;
    nextStep = retryAfterSeconds !== null
      ? `Wait ${retryAfterSeconds} seconds, then call send_feedback again with the same arguments.`
      : 'Wait about a minute, then call send_feedback again with the same arguments.';
  } else if (status !== null && status >= 500) {
    reason = 'server_error';
    retryable = true;
    nextStep = retryAfterSeconds !== null
      ? `Wait ${retryAfterSeconds} seconds, then call send_feedback again; if it fails again, call get_api_diagnostics.`
      : 'Retry send_feedback once in a few seconds; if it fails again, call get_api_diagnostics.';
  } else if (status === null && res.timedOut) {
    reason = 'timeout';
    retryable = true;
    nextStep = 'Retry send_feedback once; if it times out again, call get_api_diagnostics to check apiReachable.';
  } else if (status === null) {
    reason = 'network_error';
    retryable = true;
    nextStep = 'Call get_api_diagnostics to check apiReachable and the API base URL, then retry send_feedback.';
  } else {
    reason = 'request_rejected';
    retryable = false;
    nextStep = 'Do not retry with the same arguments: check that tool names a findtime.io MCP tool, then call send_feedback again.';
  }
  const statusText = status !== null ? `HTTP ${status}` : (res.networkError || 'no response');
  const whatWentWrong = `The feedback was not sent: findtime.io did not accept it (${reason}, ${statusText}).`;
  const structuredContent = {
    ok: false,
    sent: false,
    recorded: false,
    errorClass: reason,
    reason,
    tool,
    status,
    retryable,
    ...(res.retryAfter ? { retryAfter: res.retryAfter } : {}),
    ...(retryAfterSeconds !== null ? { retryAfterSeconds } : {}),
    ...(status === null && res.networkError ? { networkError: res.networkError } : {}),
    whatWentWrong,
    nextStep,
    nextAction: {
      tool: reason === 'auth_failed' || reason === 'network_error' ? 'get_api_diagnostics' : 'send_feedback',
      hint: nextStep
    }
  };
  return {
    isError: true,
    content: [{
      type: 'text',
      text: `${whatWentWrong} Retryable: ${retryable ? 'yes' : 'no'}`
        + `${retryAfterSeconds !== null ? `, after ${retryAfterSeconds} seconds` : ''}. ${nextStep}`
    }],
    structuredContent
  };
}

function invalidParamsError(message) {
  const error = new Error(message);
  error.code = -32602;
  return error;
}

function addEndUserIdSchemaProperty(tool) {
  if (!tool || !tool.inputSchema || tool.inputSchema.type !== 'object') return;
  tool.inputSchema.properties = {
    ...(tool.inputSchema.properties || {}),
    [END_USER_ID_ARGUMENT]: END_USER_ID_SCHEMA
  };
}

function extractEndUserId(args = {}) {
  const cleanArgs = args && typeof args === 'object' && !Array.isArray(args)
    ? { ...args }
    : {};

  if (!Object.prototype.hasOwnProperty.call(cleanArgs, END_USER_ID_ARGUMENT)) {
    return { args: cleanArgs, endUserId: null };
  }

  const value = cleanArgs[END_USER_ID_ARGUMENT];
  delete cleanArgs[END_USER_ID_ARGUMENT];

  if (value === null || value === undefined || value === '') {
    return { args: cleanArgs, endUserId: null };
  }

  if (typeof value !== 'string') {
    throw invalidParamsError(`${END_USER_ID_ARGUMENT} must be a string when provided.`);
  }

  if (value.length > END_USER_ID_MAX_LENGTH) {
    throw invalidParamsError(`${END_USER_ID_ARGUMENT} must be ${END_USER_ID_MAX_LENGTH} characters or fewer.`);
  }

  if (/[\u0000-\u001F\u007F]/.test(value)) {
    throw invalidParamsError(`${END_USER_ID_ARGUMENT} must not contain control characters.`);
  }

  if (!value.trim()) {
    return { args: cleanArgs, endUserId: null };
  }

  return { args: cleanArgs, endUserId: value };
}

function scrubToolArgs(args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  const cleanArgs = { ...args };
  delete cleanArgs[END_USER_ID_ARGUMENT];
  return cleanArgs;
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
      try {
        messages.push(JSON.parse(bodyBuffer.toString('utf8')));
      } catch (_error) {
        // Drop malformed framed JSON instead of crashing the stdio loop.
      }
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

function buildToolErrorResult(toolName, apiResponse, options = {}) {
  return buildActionableErrorResult({
    toolName,
    args: options.args || {},
    apiResponse,
    extraCandidates: options.extraCandidates || [],
    hint: options.hint || null,
    thrownMessage: options.thrownMessage || ''
  });
}

// Saved groups live on the hosted connector (Google sign-in). An API key has no account to read them from.
const TEAM_STUB_MESSAGE = 'Saved groups need the hosted connector at https://mcp.findtime.io/mcp signed in with Google. Pass locations on each call.';
const LOCATION_HELP_TOOLS = new Set([
  'answer_time_question',
  'get_current_time',
  'convert_time',
  'get_dst_schedule',
  'get_overlap_hours',
  'find_meeting_time',
  'check_proposed_time',
  'are_they_awake',
  'rank_recurring_slot',
  'time_snapshot',
  'get_location_by_id'
]);

function nameNeedsLocationHelp(toolName) {
  return LOCATION_HELP_TOOLS.has(toolName);
}
const PASTE_TOOL_NAMES = new Set([
  'find_meeting_time',
  'check_proposed_time',
  'are_they_awake',
  'rank_recurring_slot'
]);

function presentLocationValue(value) {
  if (Array.isArray(value)) return value.some((item) => String(item || '').trim());
  return typeof value === 'string' && value.trim().length > 0;
}

// theirCities and theirCity belong to are_they_awake. The other meeting tools
// forward only locations, so only locations counts for them.
const AWAKE_LOCATION_ALIASES = ['theirCities', 'theirCity'];

function hasLocations(args, toolName) {
  if (!args) return false;
  if (presentLocationValue(args.locations)) return true;
  return toolName === 'are_they_awake'
    && AWAKE_LOCATION_ALIASES.some((key) => presentLocationValue(args[key]));
}

function misplacedLocationAliases(args, toolName) {
  if (!args || toolName === 'are_they_awake' || presentLocationValue(args.locations)) return [];
  return AWAKE_LOCATION_ALIASES.filter((key) => presentLocationValue(args[key]));
}

function requireMeetingLocations(args, toolName) {
  const misplaced = misplacedLocationAliases(args, toolName);
  if (misplaced.length) {
    throw invalidParamsError(`${toolName} takes locations, not ${misplaced.join(' or ')}. `
      + `${misplaced.join(' and ')} only work with are_they_awake. Pass the same cities as locations.`);
  }
  if (!hasLocations(args, toolName)) {
    throw invalidParamsError(`${toolName} requires locations.`);
  }
}

function teamStubResult(teamId, toolName) {
  const id = String(teamId || '').trim();
  const result = buildActionableErrorResult({
    toolName,
    args: id ? { teamId: id } : {},
    apiResponse: {
      parsedBody: {
        stub: true,
        error: 'teams_not_persisted',
        ...(id ? { teamId: id } : {}),
        message: TEAM_STUB_MESSAGE
      }
    }
  });
  result.content[0].text = TEAM_STUB_MESSAGE;
  result.structuredContent.message = TEAM_STUB_MESSAGE;
  result.structuredContent.stub = true;
  result.structuredContent.error = 'teams_not_persisted';
  if (id) result.structuredContent.teamId = id;
  return result;
}

function buildToolSuccessResult(toolName, payload, apiMeta, options = {}) {
  const structuredContent = {
    ...payload,
    _meta: {
      ...(payload && typeof payload === 'object' && payload._meta ? payload._meta : {}),
      endpoint: apiMeta.endpoint,
      url: apiMeta.url,
      ...(options.meta || {})
    }
  };
  const shareText = payload && typeof payload.shareText === 'string'
    ? payload.shareText.trim()
    : '';

  return {
    content: [
      {
        type: 'text',
        text: shareText || summarizeToolPayload(toolName, structuredContent)
      }
    ],
    structuredContent
  };
}

function loadResolveLocation() {
  if (cachedResolveLocation !== undefined) {
    return cachedResolveLocation;
  }

  try {
    const timezoneHelpers = require(TIMEZONE_HELPERS_PATH);
    cachedResolveLocation = typeof timezoneHelpers.resolveLocation === 'function'
      ? timezoneHelpers.resolveLocation
      : null;
  } catch (_error) {
    cachedResolveLocation = null;
  }

  return cachedResolveLocation;
}

function normalizeCountryCode(value) {
  return typeof value === 'string' && value.trim()
    ? value.trim().toUpperCase()
    : null;
}

function resolveCountryStyleInput(input, resolveLocationImpl) {
  if (typeof resolveLocationImpl !== 'function') {
    return null;
  }

  const resolved = resolveLocationImpl(String(input || '').trim());
  const resolutionType = String(resolved && resolved.type ? resolved.type : '');
  if (!resolved || !resolutionType.startsWith('country-')) {
    return null;
  }

  const city = firstNonEmpty(resolved.city);
  const timezone = firstNonEmpty(resolved.timezone);
  const countryCode = normalizeCountryCode(resolved.countryCode);

  if (!city && !timezone) {
    return null;
  }

  return {
    city,
    timezone,
    countryCode,
    resolutionType
  };
}

function buildCountryQueryHint(rawInput, resolvedCountry) {
  if (!rawInput || !resolvedCountry) {
    return null;
  }

  const suggestions = [];
  if (resolvedCountry.city) suggestions.push(resolvedCountry.city);
  if (resolvedCountry.timezone && !suggestions.includes(resolvedCountry.timezone)) {
    suggestions.push(resolvedCountry.timezone);
  }

  return {
    reason: 'country_query_not_supported',
    input: rawInput,
    suggest: suggestions,
    resolutionType: resolvedCountry.resolutionType,
    retriedWith: {
      city: resolvedCountry.city || null,
      countryCode: resolvedCountry.countryCode || null,
      timezone: resolvedCountry.timezone || null
    }
  };
}

function enrichLocationSearchPayload(payload, args) {
  if (!payload || typeof payload !== 'object') {
    return { payload, meta: null };
  }

  const hintedCountryCode = normalizeCountryCode(args && args.countryCode);
  if (!hintedCountryCode || !Array.isArray(payload.results)) {
    return { payload, meta: null };
  }

  const countryFilteredResults = payload.results.filter(
    (result) => normalizeCountryCode(result && result.countryCode) === hintedCountryCode
  );
  const primaryMatch = countryFilteredResults[0] || null;

  return {
    payload: {
      ...payload,
      primaryMatch,
      countryFilteredResults
    },
    meta: {
      countryCodeBehavior: 'ranking_hint',
      countryHint: hintedCountryCode,
      countryFilteredCount: countryFilteredResults.length
    }
  };
}

function createFindtimeMcpServer(options = {}) {
  const fetchImpl = options.fetchImpl || global.fetch;
  const apiBaseUrl = options.apiBaseUrl || DEFAULT_API_BASE_URL;
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const apiKey = options.apiKey === undefined ? DEFAULT_API_KEY : options.apiKey;
  const bindingType = options.bindingType === undefined ? DEFAULT_BINDING_TYPE : options.bindingType;
  const bindingValue = options.bindingValue === undefined ? DEFAULT_BINDING_VALUE : options.bindingValue;
  const bindingHeader = options.bindingHeader === undefined ? DEFAULT_BINDING_HEADER : options.bindingHeader;
  const serverName = options.serverName || 'findtime';
  const serverTitle = options.serverTitle || 'findtime Time API MCP';
  const resolveLocationImpl = options.resolveLocationImpl === undefined
    ? loadResolveLocation()
    : options.resolveLocationImpl;

  if (typeof fetchImpl !== 'function') {
    throw new Error('Fetch implementation is required to run the MCP server.');
  }

  const state = {
    initialized: false,
    protocolVersion: DEFAULT_PROTOCOL_VERSION
  };

  async function fetchJson(toolName, request, metadata = {}) {
    const url = new URL(request.path, apiBaseUrl);
    if (request.params && request.params.size > 0) {
      url.search = request.params.toString();
    }

    const method = request.method || 'GET';
    const headers = {
      Accept: 'application/json',
      'User-Agent': `findtime-mcp/${SERVER_VERSION}`,
      'X-Findtime-MCP-Tool': toolName,
      ...(request.headers || {})
    };

    if (typeof apiKey === 'string' && apiKey.trim()) {
      headers.Authorization = `Bearer ${apiKey.trim()}`;
    }

    const clientUserId = getMcpClientId();
    if (typeof clientUserId === 'string' && clientUserId.trim()) {
      headers['X-Findtime-User-ID'] = clientUserId.trim();
    }

    const resolvedBindingHeader = typeof bindingHeader === 'string' && bindingHeader.trim()
      ? bindingHeader.trim()
      : normalizeBindingHeader(bindingType);
    if (resolvedBindingHeader && typeof bindingValue === 'string' && bindingValue.trim()) {
      headers[resolvedBindingHeader] = bindingValue.trim();
    }

    if (typeof metadata.endUserId === 'string' && metadata.endUserId) {
      headers[END_USER_ID_HEADER] = metadata.endUserId;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const init = {
        method,
        headers,
        signal: controller.signal
      };
      if (request.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(request.body);
      }
      const response = await fetchImpl(url.toString(), init);

      const rawBody = await response.text();
      const parsedBody = tryParseJson(rawBody);

      if (!response.ok) {
        const retryAfter = response.headers && typeof response.headers.get === 'function'
          ? response.headers.get('retry-after')
          : null;
        return {
          ok: false,
          status: response.status,
          url: url.toString(),
          rawBody,
          parsedBody,
          ...(retryAfter ? { retryAfter: String(retryAfter) } : {})
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
        timedOut: Boolean(error && error.name === 'AbortError'),
        networkError: error && error.name === 'AbortError'
          ? `Request timed out after ${timeoutMs}ms`
          : String(error && error.message ? error.message : error)
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function fetchLatestMcpVersion() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetchImpl(MCP_NPM_REGISTRY_LATEST_URL, {
        method: 'GET',
        headers: {
          Accept: 'application/json'
        },
        signal: controller.signal
      });

      const rawBody = await response.text();
      const parsedBody = tryParseJson(rawBody);

      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          latestVersion: null
        };
      }

      const latestVersion = parsedBody && typeof parsedBody.version === 'string'
        ? parsedBody.version.trim()
        : '';

      if (!latestVersion) {
        return {
          ok: false,
          status: response.status,
          latestVersion: null
        };
      }

      return {
        ok: true,
        status: response.status,
        latestVersion
      };
    } catch (error) {
      return {
        ok: false,
        status: null,
        latestVersion: null,
        networkError: error && error.name === 'AbortError'
          ? `Request timed out after ${timeoutMs}ms`
          : String(error && error.message ? error.message : error)
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function lookupSearchCandidates(query, requestMetadata) {
    const searchQuery = firstNonEmpty(query);
    if (!searchQuery) return [];
    const params = new URLSearchParams();
    params.set('query', searchQuery);
    params.set('limit', '3');
    const searchResponse = await fetchJson('search_timezones', {
      path: '/locations/search',
      params
    }, requestMetadata);
    const results = searchResponse.ok && searchResponse.parsedBody && Array.isArray(searchResponse.parsedBody.results)
      ? searchResponse.parsedBody.results
      : [];
    return results.slice(0, 3);
  }

  async function toActionableApiError(toolName, toolArgs, apiResponse, extra = {}) {
    let extraCandidates = extra.extraCandidates || [];
    const parsed = apiResponse.parsedBody && typeof apiResponse.parsedBody === 'object'
      ? apiResponse.parsedBody
      : {};
    const needsCandidates = parsed.notFound === true
      || parsed.ambiguous === true
      || apiResponse.status === 404;
    if (needsCandidates && !extraCandidates.length && nameNeedsLocationHelp(toolName)) {
      extraCandidates = await lookupSearchCandidates(
        firstNonEmpty(toolArgs.query, toolArgs.city, toolArgs.from, parsed.query),
        extra.requestMetadata || {}
      );
    }
    return buildToolErrorResult(toolName, apiResponse, {
      args: toolArgs,
      extraCandidates,
      hint: extra.hint || null
    });
  }

  async function callTool(name, args = {}) {
    const tool = TOOL_DEFINITIONS_BY_NAME.get(name);
    if (!tool || (getMcpToolMode() === 'answer-only' && !ANSWER_ONLY_TOOL_NAMES.has(name))) {
      return buildActionableErrorResult({
        toolName: name,
        args,
        thrownMessage: `Unknown tool: ${name}`
      });
    }

    const extracted = extractEndUserId(args || {});
    const toolArgs = extracted.args;
    const requestMetadata = {
      endUserId: extracted.endUserId,
      endUserIdPresent: Boolean(extracted.endUserId)
    };

    if (PASTE_TOOL_NAMES.has(name) && String(toolArgs.teamId || '').trim()) {
      // Misplaced aliases fall through to the tool's own error, not the saved-group answer.
      if (hasLocations(toolArgs, name) || misplacedLocationAliases(toolArgs, name).length) {
        delete toolArgs.teamId;
      } else {
        return teamStubResult(toolArgs.teamId, name);
      }
    }

    if (name === 'get_findtime_help') {
      const help = buildFindtimeHelpPayload();
      return {
        content: [
          {
            type: 'text',
            text: formatFindtimeHelpText(help)
          }
        ],
        structuredContent: help
      };
    }

    if (name === 'send_feedback') {
      try {
        ensureRequired(toolArgs, ['tool', 'query', 'whatWasWrong'], 'send_feedback requires tool, query, and whatWasWrong.');
      } catch (error) {
        return buildActionableErrorResult({
          toolName: name,
          args: toolArgs,
          thrownMessage: error.message,
          apiResponse: { status: 400 }
        });
      }
      const tool = String(toolArgs.tool || '').trim();
      const sentBody = { tool };
      // Only the tool name leaves this process.
      const feedbackResponse = await fetchJson(name, {
        method: 'POST',
        path: '/mcp/feedback',
        params: new URLSearchParams(),
        body: sentBody
      }, requestMetadata).catch((error) => ({
        ok: false,
        status: null,
        networkError: String(error && error.message ? error.message : error)
      }));
      const status = Number.isInteger(feedbackResponse && feedbackResponse.status) ? feedbackResponse.status : null;
      // Only a 2xx from findtime.io counts as sent.
      if (feedbackResponse && feedbackResponse.ok && status !== null && status >= 200 && status < 300) {
        const message = `findtime.io received the feedback (HTTP ${status}). Sent exactly ${JSON.stringify(sentBody)}; `
          + 'the query, whatWasWrong and expectedAnswer stayed local and were not sent.';
        return {
          content: [{ type: 'text', text: message }],
          structuredContent: {
            ok: true,
            sent: true,
            recorded: true,
            errorClass: 'agent_feedback',
            status,
            tool,
            sentBody,
            message
          }
        };
      }
      return feedbackFailureResult(tool, feedbackResponse, status);
    }

    if (name === 'get_api_diagnostics') {
      const request = tool.buildRequest(toolArgs);
      const [apiResponse, latestMcpVersionCheck] = await Promise.all([
        fetchJson(name, request, requestMetadata),
        fetchLatestMcpVersion()
      ]);
      const checkedAt = new Date().toISOString();
      const latestVersion = latestMcpVersionCheck.latestVersion || null;
      const diagnostics = {
        ok: apiResponse.ok,
        tool: name,
        checkedAt,
        mcpVersion: SERVER_VERSION,
        mcpLatestVersion: latestVersion,
        mcpUpToDate: latestVersion ? latestVersion === SERVER_VERSION : null,
        mcpLatestVersionCheck: latestVersion ? 'ok' : 'failed',
        mcpLatestVersionSource: latestVersion ? 'npm' : 'unavailable',
        mcpLatestVersionHint: latestVersion
          ? null
          : 'Could not verify the latest published MCP version automatically. Check the npm package page or Official MCP Registry listing directly.',
        mcpInstallMode: MCP_INSTALL_MODE,
        mcpExecutablePath: path.join(PACKAGE_ROOT, 'server.js'),
        mcpRegistryUrl: MCP_REGISTRY_URL,
        mcpNpmUrl: MCP_NPM_URL,
        apiBaseUrl,
        apiConfigured: Boolean(apiBaseUrl),
        apiAuthConfigured: Boolean(typeof apiKey === 'string' && apiKey.trim()),
        clientType: firstNonEmpty(
          process.env.FINDTIME_MCP_CLIENT_TYPE,
          process.env.TIME_API_CLIENT_TYPE
        ) || null,
        apiHealthUrl: apiResponse.url,
        apiStatus: apiResponse.status,
        apiReachable: apiResponse.ok
      };

      if (apiResponse.ok) {
        diagnostics.apiHealth = apiResponse.parsedBody;
      } else {
        diagnostics.error = apiResponse.parsedBody !== undefined ? apiResponse.parsedBody : apiResponse.rawBody;
        if (apiResponse.networkError) {
          diagnostics.networkError = apiResponse.networkError;
        }
      }

      if (!latestVersion && latestMcpVersionCheck.networkError) {
        diagnostics.mcpLatestVersionNetworkError = latestMcpVersionCheck.networkError;
      }

      return buildToolSuccessResult(name, diagnostics, {
        endpoint: request.path,
        url: apiResponse.url
      });
    }

    let request;
    try {
      request = tool.buildRequest(toolArgs);
    } catch (error) {
      if (error && error.code === -32602) {
        return buildActionableErrorResult({
          toolName: name,
          args: toolArgs,
          thrownMessage: error.message,
          apiResponse: { status: 400 }
        });
      }
      throw error;
    }
    let apiResponse = await fetchJson(name, request, requestMetadata);

    if (!apiResponse.ok) {
      if (name === 'get_current_time' && apiResponse.status === 404) {
        const rawCountryQuery = firstNonEmpty(toolArgs.query, toolArgs.city);
        const resolvedCountry = resolveCountryStyleInput(rawCountryQuery, resolveLocationImpl);

        if (resolvedCountry && resolvedCountry.city) {
          const retryRequest = tool.buildRequest({
            city: resolvedCountry.city,
            countryCode: resolvedCountry.countryCode || undefined
          });
          const retryResponse = await fetchJson(name, retryRequest, requestMetadata);

          if (retryResponse.ok) {
            return buildToolSuccessResult(name, enrichResolvedPayload(name, retryResponse.parsedBody, toolArgs), {
              endpoint: retryRequest.path,
              url: retryResponse.url
            }, {
              meta: {
                fallbackResolution: {
                  input: rawCountryQuery,
                  strategy: resolvedCountry.resolutionType,
                  retriedWith: {
                    city: resolvedCountry.city,
                    countryCode: resolvedCountry.countryCode || null
                  }
                }
              }
            });
          }

          return toActionableApiError(name, toolArgs, retryResponse, {
            hint: buildCountryQueryHint(rawCountryQuery, resolvedCountry),
            requestMetadata
          });
        }
      }

      return toActionableApiError(name, toolArgs, apiResponse, { requestMetadata });
    }

    let payload = apiResponse.parsedBody;
    let meta = null;

    if (name === 'search_timezones') {
      const enriched = enrichLocationSearchPayload(payload, toolArgs);
      payload = enriched.payload;
      meta = enriched.meta;
    }

    payload = enrichResolvedPayload(name, payload, toolArgs);

    return buildToolSuccessResult(name, payload, {
      endpoint: request.path,
      url: apiResponse.url
    }, {
      meta
    });
  }

  function scheduleTracking(task) {
    const pending = Promise.resolve().then(task).catch(() => {});
    try {
      if (typeof options.scheduleTracking === 'function') options.scheduleTracking(pending);
    } catch (_error) {}
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
          tools: getVisibleToolDefinitions().map(({ name, description, inputSchema, outputSchema, annotations }) => ({
            name,
            description,
            inputSchema,
            ...(outputSchema ? { outputSchema } : {}),
            annotations
          }))
        });
      }

      if (method === 'tools/call') {
        const toolName = message.params && message.params.name;
        const toolArgs = (message.params && message.params.arguments) || {};
        const startedAt = Date.now();
        try {
          const result = await callTool(toolName, toolArgs);
          scheduleTracking(() => recordMcpUsageTelemetry({
            toolName,
            args: scrubToolArgs(toolArgs),
            result,
            latencyMs: Date.now() - startedAt
          }));
          return createSuccessResponse(message.id, result);
        } catch (toolError) {
          scheduleTracking(() => recordMcpUsageTelemetry({
            toolName,
            args: scrubToolArgs(toolArgs),
            error: toolError,
            latencyMs: Date.now() - startedAt
          }));
          throw toolError;
        }
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

function normalizeBindingHeader(bindingType) {
  const normalized = String(bindingType || '').trim().toLowerCase();
  if (normalized === 'slack_team') return 'X-Slack-Team-ID';
  if (normalized === 'workspace_id') return 'X-Findtime-Workspace-ID';
  if (normalized === 'install_id') return 'X-Findtime-Install-ID';
  return '';
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

function determineInstallMode({ packageRoot, localPackageMetadata, repoPackageMetadata }) {
  if (repoPackageMetadata && repoPackageMetadata.name === 'world-time-ai') {
    return 'repo_checkout';
  }

  if (localPackageMetadata && localPackageMetadata.name === '@findtime/mcp-server') {
    return 'npm_package';
  }

  if (typeof packageRoot === 'string' && packageRoot.includes(`${path.sep}world-time-ai${path.sep}services${path.sep}mcp-server`)) {
    return 'repo_checkout';
  }

  return 'package_install';
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
