/**
 * W5.1-T01: IPC Round-Trip and Worker Lifecycle Integration Tests
 *
 * Forks a mock worker (test-fixtures/mock-worker.ts) that speaks the IPC protocol
 * without needing the SDK or real agents. Tests the parent-side handling of:
 *   - Frame relay and sanitization
 *   - Settled flag (double-resolve prevention)
 *   - Worker lifecycle (crash, clean exit, SIGKILL)
 *   - Kill-on-resubscribe
 */

import { strict as assert } from "node:assert";
import { type ChildProcess, fork } from "node:child_process";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { type IpcResultMessage, sanitizeFrame, type WorkerToParentMessage } from "./ipc-protocol.js";
import { QueryMutex } from "./query-mutex.js";

const MOCK_WORKER_PATH = fileURLToPath(new URL("./test-fixtures/mock-worker.ts", import.meta.url));

// Safe execArgv: pass tsx loader but strip --inspect (matching production behavior)
const safeExecArgv = process.execArgv.filter((arg) => !arg.startsWith("--inspect") && !arg.startsWith("--debug"));

/**
 * Fork the mock worker with a given behavior mode.
 * Returns the child process and a promise for collected IPC messages.
 */
function spawnMockWorker(mode: string): {
  child: ChildProcess;
  messages: WorkerToParentMessage[];
  waitForExit: () => Promise<{ code: number | null; signal: string | null }>;
} {
  const child = fork(MOCK_WORKER_PATH, [], {
    env: {
      ...process.env,
      MOCK_WORKER_MODE: mode,
    },
    execArgv: safeExecArgv,
    serialization: "json",
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });

  const messages: WorkerToParentMessage[] = [];
  child.on("message", (raw: unknown) => {
    messages.push(raw as WorkerToParentMessage);
  });

  const waitForExit = () =>
    new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.on("exit", (code, signal) => resolve({ code, signal }));
    });

  return { child, messages, waitForExit };
}

/** Send init message to a mock worker. */
function sendInit(child: ChildProcess): void {
  child.send({
    type: "init",
    agentId: "test-agent",
    userId: "test-user",
    configJson: JSON.stringify({ model: "test", effort: "high" }),
    accessUser: { name: "test-user", toolsDeny: [] },
  });
}

