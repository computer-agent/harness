# Phase 1: Frontmatter + Tool Filtering

Implementation requirements for adding YAML frontmatter to IDENTITY.md files and filtering tools per agent. This phase delivers value in the TUI before any web UI work begins.

**Depends on:** Nothing (first phase)
**Enables:** Phase 2 (Web UI + access control) which needs AgentManifest for the roster endpoint

---

## 1.1 Frontmatter Parser (`src/manifest.ts`)

### Requirement

Create `src/manifest.ts` with:
- A Zod schema (`AgentFrontmatterSchema`) that validates parsed YAML frontmatter
- An `AgentFrontmatter` type inferred from the schema
- An `AgentManifest` type combining computed display fields with parsed frontmatter
- A `parseFrontmatter(raw: string)` function that splits `---`-delimited YAML from markdown body
- A `loadAgentManifest(agentDir: string)` function that reads IDENTITY.md, parses frontmatter, validates with Zod, and returns an `AgentManifest`
- Backward compatible: files with no frontmatter return all-default values and the full file as body

### Current State

No frontmatter parsing exists. The `yaml` package (v2.7.0) is already a dependency, used in `src/config.ts` line 4:

```typescript
import { parse } from "yaml";
```

Zod (v4.3.6) is already a dependency, used in every tool file:

```typescript
import { z } from "zod";
```

`src/prompt.ts` reads IDENTITY.md as a flat string (line 3-4):

```typescript
export async function loadIdentity(identityPath: string): Promise<string> {
  return readFile(identityPath, "utf-8");
}
```

### Changes

**New file: `src/manifest.ts`**

```typescript
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

// --- Tool domain names (must match keys in HarnessConfig.tools) ---

export const TOOL_DOMAINS = [
  "memory",
  "workspace",
  "web",
  "shell",
  "tasks",
  "introspection",
  "models",
] as const;

export type ToolDomain = (typeof TOOL_DOMAINS)[number];

// --- Zod schema ---

const ToolFilterSchema = z
  .object({
    allow: z.array(z.enum(TOOL_DOMAINS)).optional(),
    deny: z.array(z.enum(TOOL_DOMAINS)).optional(),
  })
  .refine((val) => !(val.allow && val.deny), {
    message: "tools.allow and tools.deny are mutually exclusive",
  });

const McpServerSchema = z.object({
  server: z.string(),
  uri: z.string(),
});

const SandboxSchema = z.object({
  enforce: z.boolean().optional(),
  network: z.enum(["host", "none"]).optional(),
  mounts: z
    .array(
      z.object({
        path: z.string(),
        mode: z.enum(["ro", "rw"]).default("ro"),
      }),
    )
    .optional(),
});

const SubAgentSchema = z.object({
  model: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  tools: ToolFilterSchema.optional(),
});

export const AgentFrontmatterSchema = z.object({
  // Display
  name: z.string().optional(),
  description: z.string().optional(),
  icon: z.string().optional(),
  tags: z.array(z.string()).default([]),
  starters: z.array(z.string()).default([]),

  // Tools
  tools: ToolFilterSchema.optional(),
  mcp: z.array(McpServerSchema).default([]),

  // Model
  model: z.string().optional(),
  effort: z.enum(["low", "medium", "high", "max"]).optional(),

  // Access
  access: z.enum(["public", "private", "users"]).default("public"),
  users: z.array(z.string()).default([]),

  // Sandbox
  sandbox: SandboxSchema.optional(),

  // Sub-agents
  agents: z.record(z.string(), SubAgentSchema).optional(),
});

export type AgentFrontmatter = z.infer<typeof AgentFrontmatterSchema>;

export interface AgentManifest {
  /** Directory name (the agent ID used on CLI) */
  id: string;
  /** Display name: frontmatter.name ?? capitalize(id) */
  displayName: string;
  /** Description: frontmatter.description ?? first paragraph of body ?? "" */
  description: string;
  /** Absolute path to the agent directory */
  agentDir: string;
  /** Parsed and validated frontmatter (all defaults applied) */
  frontmatter: AgentFrontmatter;
  /** Markdown body (everything after the closing ---), used as system prompt */
  body: string;
}

// --- Frontmatter parser ---

export interface ParsedIdentity {
  frontmatter: Record<string, unknown> | null;
  body: string;
}

/**
 * Split YAML frontmatter from markdown body.
 *
 * Rules:
 * - Frontmatter must start at the very first character of the file with `---\n`
 * - Frontmatter ends at the next `\n---\n` (or `\n---` at EOF)
 * - If no valid frontmatter delimiters are found, the entire content is the body
 */
export function parseFrontmatter(raw: string): ParsedIdentity {
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) {
    return { frontmatter: null, body: raw };
  }

  // Find the closing delimiter (must be on its own line)
  const closingIndex = raw.indexOf("\n---\n", 4);
  const closingIndexEof = raw.indexOf("\n---", 4);

  let yamlEnd: number;
  let bodyStart: number;

  if (closingIndex !== -1) {
    yamlEnd = closingIndex;
    bodyStart = closingIndex + 5; // skip \n---\n
  } else if (closingIndexEof !== -1 && closingIndexEof + 4 >= raw.length) {
    // --- at end of file with nothing after
    yamlEnd = closingIndexEof;
    bodyStart = raw.length;
  } else {
    // No closing delimiter found — treat entire file as body
    return { frontmatter: null, body: raw };
  }

  const yamlStr = raw.slice(4, yamlEnd); // skip opening ---\n
  try {
    const parsed = parseYaml(yamlStr);
    if (parsed === null || parsed === undefined || typeof parsed !== "object") {
      return { frontmatter: null, body: raw };
    }
    return {
      frontmatter: parsed as Record<string, unknown>,
      body: bodyStart < raw.length ? raw.slice(bodyStart).replace(/^\n+/, "") : "",
    };
  } catch {
    // YAML parse error — log warning, treat as no frontmatter
    return { frontmatter: null, body: raw };
  }
}

// --- Helpers ---

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function extractFirstParagraph(markdown: string): string {
  const lines = markdown.split("\n");
  const paragraphLines: string[] = [];
  let started = false;

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip leading headings and blank lines
    if (!started) {
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      started = true;
    }
    if (started) {
      if (trimmed === "") break;
      paragraphLines.push(trimmed);
    }
  }

  return paragraphLines.join(" ");
}

// --- Manifest loader ---

export interface ManifestWarning {
  agentDir: string;
  message: string;
}

export interface ManifestResult {
  manifest: AgentManifest;
  warnings: ManifestWarning[];
}

/**
 * Load and validate an AgentManifest from an agent directory.
 *
 * @param agentDir - Absolute path to the agent directory (e.g. ~/.mastersof-ai/agents/analyst)
 * @returns ManifestResult with the manifest and any validation warnings
 * @throws Error if IDENTITY.md does not exist or cannot be read
 */
export async function loadAgentManifest(agentDir: string): Promise<ManifestResult> {
  const id = basename(agentDir);
  const identityPath = join(agentDir, "IDENTITY.md");
  const warnings: ManifestWarning[] = [];

  const raw = await readFile(identityPath, "utf-8");
  const { frontmatter: rawFrontmatter, body } = parseFrontmatter(raw);

  let frontmatter: AgentFrontmatter;

  if (rawFrontmatter === null) {
    // No frontmatter — all defaults
    frontmatter = AgentFrontmatterSchema.parse({});
  } else {
    const result = AgentFrontmatterSchema.safeParse(rawFrontmatter);
    if (result.success) {
      frontmatter = result.data;
    } else {
      warnings.push({
        agentDir,
        message: `Frontmatter validation failed: ${result.error.issues.map((i) => i.message).join("; ")}. Using defaults.`,
      });
      frontmatter = AgentFrontmatterSchema.parse({});
    }
  }

  const displayName = frontmatter.name ?? capitalize(id);
  const description = frontmatter.description ?? extractFirstParagraph(body);

  return {
    manifest: {
      id,
      displayName,
      description,
      agentDir,
      frontmatter,
      body,
    },
    warnings,
  };
}
```

