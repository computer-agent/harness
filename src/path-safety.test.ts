import assert from "node:assert";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { safePath, validateName, validatePathSegment, validateSessionId } from "./path-safety.js";

describe("validatePathSegment", () => {
  it("accepts normal strings", () => {
    assert.strictEqual(validatePathSegment("hello", "test"), "hello");
    assert.strictEqual(validatePathSegment("my-file", "test"), "my-file");
    assert.strictEqual(validatePathSegment("abc123", "test"), "abc123");
  });

  it("returns the segment on success", () => {
    const result = validatePathSegment("valid-segment", "label");
    assert.strictEqual(result, "valid-segment");
  });

  it("rejects empty string", () => {
    assert.throws(() => validatePathSegment("", "test"), /Invalid test/);
  });

  it("rejects strings containing '..'", () => {
    assert.throws(() => validatePathSegment("..", "test"), /Invalid test/);
    assert.throws(() => validatePathSegment("foo/../bar", "test"), /Invalid test/);
  });

  it("rejects strings containing '/'", () => {
    assert.throws(() => validatePathSegment("foo/bar", "test"), /Invalid test/);
    assert.throws(() => validatePathSegment("/absolute", "test"), /Invalid test/);
  });

  it("rejects strings containing '\\'", () => {
    assert.throws(() => validatePathSegment("foo\\bar", "test"), /Invalid test/);
  });

  it("rejects strings containing null byte", () => {
    assert.throws(() => validatePathSegment("foo\0bar", "test"), /Invalid test/);
  });
});

describe("validateSessionId", () => {
  it("accepts valid UUID v4", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    assert.strictEqual(validateSessionId(uuid), uuid);
  });

  it("accepts uppercase UUID", () => {
    const uuid = "550E8400-E29B-41D4-A716-446655440000";
    assert.strictEqual(validateSessionId(uuid), uuid);
  });

  it("returns the id on success", () => {
    const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    assert.strictEqual(validateSessionId(uuid), uuid);
  });

  it("rejects empty string", () => {
    assert.throws(() => validateSessionId(""), /Invalid session ID/);
  });

  it("rejects non-UUID strings", () => {
    assert.throws(() => validateSessionId("not-a-uuid"), /Invalid session ID/);
    assert.throws(() => validateSessionId("hello"), /Invalid session ID/);
    assert.throws(() => validateSessionId("../etc"), /Invalid session ID/);
  });

  it("rejects partial UUIDs", () => {
    assert.throws(() => validateSessionId("550e8400-e29b-41d4"), /Invalid session ID/);
    assert.throws(() => validateSessionId("550e8400"), /Invalid session ID/);
  });
});

describe("validateName", () => {
  it("accepts valid names", () => {
    assert.strictEqual(validateName("cofounder", "agent"), "cofounder");
    assert.strictEqual(validateName("my-agent", "agent"), "my-agent");
    assert.strictEqual(validateName("agent_1", "agent"), "agent_1");
    assert.strictEqual(validateName("ab", "agent"), "ab");
  });

  it("returns the name on success", () => {
    assert.strictEqual(validateName("researcher", "agent"), "researcher");
  });

  it("rejects single character", () => {
    assert.throws(() => validateName("a", "agent"), /Invalid agent/);
  });

  it("rejects names with dots", () => {
    assert.throws(() => validateName("my.agent", "agent"), /Invalid agent/);
  });

  it("rejects names with slashes", () => {
    assert.throws(() => validateName("my/agent", "agent"), /Invalid agent/);
  });

  it("rejects names starting with hyphen", () => {
    assert.throws(() => validateName("-agent", "agent"), /Invalid agent/);
  });

  it("rejects names longer than 64 characters", () => {
    const longName = "a".repeat(65);
    assert.throws(() => validateName(longName, "agent"), /Invalid agent/);
  });

  it("rejects empty string", () => {
    assert.throws(() => validateName("", "agent"), /Invalid agent/);
  });

  it("rejects path traversal", () => {
    assert.throws(() => validateName("../etc", "agent"), /Invalid agent/);
  });
});

describe("safePath", () => {
  it("returns resolved path for valid segments", () => {
    const result = safePath("/tmp/base", "sub", "file.txt");
    assert.strictEqual(result, resolve("/tmp/base", "sub", "file.txt"));
  });

  it("throws on traversal attempt", () => {
    assert.throws(() => safePath("/tmp/base", "..", "etc", "passwd"), /Path traversal detected/);
  });

  it("throws on absolute path injection", () => {
    assert.throws(() => safePath("/tmp/base", "/etc/passwd"), /Path traversal detected/);
  });

  it("accepts base directory itself (no segments)", () => {
    const result = safePath("/tmp/base");
    assert.strictEqual(result, resolve("/tmp/base"));
  });

  it("works with nested valid segments", () => {
    const result = safePath("/tmp/base", "level1", "level2", "level3");
    assert.strictEqual(result, resolve("/tmp/base", "level1", "level2", "level3"));
  });
});
