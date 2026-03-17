# Phase 3: Web Frontend

Detailed implementation requirements for the React SPA that gives partners browser-based access to harness agents.

**Depends on:** Phase 2 (serve mode) endpoints: `GET /api/agents`, `GET /api/sessions`, `POST /api/sessions`, `DELETE /api/sessions/:id`, `GET /api/usage`, `GET /health`, `WS /ws`

**Deploy target:** Cloudflare Pages (static SPA, global CDN, `wrangler pages deploy`)

**Primary user:** Non-technical partner in Brazil, using a phone, in Portuguese.

---

## Stack Decisions (Locked)

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Build | Vite 6 + React 19 + TypeScript 5.7 | Fast dev server, native ESM, no SSR needed |
| Styling | Tailwind CSS 4 + shadcn/ui | Utility-first, dark mode built-in, composable components |
| Chat primitives | assistant-ui (preferred) or prompt-kit (fallback) | assistant-ui: composable Radix-style primitives with tool call rendering and streaming. prompt-kit: purely presentational, no runtime coupling. Choose assistant-ui first; fall back to prompt-kit only if assistant-ui's RuntimeProvider abstraction forces Vercel AI SDK patterns that conflict with our WS protocol |
| Markdown | react-markdown + remark-gfm + rehype-highlight | Standard stack, GFM tables/checkboxes, syntax highlighting |
| WebSocket | react-use-websocket | Handles reconnection, heartbeat, JSON messages. Same lib as simple-chatapp reference |
| i18n | react-i18next + i18next | Lightweight, JSON translation files, browser language detection |
| Routing | react-router v7 (client-side only) | SPA routing, no server needed |
| State | Zustand | Minimal boilerplate, works well with WebSocket event-driven updates |
| Deploy | Cloudflare Pages via wrangler | Static assets, global CDN, free tier, custom domain support |

**Not using:** Next.js (requires Node runtime, Vercel-oriented), Vercel AI SDK (couples to Vercel streaming protocol), server components, SSR.

---

## 3.1 Project Scaffold (`web/`)

### Requirement

Create the `web/` directory as a standalone Vite project within the monorepo. It builds to static assets and deploys to Cloudflare Pages. It shares types with the backend via workspace references but has no runtime dependency on the server code.

### Directory Structure

```
web/
├── public/
│   └── _headers              # Cloudflare Pages headers (CSP, CORS)
├── src/
│   ├── main.tsx              # React entry
│   ├── App.tsx               # Root: router + providers (i18n, theme, auth)
│   ├── components/
│   │   ├── ui/               # shadcn/ui generated components
│   │   ├── auth/             # TokenEntry, AuthGuard
│   │   ├── agents/           # AgentCard, AgentGrid
│   │   ├── chat/             # ChatPanel, MessageBubble, ToolCallBlock, InputArea
│   │   ├── sidebar/          # ConversationSidebar, ConversationItem
│   │   ├── layout/           # AppShell, MobileNav, DesktopLayout
│   │   └── shared/           # StatusDot, LoadingSkeleton, ReconnectBanner
│   ├── hooks/
│   │   ├── useAgentChat.ts   # WebSocket connection + message state
│   │   ├── useAgentRoster.ts # GET /api/agents fetching
│   │   ├── useSessions.ts    # GET/POST/DELETE /api/sessions
│   │   ├── useAuth.ts        # Token persistence + validation
│   │   └── useTheme.ts       # Dark/light mode
│   ├── lib/
│   │   ├── ws-client.ts      # WebSocket message types + helpers
│   │   ├── api.ts            # REST client (fetch wrapper with auth header)
│   │   ├── i18n.ts           # i18next setup
│   │   └── constants.ts      # Backend URL, feature flags
│   ├── stores/
│   │   ├── auth.ts           # Zustand: token, user info
│   │   ├── chat.ts           # Zustand: messages, active conversation
│   │   └── ui.ts             # Zustand: sidebar open, theme, locale
│   ├── locales/
│   │   ├── en.json           # English translations
│   │   └── pt-BR.json        # Brazilian Portuguese translations
│   └── types/
│       └── index.ts          # Re-export shared types from ../../src/types/
├── index.html                # Vite HTML entry
├── vite.config.ts
├── tailwind.config.ts
├── tsconfig.json
├── wrangler.toml             # Cloudflare Pages config
├── components.json           # shadcn/ui config
└── package.json
```

### `vite.config.ts`

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@shared": path.resolve(__dirname, "../src/types"),
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:3000",
      "/ws": {
        target: "ws://localhost:3000",
        ws: true,
      },
    },
  },
});
```

### `wrangler.toml`

```toml
name = "mastersof-ai-web"
compatibility_date = "2026-03-01"
pages_build_output_dir = "dist"

[env.production]
vars = { VITE_API_URL = "https://api.mastersof.ai", VITE_WS_URL = "wss://api.mastersof.ai/ws" }

