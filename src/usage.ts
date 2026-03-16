export interface SessionUsage {
  sessionId: string;
  agentId: string;
  userName: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  turns: number;
  firstUsedAt: string;
  lastUsedAt: string;
}

export interface UsageSummary {
  user: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalTurns: number;
  sessions: number;
  estimatedCostUsd: number;
}

/** In-memory usage store. */
export class UsageTracker {
  private sessions = new Map<string, SessionUsage>();

  /** Record a completed turn's usage */
  recordTurn(
    sessionId: string,
    agentId: string,
    userName: string,
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
    },
  ): void {
    const existing = this.sessions.get(sessionId);
    const now = new Date().toISOString();

    if (existing) {
      existing.inputTokens += usage.inputTokens;
      existing.outputTokens += usage.outputTokens;
      existing.cacheReadTokens += usage.cacheReadTokens ?? 0;
      existing.cacheCreationTokens += usage.cacheCreationTokens ?? 0;
      existing.turns += 1;
      existing.lastUsedAt = now;
    } else {
      this.sessions.set(sessionId, {
        sessionId,
        agentId,
        userName,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens ?? 0,
        cacheCreationTokens: usage.cacheCreationTokens ?? 0,
        turns: 1,
        firstUsedAt: now,
        lastUsedAt: now,
      });
    }
  }

  /** Get per-user summary */
  summarizeByUser(): UsageSummary[] {
    const byUser = new Map<string, UsageSummary>();

    for (const session of this.sessions.values()) {
      const existing = byUser.get(session.userName);
      if (existing) {
        existing.totalInputTokens += session.inputTokens;
        existing.totalOutputTokens += session.outputTokens;
        existing.totalCacheReadTokens += session.cacheReadTokens;
        existing.totalCacheCreationTokens += session.cacheCreationTokens;
        existing.totalTurns += session.turns;
        existing.sessions += 1;
      } else {
        byUser.set(session.userName, {
          user: session.userName,
          totalInputTokens: session.inputTokens,
          totalOutputTokens: session.outputTokens,
          totalCacheReadTokens: session.cacheReadTokens,
          totalCacheCreationTokens: session.cacheCreationTokens,
          totalTurns: session.turns,
          sessions: 1,
          estimatedCostUsd: 0,
        });
      }
    }

    // Estimate costs (Opus 4.6 pricing as of 2026-03)
    // Input: $15/MTok, Output: $75/MTok, Cache read: $1.875/MTok, Cache write: $18.75/MTok
    for (const summary of byUser.values()) {
      summary.estimatedCostUsd =
        (summary.totalInputTokens / 1_000_000) * 15 +
        (summary.totalOutputTokens / 1_000_000) * 75 +
        (summary.totalCacheReadTokens / 1_000_000) * 1.875 +
        (summary.totalCacheCreationTokens / 1_000_000) * 18.75;
      summary.estimatedCostUsd = Math.round(summary.estimatedCostUsd * 100) / 100;
    }

    return Array.from(byUser.values());
  }

  /** Get all session usage records */
  allSessions(): SessionUsage[] {
    return Array.from(this.sessions.values());
  }
}
