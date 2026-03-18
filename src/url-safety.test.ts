import assert from "node:assert";
import { describe, it } from "node:test";
import {
  BLOCKED_RANGES,
  buildPinnedFetchArgs,
  isBlockedIp,
  normalizeIp,
  parseExoticIp,
  validateUrl,
} from "./url-safety.js";

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

  it("allows 172.32.x.x (not private)", () => {
    assert.ok(!BLOCKED_RANGES.some((r) => r.test("172.32.0.1")), "172.32.0.1 should not match any blocked range");
  });

  it("allows public URLs (range check)", () => {
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

  it("returns resolved IP info for DNS pinning", async () => {
    const result = await validateUrl("http://127.0.0.2/test").catch(() => null);
    // 127.0.0.2 is in blocked range, so it should reject
    assert.strictEqual(result, null);
  });

  // W4-T04: Exotic IP encoding bypass vectors
  it("rejects decimal IP for loopback (2130706433 = 127.0.0.1)", async () => {
    await assert.rejects(() => validateUrl("http://2130706433/secret"), /private\/internal/);
  });

  it("rejects hex IP for loopback (0x7f000001 = 127.0.0.1)", async () => {
    await assert.rejects(() => validateUrl("http://0x7f000001/secret"), /private\/internal/);
  });

  it("rejects decimal IP for metadata (2852039166 = 169.254.169.254)", async () => {
    await assert.rejects(() => validateUrl("http://2852039166/latest/meta-data"), /private\/internal/);
  });

  // P0 fix: IPv4-mapped IPv6 via URL — URL parser normalizes to hex-short form
  it("rejects [::ffff:127.0.0.1] (IPv4-mapped IPv6 via URL)", async () => {
    await assert.rejects(() => validateUrl("http://[::ffff:127.0.0.1]/secret"), /private\/internal/);
  });

  it("rejects [::ffff:169.254.169.254] (metadata via IPv4-mapped IPv6)", async () => {
    await assert.rejects(() => validateUrl("http://[::ffff:169.254.169.254]/latest/meta-data"), /private\/internal/);
  });

  it("rejects [::ffff:10.0.0.1] (private via IPv4-mapped IPv6)", async () => {
    await assert.rejects(() => validateUrl("http://[::ffff:10.0.0.1]/secret"), /private\/internal/);
  });

  // Protocol validation
  it("rejects file:// URLs", async () => {
    await assert.rejects(() => validateUrl("file:///etc/passwd"), /Only HTTP and HTTPS/);
  });

  it("rejects data: URLs", async () => {
    await assert.rejects(() => validateUrl("data:text/html,<h1>hi</h1>"), /Only HTTP and HTTPS/);
  });

  it("rejects ftp:// URLs", async () => {
    await assert.rejects(() => validateUrl("ftp://example.com/file"), /Only HTTP and HTTPS/);
  });
});

describe("normalizeIp", () => {
  it("strips IPv4-mapped IPv6 prefix (dotted form)", () => {
    assert.strictEqual(normalizeIp("::ffff:127.0.0.1"), "127.0.0.1");
    assert.strictEqual(normalizeIp("::ffff:10.0.0.1"), "10.0.0.1");
    assert.strictEqual(normalizeIp("::ffff:192.168.1.1"), "192.168.1.1");
  });

  // P0 fix: hex-short form produced by new URL().hostname
  it("strips IPv4-mapped IPv6 hex-short form (URL parser output)", () => {
    // ::ffff:7f00:1 is how URL parser represents ::ffff:127.0.0.1
    assert.strictEqual(normalizeIp("::ffff:7f00:1"), "127.0.0.1");
    // ::ffff:a9fe:a9fe = 169.254.169.254
    assert.strictEqual(normalizeIp("::ffff:a9fe:a9fe"), "169.254.169.254");
    // ::ffff:a00:1 = 10.0.0.1
    assert.strictEqual(normalizeIp("::ffff:a00:1"), "10.0.0.1");
    // ::ffff:c0a8:101 = 192.168.1.1
    assert.strictEqual(normalizeIp("::ffff:c0a8:101"), "192.168.1.1");
  });

  it("strips IPv4-compatible IPv6 prefix", () => {
    assert.strictEqual(normalizeIp("::127.0.0.1"), "127.0.0.1");
  });

  it("passes through regular IPv4", () => {
    assert.strictEqual(normalizeIp("8.8.8.8"), "8.8.8.8");
    assert.strictEqual(normalizeIp("127.0.0.1"), "127.0.0.1");
  });

  it("passes through regular IPv6", () => {
    assert.strictEqual(normalizeIp("::1"), "::1");
    assert.strictEqual(normalizeIp("2606:4700::1"), "2606:4700::1");
  });

  it("is case-insensitive for ffff prefix", () => {
    assert.strictEqual(normalizeIp("::FFFF:127.0.0.1"), "127.0.0.1");
    assert.strictEqual(normalizeIp("::FFFF:7f00:1"), "127.0.0.1");
  });
});

