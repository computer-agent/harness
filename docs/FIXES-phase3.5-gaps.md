# Phase 3.5: Backend-Frontend Integration Gaps

Closes all gaps between the Phase 2 serve mode backend and the Phase 3 web frontend.
Discovered by diffing what the backend sends vs what the frontend handles, and vice versa.

Reference files:
- `src/serve.ts` — WS server + message handling
- `src/agent.ts` — `buildCanUseTool()`, `buildOptions()`
- `src/errors.ts` — `classifyError()` error categories
- `src/types/ws.ts` — backend WS message type definitions
- `web/src/hooks/useAgentChat.ts` — frontend WS message switch
- `web/src/lib/ws-client.ts` — frontend WS type definitions
- `web/src/stores/chat.ts` — Zustand chat state
- `web/src/types/index.ts` — frontend ToolCall/ChatMessage types

---

## Feature 1: Error Code Alignment

### Problem

Backend `classifyError()` returns categories that don't match the codes the frontend expects.

| Backend sends (`category`) | Frontend expects (`code`) | Status |
|---|---|---|
| `"auth"` | `"auth_failed"` | Mismatch |
| `"rate_limit"` | `"rate_limited"` | Mismatch |
| `"overloaded"` | `"overloaded"` | OK |
| `"server"` | `"model_error"` or `"internal_error"` | Mismatch |
| `"network"` | (falls to default) | Unhandled |
| `"invalid_request"` | (falls to default) | Unhandled |
| `"unknown"` | (falls to default) | Unhandled |

Hardcoded codes in `serve.ts` (`"auth_failed"`, `"agent_not_found"`, `"access_denied"`, `"parse_error"`, `"not_subscribed"`) are fine — `"auth_failed"` matches, the rest fall to the default case which is acceptable.

### Files to Modify

- `src/errors.ts` — Change category values to match frontend expectations

### Implementation

Update the `ClassifiedError.category` type and pattern returns:

```typescript
// Old
category: "auth" | "rate_limit" | "overloaded" | "network" | "invalid_request" | "server" | "unknown";

// New
category: "auth_failed" | "rate_limited" | "overloaded" | "network" | "invalid_request" | "model_error" | "unknown";
```

Map changes:
- `"auth"` → `"auth_failed"`
- `"rate_limit"` → `"rate_limited"`
- `"server"` → `"model_error"` (model API errors are the only 5xx the frontend needs to retry)

### Verification

```bash
# Type check backend
npx tsc --noEmit

# Grep for old category strings to ensure nothing references them
grep -rn '"auth"\|"rate_limit"\|"server"' src/ --include='*.ts' | grep category
```

---

## Feature 2: Ping-Pong Heartbeat

### Problem

Frontend sends `{ type: "ping" }` every 25s (via `react-use-websocket` heartbeat config). Backend WS handler has no case for `"ping"` — it falls through the switch silently. The heartbeat library expects a `"pong"` response (`returnMessage: "pong"` at `useAgentChat.ts:49`). Without it, the library may consider the connection dead after 60s timeout and force a reconnect.

### Files to Modify

- `src/serve.ts` — Add `"ping"` case to WS message switch
- `src/types/ws.ts` — Add `WsPing` to `WsClientMessage` union

### Implementation

In `serve.ts` WS message handler (line 647):
```typescript
case "ping":
  ws.send(JSON.stringify({ type: "pong" }));
  break;
```

In `src/types/ws.ts`:
```typescript
export interface WsPing { type: "ping"; }
export type WsClientMessage = WsSubscribe | WsMessage | WsInterrupt | WsPing;
```

### Verification

```bash
npx tsc --noEmit

# Manual: open WS connection, send {"type":"ping"}, verify {"type":"pong"} response
# Or: connect the web frontend and check no spurious reconnects in devtools Network tab
```

---

## Feature 3: Tool Approval Flow (Backend)

### Problem

The Phase 3 frontend has tool approval UI (approve/deny buttons in ToolCallBlock), but the backend never sends `tool_approval` messages and has no mechanism to pause tool execution pending user approval.

