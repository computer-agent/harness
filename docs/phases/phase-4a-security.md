# Phase 4A: Security Foundation

Minimum viable security boundary for serving untrusted remote users. Must be complete before any external access.

**Depends on:** Phases 1-3 complete. Phase 3.5 integration gaps closed.

**Scope:** Pre-requisite hardening, structured logging, sandbox enforcement, workspace isolation, shell policy, rate limiting.

---

## 4A.0 Pre-Requisite: Path Hardening + SSRF Fixes

### Problem

Security review identified 3 critical vulnerabilities in existing code that must be fixed before any Phase 4 work:

1. **Path traversal in workspace tools.** `list_files`, `find_files`, `grep_files` in `src/tools/workspace.ts` use `join(workspaceDir, path)` without `resolve()` + `startsWith()` validation. An agent can call `find_files({ path: "../../../etc" })` to enumerate the host filesystem.

2. **SSRF in `web_fetch`.** `src/tools/web.ts` fetches any URL including `http://localhost`, `http://127.0.0.1`, `http://169.254.169.254` (cloud metadata). In a cloud deployment, this enables credential theft.

3. **Symlink bypass.** `path.resolve()` normalizes `..` but does NOT resolve symlinks. An agent with shell could `ln -s /etc workspace/escape`, then `read_file("escape/passwd")` passes the prefix check but follows the symlink.

4. **Plaintext token storage.** `access.yaml` stores tokens in cleartext. Token comparison uses `===` (not constant-time). No brute-force protection on auth failures.

### Files to Modify

- `src/tools/workspace.ts` — Add path validation to `list_files`, `find_files`, `grep_files`; use `fs.realpath()` in read/write/edit
- `src/tools/web.ts` — Block private IP ranges and cloud metadata endpoints in `web_fetch`
- `src/access.ts` — Hash tokens with SHA-256, use `crypto.timingSafeEqual` for comparison

### Implementation

**Workspace path validation:**

Create a shared `validateWorkspacePath()` function used by ALL workspace tools:

```typescript
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

async function validateWorkspacePath(workspaceDir: string, userPath: string): Promise<string> {
  const resolved = resolve(workspaceDir, userPath);
  if (!resolved.startsWith(workspaceDir)) {
    throw new Error("Path must be within workspace");
  }
  // Resolve symlinks to detect escapes
  try {
    const real = await realpath(resolved);
    if (!real.startsWith(workspaceDir)) {
      throw new Error("Path resolves outside workspace (symlink detected)");
    }
    return real;
  } catch (err: any) {
    if (err.code === "ENOENT") return resolved; // File doesn't exist yet (for writes)
    throw err;
  }
}
```

Apply to `list_files`, `find_files`, `grep_files` — validate the `path` parameter before passing to `fd`/`rg`.

**SSRF protection:**

```typescript
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

const BLOCKED_RANGES = [
  /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
  /^169\.254\./, /^0\./, /^::1$/, /^fc/, /^fd/, /^fe80/,
];

async function validateUrl(url: string): Promise<void> {
  const parsed = new URL(url);
  const hostname = parsed.hostname;

  // Block localhost variants
  if (hostname === "localhost" || hostname === "[::1]") {
    throw new Error("Requests to localhost are not allowed");
  }

  // Resolve hostname and check IP — use the resolved IP for the actual fetch
  // to prevent DNS rebinding (attacker returns public IP on first lookup,
  // then 127.0.0.1 on the second lookup that fetch() does internally)
  const ip = isIP(hostname) ? hostname : (await lookup(hostname)).address;
  if (BLOCKED_RANGES.some(r => r.test(ip))) {
    throw new Error("Requests to private/internal networks are not allowed");
  }
  // Return resolved IP so caller can use it for the actual request
  // (prevents DNS rebinding between validation and fetch)
}
```

### Acceptance Criteria

