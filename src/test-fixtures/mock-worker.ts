/**
 * Mock worker for IPC integration tests.
 *
 * Speaks the same IPC protocol as session-worker.ts but doesn't use the SDK.
 * Behavior is controlled via MOCK_WORKER_MODE env var:
 *
 *   "normal"      — init → ready, message → frames + result
 *   "crash"       — init → ready, message → a few frames, then exit(1)
 *   "evil_frame"  — init → ready, message → frame with type "evil_payload"
 *   "exit_clean"  — init → ready, message → result, then exit(0)
 *   "hang"        — init → ready, message → never responds (for SIGKILL test)
 *   "init_fail"   — init → error + exit(1)
 *   "shutdown_mid_query" — init → ready, message → start streaming, respond to shutdown with result then exit
 *   "shutdown_idle"      — init → ready, responds to shutdown with immediate exit
 *   "double_result"      — init → ready, message → sends result twice (for settled flag test)
 */

import type {
  IpcErrorMessage,
  IpcFrameMessage,
  IpcReadyMessage,
  IpcResultMessage,
  IpcSessionIdMessage,
  ParentToWorkerMessage,
  WorkerToParentMessage,
} from "../ipc-protocol.js";

const MODE = process.env.MOCK_WORKER_MODE ?? "normal";

function send(msg: WorkerToParentMessage): void {
  if (process.send) {
    process.send(msg);
  }
}

function sendFrame(frame: Record<string, unknown>): void {
  send({ type: "frame", frame } as IpcFrameMessage);
}

let queryActive = false;
let frameId = 0;

function handleInit(): void {
  if (MODE === "init_fail") {
    send({ type: "error", code: "init_failed", message: "Mock init failure" } as IpcErrorMessage);
    process.exit(1);
  }

  send({ type: "ready" } as IpcReadyMessage);
}

function handleMessage(content: string, resumeSessionId?: string): void {
  queryActive = true;

  // Send session_id
  send({
    type: "session_id",
    sessionId: resumeSessionId ?? "mock-session-1",
    firstMessage: content,
  } as IpcSessionIdMessage);

  switch (MODE) {
    case "normal":
    case "exit_clean": {
      // Send valid frames
      sendFrame({ type: "status", status: "thinking" });
      sendFrame({ type: "token", id: frameId++, text: "Hello " });
      sendFrame({ type: "token", id: frameId++, text: "world" });
      sendFrame({
        type: "tool_use_start",
        id: frameId++,
        toolName: "web_fetch",
        toolId: "tool-1",
      });
      sendFrame({ type: "status", status: "responding" });

      // Send result
      const result: IpcResultMessage = {
        type: "result",
        sessionId: "mock-session-1",
        interrupted: false,
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 },
        responseContent: "Hello world",
        toolCalls: [{ name: "web_fetch", status: "complete" }],
      };
      send(result);
      queryActive = false;

      if (MODE === "exit_clean") {
        process.exit(0);
      }
      break;
    }

    case "crash": {
      // Send a few frames then crash
      sendFrame({ type: "status", status: "thinking" });
      sendFrame({ type: "token", id: frameId++, text: "partial" });
      // Crash without sending result
      setTimeout(() => process.exit(1), 10);
      break;
    }

    case "evil_frame": {
      // Send a valid frame, then an evil one, then result
      sendFrame({ type: "status", status: "thinking" });
      sendFrame({ type: "evil_payload", data: "malicious" });
      sendFrame({ type: "token", id: frameId++, text: "after evil" });

      const result: IpcResultMessage = {
        type: "result",
        sessionId: "mock-session-1",
        interrupted: false,
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
        responseContent: "done",
        toolCalls: [],
      };
      send(result);
      queryActive = false;
      break;
    }

    case "hang": {
      // Send initial frame but never complete — for SIGKILL test
      sendFrame({ type: "status", status: "thinking" });
      // Intentionally never sends result
      break;
    }

    case "shutdown_mid_query": {
      // Start streaming, but don't finish — wait for shutdown
      sendFrame({ type: "status", status: "thinking" });
      sendFrame({ type: "token", id: frameId++, text: "streaming..." });
      // Query stays active — shutdown handler will send result
      break;
    }

    case "double_result": {
      sendFrame({ type: "status", status: "thinking" });

      const result: IpcResultMessage = {
        type: "result",
        sessionId: "mock-session-1",
        interrupted: false,
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
        responseContent: "first",
        toolCalls: [],
      };
      send(result);

      // Send a second result (should be ignored by settled flag)
      const result2: IpcResultMessage = {
        type: "result",
        sessionId: "mock-session-1",
        interrupted: false,
        usage: { inputTokens: 20, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 },
        responseContent: "second-should-be-ignored",
        toolCalls: [],
      };
      send(result2);
      queryActive = false;
      break;
    }

    default:
      break;
  }
}

function handleShutdown(): void {
  if (queryActive) {
    // Send result before exiting
    const result: IpcResultMessage = {
      type: "result",
      sessionId: "mock-session-1",
      interrupted: true,
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 },
      responseContent: "interrupted by shutdown",
      toolCalls: [],
    };
    send(result);
    queryActive = false;
    setTimeout(() => process.exit(0), 50);
  } else {
    process.exit(0);
  }
}

process.on("message", (raw: unknown) => {
  if (!raw || typeof raw !== "object") return;
  const msg = raw as ParentToWorkerMessage;

  switch (msg.type) {
    case "init":
      handleInit();
      break;
    case "message":
      handleMessage(msg.content, msg.resumeSessionId);
      break;
    case "shutdown":
      handleShutdown();
      break;
    case "interrupt":
      // No-op in mock
      break;
    case "tool_approval_response":
      // No-op in mock
      break;
  }
});
