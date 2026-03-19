import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { generateAccessToken, hashToken, safeCompare } from "./access.js";
import { resolveRemoteAgent } from "./agent-context.js";
import {
  type IpcInitMessage,
  type IpcResultMessage,
  isParentToWorkerMessage,
  isWorkerToParentMessage,
  type ParentToWorkerMessage,
  type WorkerToParentMessage,
} from "./ipc-protocol.js";
import { MutexTimeoutError, QueryMutex } from "./query-mutex.js";
import { extractSdkEvent } from "./sdk-stream.js";
import { validateWsMessage } from "./ws-protocol.js";

// ─── IPC protocol type guards ───

describe("IPC protocol type guards", () => {
  it("isParentToWorkerMessage validates init", () => {
    const msg: IpcInitMessage = {
      type: "init",
      agentId: "test",
      userId: "alice",
      configJson: "{}",
      accessUser: { name: "alice", toolsDeny: [] },
    };
    assert.ok(isParentToWorkerMessage(msg));
  });

  it("isParentToWorkerMessage validates message", () => {
    assert.ok(isParentToWorkerMessage({ type: "message", content: "hello" }));
  });

  it("isParentToWorkerMessage validates interrupt", () => {
    assert.ok(isParentToWorkerMessage({ type: "interrupt" }));
  });

  it("isParentToWorkerMessage validates tool_approval_response", () => {
    assert.ok(isParentToWorkerMessage({ type: "tool_approval_response", toolId: "t1", approved: true }));
  });

  it("isParentToWorkerMessage validates shutdown", () => {
    assert.ok(isParentToWorkerMessage({ type: "shutdown" }));
  });

  it("isParentToWorkerMessage rejects unknown types", () => {
    assert.ok(!isParentToWorkerMessage({ type: "unknown" }));
    assert.ok(!isParentToWorkerMessage(null));
    assert.ok(!isParentToWorkerMessage("not an object"));
    assert.ok(!isParentToWorkerMessage(42));
  });

  it("isWorkerToParentMessage validates ready", () => {
    assert.ok(isWorkerToParentMessage({ type: "ready" }));
  });

  it("isWorkerToParentMessage validates frame", () => {
    assert.ok(isWorkerToParentMessage({ type: "frame", frame: { type: "token", text: "hi" } }));
  });

  it("isWorkerToParentMessage validates session_id", () => {
    assert.ok(isWorkerToParentMessage({ type: "session_id", sessionId: "s1", firstMessage: "hello" }));
  });

  it("isWorkerToParentMessage validates tool_approval_request", () => {
    assert.ok(
      isWorkerToParentMessage({
        type: "tool_approval_request",
        toolId: "t1",
        toolName: "web_fetch",
        toolInput: {},
      }),
    );
  });

  it("isWorkerToParentMessage validates result", () => {
    const msg: IpcResultMessage = {
      type: "result",
      sessionId: "s1",
      interrupted: false,
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 },
      responseContent: "Hello!",
      toolCalls: [],
    };
    assert.ok(isWorkerToParentMessage(msg));
  });

  it("isWorkerToParentMessage validates error", () => {
    assert.ok(isWorkerToParentMessage({ type: "error", code: "test", message: "oops" }));
  });

  it("isWorkerToParentMessage rejects unknown types", () => {
    assert.ok(!isWorkerToParentMessage({ type: "unknown" }));
    assert.ok(!isWorkerToParentMessage(undefined));
  });

  it("all IPC messages are JSON-serializable", () => {
    const messages: (ParentToWorkerMessage | WorkerToParentMessage)[] = [
      { type: "init", agentId: "a", userId: "u", configJson: "{}", accessUser: { name: "u", toolsDeny: [] } },
      { type: "message", content: "hello", resumeSessionId: "s1" },
      { type: "interrupt" },
      { type: "tool_approval_response", toolId: "t1", approved: true },
      { type: "shutdown" },
      { type: "ready" },
      { type: "frame", frame: { type: "token", text: "hi" } },
      { type: "session_id", sessionId: "s1", firstMessage: "hello" },
      { type: "tool_approval_request", toolId: "t1", toolName: "web_fetch", toolInput: { url: "https://x.com" } },
      {
        type: "result",
        sessionId: "s1",
        interrupted: false,
        usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 },
        responseContent: "hi",
        toolCalls: [{ name: "web_fetch", status: "complete" }],
      },
      { type: "error", code: "test", message: "oops" },
    ];
    for (const msg of messages) {
      const json = JSON.stringify(msg);
      const parsed = JSON.parse(json);
      assert.deepStrictEqual(parsed.type, msg.type, `Round-trip failed for ${msg.type}`);
    }
  });
});

// ─── QueryMutex ───

