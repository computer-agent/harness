import assert from "node:assert";
import { describe, it } from "node:test";
import { BLOCKED_RANGES, validateUrl } from "./url-safety.js";

describe("validateUrl", () => {
  it("rejects localhost", async () => {
    await assert.rejects(() => validateUrl("http://localhost:8080/secret"), /localhost/);
  });

  it("rejects ::1", async () => {
    await assert.rejects(() => validateUrl("http://[::1]:8080/secret"), /localhost/);
  });

  it("rejects 127.0.0.1", async () => {
    await assert.rejects(() => validateUrl("http://127.0.0.1/secret"), /private\/internal/);
  });

  it("rejects 10.x.x.x (private)", async () => {
    await assert.rejects(() => validateUrl("http://10.0.0.1/secret"), /private\/internal/);
  });

  it("rejects 169.254.x.x (link-local / cloud metadata)", async () => {
    await assert.rejects(() => validateUrl("http://169.254.169.254/latest/meta-data"), /private\/internal/);
  });

  it("rejects 192.168.x.x (private)", async () => {
    await assert.rejects(() => validateUrl("http://192.168.1.1/admin"), /private\/internal/);
  });

  it("rejects 172.16-31.x.x (private)", async () => {
    await assert.rejects(() => validateUrl("http://172.16.0.1/admin"), /private\/internal/);
    await assert.rejects(() => validateUrl("http://172.31.255.255/admin"), /private\/internal/);
  });

  it("allows 172.32.x.x (not private)", async () => {
    // 172.32.x.x is public — should not be blocked by range check
    // (may fail DNS but should not throw SSRF error)
    // We test the BLOCKED_RANGES directly to avoid DNS lookup
    assert.ok(!BLOCKED_RANGES.some((r) => r.test("172.32.0.1")), "172.32.0.1 should not match any blocked range");
  });

  it("allows public URLs (range check)", () => {
    // Test the blocked ranges directly to avoid DNS lookups in tests
    const publicIPs = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700::1"];
    for (const ip of publicIPs) {
      assert.ok(!BLOCKED_RANGES.some((r) => r.test(ip)), `Public IP ${ip} should not be blocked`);
    }
  });

  it("rejects 0.x.x.x", async () => {
    await assert.rejects(() => validateUrl("http://0.0.0.0/"), /private\/internal/);
  });

  it("throws on invalid URL", async () => {
    await assert.rejects(() => validateUrl("not-a-url"), /Invalid URL/);
  });
});

describe("BLOCKED_RANGES", () => {
  it("covers all RFC1918 + link-local + loopback ranges", () => {
    const mustBlock = [
      "127.0.0.1",
      "127.255.255.255",
      "10.0.0.1",
      "10.255.255.255",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.0.1",
      "192.168.255.255",
      "169.254.1.1",
      "0.0.0.0",
      "::1",
      "fc00::1",
      "fd00::1",
      "fe80::1",
    ];
    for (const ip of mustBlock) {
      assert.ok(
        BLOCKED_RANGES.some((r) => r.test(ip)),
        `Expected ${ip} to be blocked`,
      );
    }
  });

  it("does not block public IPs", () => {
    const mustAllow = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "11.0.0.1"];
    for (const ip of mustAllow) {
      assert.ok(!BLOCKED_RANGES.some((r) => r.test(ip)), `Expected ${ip} to NOT be blocked`);
    }
  });
});
