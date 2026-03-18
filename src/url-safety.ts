/**
 * URL validation for SSRF protection.
 *
 * Blocks requests to private/internal networks, localhost, and link-local addresses.
 * Handles bypass vectors: IPv4-mapped IPv6 (both dotted and hex-short forms),
 * decimal/octal/hex IPs.
 *
 * Used by web tools and A2A tools to prevent server-side request forgery.
 *
 * DNS pinning note: buildPinnedFetchArgs is exported for HTTP-only use cases.
 * For HTTPS, DNS pinning via URL rewriting breaks TLS (SNI derived from URL
 * hostname, not Host header). True HTTPS DNS pinning requires undici's
 * dispatcher with a custom `connect.lookup` — a future enhancement.
 * The SSRF blocklist check (validateUrl) is the primary defense; DNS pinning
 * closes a narrow TOCTOU window that requires an attacker-controlled DNS server.
 */

import { lookup } from "node:dns/promises";
import { isIP, isIPv6 } from "node:net";

/** Private/internal IPv4 and IPv6 CIDR ranges (checked after normalization). */
export const BLOCKED_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  /^fc/,
  /^fd/,
  /^fe80/,
];

/**
 * Normalize an IP address to a canonical form that BLOCKED_RANGES can match.
 *
 * Handles:
 * - IPv4-mapped IPv6 dotted:    `::ffff:127.0.0.1`  → `127.0.0.1`
 * - IPv4-mapped IPv6 hex-short: `::ffff:7f00:1`     → `127.0.0.1`
 *   (This is the form produced by `new URL("http://[::ffff:127.0.0.1]").hostname`)
 * - IPv4-compatible IPv6:       `::127.0.0.1`       → `127.0.0.1`
 * - Standard IPv4/IPv6: returned as-is
 */
