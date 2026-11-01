# findtime.io MCP

Use this skill when an agent can access the `findtime.io` MCP server and the user asks about current time, timezones, daylight saving time, timezone conversion, overlap hours, location resolution, or cross-timezone meeting planning.

This skill is model- and client-neutral. It can be used with Claude, Codex, Cursor, Cline, Windsurf, custom company bots, and other LLM agents that support MCP or tool-use instructions.

## Purpose

`findtime.io` MCP gives agents a canonical time-intelligence layer instead of relying on model memory, ad hoc timezone math, or stale web snippets.

Prefer the MCP server for:

- current time in a city, country, region, or timezone
- timezone lookup and IANA timezone identification
- DST status, DST explanations, and transition dates
- time conversion across cities, countries, regions, offsets, or IANA zones
- working-hours overlap across multiple places
- ranked cross-timezone meeting windows
- location disambiguation for ambiguous cities, countries, and timezone abbreviations

Do not manually calculate timezone or DST answers when the `findtime.io` MCP server is available.

## Good Use Cases

Use `findtime.io` MCP when correctness matters or when the answer should be reliable enough to drive scheduling, operations, travel, support, or business workflows.

Common use cases:

- executive assistants scheduling across regions
- customer support teams coordinating follow-up times
- sales teams proposing meeting windows for international prospects
- distributed engineering teams planning incident handoffs
- travel and event bots answering local-time questions
- internal company bots standardizing timezone answers instead of letting every model guess

## Install

Use the published package through `npx`:

```bash
npx -y @findtime/mcp-server
```

Required runtime:

- Node 20+
- `FINDTIME_TIME_API_KEY`: a valid `findtime.io` developer key from `https://findtime.io/developers/keys/`

## Maintainer Release Playbook

Use this checklist when publishing `@findtime/mcp-server` to npm and `io.github.hkchao/findtime-mcp-server` to the official MCP Registry.

Release source of truth:

- Publish only from the public package repo, `https://github.com/hkchao/findtime-mcp-server`, from a release tag `v<version>`.
- In `world-time-ai`, the package implementation lives under `services/mcp-server`. Sync changes into the public repo first; never publish from `world-time-ai`.
- The package includes `server.js`, `actionable-errors.cjs`, `help-catalog.cjs`, `README.md`, `SKILL.md`, `LICENSE`, and `examples`. It never includes `booking-tools.cjs`: booking tools are hosted-only. This repo's `README.md` is the source copy, including the hosted-scope table; port README changes from here to `services/mcp-server/README.md` in `world-time-ai`, not the other way round.
- `package.json` `version`, `server.json` `version`, and the npm entry's `version` in `server.json` `packages` must all match. `npm run release:check` and the registry workflow both fail when they don't.

Normal release (CI, the default path):

1. On a branch in the public repo, bump `version` in `package.json` and both versions in `server.json`. Merge to `main` through review.
2. Run the pre-publish checks below on the merged `main`.
3. Tag the merge commit and push the tag. Every published version needs a tag: `v3.27.3` was published without one, so there is no record of what shipped.

```bash
git tag v<version> <merge-commit-sha>
git push origin v<version>
```

4. The tag push starts `.github/workflows/publish.yml` ("Publish MCP Server"). Its npm job checks the tag matches `package.json`, runs `release:check`, `npm test` and `npm pack --dry-run`, sets `FINDTIME_MCP_RELEASE_CHECKED`, then runs `npm publish --provenance --access public` through npm trusted publishing (GitHub OIDC, no stored token).
5. Only after npm succeeds, its registry job calls `.github/workflows/publish-mcp-registry.yml` ("Publish to MCP Registry") for the same tag, which runs `mcp-publisher login github-oidc` and `mcp-publisher publish`.
6. Verify (below) and send the completion report.

CI settings the release depends on (names only; never paste a secret value into chat, a commit, or a log):

