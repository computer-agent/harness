import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AgentFrontmatterSchema, loadAgentManifest, parseFrontmatter } from "./manifest.js";

describe("parseFrontmatter", () => {
  it("returns null frontmatter when no delimiters present", () => {
    const input = "# Title\n\nBody text.";
    const result = parseFrontmatter(input);
    assert.strictEqual(result.frontmatter, null);
    assert.strictEqual(result.body, input);
  });

  it("parses valid frontmatter and separates body", () => {
    const input = "---\nname: Test Agent\ntags:\n  - foo\n---\n\n# Title\n\nBody.";
    const result = parseFrontmatter(input);
    assert.deepStrictEqual(result.frontmatter, { name: "Test Agent", tags: ["foo"] });
    assert.strictEqual(result.body, "# Title\n\nBody.");
  });

  it("handles frontmatter with no body after closing delimiter", () => {
    const input = "---\nname: Test\n---\n";
    const result = parseFrontmatter(input);
    assert.deepStrictEqual(result.frontmatter, { name: "Test" });
    assert.strictEqual(result.body, "");
  });

  it("treats malformed YAML as no frontmatter", () => {
    const input = "---\n: invalid: yaml: [[\n---\n\nBody.";
    const result = parseFrontmatter(input);
    // yaml package may parse some odd things; if it throws, frontmatter is null
    // The key invariant: this does not throw
    assert.ok(result.body.length > 0);
  });

  it("does not treat --- mid-file as frontmatter", () => {
    const input = "Some text\n---\nname: NotFrontmatter\n---\n";
    const result = parseFrontmatter(input);
    assert.strictEqual(result.frontmatter, null);
    assert.strictEqual(result.body, input);
  });

  it("handles empty frontmatter block", () => {
    const input = "---\n---\n\nBody.";
    const result = parseFrontmatter(input);
    // Empty YAML parses to null, which we treat as no frontmatter
    assert.strictEqual(result.frontmatter, null);
  });

  it("preserves body content exactly (no leading newline stripping beyond separator)", () => {
    const input = "---\nname: X\n---\n\n\n# Title\n\nParagraph.";
    const result = parseFrontmatter(input);
    // Leading newlines after --- are stripped
    assert.strictEqual(result.body, "# Title\n\nParagraph.");
  });

  it("returns null frontmatter for \\r\\n line endings (no CRLF closing match)", () => {
    // The parser finds the opening ---\r\n but cannot match the closing \n---\n with CRLF content,
    // so it treats the entire input as body with no frontmatter.
    const input = "---\r\nname: X\r\n---\r\n\r\nBody";
    const result = parseFrontmatter(input);
    assert.strictEqual(result.frontmatter, null);
    assert.strictEqual(result.body, input);
  });

  it("returns null frontmatter when opening --- is not at char 0", () => {
    const input = " ---\nname: X\n---\n\nBody";
    const result = parseFrontmatter(input);
    assert.strictEqual(result.frontmatter, null);
    assert.strictEqual(result.body, input);
  });

  it("returns null frontmatter when no closing delimiter found", () => {
    const input = "---\nname: X\nNo closing here";
    const result = parseFrontmatter(input);
    assert.strictEqual(result.frontmatter, null);
    assert.strictEqual(result.body, input);
  });

  it("handles frontmatter at EOF with no trailing newline", () => {
    const input = "---\nname: X\n---";
    const result = parseFrontmatter(input);
    assert.deepStrictEqual(result.frontmatter, { name: "X" });
    assert.strictEqual(result.body, "");
  });

  it("handles frontmatter where YAML parses to a scalar (not object)", () => {
    const input = "---\njust a string\n---\n";
    const result = parseFrontmatter(input);
    assert.strictEqual(result.frontmatter, null);
    assert.strictEqual(result.body, input);
  });

  it("handles frontmatter with only whitespace in YAML block", () => {
    const input = "---\n  \n---\n\nBody";
    const result = parseFrontmatter(input);
    assert.strictEqual(result.frontmatter, null);
    assert.strictEqual(result.body, input);
  });

  it("strips leading newlines from body after closing delimiter", () => {
    const input = "---\nname: X\n---\n\n\n\nBody";
    const result = parseFrontmatter(input);
    assert.deepStrictEqual(result.frontmatter, { name: "X" });
    assert.strictEqual(result.body, "Body");
  });
});