### Acceptance Criteria

1. `parseFrontmatter("# No frontmatter\n\nJust body.")` returns `{ frontmatter: null, body: "# No frontmatter\n\nJust body." }`
2. `parseFrontmatter("---\nname: Test\n---\n\n# Body")` returns `{ frontmatter: { name: "Test" }, body: "# Body" }`
3. `AgentFrontmatterSchema.parse({})` succeeds and returns all defaults (tags: [], starters: [], mcp: [], access: "public", users: [])
4. `AgentFrontmatterSchema.parse({ tools: { allow: ["web"], deny: ["shell"] } })` throws a Zod validation error (mutually exclusive)
5. `AgentFrontmatterSchema.parse({ tools: { allow: ["invalid_domain"] } })` throws a Zod validation error
6. `loadAgentManifest(agentDir)` for an IDENTITY.md with no frontmatter returns the full file as body, capitalize(dirname) as displayName, and first paragraph as description
7. `loadAgentManifest(agentDir)` for an IDENTITY.md with invalid YAML returns defaults and populates warnings array
8. `loadAgentManifest(agentDir)` for an IDENTITY.md with valid frontmatter returns parsed values and empty warnings

### Test Plan

**File: `src/manifest.test.ts`**

```typescript
import { describe, expect, it } from "node:test";
import assert from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseFrontmatter,
  AgentFrontmatterSchema,
  loadAgentManifest,
  TOOL_DOMAINS,
} from "./manifest.js";

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
});

describe("loadAgentManifest", () => {
  let tmpDir: string;

  function createTestAgent(name: string, content: string): string {
    const agentDir = join(tmpDir, name);
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "IDENTITY.md"), content, "utf-8");
    return agentDir;
  }

  // Setup and teardown using test hooks
  it("setup", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "manifest-test-"));
  });

  it("loads agent with no frontmatter (backward compat)", async () => {
    const dir = createTestAgent("analyst", "# Analyst\n\nYou are a research agent.\n\n## How to work\n\n- Be thorough.");
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
    assert.ok(warnings[0].message.includes("validation failed"));
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

  it("cleanup", () => {
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
```

