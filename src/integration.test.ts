import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { HarnessConfig } from "./config.js";
import { loadAgentManifest } from "./manifest.js";
import { loadIdentity } from "./prompt.js";
import { isToolEnabled, type ToolFilter } from "./tools/index.js";

const testConfig: HarnessConfig = {
  model: "test-model",
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

describe("Integration: frontmatter -> tool filtering pipeline", () => {
  let tmpDir: string;

  function createAgent(name: string, content: string): string {
    const dir = join(tmpDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "IDENTITY.md"), content, "utf-8");
    return dir;
  }

  it("setup", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "integration-test-"));
  });

  it("agent with tools.allow filters correctly through the full pipeline", async () => {
    const content = `---
name: Restricted Agent
tools:
  allow: [memory, web]
---

# Restricted Agent

You only get memory and web tools.`;

    const dir = createAgent("restricted", content);
    const { manifest } = await loadAgentManifest(dir);

    // Verify frontmatter parsed correctly
    assert.deepStrictEqual(manifest.frontmatter.tools?.allow, ["memory", "web"]);
    assert.strictEqual(manifest.frontmatter.tools?.deny, undefined);

    // Build the tool filter from frontmatter (same logic as index.tsx)
    const toolFilter: ToolFilter | undefined = manifest.frontmatter.tools
      ? { allow: manifest.frontmatter.tools.allow, deny: manifest.frontmatter.tools.deny }
      : undefined;

    // Verify each domain against the filter
    assert.strictEqual(isToolEnabled("memory", testConfig, toolFilter), true);
    assert.strictEqual(isToolEnabled("web", testConfig, toolFilter), true);
    assert.strictEqual(isToolEnabled("shell", testConfig, toolFilter), false);
    assert.strictEqual(isToolEnabled("workspace", testConfig, toolFilter), false);
    assert.strictEqual(isToolEnabled("tasks", testConfig, toolFilter), false);
    assert.strictEqual(isToolEnabled("introspection", testConfig, toolFilter), false);
    assert.strictEqual(isToolEnabled("models", testConfig, toolFilter), false);

    // Verify system prompt does not contain frontmatter
    const identity = await loadIdentity(join(dir, "IDENTITY.md"));
    assert.ok(!identity.includes("---"));
    assert.ok(!identity.includes("allow:"));
    assert.ok(identity.includes("# Restricted Agent"));
    assert.ok(identity.includes("You only get memory and web tools."));
  });

  it("agent with tools.deny filters correctly", async () => {
    const content = `---
tools:
  deny: [shell, introspection]
---

# Most Tools Agent

Everything except shell and introspection.`;

    const dir = createAgent("most-tools", content);
    const { manifest } = await loadAgentManifest(dir);
    const toolFilter: ToolFilter | undefined = manifest.frontmatter.tools
      ? { allow: manifest.frontmatter.tools.allow, deny: manifest.frontmatter.tools.deny }
      : undefined;

    assert.strictEqual(isToolEnabled("memory", testConfig, toolFilter), true);
    assert.strictEqual(isToolEnabled("web", testConfig, toolFilter), true);
    assert.strictEqual(isToolEnabled("workspace", testConfig, toolFilter), true);
    assert.strictEqual(isToolEnabled("tasks", testConfig, toolFilter), true);
    assert.strictEqual(isToolEnabled("models", testConfig, toolFilter), true);
    assert.strictEqual(isToolEnabled("shell", testConfig, toolFilter), false);
    assert.strictEqual(isToolEnabled("introspection", testConfig, toolFilter), false);
  });

  it("agent without frontmatter gets all tools (backward compat)", async () => {
    const content = `# Simple Agent

You are a simple agent with no frontmatter.

## How to work

- Just do your thing.`;

    const dir = createAgent("simple", content);
    const { manifest } = await loadAgentManifest(dir);

    // No tool filter
    assert.strictEqual(manifest.frontmatter.tools, undefined);

    const toolFilter = undefined;

    // All tools enabled
    for (const domain of ["memory", "workspace", "web", "shell", "tasks", "introspection", "models"] as const) {
      assert.strictEqual(isToolEnabled(domain, testConfig, toolFilter), true, `${domain} should be enabled`);
    }

    // System prompt is the entire file
    const identity = await loadIdentity(join(dir, "IDENTITY.md"));
    assert.strictEqual(identity, content);
  });

  it("global config disable overrides agent allow", async () => {
    const content = `---
tools:
  allow: [shell, memory]
---

# Shell Agent

Wants shell, but global config says no.`;

    const shellDisabledConfig: HarnessConfig = {
      ...testConfig,
      tools: { ...testConfig.tools, shell: { enabled: false } },
    };

    const dir = createAgent("shell-wants", content);
    const { manifest } = await loadAgentManifest(dir);
    const toolFilter: ToolFilter | undefined = manifest.frontmatter.tools
      ? { allow: manifest.frontmatter.tools.allow, deny: manifest.frontmatter.tools.deny }
      : undefined;

    // Shell is in agent's allow list but globally disabled
    assert.strictEqual(isToolEnabled("shell", shellDisabledConfig, toolFilter), false);
    // Memory is in allow list and globally enabled
    assert.strictEqual(isToolEnabled("memory", shellDisabledConfig, toolFilter), true);
  });

  it("manifest display fields computed correctly", async () => {
    // With explicit name/description
    const content1 = `---
name: Custom Name
description: Custom description
tags: [a, b]
---

# Heading

First paragraph of body.`;

    const dir1 = createAgent("custom", content1);
    const { manifest: m1 } = await loadAgentManifest(dir1);
    assert.strictEqual(m1.displayName, "Custom Name");
    assert.strictEqual(m1.description, "Custom description");
    assert.strictEqual(m1.id, "custom");

    // Without name/description — derived from directory and body
    const content2 = `# My Agent

This is the first paragraph that becomes the description.

## Section

More content.`;

    const dir2 = createAgent("my-agent", content2);
    const { manifest: m2 } = await loadAgentManifest(dir2);
    assert.strictEqual(m2.displayName, "My-agent"); // capitalize("my-agent")
    assert.strictEqual(m2.description, "This is the first paragraph that becomes the description.");
  });

  it("frontmatter with all fields parses and round-trips", async () => {
    const content = `---
name: Full Agent
description: Every field set
icon: rocket
tags: [test, full]
starters:
  - "Hello"
  - "Help me with X"
tools:
  allow: [memory, web, workspace, tasks, models]
mcp:
  - server: test-mcp
    uri: https://example.com/mcp
model: claude-opus-4-6[1m]
effort: max
access: users
users: [chris, jim]
sandbox:
  enforce: true
  network: host
  mounts:
    - path: ~/data
      mode: ro
agents:
  researcher:
    model: sonnet
    maxTurns: 30
---

# Full Agent

System prompt body.`;

    const dir = createAgent("full", content);
    const { manifest, warnings } = await loadAgentManifest(dir);

    assert.strictEqual(warnings.length, 0);
    assert.strictEqual(manifest.displayName, "Full Agent");
    assert.strictEqual(manifest.frontmatter.icon, "rocket");
    assert.deepStrictEqual(manifest.frontmatter.tags, ["test", "full"]);
    assert.deepStrictEqual(manifest.frontmatter.starters, ["Hello", "Help me with X"]);
    assert.deepStrictEqual(manifest.frontmatter.tools?.allow, ["memory", "web", "workspace", "tasks", "models"]);
    assert.strictEqual(manifest.frontmatter.mcp[0].server, "test-mcp");
    assert.strictEqual(manifest.frontmatter.model, "claude-opus-4-6[1m]");
    assert.strictEqual(manifest.frontmatter.effort, "max");
    assert.strictEqual(manifest.frontmatter.access, "users");
    assert.deepStrictEqual(manifest.frontmatter.users, ["chris", "jim"]);
    assert.strictEqual(manifest.frontmatter.sandbox?.enforce, true);
    assert.strictEqual(manifest.frontmatter.sandbox?.network, "host");
    assert.strictEqual(manifest.frontmatter.sandbox?.mounts?.[0]?.path, "~/data");
    assert.strictEqual(manifest.frontmatter.sandbox?.mounts?.[0]?.mode, "ro");
    assert.strictEqual(manifest.frontmatter.agents?.researcher?.model, "sonnet");
    assert.strictEqual(manifest.frontmatter.agents?.researcher?.maxTurns, 30);
    assert.strictEqual(manifest.body, "# Full Agent\n\nSystem prompt body.");
  });

  it("agent with tools.allow=[single domain] gets only that domain", async () => {
    const content = `---
tools:
  allow: [web]
---

# Web Only Agent

Only web tools.`;

    const dir = createAgent("web-only", content);
    const { manifest } = await loadAgentManifest(dir);
    const toolFilter: ToolFilter | undefined = manifest.frontmatter.tools
      ? { allow: manifest.frontmatter.tools.allow, deny: manifest.frontmatter.tools.deny }
      : undefined;

    assert.strictEqual(isToolEnabled("web", testConfig, toolFilter), true);
    for (const domain of ["memory", "workspace", "shell", "tasks", "introspection", "models"] as const) {
      assert.strictEqual(isToolEnabled(domain, testConfig, toolFilter), false, `${domain} should be disabled`);
    }
  });

  it("handles agent with empty tags and starters arrays", async () => {
    const content = `---
tags: []
starters: []
---

# Empty Arrays

Agent with explicitly empty arrays.`;

    const dir = createAgent("empty-arrays", content);
    const { manifest, warnings } = await loadAgentManifest(dir);

    assert.strictEqual(warnings.length, 0);
    assert.deepStrictEqual(manifest.frontmatter.tags, []);
    assert.deepStrictEqual(manifest.frontmatter.starters, []);
  });

  it("loadIdentity strips frontmatter even when validation fails", async () => {
    const content = `---
tools:
  allow: [nonexistent_tool]
---

# Bad Tools Agent

System prompt body.`;

    const dir = createAgent("bad-strip", content);
    const identity = await loadIdentity(join(dir, "IDENTITY.md"));

    // Frontmatter is stripped even though it doesn't validate
    assert.ok(!identity.includes("---"));
    assert.ok(!identity.includes("nonexistent_tool"));
    assert.ok(identity.includes("# Bad Tools Agent"));
    assert.ok(identity.includes("System prompt body."));
  });

  it("frontmatter with sub-agent config round-trips correctly through pipeline", async () => {
    const content = `---
name: Orchestrator
agents:
  researcher:
    model: sonnet
    maxTurns: 30
    tools:
      deny: [shell]
  writer:
    model: opus
    maxTurns: 20
---

# Orchestrator

I manage sub-agents.`;

    const dir = createAgent("orchestrator", content);
    const { manifest, warnings } = await loadAgentManifest(dir);

    assert.strictEqual(warnings.length, 0);
    assert.strictEqual(manifest.frontmatter.agents?.researcher?.model, "sonnet");
    assert.strictEqual(manifest.frontmatter.agents?.researcher?.maxTurns, 30);
    assert.deepStrictEqual(manifest.frontmatter.agents?.researcher?.tools?.deny, ["shell"]);
    assert.strictEqual(manifest.frontmatter.agents?.writer?.model, "opus");
    assert.strictEqual(manifest.frontmatter.agents?.writer?.maxTurns, 20);
    assert.strictEqual(manifest.body, "# Orchestrator\n\nI manage sub-agents.");
  });

  it("cleanup", () => {
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
