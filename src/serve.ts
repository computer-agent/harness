import { readFileSync } from "node:fs";
import { join } from "node:path";
import fastifyCors from "@fastify/cors";
import fastifyRateLimit from "@fastify/rate-limit";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import {
  type AccessConfig,
  type AccessUser,
  authenticateRequest,
  filterAgentsForUser,
  hashToken,
  loadAccessConfig,
  lookupUser,
  safeCompare,
  userCanAccessAgent,
} from "./access.js";
import { type AgentContext, getAgentsDir, listAgents, resolveAgent, resolveRemoteAgent } from "./agent-context.js";
import { getConfigPath, getHomeDir, type HarnessConfig, loadConfig } from "./config.js";
import { CostTracker } from "./cost.js";
import { classifyError } from "./errors.js";
import { HealthMonitor } from "./health.js";
import {
  ALLOWED_FRAME_TYPES,
  type IpcResultMessage,
  type WorkerConfig,
  type WorkerToParentMessage,
} from "./ipc-protocol.js";
import { Logger } from "./logger.js";
import type { AgentManifest } from "./manifest.js";
import { MessageBuffer } from "./message-buffer.js";
import { appendMessage, loadMessages, type PersistedMessage } from "./message-store.js";
import {
  checkConsent,
  DEFAULT_PRIVACY_CONFIG,
  deleteUserData,
  exportUserData,
  type PrivacyConfig,
  privacyDisclosure,
  recordConsent,
  runRetentionCleanup,
} from "./privacy.js";
import { MutexTimeoutError, QueryMutex } from "./query-mutex.js";
import { RateLimiter } from "./rate-limit.js";
import {
  createSessionMeta,
  deleteSession,
  listSessions,
  type SessionDirs,
  saveSession,
  touchSession,
} from "./sessions.js";
import type { WsAssistantMessage, WsToken, WsToolUseStart } from "./types/ws.js";
import { UsageTracker } from "./usage.js";
import { FileWatcher } from "./watcher.js";
import { WorkerManager } from "./worker-manager.js";
import { validateWsMessage } from "./ws-protocol.js";

const PKG_VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

export interface ServeOptions {
  port: number;
  host: string;
  config: HarnessConfig;
  access: AccessConfig;
}

// ─── WebSocket safe-send helper (W7-T10) ───

/**
 * Wraps `ws.send(JSON.stringify(data))` in a try/catch.
 * Prevents cascading throws on closed sockets in post-processing,
 * error paths, and approval cleanup.
 */
function safeSend(ws: WebSocket, data: unknown): boolean {
  try {
    ws.send(JSON.stringify(data));
    return true;
  } catch {
    // Socket already closed — nothing we can do
    return false;
  }
}

// ─── Worker config subset (W7-T11) ───

/** Extract only the config fields the worker process needs. */
function toWorkerConfig(config: HarnessConfig): WorkerConfig {
  return {
    model: config.model,
    effort: config.effort,
    tools: config.tools,
    hooks: config.hooks,
    serve: config.serve?.logging ? { logging: config.serve.logging } : undefined,
  };
}

// ─── Health tracking counters ───

let activeSessionCount = 0;
let activeConnectionCount = 0;

// ─── Active conversation state ───

interface ActiveConversation {
  agentId: string;
  agentContext: AgentContext;
  sessionId: string | null;
  sdkSessionConfirmed: boolean; // true after SDK init event confirms the session
  workerKey: string; // W5-T03: key for the session worker process
  messageBuffer: MessageBuffer;
  user: AccessUser;
  pendingApprovals: Map<string, (approved: boolean) => void>;
}

// ─── Global conversation buffer store ───
// Keyed by `{agentId}:{sessionId}:{userName}`

const conversationBuffers = new Map<string, { buffer: MessageBuffer; lastActivity: number }>();
const BUFFER_TTL_MS = 30 * 60 * 1000; // 30 minutes
const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

function bufferKey(agentId: string, sessionId: string, userName: string): string {
  return `${agentId}:${sessionId}:${userName}`;
}

function getOrCreateBuffer(agentId: string, sessionId: string, userName: string): MessageBuffer {
  const key = bufferKey(agentId, sessionId, userName);
  const existing = conversationBuffers.get(key);
  if (existing) {
    existing.lastActivity = Date.now();
    return existing.buffer;
  }
  const buffer = new MessageBuffer(1000);
  conversationBuffers.set(key, { buffer, lastActivity: Date.now() });
  return buffer;
}

function sweepStaleBuffers(): void {
  const now = Date.now();
  for (const [key, entry] of conversationBuffers) {
    if (now - entry.lastActivity > BUFFER_TTL_MS) {
      conversationBuffers.delete(key);
    }
  }
}

// ─── Helpers ───

function resolveAgentSafe(name: string): AgentContext | null {
  try {
    return resolveAgent(name);
  } catch {
    return null;
  }
}

function sessionDirsForUser(ctx: AgentContext, user: AccessUser): SessionDirs {
  const sessionsDir = join(ctx.stateDir, "sessions", user.name);
  const lastSessionFile = join(ctx.stateDir, `last-session-${user.name}`);
  return { sessionsDir, lastSessionFile };
}

interface AgentApiResponse {
  id: string;
  name: string;
  description: string;
  icon?: string;
  tags: string[];
  starters: string[];
}

function agentToApiResponse(agent: AgentManifest): AgentApiResponse {
  return {
    id: agent.id,
    name: agent.displayName,
    description: agent.description,
    icon: agent.frontmatter.icon ?? undefined,
    tags: agent.frontmatter.tags,
    starters: agent.frontmatter.starters,
  };
}

interface WsTokenResult {
  token: string;
  source: "query" | "header" | "protocol";
}

