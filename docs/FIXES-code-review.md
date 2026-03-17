# Code Review Fixes — Requirements & Verification

17 issues from code review, grouped by execution agent to avoid file conflicts.

---

## Agent 1: Backend Security & Error Handling (serve.ts)

### FIX-01: CORS origin validation (CRITICAL)

**Problem:** `origin: true` allows any website to make authenticated API requests.

**Requirement:** Replace `origin: true` with a configurable allowlist. In dev, allow `localhost:*`. Read allowed origins from `ALLOWED_ORIGINS` env var (comma-separated) or default to localhost.

**File:** `src/serve.ts` — `startServer()` → fastifyCors registration

**Implementation:**
- Replace `origin: true` with a callback that checks against allowed origins
- Allow `null` origin (same-origin requests, curl)
- In dev (no env var), allow any localhost port

**Verification:**
```bash
# Should succeed (same origin / no origin)
curl -s -H "Origin: http://localhost:5173" -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/agents
# Should be rejected
curl -s -H "Origin: https://evil.com" -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/agents
# Response should NOT have Access-Control-Allow-Origin: https://evil.com
```

---

### FIX-02: Unhandled async error in WS message handler (CRITICAL)

**Problem:** If `handleMessage()` or `handleSubscribe()` throws, the promise rejection is unhandled, crashing the connection silently with no error sent to client.

**Requirement:** Wrap the entire `switch` block in `ws.on("message")` with try-catch. On error, send a classified error frame to the client. If `ws.send()` itself fails (connection already closed), catch that too.

**File:** `src/serve.ts` — `registerWebSocketRoute()` → `ws.on("message")`

**Verification:**
- Kill the SDK mid-request (simulate crash) → client should receive `{"type":"error","code":"...","message":"..."}` instead of silent disconnect
- Test with: start a conversation, then stop the backend process mid-stream — the WS should close cleanly

---

### FIX-03: Message persistence race condition (CRITICAL)

**Problem:** For new conversations, `persistUserMessage()` depends on having a confirmed session ID from the SDK init event. If the connection drops between `status: thinking` and `init`, the user message is never persisted.

**Requirement:** Buffer the user message content at the start of `handleMessage()`. Persist it as soon as the session ID is confirmed (init event). If `handleMessage()` exits without persisting (error path), log a warning. Also reset `userMessagePersisted` when retrying without resume.

**File:** `src/serve.ts` — `handleMessage()`

**Implementation:**
- In the retry block (line ~346-350), reset `userMessagePersisted = false`
- In the catch block (line ~503-512), if `!userMessagePersisted && conversation.sessionId`, persist the user message before sending the error frame

**Verification:**
- Send a message to an agent, verify the JSONL file contains both user and assistant messages
- Send a message with an invalid resume ID → retry happens → verify user message is still persisted
- Verify: `cat ~/.mastersof-ai/state/*/sessions/*/messages.jsonl | python3 -c "import sys; [print(l.strip()[:80]) for l in sys.stdin]"`

---

### FIX-04: Memory leak — orphaned message buffers (HIGH)

**Problem:** When a session transitions from "new" to a real SDK session ID, the old buffer entry (keyed by the temp session ID or "new") is never deleted from `conversationBuffers`.

**Requirement:** When the SDK init event assigns a real session ID, delete the old buffer entry if one existed under a different key.

**File:** `src/serve.ts` — `handleMessage()` → SDK init event handler

**Verification:**
- Start 10 new conversations, check `conversationBuffers.size` stays bounded
- After the fix, old temp-keyed entries should not accumulate

---

## Agent 2: Frontend Security (MessageBubble, TokenEntry, api.ts)

### FIX-05: XSS via unsanitized markdown (HIGH)

**Problem:** `react-markdown` with `rehype-highlight` may allow raw HTML through. An agent response containing `<script>` or `<img onerror=...>` could execute arbitrary JS.

**Requirement:** Add `rehype-sanitize` to the rehype plugin chain, OR configure react-markdown with `skipHtml: true` to disable raw HTML entirely. `skipHtml` is simpler and sufficient since agent responses shouldn't contain raw HTML.

**File:** `web/src/components/chat/MessageBubble.tsx` — `<Markdown>` component

