'use strict';

const SEARCH_TOOL = 'search_timezones';
const DIAGNOSTICS_TOOL = 'get_api_diagnostics';
const ANSWER_TOOL = 'answer_time_question';

function compactText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function formatCandidate(item) {
  if (!item || typeof item !== 'object') return null;
  const name = compactText(item.name || item.city || item.label || item.iana);
  const countryName = compactText(item.countryName || item.country);
  const timezoneIana = compactText(item.timezoneIana || item.iana);
  const label = compactText(item.label);
  const suggestedQuery = compactText(item.suggestedQuery)
    || (name && (item.admin1 || item.stateCode) ? `${item.name}, ${item.admin1 || item.stateCode}` : '')
    || (name && countryName ? `${name}, ${countryName}` : name || timezoneIana);
  const suggestedId = compactText(item.suggestedId || item.id || item.iana);
  if (!suggestedQuery && !suggestedId) return null;
  // A timezone candidate stands for a group of equivalent zones: say which
  // countries and cities it covers ("Phoenix (US), also Vancouver, Surrey (CA)").
  const countries = Array.isArray(item.countries)
    ? item.countries.map((code) => compactText(code)).filter(Boolean)
    : [];
  const places = compactText(item.places);
  return {
    name: name || suggestedQuery,
    label: label || null,
    countryName: countryName || null,
    timezoneIana: timezoneIana || null,
    suggestedQuery: suggestedQuery || null,
    suggestedId: suggestedId || null,
    ...(places ? { places } : {}),
    ...(countries.length ? { countries } : {}),
    ...(Number.isFinite(item.equivalentZones) ? { equivalentZones: item.equivalentZones } : {})
  };
}

function extractCandidates(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const nested = payload.error && typeof payload.error === 'object' ? payload.error : {};
  const clarification = payload.clarification && typeof payload.clarification === 'object'
    ? payload.clarification
    : {};
  const list = payload.candidates
    || nested.candidates
    || clarification.candidates
    || payload.results
    || nested.results
    || [];
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const candidates = [];
  for (const item of list) {
    const formatted = formatCandidate(item);
    if (!formatted) continue;
    const key = formatted.suggestedId || formatted.suggestedQuery;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(formatted);
    if (candidates.length === 6) break;
  }
  return candidates;
}

function extractLocationQuery(args = {}, payload = {}) {
  return compactText(
    payload.query
    || payload.input
    || args.query
    || args.city
    || args.timezone
    || args.from
    || args.id
    || (Array.isArray(args.locations) ? args.locations.join(', ') : args.locations)
  );
}

function searchNextAction(query, candidates) {
  const argumentsPayload = { query: query || '' };
  if (candidates[0]?.countryName) {
    argumentsPayload.hint = 'Add countryCode or retry with candidate.suggestedQuery.';
  }
  return {
    tool: SEARCH_TOOL,
    arguments: { query: query || '' },
    hint: candidates.length
      ? `Pick one of the top ${candidates.length} candidates and retry with suggestedQuery or countryCode. Do not guess.`
      : `Call ${SEARCH_TOOL} for canonical matches, then retry with a candidate suggestedQuery, IANA zone, or countryCode.`
  };
}

function classifyToolFailure({ toolName, args = {}, apiResponse = {}, payload = {}, thrownMessage = '' } = {}) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const status = apiResponse.status;
  const message = compactText(thrownMessage || body.message || body.error);

  if (apiResponse.networkError || /unavailable|timed out|network/i.test(message)) {
    return 'time_api_unavailable';
  }
  if (status === 401 || status === 403 || /api key/i.test(message)) {
    return 'auth_failed';
  }
  if (body.error === 'teams_not_persisted' || body.stub === true) {
    return 'teams_not_persisted';
  }
  if (body.ambiguous === true || body.needsClarification === true || body.status === 'ambiguous_location') {
    return 'ambiguous_location';
  }
  if (body.notFound === true || body.status === 'unresolved_location' || status === 404) {
    return body.error === 'unknown tool' ? 'unknown_tool' : 'unresolved_location';
  }
  if (body.error === 'unknown tool' || /^unknown tool:/i.test(message)) {
    return 'unknown_tool';
  }
  if (body.confidence === 'low') {
    return 'low_confidence';
  }
  if (status === 400 || /requires |must be |missing /i.test(message)) {
    return 'invalid_params';
  }
  if (toolName === 'get_location_by_id' && status >= 400) {
    return 'unresolved_location';
  }
  if (status >= 500) {
    return 'time_api_unavailable';
  }
  if (status >= 400) {
    return 'failed_call';
  }
  if (message) return 'failed_call';
  return null;
}

