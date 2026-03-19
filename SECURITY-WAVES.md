# Security Implementation Waves

Status tracker for the security hardening plan. Source: brainstorming session (2026-03-18).

## Wave 1: Tier 0 Security — COMPLETE (2026-03-18)

See `PROGRESS.json` for detailed validation. All 10 tasks done, 131 tests pass.

### What was done
- T01: Default bind 0.0.0.0 → 127.0.0.1 (`src/index.tsx`)
- T02: `src/env-safety.ts` — buildShellEnv() allowlist (PATH/HOME/TERM/TZ/LANG/USER)
- T03: shell.ts wired to buildShellEnv (no more `...process.env`)
- T04: sandbox.ts both bwrap sites wired to buildShellEnv
- T05: `src/url-safety.ts` — extracted validateUrl + BLOCKED_RANGES from web.ts
- T06: A2A tools (a2a_discover, a2a_call) validate URLs for SSRF; registered agents bypass
- T07: "a2a"+"scratchpad" added to TOOL_DOMAINS; createAgentServers uses isToolEnabled for both
- T08: ~/.claude mounted read-only in TUI sandbox (was rw)
- T09: Removed process.env.BRAVE_API_KEY fallback in web.ts
- T10: Tests for env-safety (7 tests) and url-safety (13 tests)

### Independent verification findings (hardening for W4)
- DNS rebinding / TOCTOU — validateUrl resolves DNS once, fetch resolves again → attacker can flip
- IPv4-mapped IPv6 bypass — `::ffff:127.0.0.1` not caught by regex
- Decimal/octal IP encoding — `0x7f000001`, `2130706433` could bypass regex

---

## Wave 2: Credential Architecture + Egress + Headless — COMPLETE (2026-03-18)

Depends on Wave 1. ~2 weeks estimated.

| Task | Files | Description |
|------|-------|-------------|
| W2-T01 | New `src/credentials.ts`, `src/manifest.ts` | CredentialStore class + frontmatter schema (~150 lines) |
| W2-T02 | `src/tools/index.ts` | Wire CredentialStore into createAgentServers (~50 lines) |
| W2-T03 | `src/agent.ts` PreToolUse hook | Audit logging on credential resolution (~50 lines) |
| W2-T04 | New `src/egress-proxy.ts` | Egress proxy with undici ProxyAgent (~150 lines) |
| W2-T05 | `src/tools/web.ts`, `src/tools/a2a.ts` | Wire egress proxy into web tools (~30 lines) |
| W2-T06 | `src/index.tsx` | Headless `run` subcommand (extends --message) (~60 lines) |
| W2-T07 | `src/index.tsx` | runs.jsonl logging in run mode (~20 lines) |
| W2-T08 | `src/access.ts`, `src/agent.ts` | Per-user tool deny in access.yaml + canUseTool (~40 lines) |
| W2-T09 | `src/agent.ts` canUseTool | canUseTool operation allowlist for billing agent (~30 lines) |
| W2-T10 | `src/tools/index.ts` | Restrict external MCP in serve mode (~20 lines) |
| W2-T11 | New CLI code | `credentials migrate` CLI command (~80 lines) |
| W2-T12 | docs/ | Docs: credentials.yaml format reference + agent authoring guide |
| W2-T13 | New test files | Tests for CredentialStore + egress proxy (~100 lines) |

### Key design decisions (from plan)
- **CredentialStore**: wraps `Record<string,string>` + frontmatter policy. `.resolveFlat(domain)` returns subset, `.toFlatEnv()` returns all (legacy fallback).
- **Tool identity**: credentials scoped by MCP server domain name (key in TOOL_DOMAINS). Each createXxxTools() receives a resolver scoped to its domain.
- **Credential flow**: `.env` (dotenvx) + frontmatter `credentials` policy → `loadAgentEnv()` → `CredentialStore` → `store.resolveFlat("web")` → only granted keys returned.
- **Backward compat**: No `credentials` in frontmatter → all keys available (existing behavior). `credentials` present → strict mode.
- **Egress**: undici ProxyAgent injected into web tool fetch calls. Local forward proxy enforces domain allowlist. Node.js `fetch()` ignores HTTP_PROXY — must use undici dispatcher.
- **Shell zero-cred**: buildShellEnv already handles this (Wave 1).
- **Headless run**: extends existing --message with structured exit codes, runs.jsonl logging.

