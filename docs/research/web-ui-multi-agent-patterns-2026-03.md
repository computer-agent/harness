# Web UI & Multi-Agent Interaction Patterns Research

**Date:** 2026-03-16
**Purpose:** Inspiration and patterns for building a web frontend for the mastersof-ai harness
**Target users:** Non-technical to technical, including Portuguese-speaking users in Brazil, mobile-first

---

## 1. Cursor's Multi-Agent Approach

### Composer Multi-Agent (October 2025+)
- Up to **8 agents working in parallel** in isolated git worktrees
- Each agent gets its own working directory on a separate branch — no file conflicts
- Worktree creation takes ~2 seconds, making parallel execution practical
- **Judge agent** evaluates all outputs and recommends the best solution

### Background Agents
- Execute in **isolated Ubuntu VMs** with internet connectivity
- Work on separate branches autonomously
- **Auto-generate pull requests** for human review
- 99.9% reliability with instant startup (cloud-based)
- Key UX: developers don't have to watch — they get notified when done

### UI Patterns
- **Agent-first UI** (Cursor 2.0): chat panel is primary, code is secondary
- **Planning phase**: agents present implementation plans before execution for developer approval
- **25 tool-call limit per turn**: creates natural review checkpoints ("Continue" button)
- **Plan Mode** (`Shift+Tab`): agents draft Markdown plans in `.cursor/plans/` for review before execution
- Cursor confirmed they will release a **higher-level UI** beyond the IDE when agent capabilities are strong enough
- Current limitation: no quick preview of results across parallel agents; requires manual context switching

### Key Insight
> "Attention is the most precious and scarce resource" — the real bottleneck isn't agent speed, it's **human review bandwidth**. Most users run 2-3 agents concurrently despite 8-agent capacity.

---

## 2. Google Antigravity & Jules

### Antigravity IDE
- Fork of VS Code, **agent-first** — AI agents at the center of development
- **Manager View** interface coordinates specialized "Role-Based Experts" (refactoring, testing, debugging, infrastructure)
- **Planner agent** breaks large tasks into smaller tasks assigned to specialist agents
- Developers act as "Mission Controllers"
- **Browser Sub-Agent** powered by Gemini vision: launches servers, navigates pages, captures screenshots for visual verification
- Persistent workspace memory in `.gemini/antigravity/brain/`
- **Verifiable Artifacts**: task lists, implementation plans, screenshots, browser recordings — all reviewed before approval
- 1M token context window enables analysis of interdependent modules in single session

### Jules
- **Always-on autonomous coding agent** — web-based, not IDE-embedded
- Accessible via: web UI, terminal (Jules Tools), Gemini CLI extension, Jules API
- Powered by Gemini 3 Pro
- **Proactive model**: scans repos for `#TODO` comments, proposes follow-up tasks
- **Scheduled tasks**: routine maintenance, dependency checks on defined cadences
- **Event-driven**: responds to deployment failures (e.g., Render integration), proposes fixes via PRs
- **Critic agent** re-engages after replanning to keep work on track
- Diff viewer for confirming changes before applying
- Human approval loop on all suggestions

### Key Insight
Developer community concerned about Google's fragmentation: "too many products — Gemini CLI, Antigravity, Jules, Google Code Assist" — consolidation needed. Lesson: **unified experience > separate tools**.

---

## 3. ChatGPT / OpenAI UI Patterns

### Core Chat UI
- **Collapsible sidebar** listing conversation threads with infinite-scroll history
- Recent chats pinned at top, rename capability
- **Model selector dropdown**: "Auto," "Fast," "Thinking" modes + specific models (GPT-5.2, o3)
- **Custom instructions** apply globally across all conversations
- Single-model-per-conversation (no mid-conversation switching)
- Clean, minimalist, distraction-free design centered on dialogue

### Atlas Browser (October 2025)
- **Split-view sidebar**: ChatGPT panel alongside any web page
- **Agent Mode**: opens tabs, navigates sites, compiles data, executes multi-step tasks
- User remains in control — consent required for actions
- **Adaptive UI**: hides complexity until needed
  - `@tab` hint only appears when 3+ tabs are open
  - Agent Mode only shows when query implies multi-step work
- **Browser memories**: contextual recall of previously visited pages
- Context-aware page summarization and Q&A

### Key Design Principle
> "Adaptive UI" — hide complexity until users need it. Progressive disclosure based on actual usage signals.

---

## 4. Claude.ai UI Patterns