function extractWsToken(request: FastifyRequest): WsTokenResult | null {
  // 1. Query parameter (deprecated — W4-T06)
  const queryToken = (request.query as Record<string, string>).token;
  if (queryToken) return { token: queryToken, source: "query" };

  // 2. Authorization header (preferred)
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) return { token: authHeader.slice(7), source: "header" };

  // 3. Protocol header (for browsers that can't set custom headers on WS)
  const protocols = request.headers["sec-websocket-protocol"];
  if (protocols) {
    const parts = (typeof protocols === "string" ? protocols : protocols[0]).split(",").map((s) => s.trim());
    const tokenProto = parts.find((p) => p.startsWith("token."));
    if (tokenProto) return { token: tokenProto.slice(6), source: "protocol" };
  }

  return null;
}

// ─── Connected WebSocket clients (for broadcasting) ───

// W4-T07: Store token hash, not raw token — no raw credentials in memory after auth
const connectedClients = new Map<WebSocket, { user: AccessUser; tokenHash: string }>();

// ─── Route registration ───

function registerHealthRoutes(app: FastifyInstance, opts: ServeOptions, healthMonitor: HealthMonitor, _logger: Logger) {
  // Shallow health — no auth, fast
  app.get("/health", async (_request, reply) => {
    const health = healthMonitor.shallowCheck();
    if (health.status === "shutting_down") {
      return reply.code(503).send(health);
    }
    return health;
  });

  // Deep health — admin auth required, cached 30s
  app.get("/health/deep", async (request, reply) => {
    const user = authenticateRequest(request as any, opts.access);
    if (!user) return reply.code(401).send({ error: "Invalid or missing token" });
    if (user.agents !== "*") return reply.code(403).send({ error: "Admin access required" });

    const health = await healthMonitor.deepCheck();
    return health;
  });
}

function registerAgentRoutes(app: FastifyInstance, opts: ServeOptions, logger: Logger) {
  app.get("/api/agents", async (request, reply) => {
    const user = authenticateRequest(request as any, opts.access);
    if (!user) {
      logger.warn("auth", "auth.failure", "REST auth failed: GET /api/agents");
      return reply.code(401).send({ error: "Invalid or missing token" });
    }

    const allAgents = await listAgents();
    const filtered = filterAgentsForUser(allAgents, user);
    return filtered.map(agentToApiResponse);
  });

  app.get("/api/agents/:id", async (request, reply) => {
    const user = authenticateRequest(request as any, opts.access);
    if (!user) return reply.code(401).send({ error: "Invalid or missing token" });

    const { id } = request.params as { id: string };
    const allAgents = await listAgents();
    const agent = allAgents.find((a) => a.id === id);

    if (!agent) return reply.code(404).send({ error: "Agent not found" });
    if (!userCanAccessAgent(agent, user)) return reply.code(403).send({ error: "Access denied" });

    return agentToApiResponse(agent);
  });
}

function registerSessionRoutes(app: FastifyInstance, opts: ServeOptions) {
  app.get("/api/sessions", async (request, reply) => {
    const user = authenticateRequest(request as any, opts.access);
    if (!user) return reply.code(401).send({ error: "Invalid or missing token" });

    const agentId = (request.query as Record<string, string>).agent;
    if (!agentId) return reply.code(400).send({ error: "agent query parameter required" });

    const agentCtx = resolveAgentSafe(agentId);
    if (!agentCtx) return reply.code(404).send({ error: "Agent not found" });

    const sessionDirs = sessionDirsForUser(agentCtx, user);
    const sessions = await listSessions(sessionDirs);
    return sessions;
  });

  app.post("/api/sessions", async (request, reply) => {
    const user = authenticateRequest(request as any, opts.access);
    if (!user) return reply.code(401).send({ error: "Invalid or missing token" });

    const { agent } = (request.body as { agent?: string }) ?? {};
    if (!agent) return reply.code(400).send({ error: "agent field required" });

    const agentCtx = resolveAgentSafe(agent);
    if (!agentCtx) return reply.code(404).send({ error: "Agent not found" });

    const sessionDirs = sessionDirsForUser(agentCtx, user);
    const meta = createSessionMeta(crypto.randomUUID(), "(new conversation)");
    await saveSession(sessionDirs, meta);
    return reply.code(201).send(meta);
  });

  app.get("/api/sessions/:id/messages", async (request, reply) => {
    const user = authenticateRequest(request as any, opts.access);
    if (!user) return reply.code(401).send({ error: "Invalid or missing token" });

    const { id } = request.params as { id: string };
    const agentId = (request.query as Record<string, string>).agent;
    if (!agentId) return reply.code(400).send({ error: "agent query parameter required" });

    const agentCtx = resolveAgentSafe(agentId);
    if (!agentCtx) return reply.code(404).send({ error: "Agent not found" });

    const sessionDirs = sessionDirsForUser(agentCtx, user);
    const messages = await loadMessages(sessionDirs, id);
    return messages;
  });

  app.delete("/api/sessions/:id", async (request, reply) => {
    const user = authenticateRequest(request as any, opts.access);
    if (!user) return reply.code(401).send({ error: "Invalid or missing token" });

    const { id } = request.params as { id: string };
    const agentId = (request.query as Record<string, string>).agent;
    if (!agentId) return reply.code(400).send({ error: "agent query parameter required" });

    const agentCtx = resolveAgentSafe(agentId);
    if (!agentCtx) return reply.code(404).send({ error: "Agent not found" });

    const sessionDirs = sessionDirsForUser(agentCtx, user);
    await deleteSession(sessionDirs, id);
    return { deleted: true };
  });
}

