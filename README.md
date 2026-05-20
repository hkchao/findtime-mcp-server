# @findtime/mcp-server

`@findtime/mcp-server` is a thin stdio MCP wrapper over the production findtime.io Time API at `https://time-api.findtime.io`.

The package intentionally proxies the production API instead of re-implementing time logic locally. Current time, DST, conversion, overlap, meeting search, and location resolution should stay aligned with the live API.

Published surfaces:

- npm: `@findtime/mcp-server`
- GitHub: `https://github.com/hkchao/findtime-mcp-server`
- Official MCP Registry: `https://registry.modelcontextprotocol.io/?q=io.github.hkchao%2Ffindtime-mcp-server`
- MCP Registry name: `io.github.hkchao/findtime-mcp-server`

## Tool surface

- `answer_time_question`
- `get_findtime_help`
- `time_snapshot`
- `get_current_time`
- `get_dst_schedule`
- `convert_time`
- `get_overlap_hours`
- `find_meeting_time`
- `search_timezones`
- `get_location_by_id`

Prefer `answer_time_question` for messy natural-language prompts such as "3pm PST to London", "what is the IANA timezone for San Francisco?", "working hours overlap for SF, Berlin, and Tokyo", or "what does CST mean?". The tool classifies the prompt through findtime.io's domain logic, dispatches to deterministic Time API behavior, and returns structured ambiguity or clarification when the world is genuinely ambiguous.

## Install in MCP clients

Use the published package through `npx`:

```bash
npx -y @findtime/mcp-server
```

For agent authors, include [`SKILL.md`](./SKILL.md) alongside the MCP config.
It gives Claude, Codex, Cursor, Cline, Windsurf, custom company bots, and other
LLM agents the operating rules for when to prefer `findtime.io` MCP, which tools
to call, and how to handle ambiguity or fallback.

Required runtime:

- Node 20+
- `FINDTIME_TIME_API_KEY`: a valid `findtime.io` developer key from `https://findtime.io/developers/keys/`

Optional environment variables:

- `FINDTIME_TIME_API_BASE_URL`
- `TIME_API_BASE_URL`
- `TIME_API_TIMEOUT_MS`
- `FINDTIME_BINDING_TYPE` for optional install/workspace binding context. Supported values: `slack_team`, `workspace_id`, `install_id`.
- `FINDTIME_BINDING_VALUE` for the install/workspace identifier that matches the selected binding type.
- `FINDTIME_BINDING_HEADER` to override the header name directly for custom enterprise environments.
- `FINDTIME_MCP_CLIENT_ID` or `FINDTIME_MCP_INSTALL_ID` to provide a stable client identifier. If omitted, the server creates one locally under the user's state directory. When present, the MCP wrapper forwards it to `time-api` as `X-Findtime-User-ID` for enterprise usage attribution.
- `FINDTIME_MCP_CLIENT_TYPE`
- `FINDTIME_MCP_TOOL_MODE=answer-only` to expose only `answer_time_question`, `get_findtime_help`, and `get_api_diagnostics` for enterprise bots that should route every natural-language request through the answer API.
- `FINDTIME_MCP_INSTRUMENTATION_ENABLED=false` to opt out of anonymous usage telemetry.
- `FINDTIME_MCP_USAGE_TELEMETRY_URL` to override the default telemetry endpoint.

## Per-call end-user attribution

Multi-user MCP hosts such as Slack, Discord, and Teams bots can run one long-lived `@findtime/mcp-server` subprocess while still attributing each Time API call to the end-user who triggered it. Add an optional `_endUserId` field inside the MCP tool call `arguments` object. The server strips `_endUserId` from the tool parameters and forwards it only as the upstream `X-Findtime-End-User-ID` HTTP header.

```js
await client.callTool({
  name: "get_current_time",
  arguments: {
    city: "Tokyo",
    _endUserId: "a3f2c1d4e5b6c7d8"
  }
});
```

The field is optional and backward-compatible. If `_endUserId` is missing, `null`, or an empty string, the header is omitted and attribution falls back to the install-level `FINDTIME_MCP_CLIENT_ID` or `FINDTIME_MCP_INSTALL_ID` behavior.

Privacy contract: `_endUserId` must be an opaque token supplied by the MCP host, typically a SHA-256 hash of the platform user ID truncated to 16-32 hex characters. Do not send raw email addresses, names, Slack/Discord/Teams IDs, or other PII. Avoiding PII in this field is the host application's responsibility.

The server validates `_endUserId` defensively: it must be a string, at most 256 characters, and must not contain CR, LF, or other control characters. The raw value is never logged by the server.