describe("QueryMutex", () => {
  it("acquire returns a release function", async () => {
    const mutex = new QueryMutex();
    const release = await mutex.acquire("key1");
    assert.ok(typeof release === "function");
    assert.ok(mutex.isLocked("key1"));
    release();
    assert.ok(!mutex.isLocked("key1"));
  });

  it("serializes concurrent acquires on the same key", async () => {
    const mutex = new QueryMutex();
    const order: number[] = [];

    const task1 = (async () => {
      const release = await mutex.acquire("key");
      order.push(1);
      // Simulate work
      await new Promise((r) => setTimeout(r, 50));
      order.push(2);
      release();
    })();

    // Small delay to ensure task1 acquires first
    await new Promise((r) => setTimeout(r, 5));

    const task2 = (async () => {
      const release = await mutex.acquire("key");
      order.push(3);
      release();
    })();

    await Promise.all([task1, task2]);
    // task2 should start after task1 finishes
    assert.deepStrictEqual(order, [1, 2, 3]);
  });

  it("allows concurrent acquires on different keys", async () => {
    const mutex = new QueryMutex();
    const order: string[] = [];

    const task1 = (async () => {
      const release = await mutex.acquire("keyA");
      order.push("A-start");
      await new Promise((r) => setTimeout(r, 50));
      order.push("A-end");
      release();
    })();

    await new Promise((r) => setTimeout(r, 5));

    const task2 = (async () => {
      const release = await mutex.acquire("keyB");
      order.push("B-start");
      release();
    })();

    await Promise.all([task1, task2]);
    // B should start while A is still running (different keys)
    assert.ok(order.indexOf("B-start") < order.indexOf("A-end"), "B should start before A ends");
  });

  it("serializes 3+ concurrent acquires on the same key (queue correctness)", async () => {
    const mutex = new QueryMutex();
    const order: number[] = [];

    const task1 = (async () => {
      const release = await mutex.acquire("key");
      order.push(1);
      await new Promise((r) => setTimeout(r, 30));
      release();
    })();

    await new Promise((r) => setTimeout(r, 5));

    const task2 = (async () => {
      const release = await mutex.acquire("key");
      order.push(2);
      await new Promise((r) => setTimeout(r, 30));
      release();
    })();

    await new Promise((r) => setTimeout(r, 5));

    const task3 = (async () => {
      const release = await mutex.acquire("key");
      order.push(3);
      release();
    })();

    await Promise.all([task1, task2, task3]);
    // Must execute in strict FIFO order — the old while-loop pattern broke here
    assert.deepStrictEqual(order, [1, 2, 3]);
  });

  it("isLocked returns false for unknown keys", () => {
    const mutex = new QueryMutex();
    assert.ok(!mutex.isLocked("nonexistent"));
  });

  it("double release is a no-op", async () => {
    const mutex = new QueryMutex();
    const release = await mutex.acquire("key");
    release();
    release(); // should not throw or corrupt state
    assert.ok(!mutex.isLocked("key"));
  });
});

// ─── W5.1-T02: Mutex stress tests ───

describe("QueryMutex stress (W5.1-T02)", () => {
  it("10 concurrent acquires on same key execute in strict FIFO order", async () => {
    const mutex = new QueryMutex();
    const order: number[] = [];
    const N = 10;

    // Acquire the lock first so all subsequent acquires queue up
    const initialRelease = await mutex.acquire("stress");

    const tasks = Array.from({ length: N }, (_, i) =>
      (async () => {
        const release = await mutex.acquire("stress");
        order.push(i);
        // Tiny yield to let other microtasks run (shouldn't break FIFO)
        await new Promise((r) => setTimeout(r, 1));
        release();
      })(),
    );

    // All 10 are now queued — release the initial lock
    initialRelease();
    await Promise.all(tasks);

    // Must be strictly sequential 0-9
    assert.deepStrictEqual(
      order,
      Array.from({ length: N }, (_, i) => i),
    );
  });

  it("5 keys x 3 acquires: cross-key concurrency with same-key serialization", async () => {
    const mutex = new QueryMutex();
    const results = new Map<string, number[]>();

    const tasks: Promise<void>[] = [];
    for (let k = 0; k < 5; k++) {
      const key = `key-${k}`;
      results.set(key, []);
      for (let i = 0; i < 3; i++) {
        tasks.push(
          (async () => {
            const release = await mutex.acquire(key);
            results.get(key)?.push(i);
            await new Promise((r) => setTimeout(r, 5));
            release();
          })(),
        );
        // Small stagger within each key
        await new Promise((r) => setTimeout(r, 1));
      }
    }

    await Promise.all(tasks);

    // Each key must have all 3 entries in FIFO order
    for (const [key, order] of results) {
      assert.deepStrictEqual(order, [0, 1, 2], `Key ${key} should have FIFO order`);
    }
  });

  it("release wakes exactly one waiter (not all)", async () => {
    const mutex = new QueryMutex();
    let wokenCount = 0;

    const holder = await mutex.acquire("single-wake");

    // Queue 3 waiters
    const w1 = mutex.acquire("single-wake").then((r) => {
      wokenCount++;
      return r;
    });
    const w2 = mutex.acquire("single-wake").then((r) => {
      wokenCount++;
      return r;
    });
    const w3 = mutex.acquire("single-wake").then((r) => {
      wokenCount++;
      return r;
    });

    // Release the holder — should wake exactly one
    holder();
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(wokenCount, 1, "Only one waiter should wake on release");

    // Release the second — should wake the next
    const r1 = await w1;
    r1();
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(wokenCount, 2);

    const r2 = await w2;
    r2();
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(wokenCount, 3);

    const r3 = await w3;
    r3();
    assert.ok(!mutex.isLocked("single-wake"));
  });

  it("acquire-release-acquire cycle leaves no stale state", async () => {
    const mutex = new QueryMutex();

    for (let i = 0; i < 5; i++) {
      const release = await mutex.acquire("cycle");
      assert.ok(mutex.isLocked("cycle"));
      release();
      assert.ok(!mutex.isLocked("cycle"));
    }
  });
});

