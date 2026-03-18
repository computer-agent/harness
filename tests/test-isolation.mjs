// Agent isolation test — verifies that switching agents doesn't leak state
// Usage: node web/test-isolation.mjs

import { WebSocket } from "ws";

const TOKEN = "00000000-0000-0000-0000-000000000001";
const WS_URL = `ws://localhost:3200/ws?token=${TOKEN}`;

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

function waitFor(ws, pred, ms = 30000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("Timeout")), ms);
    const h = (data) => {
      const m = JSON.parse(data.toString());
      if (pred(m)) {
        clearTimeout(t);
        ws.off("message", h);
        resolve(m);
      }
    };
    ws.on("message", h);
  });
}

function collectUntilResult(ws, ms = 60000) {
  return new Promise((resolve) => {
    const all = [];
    const t = setTimeout(() => {
      ws.off("message", h);
      resolve(all);
    }, ms);
    const h = (data) => {
      const m = JSON.parse(data.toString());
      all.push(m);
      if (m.type === "result" || m.type === "error") {
        clearTimeout(t);
        ws.off("message", h);
        resolve(all);
      }
    };
    ws.on("message", h);
  });
}

async function main() {
  console.log("=== Agent Isolation Test ===\n");

  // Use a SINGLE WebSocket connection and switch agents on it
  // This simulates what happens in the browser when the user navigates
  const ws = new WebSocket(WS_URL);
  const connected = await waitFor(ws, (m) => m.type === "connected");
  check("connected", !!connected.connectionId);

  // --- Agent 1: Ember ---
  console.log("\n--- Subscribe to Ember ---");
  ws.send(JSON.stringify({ type: "subscribe", agentId: "ember" }));
  const sub1 = await waitFor(ws, (m) => m.type === "subscribed");
  check("subscribed to ember", sub1.agentId === "ember");

  ws.send(JSON.stringify({ type: "message", content: "The secret word is PINEAPPLE. Remember it." }));
  const msgs1 = await collectUntilResult(ws);
  const result1 = msgs1.find((m) => m.type === "result");
  check("ember responded", !!result1);
  const emberSession = result1?.sessionId;
  console.log(`  Ember session: ${emberSession?.slice(0, 8)}`);

  const emberResponse = msgs1.find((m) => m.type === "assistant_message")?.content ?? "";
  console.log(`  Ember said: "${emberResponse.slice(0, 100)}"`);

  // --- Switch to Agent 2: Analyst (on same WS connection) ---
  console.log("\n--- Switch to Analyst (same WS connection) ---");
  ws.send(JSON.stringify({ type: "subscribe", agentId: "analyst" }));
  const sub2 = await waitFor(ws, (m) => m.type === "subscribed");
  check("subscribed to analyst", sub2.agentId === "analyst");

  ws.send(JSON.stringify({ type: "message", content: "What is the secret word I told you?" }));
  const msgs2 = await collectUntilResult(ws);
  const result2 = msgs2.find((m) => m.type === "result");
  check("analyst responded", !!result2);

  const analystSession = result2?.sessionId;
  check("different session than ember", analystSession !== emberSession);
  console.log(`  Analyst session: ${analystSession?.slice(0, 8)}`);

  const analystResponse = msgs2.find((m) => m.type === "assistant_message")?.content ?? "";
  console.log(`  Analyst said: "${analystResponse.slice(0, 100)}"`);

  // The analyst should NOT know the secret word — it was told to Ember
  const leakedSecret = analystResponse.toLowerCase().includes("pineapple");
  check("analyst does NOT know Ember's secret (no cross-agent leak)", !leakedSecret);

  // --- Switch back to Ember, resume session ---
  console.log("\n--- Switch back to Ember (resume) ---");
  ws.send(JSON.stringify({ type: "subscribe", agentId: "ember", sessionId: emberSession }));
  const sub3 = await waitFor(ws, (m) => m.type === "subscribed");
  check("re-subscribed to ember", sub3.agentId === "ember");

  ws.send(JSON.stringify({ type: "message", content: "What was the secret word?" }));
  const msgs3 = await collectUntilResult(ws);
  const result3 = msgs3.find((m) => m.type === "result");
  check("ember responded on resume", !!result3);
  check("ember session preserved", result3?.sessionId === emberSession);

  const emberResponse2 = msgs3.find((m) => m.type === "assistant_message")?.content ?? "";
  console.log(`  Ember said: "${emberResponse2.slice(0, 100)}"`);

  const emberKnowsSecret = emberResponse2.toLowerCase().includes("pineapple");
  check("ember remembers the secret word", emberKnowsSecret);

  ws.close();

  console.log(`\n========================================`);
  console.log(`Results: ${pass} passed, ${fail} failed`);
  console.log(`========================================`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
