import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getHomeDir } from "./config.js";

export interface BudgetConfig {
  sessionLimit: number;
  dailyLimit: number;
  monthlyLimit: number;
}

export const DEFAULT_BUDGET: BudgetConfig = {
  sessionLimit: 500_000,
  dailyLimit: 2_000_000,
  monthlyLimit: 30_000_000,
};

export const UNLIMITED_BUDGET: BudgetConfig = {
  sessionLimit: Infinity,
  dailyLimit: Infinity,
  monthlyLimit: Infinity,
};

export interface BudgetStatus {
  allowed: boolean;
  warnings: BudgetWarningDetail[];
  exceeded?: {
    budget: "session" | "daily" | "monthly";
    limit: number;
    used: number;
    resetsAt?: string; // ISO timestamp
  };
}

export interface BudgetWarningDetail {
  budget: "session" | "daily" | "monthly";
  limit: number;
  used: number;
  percentage: number;
}

interface UsageEntry {
  timestamp: number;
  tokens: number;
}

interface UserUsageData {
  dailyTokens: UsageEntry[];
  monthlyTokens: UsageEntry[];
  sessionTokens: Record<string, number>; // sessionId -> total tokens
}

export class CostTracker {
  private usage = new Map<string, UserUsageData>();
  private budgets = new Map<string, BudgetConfig>();
  private persistTimer: ReturnType<typeof setInterval> | null = null;
  private dirty = false;

  /** Set a user's budget config */
  setBudget(userId: string, budget: BudgetConfig): void {
    this.budgets.set(userId, budget);
  }

  /** Get the budget for a user (returns DEFAULT_BUDGET if not set) */
  getBudget(userId: string): BudgetConfig {
    return this.budgets.get(userId) ?? DEFAULT_BUDGET;
  }

  /** Record token usage for a turn */
  recordUsage(userId: string, sessionId: string, inputTokens: number, outputTokens: number): void {
    const totalTokens = inputTokens + outputTokens;
    const data = this.getOrCreateUsageData(userId);
    const now = Date.now();

    data.dailyTokens.push({ timestamp: now, tokens: totalTokens });
    data.monthlyTokens.push({ timestamp: now, tokens: totalTokens });
    data.sessionTokens[sessionId] = (data.sessionTokens[sessionId] ?? 0) + totalTokens;

    this.dirty = true;
  }

  /** Check budget status before/after a message */
  checkBudget(userId: string, sessionId: string): BudgetStatus {
    const budget = this.getBudget(userId);
    const data = this.getOrCreateUsageData(userId);
    const now = Date.now();

    // Clean expired entries
    const dayAgo = now - 24 * 60 * 60 * 1000;
    const monthAgo = now - 30 * 24 * 60 * 60 * 1000;
    data.dailyTokens = data.dailyTokens.filter((e) => e.timestamp > dayAgo);
    data.monthlyTokens = data.monthlyTokens.filter((e) => e.timestamp > monthAgo);

    const sessionUsed = data.sessionTokens[sessionId] ?? 0;
    const dailyUsed = data.dailyTokens.reduce((sum, e) => sum + e.tokens, 0);
    const monthlyUsed = data.monthlyTokens.reduce((sum, e) => sum + e.tokens, 0);

    const warnings: BudgetWarningDetail[] = [];

    // Compute resetsAt: when the oldest entry in the window expires
    const dailyResetsAt =
      data.dailyTokens.length > 0
        ? new Date(data.dailyTokens[0].timestamp + 24 * 60 * 60 * 1000).toISOString()
        : undefined;
    const monthlyResetsAt =
      data.monthlyTokens.length > 0
        ? new Date(data.monthlyTokens[0].timestamp + 30 * 24 * 60 * 60 * 1000).toISOString()
        : undefined;

    const checks: Array<{
      name: "session" | "daily" | "monthly";
      used: number;
      limit: number;
      resetsAt?: string;
    }> = [
      { name: "session", used: sessionUsed, limit: budget.sessionLimit },
      { name: "daily", used: dailyUsed, limit: budget.dailyLimit, resetsAt: dailyResetsAt },
      { name: "monthly", used: monthlyUsed, limit: budget.monthlyLimit, resetsAt: monthlyResetsAt },
    ];

    for (const check of checks) {
      if (check.limit === Infinity) continue;
      const percentage = (check.used / check.limit) * 100;

      if (check.used >= check.limit) {
        return {
          allowed: false,
          warnings,
          exceeded: {
            budget: check.name,
            limit: check.limit,
            used: check.used,
            resetsAt: check.name === "session" ? undefined : check.resetsAt,
          },
        };
      }

      if (percentage >= 80) {
        warnings.push({
          budget: check.name,
          limit: check.limit,
          used: check.used,
          percentage: Math.round(percentage),
        });
      }
    }

    return { allowed: true, warnings };
  }