### Projects
- **Three-part structure**: Knowledge Base (up to 500 pages) + Custom Instructions + Active Conversations
- Projects isolate contexts — prevents information bleed between work streams
- Multiple conversations within a project retain project context automatically
- Team sharing: members can upvote/comment on shared chats
- Reduces cognitive load through separation

### Artifacts
- **Side panel** for interactive outputs: working documents, functional apps, real designs
- Replaced "massive walls of code in chat" with previewable, interactive content
- Users can test code, preview designs, validate outputs immediately
- Artifacts Catalog: browse thousands of community-built tools/apps
- Download as zip capability

### Conversation Design
- **Two-column layout**: left sidebar for conversations/projects, main area for chat
- Utilitarian, text-focused — "deliberately downplays itself to let content shine"
- No model selector visible in UI (plan determines access)
- Voice mode with personal data integration (Calendar, Gmail, Drive)
- Mobile apps with offline access to recent chats

### Key Insight
Claude's **Projects = context containers**. The insight: group related conversations under shared knowledge + instructions. This is the closest existing pattern to what we need for agent workspaces.

---

## 5. Multi-Agent Web UIs in the Wild

### LobeHub / LobeChat (Open Source, Next.js)
**GitHub:** github.com/lobehub/lobe-chat (major open-source option)

**Agents as Units of Work** — paradigm shift from conversations to persistent agent entities:
- **Agent Marketplace**: 1,500+ community-submitted agents with tags, descriptions, creator attribution
- **Agent Builder**: describe needs once, auto-configuration deployed
- **Agent Groups**: multiple agents refining content in shared context
- **Branching Conversations**: tree-like discussion structures (explore multiple paths)
- **10,000+ Skills**: MCP-compatible plugin system
- **White-Box Memory**: structured, user-editable — transparency + control

**Tech Stack:** Next.js, React, TypeScript, Zustand, Drizzle ORM, Vercel/Docker deployment

**Key Pattern:** Agent marketplace with tag-based discovery, not rigid categories. Agents submitted via PR with standardized JSON templates.

### LibreChat (Open Source)
**GitHub:** github.com/danny-avila/LibreChat (34.7k stars, 26M Docker pulls)

- **Unified multi-provider interface**: Anthropic, OpenAI, Azure, AWS, etc.
- **AI Agents** with file handling, code interpretation, API actions
- **MCP support** for tool/service connections
- **Artifacts**: React, HTML, Mermaid diagrams inline
- **Search**: instant message/file/code search across conversations
- **Enterprise SSO**: OAuth, SAML, LDAP, 2FA
- Used by Shopify, Stripe, Boston University

### Poe (Quora)
**Key Innovation: Multi-model comparison in single conversation**

- **@-mention system** (like Slack) to summon specific bots
- Users select from recommended bots or `@mention` directly
- **Side-by-side response display** within same conversation window
- **Group Chats**: up to 200 participants chatting with 200+ models
- **Previews** feature (like Artifacts) — content displayed in dedicated preview window
- Custom bot creation with personality/background definition
- Available on iOS, Android, Mac (Electron), Web

**Key Pattern:** `@mention` for agent invocation is natural, familiar, zero-learning-curve.

### AWS Sample: Group Chat AI
**GitHub:** github.com/aws-samples/sample-group-chat-ai

- **Tile-based persona selection UI**: name, role, details, avatar
- Up to 5 personas per session with intelligent turn-taking
- **14 languages** including Portuguese
- React + Vite frontend, Express.js backend
- Multi-provider: OpenAI, Anthropic, AWS Bedrock, Ollama
- Persona import/export via JSON
- Session persistence across browser sessions

### Key Pattern
The tile/card-based agent selection with avatar, name, role, and short description is the most common pattern across all platforms. It's visual, scannable, and works on mobile.

---

## 6. Concurrent Conversation Patterns

### Microsoft Azure Architecture Patterns (Canonical Reference)

**Sequential Orchestration**: Pipeline of agents — each processes previous output
**Concurrent Orchestration (Fan-out/Fan-in)**: Multiple agents on same task simultaneously, results aggregated
**Group Chat Orchestration**: Shared conversation thread, chat manager coordinates
**Handoff Orchestration (Triage/Routing)**: Dynamic delegation based on context
**Maker-Checker Loops**: One agent creates, another validates, cycle until approved

### Superset (Terminal-First Parallel Agents)
**HN Discussion:** news.ycombinator.com/item?id=46368739

