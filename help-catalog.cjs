'use strict';

const HELP_ALIASES = ['help', '?', '/help', '/findtime help', '/findtime ?'];

const HELP_INTENTS = [
  {
    id: 'current_time',
    label: 'Current time',
    notes: 'Returns local date/time, timezone, UTC offset, and DST context when relevant.',
    examples: {
      default: ['What time is it now in Tokyo?', 'now in Tokyo, Sydney, Dubai'],
      slack: ['/findtime now in Tokyo Sydney Dubai'],
      discord: ['now in Tokyo, Paris, and Vancouver'],
      chrome: ['now in Tokyo Sydney Dubai'],
      mcp: ['What time is it now in Tokyo?']
    }
  },
  {
    id: 'timezone_lookup',
    label: 'Timezone lookup',
    notes: 'Returns the canonical IANA timezone plus the current abbreviation.',
    examples: {
      default: ['What timezone is Auckland in?', 'Tokyo time zone'],
      slack: ['/findtime Tokyo time zone'],
      discord: ['Tokyo time zone'],
      chrome: ['Singapore time zone'],
      mcp: ['What timezone is Auckland in?']
    }
  },
  {
    id: 'timezone_abbreviation_lookup',
    label: 'Timezone abbreviation',
    notes: 'Returns the current abbreviation plus the canonical IANA timezone.',
    examples: {
      default: ['What timezone abbreviation is Auckland?', 'What does CST mean?'],
      slack: ['/findtime what does CST mean?'],
      discord: ['what does CST mean?'],
      chrome: ['timezone in Dubai'],
      mcp: ['What timezone abbreviation is Auckland?']
    }
  },
  {
    id: 'time_conversion',
    label: 'Time conversion',
    notes: 'Includes local dates because conversions often cross calendar days.',
    examples: {
      default: ['If it is 3:30pm in London, what time is it in Sydney?', 'What is 5pm San Francisco time in Tokyo?', '9am New York to Berlin'],
      slack: ['/findtime 3pm London to NYC'],
      discord: ['8pm PST to London and Tokyo'],
      chrome: ['3pm London to NYC', '9am PST to IST'],
      mcp: ['If it is 3:30pm in London, what time is it in Sydney?', 'What is 5pm San Francisco time in Tokyo?']
    }
  },
  {
    id: 'dst_status',
    label: 'Daylight saving',
    notes: 'Returns DST status and transition context when available.',
    examples: {
      default: ['Is Mexico City on DST?', 'Does London observe daylight saving?', 'When do clocks change in New York?'],
      slack: ['/findtime does London observe daylight saving?'],
      discord: ['does London observe daylight saving?'],
      chrome: ['does Sydney observe daylight saving?', 'DST in New York'],
      mcp: ['Is Mexico City on DST?']
    }
  },
  {
    id: 'overlap_hours',
    label: 'Overlap hours',
    notes: 'Useful for distributed-team availability, handoff planning, and group coordination.',
    examples: {
      default: ['What working hours overlap for San Francisco, Berlin, and Tokyo?', 'working hours overlap for New York and London'],
      slack: ['/findtime working hours overlap for San Francisco Berlin Tokyo'],
      discord: ['when are New York and Sydney both free?'],
      chrome: ['new york london tokyo'],
      mcp: ['What working hours overlap for San Francisco, Berlin, and Tokyo?']
    }
  },
  {
    id: 'meeting_time_search',
    label: 'Meeting time search',
    notes: 'Returns ranked meeting windows and tradeoffs across participants.',
    examples: {
      default: ['Find a good meeting time for San Francisco, Berlin, and Sydney.', 'Best meeting time for San Francisco, Berlin, and Sydney next week', 'find the best meeting times between Helsinki and Osaka'],
      slack: ['/findtime find a good meeting time for San Francisco Berlin Sydney'],
      discord: ['best time for Los Angeles, Berlin, and Seoul'],
      chrome: ['meeting Helsinki Dubai Chicago Taipei'],
      mcp: ['Find a good meeting time for San Francisco, Berlin, and Sydney.']
    }
  },
  {
    id: 'abbreviation_disambiguation',
    label: 'Abbreviation disambiguation',
    notes: 'Timezone abbreviations are aliases, not canonical identifiers.',
    examples: {
      default: ['What does CST mean for a customer in China versus a customer in Chicago?', 'Convert 9am CST to London'],
      slack: ['/findtime Convert 9am CST to London'],
      discord: ['9am CST to London'],
      chrome: ['EST to GMT'],
      mcp: ['What does CST mean for a customer in China versus a customer in Chicago?']
    }
  },
  {
    id: 'location_disambiguation',
    label: 'Location disambiguation',
    notes: 'Ambiguous place names should return clarification or country-aware choices instead of silent guessing.',
    examples: {
      default: ['What time is it in Victoria?', 'What time is it in Springfield?'],
      slack: ['/findtime what time is it in Victoria?'],
      discord: ['what time is it in Victoria?'],
      chrome: ['time in Victoria'],
      mcp: ['What time is it in Victoria?']
    }
  }
];

