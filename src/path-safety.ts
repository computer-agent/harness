import { resolve } from "node:path";

/**
 * Validate a path segment to prevent directory traversal.
 * Rejects .., /, \, and null bytes.
 */
export function validatePathSegment(segment: string, label: string): string {
  if (!segment || segment.includes("..") || segment.includes("/") || segment.includes("\\") || segment.includes("\0")) {
    throw new Error(`Invalid ${label}: contains path traversal characters`);
  }
  return segment;
}

/** UUID v4 pattern (lowercase hex with dashes) */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validate a session ID as a UUID. */
export function validateSessionId(id: string): string {
  if (!UUID_RE.test(id)) {
    throw new Error(`Invalid session ID: expected UUID format, got "${id}"`);
  }
  return id;
}

/** Agent/user name pattern: alphanumeric, hyphens, underscores, 1-64 chars */
const SAFE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,62}[a-z0-9]$/i;

/** Validate an agent or user name for safe use in file paths. */
export function validateName(name: string, label: string): string {
  if (!name || name.length > 64 || !SAFE_NAME_RE.test(name)) {
    throw new Error(`Invalid ${label}: must be 2-64 alphanumeric/hyphen/underscore characters, got "${name}"`);
  }
  validatePathSegment(name, label);
  return name;
}

/**
 * Join path segments and verify the result stays within the expected base directory.
 * Throws if the resolved path escapes the base.
 */
export function safePath(base: string, ...segments: string[]): string {
  const resolved = resolve(base, ...segments);
  const normalizedBase = resolve(base);
  if (!resolved.startsWith(`${normalizedBase}/`) && resolved !== normalizedBase) {
    throw new Error(`Path traversal detected: resolved path escapes base directory`);
  }
  return resolved;
}