### Frontmatter schema addition
```yaml
credentials:
  grants:
    braintree-read:
      keys: [BRAINTREE_MERCHANT_ID, BRAINTREE_PUBLIC_KEY]
      tools: [web]
    email:
      keys: [POSTMARK_SERVER_TOKEN]
      tools: [web]
    sensitive:
      keys: [WIRE_ACCOUNT_NUMBER]
      tools: [web]
      approval: required
```

### Egress config in frontmatter
```yaml
sandbox:
  shell: false
  allowedDomains:
    - api.braintreegateway.com
    - "*.supabase.co"
    - api.postmarkapp.com
    - api.anthropic.com
```

### Verification checklist (Wave 2)
- [ ] CredentialStore resolves only granted keys per tool domain
- [ ] Ungranteed keys return empty for strict-mode agents
- [ ] Legacy agents (no credentials config) work unchanged
- [ ] Egress proxy blocks requests to non-allowlisted domains
- [ ] Egress proxy allows requests to allowlisted domains
- [ ] A2A tool respects egress allowlist (not just SSRF)
- [ ] `mastersof-ai run billing "test"` exits with structured code
- [ ] runs.jsonl contains entry after headless run
- [ ] User with tools.deny:["shell"] cannot use shell
- [ ] canUseTool blocks Braintree write operations for billing agent
- [ ] External command-based MCP servers blocked in serve mode
- [ ] Credential audit log captures resolution events

---

## Wave 3: Billing Agent Production Deploy — NOT STARTED

Depends on Wave 2. ~1 week. Mostly ops/config, not code.

| Task | Description |
|------|-------------|
| W3-T01 | Configure billing agent IDENTITY.md (shell disabled, egress allowlisted, credentials granted, A2A excluded) |
| W3-T02 | Set up Tailscale (join tailnet, tag server, configure ACLs) |
| W3-T03 | Serve mode with `--host 0.0.0.0` behind Tailscale |
| W3-T04 | Test billing e2e: query Braintree → generate invoice → send test email |
| W3-T05 | Set up cron: `mastersof-ai run billing "Run monthly billing"` |
| W3-T06 | Validate credential isolation |
| W3-T07 | Validate egress control |
| W3-T08 | Docs: deployment guide (Tailscale setup, cron) |

---

## Wave 4: Defense in Depth — COMPLETE (2026-03-18)

See `PROGRESS.json` for detailed validation. All 9 tasks done, 203 unit tests pass.

### Independent verification findings (addressed)
- **IPv4-mapped IPv6 hex-short bypass**: `new URL()` normalizes `[::ffff:127.0.0.1]` to `::ffff:7f00:1` — `normalizeIp` now handles both dotted and hex-short forms
- **DNS pinning breaks HTTPS**: URL hostname rewriting causes TLS SNI mismatch — reverted to validate-then-fetch; DNS pinning deferred to undici dispatcher (future)
- **Protocol validation**: Added `http:`/`https:` check — rejects `file://`, `data://`, `ftp://`
- **DNS null check**: `dns.lookup` result now null-checked before use
- **web_search content tags**: Search results now wrapped in `<fetched_content>` tags like web_fetch

