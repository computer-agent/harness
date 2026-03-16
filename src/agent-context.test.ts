import assert from "node:assert";
import { describe, it } from "node:test";
import { AgentNotFoundError } from "./agent-context.js";

describe("AgentNotFoundError", () => {
  it("has agentName property", () => {
    const err = new AgentNotFoundError("test-agent", "not found");
    assert.strictEqual(err.agentName, "test-agent");
    assert.ok(err.message.includes("test-agent"));
    assert.strictEqual(err.name, "AgentNotFoundError");
  });
});
