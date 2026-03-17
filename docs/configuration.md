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
```

Config is loaded at startup, deep-merged with defaults. Tools are only created if enabled. Model is read from config and passed to the SDK.

### effort

Controls the reasoning effort level passed to the SDK. Maps to `low`, `medium`, `high`, or `max`. Defaults to `max`. Can be changed at runtime via `/effort`.

### hooks.logToolUse

When `true`, the harness registers PreToolUse and PostToolUse hooks with the SDK. Every tool call is logged with its name, input, and result. Useful for debugging tool behavior. Disabled by default.

### hooks.verifyBeforeComplete

When `true` (default), two things happen: a verification protocol is added to the system prompt reminding the agent to re-read modified files before finishing, and a `canUseTool` callback tracks write/verify sequences. If the agent writes a file but doesn't subsequently read or grep it, the callback injects a reminder.

### hooks.loopDetection

When `true` (default), tracks per-file edit counts within a session. After `loopDetectionThreshold` edits (default: 3) to the same file, the agent receives a message suggesting it reconsider its approach. Counters reset when the agent runs a verification tool (read, grep, shell).

### hooks.compactSuccessOutput

When `true` (default), a PostToolUse hook truncates long successful tool output to keep context clean. Shell commands that succeed with more than `compactOutputThreshold` lines (default: 50) are summarized to the first 5 lines. Large grep results are summarized to count + first 10 matches. Failed commands always pass through in full.

### a2a

Top-level section for A2A protocol configuration.

- `enabled` — Master toggle for A2A server mode. Must be `true` for `--serve` to work.
- `port` — Default port for `--serve` mode (default: 4000). Can be overridden with `--port`.
- `agents` — Registry of known remote A2A agents. Each entry has a `url` and `description`. Agents registered here can be referenced by name in the `a2a_discover` and `a2a_call` tools instead of by URL.

## CLI Interface

```
mastersof-ai                          # Start with default agent
mastersof-ai --agent researcher       # Start with specific agent
mastersof-ai --message "do X"         # Non-interactive single message
mastersof-ai --resume                 # Resume last session
mastersof-ai --sandbox                # Run in bubblewrap sandbox
mastersof-ai --list-agents            # Show available agents
mastersof-ai --init                   # Force first-run setup
mastersof-ai --serve                  # Start as A2A server (no TUI)
mastersof-ai --serve --port 5000      # A2A server on custom port
mastersof-ai --card                   # Output Agent Card JSON and exit
mastersof-ai create <name>            # Create a new agent
```

## First Run

On first run (`~/.mastersof-ai/` doesn't exist), the harness:

1. Creates `~/.mastersof-ai/` with `agents/`, `contexts/`, `intents/`, `state/` dirs
2. Copies default agent definitions from bundled defaults
3. Writes default `config.yaml`
4. Prints welcome message

## Sessions

Conversations persist as session files in `~/.mastersof-ai/state/{agent}/sessions/`. The `--resume` flag continues the last session. Sessions are JSON arrays of message turns.

## User Directory Layout

After install and first run:

```
~/.mastersof-ai/
├── config.yaml                    — Global config
├── agents/                        — Agent definitions
│   ├── assistant/
│   │   ├── IDENTITY.md            — Agent identity (system prompt)
│   │   └── memory/                — Persistent memory
│   │       └── CONTEXT.md
│   ├── analyst/
│   │   └── IDENTITY.md
│   └── cofounder/
│       ├── IDENTITY.md
│       ├── .env                   — Encrypted secrets (optional, see docs/secrets.md)
│       ├── sandbox.json           — Per-agent sandbox config
│       └── memory/
├── contexts/                      — Shared context blocks (reserved)
├── intents/                       — Shared intent blocks (reserved)
└── state/                         — Session data
    └── cofounder/sessions/
```
