# Claude Agent SDK Harness Landscape Research

**Date:** 2026-03-16
**Purpose:** Understand what other harness projects are doing, identify gaps in our harness, and surface patterns worth adopting — especially for remote access and deployment.

---

## 1. Primary Projects Researched

### 1a. coleam00/your-claude-engineer

**What:** Autonomous software engineering system that accepts feature requests and delivers implemented code. Python. Coordinator-specialist multi-agent architecture.

**Architecture:** Five specialized agents — Orchestrator, Linear Agent, Coding Agent, GitHub Agent, Slack Agent. Orchestrator reads project state, queries Linear, delegates work via the SDK Task tool. Each agent configurable with different Claude models (Haiku for Linear, Sonnet for coding, etc.) for cost optimization.

**Tools/Capabilities:**
- Arcade MCP gateway providing unified OAuth across Linear (39 tools), GitHub (46 tools), Slack (8 tools)
- Playwright for browser-based UI testing and verification
- Security: bash command allowlist, filesystem restrictions, dangerous command validation

**Deployment:** Local only. Isolated project directories with separate git repos. No remote access.

**User Exposure:** CLI only (`autonomous_agent_demo.py`). Observability via Linear workspace updates and optional Slack notifications.

**Multi-Agent Pattern:** Orchestrator-specialist with per-agent model selection. State machine tracking via `.linear_project.json` marker files for session resumption. Context window optimization by delegating to sub-agents.