function registerUsageRoutes(
  app: FastifyInstance,
  opts: ServeOptions,
  usageTracker: UsageTracker,
  costTracker: CostTracker,
) {
  app.get("/api/usage", async (request, reply) => {
    const user = authenticateRequest(request as any, opts.access);
    if (!user) return reply.code(401).send({ error: "Invalid or missing token" });

    const userUsage = costTracker.getUserUsage(user.name);
    const budget = costTracker.getBudget(user.name);

    // Everyone can see their own usage
    const result: Record<string, unknown> = {
      usage: userUsage,
      budget: {
        sessionLimit: budget.sessionLimit === Infinity ? "unlimited" : budget.sessionLimit,
        dailyLimit: budget.dailyLimit === Infinity ? "unlimited" : budget.dailyLimit,
        monthlyLimit: budget.monthlyLimit === Infinity ? "unlimited" : budget.monthlyLimit,
      },
    };

    // Operators get the full summary
    if (user.agents === "*") {
      result.summary = usageTracker.summarizeByUser();
      result.sessions = usageTracker.allSessions();
    }

    return result;
  });
}

function registerAdminRoutes(app: FastifyInstance, opts: ServeOptions, costTracker: CostTracker, logger: Logger) {
  app.post("/api/admin/users/:id/budget/reset", async (request, reply) => {
    const user = authenticateRequest(request as any, opts.access);
    if (!user) return reply.code(401).send({ error: "Invalid or missing token" });
    if (user.agents !== "*") return reply.code(403).send({ error: "Admin access required" });

    const { id } = request.params as { id: string };
    const { scope } = (request.body as { scope?: string }) ?? {};
    const validScopes = ["session", "daily", "monthly", "all"] as const;
    const resetScope = validScopes.includes(scope as (typeof validScopes)[number])
      ? (scope as "session" | "daily" | "monthly" | "all")
      : "all";

    costTracker.resetBudget(id, resetScope);
    logger.info("cost", "cost.reset", `Budget reset for user ${id}`, {
      details: { userId: id, scope: resetScope },
    });
    return { reset: true, userId: id, scope: resetScope };
  });
}

function registerPrivacyRoutes(app: FastifyInstance, opts: ServeOptions, logger: Logger) {
  // Privacy disclosure — no auth required
  app.get("/api/privacy", async () => {
    const privacyConfig = opts.config.serve?.privacy ?? DEFAULT_PRIVACY_CONFIG;
    return privacyDisclosure(privacyConfig.policyVersion ?? DEFAULT_PRIVACY_CONFIG.policyVersion);
  });

  // Data export — self or admin
  app.get("/api/users/:userId/data", async (request, reply) => {
    const user = authenticateRequest(request as any, opts.access);
    if (!user) return reply.code(401).send({ error: "Invalid or missing token" });

    const { userId } = request.params as { userId: string };

    // Self or admin access
    if (user.name !== userId && user.agents !== "*") {
      return reply.code(403).send({ error: "Access denied" });
    }

    try {
      const zipBuffer = await exportUserData(userId);
      if (zipBuffer.length === 0) {
        return reply.code(404).send({ error: "No data found for user" });
      }

      logger.info("server", "privacy.export", `Data exported for user ${userId}`, {
        details: { userId, requestedBy: user.name },
      });

      return reply
        .type("application/zip")
        .header("Content-Disposition", `attachment; filename="export-${userId}.zip"`)
        .send(zipBuffer);
    } catch (err) {
      logger.error("server", "privacy.export_failed", `Data export failed: ${err}`);
      return reply.code(500).send({ error: "Export failed" });
    }
  });

  // Data deletion — admin only
  app.delete("/api/users/:userId/data", async (request, reply) => {
    const user = authenticateRequest(request as any, opts.access);
    if (!user) return reply.code(401).send({ error: "Invalid or missing token" });
    if (user.agents !== "*") return reply.code(403).send({ error: "Admin access required" });

    const { userId } = request.params as { userId: string };

    try {
      const report = await deleteUserData(userId);

      // Check if anything was actually deleted
      const { deleted } = report;
      const totalDeleted =
        deleted.sessions +
        deleted.memoryFiles +
        deleted.workspaceFiles +
        (deleted.usageFile ? 1 : 0) +
        (deleted.consentFile ? 1 : 0);

      if (totalDeleted === 0) {
        return reply.code(404).send({ error: "No data found for user" });
      }

      logger.info("server", "privacy.deletion", `Data deleted for user ${userId}`, {
        details: { userId, requestedBy: user.name, report: report.deleted },
      });

      return report;
    } catch (err) {
      logger.error("server", "privacy.deletion_failed", `Data deletion failed: ${err}`);
      return reply.code(500).send({ error: "Deletion failed" });
    }
  });
}

// ─── WebSocket handler ───