- [ ] `find_files({ path: "../../etc" })` returns "Path must be within workspace"
- [ ] `grep_files({ path: "../../etc", pattern: "root" })` returns "Path must be within workspace"
- [ ] `list_files({ path: "../../" })` returns "Path must be within workspace"
- [ ] Creating a symlink `workspace/escape -> /etc`, then `read_file("escape/passwd")` is blocked
- [ ] `web_fetch("http://169.254.169.254/latest/meta-data/")` is blocked
- [ ] `web_fetch("http://localhost:3000/health")` is blocked
- [ ] `web_fetch("http://10.0.0.1/internal")` is blocked
- [ ] `web_fetch("https://example.com")` still works (public URLs unaffected)
- [ ] `write_file` and `edit_file` with path `../../etc/test` return "Path must be within workspace"
- [ ] DNS rebinding attack mitigated (resolved IP used for actual request)
- [ ] Tokens in `access.yaml` stored as SHA-256 hashes, not plaintext
- [ ] Token comparison uses `crypto.timingSafeEqual` (constant-time)

### Verification

```bash
npx tsc --noEmit
npm test
```

---

## 4A.1 Structured Logging

Foundation for all subsequent tasks — every security event needs structured logging.

### Requirement

All serve mode logs are JSON, one object per line, to stdout. Compatible with Docker, Fly.io, Datadog, `jq`.

### Log Schema

```typescript
interface LogEntry {
  timestamp: string;       // ISO 8601
  level: "debug" | "info" | "warn" | "error";
  requestId?: string;      // UUID per request/message
  userId?: string;
  agentId?: string;
  sessionId?: string;
  category: "auth" | "session" | "agent" | "tool" | "mcp" | "cost" | "health" | "server" | "error";
  event: string;           // e.g., "session.created", "tool.denied"
  message: string;
  details?: Record<string, unknown>;
  durationMs?: number;
}
```

### Event Catalog

| Category | Event | Level | When |
|----------|-------|-------|------|
| server | `server.started` | info | Server starts listening |
| server | `server.shutdown` | info | Graceful shutdown |
| auth | `auth.success` | info | Valid token |
| auth | `auth.failure` | warn | Invalid/missing token |
| session | `session.created` | info | New session |
| session | `session.resumed` | info | Existing session resumed |
| session | `session.ended` | info | Session ended |
| agent | `agent.loaded` | info | Agent manifest parsed |
| agent | `agent.error` | error | Agent failed to load |
| tool | `tool.called` | debug | Tool invocation started |
| tool | `tool.completed` | debug | Tool invocation finished |
| tool | `tool.denied` | warn | Tool call denied |
| cost | `cost.recorded` | debug | Token usage recorded |
| cost | `cost.warning` | warn | User at 80% of budget |
| cost | `cost.exceeded` | warn | Budget exceeded |
| error | `error.unhandled` | error | Unhandled exception |

**NOT logged:** message content, API keys/tokens, full tool inputs/outputs.

### Files to Create/Modify

- `src/logger.ts` — New: Logger class with child logger pattern
- `src/serve.ts` — Use Logger everywhere
- `src/agent.ts` — Accept optional Logger for structured hook logging
- `src/config.ts` — Extend with `serve.logging` config

### Implementation

See original spec section 4.7 for full details.

### Acceptance Criteria

- [ ] Every serve mode log line is valid JSON
- [ ] `requestId` groups all entries for a single user interaction
- [ ] No message content, API keys, or tokens in logs
- [ ] Log level filtering works
- [ ] CLI mode logging unchanged

---

## 4A.2 Mandatory Remote Sandbox

### Requirement

Every serve mode session runs with sandbox enforcement. Unconditional — no config override.

**Sandbox model for serve mode:** In-process tool-level constraints (NOT bwrap re-exec). Shell commands get per-invocation bwrap.

```typescript
const REMOTE_SANDBOX_DEFAULTS: RemoteSandboxPolicy = {
  shell: false,
  filesystem: "workspace",
  network: true,
  additionalMounts: [],
};
```

### Files to Modify

- `src/sandbox.ts` — Add `buildPerCommandBwrapArgs()` for per-invocation shell
- `src/serve.ts` — Enforce sandbox at session creation
- `src/tools/shell.ts` — Add sandboxed execution mode
- `src/tools/index.ts` — Accept sandbox policy in `createAgentServers()`

