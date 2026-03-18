# @mastersof-ai/harness

[![CI](https://github.com/mastersof-ai/harness/actions/workflows/ci.yml/badge.svg)](https://github.com/mastersof-ai/harness/actions/workflows/ci.yml)

Define agents in markdown. Control the entire system prompt. No hidden framework instructions coloring your agent's behavior.

Write an `IDENTITY.md`, run `mastersof-ai`, and your agent starts with exactly the context you gave it — nothing more. Use the terminal TUI for single-user iteration, or `--serve` for a web UI that multiple users can access from their browser. Both share the same agent runtime, tools, and configuration.

## Install

```bash
npm install -g @mastersof-ai/harness
```

### Linux / Ubuntu

```bash
# Install Node.js 22.x
apt-get update && apt-get install -y curl
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# Install the harness
npm install -g @mastersof-ai/harness
```

**Auth prerequisite:** The harness authenticates via Claude Code credentials or an API key. Before first run:

- **Claude Code:** `npm install -g @anthropic-ai/claude-code && claude login`
- **API key:** `export ANTHROPIC_API_KEY=your-key`

## Quick Start

### Terminal TUI (single user)

```bash
mastersof-ai                          # first-run setup, starts default agent
mastersof-ai --agent analyst          # start a specific agent
mastersof-ai --message "hello"        # headless one-shot mode
mastersof-ai --resume                 # resume last session
mastersof-ai create my-agent          # scaffold a new agent
mastersof-ai --list-agents            # list available agents
```

### Web UI (multi-user)

```bash
mastersof-ai --serve                  # start web server on port 3100
mastersof-ai --serve --port 5000      # custom port
```

The web UI requires token-based auth configured in `~/.mastersof-ai/access.yaml`. See [Configuration](docs/configuration.md) for setup.

On first run, `~/.mastersof-ai/` is created with three default agents:

- **cofounder** — co-founder template with self-improvement tools (default)
- **assistant** — general purpose
- **analyst** — research and analysis

## Creating Agents

```bash
mastersof-ai create my-agent
```

This creates `~/.mastersof-ai/agents/my-agent/` with a template `IDENTITY.md`. Edit the identity file to customize your agent's personality, instructions, and behavior. Optionally add YAML frontmatter for metadata like display name, description, tool restrictions, and access control.

Three example agents ship in `defaults/agents/` (cofounder, assistant, analyst). They're copied to `~/.mastersof-ai/agents/` on first run — use them as templates for your own.

## How It Works

- **Identity is markdown.** Each agent is defined by an `IDENTITY.md` file — no code required. Optional YAML frontmatter adds structured metadata.
- **Two interfaces.** Terminal TUI for local iteration. Web UI (`--serve`) for multi-user remote access. Same agent runtime underneath.
- **Persistent memory.** Agents read and write to `~/.mastersof-ai/agents/{name}/memory/`. Context survives across sessions.
- **Built-in tools.** Memory, workspace (file ops), web search/fetch, shell, task tracking, introspection, model queries, A2A client.
- **Sub-agents.** Researcher, deep-thinker, and writer handle delegated work in separate contexts.
- **Session management.** Named sessions with resume, rename, and history. Per-user isolation in serve mode.
- **Config-driven.** Optional `~/.mastersof-ai/config.yaml` for model selection, tool toggles, and serve mode settings.
- **Sandbox.** Optional `--sandbox` flag runs the agent inside a bubblewrap container for filesystem isolation.

## Configuration

Edit `~/.mastersof-ai/config.yaml`:

```yaml
model: claude-opus-4-6[1m]    # default model for all agents
defaultAgent: cofounder        # agent started with no --agent flag
effort: max                    # low | medium | high | max

tools:
  memory:
    enabled: true
  workspace:
    enabled: true
  web:
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

See [docs/configuration.md](docs/configuration.md) for serve mode settings, access control, rate limits, and privacy config.

## TUI Commands

Inside the TUI:

- `/help` — show all commands, shortcuts, and current settings
- `/effort [low|med|high|max]` — show or set effort level
- `/model [model-id]` — show or set model
- `/sessions` — list recent sessions
- `/resume [name|#N]` — resume a session
- `/name <text>` — rename current session
- `/new` — start a fresh session
- `/quit` — exit

**Keyboard shortcuts:**

- `Enter` — send message
- `Ctrl+J` — insert newline
- `Ctrl+G` — open external editor
- `Escape` — interrupt streaming / clear input
- `Ctrl+C` (double) — exit

## Auth

Uses your Claude Code subscription. No API key needed.

## Sandbox

Run any agent in a [bubblewrap](https://github.com/containers/bubblewrap) sandbox for filesystem isolation:

```bash
mastersof-ai --agent cofounder --sandbox
```

The sandbox mounts system directories read-only, gives the agent read-write access to its memory, session state, and a configured project directory, and isolates PID/IPC namespaces. On first use, a default `sandbox.json` is created in the agent's directory. Edit it to customize mounts, environment variables, and network access.

Requires `bwrap` to be installed (`apt install bubblewrap` or equivalent).

## Optional Dependencies

- `fd` — used by `find_files` tool (fast file search)
- `rg` (ripgrep) — used by `grep_files` tool (fast content search)

Both are optional. Tools return clear errors if the binaries are missing.

## Web Search

Set `BRAVE_API_KEY` environment variable to enable the `web_search` tool. `web_fetch` works without it.

## Troubleshooting

- **`bubblewrap not found`** — Install bwrap (`apt install bubblewrap` or equivalent), or run without `--sandbox`.
- **API key not set** — Web search requires `BRAVE_API_KEY` to be set in your environment.
- **No agents on first run** — Check that `~/.mastersof-ai/agents/` was created and contains agent directories. Re-run `mastersof-ai` to trigger first-run setup.
- **Web UI rejects all requests** — Create `~/.mastersof-ai/access.yaml` with at least one user token. See [Configuration](docs/configuration.md).

## License

MIT
