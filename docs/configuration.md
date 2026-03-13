# Configuration

## Config File

Global config lives at `~/.mastersof-ai/config.yaml`.

```yaml
model: claude-opus-4-6[1m]     # Opus 4.6 with 1M context window
defaultAgent: cofounder
effort: max                  # low | medium | high | max (default: max)
hooks:
  logToolUse: false          # Log all tool calls via PreToolUse/PostToolUse hooks
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
```

Config is loaded at startup, deep-merged with defaults. Tools are only created if enabled. Model is read from config and passed to the SDK.

### effort

Controls the reasoning effort level passed to the SDK. Maps to `low`, `medium`, `high`, or `max`. Defaults to `max`. Can be changed at runtime via `/effort`.

### hooks.logToolUse

When `true`, the harness registers PreToolUse and PostToolUse hooks with the SDK. Every tool call is logged with its name, input, and result. Useful for debugging tool behavior. Disabled by default.

## CLI Interface

```
mastersof-ai                          # Start with default agent
mastersof-ai --agent researcher       # Start with specific agent
mastersof-ai --message "do X"         # Non-interactive single message
mastersof-ai --resume                 # Resume last session
mastersof-ai --sandbox                # Run in bubblewrap sandbox
mastersof-ai --list-agents            # Show available agents
mastersof-ai --init                   # Force first-run setup
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