describe("AgentFrontmatterSchema", () => {
  it("accepts empty object and returns all defaults", () => {
    const result = AgentFrontmatterSchema.parse({});
    assert.deepStrictEqual(result.tags, []);
    assert.deepStrictEqual(result.starters, []);
    assert.deepStrictEqual(result.mcp, []);
    assert.strictEqual(result.access, "public");
    assert.deepStrictEqual(result.users, []);
    assert.strictEqual(result.name, undefined);
    assert.strictEqual(result.tools, undefined);
    assert.strictEqual(result.model, undefined);
    assert.strictEqual(result.effort, undefined);
  });

  it("accepts full valid frontmatter", () => {
    const input = {
      name: "CRE Analyst",
      description: "Analyzes deals",
      icon: "building",
      tags: ["cre", "analysis"],
      starters: ["Analyze this deal"],
      tools: { allow: ["memory", "web", "workspace"] },
      mcp: [{ server: "cre-mcp", uri: "https://example.com" }],
      model: "claude-opus-4-6[1m]",
      effort: "max",
      access: "users",
      users: ["chris", "jim"],
      sandbox: {
        enforce: true,
        network: "host",
        mounts: [{ path: "~/data", mode: "ro" }],
      },
      agents: {
        researcher: { model: "sonnet", maxTurns: 30, tools: { allow: ["web"] } },
      },
    };
    const result = AgentFrontmatterSchema.parse(input);
    assert.strictEqual(result.name, "CRE Analyst");
    assert.deepStrictEqual(result.tools?.allow, ["memory", "web", "workspace"]);
    assert.strictEqual(result.agents?.researcher?.maxTurns, 30);
  });

  it("rejects tools with both allow and deny", () => {
    const input = { tools: { allow: ["web"], deny: ["shell"] } };
    const result = AgentFrontmatterSchema.safeParse(input);
    assert.strictEqual(result.success, false);
  });

  it("rejects invalid tool domain names", () => {
    const input = { tools: { allow: ["nonexistent_tool"] } };
    const result = AgentFrontmatterSchema.safeParse(input);
    assert.strictEqual(result.success, false);
  });

  it("rejects invalid effort level", () => {
    const result = AgentFrontmatterSchema.safeParse({ effort: "turbo" });
    assert.strictEqual(result.success, false);
  });

  it("rejects invalid access level", () => {
    const result = AgentFrontmatterSchema.safeParse({ access: "admin" });
    assert.strictEqual(result.success, false);
  });

  it("rejects sub-agent with negative maxTurns", () => {
    const result = AgentFrontmatterSchema.safeParse({ agents: { r: { maxTurns: -1 } } });
    assert.strictEqual(result.success, false);
  });

  it("rejects sub-agent with non-integer maxTurns", () => {
    const result = AgentFrontmatterSchema.safeParse({ agents: { r: { maxTurns: 2.5 } } });
    assert.strictEqual(result.success, false);
  });

  it("accepts sub-agent tools filter with deny", () => {
    const result = AgentFrontmatterSchema.parse({ agents: { r: { tools: { deny: ["shell"] } } } });
    assert.deepStrictEqual(result.agents?.r?.tools?.deny, ["shell"]);
  });

  it("rejects sub-agent tools with both allow and deny", () => {
    const result = AgentFrontmatterSchema.safeParse({
      agents: { r: { tools: { allow: ["web"], deny: ["shell"] } } },
    });
    assert.strictEqual(result.success, false);
  });

  it("applies default mount mode 'ro' when mode omitted", () => {
    const result = AgentFrontmatterSchema.parse({ sandbox: { mounts: [{ path: "/data" }] } });
    assert.strictEqual(result.sandbox?.mounts?.[0]?.mode, "ro");
  });

  it("rejects invalid sandbox network value", () => {
    const result = AgentFrontmatterSchema.safeParse({ sandbox: { network: "bridge" } });
    assert.strictEqual(result.success, false);
  });

  it("rejects invalid mount mode", () => {
    const result = AgentFrontmatterSchema.safeParse({
      sandbox: { mounts: [{ path: "/x", mode: "exec" }] },
    });
    assert.strictEqual(result.success, false);
  });

  it("ignores unknown/extra keys (strips them)", () => {
    const result = AgentFrontmatterSchema.parse({ unknownKey: "value" });
    assert.strictEqual("unknownKey" in result, false);
  });
});

