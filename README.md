# @mastersof-ai/harness

[![CI](https://github.com/mastersof-ai/harness/actions/workflows/ci.yml/badge.svg)](https://github.com/mastersof-ai/harness/actions/workflows/ci.yml)

An agent runtime where you control the entire system prompt. Write a markdown file, get an agent -- no hidden framework instructions, no magic behavior injection, no black box.

```
IDENTITY.md  --->  mastersof-ai  --->  Agent with exactly the context you gave it
```

Use the terminal TUI for local development. Switch to `--serve` for a web UI that your team accesses from a browser. Both run the same agent runtime, tools, and configuration underneath.

## Why This Exists

Most agent frameworks inject their own system prompt that you can't see or override. Your carefully crafted instructions compete with hidden framework behavior. You're debugging a black box.

The harness takes a different approach:

- **Your IDENTITY.md IS the system prompt.** No hidden framework instructions. The harness adds only transparent operational context (date/time, workspace path, memory) -- no behavioral injection.
- **No separate billing.** Uses your existing Claude Code subscription or API key. Powered by the Claude Agent SDK directly.
- **Agents are just markdown.** No code to define an agent. Write a file, run a command. Optional YAML frontmatter adds metadata when you need it.
- **Two interfaces, one runtime.** Terminal TUI for solo iteration. Web UI for team/client access. Same agent behavior in both.
- **Production-ready.** Token auth, per-user isolation, rate limiting, cost caps, LGPD-compliant privacy, optional bubblewrap sandboxing.

## Install

```bash
npm install -g @mastersof-ai/harness
```

**Auth prerequisite:** The harness authenticates via Claude Code credentials or an API key.

```bash
# Option A: Claude Code credentials (uses your existing subscription)
npm install -g @anthropic-ai/claude-code && claude login

# Option B: API key
export ANTHROPIC_API_KEY=your-key
```

<details>
<summary>Linux / Ubuntu from scratch</summary>

```bash
# Install Node.js 22.x
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# Install the harness
npm install -g @mastersof-ai/harness
```
</details>

## Quick Start

**Start the default agent:**

```bash
mastersof-ai
```

On first run, `~/.mastersof-ai/` is created with three starter agents (cofounder, assistant, analyst) and a default config. You're in a TUI conversation immediately.

**Create your own agent:**

```bash
mastersof-ai create my-agent
```

This scaffolds `~/.mastersof-ai/agents/my-agent/IDENTITY.md`. Edit it:

```markdown
# Market Analyst

You are a senior market analyst. Your job is to research markets,
identify trends, and deliver clear, actionable analysis.

## How to work

- Use web search to gather current data before forming opinions.
- Structure every analysis with: thesis, evidence, risks, and conclusion.
- Save key findings to memory so they compound across sessions.
- Be direct. Commit to positions after weighing evidence.
```

Run it:

```bash
mastersof-ai --agent my-agent
```

That's it. The agent starts with exactly those instructions, plus whatever tools are enabled in your config.

## Two Interfaces

```
                    +-----------------------------------------+
                    |       Shared Agent Runtime               |
                    |  IDENTITY.md, Claude Agent SDK,          |
                    |  MCP tools, sub-agents, sessions, memory |
                    +-------+-------------------------+-------+
                            |                         |
              +-------------+----------+   +----------+--------------+
              |    Terminal TUI        |   |      Web UI             |
              |    mastersof-ai        |   |      mastersof-ai       |
              |                        |   |        --serve          |
              |  React/Ink in terminal |   |  Fastify + React SPA   |
              |  Single user, local    |   |  Multi-user, token auth |
              |  Direct keyboard I/O   |   |  Per-user isolation     |
              +------------------------+   +-------------------------+
```

### Terminal TUI

```bash
mastersof-ai                          # default agent
mastersof-ai --agent analyst          # specific agent
mastersof-ai --message "summarize X"  # headless single-shot
mastersof-ai --resume                 # resume last session
mastersof-ai --list-agents            # show available agents
```

### Web UI

```bash
mastersof-ai --serve                  # start on port 3100
mastersof-ai --serve --port 5000      # custom port
```

The web UI provides an agent card grid, streaming chat with markdown rendering, tool call display, @mention agent switching, conversation sidebar, dark mode, voice input, and i18n (English + Portuguese). It requires token auth configured in `~/.mastersof-ai/access.yaml` -- see [Configuration](docs/configuration.md).

The frontend (React + Vite + Tailwind) deploys to Cloudflare Pages. The backend runs wherever you host it.

## Tools

Agents discover tools at runtime -- no declarations needed. The same agent definition works with all tools enabled or only a few.

| Tool | What It Does |
|------|-------------|
| **memory** | Read/write persistent memory across sessions |
| **workspace** | File operations (read, write, list, search) |
| **web** | Web search (Brave) and URL fetch with content extraction |
| **shell** | Execute shell commands |
| **tasks** | Lightweight task tracking |
| **introspection** | Read and propose changes to own identity |
| **models** | Query other Claude models |
| **scratchpad** | Shared scratch space for sub-agent coordination |
| **a2a** | Discover and call remote A2A-protocol agents |

All tools are in-process MCP servers. Enable or disable any of them in `config.yaml`.

## Sub-Agents

The primary agent can delegate to three built-in sub-agents, each running in its own context:

| Sub-Agent | Purpose | Turns | Restrictions |
|-----------|---------|-------|-------------|
| **researcher** | Deep research and information gathering | 30 | No file writes, no shell |
| **deep-thinker** | Extended analysis and reasoning | 15 | No file writes, no shell |
| **writer** | Content composition and writing | 20 | No shell |

Sub-agents coordinate through a shared `.scratch/` directory -- researcher writes findings, deep-thinker reads and analyzes them, writer composes the output. The parent agent's context stays clean.

## Memory

Agents persist knowledge across sessions through two layers:

1. **Auto-loaded context** -- `CONTEXT.md` is injected into the system prompt at startup. The agent sees accumulated knowledge immediately.
2. **Memory tools** -- `memory_read`, `memory_write`, `memory_replace`, `memory_insert`, `memory_list`. The agent decides what to remember.

No auto-summarization, no RAG pipeline. The agent controls what persists. Memory files are plain markdown on disk -- inspectable, editable, portable.

See [docs/memory.md](docs/memory.md) for the full design.

## Configuration

`~/.mastersof-ai/config.yaml`:

```yaml
model: claude-opus-4-6[1m]     # Opus 4.6 with 1M context window
defaultAgent: cofounder
effort: max                     # low | medium | high | max

tools:
  memory:    { enabled: true }
  workspace: { enabled: true }
  web:       { enabled: true }
  shell:     { enabled: true }
  tasks:     { enabled: true }
  introspection: { enabled: true }
  models:    { enabled: true }
  scratchpad: { enabled: true }
  a2a:
    enabled: true
    agents:                     # Register remote A2A agents by name
      data-pipeline:
        url: http://data-agent.internal:4000
        description: "LangGraph data pipeline agent"

# Behavioral hooks
hooks:
  verifyBeforeComplete: true    # Require file verification after writes
  loopDetection: true           # Warn on repeated edits to same file
  compactSuccessOutput: true    # Truncate long successful output
```

See [docs/configuration.md](docs/configuration.md) for serve mode, access control, rate limits, privacy settings, and per-agent frontmatter.

## Agent Frontmatter

Agents can include optional YAML frontmatter for metadata, tool filtering, and access control:

```markdown
---
name: CRE Analyst
description: Commercial real estate research and analysis
tags: [research, real-estate]
starters:
  - "Analyze the Austin office market"
  - "Compare cap rates across Sun Belt metros"
access: users
users: [alice, bob]
tools:
  allow: [memory, web, workspace]
mcp:
  - server: my-db
    uri: "http://localhost:8080/sse"
---

You are a commercial real estate analyst...
```

See [docs/agents.md](docs/agents.md) for the full frontmatter reference and best practices.

## TUI Commands

| Command | Action |
|---------|--------|
| `/help` | Show all commands, shortcuts, and settings |
| `/effort [low\|med\|high\|max]` | Show or change effort level |
| `/model [model-id]` | Show or change model |
| `/sessions` | List recent sessions |
| `/resume [name\|#N]` | Resume a session |
| `/name <text>` | Rename current session |
| `/new` | Start fresh session |
| `/quit` | Exit |

**Keyboard shortcuts:** `Enter` send, `Ctrl+J` newline, `Ctrl+G` external editor, `Escape` interrupt/clear, `Ctrl+C` (double) exit.

## Security

**Access control** -- Serve mode uses SHA-256 hashed tokens in `access.yaml`. Constant-time comparison prevents timing attacks. Per-user agent restrictions and token budgets.

**Sandbox** -- Optional bubblewrap (`bwrap`) container isolates agent filesystem access. Read-only system mounts, read-write workspace, configurable network policy.

```bash
mastersof-ai --agent analyst --sandbox
```

**Serve mode hardening** -- Rate limiting, CORS origin validation, per-user workspace isolation, mandatory remote sandbox, connection limits, auth failure throttling, graceful shutdown with 30s connection draining.

**Privacy** -- LGPD-compliant data export, deletion, consent tracking, and configurable retention policies.

**Code quality** -- Strict TypeScript (`noUncheckedIndexedAccess`), Biome linting, Lefthook pre-commit hooks, GitHub Actions CI (Node 20 + 22), CodeQL security scanning (weekly), path traversal protection.

## A2A Protocol

The harness supports the Agent-to-Agent protocol in both directions:

- **As server** -- Generate Agent Cards from IDENTITY.md (`--card`). H2 sections become skills automatically.
- **As client** -- `a2a_discover`, `a2a_call`, `a2a_list` tools let your agents call remote A2A agents (LangGraph, Bedrock, other harness instances).

## Optional Dependencies

| Dependency | Used By | Purpose |
|-----------|---------|---------|
| `fd` | `find_files` tool | Fast file search |
| `rg` (ripgrep) | `grep_files` tool | Fast content search |
| `bwrap` (bubblewrap) | `--sandbox` flag | Filesystem isolation |
| `BRAVE_API_KEY` env var | `web_search` tool | Web search (Brave API) |

All optional. Tools surface clear errors if dependencies are missing.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `bubblewrap not found` | `apt install bubblewrap`, or run without `--sandbox` |
| Web search not working | Set `BRAVE_API_KEY` environment variable |
| No agents on first run | Check `~/.mastersof-ai/agents/` exists. Re-run `mastersof-ai` to trigger setup. |
| Web UI rejects requests | Create `~/.mastersof-ai/access.yaml` with user tokens. See [docs/configuration.md](docs/configuration.md). |
| Auth errors | Run `claude login` or set `ANTHROPIC_API_KEY` |

## Docs

- [Architecture](docs/architecture.md) -- Dual-interface model, data flow, source map
- [Agents](docs/agents.md) -- Agent creation, frontmatter reference, sub-agents
- [Configuration](docs/configuration.md) -- Config file, serve mode, access control
- [Memory](docs/memory.md) -- Persistent memory system
- [Tools](docs/tools.md) -- Tool system, available tools, MCP servers
- [Secrets](docs/secrets.md) -- Per-agent encrypted secrets
- [Sandbox](docs/sandbox.md) -- Bubblewrap isolation
- [Design Decisions](docs/design-decisions.md) -- Rationale for key choices
- [Changelog](CHANGELOG.md) -- Version history

## License

MIT
