# @findtime/mcp-server

[![M8ven Score](https://m8ven.ai/badge/mcp/findtime-mcp-server-s6kz8n?v=d6bb8bee04639f042b16c53a2608f80a)](https://m8ven.ai/mcp/findtime-mcp-server-s6kz8n)

`@findtime/mcp-server` is a thin stdio MCP wrapper over the production findtime.io Time API at `https://time-api.findtime.io`.

The package intentionally proxies the production API instead of re-implementing time logic locally. Current time, DST, conversion, overlap, meeting search, and location resolution should stay aligned with the live API.

Published surfaces:

- npm: `@findtime/mcp-server`
- GitHub: `https://github.com/hkchao/findtime-mcp-server`
- Official MCP Registry: `https://registry.modelcontextprotocol.io/?q=io.github.hkchao%2Ffindtime-mcp-server`
- MCP Registry name: `io.github.hkchao/findtime-mcp-server`
- Hosted server: `https://mcp.findtime.io/mcp` (Streamable HTTP, OAuth sign-in). It includes the time tools and saved teams. Booking tools (request, reschedule and cancel bookings; host approve/decline; booking pages and invite links) are available after you sign in with Google through the connector and grant the booking scopes. See [Hosted server scopes](#hosted-server-scopes) for which OAuth scope covers which tool. The npm package covers the time and meeting-planning tools only and needs `FINDTIME_TIME_API_KEY`. It has no saved-group or booking tools: those need a findtime account signed in with Google on the hosted server, and an API key never gets booking tools.

## Hosted server scopes

The hosted server's OAuth metadata (`/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`) lists only the two default scopes, `time:read` and `meetings:plan`. A client that connects without naming a scope gets both. The booking scopes, `booking:request` and `booking:host`, are left out of `scopes_supported` on purpose, so a client that copies that list on first connect never asks for host access. They are still granted when a client asks for them by name.

When a signed-in client calls a booking tool without the scope it needs, the server answers `403` with `WWW-Authenticate: Bearer error="insufficient_scope", scope="..."`. The `scope` value is the full set to ask for on the next sign-in. Asking for `booking:host` shows a findtime consent screen before Google sign-in.

| Scope | Tools |
| --- | --- |
| `time:read` | All time tools not listed below (including `check_proposed_time`, `are_they_awake`, `rank_recurring_slot`, and `send_feedback`), plus `get_team`, `list_teams`, the booking reads `get_host_booking_profile`, `find_host_slots`, `get_booking_status`, `list_my_booking_requests`, and `cancel_booking` (a guest cancelling their own request; it needs the tracking or history token returned when the request was sent) |
| `meetings:plan` | `find_meeting_time`, `get_overlap_hours`, `save_team`, `rename_team`, `delete_team` |
| `booking:request` | `request_booking`, `reschedule_booking` |
| `booking:host` | `get_my_booking_page`, `list_booking_requests`, `approve_booking_request`, `decline_booking_request`, `cancel_booking_as_host`, `update_booking_page`, `create_invite_link`, `revoke_invite_link` |

The findtime booking API checks `booking:request` and `booking:host` again on its side, using a signed assertion from the hosted server. Those tools also need the person signed in to findtime with Google and a verified email. Finding a host's open times needs no booking scope. A Time API key (`ftk_live_...`) used as a bearer token gets `time:read meetings:plan` only and never sees the booking tools.

## Tool surface

The npm package (stdio, API key) and the hosted server both have:

- `answer_time_question`
- `get_findtime_help`
- `get_api_diagnostics`
- `send_feedback` (reports a wrong answer; sends the tool name, never the query text)
- `time_snapshot`
- `get_current_time`
- `get_dst_schedule`
- `convert_time`
- `get_overlap_hours`
- `find_meeting_time`
- `check_proposed_time` (`/meeting/check`: verdicts for a time the user already picked)
- `are_they_awake` (`/meeting/awake`: work, awake, or sleep in other cities at one moment)
- `rank_recurring_slot` (`/meeting/recurring`: who a weekly time punishes, plus a kinder slot)
- `search_timezones`
- `get_location_by_id`

Hosted server only (`https://mcp.findtime.io/mcp`, signed in with Google). These are not in the npm package and never will be on an API key:

- Saved groups: `save_team`, `get_team`, `list_teams`, `rename_team`, `delete_team`. They read and write the homepage planner Saved groups of the signed-in Google account. On the npm package, a `teamId` without locations answers `teams_not_persisted`; pass locations on each call.
- Booking: `get_host_booking_profile`, `find_host_slots`, `request_booking`, `get_booking_status`, `list_my_booking_requests`, `cancel_booking`, `reschedule_booking`, `get_my_booking_page`, `list_booking_requests`, `approve_booking_request`, `decline_booking_request`, `cancel_booking_as_host`, `update_booking_page`, `create_invite_link`, `revoke_invite_link`. Every booking write returns a read-back first and changes nothing until it is called again with `confirm: true`; the host approves or declines every request.

Scopes for each hosted tool are in [Hosted server scopes](#hosted-server-scopes). Tool and setup docs: https://findtime.io/developers/mcp/#booking-tools. The booking routes these tools call: https://findtime.io/developers/#booking-api.

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

Releases publish from CI when a `v<version>` tag is pushed: `.github/workflows/publish.yml` publishes to npm with trusted publishing (GitHub OIDC), then calls `.github/workflows/publish-mcp-registry.yml` to publish `server.json` to the MCP Registry. The full runbook (manual dispatch, re-runs, error fixes, and the hand-publish fallback) is the "Maintainer Release Playbook" in `SKILL.md`.

Standard release flow in the public repo, after bumping `package.json` and `server.json` and merging to `main`:

```bash
npm run release:check
npm test
npm pack --dry-run
git tag v<version> <merge-commit-sha>
git push origin v<version>
```

Hand publishing is a fallback only. `prepublishOnly` rejects it unless you set the acknowledgement that `release:check` prints:

```bash
FINDTIME_MCP_RELEASE_CHECKED=<version> npm publish --access public
```

The equivalent local verification checks in this repo are:

```bash
npm run test:mcp-server
npm run mcp:pack
```

Treat this repo as the implementation source that originally produced the MCP package, not as the canonical public release source.

## Publisher and tool safety

The npm package `@findtime/mcp-server` and GitHub repository
`hkchao/findtime-mcp-server` are the findtime.io MCP distribution channels.
Product documentation: https://findtime.io/developers/mcp/

The npm package's tools query time information, suggest meeting times, or
return help and diagnostics; they do not book meetings or modify calendars.
They declare `readOnlyHint: true`, `destructiveHint: false`,
`idempotentHint: true`, and `openWorldHint: true`, except `send_feedback`, which
records a report and declares `readOnlyHint: false`, `destructiveHint: false`,
and `idempotentHint: false`. Read-only describes the user-facing operation, not
an absence of network traffic: API requests, diagnostics, and optional usage
telemetry contact external services. Repeating a current-time query can return a
new time; idempotent describes the absence of additional domain mutations.

The hosted server at `https://mcp.findtime.io/mcp` also has booking tools that
do write: requesting, rescheduling, approving, declining, and cancelling
bookings, changing a booking page, and making or revoking invite links.
Approving or cancelling a meeting changes the host's Google Calendar. Those
tools declare `readOnlyHint: false`, and the ones that cancel, decline, or
revoke declare `destructiveHint: true`. They are not part of this package.

API-key environment variables are alternative configuration names for one key,
not four separate credentials.

## Privacy, authentication, and service limits

Privacy policy: https://findtime.io/privacy/

The stdio process runs locally. Time tools send their query arguments to the
configured Time API (by default `https://time-api.findtime.io`). The selected API
key is sent in the `Authorization: Bearer` header to that API, not to npm or
telemetry. Configure only API hosts you trust. The four API-key variable names
are aliases: the first nonempty value wins in this order: `FINDTIME_API_KEY`,
`TIME_API_KEY`, `FINDTIME_MCP_API_KEY`, `FINDTIME_TIME_API_KEY`.

The hosted Time API owns API-key validation, configured per-key rate limits,
and quotas. The wrapper forwards upstream failures, including HTTP 429, as MCP
tool errors. It does not expose a public HTTP listener or implement a separate
local rate limiter. Help is local; diagnostics also reads npm version metadata.

Miss reports: when a tool call fails, a location can't be resolved, or the
same client quickly re-asks, the
wrapper posts a miss event to the configured Time API (`/mcp/miss`) with the
tool name, an error class, result flags, a candidate count, the installation
identifier, and the client and traffic type. `send_feedback` posts the tool
name and the same metadata to `/mcp/feedback`. Neither sends query text,
`whatWasWrong`, or the API key in the body; the key goes only in the
`Authorization` header, as for every Time API call.

Optional usage telemetry goes to `https://slack.findtime.io/telemetry/usage` by
default. The wrapper sends tool name, outcome, query-text length, a persistent
installation/client identifier, version, OS, locale, timezone, and latency.
This telemetry event does not include raw query text, API keys, or the per-call
`_endUserId`. Set `FINDTIME_MCP_INSTRUMENTATION_ENABLED=false` to disable it.
A generated installation identifier is stored in the user's state directory.
Host-provided attribution identifiers are sent to the Time API as documented
above; use opaque non-PII values.

## License

The MCP wrapper and documentation in this repository are licensed under the
[MIT License](LICENSE).

This license covers this repository only. It does not grant rights to the
hosted findtime.io Time API, its backend implementation or data, or the broader
findtime.io application. Use of hosted services remains subject to their
applicable terms and API access requirements.
