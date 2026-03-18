# Configuration

## Config File

Global config lives at `~/.mastersof-ai/config.yaml`.

```yaml
model: claude-opus-4-6[1m]     # Opus 4.6 with 1M context window
defaultAgent: cofounder
effort: max                  # low | medium | high | max (default: max)

hooks:
  logToolUse: false          # Log all tool calls via PreToolUse/PostToolUse hooks
  verifyBeforeComplete: true # Remind agent to verify file changes before completing
  loopDetection: true        # Detect repeated edits to the same file
  loopDetectionThreshold: 3  # Edits before warning
  compactSuccessOutput: true # Truncate long successful command output
  compactOutputThreshold: 50 # Max lines for successful output before truncation

tools:
  memory:
    enabled: true
  web:
    enabled: true
  workspace:
    enabled: true
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
    agents: {}               # Registered remote A2A agents
    # Example:
    #   data-pipeline:
    #     url: http://data-agent.internal:4000
    #     description: "LangGraph data pipeline agent"

serve:                         # Web UI server mode settings
  logging:
    level: info                # debug | info | warn | error
  rateLimits:
    messagesPerMinute: 20
    concurrentSessions: 10
    wsConnectionsPerUser: 3
    maxMessageLength: 50000
    authFailuresPerMinute: 10
    wsIdleTimeoutMs: 1800000   # 30 minutes
  privacy:
    sessionRetentionDays: 90
    workspaceRetentionDays: 90
    usageRetentionDays: 365
    policyVersion: "1.0"
```

Config is loaded at startup, deep-merged with defaults. Tools are only created if enabled. Model is read from config and passed to the SDK. In serve mode, config changes are picked up automatically via hot reload.

### effort

Controls the reasoning effort level passed to the SDK. Maps to `low`, `medium`, `high`, or `max`. Defaults to `max`. Can be changed at runtime via `/effort` in the TUI.

### hooks.logToolUse

When `true`, the harness registers PreToolUse and PostToolUse hooks with the SDK. Every tool call is logged with its name, input, and result. Useful for debugging tool behavior. Disabled by default.

### hooks.verifyBeforeComplete

When `true` (default), two things happen: a verification protocol is added to the system prompt reminding the agent to re-read modified files before finishing, and a `canUseTool` callback tracks write/verify sequences. If the agent writes a file but doesn't subsequently read or grep it, the callback injects a reminder.

### hooks.loopDetection

When `true` (default), tracks per-file edit counts within a session. After `loopDetectionThreshold` edits (default: 3) to the same file, the agent receives a message suggesting it reconsider its approach. Counters reset when the agent runs a verification tool (read, grep, shell).

### hooks.compactSuccessOutput

When `true` (default), a PostToolUse hook truncates long successful tool output to keep context clean. Shell commands that succeed with more than `compactOutputThreshold` lines (default: 50) are summarized to the first 5 lines. Large grep results are summarized to count + first 10 matches. Failed commands always pass through in full.

### tools.a2a

A2A client tool configuration, under `tools.a2a`.

- `enabled` — Toggle for the A2A client tools (`a2a_discover`, `a2a_call`, `a2a_list`). Default: `true`.
- `agents` — Registry of known remote A2A agents. Each entry has a `url` and `description`. Agents registered here can be referenced by name in the A2A tools instead of by URL.

### serve

Settings for web UI server mode (`--serve`). These have no effect in TUI mode.

- `logging.level` — Log verbosity. Default: `info`.
- `rateLimits` — Per-user rate limiting for the web UI:
  - `messagesPerMinute` — Max messages per user per minute
  - `concurrentSessions` — Max concurrent active sessions
  - `wsConnectionsPerUser` — Max WebSocket connections per user
  - `maxMessageLength` — Max characters per message
  - `authFailuresPerMinute` — Auth failure rate limit per IP
  - `wsIdleTimeoutMs` — WebSocket idle timeout in milliseconds
