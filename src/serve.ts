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
  lookupUser,
  userCanAccessAgent,
} from "./access.js";
import { buildOptions, buildSystemPrompt, sendMessage } from "./agent.js";
import { type AgentContext, listAgents, resolveAgent } from "./agent-context.js";
import type { HarnessConfig } from "./config.js";
import { loadAgentEnv } from "./env.js";
import { classifyError } from "./errors.js";
import type { AgentManifest } from "./manifest.js";
import { MessageBuffer } from "./message-buffer.js";
import { type PersistedMessage, appendMessage, loadMessages } from "./message-store.js";
import {
  createSessionMeta,
  deleteSession,
  listSessions,
  type SessionDirs,
  saveSession,
  touchSession,
} from "./sessions.js";
import type { WsAssistantMessage, WsClientMessage, WsToken, WsToolUseStart } from "./types/ws.js";
import { UsageTracker } from "./usage.js";

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

// ─── Active conversation state ───

interface ActiveConversation {
  agentId: string;
  agentContext: AgentContext;
  sessionId: string | null;
  sdkSessionConfirmed: boolean; // true after SDK init event confirms the session
  activeQuery: Query | null;
  messageBuffer: MessageBuffer;
  user: AccessUser;
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

// ─── Route registration ───

function registerHealthRoutes(app: FastifyInstance) {
  app.get("/health", async () => {
    return { status: "ok", version: PKG_VERSION, uptime: process.uptime() };
  });
}

function registerAgentRoutes(app: FastifyInstance, opts: ServeOptions) {
  app.get("/api/agents", async (request, reply) => {
    const user = authenticateRequest(request as any, opts.access);
    if (!user) return reply.code(401).send({ error: "Invalid or missing token" });

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

function registerUsageRoutes(app: FastifyInstance, opts: ServeOptions, usageTracker: UsageTracker) {
  app.get("/api/usage", async (request, reply) => {
    const user = authenticateRequest(request as any, opts.access);
    if (!user) return reply.code(401).send({ error: "Invalid or missing token" });

    // Only operators (wildcard access) can view usage
    if (user.agents !== "*") {
      return reply.code(403).send({ error: "Usage data requires operator access" });
    }

    const summary = usageTracker.summarizeByUser();
    return {
      summary,
      sessions: usageTracker.allSessions(),
    };
  });
}

// ─── WebSocket handler ───

async function handleSubscribe(
  ws: WebSocket,
  msg: { agentId: string; sessionId?: string; lastMessageId?: number },
  user: AccessUser,
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

  const agentContext = resolveAgent(msg.agentId);
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
): Promise<void> {
  const { agentContext, user } = conversation;

  ws.send(JSON.stringify({ type: "status", status: "thinking" }));

  const { systemPrompt, manifest } = await buildSystemPrompt(agentContext);
  const toolFilter = manifest.frontmatter.tools ?? undefined;
  const cwd = agentContext.workspaceDir;
  const agentEnv = loadAgentEnv(agentContext.agentDir);

  // Only resume if we have a session ID that came from the SDK (not a pre-created REST session).
  // If resume fails with "No conversation found", retry without resume.
  let resumeId = conversation.sdkSessionConfirmed ? conversation.sessionId ?? undefined : undefined;

  let options = buildOptions(
    agentContext,
    {
      resume: resumeId,
      systemPrompt,
      cwd,
      agentEnv,
      toolFilter,
    },
    config,
  );

  let q: ReturnType<typeof sendMessage>;
  try {
    q = sendMessage(msg.content, options);
    // Peek at the first message to detect session-not-found errors early
    // (the SDK throws synchronously or on first iteration)
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (resumeId && errMsg.includes("No conversation found")) {
      // Retry without resume — treat as new conversation
      options = buildOptions(agentContext, { systemPrompt, cwd, agentEnv, toolFilter }, config);
      q = sendMessage(msg.content, options);
    } else {
      throw err;
    }
  }
  conversation.activeQuery = q;

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

  // If resuming an existing session, persist user message immediately
  if (conversation.sdkSessionConfirmed && conversation.sessionId) {
    await persistUserMessage();
  }

  try {
    for await (const sdkMsg of q) {
      // Capture session ID from init
      if (sdkMsg.type === "system" && (sdkMsg as any).subtype === "init" && sdkMsg.session_id) {
        conversation.sessionId = sdkMsg.session_id;
        conversation.sdkSessionConfirmed = true;
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

function registerWebSocketRoute(app: FastifyInstance, opts: ServeOptions, usageTracker: UsageTracker) {
  app.register(async (fastify) => {
    fastify.get("/ws", { websocket: true }, (socket, request) => {
      const ws = socket as unknown as WebSocket;
      const connectionId = crypto.randomUUID();

      // Auth: read token from query param or headers
      const token = extractWsToken(request);
      const user = token ? lookupUser(token, opts.access) : null;
      if (!user) {
        ws.send(JSON.stringify({ type: "error", code: "auth_failed", message: "Invalid token" }));
        ws.close(4001, "Unauthorized");
        return;
      }

      ws.send(JSON.stringify({ type: "connected", connectionId }));

      let activeConversation: ActiveConversation | null = null;

      ws.on("message", async (raw: Buffer) => {
        let msg: WsClientMessage;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          ws.send(JSON.stringify({ type: "error", code: "parse_error", message: "Invalid JSON" }));
          return;
        }

        switch (msg.type) {
          case "subscribe":
            activeConversation = await handleSubscribe(ws, msg, user);
            break;
          case "message":
            if (!activeConversation) {
              ws.send(JSON.stringify({ type: "error", code: "not_subscribed", message: "Subscribe first" }));
              return;
            }
            await handleMessage(ws, msg, activeConversation, opts.config, usageTracker);
            break;
          case "interrupt":
            if (activeConversation?.activeQuery) {
              activeConversation.activeQuery.interrupt();
            }
            break;
        }
      });

      ws.on("close", () => {
        if (activeConversation?.activeQuery) {
          activeConversation.activeQuery = null;
        }
      });
    });
  });
}

// ─── Server startup ───

export async function startServer(opts: ServeOptions): Promise<void> {
  const app = Fastify({ logger: true });
  const usageTracker = new UsageTracker();

  await app.register(fastifyCors, {
    origin: true,
    methods: ["GET", "POST", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  });
  await app.register(fastifyWebsocket);

  registerHealthRoutes(app);
  registerAgentRoutes(app, opts);
  registerSessionRoutes(app, opts);
  registerUsageRoutes(app, opts, usageTracker);
  registerWebSocketRoute(app, opts, usageTracker);

  // Periodic sweep of stale message buffers
  const sweepTimer = setInterval(sweepStaleBuffers, SWEEP_INTERVAL_MS);

  // Clean shutdown
  const shutdown = async () => {
    clearInterval(sweepTimer);
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({ port: opts.port, host: opts.host });
}
