# Design Decisions

## Core

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Standalone | Reads format directly | Independence, simpler install, no coupling |
| Tools discovered at runtime | Agent adapts to harness | Portable definitions, no dep declarations |
| In-process MCP servers | One server per tool domain | No external processes, fast, simple |
| Config-driven tool enable/disable | `config.yaml` controls what's available | User controls their environment |
| tsx as runtime | No build step for JSX | Simpler than bundling React/Ink |
| `~/.mastersof-ai/` home dir | Global config + agents + state | Standard Unix convention |
| Memory as a tool | Not baked into core | Just another context source |
| Sub-agents as .md files (planned) | Same format as primary agents | Uniform, composable, portable |
| Bubblewrap sandbox | Optional `--sandbox` flag | Isolate agent filesystem access without Docker overhead |

## Dual-Interface Architecture

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Two interfaces, one runtime | TUI + Web UI share agent core | No code duplication; agent behavior is identical regardless of interface |
| Fastify for serve mode | Not Express (which is used only for A2A) | Typed, fast, native WebSocket + CORS support, async-first |
| WebSocket for streaming | Not SSE or polling | Bidirectional (interrupts, tool approvals), lower overhead, message replay on reconnect |
| Separate frontend SPA | `web/` dir, Vite + React, deploys independently | Frontend on CDN (Cloudflare Pages), backend on VPS — decoupled scaling |
| Token auth via access.yaml | SHA-256 hashed tokens, constant-time comparison | Simple, no external auth service, hot-reloadable, secure at rest |
| Per-user session isolation | Sessions stored under `sessions/{user}/` | No cross-user data leakage, supports per-user cost caps |
| Default port 3200 for serve | Not 3000 (common conflict) | Avoids collision with Vite dev server and other common services |

## Agent Definition

| Decision | Choice | Rationale |
|----------|--------|-----------|
| YAML frontmatter in IDENTITY.md | Optional metadata block, identity content untouched | Agent definition stays human-readable; structured data for tooling |
| Agent Card from IDENTITY.md | Parse H2 sections as skills | No separate card file to maintain — identity is the source of truth |
| Per-agent tool filtering | `tools.allow` / `tools.deny` in frontmatter | Agent authors control capabilities; enforced at server creation time |
| Per-agent MCP servers | `mcp` field in frontmatter with URI or command | Agents can bring external tools without global config changes |

## Agent Behavior

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Sub-agent scratchpad | Dedicated `.scratch/` tool, not workspace | Scoped access, path confinement, clear separation from workspace files |
| Verification hook | System prompt + canUseTool tracking | Dual approach — prompt sets expectations, hook enforces verify-after-write |
| Loop detection | canUseTool edit counter | Lightweight, resets on verification, configurable threshold |
| Compact success output | PostToolUse hook truncation | Keeps context clean — failures stay verbose, successes get summarized |

## A2A Protocol

| Decision | Choice | Rationale |
|----------|--------|-----------|
| A2A server as separate module | Express in `src/a2a/`, not merged into Fastify serve | A2A is a standard protocol with its own SDK; serve mode is a custom web backend |
| A2A client as MCP tool | `a2a_discover` / `a2a_call` / `a2a_list` | Agents call external agents the same way they use any tool — discoverable at runtime |

## Production (Serve Mode)

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Cost caps per user | Rolling window budgets (session, daily, monthly) | Prevents runaway costs; budget exceeded = blocked until window resets |
| Hot reload | File watcher on agents dir, config, access.yaml | No server restart needed for agent changes or access revocation |
| Graceful shutdown | 30s drain timeout, then force close | Active conversations complete cleanly; state is persisted before exit |
| LGPD compliance | Data export, deletion, consent tracking, retention cleanup | Required for Brazilian users; built into serve mode from the start |