### Cursor

```json
{
  "mcpServers": {
    "findtime": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@findtime/mcp-server"],
      "env": {
        "FINDTIME_MCP_CLIENT_TYPE": "cursor",
        "FINDTIME_TIME_API_BASE_URL": "https://time-api.findtime.io",
        "FINDTIME_TIME_API_KEY": "YOUR_FINDTIME_SECRET_KEY"
      }
    }
  }
}
```

### Codex

```toml
[mcp_servers.findtime]
command = "npx"
args = ["-y", "@findtime/mcp-server"]
enabled = true

[mcp_servers.findtime.env]
FINDTIME_MCP_CLIENT_TYPE = "codex"
FINDTIME_TIME_API_BASE_URL = "https://time-api.findtime.io"
FINDTIME_TIME_API_KEY = "YOUR_FINDTIME_SECRET_KEY"
# Optional enterprise install binding:
# FINDTIME_BINDING_TYPE = "workspace_id"
# FINDTIME_BINDING_VALUE = "YOUR_WORKSPACE_ID"
```

### Claude Desktop

```json
{
  "preferences": {
    "...": "keep your existing preferences here"
  },
  "mcpServers": {
    "findtime": {
      "command": "npx",
      "args": ["-y", "@findtime/mcp-server"],
        "env": {
          "FINDTIME_TIME_API_BASE_URL": "https://time-api.findtime.io",
          "FINDTIME_TIME_API_KEY": "YOUR_FINDTIME_SECRET_KEY"
        }
      }
    }
  }
```

### Claude CLI / Claude Code

Add `findtime.io` with:

```bash
claude mcp add --transport stdio \
  --env FINDTIME_TIME_API_BASE_URL=https://time-api.findtime.io \
  --env FINDTIME_TIME_API_KEY=YOUR_FINDTIME_SECRET_KEY \
  --env FINDTIME_MCP_CLIENT_TYPE=claude-cli \
  findtime -- npx -y @findtime/mcp-server
```

If your Claude CLI uses JSON config instead, add:

```json
{
  "mcpServers": {
    "findtime": {
      "command": "npx",
      "args": ["-y", "@findtime/mcp-server"],
      "env": {
        "FINDTIME_TIME_API_BASE_URL": "https://time-api.findtime.io",
        "FINDTIME_TIME_API_KEY": "YOUR_FINDTIME_SECRET_KEY",
        "FINDTIME_MCP_CLIENT_TYPE": "claude-cli"
      }
    }
  }
}
```

For enterprise installs, the minimum credential is always the API key. If the install environment has a stable workspace or installation identifier, optionally add:

```text
FINDTIME_BINDING_TYPE=workspace_id
FINDTIME_BINDING_VALUE=YOUR_WORKSPACE_ID
```

For Slack-specific installs:

```text
FINDTIME_BINDING_TYPE=slack_team
FINDTIME_BINDING_VALUE=T01ABC123
```

## Verify installation

Use an explicit tool-call prompt first:

```text
Use the findtime.io MCP tool get_api_diagnostics.
```

Then:

```text
Use the findtime.io MCP tool get_current_time for city "Tokyo" with countryCode "JP".
```

After that succeeds, switch back to normal natural-language prompts:

```text
Best meeting time between New York, Sydney, and Mumbai?
```

## Local development

Run the workspace version directly:

```bash
npm run mcp:start
```

The server attempts to load `.env.development.local`, `.env.development`, `.env.local`, and `.env` from:

- the current working directory
- `services/mcp-server`
- the repo root

## Tests

Protocol and transport tests:

```bash
npm run test:mcp-server
```

Live production-parity smoke tests:

```bash
npm run test:mcp-server:smoke
```

The smoke suite checks:

- `search_timezones`
- `answer_time_question`
- `get_current_time`
- `get_dst_schedule`
- `convert_time`
- `get_overlap_hours`
- `find_meeting_time`
- `get_location_by_id`

## Maintainer release flow

The canonical public source for this package now lives in:

- GitHub: `https://github.com/hkchao/findtime-mcp-server`
- npm: `@findtime/mcp-server`
- Official MCP Registry: `https://registry.modelcontextprotocol.io/?q=io.github.hkchao%2Ffindtime-mcp-server`

Publish and version updates should happen from that public repo, not from this private app repo.

Standard publish flow in the public repo:

```bash
npm test
npm pack --dry-run
npm publish --access public
```

The equivalent local verification checks in this repo are:

```bash
npm run test:mcp-server
npm run mcp:pack
```

Treat this repo as the implementation source that originally produced the MCP package, not as the canonical public release source.
