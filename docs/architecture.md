# Architecture

## What The Harness Is

A standalone agent runtime with two interfaces: a terminal TUI for single-user iteration, and a web UI for multi-user remote access. Write a markdown agent definition, run an agent — interactively via TUI or as a web service via `--serve`. Both interfaces share the same agent runtime, tools, and configuration.

## Dual-Interface Model

```
                       ┌──────────────────────────────────────────┐
                       │          Shared Agent Runtime             │
                       │  IDENTITY.md loading, system prompt,      │
                       │  Claude Agent SDK, MCP tools, sub-agents  │
                       └─────────────┬────────────────┬───────────┘
                                     │                │
                 ┌───────────────────┘                └───────────────────┐
                 │                                                       │
    ┌────────────▼──────────────┐                  ┌─────────────────────▼─────────────┐
    │     Terminal TUI          │                  │         Web UI (--serve)           │
    │  mastersof-ai [--agent x] │                  │  mastersof-ai --serve [--port N]   │
    │                           │                  │                                    │
    │  React/Ink terminal UI    │                  │  Fastify backend (REST + WebSocket)│
    │  Single user, local       │                  │  React SPA frontend (web/)         │
    │  Sessions on disk         │                  │  Multi-user with token auth        │
    │  Direct keyboard I/O      │                  │  Per-user session isolation         │
    └───────────────────────────┘                  └────────────────────────────────────┘
```

### Terminal TUI

The default mode. Single-user, interactive, runs in a terminal. React/Ink renders the UI. Sessions are stored locally. Best for iterative agent work, development, and personal use.

```bash
mastersof-ai                          # default agent
mastersof-ai --agent analyst          # specific agent
mastersof-ai --resume                 # resume last session
```

### Web UI (Serve Mode)

Started with `--serve`. A Fastify HTTP server exposes a REST API and WebSocket endpoint. A separate React SPA (in `web/`) connects to the server and provides a browser-based chat interface. Multiple users connect simultaneously, each with their own sessions and workspace isolation. Authentication is token-based via `~/.mastersof-ai/access.yaml`.

```bash
mastersof-ai --serve                  # start on port 3100
mastersof-ai --serve --port 5000      # custom port
```

The backend provides:
- **REST API** — Agent roster (`/api/agents`), session CRUD (`/api/sessions`), usage tracking (`/api/usage`), health checks (`/health`), privacy endpoints, admin operations
- **WebSocket** (`/ws`) — Real-time streaming of text tokens, thinking tokens, tool calls, sub-agent progress, tool approval requests
- **Security** — Token auth, rate limiting, CORS origin validation, per-user cost caps, connection limits
- **Operations** — Health monitoring, hot reload (watches agents dir + config files), graceful shutdown with connection draining, structured logging

The frontend provides:
- Agent card grid (home screen)
- Conversation sidebar with session management
- Streaming chat with markdown rendering
- Tool call display (collapsible, with approval flow)
- @mention agent switching
- Dark mode, i18n (English + Portuguese), voice input
- WebSocket reconnection with message replay

## How It Works

1. User starts the harness (optionally specifying an agent)
2. Harness loads the agent definition — reads `IDENTITY.md` from the agent's directory
3. Parses optional YAML frontmatter for metadata (name, description, tools, access, MCP servers)
4. Loads persistent memory (`CONTEXT.md`) if present
5. Builds the system prompt: identity + memory + environment onboarding + verification protocol + current date/timezone
6. Creates MCP tool servers based on config and frontmatter (only enabled + allowed tools)
7. Connects to the model via Claude Agent SDK
8. Launches TUI for interactive conversation, or starts Fastify server if `--serve`
9. Handles tool calls, streaming responses, sub-agent delegation

## Source Layout