[env.staging]
vars = { VITE_API_URL = "https://staging-api.mastersof.ai", VITE_WS_URL = "wss://staging-api.mastersof.ai/ws" }
```

### `package.json` Scripts

```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "deploy": "npm run build && wrangler pages deploy dist",
    "deploy:staging": "npm run build && wrangler pages deploy dist --env staging",
    "lint": "eslint src/",
    "i18n:check": "npx i18next-parser 'src/**/*.{ts,tsx}'"
  }
}
```

### Acceptance Criteria

- [ ] `npm run dev` starts Vite dev server with hot reload
- [ ] `/api/*` and `/ws` requests proxy to `localhost:3000` during development
- [ ] `npm run build` produces `dist/` with `index.html` + hashed JS/CSS assets
- [ ] `npm run deploy` deploys to Cloudflare Pages successfully
- [ ] `@` alias resolves to `src/`, `@shared` resolves to `../src/types/`
- [ ] shadcn/ui components available via `npx shadcn@latest add <component>`
- [ ] Tailwind dark mode works via `class` strategy (not `media`)
- [ ] TypeScript strict mode enabled, no `any` in component props

### Test Plan

1. Run `npm run dev`, open `http://localhost:5173` -- page loads without errors
2. Run `npm run build` -- outputs to `dist/`, no TS errors, bundle size under 500KB gzipped
3. Run `npx wrangler pages dev dist` -- serves the built SPA locally as Cloudflare Pages would
4. Verify Vite proxy: while backend is running on :3000, `fetch("/api/agents")` from browser console returns agent list

---

## 3.2 Auth Screen

### Requirement

A full-screen token entry that appears when no valid token is stored. The token is an opaque UUID issued by the operator and defined in `~/.mastersof-ai/access.yaml` on the server. The frontend never sees the access.yaml file -- it validates the token by calling the backend.

**Components:**
- `TokenEntry` -- full-screen centered form
- `AuthGuard` -- wrapper that checks for stored token and validates it

**State (Zustand `auth` store):**
```typescript
interface AuthStore {
  token: string | null;
  userName: string | null;  // returned from validation response
  isValidating: boolean;
  error: string | null;
  setToken: (token: string) => void;
  clearToken: () => void;
  validate: () => Promise<boolean>;
}
```

**Flow:**
1. App mounts. `AuthGuard` checks `localStorage.getItem("mastersof-ai-token")`.
2. If token exists, call `GET /api/agents` with `Authorization: Bearer <token>`.
   - 200 -> token valid, store user info, render children.
   - 401/403 -> token expired/invalid, clear localStorage, show `TokenEntry`.
3. If no token, show `TokenEntry`.
4. User pastes token, submits. Same validation call.
5. On success, save to localStorage, navigate to agent grid.

**Cloudflare Access bypass:** If the environment variable `VITE_SKIP_AUTH=true` is set (because Cloudflare Access handles auth at the network layer), `AuthGuard` renders children immediately without token validation.

### Layout

```
Mobile + Desktop (centered):
┌──────────────────────────────────────────┐
│                                          │
│                                          │
│          ┌────────────────────┐          │
│          │   [harness icon]   │          │
│          │                    │          │
│          │   Masters of AI    │          │
│          │                    │          │
│          │ ┌────────────────┐ │          │
│          │ │ Enter token... │ │          │
│          │ └────────────────┘ │          │
│          │                    │          │
│          │   [ Continue → ]   │          │
│          │                    │          │
│          │  ⚠ Invalid token   │          │
│          │  (error, hidden    │          │
│          │   until triggered) │          │
│          └────────────────────┘          │
│                                          │
│                                          │
└──────────────────────────────────────────┘
```

### shadcn/ui Components

- `Card`, `CardHeader`, `CardContent` -- centered card container
- `Input` -- token text input (type="password" to obscure the token)
- `Button` -- submit button with loading spinner during validation
- `Alert`, `AlertDescription` -- error display (destructive variant)

### Acceptance Criteria

- [ ] Token input accepts paste (common flow: operator sends token via message, user pastes)
- [ ] Submit disabled while input is empty or while validating
- [ ] Loading spinner on button during validation (replace button text with spinner)
- [ ] Error message appears below input on 401/403, clears on next attempt
- [ ] Valid token persists across page refreshes (localStorage)
- [ ] Logging out (future) clears token from localStorage and returns to this screen
- [ ] Screen renders correctly on 320px-wide viewport (small phones)
- [ ] Input is auto-focused on mount
- [ ] Enter key submits the form
- [ ] Dark background (zinc-950) with centered card (zinc-900 border)

### Test Plan

1. Clear localStorage, reload -- token entry screen appears
2. Enter invalid token, submit -- error message "Token inv\u00e1lido" (pt-BR) / "Invalid token" (en)
3. Enter valid token, submit -- spinner shows, then redirects to agent grid
4. Reload page -- agent grid loads immediately (token in localStorage)
5. Accessibility: Tab through form elements, ensure focus ring visible on all interactive elements
6. Screen reader: form has `aria-label`, error has `role="alert"`

---

## 3.3 Agent Card Grid (Home Screen)

### Requirement

The landing screen after auth. Displays all agents the current user has access to as a grid of cards. Each card shows the agent's identity and provides an entry point into conversation.

**Data source:** `GET /api/agents` (filtered by token on the server).

**Response shape (from Phase 2):**
```typescript
interface AgentManifest {
  id: string;            // directory name, e.g. "cre-analyst"
  name: string;          // display name, e.g. "CRE Analyst"
  description: string;   // one-liner from frontmatter or first paragraph
  icon?: string;         // emoji shortcode or image filename
  tags: string[];        // e.g. ["cre", "analysis"]
  starters: string[];    // e.g. ["Analyze this deal for me"]
  access: "public" | "private" | "users";
}
```

**Components:**
- `AgentGrid` -- fetches roster, renders grid of `AgentCard` components
- `AgentCard` -- single agent card with icon, name, description, tags, action

**Hook: `useAgentRoster`**
```typescript
interface UseAgentRoster {
  agents: AgentManifest[];
  isLoading: boolean;
  error: string | null;
  refetch: () => void;
}
```

### Layout

```
Desktop (>= 1024px):
┌────────────────────────────────────────────────────────────┐
│  Masters of AI                              [theme] [lang] │
├────────────────────────────────────────────────────────────┤
│                                                            │
│  Choose an agent                                           │
│                                                            │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐       │
│  │ 🏢           │ │ 🔍           │ │ 📝           │       │
│  │ CRE Analyst  │ │ Researcher   │ │ Writer       │       │
│  │              │ │              │ │              │       │
│  │ Commercial   │ │ Deep dive    │ │ Draft and    │       │
│  │ real estate  │ │ research on  │ │ edit content │       │
│  │ analysis     │ │ any topic    │ │ of any kind  │       │
│  │              │ │              │ │              │       │
│  │ [cre] [deals]│ │ [research]   │ │ [writing]    │       │
│  │              │ │              │ │              │       │
│  │ > Analyze... │ │ > Research.. │ │ > Write a... │       │
│  │ > Compare... │ │ > Find...    │ │ > Edit this. │       │
│  └──────────────┘ └──────────────┘ └──────────────┘       │
│                                                            │
└────────────────────────────────────────────────────────────┘

Mobile (< 640px):
┌──────────────────────┐
│ Masters of AI  [cog] │
├──────────────────────┤
│                      │
│ Choose an agent      │
│                      │
│ ┌──────────────────┐ │
│ │ 🏢 CRE Analyst   │ │
│ │                  │ │
│ │ Commercial real  │ │
│ │ estate analysis  │ │
│ │                  │ │
│ │ [cre] [deals]    │ │
│ │                  │ │
│ │ > Analyze this.. │ │
│ │ > Compare these. │ │
│ └──────────────────┘ │
│                      │
│ ┌──────────────────┐ │
│ │ 🔍 Researcher    │ │
│ │ ...              │ │
│ └──────────────────┘ │
│                      │
└──────────────────────┘
```

### AgentCard Component

**Props:**
```typescript
interface AgentCardProps {
  agent: AgentManifest;
  onSelect: (agentId: string) => void;
  onStarterClick: (agentId: string, starter: string) => void;
}
```

**Rendering:**
- Icon: rendered as emoji if shortcode, as `<img>` if filename (served from `/api/agents/:id/icon`)
- Name: `text-lg font-semibold`
- Description: `text-sm text-muted-foreground`, max 3 lines with `line-clamp-3`
- Tags: `Badge` components (shadcn/ui), small, muted variant
- Starters: max 3 shown, each as a clickable row with `>` prefix. Clicking a starter creates a new conversation and sends that starter as the first message.
- Entire card is clickable (navigates to conversation list for that agent or creates a new conversation)

**shadcn/ui components:** `Card`, `CardHeader`, `CardContent`, `CardFooter`, `Badge`, `Skeleton`

**Loading state:** Grid of 3 `Skeleton` cards (card-shaped placeholders with shimmer animation). Use shadcn/ui `Skeleton` component sized to match card dimensions.

**Empty state:** Centered message: "No agents available. Contact your administrator." / "Nenhum agente dispon\u00edvel. Entre em contato com o administrador."

**Error state:** `Alert` with destructive variant showing the error message and a retry button.

### Acceptance Criteria

- [ ] Grid renders 1 column on mobile (<640px), 2 columns on tablet (640-1023px), 3 columns on desktop (>=1024px)
- [ ] Cards have consistent height within each row (CSS grid `auto-rows`)
- [ ] Loading skeleton shows for at least 200ms (prevents flash)
- [ ] Clicking a card navigates to `/agent/:agentId` (conversation view)
- [ ] Clicking a starter prompt navigates to `/agent/:agentId/new?starter=<encoded>`, which creates a new session and sends the starter
- [ ] Tags wrap properly when there are many
- [ ] Agent icons render (emoji and image variants)
- [ ] Empty state message appears when API returns empty array
- [ ] Error state appears on network failure with retry button
- [ ] Cards have hover effect (desktop): subtle border highlight or shadow lift
- [ ] Cards have active/pressed effect (mobile): brief scale-down

### Test Plan

1. Mock backend with 0 agents -- empty state message renders
2. Mock backend with 5 agents -- grid renders correctly at mobile, tablet, desktop widths
3. Mock backend with slow response (2s) -- skeleton cards show, then real cards replace them
4. Mock backend returning 500 -- error alert with retry button renders
5. Click a card -- URL changes to `/agent/:id`
6. Click a starter -- URL changes to `/agent/:id/new?starter=...`
7. Accessibility: cards are focusable with Tab, activatable with Enter/Space
8. Accessibility: each card has `role="article"` or semantic `<article>`, starters have `role="button"`
9. Playwright: `await page.goto("/"); await expect(page.getByText("CRE Analyst")).toBeVisible();`

---

## 3.4 Conversation Sidebar

### Requirement

A sidebar listing all conversations (sessions) for the currently selected agent. Follows the WhatsApp/Telegram conversation list pattern that the target user base is familiar with.

**Data source:** `GET /api/sessions?agentId=<id>` returns:
```typescript
interface Session {
  id: string;
  agentId: string;
  title: string;          // auto-generated from first message or user-set
  status: "idle" | "active" | "needs_attention" | "error";
  lastMessage?: string;   // preview text
  lastMessageAt?: string; // ISO timestamp
  createdAt: string;
  messageCount: number;
}
```

**Components:**
- `ConversationSidebar` -- container with session list and new conversation button
- `ConversationItem` -- single session row
- `StatusDot` -- colored status indicator

**Hook: `useSessions`**
```typescript
interface UseSessions {
  sessions: Session[];
  isLoading: boolean;
  error: string | null;
  createSession: (agentId: string) => Promise<Session>;
  deleteSession: (sessionId: string) => Promise<void>;
  refetch: () => void;
}
```

### Layout

```
Desktop (fixed left sidebar, 320px wide):
┌──────────────────┬─────────────────────────────────────┐
│ ← Agents         │                                     │
│                  │                                     │
│ CRE Analyst      │          (chat panel)               │
│                  │                                     │
│ [+ New chat]     │                                     │
│                  │                                     │
│ ┌──────────────┐ │                                     │
│ │🏢 Deal anal. │ │                                     │
│ │● Cap rate is │ │                                     │
│ │  2 min ago   │ │                                     │
│ ├──────────────┤ │                                     │
│ │🏢 Market comp│ │                                     │
│ │○ Compare the │ │                                     │
│ │  Yesterday   │ │                                     │
│ ├──────────────┤ │                                     │
│ │🏢 Portfolio  │ │                                     │
│ │⚠ Error fetch │ │                                     │
│ │  3 days ago  │ │                                     │
│ └──────────────┘ │                                     │
│                  │                                     │
└──────────────────┴─────────────────────────────────────┘

Mobile (full-width conversation list, replaces chat panel):
┌──────────────────────┐
│ ← Agents    [+ New]  │
│                      │
│ CRE Analyst          │
│                      │
│ ┌──────────────────┐ │
│ │ 🏢  Deal analysis│ │
│ │ ●   Cap rate is  │ │
│ │     5.2% which.. │ │
│ │          2m ago  │ │
│ ├──────────────────┤ │
│ │ 🏢  Market comp  │ │
│ │ ○   Compare the  │ │
│ │     downtown...  │ │
│ │      Yesterday   │ │
│ └──────────────────┘ │
│                      │
└──────────────────────┘
```

### ConversationItem Component

**Props:**
```typescript
interface ConversationItemProps {
  session: Session;
  isSelected: boolean;
  onSelect: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
}
```

**Rendering:**
- Agent icon (small, 24px) on the left
- Title: `text-sm font-medium`, single line, truncated
- Status dot: inline before the title
  - `idle` -- gray dot (`bg-zinc-500`)
  - `active` -- green dot with CSS pulse animation (`bg-green-500 animate-pulse`)
  - `needs_attention` -- orange dot (`bg-orange-500`)
  - `error` -- red dot (`bg-red-500`)
- Last message preview: `text-xs text-muted-foreground`, single line, truncated
- Relative time: `text-xs text-muted-foreground`, right-aligned. Use `Intl.RelativeTimeFormat` with the current locale (not a library). Examples: "2 min ago" / "h\u00e1 2 min", "Yesterday" / "Ontem".
- Selected state: `bg-accent` background
- Delete: on desktop, show trash icon on hover (right side). On mobile, swipe-left to reveal delete button (use a simple CSS transform + touch event handler, no heavy gesture library).

### Delete Confirmation

Use shadcn/ui `AlertDialog` with:
- Title: "Delete conversation?" / "Excluir conversa?"
- Description: "This action cannot be undone." / "Esta a\u00e7\u00e3o n\u00e3o pode ser desfeita."
- Cancel + Confirm (destructive variant) buttons

### New Conversation Button

- Prominent at top of sidebar
- shadcn/ui `Button` with `PlusIcon` from lucide-react
- Creates session via `POST /api/sessions { agentId }`, then navigates to the new session

### Back to Agents

- Arrow-left button at top of sidebar navigates back to the agent grid (`/`)
- On desktop, always visible. On mobile, replaces the header when in conversation list view.

### Acceptance Criteria

- [ ] Sessions load when an agent is selected and display in reverse chronological order (newest first)
- [ ] Status dots render with correct colors and pulse animation for `active`
- [ ] Relative times update every 60 seconds (use `setInterval` in the component)
- [ ] Selecting a session highlights it and loads the chat panel
- [ ] New conversation button creates a session and navigates to it
- [ ] Delete shows confirmation dialog, then removes the session from the list
- [ ] Mobile: swipe-left reveals delete button with red background
- [ ] Mobile: tapping a session navigates to full-screen chat (hides sidebar)
- [ ] Desktop: sidebar is fixed width (320px), does not collapse
- [ ] Empty state: "No conversations yet. Start one!" / "Nenhuma conversa ainda. Comece uma!"
- [ ] Loading: `Skeleton` components matching the conversation item shape

### Test Plan

1. Mock 0 sessions -- empty state appears
2. Mock 5 sessions with mixed statuses -- all render correctly with proper status dots
3. Mock session with `active` status -- green dot pulses
4. Click "New chat" -- session created, appears at top of list, chat panel opens
5. Delete a session -- dialog appears, confirming removes it, canceling preserves it
6. On mobile viewport (375px), tap session -- chat panel fills screen, sidebar hidden
7. On mobile, tap back arrow in chat -- returns to conversation list
8. Accessibility: items are in a `<nav>` with `role="list"`, each is `role="listitem"`, focusable with keyboard
9. Playwright: `await page.getByRole("button", { name: /new chat/i }).click(); await expect(page.getByRole("listitem")).toHaveCount(initialCount + 1);`

---

## 3.5 Chat Panel

### Requirement

The main conversation area. Connects to the backend via WebSocket, displays streaming responses, renders markdown, and handles user input. This is the most complex component and the core of the user experience.

**WebSocket Protocol (from Phase 2):**

Client sends:
```typescript
// Subscribe to a conversation (on connect or session change)
{ type: "subscribe", agentId: string, sessionId?: string }

// Send a user message
{ type: "message", content: string }

// Interrupt current generation
{ type: "interrupt" }
```

Server sends:
```typescript
// Streaming text tokens
{ type: "token", content: string, messageId: string }

// Tool call started
{ type: "tool_use", toolId: string, toolName: string, toolInput: Record<string, any> }

// Tool call completed
{ type: "tool_result", toolId: string, output: string, isError: boolean }

// Complete assistant message (sent after all tokens)
{ type: "assistant_message", messageId: string, content: string }

// Status changes
{ type: "status", status: "thinking" | "tool_executing" | "responding" | "idle" }

// Errors
{ type: "error", code: string, message: string }

// Conversation history (on subscribe)
{ type: "history", messages: Message[] }
```

### Hook: `useAgentChat`

The central hook managing WebSocket connection and message state. Based on the pattern from the simple-chatapp reference but extended with streaming, reconnection, and multi-agent support.

```typescript
interface UseAgentChat {
  // State
  messages: ChatMessage[];
  isConnected: boolean;
  isStreaming: boolean;
  agentStatus: "idle" | "thinking" | "tool_executing" | "responding";
  connectionState: "connected" | "connecting" | "reconnecting" | "disconnected";
  error: string | null;

  // Actions
  sendMessage: (content: string) => void;
  interrupt: () => void;
  subscribe: (agentId: string, sessionId?: string) => void;

  // Refs
  messagesEndRef: React.RefObject<HTMLDivElement>;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  isStreaming?: boolean;       // true while tokens still arriving
  toolCalls?: ToolCall[];      // tool calls within this assistant message
  agentId?: string;            // which agent generated this message
}

interface ToolCall {
  id: string;
  name: string;
  input: Record<string, any>;
  output?: string;
  status: "executing" | "complete" | "error";
  error?: string;
}
```

**Streaming accumulation:** When `token` messages arrive, append to the current assistant message's `content` field. Set `isStreaming: true`. When `assistant_message` arrives, replace the accumulated content with the final content and set `isStreaming: false`. This handles the case where tokens arrive out of order or the final message differs from accumulated tokens.

**Optimistic user messages:** When `sendMessage` is called, immediately add the user message to `messages` (same pattern as simple-chatapp). The server will not echo it back.

### Layout

```
Desktop (within right panel, next to sidebar):
┌─────────────────────────────────────────────────┐
│ CRE Analyst                     ● Connected     │
├─────────────────────────────────────────────────┤
│                                                 │
│  ┌──────────────────────────────────────┐       │
│  │ 🏢 Here's my analysis of the deal:  │       │
│  │                                      │       │
│  │ ## Key Metrics                       │       │
│  │ - Cap rate: 5.2%                     │       │
│  │ - NOI: $1.2M                         │       │
│  │                                      │       │
│  │ ▶ Read "deal-memo.pdf"        ✓      │       │
│  │ ▶ Bash: python analyze.py     ✓      │       │
│  │ ▶ WebSearch: "cap rate 2026"  ⟳      │       │
│  │                                      │       │
│  │ Based on the current market...       │       │
│  └──────────────────────────────────────┘       │
│                                                 │
│                    ┌────────────────────────┐    │
│                    │ What's the cap rate?   │    │
│                    └────────────────────────┘    │
│                                                 │
│  ┌──────────────────────────────────────┐       │
│  │ 🏢 The cap rate for this property... │       │
│  │ █  (streaming cursor)                │       │
│  └──────────────────────────────────────┘       │
│                                                 │
├─────────────────────────────────────────────────┤
│ ┌─────────────────────────────────┐ [🎤] [➤]   │
│ │ Type a message...               │             │
│ └─────────────────────────────────┘             │
└─────────────────────────────────────────────────┘

Mobile (full width):
┌──────────────────────┐
│ ← CRE Analyst    ●  │
├──────────────────────┤
│                      │
│ (same message layout │
│  but full-width      │
│  bubbles)            │
│                      │
├──────────────────────┤
│ ┌──────────────┐🎤 ➤│
│ │ Message...   │     │
│ └──────────────┘     │
└──────────────────────┘
```

### Message Display

**User messages:**
- Right-aligned
- Background: `bg-blue-600 text-white` (dark mode: `bg-blue-700`)
- Max-width: 80% on desktop, 85% on mobile
- Rounded corners: `rounded-2xl rounded-br-sm` (chat bubble shape)
- Plain text (no markdown rendering for user messages)

**Assistant messages:**
- Left-aligned
- Agent avatar (icon from manifest, 32px) to the left of the first message in a group
- Background: `bg-zinc-800` (dark mode) / `bg-zinc-100` (light mode)
- Max-width: 80% on desktop, 90% on mobile
- Rounded corners: `rounded-2xl rounded-bl-sm`
- Content rendered as markdown (see below)
- Tool calls rendered inline (see 3.6)
- Streaming indicator: blinking block cursor (`█`) at end of content while `isStreaming: true`. Use CSS animation: `@keyframes blink { 50% { opacity: 0; } }` at 530ms interval.

**Markdown rendering:**
- `react-markdown` with `remarkGfm` (tables, strikethrough, task lists, autolinks)
- `rehypeHighlight` for code syntax highlighting
- Prose styling: use Tailwind Typography plugin (`prose prose-invert prose-sm`) for consistent markdown typography
- Code blocks: see dedicated section below

**Code blocks:**
- Syntax-highlighted via `rehype-highlight` (language auto-detection + explicit language tags)
- Dark background: `bg-zinc-900` with `rounded-lg` and `p-4`
- Header bar showing language name (left) and copy button (right)
- Copy button: clipboard icon from lucide-react, onClick copies code content. Shows check icon for 2 seconds after copy. Use `navigator.clipboard.writeText()`.
- Horizontal scroll for long lines (no wrapping): `overflow-x-auto`

**Auto-scroll:**
- On new messages or streaming tokens, scroll to bottom
- Exception: if the user has manually scrolled up (more than 100px from bottom), do NOT auto-scroll. Show a "scroll to bottom" floating button (`ChevronDown` icon, circular, bottom-right of message area).
- Clicking the scroll-to-bottom button scrolls to bottom and re-enables auto-scroll.
- Implementation: use `IntersectionObserver` on the sentinel div at the bottom. When it's not visible, user has scrolled up. When it's visible, auto-scroll is active.

### Input Area

**Components:**
- Text area: `<textarea>` with auto-resize (min 1 row, max 6 rows). Not a `<input>` -- must support multiline.
- Send button: `SendHorizontal` icon from lucide-react. Enabled only when input is non-empty and not streaming.
- Mic button: see 3.10 (Voice Input)
- Keyboard: `Enter` sends, `Shift+Enter` inserts newline. This is the WhatsApp convention the target user knows.
- Placeholder text: "Type a message..." / "Digite uma mensagem..."
- Disabled state during streaming: input is NOT disabled (user can type next message), but send button shows "Stop" with `Square` icon that triggers `interrupt`.

**shadcn/ui components:** `Button` (icon variants for send/mic/stop), `Textarea` (or custom auto-resizing textarea)

### Empty Conversation State

When a session has no messages yet, show:
- Agent icon (large, 64px)
- Agent name
- Agent description
- Starter prompts as clickable chips/buttons (shadcn/ui `Button` variant="outline")
- Clicking a starter sends it as the first message

```
┌─────────────────────────────────────┐
│                                     │
│              🏢                     │
│         CRE Analyst                 │
│                                     │
│  Commercial real estate deal        │
│  analysis and market research       │
│                                     │
│  ┌─────────────────────────────┐    │
│  │ Analyze this deal for me    │    │
│  └─────────────────────────────┘    │
│  ┌─────────────────────────────┐    │
│  │ What's the cap rate in...   │    │
│  └─────────────────────────────┘    │
│  ┌─────────────────────────────┐    │
│  │ Compare these two properties│    │
│  └─────────────────────────────┘    │
│                                     │
└─────────────────────────────────────┘
```

### Acceptance Criteria

- [ ] WebSocket connects on mount, subscribes to the active session
- [ ] User messages appear immediately (optimistic), right-aligned, blue
- [ ] Assistant messages stream token-by-token with visible typewriter effect
- [ ] Blinking cursor visible at end of streaming message, disappears when complete
- [ ] Markdown renders correctly: headings, bold, italic, lists, links, tables, code blocks
- [ ] Code blocks have syntax highlighting, language label, and working copy button
- [ ] Auto-scroll follows new content unless user has scrolled up
- [ ] Scroll-to-bottom button appears when user scrolls up during streaming
- [ ] Enter sends message, Shift+Enter inserts newline
- [ ] Empty conversation shows agent info and starter prompts
- [ ] Clicking starter prompt sends it as the first message
- [ ] "Stop" button (during streaming) sends interrupt and stops the stream
- [ ] Connection status indicator visible in header
- [ ] Input area auto-resizes with content (1-6 rows)
- [ ] Message area takes full remaining height (flex-1, overflow-y-auto)

### Test Plan

1. Open a new conversation -- empty state with starters appears
2. Click a starter -- message sent, streaming response appears
3. Type a message, press Enter -- message appears right-aligned, assistant response streams
4. During streaming, press Shift+Enter in input -- newline inserted, message not sent
5. During streaming, click Stop -- streaming halts
6. Send a message that triggers markdown (e.g. ask for a code example) -- markdown renders with syntax highlighting
7. Click copy button on a code block -- clipboard contains the code
8. Scroll up during streaming -- auto-scroll stops, "scroll to bottom" button appears
9. Click "scroll to bottom" -- jumps to bottom, auto-scroll resumes
10. Kill backend during conversation -- "Reconnecting..." banner appears (see 3.12)
11. Mobile (375px): messages fill width appropriately, input area has correct safe area padding
12. Accessibility: messages have `role="log"` container with `aria-live="polite"`, each message has `role="article"`, input has clear label
13. Playwright: `await page.getByPlaceholder(/type a message/i).fill("Hello"); await page.keyboard.press("Enter"); await expect(page.locator('[data-role="assistant"]')).toBeVisible();`

---

## 3.6 Tool Call Display

### Requirement

Tool calls are rendered inline within assistant messages as collapsible blocks. They show what the agent is doing -- reading files, running commands, searching -- with a clear visual state (executing, complete, error). Tool approval is supported for cases where `canUseTool` returns a question.

### Tool Call Block Component

**Props:**
```typescript
interface ToolCallBlockProps {
  toolCall: ToolCall;
  onApprove?: (toolId: string) => void;
  onReject?: (toolId: string) => void;
}
```

**Three visual states:**

1. **Executing** -- tool is currently running
   - Left icon: `Loader2` (lucide-react) with `animate-spin`
   - Tool name in small caps: `text-xs font-semibold uppercase tracking-wide`
   - Summary text (see per-tool summaries below)
   - Background: `bg-zinc-800/50` with left border `border-l-2 border-blue-500`
   - Not expandable (no output yet)

2. **Complete** -- tool finished successfully
   - Left icon: `Check` (lucide-react) in green
   - Tool name + summary text
   - Background: `bg-zinc-800/50` with left border `border-l-2 border-green-500`
   - Expandable: click to show/hide full input and output

3. **Error** -- tool failed
   - Left icon: `X` (lucide-react) in red
   - Tool name + error message
   - Background: `bg-zinc-800/50` with left border `border-l-2 border-red-500`
   - Expandable: click to show full error details

**Per-tool summaries** (generate a human-readable one-liner from tool input):

| Tool | Summary Format |
|------|---------------|
| Read | File path: `src/agent.ts` |
| Write | Writing: `src/new-file.ts` |
| Edit | Editing: `src/agent.ts` |
| Bash | `$ npm install react` (first 80 chars of command) |
| Grep | Searching for `"AgentManifest"` in `src/` |
| Glob | Finding `**/*.ts` |
| WebSearch | Searching: "cap rate trends 2026" |
| WebFetch | Fetching: `https://example.com` |
| (default) | Tool name + JSON.stringify(input).slice(0, 80) |