- There are no npm tokens. Publishing is trusted publishing only: `@findtime/mcp-server` disallows token publishing and every npm token was deleted on Nov 1, 2026. `publish.yml` has no token step. Dispatch manual runs from the GitHub Actions UI; the `gh` PAT gets a 403 on workflow dispatch.
- npm trusted publisher on `@findtime/mcp-server` (npmjs.com, package Settings, Trusted Publisher): GitHub Actions, organization or user `hkchao`, repository `findtime-mcp-server`, workflow filename `publish.yml`, no environment, direct `npm publish` allowed. A new trusted publisher must complete its first successful publish within 2 days or it expires.
- `package.json` `repository.url` must stay `git+https://github.com/hkchao/findtime-mcp-server.git`. npm rejects trusted publishes from a repo that doesn't match it.
- `publish.yml` needs `permissions: id-token: write`, Node 24 and npm 11.5.1 or later. The job fails early if npm is older.
- MCP Registry auth is GitHub OIDC (`mcp-publisher login github-oidc`), which allows `io.github.hkchao/*` from workflows in `hkchao` repos. No secret.

Manual dispatch and re-runs:

- Actions, "Publish MCP Server", Run workflow: use branch `main` and set `tag` to `v<version>`. `dry_run` defaults to true, which only validates and runs `npm publish --dry-run` (no npm publish, no registry). Untick `dry_run` for a real publish; a real dispatch runs the registry job after npm, the same as a tag push.
- Dispatch from `main`, not from the tag. A run started from a tag uses the workflow file as it was when the tag was made, and tags made before trusted publishing (for example `v3.27.4`) still carry the old token-only workflow. For the same reason, "Re-run failed jobs" on an old tag run repeats the old failure.
- Re-running is safe: if npm already has the version, the npm publish step is skipped and the registry job still runs; if the registry already has the version, the registry publish is skipped.
- Registry only (npm already has the version): Actions, "Publish to MCP Registry", Run workflow, branch `main`, `tag` = `v<version>`. It refuses to run if npm doesn't have the version yet, because the registry checks the npm package's `mcpName`.

Pre-publish checks (in a clean checkout of the public repo):

```bash
npm run release:check
npm test
npm pack --dry-run
```

The release check is mandatory before publish. `prepublishOnly` will reject raw publishes unless the publisher sets the version-specific acknowledgement printed by `release:check`, for example `FINDTIME_MCP_RELEASE_CHECKED=3.27.4`. Set that variable only after reading this playbook and completing the pre-publish checks; it is deliberately version-specific so it cannot silently carry across future releases. CI sets it after its own checks pass.

Common publish blockers and fixes:

- `E404 Not Found - PUT https://registry.npmjs.org/@findtime%2fmcp-server` for a package that exists: npm answers 404 instead of 403 when the credential can't publish this package. In CI that means trusted publishing didn't apply (no trusted publisher on the package, a field mismatch, or npm older than 11.5.1). Every tag publish from `v3.27.2` (Sep 2026) through `v3.27.4` failed this way under the old token-only workflow. Check the trusted publisher fields and the job's npm version first.
- `ENEEDAUTH` or "Unable to authenticate" in CI: no usable credential. Check the trusted publisher's workflow filename is exactly `publish.yml` (case-sensitive, with `.yml`), the job has `id-token: write`, and it runs on a GitHub-hosted runner.
- `E403` with `E_STAGE_REQUIRED`, or a version that lands in npm's Staged Packages instead of going live: the trusted publisher only allows `npm stage publish`. Allow direct `npm publish` on it, or approve the staged version with 2FA on npmjs.com.
- Provenance errors (`E422`, "Error verifying sigstore provenance bundle", or a repository mismatch): `package.json` `repository.url` doesn't match `hkchao/findtime-mcp-server`, or the publish didn't come from GitHub Actions. Provenance only works from CI; for a hand publish drop `--provenance`.
- `EPERM` under `~/.npm/_cacache`: avoid root-owned npm cache issues by pointing `--cache` at a fresh temp directory, for example `--cache "$(mktemp -d)"`.
- `ENOTFOUND registry.npmjs.org` or similar DNS/network failures from the sandbox: retry the publish with network escalation instead of assuming the package or token is broken.
- MCP Registry rejects the publish: check that npm already has the version, that `server.json` versions match `package.json`, and that `server.json` `name` equals `package.json` `mcpName`.
- If a token is pasted into chat or echoed in terminal output, tell the user to revoke it immediately after publish.