**Verification:**
- Send a message that triggers a response containing `<img src=x onerror=alert(1)>` — should render as text, not execute
- Send markdown with `<script>alert('xss')</script>` — should render as text
- Normal markdown (headings, code blocks, links, tables) should still render correctly

---

### FIX-07: Missing error boundary for markdown (HIGH)

**Problem:** If markdown parsing throws (malformed syntax, plugin crash), the entire chat UI crashes with a React error boundary.

**Requirement:** Wrap the `<Markdown>` component in a try-catch. On error, fall back to rendering the raw content in a `<pre>` tag.

**File:** `web/src/components/chat/MessageBubble.tsx`

**Implementation:** Use a React error boundary component wrapping the Markdown renderer, with a fallback that shows raw text.

**Verification:**
- Render a message with extremely malformed content (e.g., deeply nested unclosed tags) — should show raw text, not crash
- Normal markdown should render correctly

---

### FIX-10: Missing fetch timeout in API client (MEDIUM)

**Problem:** `fetch()` calls have no timeout. A hung backend will leave the frontend spinner going forever.

**Requirement:** Add a 30-second AbortController timeout to all fetch requests. On timeout, throw a descriptive error.

**File:** `web/src/lib/api.ts` — `request()` function

**Verification:**
- Configure a backend that delays response > 30s → client should show error after 30s, not hang indefinitely
- Normal requests (<30s) should work as before

---

### FIX-17: Error key validation in TokenEntry (LOW)

**Problem:** The error string from the store is used directly as an i18n key (`t(\`auth.${error}\`)`). If the error comes from an unexpected source, it could access arbitrary translation keys.

**Requirement:** Whitelist valid error keys. Default to a generic error if the key isn't in the whitelist.

**File:** `web/src/components/auth/TokenEntry.tsx` + `web/src/stores/auth.ts`

**Verification:**
- Set an invalid error value in the store → should display generic error, not crash or show raw key
- Valid errors ("invalidToken") should display correctly in both en and pt-BR

---

## Agent 3: Frontend State Management (useAgentChat, chat.ts, ui.ts)

### FIX-06: Race condition in session ID update (HIGH)

**Problem:** When `result` arrives with a session ID, `agentIdRef.current` may have changed if the user switched agents during streaming. The cache key migration would use the wrong agent ID.

**Requirement:** Guard the `updateActiveKey` call — only migrate if the agent hasn't changed since the message was sent.

**File:** `web/src/hooks/useAgentChat.ts` — `case "result"` handler

**Implementation:** Capture `agentIdRef.current` at the time of sending the message (in `sendMessage`), compare it when `result` arrives.

**Verification:**
- Start a conversation with Ember, immediately switch to Analyst before response arrives → Analyst's chat should not show Ember's response
- Start a conversation with Ember, wait for response → session ID correctly assigned to Ember

---

### FIX-09: Stale closure in sendSubscribe (MEDIUM)

**Problem:** `sendSubscribe` has `store.lastMessageId` in its dependency array, causing it to be recreated on every message, which is inefficient and can cause cascading re-renders.

**Requirement:** Pass `lastMessageId` as a parameter to `sendSubscribe` instead of capturing it from the store in the closure.

**File:** `web/src/hooks/useAgentChat.ts`

**Verification:**
- Conversations still work (subscribe, send, receive)
- No observable behavior change — this is a performance/correctness fix

---

### FIX-11: get() inside set() in Zustand store (MEDIUM)

**Problem:** `finalizeAssistantMessage` calls `get().activeKey` inside `set()` callback, which can return stale state if the store is updated concurrently.

**Requirement:** Use `s.activeKey` (from the state parameter) instead of `get().activeKey`.

**File:** `web/src/stores/chat.ts` — `finalizeAssistantMessage`

**Verification:**
- Multi-turn conversations still work with tool calls
- Messages are correctly cached under the right key

---

### FIX-12: localStorage SecurityError in private browsing (MEDIUM)

**Problem:** Safari private mode and some corporate browsers throw `SecurityError` when accessing localStorage. The theme store initialization crashes.

**Requirement:** Wrap all `localStorage.getItem()` and `setItem()` calls in try-catch. Fall back to defaults on error.

