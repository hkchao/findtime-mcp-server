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

Required runtime:

- Node 20+
- a valid findtime developer key in `FINDTIME_TIME_API_KEY`, `FINDTIME_API_KEY`, `TIME_API_KEY`, or `FINDTIME_MCP_API_KEY`

Optional environment variables:

- `FINDTIME_TIME_API_BASE_URL`
- `TIME_API_BASE_URL`
- `TIME_API_TIMEOUT_MS`
- `FINDTIME_MCP_CLIENT_TYPE`
- `FINDTIME_MCP_CLIENT_ID` or `FINDTIME_MCP_INSTALL_ID` to provide a stable client identifier. If omitted, the server creates one locally under the user's state directory.
- `FINDTIME_MCP_INSTRUMENTATION_ENABLED=false` to opt out of anonymous usage telemetry.
- `FINDTIME_MCP_USAGE_TELEMETRY_URL` to override the default telemetry endpoint.

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

## Verify installation

Use an explicit tool-call prompt first:

```text
Use the findtime MCP tool get_current_time for city "Tokyo" with countryCode "JP".
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
