/**
 * Egress filtering — restricts which external domains tools can reach.
 *
 * When an agent declares `sandbox.allowedDomains` in its IDENTITY.md frontmatter,
 * only requests to listed domains (or matching wildcards) are permitted.
 * Without allowedDomains, all outbound requests are allowed (existing behavior).
 */

export class EgressFilter {
  private readonly patterns: Array<{ exact?: string; suffix?: string }>;

  /**
   * @param allowedDomains Domain patterns from frontmatter. Supports:
   *   - Exact match: "api.braintreegateway.com"
   *   - Wildcard suffix: "*.supabase.co" (matches any subdomain)
   */
  constructor(allowedDomains: string[]) {
    this.patterns = allowedDomains.map((d) => {
      if (d.startsWith("*.")) {
        return { suffix: d.slice(1) }; // "*.foo.com" → suffix ".foo.com"
      }
      return { exact: d };
    });
  }

  /**
   * Check whether a URL's hostname is in the allowlist.
   * Throws if the domain is not allowed.
   */
  validate(url: string): void {
    const hostname = this.extractHostname(url);
    if (!this.isAllowed(hostname)) {
      throw new Error(`Egress blocked: domain "${hostname}" is not in the allowed list`);
    }
  }

  /**
   * Check whether a hostname matches any allowed pattern.
   */
  isAllowed(hostname: string): boolean {
    const lower = hostname.toLowerCase();
    for (const pattern of this.patterns) {
      if (pattern.exact && lower === pattern.exact.toLowerCase()) return true;
      if (
        pattern.suffix &&
        (lower.endsWith(pattern.suffix.toLowerCase()) || lower === pattern.suffix.slice(1).toLowerCase())
      )
        return true;
    }
    return false;
  }

  private extractHostname(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      throw new Error(`Egress blocked: invalid URL "${url}"`);
    }
  }
}
