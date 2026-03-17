# Cloudflare for AI Agent Deployment — Deep Research

Research date: 2026-03-16

## Executive Summary

Cloudflare has built a serious agent hosting platform. The **Agents SDK** (built on Durable Objects) provides stateful, hibernatable, WebSocket-connected agents with built-in SQL storage, MCP support, and multi-provider LLM integration. **However, deploying the mastersof-ai harness as-is on Cloudflare is not feasible** — the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) depends heavily on Node.js APIs (child_process, fs) that don't work in Workers. A Cloudflare deployment would require either a ground-up rewrite using Cloudflare's own Agents SDK, or a hybrid architecture where Cloudflare handles routing/state while a traditional server runs the Claude Agent SDK.

---

## 1. Cloudflare Workers AI

### What It Is
Serverless GPU inference for open-source models, running on Cloudflare's global network. **Not a proxy to external APIs** — it runs models directly on Cloudflare's hardware.

### Supported Models (~50+ curated)
| Category | Notable Models |
|----------|---------------|
| Text Generation | GPT-OSS-120B, GPT-OSS-20B, Llama 4 Scout 17B, Llama 3.3 70B, Nemotron 3 120B, GLM 4.7 Flash (131K context), Qwen3 30B, Gemma 3 12B, Mistral Small 3.1 24B, QwQ 32B, DeepSeek R1 32B |
| Embeddings | Qwen3-embedding-0.6B, BGE-M3, BGE-large/small/base, Embedding Gemma 300M |
| Text-to-Speech | Deepgram Aura 2, MeloTTS |
| Speech-to-Text | Deepgram Nova 3, Whisper Large V3 Turbo, Deepgram Flux |
| Image Generation | Flux 2 Klein/Dev, Stable Diffusion XL, Leonardo Phoenix |
| Image Classification | ResNet-50, DETR |

### What It Can't Do
- **Cannot proxy to Anthropic/Claude APIs.** Workers AI runs open-source models only.
- To call Claude, you use **AI Gateway** (see section 3) or direct API calls from your Worker.

### Pricing
- **Free tier:** 10,000 Neurons/day (resets at 00:00 UTC)
- **Paid:** $0.011 per 1,000 Neurons
- Per-model token pricing examples:
  - Llama 3.1-70B: $0.293/M input tokens, $2.253/M output tokens
  - Llama 3.2-1B: $0.027/M input, $0.201/M output
  - DeepSeek R1-32B: $0.497/M input, $4.881/M output
  - BGE-small embeddings: $0.020/M input tokens

### Relevance to Us
Workers AI is useful for auxiliary tasks (embeddings, classification, summarization) but irrelevant for the core agent loop, which must run Claude via the Anthropic API.

---

## 2. Durable Objects

### What They Are
Stateful Workers with a globally-unique identity, built-in storage, and WebSocket support. Each Durable Object instance is a single JavaScript isolate that can maintain state in memory and persist to storage. They're the foundation of Cloudflare's Agents SDK.

### Key Capabilities

**Storage Options:**
- **SQLite-backed** (recommended, default): Transactional, strongly-consistent SQL storage per object
- **KV-backed** (legacy): Key-value pairs per object

**WebSocket Hibernation:**
- DOs can act as WebSocket servers connecting thousands of clients
- When idle, the DO hibernates — evicted from memory, but WebSocket connections stay alive on the Cloudflare network
- No duration billing during hibernation
- Auto-wakes on incoming message, re-runs constructor
- Per-connection state via `serializeAttachment()` (max 2,048 bytes per connection)

**Alarms:**
- Schedule future compute at customizable intervals
- Useful for scheduled agent tasks, polling, periodic processing

### Limits (Critical)

| Limit | SQLite-backed | KV-backed |
|-------|--------------|-----------|
| Storage per object | **10 GB** | Unlimited |
| CPU per request | 30s default, **5 min max** | 30s |
| Memory per isolate | **128 MB** | 128 MB |
| Max SQL row/BLOB | 2 MB | N/A |
| Max key size | N/A | 2 KB |
| Max value size | N/A | 128 KB |
| SQL columns per table | 100 | N/A |
| SQL statement length | 100 KB | N/A |
| Objects per account | Unlimited | Unlimited |
| Max classes | 500 (paid) / 100 (free) | Same |
| Requests per object | ~1,000/sec (soft) | Same |
| WebSocket message size | 32 MiB (received) | Same |

