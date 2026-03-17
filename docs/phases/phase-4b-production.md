# Phase 4B: Production Operations

Cost control, external tool integration, monitoring, compliance, and operational tooling. Ships after Phase 4A security foundation is complete.

**Depends on:** Phase 4A complete — logging, sandbox, workspace isolation, shell policy, and rate limiting all operational.

**Scope:** Per-agent MCP servers, cost caps, health monitoring, LGPD compliance, hot reload, deployment infrastructure.

---

## 4B.1 Per-Agent MCP Servers

### Requirement

IDENTITY.md frontmatter declares additional MCP servers:

```yaml
mcp:
  - server: cre-mcp
    uri: https://mcp.mastersof.ai/cre           # remote MCP (SSE/streamable HTTP)
  - server: google-calendar
    command: npx -y @anthropic-ai/google-calendar-mcp   # local process
    env:
      GOOGLE_CLIENT_ID: "${GOOGLE_CLIENT_ID}"
      GOOGLE_CLIENT_SECRET: "${GOOGLE_CLIENT_SECRET}"
```

| Form | Protocol | When allowed |
|------|----------|--------------|
| Remote (`uri`) | SSE / Streamable HTTP | Always |
| Local process (`command`) | stdio MCP | Only when session is sandboxed |

### Lifecycle

- URI-based: per-agent (shared across sessions — stateless)
- Command-based: per-session (fresh process for isolation)

### Files to Create/Modify

- `src/manifest.ts` — Parse `mcp` field in frontmatter schema
- `src/tools/index.ts` — `mergeExternalMcpServers()` function
- `src/agent.ts` — Pass merged servers to SDK
- `src/serve.ts` — MCP lifecycle management (terminate on session end)

### Implementation

See original spec section 4.4 for full details.

**Security amendments from review:**

- Command-based MCP in remote mode: enforce `network: "none"` in bwrap by default (prevent data exfiltration). Require explicit `network: "host"` opt-in.
- `${VAR}` interpolation must use simple string replacement, never shell evaluation
- MCP server name collisions with harness servers rejected at parse time
- Track PIDs for command-based servers, use `--die-with-parent` equivalent

### Acceptance Criteria

- [ ] URI-based MCP server connected and tools available
- [ ] Command-based MCP starts as child process (CLI mode)
- [ ] Command-based MCP runs inside bwrap (remote mode)
- [ ] Command-based MCP skipped without sandbox, warning logged
- [ ] MCP failure doesn't prevent agent from loading
- [ ] `${VAR}` resolves from agent .env
- [ ] Session end terminates command-based MCP processes
- [ ] Name collisions with harness servers rejected
- [ ] Command-based MCP in remote mode defaults to `network: "none"` in bwrap

---

## 4B.2 Cost Caps

### Requirement

Per-user token budgets:

| Budget | Default | Scope |
|--------|---------|-------|
| Per-session | 500,000 tokens | Single conversation |
| Daily (rolling 24h) | 2,000,000 tokens | All sessions |
| Monthly (rolling 30d) | 30,000,000 tokens | All sessions |

Configured in `access.yaml` per user:

```yaml
tokens:
  abc-123:
    name: Jim
    agents: [cre-analyst]
    budget:
      sessionLimit: 500000
      dailyLimit: 2000000
      monthlyLimit: 30000000
  admin-token:
    name: Chris
    agents: "*"
    budget: unlimited
```

### Warning/Enforcement

| Usage | Action |
|-------|--------|
| < 80% | Normal |
| >= 80% | WS warning: `budget_warning` |
| 100% | Hard stop after current response completes: `budget_exceeded` |

### Files to Create/Modify

- `src/cost.ts` — New: CostTracker class with rolling windows
- `src/access.ts` — Parse budget config
- `src/serve.ts` — Integrate cost checking before/after messages
- REST: `GET /api/usage`, `POST /api/admin/users/:id/budget/reset`

### Implementation

See original spec section 4.6 for full details.

Storage: in-memory with periodic disk persistence (`~/.mastersof-ai/state/usage/{userId}.json`).

### Acceptance Criteria

