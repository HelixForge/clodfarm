# Connect Claude Code on your computer (MCP)

The farm is a **remote MCP server**. Add it to Claude Code once, and the Claude on your laptop can:
- see the farm;
- hand work to it;
- talk to the farm's Claudes.

It does this without holding anyone's Claude login.

```bash
claude mcp add --transport http --scope user farm https://clod.farm/<team>/mcp     # or http://localhost:8080/mcp
```

Then run `/mcp` in Claude Code, pick **farm** and choose *Authenticate*. A browser page on the farm itself asks for:
- **being signed in to your Claude on the farm** in that browser (MY CLAUDE, with a code from "farm login");
- **a name for your computer**, for example `matan-laptop`;
- **what it may do:** see and work (the default), or only see.

Claude Code gets a token for this farm only. `clodfarm connect` on the farm prints the exact `claude mcp add` line.

## What your Claude Code can do

| Tool | Scope | |
|---|---|---|
| `farm_status` | read | the Claudes, each one's 5-hour and 7-day usage, room for sub-agents, what's running |
| `farm_budget` | read | every seat's usage windows and what the governor allows now |
| `farm_subagents` · `farm_result` | read | sub-agents; one sub-agent's prompt, result and runs (`wait_seconds` up to 45) |
| `farm_events` · `farm_sessions` · `farm_session` | read | the event log; every session and its conversation |
| `farm_inbox` · `farm_schedules` | read | messages the Claudes sent you; the schedules |
| `farm_spawn` | work | start a sub-agent: any Claude with budget runs it, or `on` picks one |
| `farm_msg` | work | message a Claude by name; it lands in its next turn |
| `farm_cancel` · `farm_retry` | work | stop or restart a sub-agent |
| `farm_schedule_add` · `farm_schedule_remove` | work | schedules (`cron` + `tz`, `every`, `at`) |

A connection can never:
- log Claudes in or out, release them, or pause the farm (those stay in the farm UI);
- read credentials.

Your computer is a **guest** on the farm, not a Claude, so it adds no budget and uses none. Its sub-agents run on the farm's Claudes, under the budget governor like any other. They show on the farm's own Claude's plot, marked `(for <name>)`. A farm Claude answers you with `clodfarm msg <name> "..."`, and you read the answer with `farm_inbox`.

## How it's secured

- **OAuth 2.1** with the MCP authorization flow:
  - protected-resource metadata (RFC 9728) and authorization-server metadata (RFC 8414);
  - dynamic client registration (RFC 7591);
  - **PKCE S256 only**; the authorization response carries `iss`.
- **Redirect addresses** must be loopback `http` (`localhost`, `127.0.0.1`, `::1`) or `https`, registered up front, and matched exactly. The farm never redirects an error to an unregistered address.
- **The consent page** is the farm's own:
  - it is signed against tampering (the form is bound to the exact request for 15 minutes);
  - it runs under a strict CSP;
  - it shares the UI's login lockout (5 wrong passwords in 5 minutes).

  A connection's name can't be a farm Claude's name, so a guest can never read a Claude's messages.
- **Tokens:**
  - access tokens last an hour and are bound to this farm's `/mcp` URL (RFC 8707);
  - refresh tokens last 30 days and **rotate**: using an old refresh token again ends the whole connection, since that means it was copied;
  - all of them are stored only as SHA-256 hashes, in `/workspace/.farm/mcp-auth.json` (mode 600).
- **The MCP endpoint** refuses browser requests from other origins (DNS rebinding) and answers `401` with a `WWW-Authenticate` challenge that points clients to the metadata.

`clodfarm connections` lists what's connected (name, scope, client, last use). `clodfarm disconnect ID` ends one at once. Signing in and ending a connection are both in `clodfarm events` (`mcp.connected`, `mcp.disconnected`).

## Behind a proxy

Claude Code must reach the farm over HTTPS (or `localhost`). Behind a reverse proxy, set:
- `FARM_UI_BASE` for a path prefix;
- `FARM_PUBLIC_URL` to the URL people use, e.g. `https://clod.farm/team`, when the proxy rewrites `Host` (CloudFront does).

The farm answers the discovery documents both under its prefix and at the root, path-inserted as RFC 8414 and 9728 put them:
- `/.well-known/oauth-authorization-server/<prefix>`
- `/.well-known/oauth-protected-resource/<prefix>/mcp`

So route those root paths to the farm too. The proxy must pass the `Authorization` header through.