**Expanded content:**
- Input section: `<pre>` block with `JSON.stringify(input, null, 2)`, syntax highlighted
- Output section: `<pre>` block with output text. If output is very long (>500 chars), show first 500 chars with a "Show more" toggle.
- Use shadcn/ui `Collapsible` component for expand/collapse with smooth height animation.

### Tool Approval Flow

When the backend sends a tool call that requires user approval (because `canUseTool` returned a question), the tool call block renders in a special state:

- Left icon: `ShieldQuestion` (lucide-react) in orange
- Displays the question text from `canUseTool`
- Two buttons: "Allow" (green, `Check` icon) and "Deny" (red, `X` icon)
- Background: `bg-zinc-800/50` with left border `border-l-2 border-orange-500`
- Buttons send approval/rejection via WebSocket:
  ```typescript
  { type: "tool_approval", toolId: string, approved: boolean }
  ```
- After user decides, block transitions to `executing` or `error` state

### Layout

```
Within an assistant message:
┌──────────────────────────────────────────┐
│ 🏢 Here's what I found:                 │
│                                          │
│ ┃ ⟳ WEBSEARCH                           │
│ ┃   Searching: "cap rate trends 2026"   │
│                                          │
│ ┃ ✓ READ                          [▶]   │
│ ┃   File: data/market-report.csv        │
│                                          │
│ ┃ ✗ BASH                          [▶]   │
│ ┃   $ python analyze.py                 │
│ ┃   Error: ModuleNotFoundError          │
│                                          │
│ Based on the market data...              │
└──────────────────────────────────────────┘

Expanded tool call:
┌──────────────────────────────────────────┐
│ ┃ ✓ READ                          [▼]   │
│ ┃   File: data/market-report.csv        │
│ ┃ ┌──────────────────────────────────┐   │
│ ┃ │ Input:                           │   │
│ ┃ │ { "file_path": "data/market..." }│   │
│ ┃ │                                  │   │
│ ┃ │ Output:                          │   │
│ ┃ │ Market,CapRate,NOI               │   │
│ ┃ │ Austin,5.2%,1200000              │   │
│ ┃ │ Dallas,4.8%,980000               │   │
│ ┃ │ ...                              │   │
│ ┃ │           [Show more]            │   │
│ ┃ └──────────────────────────────────┘   │
└──────────────────────────────────────────┘

Tool approval:
┌──────────────────────────────────────────┐
│ ┃ ⚠ BASH                                │
│ ┃   Run: rm -rf /tmp/old-data            │
│ ┃                                        │
│ ┃   Allow this command?                  │
│ ┃                                        │
│ ┃   [✓ Allow]  [✗ Deny]                 │
└──────────────────────────────────────────┘
```

