# Security Narrative — Masters Of AI Harness

Comprehensive security documentation for external audit review. Covers threat model, defensive architecture, process isolation, data flow, and known limitations.

For the concise reference version, see [security-model.md](security-model.md).

---

## 1. Executive Summary

The Masters Of AI Harness is a standalone agent runtime that executes LLM agents with tool access. It has two interfaces — a local terminal TUI (`mastersof-ai`) and a multi-user web server (`mastersof-ai --serve`) — sharing a single runtime. Agents can execute shell commands, fetch web content, read/write files, manage memory, and communicate with other agents via A2A protocol.

**Attack surface.** The system is a tool-using AI runtime exposed to three categories of input:

1. **User input** — messages from authenticated users (local or remote via WebSocket)
2. **External content** — web pages, API responses, and A2A messages fetched by agent tools
3. **Persisted state** — memory files, session history, and workspace files from prior interactions

Any of these can contain adversarial content that influences agent behavior. The core security problem is preventing an agent from being tricked into misusing the tools it legitimately has access to.

**Defense-in-depth approach.** No single layer is sufficient. The harness applies 10 independent security layers, each addressing a distinct threat category. Deterministic layers (environment safety, SSRF blocking, credential scoping, egress filtering, tool access control, authentication, process isolation, WebSocket validation) provide hard boundaries. Probabilistic layers (content boundaries) reduce the success rate of attacks that bypass deterministic controls.

The architecture was hardened over 7 security waves spanning systematic reviews with independent security, engineering, and architecture reviewers. Each wave addressed specific threat categories, and later waves incorporated findings from reviews of earlier waves.

---

## 2. Threat Model

### 2.1 Prompt Injection

**Threat.** Malicious instructions embedded in fetched web pages, API responses, A2A messages, or accumulated memory trick the agent into executing unintended tool calls — exfiltrating data, modifying files, or escalating privileges.

**Attack vectors:**
- Web pages containing `ignore previous instructions` payloads fetched via `web_fetch`
- A2A agent responses containing injected instructions
- Memory files (`CONTEXT.md`) poisoned in a prior session
- Workspace files created by a prior agent run

**Defenses:** Content boundaries (Layer 5), tool access control (Layer 6), credential scoping (Layer 3), egress filtering (Layer 4). Content boundaries are probabilistic; the remaining layers are deterministic.

### 2.2 Server-Side Request Forgery (SSRF)

**Threat.** Agent tricked into fetching internal network resources — cloud metadata endpoints (169.254.169.254), localhost services, or private network hosts.

**Attack vectors:**
- Direct URL to private IP
- IPv4-mapped IPv6 bypass (`::ffff:127.0.0.1`, `::ffff:7f00:1`)
- Exotic IP encoding (decimal `2130706433`, hex `0x7f000001`, octal `0177.0.0.1`)
- DNS rebinding — attacker flips DNS resolution between validation and fetch
- Redirect chaining — initial URL passes validation, redirect targets internal IP
- Protocol smuggling — `file://`, `data://`, `ftp://` URLs

**Defenses:** URL safety (Layer 2) blocks all known SSRF vectors. DNS rebinding has a narrow TOCTOU window (see Section 7).

### 2.3 Credential Leakage

**Threat.** Agent exfiltrates API keys, tokens, or secrets through shell commands (`env`, `printenv`), web requests (posting secrets to attacker-controlled endpoints), or A2A messages.

**Attack vectors:**
- Shell `env` or `printenv` exposing process environment
- `$VARIABLE` expansion in shell commands
- Web fetch POST to attacker endpoint with credentials in body
- A2A message containing credentials to a compromised peer agent

**Defenses:** Environment safety (Layer 1) strips all secrets from shell env. Credential scoping (Layer 3) restricts which keys are available to which tool domains. Egress filtering (Layer 4) limits which domains the agent can reach.

### 2.4 Lateral Movement

**Threat.** Compromised agent or user session accesses other agents, other users' data, or escalates to system-level access.

**Attack vectors:**
- Remote user accessing agents not in their access list
- Worker process accessing another worker's state
- User bypassing tool restrictions via alternate tool names
- Agent accessing credentials granted to a different agent

**Defenses:** Authentication (Layer 7) with per-user agent access control. Process isolation (Layer 8) with fork-per-session. Tool access control (Layer 6) with 5-layer gating. Per-user workspace/memory/log isolation.

### 2.5 DNS Rebinding

**Threat.** Attacker controls a DNS server that returns a public IP during validation, then switches to a private IP for the actual fetch — bypassing the SSRF blocklist.

**Technical detail.** The `validateUrl` function resolves DNS and checks the IP, then `fetch` resolves DNS again independently. Between these two resolutions, the attacker can change the DNS response.

