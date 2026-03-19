/**
 * Session worker — child process entry point for process-isolated sessions.
 *
 * Each remote session runs in its own Node.js process, forked from the parent
 * (serve.ts). Communication is via IPC (process.send / process.on('message')).
 *
 * Lifecycle:
 *   1. Parent sends 'init' → worker loads agent context, config, manifest
 *   2. Parent sends 'message' → worker runs SDK query, streams frames back
 *   3. Parent sends 'interrupt' → worker interrupts the active query
 *   4. Parent sends 'shutdown' → worker exits cleanly
 *
 * The worker holds the SDK session state across messages (resume by session ID).
 * It is killed when the WebSocket connection closes or on idle timeout.
 */

import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { buildOptions, buildSystemPrompt, sendMessage } from "./agent.js";
import { type AgentContext, resolveRemoteAgent } from "./agent-context.js";
import type { HarnessConfig } from "./config.js";
import { loadAgentEnv } from "./env.js";
import type {
  IpcInitMessage,
  IpcResultMessage,
  IpcSessionIdMessage,
  IpcToolApprovalRequest,
  IpcUserMessage,
  ParentToWorkerMessage,
  WorkerConfig,
  WorkerToParentMessage,
} from "./ipc-protocol.js";
import { Logger } from "./logger.js";
import type { AgentManifest } from "./manifest.js";
import { REMOTE_SANDBOX_DEFAULTS, type RemoteSandboxPolicy } from "./sandbox.js";
import { extractSdkEvent } from "./sdk-stream.js";

// ─── Worker state ───

let agentContext: AgentContext | null = null;
// W7-T11: Worker receives only the config subset it needs (WorkerConfig),
// but agent.ts buildOptions expects HarnessConfig. The unused fields are
// harmless — we cast because WorkerConfig is a structural subset.
let config: HarnessConfig | null = null;
let manifest: AgentManifest | null = null;
let agentEnv: Record<string, string> = {};
let userId = "";
let userToolsDeny: string[] = [];
let logger: Logger | undefined;

let activeQuery: Query | null = null;
let sessionId: string | null = null;

// W7-T04: Module-scoped frame ID — monotonically increasing across messages.
// Per-message reset (old behavior) broke MessageBuffer.since(lastMessageId) on reconnection
// because IDs restarted at 0 after the first turn.
let frameId = 0;

// Pending tool approval promises — keyed by toolId
const pendingApprovals = new Map<string, (approved: boolean) => void>();

// ─── IPC helpers ───

function send(msg: WorkerToParentMessage): boolean {
  if (!process.send) return false;
  try {
    process.send(msg);
    return true;
  } catch {
    // IPC channel closed (parent died or disconnected) — nothing we can do
    return false;
  }
}

function sendFrame(frame: Record<string, unknown>): void {
  send({ type: "frame", frame });
}

function sendError(code: string, message: string): void {
  send({ type: "error", code, message });
}

// ─── Message handlers ───

