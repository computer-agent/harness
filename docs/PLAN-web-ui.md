# Plan: Web UI for Mastersof-AI Harness

**Goal:** Write an IDENTITY.md → agent appears in a web UI → partners can use it.

**Architecture:**
```
Cloudflare Pages (SPA)          Server (VPS / Fly.io / Railway)
┌──────────────────────┐        ┌─────────────────────────────────┐
│ Vite + React + shadcn│  WS    │ Harness --serve mode            │
│ + assistant-ui       │◄──────►│ Express + WS                    │
│                      │        │ Claude Agent SDK (unchanged)    │
│ Agent card grid      │  REST  │ IDENTITY.md loading + frontmatter│
│ Conversation sidebar │◄──────►│ MCP tools (in-process)          │
│ Streaming chat       │        │ Per-user workspace isolation    │
│ Tool call display    │        │ Token auth (access.yaml)        │
│ Voice input          │        │ Sandbox enforcement (remote)    │
└──────────────────────┘        └──────────┬──────────────────────┘
                                           │
                                  Cloudflare AI Gateway (free)
                                           │
                                    Anthropic API → Opus 4.6
```

**Repo structure:** Same repo, monorepo layout.
```
mastersof-ai-harness/
├── bin/mastersof-ai.js          # CLI entry (unchanged)
├── src/                         # Harness core (unchanged)
│   ├── agent.ts                 # SDK interface
│   ├── agent-context.ts         # Agent loading + discovery
│   ├── config.ts                # Configuration
│   ├── sessions.ts              # Session persistence
│   ├── tools/                   # MCP tool servers
│   ├── agents/                  # Sub-agent definitions
│   ├── components/              # TUI (unchanged, still works)
│   ├── serve.ts                 # NEW: HTTP/WS server
│   ├── manifest.ts              # NEW: IDENTITY.md frontmatter parsing
│   └── types/                   # NEW: Shared types (WS protocol, AgentManifest)
├── web/                         # NEW: Frontend SPA
│   ├── src/
│   │   ├── App.tsx
│   │   ├── components/          # Chat, AgentGrid, ConvoSidebar, etc.
│   │   ├── hooks/               # useAgentChat, useAgentRoster, etc.
│   │   └── lib/                 # WS client, auth, i18n
│   ├── package.json
│   ├── vite.config.ts
│   └── wrangler.toml            # Cloudflare Pages config
├── docs/
│   ├── PLAN-web-ui.md           # This file
│   ├── proposal-agent-deployment.md
│   └── research/                # All research docs
└── package.json                 # Root workspace
```

**Deploy targets:**
- Frontend: Cloudflare Pages (free tier, global CDN, `wrangler pages deploy`)
- Backend: Fly.io or Railway or Hetzner VPS (needs Node.js + filesystem)
- API proxy: Cloudflare AI Gateway (free, logging + rate limiting)
- Auth: Cloudflare Access + Tunnel (free for ≤50 users) OR token-based (access.yaml)

**Key decisions locked:**
- V1 `query()` API with `resume` (NOT V2 unstable API)
- Vite + React SPA on Cloudflare Pages (NOT Next.js, NOT Vercel)
- Same repo, `web/` directory
- WebSocket for streaming, REST for roster/sessions/config
- IDENTITY.md frontmatter for agent manifest (no separate registry)
- Token-based access control for v1

**Detailed phase requirements (hand these to implementation agents):**
- [Phase 1: Frontmatter + Tool Filtering](phases/phase-1-frontmatter.md) — Types, zod schemas, test code, CLI verification
- [Phase 2: Serve Mode](phases/phase-2-serve-mode.md) — WS protocol, REST endpoints, global state fixes, curl/wscat tests
- [Phase 3: Web Frontend](phases/phase-3-web-frontend.md) — Component specs, wireframes, i18n, dependency graph
- [Phase 4: Security + Production](phases/phase-4-security.md) — Sandbox enforcement, LGPD, adversarial tests

---

## Phase 1: Frontmatter + Tool Filtering

**Value:** Per-agent tool restrictions work in CLI mode immediately. Foundation for everything else.

**No web work.** Pure harness enhancement.

### Tasks

- [ ] **1.1 Frontmatter parser** — Add `src/manifest.ts`
  - Parse YAML frontmatter from IDENTITY.md (split on `---`, use existing `yaml` dep)
  - Define `AgentFrontmatter` type (all fields from proposal)
  - Define `AgentManifest` type (parsed + computed display fields)
  - `loadAgentManifest(agentDir)` → `AgentManifest`
  - Backward compatible: no frontmatter = all defaults
  - Validate with zod schema