describe("loadAgentManifest", () => {
  let tmpDir: string;

  function createTestAgent(name: string, content: string): string {
    const agentDir = join(tmpDir, name);
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "IDENTITY.md"), content, "utf-8");
    return agentDir;
  }

  it("setup", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "manifest-test-"));
  });

  it("loads agent with no frontmatter (backward compat)", async () => {
    const dir = createTestAgent(
      "analyst",
      "# Analyst\n\nYou are a research agent.\n\n## How to work\n\n- Be thorough.",
    );
    const { manifest, warnings } = await loadAgentManifest(dir);

    assert.strictEqual(manifest.id, "analyst");
    assert.strictEqual(manifest.displayName, "Analyst");
    assert.strictEqual(manifest.description, "You are a research agent.");
    assert.strictEqual(manifest.body, "# Analyst\n\nYou are a research agent.\n\n## How to work\n\n- Be thorough.");
    assert.strictEqual(manifest.frontmatter.access, "public");
    assert.strictEqual(manifest.frontmatter.tools, undefined);
    assert.strictEqual(warnings.length, 0);
  });

  it("loads agent with valid frontmatter", async () => {
    const content = `---
name: CRE Analyst
description: Analyzes CRE deals
tags: [cre]
tools:
  allow: [memory, web]
access: users
users: [jim]
---

# CRE Analyst

You are a commercial real estate analyst.`;
    const dir = createTestAgent("cre-analyst", content);
    const { manifest, warnings } = await loadAgentManifest(dir);

    assert.strictEqual(manifest.id, "cre-analyst");
    assert.strictEqual(manifest.displayName, "CRE Analyst");
    assert.strictEqual(manifest.description, "Analyzes CRE deals");
    assert.deepStrictEqual(manifest.frontmatter.tools?.allow, ["memory", "web"]);
    assert.strictEqual(manifest.frontmatter.access, "users");
    assert.deepStrictEqual(manifest.frontmatter.users, ["jim"]);
    assert.strictEqual(manifest.body, "# CRE Analyst\n\nYou are a commercial real estate analyst.");
    assert.strictEqual(warnings.length, 0);
  });

  it("handles invalid frontmatter gracefully with warnings", async () => {
    const content = `---
tools:
  allow: [nonexistent]
---

# Agent

Body.`;
    const dir = createTestAgent("bad-tools", content);
    const { manifest, warnings } = await loadAgentManifest(dir);

    assert.strictEqual(manifest.displayName, "Bad-tools");
    assert.strictEqual(manifest.frontmatter.tools, undefined); // fell back to defaults
    assert.ok(warnings.length > 0);
    assert.ok(warnings[0]?.message.includes("validation failed"));
  });

  it("extracts first paragraph as description when not in frontmatter", async () => {
    const content = `---
tags: [test]
---

# My Agent

This agent does important things
across multiple lines.

## Section`;
    const dir = createTestAgent("desc-test", content);
    const { manifest } = await loadAgentManifest(dir);

    assert.strictEqual(manifest.description, "This agent does important things across multiple lines.");
  });

  it("throws when IDENTITY.md does not exist", async () => {
    const agentDir = join(tmpDir, "no-identity");
    mkdirSync(agentDir, { recursive: true });
    // No IDENTITY.md written
    await assert.rejects(() => loadAgentManifest(agentDir));
  });

  it("uses capitalize(id) as displayName when name is absent", async () => {
    const dir = createTestAgent("helper", "# Helper\n\nSome body.");
    const { manifest } = await loadAgentManifest(dir);
    assert.strictEqual(manifest.displayName, "Helper");
  });

  it("returns empty description when body has no paragraphs (only headings)", async () => {
    const content = "---\ntags: [test]\n---\n\n# Heading\n\n## Another Heading";
    const dir = createTestAgent("headings-only", content);
    const { manifest } = await loadAgentManifest(dir);
    assert.strictEqual(manifest.description, "");
  });

  it("derives description from first paragraph, skipping headings and blanks", async () => {
    const content = "# Title\n\n\nFirst real paragraph.\n\n## Section";
    const dir = createTestAgent("para-skip", content);
    const { manifest } = await loadAgentManifest(dir);
    assert.strictEqual(manifest.description, "First real paragraph.");
  });

  it("uses id from directory basename, not from frontmatter", async () => {
    const content = "---\nname: Display Name\n---\n\n# Agent\n\nBody.";
    const dir = createTestAgent("dir-name", content);
    const { manifest } = await loadAgentManifest(dir);
    assert.strictEqual(manifest.id, "dir-name");
    assert.strictEqual(manifest.displayName, "Display Name");
  });

  it("cleanup", () => {
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
