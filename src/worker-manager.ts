/**
 * Worker manager — spawns and manages session worker processes.
 *
 * Each active conversation gets its own child process (via child_process.fork).
 * The worker handles SDK queries in isolation; the parent handles WebSocket I/O,
 * session persistence, and cost tracking.
 *
 * Workers persist for the duration of a conversation (across multiple messages).
 * The message handler can be updated per-message via updateHandler().
 */

import { type ChildProcess, fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadAgentEnv } from "./env.js";
import { buildShellEnv } from "./env-safety.js";
import type { IpcInitMessage, ParentToWorkerMessage, WorkerToParentMessage } from "./ipc-protocol.js";
import type { Logger } from "./logger.js";

const WORKER_PATH = fileURLToPath(new URL("./session-worker.ts", import.meta.url));

const WORKER_IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const DEFAULT_MAX_WORKERS = 20;

export type WorkerMessageHandler = (msg: WorkerToParentMessage) => void;
export type WorkerExitHandler = (code: number | null, signal: string | null) => void;

export interface WorkerHandle {
  process: ChildProcess;
  agentId: string;
  userId: string;
  conversationKey: string;
  createdAt: number;
  lastActivity: number;
}

interface InternalWorkerState {
  handle: WorkerHandle;
  handlerRef: { current: WorkerMessageHandler };
  exitHandlerRef: { current: WorkerExitHandler };
  idleTimer: ReturnType<typeof setTimeout>;
  killTimer: ReturnType<typeof setTimeout> | null;
}

export class WorkerManager {
  private readonly workers = new Map<string, InternalWorkerState>();
  private readonly logger: Logger;
  private readonly maxWorkers: number;

  constructor(logger: Logger, maxWorkers = DEFAULT_MAX_WORKERS) {
    this.logger = logger;
    this.maxWorkers = maxWorkers;
  }

  /**
   * Spawn a new worker for a conversation.
   *
   * The onMessage/onExit handlers can be updated later via updateHandler/updateExitHandler
   * (needed when the same worker handles multiple messages with different result resolvers).
   */
  spawn(
    conversationKey: string,
    agentId: string,
    userId: string,
    configJson: string,
    userToolsDeny: string[],
    onMessage: WorkerMessageHandler,
    onExit: WorkerExitHandler,
  ): WorkerHandle {
    // Kill existing worker for this conversation if any
    this.kill(conversationKey);

    // F1: Enforce max workers cap to prevent fork-bomb DoS
    if (this.workers.size >= this.maxWorkers) {
      throw new Error(`Worker capacity exceeded (max ${this.maxWorkers})`);
    }

    // Build worker env — minimal base + agent secrets, no parent process secrets
    const agentEnv = loadAgentEnv(`${process.env.HOME ?? "/root"}/.mastersof-ai/agents/${agentId}`);
    const safeEnv = buildShellEnv(agentEnv);

    // W5-T04: Per-worker env injection — only safe vars + agent credentials.
    // ANTHROPIC_API_KEY must pass through (SDK needs it), but nothing else from process.env.
    const workerEnv: Record<string, string> = {
      ...safeEnv,
      ...(process.env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : {}),
      HOME: process.env.HOME ?? "/root",
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TZ: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
      WORKER_AGENT_ID: agentId,
      WORKER_USER_ID: userId,
    };

    // P2-4: Pass parent's execArgv so tsx loader is available in the child.
    // F3: Filter out --inspect/--inspect-brk to prevent debug port RCE in workers.
    const safeExecArgv = process.execArgv.filter((arg) => !arg.startsWith("--inspect") && !arg.startsWith("--debug"));

    const child = fork(WORKER_PATH, [], {
      env: workerEnv,
      execArgv: safeExecArgv,
      serialization: "json",
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });

    // Mutable handler references — updated per-message via updateHandler()
    const handlerRef = { current: onMessage };
    const exitHandlerRef = { current: onExit };

    // Handle IPC messages — delegates to mutable handlerRef
    child.on("message", (raw: unknown) => {
      state.handle.lastActivity = Date.now();
      this.resetIdleTimer(state);
      handlerRef.current(raw as WorkerToParentMessage);
    });

    // Handle worker exit
    child.on("exit", (code, signal) => {
      this.logger.info("session", "worker.exit", `Worker exited`, {
        details: { conversationKey, code, signal },
      });
      clearTimeout(state.idleTimer);
      if (state.killTimer) clearTimeout(state.killTimer);
      this.workers.delete(conversationKey);
      exitHandlerRef.current(code, signal);
    });

    child.on("error", (err) => {
      this.logger.error("session", "worker.error", `Worker process error: ${err.message}`, {
        details: { conversationKey },
      });
    });

    const handle: WorkerHandle = {
      process: child,
      agentId,
      userId,
      conversationKey,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };

    const state: InternalWorkerState = {
      handle,
      handlerRef,
      exitHandlerRef,
      idleTimer: setTimeout(() => {}, 0), // placeholder
      killTimer: null,
    };
    this.resetIdleTimer(state);
    this.workers.set(conversationKey, state);

    // Send init message
    const initMsg: IpcInitMessage = {
      type: "init",
      agentId,
      userId,
      configJson,
      accessUser: { name: userId, toolsDeny: userToolsDeny },
    };
    child.send(initMsg);

    this.logger.info("session", "worker.spawned", `Worker spawned for ${agentId}/${userId}`, {
      details: { conversationKey, pid: child.pid },
    });

    return handle;
  }

