# Phase 1 Test Specification: Frontmatter + Tool Filtering

## Conventions

All existing tests use:
- **`node:test`** built-in test runner (no vitest/jest) -- `describe`, `it` from `node:test`
- **`node:assert`** -- `assert.strictEqual`, `assert.deepStrictEqual`, `assert.ok`, `assert.throws`
- Run via `npx tsx --test <file>`
- Test files are **co-located** with source: `src/manifest.test.ts`, `src/tools/index.test.ts`, etc.
- Filesystem fixtures use `mkdtempSync` + `writeFileSync` + `rmSync` cleanup (no mocking library)
- Setup/teardown done as `it("setup")` and `it("cleanup")` blocks (not `before`/`after`)
- `package.json` `"test"` script lists files explicitly -- any new test file must be added there

## Current State

40 tests across 5 files, all passing. The existing tests cover the core happy paths defined in `docs/phases/phase-1-frontmatter.md`. The gaps below identify missing coverage.

---

## 1. `src/manifest.test.ts` -- Gaps to Fill

### File path: `src/manifest.test.ts` (existing, extend)

### `parseFrontmatter` -- Missing Test Cases

```
describe("parseFrontmatter")
  it("handles \\r\\n line endings in frontmatter")
  it("returns null frontmatter when opening --- is not at char 0")
  it("returns null frontmatter when no closing delimiter found")
  it("handles frontmatter at EOF with no trailing newline")
  it("handles frontmatter where YAML parses to a scalar (not object)")
  it("handles frontmatter with only whitespace in YAML block")
  it("strips leading newlines from body after closing delimiter")
```

**Key assertions:**
- `\r\n` variant: `parseFrontmatter("---\r\nname: X\r\n---\r\n\r\nBody")` returns `frontmatter.name === "X"` and `body === "Body"`
- No closing: `parseFrontmatter("---\nname: X\nNo closing here")` returns `frontmatter: null`, `body` equals the full input
- EOF: `parseFrontmatter("---\nname: X\n---")` returns valid frontmatter (the `closingIndexEof` branch)
- Scalar YAML: `parseFrontmatter("---\njust a string\n---\n")` returns `frontmatter: null` because `typeof parsed !== "object"`
- Whitespace YAML: `parseFrontmatter("---\n  \n---\n\nBody")` returns `frontmatter: null` (parses to `null`)
- Leading newlines: `parseFrontmatter("---\nname: X\n---\n\n\n\nBody")` returns `body === "Body"`

**Mocking strategy:** None. Pure function, string in / `ParsedIdentity` out.

### `AgentFrontmatterSchema` -- Missing Test Cases

```
describe("AgentFrontmatterSchema")
  it("rejects sub-agent with negative maxTurns")
  it("rejects sub-agent with non-integer maxTurns")
  it("accepts sub-agent tools filter with deny")
  it("rejects sub-agent tools with both allow and deny")
  it("applies default mount mode 'ro' when mode omitted")
  it("rejects invalid sandbox network value")
  it("rejects invalid mount mode")
  it("ignores unknown/extra keys (strips them)")
```

**Key assertions:**
- `safeParse({ agents: { r: { maxTurns: -1 } } }).success === false`
- `safeParse({ agents: { r: { maxTurns: 2.5 } } }).success === false`
- `parse({ agents: { r: { tools: { deny: ["shell"] } } } }).agents.r.tools.deny` equals `["shell"]`
- `safeParse({ agents: { r: { tools: { allow: ["web"], deny: ["shell"] } } } }).success === false`
- `parse({ sandbox: { mounts: [{ path: "/data" }] } }).sandbox.mounts[0].mode === "ro"`
- `safeParse({ sandbox: { network: "bridge" } }).success === false`
- `parse({ unknownKey: "value" })` does not contain `unknownKey`

### `loadAgentManifest` -- Missing Test Cases

```
describe("loadAgentManifest")
  it("throws when IDENTITY.md does not exist")
  it("uses capitalize(id) as displayName when name is absent")
  it("returns empty description when body has no paragraphs (only headings)")
  it("derives description from first paragraph, skipping headings and blanks")
  it("uses id from directory basename, not from frontmatter")
```

**Mocking strategy:** Filesystem fixtures via `mkdtempSync`/`writeFileSync`/`rmSync`. Same pattern as existing tests.

---

## 2. `src/agent-context.test.ts` -- Gaps to Fill

### File path: `src/agent-context.test.ts` (existing, extend significantly)

The existing file only tests `AgentNotFoundError`. The entire `resolveAgent` and `listAgents` public API is untested.

### `resolveAgent` -- New Test Cases