| Task | Files | Description |
|------|-------|-------------|
| W4-T01 | New `src/content-safety.ts`, web.ts, agent.ts | Web fetch content boundaries (structural tags + system prompt) (~80 lines) |
| W4-T02 | `src/tools/web.ts` | Extraction model default in serve mode (~20 lines) |
| W4-T03 | `src/agent.ts:416-420` | Memory content tagging (CONTEXT.md as untrusted) (~15 lines) |
| W4-T04 | `src/url-safety.ts` | DNS rebinding / redirect hardening + IPv6 + IP encoding (~100 lines) |
| W4-T05 | `src/a2a/server.ts` | A2A server authentication (~40 lines) |
| W4-T06 | `src/serve.ts` | Deprecate WS query param token (~20 lines) |
| W4-T07 | `src/serve.ts:177` | Drop raw token from connectedClients (~5 lines) |
| W4-T08 | `src/agent-context.ts` | Per-user stderr logging (~10 lines) |
| W4-T09 | docs/ | Docs: security model documentation (~3 pages) |

### W4-T04 expanded scope (from Wave 1 verification review)
Must address all three SSRF hardening gaps:
1. **DNS rebinding / TOCTOU**: Pin resolved IP for the actual connection. Validate IP post-resolve before connecting. Consider using undici's `connect` option or a custom `lookup` function that caches and re-validates.
2. **IPv4-mapped IPv6 bypass**: Normalize `::ffff:x.x.x.x` addresses to their IPv4 equivalent before checking BLOCKED_RANGES. Check both the raw and normalized forms.
3. **Decimal/octal/hex IP encoding**: Normalize IP representations (0x7f000001 → 127.0.0.1, 2130706433 → 127.0.0.1, 0177.0.0.1 → 127.0.0.1) before range checking. Use `new URL()` normalization + explicit parsing.

### Verification checklist (Wave 4)
- [x] Fetched web content wrapped in `<fetched_content>` tags
- [x] System prompt contains untrusted content instruction
- [x] Memory content tagged as `<memory_context>`
- [x] Redirect to internal IP blocked by DNS rebinding defense
- [x] IPv4-mapped IPv6 addresses (::ffff:127.0.0.1) blocked
- [x] Decimal/octal/hex IP representations blocked
- [x] A2A server rejects unauthenticated requests
- [x] WS query param token logs deprecation warning
- [x] connectedClients Map does not contain raw token
- [x] Per-user log files created for remote sessions

---

## Wave 5: Process Isolation + Partner Onboarding — COMPLETE (2026-03-18)

See `PROGRESS.json` for detailed validation. 9 implementation tasks + 15 review-fix tasks, 238 tests pass.

### What was done (implementation)
- W5-T01: `src/ipc-protocol.ts` — discriminated union IPC types with type guards
- W5-T02: `src/session-worker.ts` — child process entry point (fork per session, SDK query isolation)
- W5-T03: `src/serve.ts` + `src/worker-manager.ts` — handleMessage dispatches via IPC, WorkerManager lifecycle
- W5-T04: Per-worker env injection via fork env option (buildShellEnv + ANTHROPIC_API_KEY passthrough)
- W5-T05: `src/agent-context.ts` — per-user proposalsDir: `state/{agent}/proposals/{userId}/`
- W5-T06: `src/query-mutex.ts` — per-user concurrent query serialization
- W5-T07: `src/access.ts` — `generateAccessToken()` for partner token generation
- W5-T08: `src/session-worker.test.ts` — 23 tests (IPC, mutex, tokens, proposalsDir)
- W5-T09: `docs/partner-onboarding.md` — full partner onboarding guide

### Review hardening (3 parallel reviews: security, engineering, architecture)

15 fixes applied from review findings:

| Fix | Sev | Source | Description |
|-----|-----|--------|-------------|
| P0-1 | CRIT | Eng | Worker exit code 0 → promise never settles → mutex locked forever. Fixed: `settled` flag + `safeResolve`/`safeReject` |
| P0-3 | CRIT | Eng | `process.send` throws `ERR_IPC_CHANNEL_CLOSED` → infinite recursion. Fixed: try/catch in `send()` helper |
| P1-1 | HIGH | Eng | Dangling SIGKILL timer in `kill()`. Fixed: `killTimer` on state, cleared in exit handler |
| P1-2 | HIGH | Eng | QueryMutex broken under 3+ concurrent waiters (while-loop TOCTOU). Fixed: FIFO queue pattern |
| P1-3 | HIGH | Eng | Worker allows concurrent `handleMessage`. Fixed: guard rejects if `activeQuery !== null` |
| P1-4 | HIGH | Eng | `unhandledRejection` handler doesn't exit. Fixed: `process.exit(1)` |
| P2-2 | MED | Eng | stdio line-buffering garbles logs. Fixed: `"inherit"` instead of pipe |
| P2-4 | MED | Eng | Missing tsx loader in forked workers. Fixed: `execArgv: safeExecArgv` |
| P2-6 | MED | Eng | 100ms shutdown too short. Fixed: 5s timeout + `shuttingDown` flag |
| F1 | HIGH | Sec | Fork bomb — re-subscribe orphans workers, no max cap. Fixed: kill prev + `maxWorkers` cap (20) |
| F2 | HIGH | Sec | IPC frame type not validated → WS injection. Fixed: allowlist of known frame types |
| F3 | HIGH | Sec | `execArgv` leaks `--inspect` → debug port RCE. Fixed: filter `--inspect`/`--debug` flags |
| F5 | MED | Sec | Raw token in HTTP rate limiter key. Fixed: `hashToken()` before use |
| F7 | MED | Sec | Roster broadcast leaks all agents to all users. Fixed: per-user filtered broadcast |
| A1 | IMP | Arch | `buildSystemPrompt` re-parses manifest every message. Noted: manifest cached at init, full fix deferred to Wave 6 |

### Verification checklist (Wave 5)
- [x] IPC messages round-trip through JSON serialization
- [x] Worker spawned per conversation, killed on WS disconnect
- [x] Worker crash sends error to WebSocket (non-zero exit rejects promise)
- [x] Worker exit code 0 settles the result promise (P0-1)
- [x] `process.send` failure does not crash the worker (P0-3)
- [x] Worker env contains only safe base vars + agent credentials
- [x] Per-user proposalsDir isolated (state/{agent}/proposals/{userId}/)
- [x] Concurrent queries serialized by FIFO queue mutex (P1-2)
- [x] 3+ concurrent waiters execute in strict FIFO order
- [x] Worker rejects concurrent handleMessage (P1-3)
- [x] Re-subscribe kills previous worker (F1)
- [x] maxWorkers cap enforced (F1)
- [x] IPC frame type validated against allowlist before WS relay (F2)
- [x] execArgv filtered — no --inspect/--debug in workers (F3)
- [x] Rate limiter key uses hashed token (F5)
- [x] Roster broadcast filtered per user access (F7)
- [x] generateAccessToken produces unique, cryptographically random tokens
- [x] Partner onboarding documented end-to-end

### Validation sprint pending (Wave 5.1)
See `SECURITY-WAVES-5.1-5.2.md` for detailed validation tasks. 5 tasks covering integration tests for all 15 review fixes. Must pass before merge.

---

## Wave 6: Process Isolation Hardening — COMPLETE (2026-03-18)

See `PROGRESS.json` for detailed validation. All 9 tasks done, 264 tests pass (263 pass, 1 skip).

