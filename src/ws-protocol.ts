/**
 * WebSocket client message schema validation (W6-T05).
 *
 * Validates incoming WS messages against Zod schemas after JSON.parse.
 * Rejects malformed messages with structured errors instead of allowing
 * untyped data to flow through the system.
 */

import { z } from "zod";
import type { WsClientMessage } from "./types/ws.js";

const WsSubscribeSchema = z.object({
  type: z.literal("subscribe"),
  agentId: z.string().min(1).max(200),
  sessionId: z.string().min(1).max(200).optional(),
  // W7-T12: Explicit max prevents abuse with astronomically large IDs
  lastMessageId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});

const WsMessageSchema = z.object({
  type: z.literal("message"),
  // W7-T12: Belt-and-suspenders with rate limiter's maxMessageLength
  content: z.string().min(1).max(200_000),
});

const WsInterruptSchema = z.object({
  type: z.literal("interrupt"),
});

const WsPingSchema = z.object({
  type: z.literal("ping"),
});

const WsToolApprovalResponseSchema = z.object({
  type: z.literal("tool_approval"),
  toolId: z.string().min(1),
  approved: z.boolean(),
});

const WsConsentGrantedSchema = z.object({
  type: z.literal("consent_granted"),
  policyVersion: z.string().min(1),
});

const WsClientMessageSchema = z.discriminatedUnion("type", [
  WsSubscribeSchema,
  WsMessageSchema,
  WsInterruptSchema,
  WsPingSchema,
  WsToolApprovalResponseSchema,
  WsConsentGrantedSchema,
]);

// W7-T06: Compile-time assertion that Zod output matches the TypeScript union.
// If the two diverge (e.g., a new message type added to one but not the other),
// this assignment fails at build time.
type ZodOutput = z.output<typeof WsClientMessageSchema>;
type _AssertZodMatchesTs = ZodOutput extends WsClientMessage
  ? WsClientMessage extends ZodOutput
    ? true
    : never
  : never;
const _typeCheck: _AssertZodMatchesTs = true as _AssertZodMatchesTs;
void _typeCheck;

export type WsValidationResult = { ok: true; message: WsClientMessage } | { ok: false; error: string; detail: string };

/**
 * Validate a parsed JSON object as a WsClientMessage.
 *
 * Returns a discriminated result — callers check `.ok` before accessing `.message`.
 */
export function validateWsMessage(raw: unknown): WsValidationResult {
  const result = WsClientMessageSchema.safeParse(raw);
  if (result.success) {
    // W7-T06: Safe — compile-time assertion above proves ZodOutput === WsClientMessage
    return { ok: true, message: result.data };
  }
  const firstIssue = result.error.issues[0];
  const path = firstIssue?.path.join(".") || "root";
  const detail = firstIssue?.message ?? "Invalid message";
  return {
    ok: false,
    error: `Invalid message format at "${path}"`,
    detail: `WS validation failed at "${path}": ${detail}`,
  };
}