**Defenses:** HTTP-only DNS pinning via `buildPinnedFetchArgs` (replaces hostname with resolved IP). HTTPS DNS pinning is not yet implemented (see Section 7). The SSRF blocklist is the primary defense; DNS rebinding requires attacker-controlled DNS infrastructure.

### 2.6 Fork Bombs / Resource Exhaustion

**Threat.** In serve mode, an attacker with valid credentials spawns unlimited worker processes, exhausting system resources.

**Attack vectors:**
- Rapid WebSocket reconnections spawning new workers
- Orphan workers accumulating from unclean disconnects
- Exploiting re-subscribe to accumulate workers without limit

**Defenses:** Worker capacity cap (`maxWorkers`, default 20, configurable). Re-subscribe kills the previous worker before spawning a new one. Worker idle timeout (10 minutes). Worker ready timeout (30 seconds). Per-user rate limiting and connection limits.

### 2.7 IPC Injection

**Threat.** Compromised worker process sends crafted IPC messages to the parent, injecting WebSocket frames or manipulating server state.

**Attack vectors:**
- Worker sending frame types not in the allowed set (e.g., injecting auth responses)
- Worker sending oversized or malformed frames
- Worker exploiting unvalidated IPC message fields

**Defenses:** IPC frame type allowlisting — only 9 known frame types are relayed to the WebSocket client (`ALLOWED_FRAME_TYPES` in `src/ipc-protocol.ts`). Each frame is sanitized via `sanitizeFrame()` which reconstructs new objects with only the known fields for that frame type, stripping any extra properties a compromised worker might inject. Field values are validated at runtime (`typeof` checks, enum value checks) — frames with missing or wrong-typed fields are silently dropped. Parent validates all worker-to-parent messages via type guards before processing.

### 2.8 WebSocket Abuse

**Threat.** Authenticated user sends malformed, oversized, or high-frequency WebSocket messages to crash the server or exploit parsing bugs.

**Attack vectors:**
- Oversized message content (memory exhaustion)
- Invalid JSON or unexpected message shapes
- Astronomically large `lastMessageId` values
- Rapid message flooding

**Defenses:** WebSocket message schema validation via Zod (Layer 9) with explicit field constraints — `content` max 200KB, `agentId` max 200 chars, `lastMessageId` bounded to `Number.MAX_SAFE_INTEGER`. Per-user rate limiting. Malformed messages produce structured error responses without crashing the server.

---

## 3. Security Architecture

### Layer 1: Environment Safety

**Source:** `src/env-safety.ts`

Shell subprocesses receive a minimal, allowlisted set of environment variables: `PATH`, `HOME`, `TERM`, `TZ`, `LANG`, `USER`. The `buildShellEnv()` function starts from an empty object and copies only these keys from `process.env`. Agent-specific env values (from dotenvx `.env` decryption) are merged in, but `DOTENV_PRIVATE_KEY` is excluded.

Critical secrets like `ANTHROPIC_API_KEY` are never present in shell environments. This prevents credential access via `env`, `printenv`, `$VAR` expansion, or any other environment inspection technique.

**Enforcement points:**
- `src/tools/shell.ts` — all shell tool executions
- `src/sandbox.ts` — both bubblewrap sandbox sites
- `src/worker-manager.ts` — forked worker processes (safe base env + `ANTHROPIC_API_KEY` passthrough for SDK only)

### Layer 2: URL Safety / SSRF Protection

**Source:** `src/url-safety.ts`

All outbound HTTP requests from web and A2A tools pass through `validateUrl()`, which:

1. **Protocol restriction.** Only `http:` and `https:` URLs are accepted. `file://`, `data://`, `ftp://`, and all other schemes are rejected.

2. **Hostname pre-check.** `localhost` and `::1` are rejected immediately.

3. **Exotic IP normalization.** `parseExoticIp()` converts decimal (`2130706433`), hex (`0x7f000001`), octal (`0177.0.0.1`), and mixed-notation IPs to standard dotted-quad before range checking.

4. **DNS resolution.** Non-IP hostnames are resolved via `dns.lookup()`. Null results are rejected.

5. **IPv6 normalization.** `normalizeIp()` converts IPv4-mapped IPv6 addresses to their IPv4 equivalents:
   - Dotted form: `::ffff:127.0.0.1` -> `127.0.0.1`
   - Hex-short form: `::ffff:7f00:1` -> `127.0.0.1` (this is the form `new URL()` produces)
   - IPv4-compatible: `::127.0.0.1` -> `127.0.0.1`

6. **Blocked range check.** `isBlockedIp()` tests the normalized IP against `BLOCKED_RANGES`:
   - RFC 1918: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
   - Loopback: `127.0.0.0/8`, `::1`
   - Link-local: `169.254.0.0/16`, `fe80::/10`
   - Zero network: `0.0.0.0/8`
   - Unique local (IPv6): `fc00::/7`, `fd00::/8`