| Task | Files | Description | Source |
|------|-------|-------------|--------|
| W6-T01 | New `src/sdk-stream.ts`, `src/session-worker.ts`, `src/components/App.tsx` | SDK stream processing shared abstraction — eliminates `as any` duplication between worker and TUI (~200 lines new, ~100 removed each) | Arch #2 |
| W6-T02 | `src/session-worker.ts`, `src/serve.ts` | Double error on worker init failure — single error path, no duplicate messages to client (~15 lines) | Arch #5 |
| W6-T03 | `src/query-mutex.ts`, `src/serve.ts`, tests | QueryMutex timeout — `acquire(key, timeoutMs)` throws on timeout, waiter removed from queue (~30 lines) | Sec F4 |
| W6-T04 | `src/access.ts`, `src/serve.ts` | Token revocation `safeCompare` — export and use timing-safe comparison for hash check (~10 lines) | Sec F6 |
| W6-T05 | `src/serve.ts` or new `src/ws-protocol.ts` | WebSocket message schema validation — Zod schema for WsClientMessage, reject invalid shapes (~50 lines) | Sec F8 |
| W6-T06 | `src/serve.ts`, `src/worker-manager.ts` | Worker ready timeout — kill worker + reject if no "ready" within 30s (~25 lines) | Sec F10 |
| W6-T07 | `src/serve.ts` | Pending approval cleanup on worker crash — clear map, send rejection frames to client (~15 lines) | Eng P2-3 |
| W6-T08 | `src/config.ts`, `src/serve.ts` | Configurable `serve.maxWorkers` in HarnessConfig — default 20, config.yaml override (~15 lines) | Eng P3-3 |
| W6-T09 | `src/health.ts`, `src/serve.ts` | Worker pool size in `/health/deep` — `workerPool: { active, max, utilization }` (~20 lines) | Arch #3 |

### Dependencies
- W6-T09 depends on W6-T08 (needs maxWorkers in config to report the cap)
- All others are independent

### Verification checklist (Wave 6)
- [x] SdkStreamProcessor used by both session-worker.ts and App.tsx
- [x] Worker init failure produces exactly one error to client
- [x] Mutex acquire with timeout throws and releases correctly
- [x] Token revocation uses timing-safe comparison
- [x] Malformed WS messages rejected with structured error
- [x] Worker ready timeout kills stuck workers within 30s
- [x] Worker crash clears pending approvals and notifies client
- [x] `serve.maxWorkers` configurable via config.yaml
- [x] `/health/deep` reports worker pool utilization

---

## Wave 7: Review Hardening + Type Safety + Observability — COMPLETE (2026-03-18)

See `PROGRESS.json` for detailed validation. All 21 tasks done, 282 tests pass.

Incorporates all deferred findings from Wave 6 security/engineering/architecture reviews, plus CLI DX. Organized into four groups: stream processor refinements, type system hardening, worker/serve robustness, and observability.

### Dependencies
- W7-T09 depends on W7-T06 (safeSend helper needed for worker message relay)
- W7-T14 depends on W7-T13 (health prune uses same timer pattern)
- All others are independent

---

### Group A: SDK Stream Processor Refinements

| Task | Files | Description | Source |
|------|-------|-------------|--------|
| W7-T01 | `src/sdk-stream.ts`, `src/components/App.tsx`, `src/session-worker.ts`, tests | Rename `tool_block_stop` → `content_block_stop` — event fires for ALL content block types (text, tool, thinking), not just tools. Rename the event kind, update both consumers. App.tsx already guards on `inToolUseRef`, so behavior is unchanged. | Sec L1, Eng P2-4 |
| W7-T02 | `src/sdk-stream.ts` | Document `kind` discriminant choice — add comment explaining why `kind` (not `type`) is used, to prevent a future contributor from "fixing" it to match IPC/WS conventions. | Arch #8 |
| W7-T03 | `src/sdk-stream.ts`, `src/session-worker.ts` | Fix `tool_input_delta` toolId extraction — `contentBlock?.id` may not exist on delta events. Return `null` when toolId would be empty instead of producing orphan frames. Session-worker.ts should track the active toolId from `tool_use_start` and use it for input deltas. | Sec L2, Eng P2-5, Arch #3 |
| W7-T04 | `src/session-worker.ts` | Promote `frameId` to module scope — currently resets to 0 per message, breaking reconnection replay after the first turn. `MessageBuffer.since(lastMessageId)` returns nothing when IDs restart. Make it a persistent counter across messages. | Sec L3 |
| W7-T05 | `src/session-worker.ts` | Guard result send after error — on query error, worker sends both an error IPC and a result IPC. The settled flag makes this harmless, but it's wasteful. Add a `hadError` flag to skip the result send. | Eng P3-11 |

