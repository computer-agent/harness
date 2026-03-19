/**
 * WebSocket client message schema validation (W6-T05).
 *
 * The Zod schema is the single source of truth for client→server message types.
 * The TypeScript type `WsClientMessage` is derived from the schema via `z.infer<>`,
 * so adding a field to the schema automatically updates the TS type — no drift possible.
 *
 * W8-T07: Replaced bidirectional assertion (W7-T06) with Zod-derived type.
 */

import { z } from "zod";

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

export const WsClientMessageSchema = z.discriminatedUnion("type", [
  WsSubscribeSchema,
  WsMessageSchema,
  WsInterruptSchema,
  WsPingSchema,
  WsToolApprovalResponseSchema,
  WsConsentGrantedSchema,
]);

/**
 * W8-T07: WsClientMessage derived from Zod schema — single source of truth.
 * Adding or changing fields in the schema above automatically updates this type.
 */
export type WsClientMessage = z.infer<typeof WsClientMessageSchema>;

export type WsValidationResult = { ok: true; message: WsClientMessage } | { ok: false; error: string; detail: string };

/**
 * Validate a parsed JSON object as a WsClientMessage.
 *
 * Returns a discriminated result — callers check `.ok` before accessing `.message`.
 */
export function validateWsMessage(raw: unknown): WsValidationResult {
  const result = WsClientMessageSchema.safeParse(raw);
  if (result.success) {
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
