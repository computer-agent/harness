# Phase 3 Remaining Work — Implementation Spec

3 features to complete Phase 3. Each has requirements, implementation details, and verification.

Reference docs:
- `docs/phases/phase-3-web-frontend.md` — Full Phase 3 spec (sections 3.7, 3.13, 3.6 tool approval)
- `docs/FIXES-code-review.md` — Recent code review fixes already applied (context for current file state)

---

## Feature 1: @mention Agent Switching (Section 3.7)

### Files to Create
- `web/src/components/chat/MentionAutocomplete.tsx` — Dropdown component

### Files to Modify
- `web/src/components/chat/InputArea.tsx` — Add @ detection, show/hide autocomplete, insert mention
- `web/src/locales/en.json` — Add `mentions.noAgents` key
- `web/src/locales/pt-BR.json` — Add `mentions.noAgents` key

### Requirements

1. User types `@` after whitespace or at start of input → autocomplete dropdown appears above input
2. Dropdown lists agents from `useAgentRoster`, filtered by text after `@`
3. Each row: agent icon + name + short description
4. Navigation: arrow keys + Enter to select, Escape to dismiss, click/tap to select
5. On select: insert `@agentname ` (with trailing space) at cursor position in textarea
6. `@` mid-word (e.g. `email@test`) does NOT trigger autocomplete
7. Dropdown: max 5 visible, scrollable if more. "No agents found" if filter matches nothing
8. Mobile: dropdown is full-width above the input
9. Desktop: dropdown positioned above cursor or above input area
10. Sent message contains raw `@agentname` text (backend parses it)

### Implementation Notes

