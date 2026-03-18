/**
 * URL validation for SSRF protection.
 *
 * Blocks requests to private/internal networks, localhost, and link-local addresses.
 * Used by web tools and A2A tools to prevent server-side request forgery.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

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
 * Validate that a URL does not point to a private/internal network.
 * Resolves hostnames to IP addresses and checks against blocked ranges.
 *
 * @throws Error if the URL targets localhost, a private IP, or a link-local address.
 */
export async function validateUrl(url: string): Promise<void> {
  const parsed = new URL(url);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname === "::1") {
    throw new Error("Requests to localhost are not allowed");
  }
  const ip = isIP(hostname) ? hostname : (await lookup(hostname)).address;
  if (BLOCKED_RANGES.some((r) => r.test(ip))) {
    throw new Error("Requests to private/internal networks are not allowed");
  }
}