```
mastersof-ai-harness/
├── bin/mastersof-ai.js          — Entry point (tsx wrapper)
├── defaults/agents/             — Default agents (copied on first run)
│   ├── assistant/IDENTITY.md
│   ├── analyst/IDENTITY.md
│   └── cofounder/IDENTITY.md
├── src/
│   ├── index.tsx                — CLI entry, arg parsing, TUI/server launch
│   ├── config.ts                — Config loading + defaults (HarnessConfig type)
│   ├── serve.ts                 — Fastify HTTP/WS server (--serve mode)
│   ├── access.ts                — Token auth, access.yaml loading, agent filtering
│   ├── manifest.ts              — IDENTITY.md frontmatter parsing (zod schemas)
│   ├── first-run.ts             — First run setup
│   ├── create-agent.ts          — `mastersof-ai create <name>`
│   ├── agent-context.ts         — Resolve agent paths, listAgents()
│   ├── agent.ts                 — Build system prompt, SDK options, hooks
│   ├── prompt.ts                — Load identity/definition file
│   ├── env.ts                   — Per-agent .env loading (dotenvx)
│   ├── errors.ts                — Error classification + diagnostics
│   ├── sandbox.ts               — Bubblewrap sandbox (--sandbox)
│   ├── sessions.ts              — Session persistence
│   ├── message-store.ts         — Per-session message persistence (serve mode)
│   ├── message-buffer.ts        — In-memory message buffer for WS reconnection
│   ├── cost.ts                  — Per-user token budget tracking
│   ├── usage.ts                 — Usage tracking (per-session, per-user)
│   ├── rate-limit.ts            — Rate limiting (messages, connections, auth)
│   ├── health.ts                — Health monitoring (shallow + deep checks)
│   ├── privacy.ts               — LGPD: consent, export, deletion, retention
│   ├── logger.ts                — Structured logging
│   ├── watcher.ts               — File watcher for hot reload
│   ├── a2a/                     — A2A protocol integration
│   │   ├── index.ts             — Module exports
│   │   ├── server.ts            — Express A2A server (JSON-RPC endpoint)
│   │   ├── agent-card.ts        — Agent Card generation from IDENTITY.md
│   │   └── executor.ts          — AgentExecutor bridge (A2A → harness)
│   ├── agents/                  — Sub-agent definitions (TypeScript)
│   │   ├── index.ts
│   │   ├── researcher.ts
│   │   ├── deep-thinker.ts
│   │   └── writer.ts
│   ├── tools/                   — MCP tool servers
│   │   ├── index.ts             — Server creation (config + frontmatter-aware)
│   │   ├── memory.ts
│   │   ├── web.ts
│   │   ├── workspace.ts
│   │   ├── shell.ts
│   │   ├── introspection.ts
│   │   ├── model-query.ts
│   │   ├── tasks.ts
│   │   ├── scratchpad.ts        — Sub-agent shared scratchpad (.scratch/)
│   │   └── a2a.ts               — A2A client tools (discover, call, list)
│   ├── components/              — React/Ink TUI (terminal interface)
│   │   ├── App.tsx              — Main app component
│   │   ├── ChatHistory.tsx
│   │   ├── InputArea.tsx
│   │   ├── StreamingResponse.tsx
│   │   ├── Message.tsx
│   │   ├── MultilineInput.tsx
│   │   ├── AskUserQuestion.tsx
│   │   └── ThinkingAnimation.tsx
│   ├── lib/                     — Utilities
│   │   ├── editor.ts            — External editor support (Ctrl+G)
│   │   └── ink-clear.ts         — Ink instance cleanup
│   └── types/
│       ├── ws.ts                — WebSocket protocol types (shared with frontend)
│       └── marked-terminal.d.ts — Type shim
├── web/                         — Web frontend SPA
│   ├── src/
│   │   ├── App.tsx              — Router, auth guard, app shell
│   │   ├── main.tsx             — Entry point
│   │   ├── components/
│   │   │   ├── agents/          — AgentCard, AgentGrid
│   │   │   ├── auth/            — AuthGuard, TokenEntry
│   │   │   ├── chat/            — ChatPanel, InputArea, MessageBubble,
│   │   │   │                      ToolCallBlock, MentionAutocomplete,
│   │   │   │                      SubagentIndicator
│   │   │   ├── layout/          — AppShell, AgentView
│   │   │   ├── sidebar/         — ConversationSidebar, ConversationItem
│   │   │   ├── shared/          — ReconnectBanner, StatusDot
│   │   │   └── ui/              — Radix-based primitives (button, card, etc.)
│   │   ├── hooks/               — useAgentChat, useAgentRoster, useAuth,
│   │   │                          useSessions, useTheme, useVoiceInput
│   │   ├── stores/              — Zustand stores (auth, chat, ui)
│   │   ├── lib/                 — API client, WS client, constants, i18n
│   │   ├── locales/             — en.json, pt-BR.json
│   │   └── types/               — Frontend type definitions
│   ├── vite.config.ts           — Dev proxy to backend on localhost:3100
│   └── wrangler.toml            — Cloudflare Pages deployment config
└── package.json
```

## Tech Stack

**Shared:**
- **Runtime:** Node.js + tsx (no build step for backend)
- **SDK:** @anthropic-ai/claude-agent-sdk ^0.2.76 (Claude Agent SDK)
- **Tools:** MCP protocol (in-process servers)
- **Config:** YAML (`config.yaml`, `access.yaml`)
- **Sandbox:** bubblewrap (bwrap)

**Terminal TUI:**
- **UI:** React + Ink
- **Sessions:** JSON files on disk

**Web UI Backend (serve mode):**
- **Server:** Fastify (HTTP + WebSocket)
- **Auth:** Token-based (SHA-256 hashed tokens in `access.yaml`)
- **Sessions:** Per-user JSON files on disk
- **Monitoring:** Health checks, structured logging, cost tracking

**Web UI Frontend:**
- **Framework:** React 19 + Vite
- **Styling:** Tailwind CSS 4 + Radix UI
- **State:** Zustand stores
- **Routing:** React Router 7
- **i18n:** i18next (English + Portuguese)
- **Deploy:** Cloudflare Pages

**A2A Protocol:**
- **SDK:** @a2a-js/sdk (server + client)
- **Server:** Express (standalone A2A endpoint)
- **Client:** MCP tools (`a2a_discover`, `a2a_call`, `a2a_list`)

## A2A Protocol

The harness integrates with the A2A (Agent-to-Agent) protocol in two directions:

**As A2A server** — The `src/a2a/` module provides an Express-based A2A endpoint. Agent Cards are generated from IDENTITY.md (H2 sections become skills). The `--card` flag outputs the Agent Card JSON. The AgentExecutor bridges A2A task lifecycle to the harness's `sendMessage()` / `Query` flow.

**As A2A client** — The `a2a_discover`, `a2a_call`, and `a2a_list` tools let agents call remote A2A-compatible services (LangGraph pipelines, Bedrock agents, other harness instances). Agents are registered in `config.yaml` under `tools.a2a.agents` or discovered by URL.