async function handleSubscribe(
  ws: WebSocket,
  msg: { agentId: string; sessionId?: string; lastMessageId?: number },
  user: AccessUser,
  config: HarnessConfig,
): Promise<ActiveConversation | null> {
  const allAgents = await listAgents();
  const agent = allAgents.find((a) => a.id === msg.agentId);
  if (!agent) {
    ws.send(JSON.stringify({ type: "error", code: "agent_not_found", message: `Agent "${msg.agentId}" not found` }));
    return null;
  }
  if (!userCanAccessAgent(agent, user)) {
    ws.send(JSON.stringify({ type: "error", code: "access_denied", message: "Access denied" }));
    return null;
  }

  // Check consent before creating conversation
  const privacyConfig = config.serve?.privacy ?? DEFAULT_PRIVACY_CONFIG;
  const policyVersion = privacyConfig.policyVersion ?? DEFAULT_PRIVACY_CONFIG.policyVersion;
  const hasConsent = await checkConsent(user.name, policyVersion);
  if (!hasConsent) {
    ws.send(
      JSON.stringify({
        type: "consent_required",
        policyVersion,
      }),
    );
    return null;
  }

  const agentContext = resolveRemoteAgent(msg.agentId, user.name);
  const sessionId = msg.sessionId ?? null;

  // Get or create a message buffer for this conversation
  const messageBuffer = sessionId ? getOrCreateBuffer(msg.agentId, sessionId, user.name) : new MessageBuffer(1000);

  // W5-T03: Worker key uniquely identifies this conversation's worker process
  const workerKey = `${msg.agentId}:${user.name}:${crypto.randomUUID()}`;

  const conversation: ActiveConversation = {
    agentId: msg.agentId,
    agentContext,
    sessionId,
    sdkSessionConfirmed: !!sessionId, // true if subscribing with an existing session ID (from a prior SDK session)
    workerKey,
    messageBuffer,
    user,
    pendingApprovals: new Map(),
  };

  // Replay buffered messages if reconnecting
  if (msg.lastMessageId !== undefined && sessionId) {
    const missed = messageBuffer.since(msg.lastMessageId);
    if (missed.length > 0) {
      ws.send(JSON.stringify({ type: "replay", messages: missed }));
    }
  }

  ws.send(
    JSON.stringify({
      type: "subscribed",
      agentId: msg.agentId,
      sessionId: sessionId ?? "(new)",
      agentName: agent.displayName,
      agentDescription: agent.description,
    }),
  );

  return conversation;
}