### Acceptance Criteria

- [ ] Tool calls render inline within the assistant message, between text blocks
- [ ] Executing state shows spinner, name, and summary
- [ ] Complete state shows green check, clickable to expand
- [ ] Error state shows red X, clickable to expand with error details
- [ ] Per-tool summaries generate correctly for Read, Write, Edit, Bash, Grep, Glob, WebSearch, WebFetch
- [ ] Unknown tools fall back to truncated JSON input
- [ ] Expanded view shows formatted input and output with syntax highlighting
- [ ] Long output (>500 chars) truncates with "Show more" toggle
- [ ] Collapse/expand has smooth height animation (200ms)
- [ ] Tool approval buttons render when approval is required
- [ ] Clicking Allow/Deny sends correct WebSocket message and transitions state
- [ ] Multiple tool calls in one message render in sequence

### Test Plan

1. Send a message that triggers a single tool call -- tool block appears with executing state, then transitions to complete
2. Send a message that triggers multiple tool calls -- all render in sequence with correct states
3. Click on a complete tool call -- expands to show input/output
4. Click again -- collapses
5. Trigger a tool error -- error state renders with red styling and error message
6. Trigger a tool that requires approval (if backend supports it) -- approval buttons appear, clicking Allow continues
7. Long tool output (>500 chars) -- truncated with "Show more"
8. Accessibility: tool blocks have `role="status"`, expanding/collapsing uses `aria-expanded`, approve/deny buttons have descriptive labels
9. Playwright: `await expect(page.locator('[data-tool-status="complete"]')).toBeVisible(); await page.locator('[data-tool-status="complete"]').click(); await expect(page.getByText("Output:")).toBeVisible();`

---

## 3.7 @mention Agent Switching

### Requirement

Users can type `@` in the chat input to trigger an autocomplete dropdown showing available agents. Selecting an agent inserts an `@agentname` mention into the message, which the backend interprets as a request to involve that agent (either as a handoff or a sub-agent invocation, depending on backend implementation).

### Components

- `MentionAutocomplete` -- dropdown that appears above the input when `@` is typed
- `MentionBadge` -- inline visual indicator that a mention was inserted

### Behavior

1. User types `@` anywhere in the input textarea
2. Autocomplete dropdown appears above the cursor position (or above the input on mobile)
3. Dropdown lists available agents from the roster (fetched via `useAgentRoster`), filtered by text typed after `@`
4. Each row: agent icon + agent name + short description
5. User selects via click, tap, or arrow keys + Enter
6. On selection: `@agentname` is inserted into the input at the cursor position, with a trailing space
7. The `@agentname` text is styled differently in the textarea (bold or colored) -- implemented via a contentEditable overlay or by rendering the input with highlighted tokens (use a simple approach: just show the text, style it on send)
8. When the message is sent, the backend parses `@agentname` from the content
9. On mobile, the dropdown is full-width at the bottom of the screen (above the keyboard)