### Implementation

See original spec section 4.1 for full details.

**Security amendment from review:** The in-process sandbox model relies on every tool correctly implementing path checks. The pre-req (4A.0) hardens the existing tools. Additionally:

- Create a single `validatePath()` function that ALL filesystem-touching tools must use
- Sub-agents must inherit the remote sandbox policy (not addressed in original spec)
- `permissionMode` should NOT be `"bypassPermissions"` for remote sessions — use the SDK's own permission checks as an additional defense layer

### Acceptance Criteria

- [ ] Remote sessions always have sandbox policy applied
- [ ] No code path bypasses sandbox (verified by code review)
- [ ] `sandbox.enforce: false` in IDENTITY.md has no effect on remote sessions
- [ ] Shell commands run inside bwrap when shell is allowed
- [ ] Shell-less sessions return "tool not available" for shell_exec
- [ ] CLI mode sandbox unchanged
- [ ] Sub-agent sessions inherit the parent's sandbox policy
- [ ] Remote sessions do NOT use `permissionMode: "bypassPermissions"` — use SDK's default permission checks as additional defense layer

---

## 4A.3 Per-User Workspace Isolation

### Requirement

Each user gets their own workspace and memory directories per agent:

```
~/.mastersof-ai/agents/{agent}/workspace/{userId}/
~/.mastersof-ai/agents/{agent}/memory/{userId}/
```

Agent shared memory (`memory/CONTEXT.md`) is read-only for remote users.

### Files to Modify

