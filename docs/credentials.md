# Credential Scoping

Controls which environment variables (API keys, tokens) are visible to which tool domains.

## Overview

By default, all agent `.env` variables are available to all tools ("legacy mode"). When you add a `credentials` block to an agent's `IDENTITY.md` frontmatter, only explicitly granted keys are available ("strict mode").

## Frontmatter Schema

```yaml
credentials:
  grants:
    <grant-name>:
      keys: [ENV_KEY_1, ENV_KEY_2]     # Required: env var names from .env
      tools: [web, shell]               # Required: tool domains that receive these keys
      approval: required                 # Optional: withheld until user approves (future)
```

## Example

```yaml
---
name: Billing Agent
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
---
```

In this example:
- `web` tools receive `BRAINTREE_MERCHANT_ID`, `BRAINTREE_PUBLIC_KEY`, and `POSTMARK_SERVER_TOKEN`
- `WIRE_ACCOUNT_NUMBER` requires explicit approval before being passed to tools
- `shell` tools receive no credentials (not granted)
- `BRAINTREE_PRIVATE_KEY` is never exposed (not in any grant)

## Tool Domains

Valid tool domain names: `memory`, `workspace`, `web`, `shell`, `tasks`, `introspection`, `models`, `a2a`, `scratchpad`

## Backward Compatibility

Agents without a `credentials` block continue to work exactly as before — all `.env` values are available to all tool domains.

## Migration

Generate a starting `credentials` block from an existing `.env`:

```bash
mastersof-ai credentials migrate <agent-name>
```

This outputs a YAML block granting all keys to `web`. Edit to split by sensitivity level.

## How It Works

1. Agent `.env` is loaded by `loadAgentEnv()` (dotenvx decryption)
2. Frontmatter `credentials` is parsed by `AgentFrontmatterSchema`
3. `CredentialStore` is created with env vars + credentials config
4. Each tool domain calls `store.resolveFlat(domain)` to get its scoped env
5. Shell tools use `store.toFlatEnv()` (filtered separately by `buildShellEnv()`)

## Audit Logging

When a logger is available (serve mode), credential resolution events are logged:
- Domain, grant names matched, and keys returned
- Category: `tool`, event: `credentials.resolved`
