# Architecture

## What The Harness Is

A standalone terminal-based agent runtime. Install it, write a markdown agent definition, run an agent. That's the complete story.

The harness reads agent definitions (plain markdown files), connects them to a model, provides tools via MCP, and handles I/O through a React/Ink TUI.

## How It Works

1. User starts the harness (optionally specifying an agent)
2. Harness loads the agent definition — reads `IDENTITY.md` from the agent's directory
3. Loads persistent memory (`CONTEXT.md`) if present
4. Builds the system prompt: identity + memory + environment onboarding + verification protocol + current date/timezone
5. Creates MCP tool servers based on config (only enabled tools)
6. Connects to the model via Claude Agent SDK
7. Launches TUI for interactive conversation (or starts A2A server if `--serve`)
8. Handles tool calls, streaming responses, sub-agent delegation

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
│   ├── config.ts                — Config loading + defaults
│   ├── first-run.ts             — First run setup
│   ├── create-agent.ts          — `mastersof-ai create <name>`
│   ├── agent-context.ts         — Resolve agent paths and content
│   ├── agent.ts                 — Build system prompt, SDK options, hooks
│   ├── prompt.ts                — Load identity/definition file
│   ├── sandbox.ts               — Bubblewrap sandbox (--sandbox)
│   ├── sessions.ts              — Session persistence
│   ├── a2a/                     — A2A protocol integration
│   │   ├── index.ts             — Module exports
│   │   ├── server.ts            — Express A2A server (--serve mode)
│   │   ├── agent-card.ts        — Agent Card generation from IDENTITY.md
│   │   └── executor.ts          — AgentExecutor bridge (A2A → harness)
│   ├── agents/                  — Sub-agent definitions (TypeScript)
│   │   ├── index.ts
│   │   ├── researcher.ts
│   │   ├── deep-thinker.ts
│   │   └── writer.ts
│   ├── tools/                   — MCP tool servers
│   │   ├── index.ts             — Server creation (config-aware)
│   │   ├── memory.ts
│   │   ├── web.ts
│   │   ├── workspace.ts
│   │   ├── shell.ts
│   │   ├── introspection.ts
│   │   ├── model-query.ts
│   │   ├── tasks.ts
│   │   ├── scratchpad.ts        — Sub-agent shared scratchpad (.scratch/)
│   │   └── a2a.ts               — A2A client tools (discover, call, list)
│   ├── components/              — React/Ink TUI
│   │   ├── App.tsx              — Main app component
│   │   ├── ChatHistory.tsx
│   │   ├── InputArea.tsx
│   │   ├── StreamingResponse.tsx
│   │   ├── Message.tsx
│   │   ├── MultilineInput.tsx
│   │   └── ThinkingAnimation.tsx
│   ├── lib/                     — Utilities
│   │   ├── editor.ts            — External editor support (Ctrl+G)
│   │   └── ink-clear.ts         — Ink instance cleanup
│   └── types/
│       └── marked-terminal.d.ts — Type shim
└── package.json
```

## Tech Stack

- **Runtime:** Node.js + tsx (no build step)
- **SDK:** @anthropic-ai/claude-agent-sdk ^0.2.75 (Claude Agent SDK)
- **TUI:** React + Ink
- **Tools:** MCP protocol (in-process servers)
- **A2A:** @a2a-js/sdk + Express (A2A protocol server and client)
- **Config:** YAML
- **Sessions:** JSON files
- **Sandbox:** bubblewrap (bwrap)

## A2A Server Mode

When started with `--serve`, the harness exposes the agent as an A2A-compatible HTTP endpoint instead of launching the TUI. Any A2A client (AWS Bedrock, Google ADK, LangGraph, etc.) can call the agent.

The server provides two endpoints:
- `GET /.well-known/agent-card.json` — Agent Card derived from IDENTITY.md (name, description, skills from H2 sections)
- `POST /` — JSON-RPC 2.0 per the A2A protocol spec

The executor bridges A2A task lifecycle to the harness's existing `sendMessage()` / `Query` flow. Tasks move through submitted, working, completed (or failed) states. The in-memory task store comes from the A2A SDK.