The SDK's `canUseTool` callback is already async and supports returning `{ behavior: "allow" | "deny" }`. The TUI uses this for `AskUserQuestion`. The serve mode needs to extend this to support interactive tool approval via WS.

### Files to Modify

- `src/serve.ts` — Add tool approval WS plumbing (send request, receive response)
- `src/agent.ts` — Add `onToolApproval` callback to `buildCanUseTool`
- `src/types/ws.ts` — Add `WsToolApprovalRequest` (server→client) and `WsToolApprovalResponse` (client→server)

### Implementation

**1. WS types (`src/types/ws.ts`):**

```typescript
// Server → Client: ask user to approve a tool call
export interface WsToolApprovalRequest {
  type: "tool_approval";
  toolId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  question: string;
}

// Client → Server: user's decision
export interface WsToolApprovalResponse {
  type: "tool_approval";
  toolId: string;
  approved: boolean;
}

// Add to unions:
// WsServerMessage: | WsToolApprovalRequest
// WsClientMessage: | WsToolApprovalResponse
```

**2. Serve mode (`src/serve.ts`):**

Add a pending-approval map to `ActiveConversation`:
```typescript
interface ActiveConversation {
  // ... existing fields ...
  pendingApprovals: Map<string, (approved: boolean) => void>;
}
```

Add the `"tool_approval"` case to the WS message switch:
```typescript
case "tool_approval":
  if (activeConversation?.pendingApprovals) {
    const resolver = activeConversation.pendingApprovals.get(msg.toolId);
    if (resolver) {
      resolver(msg.approved);
      activeConversation.pendingApprovals.delete(msg.toolId);
    }
  }
  break;
```

Pass an `onToolApproval` callback to `buildOptions`:
```typescript
const onToolApproval = async (toolId: string, toolName: string, input: Record<string, unknown>): Promise<boolean> => {
  return new Promise((resolve) => {
    conversation.pendingApprovals.set(toolId, resolve);
    ws.send(JSON.stringify({
      type: "tool_approval",
      toolId,
      toolName,
      toolInput: input,
      question: `Allow ${toolName}?`,
    }));
  });
};
```

**3. Agent (`src/agent.ts`):**

Extend `buildCanUseTool` to accept an `onToolApproval` callback. In serve mode, when a tool is called, the callback sends a WS message and awaits the user's response before returning `allow` or `deny`.

The question is which tools need approval. Options:
- **All tools** — too noisy, defeats the purpose of an autonomous agent
- **Only when `canUseTool` would have returned a question** — but the SDK doesn't expose this natively
- **Configurable per-agent via frontmatter** — e.g. `approveTools: [bash, write]`

Recommended: Add an optional `approveTools` list to agent frontmatter. If a tool is in the list, `canUseTool` sends the approval request. Otherwise, auto-allow. Default: empty (no approval needed).

Add `onToolApproval` to `buildCanUseTool` params:
```typescript
function buildCanUseTool(
  ctx: AgentContext,
  config: HarnessConfig,
  onAskUserQuestion?: ...,
  onToolApproval?: (toolId: string, toolName: string, input: Record<string, unknown>) => Promise<boolean>,
): CanUseTool {
  return async (toolName, input, options) => {
    // ... existing logging + AskUserQuestion handling ...

    // Tool approval (serve mode only)
    if (onToolApproval) {
      const approved = await onToolApproval(options.toolUseId ?? toolName, toolName, input);
      if (!approved) {
        return { behavior: "deny", message: "User denied tool execution" };
      }
    }

    return { behavior: "allow" };
  };
}
```

Update `buildOptions` to accept and pass through `onToolApproval`.

### Verification

```bash
npx tsc --noEmit

# Integration test:
# 1. Start serve mode with an agent
# 2. Connect via web UI, send a message that triggers a tool call
# 3. Verify tool_approval WS message is received by frontend
# 4. Click Allow → tool executes
# 5. Click Deny → tool shows error, agent gets denial message
# 6. Agent without approveTools config → tools auto-allow (no approval prompt)
```

---

## Feature 4: Tool Approval Flow (Frontend — redo)

### Problem

Agent C's frontend changes for tool approval were lost during the Wave 1 merge. The types, store, hook, and component changes need to be reimplemented.