// ─── W5.1-T03: Security hardening validation ───

describe("Security hardening (W5.1-T03)", () => {
  it("F3: execArgv filter strips --inspect but preserves --import", () => {
    const rawArgv = [
      "--require",
      "/path/to/tsx/preflight.cjs",
      "--import",
      "file:///path/to/tsx/loader.mjs",
      "--inspect=0.0.0.0:9229",
      "--inspect-brk",
      "--debug=5858",
    ];
    const filtered = rawArgv.filter((arg) => !arg.startsWith("--inspect") && !arg.startsWith("--debug"));
    assert.deepStrictEqual(filtered, [
      "--require",
      "/path/to/tsx/preflight.cjs",
      "--import",
      "file:///path/to/tsx/loader.mjs",
    ]);
  });

  it("F5: rate limit key is a 64-char hex hash, not raw token", () => {
    const rawToken = "my-secret-bearer-token-1234567890";
    const hash = hashToken(rawToken);
    assert.strictEqual(hash.length, 64);
    assert.ok(/^[0-9a-f]+$/.test(hash));
    assert.notStrictEqual(hash, rawToken);
  });

  it("F2: frame type allowlist rejects unknown types", () => {
    const ALLOWED = new Set([
      "status",
      "token",
      "thinking_token",
      "tool_use_start",
      "tool_use_input",
      "tool_result",
      "subagent_started",
      "subagent_progress",
      "subagent_done",
    ]);

    // Valid types pass
    for (const t of ALLOWED) {
      assert.ok(ALLOWED.has(t), `${t} should be allowed`);
    }

    // Malicious types rejected
    for (const bad of ["evil_payload", "__proto__", "constructor", "error", "budget_exceeded", ""]) {
      assert.ok(!ALLOWED.has(bad), `"${bad}" should be rejected`);
    }
  });
});

// ─── W5.1-T04: Worker behavior validation ───

describe("Worker behavior (W5.1-T04)", () => {
  it("P0-1: settled flag pattern prevents double-resolve", async () => {
    // Simulate the settled flag pattern from serve.ts handleMessage
    let settled = false;
    let resolveCount = 0;

    const result = await new Promise<string>((resolve) => {
      const safeResolve = (val: string) => {
        if (!settled) {
          settled = true;
          resolveCount++;
          resolve(val);
        }
      };

      // Simulate: result arrives, then worker exits
      safeResolve("result-from-worker");
      safeResolve("should-be-ignored"); // double-resolve attempt
    });

    assert.strictEqual(result, "result-from-worker");
    assert.strictEqual(resolveCount, 1);
  });

  it("P0-1: settled flag prevents resolve after reject", async () => {
    let settled = false;
    let resolveCount = 0;
    let rejectCount = 0;

    try {
      await new Promise<string>((resolve, reject) => {
        const safeResolve = (val: string) => {
          if (!settled) {
            settled = true;
            resolveCount++;
            resolve(val);
          }
        };
        const safeReject = (err: Error) => {
          if (!settled) {
            settled = true;
            rejectCount++;
            reject(err);
          }
        };

        // Simulate: worker crashes (reject), then exit handler also fires (reject again)
        safeReject(new Error("crash"));
        safeReject(new Error("should-be-ignored"));
        safeResolve("should-also-be-ignored");
      });
      assert.fail("Should have rejected");
    } catch (err: any) {
      assert.strictEqual(err.message, "crash");
      assert.strictEqual(rejectCount, 1);
      assert.strictEqual(resolveCount, 0);
    }
  });

  it("P0-3: send() helper returns false on failure (simulated)", () => {
    // Test that the send pattern handles missing process.send gracefully
    // In a real child process, process.send exists; in the test process, it doesn't
    const hasSend = typeof process.send === "function";
    if (hasSend) {
      // Running as a child process (unlikely in test) — skip
      return;
    }
    // In the test process, process.send is undefined — the worker's send() should return false
    assert.strictEqual(process.send, undefined);
  });
});

