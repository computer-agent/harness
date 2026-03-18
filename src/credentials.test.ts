import assert from "node:assert";
import { describe, it } from "node:test";
import { CredentialStore, type CredentialsConfig } from "./credentials.js";

const testEnv: Record<string, string> = {
  BRAINTREE_MERCHANT_ID: "mid_123",
  BRAINTREE_PUBLIC_KEY: "pub_abc",
  BRAINTREE_PRIVATE_KEY: "priv_secret",
  POSTMARK_SERVER_TOKEN: "pmk_token",
  WIRE_ACCOUNT_NUMBER: "wire_999",
  DATABASE_URL: "postgres://localhost/db",
};

const testConfig: CredentialsConfig = {
  grants: {
    "braintree-read": {
      keys: ["BRAINTREE_MERCHANT_ID", "BRAINTREE_PUBLIC_KEY"],
      tools: ["web"],
    },
    email: {
      keys: ["POSTMARK_SERVER_TOKEN"],
      tools: ["web"],
    },
    sensitive: {
      keys: ["WIRE_ACCOUNT_NUMBER"],
      tools: ["web"],
      approval: "required",
    },
    "db-access": {
      keys: ["DATABASE_URL"],
      tools: ["shell"],
    },
  },
};

describe("CredentialStore", () => {
  describe("legacy mode (no credentials config)", () => {
    it("resolveFlat returns all env vars for any domain", () => {
      const store = new CredentialStore(testEnv);
      assert.strictEqual(store.isStrict, false);
      const result = store.resolveFlat("web");
      assert.deepStrictEqual(result, testEnv);
    });

    it("resolveFlat returns a copy, not a reference", () => {
      const store = new CredentialStore(testEnv);
      const result = store.resolveFlat("web");
      result.NEW_KEY = "new_value";
      assert.strictEqual(store.resolveFlat("web").NEW_KEY, undefined);
    });

    it("toFlatEnv returns all env vars", () => {
      const store = new CredentialStore(testEnv);
      assert.deepStrictEqual(store.toFlatEnv(), testEnv);
    });

    it("listGrants returns empty array", () => {
      const store = new CredentialStore(testEnv);
      assert.deepStrictEqual(store.listGrants(), []);
    });
  });

  describe("strict mode (with credentials config)", () => {
    it("resolveFlat returns only granted keys for web domain", () => {
      const store = new CredentialStore(testEnv, testConfig);
      assert.strictEqual(store.isStrict, true);
      const result = store.resolveFlat("web");

      // Should include braintree-read and email grants (not sensitive — approval required)
      assert.strictEqual(result.BRAINTREE_MERCHANT_ID, "mid_123");
      assert.strictEqual(result.BRAINTREE_PUBLIC_KEY, "pub_abc");
      assert.strictEqual(result.POSTMARK_SERVER_TOKEN, "pmk_token");

      // Should NOT include: approval-required, wrong domain, or ungranted keys
      assert.strictEqual(result.WIRE_ACCOUNT_NUMBER, undefined);
      assert.strictEqual(result.BRAINTREE_PRIVATE_KEY, undefined);
      assert.strictEqual(result.DATABASE_URL, undefined);
    });

    it("resolveFlat returns only shell-granted keys for shell domain", () => {
      const store = new CredentialStore(testEnv, testConfig);
      const result = store.resolveFlat("shell");

      assert.strictEqual(result.DATABASE_URL, "postgres://localhost/db");
      assert.strictEqual(Object.keys(result).length, 1);
    });

    it("resolveFlat returns empty for domain with no grants", () => {
      const store = new CredentialStore(testEnv, testConfig);
      const result = store.resolveFlat("memory");
      assert.deepStrictEqual(result, {});
    });

    it("excludes approval-required grants", () => {
      const store = new CredentialStore(testEnv, testConfig);
      const result = store.resolveFlat("web");
      assert.strictEqual(result.WIRE_ACCOUNT_NUMBER, undefined);
    });

    it("handles missing env keys gracefully", () => {
      const partialEnv = { BRAINTREE_MERCHANT_ID: "mid_123" };
      const store = new CredentialStore(partialEnv, testConfig);
      const result = store.resolveFlat("web");

      assert.strictEqual(result.BRAINTREE_MERCHANT_ID, "mid_123");
      assert.strictEqual(result.BRAINTREE_PUBLIC_KEY, undefined);
      assert.strictEqual(result.POSTMARK_SERVER_TOKEN, undefined);
    });

    it("toFlatEnv returns all env regardless of grants", () => {
      const store = new CredentialStore(testEnv, testConfig);
      assert.deepStrictEqual(store.toFlatEnv(), testEnv);
    });

    it("listGrants returns all configured grants", () => {
      const store = new CredentialStore(testEnv, testConfig);
      const grants = store.listGrants();
      assert.strictEqual(grants.length, 4);
      assert.strictEqual(grants[0]?.name, "braintree-read");
    });
  });

  describe("edge cases", () => {
    it("handles empty env", () => {
      const store = new CredentialStore({}, testConfig);
      const result = store.resolveFlat("web");
      assert.deepStrictEqual(result, {});
    });

    it("handles empty grants config", () => {
      const store = new CredentialStore(testEnv, { grants: {} });
      assert.strictEqual(store.isStrict, true);
      const result = store.resolveFlat("web");
      assert.deepStrictEqual(result, {});
    });

    it("handles null config same as no config", () => {
      const store = new CredentialStore(testEnv, null);
      assert.strictEqual(store.isStrict, false);
      assert.deepStrictEqual(store.resolveFlat("web"), testEnv);
    });
  });
});