- Terminal tabs isolated to worktrees
- Electron + xterm.js + node-pty (same stack as VS Code terminals)
- Port visualization per worktree for concurrent web servers
- **Hooks notify** when agents complete or need attention
- Practical limit: 2-3 concurrent agents despite 10-agent capacity
- Key requirement: "tight contracts — scoped task, invariant tests, diff small enough to audit quickly"

### Emerging UI Patterns for Concurrent Work

1. **Card/tile dashboard**: each active conversation as a card with status indicator (working, needs review, complete)
2. **Notification-driven**: background agents work silently, surface results via notifications
3. **Sidebar list + main panel**: conversations in sidebar, active one in main area (ChatGPT/Claude pattern)
4. **Tab bar**: browser-style tabs for switching between agent sessions (Zed editor proposal)
5. **Split view**: side-by-side comparison (Poe's multi-model, Atlas's page+chat)

### Key Insight
> "Excessive context switching is very damaging to the brain" — batch tasks, review results separately. The UI should support **async workflow**: dispatch tasks, get notified, review in batches.

---

## 7. Accessibility & Non-Technical User Patterns

### 2026 AI App UI/UX Trends

1. **Streaming text with typewriter effect**: perceived wait time drops 55-70% even when total generation time is identical
2. **Skeleton loading** (shimmer placeholders): reduces perceived load time by 40% vs. spinners
3. **Confidence indicators**: percentage badges, source citations, color-coded borders (green=high, amber=medium)
4. **Voice-first interfaces**: usage grew 65% YoY; persistent mic button, live transcription, waveform animation
5. **Dark mode as default**: 82% of users prefer dark mode for extended AI sessions; must support system-aware switching
6. **Micro-animations** (100-300ms): pulse during generation, height expansion for streaming, color transitions for state changes
7. **Glassmorphism 2.0**: dark base + translucent frosted panels for AI output areas
8. **Screen reader support**: `aria-live="polite"` on AI response containers, `role="status"` on loading indicators, keyboard focus management

### Reducing Friction for Non-Technical Users

**From chatbot UI research (Jotform 2026):**
- **Suggested conversation starters**: pre-built prompts reduce blank-screen anxiety
- **Quick-reply buttons**: organized visually, reduce typing
- **Pre-chat forms**: gather context before conversation starts
- **Clear human handoff**: obvious transition points between AI and human
- **Generative avatars**: personalized bot faces increase trust
- A good chatbot UI "feels invisible"

**From AI design patterns research:**
- **Voice as primary interface**: ChatGPT made dictation one of only 3 core buttons
- **Context maxing**: build persistent context (like Claude Projects) so users don't repeat themselves
- **Control over intent**: separate planning from execution — prevent accidental task initiation
- **Citation & source transparency**: inline sources improve confidence (Perplexity pioneered this)
- **Streaming work visualization**: show what's happening in real-time to reduce anxiety

### Internationalization Note
AWS Group Chat AI supports 14 languages including Portuguese. Persona definitions in TypeScript source, generated into JSON translation files. This pattern works for our Brazil users.

---

## 8. Vercel AI SDK Templates & Component Libraries

### AI SDK Agent Templates (aisdkagents.com)

**Ecommerce Multi-Agent Template:**
- Triage agent routes to specialists (Products, Account, General)
- Rich artifact streaming (product catalogs, shopping carts)
- Interactive UI components in side panel
- Tool-first approach with real data

**Sub Agent Starter Template:**
- Triage agent for intelligent routing
- Billing, Technical, General specialist agents
- Structured artifact display with animations
- Context-aware agent handoffs

**AI SDK Agent Platform Template:**
- Better Auth authentication, PostgreSQL, RAG
- Admin-based agent management (draft/active/archived lifecycle)
- Multi-organization support
- Database-backed agent persistence

### Common Template Patterns
- **Artifact side panels**: structured data alongside chat
- **Streaming responses**: real-time content rendering
- **Tool execution display**: visual feedback for agent tool calls
- **Status indicators**: agent routing and processing states

### Component Libraries

**assistant-ui** (github.com/assistant-ui/assistant-ui):
- Radix-style composable primitives (not monolithic widgets)
- Message list, chat input, thread management, toolbar
- Tool call rendering with human approval inline
- Integrates with: Vercel AI SDK, LangGraph, Mastra
- shadcn/ui theming, accessibility built-in, keyboard shortcuts