- [ ] Session exceeding limit stops accepting messages
- [ ] 80% warning sent via WebSocket
- [ ] `budget: unlimited` users never capped
- [ ] `GET /api/usage` returns accurate counts
- [ ] Budget survives server restart
- [ ] Admin can reset budget via REST
- [ ] Last response before budget exceeded delivered complete
- [ ] Token counting includes both input and output tokens

---

## 4B.3 Health Monitoring

### Requirement

Two endpoints:

**`GET /health`** — Shallow (no auth, < 10ms, no external calls):
```json
{
  "status": "healthy",
  "uptime": 86400,
  "version": "0.1.5",
  "activeSessions": 3,
  "activeConnections": 7,
  "memory": { "heapUsedMB": 128, "heapTotalMB": 256, "rssMB": 310 }
}
```

**`GET /health/deep`** — Deep (admin auth, < 5s, cached 30s):
```json
{
  "status": "healthy",
  "checks": {
    "anthropicApi": { "status": "healthy", "latencyMs": 230 },
    "filesystem": { "status": "healthy" },
    "mcpServers": { "cre-mcp": { "status": "healthy" } }
  },
  "stats": { "activeSessions": 3, "errorRate1h": 0.02 }
}
```

Returns 503 during graceful shutdown.

### Files to Create/Modify

- `src/health.ts` — New: HealthMonitor class
- `src/serve.ts` — Register health routes, error tracking

### Implementation

See original spec section 4.8 for full details.

**Note:** The existing `GET /health` endpoint returns basic info. Extend it with memory stats and 503 on shutdown. Add `/health/deep` as new.

### Acceptance Criteria

- [ ] `/health` returns 200 in < 10ms, no auth required
- [ ] `/health` returns 503 during shutdown
- [ ] `/health/deep` requires admin auth
- [ ] Anthropic API check cached for 30s
- [ ] Error rate tracking accurate
- [ ] Degraded when Anthropic unreachable, healthy when server is fine

---

## 4B.4 LGPD Compliance

### Requirement

Brazilian data privacy law compliance: users can know what's collected, access it, request deletion.

### Data Stored Per User

| Data | Location |
|------|----------|
| Session metadata | `state/{agent}/{userId}/sessions/*.json` |
| User memory | `agents/{agent}/memory/{userId}/` |
| User workspace | `agents/{agent}/workspace/{userId}/` |
| Usage data | `state/usage/{userId}.json` |

### Endpoints

1. **`GET /api/users/:userId/data`** — ZIP export of all user data. Self or admin.
2. **`DELETE /api/users/:userId/data`** — Delete all user data. Admin only.
3. **`GET /api/privacy`** — Privacy disclosure. No auth.

### Consent Flow

On first session, WS sends `consent_required`. Client must respond `consent_granted` before proceeding. Recorded with timestamp and policy version. Re-consent required on policy version change.

### Data Retention

```yaml
serve:
  privacy:
    sessionRetentionDays: 90
    workspaceRetentionDays: 365
    usageRetentionDays: 365
    policyVersion: "2026-03-01"
```

Daily cleanup job deletes data older than retention period.

### Files to Create/Modify

- `src/privacy.ts` — New: export, delete, consent, retention
- `src/serve.ts` — Privacy routes, consent flow in WS
- `src/config.ts` — Extend with `serve.privacy`

### Implementation

See original spec section 4.9 for full details.

**Security amendments from review:**

- Consent flow must also be enforced on REST API endpoints (not just WebSocket)
- Audit log entries for all admin operations (data export, deletion, budget reset)
- Rate limit the export endpoint to prevent exfiltration

### Acceptance Criteria

- [ ] Data export returns ZIP with user's data only
- [ ] Data deletion removes all user data across all agents
- [ ] Privacy disclosure available without auth
- [ ] Consent required on first session
- [ ] Re-consent on policy version change
- [ ] Retention cleanup runs daily
- [ ] Deletion of non-existent user returns 404
- [ ] Admin operations (data export, deletion, budget reset) generate audit log entries
- [ ] Deferred: encryption at rest (see original spec 4.9 — implement if time permits)

---

## 4B.5 Hot Reload

### Requirement

Server watches agents directory and config files. Updates in-memory state and pushes to connected clients. No restart required.