**Run with:**

```bash
npx tsx --test src/manifest.test.ts
```

---

## 1.2 Agent Discovery Refactor (`src/agent-context.ts`)

### Requirement

Extract agent discovery logic currently inline in `src/index.tsx` (lines 79-98) into reusable functions in `src/agent-context.ts`. These functions return structured data instead of printing to stdout and calling `process.exit()`.

Specifically:
- `listAgents(agentsDir: string): Promise<AgentManifest[]>` -- scans directory, returns manifests
- `resolveAgent(name: string)` throws an `AgentNotFoundError` instead of calling `process.exit(1)`
- `loadIdentity()` in `src/prompt.ts` separates frontmatter from body, returning only the body as the system prompt

### Current State

**`src/agent-context.ts` lines 25-36** -- `resolveAgent` calls `process.exit(1)`:

```typescript
export function resolveAgent(name: string): AgentContext {
  const agentDir = join(getAgentsDir(), name);
  const identityPath = join(agentDir, "IDENTITY.md");

  if (!existsSync(agentDir)) {
    console.error(`Agent "${name}" not found — ~/.mastersof-ai/agents/${name}/ does not exist`);
    process.exit(1);
  }
  if (!existsSync(identityPath)) {
    console.error(`Agent "${name}" has no IDENTITY.md — ~/.mastersof-ai/agents/${name}/IDENTITY.md not found`);
    process.exit(1);
  }
```

**`src/index.tsx` lines 79-98** -- inline `--list-agents` implementation:

```typescript
if (getFlag("list-agents")) {
  const agentsDir = getAgentsDir();
  try {
    const entries = readdirSync(agentsDir, { withFileTypes: true });
    const agents = entries
      .filter((e) => e.isDirectory() && existsSync(join(agentsDir, e.name, "IDENTITY.md")))
      .map((e) => e.name);
    // ... prints names
```

### Changes

**File: `src/agent-context.ts`**

Add imports:

```typescript
import { readdirSync } from "node:fs";
import { type AgentManifest, loadAgentManifest } from "./manifest.js";
```

Add `AgentNotFoundError` class:

```typescript
export class AgentNotFoundError extends Error {
  constructor(
    public readonly agentName: string,
    reason: string,
  ) {
    super(`Agent "${agentName}": ${reason}`);
    this.name = "AgentNotFoundError";
  }
}
```

Change `resolveAgent` to throw instead of `process.exit(1)`:

```typescript
export function resolveAgent(name: string): AgentContext {
  const agentDir = join(getAgentsDir(), name);
  const identityPath = join(agentDir, "IDENTITY.md");

  if (!existsSync(agentDir)) {
    throw new AgentNotFoundError(name, `directory not found: ${agentDir}`);
  }
  if (!existsSync(identityPath)) {
    throw new AgentNotFoundError(name, `IDENTITY.md not found: ${identityPath}`);
  }

  // ... rest unchanged
```

Add `listAgents` function:

```typescript
/**
 * Scan the agents directory and return manifests for all valid agents.
 * Agents with parse errors are included with default frontmatter (warnings logged to stderr).
 */
export async function listAgents(): Promise<AgentManifest[]> {
  const agentsDir = getAgentsDir();
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(agentsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const agentDirs = entries
    .filter((e) => e.isDirectory() && existsSync(join(agentsDir, e.name, "IDENTITY.md")))
    .map((e) => join(agentsDir, e.name));

  const results = await Promise.all(
    agentDirs.map(async (dir) => {
      try {
        const { manifest, warnings } = await loadAgentManifest(dir);
        for (const w of warnings) {
          console.error(`Warning [${manifest.id}]: ${w.message}`);
        }
        return manifest;
      } catch (err) {
        console.error(`Error loading agent from ${dir}: ${err}`);
        return null;
      }
    }),
  );

  return results.filter((m): m is AgentManifest => m !== null);
}
```

**File: `src/index.tsx`**

Update the `resolveAgent` call site (around line 150) to catch `AgentNotFoundError`:

```typescript
import { AgentNotFoundError, resolveAgent, /* ... */ } from "./agent-context.js";

// Replace:
//   const agentContext = resolveAgent(agentName);
// With:
let agentContext: AgentContext;
try {
  agentContext = resolveAgent(agentName);
} catch (err) {
  if (err instanceof AgentNotFoundError) {
    console.error(err.message);
    process.exit(1);
  }
  throw err;
}
```

### Acceptance Criteria

1. `resolveAgent("nonexistent")` throws `AgentNotFoundError` (does not call `process.exit`)
2. `resolveAgent("analyst")` (valid agent) returns `AgentContext` as before
3. `listAgents()` returns `AgentManifest[]` with one entry per valid agent directory
4. `listAgents()` does not throw when agents directory does not exist (returns `[]`)
5. `listAgents()` skips directories without IDENTITY.md (no error, no entry)
6. The existing `--list-agents` flag still works (behavior preserved via index.tsx changes)
7. The existing `--agent analyst` flag still works (behavior preserved via try/catch)
8. `AgentNotFoundError` has `agentName` property for programmatic use