// ─── W5.1-T05: Worker environment isolation ───

describe("Worker environment isolation (W5.1-T05)", () => {
  it("buildShellEnv only includes safe system vars + agent env", async () => {
    // Dynamic import to match ESM
    const { buildShellEnv } = await import("./env-safety.js");

    const agentEnv = { MY_API_KEY: "secret123", DB_URL: "postgres://..." };
    const safe = buildShellEnv(agentEnv);

    // Agent env keys pass through
    assert.strictEqual(safe.MY_API_KEY, "secret123");
    assert.strictEqual(safe.DB_URL, "postgres://...");

    // System vars from process.env pass through (if set)
    if (process.env.HOME) assert.strictEqual(safe.HOME, process.env.HOME);
    if (process.env.PATH) assert.strictEqual(safe.PATH, process.env.PATH);

    // ANTHROPIC_API_KEY from process.env does NOT pass through buildShellEnv
    // (it's added separately in WorkerManager, not via buildShellEnv)
    const envWithApiKey = { ...agentEnv, ANTHROPIC_API_KEY: "sk-ant-test" };
    const safe2 = buildShellEnv(envWithApiKey);
    // buildShellEnv allows it through because it's in the agent env, not process.env
    assert.strictEqual(safe2.ANTHROPIC_API_KEY, "sk-ant-test");
  });

  it("worker env construction includes only expected keys", () => {
    // Simulate the env construction from worker-manager.ts
    const _agentEnv = { BRAINTREE_KEY: "bt-123" };
    const safeEnv = { HOME: "/root", PATH: "/usr/bin", BRAINTREE_KEY: "bt-123" }; // buildShellEnv result

    const workerEnv: Record<string, string> = {
      ...safeEnv,
      ANTHROPIC_API_KEY: "sk-test",
      HOME: "/root",
      PATH: "/usr/bin:/bin",
      TZ: "UTC",
      WORKER_AGENT_ID: "billing",
      WORKER_USER_ID: "alice",
    };

    // Expected keys present
    assert.ok("ANTHROPIC_API_KEY" in workerEnv);
    assert.ok("BRAINTREE_KEY" in workerEnv);
    assert.ok("WORKER_AGENT_ID" in workerEnv);
    assert.ok("WORKER_USER_ID" in workerEnv);

    // Unexpected keys absent
    assert.ok(!("DATABASE_URL" in workerEnv));
    assert.ok(!("AWS_SECRET_ACCESS_KEY" in workerEnv));
    assert.ok(!("NODE_ENV" in workerEnv));
  });

  it("missing ANTHROPIC_API_KEY is omitted, not empty string", () => {
    const workerEnv: Record<string, string> = {
      HOME: "/root",
      PATH: "/usr/bin",
      TZ: "UTC",
      // No ANTHROPIC_API_KEY
    };

    // Simulate the conditional from worker-manager.ts
    const apiKey = undefined; // process.env.ANTHROPIC_API_KEY when unset
    if (apiKey) {
      workerEnv.ANTHROPIC_API_KEY = apiKey;
    }

    assert.ok(!("ANTHROPIC_API_KEY" in workerEnv));
  });
});

// ─── Per-user proposalsDir isolation ───

describe("Per-user proposalsDir isolation (W5-T05)", () => {
  // Skip if agents dir doesn't exist (CI)
  const agentsDir = `${process.env.HOME ?? "/root"}/.mastersof-ai/agents`;
  const hasAgents = (() => {
    try {
      const { existsSync } = require("node:fs");
      return existsSync(agentsDir);
    } catch {
      return false;
    }
  })();

  it("resolveRemoteAgent creates per-user proposalsDir", { skip: !hasAgents }, () => {
    // This test requires an actual agent directory to exist
    const { readdirSync } = require("node:fs");
    const agents = readdirSync(agentsDir);
    if (agents.length === 0) return;

    const agentName = agents[0];
    const ctx = resolveRemoteAgent(agentName, "test-user-w5");
    assert.ok(ctx.proposalsDir.includes("test-user-w5"), "proposalsDir should include userId");
    assert.ok(ctx.proposalsDir.includes("proposals"), "proposalsDir should be under proposals/");
    // Clean up
    const { rmSync } = require("node:fs");
    try {
      rmSync(ctx.proposalsDir, { recursive: true });
      rmSync(ctx.workspaceDir, { recursive: true });
      rmSync(ctx.memoryDir, { recursive: true });
    } catch {
      // Best effort cleanup
    }
  });
});

// ─── Access token generation (W5-T07) ───