async function handleInit(msg: IpcInitMessage): Promise<void> {
  try {
    userId = msg.userId;
    userToolsDeny = msg.accessUser.toolsDeny;
    config = JSON.parse(msg.configJson) as WorkerConfig as HarnessConfig;
    logger = new Logger(config.serve?.logging?.level ?? "info", {
      userId,
      agentId: msg.agentId,
    });

    agentContext = resolveRemoteAgent(msg.agentId, userId);
    agentEnv = loadAgentEnv(agentContext.agentDir);

    const result = await buildSystemPrompt(agentContext);
    manifest = result.manifest;

    logger.info("session", "worker.ready", `Worker initialized for ${msg.agentId}/${userId}`);
    send({ type: "ready" });
  } catch (err) {
    sendError("init_failed", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

async function handleMessage(msg: IpcUserMessage): Promise<void> {
  if (!agentContext || !config || !manifest) {
    sendError("not_initialized", "Worker not initialized — send init first");
    return;
  }

  // P1-3: Guard against concurrent queries in the same worker
  if (activeQuery) {
    sendError("query_in_progress", "A query is already running — wait for it to complete");
    return;
  }

  sendFrame({ type: "status", status: "thinking" });

  // A1: Rebuild system prompt (includes current date/time) but reuse cached manifest from init.
  // This avoids re-parsing the IDENTITY.md file on every message.
  const { systemPrompt } = await buildSystemPrompt(agentContext);
  const toolFilter = manifest?.frontmatter.tools ?? undefined;
  const cwd = agentContext.workspaceDir;

  let resumeId = msg.resumeSessionId;

  // Tool approval callback — sends IPC request, waits for response
  const onToolApproval = async (toolId: string, toolName: string, input: Record<string, unknown>): Promise<boolean> => {
    return new Promise((resolve) => {
      pendingApprovals.set(toolId, resolve);
      const request: IpcToolApprovalRequest = {
        type: "tool_approval_request",
        toolId,
        toolName,
        toolInput: input,
      };
      send(request);
    });
  };

  // Tool result callback — sends frame to parent for forwarding
  const onToolResult = (toolId: string, _toolName: string, output: string) => {
    // Review fix #1: tool_result must include id for WsToolResult type conformance
    sendFrame({ type: "tool_result", id: frameId++, toolId, content: output });
  };

  // Remote sandbox policy
  const sandboxPolicy: RemoteSandboxPolicy = {
    ...REMOTE_SANDBOX_DEFAULTS,
    shell: !!(manifest.frontmatter.sandbox?.enforce && toolFilter?.allow?.includes("shell")),
  };

  let options = buildOptions(
    agentContext,
    {
      resume: resumeId,
      systemPrompt,
      cwd,
      agentEnv,
      credentialsConfig: manifest.frontmatter.credentials ?? undefined,
      allowedDomains: manifest.frontmatter.sandbox?.allowedDomains,
      toolFilter,
      toolOperations: manifest.frontmatter.toolOperations ?? undefined,
      userToolsDeny,
      onToolApproval,
      onToolResult,
      sandboxPolicy,
      mcpConfigs: manifest.frontmatter.mcp,
      isRemoteSession: true,
      logger,
    },
    config,
  );

  let responseBuffer = "";
  let wasInterrupted = false;
  const accumulatedUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
  const toolCallNames: { name: string; status: string }[] = [];
  // W7-T03: Track active toolId from tool_use_start for input delta frames
  let activeToolId: string | null = null;

  let q: ReturnType<typeof sendMessage>;
  try {
    q = sendMessage(msg.content, options);
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (resumeId && errMsg.includes("No conversation found")) {
      // Retry without resume — treat as new conversation
      resumeId = undefined;
      options = buildOptions(
        agentContext,
        {
          systemPrompt,
          cwd,
          agentEnv,
          credentialsConfig: manifest.frontmatter.credentials ?? undefined,
          allowedDomains: manifest.frontmatter.sandbox?.allowedDomains,
          toolFilter,
          toolOperations: manifest.frontmatter.toolOperations ?? undefined,
          userToolsDeny,
          onToolApproval,
          onToolResult,
          sandboxPolicy,
          mcpConfigs: manifest.frontmatter.mcp,
          isRemoteSession: true,
          logger,
        },
        config,
      );
      q = sendMessage(msg.content, options);
    } else {
      throw err;
    }
  }
  activeQuery = q;

  let hadError = false;

  try {
    for await (const sdkMsg of q) {
      const event = extractSdkEvent(sdkMsg);
      if (!event) continue;

      switch (event.kind) {
        case "init": {
          sessionId = event.sessionId;
          const sessionMsg: IpcSessionIdMessage = {
            type: "session_id",
            sessionId: event.sessionId,
            firstMessage: msg.content,
          };
          send(sessionMsg);
          break;
        }

        case "text_token":
          responseBuffer += event.text;
          sendFrame({ type: "token", id: frameId++, text: event.text });
          break;

        case "thinking_token":
          sendFrame({ type: "thinking_token", text: event.text });
          break;

        case "tool_use_start":
          activeToolId = event.toolId;
          sendFrame({
            type: "tool_use_start",
            id: frameId++,
            toolName: event.toolName,
            toolId: event.toolId,
          });
          sendFrame({ type: "status", status: "tool_use" });
          toolCallNames.push({ name: event.toolName, status: "complete" });
          break;

        case "tool_input_delta": {
          // W7-T03: Use tracked activeToolId when SDK delta lacks contentBlock.id
          const toolId = event.toolId ?? activeToolId;
          if (toolId) {
            sendFrame({
              type: "tool_use_input",
              toolId,
              partialJson: event.partialJson,
            });
          }
          break;
        }

        case "subagent_started":
          sendFrame({
            type: "subagent_started",
            taskId: event.taskId,
            description: event.description,
          });
          break;

        case "subagent_progress":
          sendFrame({
            type: "subagent_progress",
            taskId: event.taskId,
            toolUses: event.toolUses,
            durationMs: event.durationMs,
            totalTokens: event.totalTokens,
          });
          break;

        case "subagent_done":
          sendFrame({
            type: "subagent_done",
            taskId: event.taskId,
            status: event.status,
            summary: event.summary,
            totalTokens: event.totalTokens,
          });
          break;

        case "assistant": {
          const usage = event.usage;
          if (usage) {
            accumulatedUsage.inputTokens += usage.input_tokens ?? 0;
            accumulatedUsage.outputTokens += usage.output_tokens ?? 0;
            accumulatedUsage.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
            accumulatedUsage.cacheCreationTokens += usage.cache_creation_input_tokens ?? 0;
          }
          if (!responseBuffer && event.textContent) {
            responseBuffer = event.textContent;
          }
          break;
        }

        case "content_block_stop":
          activeToolId = null;
          break;

        case "text_block_start":
        case "message_start":
          // Handled by TUI only — no-op in worker
          break;

        case "result":
          wasInterrupted = event.isInterrupted;
          break;

        default: {
          // W7-T07: Exhaustive check — adding a new SdkEvent kind without handling it here
          // causes a compile error (Type 'SdkXxxEvent' is not assignable to type 'never').
          const _exhaustive: never = event;
          void _exhaustive;
        }
      }
    }
  } catch (err) {
    hadError = true;
    const errMsg = err instanceof Error ? err.message : String(err);
    sendError("query_error", errMsg);
  }

  activeQuery = null;

  // W7-T05: Skip result IPC if we already sent an error — the settled flag makes
  // the duplicate harmless, but it's wasteful traffic and confusing in logs.
  if (hadError) {
    if (shuttingDown) process.exit(0);
    return;
  }

  // Send result to parent
  const result: IpcResultMessage = {
    type: "result",
    sessionId,
    interrupted: wasInterrupted,
    usage: accumulatedUsage,
    responseContent: responseBuffer,
    toolCalls: toolCallNames,
  };
  send(result);

  // If shutdown was requested during the query, exit now that we've sent the result
  if (shuttingDown) {
    process.exit(0);
  }
}

function handleInterrupt(): void {
  if (activeQuery) {
    activeQuery.interrupt();
    sendFrame({ type: "status", status: "interrupted" });
  }
}

function handleToolApprovalResponse(msg: { toolId: string; approved: boolean }): void {
  const resolver = pendingApprovals.get(msg.toolId);
  if (resolver) {
    resolver(msg.approved);
    pendingApprovals.delete(msg.toolId);
  }
}

let shuttingDown = false;

function handleShutdown(): void {
  shuttingDown = true;
  // P1-2: Resolve pending tool approvals with denial to unblock the SDK query loop.
  // Without this, the SDK hangs waiting for the approval callback until the 5s force-kill.
  for (const [, resolver] of pendingApprovals) {
    resolver(false);
  }
  pendingApprovals.clear();
  if (activeQuery) {
    activeQuery.interrupt();
    // Let the query loop finish and send its result before exiting.
    // If it doesn't finish within 5s, force exit.
    setTimeout(() => process.exit(0), 5000);
  } else {
    // No active query — exit immediately
    process.exit(0);
  }
}

// ─── IPC message dispatch ───

process.on("message", async (raw: unknown) => {
  if (!raw || typeof raw !== "object") return;
  const msg = raw as ParentToWorkerMessage;

  try {
    switch (msg.type) {
      case "init":
        await handleInit(msg);
        break;
      case "message":
        await handleMessage(msg);
        break;
      case "interrupt":
        handleInterrupt();
        break;
      case "tool_approval_response":
        handleToolApprovalResponse(msg);
        break;
      case "shutdown":
        handleShutdown();
        break;
      default: {
        // Exhaustive check — adding a new ParentToWorkerMessage type without
        // handling it here causes a compile error.
        const _exhaustive: never = msg;
        void _exhaustive;
      }
    }
  } catch (err) {
    sendError("worker_error", err instanceof Error ? err.message : String(err));
  }
});

// Handle unexpected errors — best-effort IPC, then always exit.
// Do NOT call sendError (which calls send) from here if send itself threw — avoid recursion.
process.on("uncaughtException", (err) => {
  send({ type: "error", code: "uncaught_exception", message: err.message });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  send({
    type: "error",
    code: "unhandled_rejection",
    message: reason instanceof Error ? reason.message : String(reason),
  });
  process.exit(1);
});