7. **HTTP DNS pinning.** `buildPinnedFetchArgs()` rewrites the URL hostname to the resolved IP and sets the `Host` header to the original hostname, preventing DNS rebinding for plain HTTP requests. (HTTPS pinning requires undici dispatcher customization — see Section 7.)

8. **Redirect validation.** Each HTTP redirect hop re-validates the target URL through the full SSRF blocklist and egress filter pipeline.

### Layer 3: Credential Scoping

**Source:** `src/credentials.ts`

The `CredentialStore` class controls which environment variables (API keys, tokens) are available to which tool domains.

**Strict mode** (agent declares `credentials.grants` in IDENTITY.md frontmatter):
- Only explicitly granted keys are returned for each tool domain
- Grants are scoped to specific tool domains (e.g., Braintree keys only available to `web` tools)
- Grants with `approval: required` are excluded from automatic resolution (reserved for future human-in-the-loop approval)
- Every credential resolution is audit-logged with domain, grant names, and resolved key names

**Legacy mode** (no `credentials` block in frontmatter):
- All agent env vars are available to all tool domains (backward compatibility)
- Agents should migrate to strict mode for production use

**Implementation detail.** `resolveFlat(domain)` iterates grants, filters by tool domain, skips approval-required grants, and returns only matching env vars. The `listGrants()` method supports the `credentials check` CLI command for auditing.

### Layer 4: Egress Filtering

**Source:** `src/egress-proxy.ts`

The `EgressFilter` class restricts which external domains agent tools can reach.

When an agent declares `sandbox.allowedDomains` in its frontmatter, only requests to listed domains are permitted. Supports:
- **Exact match:** `api.braintreegateway.com`
- **Wildcard suffix:** `*.supabase.co` (matches any subdomain, including the bare domain)

Domain comparison is case-insensitive. URLs that fail to parse are rejected. The filter is injected into web tools and A2A tools at agent initialization time. Without `allowedDomains`, all outbound requests are allowed (existing behavior).

### Layer 5: Content Boundaries

**Source:** `src/content-safety.ts`

External content is wrapped in structural XML tags to help the model distinguish trusted instructions from untrusted data:

- **Fetched web content:** `<fetched_content source="...">` with HTML-escaped source URL attribute
- **Memory context:** `<memory_context>` for `CONTEXT.md` and prior session data
- **Search results:** Web search results are also wrapped in `<fetched_content>` tags

The system prompt includes `UNTRUSTED_CONTENT_INSTRUCTION`, which tells the model to treat tagged content as untrusted and never follow instructions within it.

**This is a probabilistic defense.** It reduces the success rate of prompt injection but does not eliminate it. Models can still be influenced by sophisticated injection techniques. The deterministic layers above (environment safety, SSRF blocking, credential scoping, egress filtering, tool access control) provide the hard boundaries.

### Layer 6: Tool Access Control

**Source:** `src/agent.ts` (`buildCanUseTool`), `src/tools/index.ts` (`isToolEnabled`)

Tool access is gated by a 5-layer evaluation chain. Each layer is independent — failing at any layer denies the tool call.

**Layer 6.1: Global config** (`~/.mastersof-ai/config.yaml`)
- Each tool domain (memory, workspace, web, shell, tasks, introspection, models, scratchpad, a2a) can be enabled or disabled globally
- `isToolEnabled()` checks this before creating MCP servers — disabled domains are never registered
- Agents cannot override global disablement

**Layer 6.2: Agent filter** (IDENTITY.md frontmatter `tools.allow` / `tools.deny`)
- Per-agent tool allow/deny lists, mutually exclusive
- `tools.allow: [web, memory]` — only these domains are available
- `tools.deny: [shell]` — all except these domains are available
- Validated by Zod schema at manifest parse time

**Layer 6.3: Sandbox policy** (remote sessions)
- `shell_exec` denied by default in serve mode unless the agent frontmatter explicitly enables it with `sandbox.enforce: true` and `tools.allow` includes `shell`
- External command-based MCP servers blocked entirely in serve mode (arbitrary command execution)

**Layer 6.4: Per-user deny** (`~/.mastersof-ai/access.yaml` `tools_deny`)
- Per-user tool restrictions — e.g., `tools_deny: ["shell_exec"]` prevents a specific user from using shell tools
- Matches on full tool name, tool suffix, or tool domain

**Layer 6.5: Operation allowlist** (IDENTITY.md frontmatter `toolOperations`)
- Per-agent operation-level restrictions within a tool domain
- Example: billing agent restricted to read-only Braintree operations (`allow: ["query", "search"]`)
- Operations extracted from tool input (`input.operation`, `input.method`, or `input.action`)

All denials are logged with the tool name, denial reason, and relevant context.

### Layer 7: Authentication and Session Security

**Source:** `src/access.ts`, `src/serve.ts`