### Test Plan

**File: `src/agent-context.test.ts`**

```typescript
import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentNotFoundError } from "./agent-context.js";

describe("AgentNotFoundError", () => {
  it("has agentName property", () => {
    const err = new AgentNotFoundError("test-agent", "not found");
    assert.strictEqual(err.agentName, "test-agent");
    assert.ok(err.message.includes("test-agent"));
    assert.strictEqual(err.name, "AgentNotFoundError");
  });
});

// Note: resolveAgent and listAgents depend on the filesystem at ~/.mastersof-ai/agents.
// Full integration tests are in section 1.6. Unit testing the error-throwing behavior
// can be done by temporarily pointing getAgentsDir() at a temp directory, but that
// requires either dependency injection or a module-level override. The pragmatic
// approach: test the error class directly, test integration via CLI in 1.6.
```

**Integration test (CLI-level):**

```bash
# resolveAgent throws (caught by index.tsx, prints message, exits 1)
npx tsx src/index.tsx --agent nonexistent_agent_xyz 2>&1; echo "EXIT: $?"
# Expected: stderr contains 'Agent "nonexistent_agent_xyz"', exit code 1

# listAgents works through --list-agents
npx tsx src/index.tsx --list-agents
# Expected: lists agent names (unchanged behavior from user perspective)
```

---

## 1.3 Tool Filtering (`src/tools/index.ts`)

### Requirement

Modify `createAgentServers()` to accept tool allow/deny configuration from frontmatter and filter which MCP servers are created. Implements the three-layer model:

```
Global config (supply) --> Agent frontmatter (demand) --> Actual tool set
```

### Current State

**`src/tools/index.ts` lines 15-46** -- `createAgentServers` only checks `config.tools.*.enabled`:

```typescript
export function createAgentServers(ctx: AgentContext, config: HarnessConfig) {
  const prefix = `${ctx.name}-`;
  const cwd = process.cwd();
  const servers: Record<string, ReturnType<typeof createSdkMcpServer>> = {};

  if (config.tools.memory.enabled) {
    servers[`${prefix}memory`] = createServer(`${prefix}memory`, createMemoryTools(ctx.memoryDir));
  }
  if (config.tools.web.enabled) {
    servers[`${prefix}web`] = createServer(`${prefix}web`, createWebTools(config.tools.web));
  }
  // ... etc for each domain
```

**`src/config.ts` lines 6-22** -- `HarnessConfig.tools` type:

```typescript
tools: {
  memory: { enabled: boolean };
  workspace: { enabled: boolean };
  web: { enabled: boolean; extraction_model?: string };
  shell: { enabled: boolean };
  tasks: { enabled: boolean };
  introspection: { enabled: boolean };
  models: { enabled: boolean };
};
```

**`src/agent.ts` line 149** -- where `createAgentServers` is called:

```typescript
mcpServers: createAgentServers(ctx, config),
```

### Changes

**File: `src/tools/index.ts`**

Add import and new type:

```typescript
import type { ToolDomain } from "../manifest.js";
```

Add a `ToolFilter` type and change the function signature:

```typescript
export interface ToolFilter {
  allow?: ToolDomain[];
  deny?: ToolDomain[];
}

/**
 * Determine whether a tool domain is enabled given global config and agent-level filter.
 *
 * Layer 1 (global): config.tools[domain].enabled must be true
 * Layer 2 (agent): if filter.allow is set, domain must be in the list
 *                   if filter.deny is set, domain must NOT be in the list
 *                   if neither, all globally-enabled tools pass
 */
export function isToolEnabled(domain: ToolDomain, config: HarnessConfig, filter?: ToolFilter): boolean {
  // Layer 1: global config
  if (!config.tools[domain].enabled) return false;

  // Layer 2: agent-level filter
  if (!filter) return true;
  if (filter.allow) return filter.allow.includes(domain);
  if (filter.deny) return !filter.deny.includes(domain);

  return true;
}

export function createAgentServers(
  ctx: AgentContext,
  config: HarnessConfig,
  toolFilter?: ToolFilter,
) {
  const prefix = `${ctx.name}-`;
  const cwd = process.cwd();
  const servers: Record<string, ReturnType<typeof createSdkMcpServer>> = {};

  if (isToolEnabled("memory", config, toolFilter)) {
    servers[`${prefix}memory`] = createServer(`${prefix}memory`, createMemoryTools(ctx.memoryDir));
  }
  if (isToolEnabled("web", config, toolFilter)) {
    servers[`${prefix}web`] = createServer(`${prefix}web`, createWebTools(config.tools.web));
  }
  if (isToolEnabled("introspection", config, toolFilter)) {
    servers[`${prefix}introspection`] = createServer(
      `${prefix}introspection`,
      createIntrospectionTools({ identityPath: ctx.identityPath, proposalsDir: ctx.proposalsDir }),
    );
  }
  if (isToolEnabled("workspace", config, toolFilter)) {
    servers[`${prefix}workspace`] = createServer(`${prefix}workspace`, createWorkspaceTools(cwd));
  }
  if (isToolEnabled("shell", config, toolFilter)) {
    servers[`${prefix}shell`] = createServer(`${prefix}shell`, createShellTools(cwd));
  }
  if (isToolEnabled("models", config, toolFilter)) {
    servers[`${prefix}models`] = createServer(`${prefix}models`, modelQueryTools);
  }
  if (isToolEnabled("tasks", config, toolFilter)) {
    servers[`${prefix}tasks`] = createServer(`${prefix}tasks`, createTaskTools(ctx.memoryDir));
  }

  return servers;
}
```