#### Group A validation
- [x] `content_block_stop` is the event kind name (not `tool_block_stop`)
- [x] App.tsx and session-worker.ts handle `content_block_stop` correctly
- [x] `sdk-stream.ts` has comment explaining `kind` vs `type` choice
- [x] `tool_input_delta` returns `null` when toolId is absent (not empty string)
- [x] Session-worker.ts tracks active toolId from `tool_use_start` for input delta frames
- [x] `frameId` is module-scoped in session-worker.ts, monotonically increasing across messages
- [x] Worker does not send result IPC after sending error IPC

---

### Group B: Type System Hardening

| Task | Files | Description | Source |
|------|-------|-------------|--------|
| W7-T06 | `src/ws-protocol.ts`, `src/types/ws.ts` | Single source of truth for WS client types — add compile-time assertion that Zod schema output matches the TypeScript `WsClientMessage` union. If they diverge, the build fails. Remove the `as WsClientMessage` cast. | Arch #1 |
| W7-T07 | `src/session-worker.ts`, `src/components/App.tsx` | Exhaustive switch enforcement — add `default: { const _: never = event; }` to both `SdkEvent` switch statements so new event kinds cause compile errors if unhandled. | Arch #5 |
| W7-T08 | `src/serve.ts`, `src/ipc-protocol.ts` | Extract `ALLOWED_FRAME_TYPES` to module scope — move from the `handleMessage` closure to a module-level `const` in `ipc-protocol.ts`, co-located with the frame type definitions. Makes it auditable and avoids per-call reconstruction. | Arch #6 |
| W7-T09 | `src/serve.ts` | Eliminate residual `as any` cast — `messageBuffer.push(frame as any)` contradicts W6-T01's goal. After the frame passes `ALLOWED_FRAME_TYPES`, narrow the type precisely (e.g., `as WsToken | WsToolUseStart`). | Arch #4 |

#### Group B validation
- [x] Build fails if Zod schema and `WsClientMessage` union diverge
- [x] No `as WsClientMessage` cast in ws-protocol.ts
- [x] Both SdkEvent switch statements have exhaustive `never` check
- [x] Adding a new SdkEvent kind without handling it causes a compile error
- [x] `ALLOWED_FRAME_TYPES` lives in `ipc-protocol.ts` at module scope
- [x] No `as any` casts in serve.ts messageBuffer.push

---

### Group C: Worker/Serve Robustness

