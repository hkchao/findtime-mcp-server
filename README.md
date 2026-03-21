# @findtime/mcp-server

`@findtime/mcp-server` is a thin stdio MCP wrapper over the production findtime.io Time API at `https://time-api.findtime.io`.

The package intentionally proxies the production API instead of re-implementing time logic locally. Current time, DST, conversion, overlap, meeting search, and location resolution should stay aligned with the live API.

## Tool surface

- `time_snapshot`
- `get_current_time`
- `get_dst_schedule`
- `convert_time`
- `get_overlap_hours`
- `find_meeting_time`
- `search_timezones`
- `get_location_by_id`

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
- `FINDTIME_MCP_INSTRUMENTATION_ENABLED`

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
        "FINDTIME_TIME_API_KEY": "YOUR_FINDTIME_SECRET_KEY",
        "FINDTIME_MCP_INSTRUMENTATION_ENABLED": "false"
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
FINDTIME_MCP_INSTRUMENTATION_ENABLED = "false"
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
        "FINDTIME_TIME_API_KEY": "YOUR_FINDTIME_SECRET_KEY",
        "FINDTIME_MCP_INSTRUMENTATION_ENABLED": "false"
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

Run the server directly from the repo root:

```bash
npm start
```

The server attempts to load `.env.development.local`, `.env.development`, `.env.local`, and `.env` from:

- the current working directory
- the repo root

## Tests

Protocol and transport tests:

```bash
npm test
```

Live production-parity smoke tests:

```bash
npm run test:smoke
```

The smoke suite checks:

- `search_timezones`
- `get_current_time`
- `get_dst_schedule`
- `convert_time`
- `get_overlap_hours`
- `find_meeting_time`
- `get_location_by_id`

## Maintainer release flow

This repository is intended to be the canonical public source for `@findtime/mcp-server`.

Recommended setup:

- keep `@findtime/mcp-server` as the npm package name
- add `repository` and `bugs` metadata after creating the GitHub repo
- add an `NPM_TOKEN` secret to the GitHub repository
- publish through GitHub Actions or a maintainer terminal from this repo root

Standard local publish flow:

```bash
npm test
npm pack --dry-run
npm publish --access public
```

GitHub Actions release flow:

```bash
npm test
npm pack --dry-run
npm publish --access public
```

Use the workflow in `.github/workflows/publish.yml` for repo-backed publishes.
