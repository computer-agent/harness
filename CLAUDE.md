# Masters Of AI Harness

## Related Docs

- **DESIGN.md** — overview with links to docs/
- **docs/** — architecture, agents, tools, configuration, sandbox, design decisions
- **CHANGELOG.md** — version history

## Quick Orientation

Standalone agent runtime built on top of the Claude Agent SDK. Two interfaces, one runtime:

- **Terminal TUI** — `mastersof-ai [--agent x]` — React/Ink, single user, local
- **Web UI** — `mastersof-ai --serve` — Fastify backend + React SPA frontend, multi-user, token auth

Both share agent loading, tools, sub-agents, sessions, and memory.

- TypeScript, runs via tsx (no build step for backend)
- Entry: `bin/mastersof-ai.js` → `src/index.tsx`
- Agent loading: `src/agent-context.ts` + `src/manifest.ts` (frontmatter) → `src/agent.ts`
- Tools: `src/tools/` — in-process MCP servers, one per domain
- Serve mode: `src/serve.ts` — Fastify HTTP/WS server (REST API + WebSocket streaming)
- Web frontend: `web/` — React + Vite + Tailwind SPA (deploys to Cloudflare Pages)
- A2A: `src/a2a/` — agent card generation, A2A protocol server/client
- TUI: `src/components/` — React/Ink (DO NOT TOUCH unless broken)
- Config: `~/.mastersof-ai/config.yaml`
- Auth (serve mode): `~/.mastersof-ai/access.yaml`

## Running Locally

```bash
npx tsx bin/mastersof-ai.js                         # TUI with default agent
npx tsx bin/mastersof-ai.js --agent researcher      # TUI with specific agent
npx tsx bin/mastersof-ai.js --serve                 # Web UI server on port 3200
npx tsx bin/mastersof-ai.js --serve --port 5000     # Web UI on custom port
npx tsx bin/mastersof-ai.js --agent researcher --sandbox  # Bubblewrap sandbox
npx tsx bin/mastersof-ai.js --card                  # Output Agent Card JSON
npx tsx bin/mastersof-ai.js --list-agents
```