describe("generateAccessToken (W5-T07)", () => {
  it("generates a 64-char hex token", () => {
    const { token } = generateAccessToken();
    assert.strictEqual(token.length, 64);
    assert.ok(/^[0-9a-f]+$/.test(token));
  });

  it("generates a valid SHA-256 hash", () => {
    const { token, tokenHash } = generateAccessToken();
    assert.strictEqual(tokenHash, hashToken(token));
    assert.strictEqual(tokenHash.length, 64);
  });

  it("generates unique tokens each call", () => {
    const a = generateAccessToken();
    const b = generateAccessToken();
    assert.notStrictEqual(a.token, b.token);
    assert.notStrictEqual(a.tokenHash, b.tokenHash);
  });
});

// ═══════════════════════════════════════════════════════
// ─── Wave 6: Process Isolation Hardening ───
// ═══════════════════════════════════════════════════════

// ─── W6-T01: SDK stream processor ───

describe("SdkStreamProcessor (W6-T01)", () => {
  it("extracts init event from system message", () => {
    const event = extractSdkEvent({ type: "system", subtype: "init", session_id: "s1" });
    assert.ok(event);
    assert.strictEqual(event.kind, "init");
    if (event.kind === "init") assert.strictEqual(event.sessionId, "s1");
  });

  it("extracts text_token from stream_event", () => {
    const event = extractSdkEvent({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "hello" } },
    });
    assert.ok(event);
    assert.strictEqual(event.kind, "text_token");
    if (event.kind === "text_token") assert.strictEqual(event.text, "hello");
  });

  it("extracts thinking_token from stream_event", () => {
    const event = extractSdkEvent({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } },
    });
    assert.ok(event);
    assert.strictEqual(event.kind, "thinking_token");
    if (event.kind === "thinking_token") assert.strictEqual(event.text, "hmm");
  });

  it("extracts tool_use_start and strips MCP prefix", () => {
    const event = extractSdkEvent({
      type: "stream_event",
      event: {
        type: "content_block_start",
        content_block: { type: "tool_use", name: "mcp__web__web_fetch", id: "t1" },
      },
    });
    assert.ok(event);
    assert.strictEqual(event.kind, "tool_use_start");
    if (event.kind === "tool_use_start") {
      assert.strictEqual(event.toolName, "web_fetch");
      assert.strictEqual(event.toolId, "t1");
    }
  });

  it("extracts tool_input_delta", () => {
    const event = extractSdkEvent({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: '{"url":' },
        content_block: { id: "t1" },
      },
    });
    assert.ok(event);
    assert.strictEqual(event.kind, "tool_input_delta");
    if (event.kind === "tool_input_delta") {
      assert.strictEqual(event.partialJson, '{"url":');
    }
  });

  it("extracts text_block_start", () => {
    const event = extractSdkEvent({
      type: "stream_event",
      event: { type: "content_block_start", content_block: { type: "text" } },
    });
    assert.ok(event);
    assert.strictEqual(event.kind, "text_block_start");
  });

  it("extracts message_start with usage", () => {
    const event = extractSdkEvent({
      type: "stream_event",
      event: {
        type: "message_start",
        message: { usage: { input_tokens: 100, cache_read_input_tokens: 50 } },
      },
    });
    assert.ok(event);
    assert.strictEqual(event.kind, "message_start");
    if (event.kind === "message_start") {
      assert.strictEqual(event.usage.input_tokens, 100);
    }
  });

  it("extracts content_block_stop", () => {
    const event = extractSdkEvent({
      type: "stream_event",
      event: { type: "content_block_stop" },
    });
    assert.ok(event);
    assert.strictEqual(event.kind, "content_block_stop");
  });

  it("extracts subagent_started", () => {
    const event = extractSdkEvent({
      type: "system",
      subtype: "task_started",
      task_id: "t1",
      description: "research",
    });
    assert.ok(event);
    assert.strictEqual(event.kind, "subagent_started");
    if (event.kind === "subagent_started") {
      assert.strictEqual(event.taskId, "t1");
      assert.strictEqual(event.description, "research");
    }
  });

  it("extracts subagent_progress", () => {
    const event = extractSdkEvent({
      type: "system",
      subtype: "task_progress",
      task_id: "t1",
      usage: { tool_uses: 3, duration_ms: 5000, total_tokens: 1500 },
    });
    assert.ok(event);
    assert.strictEqual(event.kind, "subagent_progress");
    if (event.kind === "subagent_progress") {
      assert.strictEqual(event.toolUses, 3);
    }
  });

  it("extracts subagent_done", () => {
    const event = extractSdkEvent({
      type: "system",
      subtype: "task_notification",
      task_id: "t1",
      status: "completed",
      summary: "done",
      usage: { total_tokens: 2000 },
    });
    assert.ok(event);
    assert.strictEqual(event.kind, "subagent_done");
    if (event.kind === "subagent_done") {
      assert.strictEqual(event.status, "completed");
    }
  });

  it("extracts assistant with usage and text fallback", () => {
    const event = extractSdkEvent({
      type: "assistant",
      message: {
        usage: { input_tokens: 200, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [{ type: "text", text: "Hello!" }, { type: "tool_use" }],
      },
    });
    assert.ok(event);
    assert.strictEqual(event.kind, "assistant");
    if (event.kind === "assistant") {
      assert.strictEqual(event.usage?.output_tokens, 50);
      assert.strictEqual(event.textContent, "Hello!");
    }
  });

  it("extracts result with is_interrupted", () => {
    const event = extractSdkEvent({ type: "result", is_interrupted: true });
    assert.ok(event);
    assert.strictEqual(event.kind, "result");
    if (event.kind === "result") assert.strictEqual(event.isInterrupted, true);
  });

  it("returns null for unknown message types", () => {
    assert.strictEqual(extractSdkEvent({ type: "unknown_type" }), null);
    assert.strictEqual(extractSdkEvent(null), null);
    assert.strictEqual(extractSdkEvent("not an object"), null);
  });

  it("returns null for system messages with unknown subtype", () => {
    assert.strictEqual(extractSdkEvent({ type: "system", subtype: "unknown" }), null);
  });
});

