import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import fastifyCors from "@fastify/cors";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import {
  type AccessConfig,
  type AccessUser,
  authenticateRequest,
  filterAgentsForUser,
  loadAccessConfig,
  lookupUser,
  userCanAccessAgent,
} from "./access.js";
import { buildOptions, buildSystemPrompt, sendMessage } from "./agent.js";
import { CostTracker } from "./cost.js";
import { type AgentContext, getAgentsDir, listAgents, resolveAgent, resolveRemoteAgent } from "./agent-context.js";
import { type HarnessConfig, getConfigPath, getHomeDir, loadConfig } from "./config.js";
import { loadAgentEnv } from "./env.js";
import { classifyError } from "./errors.js";
import type { AgentManifest } from "./manifest.js";
import { MessageBuffer } from "./message-buffer.js";
import { appendMessage, loadMessages, type PersistedMessage } from "./message-store.js";
import {
  createSessionMeta,
  deleteSession,
  listSessions,
  type SessionDirs,
  saveSession,
  touchSession,
} from "./sessions.js";
import type { WsAssistantMessage, WsClientMessage, WsToken, WsToolUseStart } from "./types/ws.js";
import { Logger } from "./logger.js";
import {
  checkConsent,
  recordConsent,
  exportUserData,
  deleteUserData,
  runRetentionCleanup,
  privacyDisclosure,
  DEFAULT_PRIVACY_CONFIG,
  type PrivacyConfig,
} from "./privacy.js";
import { RateLimiter } from "./rate-limit.js";
import { REMOTE_SANDBOX_DEFAULTS, type RemoteSandboxPolicy } from "./sandbox.js";
import { UsageTracker } from "./usage.js";
import { HealthMonitor } from "./health.js";
import { FileWatcher } from "./watcher.js";

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

// ─── Health tracking counters ───

let activeSessionCount = 0;
let activeConnectionCount = 0;

// ─── Active conversation state ───

interface ActiveConversation {
  agentId: string;
  agentContext: AgentContext;
  sessionId: string | null;
  sdkSessionConfirmed: boolean; // true after SDK init event confirms the session
  activeQuery: Query | null;
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

function extractWsToken(request: FastifyRequest): string | null {
  // 1. Query parameter
  const queryToken = (request.query as Record<string, string>).token;
  if (queryToken) return queryToken;

  // 2. Authorization header
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);

  // 3. Protocol header (for browsers that can't set custom headers on WS)
  const protocols = request.headers["sec-websocket-protocol"];
  if (protocols) {
    const parts = (typeof protocols === "string" ? protocols : protocols[0]).split(",").map((s) => s.trim());
    const tokenProto = parts.find((p) => p.startsWith("token."));
    if (tokenProto) return tokenProto.slice(6);
  }

  return null;
}

// ─── Connected WebSocket clients (for broadcasting) ───

const connectedClients = new Map<WebSocket, { user: AccessUser; token: string }>();

function broadcastToAll(message: object): void {
  const payload = JSON.stringify(message);
  for (const [ws] of connectedClients) {
    try {
      ws.send(payload);
    } catch {
      // Connection already closed
    }
  }
}

// ─── Route registration ───