const HELP_SURFACES = {
  default: {
    title: 'Ask about time anywhere',
    summary: 'Convert times, compare cities, check current time, inspect time zones, resolve ambiguity, or find a meeting slot.'
  },
  slack: {
    title: 'Use /findtime for time intelligence',
    summary: 'Convert times, compare teammates, check time zones, and find meeting windows directly in Slack.'
  },
  discord: {
    title: 'Coordinate across time zones',
    summary: 'Convert raid times, compare party locations, check current time, or find a time that works for your group.',
    commandAliases: ['/findtime', '/ft']
  },
  telegram: {
    title: 'Ask findtime.io about time',
    summary: 'Convert times, check cities, inspect time zones, and coordinate across locations from Telegram.'
  },
  chrome: {
    title: 'What you can do',
    summary: 'Convert times, open live pages on findtime.io, and plan across cities from the browser.'
  },
  mcp: {
    title: 'findtime.io Time Help',
    summary: 'Use findtime.io MCP for accurate timezone, DST, conversion, overlap-hours, and cross-timezone meeting-time intelligence.'
  }
};

const AMBIGUITY_EXAMPLES = [
  {
    query: 'What time is it in Springfield?',
    expectedBehavior: 'Ask for clarification or provide likely matches because many cities share this name.'
  },
  {
    query: 'Convert 9am CST to London.',
    expectedBehavior: 'Clarify whether CST means China Standard Time, Central Standard Time, Cuba Standard Time, or another regional meaning when context is insufficient.'
  },
  {
    query: 'Schedule a meeting for Paris and Sydney next Friday.',
    expectedBehavior: 'Resolve Paris, France unless context suggests otherwise; include date and local-time tradeoffs.'
  }
];

const FAILURE_POLICY = [
  'If a findtime.io MCP call fails, say the MCP call failed and include the visible error.',
  'Do not present fallback timezone or DST calculations as if they came from findtime.io MCP.',
  'For high-stakes scheduling, retry or ask the user before using fallback reasoning.'
];

function normalizeSurface(surface) {
  const normalized = String(surface || '').trim().toLowerCase();
  if (normalized === 'discord-bot') return 'discord';
  if (normalized === 'slack-bot') return 'slack';
  if (normalized === 'telegram-bot') return 'telegram';
  if (normalized === 'web-chat' || normalized === 'webapp' || normalized === 'web') return 'default';
  return HELP_SURFACES[normalized] ? normalized : 'default';
}

function examplesForSurface(intent, surface) {
  const key = normalizeSurface(surface);
  const examples = intent.examples || {};
  return examples[key] || examples.default || [];
}

function flattenExamples(surface = 'default', { max = 12 } = {}) {
  const examples = [];
  for (const intent of HELP_INTENTS) {
    for (const example of examplesForSurface(intent, surface)) {
      if (!examples.includes(example)) examples.push(example);
      if (examples.length >= max) return examples;
    }
  }
  return examples;
}

function mergeExamples(primary = [], secondary = [], { max = 18 } = {}) {
  const examples = [];
  for (const example of [...primary, ...secondary]) {
    if (!examples.includes(example)) examples.push(example);
    if (examples.length >= max) return examples;
  }
  return examples;
}

function buildHelpPayload({ surface = 'default', includeAllIntents = false } = {}) {
  const normalizedSurface = normalizeSurface(surface);
  const surfaceMeta = HELP_SURFACES[normalizedSurface] || HELP_SURFACES.default;
  const defaultSuggestions = flattenExamples('default', { max: 18 });
  const surfaceSuggestions = normalizedSurface === 'default'
    ? []
    : flattenExamples(normalizedSurface, { max: 6 });
  const suggestions = normalizedSurface === 'default'
    ? defaultSuggestions
    : mergeExamples(surfaceSuggestions, defaultSuggestions, { max: 18 });

  return {
    version: 'answer-help.v1',
    surface: normalizedSurface,
    title: surfaceMeta.title,
    summary: surfaceMeta.summary,
    commandAliases: surfaceMeta.commandAliases || [],
    aliases: HELP_ALIASES,
    suggestions,
    surfaceSuggestions,
    defaultSuggestions,
    intents: HELP_INTENTS.map((intent) => ({
      intent: intent.id,
      label: intent.label,
      notes: intent.notes,
      examples: includeAllIntents
        ? mergeExamples(examplesForSurface(intent, normalizedSurface), examplesForSurface(intent, 'default'), { max: 6 })
        : mergeExamples(examplesForSurface(intent, normalizedSurface), examplesForSurface(intent, 'default'), { max: 2 }),
      surfaceExamples: normalizedSurface === 'default' ? [] : examplesForSurface(intent, normalizedSurface),
      defaultExamples: examplesForSurface(intent, 'default'),
      example: (examplesForSurface(intent, normalizedSurface)[0] || examplesForSurface(intent, 'default')[0] || '')
    })),
    ambiguityExamples: AMBIGUITY_EXAMPLES,
    failurePolicy: FAILURE_POLICY
  };
}

function isHelpQuery(value) {
  const normalized = String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
  return HELP_ALIASES.includes(normalized);
}

module.exports = {
  HELP_ALIASES,
  HELP_INTENTS,
  HELP_SURFACES,
  AMBIGUITY_EXAMPLES,
  FAILURE_POLICY,
  normalizeSurface,
  flattenExamples,
  buildHelpPayload,
  isHelpQuery
};
