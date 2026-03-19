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
  lastMessageId: z.number().int().nonnegative().optional(),
});

const WsMessageSchema = z.object({
  type: z.literal("message"),
  content: z.string().min(1),
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

export type WsValidationResult = { ok: true; message: WsClientMessage } | { ok: false; error: string; detail: string };

/**
 * Validate a parsed JSON object as a WsClientMessage.
 *
 * Returns a discriminated result — callers check `.ok` before accessing `.message`.
 */
export function validateWsMessage(raw: unknown): WsValidationResult {
  const result = WsClientMessageSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, message: result.data as WsClientMessage };
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