- [ ] **1.2 Agent discovery** — Refactor `src/agent-context.ts`
  - Extract `listAgents()` function from `--list-agents` inline code in index.tsx
  - Returns `AgentManifest[]` with display metadata
  - `resolveAgent()`: throw error instead of `process.exit(1)`

- [ ] **1.3 Tool filtering** — Modify `src/tools/index.ts`
  - `createAgentServers()` accepts `AgentFrontmatter.tools` (allow/deny)
  - Filter tool domains by intersection of global config + agent frontmatter
  - Test: agent with `tools.allow: [memory, web]` only gets those servers

- [ ] **1.4 Update --list-agents** — Show name, description, tools, access from frontmatter

- [ ] **1.5 Test with existing agents** — Add frontmatter to one agent, verify tool filtering works

### Done when
`mastersof-ai --list-agents` shows rich metadata. An agent with `tools.allow: [memory, web]` cannot use shell or workspace tools.

---

## Phase 2: Serve Mode (Backend)

**Value:** Agents accessible via WebSocket/REST API. No frontend yet — test with curl/wscat.

### Pre-work: Fix global state

- [ ] **2.0a Remove process.chdir()** — Pass `cwd` per-request to tools/SDK instead of global chdir
- [ ] **2.0b Scope env loading** — Don't merge agent `.env` into `process.env`; pass as env option to SDK
- [ ] **2.0c Error handling** — Replace all `process.exit()` with thrown errors in library code

### Server

- [ ] **2.1 src/serve.ts** — HTTP/WS server
  - Fastify (fast, typed, WS support, CORS built-in)
  - REST endpoints:
    - `GET /api/agents` — filtered agent roster (by token)
    - `GET /api/agents/:id` — single agent manifest
    - `GET /api/sessions` — list sessions for an agent
    - `POST /api/sessions` — create session
    - `DELETE /api/sessions/:id` — delete session
    - `GET /health` — health check
  - WebSocket endpoint: `/ws`
    - `subscribe { agentId, sessionId? }` — start or resume conversation
    - `message { content }` — send user message
    - `interrupt` — cancel current generation
    - Server sends: `token`, `tool_use`, `tool_result`, `assistant_message`, `error`, `status`
  - Per-request agent resolution (not global)
  - Stream SDK output to WebSocket

- [ ] **2.2 Token auth** — `access.yaml` + middleware
  - Load `~/.mastersof-ai/access.yaml` on startup
  - Validate `Authorization: Bearer <token>` on every request
  - Filter agent roster by token's allowed agents + agent's access field
  - Reject unauthorized agent access with 403

- [ ] **2.3 Session management** — Reuse existing `sessions.ts`
  - Map REST endpoints to existing session CRUD
  - SDK `resume: sessionId` for continuing conversations

- [ ] **2.4 Message buffer** — Server-side per-conversation
  - Buffer last N messages for WebSocket reconnection
  - On reconnect: client sends `lastMessageId`, server replays missed messages
  - Critical for mobile users on unstable connections

- [ ] **2.5 Cost tracking** — Per-session token counting
  - Intercept SDK stream `result` messages for usage data
  - Accumulate per-session, per-user
  - Expose via REST: `GET /api/usage`

- [ ] **2.6 --serve flag** — Add to src/index.tsx
  - `--serve` starts Fastify instead of TUI
  - `--port` (default 3000), `--host` (default 0.0.0.0)
  - All other flags still work (--sandbox, etc.)

### Done when
`mastersof-ai --serve --port 3000` starts. Can connect via wscat/curl, send messages, get streaming responses, list agents, manage sessions. Token auth works.

---

## Phase 3: Web Frontend (SPA)

**Value:** Partners open a URL and use agents in their browser.

### Setup

