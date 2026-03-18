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

## Wave 4: Defense in Depth — NOT STARTED

Can run parallel with Wave 2/3. ~1 week.

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
- [ ] Fetched web content wrapped in `<fetched_content>` tags
- [ ] System prompt contains untrusted content instruction
- [ ] Memory content tagged as `<memory_context>`
- [ ] Redirect to internal IP blocked by DNS rebinding defense
- [ ] IPv4-mapped IPv6 addresses (::ffff:127.0.0.1) blocked
- [ ] Decimal/octal/hex IP representations blocked
- [ ] A2A server rejects unauthenticated requests
- [ ] WS query param token logs deprecation warning
- [ ] connectedClients Map does not contain raw token
- [ ] Per-user log files created for remote sessions

---

## Wave 5: Process Isolation + Partner Onboarding — NOT STARTED

Depends on Waves 1-4. ~4-6 weeks.

| Task | Description |
|------|-------------|
| W5-T01 | IPC protocol design (start/message/interrupt/stream/result) |
| W5-T02 | Session worker process (fork per session) (~400 lines) |
| W5-T03 | Refactor handleMessage to dispatch via IPC (~300 lines) |
| W5-T04 | Per-worker env injection (per-user credentials) (~50 lines) |
| W5-T05 | Per-user stateDir/proposalsDir isolation (~30 lines) |
| W5-T06 | Per-user concurrent query mutex (~30 lines) |
| W5-T07 | Create partner access tokens + Tailscale invites (ops) |
| W5-T08 | Test multi-user concurrent sessions |
| W5-T09 | Docs: partner onboarding guide |

---

## Wave 6: Observability + CLI DX — ongoing

| Task | Description |
|------|-------------|
| W6-T01 | `mastersof-ai credentials check --agent <name>` |
| W6-T02 | `mastersof-ai access create --name <name> --agents <list>` |
| W6-T03 | `mastersof-ai status <agent>` (reads runs.jsonl) |
| W6-T04 | `mastersof-ai preflight --agent <name>` (validate full config) |
| W6-T05 | Token rotation mechanism in access.yaml |

## Wave 7: Documentation Polish — ongoing

- Architecture refresh (DESIGN.md, docs/)
- CLAUDE.md update for new modules (env-safety, url-safety, credentials, egress-proxy, content-safety)
- CHANGELOG
- Full security narrative for audit