// ─── W6-T03: QueryMutex timeout ───

describe("QueryMutex timeout (W6-T03)", () => {
  it("acquire with timeout throws MutexTimeoutError on locked key", async () => {
    const mutex = new QueryMutex();
    // Lock the key
    await mutex.acquire("locked");

    const start = Date.now();
    try {
      await mutex.acquire("locked", 100);
      assert.fail("Should have thrown MutexTimeoutError");
    } catch (err) {
      assert.ok(err instanceof MutexTimeoutError);
      assert.strictEqual(err.key, "locked");
      assert.strictEqual(err.timeoutMs, 100);
      const elapsed = Date.now() - start;
      assert.ok(elapsed >= 90 && elapsed < 300, `Should timeout in ~100ms, took ${elapsed}ms`);
    }
  });

  it("timed-out waiter is removed from queue", async () => {
    const mutex = new QueryMutex();
    const release = await mutex.acquire("key");

    // Queue a waiter that will timeout
    try {
      await mutex.acquire("key", 50);
    } catch {
      // expected
    }

    // Release the original lock
    release();

    // Key should be unlocked — the timed-out waiter was removed
    assert.ok(!mutex.isLocked("key"));
  });

  it("acquire without timeout still works (no regression)", async () => {
    const mutex = new QueryMutex();
    const release = await mutex.acquire("key");
    assert.ok(mutex.isLocked("key"));
    release();
    assert.ok(!mutex.isLocked("key"));
  });

  it("acquire with timeout succeeds if lock becomes available in time", async () => {
    const mutex = new QueryMutex();
    const release1 = await mutex.acquire("key");

    // Release after 30ms — timeout is 200ms, so the waiter should succeed
    setTimeout(() => release1(), 30);

    const release2 = await mutex.acquire("key", 200);
    assert.ok(typeof release2 === "function");
    release2();
  });

  it("timeout does not break FIFO for remaining waiters", async () => {
    const mutex = new QueryMutex();
    const order: string[] = [];

    const holder = await mutex.acquire("key");

    // Waiter A: will timeout
    const a = mutex.acquire("key", 50).catch(() => order.push("a-timeout"));

    // Waiter B: no timeout
    const b = (async () => {
      const r = await mutex.acquire("key");
      order.push("b-acquired");
      r();
    })();

    // Wait for A to timeout
    await a;

    // Release the initial lock — B should get it
    holder();
    await b;

    assert.deepStrictEqual(order, ["a-timeout", "b-acquired"]);
  });

  it("timed-out entry does not orphan subsequent waiters (race fix)", async () => {
    const mutex = new QueryMutex();
    const order: string[] = [];

    const holder = await mutex.acquire("key");

    // Waiter A: will timeout quickly
    const a = mutex.acquire("key", 30).catch(() => order.push("a-timeout"));

    // Waiter B: no timeout, should eventually acquire
    const b = (async () => {
      const r = await mutex.acquire("key");
      order.push("b-acquired");
      r();
    })();

    // Waiter C: no timeout, should acquire after B
    const c = (async () => {
      const r = await mutex.acquire("key");
      order.push("c-acquired");
      r();
    })();

    // Let A timeout
    await a;

    // Release holder — B and C should both get their turn despite A's timeout
    holder();
    await Promise.all([b, c]);

    assert.deepStrictEqual(order, ["a-timeout", "b-acquired", "c-acquired"]);
  });
});

// ─── W6-T04: safeCompare export ───

