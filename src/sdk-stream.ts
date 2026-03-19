/**
 * Shared SDK stream processor — typed extraction of events from Claude Agent SDK messages.
 *
 * Both session-worker.ts (remote) and App.tsx (TUI) parse the same SDK stream events.
 * This module eliminates the duplicated `as any` casts and provides a single, typed
 * extraction layer that both consumers use.
 *
 * Usage:
 *   for await (const msg of query) {
 *     const event = extractSdkEvent(msg);
 *     if (!event) continue;
 *     switch (event.kind) { ... }
 *   }
 */

// ─── Raw SDK message shape (untyped — the SDK exports `Message` but stream events lack types) ───

interface SdkMessage {
  type: string;
  session_id?: string;
  [key: string]: unknown;
}

// ─── Extracted event types ───
//
// Why `kind` and not `type`?
// The raw SDK messages and IPC/WS protocols both use `type` as their discriminant.
// Using `kind` here avoids ambiguity: `event.kind` is always the SdkEvent discriminant,
// `event.type` would shadow the raw message's `type` field. Do NOT rename to `type`.
//

export interface SdkInitEvent {
  kind: "init";
  sessionId: string;
}

export interface SdkTextTokenEvent {
  kind: "text_token";
  text: string;
}

export interface SdkThinkingTokenEvent {
  kind: "thinking_token";
  text: string;
}

export interface SdkToolUseStartEvent {
  kind: "tool_use_start";
  toolName: string;
  toolId: string;
}

export interface SdkToolInputDeltaEvent {
  kind: "tool_input_delta";
  toolId: string | null;
  partialJson: string;
}

export interface SdkContentBlockStopEvent {
  kind: "content_block_stop";
}

export interface SdkTextBlockStartEvent {
  kind: "text_block_start";
}

export interface SdkMessageStartEvent {
  kind: "message_start";
  usage: { input_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

export interface SdkSubagentStartedEvent {
  kind: "subagent_started";
  taskId: string;
  description: string;
}

export interface SdkSubagentProgressEvent {
  kind: "subagent_progress";
  taskId: string;
  toolUses: number;
  durationMs: number;
  totalTokens: number;
}

export interface SdkSubagentDoneEvent {
  kind: "subagent_done";
  taskId: string;
  status: string;
  summary: string;
  totalTokens: number;
}

export interface SdkAssistantEvent {
  kind: "assistant";
  usage: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  } | null;
  /** Fallback text content extracted from message blocks */
  textContent: string;
}

export interface SdkResultEvent {
  kind: "result";
  isInterrupted: boolean;
}

export type SdkEvent =
  | SdkInitEvent
  | SdkTextTokenEvent
  | SdkThinkingTokenEvent
  | SdkToolUseStartEvent
  | SdkToolInputDeltaEvent
  | SdkContentBlockStopEvent
  | SdkTextBlockStartEvent
  | SdkMessageStartEvent
  | SdkSubagentStartedEvent
  | SdkSubagentProgressEvent
  | SdkSubagentDoneEvent
  | SdkAssistantEvent
  | SdkResultEvent;

// ─── Extraction ───

/**
 * Extract a typed event from a raw SDK stream message.
 *
 * Returns null for messages that don't map to a known event (e.g. unknown system subtypes).
 * A single SDK message may only produce one event — this is by design; the SDK emits
 * fine-grained messages.
 */
export function extractSdkEvent(raw: unknown): SdkEvent | null {
  const msg = raw as SdkMessage;
  if (!msg || typeof msg !== "object" || !msg.type) return null;

  // ─── system messages (init, subagent lifecycle) ───
  if (msg.type === "system") {
    const subtype = msg.subtype as string | undefined;

    if (subtype === "init" && msg.session_id) {
      return { kind: "init", sessionId: msg.session_id };
    }

    if (subtype === "task_started") {
      return {
        kind: "subagent_started",
        taskId: (msg.task_id as string) ?? "",
        description: (msg.description as string) ?? "",
      };
    }

    if (subtype === "task_progress") {
      const usage = msg.usage as Record<string, unknown> | undefined;
      return {
        kind: "subagent_progress",
        taskId: (msg.task_id as string) ?? "",
        toolUses: (usage?.tool_uses as number) ?? 0,
        durationMs: (usage?.duration_ms as number) ?? 0,
        totalTokens: (usage?.total_tokens as number) ?? 0,
      };
    }

    if (subtype === "task_notification") {
      const usage = msg.usage as Record<string, unknown> | undefined;
      return {
        kind: "subagent_done",
        taskId: (msg.task_id as string) ?? "",
        status: (msg.status as string) ?? "",
        summary: (msg.summary as string) ?? "",
        totalTokens: (usage?.total_tokens as number) ?? 0,
      };
    }

    return null;
  }

  // ─── stream_event (Anthropic API streaming events) ───
  if (msg.type === "stream_event") {
    const event = msg.event as Record<string, unknown> | undefined;
    if (!event) return null;

    const eventType = event.type as string;
    const delta = event.delta as Record<string, unknown> | undefined;
    const contentBlock = event.content_block as Record<string, unknown> | undefined;

    // message_start — contains initial usage
    if (eventType === "message_start") {
      const message = event.message as Record<string, unknown> | undefined;
      const usage = message?.usage as Record<string, unknown> | undefined;
      if (usage) {
        return { kind: "message_start", usage: usage as SdkMessageStartEvent["usage"] };
      }
      return null;
    }

    // content_block_start
    if (eventType === "content_block_start" && contentBlock) {
      if (contentBlock.type === "tool_use") {
        const rawName = (contentBlock.name as string) ?? "unknown";
        return {
          kind: "tool_use_start",
          toolName: rawName.replace(/^mcp__.+?__/, ""),
          toolId: (contentBlock.id as string) ?? "",
        };
      }
      if (contentBlock.type === "text") {
        return { kind: "text_block_start" };
      }
    }

    // content_block_delta
    if (eventType === "content_block_delta" && delta) {
      if (delta.type === "text_delta" && delta.text) {
        return { kind: "text_token", text: delta.text as string };
      }
      if (delta.type === "thinking_delta" && delta.thinking) {
        return { kind: "thinking_token", text: delta.thinking as string };
      }
      if (delta.type === "input_json_delta") {
        const rawId = contentBlock?.id as string | undefined;
        return {
          kind: "tool_input_delta",
          toolId: rawId || null,
          partialJson: (delta.partial_json as string) ?? "",
        };
      }
    }

    // content_block_stop
    if (eventType === "content_block_stop") {
      return { kind: "content_block_stop" };
    }

    return null;
  }

  // ─── assistant turn ───
  if (msg.type === "assistant") {
    const message = msg.message as Record<string, unknown> | undefined;
    const usage = (message?.usage as Record<string, unknown>) ?? null;
    const content = message?.content as Array<Record<string, unknown>> | undefined;
    const textContent =
      content
        ?.filter((block) => block.type === "text")
        .map((block) => block.text as string)
        .join("") ?? "";
    return {
      kind: "assistant",
      usage: usage as SdkAssistantEvent["usage"],
      textContent,
    };
  }

  // ─── result (end of turn) ───
  if (msg.type === "result") {
    return { kind: "result", isInterrupted: !!msg.is_interrupted };
  }

  return null;
}