```
describe("resolveAgent")
  it("returns AgentContext with all paths set correctly")
  it("throws AgentNotFoundError when agent directory does not exist")
  it("throws AgentNotFoundError when IDENTITY.md is missing")
  it("creates workspace directory if it does not exist")
  it("does not fail if workspace directory already exists")
```

**Key assertions:**
- Verify all returned paths: `agentDir`, `identityPath`, `memoryDir`, `contextFile`, `stateDir`, `sessionsDir`, `lastSessionFile`, `proposalsDir`, `stderrLog`, `workspaceDir` are correct `join()` compositions
- `AgentNotFoundError.agentName` matches the name passed in
- After calling `resolveAgent`, `existsSync(ctx.workspaceDir)` is `true`

**Mocking strategy:** `resolveAgent` depends on `getHomeDir()` from `config.ts` which calls `homedir()`. The `homedir()` function reads `$HOME` on Linux. So:
- Save original `$HOME`, set `process.env.HOME` to a temp dir
- Create the agent directory structure under `<tmp>/.mastersof-ai/agents/<name>/IDENTITY.md`
- After test, restore `$HOME` and clean up

Alternative: use `node:test` `mock.module()` if Node 22.3+.

### `listAgents` -- New Test Cases

```
describe("listAgents")
  it("returns empty array when agents directory does not exist")
  it("returns manifests for all valid agent directories")
  it("skips directories without IDENTITY.md")
  it("skips non-directory entries (files) in agents dir")
  it("continues loading other agents when one fails to parse")
```

**Mocking strategy:** Same as `resolveAgent` -- control `$HOME` to point at temp dir.

---

## 3. `src/tools/index.test.ts` -- Gaps to Fill

### File path: `src/tools/index.test.ts` (existing, extend)

### `isToolEnabled` -- Missing Test Cases

```
describe("isToolEnabled")
  it("returns false when global config disables a domain, no filter")
  it("deny filter on globally disabled domain returns false")
  it("allow with empty array blocks all domains")
  it("deny with empty array allows all domains")
```

**Key assertions:**
- `isToolEnabled("shell", shellDisabledConfig)` returns `false`
- `isToolEnabled("memory", allEnabledConfig, { allow: [] })` returns `false`
- `isToolEnabled("memory", allEnabledConfig, { deny: [] })` returns `true`

---

## 4. `src/types/ask-user.test.ts` -- New File

### File path: `src/types/ask-user.test.ts` (new)

### `parseQuestions` -- Test Cases

```
describe("parseQuestions")
  it("returns empty array when input has no questions key")
  it("returns empty array when questions is not an array")
  it("parses a single question with options")
  it("parses multiple questions")
  it("handles missing optional fields with defaults")
  it("coerces non-string fields to strings")
  it("handles options that are not arrays")
  it("handles question with no options")
  it("preserves preview field when present")
  it("omits preview field when absent")
  it("handles multiSelect boolean coercion")
```

**Key assertions:**
- `parseQuestions({})` returns `[]`
- `parseQuestions({ questions: "not an array" })` returns `[]`
- `parseQuestions({ questions: null })` returns `[]`
- Single question: returns array of length 1 with matching fields
- Missing fields: returns `[{ question: "", header: "", options: [], multiSelect: false }]`
- Non-string: `parseQuestions({ questions: [{ question: 123 }] })` returns `question === "123"`
- `preview: ""` is omitted (falsy), `preview: "x"` is included
- `multiSelect: 0` => `false`, `multiSelect: 1` => `true`

**Mocking strategy:** None. Pure function, object in / array out.

---

## 5. `src/integration.test.ts` -- Gaps to Fill

### File path: `src/integration.test.ts` (existing, extend)

```
describe("Integration: frontmatter -> tool filtering pipeline")
  it("agent with tools.allow=[single domain] gets only that domain")
  it("handles agent with empty tags and starters arrays")
  it("loadIdentity strips frontmatter even when validation fails")
  it("frontmatter with sub-agent config round-trips correctly through pipeline")
```

---

## 6. `package.json` -- Required Update

Add `src/types/ask-user.test.ts` to the `"test"` and `"test:unit"` scripts.

---

## Implementation Order

1. `src/types/ask-user.test.ts` — New file, pure function, no deps
2. `src/manifest.test.ts` — Extend with edge cases
3. `src/tools/index.test.ts` — Extend isToolEnabled edge cases
4. `src/agent-context.test.ts` — Extend with resolveAgent/listAgents (requires HOME mocking)
5. `src/integration.test.ts` — Extend pipeline scenarios
6. `package.json` — Add new test file to scripts