**File: `src/agent.ts`**

Update `buildOptions` to accept and pass through `ToolFilter`:

```typescript
import type { ToolFilter } from "./tools/index.js";

export function buildOptions(
  ctx: AgentContext,
  opts: {
    resume?: string;
    systemPrompt: string;
    toolFilter?: ToolFilter;
    onInstructionsLoaded?: (filePath: string, memoryType: string, loadReason: string) => void;
    onAskUserQuestion?: (input: Record<string, unknown>) => Promise<Record<string, string> | null>;
  },
  config: HarnessConfig,
): Options {
  // ...
  return {
    // ...
    mcpServers: createAgentServers(ctx, config, opts.toolFilter),
    // ...
  };
}
```

**File: `src/agent.ts` `buildSystemPrompt`**

Update to load manifest and use body only:

```typescript
import { loadAgentManifest, type AgentManifest } from "./manifest.js";

export async function buildSystemPrompt(ctx: AgentContext): Promise<{ systemPrompt: string; manifest: AgentManifest }> {
  const { manifest } = await loadAgentManifest(ctx.agentDir);
  const identity = manifest.body;
  const memoryContext = await loadMemoryContext(ctx.contextFile);

  // ... rest of prompt assembly uses `identity` instead of loadIdentity()

  return { systemPrompt: parts.join("\n\n"), manifest };
}
```

**File: `src/index.tsx`**

Update all call sites to pass `toolFilter` from manifest:

```typescript
// In headless mode (line ~196):
const { systemPrompt, manifest } = await buildSystemPrompt(agentContext);
const toolFilter = manifest.frontmatter.tools
  ? { allow: manifest.frontmatter.tools.allow, deny: manifest.frontmatter.tools.deny }
  : undefined;
const options = buildOptions(agentContext, { systemPrompt, toolFilter }, config);

// In TUI mode: App.tsx receives manifest and passes toolFilter through
// (App.tsx already receives agentContext and config — add manifest)
```

### Acceptance Criteria

1. `isToolEnabled("shell", config, { deny: ["shell"] })` returns `false`
2. `isToolEnabled("shell", config, { allow: ["web", "memory"] })` returns `false`
3. `isToolEnabled("web", config, { allow: ["web", "memory"] })` returns `true`
4. `isToolEnabled("shell", config, undefined)` returns `true` (backward compat, when config.tools.shell.enabled is true)
5. `isToolEnabled("shell", disabledConfig, { allow: ["shell"] })` returns `false` (global config overrides agent request)
6. `createAgentServers(ctx, config, { allow: ["memory", "web"] })` creates only `memory` and `web` servers
7. `createAgentServers(ctx, config)` (no filter) creates all enabled servers (backward compat)
8. Calling `createAgentServers(ctx, config, { deny: ["shell", "tasks"] })` creates servers for all domains except shell and tasks

### Test Plan

**File: `src/tools/index.test.ts`**

```typescript
import { describe, it } from "node:test";
import assert from "node:assert";
import { isToolEnabled, type ToolFilter } from "./index.js";
import type { HarnessConfig } from "../config.js";

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
  },
  hooks: { logToolUse: false },
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
    const domains = ["memory", "workspace", "web", "shell", "tasks", "introspection", "models"] as const;
    for (const domain of domains) {
      assert.strictEqual(isToolEnabled(domain, allEnabledConfig), true);
    }
  });
});
```

**Run with:**

```bash
npx tsx --test src/tools/index.test.ts
```

---

## 1.4 System Prompt Update (`src/agent.ts`, `src/prompt.ts`)

### Requirement

`buildSystemPrompt()` must use the frontmatter body (markdown after `---`) as the agent's system prompt. The raw YAML frontmatter must NOT be included in the prompt sent to the model. The function must also return the parsed `AgentManifest` so callers can access frontmatter fields (model override, tool filter, etc.).

### Current State

**`src/agent.ts` lines 158-180** -- `buildSystemPrompt` reads full file via `loadIdentity`:

```typescript
export async function buildSystemPrompt(ctx: AgentContext): Promise<string> {
  const identity = await loadIdentity(ctx.identityPath);
  const memoryContext = await loadMemoryContext(ctx.contextFile);
  // ...
  const parts = [identity];
  // ...
  return parts.join("\n\n");
}
```

**`src/prompt.ts`** -- `loadIdentity` returns the entire file:

```typescript
export async function loadIdentity(identityPath: string): Promise<string> {
  return readFile(identityPath, "utf-8");
}
```

**`src/agent.ts` line 13** -- imports `loadIdentity`:

```typescript
import { loadIdentity } from "./prompt.js";
```

### Changes

**File: `src/prompt.ts`**

Keep `loadIdentity` but update it to strip frontmatter. This ensures backward compatibility with any other callers (currently `src/tools/introspection.ts` reads identityPath directly, not through `loadIdentity`, so this is safe):

```typescript
import { readFile } from "node:fs/promises";
import { parseFrontmatter } from "./manifest.js";

/**
 * Load the system prompt from an IDENTITY.md file.
 * Strips YAML frontmatter if present — only the markdown body is returned.
 */
export async function loadIdentity(identityPath: string): Promise<string> {
  const raw = await readFile(identityPath, "utf-8");
  const { body } = parseFrontmatter(raw);
  return body;
}
```

**File: `src/agent.ts`**

Change `buildSystemPrompt` return type to include the manifest:

```typescript
import { loadAgentManifest, type AgentManifest } from "./manifest.js";

interface SystemPromptResult {
  systemPrompt: string;
  manifest: AgentManifest;
}

export async function buildSystemPrompt(ctx: AgentContext): Promise<SystemPromptResult> {
  const { manifest, warnings } = await loadAgentManifest(ctx.agentDir);

  // Log any frontmatter warnings
  for (const w of warnings) {
    console.error(`Warning [${manifest.id}]: ${w.message}`);
  }

  const identity = manifest.body;
  const memoryContext = await loadMemoryContext(ctx.contextFile);

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new Date();
  const date = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
  const time = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  const dateLine = `# Current Date\n\n${date}, ${time} (${tz})`;

  const workspaceLine = `# Workspace\n\nYour workspace directory is \`${ctx.workspaceDir}\`. This is your persistent working directory — files you create here survive across sessions. You can also access any directories mounted in your sandbox config.`;

  const parts = [identity];
  if (memoryContext) {
    parts.push(
      `# Persistent Memory\n\nThe following is your accumulated context from previous sessions:\n\n${memoryContext}`,
    );
  }
  parts.push(dateLine);
  parts.push(workspaceLine);

  return { systemPrompt: parts.join("\n\n"), manifest };
}
```

**File: `src/index.tsx`**

Update all call sites of `buildSystemPrompt`. The function now returns `{ systemPrompt, manifest }` instead of a plain string.

Headless mode (around line 196):

```typescript
// Before:
//   const systemPrompt = await buildSystemPrompt(agentContext);
//   const options = buildOptions(agentContext, { systemPrompt }, config);

// After:
const { systemPrompt, manifest } = await buildSystemPrompt(agentContext);
const toolFilter = manifest.frontmatter.tools ?? undefined;
const options = buildOptions(agentContext, { systemPrompt, toolFilter }, config);
```

**File: `src/components/App.tsx`**

The App component calls `buildSystemPrompt` via a `startSession` callback. Must be updated to destructure and pass `toolFilter`. Locate the exact call site and update accordingly.

### Acceptance Criteria

1. An IDENTITY.md with frontmatter produces a system prompt that does NOT contain `---` delimiters or YAML key-value pairs from the frontmatter
2. An IDENTITY.md without frontmatter produces the same system prompt as before (the entire file content)
3. `buildSystemPrompt` returns both `systemPrompt` (string) and `manifest` (AgentManifest)
4. `loadIdentity` still works as a standalone function and strips frontmatter
5. `buildOptions` receives `toolFilter` and passes it to `createAgentServers`
6. The model override from frontmatter (`manifest.frontmatter.model`) is available to callers (used in Phase 2, but the plumbing must exist now)

### Test Plan

**File: `src/prompt.test.ts`**

```typescript
import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadIdentity } from "./prompt.js";

