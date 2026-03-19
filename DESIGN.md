# Masters Of AI Harness -- Design

Agent runtime with full system prompt control. Two interfaces, one core.

```
Terminal TUI:  mastersof-ai [--agent x]           Single user, local, React/Ink
Web UI:        mastersof-ai --serve [--port 3200] Multi-user, token auth, Fastify + React SPA
```

Both share: agent loading, IDENTITY.md parsing, Claude Agent SDK, MCP tools, sub-agents, sessions, memory.

## Architecture at a Glance

```
IDENTITY.md --> System prompt assembly --> Claude Agent SDK (query/streaming)
                     |                          |
                 MCP tools (9 domains)    Sub-agents (researcher,
                 External MCP servers      deep-thinker, writer)
                     |
              +------+------+
              |             |
           TUI mode    Serve mode
           React/Ink   Fastify + React SPA
                       Token auth, rate limits,
                       per-user isolation,
                       cost caps, hot reload

Security layers (Waves 1-7):

  Inbound          Runtime               Outbound
  --------         --------              ---------
  rate-limit.ts    env-safety.ts         egress-proxy.ts
  ws-protocol.ts   content-safety.ts     url-safety.ts (SSRF)
  query-mutex.ts   credentials.ts        cost.ts (budgets)
                   privacy.ts (LGPD)

  Process isolation              Observability
  ------------------             -------------
  ipc-protocol.ts                health.ts
  session-worker.ts              sdk-stream.ts
  worker-manager.ts
```

## Key Files

| What | Where |
|------|-------|
| Entry point | `bin/mastersof-ai.js` --> `src/index.tsx` |
| Agent loading | `src/agent-context.ts` + `src/manifest.ts` |
| System prompt + SDK | `src/agent.ts` |
| MCP tool servers | `src/tools/` (one file per domain) |
| Sub-agents | `src/agents/` (researcher, deep-thinker, writer) |
| Serve backend | `src/serve.ts` (Fastify REST + WebSocket) |
| Web frontend | `web/src/` (React + Vite + Tailwind SPA) |
| A2A protocol | `src/a2a/` (server, client tools, agent cards) |
| TUI | `src/components/` (React/Ink -- do not touch unless broken) |
| Config | `~/.mastersof-ai/config.yaml` |
| Auth | `~/.mastersof-ai/access.yaml` |
| Security | `src/env-safety.ts`, `src/url-safety.ts`, `src/content-safety.ts` |
| Credentials | `src/credentials.ts` + `src/egress-proxy.ts` |
| Process isolation | `src/ipc-protocol.ts`, `src/session-worker.ts`, `src/worker-manager.ts` |
| WS protocol | `src/ws-protocol.ts`, `src/sdk-stream.ts`, `src/query-mutex.ts` |
| Health/observability | `src/health.ts`, `src/rate-limit.ts`, `src/cost.ts` |
| Privacy | `src/privacy.ts` (LGPD compliance) |
| CLI subcommands | `src/cli/` — modular command handlers |

## Docs

Detailed documentation for each area:

- **[Architecture](docs/architecture.md)** -- Dual-interface model, data flow, source map, tech stack
- **[Agents](docs/agents.md)** -- Creating agents, IDENTITY.md frontmatter, sub-agents, best practices
- **[Memory](docs/memory.md)** -- Persistent memory system, auto-loaded context, memory tools
- **[Tools](docs/tools.md)** -- Tool system, available tools, scratchpad, A2A client, MCP tool search
- **[Configuration](docs/configuration.md)** -- Config file, serve mode, access control, rate limits, privacy
- **[Secrets](docs/secrets.md)** -- Per-agent encrypted secrets via dotenvx
- **[Sandbox](docs/sandbox.md)** -- Bubblewrap isolation, per-agent config
- **[Security](docs/security.md)** -- Security narrative, threat model, hardening layers
- **[Design Decisions](docs/design-decisions.md)** -- Rationale for key choices
- **[Changelog](CHANGELOG.md)** -- Version history and notable changes

## Running Locally

```bash
npx tsx bin/mastersof-ai.js                         # TUI with default agent
npx tsx bin/mastersof-ai.js --agent analyst          # TUI with specific agent
npx tsx bin/mastersof-ai.js --serve                  # Web server on port 3200
npx tsx bin/mastersof-ai.js --serve --port 5000      # Custom port
npx tsx bin/mastersof-ai.js --agent analyst --sandbox # Bubblewrap sandbox
npx tsx bin/mastersof-ai.js --card                   # Output Agent Card JSON
npx tsx bin/mastersof-ai.js --list-agents            # List all agents

# CLI subcommands (Wave 8)
npx tsx bin/mastersof-ai.js run <agent> "message"     # Headless execution
npx tsx bin/mastersof-ai.js credentials check --agent x # Check credential config
npx tsx bin/mastersof-ai.js access create --name x      # Generate access token
npx tsx bin/mastersof-ai.js preflight --agent x         # Validate agent config
npx tsx bin/mastersof-ai.js status <agent>              # Recent run history
```