function registerHealthRoutes(
  app: FastifyInstance,
  opts: ServeOptions,
  healthMonitor: HealthMonitor,
  logger: Logger,
) {
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

function registerUsageRoutes(app: FastifyInstance, opts: ServeOptions, usageTracker: UsageTracker, costTracker: CostTracker) {
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

function registerPrivacyRoutes(
  app: FastifyInstance,
  opts: ServeOptions,
  logger: Logger,
) {
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
      const totalDeleted = deleted.sessions + deleted.memoryFiles + deleted.workspaceFiles +
        (deleted.usageFile ? 1 : 0) + (deleted.consentFile ? 1 : 0);

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
    ws.send(JSON.stringify({
      type: "consent_required",
      policyVersion,
    }));
    return null;
  }

  const agentContext = resolveRemoteAgent(msg.agentId, user.name);
  const sessionId = msg.sessionId ?? null;

  // Get or create a message buffer for this conversation
  const messageBuffer = sessionId ? getOrCreateBuffer(msg.agentId, sessionId, user.name) : new MessageBuffer(1000);

  const conversation: ActiveConversation = {
    agentId: msg.agentId,
    agentContext,
    sessionId,
    sdkSessionConfirmed: !!sessionId, // true if subscribing with an existing session ID (from a prior SDK session)
    activeQuery: null,
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
): Promise<void> {
  const { agentContext, user } = conversation;

  ws.send(JSON.stringify({ type: "status", status: "thinking" }));

  const { systemPrompt, manifest } = await buildSystemPrompt(agentContext);
  const toolFilter = manifest.frontmatter.tools ?? undefined;
  const cwd = agentContext.workspaceDir;
  const agentEnv = loadAgentEnv(agentContext.agentDir);

  // Only resume if we have a session ID that came from the SDK (not a pre-created REST session).
  // If resume fails with "No conversation found", retry without resume.
  let resumeId = conversation.sdkSessionConfirmed ? (conversation.sessionId ?? undefined) : undefined;

  const onToolApproval = async (
    toolId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<boolean> => {
    return new Promise((resolve) => {
      conversation.pendingApprovals.set(toolId, resolve);
      ws.send(
        JSON.stringify({
          type: "tool_approval",
          toolId,
          toolName,
          toolInput: input,
          question: `Allow ${toolName}?`,
        }),
      );
    });
  };

  const onToolResult = (toolId: string, _toolName: string, output: string) => {
    ws.send(
      JSON.stringify({
        type: "tool_result",
        id: conversation.messageBuffer.nextId(),
        toolId,
        content: output,
      }),
    );
  };

  // Enforce remote sandbox policy — unconditional for serve mode
  const sandboxPolicy: RemoteSandboxPolicy = {
    ...REMOTE_SANDBOX_DEFAULTS,
    // Enable shell only if agent manifest allows it AND sandbox is enforced
    shell: !!(manifest.frontmatter.sandbox?.enforce && toolFilter?.allow?.includes("shell")),
  };

  let options = buildOptions(
    agentContext,
    {
      resume: resumeId,
      systemPrompt,
      cwd,
      agentEnv,
      toolFilter,
      onToolApproval,
      onToolResult,
      sandboxPolicy,
      mcpConfigs: manifest.frontmatter.mcp,
      isRemoteSession: true,
    },
    config,
  );

  let responseBuffer = "";
  let wasInterrupted = false;
  const accumulatedUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const toolCallNames: { name: string; status: string }[] = [];
  let userMessagePersisted = false;

  // Helper: persist the user message once we have a confirmed session ID
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

  let q: ReturnType<typeof sendMessage>;
  try {
    q = sendMessage(msg.content, options);
    // Peek at the first message to detect session-not-found errors early
    // (the SDK throws synchronously or on first iteration)
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (resumeId && errMsg.includes("No conversation found")) {
      // Retry without resume — treat as new conversation
      resumeId = undefined;
      userMessagePersisted = false;
      options = buildOptions(agentContext, { systemPrompt, cwd, agentEnv, toolFilter, onToolApproval, onToolResult, sandboxPolicy, mcpConfigs: manifest.frontmatter.mcp, isRemoteSession: true }, config);
      q = sendMessage(msg.content, options);
    } else {
      throw err;
    }
  }
  conversation.activeQuery = q;

  // If resuming an existing session, persist user message immediately
  if (conversation.sdkSessionConfirmed && conversation.sessionId) {
    await persistUserMessage();
  }

  try {
    for await (const sdkMsg of q) {
      // Capture session ID from init
      if (sdkMsg.type === "system" && (sdkMsg as any).subtype === "init" && sdkMsg.session_id) {
        const oldSessionId = conversation.sessionId;
        conversation.sessionId = sdkMsg.session_id;
        conversation.sdkSessionConfirmed = true;
        // Delete orphaned buffer entry if the session ID changed (e.g. pre-created REST session → real SDK session)
        if (oldSessionId && oldSessionId !== sdkMsg.session_id) {
          const oldKey = bufferKey(conversation.agentId, oldSessionId, user.name);
          conversationBuffers.delete(oldKey);
        }
        // Register the buffer under the real session ID
        const key = bufferKey(conversation.agentId, sdkMsg.session_id, user.name);
        if (!conversationBuffers.has(key)) {
          conversationBuffers.set(key, { buffer: conversation.messageBuffer, lastActivity: Date.now() });
        }
        // If this is a new session, save metadata
        const sessionDirs = sessionDirsForUser(agentContext, user);
        const meta = createSessionMeta(sdkMsg.session_id, msg.content);
        await saveSession(sessionDirs, meta);
        await persistUserMessage();
      }

      // Stream events → WS frames
      if (sdkMsg.type === "stream_event") {
        const event = (sdkMsg as any).event;

        // Text tokens
        if (event?.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
          responseBuffer += event.delta.text;
          const frame: WsToken = {
            type: "token",
            id: conversation.messageBuffer.nextId(),
            text: event.delta.text,
          };
          conversation.messageBuffer.push(frame);
          ws.send(JSON.stringify(frame));
        }

        // Thinking tokens
        if (event?.type === "content_block_delta" && event.delta?.type === "thinking_delta" && event.delta.thinking) {
          ws.send(JSON.stringify({ type: "thinking_token", text: event.delta.thinking }));
        }

        // Tool use start
        if (event?.type === "content_block_start" && event.content_block?.type === "tool_use") {
          const toolName = (event.content_block.name ?? "unknown").replace(/^mcp__.+?__/, "");
          const frame: WsToolUseStart = {
            type: "tool_use_start",
            id: conversation.messageBuffer.nextId(),
            toolName,
            toolId: event.content_block.id,
          };
          conversation.messageBuffer.push(frame);
          ws.send(JSON.stringify(frame));
          ws.send(JSON.stringify({ type: "status", status: "tool_use" }));
          toolCallNames.push({ name: toolName, status: "complete" });
        }

        // Tool input streaming
        if (event?.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
          ws.send(
            JSON.stringify({
              type: "tool_use_input",
              toolId: event.content_block?.id ?? "",
              partialJson: event.delta.partial_json,
            }),
          );
        }

        // Tool use end (content_block_stop doesn't carry content_block in all SDK versions)
        if (event?.type === "content_block_stop") {
          // Tool end is best-effort — the frontend uses tool_use_start as the anchor
        }
      }

      // Sub-agent events
      if (sdkMsg.type === "system" && (sdkMsg as any).subtype === "task_started") {
        const m = sdkMsg as any;
        ws.send(
          JSON.stringify({
            type: "subagent_started",
            taskId: m.task_id,
            description: m.description ?? "",
          }),
        );
      }

      if (sdkMsg.type === "system" && (sdkMsg as any).subtype === "task_progress") {
        const m = sdkMsg as any;
        ws.send(
          JSON.stringify({
            type: "subagent_progress",
            taskId: m.task_id,
            toolUses: m.usage?.tool_uses ?? 0,
            durationMs: m.usage?.duration_ms ?? 0,
            totalTokens: m.usage?.total_tokens ?? 0,
          }),
        );
      }

      if (sdkMsg.type === "system" && (sdkMsg as any).subtype === "task_notification") {
        const m = sdkMsg as any;
        ws.send(
          JSON.stringify({
            type: "subagent_done",
            taskId: m.task_id,
            status: m.status,
            summary: m.summary ?? "",
            totalTokens: m.usage?.total_tokens ?? 0,
          }),
        );
      }

      // Assistant turn complete — accumulate usage but DON'T send assistant_message yet.
      // In multi-turn tool use, there are multiple `assistant` events (one per API call).
      // We send ONE assistant_message after the loop ends (with the full accumulated content).
      if (sdkMsg.type === "assistant") {
        const usage = (sdkMsg as any).message?.usage;
        if (usage) {
          accumulatedUsage.inputTokens += usage.input_tokens ?? 0;
          accumulatedUsage.outputTokens += usage.output_tokens ?? 0;
          accumulatedUsage.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
          accumulatedUsage.cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
        }
        // Extract text from the message content as fallback (if streaming didn't capture it)
        if (!responseBuffer) {
          const text = (sdkMsg as any).message?.content
            ?.filter((block: any) => block.type === "text")
            .map((block: any) => block.text)
            .join("");
          if (text) responseBuffer = text;
        }
      }

      // Result (end of turn)
      if (sdkMsg.type === "result") {
        wasInterrupted = !!(sdkMsg as any).is_interrupted;
      }
    }
  } catch (err) {
    // Ensure user message is persisted even on error, if we have a session
    if (!userMessagePersisted && conversation.sessionId) {
      try {
        await persistUserMessage();
      } catch (persistErr) {
        console.error("[serve] Failed to persist user message on error path:", persistErr);
      }
    }
    if (!userMessagePersisted) {
      console.warn("[serve] User message was not persisted — no session ID was confirmed before error");
    }
    const classified = classifyError(err);
    ws.send(
      JSON.stringify({
        type: "error",
        code: classified.category,
        message: classified.message,
      }),
    );
  }

  conversation.activeQuery = null;

  // Send ONE assistant_message with the final accumulated content (after all tool-use turns)
  if (responseBuffer) {
    const frame: WsAssistantMessage = {
      type: "assistant_message",
      id: conversation.messageBuffer.nextId(),
      content: responseBuffer,
      usage: {
        inputTokens: accumulatedUsage.inputTokens,
        outputTokens: accumulatedUsage.outputTokens,
        cacheReadTokens: accumulatedUsage.cacheReadTokens,
        cacheCreationTokens: accumulatedUsage.cacheCreationTokens,
      },
    };
    conversation.messageBuffer.push(frame);
    ws.send(JSON.stringify(frame));

    // Persist assistant message to disk
    if (conversation.sessionId) {
      const sessionDirs = sessionDirsForUser(agentContext, user);
      const assistantMsg: PersistedMessage = {
        role: "assistant",
        content: responseBuffer,
        timestamp: new Date().toISOString(),
        ...(toolCallNames.length > 0 ? { toolCalls: toolCallNames } : {}),
      };
      await appendMessage(sessionDirs, conversation.sessionId, assistantMsg);
    }
  }

  // Record usage
  if (conversation.sessionId) {
    usageTracker.recordTurn(conversation.sessionId, conversation.agentId, user.name, accumulatedUsage);

    // Record cost and check budget
    costTracker.recordUsage(user.name, conversation.sessionId, accumulatedUsage.inputTokens, accumulatedUsage.outputTokens);
    const postBudget = costTracker.checkBudget(user.name, conversation.sessionId);
    if (postBudget.warnings.length > 0) {
      ws.send(JSON.stringify({ type: "budget_warning", warnings: postBudget.warnings }));
    }
    if (!postBudget.allowed) {
      ws.send(
        JSON.stringify({
          type: "budget_exceeded",
          reason: postBudget.exceeded!.budget,
          limit: postBudget.exceeded!.limit,
          used: postBudget.exceeded!.used,
          resetsAt: postBudget.exceeded!.resetsAt,
        }),
      );
    }
  }

  // Final result frame
  ws.send(
    JSON.stringify({
      type: "result",
      sessionId: conversation.sessionId,
      interrupted: wasInterrupted,
      usage: {
        inputTokens: accumulatedUsage.inputTokens,
        outputTokens: accumulatedUsage.outputTokens,
      },
    }),
  );

  ws.send(JSON.stringify({ type: "status", status: wasInterrupted ? "interrupted" : "idle" }));

  // Touch session
  if (conversation.sessionId) {
    const sessionDirs = sessionDirsForUser(agentContext, user);
    await touchSession(sessionDirs, conversation.sessionId);
  }
}

function registerWebSocketRoute(app: FastifyInstance, opts: ServeOptions, usageTracker: UsageTracker, logger: Logger, rateLimiter: RateLimiter, costTracker: CostTracker) {
  app.register(async (fastify) => {
    fastify.get("/ws", { websocket: true }, (socket, request) => {
      const ws = socket as unknown as WebSocket;
      const connectionId = crypto.randomUUID();

      const clientIp = request.ip ?? "unknown";

      // Auth: read token from query param or headers
      const token = extractWsToken(request);
      const user = token ? lookupUser(token, opts.access) : null;
      if (!user) {
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
      connectedClients.set(ws, { user, token: token! });

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

        let msg: WsClientMessage;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          ws.send(JSON.stringify({ type: "error", code: "parse_error", message: "Invalid JSON" }));
          return;
        }

        try {
          switch (msg.type) {
            case "subscribe": {
              const prev = activeConversation;
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
                ws.send(JSON.stringify({
                  type: "error",
                  code: "message_too_large",
                  message: "Message exceeds character limit",
                }));
                return;
              }
              // Per-user message rate limiting
              const rateCheck = rateLimiter.checkMessageRate(user.name);
              if (!rateCheck.allowed) {
                ws.send(JSON.stringify({
                  type: "error",
                  code: "rate_limited",
                  message: "Too many messages",
                  retryAfter: rateCheck.retryAfter,
                }));
                return;
              }
              // Pre-flight budget check
              const budgetCheck = costTracker.checkBudget(user.name, activeConversation.sessionId ?? "");
              if (!budgetCheck.allowed) {
                ws.send(
                  JSON.stringify({
                    type: "budget_exceeded",
                    reason: budgetCheck.exceeded!.budget,
                    limit: budgetCheck.exceeded!.limit,
                    used: budgetCheck.exceeded!.used,
                    resetsAt: budgetCheck.exceeded!.resetsAt,
                  }),
                );
                return;
              }
              await handleMessage(ws, msg, activeConversation, opts.config, usageTracker, costTracker);
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
              if (activeConversation?.activeQuery) {
                activeConversation.activeQuery.interrupt();
                ws.send(JSON.stringify({ type: "status", status: "interrupted" }));
              }
              break;
          }
        } catch (err) {
          const classified = classifyError(err);
          try {
            ws.send(
              JSON.stringify({
                type: "error",
                code: classified.category,
                message: classified.message,
              }),
            );
          } catch {
            // Connection already closed — nothing we can do
          }
        }
      });

      ws.on("close", () => {
        clearTimeout(idleTimer);
        activeConnectionCount--;
        connectedClients.delete(ws);
        if (activeConversation) {
          activeSessionCount--;
        }
        rateLimiter.removeConnection(user.name);
        if (activeConversation?.activeQuery) {
          activeConversation.activeQuery = null;
        }
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

  // Health monitoring
  const healthMonitor = new HealthMonitor(
    PKG_VERSION,
    () => activeSessionCount,
    () => activeConnectionCount,
    logger,
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
  registerWebSocketRoute(app, opts, usageTracker, logger, rateLimiter, costTracker);

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
          const rosterPayload = allAgents.map(agentToApiResponse);
          broadcastToAll({ type: "roster_updated", agents: rosterPayload });
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
          // Disconnect revoked tokens
          for (const [ws, clientInfo] of connectedClients) {
            const user = lookupUser(clientInfo.token, opts.access);
            if (!user) {
              try {
                ws.send(JSON.stringify({ type: "error", code: "token_revoked", message: "Your access has been revoked" }));
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
      broadcastToAll({ type: "roster_updated", agents: allAgents.map(agentToApiResponse) });
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
  runRetentionCleanup(privacyConfig, logger).catch(err => {
    logger.error("server", "retention.cleanup_failed", `Initial retention cleanup failed: ${err}`);
  });
  const retentionTimer = setInterval(() => {
    runRetentionCleanup(privacyConfig, logger).catch(err => {
      logger.error("server", "retention.cleanup_failed", `Retention cleanup failed: ${err}`);
    });
  }, 24 * 60 * 60 * 1000); // daily

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