### Pricing

| Component | Included (Paid) | Overage |
|-----------|-----------------|---------|
| Requests | 1M/month | $0.15/million |
| Duration | 400,000 GB-s/month | $12.50/million GB-s |
| Storage (SQLite) | 5 GB/month | $0.20/GB-month |
| Storage (KV reads) | N/A | $0.20/million |
| Storage (KV writes) | N/A | $1.00/million |

**Free plan:** 100,000 requests/day, 13,000 GB-s/day, SQLite only.

### For Agent State & Conversation History
DOs are well-suited for this. Each agent session gets its own DO instance with:
- SQLite for conversation history (10 GB per object is generous)
- In-memory state for active session context
- WebSocket for real-time client communication
- Hibernation during idle periods (no cost)
- Alarms for scheduled agent tasks

---

## 3. AI Gateway

### What It Is
A proxy layer that sits between your application and AI providers. Routes requests, adds caching, rate limiting, logging, and fallback.

### Supported Providers (24)
Anthropic, OpenAI, Azure OpenAI, Google AI Studio, Google Vertex AI, Amazon Bedrock, Groq, Mistral AI, DeepSeek, Cohere, Replicate, HuggingFace, xAI, Perplexity, OpenRouter, ElevenLabs, Deepgram, Cerebras, Baseten, Cartesia, Fal AI, Ideogram, Parallel, Workers AI.

### Anthropic Integration
- **Base URL:** `https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway_id}/anthropic`
- **Endpoint:** `/v1/messages` (standard Anthropic Messages API)
- **Authentication:** Three options:
  1. Pass `x-api-key` header with Anthropic key
  2. Store keys in AI Gateway (BYOK) — keys never exposed to client
  3. Unified billing through Cloudflare
- **OpenAI-compatible mode:** `/compat/chat/completions` with `model: "anthropic/{model_name}"`
- **SDK integration:** Set `baseURL` on the Anthropic SDK to the gateway URL

### Key Features
- **Caching:** Serve identical responses from edge cache (saves API costs)
- **Rate Limiting:** Control request volume per gateway
- **Fallback:** Automatically fall back to alternative providers/models on failure
- **Retry:** Automatic retry with configurable logic
- **Logging:** Request/response logging with analytics
- **Analytics:** Token counts, costs, latency tracking

### Pricing
- **Core features free** on all plans (analytics, caching, rate limiting)
- **Persistent logs:** 100K (free plan) / 1M (paid plan) total across all gateways
- **Logpush:** Paid only, 10M requests/month included, $0.05/million overage

### Relevance to Us
AI Gateway is immediately useful — we could route all Claude API calls through it today to get caching, logging, and fallback without changing our runtime. Just swap the base URL.

---

## 4. Cloudflare Agents SDK

### What It Is
A TypeScript framework for building stateful AI agents, built on top of Durable Objects. Each agent instance gets its own SQL database, WebSocket connections, and scheduling. It's a distinct product from "Workers AI" — this is about hosting and orchestrating agents, not running models.

**NPM packages:**
- `agents` — core SDK (Agent class, routing, state, scheduling, MCP, email, workflows)
- `@cloudflare/ai-chat` — higher-level AIChatAgent with message persistence and resumable streaming
- `hono-agents` — Hono middleware integration
- `@cloudflare/codemode` — experimental LLM-generated executable code

### Agent Class API