describe("loadIdentity", () => {
  let tmpDir: string;

  it("setup", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "prompt-test-"));
  });

  it("returns full content when no frontmatter", async () => {
    const content = "# Agent\n\nYou are an agent.";
    const filePath = join(tmpDir, "no-fm.md");
    writeFileSync(filePath, content, "utf-8");

    const result = await loadIdentity(filePath);
    assert.strictEqual(result, content);
  });

  it("strips frontmatter and returns only body", async () => {
    const content = "---\nname: Test\ntags: [a, b]\n---\n\n# Agent\n\nYou are an agent.";
    const filePath = join(tmpDir, "with-fm.md");
    writeFileSync(filePath, content, "utf-8");

    const result = await loadIdentity(filePath);
    assert.strictEqual(result, "# Agent\n\nYou are an agent.");
    assert.ok(!result.includes("---"));
    assert.ok(!result.includes("name: Test"));
  });

  it("cleanup", () => {
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
```

**Run with:**

```bash
npx tsx --test src/prompt.test.ts
```

---

## 1.5 `--list-agents` Update (`src/index.tsx`)

### Requirement

Replace the inline agent listing code in `src/index.tsx` with a call to the new `listAgents()` function. Display richer information from frontmatter: display name, description, tool allow/deny, access level, and tags.

### Current State

**`src/index.tsx` lines 79-98:**

```typescript
if (getFlag("list-agents")) {
  const agentsDir = getAgentsDir();
  try {
    const entries = readdirSync(agentsDir, { withFileTypes: true });
    const agents = entries
      .filter((e) => e.isDirectory() && existsSync(join(agentsDir, e.name, "IDENTITY.md")))
      .map((e) => e.name);
    if (agents.length === 0) {
      console.log("No agents found. Create one with: mastersof-ai create <name>");
    } else {
      console.log("Available agents:\n");
      for (const name of agents) {
        const marker = name === config.defaultAgent ? " (default)" : "";
        console.log(`  ${name}${marker}`);
      }
    }
  } catch {
    console.log("No agents found. Run: mastersof-ai --init");
  }
  process.exit(0);
}
```

### Changes

**File: `src/index.tsx`**

Replace the `--list-agents` block with:

```typescript
if (getFlag("list-agents")) {
  const agents = await listAgents();
  if (agents.length === 0) {
    console.log("No agents found. Create one with: mastersof-ai create <name>");
  } else {
    console.log("Available agents:\n");
    for (const agent of agents) {
      const isDefault = agent.id === config.defaultAgent;
      const marker = isDefault ? " (default)" : "";
      const desc = agent.description ? ` — ${agent.description}` : "";

      console.log(`  ${agent.displayName} [${agent.id}]${marker}`);
      if (desc) console.log(`    ${agent.description}`);

      // Tools
      const tools = agent.frontmatter.tools;
      if (tools?.allow) {
        console.log(`    tools: ${tools.allow.join(", ")}`);
      } else if (tools?.deny) {
        console.log(`    tools: all except ${tools.deny.join(", ")}`);
      }

      // Access
      if (agent.frontmatter.access !== "public") {
        const accessStr =
          agent.frontmatter.access === "users"
            ? `users: ${agent.frontmatter.users.join(", ")}`
            : agent.frontmatter.access;
        console.log(`    access: ${accessStr}`);
      }

      // Tags
      if (agent.frontmatter.tags.length > 0) {
        console.log(`    tags: ${agent.frontmatter.tags.join(", ")}`);
      }

      console.log(""); // blank line between agents
    }
  }
  process.exit(0);
}
```

Note: `listAgents` is async, so the `--list-agents` block must use `await`. Since `src/index.tsx` already uses top-level `await` (line 165 for sandbox import, line 239-264 for session resolution), this is fine.

Add import at the top of the file:

```typescript
import { listAgents } from "./agent-context.js";
```

Remove the now-unused imports that were only needed for the old inline implementation:

```typescript
// Remove these from the import if they become unused:
// readdirSync (check if used elsewhere in the file — it is not)
// existsSync (still used for credential check on line 105)
```

### Acceptance Criteria

1. `mastersof-ai --list-agents` prints display name and directory name for each agent
2. Default agent is marked with `(default)`
3. Agents with `tools.allow` show `tools: memory, web, ...`
4. Agents with `tools.deny` show `tools: all except shell, ...`
5. Agents with no tool filter show no tools line
6. Agents with non-public access show `access: private` or `access: users: jim, chris`
7. Agents with tags show `tags: cre, analysis`
8. Agents without frontmatter still appear (backward compat) with capitalized directory name
9. Output is sorted alphabetically by agent ID (or directory scan order is fine for v1)
10. Empty agents directory prints "No agents found" message

### Test Plan

**Integration test (CLI):**

```bash
# Test with existing agents (no frontmatter) — should show names, backward compat
npx tsx src/index.tsx --list-agents
# Expected output includes:
#   Analyst [analyst]
#   Assistant [assistant]
#   (one of these marked as default)

# Test with a temporary agent that has frontmatter
mkdir -p /tmp/test-list-agents
cat > /tmp/test-list-agents/IDENTITY.md << 'EOF'
---
name: Test Agent
description: A test agent for validation
tags: [test, validation]
tools:
  allow: [memory, web]
access: users
users: [chris]
---

# Test Agent

You are a test agent.
EOF

# To validate this without modifying the real agents dir, the listAgents() unit test
# in 1.2 covers the data. The CLI test verifies formatting on the real agents dir:
npx tsx src/index.tsx --list-agents 2>/dev/null
# Verify: output contains "Analyst [analyst]", no crash, exit code 0
echo "EXIT: $?"
```

**Formatting validation test (manual, after adding frontmatter to an agent):**

```bash
# Add frontmatter to analyst for testing, then revert
cp ~/.mastersof-ai/agents/analyst/IDENTITY.md ~/.mastersof-ai/agents/analyst/IDENTITY.md.bak

cat > ~/.mastersof-ai/agents/analyst/IDENTITY.md << 'EOF'
---
name: Research Analyst
description: Deep research and analysis agent
tags: [research, analysis]
tools:
  deny: [shell]
---

# Analyst

You are Analyst, a research and analysis agent.

## How to work

- Gather information thoroughly before forming conclusions.
EOF

npx tsx src/index.tsx --list-agents

# Expected output includes:
#   Research Analyst [analyst]
#     Deep research and analysis agent
#     tools: all except shell
#     tags: research, analysis

# Restore
mv ~/.mastersof-ai/agents/analyst/IDENTITY.md.bak ~/.mastersof-ai/agents/analyst/IDENTITY.md
```

---

## 1.6 Integration Test

### Requirement

Validate the full pipeline end-to-end: frontmatter parsing, tool filtering, system prompt construction, and backward compatibility. Test both agents with frontmatter and agents without.

### Current State

No test infrastructure exists in the project. No test runner configured in `package.json`. The project uses `tsx` to run TypeScript directly.

### Changes

**File: `package.json`**

Add a test script:

```json
{
  "scripts": {
    "test": "tsx --test src/**/*.test.ts",
    "test:unit": "tsx --test src/manifest.test.ts src/tools/index.test.ts src/prompt.test.ts src/agent-context.test.ts",
    "test:integration": "tsx --test src/integration.test.ts"
  }
}
```

**File: `src/integration.test.ts`**

```typescript
import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadAgentManifest } from "./manifest.js";
import { isToolEnabled, type ToolFilter } from "./tools/index.js";
import type { HarnessConfig } from "./config.js";
import { loadIdentity } from "./prompt.js";

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
  },
  hooks: { logToolUse: false },
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

  it("cleanup", () => {
    rmSync(tmpDir, { recursive: true, force: true });
  });
});
```

**Run with:**

```bash
# All tests
npx tsx --test src/**/*.test.ts