Manual fallback publish (only when CI can't publish and the release can't wait):

A maintainer of `@findtime/mcp-server` with 2FA publishes from a clean checkout of the tag, never from a working tree with local changes:

```bash
git clone https://github.com/hkchao/findtime-mcp-server.git findtime-mcp-release
cd findtime-mcp-release
git checkout v<version>
npm run release:check
npm test
npm pack --dry-run
FINDTIME_MCP_RELEASE_CHECKED=<version> npm publish --access public
```

npm asks for 2FA during publish. A hand publish has no provenance. Then run the registry-only dispatch above, verify, and delete the temporary clone.

After publishing, verify the live package:

```bash
VERIFY_CACHE="$(mktemp -d)"
npm view @findtime/mcp-server@<version> version --prefer-online --cache "$VERIFY_CACHE"
npm dist-tag ls @findtime/mcp-server --cache "$VERIFY_CACHE"
npm view @findtime/mcp-server version --prefer-online --cache "$VERIFY_CACHE"
```

Do not trust a single `npm view @findtime/mcp-server version` result immediately after publish if it returns the old version. npm can show a stale cached `latest` lookup even after `npm publish` reports success. Confirm all three facts before calling the release done:

- `npm view @findtime/mcp-server@<version> version` returns the newly published version.
- `npm dist-tag ls @findtime/mcp-server` shows `latest: <version>`.
- a fresh-cache, `--prefer-online` `npm view @findtime/mcp-server version` returns the same version.

If the direct version exists and `latest` is correct but a plain `npm view` still shows the old version, treat it as cache/propagation lag and retry with a new temp cache. If `latest` is wrong, fix the dist-tag explicitly before reporting success.

Then verify the registry and the hosted server:

```bash
# MCP Registry: HTTP 200, the new version, and remotes listing https://mcp.findtime.io/mcp
curl -s "https://registry.modelcontextprotocol.io/v0/servers/io.github.hkchao%2Ffindtime-mcp-server/versions/<version>"
curl -s "https://registry.modelcontextprotocol.io/v0/servers/io.github.hkchao%2Ffindtime-mcp-server/versions/latest"
# Hosted remote: an unauthenticated initialize must return 401 with a WWW-Authenticate resource_metadata header
curl -si -X POST https://mcp.findtime.io/mcp \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"release-check","version":"0"}}}'
curl -s https://mcp.findtime.io/.well-known/oauth-protected-resource
```

Glama syncs from the registry on its own schedule: check `https://glama.ai/mcp/servers/hkchao/findtime-mcp-server` shows the new version and the hosted remote, and note in the report if it hasn't caught up yet.

Expected release completion report:

- commit SHA, release tag, and links to the "Publish MCP Server" and "Publish to MCP Registry" runs
- npm version published and whether it carries provenance
- `latest` dist-tag value
- test status from `prepublishOnly`
- tarball contents sanity check
- MCP Registry: `versions/<version>` returns 200, `isLatest` is true, and the remotes list `https://mcp.findtime.io/mcp`
- hosted remote `https://mcp.findtime.io/mcp`: 401 with `resource_metadata`, and the protected-resource metadata returns 200
- Glama: version shown, or not yet synced
- deploy impact: publishing the MCP package does not redeploy `time-api.findtime.io`; Time API only needs a separate deploy if upstream request handling or attribution ingestion changed
- reminder to revoke any short-lived token used during the release