### Files to Modify

- `web/src/types/index.ts` — Add `"needs_approval"` to ToolCall status, add `question?: string`
- `web/src/lib/ws-client.ts` — Add `WsToolApprovalServerMsg` and `WsToolApprovalClientMsg` types
- `web/src/stores/chat.ts` — Add `setToolCallApproval()` and `updateToolCallStatus()` actions
- `web/src/hooks/useAgentChat.ts` — Handle `tool_approval` message, expose `respondToToolApproval`
- `web/src/components/chat/ToolCallBlock.tsx` — Render `needs_approval` state with approve/deny buttons
- `web/src/components/chat/MessageBubble.tsx` — Pass `onToolApproval` callbacks through
- `web/src/components/chat/ChatPanel.tsx` — Wire `respondToToolApproval` from hook to components

### Implementation

See the original spec in `docs/FIXES-phase3-remaining.md` Feature 3. The requirements are unchanged:

1. ToolCall type gets `"needs_approval"` status + `question?: string`
2. WS types: server sends `{ type: "tool_approval", toolId, toolName, toolInput, question }`, client sends `{ type: "tool_approval", toolId, approved }`
3. Store: `setToolCallApproval(toolId, question)` sets status to `needs_approval`, `updateToolCallStatus(toolId, status)` transitions after decision
4. Hook: `tool_approval` case creates/updates tool call, exposes `respondToToolApproval(toolId, approved)` that sends WS message + optimistic status update
5. ToolCallBlock: orange border, ShieldQuestion icon, question text, Allow/Deny buttons
6. Wired through ChatPanel → MessageBubble → ToolCallBlock

### Verification

```bash
cd web && npx tsc --noEmit && npx biome check src/
```

---

## Feature 5: Thinking Token Display

### Problem

Backend sends `{ type: "thinking_token", text }` (serve.ts line 439). Frontend has no handler — these messages are silently dropped. Users miss seeing the model's reasoning.

### Files to Modify

- `web/src/lib/ws-client.ts` — Add `WsThinkingTokenMsg` type to `WsServerMsg` union
- `web/src/hooks/useAgentChat.ts` — Add `thinking_token` case to message switch
- `web/src/stores/chat.ts` — Add `appendThinkingToken()` action
- `web/src/types/index.ts` — Add `thinkingContent?: string` to ChatMessage
- `web/src/components/chat/MessageBubble.tsx` — Render thinking content with distinct styling

### Implementation

**Types (`web/src/types/index.ts`):**
```typescript
export interface ChatMessage {
  // ... existing fields ...
  thinkingContent?: string; // Accumulated thinking tokens
}
```

**WS types (`web/src/lib/ws-client.ts`):**
```typescript
export interface WsThinkingTokenMsg {
  type: "thinking_token";
  text: string;
}
// Add to WsServerMsg union
```

**Store (`web/src/stores/chat.ts`):**
```typescript
appendThinkingToken: (text: string) => {
  set((s) => {
    const msgs = [...s.messages];
    const last = msgs[msgs.length - 1];
    if (last?.role === "assistant") {
      msgs[msgs.length - 1] = {
        ...last,
        thinkingContent: (last.thinkingContent ?? "") + text,
      };
    }
    return { messages: msgs };
  });
},
```

**Hook (`web/src/hooks/useAgentChat.ts`):**
```typescript
case "thinking_token":
  store.appendThinkingToken(msg.text);
  break;
```

**Component (`web/src/components/chat/MessageBubble.tsx`):**
Render `thinkingContent` in a collapsible block above the main content, styled with muted text (e.g. `text-zinc-500 italic text-sm`), with a "Thinking..." header. Use shadcn Collapsible, collapsed by default once streaming ends.

### Verification

```bash
cd web && npx tsc --noEmit && npx biome check src/

# Manual: send a message to an agent using extended thinking
# → thinking tokens appear in a collapsible "Thinking" section above the response
# → section collapses automatically when response starts streaming
```

---

## Feature 6: Subagent Progress Display

### Problem