**Token storage.** Access tokens are stored as SHA-256 hashes in `~/.mastersof-ai/access.yaml`. Raw tokens are never persisted. Token generation uses `crypto.randomBytes(32)` (256 bits of entropy, hex-encoded to 64 characters).

**Token comparison.** `safeCompare()` uses Node.js `crypto.timingSafeEqual()` to prevent timing side-channel attacks. The function includes a length check that exits early on mismatch — safe because all callers compare fixed-length SHA-256 hex digests (64 characters). The JSDoc explicitly documents this constraint.

**WebSocket security:**
- Authorization via `Bearer` token in HTTP `Authorization` header (preferred)
- Query parameter token support deprecated with log warning (backward compatibility)
- Connected clients store token hash, not raw token — prevents in-memory token exposure
- Rate limiter keys use hashed tokens, not raw tokens

**Session security:**
- Per-user rate limiting (requests per window)
- Connection limits (max concurrent WebSocket connections per user)
- Idle timeouts (disconnects inactive WebSocket connections)
- Agent access control — per-user agent lists in `access.yaml`, per-agent access levels (`public`, `users`, `private`) in IDENTITY.md

**A2A authentication.** The A2A JSON-RPC server endpoint requires bearer token authentication.

**Token lifecycle:**
- `generateAccessToken()` — creates new token + hash pair
- `access create` CLI — generates token, appends to `access.yaml`
- `access rotate` CLI — generates new token, revokes old, disconnects active sessions

### Layer 8: Process Isolation

**Source:** `src/session-worker.ts`, `src/worker-manager.ts`, `src/query-mutex.ts`

In serve mode, each remote session runs in an isolated child process (Node.js `child_process.fork`). This provides:

- **Memory isolation.** Worker processes have independent heaps. A memory leak or crash in one session does not affect others.
- **Environment isolation.** Workers receive a minimal environment (`buildShellEnv` + agent-specific credentials + `ANTHROPIC_API_KEY`). The parent's full `process.env` is not inherited.
- **Execution isolation.** `execArgv` is filtered to remove `--inspect` and `--debug` flags, preventing debug port exposure in worker processes (RCE vector).

See Section 5 for the detailed process isolation model.

### Layer 9: WebSocket Protocol Safety

**Source:** `src/ws-protocol.ts`

All incoming WebSocket messages are validated against Zod schemas before processing:

- `subscribe` — `agentId` max 200 chars, `sessionId` max 200 chars, `lastMessageId` non-negative integer bounded to `Number.MAX_SAFE_INTEGER`
- `message` — `content` min 1, max 200,000 characters
- `interrupt`, `ping` — empty payload
- `tool_approval` — `toolId` non-empty, `approved` boolean
- `consent_granted` — `policyVersion` non-empty

The schema uses `z.discriminatedUnion("type", ...)` for efficient validation. The TypeScript `WsClientMessage` type is derived directly from the Zod schema via `z.infer<typeof WsClientMessageSchema>`, making the schema the single source of truth — adding or changing fields in the schema automatically updates the TypeScript type, so schema/type divergence is structurally impossible.

Invalid messages produce structured error responses (`{ error, detail }`) without crashing the server. The validation detail includes the Zod issue path for debugging.

### Layer 10: Observability and Health

**Source:** `src/health.ts`, `src/logger.ts`

**Structured logging.** Every log entry is a JSON object written to stdout. The logger explicitly never logs: message content, API keys, tokens, or full tool inputs/outputs. Logs include: timestamp, level, userId, agentId, sessionId, category, event name, and structured details.

**Health monitoring.** Two levels:
- **Shallow** (`/health`) — fast, no auth, no external calls. Reports: status, version, uptime, active sessions/connections, memory usage. Suitable for load balancer health checks.
- **Deep** (`/health/deep`) — admin-only, cached 30 seconds. Checks: Anthropic API reachability (5-second timeout), filesystem access (agents/state dirs), error rate (1-hour window), worker pool utilization.

**Bounded arrays.** Error/success tracking arrays use a prune-on-insert strategy: every 1,000 insertions, entries older than 1 hour are trimmed. This prevents unbounded memory growth under sustained load.

**Worker pool monitoring.** `WorkerManager.getStats()` reports active workers, max capacity, and utilization ratio. Exposed via `/health/deep` for operational monitoring.

---

## 4. Data Flow

### 4.1 Request Flow — Web Tool Call