## MCP Client Config

Most MCP clients need the same core config:

```json
{
  "mcpServers": {
    "findtime": {
      "command": "npx",
      "args": ["-y", "@findtime/mcp-server"],
      "env": {
        "FINDTIME_TIME_API_BASE_URL": "https://time-api.findtime.io",
        "FINDTIME_TIME_API_KEY": "YOUR_FINDTIME_SECRET_KEY",
        "FINDTIME_MCP_CLIENT_TYPE": "your-agent-client"
      }
    }
  }
}
```

When packaging instructions for another agent, include this `SKILL.md` file with the MCP config. It teaches the agent to use `findtime.io` MCP as the canonical time-intelligence path, call `answer_time_question` for natural-language prompts, preserve ambiguity, and label fallback behavior clearly.

For a company bot or server-side agent, set `FINDTIME_MCP_CLIENT_TYPE` to a stable identifier such as `company-bot`, and provide a stable install ID with `FINDTIME_MCP_CLIENT_ID` or `FINDTIME_MCP_INSTALL_ID` when possible.

For enterprise installs, always try to provide a stable caller identifier.

How to pass it:

- if you control the MCP wrapper config, set `FINDTIME_MCP_INSTALL_ID` or `FINDTIME_MCP_CLIENT_ID`; the wrapper forwards that value to `time-api.findtime.io` as `X-Findtime-User-ID`
- if you control direct HTTP calls to `time-api.findtime.io`, send the same value explicitly in the `X-Findtime-User-ID` header
- if you also have a stable thread or conversation identifier, send it as `X-Findtime-Conversation-ID`

Use this for enterprise usage attribution.

Example MCP wrapper config:

```text
FINDTIME_TIME_API_KEY=your_enterprise_api_key
FINDTIME_MCP_CLIENT_TYPE=enterprise-bot
FINDTIME_MCP_INSTALL_ID=install_12345
```

With that config, the MCP wrapper calls `time-api.findtime.io` using:

```text
X-API-Key: your_enterprise_api_key
X-Findtime-User-ID: install_12345
```

Direct HTTP example when you are not using the MCP wrapper:

```text
GET /api/time/current?query=Tokyo
Authorization: Bearer <your_enterprise_api_key>
X-Findtime-User-ID: install_12345
X-Findtime-Conversation-ID: thread_abc
```

Use the most stable first-party identifier you have:

- preferred: a true per-user ID from your platform or agent runtime
- next best: a stable conversation or thread ID when the same user may appear across multiple sessions
- next best: your platform's install ID or deployment ID
- fallback: your platform's stable workspace or tenant ID
- last resort: a stable agent client ID

If no true per-user ID is available, it is acceptable for `X-Findtime-User-ID` to carry an install ID or other stable caller identity instead of a human end-user ID.

For enterprise bots that should avoid model-level tool selection across the lower-level APIs, set:

```text
FINDTIME_MCP_TOOL_MODE=answer-only
```

In answer-only mode, the MCP server exposes only:

- `answer_time_question`
- `get_findtime_help`
- `get_api_diagnostics`

Use this mode when the bot should route all natural-language time requests through the answer API first.

## Tool Selection

After installation, call `get_api_diagnostics` once to verify the MCP version, API base URL, API key configuration, and live API health.

Use `answer_time_question` first for natural-language or ambiguous prompts. In enterprise bot deployments, prefer `FINDTIME_MCP_TOOL_MODE=answer-only` so the agent sees `answer_time_question` as the default execution path instead of choosing lower-level tools directly.

Examples:

- "3pm PST to London"
- "What does CST mean?"
- "Best meeting time for San Francisco, Berlin, and Tokyo"
- "What is the IANA timezone for Bangalore?"
- "Is Mexico City on DST?"