async function handleMessage(
  ws: WebSocket,
  msg: { content: string },
  conversation: ActiveConversation,
  config: HarnessConfig,
  usageTracker: UsageTracker,
  costTracker: CostTracker,
  workerManager: WorkerManager,
  queryMutex: QueryMutex,
  logger: Logger,
): Promise<void> {
  const { agentContext, user, workerKey } = conversation;

  // W5-T06: Per-user concurrent query mutex — prevents two messages from running simultaneously
  // W6-T03: 5-minute timeout prevents permanent lockout from stuck workers
  const mutexKey = `${conversation.agentId}:${user.name}`;
  const release = await queryMutex.acquire(mutexKey, 5 * 60 * 1000);

  try {
    safeSend(ws, { type: "status", status: "thinking" });

    let userMessagePersisted = false;

    const persistUserMessage = async () => {
      if (userMessagePersisted || !conversation.sessionId) return;
      userMessagePersisted = true;
      const sessionDirs = sessionDirsForUser(agentContext, user);
      const userMsg: PersistedMessage = {
        role: "user",
        content: msg.content,
        timestamp: new Date().toISOString(),
      };
      await appendMessage(sessionDirs, conversation.sessionId, userMsg);
    };

    // If resuming an existing session, persist user message immediately
    if (conversation.sdkSessionConfirmed && conversation.sessionId) {
      await persistUserMessage();
    }

    // W5-T03: Dispatch to session worker via IPC instead of in-process SDK query
    const result = await new Promise<IpcResultMessage>((resolveResult, rejectResult) => {
      // Handler for messages from the worker — relays frames to WS, captures session/result
      const workerMessageHandler = async (workerMsg: WorkerToParentMessage) => {
        try {
          switch (workerMsg.type) {
            case "ready":
              // Worker initialized — send the user message
              workerManager.sendToWorker(workerKey, {
                type: "message",
                content: msg.content,
                resumeSessionId: conversation.sdkSessionConfirmed ? (conversation.sessionId ?? undefined) : undefined,
              });
              break;

            case "frame": {
              // F2: Validate frame type against allowlist before relaying to WebSocket.
              // A compromised worker could inject arbitrary JSON — only relay known frame types.
              // W7-T08: ALLOWED_FRAME_TYPES now lives in ipc-protocol.ts at module scope.
              const frame = workerMsg.frame;
              if (!frame.type || !ALLOWED_FRAME_TYPES.has(frame.type as string)) {
                logger.warn("session", "worker.frame_rejected", `Rejected unknown frame type: ${frame.type}`, {
                  details: { workerKey },
                });
                break;
              }
              // W7-T09: Narrowed types replace the `as any` cast — frame shape
              // is validated by ALLOWED_FRAME_TYPES, and only bufferable types are pushed.
              if (frame.type === "token" || frame.type === "tool_use_start") {
                conversation.messageBuffer.push(frame as unknown as WsToken | WsToolUseStart);
              }
              safeSend(ws, frame);
              break;
            }

            case "session_id": {
              const oldSessionId = conversation.sessionId;
              conversation.sessionId = workerMsg.sessionId;
              conversation.sdkSessionConfirmed = true;
              // Delete orphaned buffer entry
              if (oldSessionId && oldSessionId !== workerMsg.sessionId) {
                const oldBufKey = bufferKey(conversation.agentId, oldSessionId, user.name);
                conversationBuffers.delete(oldBufKey);
              }
              // Register buffer under real session ID
              const bKey = bufferKey(conversation.agentId, workerMsg.sessionId, user.name);
              if (!conversationBuffers.has(bKey)) {
                conversationBuffers.set(bKey, {
                  buffer: conversation.messageBuffer,
                  lastActivity: Date.now(),
                });
              }
              // Save session metadata
              const sessionDirs = sessionDirsForUser(agentContext, user);
              const meta = createSessionMeta(workerMsg.sessionId, workerMsg.firstMessage);
              await saveSession(sessionDirs, meta);
              await persistUserMessage();
              break;
            }

            case "tool_approval_request":
              // Store resolver that sends IPC response back to worker
              conversation.pendingApprovals.set(workerMsg.toolId, (approved: boolean) => {
                workerManager.sendToWorker(workerKey, {
                  type: "tool_approval_response",
                  toolId: workerMsg.toolId,
                  approved,
                });
              });
              safeSend(ws, {
                type: "tool_approval",
                toolId: workerMsg.toolId,
                toolName: workerMsg.toolName,
                toolInput: workerMsg.toolInput,
                question: `Allow ${workerMsg.toolName}?`,
              });
              break;

            case "result":
              safeResolve(workerMsg);
              break;

            case "error":
              // W6-T02: Worker errors (especially init_failed) must settle the promise
              // so the exit handler's safeReject is a no-op — prevents double error to client.
              safeSend(ws, {
                type: "error",
                code: workerMsg.code,
                message: workerMsg.message,
              });
              safeReject(new Error(`Worker error [${workerMsg.code}]: ${workerMsg.message}`));
              break;
            default: {
              // Exhaustive check — adding a new WorkerToParentMessage type without
              // handling it here causes a compile error.
              const _exhaustive: never = workerMsg;
              void _exhaustive;
            }
          }
        } catch (err) {
          logger.error("session", "worker.handler_error", `Worker message handler error: ${err}`, {
            details: { workerKey },
          });
        }
      };

      // P0-1 fix: Worker exit must ALWAYS settle the promise, even for code 0.
      // Otherwise the QueryMutex is permanently locked for this user/agent.
      let settled = false;
      const safeResolve = (msg: IpcResultMessage) => {
        if (!settled) {
          settled = true;
          resolveResult(msg);
        }
      };
      const safeReject = (err: Error) => {
        if (!settled) {
          settled = true;
          rejectResult(err);
        }
      };

      const workerExitHandler = (code: number | null, signal: string | null) => {
        // W6-T07: Clear pending approvals on worker crash — reject each with a denial
        // so the client doesn't show stale approval prompts.
        if (conversation.pendingApprovals.size > 0) {
          for (const [toolId, resolver] of conversation.pendingApprovals) {
            resolver(false); // deny
            safeSend(ws, {
              type: "tool_approval_rejected",
              toolId,
              reason: "Worker process exited",
            });
          }
          conversation.pendingApprovals.clear();
        }
        safeReject(new Error(`Worker exited: code=${code} signal=${signal}`));
      };

      // Spawn worker if needed, otherwise update handler and send message directly
      if (!workerManager.has(workerKey)) {
        workerManager.spawn(
          workerKey,
          conversation.agentId,
          user.name,
          JSON.stringify(toWorkerConfig(config)),
          user.toolsDeny,
          workerMessageHandler,
          workerExitHandler,
        );
        // Worker will send "ready" → handler sends the "message" IPC
      } else {
        // Worker already alive from a previous message — update handler and send directly
        workerManager.updateHandler(workerKey, workerMessageHandler);
        workerManager.updateExitHandler(workerKey, workerExitHandler);
        workerManager.sendToWorker(workerKey, {
          type: "message",
          content: msg.content,
          resumeSessionId: conversation.sdkSessionConfirmed ? (conversation.sessionId ?? undefined) : undefined,
        });
      }
    });

    // === Post-processing: persistence, cost tracking, result frame ===

    if (result.responseContent) {
      const frame: WsAssistantMessage = {
        type: "assistant_message",
        id: conversation.messageBuffer.nextId(),
        content: result.responseContent,
        usage: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          cacheReadTokens: result.usage.cacheReadTokens,
          cacheCreationTokens: result.usage.cacheCreationTokens,
        },
      };
      conversation.messageBuffer.push(frame);
      safeSend(ws, frame);

      // Persist assistant message
      if (conversation.sessionId) {
        const sessionDirs = sessionDirsForUser(agentContext, user);
        const assistantMsg: PersistedMessage = {
          role: "assistant",
          content: result.responseContent,
          timestamp: new Date().toISOString(),
          ...(result.toolCalls.length > 0 ? { toolCalls: result.toolCalls } : {}),
        };
        await appendMessage(sessionDirs, conversation.sessionId, assistantMsg);
      }
    }

    // Record usage
    if (conversation.sessionId) {
      usageTracker.recordTurn(conversation.sessionId, conversation.agentId, user.name, result.usage);
      costTracker.recordUsage(user.name, conversation.sessionId, result.usage.inputTokens, result.usage.outputTokens);
      const postBudget = costTracker.checkBudget(user.name, conversation.sessionId);
      if (postBudget.warnings.length > 0) {
        safeSend(ws, { type: "budget_warning", warnings: postBudget.warnings });
      }
      if (!postBudget.allowed && postBudget.exceeded) {
        safeSend(ws, {
          type: "budget_exceeded",
          reason: postBudget.exceeded.budget,
          limit: postBudget.exceeded.limit,
          used: postBudget.exceeded.used,
          resetsAt: postBudget.exceeded.resetsAt,
        });
      }
    }

    // Final result frame
    safeSend(ws, {
      type: "result",
      sessionId: conversation.sessionId,
      interrupted: result.interrupted,
      usage: {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      },
    });

    safeSend(ws, {
      type: "status",
      status: result.interrupted ? "interrupted" : "idle",
    });

    // Touch session
    if (conversation.sessionId) {
      const sessionDirs = sessionDirsForUser(agentContext, user);
      await touchSession(sessionDirs, conversation.sessionId);
    }
  } catch (err) {
    // Best-effort persist user message on error
    if (conversation.sessionId) {
      try {
        const sessionDirs = sessionDirsForUser(agentContext, user);
        await appendMessage(sessionDirs, conversation.sessionId, {
          role: "user",
          content: msg.content,
          timestamp: new Date().toISOString(),
        });
      } catch {
        // Best effort
      }
    }
    // W6: MutexTimeoutError → specific "busy" code so client can retry
    if (err instanceof MutexTimeoutError) {
      safeSend(ws, {
        type: "error",
        code: "busy",
        message: "Agent is busy processing another request. Please try again.",
      });
    } else {
      const classified = classifyError(err);
      safeSend(ws, {
        type: "error",
        code: classified.category,
        message: classified.message,
      });
    }
  } finally {
    release();
  }
}