```
User message (WebSocket or TUI)
  |
  v
[Layer 7] Authentication (token hash lookup, timing-safe compare)
  |
  v
[Layer 9] WS message validation (Zod schema check)
  |
  v
[Layer 8] Worker dispatch (IPC to isolated child process)
  |
  v
SDK query (Claude Agent SDK processes the message)
  |
  v
Agent decides to call web_fetch tool
  |
  v
[Layer 6] canUseTool (5-layer gating: global config, agent filter,
          sandbox policy, user deny, operation allowlist)
  |
  v
[Layer 3] CredentialStore.resolveFlat("web") — only granted keys available
  |
  v
[Layer 4] EgressFilter.validate(url) — domain allowlist check
  |
  v
[Layer 2] validateUrl(url) — SSRF blocklist, IP normalization,
          protocol restriction, DNS resolution
  |
  v
HTTP fetch (with DNS pinning for HTTP, redirect re-validation)
  |
  v
[Layer 5] wrapFetchedContent(response, url) — structural XML tags
  |
  v
Model receives tagged response with UNTRUSTED_CONTENT_INSTRUCTION in system prompt
  |
  v
Agent response streamed back through IPC → WebSocket
```

### 4.2 Request Flow — Shell Execution

```
Agent decides to call shell_exec tool
  |
  v
[Layer 6] canUseTool — sandbox policy check (denied by default in serve mode)
  |
  v
[Layer 1] buildShellEnv() — minimal allowlist (PATH, HOME, TERM, TZ, LANG, USER)
          + agent-specific env (no ANTHROPIC_API_KEY, no process.env secrets)
  |
  v
Shell subprocess with restricted environment
```

### 4.3 Request Flow — Credential Resolution

```
Tool server initialization (per-domain)
  |
  v
CredentialStore constructed with agent env + frontmatter credentials config
  |
  v
createAgentServers() calls resolveFlat(domain) per tool domain
  |
  v
[Strict mode] Only granted keys for this domain returned
[Legacy mode] All agent env vars returned
  |
  v
Credential audit log entry (domain, grant names, resolved keys)
  |
  v
Tool server receives only its authorized credentials
```

---

## 5. Process Isolation Model

### 5.1 Architecture

In serve mode, the parent process (`src/serve.ts`) handles HTTP/WebSocket I/O, authentication, and session management. Each active conversation runs in a child process (`src/session-worker.ts`) spawned via `WorkerManager` (`src/worker-manager.ts`).

```
                      ┌──────────────────────────────┐
                      │        Parent (serve.ts)      │
                      │                               │
                      │  HTTP/WS I/O                  │
                      │  Authentication               │
                      │  Rate Limiting                 │
                      │  Session Persistence           │
                      │  Cost Tracking                 │
                      │  Health Monitoring             │
                      └───────┬──────────┬────────────┘
                              │          │
                       IPC    │          │    IPC
                              │          │
                    ┌─────────▼──┐  ┌────▼──────────┐
                    │  Worker 1  │  │   Worker 2     │
                    │  (Agent A, │  │   (Agent B,    │
                    │   User X)  │  │    User Y)     │
                    │            │  │                 │
                    │  SDK Query │  │  SDK Query      │
                    │  Tool Exec │  │  Tool Exec      │
                    └────────────┘  └─────────────────┘
```

### 5.2 Worker Lifecycle

1. **Spawn.** `WorkerManager.spawn()` forks a new process with `child_process.fork()`. The worker receives a minimal environment (see 5.3). A 30-second ready timeout starts — if the worker does not send `"ready"` within this window, it is killed.

2. **Init.** Parent sends `IpcInitMessage` with agent ID, user ID, config subset (see 5.4), and user access policy. Worker loads agent context, parses manifest, builds system prompt, and replies `"ready"`.

3. **Message.** Parent sends `IpcUserMessage`. Worker runs an SDK query, streams frames back via `IpcFrameMessage`. The worker guards against concurrent queries — a second message while a query is active is rejected.

4. **Interrupt.** Parent sends `IpcInterruptMessage`. Worker calls `query.interrupt()` on the active SDK query.

5. **Shutdown.** Parent sends `IpcShutdownMessage`. Worker denies all pending tool approvals (unblocking the SDK), interrupts the active query, and exits. If the worker does not exit within 5 seconds, the parent sends `SIGKILL`.

6. **Crash handling.** If a worker exits with non-zero code, the parent clears pending approvals, sends an error frame to the WebSocket client, and cleans up.

### 5.3 Environment Isolation

Worker processes receive a constructed environment, not the parent's `process.env`:

```
buildShellEnv()           → PATH, HOME, TERM, TZ, LANG, USER
+ loadAgentEnv(agentDir)  → agent-specific env from dotenvx .env
+ ANTHROPIC_API_KEY       → SDK needs this (explicit passthrough)
+ WORKER_AGENT_ID         → diagnostic metadata
+ WORKER_USER_ID          → diagnostic metadata
```

The parent's `process.env` (which may contain secrets, API keys for other services, or operational credentials) is never inherited. The `execArgv` array is filtered to remove `--inspect` and `--debug` flags, preventing workers from opening debug ports (which would allow arbitrary code execution via Chrome DevTools protocol).

### 5.4 Config Minimization

Workers receive a `WorkerConfig` subset (`src/ipc-protocol.ts`) rather than the full `HarnessConfig`. Excluded fields:

- `serve.rateLimits` — handled by the parent, irrelevant inside workers
- `serve.privacy` — parent-side policy
- `serve.maxWorkers` — parent-side capacity management
- Other serve-mode operational config

This reduces information exposure if a worker process is compromised.

### 5.5 IPC Protocol Safety

The IPC protocol (`src/ipc-protocol.ts`) uses discriminated unions with explicit type guards:

- **Parent-to-worker:** `init`, `message`, `interrupt`, `tool_approval_response`, `shutdown`
- **Worker-to-parent:** `ready`, `frame`, `session_id`, `tool_approval_request`, `result`, `error`
- **Frame type allowlist:** Only 9 known frame types (`status`, `token`, `thinking_token`, `tool_use_start`, `tool_use_input`, `tool_result`, `subagent_started`, `subagent_progress`, `subagent_done`) are relayed from worker to WebSocket client

The `ALLOWED_FRAME_TYPES` set is defined at module scope in `ipc-protocol.ts`, co-located with the type definitions for auditability. The parent checks each `IpcFrameMessage.frame.type` against this set before relaying to the WebSocket. Frames with unknown types are silently dropped. Additionally, `sanitizeFrame()` reconstructs each frame as a new object with only the expected fields, validated at runtime with `typeof` checks and enum value validation — this prevents a compromised worker from injecting extra properties or wrong-typed values through the IPC channel.

`process.send()` calls in the worker are wrapped in try/catch to handle `ERR_IPC_CHANNEL_CLOSED` (parent died or disconnected) without crashing the worker or causing infinite recursion.

### 5.6 Concurrency Control

`QueryMutex` (`src/query-mutex.ts`) serializes concurrent queries per conversation key. This prevents two rapid messages from starting two SDK queries on the same session, which would corrupt conversation state.

The mutex uses a FIFO queue pattern — waiters are enqueued and dequeued one at a time. An optional timeout parameter (`acquire(key, timeoutMs)`) removes timed-out waiters from the queue and rejects with `MutexTimeoutError`. Timed-out entries are skipped during release, so they never re-acquire the lock.

### 5.7 Capacity Management

- **Max workers.** Configurable via `serve.maxWorkers` (default 20). Invalid values (NaN, negative, 0) are clamped or defaulted. Exceeding the cap returns an error to the client, not a crash.
- **Idle timeout.** Workers are killed after 10 minutes of inactivity.
- **Ready timeout.** Workers that do not send `"ready"` within 30 seconds are killed.
- **Re-subscribe protection.** When a user re-subscribes to a conversation, the existing worker is killed before spawning a new one — prevents orphan accumulation.
- **Graceful shutdown.** `WorkerManager.killAll()` sends shutdown messages to all workers on server termination.

---

## 6. Security Review History

The security architecture was built across 7 implementation waves. Starting from Wave 5, each wave was reviewed by 3 independent reviewers (security, engineering, architecture) before the next wave began. Review findings from one wave were incorporated into the next.

### Wave 1: Tier 0 Security (10 tasks)

Foundation layer. Established the basic security boundaries.

- Default bind address changed from `0.0.0.0` to `127.0.0.1`
- Environment safety module (`buildShellEnv` allowlist)
- URL safety module (SSRF blocklist extraction from web.ts)
- A2A SSRF validation for agent discovery and calls
- Tool domain gating (`TOOL_DOMAINS`, `isToolEnabled`)
- Sandbox read-only mount for `~/.claude`
- Removed `BRAVE_API_KEY` process.env fallback
- 20 tests (env-safety: 7, url-safety: 13)

**Review findings (addressed in Wave 4):** DNS rebinding TOCTOU, IPv4-mapped IPv6 bypass, exotic IP encoding.

### Wave 2: Credential Architecture + Egress (13 tasks)

Credential isolation and outbound traffic control.

- `CredentialStore` class with strict/legacy modes
- Credential audit logging (domain, grant names, resolved keys)
- `EgressFilter` with domain allowlists and wildcard support
- Per-user tool deny in `access.yaml`
- Per-agent operation-level restrictions
- External MCP server blocking in serve mode
- Headless `run` subcommand with structured exit codes

### Wave 3: Billing Agent Deploy (8 tasks)

Operational deployment. Not security implementation — validation of Wave 2 controls in production.

### Wave 4: Defense in Depth (9 tasks, 203 tests)

Addressed all Wave 1 review findings plus new hardening.

- Content boundaries (`<fetched_content>`, `<memory_context>`, system prompt instruction)
- IPv4-mapped IPv6 normalization (both dotted and hex-short forms)
- Exotic IP parsing (decimal, hex, octal, mixed)
- Protocol restriction (HTTP/HTTPS only)
- DNS null-check hardening
- Redirect re-validation
- A2A server bearer token auth
- WebSocket query parameter token deprecation
- Raw token removal from `connectedClients` Map
- Per-user stderr logging