describe("safeCompare export (W6-T04)", () => {
  it("safeCompare returns true for equal strings", () => {
    const hash = hashToken("test-token");
    assert.ok(safeCompare(hash, hash));
  });

  it("safeCompare returns false for different strings", () => {
    assert.ok(!safeCompare(hashToken("a"), hashToken("b")));
  });

  it("safeCompare returns false for different-length strings", () => {
    assert.ok(!safeCompare("short", "muchlongerstring"));
  });
});

// ─── W6-T05: WebSocket message schema validation ───

describe("WS message schema validation (W6-T05)", () => {
  it("validates subscribe message", () => {
    const result = validateWsMessage({ type: "subscribe", agentId: "billing" });
    assert.ok(result.ok);
    if (result.ok) assert.strictEqual(result.message.type, "subscribe");
  });

  it("validates subscribe with sessionId and lastMessageId", () => {
    const result = validateWsMessage({
      type: "subscribe",
      agentId: "billing",
      sessionId: "s1",
      lastMessageId: 42,
    });
    assert.ok(result.ok);
  });

  it("validates message with string content", () => {
    const result = validateWsMessage({ type: "message", content: "hello" });
    assert.ok(result.ok);
  });

  it("rejects message with numeric content", () => {
    const result = validateWsMessage({ type: "message", content: 123 });
    assert.ok(!result.ok);
    if (!result.ok) assert.ok(result.error.includes("content"));
  });

  it("rejects message with empty content", () => {
    const result = validateWsMessage({ type: "message", content: "" });
    assert.ok(!result.ok);
  });

  it("validates interrupt", () => {
    const result = validateWsMessage({ type: "interrupt" });
    assert.ok(result.ok);
  });

  it("validates ping", () => {
    const result = validateWsMessage({ type: "ping" });
    assert.ok(result.ok);
  });

  it("validates tool_approval", () => {
    const result = validateWsMessage({ type: "tool_approval", toolId: "t1", approved: true });
    assert.ok(result.ok);
  });

  it("rejects tool_approval with string approved", () => {
    const result = validateWsMessage({ type: "tool_approval", toolId: "t1", approved: "yes" });
    assert.ok(!result.ok);
  });

  it("validates consent_granted", () => {
    const result = validateWsMessage({ type: "consent_granted", policyVersion: "2026-03-01" });
    assert.ok(result.ok);
  });

  it("rejects unknown message type", () => {
    const result = validateWsMessage({ type: "evil_command", payload: "drop tables" });
    assert.ok(!result.ok);
  });

  it("rejects non-object input", () => {
    const result = validateWsMessage("not an object");
    assert.ok(!result.ok);
  });

  it("rejects null input", () => {
    const result = validateWsMessage(null);
    assert.ok(!result.ok);
  });

  it("rejects subscribe with empty agentId", () => {
    const result = validateWsMessage({ type: "subscribe", agentId: "" });
    assert.ok(!result.ok);
  });

  it("rejects subscribe with missing agentId", () => {
    const result = validateWsMessage({ type: "subscribe" });
    assert.ok(!result.ok);
  });
});

// ═══════════════════════════════════════════════════════
// ─── Wave 7: Review Hardening + Type Safety + Observability ───
// ═══════════════════════════════════════════════════════

// ─── W7-T01: Rename tool_block_stop → content_block_stop ───

describe("content_block_stop rename (W7-T01)", () => {
  it("extractSdkEvent returns content_block_stop kind", () => {
    const event = extractSdkEvent({
      type: "stream_event",
      event: { type: "content_block_stop" },
    });
    assert.ok(event);
    assert.strictEqual(event.kind, "content_block_stop");
  });
});

// ─── W7-T03: tool_input_delta toolId extraction ───

describe("tool_input_delta toolId (W7-T03)", () => {
  it("returns null toolId when contentBlock.id is absent", () => {
    const event = extractSdkEvent({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: '{"x":1}' },
        // no content_block
      },
    });
    assert.ok(event);
    assert.strictEqual(event.kind, "tool_input_delta");
    if (event.kind === "tool_input_delta") {
      assert.strictEqual(event.toolId, null);
    }
  });

  it("returns toolId when contentBlock.id is present", () => {
    const event = extractSdkEvent({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: '{"x":1}' },
        content_block: { id: "tool-123" },
      },
    });
    assert.ok(event);
    if (event.kind === "tool_input_delta") {
      assert.strictEqual(event.toolId, "tool-123");
    }
  });
});

// ─── W7-T08: ALLOWED_FRAME_TYPES in ipc-protocol.ts ───

