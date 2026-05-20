#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const packageRoot = path.resolve(__dirname, '..');
const packageJsonPath = path.join(packageRoot, 'package.json');
const skillPath = path.join(packageRoot, 'SKILL.md');
const docsSkillPath = path.resolve(packageRoot, '..', '..', 'docs', 'api-mcp', 'agent-skills', 'findtime-io-mcp', 'SKILL.md');
const isPrepublish = process.argv.includes('--prepublish');

function fail(message) {
  console.error(`\nMCP release check failed: ${message}\n`);
  process.exit(1);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`could not read ${filePath}: ${error.message}`);
  }
}

function assertFileContains(filePath, snippets) {
  let contents;
  try {
    contents = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    fail(`could not read ${filePath}: ${error.message}`);
  }

  for (const snippet of snippets) {
    if (!contents.includes(snippet)) {
      fail(`${filePath} is missing release-playbook text: ${snippet}`);
    }
  }
}

const packageJson = readJson(packageJsonPath);
const version = packageJson.version;
const requiredAck = String(version || '').trim();
const actualAck = String(process.env.FINDTIME_MCP_RELEASE_CHECKED || '').trim();

if (!requiredAck) {
  fail('package.json has no version');
}

assertFileContains(skillPath, [
  'Maintainer Release Playbook',
  'npm dist-tag ls @findtime/mcp-server',
  'Do not trust a single `npm view @findtime/mcp-server version` result immediately after publish'
]);

if (fs.existsSync(docsSkillPath)) {
  assertFileContains(docsSkillPath, [
    'Maintainer Release Playbook',
    'npm dist-tag ls @findtime/mcp-server',
    'Do not trust a single `npm view @findtime/mcp-server version` result immediately after publish'
  ]);
}

if (isPrepublish && actualAck !== requiredAck) {
  fail([
    `prepublishOnly requires FINDTIME_MCP_RELEASE_CHECKED=${requiredAck}.`,
    'Before publishing, read SKILL.md and run `/usr/local/bin/npm run release:check` from this package directory.',
    'Then publish with the version-specific acknowledgement only after completing the checklist.'
  ].join('\n'));
}

console.log(`@findtime/mcp-server release check for ${version}`);
console.log('');
console.log('Read before publishing:');
console.log(`- ${skillPath}`);
if (fs.existsSync(docsSkillPath)) {
  console.log(`- ${docsSkillPath}`);
}
console.log('');
console.log('Required pre-publish checks:');
console.log('- /usr/local/bin/npm test');
console.log('- /usr/local/bin/npm pack --dry-run --cache /private/tmp/findtime-npm-cache');
console.log('- Confirm publish source is the canonical package repo or synced services/mcp-server package');
console.log('- Confirm deploy impact: MCP package publish only; time-api.findtime.io deploy only if upstream API behavior changed');
console.log('');
console.log('Required post-publish verification:');
console.log(`- /usr/local/bin/npm view @findtime/mcp-server@${version} version --prefer-online --cache /private/tmp/findtime-npm-cache-verify`);
console.log('- /usr/local/bin/npm dist-tag ls @findtime/mcp-server --cache /private/tmp/findtime-npm-cache-verify');
console.log('- /usr/local/bin/npm view @findtime/mcp-server version --prefer-online --cache /private/tmp/findtime-npm-cache-verify');
console.log('');
console.log('Publish gate:');
console.log(`- Set FINDTIME_MCP_RELEASE_CHECKED=${version} only after reading the playbook and completing the pre-publish checks.`);
console.log('- Revoke any npm token that was pasted into chat or used as a short-lived release token.');