function registerWebSocketRoute(
  app: FastifyInstance,
  opts: ServeOptions,
  usageTracker: UsageTracker,
  logger: Logger,
  rateLimiter: RateLimiter,
  costTracker: CostTracker,
  workerManager: WorkerManager,
  queryMutex: QueryMutex,
) {
  app.register(async (fastify) => {
    fastify.get("/ws", { websocket: true }, (socket, request) => {
      const ws = socket as unknown as WebSocket;
      const connectionId = crypto.randomUUID();

      const clientIp = request.ip ?? "unknown";

      // Auth: read token from query param or headers
      const tokenResult = extractWsToken(request);
      const user = tokenResult ? lookupUser(tokenResult.token, opts.access) : null;
      if (!tokenResult || !user) {
        // Rate limit auth failures per IP
        if (!rateLimiter.checkAuthFailure(clientIp)) {
          logger.warn("auth", "auth.failure", "Auth failure rate limited", {
            details: { connectionId, ip: clientIp },
          });
          ws.close(4001, "Too many auth failures");
          return;
        }
        logger.warn("auth", "auth.failure", "WebSocket auth failed", {
          details: { connectionId },
        });
        ws.send(JSON.stringify({ type: "error", code: "auth_failed", message: "Invalid token" }));
        ws.close(4001, "Unauthorized");
        return;
      }

      // W4-T06: Deprecate query param token — warn client and log
      if (tokenResult.source === "query") {
        logger.warn(
          "auth",
          "auth.deprecated",
          "WS token via query param is deprecated — use Authorization header or Sec-WebSocket-Protocol",
          {
            details: { userId: user.name, connectionId },
          },
        );
        ws.send(
          JSON.stringify({
            type: "warning",
            code: "token_query_deprecated",
            message:
              "Passing token as query parameter is deprecated. Use the Authorization header or Sec-WebSocket-Protocol instead.",
          }),
        );
      }

      // Connection limit per user
      if (!rateLimiter.addConnection(user.name)) {
        logger.warn("session", "session.created", "Connection limit exceeded", {
          details: { userId: user.name, connectionId },
        });
        ws.send(JSON.stringify({ type: "error", code: "rate_limited", message: "Too many connections" }));
        ws.close(4008, "Connection limit exceeded");
        return;
      }

      logger.info("auth", "auth.success", `User authenticated: ${user.name}`, {
        details: { userId: user.name, connectionId },
      });

      activeConnectionCount++;

      // Track connected client for broadcasting and token revocation
      // W4-T07: Store hash, not raw token — prevents credential leaks from memory dumps
      connectedClients.set(ws, { user, tokenHash: hashToken(tokenResult.token) });

      ws.send(JSON.stringify({ type: "connected", connectionId }));

      // Idle timeout — disconnect if no messages received
      let idleTimer = setTimeout(() => {
        logger.info("session", "session.ended", "WebSocket idle timeout", {
          details: { userId: user.name, connectionId },
        });
        ws.close(4009, "Idle timeout");
      }, rateLimiter.idleTimeoutMs);

      let activeConversation: ActiveConversation | null = null;

      ws.on("message", async (raw: Buffer) => {
        // Reset idle timer on any message
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          ws.close(4009, "Idle timeout");
        }, rateLimiter.idleTimeoutMs);

        // Reject oversized messages
        if (raw.length > 1024 * 1024) {
          ws.send(JSON.stringify({ type: "error", code: "message_too_large", message: "Message exceeds 1MB" }));
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString());
        } catch {
          ws.send(JSON.stringify({ type: "error", code: "parse_error", message: "Invalid JSON" }));
          return;
        }

        // W6-T05: Validate WS message against Zod schema before processing
        const validated = validateWsMessage(parsed);
        if (!validated.ok) {
          logger.warn("session", "ws.invalid_message", validated.detail, {
            details: { connectionId, userId: user.name },
          });
          ws.send(JSON.stringify({ type: "error", code: "invalid_message", message: validated.error }));
          return;
        }
        const msg = validated.message;

        try {
          switch (msg.type) {
            case "subscribe": {
              const prev = activeConversation;
              // F1 fix: Kill previous worker before re-subscribing
              if (prev) {
                workerManager.kill(prev.workerKey);
              }
              activeConversation = await handleSubscribe(ws, msg, user, opts.config);
              if (activeConversation && !prev) {
                activeSessionCount++;
              }
              break;
            }
            case "message": {
              if (!activeConversation) {
                ws.send(JSON.stringify({ type: "error", code: "not_subscribed", message: "Subscribe first" }));
                return;
              }
              // Message length check
              if (!rateLimiter.checkMessageLength(msg.content)) {
                ws.send(
                  JSON.stringify({
                    type: "error",
                    code: "message_too_large",
                    message: "Message exceeds character limit",
                  }),
                );
                return;
              }
              // Per-user message rate limiting
              const rateCheck = rateLimiter.checkMessageRate(user.name);
              if (!rateCheck.allowed) {
                ws.send(
                  JSON.stringify({
                    type: "error",
                    code: "rate_limited",
                    message: "Too many messages",
                    retryAfter: rateCheck.retryAfter,
                  }),
                );
                return;
              }
              // Pre-flight budget check
              const budgetCheck = costTracker.checkBudget(user.name, activeConversation.sessionId ?? "");
              if (!budgetCheck.allowed && budgetCheck.exceeded) {
                ws.send(
                  JSON.stringify({
                    type: "budget_exceeded",
                    reason: budgetCheck.exceeded.budget,
                    limit: budgetCheck.exceeded.limit,
                    used: budgetCheck.exceeded.used,
                    resetsAt: budgetCheck.exceeded.resetsAt,
                  }),
                );
                return;
              }
              await handleMessage(
                ws,
                msg,
                activeConversation,
                opts.config,
                usageTracker,
                costTracker,
                workerManager,
                queryMutex,
                logger,
              );
              break;
            }
            case "ping":
              ws.send(JSON.stringify({ type: "pong" }));
              break;
            case "tool_approval":
              if (activeConversation?.pendingApprovals) {
                const resolver = activeConversation.pendingApprovals.get(msg.toolId);
                if (resolver) {
                  resolver(msg.approved);
                  activeConversation.pendingApprovals.delete(msg.toolId);
                }
              }
              break;
            case "consent_granted": {
              await recordConsent(user.name, msg.policyVersion);
              ws.send(JSON.stringify({ type: "status", status: "idle" }));
              break;
            }
            case "interrupt":
              if (activeConversation) {
                workerManager.sendToWorker(activeConversation.workerKey, { type: "interrupt" });
              }
              break;
          }
        } catch (err) {
          const classified = classifyError(err);
          safeSend(ws, {
            type: "error",
            code: classified.category,
            message: classified.message,
          });
        }
      });

      ws.on("close", () => {
        clearTimeout(idleTimer);
        activeConnectionCount--;
        connectedClients.delete(ws);
        if (activeConversation) {
          activeSessionCount--;
          // W5-T03: Kill the session worker when the WebSocket disconnects
          workerManager.kill(activeConversation.workerKey);
        }
        rateLimiter.removeConnection(user.name);
      });
    });
  });
}