- `src/agent-context.ts` — Add `resolveRemoteAgent(name, userId)`
- `src/tools/memory.ts` — Shared memory fallback (read from shared, write to user's)
- `src/agent.ts` — Load both shared and per-user memory in system prompt
- `src/serve.ts` — Use `resolveRemoteAgent()` instead of `resolveAgent()`

### Implementation

See original spec section 4.2 for full details.

**Security amendments from review:**

- Validate `userId` against `/^[a-z0-9][a-z0-9-]*[a-z0-9]$/i` — reject traversal characters
- Use `realpath()` in workspace tools (from 4A.0) to prevent symlink attacks
- Create workspace directories with mode `0o700`

### Acceptance Criteria

- [ ] Two users see separate workspaces for the same agent
- [ ] User A's files don't appear in User B's `list_files`
- [ ] `memory_write` writes to `memory/{userId}/`, never shared
- [ ] `memory_read` falls back to shared memory (read-only)
- [ ] `resolveRemoteAgent()` rejects userId with `/`, `..`, null bytes
- [ ] Workspace directories created with 0o700

---

## 4A.4 Shell Policy Enforcement

### Requirement

Shell requires BOTH `tools.allow: [shell]` AND `sandbox.enforce: true`. Three-layer defense:

```
Layer 1: createAgentServers() — shell MCP server not created if policy forbids
Layer 2: canUseTool() — rejects shell_exec even if tool somehow exists
Layer 3: bwrap — commands execute in sandbox even if layers 1-2 fail
```

### Files to Modify

- `src/serve.ts` — Shell policy validation at agent load
- `src/agent.ts` — Extend `buildCanUseTool()` for remote policy
- `src/tools/index.ts` — Skip shell server when policy forbids

### Implementation

See original spec section 4.3 for full details.

**Security amendments from review:**

- `canUseTool` must check tool provenance (which MCP server registered it), not just name — prevents tool name confusion from custom MCP servers
- Sub-agents inherit shell policy from parent session
- `find_files`/`grep_files` spawn `fd`/`rg` child processes — these should also be restricted in remote mode (run via bwrap or constrained to workspace)

### Acceptance Criteria

- [ ] Shell + sandbox.enforce: shell works, commands run in bwrap
- [ ] Shell + no sandbox.enforce: shell disabled, warning logged
- [ ] No shell in tools: shell_exec not available
- [ ] `canUseTool` denies shell_exec from wrong MCP server provenance
- [ ] Logging records every denied shell_exec attempt

---

## 4A.5 Rate Limiting

### Requirement

Per-user rate limits:

| Limit | Default |
|-------|---------|
| Messages per minute per user | 20 |
| Concurrent sessions per user | 3 |
| WebSocket connections per user | 5 |
| Message size (characters) | 50,000 |

Sliding window counter, in-memory. Rejected messages get HTTP 429 or WS error with `retryAfter`.

### Files to Create/Modify

- `src/rate-limit.ts` — New: RateLimiter class
- `src/config.ts` — Extend with `serve.rateLimits`
- `src/serve.ts` — Apply rate limiting

### Implementation

See original spec section 4.5 for full details.

**Security amendments from review:**

- Add per-IP rate limiting on auth failures (5 failures per IP per minute) — prevents token brute-forcing
- Add WebSocket idle timeout (5 minutes without a message → disconnect)
- Validate all WebSocket messages against zod schemas before processing
- Set Fastify `bodyLimit` to prevent oversized request parsing
- Validate WebSocket `Origin` header against CORS allowlist

### Acceptance Criteria

- [ ] 21st message in 60s returns rate_limited error
- [ ] `Retry-After` is accurate
- [ ] 4th concurrent session rejected
- [ ] 6th WebSocket connection rejected
- [ ] Message > 50K chars rejected before SDK
- [ ] Users have independent limits
- [ ] Auth failures rate-limited per IP (5 failures/minute)
- [ ] Idle WebSocket connections disconnected after 5 minutes
- [ ] Invalid JSON / oversized WS messages rejected
- [ ] Fastify `bodyLimit` set (1MB default)
- [ ] WebSocket `Origin` header validated against CORS allowlist
- [ ] `fd`/`rg` child processes in workspace tools constrained to workspace directory

---

## Execution Strategy

### Wave 1: Foundation (parallel)
- **Agent A:** 4A.0 Path hardening + SSRF fixes (workspace.ts, web.ts)
- **Agent B:** 4A.1 Structured Logging (logger.ts, serve.ts, config.ts)

### Wave 2: Sandbox + Isolation (parallel, after Wave 1)
- **Agent C:** 4A.2 Mandatory Remote Sandbox (sandbox.ts, serve.ts, tools/shell.ts, tools/index.ts)
- **Agent D:** 4A.3 Per-User Workspace Isolation (agent-context.ts, tools/memory.ts, agent.ts, serve.ts)

### Wave 3: Policy + Limits (parallel, after Wave 2)
- **Agent E:** 4A.4 Shell Policy (serve.ts, agent.ts, tools/index.ts)
- **Agent F:** 4A.5 Rate Limiting + WS hardening (rate-limit.ts, serve.ts, config.ts)

### Conflict Analysis

- Wave 1: zero file overlap (workspace/web/access vs logger/config)
- Wave 2: both touch `serve.ts`; 4A.3 also touches `agent.ts` which 4A.2 modifies — run sequentially (4A.2 first, then 4A.3)
- Wave 3: both touch `serve.ts`; 4A.4 also touches `agent.ts` and `tools/index.ts` — run sequentially (4A.4 first, then 4A.5)

### After All Waves

```bash
npx tsc --noEmit
cd web && npx tsc --noEmit && npx biome check src/
npm test

# Integration smoke test:
# 1. Start serve mode, create two users
# 2. Verify workspace isolation (user A can't see user B's files)
# 3. Verify path traversal blocked (../../etc)
# 4. Verify SSRF blocked (localhost, 169.254.169.254)
# 5. Verify rate limiting (exceed limits, get 429)
# 6. Verify shell policy (shell disabled without sandbox.enforce)
# 7. Verify structured JSON logs
# 8. Verify symlink attack blocked
```

---

## Done When

1. `npx tsc --noEmit` passes
2. `npm test` passes
3. All acceptance criteria verified
4. No path traversal possible via any workspace tool
5. No SSRF possible via web_fetch
6. Per-user workspace isolation verified
7. Shell policy enforced (3 layers)
8. Rate limiting active
9. All security events logged as structured JSON
10. Security review sign-off on critical findings (path traversal, SSRF, symlinks)
