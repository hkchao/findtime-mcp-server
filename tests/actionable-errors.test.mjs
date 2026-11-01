import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  buildActionableErrorResult,
  classifyToolFailure,
  enrichResolvedPayload,
  extractCandidates
} = require('../actionable-errors.cjs');

test('unknown city errors list top candidates and suggest search_timezones', () => {
  const result = buildActionableErrorResult({
    toolName: 'get_current_time',
    args: { query: 'Springfeld' },
    apiResponse: {
      status: 404,
      url: 'https://time-api.findtime.io/time/current?query=Springfeld',
      parsedBody: { notFound: true, query: 'Springfeld' }
    },
    extraCandidates: [
      { name: 'Springfield', countryName: 'United States', timezoneIana: 'America/Chicago', id: 'a' },
      { name: 'Springfield', countryName: 'United States', timezoneIana: 'America/New_York', id: 'b' },
      { name: 'Springfield', countryName: 'Australia', timezoneIana: 'Australia/Sydney', id: 'c' },
      { name: 'Springfield', countryName: 'Canada', timezoneIana: 'America/Toronto', id: 'd' }
    ]
  });

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.errorClass, 'unresolved_location');
  assert.equal(result.structuredContent.candidates.length, 4);
  assert.equal(result.structuredContent.nextAction.tool, 'search_timezones');
  assert.match(result.content[0].text, /could not resolve/i);
  assert.match(result.content[0].text, /Springfield, United States/);
  assert.match(result.content[0].text, /search_timezones/);
});

test('ambiguous city errors keep three candidates and tell the agent not to guess', () => {
  const result = buildActionableErrorResult({
    toolName: 'convert_time',
    args: { from: 'Paris', to: 'London', time: '3pm' },
    apiResponse: {
      status: 200,
      parsedBody: {
        ambiguous: true,
        query: 'Paris',
        candidates: [
          { name: 'Paris', countryName: 'France', timezoneIana: 'Europe/Paris', suggestedQuery: 'Paris, France' },
          { name: 'Paris', countryName: 'United States', timezoneIana: 'America/Chicago', suggestedQuery: 'Paris, United States' },
          { name: 'Paris', countryName: 'Canada', timezoneIana: 'America/Toronto', suggestedQuery: 'Paris, Canada' }
        ]
      }
    }
  });
  assert.equal(result.structuredContent.errorClass, 'ambiguous_location');
  assert.equal(result.structuredContent.candidates.length, 3);
  assert.match(result.structuredContent.why, /will not guess/i);
  assert.equal(result.structuredContent.nextAction.tool, 'search_timezones');
});

test('missing convert_time fields tell the agent what to pass or to use answer_time_question', () => {
  const result = buildActionableErrorResult({
    toolName: 'convert_time',
    args: { from: 'Tokyo' },
    thrownMessage: 'convert_time requires from, to, and time.',
    apiResponse: { status: 400 }
  });
  assert.equal(result.structuredContent.errorClass, 'invalid_params');
  assert.match(result.structuredContent.whatWentWrong, /requires from, to, and time/);
  assert.match(result.structuredContent.nextAction.hint, /answer_time_question/);
});

test('auth and network failures point at get_api_diagnostics', () => {
  const auth = buildActionableErrorResult({
    toolName: 'answer_time_question',
    args: { query: 'time in Tokyo' },
    apiResponse: { status: 401, parsedBody: { error: 'Invalid or missing API key' } }
  });
  assert.equal(auth.structuredContent.errorClass, 'auth_failed');
  assert.equal(auth.structuredContent.nextAction.tool, 'get_api_diagnostics');

  const network = buildActionableErrorResult({
    toolName: 'get_current_time',
    args: { query: 'Tokyo' },
    apiResponse: { status: null, networkError: 'Request timed out after 15000ms' }
  });
  assert.equal(network.structuredContent.errorClass, 'time_api_unavailable');
  assert.equal(network.structuredContent.nextAction.tool, 'get_api_diagnostics');
});