### Layout

```
Desktop (dropdown above input):
┌─────────────────────────────────────┐
│  ┌───────────────────────────────┐  │
│  │ 🏢 CRE Analyst               │  │
│  │    Commercial real estate...  │  │
│  ├───────────────────────────────┤  │
│  │ 🔍 Researcher                 │  │
│  │    Deep dive research...      │  │
│  ├───────────────────────────────┤  │
│  │ 📝 Writer                     │  │
│  │    Draft and edit content...  │  │
│  └───────────────────────────────┘  │
│ ┌─────────────────────────────┐     │
│ │ Ask @re|                    │     │
│ └─────────────────────────────┘     │
└─────────────────────────────────────┘
(typing "@re" filters to "Researcher")

Mobile (full-width above keyboard):
┌──────────────────────┐
│                      │
│  (chat messages)     │
│                      │
│ ┌──────────────────┐ │
│ │🏢 CRE Analyst    │ │
│ │🔍 Researcher     │ │
│ │📝 Writer         │ │
│ └──────────────────┘ │
│ ┌──────────────────┐ │
│ │ Ask @|           │ │
│ └──────────────────┘ │
│ [virtual keyboard]   │
└──────────────────────┘
```

### Acceptance Criteria

- [ ] Typing `@` triggers autocomplete dropdown
- [ ] Dropdown filters as user types after `@`
- [ ] Selecting an agent inserts `@agentname ` (with trailing space) at cursor position
- [ ] Arrow keys navigate the dropdown, Enter selects, Escape dismisses
- [ ] Clicking/tapping an agent row selects it
- [ ] Dropdown positions above the input and does not overflow the viewport
- [ ] Dropdown shows max 5 agents (scrollable if more)
- [ ] If no agents match the filter, dropdown shows "No agents found" / "Nenhum agente encontrado"
- [ ] `@` in the middle of a word does not trigger autocomplete (only after whitespace or at start of input)
- [ ] The sent message contains the raw `@agentname` text for backend parsing

### Test Plan

1. Type `@` in empty input -- dropdown shows all available agents
2. Type `@cre` -- dropdown filters to agents matching "cre"
3. Press down arrow twice, then Enter -- second agent is selected, mention inserted
4. Click on an agent in dropdown -- mention inserted, dropdown closes
5. Press Escape -- dropdown closes without inserting
6. Type a message without `@` -- no dropdown appears
7. Type `email@test` (no space before @) -- no dropdown appears
8. Accessibility: dropdown has `role="listbox"`, items have `role="option"`, active item has `aria-selected="true"`

---

## 3.8 Dark Mode

### Requirement

The app defaults to dark mode. Users can toggle between dark and light, with the preference persisted. System theme detection is supported as the initial default.

### Implementation

**Theme store (Zustand `ui` store, `theme` field):**
```typescript
type Theme = "dark" | "light" | "system";
```

**Resolution order:**
1. Check `localStorage.getItem("mastersof-ai-theme")`
2. If `"system"` or absent, check `window.matchMedia("(prefers-color-scheme: dark)")`
3. Default: `"dark"` (if no system preference detected)

**Applying the theme:**
- Add/remove `dark` class on `<html>` element (Tailwind `class` strategy)
- Listen for `matchMedia` changes when theme is `"system"` to react to OS-level changes
- shadcn/ui components automatically use dark variant when `.dark` class is present

**Toggle UI:**
- Icon button in the top-right header area
- Three states cycle: dark (Moon icon) -> light (Sun icon) -> system (Monitor icon)
- Tooltip shows current mode name
- shadcn/ui `Button` (ghost variant, icon-only) + `Tooltip`

### Acceptance Criteria

- [ ] App loads in dark mode by default (new user, no localStorage, no system preference)
- [ ] Clicking toggle cycles: dark -> light -> system
- [ ] Theme persists across page reloads
- [ ] System mode reacts to OS theme change in real time
- [ ] All shadcn/ui components render correctly in both modes
- [ ] Custom components (message bubbles, tool blocks, status dots) have correct colors in both modes
- [ ] No flash of wrong theme on initial load (apply theme class in `<head>` script before React mounts)
- [ ] Color contrast meets WCAG AA in both modes (4.5:1 for normal text, 3:1 for large text)

### Test Plan

1. Open app with no localStorage -- dark mode renders
2. Toggle to light -- all backgrounds, text, borders switch correctly
3. Toggle to system -- matches OS setting
4. Change OS theme while in system mode -- app theme changes without reload
5. Reload -- persisted theme loads without flash
6. Run axe or Lighthouse accessibility audit -- no contrast failures in either mode

---

## 3.9 Mobile Responsive

### Requirement

The app is designed mobile-first. The Brazilian partner uses it primarily on a phone. The layout adapts across three breakpoints with no loss of functionality.

### Breakpoints

| Breakpoint | Width | Layout |
|------------|-------|--------|
| Mobile | < 640px | Single column. Conversation list OR chat panel, never both. Bottom navigation for primary actions. |
| Tablet | 640px - 1023px | Conversation sidebar (240px) + chat panel. Agent grid 2 columns. |
| Desktop | >= 1024px | Conversation sidebar (320px) + chat panel. Agent grid 3 columns. |

### Mobile Navigation Pattern

On mobile, the app uses a stack navigation model (like WhatsApp):

```
[Agent Grid] --(tap agent)--> [Conversation List] --(tap convo)--> [Chat Panel]
                 <--(back)--                          <--(back)--
```

Each navigation step replaces the full screen. The back button (`ChevronLeft` icon) in the header navigates to the previous level.

```
Mobile: Agent Grid
┌──────────────────────┐
│ Masters of AI  [cog] │
├──────────────────────┤
│ ┌──────────────────┐ │
│ │ 🏢 CRE Analyst   │ │
│ │ ...              │ │
│ └──────────────────┘ │
│ ┌──────────────────┐ │
│ │ 🔍 Researcher    │ │
│ │ ...              │ │
│ └──────────────────┘ │
└──────────────────────┘

Mobile: Conversation List
┌──────────────────────┐
│ ← CRE Analyst [+ ⊕] │
├──────────────────────┤
│ ┌──────────────────┐ │
│ │ Deal analysis    │ │
│ │ ● Cap rate is... │ │
│ │          2m ago  │ │
│ ├──────────────────┤ │
│ │ Market research  │ │
│ │ ○ The Austin...  │ │
│ │      Yesterday   │ │
│ └──────────────────┘ │
└──────────────────────┘

Mobile: Chat Panel
┌──────────────────────┐
│ ← Deal analysis   ● │
├──────────────────────┤
│                      │
│ (messages, full      │
│  width)              │
│                      │
├──────────────────────┤
│┌────────────────┐🎤➤ │
││ Message...     │    │
│└────────────────┘    │
│    safe-area-bottom  │
└──────────────────────┘
```

### Touch Interactions

- **Swipe right on chat panel** -- reveals conversation sidebar as an overlay (300ms slide animation, 75% opacity backdrop). Only on mobile. Not a gesture library -- use `touchstart`, `touchmove`, `touchend` event handlers with a 50px threshold.
- **Swipe left on conversation item** -- reveals delete button (red background, trash icon). 150px swipe threshold. Release returns to normal unless user taps delete.
- **Tap targets** -- minimum 44x44px for all interactive elements (Apple HIG guideline). Buttons, list items, send button, mic button, back arrow all meet this minimum.
- **No hover-dependent UI** -- everything accessible via hover on desktop is also accessible via tap or long-press on mobile. Specifically: tool call expand (tap), conversation delete (swipe or long-press), code copy button (always visible on mobile, not hover-only).

### Safe Area Handling

For phones with notches, home indicators, or rounded corners:
- `env(safe-area-inset-top)` on the top header
- `env(safe-area-inset-bottom)` on the input area
- Add to `index.html`: `<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">`
- CSS: `padding-bottom: max(16px, env(safe-area-inset-bottom))`

### Acceptance Criteria

- [ ] At 375px width (iPhone SE): agent grid 1 column, conversation list full-width, chat panel full-width
- [ ] At 768px width (iPad): sidebar + chat panel side-by-side, agent grid 2 columns
- [ ] At 1440px width (desktop): full layout with 320px sidebar
- [ ] Back button navigates through the stack correctly on mobile
- [ ] Swipe right on chat panel reveals sidebar overlay
- [ ] Swipe left on conversation item reveals delete
- [ ] All tap targets are at least 44x44px
- [ ] Input area respects safe area insets on notched phones
- [ ] No horizontal scroll at any viewport width
- [ ] Text does not overflow containers at any width
- [ ] Code blocks have horizontal scroll (only element allowed to scroll horizontally)

### Test Plan

1. Chrome DevTools device toolbar: test at 375px (iPhone SE), 390px (iPhone 15), 768px (iPad), 1024px, 1440px
2. Navigate agent grid -> conversation list -> chat -> back -> back on mobile viewport
3. Swipe right on chat panel (mobile) -- sidebar slides in
4. Swipe left on conversation item -- delete button reveals
5. Verify no double-scroll (page body should not scroll, only message area)
6. Test with keyboard open on mobile (input should remain visible)
7. Real device testing: iOS Safari + Android Chrome (minimum)
8. Playwright: `await page.setViewportSize({ width: 375, height: 667 }); await page.goto("/"); await expect(page.getByText("CRE Analyst")).toBeVisible();`

---

## 3.10 Voice Input

### Requirement

A microphone button in the input area for speech-to-text. Critical for the mobile-first Portuguese-speaking user. Uses the Web Speech API where available, with a fallback to server-side Whisper transcription.