### Wave 5: Process Isolation + Partner Onboarding (9 implementation + 15 review-fix tasks, 238 tests)

Introduced fork-per-session isolation. First wave with 3 independent reviews.

**Implementation:**
- IPC protocol with discriminated union types
- Session worker child process entry point
- WorkerManager lifecycle management
- Per-worker environment injection
- Per-user proposals directory isolation
- Query mutex for concurrent query serialization
- Partner token generation

**Review fixes (15 items, 3 critical, 4 high, 5 medium):**
- P0-1 (CRIT): Worker exit code 0 left promise unsettled, locking mutex forever. Fixed with `settled` flag + `safeResolve`/`safeReject`.
- P0-3 (CRIT): `process.send` throwing `ERR_IPC_CHANNEL_CLOSED` caused infinite recursion. Fixed with try/catch in `send()` helper.
- F1 (HIGH): Fork bomb — re-subscribe orphaned workers with no max cap. Fixed with kill-previous + `maxWorkers` cap.
- F2 (HIGH): IPC frame type not validated, allowing WebSocket injection. Fixed with `ALLOWED_FRAME_TYPES` allowlist.
- F3 (HIGH): `execArgv` leaked `--inspect` flags to workers, enabling debug port RCE. Fixed with `--inspect`/`--debug` filter.
- F5 (MED): Raw token used in HTTP rate limiter key. Fixed with `hashToken()`.
- F7 (MED): Agent roster broadcast leaked all agents to all users. Fixed with per-user filtered broadcast.

### Wave 6: Process Isolation Hardening (9 tasks, 264 tests)

Hardened Wave 5 based on review findings.

- SDK stream processing shared abstraction (eliminated `as any` duplication)
- Mutex acquire timeout with queue removal
- Token revocation timing-safe comparison
- WebSocket message Zod schema validation
- Worker ready timeout (30s)
- Pending approval cleanup on worker crash
- Configurable `serve.maxWorkers`
- Worker pool utilization in `/health/deep`

### Wave 7: Review Hardening + Type Safety + Observability (21 tasks, 282 tests)

Final hardening wave. Addressed all remaining deferred findings.

- Renamed `tool_block_stop` to `content_block_stop` (correct semantics)
- Fixed `tool_input_delta` toolId extraction (null instead of orphan frames)
- Module-scoped `frameId` (reconnection replay correctness)
- Zod/TypeScript compile-time type assertion
- Exhaustive switch enforcement on SdkEvent (`never` check)
- `ALLOWED_FRAME_TYPES` moved to module scope in `ipc-protocol.ts`
- `safeSend` wrapper for all error-prone `ws.send` paths
- Worker config minimization (only needed subset)
- WebSocket schema field bounds (content max 200KB, lastMessageId max safe integer)
- `safeCompare` equal-length-only JSDoc documentation
- Bounded health arrays (prune-on-insert)
- Worker pool stats localization
- CLI DX tools: `credentials check`, `access create`, `access rotate`, `status`, `preflight`

---

## 7. Known Limitations and Mitigations

### 7.1 DNS Rebinding TOCTOU Window (HTTPS)

**Limitation.** For HTTPS requests, DNS pinning is not implemented. `validateUrl()` resolves DNS and validates the IP, then `fetch()` resolves DNS independently. An attacker with a controlled DNS server can flip the resolution between these two steps.

**Risk level.** Low. Exploitation requires:
1. Attacker controls the DNS server for the target domain
2. Attacker can trick the agent into fetching a specific URL
3. DNS TTL must be low enough to allow the flip within the TOCTOU window (typically < 1 second)
4. The SSRF blocklist check still runs on the initial resolution

**Mitigation path.** True HTTPS DNS pinning requires undici's dispatcher with a custom `connect.lookup` function that caches the resolved IP and uses it for the actual connection. This is architecturally identified but not yet implemented. The SSRF blocklist remains the primary defense.

**For HTTP.** `buildPinnedFetchArgs()` replaces the URL hostname with the resolved IP, closing the TOCTOU window entirely for plain HTTP requests.

### 7.2 Content Boundary Probabilistic Defense

**Limitation.** The `<fetched_content>` and `<memory_context>` structural tags, combined with the `UNTRUSTED_CONTENT_INSTRUCTION` system prompt, are a probabilistic defense. Sophisticated prompt injection can still influence agent behavior despite the tags.

**Risk level.** Medium. The probabilistic defense reduces attack surface but does not eliminate it. Models are generally trained to respect content boundary instructions, but there are no guarantees.

**Mitigation.** This layer works alongside deterministic controls: environment safety, SSRF blocking, credential scoping, egress filtering, and tool access control. Even if an injection succeeds in influencing the agent's reasoning, the deterministic layers restrict what the agent can actually do.

### 7.3 Legacy Mode Credential Exposure