- [ ] **3.1 Scaffold web/** — Vite + React + TypeScript + Tailwind + shadcn/ui
  - `npm create vite@latest web -- --template react-ts`
  - Add shadcn/ui, assistant-ui, prompt-kit
  - Cloudflare Pages config (wrangler.toml)
  - Shared types from `src/types/` (symlink or workspace reference)

### Core UI

- [ ] **3.2 Auth screen** — Token entry
  - Simple input field, token saved to localStorage
  - Validates against server, shows error if invalid
  - Skip if Cloudflare Access is handling auth

- [ ] **3.3 Agent card grid** — Home screen
  - Fetch `GET /api/agents` (filtered by token)
  - Card per agent: icon, name, description, tags
  - Suggested starters shown on card hover/tap
  - Mobile: scrollable grid or swipeable carousel
  - Click card → start new conversation with that agent

- [ ] **3.4 Conversation sidebar** — Left panel
  - Fetch `GET /api/sessions` per agent
  - List: agent avatar, title, status dot, last message preview
  - New conversation button
  - Delete conversation (swipe on mobile)
  - WhatsApp-familiar pattern

- [ ] **3.5 Chat panel** — Main area
  - WebSocket connection via `useAgentChat` custom hook
  - Streaming markdown rendering (react-markdown + remark-gfm)
  - User messages (right-aligned, blue)
  - Assistant messages (left-aligned, with avatar)
  - Skeleton loading during inference
  - Streaming typewriter effect
  - Auto-scroll with scroll-lock on manual scroll-up

- [ ] **3.6 Tool call display** — Inline in chat
  - Collapsible tool call blocks (tool name, input summary)
  - Expandable to show full input/output
  - Status: executing (spinner), complete (check), error (x)
  - Tool approval flow if needed (approve/reject buttons)

- [ ] **3.7 @mention agent switching** — In chat input
  - Type `@` to see available agents
  - Select agent to switch mid-conversation (or start sub-conversation)
  - Autocomplete dropdown

### Polish

- [ ] **3.8 Dark mode** — Default, with system-aware toggle
- [ ] **3.9 Mobile responsive** — Full-width chat on mobile, slide-out sidebar
- [ ] **3.10 Voice input** — Mic button, Web Speech API or Whisper
- [ ] **3.11 i18n** — UI chrome in Portuguese (buttons, labels, errors, status)
- [ ] **3.12 Reconnection** — Auto-reconnect WebSocket, replay missed messages
- [ ] **3.13 Error states** — Rate limit, server down, session expired, auth failed

### Deploy

- [ ] **3.14 Cloudflare Pages** — `wrangler pages deploy web/dist`
- [ ] **3.15 Custom domain** — `agents.mastersof.ai` or similar
- [ ] **3.16 Cloudflare Tunnel** — Connect to backend server without opening ports

### Done when
Partner in Brazil opens URL on phone, sees agent cards, taps one, chats in Portuguese with streaming responses, can switch conversations, sees tool execution, voice input works.

---

## Phase 4: Security + Production

**Value:** Safe for untrusted remote users. Cost-controlled.

- [ ] **4.1 Mandatory remote sandbox** — Server forces sandbox for all remote sessions
- [ ] **4.2 Per-user workspace isolation** — `workspace/{user}/` per agent
- [ ] **4.3 Shell policy enforcement** — Shell requires both `tools.allow` + `sandbox.enforce`
- [ ] **4.4 Per-agent MCP servers** — `mcp` field in frontmatter, merged into SDK options
- [ ] **4.5 Rate limiting** — Per-user request limits, queue management
- [ ] **4.6 Cost caps** — Per-user daily/monthly budget, alerts
- [ ] **4.7 Structured logging** — JSON logs, request tracing
- [ ] **4.8 Health monitoring** — Uptime checks, error rate alerts
- [ ] **4.9 LGPD basics** — Data retention policy, deletion endpoint
- [ ] **4.10 Hot reload** — Watch agents dir, push roster updates to connected clients

### Done when
Remote users are sandboxed, costs are tracked and capped, server is observable, data handling is documented.

---

## Dependencies

```
Phase 1 (frontmatter) ──► Phase 2 (serve mode) ──► Phase 3 (web UI) ──► Phase 4 (security)
                                                         │
                                                         ├── 3.1-3.7 can start once 2.1-2.3 are done
                                                         └── 3.8-3.16 can parallel with 3.5-3.7
```

Phase 1 has no dependencies and delivers value immediately (tool filtering in CLI).
Phase 2 depends on Phase 1 (needs frontmatter for tool filtering and agent roster).
Phase 3 depends on Phase 2 (needs API endpoints to build against).
Phase 4 can overlap with late Phase 3.

---

## Open Decisions

1. **Fastify vs Express** for serve mode — Fastify recommended (faster, typed, built-in WS/CORS)
2. **assistant-ui vs roll-our-own** — assistant-ui needs a custom RuntimeProvider for our WS protocol; alternative is prompt-kit (purely presentational) + our own state management
3. **Cloudflare Access vs token-based auth** — Can use both: Access for the tunnel, tokens for API-level agent filtering
4. **Backend hosting** — Fly.io (simple, good free tier), Railway (git push deploy), Hetzner VPS (cheapest, most control)
5. **Hot reload priority** — File watcher for agents dir: nice-to-have or must-have?