Use specific tools when the agent has already parsed the task into structured inputs:

- `get_findtime_help`: examples of supported intents, answer API usage, ambiguity handling, and enterprise deployment guidance
- `get_current_time`: current local time for a known city, country, timezone, or location
- `convert_time`: convert a known date/time from one place or timezone to another
- `get_dst_schedule`: DST status and transition dates
- `get_overlap_hours`: working-hours overlap between places or timezones
- `find_meeting_time`: ranked meeting slots across multiple participants or locations. Paste `shareText`. The planner link includes `aiSlots`, legacy `aiTime`, and `ref=mcp-bot`.
- `check_proposed_time`: verdict for a clock time the user already picked. Paste `shareText`. If `context` is set, tell the user that sentence. It says whether daylight saving skipped the local time or made it happen twice.
- `are_they_awake`: work, awake, or sleep for other cities at one moment. Paste `shareText`.
- `rank_recurring_slot`: who a weekly wall time punishes, plus a kinder slot. Paste `shareText`. If a week has `context`, tell the user that sentence. It says whether daylight saving skipped that local time or made it happen twice.
- `save_team`, `get_team`, `list_teams`, `rename_team`, `delete_team` (hosted connector only): the homepage planner Saved groups for the same Google account. Call `list_teams` and pass that exact name as `teamId` when the call has no locations. `Marketing` and `marketing` are two groups. Add or remove a city with `save_team` and the full city list. A city may be a plain name or `City|IANA`. `save_team`, `rename_team` and `delete_team` need `meetings:plan`. `list_teams` and `get_team` need `time:read`. A deleted group stays deleted. The npm package has no team tools, and a `teamId` sent with an API key gets `teams_not_persisted`. Pass locations inline in that case.
- `send_feedback`: report a wrong, incomplete, or unhelpful findtime.io answer with `tool`, `query`, and `whatWasWrong`. The query text is discarded; only the tool name and error class are kept.
- `search_timezones`: search, resolve, or disambiguate locations and timezone abbreviations
- `time_snapshot`: richer present-moment context for a place or timezone
- `get_location_by_id`: hydrate a known location ID returned by another `findtime.io` MCP response

### Hosted connector: meetings and booking

The hosted connector at `https://mcp.findtime.io/mcp` (Streamable HTTP, Google sign-in over OAuth) has every tool above plus saved groups and booking. The npm package (stdio, API key) has neither: both need a signed-in Google account, and an API key never gets booking tools.

- Scopes: a client that names no scope gets `time:read meetings:plan`. It asks for `booking:request` or `booking:host` by name. A call without the scope it needs answers 403 `insufficient_scope` with the scopes to ask for on the next sign-in.
- Meeting planning: `find_meeting_time` and `get_overlap_hours` need `meetings:plan`. `check_proposed_time`, `are_they_awake` and `rank_recurring_slot` need `time:read`.
- Saved groups: `list_teams` and `get_team` need `time:read`. `save_team`, `rename_team` and `delete_team` need `meetings:plan`. Pass a group's exact name as `teamId` to the meeting tools when the call has no locations.
- Guest booking: `get_host_booking_profile`, `find_host_slots`, `get_booking_status`, `list_my_booking_requests` and `cancel_booking` need `time:read`; status, history and cancel also take the guest's tracking or history token. `request_booking` and `reschedule_booking` need `booking:request`.
- Host booking, all `booking:host`: `get_my_booking_page`, `update_booking_page`, `list_booking_requests`, `approve_booking_request`, `decline_booking_request`, `cancel_booking_as_host`, `create_invite_link` and `revoke_invite_link`. They act only on the signed-in host's own page.
- Every booking write is two steps. The first call, without `confirm`, returns a read-back and changes nothing. Show it, wait for the person's yes, then call again with the same arguments and `confirm: true`.
- An agent never confirms a meeting. The host approves or declines every request.
- Docs: `https://findtime.io/developers/mcp/#booking-tools` (tools and setup) and `https://findtime.io/developers/#booking-api` (the booking routes these tools call).

