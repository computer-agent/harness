// Tests Ember with a prompt that triggers tool calls (memory reads, task lists)
// Usage: node web/test-ember-tools.mjs

import { WebSocket } from "ws";

const TOKEN = "00000000-0000-0000-0000-000000000001";
const WS_URL = `ws://localhost:3200/ws?token=${TOKEN}`;

function connect(sessionId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const timer = setTimeout(() => reject(new Error("Connect timeout")), 10000);
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === "connected") {
        const sub = { type: "subscribe", agentId: "ember" };
        if (sessionId) sub.sessionId = sessionId;
        ws.send(JSON.stringify(sub));
      }
      if (msg.type === "subscribed") {
        clearTimeout(timer);
        resolve(ws);
      }
      if (msg.type === "error") {
        clearTimeout(timer);
        reject(new Error(msg.message));
      }
    });
    ws.on("error", reject);
  });
}

function sendAndWatch(ws, content, timeoutMs = 120_000) {
  return new Promise((resolve) => {
    const all = [];
    const toolCalls = [];
    let textTokenCount = 0;
    let thinkingTokenCount = 0;

    const timer = setTimeout(() => {
      ws.off("message", handler);
      console.log(`\n  TIMEOUT after ${timeoutMs / 1000}s — ${all.length} messages received`);
      resolve({ all, toolCalls, textTokenCount, thinkingTokenCount, timedOut: true });
    }, timeoutMs);

    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      all.push(msg);

      switch (msg.type) {
        case "status":
          process.stdout.write(`\n  [${msg.status}] `);
          break;
        case "thinking_token":
          thinkingTokenCount++;
          if (thinkingTokenCount % 5 === 0) process.stdout.write("T");
          break;
        case "token":
          textTokenCount++;
          process.stdout.write(msg.text);
          break;
        case "tool_use_start":
          toolCalls.push(msg.toolName);
          process.stdout.write(`\n  >>> TOOL: ${msg.toolName} (id: ${msg.toolId})`);
          break;
        case "tool_use_input":
          // Show first bit of tool input
          if (msg.partialJson && msg.partialJson.length < 100) {
            process.stdout.write(` ${msg.partialJson}`);
          }
          break;
        case "assistant_message":
          process.stdout.write(`\n  >>> ASSISTANT_MESSAGE (${msg.content?.length ?? 0} chars)`);
          break;
        case "error":
          process.stdout.write(`\n  >>> ERROR: ${msg.code} — ${msg.message}`);
          break;
        case "result":
          process.stdout.write(`\n  >>> RESULT: session=${msg.sessionId?.slice(0, 8)} interrupted=${msg.interrupted}`);
          clearTimeout(timer);
          ws.off("message", handler);
          resolve({ all, toolCalls, textTokenCount, thinkingTokenCount, timedOut: false, sessionId: msg.sessionId });
          return;
      }
    };

    ws.on("message", handler);
    ws.send(JSON.stringify({ type: "message", content }));
  });
}

async function main() {
  let pass = 0,
    fail = 0;
  function check(d, c) {
    if (c) {
      console.log(`  PASS: ${d}`);
      pass++;
    } else {
      console.log(`  FAIL: ${d}`);
      fail++;
    }
  }

  // Test 1: Trigger tool use with context-heavy prompt
  console.log("=== Test: Ember with tool-triggering prompt ===\n");
  const ws = await connect();
  console.log("  Connected\n");

  const r1 = await sendAndWatch(ws, "What projects are we currently working on? Check your memory and tasks.");
  console.log("\n");

  check("did not time out", !r1.timedOut);
  check("received text tokens", r1.textTokenCount > 0);
  check("used tools", r1.toolCalls.length > 0);
  console.log(`  Tools used: ${r1.toolCalls.join(", ") || "none"}`);
  console.log(`  Text tokens: ${r1.textTokenCount}, Thinking tokens: ${r1.thinkingTokenCount}`);
  console.log(`  Session: ${r1.sessionId}`);

  const assistantMsg = r1.all.find((m) => m.type === "assistant_message");
  if (assistantMsg) {
    console.log(`  Final response (first 200 chars): "${assistantMsg.content?.slice(0, 200)}"`);
  }

  // Test 2: Follow-up in same session
  if (r1.sessionId && !r1.timedOut) {
    console.log("\n=== Test: Follow-up after tool use ===\n");
    ws.close();
    const ws2 = await connect(r1.sessionId);

    const r2 = await sendAndWatch(ws2, "Summarize that in one sentence.");
    console.log("\n");

    check("follow-up did not time out", !r2.timedOut);
    check("follow-up has text", r2.textTokenCount > 0);
    check("session preserved", r2.sessionId === r1.sessionId);

    ws2.close();
  } else {
    ws.close();
  }

  console.log(`\n========================================`);
  console.log(`Results: ${pass} passed, ${fail} failed`);
  console.log(`========================================`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