function explainFailure(errorClass, { toolName, query, candidates, message } = {}) {
  switch (errorClass) {
    case 'ambiguous_location':
      return {
        whatWentWrong: `The place or timezone ${query ? `"${query}"` : 'in this request'} matches more than one location.`,
        why: 'findtime.io will not guess between close city or abbreviation matches.',
        nextAction: searchNextAction(query, candidates)
      };
    case 'unresolved_location':
      return {
        whatWentWrong: `findtime.io could not resolve ${query ? `"${query}"` : 'the requested place or timezone'}.`,
        why: 'The name is unknown, too vague, or needs a country or IANA qualifier.',
        nextAction: searchNextAction(query, candidates)
      };
    case 'low_confidence':
      return {
        whatWentWrong: 'The match is low-confidence and should not be treated as authoritative.',
        why: 'Several interpretations remain plausible.',
        nextAction: searchNextAction(query, candidates)
      };
    case 'invalid_params':
      return {
        whatWentWrong: message || `${toolName} is missing required arguments.`,
        why: 'Structured tools need explicit fields; messy natural language belongs on answer_time_question.',
        nextAction: {
          tool: toolName === ANSWER_TOOL ? ANSWER_TOOL : (toolName || ANSWER_TOOL),
          arguments: toolName === ANSWER_TOOL ? { query: query || '' } : undefined,
          hint: toolName && toolName !== ANSWER_TOOL
            ? `Supply the documented fields for ${toolName}, or call ${ANSWER_TOOL} with the raw user prompt.`
            : `Call ${ANSWER_TOOL} with the raw user prompt.`
        }
      };
    case 'time_api_unavailable':
      return {
        whatWentWrong: message || 'The findtime Time API did not respond.',
        why: 'The MCP server could not reach time-api.findtime.io, or the request timed out.',
        nextAction: {
          tool: DIAGNOSTICS_TOOL,
          arguments: {},
          hint: 'Call get_api_diagnostics and check apiReachable, apiStatus, apiAuthConfigured, and mcpInstallMode before retrying.'
        }
      };
    case 'auth_failed':
      return {
        whatWentWrong: 'The Time API rejected this MCP request as unauthorized.',
        why: 'FINDTIME_TIME_API_KEY is missing, inactive, or not sent as a bearer token.',
        nextAction: {
          tool: DIAGNOSTICS_TOOL,
          arguments: {},
          hint: 'Call get_api_diagnostics and confirm apiAuthConfigured is true, then set FINDTIME_TIME_API_KEY from https://findtime.io/developers/keys/.'
        }
      };
    case 'teams_not_persisted':
      return {
        whatWentWrong: 'Saved groups are not available on this unauthenticated MCP session.',
        why: 'teamId maps to homepage Saved groups only on the signed-in hosted connector.',
        nextAction: {
          tool: 'find_meeting_time',
          arguments: { locations: ['City A', 'City B'] },
          hint: 'Pass locations (or theirCities) on this call instead of teamId. Hosted signed-in agents can keep using teamId.'
        }
      };
    case 'unknown_tool':
      return {
        whatWentWrong: message || 'That MCP tool is not available on this server.',
        why: 'The tool name is unknown or disabled by FINDTIME_MCP_TOOL_MODE=answer-only.',
        nextAction: {
          tool: 'get_findtime_help',
          arguments: {},
          hint: 'Call get_findtime_help or get_api_diagnostics, then use a listed tool. For a raw prompt use answer_time_question.'
        }
      };
    default:
      return {
        whatWentWrong: message || `${toolName} failed.`,
        why: 'The Time API returned an error the MCP server could not satisfy.',
        nextAction: {
          tool: DIAGNOSTICS_TOOL,
          arguments: {},
          hint: 'Call get_api_diagnostics, then retry with corrected arguments or answer_time_question.'
        }
      };
  }
}

