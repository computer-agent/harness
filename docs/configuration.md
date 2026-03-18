# Configuration

## Config File

Global config lives at `~/.mastersof-ai/config.yaml`. Created automatically on first run with sensible defaults. Every field is optional -- the harness uses defaults for anything you omit.

## Configuration by Use Case

### Local Development (Minimal Config)

The defaults work out of the box. You only need a config file if you want to change something.

```yaml
# ~/.mastersof-ai/config.yaml
model: claude-opus-4-6[1m]
defaultAgent: cofounder
effort: max
```

### Team Deployment (Serve Mode)

For running `--serve` so your team accesses agents from a browser:

```yaml
model: claude-opus-4-6[1m]
defaultAgent: assistant
effort: high

# Disable tools you don't want agents using in multi-user mode
tools:
  shell:
    enabled: false
  introspection:
    enabled: false

# Serve mode settings
serve:
  logging:
    level: info
  rateLimits:
    messagesPerMinute: 20
    concurrentSessions: 10
    wsConnectionsPerUser: 3
    maxMessageLength: 50000
  privacy:
    sessionRetentionDays: 90
    policyVersion: "1.0"
```

Then configure access control:

```yaml
# ~/.mastersof-ai/access.yaml
users:
  - token_hash: "a1b2c3..."    # SHA-256 of the token you give Alice
    name: "Alice"
    agents: "*"                 # All agents (also grants admin)
    budget: unlimited

  - token_hash: "d4e5f6..."
    name: "Bob"
    agents: ["analyst", "assistant"]
    budget:
      sessionLimit: 100000      # Max tokens per session
      dailyLimit: 500000        # Max tokens per day
      monthlyLimit: 5000000     # Max tokens per month
```

Generate a token hash:

```bash
echo -n "your-secret-token" | sha256sum | cut -d' ' -f1
```

### Production Hardening

For a production deployment, add CORS, stricter rate limits, and tighter budgets:

```yaml
serve:
  logging:
    level: warn
  rateLimits:
    messagesPerMinute: 10
    concurrentSessions: 5
    wsConnectionsPerUser: 2
    maxMessageLength: 20000
    authFailuresPerMinute: 5
    wsIdleTimeoutMs: 900000     # 15 min idle timeout
  privacy:
    sessionRetentionDays: 30
    workspaceRetentionDays: 30
    usageRetentionDays: 365
    policyVersion: "2.0"
```

Set the CORS allowlist via environment variable:

```bash
ALLOWED_ORIGINS="https://app.example.com,https://staging.example.com" \
  mastersof-ai --serve
```

When `ALLOWED_ORIGINS` is unset, the server allows any localhost origin (dev mode).

## Full Config Reference

```yaml
# Model for all agents (append [1m] for 1M context window)
model: claude-opus-4-6[1m]

# Agent started when no --agent flag is given
defaultAgent: cofounder

# Reasoning effort: low | medium | high | max
effort: max

# Tool domains -- disable any you don't need
tools:
  memory:
    enabled: true
  workspace:
    enabled: true
  web:
    enabled: true
    # extraction_model: claude-haiku-4-5  # Smart extraction for web_fetch
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
    agents: {}
    # Register remote A2A agents:
    #   data-pipeline:
    #     url: http://data-agent.internal:4000
    #     description: "LangGraph data pipeline agent"

# Behavioral hooks
hooks:
  logToolUse: false              # Log tool calls to stderr log
  verifyBeforeComplete: true     # Require file verification after writes
  loopDetection: true            # Warn on repeated edits to same file
  loopDetectionThreshold: 3      # Edits before warning
  compactSuccessOutput: true     # Truncate long successful output
  compactOutputThreshold: 50     # Lines before truncation

# Serve mode settings (--serve only)
serve:
  logging:
    level: info                  # debug | info | warn | error
  rateLimits:
    messagesPerMinute: 20
    concurrentSessions: 10
    wsConnectionsPerUser: 3
    maxMessageLength: 50000
    authFailuresPerMinute: 10
    wsIdleTimeoutMs: 1800000     # 30 minutes
  privacy:
    sessionRetentionDays: 90
    workspaceRetentionDays: 90
    usageRetentionDays: 365
    policyVersion: "1.0"
```

Config is loaded at startup and deep-merged with defaults. In serve mode, `config.yaml` is hot-reloaded when the file changes -- no server restart needed.

## Config Fields

### model

The Claude model to use. Default: `claude-opus-4-6[1m]` (Opus 4.6 with 1M context window). Append `[1m]` to any model ID to request the 1M context variant. Can be changed at runtime in the TUI via `/model`.

### effort

Reasoning effort level passed to the SDK. One of `low`, `medium`, `high`, `max`. Default: `max`. Higher effort means more thinking tokens and deeper reasoning. Can be changed at runtime in the TUI via `/effort`.

### hooks.logToolUse

When `true`, every tool call is logged to the agent's stderr log (`~/.mastersof-ai/state/{agent}/stderr.log`) with tool name, input preview, and timestamp. Useful for debugging. Default: `false`.

### hooks.verifyBeforeComplete

When `true` (default), two things happen:

1. A verification protocol is added to the system prompt, reminding the agent to re-read modified files before completing a task.
2. A `canUseTool` callback tracks file write/read sequences. If the agent writes a file but doesn't subsequently read or grep it, the callback injects a reminder.

### hooks.loopDetection

When `true` (default), tracks per-file edit counts within a session. After `loopDetectionThreshold` edits (default: 3) to the same file, the agent receives a warning suggesting it reconsider its approach. Counters reset when the agent verifies the file (read, grep, or shell).

### hooks.compactSuccessOutput

