// Ember conversation flow test — tests multi-turn tool use
// Usage: node web/test-ember-flow.mjs
// Requires: backend running on :3100

import { WebSocket } from "ws";

const TOKEN = "b3f88d0b-e226-486e-b0f6-80a5b98535cc";
const WS_URL = `ws://localhost:3100/ws?token=${TOKEN}`;
const TIMEOUT = 120_000; // 2 minutes — tool use can be slow

function connectAndSubscribe() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const timer = setTimeout(() => reject(new Error("Connect timeout")), 10000);

    ws.on("open", () => {
      // Wait for connected message, then subscribe
    });

    const messages = [];
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      messages.push(msg);

      if (msg.type === "connected") {
        ws.send(JSON.stringify({ type: "subscribe", agentId: "ember" }));
      }
      if (msg.type === "subscribed") {
        clearTimeout(timer);
        resolve({ ws, messages });
      }
      if (msg.type === "error") {
        clearTimeout(timer);
        reject(new Error(`WS error: ${msg.message}`));
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function sendAndCollect(ws, content, timeoutMs = TIMEOUT) {
  return new Promise((resolve, _reject) => {
    const messages = [];
    const timer = setTimeout(() => {
      ws.off("message", handler);
      console.log(`  WARN: Timed out after ${timeoutMs / 1000}s with ${messages.length} messages`);
      resolve(messages);
    }, timeoutMs);

    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      messages.push(msg);

      // Log each message type in real time
      if (msg.type === "status") {
        process.stdout.write(`  [status: ${msg.status}]`);
      } else if (msg.type === "token") {
        process.stdout.write(".");
      } else if (msg.type === "thinking_token") {
        process.stdout.write("T");
      } else if (msg.type === "tool_use_start") {
        process.stdout.write(`\n  [tool: ${msg.toolName}]`);
      } else if (msg.type === "assistant_message") {
        process.stdout.write("\n  [assistant_message]");
      } else if (msg.type === "result") {
        process.stdout.write(`\n  [result: session=${msg.sessionId?.slice(0, 8)}, interrupted=${msg.interrupted}]\n`);
      } else if (msg.type === "subagent_started") {
        process.stdout.write(`\n  [subagent: ${msg.description}]`);
      } else if (msg.type === "subagent_done") {
        process.stdout.write(`\n  [subagent done: ${msg.status}]`);
      } else if (msg.type === "error") {
        process.stdout.write(`\n  [ERROR: ${msg.code} - ${msg.message}]`);
      } else {
        process.stdout.write(`\n  [${msg.type}]`);
      }

      // Stop when we get the final result
      if (msg.type === "result") {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(messages);
      }
      // Also stop on error (it might be the only thing we get)
      if (msg.type === "error") {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(messages);
      }
    };

    ws.on("message", handler);
    ws.send(JSON.stringify({ type: "message", content }));
  });
}

async function main() {
  console.log("=== Ember Flow Test ===\n");

  // Test 1: Simple greeting (may trigger MEMORY_READ + response)
  console.log("--- Test 1: Simple hello ---");
  const { ws, messages: _setupMsgs } = await connectAndSubscribe();
  console.log("  Connected and subscribed\n");

  const msgs1 = await sendAndCollect(ws, "Hello! What's your name?");
  console.log("");

  const types1 = msgs1.map((m) => m.type);
  const uniqueTypes1 = [...new Set(types1)];
  console.log(`  Message types: ${uniqueTypes1.join(", ")}`);
  console.log(`  Total messages: ${msgs1.length}`);

  const hasResult1 = types1.includes("result");
  const hasAssistant1 = types1.includes("assistant_message");
  const hasTokens1 = types1.includes("token");
  const toolCalls1 = msgs1.filter((m) => m.type === "tool_use_start").map((m) => m.toolName);

  console.log(`  Tool calls: ${toolCalls1.length > 0 ? toolCalls1.join(", ") : "none"}`);
  console.log(`  Has result: ${hasResult1}`);
  console.log(`  Has assistant_message: ${hasAssistant1}`);
  console.log(`  Has tokens: ${hasTokens1}`);

  if (hasAssistant1) {
    const am = msgs1.find((m) => m.type === "assistant_message");
    console.log(`  Response: "${am.content.slice(0, 150)}${am.content.length > 150 ? "..." : ""}"`);
  }

  const result1 = msgs1.find((m) => m.type === "result");
  const sessionId = result1?.sessionId;
  console.log(`  Session ID: ${sessionId}`);

  // Evaluate
  let pass = 0;
  let fail = 0;
  function check(desc, cond) {
    if (cond) {
      console.log(`  PASS: ${desc}`);
      pass++;
    } else {
      console.log(`  FAIL: ${desc}`);
      fail++;
    }
  }

  check("received result", hasResult1);
  check(
    "received assistant_message with content",
    hasAssistant1 && msgs1.find((m) => m.type === "assistant_message")?.content?.length > 0,
  );
  check("received text tokens", hasTokens1);
  check("got SDK session ID", !!sessionId);

  // Test 2: Follow-up (tests resume)
  if (sessionId) {
    console.log("\n--- Test 2: Follow-up (resume) ---");

    // Reconnect with session ID
    ws.close();
    const { ws: ws2 } = await connectAndSubscribe2(sessionId);

    const msgs2 = await sendAndCollect(ws2, "What's 2+2? Answer in one word.");
    console.log("");

    const hasResult2 = msgs2.some((m) => m.type === "result");
    const hasAssistant2 = msgs2.some((m) => m.type === "assistant_message");
    const result2 = msgs2.find((m) => m.type === "result");

    check("resume: received result", hasResult2);
    check("resume: received assistant_message", hasAssistant2);
    check("resume: session ID preserved", result2?.sessionId === sessionId);

    if (hasAssistant2) {
      const am = msgs2.find((m) => m.type === "assistant_message");
      console.log(`  Response: "${am.content.slice(0, 150)}"`);
    }

    ws2.close();
  }

  console.log(`\n========================================`);
  console.log(`Results: ${pass} passed, ${fail} failed`);
  console.log(`========================================`);
  process.exit(fail > 0 ? 1 : 0);
}

function connectAndSubscribe2(sessionId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const timer = setTimeout(() => reject(new Error("Connect timeout")), 10000);

    const messages = [];
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      messages.push(msg);

      if (msg.type === "connected") {
        ws.send(JSON.stringify({ type: "subscribe", agentId: "ember", sessionId }));
      }
      if (msg.type === "subscribed") {
        clearTimeout(timer);
        resolve({ ws, messages });
      }
    });

    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