```typescript
export class MyAgent extends Agent<Env, StateType> {
  initialState = { /* ... */ };

  // Lifecycle hooks
  onStart(props?)           // Instance starts or wakes from hibernation
  onRequest(request)        // HTTP request to instance
  onConnect(connection, ctx) // WebSocket connection established
  onMessage(connection, msg) // WebSocket message received
  onClose(connection, ...)  // WebSocket connection closed
  onError(connection, error)
  onEmail(email)            // Incoming email
  onStateChanged(state, src) // State changed (server or client)

  // State management
  setState(newState)        // Persists + broadcasts to all clients
  this.state               // Current state
  this.sql                 // Execute SQL on embedded SQLite

  // Communication
  broadcast(message)        // Send to all connected WebSocket clients
  send(connection, message) // Send to specific client

  // Scheduling
  schedule(delay, callback) // One-time scheduled task
  scheduleEvery(cron, cb)   // Recurring cron task
  getSchedules()            // List scheduled tasks
  cancelSchedule(id)        // Cancel a scheduled task
  keepAlive()               // Prevent hibernation

  // Task queue
  queue(task)               // Add task to queue
  dequeue() / dequeueAll()  // Process tasks

  // Integration
  addMcpServer(config)      // Connect to external MCP server
  removeMcpServer(name)
  runWorkflow(workflow)      // Launch a durable workflow
  waitForApproval(step)      // Human-in-the-loop pause

  // Callable decorator
  @callable()               // Exposes method as type-safe RPC
}
```

### AIChatAgent
Extended Agent class for conversational AI:
- Automatic message persistence in SQLite
- Resumable streams (if client disconnects, reconnects and picks up where it left off)
- Server-side and client-side tool execution
- Multi-provider support: Workers AI, OpenAI, Anthropic, Gemini

### MCP Support
- Agents can act as **MCP servers** (expose tools to other agents/LLMs)
- Agents can connect as **MCP clients** (consume external MCP tools)
- Remote MCP connections via Streamable HTTP with OAuth
- Local MCP via stdio transport

### Human-in-the-Loop
- `waitForApproval(step, { timeout })` pauses workflow execution
- Client gets notified, human approves/rejects
- State persists across the wait (even if it takes days)
- `needsApproval` flag on tool definitions for gating tool execution

### AI Model Integration
- **Workers AI:** Built-in binding, no API key needed
- **Anthropic:** Install `@ai-sdk/anthropic`, set `ANTHROPIC_API_KEY` env var
- **OpenAI:** Install `@ai-sdk/openai`, set `OPENAI_API_KEY`
- **Any OpenAI-compatible API:** Custom base URL
- Streaming supported via WebSocket or SSE
- Long-running responses supported ("minutes or longer")

### Deployment
```bash
# New project
npm create cloudflare@latest -- --template cloudflare/agents-starter

# Existing project — add deps + wrangler config with DO bindings
npm install agents @cloudflare/ai-chat

# Deploy
npm run deploy  # via wrangler
```

`wrangler.jsonc` needs Durable Object class bindings and `nodejs_compat` flag.

---

## 5. Deployment Patterns for Our Harness

### The Core Problem

The mastersof-ai harness uses `@anthropic-ai/claude-agent-sdk` which is fundamentally incompatible with Cloudflare Workers:

| Dependency | Workers Compatibility |
|-----------|----------------------|
| `@anthropic-ai/claude-agent-sdk` (sdk.mjs, 396KB) | **INCOMPATIBLE** — uses `child_process`, `fs`, `spawn`, `execSync`, `readFile`, `writeFile`, `mkdir`, etc. |
| `@anthropic-ai/claude-agent-sdk/browser` (browser-sdk.js, 504KB) | **Partial** — no child_process, minimal fs (2 refs). Uses WebSocket transport. Designed for browser, might work in Workers with polyfills. |
| `ink` + `react` (TUI) | **INCOMPATIBLE** — terminal rendering, stdout/stdin |
| `jsdom` | **Problematic** — heavy, may exceed bundle limits |
| `tsx` | **INCOMPATIBLE** — runtime TypeScript compilation, child_process |
| `sharp` (optional SDK dep) | **INCOMPATIBLE** — native binary |
| Total node_modules | **238 MB** — far exceeds 10 MB compressed bundle limit |
| Claude Agent SDK alone | **58 MB** |

The Claude Agent SDK's main entry (`sdk.mjs`) contains 6 references to child_process/spawn and 13 references to filesystem APIs. It's designed to run as a local CLI tool that executes commands, reads/writes files, and manages processes.

### Option A: Full Rewrite on Cloudflare Agents SDK (Recommended if Cloudflare is the target)

Replace the Claude Agent SDK with Cloudflare's Agents SDK + direct Anthropic API calls:

```
Cloudflare Agent (Durable Object)
├── AIChatAgent class (state, WebSockets, persistence)
├── Anthropic API calls via AI Gateway or direct
├── MCP tools (Cloudflare's MCP support)
├── Workflows for long-running operations
└── SQLite for conversation history + memory
```

**What you'd keep:**
- Agent identity/prompt files (IDENTITY.md)
- Tool logic (rewritten as Cloudflare Agent tools or MCP servers)
- Configuration concepts

**What you'd lose:**
- Claude Agent SDK features: built-in tool execution (Read, Edit, Bash, Grep, Glob, etc.), sub-agent orchestration, hooks, permission model, session management, thinking mode
- You'd be calling the raw Anthropic Messages API and implementing tool execution yourself
- The SDK's sophisticated tool loop (call model -> execute tool -> feed result back -> repeat) would need to be reimplemented

**What you'd gain:**
- Global edge deployment with hibernation
- Built-in WebSocket client connections
- Persistent SQL storage per agent
- Scheduled agent tasks
- Human-in-the-loop flows
- MCP server capability (agents expose tools to other agents)
- Pay-per-use with zero cost when idle

### Option B: Hybrid Architecture

```
Client (browser/mobile)
    ↓ WebSocket
Cloudflare Agent (Durable Object)
    ├── State management, session routing, auth
    ├── Message queue, rate limiting
    ├── Conversation history (SQLite)
    └── Proxies to ↓
Backend Server (traditional Node.js — Fly.io, Railway, EC2, etc.)
    ├── Claude Agent SDK (full capabilities)
    ├── MCP tool servers
    ├── File system access
    └── Shell execution
```

Cloudflare handles the stateful edge layer (auth, routing, WebSocket management, caching, conversation persistence) while a traditional server runs the actual Claude Agent SDK. This preserves all SDK capabilities while gaining Cloudflare's edge infrastructure for the client-facing layer.

### Option C: Browser SDK Experiment