- InputArea already has a `<textarea>` with `textareaRef`. Hook into `onChange` or `onKeyUp` to detect `@` patterns.
- Use a regex like `/(?:^|\s)@(\w*)$/` against the text before the cursor to detect mention-in-progress.
- MentionAutocomplete receives: `agents`, `filter`, `onSelect`, `onDismiss`, `visible`
- Accessibility: dropdown has `role="listbox"`, items have `role="option"`, active item has `aria-selected="true"`
- InputArea already imports `useAgentRoster` is NOT present — the hook is at `web/src/hooks/useAgentRoster.ts`. Import it in InputArea or pass agents as a prop from ChatPanel (ChatPanel already has access via AgentView's route params — check the component tree).

### Verification

```bash
# After implementation, verify:
# 1. Type check passes
cd web && npx tsc --noEmit

# 2. Lint passes
npx biome check src/

# 3. Manual test plan (document these as comments or in the PR):
# - Type "@" in empty input → dropdown shows all agents
# - Type "@cre" → filters to matching agents
# - Arrow down + Enter → mention inserted with trailing space
# - Click agent → mention inserted, dropdown closes
# - Escape → dropdown closes without inserting
# - Type "email@test" → no dropdown
# - Mobile viewport (375px) → dropdown full-width
# - Accessibility: Tab into input, type @, arrow keys work, Enter selects
```

---

## Feature 2: Error State Wiring (Section 3.13)

### Files to Modify
- `web/src/hooks/useAgentChat.ts` — Add toast calls for specific error types
- `web/src/components/chat/ChatPanel.tsx` — Add retry button for model errors in chat
- `web/src/stores/chat.ts` — Add `lastUserMessage` field for retry, add `retryLastMessage` action
- `web/src/lib/api.ts` — Surface rate limit info (429 status + Retry-After header)
- `web/src/stores/auth.ts` — Clear token + redirect on auth_failed from WS
- `web/src/locales/en.json` — Verify all `errors.*` keys exist (they should already)
- `web/src/locales/pt-BR.json` — Same

### Requirements

Wire these specific error scenarios to user-visible feedback. Sonner toast is already installed and configured in App.tsx.

**A. Rate Limited (429)**
- When api.ts gets 429: extract `Retry-After` header (seconds), throw error with countdown info
- Toast: `t("errors.rateLimited", { seconds })` with auto-dismiss matching the countdown
- Input disabled during countdown

**B. Session Expired**
- When WS receives `{ type: "error", code: "session_expired" }`:
  - Toast: `t("errors.sessionExpired")`
  - Auto-create new session (clear sessionId, keep agentId)
  - Old messages remain visible (read-only)

**C. Auth Failed (from WS)**
- When WS receives `{ type: "error", code: "auth_failed" }`:
  - Call `useAuthStore.getState().clearToken()`
  - Toast: `t("errors.authFailed")`
  - App re-renders to TokenEntry via AuthGuard

**D. Model Error (retry in chat)**
- When WS receives `{ type: "error", code: "model_error" | "rate_limited" | ... }` during a conversation:
  - Display error as a special message in chat (red left border, `bg-red-950/20`)
  - Include a "Retry" button that re-sends the last user message
  - Store `lastUserMessage` in chat store for retry
  - `retryLastMessage()` action: remove the error message, re-send

**E. Network Error (fetch failures)**
- Already partially handled. Ensure `request()` in api.ts catches network errors and throws with `t("errors.networkError")` context.

### Implementation Notes

- `sonner` toast API: `import { toast } from "sonner"` then `toast.error("message")`, `toast.warning("message")`, etc.
- For rate limit countdown: use `toast.error(message, { duration: seconds * 1000 })`
- For the retry button in chat: add a new message type or a flag on ChatMessage like `isError: true` with an `onRetry` callback
- Check `web/src/lib/ws-client.ts` for the WS message type definitions — `WsErrorMsg` likely has `code` and `message` fields

### Verification

```bash
# Type check + lint
cd web && npx tsc --noEmit && npx biome check src/

# Manual test scenarios:
# 1. Rate limit: Have backend return 429 → toast shows with countdown
# 2. Kill backend mid-conversation → reconnecting banner shows (already works)
# 3. Invalidate token → WS sends auth_failed → redirects to token entry
# 4. Trigger model error → error message in chat with retry button → click retry → re-sends
# 5. All error toasts display in correct language (switch to pt-BR, trigger error)
```

---

## Feature 3: Tool Approval Flow (Section 3.6 addition)

### Files to Modify
- `web/src/components/chat/ToolCallBlock.tsx` — Add "needs_approval" state with approve/deny buttons
- `web/src/lib/ws-client.ts` — Add `WsToolApprovalMsg` type to client messages
- `web/src/hooks/useAgentChat.ts` — Handle `tool_approval` server message, send approval response
- `web/src/types/index.ts` — Add `"needs_approval"` to ToolCall status type
- `web/src/locales/en.json` — `toolCalls.approve` and `toolCalls.deny` already exist
- `web/src/locales/pt-BR.json` — Same

### Requirements

1. When backend sends `{ type: "tool_approval", toolId, toolName, toolInput, question }`:
   - ToolCallBlock renders in approval state:
     - Left icon: `ShieldQuestion` (lucide-react) in orange
     - Question text displayed
     - Two buttons: "Allow" (green) and "Deny" (red)
     - Border: `border-l-2 border-orange-500`
2. Clicking Allow → send `{ type: "tool_approval", toolId, approved: true }` via WS
3. Clicking Deny → send `{ type: "tool_approval", toolId, approved: false }` via WS
4. After decision: tool transitions to "executing" (if approved) or "error" (if denied)

### Implementation Notes

- ToolCallBlock already handles 3 states (executing/complete/error). Add a 4th: `needs_approval`
- The `ToolCall` type in `web/src/types/index.ts` has `status: "executing" | "complete" | "error"` — add `"needs_approval"`
- Add `question?: string` to ToolCall type
- ToolCallBlock needs `onApprove` and `onReject` callbacks (props already spec'd in phase-3 doc)
- Wire callbacks through ChatPanel → MessageBubble → ToolCallBlock, or use a Zustand action
- Check if backend actually sends `tool_approval` messages — if not yet implemented on backend, still build the frontend and document that backend support is pending

### Verification

```bash
# Type check + lint
cd web && npx tsc --noEmit && npx biome check src/

# Manual test:
# 1. If backend supports tool approval: trigger a tool that requires approval
#    → orange block appears with question + Allow/Deny buttons
#    → click Allow → tool executes
#    → click Deny → tool shows error state
# 2. If backend doesn't support it yet: verify the UI renders correctly
#    by temporarily adding a mock tool_approval message in useAgentChat
# 3. Accessibility: approve/deny buttons have aria-labels
```

---

## Execution Strategy

**These can run as 2 parallel agents + 1 sequential:**

- **Agent A**: Feature 1 (@mention) — standalone, touches InputArea + new MentionAutocomplete
- **Agent B**: Feature 2 (Error states) — touches useAgentChat, ChatPanel, chat store, api.ts, auth store
- **Agent C**: Feature 3 (Tool approval) — touches ToolCallBlock, ws-client, useAgentChat, types

**Conflict analysis:**
- Agent A and B both touch `useAgentChat.ts` — but A only touches InputArea/new component, so no real conflict if A doesn't modify useAgentChat
- Agent B and C both touch `useAgentChat.ts` — B adds toast calls in error handler, C adds tool_approval message handler. Different switch cases, low conflict risk.
- Safest: Run A in parallel with B, then C after B (since B and C both modify useAgentChat error/message handling).

**Recommended:**
- Wave 1: Agent A (@mention) + Agent B (Error states) in parallel
- Wave 2: Agent C (Tool approval) after wave 1

After all agents complete:
```bash
cd web && npx tsc --noEmit && npx biome check src/
```

---

## Done When

All Phase 3 acceptance criteria from `docs/phases/phase-3-web-frontend.md` sections 3.7, 3.13, and 3.6 (tool approval) are met. Type check and lint pass clean.
