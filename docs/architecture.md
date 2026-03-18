# Architecture

## Overview

The harness is a standalone agent runtime with two interfaces: a terminal TUI for single-user development and a web UI for multi-user remote access. Both interfaces share the same core: agent loading, system prompt assembly, Claude Agent SDK integration, MCP tools, sub-agents, sessions, and memory.

```
                         +------------------------------------------+
                         |          Shared Agent Runtime              |
                         |                                            |
                         |  IDENTITY.md  -->  System Prompt Assembly  |
                         |  Claude Agent SDK (query / streaming)      |
                         |  MCP Tool Servers (in-process)             |
                         |  Sub-Agents (researcher, deep-thinker,     |
                         |              writer)                       |
                         |  Sessions, Memory, Configuration           |
                         +----------+-----------------------+---------+
                                    |                       |
              +---------------------+---+           +-------+---------------------+
              |     Terminal TUI        |           |         Web UI (--serve)     |
              |                         |           |                              |
              |  React/Ink              |           |  Fastify Backend             |
              |  Single user            |           |    REST API + WebSocket      |
              |  Local sessions         |           |    Token auth (access.yaml)  |
              |  Keyboard I/O           |           |    Rate limiting, CORS       |
              |                         |           |    Per-user isolation         |
              |  src/components/App.tsx  |           |    Health monitoring          |
              |                         |           |  src/serve.ts                |
              +-------------------------+           |                              |
                                                    |  React SPA Frontend          |
                                                    |    Agent cards, chat, sidebar |
                                                    |    Tool calls, @mentions      |
                                                    |    Dark mode, i18n, voice     |
                                                    |  web/src/App.tsx              |
                                                    +------------------------------+
```

## Data Flow

### TUI Mode

```
User types message
    |
    v
App.tsx (React/Ink) --> buildSystemPrompt()
    |                       |
    |                   Loads IDENTITY.md (strips frontmatter)
    |                   Loads CONTEXT.md (persistent memory)
    |                   Adds date/time, workspace path
    |                   Adds environment context (workspace files, enabled tools)
    |                   Adds verification protocol, session continuity
    |                       |
    v                       v
buildOptions() -----> Creates MCP tool servers (config + frontmatter filtering)
    |                 Creates sub-agent registry
    |                 Registers SDK hooks (logging, compact output, loop detection)
    |                 Registers canUseTool callback (verification, approvals)
    |
    v
sendMessage() --> query() (Claude Agent SDK)
    |
    v
Stream events --> StreamingResponse.tsx renders tokens
    |               Tool calls shown inline
    |               Sub-agent progress tracked
    |
    v
Result --> ChatHistory.tsx displays conversation
           Session saved to disk
```

### Serve Mode

```
Browser connects via WebSocket
    |
    v
Fastify server (serve.ts)
    |
    +-- Authenticate token (SHA-256 hash lookup in access.yaml)
    +-- Check rate limits (per-user message rate, connection limits)
    +-- Check cost budget (session/daily/monthly token caps)
    |
    v
resolveRemoteAgent() --> Per-user workspace and memory isolation
    |                     workspace/{userId}/, memory/{userId}/
    |
    v
buildSystemPrompt() + buildOptions() (same as TUI)
    |
    v
sendMessage() --> query() (Claude Agent SDK)
    |
    v
Stream events --> WebSocket messages to browser
    |               WsToken (text/thinking), WsToolUseStart,
    |               WsAssistantMessage, sub-agent progress
    |
    v
React SPA renders conversation
    Messages persisted incrementally
    MessageBuffer supports reconnection with replay
```

## Agent Loading

```
mastersof-ai --agent analyst
    |
    v
resolveAgent("analyst")                                   [src/agent-context.ts]
    |
    +-- Validate name (no path traversal, alphanumeric + hyphens)
    +-- Check ~/.mastersof-ai/agents/analyst/ exists
    +-- Check IDENTITY.md exists
    +-- Create workspace/ if missing
    |
    v
Returns AgentContext {
    name, agentDir, identityPath,
    memoryDir, contextFile,
    stateDir, sessionsDir,
    workspaceDir
}
    |
    v
loadAgentManifest()                                       [src/manifest.ts]
    |
    +-- Parse YAML frontmatter (zod-validated)
    +-- Extract: name, description, icon, tags, starters,
    |            access, tools.allow/deny, mcp configs
    +-- Return markdown body (frontmatter stripped)
    |
    v
buildSystemPrompt()                                       [src/agent.ts]
    |
    +-- Identity (IDENTITY.md body, as-is)
    +-- Memory (CONTEXT.md if present)
    +-- Date, time, timezone
    +-- Workspace path
    +-- Environment onboarding (files, PROGRESS.json, enabled tools)
    +-- Verification protocol (if configured)
    +-- Session continuity guidance
    +-- Sub-agent coordination guidance (if scratchpad enabled)
```