function buildActionablePayload({
  toolName,
  args = {},
  apiResponse = {},
  payload = null,
  extraCandidates = [],
  thrownMessage = '',
  hint = null
} = {}) {
  const apiPayload = payload !== null && payload !== undefined
    ? payload
    : (apiResponse.parsedBody !== undefined ? apiResponse.parsedBody : { raw: apiResponse.rawBody });
  const candidates = [
    ...extractCandidates(apiPayload),
    ...extractCandidates({ candidates: extraCandidates })
  ].slice(0, 6);
  const query = extractLocationQuery(args, apiPayload && typeof apiPayload === 'object' ? apiPayload : {});
  const errorClass = classifyToolFailure({
    toolName,
    args,
    apiResponse,
    payload: apiPayload,
    thrownMessage
  }) || 'failed_call';
  const explanation = explainFailure(errorClass, {
    toolName,
    query,
    candidates,
    message: thrownMessage || (apiPayload && apiPayload.message)
  });

  return {
    ok: false,
    tool: toolName,
    errorClass,
    query: query || null,
    candidates,
    whatWentWrong: explanation.whatWentWrong,
    why: explanation.why,
    nextAction: explanation.nextAction,
    ...(hint ? { hint } : {}),
    status: apiResponse.status ?? null,
    url: apiResponse.url,
    error: apiPayload,
    ...(apiResponse.networkError ? { networkError: apiResponse.networkError } : {})
  };
}

function buildActionableText(payload) {
  const lines = [
    payload.whatWentWrong,
    payload.why && `Why: ${payload.why}`,
    payload.nextAction && payload.nextAction.hint && `What to do: ${payload.nextAction.hint}`
  ].filter(Boolean);
  if (Array.isArray(payload.candidates) && payload.candidates.length) {
    lines.push('Top candidates:');
    payload.candidates.forEach((candidate, index) => {
      const places = candidate.places ? ` - ${candidate.label || candidate.name}: ${candidate.places}` : '';
      lines.push(`${index + 1}. ${candidate.suggestedQuery || candidate.name}${candidate.timezoneIana ? ` (${candidate.timezoneIana})` : ''}${places}`);
    });
  }
  if (payload.nextAction && payload.nextAction.tool) {
    lines.push(`Suggested tool: ${payload.nextAction.tool}`);
  }
  return lines.join('\n');
}

function buildActionableErrorResult(input) {
  const structuredContent = buildActionablePayload(input);
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: buildActionableText(structuredContent)
      }
    ],
    structuredContent
  };
}

function enrichResolvedPayload(toolName, payload, args = {}) {
  if (!payload || typeof payload !== 'object') return payload;
  const errorClass = classifyToolFailure({
    toolName,
    args,
    apiResponse: { status: 200, parsedBody: payload },
    payload
  });
  if (!errorClass || !['ambiguous_location', 'unresolved_location', 'low_confidence'].includes(errorClass)) {
    return payload;
  }
  const actionable = buildActionablePayload({
    toolName,
    args,
    apiResponse: { status: 200, parsedBody: payload },
    payload
  });
  return {
    ...payload,
    errorClass: actionable.errorClass,
    whatWentWrong: actionable.whatWentWrong,
    why: actionable.why,
    nextAction: actionable.nextAction,
    candidates: actionable.candidates.length ? actionable.candidates : payload.candidates
  };
}

module.exports = {
  ANSWER_TOOL,
  DIAGNOSTICS_TOOL,
  SEARCH_TOOL,
  buildActionableErrorResult,
  buildActionablePayload,
  buildActionableText,
  classifyToolFailure,
  enrichResolvedPayload,
  extractCandidates,
  extractLocationQuery
};
