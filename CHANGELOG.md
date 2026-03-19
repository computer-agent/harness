# Changelog

All notable changes to the mastersof-ai harness.

## 2026-03-19

### Wave 5.1: Validation Sprint + Test Strengthening

- 49 new integration tests for IPC round-trip, worker lifecycle, frame sanitization, mutex contention, and env isolation
- Mock worker (`src/test-fixtures/mock-worker.ts`) speaks IPC protocol without SDK dependency
- Extracted `filterExecArgv()` and `buildWorkerEnv()` from worker-manager.ts so tests call production code instead of reimplementing logic inline
- Added `workerPath` constructor param for test injection
- Rewrote 5 tautological tests in session-worker; added 2 integration tests (SIGKILL+mutex, kill-on-resubscribe)
- 332 total tests, 0 failures, 5/5 flakiness runs clean

## 2026-03-18

### Security Hardening Waves 1–7

Seven waves of defense-in-depth security hardening, culminating in 282 passing tests and zero known critical vulnerabilities.

**Wave 1: Tier 0 Security** — Default bind to 127.0.0.1, shell env allowlist (`src/env-safety.ts`), SSRF URL validation (`src/url-safety.ts`), sandbox read-only mounts, API key hygiene.

**Wave 2: Credential Architecture + Egress** — CredentialStore with per-tool scoping (`src/credentials.ts`), egress domain filtering (`src/egress-proxy.ts`), headless `run` subcommand with runs.jsonl logging, per-user tool deny lists, canUseTool operation allowlists.

**Wave 4: Defense in Depth** — Content boundary tagging for prompt injection defense (`src/content-safety.ts`), SSRF hardening (IPv4-mapped IPv6, hex-short, decimal/octal/hex IP encoding, protocol restriction, redirect chaining), A2A server authentication, WS query param token deprecation, per-user logging.

**Wave 5: Process Isolation + Partner Onboarding** — Fork-per-session workers (`src/session-worker.ts`), IPC protocol (`src/ipc-protocol.ts`), worker lifecycle management (`src/worker-manager.ts`), per-user query serialization (`src/query-mutex.ts`), partner token generation. 15 review fixes: settled-flag race, IPC channel closed recursion, mutex FIFO ordering, fork bomb cap, IPC frame allowlist, execArgv sanitization, hashed rate limiter keys.

**Wave 6: Process Isolation Hardening** — Shared SDK stream processor (`src/sdk-stream.ts`), WebSocket message validation (`src/ws-protocol.ts`), mutex timeout, timing-safe token comparison, worker ready timeout, pending approval cleanup, configurable maxWorkers, worker pool health reporting.

**Wave 7: Review Hardening + Type Safety + Observability** — Exhaustive switch enforcement, Zod↔TypeScript type assertions, ALLOWED_FRAME_TYPES module extraction, safeSend wrapper, worker config minimization, WS schema tightening (content max, lastMessageId max), bounded health arrays, WorkerManager.getStats(), safeCompare JSDoc. CLI DX: `credentials check`, `access create`, `access rotate`, `status`, `preflight`, token rotation.

### Wave 8: Documentation + Deferred Hardening

- CLI subcommands extracted to `src/cli/` modules (index.tsx reduced from 753 to 161 lines)
- `WsClientMessage` type derived from Zod schema (single source of truth, no bidirectional assertion)
- Zero bare `ws.send(JSON.stringify(...))` calls in serve.ts — all use `safeSend`
- `isBufferableFrame()` runtime type guard replaces `as unknown as` casts in WS relay
- Security narrative documentation for external audit (`docs/security.md`)
- Architecture docs updated for all new modules

### Wave 8.1: Review Fixes (16 findings from 3 independent reviews)

**HIGH (3):**
- Dispatcher fall-through: converted independent `if` blocks to `if/else if` chain with `process.exit(0)` safety nets
- Frame allowlist-output: `sanitizeFrame()` constructs new objects with only known fields before relaying IPC frames to WebSocket — strips extra properties from compromised workers
- Removed `as any` casts in credential grant iteration — uses Zod-inferred `CredentialGrant` type from manifest.ts

**MEDIUM (7):**
- `safeSend` typed as `WsServerMessage` — protocol drift caught at compile time
- New `WsWarning`, `WsPong` types and `retryAfter?` on `WsError`
- `streamToStdout` uses `extractSdkEvent()` instead of raw `(msg as any).event` casts
- `safeClose()` wrapper for `ws.close()` at all call sites (auth failure, rate limit, idle timeout, shutdown)
- Unknown subcommands print usage error instead of silently launching TUI
- `--agents` flag warns on wildcard default (least-privilege)
- docs/security-model.md updated with Layers 9-10, process isolation details

**LOW (6):**
- `isBufferableFrame` moved to ipc-protocol.ts (co-located with `ALLOWED_FRAME_TYPES`)
- `access create --name` validated with `validateName` at creation time
- Dead `buildOptions` import removed from preflight.ts
- CLI subcommand examples added to CLAUDE.md
- `retryAfter?` added to `WsError` (covered by T05)
- Shared CLI context type deferred (not actionable at 10 modules)

## 2026-03-17

### Web UI: Serve Mode (Phases 1-4)

The harness now has a dual-interface architecture: the original terminal TUI for single-user iteration, and a web UI for multi-user remote access. Both share the same agent runtime, tools, and configuration.

**Phase 1: Frontmatter + Tool Filtering**
- IDENTITY.md files now support YAML frontmatter for agent metadata (name, description, icon, tags, starters, access control)
- Per-agent tool filtering via `tools.allow` / `tools.deny` in frontmatter
- Zod-validated `AgentManifest` type; `--list-agents` shows rich metadata
- 55 unit tests covering frontmatter parsing, tool filtering, and agent context

**Phase 2: Serve Mode Backend**
- `--serve` starts a Fastify HTTP/WebSocket server (default port 3200)
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
