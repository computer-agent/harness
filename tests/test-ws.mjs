// WebSocket integration test — validates the full conversation flow.
// Usage: node web/test-ws.mjs
// Requires: backend running on :3100

import { WebSocket } from "ws";

const TOKEN = "b3f88d0b-e226-486e-b0f6-80a5b98535cc";
const WS_URL = `ws://localhost:3100/ws?token=${TOKEN}`;

let pass = 0;
let fail = 0;

function check(desc, condition) {
  if (condition) {
    console.log(`  PASS: ${desc}`);
    pass++;
  } else {
    console.log(`  FAIL: ${desc}`);
    fail++;
  }
}

function waitForMessage(ws, predicate, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timeout waiting for message")), timeoutMs);
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(msg);
      }
    };
    ws.on("message", handler);
  });
}

function collectMessages(ws, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const msgs = [];
    const timer = setTimeout(() => {
      ws.off("message", handler);
      resolve(msgs);
    }, timeoutMs);
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      msgs.push(msg);
      // Stop collecting when we get a result (end of turn)
      if (msg.type === "result" || (msg.type === "status" && msg.status === "idle")) {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(msgs);
      }
    };
    ws.on("message", handler);
  });
}

async function testInvalidToken() {
  console.log("\n=== Test: Invalid token rejected ===");
  return new Promise((resolve) => {
    const ws = new WebSocket("ws://localhost:3100/ws?token=bad-token");
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      check("error type for invalid token", msg.type === "error");
      check("auth_failed code", msg.code === "auth_failed");
    });
    ws.on("close", (code) => {
      check("connection closed with 4001", code === 4001);
      resolve();
    });
  });
}

async function testNewConversation() {
  console.log("\n=== Test: New conversation (no session ID) ===");
  const ws = new WebSocket(WS_URL);

  // Wait for connected
  const connected = await waitForMessage(ws, (m) => m.type === "connected");
  check("received connected message", !!connected.connectionId);

  // Subscribe without session ID
  ws.send(JSON.stringify({ type: "subscribe", agentId: "ember" }));
  const subscribed = await waitForMessage(ws, (m) => m.type === "subscribed");
  check("received subscribed message", subscribed.type === "subscribed");
  check("agentId is ember", subscribed.agentId === "ember");
  check("session is (new)", subscribed.sessionId === "(new)");

  // Send a message
  ws.send(JSON.stringify({ type: "message", content: "Say hello in exactly 5 words." }));

  // Collect all streaming messages
  const messages = await collectMessages(ws, 30000);
  const types = messages.map((m) => m.type);

  console.log(`  INFO: received ${messages.length} messages: ${[...new Set(types)].join(", ")}`);

  check("received status=thinking", types.includes("status"));
  check("received tokens", types.includes("token"));
  check("received assistant_message", types.includes("assistant_message"));
  check("received result", types.includes("result"));

  const result = messages.find((m) => m.type === "result");
  check("result has sessionId (SDK-assigned)", !!result?.sessionId && result.sessionId !== "(new)");
  check("result not interrupted", result?.interrupted === false);

  const assistantMsg = messages.find((m) => m.type === "assistant_message");
  check("assistant message has content", !!assistantMsg?.content && assistantMsg.content.length > 0);

  console.log(`  INFO: session ID = ${result?.sessionId}`);
  console.log(`  INFO: assistant said: "${assistantMsg?.content?.slice(0, 100)}"`);

  ws.close();
  return result?.sessionId;
}

async function testResumeConversation(sessionId) {
  console.log(`\n=== Test: Resume conversation (session ${sessionId?.slice(0, 8)}...) ===`);
  if (!sessionId) {
    console.log("  SKIP: no session ID from previous test");
    return;
  }

  const ws = new WebSocket(WS_URL);
  await waitForMessage(ws, (m) => m.type === "connected");

  // Subscribe WITH session ID
  ws.send(JSON.stringify({ type: "subscribe", agentId: "ember", sessionId }));
  const subscribed = await waitForMessage(ws, (m) => m.type === "subscribed");
  check("subscribed with session ID", subscribed.sessionId === sessionId);

  // Send follow-up message
  ws.send(JSON.stringify({ type: "message", content: "What did I just ask you?" }));
  const messages = await collectMessages(ws, 30000);
  const types = messages.map((m) => m.type);

  check("received response for resumed session", types.includes("assistant_message"));
  const result = messages.find((m) => m.type === "result");
  check("session ID preserved", result?.sessionId === sessionId);

  const assistantMsg = messages.find((m) => m.type === "assistant_message");
  console.log(`  INFO: assistant said: "${assistantMsg?.content?.slice(0, 100)}"`);

  ws.close();
}

async function testSubscribeRequired() {
  console.log("\n=== Test: Message before subscribe rejected ===");
  const ws = new WebSocket(WS_URL);
  await waitForMessage(ws, (m) => m.type === "connected");

  ws.send(JSON.stringify({ type: "message", content: "hello" }));
  const error = await waitForMessage(ws, (m) => m.type === "error");
  check("not_subscribed error", error.code === "not_subscribed");

  ws.close();
}

async function testUnknownAgent() {
  console.log("\n=== Test: Unknown agent rejected ===");
  const ws = new WebSocket(WS_URL);
  await waitForMessage(ws, (m) => m.type === "connected");

  ws.send(JSON.stringify({ type: "subscribe", agentId: "nonexistent-agent" }));
  const error = await waitForMessage(ws, (m) => m.type === "error");
  check("agent_not_found error", error.code === "agent_not_found");

  ws.close();
}

// Run all tests
try {
  await testInvalidToken();
  await testSubscribeRequired();
  await testUnknownAgent();
  const sessionId = await testNewConversation();
  await testResumeConversation(sessionId);

  console.log(`\n========================================`);
  console.log(`Results: ${pass} passed, ${fail} failed`);
  console.log(`========================================`);
  process.exit(fail > 0 ? 1 : 0);
} catch (err) {
  console.error("Test error:", err);
  process.exit(1);
}