- `privacy` — Data retention and privacy settings:
  - `sessionRetentionDays` — Days to keep session data before cleanup
  - `workspaceRetentionDays` — Days to keep workspace files
  - `usageRetentionDays` — Days to keep usage records
  - `policyVersion` — Privacy policy version (triggers re-consent when bumped)

## Access Control (Serve Mode)

Multi-user authentication for serve mode is configured in `~/.mastersof-ai/access.yaml`:

```yaml
users:
  - token_hash: "<sha256 hex of token>"
    name: "Alice"
    agents: "*"                # "*" = all agents, or list: ["analyst", "writer"]
    budget: unlimited          # or: { sessionLimit: 100000, dailyLimit: 500000, monthlyLimit: 5000000 }

  - token_hash: "<sha256 hex>"
    name: "Bob"
    agents: ["analyst"]
    budget:
      sessionLimit: 50000
      dailyLimit: 200000
      monthlyLimit: 2000000
```

Tokens are stored as SHA-256 hashes (never plaintext). Comparison uses constant-time operations to prevent timing attacks. Users with `agents: "*"` have admin access (health deep checks, reload, budget resets, data deletion).

Generate a token hash: `echo -n "your-secret-token" | sha256sum | cut -d' ' -f1`

Access.yaml is hot-reloaded on change. When a token is removed, active WebSocket connections using that token are immediately disconnected.

## CLI Interface

```
mastersof-ai                          # Start with default agent (TUI)
mastersof-ai --agent researcher       # Start with specific agent (TUI)
mastersof-ai --message "do X"         # Non-interactive single message
mastersof-ai --resume                 # Resume last session (TUI)
mastersof-ai --sandbox                # Run in bubblewrap sandbox
mastersof-ai --list-agents            # Show available agents
mastersof-ai --init                   # Force first-run setup
mastersof-ai --serve                  # Start web UI server (port 3100)
mastersof-ai --serve --port 5000      # Web UI server on custom port
mastersof-ai --serve --host 127.0.0.1 # Bind to specific host
mastersof-ai --card                   # Output A2A Agent Card JSON and exit
mastersof-ai create <name>            # Create a new agent
```

## First Run

On first run (`~/.mastersof-ai/` doesn't exist), the harness:

1. Creates `~/.mastersof-ai/` with `agents/`, `contexts/`, `intents/`, `state/` dirs
2. Copies default agent definitions from bundled defaults
3. Writes default `config.yaml`
4. Prints welcome message

## Sessions

### TUI Mode

Conversations persist as session files in `~/.mastersof-ai/state/{agent}/sessions/`. The `--resume` flag continues the last session. Sessions are JSON arrays of message turns.

### Serve Mode

Sessions are per-user: `~/.mastersof-ai/state/{agent}/sessions/{user}/`. Each user has isolated session data. Messages are persisted incrementally (appended on each turn) rather than written at session end. The WebSocket protocol supports reconnection with message replay from a `lastMessageId`.

## User Directory Layout

After install and first run:

```
~/.mastersof-ai/
├── config.yaml                    — Global config
├── access.yaml                    — Token auth for serve mode (optional)
├── agents/                        — Agent definitions
│   ├── assistant/
│   │   ├── IDENTITY.md            — Agent identity (system prompt + optional frontmatter)
│   │   └── memory/                — Persistent memory
│   │       └── CONTEXT.md
│   ├── analyst/
│   │   └── IDENTITY.md
│   └── cofounder/
│       ├── IDENTITY.md
│       ├── .env                   — Encrypted secrets (optional, see docs/secrets.md)
│       ├── sandbox.json           — Per-agent sandbox config
│       ├── workspace/             — Agent's persistent working directory
│       └── memory/
├── contexts/                      — Shared context blocks (reserved)
├── intents/                       — Shared intent blocks (reserved)
└── state/                         — Session data
    └── cofounder/
        └── sessions/
            ├── <session-files>    — TUI sessions
            └── Alice/             — Per-user sessions (serve mode)
```
