import assert from "node:assert";
import { describe, it } from "node:test";
import { buildShellEnv } from "./env-safety.js";

describe("buildShellEnv", () => {
  it("includes safe system vars from process.env", () => {
    const env = buildShellEnv();
    // PATH and HOME should always be present on any system
    assert.ok(env.PATH, "PATH should be present");
    assert.ok(env.HOME, "HOME should be present");
  });

  it("includes TZ (from process.env or Intl fallback)", () => {
    const env = buildShellEnv();
    assert.ok(env.TZ, "TZ should be present (from env or Intl fallback)");
  });

  it("excludes ANTHROPIC_API_KEY from output", () => {
    // Temporarily set the key to verify it's excluded
    const originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-secret-key";
    try {
      const env = buildShellEnv();
      assert.strictEqual(env.ANTHROPIC_API_KEY, undefined, "ANTHROPIC_API_KEY must not be in shell env");
    } finally {
      if (originalKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = originalKey;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    }
  });

  it("excludes other process.env secrets", () => {
    const originalKey = process.env.AWS_SECRET_ACCESS_KEY;
    process.env.AWS_SECRET_ACCESS_KEY = "some-aws-secret";
    try {
      const env = buildShellEnv();
      assert.strictEqual(env.AWS_SECRET_ACCESS_KEY, undefined, "AWS_SECRET_ACCESS_KEY must not leak");
    } finally {
      if (originalKey !== undefined) {
        process.env.AWS_SECRET_ACCESS_KEY = originalKey;
      } else {
        delete process.env.AWS_SECRET_ACCESS_KEY;
      }
    }
  });

  it("includes agent env values", () => {
    const agentEnv = { BRAINTREE_MERCHANT_ID: "merchant-123", SUPABASE_URL: "https://example.supabase.co" };
    const env = buildShellEnv(agentEnv);
    assert.strictEqual(env.BRAINTREE_MERCHANT_ID, "merchant-123");
    assert.strictEqual(env.SUPABASE_URL, "https://example.supabase.co");
  });

  it("excludes DOTENV_PRIVATE_KEY from agent env", () => {
    const agentEnv = { DOTENV_PRIVATE_KEY: "secret-decryption-key", APP_KEY: "app-value" };
    const env = buildShellEnv(agentEnv);
    assert.strictEqual(env.DOTENV_PRIVATE_KEY, undefined, "DOTENV_PRIVATE_KEY must be excluded");
    assert.strictEqual(env.APP_KEY, "app-value");
  });

  it("returns only allowlisted keys when no agent env", () => {
    const env = buildShellEnv();
    const allowedKeys = new Set(["PATH", "HOME", "TERM", "TZ", "LANG", "USER"]);
    for (const key of Object.keys(env)) {
      assert.ok(allowedKeys.has(key), `Unexpected key in shell env: ${key}`);
    }
  });
});
