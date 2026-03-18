/**
 * Credential scoping — controls which env keys are visible to which tool domains.
 *
 * When an agent declares `credentials.grants` in its IDENTITY.md frontmatter,
 * only explicitly granted keys are available to each tool domain ("strict mode").
 * Without a credentials block, all keys are available everywhere ("legacy mode").
 */

import type { Logger } from "./logger.js";
import type { ToolDomain } from "./manifest.js";

export interface CredentialGrant {
  keys: string[];
  tools: ToolDomain[];
  approval?: "required";
}

export interface CredentialsConfig {
  grants: Record<string, CredentialGrant>;
}

export class CredentialStore {
  private readonly allEnv: Record<string, string>;
  private readonly grants: Record<string, CredentialGrant> | null;
  private readonly logger?: Logger;

  /**
   * @param allEnv    All agent env vars (from dotenvx .env)
   * @param config    Parsed credentials config from frontmatter (null = legacy mode)
   * @param logger    Optional logger for audit trail
   */
  constructor(allEnv: Record<string, string>, config?: CredentialsConfig | null, logger?: Logger) {
    this.allEnv = allEnv;
    this.grants = config?.grants ?? null;
    this.logger = logger;
  }

  /** True when the agent has a credentials block (strict mode). */
  get isStrict(): boolean {
    return this.grants !== null;
  }

  /**
   * Resolve the env vars available to a specific tool domain.
   *
   * - Legacy mode (no credentials config): returns all env vars.
   * - Strict mode: returns only keys explicitly granted to this domain.
   *   Grants with `approval: required` are excluded (future: prompt user).
   */
  resolveFlat(domain: ToolDomain): Record<string, string> {
    if (!this.grants) {
      // Legacy mode — all keys available
      return { ...this.allEnv };
    }

    const result: Record<string, string> = {};
    const grantNames: string[] = [];

    for (const [name, grant] of Object.entries(this.grants)) {
      if (!grant.tools.includes(domain)) continue;
      if (grant.approval === "required") continue; // Skip approval-required grants

      grantNames.push(name);
      for (const key of grant.keys) {
        const val = this.allEnv[key];
        if (val !== undefined) {
          result[key] = val;
        }
      }
    }

    if (this.logger && grantNames.length > 0) {
      this.logger.info("tool", "credentials.resolved", `Credentials resolved for domain "${domain}"`, {
        details: {
          domain,
          grants: grantNames,
          keys: Object.keys(result),
        },
      });
    }

    return result;
  }

  /**
   * Return all env vars (legacy fallback).
   * Use this only when credential scoping is not applicable (e.g., shell env).
   */
  toFlatEnv(): Record<string, string> {
    return { ...this.allEnv };
  }

  /**
   * List all grant names and their configurations (for audit/CLI display).
   */
  listGrants(): Array<{ name: string; grant: CredentialGrant }> {
    if (!this.grants) return [];
    return Object.entries(this.grants).map(([name, grant]) => ({ name, grant }));
  }
}