// ─── Server startup ───

export async function startServer(opts: ServeOptions): Promise<void> {
  const app = Fastify({ logger: true, bodyLimit: 1024 * 1024 }); // 1MB body limit
  const usageTracker = new UsageTracker();
  const rateLimiter = new RateLimiter(opts.config.serve?.rateLimits);
  const logger = new Logger(opts.config.serve?.logging?.level ?? "info");

  // Cost tracking: restore persisted data and sync budgets from access config
  const costTracker = new CostTracker();
  await costTracker.restore();
  costTracker.startPersistence();
  for (const entry of opts.access.users) {
    costTracker.setBudget(entry.name, entry.budget);
  }

  logger.info("server", "server.started", "Serve mode started", {
    details: { port: opts.port, host: opts.host },
  });

  // CORS: validate origins against an allowlist.
  // ALLOWED_ORIGINS env var: comma-separated list (e.g. "https://app.example.com,https://staging.example.com")
  // If unset (dev mode), allow any localhost origin.
  const allowedOriginsEnv = process.env.ALLOWED_ORIGINS;
  const allowedOrigins = allowedOriginsEnv
    ? allowedOriginsEnv
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean)
    : null; // null = dev mode (allow localhost)

  await app.register(fastifyCors, {
    origin: (origin, callback) => {
      // Allow requests with no origin (same-origin, curl, non-browser clients)
      if (!origin) return callback(null, true);

      if (allowedOrigins) {
        // Production: check against explicit allowlist
        if (allowedOrigins.includes(origin)) return callback(null, true);
      } else {
        // Dev mode: allow any localhost/127.0.0.1 origin (any port)
        if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return callback(null, true);
      }

      callback(new Error(`Origin ${origin} not allowed by CORS`), false);
    },
    methods: ["GET", "POST", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });
  await app.register(fastifyWebsocket);

  // Rate limiting for HTTP routes (WebSocket has its own rate limiter)
  await app.register(fastifyRateLimit, {
    max: 100,
    timeWindow: "1 minute",
    keyGenerator: (request) => {
      // F5: Hash the token before using as rate limit key — never store raw tokens in memory
      const authHeader = request.headers.authorization;
      if (authHeader?.startsWith("Bearer ")) return hashToken(authHeader.slice(7));
      return request.ip ?? "unknown";
    },
    allowList: (request) => {
      // Don't rate-limit health checks
      return request.url === "/health" || request.url === "/health/deep";
    },
  });

  // W5-T02/T03: Worker manager for process-isolated sessions
  // W6-T08: configurable maxWorkers from config.yaml (default 20)
  const workerManager = new WorkerManager(logger, opts.config.serve?.maxWorkers);
  const queryMutex = new QueryMutex();

  // Health monitoring
  // W6-T09 + W7-T15: Worker pool stats via workerManager.getStats()
  const healthMonitor = new HealthMonitor(
    PKG_VERSION,
    () => activeSessionCount,
    () => activeConnectionCount,
    logger,
    () => workerManager.getStats(),
  );

  // Track error/success rates via Fastify response hook
  app.addHook("onResponse", (_request, reply, done) => {
    if (reply.statusCode >= 400) {
      healthMonitor.recordError();
    } else {
      healthMonitor.recordSuccess();
    }
    done();
  });

  registerHealthRoutes(app, opts, healthMonitor, logger);
  registerAgentRoutes(app, opts, logger);
  registerSessionRoutes(app, opts);
  registerUsageRoutes(app, opts, usageTracker, costTracker);
  registerAdminRoutes(app, opts, costTracker, logger);
  registerPrivacyRoutes(app, opts, logger);
  registerWebSocketRoute(app, opts, usageTracker, logger, rateLimiter, costTracker, workerManager, queryMutex);

  // ─── File watcher for hot reload ───

  const homeDir = getHomeDir();
  const agentsDir = getAgentsDir();
  const configPath = getConfigPath();
  const accessPath = join(homeDir, "access.yaml");

  const watcher = new FileWatcher(
    agentsDir,
    configPath,
    accessPath,
    {
      onRosterChange: async () => {
        try {
          const allAgents = await listAgents();
          // F7: Filter roster per user's access — don't leak agent info to unauthorized users
          for (const [ws, clientInfo] of connectedClients) {
            const filtered = filterAgentsForUser(allAgents, clientInfo.user);
            try {
              ws.send(JSON.stringify({ type: "roster_updated", agents: filtered.map(agentToApiResponse) }));
            } catch {
              // Connection already closed
            }
          }
          logger.info("agent", "roster.reloaded", `Roster reloaded: ${allAgents.length} agents`);
        } catch (err) {
          logger.error("agent", "roster.reload_failed", `Failed to reload roster: ${err}`);
        }
      },
      onConfigChange: async () => {
        try {
          opts.config = loadConfig();
          rateLimiter.updateLimits(opts.config.serve?.rateLimits);
          logger.info("server", "config.reloaded", "Config reloaded");
        } catch (err) {
          logger.error("server", "config.reload_failed", `Failed to reload config: ${err}`);
        }
      },
      onAccessChange: async () => {
        try {
          opts.access = loadAccessConfig();
          // Sync budgets from updated access config
          for (const entry of opts.access.users) {
            costTracker.setBudget(entry.name, entry.budget);
          }
          // W6-T04: Disconnect revoked tokens — timing-safe comparison of stored hash
          for (const [ws, clientInfo] of connectedClients) {
            const stillValid = opts.access.users.some((entry) => safeCompare(entry.tokenHash, clientInfo.tokenHash));
            if (!stillValid) {
              try {
                ws.send(
                  JSON.stringify({ type: "error", code: "token_revoked", message: "Your access has been revoked" }),
                );
                ws.close(4003, "Token revoked");
              } catch {
                // Already closed
              }
            }
          }
          logger.info("auth", "access.reloaded", "Access control reloaded");
        } catch (err) {
          logger.error("auth", "access.reload_failed", `Failed to reload access: ${err}`);
        }
      },
    },
    logger,
  );
  await watcher.start();

  // ─── Admin reload endpoint (manual trigger) ───

  app.post("/api/admin/reload", async (request, reply) => {
    const user = authenticateRequest(request as any, opts.access);
    if (!user) return reply.code(401).send({ error: "Invalid or missing token" });
    if (user.agents !== "*") return reply.code(403).send({ error: "Admin access required" });

    try {
      opts.config = loadConfig();
      rateLimiter.updateLimits(opts.config.serve?.rateLimits);
      opts.access = loadAccessConfig();
      for (const entry of opts.access.users) {
        costTracker.setBudget(entry.name, entry.budget);
      }
      const allAgents = await listAgents();
      // F7: Filter roster per user on broadcast
      for (const [ws, clientInfo] of connectedClients) {
        const filtered = filterAgentsForUser(allAgents, clientInfo.user);
        try {
          ws.send(JSON.stringify({ type: "roster_updated", agents: filtered.map(agentToApiResponse) }));
        } catch {
          // Connection already closed
        }
      }
      logger.info("server", "admin.reload", "Manual reload completed");
      return { reloaded: true, agents: allAgents.length };
    } catch (err) {
      logger.error("server", "admin.reload_failed", `Manual reload failed: ${err}`);
      return reply.code(500).send({ error: "Reload failed" });
    }
  });

  // Periodic sweep of stale message buffers
  const sweepTimer = setInterval(sweepStaleBuffers, SWEEP_INTERVAL_MS);

  // Retention cleanup — run once at startup, then daily
  const privacyConfig: PrivacyConfig = {
    ...DEFAULT_PRIVACY_CONFIG,
    ...opts.config.serve?.privacy,
  };
  runRetentionCleanup(privacyConfig, logger).catch((err) => {
    logger.error("server", "retention.cleanup_failed", `Initial retention cleanup failed: ${err}`);
  });
  const retentionTimer = setInterval(
    () => {
      runRetentionCleanup(privacyConfig, logger).catch((err) => {
        logger.error("server", "retention.cleanup_failed", `Retention cleanup failed: ${err}`);
      });
    },
    24 * 60 * 60 * 1000,
  ); // daily

  // Graceful shutdown with connection draining
  const SHUTDOWN_TIMEOUT_MS = 30_000;

  const shutdown = async () => {
    healthMonitor.setShuttingDown();
    logger.info("server", "server.shutdown", "Graceful shutdown initiated");

    // Stop accepting new work and watching files
    watcher.stop();
    clearInterval(sweepTimer);
    clearInterval(retentionTimer);

    // Wait for active queries to complete (max 30s)
    const drainStart = Date.now();
    const checkDrained = (): boolean => activeSessionCount === 0;

    if (!checkDrained()) {
      logger.info(
        "server",
        "server.draining",
        `Waiting for ${activeSessionCount} active sessions to complete (max ${SHUTDOWN_TIMEOUT_MS / 1000}s)`,
      );

      await new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          if (checkDrained() || Date.now() - drainStart > SHUTDOWN_TIMEOUT_MS) {
            clearInterval(interval);
            resolve();
          }
        }, 500);
      });

      if (!checkDrained()) {
        logger.warn(
          "server",
          "server.drain_timeout",
          `Shutdown timeout: ${activeSessionCount} sessions still active, forcing close`,
        );
      }
    }

    // W5-T02: Kill all session workers before closing connections
    workerManager.killAll();

    // Close all remaining WebSocket connections
    for (const [ws] of connectedClients) {
      try {
        ws.close(1001, "Server shutting down");
      } catch {
        // Already closed
      }
    }

    // Persist state
    costTracker.stopPersistence();
    await costTracker.persist();

    // Close the HTTP server
    await app.close();
    logger.info("server", "server.shutdown", "Shutdown complete");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({ port: opts.port, host: opts.host });
}