The Claude Agent SDK exports a `@anthropic-ai/claude-agent-sdk/browser` entry that uses WebSocket transport instead of local process execution. This 504KB bundle has zero child_process references. However:
- It requires a WebSocket server endpoint to connect to (likely Anthropic's hosted Claude Code backend)
- It's designed for browser contexts, not server-side Workers
- It may not support the full tool execution model needed
- Documentation is sparse on this variant

This could theoretically work in a Worker, but you'd need to understand what WebSocket endpoint it connects to and whether that endpoint supports your use case.

---

## 6. Limitations and Gotchas

### Workers Runtime Constraints
| Constraint | Impact |
|-----------|--------|
| **128 MB memory** per isolate | Limits context window processing, large response buffering |
| **5 min max CPU time** (paid) | Sufficient for most agent turns, but multi-step tool loops must complete within this |
| **10 MB compressed bundle** | Claude Agent SDK alone (58MB uncompressed) won't fit. Even the browser variant (504KB) is feasible only with careful bundling |
| **No true file system** | `node:fs` is polyfilled but may noop or throw. Agent tools that read/write files need alternative storage (R2, KV, DO storage) |
| **No child_process** | Polyfilled as non-functional stub. Cannot spawn subprocesses, run shell commands, or execute system tools |
| **1 second startup time** | Worker must initialize within 1 second |

### Node.js Compatibility (with `nodejs_compat` flag)
| Status | APIs |
|--------|------|
| Fully supported | Buffer, Crypto, DNS, Events, HTTP/HTTPS, Net, Path, Process, Streams, Timers, URL, Zlib, AsyncLocalStorage |
| Partially supported | Console, Module, OS, TLS/SSL |
| Non-functional stubs | **child_process**, Cluster, HTTP/2, Readline, REPL, UDP, V8, VM |
| Not supported | SQLite (Node's), Test runner |

### Durable Objects Constraints
- **10 GB storage per object** — generous for conversation history, but not unlimited
- **1,000 req/sec per object** (soft limit) — fine for individual agents, could be an issue for shared state objects
- **Deploys disconnect all WebSockets** — clients must handle reconnection on code updates
- **Hibernation caveats:** Alarms, incoming requests, and `setTimeout`/`setInterval` prevent hibernation. Agent must be truly idle.
- **2 MB max SQL row/BLOB** — large tool outputs may need chunking

### Streaming
- **WebSocket streaming works well** — DOs natively support WebSocket with hibernation
- **SSE works** — Workers support `ReadableStream` responses for SSE
- **Subrequest streaming** — Can proxy streaming responses (e.g., from Anthropic API) through a Worker without buffering the full response
- **No duration limit on HTTP responses** — response streams can run as long as the client stays connected

### Bundle Size Strategies
- **Free plan:** 3 MB compressed, 64 MB uncompressed
- **Paid plan:** 10 MB compressed, 64 MB uncompressed
- Use Service Bindings to split across multiple Workers
- Store large assets in R2/KV instead of bundling
- `find_additional_modules` in wrangler for lazy-loaded chunks

---

## 7. Cost Model

### Scenario: 100 Active Agents, Varying Usage

**Assumptions:**
- 100 agent sessions per day
- Average 20 messages per session
- 5 tool calls per message (each generating a subrequest)
- Sessions last ~30 minutes active, then hibernate
- Each session uses ~256 MB-s of compute duration

**Workers (entry point routing):**
- Requests: 100 sessions x 20 messages = 2,000/day = ~60,000/month
- Well within 10M included requests
- **Cost: $0** (included in $5/month base)

**Durable Objects:**
- Requests: 60,000 messages + 300,000 tool-related internal ops = ~360,000/month
- Duration: 100 sessions x 30 min x 0.128 GB = ~384,000 GB-s/month (close to 400K included)
- Storage: Conversation history ~100 MB total
- **Cost: ~$0** (within included allocations)

**AI Gateway (proxying to Anthropic):**
- Requests: ~360,000/month
- Logging: Within 1M included logs
- **Cost: $0**

**Anthropic API (the real cost):**
- This is where the money goes. Cloudflare infrastructure costs are negligible compared to Claude API costs.
- Example: 100 sessions/day x 20 messages x ~4K tokens avg = ~8M tokens/day input + ~2M output
- At Claude Opus pricing: this is the dominant cost by far

**Workers AI (if using for auxiliary tasks):**
- 10,000 free neurons/day
- Light embedding/classification work: likely within free tier
- **Cost: $0 to ~$5/month**

### Total Cloudflare Infrastructure Cost Estimate
| Component | Monthly Cost |
|-----------|-------------|
| Workers Paid plan | $5 |
| Durable Objects | $0-5 (within included) |
| AI Gateway | $0 |
| Workers AI (auxiliary) | $0-5 |
| **Total Cloudflare** | **$5-15/month** |
| Anthropic API (the real cost) | **$hundreds to $thousands** |

The Cloudflare infrastructure cost is negligible. The billing model (CPU time, not wall time) is ideal for AI agents that spend most of their time waiting on API responses.

---

## 8. Recommendation

### Immediate Win: AI Gateway
Route all Anthropic API calls through AI Gateway today. Zero code changes to the runtime — just change the base URL. Get caching, logging, analytics, and fallback for free.

### Near-Term: Hybrid Architecture
Deploy a Cloudflare Agent (Durable Object) as the client-facing layer:
- WebSocket connections from browser/mobile clients
- Session state and conversation history in DO SQLite
- Auth, rate limiting, routing at the edge
- Proxy to a backend server running the full Claude Agent SDK

This gives you global edge presence, hibernation-based cost efficiency, and persistent state without rewriting the core agent runtime.

### Long-Term: Evaluate Full Cloudflare Agents SDK
If you want to move fully onto Cloudflare, you'd need to:
1. Replace the Claude Agent SDK with direct Anthropic API calls + your own tool execution loop
2. Rewrite MCP tool servers as Cloudflare Agent tools or remote MCP servers
3. Replace file system operations with DO storage / R2 / KV
4. Replace shell execution with Workflows or external service calls
5. Implement the agent orchestration loop (model call -> tool execution -> result feedback -> repeat) from scratch

This is substantial work, but the Cloudflare Agents SDK provides good primitives for it. The question is whether the Claude Agent SDK's built-in capabilities (tool execution, sub-agents, hooks, permission model) are worth reimplementing.
