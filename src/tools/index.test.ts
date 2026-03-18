import assert from "node:assert";
import { describe, it } from "node:test";
import type { HarnessConfig } from "../config.js";
import { isToolEnabled, type ToolFilter } from "./index.js";

// Minimal config with all tools enabled
const allEnabledConfig: HarnessConfig = {
  model: "test",
  defaultAgent: "test",
  tools: {
    memory: { enabled: true },
    workspace: { enabled: true },
    web: { enabled: true },
    shell: { enabled: true },
    tasks: { enabled: true },
    introspection: { enabled: true },
    models: { enabled: true },
    scratchpad: { enabled: true },
    a2a: { enabled: true, agents: {} },
  },
  hooks: {
    logToolUse: false,
    verifyBeforeComplete: true,
    loopDetection: true,
    loopDetectionThreshold: 3,
    compactSuccessOutput: true,
    compactOutputThreshold: 50,
  },
  effort: "high",
};

// Config with shell disabled globally
const shellDisabledConfig: HarnessConfig = {
  ...allEnabledConfig,
  tools: {
    ...allEnabledConfig.tools,
    shell: { enabled: false },
  },
};

describe("isToolEnabled", () => {
  it("returns true for enabled domain with no filter", () => {
    assert.strictEqual(isToolEnabled("memory", allEnabledConfig), true);
    assert.strictEqual(isToolEnabled("shell", allEnabledConfig), true);
  });

  it("returns false for globally disabled domain even with allow filter", () => {
    assert.strictEqual(isToolEnabled("shell", shellDisabledConfig, { allow: ["shell"] }), false);
  });

  it("returns true for domain in allow list", () => {
    const filter: ToolFilter = { allow: ["memory", "web"] };
    assert.strictEqual(isToolEnabled("memory", allEnabledConfig, filter), true);
    assert.strictEqual(isToolEnabled("web", allEnabledConfig, filter), true);
  });

  it("returns false for domain not in allow list", () => {
    const filter: ToolFilter = { allow: ["memory", "web"] };
    assert.strictEqual(isToolEnabled("shell", allEnabledConfig, filter), false);
    assert.strictEqual(isToolEnabled("tasks", allEnabledConfig, filter), false);
    assert.strictEqual(isToolEnabled("introspection", allEnabledConfig, filter), false);
  });

  it("returns true for domain not in deny list", () => {
    const filter: ToolFilter = { deny: ["shell"] };
    assert.strictEqual(isToolEnabled("memory", allEnabledConfig, filter), true);
    assert.strictEqual(isToolEnabled("web", allEnabledConfig, filter), true);
  });

  it("returns false for domain in deny list", () => {
    const filter: ToolFilter = { deny: ["shell", "tasks"] };
    assert.strictEqual(isToolEnabled("shell", allEnabledConfig, filter), false);
    assert.strictEqual(isToolEnabled("tasks", allEnabledConfig, filter), false);
  });

  it("returns true with empty filter object (no allow or deny)", () => {
    const filter: ToolFilter = {};
    assert.strictEqual(isToolEnabled("shell", allEnabledConfig, filter), true);
  });

  it("handles every tool domain", () => {
    const domains = [
      "memory",
      "workspace",
      "web",
      "shell",
      "tasks",
      "introspection",
      "models",
      "a2a",
      "scratchpad",
    ] as const;
    for (const domain of domains) {
      assert.strictEqual(isToolEnabled(domain, allEnabledConfig), true);
    }
  });

  it("deny filter blocks a2a domain", () => {
    const filter: ToolFilter = { deny: ["shell", "a2a"] };
    assert.strictEqual(isToolEnabled("a2a", allEnabledConfig, filter), false);
    assert.strictEqual(isToolEnabled("shell", allEnabledConfig, filter), false);
    assert.strictEqual(isToolEnabled("memory", allEnabledConfig, filter), true);
  });

  it("returns false when global config disables a domain, no filter", () => {
    assert.strictEqual(isToolEnabled("shell", shellDisabledConfig), false);
  });

  it("deny filter on globally disabled domain returns false", () => {
    // Shell is globally disabled; deny filter for something else shouldn't enable it
    assert.strictEqual(isToolEnabled("shell", shellDisabledConfig, { deny: ["memory"] }), false);
  });

  it("allow with empty array blocks all domains", () => {
    assert.strictEqual(isToolEnabled("memory", allEnabledConfig, { allow: [] }), false);
    assert.strictEqual(isToolEnabled("web", allEnabledConfig, { allow: [] }), false);
    assert.strictEqual(isToolEnabled("shell", allEnabledConfig, { allow: [] }), false);
  });

  it("deny with empty array allows all domains", () => {
    assert.strictEqual(isToolEnabled("memory", allEnabledConfig, { deny: [] }), true);
    assert.strictEqual(isToolEnabled("web", allEnabledConfig, { deny: [] }), true);
    assert.strictEqual(isToolEnabled("shell", allEnabledConfig, { deny: [] }), true);
  });
});