**Zola** (github.com/ibelick/zola):
- Next.js + TypeScript + Tailwind + shadcn/ui + Vercel AI SDK
- Multi-model: OpenAI, Mistral, Claude, Gemini, Ollama
- BYOK via OpenRouter
- Thread-based conversation management
- Supabase backend for auth and persistence
- Light/dark theme, responsive design

**prompt-kit** (github.com/ibelick/prompt-kit):
- Customizable components for AI apps
- PromptInput, Message display, CodeBlock, Chat container
- Markdown rendering, syntax highlighting, drag-drop uploads
- Streaming text, auto-scrolling, accessibility

**shadcn-chatbot-kit** (github.com/Blazity/shadcn-chatbot-kit):
- Rich chat interface with animations
- Advanced attachment handling with smart previews
- Thinking process visualization
- Tool integration with visual states
- CSS variable customization

---

## 9. Synthesis: Patterns Most Relevant to Our Harness

### Agent Selection UI
| Pattern | Used By | Pros | Cons |
|---------|---------|------|------|
| **Card/tile grid** | LobeHub, AWS Group Chat | Visual, scannable, mobile-friendly | Takes space |
| **Sidebar list** | ChatGPT, Claude, LibreChat | Familiar, compact | Less visual |
| **@mention in chat** | Poe, Slack | Zero learning curve, inline | Requires knowing agent names |
| **Dropdown selector** | Zola, Cursor | Compact, simple | Hidden, not discoverable |
| **Agent marketplace browse** | LobeHub, Poe | Discovery-first | Overkill for small roster |

**Recommendation for our use case:** Card grid for initial selection (agents have avatar + name + short description in Portuguese/English), with @mention for mid-conversation agent switching. Non-technical Brazilian users need visual, not text-heavy.

### Conversation Management
| Pattern | Used By | Pros | Cons |
|---------|---------|------|------|
| **Sidebar conversation list** | ChatGPT, Claude, LibreChat | Standard, proven | Gets long |
| **Tab bar** | Zed proposal, browsers | Quick switching, visible state | Limited on mobile |
| **Card dashboard** | Custom | Shows status at glance | Novel, learning curve |
| **Notification-driven background** | Cursor, Superset | Async-friendly | Needs good notification system |

**Recommendation:** Sidebar list (proven pattern users already know from WhatsApp/Telegram) + notification badges for background agent work. Each conversation shows: agent avatar, conversation title, status indicator (working/waiting/complete), last message preview.

### Concurrent Work
**Recommendation:** Don't try to show all conversations simultaneously. Instead:
1. Active conversation in main panel (full width on mobile)
2. Background agents show status dots in sidebar
3. Toast notifications when an agent completes or needs attention
4. "Review queue" view for batch-reviewing completed agent work

### Mobile-First
**Recommendation based on research:**
- Conversation list is the home screen (like WhatsApp)
- Tap to enter a conversation (full screen)
- Agent selection: swipeable card carousel or simple grid
- Voice input as first-class citizen (prominent mic button)
- Suggested prompts/starters for each agent
- Streaming text with typewriter effect
- Skeleton loading during inference
- Dark mode default with system-aware toggle

### Accessibility for Non-Technical Users
1. **Suggested starters per agent** — no blank screen anxiety
2. **Agent descriptions in plain language** — "I help you research topics" not "RAG-powered retrieval agent"
3. **Visual status indicators** — colored dots, progress bars, not technical status text
4. **One-tap agent selection** — card with avatar + name + one-line description
5. **Voice input** — critical for Portuguese-speaking users, mobile-first
6. **Confidence indicators** — when agents cite sources or express uncertainty
7. **Progressive disclosure** — advanced settings hidden until needed (ChatGPT Atlas pattern)

---

## 10. Open Source Starting Points (Ranked by Relevance)

1. **Zola** — closest to what we need: Next.js, shadcn, Vercel AI SDK, multi-model, clean. Fork-friendly.
2. **assistant-ui** — composable React components we could use regardless of which app shell we build
3. **prompt-kit** — AI-specific UI components (input, messages, code blocks)
4. **LobeChat** — full-featured reference, but complex. Study the agent marketplace pattern.
5. **LibreChat** — enterprise reference for multi-provider support
6. **AWS Group Chat AI** — reference for multi-persona group conversations with i18n
7. **Vercel AI SDK templates** — reference for agent routing, artifact streaming patterns
8. **shadcn-chatbot-kit** — reference for chat UI animations and attachment handling