### Implementation

**Primary: Web Speech API (`SpeechRecognition`)**

```typescript
interface UseVoiceInput {
  isListening: boolean;
  isSupported: boolean;
  transcript: string;         // accumulated text
  interimTranscript: string;  // in-progress text (not yet finalized)
  error: string | null;
  startListening: () => void;
  stopListening: () => void;
}
```

- Check `window.SpeechRecognition || window.webkitSpeechRecognition` for support
- Set language to current locale: `recognition.lang = "pt-BR"` or `"en-US"`
- `recognition.continuous = true` (keep listening until stopped)
- `recognition.interimResults = true` (show partial results)
- On `onresult`: accumulate `transcript`, update `interimTranscript`
- On `onspeechend` or manual stop: insert final transcript into input area
- Auto-send option: detect 2 seconds of silence, then auto-send. Configurable in settings.

**Fallback: Server-side Whisper**

If `SpeechRecognition` is not available (Firefox on Android, some WebViews):
- Record audio via `MediaRecorder` API (always available)
- On stop, POST audio blob to `POST /api/transcribe` (backend calls Whisper API)
- Display "Transcribing..." while waiting for response
- Insert transcribed text into input area

### UI

**Mic button:** Right side of input area, left of send button.
- Default state: `Mic` icon (lucide-react), ghost button
- Listening state: `Mic` icon in red with pulsing ring animation. Input area border changes to red to indicate recording.
- Below the input (or overlaid): waveform visualization during recording. Use `AnalyserNode` from Web Audio API to get frequency data, render as a simple bar visualization (8-12 bars, animating heights). CSS only, no canvas needed -- use `div` elements with dynamic `height` via `requestAnimationFrame`.

```
Default:
┌─────────────────────────────┐ [🎤] [➤]
│ Type a message...            │
└─────────────────────────────┘

Listening (Web Speech API):
┌─────────────────────────────┐ [🎤] [■]
│ How is the cap rate in...    │  (red)
│ (interim: Austin compared )  │
└─────────────────────────────┘
 ▃ █ ▅ █ ▃ ▂ █ ▅  (waveform)

Listening (fallback, recording):
┌─────────────────────────────┐ [🎤] [■]
│ Recording...                 │  (red)
└─────────────────────────────┘
 ▃ █ ▅ █ ▃ ▂ █ ▅  (waveform)

Transcribing (fallback):
┌─────────────────────────────┐ [🎤] [➤]
│ Transcribing... ⟳            │
└─────────────────────────────┘
```

### Acceptance Criteria

- [ ] Mic button visible in input area on all viewports
- [ ] Tapping mic starts listening (Web Speech API) or recording (fallback)
- [ ] Visual feedback: red mic icon, pulsing ring, waveform bars animating
- [ ] Interim transcript appears in the input area in real time (Web Speech API)
- [ ] Stopping recording inserts final transcript into input area
- [ ] Language matches current locale setting (pt-BR or en-US)
- [ ] Auto-send on 2-second silence (when enabled) sends the transcribed text
- [ ] Fallback recording: audio sent to backend, transcription result inserted into input
- [ ] Mic button disabled during streaming (agent is responding)
- [ ] Permission request handled gracefully: if user denies mic, show message and hide mic button for session
- [ ] Works on iOS Safari (webkitSpeechRecognition) and Android Chrome (SpeechRecognition)

### Test Plan

1. Chrome desktop: click mic, speak, verify transcript appears in input
2. Chrome mobile (Android): tap mic, speak in Portuguese, verify pt-BR transcript
3. Safari mobile (iOS): tap mic, speak, verify webkitSpeechRecognition works
4. Firefox (no SpeechRecognition): tap mic, speak, verify fallback recording works
5. Deny microphone permission -- error message appears, mic button hidden
6. Speak then pause 2 seconds with auto-send enabled -- message sends automatically
7. Tap mic while agent is streaming -- mic button should be disabled
8. Accessibility: mic button has `aria-label="Start voice input"` / `"Iniciar entrada por voz"`, listening state has `aria-live` announcement

---

## 3.11 i18n (Portuguese)

### Requirement

All UI chrome (buttons, labels, error messages, status text, empty states, placeholders) is translated into Brazilian Portuguese (pt-BR). Agent content (names, descriptions, starters) comes from IDENTITY.md and is already in the desired language -- the frontend does not translate it.

### Setup

**Library:** react-i18next + i18next

**Configuration (`src/lib/i18n.ts`):**
```typescript
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import en from "../locales/en.json";
import ptBR from "../locales/pt-BR.json";

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      "pt-BR": { translation: ptBR },
    },
    fallbackLng: "en",
    detection: {
      order: ["localStorage", "navigator"],
      lookupLocalStorage: "mastersof-ai-lang",
    },
    interpolation: { escapeValue: false },
  });
```

**Detection order:**
1. `localStorage.getItem("mastersof-ai-lang")` -- user's explicit choice
2. `navigator.language` -- browser/OS language
3. Fallback: `en`

**Language selector:** In the header area (top-right, near theme toggle). Simple dropdown or toggle button between "EN" and "PT". Changing language updates `localStorage` and re-renders all translated strings immediately (no reload needed).

### Translation File Structure

```json
// en.json
{
  "app": {
    "title": "Masters of AI"
  },
  "auth": {
    "tokenPlaceholder": "Enter your access token",
    "continue": "Continue",
    "invalidToken": "Invalid token. Please check and try again.",
    "validating": "Validating..."
  },
  "agents": {
    "chooseAgent": "Choose an agent",
    "noAgents": "No agents available. Contact your administrator.",
    "loading": "Loading agents..."
  },
  "conversations": {
    "newChat": "New chat",
    "noConversations": "No conversations yet. Start one!",
    "deleteTitle": "Delete conversation?",
    "deleteDescription": "This action cannot be undone.",
    "deleteConfirm": "Delete",
    "deleteCancel": "Cancel",
    "timeJustNow": "Just now",
    "loading": "Loading conversations..."
  },
  "chat": {
    "placeholder": "Type a message...",
    "send": "Send",
    "stop": "Stop",
    "scrollToBottom": "Scroll to bottom",
    "emptyState": "Start a conversation with {{agentName}}",
    "starters": "Suggested prompts",
    "copyCode": "Copy code",
    "codeCopied": "Copied!",
    "showMore": "Show more",
    "showLess": "Show less"
  },
  "toolCalls": {
    "executing": "Running...",
    "complete": "Complete",
    "error": "Error",
    "approve": "Allow",
    "deny": "Deny",
    "readFile": "Reading: {{path}}",
    "writeFile": "Writing: {{path}}",
    "editFile": "Editing: {{path}}",
    "bash": "Running: {{command}}",
    "search": "Searching: {{query}}",
    "fetch": "Fetching: {{url}}"
  },
  "connection": {
    "connected": "Connected",
    "connecting": "Connecting...",
    "reconnecting": "Reconnecting...",
    "disconnected": "Disconnected"
  },
  "errors": {
    "rateLimited": "Too many requests. Please wait {{seconds}} seconds.",
    "serverDown": "Server unavailable. Reconnecting...",
    "sessionExpired": "Session expired. Starting a new conversation.",
    "authFailed": "Authentication failed. Please sign in again.",
    "modelError": "An error occurred. Please try again.",
    "retry": "Retry",
    "networkError": "Network error. Check your connection."
  },
  "voice": {
    "startListening": "Start voice input",
    "stopListening": "Stop voice input",
    "transcribing": "Transcribing...",
    "micDenied": "Microphone access denied.",
    "notSupported": "Voice input is not supported in this browser."
  },
  "theme": {
    "dark": "Dark mode",
    "light": "Light mode",
    "system": "System theme"
  },
  "common": {
    "back": "Back",
    "close": "Close",
    "loading": "Loading...",
    "error": "Error",
    "success": "Success"
  }
}
```

```json
// pt-BR.json
{
  "app": {
    "title": "Masters of AI"
  },
  "auth": {
    "tokenPlaceholder": "Insira seu token de acesso",
    "continue": "Continuar",
    "invalidToken": "Token inv\u00e1lido. Verifique e tente novamente.",
    "validating": "Validando..."
  },
  "agents": {
    "chooseAgent": "Escolha um agente",
    "noAgents": "Nenhum agente dispon\u00edvel. Entre em contato com o administrador.",
    "loading": "Carregando agentes..."
  },
  "conversations": {
    "newChat": "Nova conversa",
    "noConversations": "Nenhuma conversa ainda. Comece uma!",
    "deleteTitle": "Excluir conversa?",
    "deleteDescription": "Esta a\u00e7\u00e3o n\u00e3o pode ser desfeita.",
    "deleteConfirm": "Excluir",
    "deleteCancel": "Cancelar",
    "timeJustNow": "Agora mesmo",
    "loading": "Carregando conversas..."
  },
  "chat": {
    "placeholder": "Digite uma mensagem...",
    "send": "Enviar",
    "stop": "Parar",
    "scrollToBottom": "Ir para o final",
    "emptyState": "Inicie uma conversa com {{agentName}}",
    "starters": "Sugest\u00f5es",
    "copyCode": "Copiar c\u00f3digo",
    "codeCopied": "Copiado!",
    "showMore": "Ver mais",
    "showLess": "Ver menos"
  },
  "toolCalls": {
    "executing": "Executando...",
    "complete": "Conclu\u00eddo",
    "error": "Erro",
    "approve": "Permitir",
    "deny": "Negar",
    "readFile": "Lendo: {{path}}",
    "writeFile": "Escrevendo: {{path}}",
    "editFile": "Editando: {{path}}",
    "bash": "Executando: {{command}}",
    "search": "Pesquisando: {{query}}",
    "fetch": "Buscando: {{url}}"
  },
  "connection": {
    "connected": "Conectado",
    "connecting": "Conectando...",
    "reconnecting": "Reconectando...",
    "disconnected": "Desconectado"
  },
  "errors": {
    "rateLimited": "Muitas solicita\u00e7\u00f5es. Aguarde {{seconds}} segundos.",
    "serverDown": "Servidor indispon\u00edvel. Reconectando...",
    "sessionExpired": "Sess\u00e3o expirada. Iniciando nova conversa.",
    "authFailed": "Falha na autentica\u00e7\u00e3o. Fa\u00e7a login novamente.",
    "modelError": "Ocorreu um erro. Tente novamente.",
    "retry": "Tentar novamente",
    "networkError": "Erro de rede. Verifique sua conex\u00e3o."
  },
  "voice": {
    "startListening": "Iniciar entrada por voz",
    "stopListening": "Parar entrada por voz",
    "transcribing": "Transcrevendo...",
    "micDenied": "Acesso ao microfone negado.",
    "notSupported": "Entrada por voz n\u00e3o suportada neste navegador."
  },
  "theme": {
    "dark": "Modo escuro",
    "light": "Modo claro",
    "system": "Tema do sistema"
  },
  "common": {
    "back": "Voltar",
    "close": "Fechar",
    "loading": "Carregando...",
    "error": "Erro",
    "success": "Sucesso"
  }
}
```