**What we can learn:**
- Per-agent model selection for cost optimization (we support model overrides on sub-agents but don't explicitly use it for cost)
- Unified OAuth gateway (Arcade) for external services — single auth flow across multiple integrations
- State marker files for session resumption (our sessions.ts does similar but less structured)
- Security allowlists for bash commands (we have sandbox.ts but no command allowlisting outside sandbox mode)

---

### 1b. BulloRosso/etienne

**What:** Full agent harness positioned as a "proactive AI coworker" with event-driven architecture and artifact-based collaboration. Node.js + Python.

**Architecture:** Three subsystems connected via ZeroMQ pub/sub event bus:
1. **CMS (Condition Monitoring)** — Ingests events from email (IMAP), MQTT devices, webhooks, filesystem, schedulers
2. **DSS (Decision Support)** — Knowledge graph (Quadstore RDF), vector store (ChromaDB), context injection
3. **SWE (Stateful Workflow Engine)** — XState v5 for deterministic multi-step orchestration

**Tools/Capabilities:**
- Skills system: markdown business expertise + code snippets, versioned, admin-curated, org-distributable
- Knowledge graph (RDF) + vector store (ChromaDB) — dual-layer context
- Event-triggered micro-workflows via XState state machines
- Phoenix tracing for observability
- Budget/cost tracking per-project and per-session
- Self-healing: agent generates patches, admin reviews (4-eyes principle)
- File type previewers (CAD, financial models, etc.)

**Deployment:** Docker containerized. Local-first but with services architecture. OAuth server for auth. Process manager API for service control.

**User Exposure:** React web UI with artifact editing pane, role-based access control (admin/analyst/user), internationalization (EN/DE/ZH). Messenger integrations: email (IMAP), MS Teams, Telegram as input channels.

**Multi-Agent Pattern:** Single primary agent (Opus) with skill-based specialization — domains handled by skills rather than separate agents. Event-driven coordination rather than explicit orchestration.

**What we can learn:**
- **Event bus architecture** (ZeroMQ) for loose coupling between subsystems — we're monolithic
- **Skills system** — portable, versioned, business-aware capabilities that can be shared across agents
- **Dual-layer context** (knowledge graph + vector store) — we only have flat markdown memory
- **Web UI with artifact editing** — our TUI is great for developers but limits audience
- **Event-triggered workflows** via state machines — deterministic sub-processes beyond LLM reasoning
- **Budget/cost tracking** — we don't track costs at all
- **Observability** via Phoenix tracing — we have logging but no trace visualization
- **Multi-channel input** (email, Teams, Telegram) — we only have TUI

---

### 1c. haasonsaas/agent-harness

**What:** Provider-agnostic Python framework for hot-swapping between OpenAI Agents SDK and Claude Agent SDK with shared tool registry.

**Architecture:** Layered: `AgentHarness` → `BaseHarness` → `OpenAIHarness` | `ClaudeHarness`. Tools registered once via decorator, auto-adapted per provider. Lazy SDK loading.

**Tools/Capabilities:**
- Unified tool registry with decorator pattern (`@register_tool`)
- Automatic JSON Schema generation from type hints
- Side-by-side provider comparison via `compare_providers()`
- Streaming support with consistent response deltas
- Error handling with retries and exponential backoff

**Deployment:** Library pattern — applications instantiate `AgentHarness` directly. No separate agent service. In-process.

**User Exposure:** Python API only (`run()`, `stream()`, `switch_provider()`).

**Multi-Agent Pattern:** Not a focus — single agent with provider flexibility.

**What we can learn:**
- **Provider abstraction** — interesting but not our priority since we're committed to Claude
- **Decorator-based tool registration** — cleaner than our MCP server approach for simple tools
- **Retry/backoff patterns** — we should have this for API resilience
- **Comparison mode** — useful for evaluating model performance

---

### 1d. GantisStorm/autonomous-coding-harness

**What:** Human-in-the-loop AI coding agent with GitLab integration and Textual TUI. Python. Milestone-based development.

**Architecture:** Three-agent sequential pattern:
1. **Initializer** — Creates feature lists, sets up environments, initializes git
2. **Coding Agent** (looping) — Implements one issue per session, writes tests, verifies
3. **MR Creation Agent** — Generates merge requests

Each session gets "fresh context" via external memory (files, git, GitLab) rather than in-context retention.

**Tools/Capabilities:**
- 8 HITL (Human-in-the-Loop) checkpoints — approval gates for verification, breakdown, review, merge decisions
- GitLab integration (milestones, issues, MRs) with file-only JSON fallback mode
- Multi-session handoffs with structured state (commit SHA, progress checklist, next steps)
- Quality gates: mandatory linting, type-checking, test passing before issue closure
- Test automation with repair loops (max 3 attempts)
- Regression testing (before/after on each issue)
- Context7 (library docs) and SearxNG (web search) enrichment
- File tracking — only agent-modified files are pushed

**Deployment:** Docker (Dockerfile + docker-entrypoint.sh). Primarily local execution.

**User Exposure:** Textual TUI with interactive approval prompts and real-time log-tailing.

**Multi-Agent Pattern:** Sequential task loop — one issue per session with explicit handoffs. No parallel execution. State preserved in git history + issue comments.

**What we can learn:**
- **HITL checkpoints** — structured approval gates at critical decision points (we have ask-user but no formal gate pattern)
- **One issue per session** — prevents context exhaustion; explicit handoff artifacts between sessions
- **Quality gates** — mandatory lint/typecheck/test pass before proceeding (we have no automated quality gates)
- **Structured handoffs** — commit SHA, checklist, next steps as first-class artifacts
- **File tracking** — knowing which files the agent modified vs. which the user owns
- **Regression testing** — automated before/after verification
- **Compounding error awareness** — explicitly designs around 0.95^20 = 36% reliability math

---

## 2. Anthropic's Official Guidance

### 2a. "Effective Harnesses for Long-Running Agents" (Blog Post)

Core pattern: Two-agent architecture for long-running work.

**Initializer Agent (first session):**
- Creates `init.sh` for development server startup
- Creates `claude-progress.txt` for tracking decisions and actions
- Initializes git repo with baseline commits
- Creates comprehensive feature requirements as JSON (not markdown — "model is less likely to inappropriately change JSON files")

**Coding Agent (subsequent sessions):**
- Session startup protocol: `pwd` → read git logs → read progress files → review feature list → run `init.sh` → baseline tests → pick highest-priority incomplete feature
- Single-feature-at-a-time implementation
- Git commits with descriptive messages
- Browser automation (Puppeteer) for verification

**Key design decisions:**
- JSON over markdown for structured state (less prone to model corruption)
- Feature list uses `"passes": false` with strong constraints against editing
- Every session starts with environmental awareness + historical context review
- Browser-based testing essential ("agents marked features complete without proper testing" when using only unit tests)
- Single-feature focus prevents context exhaustion from "one-shotting"

**What we should adopt:**
- **Structured session startup protocol** — formalized context loading sequence before work begins
- **Progress tracking files** — explicit state that bridges context windows
- **JSON for structured state** over markdown (less corruption risk)
- **Browser-based verification** — agents need visual confirmation for UI work

### 2b. "Building Effective Agents" (Blog Post)

Core patterns:
- **Prompt chaining** — sequential steps with programmatic gates
- **Routing** — classify and direct to specialists
- **Parallelization** — sectioning (independent tasks) or voting (same task, multiple perspectives)
- **Orchestrator-workers** — central LLM dynamically decomposes and delegates
- **Evaluator-optimizer** — generate/evaluate loop with clear criteria

Key principles:
- "Start with simple prompts, optimize with comprehensive evaluation, add multi-step agentic systems only when simpler solutions fall short"
- Tool design is as important as prompt engineering — format for model usability, not human convenience
- Poka-yoke tool design: "Requiring absolute filepaths prevents navigation-related mistakes"
- Always sandbox and test before production

---

## 3. Notable Projects from the claude-agent-sdk Topic (81 repos total)

### 3a. dzhng/claude-agent-server (542 stars)

**What:** WebSocket server wrapper around Claude Agent SDK. The closest thing to "remote Claude agents" in the ecosystem.

**Architecture:**
- WebSocket server on port 3000 for bidirectional communication
- REST API (`POST /config`, `GET /config`) for runtime configuration
- Single active connection constraint per server instance
- Built for E2B sandbox deployment

**Key pattern:** Build a Docker/E2B template, deploy sandboxed server, connect via WebSocket from any client. Client library published as `@dzhng/claude-agent`.

**Message types:** `user_message` and `interrupt`

**What we can learn:**
- **WebSocket server pattern** is the standard approach for exposing Claude agents remotely
- **Configuration via REST endpoint** before WebSocket connection — clean separation
- **E2B integration** for sandboxed, disposable agent environments
- **Single-connection constraint** simplifies session management

### 3b. is0383kk/claude-multi-agent-api-server (13 stars)

**What:** FastAPI service for concurrent Claude Agent session management.

**Architecture:**
- 7 REST endpoints for agent lifecycle (execute, status, cancel, list, delete, cleanup)
- Independent session lifecycles with 5 states (pending, running, completed, error, cancelled)
- Per-session cost tracking in USD
- In-memory session storage (no persistent backend)

**What we can learn:**
- **REST API for agent lifecycle management** — clean pattern for exposing agents as a service
- **Session state machine** (pending → running → completed/error/cancelled)
- **Cost tracking per session** — we should track this
- **Cleanup endpoint** for session garbage collection

### 3c. xvirobotics/metabot (281 stars)

**What:** Infrastructure for autonomous agent organizations with Feishu/Telegram integration. Runs XVI Robotics' actual operations.

**Architecture:**
- **MetaSkill** — agent factory that generates complete teams from a prompt
- **MetaMemory** — shared SQLite knowledge store with full-text search, Web UI (port 8100), auto-sync to Feishu Wiki
- **Agent Bus** — REST API (port 9100) for agent-to-agent communication, supports cross-instance federation
- **IM Bridge** — streaming cards in Feishu/Telegram showing real-time tool calls
- **Task Scheduler** — cron + one-time delays with timezone awareness
- PM2 process management, bypass-permissions mode

**What we can learn:**
- **Shared memory across agents** (MetaMemory) with search — our memory is per-agent only
- **Agent Bus for inter-agent communication** with federation across machines
- **IM bridge** as a real-time observability layer (Feishu/Telegram streaming cards)
- **Agent factory** (MetaSkill) — generate complete agent teams from a description
- **Scheduling** — cron-based recurring tasks
- **Multi-machine federation** via configurable peers
- **"Jarvis Mode"** — voice control via iOS Shortcuts + Whisper STT

### 3d. suitedaces/dorabot (194 stars)

**What:** macOS desktop app for 24/7 AI agents with IDE workspace, browser automation, and messaging integrations.

**Architecture:**
- Electron app with Monaco editor, real PTY terminal, file explorer, git panel
- Persistent memory: `SOUL.md` (personality), `USER.md` (user context), `MEMORY.md` (cross-session knowledge)
- Browser automation using real Chrome profile (40+ actions)
- Cron + iCal RRULE scheduling with Apple Calendar sync

**User Exposure:** macOS app + WhatsApp + Telegram bots with unified memory context across all channels.

**What we can learn:**
- **Multi-channel unified memory** — same agent accessible via app + WhatsApp + Telegram with shared context
- **Scheduling with calendar sync** — agents as persistent background workers
- **Browser automation with user's Chrome profile** — already-authenticated sessions
- **SOUL.md pattern** — separating agent personality from instructions

### 3e. ruvnet/agentic-flow (540 stars)

**What:** Agent orchestration platform with 66 specialized agents and 213 MCP tools. Claims to be a self-optimizing system.

**Architecture:** Heavy on ML infrastructure (LoRA fine-tuning, ONNX models, Flash Attention, GNN). Swarm coordination with hierarchical, mesh, and MoE patterns. Byzantine/Raft/Gossip/CRDT consensus protocols.

**Relevance to us:** Limited. This is a very different beast — more ML research platform than practical harness. The LLM router for cost optimization (intelligent Sonnet/Haiku selection) is interesting conceptually but the implementation seems heavy.

### 3f. kivo360/OmoiOS (37 stars)

**What:** Spec-driven multi-agent orchestration that turns specs into PRs using parallel agent swarms in isolated sandboxes.

**Architecture:**
- Next.js 15 frontend with kanban, agent monitoring, React Flow dependency graphs
- FastAPI backend with 40+ routes, 100+ services, 75+ SQLAlchemy models
- PostgreSQL 16 + pgvector + Redis + Daytona sandboxes
- Phase-based execution: Exploration → Requirements → Design → Tasks (DAG) → Execution → Convergence

**Key patterns:**
- **IntelligentGuardian** — analyzes agent trajectories every 60 seconds, detects drift, injects steering
- **ConductorService** — system-wide coherence monitoring, duplicate work detection
- **DiscoveryService** — spawns new tasks when agents encounter bugs/opportunities
- **ConvergenceMergeService** — merges branches with Claude for conflict resolution

**What we can learn:**
- **DAG-based task execution** with dependency tracking and critical path analysis
- **Active supervision** — periodic trajectory analysis, not fire-and-forget
- **Adaptive workflows** — task graph grows during execution based on discoveries
- **Phase gates** — validation at strategic checkpoints

### 3g. chadingTV/claudecode-discord (19 stars)

**What:** Discord bot that turns Claude into a remote-controlled agent accessible via smartphone.

**Architecture:**
- Outbound-only WebSocket to Discord (zero inbound attack surface)
- Each Discord channel maps to a project directory with isolated workspace
- SQLite for session state, heartbeat progress displays every 15 seconds
- Platform-specific background services (macOS/Linux/Windows)

**Multi-machine pattern:**
```
Discord Server
├── #work-mac-frontend  ← Bot on work Mac
├── #home-pc-backend    ← Bot on home PC
├── #cloud-server-infra ← Bot on cloud server
```

**What we can learn:**
- **Discord as a remote access layer** — zero-infrastructure approach to multi-machine agent management
- **Channel-per-project mapping** — workspace isolation through chat channels
- **Usage dashboard** — built-in consumption tracking
- **Tool approval via Discord buttons** — HITL gates without custom UI

---

## 4. LangChain's DeepAgents

**What:** Opinionated, production-ready agent framework on LangGraph. "Batteries-included agent harness."

**Architecture:** Returns compiled LangGraph graph with streaming, Studio, checkpointers, persistence out of the box.

**Tools:** Planning (write_todos), filesystem (read/write/edit/ls/glob/grep), shell (sandboxed), sub-agents (task tool with isolated context), automatic summarization for context management.

**User Exposure:** Python package + CLI tool + `create_deep_agent()` factory API. Provider-agnostic.

**What we can learn:**
- **Automatic context summarization** for extended conversations — we don't manage context window pressure
- **Large outputs saved to files** automatically — prevents context pollution
- **Factory pattern** (`create_deep_agent()`) for zero-setup instantiation
- **LangGraph's checkpointing** for session persistence is more robust than JSON files

---

## 5. Gap Analysis: What We're Missing

### Critical Gaps (High Impact)

| Gap | Who Does It | Difficulty | Notes |
|-----|------------|------------|-------|
| **Remote access** — no way to expose agents to non-local users | claude-agent-server (WebSocket), agent-kit (Web UI), claudecode-discord (Discord), metabot (Feishu/Telegram) | Medium | WebSocket server or IM bridge are the two proven patterns |
| **Web UI** | agent-kit, etienne, OmoiOS | High | Our TUI limits audience to terminal users. Even a read-only web viewer of agent activity would help. |
| **Cost tracking** | metabot, etienne, multi-agent-api-server | Low | We have zero visibility into API costs per session/agent |
| **Session startup protocol** | Anthropic blog, GantisStorm | Low | Formalized context loading sequence — read history, read state, verify environment, then proceed |
| **Shared memory across agents** | metabot (MetaMemory) | Medium | Our memory is per-agent. No way for agents to share knowledge. |
| **Scheduling / background tasks** | metabot, dorabot | Medium | Our agents only run interactively. No cron, no background execution. |

### Important Gaps (Medium Impact)

| Gap | Who Does It | Difficulty | Notes |
|-----|------------|------------|-------|
| **HITL gates** — structured approval checkpoints beyond ask-user | GantisStorm (8 checkpoints) | Low | Formalize decision gates at critical moments |
| **Quality gates** — automated lint/test/typecheck before proceeding | GantisStorm | Low | Agents should verify work before declaring done |
| **Retry/backoff** for API calls | agent-harness | Low | We don't handle transient API failures gracefully |
| **Observability/tracing** | etienne (Phoenix), metabot (streaming cards) | Medium | We log to stderr; no trace visualization or structured observability |
| **Docker deployment** | GantisStorm, agent-kit, etienne | Low | We have no Dockerfile or container story |
| **Per-agent model selection** for cost optimization | your-claude-engineer | Low | We support it in sub-agents but don't leverage it strategically |
| **Multi-channel input** (email, Slack, Teams, Discord) | etienne, metabot, dorabot, claudecode-discord | Medium-High | Only TUI input currently |

### Worth Watching (Lower Priority)

| Gap | Who Does It | Notes |
|-----|------------|-------|
| Skills system (versioned, shareable capabilities) | etienne | Interesting for org-scale but we're not there yet |
| Knowledge graph + vector store dual context | etienne | Over-engineered for our use case currently |
| Agent factory (auto-generate teams) | metabot (MetaSkill) | Cool but premature for us |
| DAG-based parallel task execution | OmoiOS | Complex; our sequential sub-agents work for now |
| Provider abstraction | agent-harness | Not useful — we're committed to Claude |
| Event bus architecture | etienne (ZeroMQ) | Only matters if we go multi-service |
| Active supervision (trajectory analysis) | OmoiOS | Complex; HITL gates are simpler |

---

## 6. Deployment Patterns in the Wild

### Pattern A: WebSocket Server (claude-agent-server)
```
Client → WebSocket → Agent Server (Docker/E2B) → Claude API
         REST /config endpoint for setup
```
- Simplest path to remote access
- Single connection per server instance
- E2B for disposable sandboxed environments

### Pattern B: REST API Server (multi-agent-api-server, agent-kit)
```
Client → HTTP REST → FastAPI → Claude Agent SDK
         Session lifecycle endpoints
```
- Standard web API pattern
- Session management with state machine
- Easy to integrate from any client

### Pattern C: IM Bridge (metabot, claudecode-discord, dorabot)
```
User on Phone → Discord/Telegram/Feishu → Bot → Claude Agent SDK
                                          ↓
                                     Streaming cards for observability
```
- Zero-infrastructure remote access (piggyback on IM platform)
- Mobile-friendly by default
- Tool approval via platform-native UI (buttons, menus)
- Multi-machine hub via channel-per-project

### Pattern D: Web UI + WebSocket (agent-kit, etienne)
```
Browser → Next.js → WebSocket → FastAPI → Claude Agent SDK
          ↓
     React UI with artifact editing
```
- Full rich experience
- Highest implementation cost
- Best for non-technical users

### What Anthropic Says (inferred from SDK docs)
The SDK itself is "fundamentally a local execution framework" — no built-in remote/server mode. The official guidance is:
- Container-based deployment where the entire app runs together
- NOT recommended for serverless (Lambda, Cloud Functions) due to subprocess overhead
- Embedding in web frameworks (FastAPI example) is supported but you build the server yourself
- For remote access: wrap the SDK in your own HTTP/WebSocket service

---

## 7. Recommended Priorities

### Quick Wins (days, not weeks)

1. **Cost tracking** — Intercept API responses in the SDK stream to accumulate token usage and cost per session. Surface in TUI status bar and persist to session data.

2. **Session startup protocol** — Before the agent begins work, inject a structured prompt: "Read your memory, review recent session history, verify your environment, then proceed." This is what Anthropic recommends and GantisStorm implements.

3. **Docker deployment** — Basic Dockerfile for running the harness in a container. Prerequisite for everything remote.

4. **Retry/backoff** — Wrap SDK calls with exponential backoff for transient failures.

### Medium-Term (weeks)

5. **WebSocket server mode** — Add a `--server` flag that starts a WebSocket server instead of TUI. Clients connect, send messages, receive streaming responses. This is the minimal path to remote access. Pattern A above.

6. **Shared memory** — A shared knowledge store that all agents can read/write, separate from per-agent memory. SQLite with full-text search (like MetaBot's MetaMemory).

7. **Structured handoffs** — For multi-session work, persist handoff artifacts (commit SHA, progress checklist, next steps) between sessions. JSON format per Anthropic's recommendation.

8. **IM bridge** — Discord integration as a remote access layer. Outbound-only WebSocket, channel-per-project, button-based tool approval. The claudecode-discord project is a good reference.

### Longer-Term (months)

9. **Web UI** — At minimum, a read-only web viewer of agent activity. At most, a full interactive UI with artifact editing.

10. **Scheduling** — Background agent execution on cron schedules. Requires server mode first.

11. **Observability** — Structured tracing with visualization. OpenTelemetry or Phoenix integration.

---

## 8. Key Takeaways

1. **The ecosystem is converging on wrapping the SDK in a server.** The SDK provides no built-in remote access. Every project that exposes agents remotely builds their own WebSocket or HTTP wrapper. This is our biggest gap.

2. **IM bridges are the cheapest path to remote access.** Discord, Telegram, and Feishu bots give you mobile access, tool approval UIs, and multi-machine management for free. Multiple projects validate this pattern.

3. **Session continuity is a solved problem.** The pattern is: structured state files (JSON, not markdown) + git history + explicit startup protocol that reads state before proceeding. We should adopt this.

4. **Cost tracking is table stakes.** Every production-oriented harness tracks costs. We don't.

5. **Our TUI is a strength for developers but a ceiling for adoption.** Every project targeting broader audiences has a web UI or IM integration.

6. **Multi-agent coordination is mostly sequential.** Despite the hype, most production harnesses use sequential task delegation, not parallel swarms. Our sub-agent approach is solid. The one upgrade worth considering is shared memory across agents.

7. **Quality gates matter.** GantisStorm's insight about compounding errors (0.95^20 = 36% reliability) is the strongest argument for mandatory verification steps. Agents should prove their work before declaring done.