Backend sends `subagent_started`, `subagent_progress`, `subagent_done` messages (serve.ts lines 477-508). Frontend WS types define these but `useAgentChat` has no handlers — messages are silently dropped.

### Files to Modify

- `web/src/hooks/useAgentChat.ts` — Add cases for all 3 subagent message types
- `web/src/stores/chat.ts` — Add subagent tracking state + actions
- `web/src/types/index.ts` — Add `SubagentTask` type
- `web/src/components/chat/SubagentIndicator.tsx` — **New file**: inline indicator component

### Implementation

**Types (`web/src/types/index.ts`):**
```typescript
export interface SubagentTask {
  taskId: string;
  description: string;
  status: "running" | "completed" | "failed" | "stopped";
  toolUses: number;
  durationMs: number;
  totalTokens: number;
  summary?: string;
}
```

**Store (`web/src/stores/chat.ts`):**
Add `subagentTasks: SubagentTask[]` to state, with actions:
- `addSubagentTask(taskId, description)` — called on `subagent_started`
- `updateSubagentProgress(taskId, toolUses, durationMs, totalTokens)` — called on `subagent_progress`
- `completeSubagentTask(taskId, status, summary, totalTokens)` — called on `subagent_done`
- `clearSubagentTasks()` — called when conversation switches

**Hook (`web/src/hooks/useAgentChat.ts`):**
```typescript
case "subagent_started":
  store.addSubagentTask(msg.taskId, msg.description);
  break;
case "subagent_progress":
  store.updateSubagentProgress(msg.taskId, msg.toolUses, msg.durationMs, msg.totalTokens);
  break;
case "subagent_done":
  store.completeSubagentTask(msg.taskId, msg.status, msg.summary, msg.totalTokens);
  break;
```

**Component (`web/src/components/chat/SubagentIndicator.tsx`):**
Renders inline within the current assistant message (similar to tool call blocks). Shows:
- Running: spinner + description + elapsed time
- Complete: check + description + summary (truncated)
- Failed: x + description

Wire through MessageBubble — display active subagent tasks below tool calls.

### Verification

```bash
cd web && npx tsc --noEmit && npx biome check src/

# Manual: trigger an agent that spawns sub-agents
# → "Researching..." indicator appears during sub-agent execution
# → Updates with progress (tool uses, duration)
# → Shows summary when sub-agent completes
```

---

## Feature 7: Tool Results Display

### Problem

Backend types define `WsToolResult` and `WsToolUseEnd` (in `src/types/ws.ts`) but `serve.ts` never sends them. Tools complete silently — frontend shows tools go from "executing" to "complete" via `finalizeAssistantMessage` but never shows what the tool returned.

### Files to Modify

- `src/serve.ts` — Send `tool_result` messages when tools complete
- `web/src/lib/ws-client.ts` — Add `WsToolResultMsg` type
- `web/src/hooks/useAgentChat.ts` — Handle `tool_result` message
- `web/src/stores/chat.ts` — Add `setToolResult(toolId, output)` action

### Implementation

**Backend (`src/serve.ts`):**

The SDK emits tool results as `stream_event` with `event.type === "content_block_start"` where `content_block.type === "tool_result"`. However, tool results in the Anthropic API flow come back as user-role messages in multi-turn conversations, not as stream events.

Alternative approach: use the SDK's `PostToolUse` hook (already imported in `src/agent.ts`). Add a hook that fires after each tool call completes and sends the result to the WS client.

In `buildHooks` (or via a new hook in `buildOptions`):
```typescript
// In serve mode, add a PostToolUse hook to capture tool results
hooks.push({
  type: "PostToolUse",
  callback: async (event) => {
    if (onToolResult) {
      onToolResult(event.toolUseId, event.toolName, event.output);
    }
  },
});
```

In `handleMessage`, pass an `onToolResult` callback:
```typescript
const onToolResult = (toolId: string, toolName: string, output: string) => {
  ws.send(JSON.stringify({
    type: "tool_result",
    id: conversation.messageBuffer.nextId(),
    toolId,
    content: typeof output === "string" ? output : JSON.stringify(output),
  }));
};
```