**File:** `web/src/stores/ui.ts` (theme), `web/src/stores/auth.ts` (token), `web/src/components/layout/AppShell.tsx` (lang)

**Verification:**
- App loads without crashing in Safari Private Browsing mode
- Theme defaults to dark when localStorage is unavailable
- Auth falls back gracefully (shows token entry)

---

### FIX-14: Inefficient ref sync pattern (LOW)

**Problem:** `agentIdRef.current = agentId` on every render is unnecessary — should update via useEffect.

**Requirement:** Move ref assignments into useEffect hooks that depend on the respective values.

**File:** `web/src/hooks/useAgentChat.ts`

**Verification:**
- Agent switching, reconnection, and session resume all still work
- No behavior change — this is a correctness/clarity fix

---

## Agent 4: Token Security & API Hardening

### FIX-08: Token in localStorage (MEDIUM)

**Problem:** Tokens in localStorage are accessible to any JS on the page, including XSS payloads.

**Requirement:** Move token storage from localStorage to sessionStorage. Tokens will be lost on tab close (acceptable trade-off for security). Update all reads/writes: auth store, api.ts, useAgentChat.ts, constants.ts.

**Note:** This is a deliberate trade-off. Full httpOnly cookie auth would be better but requires backend changes. sessionStorage is the quick win.

**File:** `web/src/stores/auth.ts`, `web/src/lib/api.ts`, `web/src/hooks/useAgentChat.ts`

**Verification:**
- Enter token → works for the session
- Open new tab → token not shared (expected with sessionStorage)
- Close tab, reopen → token is gone, must re-enter (expected)
- XSS payload `document.cookie` and `localStorage.getItem("mastersof-ai-token")` should both return nothing useful

---

### FIX-13: API response validation (LOW)

**Problem:** `res.json()` is called without validating the response shape. Malformed JSON or unexpected structures propagate as cryptic errors.

**Requirement:** Wrap the final `res.json()` call in try-catch with a descriptive error message.

**File:** `web/src/lib/api.ts`

**Verification:**
- Backend returning invalid JSON → client shows "Invalid response" error, not a cryptic parse error
- Normal responses still work

---

## Agent 5: Component Quality (AgentGrid, ChatPanel, MessageBubble)

### FIX-15: Named vs default export inconsistency (LOW)

**Problem:** `App.tsx` uses `lazy(() => import(...).then(m => ({ default: m.AgentGrid })))` because components use named exports. This is fragile.

**Requirement:** No change needed — the current pattern works correctly. Document it with a comment in App.tsx explaining the named-to-default mapping pattern.

**File:** `web/src/App.tsx`

**Verification:**
- Code splitting still works — lazy-loaded routes load on navigation
- No console errors about missing default exports

---

### FIX-16: Missing React.memo on MessageBubble (LOW)

**Problem:** Every message re-renders when any new message arrives because MessageBubble isn't memoized.

**Requirement:** Wrap `MessageBubble` in `React.memo()`. Skip memo for `ToolCallBlock` (it has dynamic state).

**File:** `web/src/components/chat/MessageBubble.tsx`

**Verification:**
- Use React DevTools Profiler: send 5 messages, verify that only the newest message re-renders (not all 5)
- All message types (user, assistant, streaming, tool calls) still render correctly

---

## Execution Plan

| Agent | Issues | Files | Can run in parallel with |
|-------|--------|-------|--------------------------|
| Agent 1 | FIX-01,02,03,04 | src/serve.ts | Agents 2,3,4,5 |
| Agent 2 | FIX-05,07,10,17 | MessageBubble, TokenEntry, api.ts | Agent 1 |
| Agent 3 | FIX-06,09,11,12,14 | useAgentChat, chat.ts, ui.ts | Agent 1 |
| Agent 4 | FIX-08,13 | auth.ts, api.ts | Agent 1 (conflicts with Agent 2 on api.ts — run after Agent 2) |
| Agent 5 | FIX-15,16 | App.tsx, MessageBubble | Agent 1 (conflicts with Agent 2 on MessageBubble — run after Agent 2) |

**Parallel groups:**
- Wave 1: Agents 1, 2, 3 (no file conflicts)
- Wave 2: Agents 4, 5 (after wave 1 completes, since they share files with Agent 2)