describe("parseExoticIp", () => {
  it("parses decimal integer to dotted quad", () => {
    assert.strictEqual(parseExoticIp("2130706433"), "127.0.0.1");
    assert.strictEqual(parseExoticIp("167772161"), "10.0.0.1");
  });

  it("parses hex integer to dotted quad", () => {
    assert.strictEqual(parseExoticIp("0x7f000001"), "127.0.0.1");
    assert.strictEqual(parseExoticIp("0x0a000001"), "10.0.0.1");
  });

  it("parses octal-dotted notation", () => {
    assert.strictEqual(parseExoticIp("0177.0.0.01"), "127.0.0.1");
    assert.strictEqual(parseExoticIp("012.0.0.01"), "10.0.0.1");
  });

  it("parses hex-dotted notation", () => {
    assert.strictEqual(parseExoticIp("0x7f.0.0.1"), "127.0.0.1");
  });

  it("returns null for normal dotted quad", () => {
    assert.strictEqual(parseExoticIp("127.0.0.1"), null);
    assert.strictEqual(parseExoticIp("8.8.8.8"), null);
  });

  it("returns null for non-IP strings", () => {
    assert.strictEqual(parseExoticIp("example.com"), null);
    assert.strictEqual(parseExoticIp(""), null);
  });

  it("returns null for out-of-range values", () => {
    assert.strictEqual(parseExoticIp("4294967296"), null); // > 0xFFFFFFFF
    assert.strictEqual(parseExoticIp("-1"), null);
  });

  it("handles metadata endpoint decimal (169.254.169.254)", () => {
    // 169.254.169.254 = 0xa9fea9fe = 2852039166
    assert.strictEqual(parseExoticIp("2852039166"), "169.254.169.254");
  });
});

describe("isBlockedIp", () => {
  it("blocks IPv4-mapped IPv6 loopback (dotted)", () => {
    assert.ok(isBlockedIp("::ffff:127.0.0.1"));
  });

  it("blocks IPv4-mapped IPv6 loopback (hex-short)", () => {
    assert.ok(isBlockedIp("::ffff:7f00:1"));
  });

  it("blocks IPv4-mapped IPv6 private (dotted)", () => {
    assert.ok(isBlockedIp("::ffff:10.0.0.1"));
    assert.ok(isBlockedIp("::ffff:192.168.1.1"));
    assert.ok(isBlockedIp("::ffff:172.16.0.1"));
  });

  it("blocks IPv4-mapped IPv6 private (hex-short)", () => {
    assert.ok(isBlockedIp("::ffff:a00:1"));
    assert.ok(isBlockedIp("::ffff:c0a8:101"));
    assert.ok(isBlockedIp("::ffff:ac10:1"));
  });

  it("blocks IPv4-mapped IPv6 metadata (both forms)", () => {
    assert.ok(isBlockedIp("::ffff:169.254.169.254"));
    assert.ok(isBlockedIp("::ffff:a9fe:a9fe"));
  });

  it("allows IPv4-mapped IPv6 public", () => {
    assert.ok(!isBlockedIp("::ffff:8.8.8.8"));
    assert.ok(!isBlockedIp("::ffff:808:808"));
  });

  it("blocks standard private ranges", () => {
    assert.ok(isBlockedIp("127.0.0.1"));
    assert.ok(isBlockedIp("10.0.0.1"));
    assert.ok(isBlockedIp("192.168.1.1"));
    assert.ok(isBlockedIp("::1"));
  });

  it("allows public IPs", () => {
    assert.ok(!isBlockedIp("8.8.8.8"));
    assert.ok(!isBlockedIp("1.1.1.1"));
  });
});

describe("buildPinnedFetchArgs", () => {
  it("replaces hostname with resolved IP", () => {
    const result = buildPinnedFetchArgs("https://example.com/path?q=1", "93.184.216.34");
    assert.ok(result.url.includes("93.184.216.34"));
    assert.strictEqual(result.headers.Host, "example.com");
  });

  it("preserves port in Host header", () => {
    const result = buildPinnedFetchArgs("http://example.com:8080/path", "93.184.216.34");
    assert.strictEqual(result.headers.Host, "example.com:8080");
  });

  it("brackets IPv6 addresses", () => {
    const result = buildPinnedFetchArgs("http://example.com/path", "2606:4700::1");
    assert.ok(result.url.includes("[2606:4700::1]"));
    assert.strictEqual(result.headers.Host, "example.com");
  });

  it("merges extra headers", () => {
    const result = buildPinnedFetchArgs("http://example.com/", "1.2.3.4", { "User-Agent": "test" });
    assert.strictEqual(result.headers["User-Agent"], "test");
    assert.strictEqual(result.headers.Host, "example.com");
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