export function normalizeIp(ip: string): string {
  // Form 1: Dotted-decimal IPv4 in mapped/compatible address
  // e.g. ::ffff:127.0.0.1, ::10.0.0.1
  const v4Mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;
  const v4Compat = /^::(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;
  const dottedMatch = ip.match(v4Mapped) ?? ip.match(v4Compat);
  if (dottedMatch?.[1]) return dottedMatch[1];

  // Form 2: Hex-short IPv4-mapped address (URL parser produces this)
  // e.g. ::ffff:7f00:1 → two 16-bit groups encoding the four IPv4 octets
  // Group1=0x7f00 → octets 127, 0   Group2=0x0001 → octets 0, 1  → 127.0.0.1
  const hexShort = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;
  const hexMatch = ip.match(hexShort);
  if (hexMatch?.[1] && hexMatch[2]) {
    const hi = parseInt(hexMatch[1], 16);
    const lo = parseInt(hexMatch[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }

  return ip;
}

/**
 * Parse exotic IP representations to dotted-quad IPv4.
 *
 * Handles:
 * - Decimal:  `2130706433`  → `127.0.0.1`
 * - Hex:      `0x7f000001`  → `127.0.0.1`
 * - Octal:    `0177.0.0.1`  → `127.0.0.1`
 * - Mixed:    `0x7f.0.0.1`  → `127.0.0.1`
 *
 * Returns null if the hostname is not an exotic IP representation.
 *
 * Note: `new URL()` normalizes most exotic IPs to dotted-quad before we see them,
 * so this serves as a defense-in-depth second check for any callers that bypass
 * URL parsing.
 */
export function parseExoticIp(hostname: string): string | null {
  // Single-integer IP (decimal or hex): e.g. 2130706433, 0x7f000001
  if (/^(0x[\da-f]+|\d+)$/i.test(hostname)) {
    const num = Number(hostname);
    if (!Number.isFinite(num) || num < 0 || num > 0xffffffff) return null;
    const n = num >>> 0; // force unsigned 32-bit
    return `${(n >> 24) & 0xff}.${(n >> 16) & 0xff}.${(n >> 8) & 0xff}.${n & 0xff}`;
  }

  // Dotted notation with octal/hex octets: e.g. 0177.0.0.1, 0x7f.0.0.1
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;

  const hasExotic = parts.some((p) => /^0[xX]/.test(p) || (/^0\d/.test(p) && p.length > 1));
  if (!hasExotic) return null;

  const octets: number[] = [];
  for (const part of parts) {
    let val: number;
    if (/^0[xX][\da-fA-F]+$/.test(part)) {
      val = parseInt(part, 16);
    } else if (/^0\d+$/.test(part) && part.length > 1) {
      val = parseInt(part, 8);
    } else {
      val = parseInt(part, 10);
    }
    if (!Number.isFinite(val) || val < 0 || val > 255) return null;
    octets.push(val);
  }

  return octets.join(".");
}

/**
 * Check whether an IP address falls in a blocked range.
 * Applies normalization (IPv4-mapped IPv6, exotic encodings) first.
 */
export function isBlockedIp(ip: string): boolean {
  const normalized = normalizeIp(ip);
  return BLOCKED_RANGES.some((r) => r.test(normalized));
}

export interface ResolvedUrl {
  /** The original URL string. */
  original: string;
  /** Resolved and validated IP address. */
  resolvedIp: string;
  /** Original hostname (for Host header). */
  hostname: string;
}

/**
 * Validate that a URL does not point to a private/internal network.
 * Resolves hostnames to IP addresses, normalizes exotic representations,
 * and checks against blocked ranges.
 *
 * Only HTTP and HTTPS URLs are allowed — rejects file://, data://, etc.
 *
 * @throws Error if the URL targets localhost, a private IP, a link-local address,
 *         or uses an unsupported protocol.
 */
export async function validateUrl(url: string): Promise<ResolvedUrl> {
  const parsed = new URL(url);

  // P1: Reject non-HTTP(S) schemes — prevents file://, data://, ftp:// etc.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS URLs are allowed");
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");

  if (hostname === "localhost" || hostname === "::1") {
    throw new Error("Requests to localhost are not allowed");
  }

  // Check for exotic IP encodings (decimal, octal, hex) — defense-in-depth
  const exotic = parseExoticIp(hostname);
  if (exotic) {
    if (isBlockedIp(exotic)) {
      throw new Error("Requests to private/internal networks are not allowed");
    }
    return { original: url, resolvedIp: exotic, hostname };
  }

  // Resolve IP — either it's already an IP literal or we need DNS
  let ip: string;
  if (isIP(hostname)) {
    ip = hostname;
  } else {
    const result = await lookup(hostname);
    if (!result?.address) {
      throw new Error(`DNS resolution failed for ${hostname}`);
    }
    ip = result.address;
  }

  // Normalize and check
  if (isBlockedIp(ip)) {
    throw new Error("Requests to private/internal networks are not allowed");
  }

  return { original: url, resolvedIp: ip, hostname };
}

/**
 * Build fetch arguments that pin the connection to a validated IP address.
 * Prevents DNS rebinding (TOCTOU) by bypassing DNS resolution in fetch.
 *
 * WARNING: Only works for plain HTTP. For HTTPS, TLS SNI is derived from the
 * URL hostname (not Host header), so replacing the hostname with an IP causes
 * certificate mismatch. Use undici dispatcher with custom `connect.lookup`
 * for HTTPS DNS pinning.
 */
export function buildPinnedFetchArgs(
  url: string,
  resolvedIp: string,
  extraHeaders: Record<string, string> = {},
): { url: string; headers: Record<string, string> } {
  const parsed = new URL(url);
  const originalHost = parsed.host; // includes port if non-default

  // Replace hostname with the resolved IP
  if (isIPv6(resolvedIp)) {
    parsed.hostname = `[${resolvedIp}]`;
  } else {
    parsed.hostname = resolvedIp;
  }

  return {
    url: parsed.toString(),
    headers: {
      ...extraHeaders,
      Host: originalHost,
    },
  };
}