**Frontend:** Handle in hook, store result on ToolCall, display in ToolCallBlock's collapsible output section (which already exists but has no data).

### Verification

```bash
npx tsc --noEmit
cd web && npx tsc --noEmit && npx biome check src/

# Manual: send a message that triggers a tool (e.g. file read)
# → Tool block shows "executing" → "complete"
# → Expand the tool block → shows the tool's output
```

---

## Feature 8: Interrupt Acknowledgment

### Problem

When user clicks interrupt, the backend calls `activeQuery.interrupt()` but sends no immediate feedback. The user sees no response until the SDK finishes its current operation and returns the result with `interrupted: true`. This can take seconds, leaving the user unsure if the interrupt worked.

### Files to Modify

- `src/serve.ts` — Send immediate status update on interrupt

### Implementation

In the `"interrupt"` case (serve.ts line 658):
```typescript
case "interrupt":
  if (activeConversation?.activeQuery) {
    activeConversation.activeQuery.interrupt();
    ws.send(JSON.stringify({ type: "status", status: "interrupted" }));
  }
  break;
```

Frontend already handles `status: "interrupted"` — this just makes it fire immediately instead of waiting for the result.

### Verification

```bash
npx tsc --noEmit

# Manual: start a long-running agent response, click interrupt
# → Status changes to "interrupted" immediately (not after SDK returns)
```

---

## Execution Strategy

### Wave 1 (parallel — no file overlap)

- **Agent A**: Features 1 + 2 + 8 (error codes, ping-pong, interrupt ack) — all backend-only, touches `src/errors.ts`, `src/serve.ts`, `src/types/ws.ts`
- **Agent B**: Features 5 + 6 (thinking tokens, subagent progress) — frontend-only, touches `web/src/` (hooks, stores, types, components)

### Wave 2 (sequential — both touch agent.ts, serve.ts, useAgentChat.ts)

- **Agent C**: Features 3 + 4 + 7 (tool approval backend + frontend, tool results) — full-stack, touches `src/serve.ts`, `src/agent.ts`, `src/types/ws.ts`, `web/src/` (all the same files as Feature 4)

### Conflict analysis

- Wave 1 agents have zero file overlap (one is backend-only, one is frontend-only)
- Wave 2 must run after Wave 1 because:
  - Agent C modifies `src/serve.ts` (Agent A also modifies it in Wave 1)
  - Agent C modifies `web/src/hooks/useAgentChat.ts` (Agent B also modifies it in Wave 1)
  - Agent C modifies `web/src/types/index.ts` (Agent B also modifies it in Wave 1)

### After all waves

```bash
# Backend type check
npx tsc --noEmit

# Frontend type check + lint
cd web && npx tsc --noEmit && npx biome check src/

# Integration smoke test (manual):
# 1. Start: npx tsx bin/mastersof-ai.js --serve --port 3001
# 2. Open web UI, connect to an agent
# 3. Send a message → verify tokens stream, no spurious reconnects (ping-pong works)
# 4. Trigger a tool call → verify tool_result comes back and displays in ToolCallBlock
# 5. If agent has approveTools configured → verify approval prompt appears
# 6. Trigger an error (e.g. bad API key) → verify correct error code in toast
# 7. Click interrupt during response → verify immediate "interrupted" status
# 8. If extended thinking is enabled → verify thinking tokens display
```

---

## Deferred to Phase 4

These are operational concerns better addressed in the security/production phase:

- **Rate limiting** — Backend doesn't enforce message rate limits. Frontend has the UI for it but backend never sends 429 or `rate_limited` errors from its own logic (only passes through API rate limits). Add in Phase 4 with per-user quotas.
- **Session expiration** — Backend doesn't expire sessions. Frontend handles `session_expired` but backend never sends it. Add in Phase 4 with session TTL + validation.

---

## Done When

1. `npx tsc --noEmit` passes (backend)
2. `cd web && npx tsc --noEmit && npx biome check src/` passes (frontend)
3. All 8 features verified via the integration smoke test above
4. Error codes from backend match what frontend expects (no silent drops)
5. No WS message types sent by backend that frontend silently ignores
6. No WS message types expected by frontend that backend never sends (except deferred items)
