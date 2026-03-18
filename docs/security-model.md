# Security Model

Defense-in-depth security architecture for the Masters Of AI Harness. Each layer is independent — a bypass at one layer is caught by the next.

## Threat Model

The harness runs LLM agents with tool access (shell, web, files, A2A). Threats include:

- **Prompt injection**: Malicious content in fetched web pages or memory influencing agent behavior
- **SSRF**: Agent tricked into fetching internal/private network resources
- **Credential leakage**: Agent exfiltrating secrets via shell, web, or A2A tools
- **Lateral movement**: Compromised agent accessing other agents or users
- **DNS rebinding**: Attacker flipping DNS after validation to reach internal hosts

## Security Layers

### Layer 1: Environment Safety (`src/env-safety.ts`)

Shell commands receive a minimal allowlist of environment variables (PATH, HOME, TERM, TZ, LANG, USER). Agent credentials are never passed to shell processes. This prevents accidental or malicious credential access via `env`, `printenv`, or `$VAR` expansion.

### Layer 2: URL Safety / SSRF Protection (`src/url-safety.ts`)

All outbound HTTP requests (web_fetch, web_search, A2A) are validated against blocked IP ranges:
- RFC 1918 private ranges (10.x, 172.16-31.x, 192.168.x)
- Loopback (127.x, ::1)
- Link-local (169.254.x, fe80::)
- Cloud metadata (169.254.169.254)

**Bypass hardening** (Wave 4):
- **IPv4-mapped IPv6**: Both dotted (`::ffff:127.0.0.1`) and hex-short (`::ffff:7f00:1`) forms are normalized to IPv4 before checking. The hex-short form is what `new URL()` produces.
- **Exotic IP encoding**: Decimal (`2130706433`), hex (`0x7f000001`), and octal (`0177.0.0.1`) representations are parsed and normalized (defense-in-depth — `new URL()` normalizes most of these)
- **Protocol restriction**: Only `http:` and `https:` URLs are allowed — `file://`, `data:`, `ftp://` etc. are rejected
- **Redirect chaining**: Each redirect hop re-validates the target URL against the SSRF blocklist and egress filter
- **DNS rebinding / TOCTOU**: Known limitation — the validate-then-fetch pattern has a narrow TOCTOU window. True DNS pinning for HTTPS requires undici dispatcher customization (tracked for future enhancement). The SSRF blocklist is the primary defense; rebinding requires attacker-controlled DNS.

### Layer 3: Credential Scoping (`src/credentials.ts`)

Agents declare which credentials they need in frontmatter. The `CredentialStore` enforces least-privilege:
- **Strict mode** (credentials declared): Only granted keys are available, scoped to specific tool domains
- **Legacy mode** (no credentials block): All keys available (backward compatible)
- **Audit logging**: Every credential resolution is logged with domain and key names

See [credentials.md](credentials.md) for the credential format reference.

### Layer 4: Egress Filtering (`src/egress-proxy.ts`)

Agents declare allowed outbound domains in frontmatter. The `EgressFilter` blocks requests to any domain not on the allowlist. Supports exact match and wildcard patterns (`*.supabase.co`). Works with both web tools and A2A tools.

### Layer 5: Content Boundaries (`src/content-safety.ts`)

Fetched web content is wrapped in `<fetched_content>` structural tags. Memory from prior sessions is wrapped in `<memory_context>` tags. The system prompt includes instructions for the model to treat tagged content as untrusted and never follow instructions within it.

This is a probabilistic defense — it reduces the success rate of prompt injection but doesn't eliminate it. It works alongside the deterministic layers above.

### Layer 6: Tool Access Control (`src/agent.ts` canUseTool)

Multi-layer tool gating:
1. **Global config**: Tool domains enabled/disabled in `config.yaml`
2. **Agent filter**: Per-agent tool allow/deny in frontmatter
3. **Sandbox policy**: Remote sessions restrict shell access
4. **User deny**: Per-user tool restrictions in `access.yaml`
5. **Operation allowlist**: Per-agent operation-level restrictions (e.g., read-only Braintree)

### Layer 7: Authentication & Session Security (`src/access.ts`, `src/serve.ts`)

- Tokens stored as SHA-256 hashes in `access.yaml` (never plaintext)
- Constant-time comparison prevents timing attacks
- Connected WebSocket clients store token hash, not raw token
- WS query parameter tokens deprecated (log warning) — prefer Authorization header
- Per-user rate limiting, connection limits, idle timeouts
- A2A server requires bearer token auth on JSON-RPC endpoint

### Layer 8: Process Isolation

- **Sandbox** (bubblewrap): Filesystem and network namespace isolation for CLI mode
- **Remote sandbox policy**: Shell disabled by default in serve mode
- **Per-user directories**: Workspace, memory, and logs are isolated per remote user
- **External MCP**: Command-based MCP servers blocked in serve mode (arbitrary command execution)

## Data Flow

```
User Input
  → canUseTool (tool access control)
    → CredentialStore (credential scoping)
      → EgressFilter (domain allowlist)
        → validateUrl (SSRF + DNS pinning)
          → fetch (with pinned IP)
            → Content tagging (<fetched_content>)
              → Model (with content boundary instructions)
```

## Configuration

Security is configured at three levels:

1. **Global** (`~/.mastersof-ai/config.yaml`): Tool domain enable/disable
2. **Agent** (frontmatter in `IDENTITY.md`): Credentials, egress, tool filters, operations
3. **User** (`~/.mastersof-ai/access.yaml`): Token auth, agent access, tool deny, budgets

## Related Documentation

- [Agent Security Guide](agent-security.md) — How to author secure agents
- [Credentials Reference](credentials.md) — Credential configuration format
- [Sandbox](sandbox.md) — Process isolation details
- [Configuration](configuration.md) — Full config reference