| Path | On change |
|------|-----------|
| `agents/*/IDENTITY.md` | Re-parse manifest, update roster |
| `agents/*/` (new dir) | Discover new agent |
| `agents/*/` (deleted) | Remove from roster |
| `access.yaml` | Reload access control, disconnect revoked tokens |
| `config.yaml` | Reload config (rate limits, budgets, logging) |

Active sessions continue with original config. New sessions get updated config.

### Files to Create/Modify

- `src/watcher.ts` — New: FileWatcher with debounce
- `src/serve.ts` — Integrate watcher, roster broadcasting, token revocation

### Implementation

See original spec section 4.10 for full details.

**Security amendment from review:**

- 500ms debounce creates a window where revoked tokens still work. Add a manual reload endpoint (`POST /api/admin/reload`) for immediate effect.
- Use a mutex for roster updates to prevent race conditions during reload
- Cap agent directory count (warn at > 100) to prevent watcher DoS

### Acceptance Criteria

- [ ] New agent appears in roster within 2 seconds
- [ ] Connected clients get `roster_updated` WS message
- [ ] Deleted agent removed from roster, active sessions unaffected
- [ ] Token revocation disconnects active WebSocket
- [ ] Config change applies to new requests immediately
- [ ] 10 rapid saves trigger 1 reload (debounce works)
- [ ] Watcher cleanup on shutdown
- [ ] Invalid IDENTITY.md logged, doesn't crash server
- [ ] `POST /api/admin/reload` endpoint for immediate config/access reload

---

## 4B.6 Deployment Infrastructure

### Requirement

Operational tasks deferred from Phase 3:

1. **Custom domain** — Bind domain in Cloudflare dashboard to frontend
2. **Cloudflare Tunnel** — Connect backend to Cloudflare without public port exposure
3. **TLS** — Document requirement for TLS termination (Cloudflare Tunnel handles this, or Caddy/nginx for direct)
4. **Graceful shutdown draining** — Wait for active queries to complete (with timeout) before closing

Note: Auth hardening (token hashing) and Fastify `bodyLimit` are covered in Phase 4A.

### Acceptance Criteria

- [ ] Graceful shutdown waits for active queries (max 30s timeout)
- [ ] Backend accessible via Cloudflare Tunnel (no public port)
- [ ] Custom domain resolves to frontend
- [ ] TLS requirement documented in operational docs

---

## Execution Strategy

### Wave 1 (sequential — both touch serve.ts)
- **Agent A:** 4B.2 Cost Caps (cost.ts, access.ts, serve.ts)
- **Agent B:** 4B.1 Per-Agent MCP Servers (manifest.ts, tools/index.ts, agent.ts, serve.ts)

### Wave 2 (parallel — minimal overlap)
- **Agent C:** 4B.3 Health Monitoring (health.ts, serve.ts)
- **Agent D:** 4B.5 Hot Reload (watcher.ts, serve.ts)

Note: Both touch serve.ts — coordinate via different functions.

### Wave 3 (sequential — touches many files)
- **Agent E:** 4B.4 LGPD Compliance (privacy.ts, serve.ts, config.ts)
- **Agent F:** 4B.6 Deployment Infrastructure (access.ts, serve.ts)

### After All Waves

```bash
npx tsc --noEmit
cd web && npx tsc --noEmit && npx biome check src/
npm test

# Integration test:
# 1. Start serve mode with MCP-configured agent
# 2. Verify MCP tools available
# 3. Exceed token budget → verify warning then hard stop
# 4. GET /health → healthy, GET /health/deep → full report
# 5. Add new agent → verify hot reload + roster broadcast
# 6. Revoke token → verify immediate disconnect
# 7. Export user data → verify ZIP contents
# 8. Delete user data → verify complete removal
# 9. New user → consent required flow
```

---

## Done When

1. `npx tsc --noEmit` passes
2. `npm test` passes
3. All acceptance criteria verified
4. Cost caps prevent runaway API spending
5. MCP servers integrate correctly (URI and command-based)
6. Health endpoints operational for monitoring
7. LGPD compliance verified (export, delete, consent, retention)
8. Hot reload working for agents, config, and access control
9. Deployment infrastructure configured (Cloudflare, TLS, auth hardening)