test('team stub and unknown tool errors say what to call instead', () => {
  const teams = buildActionableErrorResult({
    toolName: 'save_team',
    args: { teamId: 'standup' },
    apiResponse: {
      parsedBody: {
        error: 'teams_not_persisted',
        stub: true,
        message: 'No-auth MCP does not store teams.'
      }
    }
  });
  assert.equal(teams.structuredContent.errorClass, 'teams_not_persisted');
  assert.match(teams.structuredContent.nextAction.hint, /Pass locations/);

  const unknown = buildActionableErrorResult({
    toolName: 'not_a_tool',
    thrownMessage: 'Unknown tool: not_a_tool'
  });
  assert.equal(unknown.structuredContent.errorClass, 'unknown_tool');
  assert.equal(unknown.structuredContent.nextAction.tool, 'get_findtime_help');
});

test('ambiguous 200 payloads are enriched without inventing extra candidates', () => {
  const enriched = enrichResolvedPayload('search_timezones', {
    resolved: false,
    ambiguous: true,
    query: 'Victoria',
    candidates: [
      { name: 'Victoria', countryName: 'Canada', timezoneIana: 'America/Vancouver', suggestedQuery: 'Victoria, Canada' },
      { name: 'Victoria', countryName: 'Australia', timezoneIana: 'Australia/Melbourne', suggestedQuery: 'Victoria, Australia' }
    ]
  }, { query: 'Victoria' });
  assert.equal(enriched.errorClass, 'ambiguous_location');
  assert.equal(enriched.nextAction.tool, 'search_timezones');
  assert.equal(extractCandidates(enriched).length, 2);
  assert.equal(classifyToolFailure({
    payload: enriched,
    apiResponse: { status: 200, parsedBody: enriched }
  }), 'ambiguous_location');
});

test('ambiguous abbreviation candidates keep the countries and cities each zone group covers', () => {
  const phoenix = {
    type: 'timezone',
    iana: 'America/Phoenix',
    abbreviation: 'MST',
    label: 'Mountain Standard Time',
    countries: ['CA', 'US'],
    equivalentZones: 5,
    places: 'Phoenix (US), also Vancouver, Surrey (CA)',
    suggestedId: 'America/Phoenix',
    suggestedQuery: 'America/Phoenix'
  };
  const denver = {
    type: 'timezone',
    iana: 'America/Denver',
    abbreviation: 'MST',
    label: 'Mountain Standard Time',
    countries: ['MX', 'US'],
    equivalentZones: 4,
    places: 'Denver (US), also Ciudad Juárez, Ascensión (MX)',
    suggestedId: 'America/Denver',
    suggestedQuery: 'America/Denver'
  };
  const enriched = enrichResolvedPayload('search_timezones', {
    resolved: false,
    ambiguous: true,
    query: 'MST',
    candidates: [denver, phoenix]
  }, { query: 'MST' });

  const kept = extractCandidates(enriched).find((candidate) => candidate.timezoneIana === 'America/Phoenix');
  assert.deepEqual(kept.countries, ['CA', 'US']);
  assert.equal(kept.equivalentZones, 5);
  assert.match(kept.places, /Vancouver, Surrey \(CA\)/);

  const result = buildActionableErrorResult({
    toolName: 'get_current_time',
    args: { query: 'MST' },
    apiResponse: { status: 200, parsedBody: { ambiguous: true, query: 'MST', candidates: [denver, phoenix] } }
  });
  assert.match(result.content[0].text, /America\/Phoenix \(America\/Phoenix\) - Mountain Standard Time: Phoenix \(US\), also Vancouver/);
});

test('city candidates without group fields keep their old shape', () => {
  const [candidate] = extractCandidates({
    candidates: [{ name: 'Victoria', countryName: 'Canada', timezoneIana: 'America/Vancouver', suggestedQuery: 'Victoria, Canada' }]
  });
  assert.deepEqual(Object.keys(candidate).sort(), ['countryName', 'label', 'name', 'suggestedId', 'suggestedQuery', 'timezoneIana']);
});