## Sub-Agent Architecture

The primary agent delegates to sub-agents via the Claude Agent SDK's agent registry. Sub-agents run in separate contexts with their own system prompts, turn limits, and tool restrictions.

```
Primary Agent
    |
    +-- delegate to "researcher"
    |       maxTurns: 30
    |       disallowed: write_file, edit_file, shell_exec, AskUserQuestion
    |       Writes findings to .scratch/
    |
    +-- delegate to "deep-thinker"
    |       maxTurns: 15
    |       disallowed: write_file, edit_file, shell_exec, AskUserQuestion
    |       Reads from .scratch/, writes analysis back
    |
    +-- delegate to "writer"
            maxTurns: 20
            disallowed: shell_exec, AskUserQuestion
            Reads .scratch/ findings + analysis, composes output
```

The `.scratch/` directory (`workspace/.scratch/`) is the coordination point. Sub-agents write intermediate results there instead of passing everything through the parent's context window. The scratchpad tool confines all paths to `.scratch/` -- no escape is possible.

## Tool System

Tools are in-process MCP servers, one per domain. Two layers of filtering determine which tools an agent gets:

```
Layer 1: Global config (config.yaml)     Layer 2: Agent frontmatter
    tools.memory.enabled: true       +    tools.allow: [memory, web]
    tools.shell.enabled: true        +    (or tools.deny: [shell])
                                     =
                              Actual tools created
```

The SDK's MCP tool search is automatically enabled when tool descriptions exceed 10% of the context window. The SDK defers less relevant tools and searches on demand -- transparent to agents.

External MCP servers declared in agent frontmatter are merged with harness servers at startup. URI-based servers (HTTP transport) are always allowed. Command-based servers (stdio transport) are only allowed in CLI mode or sandboxed remote sessions.

## Serve Mode Architecture

```
                    +---------- Fastify Server -----------+
                    |                                      |
                    |  REST API                            |
                    |    GET  /api/agents          Roster  |
                    |    GET  /api/agents/:id       Detail |
                    |    GET  /api/sessions         List   |
                    |    POST /api/sessions         Create |
                    |    GET  /api/sessions/:id/messages   |
                    |    DEL  /api/sessions/:id     Delete |
                    |    GET  /api/usage           Tracking|
                    |    GET  /health              Shallow |
                    |    GET  /health/deep         Admin   |
                    |    POST /api/admin/reload     Manual |
                    |    POST /api/admin/users/:id/budget  |
                    |    GET  /api/privacy         Policy  |
                    |    GET  /api/users/:id/data  Export  |
                    |    DEL  /api/users/:id/data  Delete  |
                    |                                      |
                    |  WebSocket /ws                       |
                    |    Streaming conversation             |
                    |    Tool call approvals                |
                    |    Reconnection with message replay   |
                    |                                      |
                    |  Middleware                           |
                    |    CORS origin validation             |
                    |    Rate limiting (HTTP + WS)          |
                    |    Token authentication               |
                    |                                      |
                    |  Background                           |
                    |    FileWatcher (hot reload)           |
                    |    CostTracker (budget persistence)   |
                    |    Retention cleanup (daily)          |
                    |    Buffer sweep (5 min)               |
                    +--------------------------------------+
```

**Multi-user isolation:**

Each authenticated user gets:
- Isolated workspace: `agents/{name}/workspace/{userId}/`
- Isolated memory: `agents/{name}/memory/{userId}/`
- Isolated sessions: `state/{agent}/sessions/{userId}/`
- Independent token budget tracking
- Independent rate limiting

The shared agent memory (`memory/CONTEXT.md`) is read-only for remote users -- they can read it but writes go to their own memory directory.

**Hot reload:**

A file watcher monitors three paths:
- `~/.mastersof-ai/agents/` -- roster changes broadcast to all connected clients
- `~/.mastersof-ai/config.yaml` -- config reloaded, rate limits updated
- `~/.mastersof-ai/access.yaml` -- tokens reloaded, revoked tokens disconnected immediately

## User Directory Layout

