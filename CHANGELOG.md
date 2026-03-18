# Changelog

All notable changes to the mastersof-ai harness.

## 2026-03-17

### Web UI: Serve Mode (Phases 1-4)

The harness now has a dual-interface architecture: the original terminal TUI for single-user iteration, and a web UI for multi-user remote access. Both share the same agent runtime, tools, and configuration.

**Phase 1: Frontmatter + Tool Filtering**
- IDENTITY.md files now support YAML frontmatter for agent metadata (name, description, icon, tags, starters, access control)
- Per-agent tool filtering via `tools.allow` / `tools.deny` in frontmatter
- Zod-validated `AgentManifest` type; `--list-agents` shows rich metadata
- 55 unit tests covering frontmatter parsing, tool filtering, and agent context

**Phase 2: Serve Mode Backend**
- `--serve` starts a Fastify HTTP/WebSocket server (default port 3100)
- REST API: agent roster, session CRUD, usage tracking
- WebSocket: real-time streaming (text tokens, thinking tokens, tool calls, sub-agent progress)
- Token-based authentication via `~/.mastersof-ai/access.yaml` (SHA-256 hashed tokens)
- Per-user session isolation and message persistence

**Phase 3: Web Frontend SPA**
- React + Vite + Tailwind CSS + Radix UI frontend in `web/`
- Agent card grid, conversation sidebar, streaming chat panel
- Tool call display with collapsible blocks and approval flow
- @mention autocomplete for agent switching
- Dark mode, i18n (English + Portuguese), voice input (Web Speech API)
- WebSocket reconnection with message replay
- Deploys to Cloudflare Pages (`wrangler pages deploy`)

**Phase 4A: Security Foundation**
- Mandatory remote sandbox for serve mode sessions
- Per-user workspace isolation (`workspace/{user}/`)
- Shell policy enforcement (requires both `tools.allow` + `sandbox.enforce`)
- Rate limiting (per-user message rate, connection limits, auth failure throttling)
- CORS origin validation (configurable allowlist, localhost in dev)

**Phase 4B: Production Hardening**
- Per-agent external MCP servers (URI and command-based, via `mcp` frontmatter field)
- Per-user token budgets with rolling windows (session, daily, monthly limits)
- Health monitoring (`/health` shallow + `/health/deep` admin endpoints)
- Hot reload: file watcher on agents dir, config, and access.yaml; broadcasts roster updates to connected clients
- LGPD compliance: data export, deletion, consent tracking, retention policies
- Graceful shutdown with 30s connection draining
- Structured logging with configurable levels

### A2A Protocol Integration

- A2A server module (`src/a2a/`) with Agent Card generation from IDENTITY.md
- `--card` flag outputs Agent Card JSON derived from identity H2 sections
- A2A client tools: `a2a_discover`, `a2a_call`, `a2a_list` for calling remote A2A agents
- AgentExecutor bridge connecting A2A task lifecycle to harness `sendMessage()` flow

### Code Quality

- 17 code review fixes: CORS security, state management, component quality
- Path traversal hardening, error handling improvements, cancellation support

## 2026-03-16

### Dependencies + Bug Fixes

- SDK upgraded to @anthropic-ai/claude-agent-sdk ^0.2.76
- Fixed `model_query` text extraction from response blocks
- npm audit fix + dependency upgrades

## 2026-03-13 — v0.1.5

### Runtime Upgrades

- SDK upgraded to ^0.2.75; switched to Opus 4.6 with 1M context window
- Default effort level changed from `high` to `max`
- New TUI commands: `/help`, `/effort [level]`, `/model [model-id]`

## 2026-03-11

### Error Handling

- Error classification system with actionable diagnostics for API/auth failures
- Structured error categories surfaced to user with fix instructions

## 2026-03-05

### Security + SDK

- Security audit: path traversal fixes, shell injection hardening, deprecated thinking config removal
- SDK upgraded to ^0.2.69; InstructionsLoaded hook, sub-agent token tracking
- Smart `web_fetch`: CSS error suppression, query-based content extraction

## 2026-03-04 — v0.1.2, v0.1.1

### Stability

- Pre-flight auth check before starting agent (validates credentials early)
- Sandbox changed to opt-in (`--sandbox`) instead of default-on
- Linux install documentation added
- Home/End/Delete key fixes in TUI

## 2026-02-26

### npm Package + SDK

- Prepared repo for GitHub publish as `@mastersof-ai/harness`
- SDK upgraded to 0.2.62; MCP tool search auto-enabled for large tool sets
- Memory system documentation added
- Auto-resume most recent session for bare `--resume` flag
- Biome lint/format fixes across codebase

## 2026-02-25

### Foundation

- Agent workspace directories (`~/.mastersof-ai/agents/<name>/workspace/`)
- Bubblewrap sandbox with per-agent configuration
- `current_time` tool
- Context bar visibility improvements for dark terminals