### Usage in Components

```typescript
import { useTranslation } from "react-i18next";

function ChatInput() {
  const { t } = useTranslation();
  return <textarea placeholder={t("chat.placeholder")} />;
}
```

### What Is NOT Translated

- Agent names, descriptions, starters (from IDENTITY.md -- author controls language)
- Agent-generated content (assistant messages, tool outputs)
- Code in code blocks
- Error messages from the model (passed through as-is)

### Acceptance Criteria

- [ ] App detects browser language on first load (pt-BR browser shows Portuguese)
- [ ] Language toggle switches all UI chrome instantly without page reload
- [ ] All visible UI text (buttons, labels, placeholders, errors, empty states) has translations
- [ ] Interpolated strings work correctly: `{{agentName}}`, `{{seconds}}`, `{{path}}`
- [ ] No hardcoded English strings in components (all use `t()`)
- [ ] Agent content (names, descriptions, starters, messages) is NOT run through translation
- [ ] Language preference persists in localStorage across sessions
- [ ] Relative times respect locale: "2 min ago" (en) vs "h\u00e1 2 min" (pt-BR)
- [ ] Date/time formatting respects locale via `Intl.DateTimeFormat`

### Test Plan

1. Set browser to pt-BR, open app -- all UI chrome in Portuguese
2. Set browser to en-US, open app -- all UI chrome in English
3. Toggle language to Portuguese -- all text switches immediately
4. Navigate through all screens: auth, agent grid, conversation list, chat, empty states, errors -- verify every string is translated
5. Trigger error states (invalid token, server down, rate limit) -- error messages in correct language
6. Check tool call summaries during agent interaction -- tool chrome translated, tool content not translated
7. Grep codebase for hardcoded English strings in JSX -- none found outside of test files

---

## 3.12 Reconnection

### Requirement

Mobile users on cellular connections will experience frequent disconnections. The app must handle WebSocket drops gracefully with no message loss.

### Implementation

**Reconnection strategy (react-use-websocket configuration):**

```typescript
useWebSocket(wsUrl, {
  shouldReconnect: () => true,
  reconnectAttempts: Infinity,     // never give up
  reconnectInterval: (attemptNumber) =>
    Math.min(1000 * Math.pow(2, attemptNumber), 30000), // 1s, 2s, 4s, 8s, 16s, 30s cap
  heartbeat: {
    message: JSON.stringify({ type: "ping" }),
    returnMessage: JSON.stringify({ type: "pong" }),
    timeout: 60000,    // 60s without pong = connection dead
    interval: 25000,   // ping every 25s (under typical 30s proxy timeout)
  },
});
```

**On reconnect flow:**
1. WebSocket reconnects (react-use-websocket handles this automatically)
2. Client sends `{ type: "subscribe", agentId, sessionId, lastMessageId }` where `lastMessageId` is the ID of the last message in the local messages array
3. Server compares `lastMessageId` against its message buffer (Phase 2, task 2.4)
4. Server replays any messages sent after `lastMessageId`
5. Client merges replayed messages into local state (deduplicate by message ID)

**Message queue:** While disconnected, if the user types and sends a message:
- Store the message in a local queue (Zustand `chat` store, `pendingMessages` array)
- Show the message in the UI with a "pending" indicator (clock icon instead of check)
- On reconnect, after subscription and replay, send all queued messages in order
- Replace "pending" indicator with normal state once the server acknowledges

### Visual Indicators

**Reconnecting banner:** A full-width bar at the top of the chat panel (below the header).

```
Connected (hidden):
(no banner)

Reconnecting:
┌─────────────────────────────────────┐
│ ⟳ Reconnecting... Attempt 3        │  <- yellow/amber background
├─────────────────────────────────────┤
│                                     │
│ (chat messages)                     │

Disconnected (after max display time):
┌─────────────────────────────────────┐
│ ✗ Disconnected. Check connection.   │  <- red background
├─────────────────────────────────────┤
│                                     │
│ (chat messages)                     │
```

**Connection status in header:**
- `connected`: green dot, text "Connected" / "Conectado"
- `connecting`: yellow dot with animation, text "Connecting..." / "Conectando..."
- `reconnecting`: yellow dot with animation, text "Reconnecting..." / "Reconectando..."
- `disconnected`: red dot, text "Disconnected" / "Desconectado"

### Acceptance Criteria

- [ ] WebSocket auto-reconnects with exponential backoff (1s, 2s, 4s, ... 30s cap)
- [ ] Reconnection banner appears within 2 seconds of disconnect
- [ ] Reconnection banner shows attempt count
- [ ] On reconnect, client sends `lastMessageId` for replay
- [ ] Replayed messages appear without duplicates
- [ ] Messages sent while disconnected are queued and sent on reconnect
- [ ] Queued messages show "pending" indicator in the UI
- [ ] Heartbeat pings every 25 seconds keep the connection alive
- [ ] If heartbeat fails (no pong in 60s), reconnection triggers
- [ ] Banner transitions: hidden -> reconnecting (yellow) -> connected (hidden) OR disconnected (red)
- [ ] Never stops trying to reconnect (reconnectAttempts: Infinity)

### Test Plan

1. Open chat, send a message, kill backend -- reconnecting banner appears
2. Restart backend -- banner disappears, connection indicator turns green
3. Kill backend, type a message, send -- message appears with pending indicator
4. Restart backend -- pending message sends, indicator changes to normal
5. Kill backend for 30+ seconds -- reconnection attempts escalate (visible in banner: "Attempt 1", "Attempt 2", etc.)
6. Chrome DevTools Network tab: simulate offline -- banner appears, simulate online -- reconnection starts
7. Verify no duplicate messages after reconnection
8. Verify heartbeat pings in WebSocket frames (DevTools -> Network -> WS -> Messages)

---

## 3.13 Error States

### Requirement

Every error the user can encounter has a specific, actionable UI state. Errors are displayed in the user's language with clear recovery instructions.

### Error Catalog

| Error | Trigger | UI Treatment | Recovery |
|-------|---------|-------------|----------|
| **Rate limited** | 429 from backend | Toast notification with countdown timer: "Too many requests. Please wait 30 seconds." | Auto-dismiss when countdown reaches 0. Input disabled during countdown. |
| **Server down** | WebSocket disconnect + REST 503 | Reconnecting banner (see 3.12). If > 60 seconds, show "Server unavailable" with manual retry button. | Automatic reconnection. Manual retry button calls `refetch()`. |
| **Session expired** | Backend returns `session_expired` error on WebSocket | Toast: "Session expired. Starting new conversation." Auto-create new session. | Automatic. Old messages remain visible (read-only). New session starts. |
| **Auth failed** | 401/403 from any API call | Clear token from localStorage. Redirect to auth screen. Toast: "Authentication failed." | User re-enters token. |
| **Model error** | Backend returns `model_error` on WebSocket | Inline error message in chat (like an assistant message, but with red border). "An error occurred. Please try again." with a retry button. | Retry button re-sends the last user message. |
| **Network error** | `fetch` throws, WebSocket `onerror` | If REST: inline error in the component that failed (agent grid, conversation list). If WS: reconnecting banner. | Retry button on inline errors. Auto-reconnect for WS. |
| **Transcription error** | Whisper API fails | Toast: "Transcription failed. Please type your message." | User types instead of speaking. |

### Toast Component

Use shadcn/ui `Toast` (via `sonner` library that shadcn recommends):
- Position: top-center on mobile, top-right on desktop
- Auto-dismiss after 5 seconds (except rate limit, which shows countdown)
- Variants: default (info), destructive (error), success
- Action button support (e.g., "Retry")

### Inline Error Component

For errors that appear within a data-fetching component (agent grid, conversation list):

```typescript
interface InlineErrorProps {
  message: string;
  onRetry?: () => void;
}
```

Renders as:
```
┌─────────────────────────────────┐
│ ⚠ Error loading agents.         │
│   Check your connection.         │
│                                 │
│   [Retry]                       │
└─────────────────────────────────┘
```

Uses shadcn/ui `Alert` with `AlertTitle` and `AlertDescription`, destructive variant.

### Chat Error Message

Model errors appear as a special message in the chat flow:

```
┌────────────────────────────────────┐
│ ⚠ An error occurred while          │  <- red left border
│   generating a response.           │
│                                    │
│   Rate limit exceeded. The model   │
│   is temporarily unavailable.      │
│                                    │
│   [Retry]                          │
└────────────────────────────────────┘
```

Styled like an assistant message but with `border-l-4 border-red-500` and `bg-red-950/20`.

### Acceptance Criteria