When `true` (default), a PostToolUse hook truncates long successful tool output to keep context clean. Shell commands that succeed with more than `compactOutputThreshold` lines are summarized to the first 5. Large grep results are summarized to count + first 10 matches. Failed commands always pass through in full -- you always see the full error.

### tools.a2a

A2A client configuration.

- `enabled` -- Toggle for the A2A tools (`a2a_discover`, `a2a_call`, `a2a_list`). Default: `true`.
- `agents` -- Registry of known remote A2A agents. Each entry has a `url` and `description`. Registered agents can be referenced by name in the A2A tools instead of by URL.

```yaml
tools:
  a2a:
    enabled: true
    agents:
      data-pipeline:
        url: http://data-agent.internal:4000
        description: "LangGraph data pipeline agent"
      summarizer:
        url: http://summarizer.internal:4001
        description: "Document summarization service"
```

### serve

Settings for web UI server mode. These have no effect in TUI mode.

**serve.logging.level** -- Log verbosity for the serve backend. Default: `info`.

**serve.rateLimits:**

| Setting | Default | Purpose |
|---------|---------|---------|
| `messagesPerMinute` | 20 | Max messages per user per minute |
| `concurrentSessions` | 10 | Max concurrent active sessions |
| `wsConnectionsPerUser` | 3 | Max WebSocket connections per user |
| `maxMessageLength` | 50000 | Max characters per message |
| `authFailuresPerMinute` | 10 | Auth failure rate limit per IP |
| `wsIdleTimeoutMs` | 1800000 | WebSocket idle timeout (30 min) |

**serve.privacy:**

| Setting | Default | Purpose |
|---------|---------|---------|
| `sessionRetentionDays` | 90 | Days before session data cleanup |
| `workspaceRetentionDays` | 90 | Days before workspace file cleanup |
| `usageRetentionDays` | 365 | Days before usage record cleanup |
| `policyVersion` | "1.0" | Privacy policy version (bump to trigger re-consent) |

## Access Control (Serve Mode)

Authentication for serve mode is configured in `~/.mastersof-ai/access.yaml`. Every request to the serve API must include a `Bearer` token in the `Authorization` header. The server hashes the token with SHA-256 and looks it up in the user list.

```yaml
# ~/.mastersof-ai/access.yaml
users:
  - token_hash: "<sha256 hex of token>"
    name: "Alice"
    agents: "*"                  # "*" = all agents + admin access
    budget: unlimited

  - token_hash: "<sha256 hex>"
    name: "Bob"
    agents: ["analyst"]          # Only these agents
    budget:
      sessionLimit: 50000        # Tokens per session
      dailyLimit: 200000         # Tokens per rolling 24h
      monthlyLimit: 2000000      # Tokens per rolling 30d
```

**Security properties:**

- Tokens are stored as SHA-256 hashes -- never plaintext.
- Comparison uses constant-time operations to prevent timing attacks.
- Users with `agents: "*"` have admin access: deep health checks, reload, budget resets, data deletion.
- `access.yaml` is hot-reloaded on change. When a token is removed, active WebSocket connections using that token are immediately disconnected.

**Token budgets** use rolling windows. When a user exceeds their budget, requests are blocked until the window resets. Budget types:

| Budget | Window | Effect |
|--------|--------|--------|
| `sessionLimit` | Per conversation | Blocks further messages in that session |
| `dailyLimit` | Rolling 24 hours | Blocks all agent access until window rolls |
| `monthlyLimit` | Rolling 30 days | Blocks all agent access until window rolls |

Admins can reset budgets via `POST /api/admin/users/:id/budget/reset`.

## CLI Flags

```
mastersof-ai                           Start with default agent (TUI)
mastersof-ai --agent <name>            Start with specific agent (TUI)
mastersof-ai --message "do X"          Non-interactive single message
mastersof-ai --resume [name|#N]        Resume a session (TUI)
mastersof-ai --sandbox                 Run in bubblewrap sandbox
mastersof-ai --list-agents             Show available agents with metadata
mastersof-ai --init                    Force first-run setup
mastersof-ai --serve                   Start web UI server (port 3100)
mastersof-ai --serve --port 5000       Custom port
mastersof-ai --serve --host 127.0.0.1  Bind to specific host
mastersof-ai --card                    Output A2A Agent Card JSON and exit
mastersof-ai create <name>             Create a new agent
```

## Per-Agent Tool Filtering

Beyond global config, individual agents can restrict their own tools via IDENTITY.md frontmatter:

```yaml
---
tools:
  allow: [memory, web, workspace]   # Only these tools
---
```

or:

```yaml
---
tools:
  deny: [shell]                     # Everything except these
---
```

`allow` and `deny` are mutually exclusive. The frontmatter filter applies on top of the global config -- a tool must be enabled globally AND pass the agent filter to be created.

Valid tool domains: `memory`, `workspace`, `web`, `shell`, `tasks`, `introspection`, `models`, `scratchpad`, `a2a`.

## First Run

When `~/.mastersof-ai/` doesn't exist, the harness:

1. Creates `~/.mastersof-ai/` with `agents/`, `contexts/`, `intents/`, `state/` directories
2. Copies three default agents from bundled defaults (cofounder, assistant, analyst)
3. Writes default `config.yaml`
4. Prints a welcome message

Run `mastersof-ai --init` to force this setup again.

## Sessions

### TUI Mode

Sessions are stored as JSON files in `~/.mastersof-ai/state/{agent}/sessions/`. The `--resume` flag continues the last session. Use `/sessions` in the TUI to browse and `/resume #N` to pick one.

### Serve Mode

Sessions are per-user: `~/.mastersof-ai/state/{agent}/sessions/{userId}/`. Messages are persisted incrementally (appended each turn, not written at session end). The WebSocket protocol supports reconnection with message replay from a `lastMessageId`.
