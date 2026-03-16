import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
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