  /** Update the message handler for an existing worker (used per-message). */
  updateHandler(conversationKey: string, handler: WorkerMessageHandler): void {
    const state = this.workers.get(conversationKey);
    if (state) state.handlerRef.current = handler;
  }

  /** Update the exit handler for an existing worker. */
  updateExitHandler(conversationKey: string, handler: WorkerExitHandler): void {
    const state = this.workers.get(conversationKey);
    if (state) state.exitHandlerRef.current = handler;
  }

  /** Send a message to a worker by conversation key. */
  sendToWorker(conversationKey: string, msg: ParentToWorkerMessage): boolean {
    const state = this.workers.get(conversationKey);
    if (!state || !state.handle.process.connected) return false;
    state.handle.lastActivity = Date.now();
    state.handle.process.send(msg);
    return true;
  }

  /** Check if a worker exists for a conversation key. */
  has(conversationKey: string): boolean {
    return this.workers.has(conversationKey);
  }

  /** Kill a worker by conversation key. */
  kill(conversationKey: string): void {
    const state = this.workers.get(conversationKey);
    if (!state) return;

    clearTimeout(state.idleTimer);
    if (state.killTimer) clearTimeout(state.killTimer);

    if (state.handle.process.connected) {
      try {
        state.handle.process.send({ type: "shutdown" } satisfies ParentToWorkerMessage);
      } catch {
        // IPC already closed
      }
      // Force kill after 5s if graceful shutdown doesn't complete.
      // Timer is cleared by the exit handler if the worker exits cleanly.
      state.killTimer = setTimeout(() => {
        if (!state.handle.process.killed) {
          state.handle.process.kill("SIGKILL");
        }
      }, 5000);
    }

    this.workers.delete(conversationKey);
  }

  /** Kill all workers (used during server shutdown). */
  killAll(): void {
    for (const key of [...this.workers.keys()]) {
      this.kill(key);
    }
  }

  /** Number of active workers. */
  get size(): number {
    return this.workers.size;
  }

  private resetIdleTimer(state: InternalWorkerState): void {
    clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      this.logger.info("session", "worker.idle_timeout", `Worker idle timeout`, {
        details: { conversationKey: state.handle.conversationKey },
      });
      this.kill(state.handle.conversationKey);
    }, WORKER_IDLE_TIMEOUT_MS);
  }
}