# Just integration
npx tsx --test src/integration.test.ts
```

**CLI integration verification (manual, run after implementation):**

```bash
# 1. Verify existing agents still work without frontmatter
npx tsx src/index.tsx --agent analyst --message "Say hello in one sentence" 2>/dev/null
echo "EXIT: $?"
# Expected: gets a response, exit code 0

# 2. Verify --list-agents works
npx tsx src/index.tsx --list-agents
echo "EXIT: $?"
# Expected: lists agents, exit code 0

# 3. Verify invalid agent name gives clean error
npx tsx src/index.tsx --agent nonexistent_xyz 2>&1
echo "EXIT: $?"
# Expected: error message on stderr, exit code 1

# 4. Verify typecheck passes
npx tsc --noEmit
echo "TYPECHECK EXIT: $?"

# 5. Verify lint passes
npx biome check
echo "LINT EXIT: $?"
```

---

## Summary of Files Changed

| File | Action | Description |
|------|--------|-------------|
| `src/manifest.ts` | **New** | Frontmatter parser, Zod schema, AgentManifest type, loadAgentManifest |
| `src/manifest.test.ts` | **New** | Unit tests for parser and schema |
| `src/agent-context.ts` | **Modified** | Add AgentNotFoundError, listAgents(); change resolveAgent to throw |
| `src/agent-context.test.ts` | **New** | Unit test for AgentNotFoundError |
| `src/tools/index.ts` | **Modified** | Add ToolFilter, isToolEnabled; change createAgentServers signature |
| `src/tools/index.test.ts` | **New** | Unit tests for isToolEnabled |
| `src/prompt.ts` | **Modified** | loadIdentity strips frontmatter |
| `src/prompt.test.ts` | **New** | Unit tests for loadIdentity |
| `src/agent.ts` | **Modified** | buildSystemPrompt returns { systemPrompt, manifest }; buildOptions accepts toolFilter |
| `src/index.tsx` | **Modified** | --list-agents uses listAgents(); resolveAgent wrapped in try/catch; toolFilter plumbed through |
| `src/integration.test.ts` | **New** | End-to-end pipeline tests |
| `package.json` | **Modified** | Add test scripts |

## Dependency Changes

None. Uses existing `yaml` (^2.7.0) and `zod` (^4.0.0).

## Migration / Backward Compatibility

- All existing IDENTITY.md files (no frontmatter) continue to work with zero changes
- `--list-agents` output changes format (adds display name, description) but the old agent IDs still appear
- `buildSystemPrompt` return type changes from `Promise<string>` to `Promise<SystemPromptResult>` -- all call sites must be updated in this phase
- `createAgentServers` gains an optional third parameter -- existing calls without it behave identically
- `resolveAgent` throws instead of calling `process.exit(1)` -- the call site in `index.tsx` must catch and exit

## What This Phase Does NOT Include

- MCP server configuration from frontmatter (`mcp` field parsed but not wired up -- Phase 3)
- Access control enforcement (`access`/`users` fields parsed but not enforced -- Phase 2)
- Sandbox from frontmatter (`sandbox` field parsed but not used -- Phase 4)
- Sub-agent overrides from frontmatter (`agents` field parsed but not wired to `createAgentRegistry` -- future)
- Model/effort override from frontmatter (parsed but not applied in `buildOptions` -- add in this phase if straightforward, otherwise Phase 2)
- Hot reload of agents directory (Phase 3)
- Web UI (Phase 2+)
