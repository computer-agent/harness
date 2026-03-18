# Agent Security Guide

How to configure credentials, egress filtering, tool restrictions, and access control for agents.

## Credential Scoping

See [credentials.md](credentials.md) for the full reference.

Add `credentials.grants` to IDENTITY.md frontmatter to restrict which API keys each tool domain can access. Without it, all `.env` keys are available everywhere.

## Egress Filtering (Domain Allowlist)

Restrict which external domains an agent can reach via `sandbox.allowedDomains`:

```yaml
---
sandbox:
  allowedDomains:
    - api.braintreegateway.com
    - "*.supabase.co"
    - api.postmarkapp.com
    - api.anthropic.com
---
```

- Exact match: `api.braintreegateway.com`
- Wildcard: `*.supabase.co` matches any subdomain (and the bare domain)
- Applies to `web_fetch`, `web_search`, and A2A tools
- Without `allowedDomains`, all outbound requests are permitted

## Tool Operation Restrictions

Restrict specific operations within tool calls via `toolOperations`:

```yaml
---
toolOperations:
  braintree:
    allow: [search, find, get]    # Only read operations
  payment:
    deny: [create, delete, void]  # Block write operations
---
```

The pattern is matched against the tool name. The operation is extracted from the tool input's `operation`, `method`, or `action` field.

## Per-User Tool Deny (Serve Mode)

In `~/.mastersof-ai/access.yaml`, restrict specific tools per user:

```yaml
users:
  - token_hash: "<sha256>"
    name: "partner-readonly"
    agents: "*"
    tools_deny: ["shell_exec", "write_file", "edit_file"]
```

Tool names are matched against the full MCP tool name, the tool suffix, or the domain segment.

## Headless Execution

Run an agent non-interactively with structured exit codes:

```bash
mastersof-ai run billing "Run monthly billing"
```

- Exit 0: success
- Exit 1: error
- Logs to `~/.mastersof-ai/state/<agent>/runs.jsonl`

## External MCP in Serve Mode

Command-based MCP servers (stdio transport) are **always blocked** in serve mode. Only URI-based MCP servers (HTTP transport) are allowed for remote sessions. This prevents arbitrary command execution on the server.

## Complete Example: Billing Agent

```yaml
---
name: Billing Agent
description: Queries Braintree, generates invoices, sends emails

tools:
  deny: [shell, a2a]

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

sandbox:
  allowedDomains:
    - api.braintreegateway.com
    - "*.supabase.co"
    - api.postmarkapp.com
    - api.anthropic.com

toolOperations:
  braintree:
    allow: [search, find, get]

access: users
users: [chris, billing-cron]
---
```

This agent:
- Cannot use shell or A2A tools
- Only receives Braintree read keys and Postmark token (not the private key or wire account)
- Can only reach four external domains
- Braintree operations restricted to read-only
- Only accessible to specific users