```
~/.mastersof-ai/
+-- config.yaml                    Global configuration
+-- access.yaml                    Token auth for serve mode (optional)
+-- agents/
|   +-- cofounder/
|   |   +-- IDENTITY.md            Agent identity (system prompt + frontmatter)
|   |   +-- .env                   Encrypted secrets (optional)
|   |   +-- sandbox.json           Sandbox config (optional)
|   |   +-- workspace/             Persistent working directory
|   |   |   +-- .scratch/          Sub-agent coordination directory
|   |   |   +-- Alice/             Per-user workspace (serve mode)
|   |   +-- memory/
|   |       +-- CONTEXT.md         Auto-loaded persistent memory
|   |       +-- Alice/             Per-user memory (serve mode)
|   +-- analyst/
|   |   +-- IDENTITY.md
|   +-- assistant/
|       +-- IDENTITY.md
+-- state/
    +-- cofounder/
        +-- sessions/
        |   +-- <session-files>    TUI sessions
        |   +-- Alice/             Per-user sessions (serve mode)
        +-- stderr.log
```

## Source Code Map

For contributors -- where to find things:

| Area | File(s) | What It Does |
|------|---------|-------------|
| CLI entry | `bin/mastersof-ai.js`, `src/index.tsx` | Arg parsing, mode dispatch (TUI / serve / headless) |
| Agent loading | `src/agent-context.ts`, `src/manifest.ts` | Resolve paths, parse frontmatter |
| System prompt | `src/agent.ts` | Assemble prompt, build SDK options, hooks, canUseTool |
| Identity parsing | `src/prompt.ts` | Load raw IDENTITY.md content |
| Configuration | `src/config.ts` | Load + merge YAML config with defaults |
| Tools | `src/tools/index.ts` | Create MCP servers, tool filtering, external MCP merge |
| Individual tools | `src/tools/{name}.ts` | One file per tool domain |
| Sub-agents | `src/agents/{name}.ts` | Sub-agent definitions (system prompt, constraints) |
| TUI | `src/components/App.tsx` | React/Ink terminal UI (reducer pattern) |
| Serve backend | `src/serve.ts` | Fastify server, REST routes, WebSocket handler |
| Web frontend | `web/src/` | React SPA (Vite, Tailwind, Radix, Zustand) |
| Auth | `src/access.ts` | Token auth, access.yaml loading, agent filtering |
| Sessions | `src/sessions.ts` | Session CRUD, persistence |
| Messages | `src/message-store.ts`, `src/message-buffer.ts` | Message persistence + reconnection buffer |
| Rate limiting | `src/rate-limit.ts` | Per-user message/connection/auth rate limits |
| Cost tracking | `src/cost.ts` | Per-user token budget (session/daily/monthly) |
| Health | `src/health.ts` | Shallow + deep health checks |
| Privacy | `src/privacy.ts` | LGPD: consent, export, deletion, retention |
| Hot reload | `src/watcher.ts` | File watcher for agents/config/access changes |
| Sandbox | `src/sandbox.ts` | Bubblewrap container setup |
| Secrets | `src/env.ts` | Per-agent .env loading via dotenvx |
| Errors | `src/errors.ts` | Error classification + diagnostics |
| Logging | `src/logger.ts` | Structured logging with levels |
| Path safety | `src/path-safety.ts` | Path traversal validation |
| A2A server | `src/a2a/server.ts` | Express A2A endpoint (JSON-RPC) |
| A2A cards | `src/a2a/agent-card.ts` | Agent Card generation from IDENTITY.md |
| A2A executor | `src/a2a/executor.ts` | Bridge A2A task lifecycle to harness |
| A2A client | `src/tools/a2a.ts` | MCP tools: discover, call, list remote agents |

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Runtime | Node.js 20+ via tsx (no build step for backend) |
| SDK | @anthropic-ai/claude-agent-sdk ^0.2.76 |
| Tools | MCP protocol (in-process servers) |
| Config | YAML (config.yaml, access.yaml) |
| TUI | React + Ink |
| Serve backend | Fastify (HTTP + WebSocket) |
| Auth | SHA-256 token hashing, constant-time comparison |
| Web frontend | React 19 + Vite + Tailwind CSS 4 + Radix UI |
| Frontend state | Zustand |
| Frontend routing | React Router 7 |
| i18n | i18next (English + Portuguese) |
| Frontend deploy | Cloudflare Pages |
| A2A protocol | @a2a-js/sdk |
| A2A server | Express (separate from Fastify -- A2A has its own SDK) |
| Sandbox | bubblewrap (bwrap) |
| Secrets | dotenvx |
| Schema validation | Zod 4 |
| Linting | Biome |
| Pre-commit | Lefthook |
| CI | GitHub Actions (Node 20 + 22) |
| Security scanning | CodeQL (weekly) |
