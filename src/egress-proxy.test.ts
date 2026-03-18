import assert from "node:assert";
import { describe, it } from "node:test";
import { EgressFilter } from "./egress-proxy.js";

describe("EgressFilter", () => {
  describe("exact domain matching", () => {
    const filter = new EgressFilter(["api.braintreegateway.com", "api.postmarkapp.com"]);

    it("allows exact match", () => {
      filter.validate("https://api.braintreegateway.com/merchants/123");
      filter.validate("https://api.postmarkapp.com/email");
    });

    it("blocks non-allowlisted domain", () => {
      assert.throws(() => filter.validate("https://evil.com/exfil"), /Egress blocked/);
    });

    it("blocks subdomain of exact match", () => {
      assert.throws(() => filter.validate("https://sub.api.braintreegateway.com"), /Egress blocked/);
    });

    it("is case-insensitive", () => {
      filter.validate("https://API.BRAINTREEGATEWAY.COM/test");
    });
  });

  describe("wildcard domain matching", () => {
    const filter = new EgressFilter(["*.supabase.co", "api.braintreegateway.com"]);

    it("allows subdomain matching wildcard", () => {
      filter.validate("https://myproject.supabase.co/rest/v1/table");
      filter.validate("https://deep.nested.supabase.co/api");
    });

    it("allows bare domain for wildcard pattern", () => {
      filter.validate("https://supabase.co/dashboard");
    });

    it("blocks unrelated domain", () => {
      assert.throws(() => filter.validate("https://supabase.io"), /Egress blocked/);
    });
  });

  describe("isAllowed", () => {
    const filter = new EgressFilter(["api.example.com", "*.cloud.io"]);

    it("returns true for allowed hostname", () => {
      assert.strictEqual(filter.isAllowed("api.example.com"), true);
    });

    it("returns false for disallowed hostname", () => {
      assert.strictEqual(filter.isAllowed("evil.com"), false);
    });

    it("returns true for wildcard match", () => {
      assert.strictEqual(filter.isAllowed("app.cloud.io"), true);
    });

    it("returns true for bare wildcard domain", () => {
      assert.strictEqual(filter.isAllowed("cloud.io"), true);
    });
  });

  describe("edge cases", () => {
    it("throws on invalid URL", () => {
      const filter = new EgressFilter(["example.com"]);
      assert.throws(() => filter.validate("not-a-url"), /invalid URL/);
    });

    it("empty allowlist blocks everything", () => {
      const filter = new EgressFilter([]);
      assert.throws(() => filter.validate("https://example.com"), /Egress blocked/);
    });

    it("handles URL with port", () => {
      const filter = new EgressFilter(["localhost"]);
      filter.validate("http://localhost:3000/api");
    });

    it("handles URL with path and query", () => {
      const filter = new EgressFilter(["api.example.com"]);
      filter.validate("https://api.example.com/v1/resource?key=value&foo=bar");
    });
  });
});
