/**
 * Per-user rate limiting for serve mode.
 * In-memory sliding window counters.
 */

export interface RateLimitConfig {
  messagesPerMinute: number;
  concurrentSessions: number;
  wsConnectionsPerUser: number;
  maxMessageLength: number;
  authFailuresPerMinute: number;
  wsIdleTimeoutMs: number;
}

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  messagesPerMinute: 20,
  concurrentSessions: 3,
  wsConnectionsPerUser: 5,
  maxMessageLength: 50_000,
  authFailuresPerMinute: 5,
  wsIdleTimeoutMs: 5 * 60 * 1000, // 5 minutes
};

interface SlidingWindowEntry {
  timestamps: number[];
}

export class RateLimiter {
  private config: RateLimitConfig;
  private readonly messageWindows = new Map<string, SlidingWindowEntry>();
  private readonly authFailureWindows = new Map<string, SlidingWindowEntry>();
  private readonly activeSessions = new Map<string, Set<string>>(); // userId → sessionIds
  private readonly activeConnections = new Map<string, number>(); // userId → connection count

  constructor(config: Partial<RateLimitConfig> = {}) {
    this.config = { ...DEFAULT_RATE_LIMITS, ...config };
  }

  /**
   * Check if a user can send a message. Returns null if allowed,
   * or a retryAfter value (seconds) if rate limited.
   */
  checkMessageRate(userId: string): { allowed: true } | { allowed: false; retryAfter: number } {
    const now = Date.now();
    const windowMs = 60_000;

    let entry = this.messageWindows.get(userId);
    if (!entry) {
      entry = { timestamps: [] };
      this.messageWindows.set(userId, entry);
    }

    // Prune expired entries
    entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);

    if (entry.timestamps.length >= this.config.messagesPerMinute) {
      const oldest = entry.timestamps[0] ?? 0;
      const retryAfter = Math.ceil((oldest + windowMs - now) / 1000);
      return { allowed: false, retryAfter };
    }

    entry.timestamps.push(now);
    return { allowed: true };
  }

  /** Check if message content exceeds max length. */
  checkMessageLength(content: string): boolean {
    return content.length <= this.config.maxMessageLength;
  }

  /** Track a new session for a user. Returns false if limit exceeded. */
  addSession(userId: string, sessionId: string): boolean {
    let sessions = this.activeSessions.get(userId);
    if (!sessions) {
      sessions = new Set();
      this.activeSessions.set(userId, sessions);
    }
    if (sessions.size >= this.config.concurrentSessions) {
      return false;
    }
    sessions.add(sessionId);
    return true;
  }

  /** Remove a session when it ends. */
  removeSession(userId: string, sessionId: string): void {
    const sessions = this.activeSessions.get(userId);
    if (sessions) {
      sessions.delete(sessionId);
      if (sessions.size === 0) this.activeSessions.delete(userId);
    }
  }

  /** Track a new WebSocket connection. Returns false if limit exceeded. */
  addConnection(userId: string): boolean {
    const count = this.activeConnections.get(userId) ?? 0;
    if (count >= this.config.wsConnectionsPerUser) {
      return false;
    }
    this.activeConnections.set(userId, count + 1);
    return true;
  }

  /** Remove a WebSocket connection when it closes. */
  removeConnection(userId: string): void {
    const count = this.activeConnections.get(userId) ?? 0;
    if (count <= 1) {
      this.activeConnections.delete(userId);
    } else {
      this.activeConnections.set(userId, count - 1);
    }
  }

  /**
   * Record an auth failure for an IP. Returns false if rate limited.
   */
  checkAuthFailure(ip: string): boolean {
    const now = Date.now();
    const windowMs = 60_000;

    let entry = this.authFailureWindows.get(ip);
    if (!entry) {
      entry = { timestamps: [] };
      this.authFailureWindows.set(ip, entry);
    }

    entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);

    if (entry.timestamps.length >= this.config.authFailuresPerMinute) {
      return false;
    }

    entry.timestamps.push(now);
    return true;
  }

  /** Update rate limit configuration at runtime (e.g., after config hot reload). */
  updateLimits(newLimits?: Partial<RateLimitConfig>): void {
    if (newLimits) {
      this.config = { ...this.config, ...newLimits };
    }
  }

  /** Get idle timeout in ms. */
  get idleTimeoutMs(): number {
    return this.config.wsIdleTimeoutMs;
  }
}