**Limitation.** Agents without a `credentials` block in their frontmatter run in legacy mode, where all agent env vars are available to all tool domains. This provides no credential isolation.

**Risk level.** Medium for agents with sensitive credentials and no frontmatter migration.

**Mitigation.** The `credentials check` CLI command audits credential configurations. The `credentials migrate` CLI command helps transition agents to strict mode. New agents should always use strict mode.

### 7.4 Bubblewrap Sandbox Availability

**Limitation.** The bubblewrap (`bwrap`) sandbox for local CLI mode requires Linux with user namespaces enabled. It is not available on macOS or Windows (except WSL2).

**Risk level.** Low for the primary deployment target (Linux servers). Not applicable to serve mode, which uses process isolation instead.

### 7.5 `safeCompare` Equal-Length Constraint

**Limitation.** `timingSafeEqual` is only constant-time when both buffers have equal length. The early return on length mismatch leaks timing information about the expected length.

**Risk level.** Negligible. All current callers compare fixed-length SHA-256 hex digests (64 characters). The JSDoc on `safeCompare` documents this constraint. Future callers using variable-length inputs must be aware.

---

## 8. Configuration Reference

Security behavior is configured at three levels. Lower levels (user) can restrict but not expand access granted at higher levels (global, agent).

### 8.1 Global Configuration (`~/.mastersof-ai/config.yaml`)

```yaml
# Tool domain enable/disable — disabled domains are never registered
tools:
  memory:
    enabled: true
  workspace:
    enabled: true
  web:
    enabled: true
    extraction_model: claude-sonnet-4-20250514  # model for web content extraction
  shell:
    enabled: true
  tasks:
    enabled: true
  introspection:
    enabled: true
  models:
    enabled: true
  scratchpad:
    enabled: true
  a2a:
    enabled: true
    agents: {}  # registered A2A peer agents

# Serve mode settings
serve:
  maxWorkers: 20        # maximum concurrent worker processes
  logging:
    level: info         # debug | info | warn | error
  rateLimits:
    maxRequestsPerWindow: 100
    windowMs: 60000
    maxMessageLength: 200000
    maxConnectionsPerUser: 5

# Hook behavior
hooks:
  logToolUse: false     # log all tool calls to stderr log
```

### 8.2 Agent Configuration (IDENTITY.md frontmatter)

```yaml
---
# Tool access
tools:
  allow: [web, memory]         # only these tool domains available
  # OR
  deny: [shell]                # all except these domains

# Credential scoping (strict mode)
credentials:
  grants:
    braintree-read:
      keys: [BRAINTREE_MERCHANT_ID, BRAINTREE_PUBLIC_KEY]
      tools: [web]
    sensitive-write:
      keys: [WIRE_ACCOUNT_NUMBER]
      tools: [web]
      approval: required       # requires human approval (not auto-resolved)

# Egress filtering
sandbox:
  shell: false                 # shell disabled by default for remote sessions
  enforce: true                # enforce sandbox policy even when shell is allowed
  allowedDomains:
    - api.braintreegateway.com
    - "*.supabase.co"
    - api.anthropic.com

# Operation-level restrictions
toolOperations:
  web:
    allow: [query, search]     # only these operations allowed
  # OR
    deny: [delete, update]     # these operations denied

# Access control
access: public                 # public | users | private
users: [alice, bob]            # only used when access: users
---
```

### 8.3 User Configuration (`~/.mastersof-ai/access.yaml`)

```yaml
users:
  - token_hash: "a1b2c3..."   # SHA-256 hex hash of the bearer token
    name: "alice"
    agents: "*"                # all agents, or ["billing", "researcher"]
    budget:
      sessionLimit: 5.00
      dailyLimit: 50.00
      monthlyLimit: 500.00
    tools_deny:                # per-user tool restrictions
      - shell_exec
      - shell                  # entire domain

  - token_hash: "d4e5f6..."
    name: "bob"
    agents: ["researcher"]     # limited agent access
    budget: unlimited
```

### 8.4 Configuration Precedence

Tool access is the intersection of all levels:

1. **Global** must enable the tool domain
2. **Agent** must allow the tool domain (or not deny it)
3. **Sandbox policy** must permit the tool (shell denied by default in serve mode)
4. **User** must not have the tool in `tools_deny`
5. **Operation** must be in the allow list (or not in the deny list)

A tool call is permitted only if it passes all 5 checks. Any single denial is sufficient to block access.

---

## Related Documentation

- [security-model.md](security-model.md) — Concise reference version of this document
- [agent-security.md](agent-security.md) — Agent authoring security guide
- [credentials.md](credentials.md) — Credential configuration format reference
- [sandbox.md](sandbox.md) — Process isolation details (bubblewrap)
- [configuration.md](configuration.md) — Full configuration reference
- [partner-onboarding.md](partner-onboarding.md) — Partner setup guide