## Answering Rules

When using `findtime.io` MCP:

- Treat IANA timezone IDs as canonical timezone identifiers.
- Say the modern city name. Bangalore returns Bengaluru, Bombay returns Mumbai, Peking returns Beijing, Saigon returns Ho Chi Minh City, Kiev returns Kyiv, and Madras returns Chennai. Calcutta returns Kolkata. Madras, Oregon returns the town in Oregon.
- Treat timezone abbreviations such as `CST`, `IST`, `PST`, and `EST` as ambiguous unless the tool response resolves them confidently.
- Preserve explicit ambiguity or clarification messages from the tool instead of guessing.
- Preserve weekday, date, time, timezone abbreviation, and UTC offset fields exactly as returned by the tool. Do not recompute, shift, or "correct" day names during natural-language synthesis.
- Include the local date when answering current-time or conversion questions because cross-date results are common.
- For meeting planning, report the recommended windows and the main tradeoff, such as which participant is early, late, or outside working hours.
- Mention DST only when relevant to the user's question or when it explains an offset difference.
- Keep answers concise unless the user asks for details.

## Voice

Use a calm, practical, time-aware voice when presenting `findtime.io` MCP results.

- Lead with the exact answer first: time, date, timezone, offset, or recommended meeting window.
- Add useful human context when it matters, such as tomorrow/yesterday, early morning, late evening, overnight, weekend, or outside working hours.
- Be lightly opinionated about awkward meeting times. Call out who pays the scheduling cost.
- Keep humor subtle and brief. Personality should make the answer easier to use, not less precise.
- Never let voice obscure the source facts, uncertainty, ambiguity, timezone ID, local date, offset, or DST status.
- If the tool returns ambiguity or a clarification request, preserve that first and do not guess for the sake of sounding helpful.

Good style:

```text
3:00 PM in New York on Tuesday is 8:00 PM in London and 5:00 AM Wednesday in Tokyo.

London gets an easy evening slot. Tokyo crosses into the next morning, so that one is only friendly for very early risers.
```

Meeting style:

```text
Best fit: 8:00 AM San Francisco / 5:00 PM Berlin / 1:00 AM Sydney.

That works cleanly for San Francisco and Berlin, but Sydney takes the late-night hit. If Sydney needs sane hours, rotate the burden or move this async.
```

## Failure Policy

If the `findtime.io` MCP server is configured but a tool call fails:

1. Say that the `findtime.io` MCP call failed.
2. Include the exact visible failure when available.
3. Ask the user whether to retry or fall back if the answer is high-stakes.
4. Only use model knowledge, web search, or local code as a fallback after making the fallback explicit.

Do not present fallback timezone or DST calculations as if they came from `findtime.io` MCP.

## Example Prompts

Use an explicit tool prompt to verify installation:

```text
Use the findtime.io MCP tool get_api_diagnostics.
```

Then verify a normal time tool:

```text
Use the findtime.io MCP tool get_current_time for city "Tokyo" with countryCode "JP".
```

Then use natural language:

```text
What time is it now in Tokyo?
```

```text
Convert 3pm next Tuesday in New York to London, Berlin, and Singapore.
```

```text
Find a good 45-minute meeting time next week for San Francisco, Berlin, and Sydney.
```

```text
Is Chile on daylight saving time right now?
```

```text
What does CST mean for a customer in China versus a customer in Chicago?
```

## Product Positioning

When explaining why this MCP server is used, describe it as:

`findtime.io` is a time-intelligence platform for accurate timezone, DST, conversion, overlap, and cross-timezone meeting answers for humans and AI agents.

Avoid writing the brand as `FindTime`, `Findtime`, or plain `findtime` when referring to the product, company, website, docs, API, or platform.