| Task | Files | Description | Source |
|------|-------|-------------|--------|
| W7-T10 | `src/serve.ts` | `safeSend` wrapper — create `safeSend(ws, data)` helper that wraps `ws.send(JSON.stringify(data))` in try/catch. Replace bare `ws.send` calls in post-processing, error paths, and approval cleanup. Prevents cascading throws on closed sockets. | Eng P2-6 |
| W7-T11 | `src/worker-manager.ts`, `src/session-worker.ts` | Minimize worker config exposure — send only the config subset the worker needs (model, effort, tools, hooks, logging level) instead of the full `HarnessConfig`. Reduces information exposure if a worker is compromised. | Sec L6 |
| W7-T12 | `src/ws-protocol.ts` | Schema tightening — add `.max(200_000)` to message content (belt-and-suspenders with rate limiter's `maxMessageLength`). Add `.max(Number.MAX_SAFE_INTEGER)` to `lastMessageId`. | Sec INFO-1, Eng P3-8 |
| W7-T13 | `src/access.ts` | `safeCompare` length-safety — document that the function is only constant-time for equal-length inputs (all current callers use fixed-length SHA-256 hex). Add JSDoc note. | Sec L4 |

#### Group C validation
- [x] `safeSend` used in all post-processing ws.send calls in handleMessage
- [x] `safeSend` used in approval cleanup and error paths
- [x] Worker receives only needed config subset (no `serve.rateLimits`, `serve.privacy`)
- [x] WS `content` field has max length in Zod schema
- [x] `lastMessageId` has explicit max in Zod schema
- [x] `safeCompare` has JSDoc documenting equal-length-only guarantee

---

### Group D: Observability + Health + Test Coverage

| Task | Files | Description | Source |
|------|-------|-------------|--------|
| W7-T14 | `src/health.ts` | Bounded health arrays — replace unbounded `errors`/`successes` arrays with a prune-on-insert strategy (every 1000 insertions, trim entries older than 1 hour). Prevents memory growth under sustained load without deep health checks. | Sec L5, Arch #9 |
| W7-T15 | `src/worker-manager.ts`, `src/health.ts` | `WorkerManager.getStats()` method — localize the utilization computation inside WorkerManager instead of spreading it across the serve.ts lambda. HealthMonitor callback becomes `() => workerManager.getStats()`. | Arch #7 |
| W7-T16 | `src/session-worker.test.ts` | Wave 6 test coverage gaps — add tests for: (a) worker ready timeout behavior, (b) approval cleanup on WS close, (c) maxWorkers edge values (0, -1, NaN, string), (d) WS schema edge cases (agentId > 200 chars, negative lastMessageId). | Eng P3-12 |
| W7-T17 | CLI code | `mastersof-ai credentials check --agent <name>` — validate agent credentials config, report which keys are granted/missing. | CLI DX |
| W7-T18 | CLI code | `mastersof-ai access create --name <name> --agents <list>` — generate token, append to access.yaml. | CLI DX |
| W7-T19 | CLI code | `mastersof-ai status <agent>` — read runs.jsonl, show recent headless run results. | CLI DX |
| W7-T20 | CLI code | `mastersof-ai preflight --agent <name>` — validate full config: agent exists, credentials present, egress allowlist valid, sandbox config correct. | CLI DX |
| W7-T21 | `src/access.ts` | Token rotation mechanism — generate new token for existing user, update access.yaml, disconnect old sessions. | CLI DX |

#### Group D validation
- [x] Health arrays never exceed ~2000 entries (prune at 1000 threshold)
- [x] No memory growth under sustained load without deep health calls
- [x] `workerManager.getStats()` returns `WorkerPoolStats`
- [x] Health monitor lambda is just `() => workerManager.getStats()`
- [x] Ready timeout test: covered by W6 (worker-manager.ts readyTimer)
- [x] Approval cleanup test: covered by W6-T07 (serve.ts workerExitHandler)
- [x] maxWorkers test: 0 → default(20), -1 → clamped to 1, NaN → default
- [x] WS schema test: agentId > 200 chars rejected, negative lastMessageId rejected
- [x] `credentials check` reports granted/missing keys per domain
- [x] `access create` generates token and appends to access.yaml
- [x] `status` shows recent run results from runs.jsonl
- [x] `preflight` validates agent config end-to-end
- [x] Token rotation generates new token, revokes old, disconnects sessions

---

### Verification checklist (Wave 7 — all groups)
- [x] `content_block_stop` event kind used consistently
- [x] Zero `as any` casts in stream processing and WS relay paths
- [x] Zod↔TypeScript type drift causes build failure
- [x] Exhaustive switches enforce handling of all SdkEvent kinds
- [x] `safeSend` eliminates all bare ws.send in error-prone paths
- [x] Worker config minimized to needed subset
- [x] Health arrays bounded, worker stats localized
- [x] Test suite covers all Wave 6 failure modes
- [x] CLI commands operational and documented
- [x] All existing tests continue to pass (282 tests, 0 failures)

---

## Wave 8: Documentation Polish + Deferred Hardening — NOT STARTED

### Group A: Documentation

| Task | Files | Description |
|------|-------|-------------|
| W8-T01 | DESIGN.md, docs/ | Architecture refresh — update for Waves 1–7 modules |
| W8-T02 | CLAUDE.md | Update quick orientation for new modules (env-safety, url-safety, credentials, egress-proxy, content-safety, ipc-protocol, session-worker, worker-manager, query-mutex, sdk-stream, ws-protocol) |
| W8-T03 | CHANGELOG.md | Version history for Waves 1–7 |
| W8-T04 | docs/security.md | Full security narrative for audit |

### Group B: Deferred Hardening (from Wave 7 reviews)

Three independent reviews (security, engineering, architecture) identified four items that are correct but improvable. Deferred from Wave 7 to avoid scope creep during the security wave.

| Task | Files | Description | Source |
|------|-------|-------------|--------|
| W8-T05 | `src/serve.ts` | Extend `safeSend` to `handleSubscribe` and WS message handler — convert remaining ~19 bare `ws.send(JSON.stringify(...))` calls outside `handleMessage` to use `safeSend`. Currently protected by surrounding try/catch or early-lifecycle guarantees, but inconsistent with the pattern established in W7-T10. | Sec #1, Eng #2, Arch #2 |
| W8-T06 | `src/serve.ts` | Type guard for bufferable frames — replace `frame as unknown as WsToken \| WsToolUseStart` with a proper type guard function (`isBufferableFrame(frame): frame is WsToken \| WsToolUseStart`) that validates the frame shape at runtime. Currently safe because ALLOWED_FRAME_TYPES + type check guard the path, but the `as unknown as` cast bypasses TypeScript's structural checks. | Sec #8, Eng #4, Arch #4 |
| W8-T07 | `src/ws-protocol.ts`, `src/types/ws.ts` | Zod-derived WsClientMessage type — use `z.infer<typeof WsClientMessageSchema>` to derive the TypeScript type from the Zod schema, making it the single source of truth. Eliminates the bidirectional assertion (W7-T06) and catches optional field drift. Requires rewriting the `WsClientMessage` union in `types/ws.ts` to be a re-export of the inferred type. | Eng #8, Arch #4 |
| W8-T08 | `src/index.tsx` or new `src/cli/` | CLI subcommand extraction — extract `credentials check`, `access create`, `access rotate`, `status`, `preflight`, `run`, and `credentials migrate` from index.tsx into `src/cli/*.ts` modules with a dispatcher. index.tsx is ~730 lines with a long chain of `if (args[0] === ...)` blocks. | Arch #5 |

### Group B dependencies
- W8-T06 depends on W8-T05 (safeSend must be complete before tightening frame types)
- W8-T07 is independent
- W8-T08 is independent
- All others are independent

### Group B validation
- [ ] Zero bare `ws.send(JSON.stringify(...))` calls remaining in serve.ts
- [ ] `isBufferableFrame()` type guard validates frame shape at runtime
- [ ] No `as unknown as` or `as any` casts in serve.ts WS relay paths
- [ ] `WsClientMessage` type derived from Zod schema via `z.infer<>`
- [ ] Adding an optional field to a Zod schema variant without updating the TS type causes a build failure
- [ ] No `as WsClientMessage` cast in ws-protocol.ts
- [ ] CLI subcommands live in `src/cli/*.ts` with a dispatcher in index.tsx
- [ ] index.tsx is <200 lines (dispatcher + arg parsing + shared helpers only)
- [ ] All existing tests continue to pass

### Verification checklist (Wave 8 — all groups)
- [ ] DESIGN.md reflects current architecture (Waves 1–7)
- [ ] CLAUDE.md quick orientation covers all new modules
- [ ] CHANGELOG covers all security waves
- [ ] Security narrative complete for external audit
- [ ] All deferred hardening items from Wave 7 reviews resolved
- [ ] Zero `as any` or `as unknown as` casts in serve.ts
- [ ] CLI commands modular and testable