- [ ] Rate limit: countdown timer displays and counts down, input disabled, auto-recovers
- [ ] Server down: reconnecting banner after 2s, "Server unavailable" after 60s with retry
- [ ] Session expired: toast appears, new session created automatically, old messages visible
- [ ] Auth failed: redirects to auth screen, token cleared
- [ ] Model error: inline chat error with retry button, retry re-sends last message
- [ ] Network error: inline error in affected component with retry
- [ ] All error messages are translated (en + pt-BR)
- [ ] Toast notifications stack correctly (max 3 visible)
- [ ] Error states do not break the layout or leave the app in an unusable state
- [ ] After any error recovery, the app returns to a fully functional state

### Test Plan

1. Configure backend to return 429 -- rate limit toast appears with countdown
2. Kill backend -- reconnecting banner, then "Server unavailable" after 60s
3. Invalidate token in access.yaml while connected -- auth failed redirect
4. Trigger model error (e.g., context too long) -- inline chat error with retry button
5. Click retry on model error -- last message re-sent, response streams
6. Disconnect network (airplane mode on mobile) -- network error handling activates
7. Reconnect network -- auto-recovery
8. Switch language during error state -- error messages update to correct language
9. Trigger multiple errors simultaneously -- toasts stack, inline errors show in correct components

---

## 3.14 Cloudflare Pages Setup

### Requirement

Deploy the built SPA to Cloudflare Pages. The SPA is a static site -- no server-side rendering, no edge functions needed for the frontend itself.

### `wrangler.toml` (complete)

```toml
name = "mastersof-ai-web"
compatibility_date = "2026-03-01"
pages_build_output_dir = "dist"

# SPA routing: all paths serve index.html
# Handled by _redirects file (Cloudflare Pages convention)
```

### `public/_redirects`

Cloudflare Pages uses a `_redirects` file for SPA routing (all paths to `index.html`):

```
/* /index.html 200
```

### `public/_headers`

Security headers:

```
/*
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: microphone=(self), camera=()
  Content-Security-Policy: default-src 'self'; connect-src 'self' wss://*.mastersof.ai https://*.mastersof.ai; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; media-src 'self' blob:
```

### Build Configuration

Cloudflare Pages build settings (configured in dashboard or `wrangler.toml`):
- Build command: `npm run build`
- Build output directory: `dist`
- Root directory: `web` (if using monorepo auto-detection)
- Node version: 22 (set via `.node-version` file or environment variable)

### Environment Variables

Set in Cloudflare Pages dashboard (not committed):
- `VITE_API_URL` -- backend REST URL (e.g., `https://api.mastersof.ai`)
- `VITE_WS_URL` -- backend WebSocket URL (e.g., `wss://api.mastersof.ai/ws`)
- `VITE_SKIP_AUTH` -- `"true"` if Cloudflare Access handles auth (optional)

These are embedded at build time by Vite (the `VITE_` prefix makes them available via `import.meta.env.VITE_API_URL`).

### Acceptance Criteria

- [ ] `wrangler pages deploy dist` succeeds from the `web/` directory
- [ ] SPA routing works: navigating directly to `/agent/cre-analyst` loads the app (not 404)
- [ ] Security headers are present on all responses
- [ ] CSP allows WebSocket connections to the backend domain
- [ ] CSP allows microphone access (for voice input)
- [ ] Environment variables are embedded correctly in the built JS
- [ ] Build produces <1MB total assets (gzipped)

### Test Plan

1. Run `npm run build` in `web/`, verify `dist/` contains `index.html`, JS bundle, CSS
2. Run `npx wrangler pages dev dist` -- local preview works, SPA routing works
3. Deploy to Cloudflare Pages staging -- site loads at the Pages URL
4. Navigate directly to `/agent/test` -- app loads (SPA routing, not 404)
5. Check response headers with `curl -I` -- security headers present
6. Verify WebSocket connection succeeds through CSP (not blocked)

---

## 3.15 Custom Domain

### Requirement

The SPA serves on a custom domain like `agents.mastersof.ai` or `app.mastersof.ai`.

### Setup Steps

1. In Cloudflare Pages dashboard: Custom Domains -> Add domain
2. Add CNAME record: `agents.mastersof.ai` -> `mastersof-ai-web.pages.dev`
3. Cloudflare auto-provisions SSL certificate
4. Update `VITE_API_URL` and `VITE_WS_URL` environment variables to use the backend domain (e.g., `api.mastersof.ai`)
5. Ensure CORS on the backend allows the custom domain origin

### Acceptance Criteria

- [ ] `https://agents.mastersof.ai` loads the SPA
- [ ] SSL certificate is valid (auto-provisioned by Cloudflare)
- [ ] HTTP redirects to HTTPS
- [ ] API requests from the custom domain succeed (CORS configured)
- [ ] WebSocket connections from the custom domain succeed

### Test Plan

1. Navigate to `https://agents.mastersof.ai` -- app loads
2. Check SSL with `curl -vI https://agents.mastersof.ai` -- valid certificate
3. Check CORS: browser console shows no CORS errors on API requests
4. WebSocket connects successfully (check DevTools Network tab)

---

## 3.16 Cloudflare Tunnel (Backend Connectivity)

### Requirement

The backend runs on a VPS (Fly.io, Railway, or Hetzner) and needs to be reachable from the Cloudflare Pages frontend without opening ports directly. Cloudflare Tunnel provides a secure connection from the backend to Cloudflare's network.

### Setup

1. Install `cloudflared` on the backend server
2. Create tunnel: `cloudflared tunnel create mastersof-ai-api`
3. Configure tunnel (`~/.cloudflared/config.yml`):

```yaml
tunnel: mastersof-ai-api
credentials-file: /home/deploy/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: api.mastersof.ai
    service: http://localhost:3000
  - service: http_status:404
```

4. Add DNS: CNAME `api.mastersof.ai` -> `<tunnel-id>.cfargotunnel.com`
5. Start tunnel as a systemd service: `cloudflared service install`

### WebSocket Support

Cloudflare Tunnel natively supports WebSocket connections. The frontend connects to `wss://api.mastersof.ai/ws` and Cloudflare proxies it through the tunnel to the backend's `ws://localhost:3000/ws`.

Ensure the Cloudflare Tunnel configuration does not set a timeout shorter than the WebSocket heartbeat interval (25 seconds). Default Cloudflare proxy timeout is 100 seconds for WebSocket, which is sufficient.

### Acceptance Criteria

- [ ] Backend is reachable at `https://api.mastersof.ai` via Cloudflare Tunnel (no direct port exposure)
- [ ] REST endpoints work through the tunnel
- [ ] WebSocket connections work through the tunnel (including sustained streaming)
- [ ] Tunnel auto-reconnects if the backend restarts
- [ ] Tunnel runs as a systemd service (starts on boot)
- [ ] `GET /health` returns 200 through the tunnel

### Test Plan

1. `curl https://api.mastersof.ai/health` -- returns 200
2. `wscat -c wss://api.mastersof.ai/ws` -- WebSocket connects
3. From the frontend, send a message -- streaming response works end-to-end
4. Restart backend process -- tunnel reconnects, subsequent requests succeed
5. Verify no ports are open on the backend server except SSH (port scan)

---

## Dependency Graph

```
3.1 Scaffold
 ├── 3.2 Auth Screen
 ├── 3.3 Agent Card Grid
 │    └── 3.4 Conversation Sidebar
 │         └── 3.5 Chat Panel
 │              ├── 3.6 Tool Call Display
 │              ├── 3.7 @mention Agent Switching
 │              └── 3.10 Voice Input
 ├── 3.8 Dark Mode (can parallel with 3.2-3.5)
 ├── 3.9 Mobile Responsive (applied incrementally to each component)
 ├── 3.11 i18n (applied incrementally to each component)
 ├── 3.12 Reconnection (after 3.5)
 └── 3.13 Error States (after 3.5)

3.14 Cloudflare Pages (after 3.1, can parallel with 3.2+)
 └── 3.15 Custom Domain (after 3.14)
     └── 3.16 Cloudflare Tunnel (after 3.15, depends on Phase 2 backend)
```

**Critical path:** 3.1 -> 3.3 -> 3.4 -> 3.5 -> 3.6 (core conversational flow).

**Parallelizable:** 3.8 (dark mode), 3.11 (i18n), and 3.14 (deploy setup) can start as soon as 3.1 is done. 3.9 (responsive) is applied to each component as it's built. 3.2 (auth) can be built in parallel with 3.3 and wired in later.

---

## Component Library Decision: assistant-ui vs prompt-kit

This decision should be made during 3.1 (scaffold) after a spike.

### Evaluate assistant-ui first

assistant-ui provides composable primitives (`Thread`, `ThreadMessages`, `Composer`, `ToolFallback`, etc.) with built-in streaming, tool call rendering, and accessibility. It requires implementing a custom `RuntimeProvider` to bridge our WebSocket protocol.

**Spike task:** Implement a minimal `RuntimeProvider` that:
1. Connects to our WS endpoint
2. Sends messages via `{ type: "message", content }`
3. Receives `token` events and feeds them to assistant-ui's streaming
4. Renders tool calls via `ToolFallback`

If the RuntimeProvider abstraction maps cleanly to our protocol, use assistant-ui.

### Fall back to prompt-kit if:
- RuntimeProvider requires adapting to Vercel AI SDK's `useChat` interface internally
- Streaming protocol assumptions conflict with our token-by-token WS events
- Tool call rendering is too opinionated to customize for our tool approval flow

### With prompt-kit:
- Use `PromptInput` for the chat input
- Use `Message` for message bubbles
- Use `CodeBlock` for syntax highlighting
- Build streaming, tool calls, and WebSocket integration ourselves (using the `useAgentChat` hook)

Either way, the components in `src/components/chat/` wrap the library primitives so the rest of the app is decoupled from the choice.