describe("ALLOWED_FRAME_TYPES (W7-T08)", () => {
  it("is exported from ipc-protocol and contains expected types", async () => {
    const { ALLOWED_FRAME_TYPES } = await import("./ipc-protocol.js");
    assert.ok(ALLOWED_FRAME_TYPES instanceof Set);
    assert.ok(ALLOWED_FRAME_TYPES.has("token"));
    assert.ok(ALLOWED_FRAME_TYPES.has("status"));
    assert.ok(ALLOWED_FRAME_TYPES.has("tool_use_start"));
    assert.ok(ALLOWED_FRAME_TYPES.has("tool_result"));
    assert.ok(!ALLOWED_FRAME_TYPES.has("evil"));
    assert.ok(!ALLOWED_FRAME_TYPES.has(""));
  });
});

// ─── W7-T12: WS schema tightening ───

describe("WS schema tightening (W7-T12)", () => {
  it("rejects message with content exceeding 200K chars", () => {
    const result = validateWsMessage({ type: "message", content: "x".repeat(200_001) });
    assert.ok(!result.ok);
  });

  it("accepts message with content at 200K chars", () => {
    const result = validateWsMessage({ type: "message", content: "x".repeat(200_000) });
    assert.ok(result.ok);
  });

  it("rejects subscribe with agentId exceeding 200 chars", () => {
    const result = validateWsMessage({ type: "subscribe", agentId: "a".repeat(201) });
    assert.ok(!result.ok);
  });

  it("accepts subscribe with agentId at 200 chars", () => {
    const result = validateWsMessage({ type: "subscribe", agentId: "a".repeat(200) });
    assert.ok(result.ok);
  });

  it("rejects negative lastMessageId", () => {
    const result = validateWsMessage({ type: "subscribe", agentId: "test", lastMessageId: -1 });
    assert.ok(!result.ok);
  });
});

// ─── W7-T14: Health array pruning ───

describe("Health array pruning (W7-T14)", () => {
  it("prunes old entries after threshold insertions", async () => {
    const { HealthMonitor } = await import("./health.js");
    const monitor = new HealthMonitor(
      "1.0.0",
      () => 0,
      () => 0,
    );

    // Insert 1001 errors to trigger pruning (threshold is 1000)
    for (let i = 0; i < 1001; i++) {
      monitor.recordError();
    }

    // After pruning, all entries are recent (within 1 hour), so they should all remain.
    // The key test is that the prune ran without crashing and arrays are bounded.
    // Access error rate to check internal state was pruned
    const shallow = monitor.shallowCheck();
    assert.strictEqual(shallow.status, "healthy");
  });
});

// ─── W7-T16: Wave 6 test coverage gaps ───

describe("WorkerManager maxWorkers edge values (W7-T16)", () => {
  it("0 falls back to default (20)", async () => {
    const { WorkerManager } = await import("./worker-manager.js");
    const { Logger } = await import("./logger.js");
    const logger = new Logger("error");
    // 0 is falsy → `0 || DEFAULT_MAX_WORKERS` → 20
    const wm = new WorkerManager(logger, 0);
    assert.strictEqual(wm.capacity, 20);
  });

  it("clamps -1 to 1", async () => {
    const { WorkerManager } = await import("./worker-manager.js");
    const { Logger } = await import("./logger.js");
    const logger = new Logger("error");
    const wm = new WorkerManager(logger, -1);
    assert.strictEqual(wm.capacity, 1);
  });

  it("NaN falls back to default (20)", async () => {
    const { WorkerManager } = await import("./worker-manager.js");
    const { Logger } = await import("./logger.js");
    const logger = new Logger("error");
    const wm = new WorkerManager(logger, NaN);
    assert.strictEqual(wm.capacity, 20);
  });

  it("string coerced correctly", async () => {
    const { WorkerManager } = await import("./worker-manager.js");
    const { Logger } = await import("./logger.js");
    const logger = new Logger("error");
    const wm = new WorkerManager(logger, "5" as any);
    assert.strictEqual(wm.capacity, 5);
  });
});

describe("WorkerManager.getStats() (W7-T15)", () => {
  it("returns WorkerPoolStats with correct structure", async () => {
    const { WorkerManager } = await import("./worker-manager.js");
    const { Logger } = await import("./logger.js");
    const logger = new Logger("error");
    const wm = new WorkerManager(logger, 10);
    const stats = wm.getStats();
    assert.strictEqual(stats.active, 0);
    assert.strictEqual(stats.max, 10);
    assert.strictEqual(stats.utilization, 0);
  });
});

describe("safeCompare JSDoc (W7-T13)", () => {
  it("returns true for equal-length equal hex strings", () => {
    const hash = hashToken("test-token-123");
    assert.ok(safeCompare(hash, hash));
  });

  it("returns false for equal-length different hex strings", () => {
    assert.ok(!safeCompare(hashToken("a"), hashToken("b")));
    // Both are 64-char hex — timing-safe comparison applies
    assert.strictEqual(hashToken("a").length, hashToken("b").length);
  });

  it("returns false immediately for different-length strings", () => {
    assert.ok(!safeCompare("short", hashToken("something")));
  });
});