  /** Reset a user's budget counters */
  resetBudget(userId: string, scope: "session" | "daily" | "monthly" | "all"): void {
    const data = this.usage.get(userId);
    if (!data) return;

    switch (scope) {
      case "session":
        data.sessionTokens = {};
        break;
      case "daily":
        data.dailyTokens = [];
        break;
      case "monthly":
        data.monthlyTokens = [];
        break;
      case "all":
        data.dailyTokens = [];
        data.monthlyTokens = [];
        data.sessionTokens = {};
        break;
    }
    this.dirty = true;
  }

  /** Get usage summary for a user (for GET /api/usage) */
  getUserUsage(userId: string): {
    sessionTokens: Record<string, number>;
    dailyTokens: number;
    monthlyTokens: number;
  } {
    const data = this.getOrCreateUsageData(userId);
    const now = Date.now();
    const dayAgo = now - 24 * 60 * 60 * 1000;
    const monthAgo = now - 30 * 24 * 60 * 60 * 1000;

    return {
      sessionTokens: { ...data.sessionTokens },
      dailyTokens: data.dailyTokens.filter((e) => e.timestamp > dayAgo).reduce((sum, e) => sum + e.tokens, 0),
      monthlyTokens: data.monthlyTokens.filter((e) => e.timestamp > monthAgo).reduce((sum, e) => sum + e.tokens, 0),
    };
  }

  /** Start periodic persistence (every 60 seconds) */
  startPersistence(): void {
    this.persistTimer = setInterval(() => this.persist(), 60_000);
  }

  /** Stop periodic persistence */
  stopPersistence(): void {
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = null;
    }
  }

  /** Write usage data to disk */
  async persist(): Promise<void> {
    if (!this.dirty) return;
    const usageDir = join(getHomeDir(), "state", "usage");
    await mkdir(usageDir, { recursive: true });

    for (const [userId, data] of this.usage) {
      const filePath = join(usageDir, `${userId}.json`);
      await writeFile(filePath, JSON.stringify(data), "utf-8");
    }
    this.dirty = false;
  }

  /** Restore usage data from disk on startup */
  async restore(): Promise<void> {
    const usageDir = join(getHomeDir(), "state", "usage");
    try {
      const files = await readdir(usageDir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const userId = file.replace(".json", "");
        try {
          const raw = await readFile(join(usageDir, file), "utf-8");
          const data = JSON.parse(raw) as UserUsageData;
          // Ensure expected shape
          if (data.dailyTokens && data.monthlyTokens && data.sessionTokens) {
            this.usage.set(userId, data);
          }
        } catch {
          // Skip corrupt files
        }
      }
    } catch {
      // No usage dir yet
    }
  }

  private getOrCreateUsageData(userId: string): UserUsageData {
    let data = this.usage.get(userId);
    if (!data) {
      data = { dailyTokens: [], monthlyTokens: [], sessionTokens: {} };
      this.usage.set(userId, data);
    }
    return data;
  }
}