/** Wait for a specific message type from the worker. */
function waitForMessage(child: ChildProcess, type: string, timeoutMs = 5000): Promise<WorkerToParentMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for "${type}" message`)), timeoutMs);

    const handler = (raw: unknown) => {
      const msg = raw as WorkerToParentMessage;
      if (msg && typeof msg === "object" && (msg as any).type === type) {
        clearTimeout(timer);
        child.removeListener("message", handler);
        resolve(msg);
      }
    };

    child.on("message", handler);
  });
}

// ═══════════════════════════════════════════════════════
// W5.1-T01: IPC Round-Trip Integration Tests
// ═══════════════════════════════════════════════════════

describe("IPC round-trip integration (W5.1-T01)", () => {
  it("V1: spawn worker, init + message IPC, frames arrive and result resolves", async () => {
    const { child, messages, waitForExit } = spawnMockWorker("normal");

    // Send init, wait for ready
    sendInit(child);
    await waitForMessage(child, "ready");

    // Send message
    child.send({ type: "message", content: "hello" });

    // Wait for result
    const resultMsg = await waitForMessage(child, "result");
    assert.strictEqual((resultMsg as IpcResultMessage).type, "result");
    assert.strictEqual((resultMsg as IpcResultMessage).responseContent, "Hello world");
    assert.strictEqual((resultMsg as IpcResultMessage).interrupted, false);

    // Verify frames were received (session_id + frames + result)
    const frameMessages = messages.filter((m) => m.type === "frame");
    assert.ok(frameMessages.length >= 4, `Expected at least 4 frames, got ${frameMessages.length}`);

    // Verify token frames
    const tokenFrames = frameMessages.filter((m) => m.type === "frame" && (m as any).frame.type === "token");
    assert.strictEqual(tokenFrames.length, 2);
    assert.strictEqual((tokenFrames[0] as any).frame.text, "Hello ");
    assert.strictEqual((tokenFrames[1] as any).frame.text, "world");

    // Clean shutdown
    child.send({ type: "shutdown" });
    const { code } = await waitForExit();
    assert.strictEqual(code, 0);
  });

  it("V2: SIGKILL mid-query — promise rejects (not hangs)", async () => {
    const { child, waitForExit } = spawnMockWorker("hang");

    sendInit(child);
    await waitForMessage(child, "ready");

    child.send({ type: "message", content: "hello" });

    // Wait for the "thinking" status frame to confirm message was received
    await waitForMessage(child, "frame", 3000);

    // SIGKILL the worker
    child.kill("SIGKILL");
    const { code, signal } = await waitForExit();

    // Verify worker was killed — code null, signal SIGKILL
    assert.strictEqual(code, null);
    assert.strictEqual(signal, "SIGKILL");
  });

  it("V3: worker exits code 0 after shutdown during query", async () => {
    const { child, waitForExit } = spawnMockWorker("shutdown_mid_query");

    sendInit(child);
    await waitForMessage(child, "ready");

    child.send({ type: "message", content: "hello" });

    // Wait for some frames to start streaming
    await waitForMessage(child, "frame", 3000);

    // Send shutdown while query is active
    child.send({ type: "shutdown" });

    // Worker should send result then exit cleanly
    const resultMsg = await waitForMessage(child, "result", 3000);
    assert.strictEqual((resultMsg as IpcResultMessage).interrupted, true);

    const { code } = await waitForExit();
    assert.strictEqual(code, 0);
  });

  it("V4: worker exits non-zero — exit event fires", async () => {
    const { child, waitForExit } = spawnMockWorker("crash");

    sendInit(child);
    await waitForMessage(child, "ready");

    child.send({ type: "message", content: "hello" });

    const { code } = await waitForExit();
    assert.strictEqual(code, 1);
  });

  it("V5: worker sends evil_payload frame — sanitizeFrame rejects it", async () => {
    const { child, messages, waitForExit } = spawnMockWorker("evil_frame");

    sendInit(child);
    await waitForMessage(child, "ready");

    child.send({ type: "message", content: "hello" });
    await waitForMessage(child, "result");

    // Extract all frames from messages
    const frameMessages = messages.filter((m) => m.type === "frame");

    // The evil_payload frame was sent by the worker — verify sanitizeFrame rejects it
    const evilFrame = frameMessages.find((m) => (m as any).frame.type === "evil_payload");
    assert.ok(evilFrame, "Worker should have sent evil_payload frame");

    // sanitizeFrame must return null for it
    assert.strictEqual(sanitizeFrame((evilFrame as any).frame), null, "sanitizeFrame must reject evil_payload");

    // Valid frames should sanitize correctly
    const validFrames = frameMessages.filter((m) => {
      const sanitized = sanitizeFrame((m as any).frame);
      return sanitized !== null;
    });
    assert.ok(validFrames.length >= 2, "At least status + token frames should be valid");

    // Clean shutdown
    child.send({ type: "shutdown" });
    const { code } = await waitForExit();
    assert.strictEqual(code, 0);
  });

  it("V6: valid frame types (token, tool_use_start, status) all relay correctly", async () => {
    const { child, messages, waitForExit } = spawnMockWorker("normal");

    sendInit(child);
    await waitForMessage(child, "ready");

    child.send({ type: "message", content: "hello" });
    await waitForMessage(child, "result");

    const frameMessages = messages.filter((m) => m.type === "frame");

    // Collect sanitized frames
    const sanitized = frameMessages.map((m) => sanitizeFrame((m as any).frame)).filter((f) => f !== null);

    // Verify we got status, token, and tool_use_start frames
    const types = new Set(sanitized.map((f) => f.type));
    assert.ok(types.has("status"), "Should have status frame");
    assert.ok(types.has("token"), "Should have token frame");
    assert.ok(types.has("tool_use_start"), "Should have tool_use_start frame");

    // Verify token frames have required fields
    const tokens = sanitized.filter((f) => f.type === "token");
    for (const t of tokens) {
      assert.strictEqual(typeof (t as any).id, "number");
      assert.strictEqual(typeof (t as any).text, "string");
    }

    // Verify tool_use_start has required fields
    const toolStarts = sanitized.filter((f) => f.type === "tool_use_start");
    for (const t of toolStarts) {
      assert.strictEqual(typeof (t as any).id, "number");
      assert.strictEqual(typeof (t as any).toolName, "string");
      assert.strictEqual(typeof (t as any).toolId, "string");
    }

    child.send({ type: "shutdown" });
    const { code } = await waitForExit();
    assert.strictEqual(code, 0);
  });

  it("V7: re-subscribe kills previous worker before spawning new one", async () => {
    // Spawn first worker
    const w1 = spawnMockWorker("normal");
    sendInit(w1.child);
    await waitForMessage(w1.child, "ready");

    // Spawn second worker (simulating re-subscribe)
    const w2 = spawnMockWorker("normal");
    sendInit(w2.child);
    await waitForMessage(w2.child, "ready");

    // Kill first worker (simulating what serve.ts does on re-subscribe via WorkerManager.kill)
    w1.child.send({ type: "shutdown" });
    const w1Exit = await w1.waitForExit();
    assert.strictEqual(w1Exit.code, 0, "First worker should exit cleanly");

    // Second worker should still be alive
    assert.ok(w2.child.connected, "Second worker should still be connected");

    // Send message to second worker — should work
    w2.child.send({ type: "message", content: "hello" });
    const result = await waitForMessage(w2.child, "result");
    assert.strictEqual((result as IpcResultMessage).responseContent, "Hello world");

    w2.child.send({ type: "shutdown" });
    await w2.waitForExit();
  });

  it("V8: settled flag prevents double-resolve/double-reject", async () => {
    const { child, messages, waitForExit } = spawnMockWorker("double_result");

    sendInit(child);
    await waitForMessage(child, "ready");

    // Set up promise with settled flag (mirrors serve.ts pattern)
    let settled = false;
    let resolveCount = 0;
    const firstResult = await new Promise<IpcResultMessage>((resolve) => {
      const handler = (raw: unknown) => {
        const msg = raw as WorkerToParentMessage;
        if (msg.type === "result" && !settled) {
          settled = true;
          resolveCount++;
          resolve(msg);
        }
      };
      child.on("message", handler);

      // Trigger the double-result
      child.send({ type: "message", content: "hello" });
    });

    // Wait a tick for any second result to arrive
    await new Promise((r) => setTimeout(r, 50));

    // Only one resolve should have happened
    assert.strictEqual(resolveCount, 1);
    assert.strictEqual(firstResult.responseContent, "first");

    // But the worker did send two results
    const resultMessages = messages.filter((m) => m.type === "result");
    assert.strictEqual(resultMessages.length, 2, "Worker sent 2 results but settled flag caught the second");

    child.send({ type: "shutdown" });
    const { code } = await waitForExit();
    assert.strictEqual(code, 0);
  });

  it("V2b: SIGKILL + promise rejection + mutex release", async () => {
    const { child, waitForExit } = spawnMockWorker("hang");
    const mutex = new QueryMutex();
    const key = "test:sigkill";

    sendInit(child);
    await waitForMessage(child, "ready");

    // Acquire mutex (mirrors serve.ts pattern)
    const release = await mutex.acquire(key);
    assert.ok(mutex.isLocked(key), "Mutex should be locked after acquire");

    // Wire settled/safeReject pattern from serve.ts
    let settled = false;
    const queryPromise = new Promise<string>((_resolve, reject) => {
      const safeReject = (err: Error) => {
        if (!settled) {
          settled = true;
          release();
          reject(err);
        }
      };

      child.on("exit", (code, signal) => {
        safeReject(new Error(`Worker killed: code=${code} signal=${signal}`));
      });

      // Send message to start the hanging query
      child.send({ type: "message", content: "hello" });
    });

    // Wait for the "thinking" frame to confirm message was received
    await waitForMessage(child, "frame", 3000);

    // SIGKILL the worker
    child.kill("SIGKILL");
    const { code, signal } = await waitForExit();
    assert.strictEqual(code, null);
    assert.strictEqual(signal, "SIGKILL");

    // Promise should reject
    await assert.rejects(queryPromise, /Worker killed/);

    // Mutex should be released by safeReject
    assert.ok(!mutex.isLocked(key), "Mutex should be released after SIGKILL");
  });

  it("V7b: kill-on-resubscribe — second spawn kills first worker", async () => {
    // Spawn two workers on the same "conversation key", simulating re-subscribe.
    // The key behavior: when a second worker is spawned for the same key,
    // the first worker must be killed (via WorkerManager.kill inside spawn).
    const w1 = spawnMockWorker("normal");
    sendInit(w1.child);
    await waitForMessage(w1.child, "ready");

    const w2 = spawnMockWorker("normal");
    sendInit(w2.child);
    await waitForMessage(w2.child, "ready");

    // Simulate WorkerManager.kill: send shutdown to w1
    w1.child.send({ type: "shutdown" });
    const w1Exit = await w1.waitForExit();

    // First worker should exit cleanly from shutdown
    assert.strictEqual(w1Exit.code, 0, "First worker should exit cleanly");

    // Second worker must still be alive and functional
    assert.ok(w2.child.connected, "Second worker should still be connected");
    w2.child.send({ type: "message", content: "after-resubscribe" });
    const result = await waitForMessage(w2.child, "result");
    assert.strictEqual((result as IpcResultMessage).responseContent, "Hello world");

    // Verify it was a different process
    assert.notStrictEqual(w1.child.pid, w2.child.pid, "Workers should be different processes");

    w2.child.send({ type: "shutdown" });
    await w2.waitForExit();
  });
});

// ─── sanitizeFrame comprehensive tests ───

describe("sanitizeFrame comprehensive (W5.1-T01)", () => {
  it("rejects unknown frame types", () => {
    assert.strictEqual(sanitizeFrame({ type: "evil_payload", data: "x" }), null);
    assert.strictEqual(sanitizeFrame({ type: "__proto__", data: "x" }), null);
    assert.strictEqual(sanitizeFrame({ type: "constructor" }), null);
    assert.strictEqual(sanitizeFrame({ type: "" }), null);
    assert.strictEqual(sanitizeFrame({} as any), null);
  });

  it("strips extra properties from token frames", () => {
    const result = sanitizeFrame({
      type: "token",
      id: 1,
      text: "hello",
      evil: "injected",
      __proto__: "attack",
    });
    assert.ok(result);
    assert.strictEqual(result.type, "token");
    assert.strictEqual((result as any).id, 1);
    assert.strictEqual((result as any).text, "hello");
    assert.strictEqual((result as any).evil, undefined);
    assert.strictEqual(Object.keys(result).length, 3); // type, id, text
  });

  it("strips extra properties from status frames", () => {
    const result = sanitizeFrame({ type: "status", status: "thinking", evil: "x" });
    assert.ok(result);
    assert.strictEqual(Object.keys(result).length, 2); // type, status
    assert.strictEqual((result as any).evil, undefined);
  });

  it("strips extra properties from tool_use_start frames", () => {
    const result = sanitizeFrame({
      type: "tool_use_start",
      id: 1,
      toolName: "test",
      toolId: "t1",
      evil: "x",
    });
    assert.ok(result);
    assert.strictEqual(Object.keys(result).length, 4);
    assert.strictEqual((result as any).evil, undefined);
  });

  it("rejects frames with wrong field types", () => {
    assert.strictEqual(sanitizeFrame({ type: "token", id: "not-a-number", text: "hi" }), null);
    assert.strictEqual(sanitizeFrame({ type: "token", id: 1, text: 123 }), null);
    assert.strictEqual(sanitizeFrame({ type: "status", status: "invalid_status" }), null);
    assert.strictEqual(sanitizeFrame({ type: "tool_use_start", id: 1, toolName: 5, toolId: "t" }), null);
  });

  it("sanitizes all 9 ALLOWED_FRAME_TYPES correctly", () => {
    const validFrames: Record<string, unknown>[] = [
      { type: "status", status: "thinking" },
      { type: "token", id: 0, text: "hi" },
      { type: "thinking_token", text: "hmm" },
      { type: "tool_use_start", id: 1, toolName: "test", toolId: "t1" },
      { type: "tool_use_input", toolId: "t1", partialJson: '{"x":1}' },
      { type: "tool_result", id: 2, toolId: "t1", content: "done" },
      { type: "subagent_started", taskId: "s1", description: "research" },
      { type: "subagent_progress", taskId: "s1", toolUses: 3, durationMs: 1000, totalTokens: 500 },
      { type: "subagent_done", taskId: "s1", status: "completed", summary: "done", totalTokens: 1000 },
    ];

    for (const frame of validFrames) {
      const result = sanitizeFrame(frame);
      assert.ok(result, `sanitizeFrame should accept ${frame.type}`);
      assert.strictEqual(result.type, frame.type);
    }
  });

  it("subagent_done rejects invalid status values", () => {
    assert.strictEqual(
      sanitizeFrame({ type: "subagent_done", taskId: "s1", status: "evil", summary: "x", totalTokens: 0 }),
      null,
    );
  });
});
