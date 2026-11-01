const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HEADER_FIELDS = {
  clientName: 'Client-Name',
  clientVersion: 'Client-Version',
  installationId: 'Installation-ID',
  callerLabel: 'Caller-Label',
  trafficType: 'Traffic-Type',
  testRunId: 'Test-Run-ID',
  mcpServerVersion: 'Server-Version',
  toolName: 'Tool'
};
let cachedInstallationId;

function metadataText(value) {
  if (typeof value !== 'string' || value.length > 128 || !/^[\x20-\x7e]*$/.test(value)) return '';
  return value.trim();
}

function normalizeAttribution(input = {}) {
  const clean = {};
  for (const field of Object.keys(HEADER_FIELDS)) {
    const value = metadataText(input && input[field]);
    if (value) clean[field] = value;
  }
  if (!['internal_qa', 'external', 'unknown'].includes(clean.trafficType)) clean.trafficType = 'unknown';
  return clean;
}

function installationId() {
  const explicit = metadataText(process.env.FINDTIME_MCP_CLIENT_ID || process.env.FINDTIME_MCP_INSTALL_ID || process.env.FINDTIME_CLIENT_USER_ID);
  if (explicit) return explicit;
  if (cachedInstallationId) return cachedInstallationId;
  const directory = process.env.FINDTIME_MCP_STATE_DIR
    || (process.env.XDG_STATE_HOME ? path.join(process.env.XDG_STATE_HOME, 'findtime') : path.join(os.homedir(), '.findtime'));
  const filename = path.join(directory, 'mcp-client-id');
  try {
    const existing = metadataText(fs.readFileSync(filename, 'utf8').trim());
    if (existing) return (cachedInstallationId = existing);
  } catch (_error) {}
  cachedInstallationId = `mcp-${crypto.randomUUID()}`;
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(filename, `${cachedInstallationId}\n`, { mode: 0o600 });
  } catch (_error) {}
  return cachedInstallationId;
}

function localAttribution() {
  const internal = [process.env.FINDTIME_MCP_INTERNAL_QA, process.env.FINDTIME_INTERNAL_QA, process.env.FINDTIME_MCP_INTERNAL]
    .some((value) => ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase()));
  return normalizeAttribution({
    clientName: process.env.FINDTIME_MCP_CLIENT_TYPE,
    callerLabel: process.env.FINDTIME_MCP_CALLER_LABEL,
    trafficType: internal ? 'internal_qa' : process.env.FINDTIME_MCP_TRAFFIC_TYPE,
    testRunId: process.env.FINDTIME_MCP_TEST_RUN_ID,
    installationId: installationId()
  });
}

function attributionHeaders(input) {
  return Object.fromEntries(Object.entries(normalizeAttribution(input)).map(([key, value]) => [
    `X-Findtime-MCP-${HEADER_FIELDS[key]}`, value
  ]));
}

module.exports = { metadataText, normalizeAttribution, installationId, localAttribution, attributionHeaders };
