import assert from "node:assert";
import { describe, it } from "node:test";
import { UNTRUSTED_CONTENT_INSTRUCTION, wrapFetchedContent, wrapMemoryContext } from "./content-safety.js";

describe("wrapFetchedContent", () => {
  it("wraps content in fetched_content tags", () => {
    const result = wrapFetchedContent("Hello world", "https://example.com");
    assert.ok(result.startsWith('<fetched_content source="https://example.com">'));
    assert.ok(result.includes("Hello world"));
    assert.ok(result.endsWith("</fetched_content>"));
  });

  it("escapes special characters in URL", () => {
    const result = wrapFetchedContent("content", 'https://example.com/path?a=1&b="2"');
    assert.ok(result.includes("&amp;"));
    assert.ok(result.includes("&quot;"));
    assert.ok(!result.includes('&b="2"'));
  });

  it("handles angle brackets in URL", () => {
    const result = wrapFetchedContent("content", "https://example.com/<path>");
    assert.ok(result.includes("&lt;path&gt;"));
  });
});

describe("wrapMemoryContext", () => {
  it("wraps content in memory_context tags", () => {
    const result = wrapMemoryContext("Previous session data");
    assert.ok(result.startsWith("<memory_context>"));
    assert.ok(result.includes("Previous session data"));
    assert.ok(result.endsWith("</memory_context>"));
  });
});

describe("UNTRUSTED_CONTENT_INSTRUCTION", () => {
  it("mentions fetched_content tags", () => {
    assert.ok(UNTRUSTED_CONTENT_INSTRUCTION.includes("fetched_content"));
  });

  it("mentions memory_context tags", () => {
    assert.ok(UNTRUSTED_CONTENT_INSTRUCTION.includes("memory_context"));
  });

  it("warns not to follow instructions", () => {
    assert.ok(UNTRUSTED_CONTENT_INSTRUCTION.includes("untrusted"));
  });
});
